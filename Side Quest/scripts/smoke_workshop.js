/* Smoke: lib/workshop — THE WORKSHOP (cut 12; her words: "Something with a pulse. Something that matters to a stranger
 * at 1 AM."). A throwaway db file (SQ_DB_PATH), an injected writer and critic, no model, no network, no file outside the
 * temp dir. Pins: the weekly slot (default one, meta-overridable, Monday-anchored, the switch); the draft prompt asks for
 * a pulse and an ending and never a source; the critic reads for craft and carries no citation requirement; a run lands
 * a documents row with origin workshop (never the road), the notes file, the ledger, cut 8's change (door workshop) and
 * one private thought; the pass cap holds at three; the slot is spent after one; his read lands in cut 10's ledger; a
 * reading speaks the latest piece; the kinds alternate; the wiring.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_workshop.js
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_workshop_${Date.now()}.db`);
const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'lib', 'db'));
db.init();
const W = require(path.join(ROOT, 'lib', 'workshop'));
const SC = require(path.join(ROOT, 'lib', 'self_changes'));
let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const MON = W.weekStart(Date.now());
const NOW = MON + 2 * 86400e3 + 3600e3;   // a Wednesday, 01:00

// ── the slot ───────────────────────────────────────────────────────────────────────────────────────────────
ok(new Date(MON).getDay() === 1 && new Date(MON).getHours() === 0, 'the week starts Monday 00:00 local');
ok(W.weeklyCap() === 1 && W.due({ now: NOW }).ok && /0 of 1 this week/.test(W.due({ now: NOW }).why), 'the default slot is one piece a week, open when nothing is written');
process.env.ZOE_WORKSHOP = '0';
ok(!W.due({ now: NOW }).ok && W.due({ now: NOW }).why === 'ZOE_WORKSHOP=0', 'ZOE_WORKSHOP=0 closes it');
delete process.env.ZOE_WORKSHOP;

// ── the prompts ────────────────────────────────────────────────────────────────────────────────────────────
const dp = W.draftPrompt({ kind: 'fiction', thoughts: ['the diner at 2 AM had one customer'], selfLines: ['I like things that are unapologetic and direct'] });
ok(/pulse/.test(dp) && /1 AM/.test(dp) && /700 words/.test(dp) && /first line is the title/.test(dp) && /diner at 2 AM/.test(dp) && /unapologetic/.test(dp) && !/cit(e|ation)|source|footnote/i.test(dp), 'the draft prompt asks for a pulse, a title line, a word cap, carries her thoughts and her lines, and never asks for a source');
ok(/PULSE/.test(W.CRITIC_WANT) && /SPECIFICITY/.test(W.CRITIC_WANT) && /THE ENDING/.test(W.CRITIC_WANT) && /do not ask for sources, citations/.test(W.CRITIC_WANT) && /"verdict":"approved\|revision_needed"/.test(W.CRITIC_WANT), 'the critic reads for craft and carries no citation requirement');
ok(/YOUR CRITIC'S NOTES ON THE LAST DRAFT/.test(W.draftPrompt({ kind: 'essay', correction: 'the ending explains itself' })) && /the ending explains itself/.test(W.draftPrompt({ kind: 'essay', correction: 'the ending explains itself' })), 'a revision folds the critic\'s notes into the next draft');

// ── one run: the row, the file, the ledgers, the thought ───────────────────────────────────────────────────
const PIECE = 'The Last Booth\n\n' + 'Marla kept the diner open past two because the trucker in the last booth had not finished his coffee, and she had learned that a man who nurses a cup that long is waiting for something he cannot name. '.repeat(4) + 'She turned the sign around anyway, and he looked up as if she had said his name.';
const files = [], thoughts = [], asks = [];
const deps = {
  ask: async (prompt, { task }) => { asks.push({ task, prompt }); return task === 'workshop_draft' ? PIECE : '{"verdict":"approved","score":0.8,"correction_notes":[]}'; },
  writeFile: (p, t) => files.push({ p, t }),
  insertThought: (c) => thoughts.push(c),
  thoughts: () => ['the diner at 2 AM had one customer'], selfLines: () => ['I like things that are unapologetic and direct'],
};
(async () => {
  const r1 = await W.run({ now: NOW, deps });
  ok(r1.ok && r1.title === 'The Last Booth' && r1.kind === 'fiction' && r1.passes === 1 && r1.outcome === 'approved' && r1.words > 60 && r1.docId > 0, `a run writes a piece: "${r1.title}" (${r1.kind}, ${r1.words} words, ${r1.passes} pass, ${r1.outcome})`);
  const doc = db.getDb().prepare('SELECT * FROM documents WHERE id = ?').get(r1.docId);
  ok(doc && doc.ref === 'workshop' && doc.source === 'workshop:fiction' && doc.title === 'The Last Booth' && /Marla kept the diner/.test(doc.body) && /1 pass, approved/.test(doc.understanding), `the documents row carries the workshop mark (ref), the kind in its source, and the passes in its understanding (${doc && doc.ref}, ${doc && doc.source})`);
  ok(files.length === 1 && /notes[\\/]workshop[\\/]\d{4}-\d{2}-\d{2}-the-last-booth\.md$/.test(files[0].p) && /^# The Last Booth\n\nMarla/.test(files[0].t) && /Unannounced; the read is yours/.test(files[0].t), `the notes file he can find: ${path.basename(files[0].p)}`);
  const led = W.ledger();
  ok(led.length === 1 && led[0].docId === r1.docId && led[0].title === 'The Last Booth' && led[0].passes === 1 && W.piecesThisWeek({ now: NOW }) === 1, 'the workshop ledger holds the piece in this week');
  const ch = SC.ledger()[0];
  ok(ch && ch.kind === 'new' && ch.door === 'workshop' && /^I wrote "The Last Booth" — fiction/.test(ch.new_content) && ch.born_from === `workshop:${r1.docId}`, 'the piece joins her own changes through cut 8\'s ledger, door workshop');
  ok(thoughts.length === 1 && /I finished a fiction tonight — "The Last Booth"/.test(thoughts[0]) && /I did not announce it/.test(thoughts[0]), 'one private thought, and no announcement');
  ok(asks.length === 2 && asks[0].task === 'workshop_draft' && asks[1].task === 'workshop_critic' && /THE PIECE:/.test(asks[1].prompt), 'one draft call and one critic call');
  ok(!W.due({ now: NOW }).ok && /1 of 1 this week — the slot is spent/.test(W.due({ now: NOW }).why) && !(await W.run({ now: NOW, deps })).ok, 'the slot is spent after one piece; a second run this week is refused');
  db.setMeta(W.CAP_KEY, '3');
  ok(W.weeklyCap() === 3 && W.due({ now: NOW }).ok && W.nextKind() === 'essay', 'his lever: meta workshop.weekly_cap opens the slot; the next kind alternates to essay');

  // the pass cap: a critic that never approves → three passes, then passed with caveats
  let drafts = 0;
  const stubborn = { ...deps, ask: async (prompt, { task }) => { if (task === 'workshop_draft') { drafts++; return `Draft ${drafts}\n\n` + 'A sentence with a want and a cost in it, carried across the page until it means something. '.repeat(6); } return '{"verdict":"revision_needed","score":0.3,"correction_notes":[{"area":"ending","issue":"it trails off","instruction":"end on the object"}]}'; }, writeFile: () => {}, insertThought: () => {} };
  const r2 = await W.run({ now: NOW + 60e3, deps: stubborn });
  ok(r2.ok && r2.passes === 3 && drafts === 3 && r2.outcome === 'passed_with_caveats' && r2.kind === 'essay' && r2.title === 'Draft 3', 'the pass cap holds at three; the third draft passes with caveats');
  ok(/the critic's last score 0\.3/.test(db.getDb().prepare('SELECT understanding FROM documents WHERE id = ?').get(r2.docId).understanding), 'the understanding keeps the critic\'s last score');
  const r3 = await W.run({ now: NOW + 120e3, deps: { ...deps, ask: async () => '' , writeFile: () => {}, insertThought: () => {} } });
  ok(!r3.ok && /no piece came back/.test(r3.why) && W.ledger().length === 2, 'no text → no piece, no row, no ledger entry');

  // origin isolation: never the road
  const wS = fs.readFileSync(path.join(ROOT, 'lib', 'workshop.js'), 'utf8'), arS = fs.readFileSync(path.join(ROOT, 'lib', 'artifact_registry.js'), 'utf8');
  ok(!/require\('\.\/(artifact_registry|deliverable_projects|delivery_router)'\)|resolveOrMint\(/.test(wS) && !/workshop/.test(arS) && db.getDb().prepare("SELECT COUNT(*) AS n FROM documents WHERE ref = 'workshop'").get().n === 2, 'a piece never touches the deliverable road: the workshop never requires the registry and the registry never names the workshop');

  // his read is the judge
  ok(W.detectReaction('I kept reading, honestly — the ending got me.').kept === true && /the ending got me/.test(W.detectReaction('I kept reading, honestly — the ending got me.').reason) && W.detectReaction("Couldn't stop reading that one.").kept === true && W.detectReaction('I read your piece straight through.').kept === true, 'three phrasings of a kept read');
  ok(W.detectReaction('I stopped reading halfway, it lost me at the diner.').kept === false && /lost me at the diner/.test(W.detectReaction('I stopped reading halfway, it lost me at the diner.').reason) && W.detectReaction("I didn't finish your story.").kept === false, 'two phrasings of a dropped read, with his reason');
  ok(W.detectReaction('What did you write this week?') === null && W.detectReaction('') === null, 'a question is not a reaction');
  const rr = W.recordReaction({ userTurnId: 9001, kept: true, reason: 'the ending got me' });
  const row = db.getDb().prepare("SELECT * FROM reactions WHERE kind = 'kept-reading' ORDER BY id DESC LIMIT 1").get();
  ok(rr && rr.ok && row && row.marker === 'yes' && row.source === 'his word' && /kept reading — the ending got me \("Draft 3"\)/.test(row.snippet) && row.user_turn_id === 9001, 'his read lands in cut 10\'s ledger as kept-reading yes with his reason and the piece');

  // a reading on request
  const spoken = [];
  const ra = await W.readAloud({ deps: { speak: async (t) => spoken.push(t) } });
  ok(ra.ok && ra.title === 'Draft 3' && spoken.length === 1 && /^Draft 3\. A sentence with a want/.test(spoken[0]), 'a reading speaks the latest piece, title first');
  ok(W.detectReadRequest('read me your piece') && W.detectReadRequest('Play the latest story') && !W.detectReadRequest('what did you read today'), 'the read request is read');

  // the wiring
  const mainS = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8'), scS = fs.readFileSync(path.join(ROOT, 'lib', 'self_changes.js'), 'utf8'), rsS = fs.readFileSync(path.join(ROOT, 'scripts', 'run_smokes.js'), 'utf8');
  ok(/_ws\.due\(\{ now \}\)\.ok && _idleDepth/.test(mainS) && /_ws\.run\(\{ now \}\)/.test(mainS) && mainS.indexOf("_ws.run({ now })") < mainS.indexOf('_forced = await _needsPressure(now)'), 'the tick writes a piece when the weekly slot is open and the tick is deep enough, before the decider runs');
  ok(/workshop'\)[\s\S]{0,200}detectReaction\(userMessage\)/.test(mainS) && /detectReadRequest\(userMessage\)/.test(mainS) && /recordReaction\(\{ userTurnId: userTurnRow && userTurnRow\.id/.test(mainS), 'his read and his read request are chat doors');
  ok(/'workshop'\]\)/.test(scS) || /'told', 'workshop'/.test(scS), 'workshop is one of her own doors in the change ledger');
  ok(/'smoke_workshop\.js'/.test(rsS), 'the smoke is registered in the allow-list');
  console.log(`\nsmoke_workshop: ${pass} passed, ${fail} failed`);
  try { db.getDb().close(); fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
