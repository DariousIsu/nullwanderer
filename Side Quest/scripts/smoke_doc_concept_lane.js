/* Smoke: doc_decompose CONCEPT LANE (Phase C Slice 3b, docs side). Offline (fake deps).
 * Proves concept-typed entities route to resolve_or_mint_concept with the doc url as source,
 * never leak into the live propose_entity path, and are counted on `out`.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_doc_concept_lane.js */
'use strict';
const D = require('../lib/doc_decompose');
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  const calls = [];
  const dispatch = async (tag) => {
    calls.push(tag);
    if (tag.name === 'resolve_or_mint_concept') return { ok: true, text: JSON.stringify({ status: 'minted', proposal_id: 1 }) };
    if (tag.name === 'propose_entity') return { ok: true, text: JSON.stringify({ action: 'created', entity_id: 2 }) };
    return { ok: true, text: '{}' };
  };
  const extract = async () => ({
    entities: [
      { name: 'Artificial Intelligence', type: 'concept' },
      { name: 'Permitting Reform', type: 'concept' },
      { name: 'Jane Q Public', type: 'person' },
    ],
    relations: [],
  });
  const resolve = async () => ({ status: 'nil' });   // nothing pre-exists → persons mint, concepts split off first

  const out = await D.decomposeDoc(
    { title: 'T', url: 'https://example.com/doc1', text: 'some civic text about policy' },
    { extract, resolve, dispatch, cap: { entities: 20, relations: 20 } },
  );

  const mintCalls = calls.filter((c) => c.name === 'resolve_or_mint_concept');
  const peCalls = calls.filter((c) => c.name === 'propose_entity');
  ok(mintCalls.length === 2, `two concepts routed to resolve_or_mint_concept (got ${mintCalls.length})`);
  ok(mintCalls.every((c) => c.args.source === 'https://example.com/doc1'), 'concept mint source = the doc url');
  ok(mintCalls.some((c) => c.args.name === 'Artificial Intelligence') && mintCalls.some((c) => c.args.name === 'Permitting Reform'), 'both concept names minted');
  ok(!peCalls.some((c) => c.args.entity_type === 'concept'), 'NO concept leaked into the live propose_entity path');
  ok(out.concepts_minted === 2, `out.concepts_minted === 2 (got ${out.concepts_minted})`);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
