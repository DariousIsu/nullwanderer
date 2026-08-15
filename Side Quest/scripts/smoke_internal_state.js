/* Smoke: lib/internal_state — Slice 0, the dark instrument (internal-state vector proposal).
 * Pure fixtures throughout: every reading is a function of injected exhaust; the dynamics decay
 * correctly; appraisal is coded + capped; tick persists current + journal; and the REPLAY
 * determinism contract holds (identical inputs → identical trajectories, byte for byte).
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_internal_state.js
 */
'use strict';
const is = require('../lib/internal_state');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const T = 3_000_000_000;
const H = 3600e3;

// drive readings
const rep = Array.from({ length: 20 }, () => ({ content: 'the same circling thought about the same thing', query: 'same topic' }));
const div = Array.from({ length: 20 }, (_, i) => ({ content: `a genuinely different reading number ${i} about subject ${i}`, query: `topic ${i}` }));
ok(is.curiosityReading(rep).value > 0.8, `curiosity: repetitive intake → starved (${is.curiosityReading(rep).value})`);
ok(is.curiosityReading(div).value < 0.2, `curiosity: diverse intake → fed (${is.curiosityReading(div).value})`);
ok(is.curiosityReading(rep.slice(0, 5)) === null, 'curiosity: too little intake → ABSENT (never guessed)');
ok(/intake diversity over 20/.test(is.curiosityReading(rep).prov), 'curiosity: provenance names the measurement');

ok(is.socialReading(0, T) === null, 'social: no turn ever seen → absent');
const s5 = is.socialReading(T - 5 * H, T).value;
ok(s5 > 0.45 && s5 < 0.55, `social: 5h gap ≈ half-risen (${s5})`);
ok(is.socialReading(T - 24 * H, T).value > 0.9, 'social: a day of silence → saturated');
ok(is.socialReading(T - 60e3, T).value < 0.01, 'social: just talked → quiet');

ok(is.energyReading(null) === null && is.energyReading({ known: false }) === null, 'energy: no quota configured → ABSENT, not defaulted');
ok(is.energyReading({ known: true, usedPct: 0.62, hoursLeft: 20 }).value === 0.62, 'energy: exhaustion = pool spend');

ok(is.progressReading(null, T) === null && is.progressReading([], T) === null, 'progress: no worklist → absent');
const th = (ago) => ({ last_touched_ts: T - ago });
ok(is.progressReading([th(1 * H), th(2 * H), th(3 * H)], T).value === 0, 'progress: everything moving → no pressure');
ok(is.progressReading([th(80 * H), th(90 * H)], T).value === 1, 'progress: everything stalled → full itch');
ok(is.progressReading([th(1 * H), th(80 * H)], T).value === 0.5, 'progress: half moving → 0.5');

// vad dynamics
const disp = { v: 0.95, a: 0.85, d: 0.1 };
const half = is.decayVad(disp, is.VAD_HALF_LIFE_MS);
ok(Math.abs(half.v - (is.VAD_BASELINE.v + (0.95 - is.VAD_BASELINE.v) / 2)) < 0.001, 'vad: one half-life → halfway home');
ok(is.decayVad(is.VAD_BASELINE, 10 * H).v === is.VAD_BASELINE.v, 'vad: at baseline, decay is a no-op');
const imp = is.appraiseEvents([{ level: 'error', lane: 'db' }, { level: 'warn', kind: 'anomaly', lane: 'machine' }, { kind: 'need', level: 'warn' }]);
ok(imp.dv < 0 && imp.da > 0 && imp.why.length === 3, `appraisal: coded impulses with why (${imp.why.join(',')})`);
const flood = is.appraiseEvents(Array.from({ length: 50 }, () => ({ level: 'error', lane: 'x' })));
ok(flood.dv === -0.12 && flood.da <= 0.12, 'appraisal: a flood is CAPPED (the lurch bound)');
ok(is.appraiseEvents([]).dv === 0, 'appraisal: quiet → zero impulse');

// tick + persistence + replay determinism
const mk = () => { const st = {}; return { st, deps: { db: { getMeta: (k) => st[k], setMeta: (k, v) => { st[k] = v; }, getDb: () => { throw new Error('no live db in smoke'); }, getActiveOpenThreads: () => { throw new Error('injected'); } } } }; };
const inputs = (deps) => ({
  deps: { ...deps, monologueRows: rep, openThreads: [th(1 * H), th(80 * H)], quotaState: { known: true, usedPct: 0.6, hoursLeft: 21 }, lastUserTurnTs: T - 5 * H, events: [{ id: 7, level: 'error', lane: 'db' }] },
});
const A = mk(), B = mk();
const t1 = is.tick({ ...inputs(A.deps), nowMs: T });
ok(t1.drives.curiosity > 0.8 && t1.drives.energy === 0.6 && t1.drives.progress === 0.5, 'tick: all four drives read');
ok(t1.vad.v < is.VAD_BASELINE.v && t1.vad.a > is.VAD_BASELINE.a, 'tick: the error event moved affect off baseline');
ok(t1.obsCursor === 7, 'tick: obs cursor advances (events consumed once)');
ok(!!A.st[is.STATE_KEY] && JSON.parse(A.st[is.JOURNAL_KEY]).length === 1, 'tick: current + journal persisted');
const t2 = is.tick({ ...inputs(A.deps), deps: { ...inputs(A.deps).deps, events: [] }, nowMs: T + 2 * H });
ok(t2.vad.v > t1.vad.v && t2.vad.v < is.VAD_BASELINE.v, 'tick 2: quiet interval → affect decays TOWARD baseline, not past it');
ok(JSON.parse(A.st[is.JOURNAL_KEY]).length === 2, 'journal grows per tick');
// replay: a fresh store fed the identical inputs reproduces the trajectory byte-for-byte
is.tick({ ...inputs(B.deps), nowMs: T });
is.tick({ ...inputs(B.deps), deps: { ...inputs(B.deps).deps, events: [] }, nowMs: T + 2 * H });
ok(B.st[is.JOURNAL_KEY] === A.st[is.JOURNAL_KEY], 'REPLAY DETERMINISM: identical inputs → identical journal, byte for byte');
// journal cap
const C = mk();
for (let i = 0; i < is.JOURNAL_CAP + 40; i++) is.tick({ ...inputs(C.deps), nowMs: T + i * 60e3 });
ok(JSON.parse(C.st[is.JOURNAL_KEY]).length === is.JOURNAL_CAP, `journal capped at ${is.JOURNAL_CAP}`);
// THE DARKNESS CONTRACT: slice 0 must not light the status-vector seam
ok(A.st['drive_gauge'] === undefined && C.st['drive_gauge'] === undefined, 'DARK: meta drive_gauge is never written (zero consumers until the 48h proof)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
