/**
 * lib/graph_integrity_tick.js — the SCHEDULER wire for the graph-integrity organ (built 07-25,
 * dark ever since: countyIntegritySubBeats/createGraphRepairer had zero callers outside the smoke).
 * Lucas's standing bar: the PROGRAM runs the repair loop, not a hand.
 *
 * Shape: pure core + injected I/O. The snapshot SQL and all shaping/picking logic live here
 * (offline-testable); `dispatch` (echoSuit) is injected by main.js. Discipline:
 *   • IDLE-TIER — main.js gates each tick with the same beatPassGate policy as the sweeps;
 *   • BUDGETED — hard daily repair cap (meta graph_integrity.daily_cap, default 25) + a bounded
 *     bite per tick (5): these are real graph WRITES, paced like everything autonomous;
 *   • KILL-SWITCH PAIR — ZOE_GRAPH_INTEGRITY=0 env, meta graph_integrity.enabled='0';
 *   • verify targets are NEVER written (the organ's own guard — acting on a name collision is
 *     exactly how a duplicate is born); only mint/parent consume budget;
 *   • citation = the Census gazetteer the expected universe ships from (edges must cite).
 */
'use strict';
const GI = require('./graph_integrity');
const US = require('./us_counties.json');

// One row per county-ish place with its LOCATED_IN parent name (null = unparented). Scoped to the
// county vocabulary so the snapshot stays small (measured live: 1,351 rows, ~180ms) while still
// carrying every possible name-collision the diff's blocked/verify guard needs to see.
const PLACES_SQL = "SELECT e.id, e.name, (SELECT p.name FROM relations r JOIN entities p ON p.id=r.target_id "
  + "WHERE r.source_id=e.id AND r.relation_type='LOCATED_IN' LIMIT 1) AS parent "
  + "FROM entities e WHERE e.entity_type='place' AND (e.name LIKE '%county%' OR e.name LIKE '%parish%' "
  + "OR e.name LIKE '%borough%' OR e.name LIKE '%census area%')";
const CITATION = 'https://www2.census.gov/geo/docs/reference/codes2020/national_county2020.txt';
const DEFAULT_DAILY_CAP = 25;
const BITE_PER_TICK = 5;

const _NAME_TO_CODE = (() => {
  const m = new Map();
  for (const [code, st] of Object.entries(US)) m.set(String((st && st.name) || '').toLowerCase(), code);
  return m;
})();

// stateNameOf as the OBJECT map apply() expects.
function stateNames() {
  const o = {};
  for (const [code, st] of Object.entries(US)) o[code] = (st && st.name) || code;
  return o;
}

// snapshot rows → the diffCounties inputs. State resolves from the LOCATED_IN parent's name
// (stripQid'd) — the graph already knows the answer ("I can't tell" ≠ "it isn't there").
function shapeSnapshot(rows) {
  const graphPlaces = [], parentedIds = new Set(), stateOf = new Map();
  for (const r of (rows || [])) {
    if (!r || r.id == null || !r.name) continue;
    graphPlaces.push({ id: r.id, name: r.name });
    if (r.parent) {
      parentedIds.add(r.id);
      const code = _NAME_TO_CODE.get(GI.stripQid(r.parent).toLowerCase());
      if (code) stateOf.set(r.id, code);
    }
  }
  return { graphPlaces, parentedIds, stateOf };
}

// Rotate the state cursor; return the first state (after the cursor) whose beat has actionable
// (non-verify) repairs, or null when the whole union is clean — coverage shrinking to nothing is
// the organ's success state, not an error.
function pickState(snap, cursor) {
  const codes = Object.keys(US).sort();
  if (!codes.length) return null;
  const at = codes.indexOf(String(cursor || '').toUpperCase());
  for (let i = 1; i <= codes.length; i++) {
    const code = codes[(at + i) % codes.length];
    const targets = GI.countyIntegrityBeat(code, () => snap).enumerate();
    const actionable = targets.filter((t) => t && t.action !== 'verify');
    if (actionable.length) return { code, targets: actionable, held: targets.length - actionable.length };
  }
  return null;
}

// One bounded repair pass. Returns { ran, why?, code?, res? } — a refusal always names its door.
async function runTick({ dispatch, getMeta = () => null, setMeta = () => {}, now = Date.now(), dryRun = false, log = () => {} } = {}) {
  if (typeof dispatch !== 'function') return { ran: false, why: 'no-dispatch' };
  if (/^(0|false|off)$/i.test(String(process.env.ZOE_GRAPH_INTEGRITY || '').trim())) return { ran: false, why: 'env-off' };
  if (String(getMeta('graph_integrity.enabled') || '') === '0') return { ran: false, why: 'meta-off' };
  const day = new Date(now).toISOString().slice(0, 10);
  let spent = 0;
  try { const j = JSON.parse(getMeta('graph_integrity.spend') || '{}') || {}; if (j.day === day) spent = j.n || 0; } catch {}
  const cap = Math.max(1, parseInt(getMeta('graph_integrity.daily_cap') || String(DEFAULT_DAILY_CAP), 10) || DEFAULT_DAILY_CAP);
  if (spent >= cap) return { ran: false, why: 'daily-cap' };

  const r = await dispatch({ kind: 'do', name: 'db_query', args: { sql: PLACES_SQL, params: [] } });
  if (!r || !r.ok) return { ran: false, why: 'snapshot-failed' };
  let rows = [];
  try { rows = (JSON.parse(r.text) || {}).rows || []; } catch { return { ran: false, why: 'snapshot-parse' }; }
  const snap = shapeSnapshot(rows);
  const picked = pickState(snap, getMeta('graph_integrity.cursor') || '');
  if (!picked) return { ran: false, why: 'graph-clean' };
  setMeta('graph_integrity.cursor', picked.code);

  const R = GI.createGraphRepairer({
    callTool: (name, args) => dispatch({ kind: 'do', name, args }),
    log: (m) => log(String(m)),
  });
  const res = await R.apply(picked.targets, {
    stateNameOf: stateNames(), dryRun, citation: CITATION,
    limit: Math.min(BITE_PER_TICK, cap - spent),
  });
  const applied = (res && ((res.minted || 0) + (res.parented || 0))) || 0;
  if (!dryRun && applied) { try { setMeta('graph_integrity.spend', JSON.stringify({ day, n: spent + applied })); } catch {} }
  return { ran: true, code: picked.code, res, applied };
}

module.exports = { PLACES_SQL, CITATION, DEFAULT_DAILY_CAP, BITE_PER_TICK, stateNames, shapeSnapshot, pickState, runTick };
