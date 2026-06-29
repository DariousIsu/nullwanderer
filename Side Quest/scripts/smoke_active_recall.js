/* Smoke: lib/active_recall — active DB integration. Deterministic (injected retrieve/graph fns).
 * Proves: coverage rich/thin (incl. verified_fact → rich, graph facts → rich); knowledgeBlock emits
 * the ACTIVE "build past it / don't re-research" directive on a rich hit (vs "build on it" when thin);
 * formatConsolidation produces the read-your-own-memory note; _relStr handles graph shapes.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_active_recall.js
 */
const ar = require('C:/Users/azrae/Desktop/Side Quest/lib/active_recall');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const note = (source, content, prov) => ({ source, content, kind: 'note', provenance: prov ? JSON.stringify(prov) : null });
const noGraph = () => [];

(async () => {
  try {
    // coverage: 3 notes → rich
    const r3 = await ar.recall('epistemology', { retrieveFn: async () => [note('reflection_knowledge', 'Descartes was a rationalist'), note('reflection_knowledge', 'Locke was an empiricist'), note('learning', 'Kant synthesized both')], graphFn: noGraph });
    ok(r3.coverage === 'rich', '3 on-topic notes → rich');
    // 1 note → thin
    const r1 = await ar.recall('obscure', { retrieveFn: async () => [note('reflection_knowledge', 'one thing')], graphFn: noGraph });
    ok(r1.coverage === 'thin', '1 note → thin');
    // 0 notes → thin
    const r0 = await ar.recall('nothing', { retrieveFn: async () => [], graphFn: noGraph });
    ok(r0.coverage === 'thin', '0 notes → thin');
    // a single verified_fact → rich (a known fact is enough to answer)
    const rv = await ar.recall('president', { retrieveFn: async () => [note('verified_fact', 'X is president', { as_of: '2026' })], graphFn: noGraph });
    ok(rv.coverage === 'rich', 'a verified_fact alone → rich');
    // graph facts alone → rich
    const rg = await ar.recall('kant', { retrieveFn: async () => [], graphFn: () => ['Kant influenced epistemology', 'Kant wrote Critique', 'Kant relates to ethics'] });
    ok(rg.coverage === 'rich', '3 graph facts → rich');

    // knowledgeBlock: rich → ACTIVE directive
    const blk = await ar.knowledgeBlock('epistemology', { retrieveFn: async () => [note('verified_fact', 'X is fact', { as_of: '2026' }), note('learning', 'Y learned'), note('reflection_knowledge', 'Z noted')], graphFn: noGraph });
    ok(/WHAT YOU ALREADY KNOW about "epistemology"/.test(blk), 'block headers the topic');
    ok(/\[VERIFIED as of 2026\]/.test(blk) && /\[learned\]/.test(blk) && /\[note\]/.test(blk), 'tags rendered across sources');
    ok(/do NOT restate it or look it up again/.test(blk) && /Extend the frontier/.test(blk), 'rich hit → ACTIVE "do not re-research" directive');

    // thin → softer directive
    const blkThin = await ar.knowledgeBlock('obscure', { retrieveFn: async () => [note('reflection_knowledge', 'one bit')], graphFn: noGraph });
    ok(/build on it/.test(blkThin) && !/do NOT restate it or look it up again/.test(blkThin), 'thin hit → "build on it", no hard stop');

    // empty → null
    ok((await ar.knowledgeBlock('x', { retrieveFn: async () => [], graphFn: noGraph })) === null, 'no recall → null block');

    // formatConsolidation
    const cons = ar.formatConsolidation({ topic: 'epistemology', notes: [note('reflection_knowledge', 'Descartes was a rationalist')], facts: ['Kant influenced epistemology'] });
    ok(/I checked my own memory on "epistemology"/.test(cons) && /Descartes was a rationalist/.test(cons) && /what specifically don't I know/.test(cons), 'consolidation reads her own memory + asks the gap');

    // _relStr shapes
    ok(ar._relStr({ source: 'Kant', type: 'INFLUENCED', target: 'epistemology' }) === 'Kant influenced epistemology', '_relStr triple');
    ok(ar._relStr({ name: 'Descartes', summary: 'rationalist' }) === 'Descartes: rationalist', '_relStr name+summary');
    ok(ar._relStr(null) === null, '_relStr null-safe');

    // ECHO master-DB integration: hits merge into recall + drive coverage; rendered as [echo:*]
    const echoFn = async () => [{ source: 'echo:wikipedia', content: 'Epistemology examines the nature of knowledge' }, { source: 'echo:wikipedia', content: 'Empiricism vs rationalism' }];
    const re = await ar.recall('epistemology', { retrieveFn: async () => [], graphFn: noGraph, echoFn });
    ok(re.echo === 2 && re.coverage === 'rich', '2 echo (master-DB) hits → rich even with 0 local notes');
    const blkE = await ar.knowledgeBlock('epistemology', { retrieveFn: async () => [], graphFn: noGraph, echoFn });
    ok(/\[echo:wikipedia\] Epistemology examines/.test(blkE), 'echo hits surface tagged [echo:wikipedia]');

    // echo_suit.recallKnowledge — parses a search_knowledge dispatch result, fail-safe when down
    const es = require('C:/Users/azrae/Desktop/Side Quest/lib/echo_suit');
    es._setLiveForTest({ connected: true, dispatch: async () => ({ ok: true, text: JSON.stringify({ result: [{ source: 'wikipedia', snippet: '<mark>QCD</mark> is a theory of the strong force' }] }) }) });
    const hits = await es.recallKnowledge('quantum chromodynamics');
    ok(hits.length === 1 && hits[0].source === 'echo:wikipedia' && /QCD is a theory/.test(hits[0].content), 'recallKnowledge normalizes a master-DB hit (mark tags stripped)');
    es._setLiveForTest(null);
    ok((await es.recallKnowledge('anything')).length === 0, 'recallKnowledge fail-safe [] when suit not connected');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
