'use strict';
/* smoke_usage_meter_durable.js — M1.1a: prove the usage meter survives a "reboot" via persist/restore.
 * Offline, injected store (no db). Run: node scripts/smoke_usage_meter_durable.js */
const path = require('path');
const um = require(path.join(__dirname, '..', 'lib', 'usage_meter'));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error('  FAIL:', n); } };

const T = 1_700_000_000_000;           // fixed base ts
const store = {};                       // fake meta store
const setMeta = (k, v) => { store[k] = v; };
const getMeta = (k) => store[k];

um.reset();
um.record('kimi-k2.6', 1000, T);
um.record('gemma4:31b', 500, T + 1000);
um.record('kimi-k2.6', 250, T + 2000);
ok('ring has 3', um._size() === 3);
const s1 = um.summary({ now: T + 3000, windowMs: um.DAY_MS });
ok('summary total 1750', s1.total === 1750);

// persist (throttle bypassed via force) → fake store holds JSON
ok('persist wrote', um.persist(T + 3000, { setMeta, force: true }) === true);
ok('store has key', typeof store['usage.meter.ring'] === 'string');
ok('persist no-op when clean', um.persist(T + 3000, { setMeta, force: true }) === false);

// simulate REBOOT: wipe in-memory ring, restore from store
um.reset();
ok('ring empty after reset', um._size() === 0);
const n = um.restore(T + 4000, { getMeta });
ok('restored 3', n === 3);
const s2 = um.summary({ now: T + 4000, windowMs: um.DAY_MS });
ok('restored total 1750', s2.total === 1750);
ok('restored byModel kimi 1250', s2.byModel['kimi-k2.6'] === 1250);

// retention: an entry older than RETAIN_MS is dropped on restore
um.reset();
store['usage.meter.ring'] = JSON.stringify([
  { model: 'old', tokens: 999, ts: T - um.RETAIN_MS - 1 },   // stale → dropped
  { model: 'fresh', tokens: 42, ts: T },                      // kept
]);
const n2 = um.restore(T + 1000, { getMeta });
ok('retention drops stale', n2 === 1);
ok('only fresh survives', um.summary({ now: T + 1000 }).byModel['fresh'] === 42 && !um.summary({ now: T + 1000 }).byModel['old']);

// corrupt/absent meta → fail-soft (0, no throw)
um.reset();
ok('absent meta → 0', um.restore(T, { getMeta: () => null }) === 0);
ok('corrupt meta → 0', um.restore(T, { getMeta: () => '{not json' }) === 0);

console.log(`\nsmoke_usage_meter_durable: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
