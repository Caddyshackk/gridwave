/**
 * GRIDWAVE Premium worker — Cloudflare Workers (free tier is plenty to start).
 *
 * What this does:
 *   1. Reads a license key off each request (header X-License-Key).
 *   2. Validates it against Whop's Memberships API using YOUR Whop API key
 *      (never the visitor's) — cached in KV so you're not hitting Whop on
 *      every page load.
 *   3. Only if the license is valid does it fetch the paid/rate-limited
 *      upstream (Odds API, nflverse) using YOUR keys — never sent to the
 *      browser, ever.
 *   4. On a schedule (Cron Trigger), snapshots current odds into KV so the
 *      VAULT's line-movement panel has real history to show instead of a
 *      single point-in-time read.
 *   5. Tracks your Odds API quota on every call so you can watch usage climb
 *      — see GET /usage.
 *   6. Abuse protection (this file's focus): edge-caches both upstreams so
 *      any number of visitors requesting the same thing in the same window
 *      costs you exactly one upstream call; rate-limits per license key and
 *      per IP; and locks CORS to your own site instead of the whole internet.
 *      See "ABUSE PROTECTION" below for the specifics and how to tune them.
 *
 * One-time setup:
 *   1. wrangler kv:namespace create LICENSES
 *      wrangler kv:namespace create LINES
 *      → paste both returned ids into wrangler.toml (template at the bottom)
 *   2. wrangler secret put WHOP_API_KEY
 *      → Whop dashboard → Developer → API Keys (needs member:basic:read)
 *   3. wrangler secret put ODDS_API_KEY
 *      → your key from the-odds-api.com
 *   4. wrangler secret put WHOP_CHECKOUT_URL   (optional, or hardcode below)
 *      → e.g. https://whop.com/gridwave-premium
 *   5. wrangler secret put ADMIN_KEY
 *      → any long random string you make up yourself (e.g. `openssl rand -hex 20`).
 *        This is not from any vendor — it's just a password only you know, so
 *        GET /usage?admin_key=... stays private to you and isn't gated by the
 *        customer license flow.
 *   6. Set ALLOWED_ORIGIN below to your real GitHub Pages URL before you go live.
 *   7. wrangler deploy
 *   8. Paste the resulting *.workers.dev URL into WORKER_BASE in gridwave.html,
 *      and your Whop checkout link into WHOP_CHECKOUT_URL there too.
 *
 * Checking usage: visit https://your-worker.workers.dev/usage?admin_key=YOUR_ADMIN_KEY
 * any time. It reports { remaining, used, lastCallCost, checkedAt } straight from
 * The Odds API's own response headers, last updated whenever anyone last loaded
 * odds or the cron last ran (every 30 min) — whichever was most recent.
 *
 * How a visitor gets a valid key: they buy your Whop product, Whop issues
 * them a license key automatically, they paste it into GRIDWAVE's license
 * bar. No accounts, no passwords on your end — Whop is the source of truth.
 *
 *
 * ============================= ABUSE PROTECTION =============================
 * Four independent layers, in the order a request actually hits them:
 *
 * 1. CORS lock (ALLOWED_ORIGIN below). Only your site's origin gets a CORS
 *    header back, so a script running on someone else's page can't call this
 *    worker from a browser. Doesn't stop server-to-server or curl requests
 *    (nothing can — CORS is a browser-only protection), but it does stop the
 *    easy case: someone embedding calls to your worker in their own page.
 *
 * 2. Per-IP throttle on BAD license keys (CHECK_LIMIT_PER_IP), before Whop
 *    is ever called. Stops someone script-guessing license keys from costing
 *    you a Whop API call per guess.
 *
 * 3. Per-license throttle on real work (RATE_LIMIT_PER_LICENSE), after a
 *    license passes. A normal session — loading the Vault, checking odds,
 *    clicking through a few players' line history — is nowhere near this.
 *    A script hammering one key in a loop hits it fast. Tune the number in
 *    RATE_LIMITS below if real usage patterns turn out heavier than expected.
 *
 * 4. Edge caching on both paid/metered upstreams (ODDS_CACHE_TTL_SECONDS,
 *    NFLVERSE_CACHE_TTL_SECONDS). This is the one that matters most: it means
 *    your actual Odds API / nflverse cost is capped at roughly (1 call per
 *    TTL window) no matter how many visitors — or bots — ask for it. A bot
 *    hammering /odds every second still only costs you one real upstream
 *    call every five minutes; everyone else in between gets served instantly
 *    from Cloudflare's edge, which costs you nothing.
 *
 * None of this requires the paid Workers plan — it's all built from KV
 * (already in use) and the standard Cache API. If you outgrow it, Cloudflare's
 * native Rate Limiting bindings (Workers Paid, $5/mo) do the same job with
 * less hand-rolled code — worth switching to once you have real traffic data
 * from GET /usage and a sense of what "normal" looks like.
 * ==============================================================================
 */

