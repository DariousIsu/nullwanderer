/* Smoke: lib/promote_gate — confidence + domain gate that closes the landing loop (offline).
 * Proof: trustworthy civic → promote; off-domain → reject; mid/legacy → review; low → hold.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_promote_gate.js
 */
'use strict';
const G = require('../lib/promote_gate');
const CM = require('../lib/confidence_model');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- effectiveConfidence: recompute calibrated from provenance; fall back to stored ---
const highMeta = { name: 'Acme PAC', relation_metadata: JSON.stringify({ grade: 'B', corroboration: 3 }) };
ok(Math.abs(G.effectiveConfidence(highMeta) - CM.calibratedConfidence({ grade: 'B', corroboration: 3 })) < 1e-9, 'effectiveConfidence: recomputed calibrated from metadata (B, corr 3)');
ok(G.effectiveConfidence({ confidence: 0.8 }) === 0.8, 'effectiveConfidence: legacy proposal (no metadata) → stored value');

// --- classify: the four decisions ---
ok(G.classify({ name: 'Florida Democratic Party', relation_metadata: JSON.stringify({ grade: 'B', corroboration: 3 }) }).decision === 'promote', 'promote: civic + A-band calibrated (corroborated)');
ok(G.classify({ name: 'Dave Bowen (footballer)', relation_metadata: JSON.stringify({ grade: 'A', corroboration: 9 }) }).decision === 'reject', 'reject: off-domain, even at high confidence');
ok(G.classify({ name: 'Some Civic Org', confidence: 0.8 }).decision === 'review', 'review: legacy flat-0.8 civic → operator review (not auto-promote)');
ok(G.classify({ name: 'Thin Civic Node', relation_metadata: JSON.stringify({ grade: 'D', corroboration: 1 }) }).decision === 'hold', 'hold: low calibrated confidence → chase corroboration first');
ok(G.classify({ name: 'No Conf Node' }).decision === 'hold' && G.classify({ name: 'No Conf Node' }).reason === 'no-confidence', 'hold: no confidence signal at all');

// --- relations: BOTH endpoints must be civic ---
ok(G.classify({ source_name: 'Jane Roe', target_name: 'Acme Corp', relation_metadata: JSON.stringify({ grade: 'B', corroboration: 4 }) }).decision === 'promote', 'relation: both civic endpoints + corroborated → promote');
ok(G.classify({ source_name: 'Jane Roe', target_name: 'Manchester United FC', relation_metadata: JSON.stringify({ grade: 'A', corroboration: 9 }) }).decision === 'reject', 'relation: an off-domain endpoint → reject the whole edge');

// --- gate: partitions a mixed queue + counts ---
const queue = [
  { name: 'Florida Democratic Party', relation_metadata: JSON.stringify({ grade: 'B', corroboration: 3 }) },  // promote
  { name: 'Graham Platner', relation_metadata: JSON.stringify({ grade: 'A', corroboration: 2 }) },             // promote
  { name: 'Some Civic Org', confidence: 0.8 },                                                                 // review
  { name: 'Thin Node', relation_metadata: JSON.stringify({ grade: 'E', corroboration: 1 }) },                  // hold
  { name: 'Stoke City F.C.', relation_metadata: JSON.stringify({ grade: 'A', corroboration: 5 }) },            // reject
  { name: 'Taylor Swift (singer)', confidence: 0.95 },                                                         // reject
];
const g = G.gate(queue);
ok(g.counts.promote === 2, `gate: 2 promotable (${g.counts.promote})`);
ok(g.counts.review === 1, `gate: 1 review (${g.counts.review})`);
ok(g.counts.hold === 1, `gate: 1 hold (${g.counts.hold})`);
ok(g.counts.reject === 2, `gate: 2 rejected as off-domain drift (${g.counts.reject})`);
ok(g.promote.every((p) => p._gate.confidence >= G.PROMOTE_FLOOR), 'gate: every promotable is >= PROMOTE_FLOOR');
ok(g.reject.some((p) => p.name === 'Taylor Swift (singer)'), 'gate: high-confidence off-domain is STILL rejected (domain beats confidence)');
ok(G.gate([]).counts.promote === 0 && G.gate(null).counts.reject === 0, 'gate: empty/null → empty buckets');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
