/* smoke_stage_direction.js — stage directions go, EMPHASIS WORDS STAY, markdown bold untouched.
 *
 * History of this seam, both directions:
 *  - 2026-07-20: the RP stripper ate the INNER of `**Bayesian inference**`, leaving "is **,".
 *  - 2026-08-19 (run-2 F15): the bold-safe pattern still deleted single-* spans WITH THEIR WORDS —
 *    live: "Chinese holdings are , fast" (*plummeting* eaten), "a response to a one" (*perceived*
 *    eaten). It dropped the emphasis-bearing words in her best writing, on three say paths.
 *
 * Spec now lives in lib/say_filter.cleanStars: a gesture-shaped span (*nods*, *smiles softly*) is
 * REMOVED; every other single-* span is UNWRAPPED (markup dropped, words kept); **bold** survives.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { cleanStars } = require('../lib/say_filter');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── ⭐ markdown bold SURVIVES ────────────────────────────────────────────────────────────────────
{
  const live = 'The most practical application is **Bayesian inference**, specifically when applied to polling data.';
  ok(cleanStars(live) === live, 'REGRESSION: the 07-20 live failure — **Bayesian inference** is not eaten');
  ok(cleanStars('Use **markdown** for **emphasis** here.') === 'Use **markdown** for **emphasis** here.',
    'multiple bolds all survive');
  ok(cleanStars('the answer is **term**, obviously') === 'the answer is **term**, obviously',
    'a bold followed by punctuation is untouched');
}

// ── ⭐ F15: emphasis words are KEPT (unwrapped), never deleted ───────────────────────────────────
{
  ok(cleanStars('Chinese holdings are *plummeting*, fast.') === 'Chinese holdings are plummeting, fast.',
    'REGRESSION (run-2 F15): "*plummeting*" keeps its word — the live corruption was "are , fast"');
  ok(cleanStars('a response to a *perceived* one') === 'a response to a perceived one',
    'REGRESSION (run-2 F15): "*perceived*" keeps its word');
  ok(cleanStars('The numbers tell a *chilling* story about *panic*.') === 'The numbers tell a chilling story about panic.',
    'multiple emphasis spans all unwrap');
  ok(cleanStars('That was *NOT* the plan.') === 'That was NOT the plan.',
    'a capitalized emphasis unwraps (capitals are never a gesture)');
  ok(cleanStars('the *Fufeng Group* case') === 'the Fufeng Group case',
    'a proper-noun span unwraps, words intact');
}

// ── stage directions still go ───────────────────────────────────────────────────────────────────
{
  ok(cleanStars('*smiles softly* That makes sense.').trim() === 'That makes sense.', 'a leading stage direction is removed');
  ok(cleanStars('That works. *nods*').trim() === 'That works.', 'a trailing one too');
  ok(!/shrugged/.test(cleanStars('She said **no** and *shrugged* at me.')), 'the direction goes…');
  ok(/\*\*no\*\*/.test(cleanStars('She said **no** and *shrugged* at me.')), '…while the bold in the SAME sentence stays');
  ok(cleanStars('*taps the desk* Here is the plan.').trim() === 'Here is the plan.', 'a multi-word gesture is removed');
  ok(cleanStars('*leans forward* Look at this.').trim() === 'Look at this.', 'leaning goes too');
}

// ── things that must not be touched ─────────────────────────────────────────────────────────────
{
  ok(cleanStars('2 * 3 = 6') === '2 * 3 = 6', 'arithmetic asterisks are not a stage direction pair');
  ok(cleanStars('no asterisks here') === 'no asterisks here', 'plain prose untouched');
  ok(cleanStars('') === '', 'empty string');
  const long = '*' + 'x'.repeat(500) + '*';
  ok(cleanStars(long) === long, 'an over-long span is left alone (the 200-char bound still applies)');
}

// ── WIRING: all three say paths run the shared filter; the word-eating pattern is GONE ─────────
{
  const files = { 'main.js': 2, 'lib/heartbeat.js': 1 };
  for (const [rel, expected] of Object.entries(files)) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const eating = (src.match(/\(\?<!\[\*\\w\]\)\\\*\(\?!\\\*\)\[\^\*\\n\]\{1,200\}\\\*\(\?!\\\*\)/g) || []).length;
    ok(eating === 0, `REGRESSION: ${rel} has no word-eating star stripper left (found ${eating})`);
    const wired = (src.match(/say_filter'?\)\.filterSay\(/g) || []).length;
    ok(wired === expected, `${rel} runs say_filter.filterSay on all ${expected} path(s) (found ${wired})`);
  }
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
