/* Smoke: lib/curation_burst.js — W2 of the swarm substrate (offline: pure behavior + wiring).
 * Proves: the gates (kill switch, drain pace, the self-clearing operator kick), the counted-rows
 * seed shape, the proposer-only task spec (the rail rides the prompt), the honest deposit note,
 * the main.js wiring (drain call site after the adjudicator, quiet canvas tab, consume mark,
 * monologue-never-chat), and the engine-side manifest's proposer-only whitelist.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_curation_burst.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cb = require('../lib/curation_burst');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
process.exitCode = 1;

// ── identity: the registry's hyphenated name, the quiet tab ────────────────────────────────────
ok(cb.AGENT === 'people-curator' && /^[a-z]+(?:-[a-z]+)+$/.test(cb.AGENT), '⭐ §70: the agent name is the registry\'s hyphenated people-curator');
ok(/^[a-z]+(?:-[a-z]+)+$/.test(cb.CURATOR_TAB), 'quiet canvas (rail 3): the burst has its own designated tab');

// ── the gates: kill switch → operator kick (self-clearing) → drain pace ───────────────────────
{
  const meta = {};
  const T0 = 1e11;   // any instant safely past one pace window from the epoch-zero "never ran" state
  const g1 = cb.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: T0 });
  ok(g1.fire === true && Number(meta[cb.PACE_KEY]) === T0, 'fresh state → fires and stamps the pace key');
  const g2 = cb.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: T0 + cb.PACE_MS - 1 });
  ok(g2.fire === false && /paced/.test(g2.why), 'inside the window → paced, why names it');
  const g3 = cb.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: T0 + cb.PACE_MS + 1 });
  ok(g3.fire === true && /drain pace/.test(g3.why), 'past the window → fires again on drain pace');
  meta[cb.KICK_KEY] = '1';
  const g4 = cb.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: T0 + cb.PACE_MS + 2 });
  ok(g4.fire === true && /operator kick/.test(g4.why) && meta[cb.KICK_KEY] === '', '⭐ operator kick: fires past the pace floor and SELF-CLEARS the knob');
  const g5 = cb.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: T0 + cb.PACE_MS + 3 });
  ok(g5.fire === false, 'the consumed kick never double-fires');
  meta[cb.KILL_KEY] = 'off';
  meta[cb.KICK_KEY] = '1';
  const g6 = cb.shouldFire({ getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; }, now: 9e12 });
  ok(g6.fire === false && /kill switch/.test(g6.why) && meta[cb.KICK_KEY] === '1', `kill switch: ${cb.KILL_KEY}=off outranks even the kick (knob left intact for after re-arm)`);
}

// ── the counted-rows seed: deterministic, person-scoped, suffix-blind, bounded ────────────────
ok(/^WITH p AS/.test(cb.SEED_SQL.trim()) && !/INSERT|UPDATE|DELETE|DROP/i.test(cb.SEED_SQL), 'seed SQL is a read (WITH…SELECT, no DML)');
ok(/entity_type = 'person'/.test(cb.SEED_SQL), 'seed scopes to person entities');
ok(/instr\(name, ' \['\)/.test(cb.SEED_SQL) && /HAVING COUNT\(\*\) >= 2/.test(cb.SEED_SQL) && /LIMIT 12/.test(cb.SEED_SQL),
  '⭐ §59b: the seed strips the import bracket-suffix (the Keeter pattern) and bounds the worklist');

// ── the task spec: the rail leads, the rows ride, the envelope closes ─────────────────────────
const rows = [{ base: 'madeline keeter', c: 6, ids: '1783441,1785003', names: 'Madeline Keeter | Madeline Keeter [insightly legislator]' }];
const p1 = cb.curatorPrompt({ seedRows: rows });
ok(/You PROPOSE, the gates decide/.test(p1) && /hold no pen/.test(p1), '⭐ the rail rides the task spec: propose, never write');
ok(/THE COUNTED ROWS/.test(p1) && /madeline keeter \| 6/.test(p1), 'the seed rows ride the prompt verbatim (queried, never storied)');
ok(/list_resolution_proposals\s+FIRST/.test(p1), 'the never-re-file check leads the proposal step');
ok(/DUPLICATE_OF/.test(p1) && /allow_open_type=true/.test(p1) && /relation_metadata/.test(p1), 'proposals carry the typed edge + verbatim evidence');
ok(/FILED: .*SKIPPED: .*ERRORS:/.test(p1), 'the deposit envelope is pinned (FILED / SKIPPED / ERRORS)');
ok(!/merge_entities|decide_resolution_proposal|update_contact|delete_relation/.test(p1), 'the spec never names a pen tool');
const p0 = cb.curatorPrompt({ seedRows: [] });
ok(/pick your own slice/.test(p0) && /degree-0 person orphans/.test(p0), 'an unseeded sweep still works — the curator picks its slice');
ok(/^CURATION SWEEP \(fired \d{4}-/.test(p1) && cb.curatorPrompt({ seedRows: [], firedAt: 1000 }) !== cb.curatorPrompt({ seedRows: [], firedAt: 2000 }),
  '⭐ the fired-stamp nonce: every fire\'s input is unique, so the B1 dedupe can never serve a failed run\'s corpse to a retry');

// ── the deposit note: counts honestly, lands as monologue text ────────────────────────────────
const n1 = cb.burstNote({ deposit: 'FILED: keeter pair (shared email) \nkeeter pair 2 (suffix) \nSKIPPED: none · ERRORS: none' });
ok(/filed 2 duplicate proposals/.test(n1) && /gates to judge/.test(n1), 'a filing sweep is counted and credits the gates');
ok(/honest empty sweep/.test(cb.burstNote({ deposit: 'FILED: none · SKIPPED: all too thin · ERRORS: none' })), 'an empty sweep is said honestly, never dressed up');

// ── the failed-sweep detector (first-fire lesson, 08-31 p202: every tool bounced on engine
// store-init warm-up; the honest deposit carried it and the pace slot was quietly burned) ──────
const _failedSpecimen = 'FILED: none · SKIPPED: all groups due to system-wide tool failure · ERRORS: "Store not initialized. Start the server via echo.main:main …"';
ok(cb.sweepFailed(_failedSpecimen) === true, '⭐ the live specimen (p202 first fire) is detected as a failed sweep');
ok(cb.sweepFailed('FILED: none · SKIPPED: all too thin · ERRORS: none') === false, 'a clean empty sweep is NOT a failure (its slot stays spent)');
ok(cb.sweepFailed('FILED: keeter pair (shared email) · SKIPPED: none · ERRORS: one get_contact timeout') === false, 'a sweep that filed keeps its slot — partial errors are honest margin, not failure');
ok(/tool failure/.test(cb.burstNote({ deposit: _failedSpecimen })) && /slot is returned/.test(cb.burstNote({ deposit: _failedSpecimen })),
  'the failed-sweep note says failure, never "honest empty sweep"');

// ── wiring (main.js): the drain call site, the quiet tab, the consume mark, monologue-not-chat ─
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const _adjIdx = mainSrc.indexOf("[adjudicate] pass failed");
const _drainIdx = mainSrc.indexOf("_curationBurst('nightly-drain')");
ok(_adjIdx > -1 && _drainIdx > _adjIdx && _drainIdx - _adjIdx < 600, '⭐ the burst rides the nightly dedup drain, AFTER the adjudication consumer');
const _fnStart = mainSrc.indexOf('async function _curationBurst');
const _fnEnd = mainSrc.indexOf('let _roadRunInFlight', _fnStart);
const fnBody = _fnStart > -1 && _fnEnd > _fnStart ? mainSrc.slice(_fnStart, _fnEnd) : '';
ok(/canvas_tab: cb\.CURATOR_TAB/.test(fnBody), 'quiet canvas (rail 3): the spawn passes the designated curation tab');
ok(/_markRunConsumed\(runId, 'curation'\)/.test(fnBody), 'double-delivery cure: a harvested sweep is marked consumed');
ok(/insertMonologue/.test(fnBody) && !/fireToolFollowup/.test(fnBody), '⭐ the deposit lands in the MONOLOGUE, never the chat (the unprompted-channel law)');
ok(/agent-consume is the backstop/.test(fnBody), 'a late curator is left to the agent-consume backstop, honestly');
ok(/if \(cb\.sweepFailed\(out\)\) \{/.test(fnBody) && /db\.setMeta\(cb\.PACE_KEY, '0'\)/.test(fnBody), '⭐ a tool-failure sweep RETURNS its pace slot — the next drain retries');
ok(/spawn returned no run id — /.test(fnBody), 'a run-id-less spawn response is logged with its head (the silent dedupe read-through never hides again)');
ok(/curation\.kick/.test(mainSrc) && /_curationBurst\('operator-kick'\)/.test(mainSrc), 'the operator kick watcher is armed (the acceptance-drive door)');

// ── the engine-side manifest: registered, proposer-only whitelist ─────────────────────────────
const manifestPath = 'C:\\Users\\azrae\\Desktop\\NX ECHO\\nx-echo\\data\\agents\\people-curator.toml';
ok(fs.existsSync(manifestPath), '⭐ registration: the people-curator manifest stands in the engine registry');
if (fs.existsSync(manifestPath)) {
  const toml = fs.readFileSync(manifestPath, 'utf8');
  ok(/name\s*=\s*"people-curator"/.test(toml), 'manifest: the hyphenated name');
  ok(/"propose_entity"/.test(toml) && /"propose_relation"/.test(toml) && /"workspace_write_handoff"/.test(toml), 'manifest: the proposal doors + the deposit are the only writes');
  ok(!/"merge_entities"|"decide_resolution_proposal"|"update_contact"|"delete_relation"|"resolve_entity_conflict"/.test(toml),
    '⭐ THE ONE RAIL: no pen tool in the whitelist — curators propose, gates decide');
  ok(/propose, never write/.test(toml), 'manifest: the rail is written into the agent\'s own purpose');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
