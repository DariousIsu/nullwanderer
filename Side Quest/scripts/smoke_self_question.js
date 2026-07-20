/* smoke_self_question.js — a question about HER INNER LIFE is hers to answer, not a lookup.
 *
 * Live failure 2026-07-20:
 *   Lucas: "That's really interesting how do you aspire to be more like her?"
 *   Zoe:   "I checked our records and searched, but I couldn't pin down the AI's aspirations
 *           or goals regarding Zoe Lane."
 *   (her own thought: "According to the instruction, I must answer that I couldn't pin down…")
 *
 * It carried a '?', so classifyClaimType said FACTUAL, the turn went cloud-owned, and the cognition
 * ladder tried to resolve her own aspirations as an entity lookup on "Zoe Lane". Five tiers missed
 * and it returned its canned miss line, which the cloud then voiced verbatim.
 *
 * OPINION_RE already covered taste and opinion — aspiration, admiration and self-image just weren't
 * in it. Adding those three phrasings is the enumerate-and-miss trap that produced both this bug and
 * the "Hey Zoe" one, so the guard states the DISTINCTION instead: second person + an inner-life
 * predicate. The records half is asserted just as hard, because over-correcting here would blind her
 * to real questions about our data.
 */
'use strict';
const meta = require('../lib/metacognition');
const cognition = require('../lib/cognition');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── HER INNER LIFE → not a factual lookup ───────────────────────────────────────────────────────
{
  const inner = [
    "That's really interesting how do you aspire to be more like her?",   // the live failure
    'What are your goals?', 'What are your aspirations?', 'Who do you admire?',
    'What is your purpose?', 'Tell me about your dreams', 'What do you fear?',
    'What do you value most?', 'How do you see your own identity?',
    'What are you curious about?', 'What are your principles?',
    'Who do you look up to?', 'What do you care about?',
  ];
  for (const q of inner) ok(meta.classifyClaimType(q) === 'other', `inner life, not a lookup: "${q}"`);
}

// ── ⭐ REAL questions about OUR DATA must stay factual ───────────────────────────────────────────
// The over-correction risk: swallow "do you have…" and she goes blind to her own records, which is
// the *other* failure this codebase keeps hitting. Records verbs are deliberately absent from the
// inner-life pattern.
{
  const factual = [
    'How many parishes are in Louisiana?',
    'Do you have contact info for the parish leadership?',
    'What do you know about Appling County?',
    'How many contacts do we have for Louisiana parish leadership?',
    'Who is Zoe Lofgren?',
    'Did you find the roster?',
    'What did you pull for Kent County?',
    'Do we hold emails for those 64 parishes?',
  ];
  for (const q of factual) ok(meta.classifyClaimType(q) === 'factual', `still a records/fact question: "${q}"`);
}

// ── taste/opinion still classified as before (no regression) ────────────────────────────────────
{
  for (const q of ["Who's your favorite historical figure?", 'What do you think about that?', 'How do you feel today?'])
    ok(meta.classifyClaimType(q) === 'other', `unchanged: "${q}"`);
}

