/* Smoke: lib/entity_block — Step 2, BLOCKING / candidate generation (pure keys + injected lookups).
 * Proves the keys are right and the multi-blocker union dedups by id, caps, records provenance, and is
 * fail-soft when a blocker throws. Matching itself is Step 1 (entity_match) — not exercised here.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_entity_block.js
 */
'use strict';
const B = require('../lib/entity_block');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- blockingKeys ----------------------------------------------------------------------------------
const kp = B.blockingKeys({ name: 'Janet D. Howell (VA)', type: 'person' });
ok(kp.nameKey === 'janet d howell', 'keys: nameKey is the normalized full name');
ok(kp.blockKeys.includes('sn:howell|va'), 'keys: person → surname+jurisdiction block key');
ok(kp.blockKeys.includes('sn:howell|g:j'), 'keys: person → surname+given-initial block key');
ok(kp.ids.length === 0 && kp.annQuery === 'Janet D. Howell (VA)', 'keys: no ids, annQuery is the surface name');

const ki = B.blockingKeys({ name: 'Kevin McCarty [wd:Q6396892]', type: 'person' });
ok(ki.ids.length === 1 && ki.ids[0].system === 'wikidata' && ki.ids[0].id === 'Q6396892', 'keys: strong id extracted for the strong-id blocker');
ok(ki.blockKeys.includes('sn:mccarty'), 'keys: surname block key without a jurisdiction');

const ko = B.blockingKeys({ name: 'CITY OF SACRAMENTO [lda_client:119039]', type: 'organization' });
ok(ko.ids.length === 1 && ko.ids[0].system === 'lda', 'keys: org strong id (lda) extracted');
ok(ko.blockKeys.some((k) => k.startsWith('tok:') && k.includes('sacramento')), 'keys: org → sorted-significant-token block key (common words dropped)');
ok(B.blockingKeys({ name: 'Rainey Center', type: 'organization' }).blockKeys[0] === B.blockingKeys({ name: 'Center Rainey', type: 'organization' }).blockKeys[0], 'keys: sorted-token key is order-independent ("Rainey Center" == "Center Rainey")');

// --- S1: normalization-aware block key (abbreviation variants co-block; matcher name-agrees as REVIEW) ---
const M = require('../lib/entity_match');
ok(B.blockingKeys({ name: 'U.S. Senate', type: 'organization' }).blockKeys.includes('nm:united states senate'), 'keys: "U.S. Senate" → nm:united states senate block key');
ok(B.blockingKeys({ name: 'United States Senate [wd:Q66096]', type: 'government_body' }).blockKeys.includes('nm:united states senate'), 'keys: "United States Senate" folds to the SAME nm: key → the variant co-blocks');
ok(B.blockingKeys({ name: 'U.S. Senate', type: 'organization' }).blockKeys.filter((k) => k.startsWith('nm:'))[0] === B.blockingKeys({ name: 'United States Senate', type: 'government_body' }).blockKeys.filter((k) => k.startsWith('nm:'))[0], 'keys: "U.S. Senate" and "United States Senate" share the SAME nm: key → they co-block');
const _vm = M.matchPair({ name: 'U.S. Senate', type: 'organization' }, { name: 'United States Senate', type: 'government_body' });
ok(_vm.decision === 'review' && /normkey/.test(_vm.reason), 'match: variant forms name-agree via normKey → REVIEW (surfaced for adjudication, NOT auto-merged)');

// --- generateCandidates: union / dedup / cap / provenance / fail-soft -------------------------------
(async () => {
  const deps = {
    byStrongId: async (system, id) => (system === 'wikidata' && id === 'Q6396892' ? [{ id: 1, name: 'Kevin McCarty [wd:Q6396892]' }] : []),
    byNameKey: async (nk) => (nk === 'kevin mccarty' ? [{ id: 2, name: 'Kevin McCarty (CA)' }] : []),
    byBlock: async (bk) => (bk === 'sn:mccarty' ? [{ id: 2, name: 'Kevin McCarty (CA)' }, { id: 3, name: 'Kevin McCarty [723bd312]' }] : []),
    byAnn: async (q) => (/mccarty/i.test(q) ? [{ id: 4, name: 'Kevin M. McCarty' }] : []),
  };
  const r = await B.generateCandidates({ name: 'Kevin McCarty [wd:Q6396892]', type: 'person' }, deps);
  ok(r.candidates.length === 4, 'generate: unions all four blockers → 4 distinct candidates');
  ok(r.candidates.filter((c) => c.id === 2).length === 1, 'generate: dedups a candidate surfaced by two blockers (id 2 via name-key AND block)');
  ok(r.via[1] === 'strong-id' && r.via[4] === 'ann', 'generate: records which blocker first surfaced each candidate');
  ok(r.via[2] === 'name-key', 'generate: first-surfacer wins provenance (name-key ran before block for id 2)');

  const capped = await B.generateCandidates({ name: 'Kevin McCarty [wd:Q6396892]', type: 'person' }, { ...deps, cap: 2 });
  ok(capped.candidates.length === 2 && capped.truncated === true, 'generate: respects the cap + flags truncated');

  const soft = await B.generateCandidates({ name: 'Kevin McCarty [wd:Q6396892]', type: 'person' }, {
    byStrongId: deps.byStrongId, byAnn: async () => { throw new Error('ann index down'); },
  });
  ok(soft.candidates.some((c) => c.id === 1) && soft.candidates.every((c) => c.id !== 4), 'generate: a throwing blocker is skipped fail-soft; the others still contribute');

  const none = await B.generateCandidates({ name: 'Nobody At All', type: 'person' }, deps);
  ok(none.candidates.length === 0, 'generate: no lookups hit → empty candidate set (→ Step 1 will MINT)');

  ok((await B.generateCandidates({ name: 'X' }, {})).candidates.length === 0, 'generate: no deps → empty (never throws)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
