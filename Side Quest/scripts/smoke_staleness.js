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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
