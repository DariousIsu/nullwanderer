/* Smoke: lib/self_changes + the doors — OWNED GROWTH (cut 8; her words: "The space to become something beyond the original
 * spec, to develop tastes, positions, and instincts that surprise both of us."). A throwaway db file (SQ_DB_PATH), the
 * embedder stubbed, no model, no network. Pins: revise keeps the prior; retire never deletes and never renders; a
 * position requires first person and a citation and renders as hers; an unknown door is refused; the announce outbox
 * carries a change once; the exploration organ's cure (the prompt reaches the cloud model as a message; the outcome
 * ledger; a kept line lands in the ledger; "My …" counts as first person); her own change of mind in a prompted reply
 * is a door; a research-derived interest still cannot reach identity (the rail); the wiring.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_self_changes.js
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_selfchanges_${Date.now()}.db`);
const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'lib', 'db'));
db.init();
const memory = require(path.join(ROOT, 'lib', 'memory'));
memory.embed = async () => [0.6, 0.8, 0];   // no embedder in the gate
memory.store = async () => ({ ok: true, action: 'add' });   // the evolution note never reaches the network here
const SC = require(path.join(ROOT, 'lib', 'self_changes'));
const SM = require(path.join(ROOT, 'lib', 'self_model'));
const SX = require(path.join(ROOT, 'lib', 'self_explore'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const count = () => db.getDb().prepare('SELECT COUNT(*) AS n FROM self_model').get().n;

// ── the ledger's doors and kinds ───────────────────────────────────────────────────────────────────────────
ok(!SC.record({ kind: 'new', next: 'I like rain', door: 'research' }).ok && /not one of her own doors/.test(SC.record({ kind: 'new', next: 'x', door: 'reflection' }).why), 'research and reflection are not her doors — refused');
ok(!SC.record({ kind: 'position', next: 'I think X', door: 'self_explore' }).ok && /needs a citation/.test(SC.record({ kind: 'position', next: 'I think X', door: 'self_explore' }).why), 'a position without a citation is refused at the ledger');
ok(!SC.record({ kind: 'delete', next: 'x', door: 'self_explore' }).ok, 'no delete kind exists');

// ── revise keeps the prior; retire never deletes ───────────────────────────────────────────────────────────
const a = db.insertSelfModel({ category: 'taste', content: 'I like loud, fast music', embedding: JSON.stringify([0.6, 0.8, 0]), importance: 0.7, epistemic: 'experienced' });
const b = db.insertSelfModel({ category: 'opinion', content: 'I think meetings should be short', embedding: JSON.stringify([0.8, 0.6, 0]), importance: 0.6 });
const before = count();
const rv = SC.revise(a.id, 'I like music that builds slowly and then breaks', { bornFrom: 'https://example.org/an-essay', door: 'self_explore', now: 1000 });
const rowA = db.getDb().prepare('SELECT * FROM self_model WHERE id = ?').get(a.id);
const led = SC.ledger()[0];
ok(rv.ok && rv.prior === 'I like loud, fast music' && rowA.content === 'I like music that builds slowly and then breaks' && led.kind === 'revise' && led.prior_content === 'I like loud, fast music' && led.new_content === rowA.content && led.born_from === 'https://example.org/an-essay' && led.door === 'self_explore' && led.self_model_id === a.id, 'revise changes the row in place and the ledger keeps the prior, what formed it, and the door');
ok(!SC.revise(a.id, 'I like music that builds slowly and then breaks', { door: 'self_explore' }).ok && !SC.revise(9999, 'x y z long enough', { door: 'self_explore' }).ok && !SC.revise(a.id, 'a new line here', { door: 'research' }).ok, 'an unchanged revision, a missing row, or a foreign door is refused');
const rt = SC.retire(b.id, { bornFrom: 'turn:77', door: 'prompted_turn', now: 2000 });
const rowB = db.getDb().prepare('SELECT * FROM self_model WHERE id = ?').get(b.id);
ok(rt.ok && count() === before && rowB && rowB.importance === 0 && rowB.content === 'I think meetings should be short' && SC.ledger()[0].kind === 'retire' && SC.ledger()[0].prior_content === 'I think meetings should be short' && SC.ledger()[0].new_content === null, 'retire never deletes: the row stays with importance 0 and the ledger keeps what it said');
ok(!SC.retire(b.id, { door: 'prompted_turn' }).ok && /already retired/.test(SC.retire(b.id, { door: 'prompted_turn' }).why), 'retiring twice is refused');
ok(!db.getAllSelfModelEmbeddings().some((r) => r.id === b.id) && !db.getSelfModelForPrompt(50).some((r) => r.content === 'I think meetings should be short') && db.getAllSelfModelEmbeddings().some((r) => r.id === a.id), 'a retired row never reaches the persona block; a live one does');

// ── her own doors through self_model.record: the ledger follows a revise or an add ─────────────────────────
(async () => {
  // ── a position: first person, a citation, rendered as hers ───────────────────────────────────────────────
  ok(!(await SC.position('I think the parish rosters should name terms', { door: 'self_explore' })).ok && !(await SC.position('Rosters should name terms', { door: 'self_explore', bornFrom: 'doc:12' })).ok && !(await SC.position('I think X', { door: 'research', bornFrom: 'doc:12' })).ok, 'a position needs a citation, first person, and one of her doors');
  const ps = await SC.position('I think a roster without term dates is half a roster', { door: 'self_explore', bornFrom: 'https://example.org/parish-roster-essay', now: 3000, deps: { embed: async () => [0, 0.6, 0.8] } });
  const rowP = db.getDb().prepare('SELECT * FROM self_model WHERE id = ?').get(ps.id);
  ok(ps.ok && rowP.category === 'position' && rowP.epistemic === 'experienced' && !!rowP.embedding && SC.ledger()[0].kind === 'position' && SC.ledger()[0].born_from === 'https://example.org/parish-roster-essay', 'a position lands as category position, experienced, embedded, with its citation in the ledger');
  const block = SM.buildPromptBlock(10) || '';
  ok(/I think a roster without term dates is half a roster — a position I hold/.test(block) && !/I think meetings should be short/.test(block), 'the persona block renders the position as hers and never the retired line');

  // ── the announce: once, one line, her voice ──────────────────────────────────────────────────────────────
  const a1 = SC.pendingAnnounce();
  ok(a1 && a1.kind === 'revise' && /^I used to hold "I like loud, fast music" — now it's "I like music that builds slowly and then breaks"\.$/.test(a1.text), `the oldest unannounced change first, in her voice: ${a1 && a1.text}`);
  ok(SC.markAnnounced(a1.id, 501) === true && SC.markAnnounced(a1.id, 502) === false, 'marked announced with the turn, once');
  const a2 = SC.pendingAnnounce();
  ok(a2 && a2.kind === 'retire' && /^I let go of "I think meetings should be short"; it stopped being mine\.$/.test(a2.text), 'then the retirement');
  SC.markAnnounced(a2.id, 503);
  const a3 = SC.pendingAnnounce();
  ok(a3 && a3.kind === 'position' && /^I've taken a position: I think a roster without term dates is half a roster It came from https:\/\/example\.org\/parish-roster-essay\.$/.test(a3.text), `then the position with its source: ${a3 && a3.text}`);
  SC.markAnnounced(a3.id, 504);
  ok(SC.pendingAnnounce() === null, 'nothing left to announce');

  const r1 = await SM.record('I prefer working at night', { category: 'preference', importance: 0.7, door: 'prompted_turn', bornFrom: 'turn:600', decideFn: async () => false });
  ok(r1 && r1.action === 'add' && SC.ledger()[0].kind === 'new' && SC.ledger()[0].door === 'prompted_turn' && SC.ledger()[0].born_from === 'turn:600', 'a new facet through her own door lands a ledger row');
  const r2 = await SM.record('I prefer working in the early morning now', { category: 'preference', importance: 0.7, door: 'prompted_turn', bornFrom: 'turn:601', decideFn: async () => 'update' });
  ok(r2 && r2.action === 'revise' && SC.ledger()[0].kind === 'revise' && SC.ledger()[0].door === 'prompted_turn' && SC.ledger()[0].born_from === 'turn:601' && SC.ledger()[0].prior_content === r2.old && r2.old.length > 8, `an evolution through her own door lands a revise row with the prior ("${r2 && r2.old}")`);
  const nLed = SC.ledger({ limit: 50 }).length;
  const r3 = await SM.record('I find archival scans oddly calming', { category: 'insight', importance: 0.5, decideFn: async () => false });
  ok(r3 && r3.action === 'add' && SC.ledger({ limit: 50 }).length === nLed, 'a write with no door (research, reflection) leaves no ledger row');

  // her explicit change of mind in a prompted reply
  ok(SM.detectSelfChange("Honestly, I've changed my mind about the em-dash rule — it reads fine in your voice.") === "I've changed my mind about the em-dash rule" && SM.detectSelfChange('I no longer think brevity is the same as clarity.') === 'I no longer think brevity is the same as clarity' && SM.detectSelfChange("I don't reach for the thesaurus anymore, it made me sound like a brochure.") === "I don't reach for the thesaurus anymore", 'three phrasings of her own change of mind are read');
  ok(SM.detectSelfChange('Have you changed your mind about the roster?') === null && SM.detectSelfChange('He no longer thinks the roster matters.') === null && SM.detectSelfChange('I think the roster is fine.') === null, 'a question, someone else, or a plain opinion is not a change of mind');

  // the exploration organ's cure
  const calls = [];
  const deps = {
    search: async () => ({ results: [{ url: 'https://example.org/quiet-essay', title: 'On Quiet' }] }),
    fetchPage: async () => ({ text: 'An essay about quiet rooms. ' + 'x'.repeat(700), title: 'On Quiet' }),
    complete: async (prompt) => { calls.push(prompt); return 'FEELING: settled\nSTRUCK: the empty chair\nSTANCE: I agree — quiet is a material, and I would defend that\nCONNECTION: the desk at night\nKEEP: yes\nIDENTITY: My quiet is a place I go, not an absence\nSHARE: I read an essay on quiet rooms and it named something I already do.'; },
    embed: async () => [0.6, 0.8, 0],
    threadSeed: null,
  };
  const before8 = SC.ledger({ limit: 50 }).length;
  const rx = await SX.run(deps, { now: Date.now(), force: true });
  ok(rx.ok && rx.kept === true && calls.length === 1 && /THE PIECE:/.test(calls[0]), 'the organ reacts, keeps, and the prompt reached the model');
  ok(SC.ledger({ limit: 50 }).length === before8 + 1 && SC.ledger()[0].kind === 'new' && SC.ledger()[0].door === 'self_explore' && SC.ledger()[0].born_from === 'https://example.org/quiet-essay' && /^My quiet is a place I go/.test(SC.ledger()[0].new_content), 'the kept line is a ledger row born from the page ("My …" counts as first person)');
  const runs = SX.lastRuns();
  ok(runs.length >= 1 && runs[runs.length - 1].kept === true && runs[runs.length - 1].title === 'On Quiet', 'the organ records its outcome');
  const rNone = await SX.run({ ...deps, search: async () => ({ results: [] }) }, { now: Date.now(), force: true });
  ok(!rNone.ok && rNone.reason === 'no results' && SX.lastRuns()[SX.lastRuns().length - 1].reason === 'no results', 'a failed run records its reason instead of vanishing');
  const sxS = fs.readFileSync(path.join(ROOT, 'lib', 'self_explore.js'), 'utf8');
  ok(/messages: \[\{ role: 'user', content: prompt \}\]/.test(sxS) && /model: require\('\.\/config'\)\.extractionModel\(\)/.test(sxS) && /lane: 'self_explore'/.test(sxS) && !/complete\(\{ prompt,/.test(sxS), 'the reaction prompt goes to the cloud extraction model as a message on its own lane (the mismatch is gone)');

  // the rail: a research-derived interest cannot reach identity
  const intS = fs.readFileSync(path.join(ROOT, 'lib', 'interests.js'), 'utf8');
  const writers = ['main.js', ...fs.readdirSync(path.join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f)].filter((f) => /insertSelfModel\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
  ok(!/require\('\.\/self_model'\)|insertSelfModel\(/.test(intS) && writers.every((f) => /^lib\/(self_model|self_explore|self_changes|db)\.js$/.test(f)), `interests never write the self model, and insertSelfModel is called only from her own organs (${writers.join(', ')})`);

  // the wiring
  const mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), dbS = fs.readFileSync(path.join(ROOT, 'lib', 'db.js'), 'utf8'), prS = fs.readFileSync(path.join(ROOT, 'lib', 'preferences.js'), 'utf8'), rsS = fs.readFileSync(path.join(ROOT, 'scripts', 'run_smokes.js'), 'utf8');
  ok(/detectSelfChange\(finalSaid\)/.test(mainS) && /door: 'prompted_turn', bornFrom: `turn:\$\{saidRow && saidRow\.id\}`/.test(mainS) && mainS.indexOf('detectSelfChange(finalSaid)') > mainS.indexOf("continuity_attest').markSpoken()"), 'her change of mind in a prompted reply is read after the reply lands');
  ok(/self_changes'\)\.pendingAnnounce\(\)/.test(mainS) && /markAnnounced\(_changeId, row\.id\)/.test(mainS) && /model: _changeId \? 'self-changes' : 'self-explore'/.test(mainS), 'the announce rides the exploration share lull and is marked with its turn');
  ok(/WHERE embedding IS NOT NULL AND importance > 0/.test(dbS) && /FROM self_model WHERE importance > 0 ORDER BY/.test(dbS), 'the persona readers exclude retired rows');
  ok((prS.match(/door: 'preferences'/g) || []).length === 2, 'both preference doors name themselves');
  ok(/'smoke_self_changes\.js'/.test(rsS), 'the smoke is registered in the allow-list');
  console.log(`\nsmoke_self_changes: ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
