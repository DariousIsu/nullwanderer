/**
 * Hard smoke — Phase 3: epistemic-ranked retrieval + curiosity stops searching her own
 * fragments. (a) graph_memory.factsForPrompt surfaces only grounded canonical facts, ranked
 * by trust, excluding refuted (confirmed=0) and speculation (never canonical). (b)
 * monologue.looksLikeOwnFragment suppresses web-searching her own introspective sentences.
 * Offline, no model, no embedder.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_graph3_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const gm = require('../lib/graph_memory');
const monologue = require('../lib/monologue');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(function () {
  console.log('Hard smoke — Phase 3 epistemic retrieval + self-fragment guard\n');

  console.log('3A — factsForPrompt surfaces grounded only, ranked, refuted/speculation excluded:');
  gm.recordEntity({ name: 'Joshua Fredrickson', type: 'person', epistemic: 'told' });
  gm.recordEntity({ name: 'FAST-41 Act', type: 'legislation', epistemic: 'read' });
  gm.recordEntity({ name: 'Q3 launch plan', type: 'concept', epistemic: 'anticipated' });          // unconfirmed → still live
  const mad = gm.recordEntity({ name: 'Madeline at the meeting', type: 'event', epistemic: 'anticipated' });
  gm.reconcileEntity(mad.entityId, false);                                                           // refuted: she didn't show
  gm.recordEntity({ name: 'Immersive Salesforce storytelling', type: 'claim', epistemic: 'speculated' }); // → proposal, not canonical

  const block = gm.factsForPrompt({ limit: 10 }) || '';
  ok('grounded told fact present (Joshua)', /Joshua Fredrickson/.test(block));
  ok('grounded read fact present (FAST-41)', /FAST-41/.test(block));
  ok('live anticipated present (Q3 launch plan)', /Q3 launch plan/.test(block));
  ok('REFUTED anticipated excluded (Madeline didn\'t show)', !/Madeline at the meeting/.test(block));
  ok('speculation excluded (never canonical)', !/Immersive Salesforce storytelling/.test(block));
  ok('block annotates how-she-knows (epistemic tags)', /\((told|read|anticipated)\)/.test(block));

  const top = gm.topFacts({ limit: 5 });
  const idx = (name) => top.findIndex(e => e.name === name);
  ok('trust ranks told (Joshua) above read (FAST-41)', idx('Joshua Fredrickson') > -1 && idx('FAST-41 Act') > -1 && idx('Joshua Fredrickson') < idx('FAST-41 Act'));

  console.log('\n3B — looksLikeOwnFragment suppresses her own sentences, allows world topics:');
  const F = monologue.looksLikeOwnFragment;
  ok('"this could be a unique angle for my article series" → fragment', F('this could be a unique angle for my article series') === true);
  ok('first-person introspection → fragment', F("I'm not sure if the Bipartisan Permitting Act could work") === true);
  ok('overlong prose clause → fragment', F('the way that immersive storytelling might possibly be applied to make Salesforce deduplication far more engaging for everyone') === true);
  ok('clean world topic allowed (FAST-41 permitting timelines)', F('FAST-41 federal permitting timelines') === false);
  ok('clean world topic allowed (Coast Guard AI program)', F('Coast Guard AI acquisition program') === false);
  ok('slice of a recent thought → fragment',
    F('Coast Guard AI connects to the Salesforce work', ['I keep thinking the Coast Guard AI connects to the Salesforce work somehow']) === true);
  ok('same topic, NOT echoing a thought → allowed',
    F('Coast Guard procurement reform', ['I keep thinking about immersive storytelling']) === false);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