// ---- tune these ----
const ALLOWED_ORIGIN = 'https://caddyshackk.github.io'; // <-- set to your real Pages origin before going live
const ODDS_CACHE_TTL_SECONDS = 300;       // odds don't need to be fresher than 5 min for this app
const NFLVERSE_CACHE_TTL_SECONDS = 1800;  // matches nflverse's own update cadence, no reason to refetch sooner
const RATE_LIMITS = {
  perLicensePerMinute: 30,  // real sessions use single digits; this leaves generous headroom
  perIpBadKeyPerMinute: 10  // legitimate users don't submit invalid keys repeatedly
};

const ALLOWED_NFLVERSE_PREFIXES = [
  'https://github.com/nflverse/nflverse-data/releases/download/',
  'https://raw.githubusercontent.com/nflverse/'
];

const LICENSE_CACHE_TTL_SECONDS = 600;   // re-check with Whop every 10 min per key
const LINE_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 10; // auto-forget a game's snapshots after 10 days
const LINE_HISTORY_MAX_SNAPSHOTS = 200;  // plenty for a week of half-hourly polling
const ACTIVE_STATUSES = ['active', 'trialing'];

function corsHeaders(request){
  const origin = request.headers.get('Origin');
  const wildcardMode = ALLOWED_ORIGIN === 'https://YOURUSERNAME.github.io'; // still on the placeholder
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-License-Key',
    'Vary': 'Origin'
  };
  if (wildcardMode) headers['Access-Control-Allow-Origin'] = '*';
  else if (origin === ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = origin;
  // else: no CORS header at all — the browser blocks the response client-side
  return headers;
}

// The Odds API returns full team names; ESPN (what the frontend uses) uses abbreviations.
// This is what lets a cron-stored snapshot and a frontend lookup find the same game.
const NAME_TO_ABBR = {
  'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF',
  'Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE',
  'Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB',
  'Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC',
  'Las Vegas Raiders':'LV','Los Angeles Chargers':'LAC','Los Angeles Rams':'LAR','Miami Dolphins':'MIA',
  'Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG',
  'New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','San Francisco 49ers':'SF',
  'Seattle Seahawks':'SEA','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN','Washington Commanders':'WSH'
};

// Simple KV-counter rate limiter. Not perfectly atomic under heavy concurrency (KV read-then-write
// can race), but for abuse prevention "approximately right, fails safe toward blocking" is enough —
// a determined attacker hitting the exact race window isn't the threat model here; a runaway
// script or a shared/leaked key hammering the API in a loop is, and this stops that fine.
async function rateLimited(env, bucket, limit){
  const windowKey = `rl:${bucket}:${Math.floor(Date.now()/60000)}`; // one bucket per wall-clock minute
  try {
    const current = +((await env.LICENSES.get(windowKey)) || '0');
    if (current >= limit) return true;
    await env.LICENSES.put(windowKey, String(current+1), { expirationTtl: 90 });
    return false;
  } catch (e) {
    // KV read/write failing (e.g. the free tier's daily write quota) must never crash the whole
    // request — rate limiting is abuse-prevention, not core functionality. Fail open: treat this
    // one check as "not limited" rather than take the entire site down over bookkeeping.
    console.log('RATE LIMIT KV ERROR (failing open)', e.message);
    return false;
  }
}

// Edge-caches an upstream GET using Cloudflare's Cache API, keyed by the worker's own request URL
// (so /nflverse?url=A and /nflverse?url=B cache separately, and /odds — always the same URL — caches
// as one shared entry for everyone). This is what caps upstream cost regardless of visitor volume.
async function cachedFetch(request, upstreamUrl, ttlSeconds, upstreamInit){
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  let response = await cache.match(cacheKey);
  if (response) return { response, hit: true };

  const upstream = await fetch(upstreamUrl, upstreamInit);
  const toCache = new Response(upstream.body, upstream);
  toCache.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
  toCache.headers.delete('Set-Cookie'); // never cache anything with a cookie, out of caution
  await cache.put(cacheKey, toCache.clone());
  return { response: toCache, hit: false };
}

