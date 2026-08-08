'use strict';
/* smoke_pathway_cadence.js — M8.4 self-test cadence (lib/pathway_cadence.js).
 * Pure decide() gates + the stdout parse contract + a full offline tick with an injected suite.
 * Run: node scripts/smoke_pathway_cadence.js */
const path = require('path');
const pc = require(path.join(__dirname, '..', 'lib', 'pathway_cadence'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', n); } };

// A fixed instant inside the night window: 2026-08-08 03:30 ET = 07:30 UTC (EDT, UTC-4).
const NIGHT = Date.UTC(2026, 7, 8, 7, 30, 0);
// Midday: 2026-08-08 13:00 ET = 17:00 UTC.
const NOON = Date.UTC(2026, 7, 8, 17, 0, 0);
const IDLE = 45 * 60 * 1000;

// ── decide(): every gate, one at a time ─────────────────────────────────────────────────────────
ok('night + idle + quota → RUN', pc.decide({ now: NIGHT, userIdleMs: IDLE, quotaAllow: true, enabled: true }).run === true);
ok('run carries the ET day stamp', pc.decide({ now: NIGHT, userIdleMs: IDLE, quotaAllow: true, enabled: true }).day === '2026-08-08');
ok('disabled → never', pc.decide({ now: NIGHT, userIdleMs: IDLE, quotaAllow: true, enabled: false }).run === false);
ok('already ran today → never', pc.decide({ now: NIGHT, lastRunDay: '2026-08-08', userIdleMs: IDLE, quotaAllow: true, enabled: true }).run === false);
ok('yesterday\'s run does not block', pc.decide({ now: NIGHT, lastRunDay: '2026-08-07', userIdleMs: IDLE, quotaAllow: true, enabled: true }).run === true);
ok('midday → outside window', (() => { const d = pc.decide({ now: NOON, userIdleMs: IDLE, quotaAllow: true, enabled: true }); return !d.run && /window/.test(d.reason); })());
ok('Lucas active 10m ago → hold', (() => { const d = pc.decide({ now: NIGHT, userIdleMs: 10 * 60 * 1000, quotaAllow: true, enabled: true }); return !d.run && /active/.test(d.reason); })());
ok('quota holds → hold with the reason', (() => { const d = pc.decide({ now: NIGHT, userIdleMs: IDLE, quotaAllow: false, quotaReason: 'idle stops at 85%', enabled: true }); return !d.run && /85%/.test(d.reason); })());

// ── parseResults(): the suite's own line format is the contract ─────────────────────────────────
const OUT = [
  'pathway_suite corpus…',
  '[contacts-precedence] running… PASS (41s)',
  '[vague-edit-honesty] running… FAIL',
  '    missing: /\\[canvas-cmd\\] edit (applied|NOT applied|output REJECTED)/',
  '[pullup-retrieval] running… PASS (28s, UNSETTLED)',
  '[draw-yield-in-session] running… ERROR socket hang up',
  'pathway_suite: 2 passed, 2 failed',
].join('\n');
const R = pc.parseResults(OUT);
ok('4 cases parsed', R.cases.length === 4);
ok('tally line wins', R.pass === 2 && R.fail === 2 && R.tallied);
ok('PASS with suffix is ok:true', R.cases[0].ok && R.cases[2].ok);
ok('FAIL captures the missing detail', !R.cases[1].ok && /missing:/.test(R.cases[1].detail));
ok('ERROR is a failure with its message', !R.cases[3].ok && /socket hang up/.test(R.cases[3].detail));
ok('empty output → zero cases, zero tally', (() => { const r = pc.parseResults(''); return r.cases.length === 0 && r.pass === 0 && r.fail === 0 && !r.tallied; })());

// ── tick(): full offline circuit with an injected suite ─────────────────────────────────────────
(async () => {
  const meta = {};
  const logs = [];
  const needs = [];
  const deps = {
    getMeta: (k) => meta[k] || '', setMeta: (k, v) => { meta[k] = String(v); },
    userIdleMs: () => IDLE,
    quotaAllow: () => ({ allow: true, reason: 'within pace' }),
    appDir: path.join(__dirname, '..'),
    recordNeed: (need, o) => { needs.push({ need, bornFrom: o.bornFrom }); return { id: needs.length }; },
    log: (m) => logs.push(m),
    runSuiteImpl: async () => ({ code: 1, out: OUT, err: '' }),
    nowMs: NIGHT,
  };

  let r = await pc.tick(deps);
  ok('tick runs in the window', r.ran === true && r.pass === 2 && r.fail === 2);
  ok('day stamped BEFORE results (crash-safe)', meta['pathway.last_run_day'] === '2026-08-08');
  ok('last_result recorded', /"pass":2/.test(meta['pathway.last_result']));
  ok('each failure filed as a need with pathway born_from', needs.length === 2 && needs.every((n) => /^pathway:/.test(n.bornFrom)) && /vague-edit-honesty/.test(needs[0].need));
  ok('failures logged with detail', logs.some((l) => /FAIL vague-edit-honesty/.test(l)));

  r = await pc.tick(deps);
  ok('second tick same night → already ran, no re-run', r.ran === false && /already ran/.test(r.reason) && needs.length === 2);

  // skip logging: once per day, and "already ran" stays quiet
  const meta2 = {}, logs2 = [];
  const deps2 = { ...deps, getMeta: (k) => meta2[k] || '', setMeta: (k, v) => { meta2[k] = String(v); }, userIdleMs: () => 0, log: (m) => logs2.push(m) };
  await pc.tick(deps2);
  await pc.tick(deps2);
  ok('skip reason logged ONCE per day', logs2.filter((l) => /skipped/.test(l)).length === 1);

  // quota hold blocks the launch
  const meta3 = {}; const needs3 = [];
  const r3 = await pc.tick({ ...deps, getMeta: (k) => meta3[k] || '', setMeta: (k, v) => { meta3[k] = String(v); }, quotaAllow: () => ({ allow: false, reason: 'idle stops at 85% of the pool' }), recordNeed: (n, o) => { needs3.push(n); return { id: 1 }; }, log: () => {} });
  ok('quota hold → no run, no needs, no day stamp', r3.ran === false && needs3.length === 0 && !meta3['pathway.last_run_day']);

  console.log(`smoke_pathway_cadence: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
