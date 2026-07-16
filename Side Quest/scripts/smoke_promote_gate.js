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

// --- classify: SUBSTANTIATION-first (decision #1); confidence rides as PRIORITY; domain is a tag ---
// THE INVERSION: a lone authoritative / cited source now PROMOTES at single-source (no 2nd-source floor).
const govSingle = { name: 'Parish Official', relation_metadata: JSON.stringify({ grade: 'A', source_set: ['https://myparish.gov/officials'] }) };
ok(G.classify(govSingle).decision === 'promote', 'inversion: a lone authoritative (.gov) source promotes at single-source (the "one official page", was parked <0.90)');
const bSingle = { name: 'Florida Democratic Party', relation_metadata: JSON.stringify({ grade: 'B', source_set: ['https://localnews.example/story'] }) };
const cB = G.classify(bSingle);
ok(cB.decision === 'promote', 'inversion: a single-source grade-B fact now PROMOTES (was held below the 0.90 floor)');
ok(cB.confidence < G.PROMOTE_FLOOR && cB.reason === 'substantiated', 'inversion: promotes with confidence BELOW the old floor — grade is priority, not a gate');
ok(cB.state === 'source-vouched', 'classify: carries the substantiation state (source-vouched)');

// unsubstantiated keeps the confidence-band routing (prove-or-fade) — an uncited derived claim holds
ok(G.classify({ name: 'Inferred Node', relation_metadata: JSON.stringify({ grade: 'D', corroboration: 1 }) }).decision === 'hold', 'unsubstantiated + low calibrated → hold (derived/uncited, grade D, no source)');
const noconf = G.classify({ name: 'Bare Node' });
ok(noconf.decision === 'hold' && noconf.reason === 'no-confidence', 'no provenance + no confidence → hold');

// bottom floor: a junk-only source never substantiates (can't ride the inversion into promotion)
const junk = G.classify({ name: 'Fan Node', relation_metadata: JSON.stringify({ grade: 'B', source_set: ['https://fandom.com/x'] }) });
ok(junk.state === 'unsubstantiated' && junk.decision !== 'promote', 'bottom floor: a junk-only source is unsubstantiated → does NOT auto-promote (even with a grade)');

// topic is a tag, never a veto — an off-domain SUBSTANTIATED proposal still promotes
const off = G.classify({ name: 'Dave Bowen (footballer)', relation_metadata: JSON.stringify({ grade: 'A', source_set: ['https://espn.com/x'] }) });
ok(off.decision === 'promote' && off.domain === 'off-domain', 'off-domain substantiated PROMOTES + carries domain=off-domain tag (topic is not a veto)');
ok(G.classify(govSingle).domain === 'civic', 'civic proposal carries domain=civic tag');

// an ungrounded-but-confident claim keeps the OLD band routing (ingest_lane's grounding gate → research)
ok(G.classify({ name: 'Civic Claim', confidence: 0.95 }).reason === 'confident-ungrounded', 'ungrounded high-confidence keeps promote-band routing (grounding gate sends it to research, not the graph)');
ok(G.classify({ name: 'Mid Civic', confidence: 0.8 }).decision === 'review', 'ungrounded mid-band → review (band routing preserved for the unsubstantiated)');

// --- relations: an off-domain endpoint tags the edge, but never discards it ---
const offRel = G.classify({ source_name: 'Jane Roe', target_name: 'Manchester United FC', relation_metadata: JSON.stringify({ grade: 'B', source_set: ['https://bbc.co.uk/x'] }) });
ok(offRel.decision === 'promote' && offRel.domain === 'off-domain', 'relation: an off-domain endpoint tags the edge off-domain but STILL promotes when substantiated');

// --- substantiationState helper ---
ok(G.substantiationState({ relation_metadata: JSON.stringify({ source_set: ['https://x.gov/a'] }) }) === 'source-vouched', 'substantiationState: a real source → source-vouched');
ok(G.substantiationState({ relation_metadata: JSON.stringify({ grade: 'D' }) }) === 'unsubstantiated', 'substantiationState: grade with no source → unsubstantiated');

// --- gate: partitions a mixed queue + counts ---
const queue = [
  { name: 'Parish A', relation_metadata: JSON.stringify({ grade: 'A', source_set: ['https://a.gov/x'] }) },                     // promote (substantiated civic)
  { name: 'Florida Democratic Party', relation_metadata: JSON.stringify({ grade: 'B', source_set: ['https://news.example/y'] }) }, // promote (substantiated single-source — the inversion)
  { name: 'Inferred', relation_metadata: JSON.stringify({ grade: 'D', corroboration: 1 }) },                                    // hold (unsubstantiated, low)
  { name: 'Bare' },                                                                                                             // hold (no confidence)
  { name: 'Stoke City F.C.', relation_metadata: JSON.stringify({ grade: 'A', source_set: ['https://espn.com/z'] }) },           // promote (substantiated off-domain)
  { name: 'Mid Civic', confidence: 0.8 },                                                                                       // review (ungrounded mid-band)
];
const g = G.gate(queue);
ok(g.counts.promote === 3, `gate: 3 substantiated promotables (${g.counts.promote})`);
ok(g.counts.review === 1, `gate: 1 review — ungrounded mid-band, band routing preserved (${g.counts.review})`);
ok(g.counts.hold === 2, `gate: 2 hold — unsubstantiated thin/uncited (${g.counts.hold})`);
ok(g.counts.reject === 0, `gate: nothing rejected on topic (${g.counts.reject})`);
ok(g.promote.some((p) => p._gate.confidence < G.PROMOTE_FLOOR), 'gate: a promotable is BELOW the old floor (the inversion — grade is priority, not gate)');
ok(g.promote.some((p) => p.name === 'Stoke City F.C.' && p._gate.domain === 'off-domain'), 'gate: substantiated off-domain PROMOTES, tagged off-domain (domain is a signal, not a veto)');
ok(g.promote.some((p) => p.name === 'Parish A' && p._gate.domain === 'civic'), 'gate: civic promotable carries domain=civic tag (operator can sort the core to the top)');
ok(G.gate([]).counts.promote === 0 && G.gate(null).counts.reject === 0, 'gate: empty/null → empty buckets');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
