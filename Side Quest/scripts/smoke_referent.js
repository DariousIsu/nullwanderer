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

// ── DEMONSTRATIVE ANAPHORA ("what is that Trump story about?") ─────────────────────────────────
{
  // the live failure: carries subject words, so it is NOT elliptical — the demonstrative path must own it
  ok(r.isElliptical('what is that Trump story about?') === false,
    'demonstrative question is NOT elliptical (has subject words) — ellipsis guard correctly skips it');
  const d = r.demonstrativeReference('what is that Trump story about?');
  ok(d && d.refNoun === 'story', 'detects the reference noun "story"');
  ok(d && d.keys.includes('trump'), 'extracts the distinctive modifier "trump" as the search key');

  ok(r.demonstrativeReference('what is the weather today') === null, 'no demonstrative+ref-noun → null (fresh subject left alone)');
  ok(r.demonstrativeReference('tell me about the LAMP summit') === null, 'a plain "the X" without a demonstrative → null');

  // resolve against a conversation where SHE told him the specific story
  const convo = [
    { speaker: 'user', content: 'anything major in the news?' },
    { speaker: 'ai_said', content: 'A video surfaced tying Trump to the Melat Kiros election in Colorado.' },
    { speaker: 'user', content: 'what is that Trump story about?' },
  ];
  const got = r.resolveDemonstrative('what is that Trump story about?', convo);
  ok(got && /Melat Kiros/.test(got.text), 'anchors to the ASSISTANT turn that raised the specific story, not ambient news');
  ok(got && got.speaker === 'ai_said', 'resolves across assistant turns (she usually told him the thing)');

  // no matching prior turn → null (falls through, behaves as today — conservative)
  ok(r.resolveDemonstrative('what is that Trump story about?', [{ speaker: 'user', content: 'hello there' }]) === null,
    'no turn mentions the key → null (never suppresses retrieval on a guess)');

  const b = r.buildDemonstrativeBlock('A video surfaced tying Trump to the Melat Kiros election.', 'story', 'Lucas');
  ok(/Melat Kiros/.test(b), 'demonstrative block names the specific referent');
  ok(/Do NOT substitute a different story/i.test(b), 'CRITICAL: forbids substituting another instance from the news beat — the observed failure');
  ok(r.buildDemonstrativeBlock('', 'story') === null, 'no referent → no block');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
