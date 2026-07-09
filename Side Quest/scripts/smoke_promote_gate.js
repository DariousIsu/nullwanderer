/* Smoke: lib/promote_gate — confidence gate that closes the landing loop (offline).
 * Proof: trustworthy → promote; mid/legacy → review; low → hold. Topic NEVER discards —
 * an off-domain high-confidence proposal still promotes, carrying a 'domain' tag.
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

// CORROBORATION ENRICHMENT (C-integration): the tenant UPSERT unions source_set + drops the stale
// corroboration key, so the gate RECOMPUTES the mirror-collapsed independent count + calibrated
// confidence from the merged set — a 2nd INDEPENDENT source scores strictly higher; a mirror does not.
const oneSrc = { relation_metadata: JSON.stringify({ grade: 'B', source_set: ['https://ballotpedia.org/x'] }) };
const twoSrc = { relation_metadata: JSON.stringify({ grade: 'B', source_set: ['https://ballotpedia.org/x', 'https://arktimes.com/y'] }) };
const mirrorSrc = { relation_metadata: JSON.stringify({ grade: 'B', source_set: ['https://en.wikipedia.org/wiki/X', 'https://www.wikiwand.com/en/X'] }) };
ok(G.effectiveConfidence(twoSrc) > G.effectiveConfidence(oneSrc), 'enrichment: a 2nd INDEPENDENT source raises confidence (gate recomputes from the merged source_set — no stale corroboration key)');
ok(Math.abs(G.effectiveConfidence(twoSrc) - CM.calibratedConfidence({ grade: 'B', corroboration: 2 })) < 1e-9, 'enrichment: two independent sources → calibrated at corroboration=2 (0.94)');
ok(Math.abs(G.effectiveConfidence(mirrorSrc) - G.effectiveConfidence(oneSrc)) < 1e-9, 'enrichment: a Wikipedia MIRROR does NOT raise confidence (collapses to 1 independent source — no self-echo-chamber)');

// --- classify: decisions are CONFIDENCE-ONLY; domain is a tag, never a veto ---
ok(G.classify({ name: 'Florida Democratic Party', relation_metadata: JSON.stringify({ grade: 'B', corroboration: 3 }) }).decision === 'promote', 'promote: A-band calibrated (corroborated)');
const off = G.classify({ name: 'Dave Bowen (footballer)', relation_metadata: JSON.stringify({ grade: 'A', corroboration: 9 }) });
ok(off.decision === 'promote' && off.domain === 'off-domain', 'off-domain high-confidence PROMOTES + carries domain=off-domain tag (topic is not a veto)');
ok(G.classify({ name: 'Florida Democratic Party', relation_metadata: JSON.stringify({ grade: 'B', corroboration: 3 }) }).domain === 'civic', 'civic proposal carries domain=civic tag');
ok(G.classify({ name: 'Some Civic Org', confidence: 0.8 }).decision === 'review', 'review: legacy flat-0.8 → operator review (not auto-promote)');
ok(G.classify({ name: 'Thin Civic Node', relation_metadata: JSON.stringify({ grade: 'D', corroboration: 1 }) }).decision === 'hold', 'hold: low calibrated confidence → chase corroboration first');
ok(G.classify({ name: 'No Conf Node' }).decision === 'hold' && G.classify({ name: 'No Conf Node' }).reason === 'no-confidence', 'hold: no confidence signal at all');

// --- relations: an off-domain endpoint tags the edge, but never discards it ---
ok(G.classify({ source_name: 'Jane Roe', target_name: 'Acme Corp', relation_metadata: JSON.stringify({ grade: 'B', corroboration: 4 }) }).decision === 'promote', 'relation: corroborated edge → promote');
const offRel = G.classify({ source_name: 'Jane Roe', target_name: 'Manchester United FC', relation_metadata: JSON.stringify({ grade: 'A', corroboration: 9 }) });
ok(offRel.decision === 'promote' && offRel.domain === 'off-domain', 'relation: an off-domain endpoint tags the edge off-domain but STILL promotes (absorb everything)');

// --- gate: partitions a mixed queue + counts ---
const queue = [
  { name: 'Florida Democratic Party', relation_metadata: JSON.stringify({ grade: 'B', corroboration: 3 }) },  // promote (civic)
  { name: 'Graham Platner', relation_metadata: JSON.stringify({ grade: 'A', corroboration: 2 }) },             // promote (civic)
  { name: 'Some Civic Org', confidence: 0.8 },                                                                 // review
  { name: 'Thin Node', relation_metadata: JSON.stringify({ grade: 'E', corroboration: 1 }) },                  // hold
  { name: 'Stoke City F.C.', relation_metadata: JSON.stringify({ grade: 'A', corroboration: 5 }) },            // promote (off-domain tag)
  { name: 'Taylor Swift (singer)', confidence: 0.95 },                                                         // promote (off-domain tag)
];
const g = G.gate(queue);
ok(g.counts.promote === 4, `gate: 4 promotable — topic doesn't gate (${g.counts.promote})`);
ok(g.counts.review === 1, `gate: 1 review (${g.counts.review})`);
ok(g.counts.hold === 1, `gate: 1 hold (${g.counts.hold})`);
ok(g.counts.reject === 0, `gate: nothing rejected on topic (${g.counts.reject})`);
ok(g.promote.every((p) => p._gate.confidence >= G.PROMOTE_FLOOR), 'gate: every promotable is >= PROMOTE_FLOOR');
ok(g.promote.some((p) => p.name === 'Taylor Swift (singer)' && p._gate.domain === 'off-domain'), 'gate: high-confidence off-domain now PROMOTES, tagged off-domain (domain is a signal, not a veto)');
ok(g.promote.some((p) => p.name === 'Florida Democratic Party' && p._gate.domain === 'civic'), 'gate: civic promotable carries domain=civic tag (operator can sort the core to the top)');
ok(G.gate([]).counts.promote === 0 && G.gate(null).counts.reject === 0, 'gate: empty/null → empty buckets');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
