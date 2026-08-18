'use strict';
// smoke_producer_vitals.js — Wave 1 producer heartbeat (lib/producer_vitals.js). Proves it catches a
// SILENTLY-dark lane (the synthesis 48-day case) without false-flagging a lane that just hasn't ticked
// yet this boot, and that a stall escalates through obs_bus (rate-limited) + persists to meta.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_producer_vitals.js
const pv = require('../lib/producer_vitals');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const DAY = 24 * 60 * 60 * 1000, HOUR = 60 * 60 * 1000, MIN = 60000;
const base = 1_700_000_000_000;

// ---- evaluate(): boot-grace ----
{
  const r = pv.evaluate([{ name: 'synthesis', lastTs: base - 48 * DAY, maxAgeMs: DAY }], { nowMs: base, uptimeMs: 2 * MIN });
  ok(r.skipped === 'boot-grace' && r.producers.length === 0, 'boot-grace: nothing judged in the first ~5 min of uptime');
}

// ---- evaluate(): a genuinely OLD last-write flags immediately, regardless of low uptime ----
{
  const r = pv.evaluate([{ name: 'synthesis', lastTs: base - 48 * DAY, maxAgeMs: DAY }], { nowMs: base, uptimeMs: 10 * MIN });
  const p = r.producers[0];
  ok(p.stalled && p.reason === 'stale', '48-day-dark synthesis flags at 10 min uptime (pre-boot silence counts)');
  ok(p.ageMs === 48 * DAY, 'age computed from the last write');
}

// ---- evaluate(): a fresh write is NOT a stall ----
{
  const r = pv.evaluate([{ name: 'subconscious', lastTs: base - 1 * HOUR, maxAgeMs: 6 * HOUR }], { nowMs: base, uptimeMs: 10 * MIN });
  ok(!r.producers[0].stalled, 'a lane that wrote 1h ago (window 6h) is not stalled');
}

// ---- evaluate(): null last-write — silent only after a full window of uptime ----
{
  const early = pv.evaluate([{ name: 'synthesis', lastTs: null, maxAgeMs: DAY }], { nowMs: base, uptimeMs: 3 * HOUR });
  ok(!early.producers[0].stalled, 'never-written + uptime < window → not yet a stall (can\'t tell new from broken)');
  const late = pv.evaluate([{ name: 'synthesis', lastTs: null, maxAgeMs: DAY }], { nowMs: base, uptimeMs: 2 * DAY });
  ok(late.producers[0].stalled && late.producers[0].reason === 'silent', 'never-written + uptime > window → silent stall');
}

// ---- describe(): fail-absent when healthy, phrase when stalled ----
ok(pv.describe({ at: base, producers: [{ name: 'x', stalled: false }] }) === null, 'describe is null (no noise) when all producers healthy');
{
  const d = pv.describe({ at: base, producers: [{ name: 'synthesis', stalled: true, reason: 'stale', ageMs: 48 * DAY }] });
  ok(/synthesis/.test(d) && /⚠/.test(d), 'describe names the quiet lane with a warning');
}

// ---- humanAge ----
ok(pv.humanAge(48 * DAY) === '48d' && pv.humanAge(3 * HOUR) === '3h' && pv.humanAge(12 * MIN) === '12m', 'humanAge formats d/h/m');

// ---- sample(): mock db + bus → emit stall, persist meta, rate-limit the renag ----
function mockDb({ synthesisTs, anyTs }) {
  const meta = {};
  return {
    getRecentMonologueByType: (type) => (type === 'synthesis' && synthesisTs != null) ? [{ ts: synthesisTs }] : [],
    getRecentMonologue: () => (anyTs != null ? [{ ts: anyTs }] : []),
    setMeta: (k, v) => { meta[k] = v; },
    _meta: meta,
  };
}
function mockBus() { const calls = []; return { emit: (evt) => { calls.push(evt); return { id: calls.length }; }, calls }; }
{
  const db = mockDb({ synthesisTs: base - 48 * DAY, anyTs: base - 30 * MIN });   // synthesis dark 48d; idle loop fresh
  const bus = mockBus();
  const r1 = pv.sample({ deps: { db, obsBus: bus }, nowMs: base, uptimeMs: 10 * MIN });
  ok(r1.stalledCount === 1, 'sample: exactly the dark synthesis lane is stalled (idle loop is fresh)');
  ok(bus.calls.length === 1 && bus.calls[0].ref === 'synthesis' && bus.calls[0].lane === 'producer' && bus.calls[0].level === 'warn',
     'sample: escalates one producer stall through obs_bus (lane=producer, warn)');
  ok(db._meta.producer_vitals && JSON.parse(db._meta.producer_vitals).stalledCount === 1, 'sample: persists producer_vitals meta');
  const r2 = pv.sample({ deps: { db, obsBus: bus }, nowMs: base + 60 * MIN, uptimeMs: 70 * MIN });
  ok(r2.stalledCount === 1 && bus.calls.length === 1, 'sample: rate-limited — still stalled, but no re-emit within the cooldown');
}

// ---- sample(): a read-FAILURE is skipped (fail-absent), never a false stall ----
{
  const bus = mockBus();
  const r = pv.sample({ deps: {
    db: { setMeta: () => {} }, obsBus: bus,
    producers: [{ name: 'boom', maxAgeMs: HOUR, note: 'unreadable', read: () => { throw new Error('db not initialized'); } }],
  }, nowMs: base, uptimeMs: 10 * MIN });
  ok(r.producers.length === 0 && r.stalledCount === 0 && bus.calls.length === 0, 'a read-failure is skipped (unknown ≠ stall), no false anomaly');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
