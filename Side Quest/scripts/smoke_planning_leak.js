/* smoke_planning_leak.js — her scaffolding must not reach Lucas as speech.
 *
 * Three times on 2026-07-21, her ENTIRE reply was the model narrating its next move:
 *
 *   #9064  "We need to emit a web search."
 *   #8994  "We need to fetch Iowa state flower. Use echo-find."
 *   #8917  "We need to emit an Echo tag to get db map."
 *
 * leakguard already stripped leaked '[directives]' and '<tags>' — neither fires on bare prose, so
 * this walked straight through every guard in the file.
 *
 * The hard part is precision, not detection: an early draft of the strip deleted "I should emit a
 * note here about how the county boards are structured, because…" — a person thinking out loud —
 * because it matched the same planning verb. Length is what separates scaffolding from prose, and
 * the false-positive tests below are the ones that matter.
 */
'use strict';
const L = require('../lib/leakguard');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

// ── the three real leaks ────────────────────────────────────────────────────────────────────────
{
  ok(L.stripPlanningLeak('We need to emit a web search.') === '', 'live #9064 is removed entirely');
  ok(L.stripPlanningLeak('We need to fetch Iowa state flower. Use echo-find.') === '',
    'live #8994 — the plan and the tool name split across two sentences');
  ok(L.stripPlanningLeak('We need to emit an Echo tag to get db map.') === '', 'live #8917');
  ok(L.stripPlanningLeak('We need to emit a web search. The Rainey Huddle is on Tuesdays.') === 'The Rainey Huddle is on Tuesdays.',
    'scaffolding is stripped and the REAL reply is kept');
}

// ── ⭐ SAFETY: real speech survives ─────────────────────────────────────────────────────────────
{
  const keep = [
    'I need to check the calendar before I answer that.',
    "Let's go through the parishes one at a time.",
    'We need to be careful about that claim.',
    'Let me pull that up for you.',
    'I should emit a note here about how the county boards are structured, because the tag system in Louisiana differs from Michigan in ways that matter.',
    'We need to talk about what happened in the huddle.',
    'First, I want to say the Summit dates are still open.',
  ];
  for (const s of keep) ok(L.stripPlanningLeak(s) === s, `kept: "${s.slice(0, 48)}…"`);
}

// ── edges ───────────────────────────────────────────────────────────────────────────────────────
{
  ok(L.stripPlanningLeak('') === '' && L.stripPlanningLeak(null) === '', 'empty in, empty out');
  ok(typeof L.stripPlanningLeak(undefined) === 'string', 'undefined does not throw');
  const plain = 'The Rainey Weekly Huddle meets on Tuesdays at 10:45 Eastern.';
  ok(L.stripPlanningLeak(plain) === plain, 'ordinary prose is untouched');
  // planning language WITHOUT internal mechanics is just talk
  ok(L.stripPlanningLeak('We need to start with Louisiana.') === 'We need to start with Louisiana.',
    'SAFETY: a plan with no machinery in it is speech, not scaffolding');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
