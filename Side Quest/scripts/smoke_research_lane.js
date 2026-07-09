/* Smoke: lib/research_lane — F3 research-to-close-the-gap (offline, pure; injected executors).
 * Proof: gap diagnosis (citation vs corroboration vs none vs park), the bounded close-the-gap loop
 * (corroboration lifts a mid-band fact over the bar; a verified citation grounds an ungrounded one),
 * and the anti-collapse guards (no external found → park; unverified citation → park; bounded exhaustion).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_research_lane.js
 */
'use strict';
const R = require('../lib/research_lane');
const ingest = require('../lib/ingest_lane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// fixtures ------------------------------------------------------------------------------------------
// mid-band: grade B + ONE source → ~0.88 calibrated → review → research/corroboration
const midband = () => ({ name: 'Acme PAC', source_name: 'Acme PAC', target_name: 'Sen. Doe', relation: 'FUNDS', metadata: { grade: 'B', source_set: ['https://a.com/x'] } });
// promote-confidence but UNGROUNDED (no source) → research/citation
const ungrounded = () => ({ name: 'Widget', source_name: 'Widget', target_name: 'Gadget', relation: 'LINKED_TO', confidence: 0.95, metadata: {} });
const parkItem = () => ({ name: 'Faint', confidence: 0.40, metadata: {} });
const alreadyOk = () => ({ name: 'Solid', confidence: 0.95, metadata: { url: 'https://src/ok' } });

console.log('== diagnoseGap ==');
ok(R.diagnoseGap(midband()) === 'corroboration', 'mid-band fact → gap is CORROBORATION');
ok(R.diagnoseGap(ungrounded()) === 'citation', 'promote-confidence but ungrounded → gap is CITATION');
ok(R.diagnoseGap(parkItem()) === 'park', 'below the review floor → PARK (too weak to research)');
ok(R.diagnoseGap(alreadyOk()) === 'none', 'already grounded + promote-band → gap NONE');

console.log('== planResearch ==');
ok(R.planResearch(midband(), 'corroboration').action === 'corroborate', 'corroboration gap → a corroborate plan (with a query)');
ok(R.planResearch(ungrounded(), 'citation').action === 'verify-citation', 'citation gap → a verify-citation plan (with the claim)');
ok(R.planResearch(ungrounded(), 'citation').claim.includes('Widget') && R.planResearch(ungrounded(), 'citation').claim.includes('Gadget'), 'the citation plan carries the claim (subject + object)');

console.log('== mergeResearch (external sources only, recompute) ==');
const merged = R.mergeResearch(midband(), { sources: ['https://b.org/y', 'https://a.com/x'] });
ok(merged.metadata.source_set.length === 2 && !('corroboration' in merged.metadata), 'unions the NEW external source + DEDUPS the repeated one (a.com) → 2, drops stale corroboration key');

(async () => {
  console.log('== runResearchItem: corroboration path ==');
  const searchHits = async () => ({ sources: ['https://b.org/y', 'https://c.net/z', 'https://d.io/w'] });   // 3 independent domains
  const r1 = await R.runResearchItem(midband(), { search: searchHits });
  ok(r1.outcome === 'promote' && r1.attempts === 1, 'mid-band + independent corroboration found → crosses the bar → PROMOTE');
  ok(ingest.threeBand(r1.proposal) === 'promote', 're-judged proposal is genuinely promote-band now (grounded + calibrated)');

  const searchNone = async () => ({ sources: [] });
  const r2 = await R.runResearchItem(midband(), { search: searchNone });
  ok(r2.outcome === 'park' && r2.reason === 'no-external-found', 'mid-band + research finds NOTHING external → PARK (never invents corroboration)');

  console.log('== runResearchItem: citation path ==');
  const verifyOk = async () => ({ verified: true, citation_url: 'https://src/confirmed' });
  const r3 = await R.runResearchItem(ungrounded(), { verifyCitation: verifyOk });
  ok(r3.outcome === 'promote' && ingest.isGrounded(r3.proposal), 'ungrounded promote-band + a VERIFIED citation → grounded → PROMOTE');

  const verifyNo = async () => ({ verified: false, reason: 'not-found' });
  const r4 = await R.runResearchItem(ungrounded(), { verifyCitation: verifyNo });
  ok(r4.outcome === 'park' && r4.reason === 'citation-unverified', 'ungrounded + UNVERIFIABLE citation → PARK (cloud-vouch-alone never promotes)');

  console.log('== guards: park band, exhaustion, fail-soft ==');
  ok((await R.runResearchItem(parkItem(), { search: searchHits })).outcome === 'park', 'a below-floor item is parked, not researched');
  // a single weak source per attempt never crosses the bar → exhausts maxAttempts → park
  const searchWeak = async () => ({ sources: ['https://a.com/x'] });   // duplicate of the base → no new domain
  const r5 = await R.runResearchItem(midband(), { search: searchWeak, maxAttempts: 2 });
  ok(r5.outcome === 'park' && (r5.reason === 'exhausted' || r5.reason === 'no-external-found'), 'no NEW independent domain across attempts → bounded exhaustion → park');
  const boom = async () => { throw new Error('web down'); };
  const r6 = await R.runResearchItem(midband(), { search: boom });
  ok(r6.outcome === 'park', 'an executor that throws → park (fail-soft, never propagates)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
