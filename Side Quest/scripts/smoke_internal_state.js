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
// appraisal = CURATED state signals only (2026-08-15 recalibration): machine/db anomalies + minted needs
const imp = is.appraiseEvents([{ kind: 'anomaly', lane: 'machine', ref: 'disk_low' }, { kind: 'need', lane: 'watch', ref: 'need:5' }]);
ok(imp.dv < 0 && imp.da > 0 && imp.why.length === 2, `appraisal: curated stress + need impulses with why (${imp.why.join(',')})`);
ok(is.appraiseEvents([{ kind: 'anomaly', lane: 'anomaly', ref: '-', level: 'error' }]).da === 0, 'appraisal: the self_watch console FIREHOSE (lane=anomaly) is NOT appraised — the pinning-bug fix');
ok(is.appraiseEvents([{ level: 'error', lane: 'echo', kind: 'line' }, { level: 'warn', lane: 'window', kind: 'line' }]).dv === 0, 'appraisal: routine error/warn LINES (deprecation noise, tool chatter) are not affective');
const dupd = is.appraiseEvents(Array.from({ length: 24 }, () => ({ kind: 'anomaly', lane: 'machine', ref: 'disk_low' })));
ok(Math.abs(dupd.da - is.appraiseEvents([{ kind: 'anomaly', lane: 'machine', ref: 'disk_low' }]).da) < 1e-9, 'appraisal: 24 re-emits of ONE condition (signature dedupe) = one signal, not 24 (no saturation)');
const flood = is.appraiseEvents(Array.from({ length: 50 }, (_, i) => ({ kind: 'anomaly', lane: 'machine', ref: 'r' + i })));
ok(flood.da === 0.12, 'appraisal: 50 DISTINCT stressors → still CAPPED at +0.12 (the lurch bound)');
ok(is.appraiseEvents([]).dv === 0, 'appraisal: quiet → zero impulse');
// ── v3 APPRAISAL SYMMETRY (2026-08-31 — the 51h honesty read): with only need/anomaly impulses,
// valence could never rise, and v/a sat PINNED at the deviation band's edges for all 300 journal
// entries (v∈[0.25,0.29], a∈[0.73,0.75] — information-free). Wins now move it up.
const win = is.appraiseEvents([{ kind: 'win', lane: 'pursuit', ref: 'rq:9' }]);
ok(win.dv > 0 && win.dd > 0 && win.why[0] === 'win:pursuit', `appraisal v3: a resolved pursuit lifts valence + dominance (${win.why.join(',')})`);
const mixed = is.appraiseEvents([{ kind: 'win', lane: 'road', ref: 'slug' }, { kind: 'anomaly', lane: 'machine', ref: 'disk_low' }]);
ok(mixed.dv > -0.03 && mixed.dv < 0.05 && mixed.why.length === 2, 'appraisal v3: a win and a stressor NET (both signs live in one tick)');
const windup = is.appraiseEvents(Array.from({ length: 30 }, () => ({ kind: 'win', lane: 'pursuit', ref: 'rq:9' })));
ok(Math.abs(windup.dv - win.dv) < 1e-9, 'appraisal v3: 30 re-emits of ONE win (signature dedupe) = one signal — no euphoria pinning');
const winflood = is.appraiseEvents(Array.from({ length: 50 }, (_, i) => ({ kind: 'win', lane: 'pursuit', ref: 'rq:' + i })));
ok(winflood.dv === 0.12, 'appraisal v3: 50 distinct wins still CAPPED at +0.12 (the lurch bound is symmetric)');
ok(is.MODEL_VERSION === 3, 'v3: MODEL_VERSION bumped — the saturated v2 journal restarts clean');
// wiring: the two win emitters exist (the exhaust actually carries wins now)
{
  const fsw = require('fs'), pathw = require('path');
  const rq = fsw.readFileSync(pathw.join(__dirname, '..', 'lib', 'recheck_queue.js'), 'utf8');
  ok(/kind: 'win'/.test(rq) && /lane: 'pursuit'/.test(rq), '⭐ wiring: recheck_queue.complete emits the pursuit-resolved win (the universal satisfaction signal)');
  const mainw = fsw.readFileSync(pathw.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/lane: 'road', kind: 'win'/.test(mainw), '⭐ wiring: a registered road delivery emits a competence win');
}
// bounded deviation: sustained stress reads "elevated", never pinned at the extreme
let vad = is.VAD_BASELINE;
for (let i = 0; i < 40; i++) { const d = is.decayVad(vad, 0); const a = is.appraiseEvents([{ kind: 'anomaly', lane: 'machine', ref: 'disk_low' }]); vad = { v: d.v + a.dv, a: d.a + a.da, d: d.d + a.dd }; }
const boundA = Math.min(1, Math.max(is.VAD_BASELINE.a - is.VAD_MAX_DEV, Math.min(is.VAD_BASELINE.a + is.VAD_MAX_DEV, vad.a)));
ok(is.VAD_BASELINE.a + is.VAD_MAX_DEV <= 0.999, 'bounded deviation: arousal ceiling (baseline+MAX_DEV) is below saturation — never pins at 1.0');

