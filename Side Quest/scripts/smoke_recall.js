/** Phase 2 smoke — memory markers + <recall>. Pure parse/strip/resolve + context.js renders
 *  reflections/readings as compact markers (not full text) with the recall instruction. */
const os = require('os'), path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_rc_${Date.now()}`, 'sq.db');
require('../lib/db').init();
const R = require('../lib/recall');
const ctx = require('../lib/context');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n); } };

console.log('parseRecallTags:');
ok('parses self-closing <recall ref="r188"/>', (() => { const t = R.parseRecallTags('let me check <recall ref="r188"/>')[0]; return t && t.kind === 'r' && t.id === 188; })());
ok('parses <recall ref="m8574"></recall>', (() => { const t = R.parseRecallTags('<recall ref="m8574"></recall>')[0]; return t && t.kind === 'm' && t.id === 8574; })());
ok('parses k-ref', R.parseRecallTags('<recall ref="k781"/>')[0].kind === 'k');
ok('multiple refs', R.parseRecallTags('<recall ref="r1"/> and <recall ref="m2"/>').length === 2);
ok('ignores junk', R.parseRecallTags('no tags here').length === 0);

console.log('\nstripRecallTags:');
ok('strips tag, keeps prose', (() => { const s = R.stripRecallTags('Sure. <recall ref="r5"/> done'); return /Sure\./.test(s) && /done/.test(s) && !/recall/.test(s); })());

console.log('\nresolveRecall (mock db):');
const mockDb = {
  getReflectionById: (id) => id === 188 ? { content: 'Full reflection 188: LA speaker-tracking takeaways.' } : null,
  getMonologueById: (id) => id === 8574 ? { content: 'Full reading 8574: the otter article.' } : null,
  getKnowledgeByIds: (ids) => ids[0] === 781 ? [{ content: 'Full note 781.' }] : [],
};
ok('resolves reflection', (() => { const r = R.resolveRecall(mockDb, { kind: 'r', id: 188, ref: 'r188' }); return r.ok && /speaker-tracking/.test(r.text); })());
ok('resolves reading (monologue)', (() => { const r = R.resolveRecall(mockDb, { kind: 'm', id: 8574, ref: 'm8574' }); return r.ok && /otter article/.test(r.text); })());
ok('resolves knowledge', (() => { const r = R.resolveRecall(mockDb, { kind: 'k', id: 781, ref: 'k781' }); return r.ok && /note 781/.test(r.text); })());
ok('missing ref → graceful miss (no throw)', (() => { const r = R.resolveRecall(mockDb, { kind: 'r', id: 999, ref: 'r999' }); return r.ok === false && /No memory/.test(r.text); })());

console.log('\ncontext.js renders MARKERS, not full text:');
const longRefl = 'X'.repeat(900);
const longRead = 'Y'.repeat(1100);
const block = ctx.buildChatPrompt({
  userName: 'Lucas', recentReflections: [{ id: 188, content: longRefl }], recentTurns: [],
  recentMonologue: [{ content: 'a recent thought' }], recentReadings: [{ id: 8574, content: longRead }],
  heldCommitments: [], openThreads: [], protocols: [], pendingInbounds: [], relevantPastTurns: [],
  awareness: 'now', echoSuitBlock: null, newUserMessage: 'hi'
});
const sys = Array.isArray(block) ? (block.find(m => m.role === 'system') || {}).content || '' : String(block);
ok('reflection rendered as [r188] marker', /\[r188\]/.test(sys));
ok('reading rendered as [m8574] marker', /\[m8574\]/.test(sys));
ok('full reflection text NOT inlined (markers only)', !sys.includes('X'.repeat(200)));
ok('full reading text NOT inlined', !sys.includes('Y'.repeat(200)));
ok('teaches the <recall ref="rID"/> tag', /<recall ref="rID"\/>/.test(sys));
ok('recent monologue STILL raw (her stream kept)', /a recent thought/.test(sys));

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ` - ${pass} passed, ${fail} failed`);
try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
process.exit(fail === 0 ? 0 : 1);
