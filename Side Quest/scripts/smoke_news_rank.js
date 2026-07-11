/* Smoke: lib/news_rank — the tuner's shared reserve/weight/cap selector. Pure.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_rank.js */
'use strict';
const R = require('../lib/news_rank');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ===== defaults + normalize =====
const d = R.defaultTuner();
ok(d.categories.weather.protected === true && d.categories.weather.capPct === null, 'default: weather protected + uncapped');
ok(d.categories.sports.capPct === 20 && d.categories.sports.protected === false, 'default: sports capped 20% + unprotected');
ok(d.reservedSlots.feed === 12 && d.reservedSlots.brief === 5, 'default reserved slots');
const bad = R.normalizeTuner('garbage');
ok(bad.categories.world.weight === 1.4, 'broken config → defaults (fail-safe)');
const part = R.normalizeTuner({ categories: { sports: { weight: 0 }, world: { weight: 9 } } });
ok(part.categories.sports.weight === 0 && part.categories.world.weight === 3, 'partial merge: sets sports 0, clamps world to 3');

// helper to build items
const mk = (category, baseScore, n = 1) => Array.from({ length: n }, (_, i) => ({ id: `${category}-${i}`, category, baseScore }));
const score = (it) => it.baseScore;

// ===== the World Cup flood scenario (slots 10, reserved 4) =====
const flood = [
  ...mk('sports', 100, 8),    // loud + high base
  ...mk('world', 50, 3),
  ...mk('politics', 40, 2),
  ...mk('local', 30, 1),
  ...mk('culture', 90, 1),
];
const a = R.arrange(flood, d, { slots: 10, reserved: 4, scoreOf: score });
const count = (cat) => a.items.filter((i) => i.category === cat).length;
ok(a.reservedFilled === 4, 'reserve: 4 protected slots filled');
ok(a.items.slice(0, 4).every((i) => d.categories[i.category].protected), 'reserve: top 4 are all protected (hard news pinned above the sports flood)');
ok(count('sports') === 2, 'cap: 8 sports collapse to 2 (20% of 10) — cannot drown out');
ok(count('culture') === 1, 'cap: culture capped to 1 (15% of 10)');
ok(count('world') === 3 && count('politics') === 2 && count('local') === 1, 'hard-news categories fully represented');
ok(a.total === 9, 'total = 9 (only 9 items survive the caps out of 15)');

// ===== weather is uncapped =====
const wx = R.arrange([...mk('weather', 10, 8), ...mk('sports', 100, 5)], d, { slots: 10, reserved: 4, scoreOf: score });
ok(wx.items.filter((i) => i.category === 'weather').length === 8, 'weather uncapped: all 8 weather items kept');
ok(wx.items.filter((i) => i.category === 'sports').length === 2, 'sports still capped alongside uncapped weather');

// ===== mute (weight 0) drops a category =====
const muted = R.normalizeTuner({ categories: { sports: { weight: 0 } } });
const m = R.arrange([...mk('sports', 100, 5), ...mk('world', 10, 3)], muted, { slots: 10, reserved: 0, scoreOf: score });
ok(m.items.every((i) => i.category !== 'sports') && m.items.length === 3, 'mute: sports (weight 0) fully dropped');

// ===== reserved shortfall falls through (no holes) =====
const few = R.arrange([...mk('world', 50, 1), ...mk('sports', 100, 6)], d, { slots: 5, reserved: 4, scoreOf: score });
ok(few.reservedFilled === 1, 'reserve shortfall: only 1 protected available → reservedFilled 1');
ok(few.total === 2 && few.items.filter((i) => i.category === 'sports').length === 1, 'shortfall fills through: 1 world + 1 sports (sports cap = 20% of 5 = 1), no empty reserved holes');

// ===== unknown category → fallback bucket, weighted =====
const unk = R.arrange([{ id: 'x', category: 'not-a-real-cat', baseScore: 100 }], d, { slots: 5, reserved: 0, scoreOf: score });
ok(unk.items.length === 1, 'unknown category treated as fallback (culture), still ranked');

// ===== A4: freshnessOf multiplies the score — stale sinks in rank, never dropped =====
// Same category (world), FRESH story has LOWER base than a STALE one; freshness should flip their order.
const twoWorld = [{ id: 'stale', category: 'world', baseScore: 100, fresh: 0.1 }, { id: 'fresh', category: 'world', baseScore: 60, fresh: 1.0 }];
const noFresh = R.arrange(twoWorld, d, { slots: 5, reserved: 0, scoreOf: (i) => i.baseScore });
ok(noFresh.items[0].id === 'stale', 'without freshnessOf: the higher base (stale, 100) ranks first (unchanged default behavior)');
const withFresh = R.arrange(twoWorld, d, { slots: 5, reserved: 0, scoreOf: (i) => i.baseScore, freshnessOf: (i) => i.fresh });
ok(withFresh.items[0].id === 'fresh', 'with freshnessOf: fresh (60×1.0=60) outranks stale (100×0.1=10) — recency wins');
ok(withFresh.items.length === 2, 'freshnessOf demotes but never DROPS the stale item (floored, still present)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
