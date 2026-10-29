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
 *   9. (optional) wrangler secret put IP_HASH_SALT
 *      → any random string; salts the IP hashes used by the license-sharing check.
 *
 * NBA routes (all premium, same license + rate limits as NFL):
 *   /nba/events  Odds API event list for the NBA (free, 0 credits), used to match a
 *                game on ESPN's scoreboard to its Odds API event id.
 *   /nba/props   ?event=<odds event id> player props (points/rebounds/assists/threes).
 *                Costs 4 credits per real upstream call, edge-cached NBA_PROPS_CACHE_TTL_SECONDS
 *                per game, and only ids present in /nba/events are accepted.
 *   /nba/espn-props ?event=<ESPN event id> FREE DraftKings player props from ESPN's core API.
 *                The frontend tries this first and only falls back to /nba/props if it's empty.
 *   /hoopr       ?url=<sportsdataverse release asset> last-season NBA box scores (the
 *                prior the NBA projections blend with this season's games).
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
 * 5. License-sharing check (LICENSE_SHARING). A paid key is meant for one
 *    person, so each key may be used from at most LICENSE_SHARING.maxNetworks
 *    different networks in any rolling LICENSE_SHARING.windowHours. Past that,
 *    the worker answers 403 { reason: 'license_shared' } until older networks
 *    age out of the window. Raw IPs are never stored, only a salted SHA-256
 *    hash. IPv6 is bucketed by its /64 network, because phones and laptops
 *    rotate the last half of an IPv6 address on their own through the day.
 *    Reset one customer's list (e.g. after they email you) with:
 *      GET /admin/ips?admin_key=YOUR_ADMIN_KEY&license=THEIR_KEY&reset=1
 *    or view it (counts + last-seen times only) without &reset=1.
 *
 * Cache keys are canonical (built from the route + the params that matter,
 * never the raw request URL), so a valid key can't bust the edge cache and
 * burn Odds API credits by appending ?anything=123 to a request.
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
const STAT_FILE_STALE_SECONDS = 60 * 60 * 24 * 7; // keep a last good copy of each stat file for a week, served only if GitHub is down
const RATE_LIMITS = {
  perLicensePerMinute: 30,  // real sessions use single digits; this leaves generous headroom
  perIpBadKeyPerMinute: 10  // legitimate users don't submit invalid keys repeatedly
};

const ALLOWED_NFLVERSE_PREFIXES = [
  'https://github.com/nflverse/nflverse-data/releases/download/',
  'https://raw.githubusercontent.com/nflverse/'
];

// ---- NBA ----
const NBA_EVENTS_CACHE_TTL_SECONDS = 600;   // event list is free; 10 min keeps tip-off times current
const NBA_PROPS_CACHE_TTL_SECONDS = 1800;   // 4 credits per real call, per game, so 30 min per game
const NBA_PROPS_MARKETS = 'player_points,player_rebounds,player_assists,player_threes';
const HOOPR_CACHE_TTL_SECONDS = 21600;      // last season's box scores never change; 6h is plenty
const ESPN_PROPS_CACHE_TTL_SECONDS = 600;   // free upstream; 10 min keeps lines fresh without hammering ESPN
const ESPN_PROPS_PROVIDER = 100;            // DraftKings on ESPN's odds feed
const ALLOWED_HOOPR_PREFIXES = [
  'https://github.com/sportsdataverse/sportsdataverse-data/releases/download/espn_nba_player_boxscores/',
  'https://github.com/sportsdataverse/hoopR-nba-data/releases/download/'
];

// ---- license sharing (Layer 5) ----
const LICENSE_SHARING = {
  maxNetworks: 5,         // home wifi, phone (cell), work, a friend's place, travel: generous on purpose
  windowHours: 24,        // a network drops off the list 24h after it was last seen
  touchEveryMinutes: 60   // only re-write a known network's last-seen time hourly (saves KV writes)
};

const LICENSE_CACHE_TTL_SECONDS = 600;   // re-check with Whop every 10 min per key
const LINE_HISTORY_TTL_SECONDS = 60 * 60 * 24 * 10; // auto-forget a game's snapshots after 10 days
const LINE_HISTORY_MAX_SNAPSHOTS = 200;  // plenty for a week of half-hourly polling
const ACTIVE_STATUSES = ['active', 'trialing', 'completed', 'canceling']; // completed = one-time purchase paid in full; canceling = cancelled but paid through the period end

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

// Edge-caches an upstream GET using Cloudflare's Cache API. The cache key is a canonical URL the
// caller builds from only the params that matter (e.g. `${origin}/odds`, or /nflverse plus its url
// param), NOT the raw request URL; otherwise /odds?x=1, /odds?x=2 ... would each miss the cache and
// each cost real Odds API credits. This is what caps upstream cost regardless of visitor volume.
// staleSeconds (optional): also keep a "last good copy" that long, and serve it when the upstream
// is down (e.g. GitHub answering 522/5xx or timing out). Used for the nflverse and hoopR stat files,
// where data a few hours old beats a broken tab. Never used for odds, where stale prices mislead.
// For logs only: never write API keys into Cloudflare's logs.
const safeUrl = u => String(u).replace(/([?&](apiKey|api_key|key|token)=)[^&]+/gi, '$1***');

async function cachedFetch(cacheKeyUrl, upstreamUrl, ttlSeconds, upstreamInit, staleSeconds){
  const cache = caches.default;
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' });
  let response = await cache.match(cacheKey);
  if (response) return { response, hit: true };

  const staleKey = staleSeconds ? new Request(cacheKeyUrl + (cacheKeyUrl.includes('?') ? '&' : '?') + 'gw_stale=1', { method: 'GET' }) : null;
  let upstream = null;
  try { upstream = await fetch(upstreamUrl, upstreamInit); }
  catch (e) { console.log('UPSTREAM FETCH ERROR', safeUrl(upstreamUrl), e.message); if (!staleKey) throw e; }
  // Stat files only: one retry on a 5xx/522 or a dropped connection, since GitHub hiccups are usually brief.
  if (staleKey && (!upstream || upstream.status >= 500)) {
    console.log('UPSTREAM RETRY', safeUrl(upstreamUrl), upstream ? upstream.status : 'fetch error');
    try { upstream = await fetch(upstreamUrl, upstreamInit); }
    catch (e) { console.log('UPSTREAM FETCH ERROR (retry)', safeUrl(upstreamUrl), e.message); upstream = null; }
  }
  if (upstream && !upstream.ok) console.log('UPSTREAM NOT OK', safeUrl(upstreamUrl), upstream.status);

  // Never cache a failure (an Odds API 429, a GitHub 404 for a season file that isn't posted yet):
  // the next request should try again, not get served the error for the whole TTL.
  if (!upstream || !upstream.ok) {
    if (staleKey) {
      const stale = await cache.match(staleKey);
      if (stale) {
        console.log('SERVING STALE COPY', safeUrl(upstreamUrl), upstream ? upstream.status : 'fetch error');
        return { response: stale, hit: true, stale: true };
      }
    }
    return { response: upstream || new Response('Upstream unavailable', { status: 502 }), hit: false };
  }
  const toCache = new Response(upstream.body, upstream);
  toCache.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
  toCache.headers.delete('Set-Cookie'); // never cache anything with a cookie, out of caution
  await cache.put(cacheKey, toCache.clone());
  if (staleKey) {
    const backup = toCache.clone();
    const keep = new Response(backup.body, backup);
    keep.headers.set('Cache-Control', `public, max-age=${staleSeconds}`);
    await cache.put(staleKey, keep);
  }
  return { response: toCache, hit: false };
}

async function sha256Hex(text){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Groups an IP into "one network". IPv4: the address itself. IPv6: the first 64 bits, since
// devices rotate the last 64 bits (privacy addresses) many times a day on the same network.
function networkOf(ip){
  if (!ip.includes(':')) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  let groups = h;
  if (tail !== undefined) {
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  }
  return groups.slice(0, 4).map(g => (g || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// Layer 5: how many different networks has this license been used from lately? Stored per key as
// { <hashed network>: lastSeenMs }. Fails open on any KV error: this is anti-sharing, not core
// functionality, and a KV quota hiccup must never lock out a paying customer.
async function checkLicenseSharing(env, licenseKey, ip){
  if (!ip) return { ok: true };
  try {
    const now = Date.now();
    const windowMs = LICENSE_SHARING.windowHours * 3600 * 1000;
    const kvKey = `ips:${licenseKey}`;
    const seen = (await env.LICENSES.get(kvKey, 'json')) || {};
    for (const h of Object.keys(seen)) if (now - seen[h] > windowMs) delete seen[h];

    const net = (await sha256Hex(`${env.IP_HASH_SALT || 'gridwave'}|${networkOf(ip)}`)).slice(0, 16);
    if (seen[net] !== undefined) {
      if (now - seen[net] > LICENSE_SHARING.touchEveryMinutes * 60000) {
        seen[net] = now;
        await env.LICENSES.put(kvKey, JSON.stringify(seen), { expirationTtl: LICENSE_SHARING.windowHours * 3600 * 2 });
      }
      return { ok: true };
    }
    if (Object.keys(seen).length >= LICENSE_SHARING.maxNetworks) {
      return { ok: false, networks: Object.keys(seen).length };
    }
    seen[net] = now;
    await env.LICENSES.put(kvKey, JSON.stringify(seen), { expirationTtl: LICENSE_SHARING.windowHours * 3600 * 2 });
    return { ok: true };
  } catch (e) {
    console.log('LICENSE SHARING KV ERROR (failing open)', e.message);
    return { ok: true };
  }
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
    // Log the HTTP status only — the full membership body includes customer details (email,
    // user info) and Cloudflare logs are not the place for those.
    console.log('WHOP CHECK', resp.status);
    if (!resp.ok) {
      result = { valid: false, reason: 'not_found' };
    } else {
      // Whop's current API doesn't return a `valid` field — only `status`. If this ever needs
      // re-checking against an API change, temporarily log Object.keys(data), not the whole body.
      const data = JSON.parse(bodyText);
      const valid = ACTIVE_STATUSES.includes(data.status);
      console.log('WHOP STATUS', data.status);
      result = { valid, status: data.status };
    }
  } catch (e) {
    console.log('WHOP CHECK EXCEPTION', e.message);
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

async function fetchNbaEvents(url, env){
  return cachedFetch(
    `${url.origin}/nba/events`,
    `https://api.the-odds-api.com/v4/sports/basketball_nba/events?apiKey=${env.ODDS_API_KEY}`,
    NBA_EVENTS_CACHE_TTL_SECONDS
  );
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
    const KNOWN_ROUTES = ['/usage', '/odds', '/line-history', '/nflverse', '/nba/events', '/nba/props', '/nba/espn-props', '/hoopr', '/admin/ips'];
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

    // ---- ADMIN: view or reset one license's network list (yours, not customer-facing) ----
    if (url.pathname === '/admin/ips') {
      const adminKey = url.searchParams.get('admin_key');
      const target = url.searchParams.get('license');
      if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY || !target) {
        return new Response(JSON.stringify({ error: 'forbidden' }), {
          status: 403, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
      if (url.searchParams.get('reset') === '1') {
        await env.LICENSES.delete(`ips:${target}`);
        return new Response(JSON.stringify({ reset: true }), { headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const seen = (await env.LICENSES.get(`ips:${target}`, 'json')) || {};
      const networks = Object.values(seen).sort((a, b) => b - a).map(t => new Date(t).toISOString());
      return new Response(JSON.stringify({ count: networks.length, limit: LICENSE_SHARING.maxNetworks, lastSeen: networks }, null, 2), {
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

    // Layer 5: one key, one person. Block a key that's being used from too many networks at once.
    const sharing = await checkLicenseSharing(env, licenseKey, request.headers.get('CF-Connecting-IP'));
    if (!sharing.ok) {
      return new Response(JSON.stringify({
        error: 'This license is in use on too many networks right now. Licenses are for one person. If this is you, it clears within 24 hours, or contact support.',
        reason: 'license_shared'
      }), { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
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
        `${url.origin}/odds`,
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
      const { response } = await cachedFetch(`${url.origin}/nflverse?url=${encodeURIComponent(target)}`, target, NFLVERSE_CACHE_TTL_SECONDS, undefined, STAT_FILE_STALE_SECONDS);
      return new Response(response.body, {
        status: response.status,
        headers: {
          ...cors,
          'Content-Type': response.headers.get('content-type') || 'text/csv',
          'Cache-Control': response.ok ? `public, max-age=${NFLVERSE_CACHE_TTL_SECONDS}` : 'no-store'   // never let a browser hold on to an error
        }
      });
    }

    // ---- NBA: Odds API event list (free, 0 credits) ----
    if (url.pathname === '/nba/events') {
      const { response } = await fetchNbaEvents(url, env);
      return new Response(await response.clone().text(), {
        status: response.status, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // ---- NBA: player props for ONE game, only for ids that are on the real event list ----
    if (url.pathname === '/nba/props') {
      const eventId = url.searchParams.get('event') || '';
      if (!/^[a-f0-9]{32}$/.test(eventId)) {
        return new Response(JSON.stringify({ error: 'bad event id' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      // Made-up ids would each be a cache miss and a real 4-credit call, so check against the list first.
      let known = false;
      try {
        const { response: evResp } = await fetchNbaEvents(url, env);
        const events = await evResp.clone().json();
        known = Array.isArray(events) && events.some(e => e.id === eventId);
      } catch (e) { known = false; }
      if (!known) {
        return new Response(JSON.stringify({ error: 'unknown event' }), { status: 404, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const { response, hit } = await cachedFetch(
        `${url.origin}/nba/props?event=${eventId}`,
        `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${eventId}/odds?regions=us&markets=${NBA_PROPS_MARKETS}&oddsFormat=american&apiKey=${env.ODDS_API_KEY}`,
        NBA_PROPS_CACHE_TTL_SECONDS
      );
      if (!hit) await recordOddsUsage(env, response.headers);
      return new Response(await response.clone().text(), {
        status: response.status, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // ---- NBA: FREE player props (DraftKings lines on ESPN's core API, 0 credits) ----
    // Proxied (not called from the browser) because ESPN's core API isn't guaranteed to send CORS
    // headers, and edge caching means every visitor shares one upstream call per game per 10 min.
    if (url.pathname === '/nba/espn-props') {
      const ev = url.searchParams.get('event') || '';
      if (!/^\d{6,12}$/.test(ev)) {
        return new Response(JSON.stringify({ error: 'bad event id' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      const { response } = await cachedFetch(
        `${url.origin}/nba/espn-props?event=${ev}`,
        `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/events/${ev}/competitions/${ev}/odds/${ESPN_PROPS_PROVIDER}/propBets?limit=1000`,
        ESPN_PROPS_CACHE_TTL_SECONDS
      );
      return new Response(response.body, {
        status: response.status, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // ---- NBA: last-season box scores (sportsdataverse release assets, no CORS upstream) ----
    if (url.pathname === '/hoopr') {
      const target = url.searchParams.get('url');
      if (!target || !ALLOWED_HOOPR_PREFIXES.some(p => target.startsWith(p))) {
        return new Response('Not allowed', { status: 403, headers: cors });
      }
      const { response } = await cachedFetch(`${url.origin}/hoopr?url=${encodeURIComponent(target)}`, target, HOOPR_CACHE_TTL_SECONDS, undefined, STAT_FILE_STALE_SECONDS);
      return new Response(response.body, {
        status: response.status,
        headers: {
          ...cors,
          'Content-Type': response.headers.get('content-type') || 'text/csv',
          'Cache-Control': response.ok ? `public, max-age=${HOOPR_CACHE_TTL_SECONDS}` : 'no-store'   // never let a browser hold on to an error
        }
      });
    }

    return new Response('Not found', { status: 404, headers: cors });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(snapshotLines(env));
  }
};