// tick + persistence + replay determinism
const mk = () => { const st = {}; return { st, deps: { db: { getMeta: (k) => st[k], setMeta: (k, v) => { st[k] = v; }, getDb: () => { throw new Error('no live db in smoke'); }, getActiveOpenThreads: () => { throw new Error('injected'); } } } }; };
const inputs = (deps) => ({
  deps: { ...deps, monologueRows: rep, openThreads: [th(1 * H), th(80 * H)], quotaState: { known: true, usedPct: 0.6, hoursLeft: 21 }, lastUserTurnTs: T - 5 * H, events: [{ id: 7, kind: 'anomaly', lane: 'db', ref: 'wal' }] },
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

// ── W5 SLICES 1–2 CONSUMER CONTRACTS (2026-08-20 — the instrument goes live, FAIL-ABSENT) ───────
{
  const mkDb = (st) => ({ db: { getMeta: (k) => st[k] } });
  const T2 = Date.UTC(2026, 7, 20, 12);
  const fresh = { at: T2 - 5 * 60e3, mv: is.MODEL_VERSION, drives: { curiosity: 0.82, social: 0.3, energy: 0.2, progress: 0.8 }, vad: { v: 0.5, a: 0.58, d: 0.5 }, prov: { vad: 'impulses: need:self_watch' } };
  const st1 = { [is.STATE_KEY]: JSON.stringify(fresh) };
  ok(is.current({ deps: mkDb(st1), nowMs: T2 }) !== null, 'current(): a fresh vector reads');
  ok(is.current({ deps: mkDb({ [is.STATE_KEY]: JSON.stringify({ ...fresh, at: T2 - 3 * 3600e3 }) }), nowMs: T2 }) === null, 'current(): a STALE vector is null (fail-absent)');
  ok(is.current({ deps: mkDb({ [is.STATE_KEY]: JSON.stringify({ ...fresh, mv: is.MODEL_VERSION - 1 }) }), nowMs: T2 }) === null, 'current(): a version-mismatched vector is null (another instrument)');
  ok(is.current({ deps: mkDb({}), nowMs: T2 }) === null, 'current(): absent → null');

  const line = is.readingsLine({ deps: mkDb(st1), nowMs: T2 });
  ok(!!line && /novelty-starvation high \(0\.82\)/.test(line), 'Slice 1: readingsLine renders drives with values (measurement, not vibes)');
  ok(/measured 5m ago/.test(line), '…and carries its age (a reading, with provenance)');
  ok(is.readingsLine({ deps: mkDb({}), nowMs: T2 }) === null, 'Slice 1: absent vector → null line (the mood prompt is byte-identical)');

  const w = is.tickWeights(fresh);
  ok(!w.neutral && w.exploreGateMult === 0.5 && w.graphMovesDelta === 2, 'Slice 2: starved curiosity + stalled progress → explore sooner, +2 graph moves');
  const tired = is.tickWeights({ drives: { curiosity: 0.2, energy: 0.9, progress: 0.1 } });
  ok(!tired.neutral && tired.exploreGateMult === 1.75 && tired.graphMovesDelta === -1, 'Slice 2: exhausted energy → longer gates, −1 move');
  ok(is.tickWeights(null).neutral && is.tickWeights(null).exploreGateMult === 1 && is.tickWeights(null).graphMovesDelta === 0, 'Slice 2: no vector → NEUTRAL (byte-identical tick)');
  ok(is.tickWeights({ drives: { curiosity: 0.5, energy: 0.5, progress: 0.5 } }).neutral, 'Slice 2: unpressured drives → neutral (weights fire on pressure, not presence)');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