// ── ⭐ the miss line must not claim a check it did not make ──────────────────────────────────────
// A false verification claim CLOSES the question — Lucas has no reason to ask again. This is the
// single sentence this codebase keeps getting wrong.
(async () => {
  const mkDeps = (allowMode) => ({
    ask: async () => 'NEED: something',                       // always a NEED → never answers
    now: () => Date.now(),
    intent: { kind: 'other', topic: '', needs_fresh: false },
    // every enrich tier returns nothing, so the ladder walks to the end
    echo: async () => null, search: async () => null, fetch: async () => null,
    _allow: allowMode,
  });
  const r = await cognition.answerGrounded({ userMessage: 'what is the thing', grounding: '', deps: mkDeps() });
  if (!r || !r.missed) { ok(false, 'expected the ladder to end in a miss'); }
  else {
    ok(Array.isArray(r.tried), 'the miss reports which tiers actually ran');
    const claimsRecords = /checked our records/.test(r.say);
    const ranOurs = (r.tried || []).some((t) => t === 'graph' || t === 'routed');
    ok(claimsRecords === ranOurs,
      'REGRESSION: "I checked our records" is claimed if and ONLY if a records tier actually ran');
    const claimsSearch = /\bsearched\b/.test(r.say);
    const ranOut = (r.tried || []).some((t) => ['wiki', 'web', 'excavate'].includes(t));
    ok(claimsSearch === ranOut, '"searched" is claimed if and only if an external tier actually ran');
    ok(/couldn't pin down/.test(r.say), 'still an honest, specific miss rather than a dead end');
  }

  // ── ⭐ GENERAL KNOWLEDGE IS NOT A RECORDS MISS ─────────────────────────────────────────────────
  // Live 2026-07-20: "what are the laws of thermodynamics and how are new China made chips being
  // designed to go around them" walked the whole ladder, found no ENTITY, and answered "I checked
  // our records and searched, but I couldn't pin down China comp…". metacognition already held this
  // rule (buildDirective returns null for scope 'general' — "the model is the source; never suppress
  // it"); the ladder didn't know about scope and overrode it.
  {
    const r = await cognition.answerGrounded({
      userMessage: 'what are the laws of thermodynamics', grounding: '', scope: 'general', deps: mkDeps(),
    });
    ok(r === null, 'a general-knowledge miss returns null so the writer answers, instead of refusing');

    // …but a question about something we SHOULD hold still gets the honest miss.
    const r2 = await cognition.answerGrounded({
      userMessage: 'how many parish contacts do we have', grounding: '', scope: 'personal', deps: mkDeps(),
    });
    ok(r2 && r2.missed === true, 'a records-scope miss still reports the miss honestly');

    // an object in hand means it IS about something we hold — never silently drop that.
    const r3 = await cognition.answerGrounded({
      userMessage: 'tell me about it', grounding: '', scope: 'general',
      object: { name: 'Appling County' }, deps: mkDeps(),
    });
    ok(r3 && r3.missed === true, 'general scope but a REAL object → still an honest miss, not silence');
  }

  // ── ⭐ DATE-ANCHOR: retrieved text carries no timestamp ────────────────────────────────────────
  // Live 2026-07-20: "When are elections this year in the US?" → cognition → enriched:wiki →
  // "…were held on November 5, 2024." The tier worked; the Wikipedia lead describes the LAST
  // occurrence of a recurring event, and nothing checked it against what today is.
  {
    const fs2 = require('fs'), path2 = require('path');
    const src2 = fs2.readFileSync(path2.join(__dirname, '..', 'lib', 'cognition.js'), 'utf8');
    ok(/TODAY is given below/.test(src2), 'the drafter is told what today is');
    ok(/this year.*now.*current.*upcoming/is.test(src2), 'relative time words are named as anchoring to TODAY');
    ok(/emit a NEED for the current one/.test(src2),
      'grounding from the WRONG PERIOD becomes a NEED rather than an answer');
    ok(/input: \{ today,/.test(src2), 'today is passed in the cached input, so the key rolls daily');
    ok(/task: 'answer_or_need', v: 2/.test(src2),
      'REGRESSION: prompt version bumped — ask() caches on {task,v,input,want} and would re-serve the old verdict');
  }

  // the wiring itself
  const fs = require('fs'), path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cognition.js'), 'utf8');
  ok(!/say: `I checked our records and searched, but/.test(src),
    'REGRESSION: the unconditional records claim is gone');
  ok(/_tried\.push\(mode\)/.test(src), 'the ladder records what it reached');
  const m = fs.readFileSync(path.join(__dirname, '..', 'lib', 'metacognition.js'), 'utf8');
  ok(/SELF_INNER_RE\.test\(s\)/.test(m), 'the inner-life guard is wired into classifyClaimType');
  ok(!/принципы/.test(m), 'no stray non-English token in the pattern');

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