async function checkLicense(licenseKey, env) {
  if (!licenseKey) return { valid: false, reason: 'missing' };

  // A KV read failure (e.g. daily quota) just means "no cached answer" — fall through to a real
  // Whop check rather than crash the request over what's only a cost-saving shortcut.
  let cached = null;
  try { cached = await env.LICENSES.get(licenseKey, 'json'); }
  catch (e) { console.log('LICENSE CACHE READ ERROR (treating as miss)', e.message); }
  if (cached) return cached; // entry self-expires via expirationTtl below

  let result;
  try {
    const resp = await fetch(
      `https://api.whop.com/api/v1/memberships/${encodeURIComponent(licenseKey)}`,
      { headers: { Authorization: `Bearer ${env.WHOP_API_KEY}` } }
    );
    const bodyText = await resp.text();
    console.log('WHOP DEBUG', resp.status, bodyText);
    if (!resp.ok) {
      result = { valid: false, reason: 'not_found' };
    } else {
      // Whop's current API doesn't return a `valid` field — only `status`. See the debug log
      // above for the raw shape if this ever needs re-checking against a future API change.
      const data = JSON.parse(bodyText);
      const valid = ACTIVE_STATUSES.includes(data.status);
      result = { valid, status: data.status };
    }
  } catch (e) {
    console.log('WHOP DEBUG EXCEPTION', e.message);
    result = { valid: false, reason: 'whop_unreachable' }; // fail closed, don't grant free access
  }

  // Same here — a real, correct answer just got computed above; a failure to *cache* it must
  // never throw that answer away. Caching is an optimization, not the source of truth.
  try { await env.LICENSES.put(licenseKey, JSON.stringify(result), { expirationTtl: LICENSE_CACHE_TTL_SECONDS }); }
  catch (e) { console.log('LICENSE CACHE WRITE ERROR (returning result anyway)', e.message); }
  return result;
}

// Persists Odds API quota headers to KV, reused by both the cron snapshot path and any live
// /odds request that actually reaches the upstream (i.e. wasn't served from edge cache).
async function recordOddsUsage(env, headers){
  const remaining = headers.get('x-requests-remaining');
  const used = headers.get('x-requests-used');
  const last = headers.get('x-requests-last');
  if (remaining === null && used === null) return;
  try {
    await env.LICENSES.put('usage:odds', JSON.stringify({
      remaining: remaining !== null ? +remaining : null,
      used: used !== null ? +used : null,
      lastCallCost: last !== null ? +last : null,
      checkedAt: Date.now()
    }));
  } catch (e) { /* usage tracking is best-effort, never block the real call on it */ }
}

async function fetchOddsRaw(env) {
  const resp = await fetch(
    `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${env.ODDS_API_KEY}`
  );
  // Awaited, not fire-and-forget: an un-awaited write can get dropped once this Worker
  // invocation ends, since nothing here has access to ctx.waitUntil().
  await recordOddsUsage(env, resp.headers);
  return resp;
}

