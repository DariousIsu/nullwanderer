/* smoke_stage_direction.js — strip roleplay stage directions, NOT markdown bold.
 *
 * Live 2026-07-20, visible in chat:
 *   "The most practical application is **, specifically when applied to polling data."
 * The term was **Bayesian inference**. The RP-narration stripper — /\*[^*\n]{1,200}\*​/g — cannot
 * see doubled delimiters, so on `**Bayesian inference**` it matched the INNER `*Bayesian inference*`
 * and deleted it, leaving a bare `**`.
 *
 * Worse, it also got the priority backwards: on "She said **no** and *shrugged* at me" the old
 * pattern ate the bold and LEFT the stage direction — the exact opposite of its purpose.
 *
 * Every reply containing a bolded term was being corrupted, silently, on three separate paths
 * (the main say, the tool-followup, and the heartbeat).
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// The pattern the three call sites use, kept here as the single behavioural spec.
const STRIP = /(?<![*\w])\*(?!\*)[^*\n]{1,200}\*(?!\*)/g;
const strip = (s) => s.replace(STRIP, '');

// ── ⭐ markdown bold SURVIVES ────────────────────────────────────────────────────────────────────
{
  const live = 'The most practical application is **Bayesian inference**, specifically when applied to polling data.';
  ok(strip(live) === live, 'REGRESSION: the live failure — **Bayesian inference** is no longer eaten');
  ok(strip('Use **markdown** for **emphasis** here.') === 'Use **markdown** for **emphasis** here.',
    'multiple bolds all survive');
  // The exact corrupted string that reached Lucas — an EMPTY bold where the term should be.
  const corrupted = 'The most practical application is **, specifically when applied to polling data.';
  ok(strip(live) !== corrupted, 'REGRESSION: does not produce the empty "is **," that shipped live');
  ok(strip('the answer is **term**, obviously') === 'the answer is **term**, obviously',
    'a bold followed by punctuation is untouched');
}

// ── stage directions still go ───────────────────────────────────────────────────────────────────
{
  ok(strip('*smiles softly* That makes sense.').trim() === 'That makes sense.', 'a leading stage direction is removed');
  ok(strip('That works. *nods*').trim() === 'That works.', 'a trailing one too');
  ok(!/shrugged/.test(strip('She said **no** and *shrugged* at me.')), 'the direction goes…');
  ok(/\*\*no\*\*/.test(strip('She said **no** and *shrugged* at me.')), '…while the bold in the SAME sentence stays');
}

// ── things that must not be touched ─────────────────────────────────────────────────────────────
{
  ok(strip('2 * 3 = 6') === '2 * 3 = 6' || !/\d\s\*\s\d/.test('x'), 'arithmetic asterisks are not a stage direction pair');
  ok(strip('no asterisks here') === 'no asterisks here', 'plain prose untouched');
  ok(strip('') === '', 'empty string');
  const long = '*' + 'x'.repeat(500) + '*';
  ok(strip(long) === long, 'an over-long span is left alone (the 200-char bound still applies)');
}

// ── WIRING: all three paths use the bold-safe pattern ───────────────────────────────────────────
// The same stripper is duplicated across the main say, the tool-followup and the heartbeat. Fixing
// one and missing another would leave the corruption on whichever path was missed.
{
  const files = { 'main.js': 2, 'lib/heartbeat.js': 1 };
  for (const [rel, expected] of Object.entries(files)) {
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    const bad = (src.match(/\.replace\(\/\\\*\[\^\*\\n\]\{1,200\}\\\*\/g/g) || []).length;
    ok(bad === 0, `REGRESSION: ${rel} has no bold-eating stripper left`);
    const good = (src.match(/\(\?<!\[\*\\w\]\)\\\*\(\?!\\\*\)/g) || []).length;
    ok(good === expected, `${rel} uses the bold-safe pattern on all ${expected} path(s) (found ${good})`);
  }
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
