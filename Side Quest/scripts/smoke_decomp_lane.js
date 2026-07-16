/* Smoke: lib/decomp_lane — Slice 2 Split-2, the per-stream inline decomposition lane (offline).
 * Covers the cloud-extractor factory (shape/think/headers/parse) and the doc_store landing adapter
 * (citation = ref | docstore:<id>, thin/uncited skips, forwards to the real decomposeDoc machine).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_decomp_lane.js
 */
'use strict';
const L = require('../lib/decomp_lane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// mock resolver (same shape as echo_suit.resolveMention)
function mockResolver(map) { return async (name) => map[name] || { status: 'nil', mention: name }; }

(async () => {
  // --- makeCloudExtractor: passes the right call shape, parses typed output ---
  let captured = null;
  const completeFn = async (args) => { captured = args; return { text: 'ENTITY: Ada Lovelace :: person\nENTITY: Analytical Engine :: other\nREL: Ada Lovelace | RELATED_TO | Analytical Engine' }; };
  const extractor = L.makeCloudExtractor({ completeFn, model: 'test-model', base: 'http://x', token: 'tok', numPredict: 300 });
  const ex = await extractor('some text about Ada', { title: 'Ada' });
  ok(ex.entities.length === 2 && ex.relations.length === 1, 'extractor: parses typed ENTITY/REL from the model output');
  ok(ex.entities[0].name === 'Ada Lovelace' && ex.entities[0].type === 'person', 'extractor: typed entity carried through');
  ok(captured.model === 'test-model' && captured.think === false, 'extractor: passes model + think:false');
  ok(captured.headers && captured.headers.Authorization === 'Bearer tok', 'extractor: sets the bearer token header');
  ok(captured.base === 'http://x' && captured.options.num_predict === 300, 'extractor: passes base + num_predict');
  ok(Array.isArray(captured.messages) && /ENTITY:/.test(captured.messages[0].content), 'extractor: uses the typed prompt');
  // no completeFn / no model → empty (fail-soft)
  ok((await L.makeCloudExtractor({})('t')).entities.length === 0, 'extractor: missing model/fn → empty (fail-soft)');
  // a stream can inject its OWN prompt (the guidelines seam)
  let usedCustom = false;
  const customExtractor = L.makeCloudExtractor({ completeFn: async () => ({ text: 'NONE' }), model: 'm', buildPrompt: () => { usedCustom = true; return [{ role: 'user', content: 'custom' }]; } });
  await customExtractor('t');
  ok(usedCustom, 'extractor: honors a stream-specific buildPrompt (the guidelines seam)');

  // --- decomposeLanding: shapes a landing → runs the machine, doc = citation ---
  const extract = async () => ({ entities: [{ name: 'Grace Hopper', type: 'person' }, { name: 'COBOL', type: 'other' }], relations: [{ source: 'Grace Hopper', relation: 'CREATED', target: 'COBOL' }] });
  const resolve = mockResolver({ 'Grace Hopper': { status: 'nil' }, 'COBOL': { status: 'nil' } });
  const calls = [], obs = [];
  const dispatch = async (tag) => { calls.push([tag.name, tag.args]); return { ok: true, text: '{"action":"created"}' }; };
  const observe = (o) => obs.push(o);

  // a real landing (id + body) → decomposes; citation defaults to docstore:<id>
  const r1 = await L.decomposeLanding({ id: 77, title: 'Notes on Hopper', body: 'Grace Hopper created COBOL.' }, { extract, resolve, dispatch, observe });
  ok(r1.minted === 2 && r1.connections === 1, 'landing: real doc decomposes (2 mints + 1 edge)');
  ok(obs.length > 0 && obs.every(o => o.url === 'docstore:77'), 'landing: the DOC is the citation (url = docstore:<id>)');
  ok(obs.filter(o => o.status === 'promoted').every(o => o.grade === 'B'), 'landing: doc-stated claims are grade B');

  // an explicit ref wins over the docstore:<id> fallback
  const obs2 = [];
  await L.decomposeLanding({ id: 5, ref: 'canvas:tab-9', body: 'Grace Hopper created COBOL.' }, { extract, resolve, dispatch, observe: (o) => obs2.push(o) });
  ok(obs2.length > 0 && obs2.every(o => o.url === 'canvas:tab-9'), 'landing: an explicit ref is used as the citation over docstore:<id>');

  // OFFICIAL-DOCUMENT WEIGHT (2026-07-15): when the citation is an authoritative gov source, doc-stated
  // claims grade A (not B) → single-source clears the promote floor. Proves curation_gate's authority tier
  // flows end-to-end through the decompose lane (this is what un-traps a lone official's own .gov page).
  const obs3 = [];
  await L.decomposeLanding({ id: 8, ref: 'https://sos.la.gov/officials', body: 'Grace Hopper created COBOL.' }, { extract, resolve, dispatch, observe: (o) => obs3.push(o) });
  ok(obs3.some(o => o.status === 'promoted') && obs3.filter(o => o.status === 'promoted').every(o => o.grade === 'A'), 'authority: a .gov-cited doc yields grade-A promoted claims (official-document weight)');
  // a non-authoritative real URL must STAY grade B (no over-grant)
  const obs4 = [];
  await L.decomposeLanding({ id: 6, ref: 'https://ex.com/roster', body: 'Grace Hopper created COBOL.' }, { extract, resolve, dispatch, observe: (o) => obs4.push(o) });
  ok(obs4.filter(o => o.status === 'promoted').every(o => o.grade === 'B'), 'authority: a non-gov real URL stays grade B (no over-grant)');

  // thin / uncited → skipped, machine not run
  ok((await L.decomposeLanding({ id: 1, body: '   ' }, { extract, resolve, dispatch, observe })).reason === 'thin', 'landing: empty body → skipped (thin)');
  ok((await L.decomposeLanding({ body: 'has text but no id/ref' }, { extract, resolve, dispatch, observe })).reason === 'uncited', 'landing: no id AND no ref → skipped (uncited)');

  // cap passes through
  const bigExtract = async () => ({ entities: ['Ann Arbor', 'Boston Ma', 'Chicago Il', 'Denver Co'].map(n => ({ name: n, type: 'location' })), relations: [] });
  const capRes = await L.decomposeLanding({ id: 9, body: 'x'.repeat(50) }, { extract: bigExtract, resolve: mockResolver({}), dispatch, observe, cap: { entities: 2, relations: 2 } });
  ok(capRes.minted === 2, 'landing: per-doc cap forwarded to the machine');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