// Runs on the Cron Trigger. Pulls current odds, files one snapshot per game into KV.
// This calls the upstream directly (not through cachedFetch) since it's on its own 30-min
// schedule already — that schedule IS the rate limit for this path.
async function snapshotLines(env) {
  const resp = await fetchOddsRaw(env);
  if (!resp.ok) return;
  const games = await resp.json();
  const now = Date.now();

  for (const g of games) {
    const awayAbbr = NAME_TO_ABBR[g.away_team];
    const homeAbbr = NAME_TO_ABBR[g.home_team];
    if (!awayAbbr || !homeAbbr) continue;

    const book = g.bookmakers?.[0];
    const spreadOutcome = book?.markets?.find(m => m.key === 'spreads')?.outcomes?.find(o => o.name === g.home_team);
    const totalOutcome = book?.markets?.find(m => m.key === 'totals')?.outcomes?.find(o => o.name === 'Over');
    const snap = {
      t: now,
      spread: spreadOutcome?.point ?? null,
      total: totalOutcome?.point ?? null,
      book: book?.title ?? null
    };

    const key = `line:${awayAbbr}-${homeAbbr}`;
    const existing = (await env.LINES.get(key, 'json')) || [];
    const trimmed = [...existing, snap].slice(-LINE_HISTORY_MAX_SNAPSHOTS);
    await env.LINES.put(key, JSON.stringify(trimmed), { expirationTtl: LINE_HISTORY_TTL_SECONDS });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // Reject anything that isn't one of this worker's actual routes before the license/rate-limit
    // layer below ever touches KV. Public *.workers.dev URLs get scanned by bots around the clock
    // hitting random paths (/.env, /wp-admin, etc.) — without this guard, every one of those scans
    // still cost a real KV operation even though they have nothing to do with the app.
    const KNOWN_ROUTES = ['/usage', '/odds', '/line-history', '/nflverse'];
    if (!KNOWN_ROUTES.includes(url.pathname)) {
      return new Response('Not found', { status: 404, headers: cors });
    }

    // ---- USAGE (private — yours, not a customer-facing route) ----
    if (url.pathname === '/usage') {
      const adminKey = url.searchParams.get('admin_key');
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const odds = (await env.LICENSES.get('usage:odds', 'json')) || null;
      return new Response(JSON.stringify({ odds }, null, 2), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const licenseKey = request.headers.get('X-License-Key') || url.searchParams.get('license');

    // Layer 2: throttle bad-key guessing by IP, before it ever reaches Whop. Checked against the
    // KV cache only (not a fresh Whop call), so a brand-new legitimate key's very first request
    // also passes through this bucket once — harmless, since one request never trips a /minute limit.
    let hasCachedLicense = false;
    if (licenseKey) {
      try { hasCachedLicense = !!(await env.LICENSES.get(licenseKey, 'json')); }
      catch (e) { console.log('BADKEY CHECK KV READ ERROR (treating as uncached)', e.message); }
    }
    if (!licenseKey || !hasCachedLicense) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (await rateLimited(env, `badkey:${ip}`, RATE_LIMITS.perIpBadKeyPerMinute)) {
        return new Response(JSON.stringify({ error: 'Too many attempts. Slow down.' }), {
          status: 429, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
    }

    const license = await checkLicense(licenseKey, env);

    if (!license.valid) {
      return new Response(JSON.stringify({
        error: 'A valid GRIDWAVE Premium license is required.',
        reason: license.reason || license.status || 'inactive',
        upgrade_url: env.WHOP_CHECKOUT_URL || 'https://whop.com/'
      }), {
        status: 402,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Layer 3: throttle a valid key's real usage. Runs for every route below this point.
    if (await rateLimited(env, `license:${licenseKey}`, RATE_LIMITS.perLicensePerMinute)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded for this license. Try again shortly.' }), {
        status: 429, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // ---- ODDS (live, edge-cached) ----
    if (url.pathname === '/odds') {
      // check=1 is the frontend's "is this license valid?" ping (fired on every Unlock click).
      // By this point in the code, checkLicense() + rate limiting have already passed, so there's
      // nothing left to prove — short-circuit here instead of spending real Odds API credits
      // (each real call below costs 3 credits: 1 region x 3 markets) just to confirm a key works.
      if (url.searchParams.get('check') === '1') {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }

      const { response, hit } = await cachedFetch(
        request,
        `https://api.the-odds-api.com/v4/sports/americanfootball_nfl/odds/?regions=us&markets=h2h,spreads,totals&oddsFormat=american&apiKey=${env.ODDS_API_KEY}`,
        ODDS_CACHE_TTL_SECONDS
      );
      if (!hit) await recordOddsUsage(env, response.headers); // only a real cache miss cost a real API call
      const body = await response.clone().text();
      return new Response(body, {
        status: response.status,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // ---- LINE HISTORY (cron-collected snapshots) ----
    if (url.pathname === '/line-history') {
      const away = url.searchParams.get('away');
      const home = url.searchParams.get('home');
      if (!away || !home) {
        return new Response(JSON.stringify({ error: 'missing away/home' }), {
          status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      const snaps = (await env.LINES.get(`line:${away}-${home}`, 'json')) || [];
      return new Response(JSON.stringify(snaps), {
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // ---- NFLVERSE (advanced player stats for the VAULT, edge-cached) ----
    if (url.pathname === '/nflverse') {
      const target = url.searchParams.get('url');
      if (!target || !ALLOWED_NFLVERSE_PREFIXES.some(p => target.startsWith(p))) {
        return new Response('Not allowed', { status: 403, headers: cors });
      }
      const { response } = await cachedFetch(request, target, NFLVERSE_CACHE_TTL_SECONDS);
      return new Response(response.body, {
        status: response.status,
        headers: {
          ...cors,
          'Content-Type': response.headers.get('content-type') || 'text/csv',
          'Cache-Control': `public, max-age=${NFLVERSE_CACHE_TTL_SECONDS}`
        }
      });
    }

    return new Response('Not found', { status: 404, headers: cors });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(snapshotLines(env));
  }
};


