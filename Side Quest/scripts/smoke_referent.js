/* smoke_referent.js — resolving elliptical follow-ups ("Full research brief please").
 *
 * The load-bearing tests are the NEGATIVES. Calling a real question "contentless" would suppress
 * retrieval on a turn that needed it, so the bar for eliding must be high; missing an elliptical turn
 * only leaves today's behaviour in place.
 */
'use strict';
const r = require('../lib/referent');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── THE LIVE CASE ──────────────────────────────────────────────────────────────────────────────
ok(r.isElliptical('Full research brief please') === true,
  'THE LIVE CASE: "Full research brief please" names a FORMAT, not a subject');

// ── other contentless follow-ups ───────────────────────────────────────────────────────────────
for (const s of ['yes', 'yes please', 'go ahead', 'do that', 'the full version', 'more detail please',
  'sounds good', 'ok great', 'continue', 'the long one', 'a summary would be great', 'perfect, more please']) {
  ok(r.isElliptical(s) === true, `elliptical: "${s}"`);
}

// ── CRITICAL NEGATIVES: one distinctive word is enough to carry a subject ──────────────────────
for (const s of [
  "Full research brief on China's World AI announcements",
  'research brief on the Louisiana parishes',
  'summarize the Burnham situation',
  'more detail on Calcasieu',
  'yes, the Virginia one',
  'go ahead with the school boards',
]) {
  ok(r.isElliptical(s) === false, `CRITICAL: carries a subject, must NOT be elided: "${s}"`);
}
ok(r.isElliptical('') === false, 'empty → not elliptical (nothing to resolve), never throws');
ok(r.isElliptical('   ') === false, 'whitespace → not elliptical');
// Length itself is evidence something is being said.
ok(r.isElliptical('please could you go ahead and do that same thing again for me now as well ok') === false,
  'a long message is never treated as contentless however generic its words');

// ── subjectWords ───────────────────────────────────────────────────────────────────────────────
ok(r.subjectWords('Full research brief please').length === 0, 'format words carry no subject');
ok(r.subjectWords("brief on China's World AI").includes('china'), "possessive kept as a subject word");
ok(r.subjectWords('more on Calcasieu').includes('calcasieu'), 'a proper noun survives');

// ── resolveReferent: walk back past the follow-ups to the real topic ───────────────────────────
{
  const turns = [
    { speaker: 'user', content: "Zoe, look for news stories about China's World AI and the open source announcement" },
    { speaker: 'ai_said', content: "I'm looking into that now." },
    { speaker: 'user', content: 'Full research brief please' },
  ];
  const got = r.resolveReferent(turns);
  ok(got && /World AI/.test(got.text), 'THE FIX: resolves back to the China World AI request, not to notes');

  // A CHAIN of follow-ups must still land on the topic, not on the previous shrug.
  const chained = turns.concat([
    { speaker: 'ai_said', content: 'On it.' },
    { speaker: 'user', content: 'yes please' },
  ]);
  const got2 = r.resolveReferent(chained);
  ok(got2 && /World AI/.test(got2.text), 'a chain of elliptical turns still resolves to the real subject');

  ok(r.resolveReferent([]) === null, 'no turns → null, never throws');
  ok(r.resolveReferent([{ speaker: 'user', content: 'yes' }]) === null, 'only elliptical turns → null (nothing to inherit)');
  ok(r.resolveReferent(null) === null, 'null input → null');
}

// ── the block states the referent AND forbids substituting another ─────────────────────────────
{
  const b = r.buildBlock("look for news about China's World AI", 'Lucas');
  ok(/World AI/.test(b), 'block names the referent');
  ok(/Do NOT substitute a different topic/i.test(b),
    'CRITICAL: forbids substituting a topic from notes/research — the observed failure was a CONFIDENT wrong subject');
  ok(/ASK rather than picking one/i.test(b), 'unresolvable → ask, not guess');
  ok(r.buildBlock('') === null && r.buildBlock(null) === null, 'no referent → no block');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
