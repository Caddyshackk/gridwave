// Refreshes values.json for Gridiron Trade Desk. Runs daily from GitHub Actions (Node 20+, no dependencies).
// QB/RB/WR/TE: FantasyCalc redraft market values (12-team). K/DEF: ranked by Sleeper rest-of-season projections.
// If a source fails, the previous values for that group are kept so the site never breaks.
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../values.json", import.meta.url);
const getJSON = async (url) => {
  const r = await fetch(url, { headers: { "user-agent": "gridiron-trade-desk" } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};

let prev = { players: [] };
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}
const prevOf = (pos) => prev.players.filter((r) => pos.includes(r[1]));

// ---- Offense from FantasyCalc ----
async function offense() {
  const base = "https://api.fantasycalc.com/values/current?isDynasty=false&numTeams=12";
  const variants = { ppr: "&ppr=1&numQbs=1", half: "&ppr=0.5&numQbs=1", std: "&ppr=0&numQbs=1", sf: "&ppr=1&numQbs=2" };
  const m = new Map();
  for (const [k, q] of Object.entries(variants)) {
    const list = await getJSON(base + q);
    for (const p of list) {
      const pl = p.player || {};
      if (!["QB", "RB", "WR", "TE"].includes(pl.position)) continue;
      const id = pl.sleeperId || pl.name;
      const row = m.get(id) || { n: pl.name, pos: pl.position, tm: pl.maybeTeam || "FA", age: pl.maybeAge ? Math.round(pl.maybeAge * 10) / 10 : 0, v: {}, tr: 0 };
      row.v[k] = Math.round(p.value || 0);
      if (k === "ppr") row.tr = Math.round(p.trend30Day || 0);
      m.set(id, row);
    }
  }
  const rows = [...m.values()].map((r) => [r.n, r.pos, r.tm, r.age, r.v.ppr || 0, r.v.half || 0, r.v.std || 0, r.v.sf || 0, r.tr]);
  if (rows.length < 100) throw new Error(`FantasyCalc returned only ${rows.length} players`);
  return rows;
}

// ---- Kickers and defenses from Sleeper projections ----
const TEAMS = { ARI: "Arizona Cardinals", ATL: "Atlanta Falcons", BAL: "Baltimore Ravens", BUF: "Buffalo Bills", CAR: "Carolina Panthers", CHI: "Chicago Bears", CIN: "Cincinnati Bengals", CLE: "Cleveland Browns", DAL: "Dallas Cowboys", DEN: "Denver Broncos", DET: "Detroit Lions", GB: "Green Bay Packers", HOU: "Houston Texans", IND: "Indianapolis Colts", JAX: "Jacksonville Jaguars", KC: "Kansas City Chiefs", LV: "Las Vegas Raiders", LAC: "Los Angeles Chargers", LAR: "Los Angeles Rams", MIA: "Miami Dolphins", MIN: "Minnesota Vikings", NE: "New England Patriots", NO: "New Orleans Saints", NYG: "New York Giants", NYJ: "New York Jets", PHI: "Philadelphia Eagles", PIT: "Pittsburgh Steelers", SF: "San Francisco 49ers", SEA: "Seattle Seahawks", TB: "Tampa Bay Buccaneers", TEN: "Tennessee Titans", WAS: "Washington Commanders" };

async function kdef() {
  const state = await getJSON("https://api.sleeper.app/v1/state/nfl");
  const season = state.season;
  const start = state.season_type === "regular" ? Math.max(1, Number(state.week) || 1) : 1;
  const tot = new Map();
  for (let w = start; w <= 18; w++) {
    let list;
    try { list = await getJSON(`https://api.sleeper.com/projections/nfl/${season}/${w}?season_type=regular&position[]=K&position[]=DEF`); }
    catch { continue; }
    for (const it of list || []) {
      const pl = it.player || {};
      const pos = pl.position || it.position;
      if (pos !== "K" && pos !== "DEF") continue;
      const id = it.player_id;
      const name = pos === "DEF" ? `${TEAMS[id] || id} D/ST` : `${pl.first_name || ""} ${pl.last_name || ""}`.trim();
      const pts = Number(it.stats?.pts_ppr ?? it.stats?.pts_std ?? 0) || 0;
      const row = tot.get(id) || { n: name, pos, tm: it.team || pl.team || (pos === "DEF" ? id : "FA"), pts: 0 };
      row.pts += pts;
      tot.set(id, row);
    }
  }
  const rank = (pos, top, decay, floor) =>
    [...tot.values()].filter((r) => r.pos === pos && r.pts > 0).sort((a, b) => b.pts - a.pts).slice(0, 32)
      .map((r, i) => { const v = Math.round(top * Math.exp(-i / decay) + floor); return [r.n, pos, r.tm, 0, v, v, v, v, null]; });
  const def = rank("DEF", 420, 7, 15), k = rank("K", 300, 6, 10);
  if (def.length < 20 || k.length < 20) throw new Error(`Sleeper projections too thin (DEF ${def.length}, K ${k.length})`);
  return [...def, ...k];
}

let off, kd, ok = true;
try { off = await offense(); } catch (e) { console.warn("Offense kept from last run:", e.message); off = prevOf(["QB", "RB", "WR", "TE"]); ok = false; }
try { kd = await kdef(); } catch (e) { console.warn("K/DEF kept from last run:", e.message); kd = prevOf(["K", "DEF"]); ok = false; }
if (!off.length) throw new Error("No offensive values available; leaving values.json unchanged.");

off.sort((a, b) => b[4] - a[4]);
const out = { updated: ok ? new Date().toISOString() : prev.updated || new Date().toISOString(), source: "FantasyCalc (QB/RB/WR/TE), Sleeper projections (K/DEF)", players: [...off, ...kd] };
await writeFile(OUT, JSON.stringify(out));
console.log(`Wrote ${out.players.length} players (${off.length} offense, ${kd.length} K/DEF).`);
