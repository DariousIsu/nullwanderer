/* Smoke: lib/staleness.js — TTL/freshness classification (pure, deterministic, injected `now`).
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_staleness.js
 */
'use strict';
const s = require('../lib/staleness');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const NOW = Date.parse('2026-07-08');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString().slice(0, 10);

// ── ttlDays classification ──
ok(s.ttlDays('The current Secretary of Defense is Pete Hegseth.') === 45, 'current office-holder → volatile (45d)');
ok(s.ttlDays('Kevin D. Roberts is the President of the Heritage Foundation.') === 45, 'current "President of X" → volatile');
ok(s.ttlDays('The Heritage Foundation was founded on February 16, 1973.') === null, 'founding date → permanent (never stale)');
ok(s.ttlDays('Grace Hopper was born on December 9, 1906.') === null, 'birth date → permanent');
ok(s.ttlDays('The company makes networking chips for data centers.') === 1460, 'a slow-changing descriptive fact → stable');
// volatile wins over a year cue (a role can change even if it names a year)
ok(s.ttlDays('He has served as president since 2025.') === 45, 'current role + year → volatile (role can turn over)');

// ── isStale (needs as_of + past TTL) ──
ok(s.isStale({ content: 'current EPA administrator is X', provenance: { as_of: daysAgo(60) } }, NOW) === true, 'volatile fact 60d old → stale (past 45d)');
ok(s.isStale({ content: 'current EPA administrator is X', provenance: { as_of: daysAgo(10) } }, NOW) === false, 'volatile fact 10d old → fresh');
ok(s.isStale({ content: 'Founded in 1973', provenance: { as_of: daysAgo(9999) } }, NOW) === false, 'permanent fact, any age → never stale');
ok(s.isStale({ content: 'current CEO is X', provenance: {} }, NOW) === false, 'undated fact → not flagged (can\'t judge)');
ok(s.isStale(null, NOW) === false, 'null fact → false (fail-safe)');
ok(s.ageDays('not-a-date', NOW) === Infinity, 'unparseable as_of → Infinity');

// ── partition ──
const part = s.partition([
  { content: 'current chair is A', provenance: { as_of: daysAgo(90) } },   // stale
  { content: 'current chair is A', provenance: { as_of: daysAgo(5) } },    // fresh
  { content: 'founded 1973', provenance: { as_of: daysAgo(9999) } },       // permanent → fresh
], NOW);
ok(part.stale.length === 1 && part.fresh.length === 2, 'partition splits stale (1) vs fresh/permanent (2)');

// ── CONTINUOUS FRESHNESS (Phase A4): a decaying ranking weight, never 0, never deleted ──
ok(s.freshness(NOW, NOW, { halfLifeDays: 10 }) === 1, 'brand-new → freshness 1');
ok(s.freshness(NOW + 86400000, NOW, { halfLifeDays: 10 }) === 1, 'future → 1 (fully fresh)');
ok(Math.abs(s.freshness(NOW - 10 * 86400000, NOW, { halfLifeDays: 10 }) - 0.5) < 1e-9, 'one half-life old → 0.5');
ok(Math.abs(s.freshness(NOW - 20 * 86400000, NOW, { halfLifeDays: 10 }) - 0.25) < 1e-9, 'two half-lives → 0.25');
const old = s.freshness(NOW - 3650 * 86400000, NOW, { halfLifeDays: 10 });
ok(old > 0 && old <= 0.05, 'ancient → decays to the FLOOR (0.05), never 0 — stale becomes historical, not deleted');
ok(s.freshness(NOW - 9999 * 86400000, NOW, { halfLifeDays: null }) === 1, 'permanent (null half-life) → always fresh, no decay');
ok(s.freshness(null, NOW) === 0.05, 'undatable → historical floor (still surfaces, weighted low)');
// accepts epoch seconds (Echo occurred_at) as well as ms
ok(Math.abs(s.freshness(Math.floor((NOW - 10 * 86400000) / 1000), NOW, { halfLifeDays: 10 }) - 0.5) < 1e-3, 'accepts epoch SECONDS (Echo occurred_at) → same 0.5 at one half-life');
// half-life agrees with the binary classifier
ok(s.halfLifeFor('the current CEO is X') === s.HALF_LIFE_DAYS.volatile, 'halfLifeFor: volatile text → short half-life');
ok(s.halfLifeFor('founded in 1973') === null, 'halfLifeFor: permanent text → no decay');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
