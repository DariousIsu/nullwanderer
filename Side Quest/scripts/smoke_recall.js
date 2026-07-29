/** Smoke — the <recall ref="…"/> marker system (lib/recall): pure parse/strip/resolve, including the
 *  d-prefix (stored documents — the reading-citation wire, memory slice 1 #6).
 *
 *  HISTORY (2026-07-22): this smoke originally also asserted context.js renders [rN]/[mN] markers
 *  into the LOCAL prompt. That behavior was deliberately retired by the voice-renderer strip (the
 *  cloud-writes-the-reply flip): buildChatPrompt stopped reading reflections/readings/monologue —
 *  that material rides the cloud PACKAGE now (main.js grounding, which teaches the <recall ref="dN"/>
 *  pull). The smoke was never in the gate, so it silently rotted against the retired contract; it now
 *  tests the LIVE rail only (main.js parses+resolves recall tags from the writer's output) and is
 *  registered in run_smokes. */
const R = require('../lib/recall');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };

console.log('parseRecallTags:');
ok('parses self-closing <recall ref="r188"/>', (() => { const t = R.parseRecallTags('let me check <recall ref="r188"/>')[0]; return t && t.kind === 'r' && t.id === 188; })());
ok('parses <recall ref="m8574"></recall>', (() => { const t = R.parseRecallTags('<recall ref="m8574"></recall>')[0]; return t && t.kind === 'm' && t.id === 8574; })());
ok('parses k-ref', R.parseRecallTags('<recall ref="k781"/>')[0].kind === 'k');
ok('parses d-ref (stored document — the reading-citation wire)', (() => { const t = R.parseRecallTags('<recall ref="d123"/>')[0]; return t && t.kind === 'd' && t.id === 123; })());
ok('multiple refs', R.parseRecallTags('<recall ref="r1"/> and <recall ref="m2"/>').length === 2);
ok('ignores junk', R.parseRecallTags('no tags here').length === 0);

console.log('\nstripRecallTags:');
ok('strips tag, keeps prose', (() => { const s = R.stripRecallTags('Sure. <recall ref="r5"/> done'); return /Sure\./.test(s) && /done/.test(s) && !/recall/.test(s); })());
ok('strips d-tag too', !/recall/.test(R.stripRecallTags('quoting <recall ref="d123"/> now')));

console.log('\nresolveRecall (mock db):');
const mockDb = {
  getReflectionById: (id) => id === 188 ? { content: 'Full reflection 188: LA speaker-tracking takeaways.' } : null,
  getMonologueById: (id) => id === 8574 ? { content: 'Full reading 8574: the otter article.' } : null,
  getKnowledgeByIds: (ids) => ids[0] === 781 ? [{ content: 'Full note 781.' }] : [],
  getDocumentById: (id) => id === 123 ? { title: 'Neuromorphic survey', body: 'The full stored document body, quotable.' } : null,
};
ok('resolves reflection', (() => { const r = R.resolveRecall(mockDb, { kind: 'r', id: 188, ref: 'r188' }); return r.ok && /speaker-tracking/.test(r.text); })());
ok('resolves reading (monologue)', (() => { const r = R.resolveRecall(mockDb, { kind: 'm', id: 8574, ref: 'm8574' }); return r.ok && /otter article/.test(r.text); })());
ok('resolves knowledge', (() => { const r = R.resolveRecall(mockDb, { kind: 'k', id: 781, ref: 'k781' }); return r.ok && /note 781/.test(r.text); })());
ok('missing ref → graceful miss (no throw)', (() => { const r = R.resolveRecall(mockDb, { kind: 'r', id: 999, ref: 'r999' }); return r.ok === false && /No memory/.test(r.text); })());
ok('resolves d-ref to the DOCUMENT itself (title + full body)', (() => { const r = R.resolveRecall(mockDb, { kind: 'd', id: 123, ref: 'd123' }); return r.ok && /# Neuromorphic survey/.test(r.text) && /quotable/.test(r.text); })());
ok('missing d-ref → graceful miss', R.resolveRecall(mockDb, { kind: 'd', id: 999, ref: 'd999' }).ok === false);
ok('resolver never throws on a broken db getter', (() => { const r = R.resolveRecall({ getDocumentById: () => { throw new Error('boom'); } }, { kind: 'd', id: 1, ref: 'd1' }); return r.ok === false; })());

// ─── COORDINATE DEREF — through the seam, not around it (2026-07-29) ───────────────────────────
// resolveCoord shipped UN-EXPORTED and every <recall coord=…/> threw into a swallowed catch for
// three days while this suite stayed green — because nothing here called the function main.js calls.
ok('resolveCoord is exported (the live failure: it was not)', typeof R.resolveCoord === 'function');
ok('parses a coord tag', (() => { const t = R.parseRecallTags('hm <recall coord="person:owner/alice"/> ok'); return t.length === 1 && t[0].kind === 'coord' && t[0].coord === 'person:owner/alice'; })());
ok('owner-world coord resolves with edges', (() => {
  const r = R.resolveCoord('person:owner/alice', { ownerGet: (c) => ({ name: 'Alice', summary: 'the daughter', edges: [{ src: c, rel: 'DAUGHTER_OF', dst: 'Lucas' }] }) });
  return r.ok && /Alice/.test(r.text) && /DAUGHTER_OF Lucas/.test(r.text);
})());
ok('non-owner coord falls through to the graph', (() => {
  const r = R.resolveCoord('place:civic/zavala-tx', { ownerGet: () => null, graphGet: () => 'Zavala County, Texas → Texas → United States' });
  return r.ok && /Zavala/.test(r.text);
})());
ok('unresolvable coord → honest gap, never invention', (() => { const r = R.resolveCoord('org:civic/nowhere', {}); return r.ok === false && /gap/.test(r.text); })());
ok('a throwing ownerGet falls through, never throws out', (() => {
  const r = R.resolveCoord('self:zoe/core', { ownerGet: () => { throw new Error('boom'); }, graphGet: () => null });
  return r.ok === false;
})());

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ` — ${pass} passed, ${fail} failed`);   // em-dash: the gate's result-line regex requires it
process.exit(fail === 0 ? 0 : 1);
