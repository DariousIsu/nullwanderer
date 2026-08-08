/**
 * Backtest — byline pipeline. Pure helpers + a FULL pipeline run (research→read→write→
 * publish→done) driven through injected mock deps (no browser, no model, no network).
 * Uses a temp DB for the meta-backed stage state.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_byline_${Date.now()}.db`);

const db = require('../lib/db');
db.init();
const byline = require('../lib/byline');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// --- mock deps ---
function mockDeps(over = {}) {
  const calls = { opens: [], recipes: [], reads: 0 };
  const _fs = {};
  const files = {
    fileWrite: (p, c) => { _fs[p] = String(c); return { ok: true, path: p }; },
    fileAppend: (p, c) => { _fs[p] = (_fs[p] || '') + String(c); return { ok: true, path: p }; },
    fileRead: (p) => _fs[p] != null ? { ok: true, text: _fs[p] } : { ok: false, reason: 'missing' },
    _fs
  };
  const web = {
    open: async (url) => { calls.opens.push(url); return over.openBlocker ? { ok: true, blocker: over.openBlocker } : { ok: true, url }; },
    read: async () => { calls.reads++; return { ok: true, text: 'page text about the topic with substance' }; },
    runRecipe: async (name, vars) => { calls.recipes.push([name, vars]); return over.publishResult || { ok: true, ran: 5, healed: 0 }; }
  };
  const webSearch = over.webSearch || (async (q) => ({ query: q, results: [
    { title: 'Source A', url: 'https://a.example/x', snippet: 'about ' + q },
    { title: 'Source B', url: 'https://b.example/y', snippet: 'more on ' + q }
  ] }));
  const streamChat = over.streamChat || (async ({ onToken }) => { onToken('Title: A Real Title\n\nThis is the essay body, long enough to clear the forty character minimum easily and then some.'); });
  return { deps: { webSearch, web, files, streamChat, MODEL: 'test-model' }, calls, files };
}

(async () => {
  console.log('Backtest — byline pipeline\n');

  console.log('slugify:');
  ok('spaces → kebab', byline.slugify('The Future of Work') === 'the-future-of-work');
  ok('strips punctuation', byline.slugify('AI, policy & you!') === 'ai-policy-you');
  ok('empty → untitled', byline.slugify('') === 'untitled');

  console.log('\ndetectStart (matches real asks, ignores casual):');
  ok('write a post about X', byline.detectStart('can you write a post about the debt ceiling') === 'the debt ceiling');
  ok('publish an essay on Y', byline.detectStart('publish an essay on monetary policy') === 'monetary policy');
  ok('draft a substack piece about Z', byline.detectStart('draft a substack piece about NATO expansion') === 'NATO expansion');
  ok('work on a column about W', byline.detectStart('work on a column about housing') === 'housing');
  ok('casual mention → null', byline.detectStart('I really liked that post you wrote') === null);
  ok('write me a poem → null (not a post)', byline.detectStart('write me a poem about the sea') === null);
  ok('bare "write a post" (no topic) → null', byline.detectStart('write a post') === null);

  console.log('\nparseDraft:');
  ok('Title: line', (() => { const r = byline.parseDraft('Title: Hello World\n\nbody here'); return r.title === 'Hello World' && r.body === 'body here'; })());
  ok('# heading', (() => { const r = byline.parseDraft('# My Heading\n\nthe body'); return r.title === 'My Heading' && r.body === 'the body'; })());
  ok('fallback first line', (() => { const r = byline.parseDraft('Just a line\nand more'); return r.title === 'Just a line' && /and more/.test(r.body); })());
  ok('strips stray tags', !/[<>]/.test(byline.parseDraft('<think>x</think>Title: Clean\n\nbody').title));

  console.log('\nrejectDraft (payload contract — the PUBLIC door, M6.3):');
  const essay = 'I want to talk about why housing policy fails renters. The evidence is everywhere, and the argument is simple: supply is policy.';
  ok('a real first-person essay passes', byline.rejectDraft('A Real Title', essay) === null);
  ok('thin body rejected', /thin/.test(byline.rejectDraft('T', 'too short') || ''));
  ok('mid-work deliberation rejected', /deliberation/.test(byline.rejectDraft('T', 'This piece matters. Let me check the notes and gather more sources before I finish.') || ''));
  ok('AI boilerplate rejected', /as an AI/i.test(byline.rejectDraft('T', 'As an AI language model, I think housing policy is complicated and multifaceted in many ways.') || ''));
  ok('prompt-scaffolding echo rejected', /scaffold/.test(byline.rejectDraft('T', 'Here is my piece on the topic. (no notes gathered) But the argument still stands on its own merits.') || ''));

  console.log('\nnextDraftPath (versioning, injected existsFn):');
  ok('no existing → base', byline.nextDraftPath('my-slug', () => false) === 'drafts/my-slug.md');
  ok('base exists → -v2', byline.nextDraftPath('my-slug', p => p === 'drafts/my-slug.md') === 'drafts/my-slug-v2.md');
  ok('base+v2 exist → -v3', byline.nextDraftPath('my-slug', p => p === 'drafts/my-slug.md' || p === 'drafts/my-slug-v2.md') === 'drafts/my-slug-v3.md');

  console.log('\nFULL pipeline (happy path):');
  const m = mockDeps();
  ok('start sets research + active', byline.start('the future of work') && byline.active() && byline.get() === 'research');
  let r = await byline.runTick({ deps: m.deps });
  ok('research → read (2 sources)', r.stage === 'research' && r.ok && byline.get() === 'read' && r.sources === 2);
  r = await byline.runTick({ deps: m.deps });
  ok('read source 1 (stays read)', r.stage === 'read' && r.ok && byline.get() === 'read');
  r = await byline.runTick({ deps: m.deps });
  ok('read source 2 (stays read)', r.stage === 'read' && byline.get() === 'read');
  r = await byline.runTick({ deps: m.deps });
  ok('sources exhausted → write', r.stage === 'read' && byline.get() === 'write');
  ok('opened both source URLs in HER browser', m.calls.opens.length === 2);
  r = await byline.runTick({ deps: m.deps });
  ok('write → publish + draft written', r.stage === 'write' && r.ok && byline.get() === 'publish' && r.title === 'A Real Title');
  ok('draft file exists with body', Object.keys(m.files._fs).some(p => /^drafts\//.test(p)));
  r = await byline.runTick({ deps: m.deps });
  ok('publish → done (autonomous, recipe run)', r.stage === 'publish' && r.ok && byline.get() === 'done');
  ok('substack recipe invoked with title+body', m.calls.recipes.length === 1 && m.calls.recipes[0][0] === 'substack_publish' && m.calls.recipes[0][1].title === 'A Real Title' && /essay body/.test(m.calls.recipes[0][1].body));
  r = await byline.runTick({ deps: m.deps });
  ok('done → cleared (inactive)', !byline.active() && byline.get() === 'none');

  console.log('\nblocker at publish (asks Lucas, stays on publish):');
  const m2 = mockDeps({ publishResult: { ok: false, blocker: { type: 'login', needsHuman: true } } });
  byline.start('topic two');
  byline.set('publish');
  db.setMeta('byline_title', 'Piece Two');
  db.setMeta('byline_draft_path', 'drafts/topic-two.md');
  m2.files._fs['drafts/topic-two.md'] = '# Piece Two\n\nthe body of piece two here, long enough to clear the payload contract minimum.';
  let surfaced = null;
  r = await byline.runTick({ deps: m2.deps, onReading: (c) => { surfaced = c; } });
  ok('publish blocked → stays publish', r.stage === 'publish' && !r.ok && r.blocker === 'login' && byline.active() && byline.get() === 'publish');
  ok('surfaced a help-ask to Lucas', /log me in|login/i.test(surfaced || ''));
  byline.reset();

  console.log('\nblocker at read (skips the source, keeps going):');
  const m3 = mockDeps({ openBlocker: { type: 'cloudflare', needsHuman: true } });
  byline.start('topic three');
  await byline.runTick({ deps: m3.deps });                 // research → read
  r = await byline.runTick({ deps: m3.deps });             // read source 0 → blocked
  ok('blocked source skipped, read_idx advances', r.stage === 'read' && r.ok && r.blocker === 'cloudflare' && parseInt(db.getMeta('byline_read_idx'), 10) === 1);
  byline.reset();

  console.log('\nwrite-stage contract (deliberation draft never lands):');
  const m5 = mockDeps({ streamChat: async ({ onToken }) => { onToken('Title: A Piece\n\nLet me check my research notes and gather a few more sources before I write this properly.'); } });
  byline.start('topic five');
  byline.set('write');
  m5.files._fs['notes/byline_topic-five.md'] = '# Notes\nsome notes';
  db.setMeta('byline_notes_path', 'notes/byline_topic-five.md');
  r = await byline.runTick({ deps: m5.deps });
  ok('deliberation draft rejected, stays write', r.stage === 'write' && !r.ok && /deliberation/.test(r.note) && byline.get() === 'write');
  ok('no draft file written', !Object.keys(m5.files._fs).some(p => /^drafts\//.test(p)));
  byline.reset();

  console.log('\npublish-stage recheck (bad draft FILE goes back to write, never to Substack):');
  const m6 = mockDeps();
  byline.start('topic six');
  byline.set('publish');
  db.setMeta('byline_title', 'Piece Six');
  db.setMeta('byline_draft_path', 'drafts/topic-six.md');
  m6.files._fs['drafts/topic-six.md'] = '# Piece Six\n\nAs an AI language model, I will now check the sources and gather what I need for this piece.';
  r = await byline.runTick({ deps: m6.deps });
  ok('bad draft file → back to write, recipe NOT run', r.stage === 'publish' && !r.ok && byline.get() === 'write' && m6.calls.recipes.length === 0);
  byline.reset();

  console.log('\nstrikes (no sources 3x → pipeline resets):');
  const m4 = mockDeps({ webSearch: async (q) => ({ query: q, results: [] }) });
  byline.start('topic four');
  await byline.runTick({ deps: m4.deps });
  await byline.runTick({ deps: m4.deps });
  r = await byline.runTick({ deps: m4.deps });
  ok('3 empty researches → reset', !byline.active() && /reset/.test(r.note));

  console.log('\nidle when inactive:');
  ok('runTick with no pipeline → none/ok:false', (await byline.runTick({ deps: mockDeps().deps })).stage === 'none');

  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
