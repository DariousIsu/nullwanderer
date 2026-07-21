/* smoke_awareness_standing.js — the ALWAYS-ON standing/working lines in the awareness block.
 *
 * These facts already existed but only surfaced REACTIVELY: main.js gates the self-state + coverage
 * block on `stateQ || coverageQ`, which matches literal status phrasings. Against ten realistic
 * turns, eight were blind — and the blind ones were the DECISION questions ("do we have enough on
 * Louisiana to write the brief?", "is the county work worth continuing?"), exactly where 64-of-64
 * versus 9-of-64 changes the answer.
 *
 * The load-bearing tests are the HONESTY ones: an unknown standing must print NOTHING rather than a
 * fabricated 0%, and a partial set must never be renderable as complete.
 */
'use strict';
const ctx = require('../lib/context');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }

const base = { chosenName: 'Zoe', sessionStartedAt: Date.now() - 60000, cumulativeMs: 3600000 };

(async () => {
  // ── absent by default — no standing, no line ─────────────────────────────────────────────────
  {
    const b = ctx.buildAwarenessBlock(base);
    ok(!/researched/i.test(b), 'no standing supplied → no standing line');
    ok(!/actively working/i.test(b), 'no working focus → no working line');
    ok(/AWARENESS/.test(b), 'the rest of the awareness block still renders');
  }

  // ── SAFETY: an unknown standing must not become "0%" ─────────────────────────────────────────
  {
    ok(!/researched/i.test(ctx.buildAwarenessBlock({ ...base, standing: null })),
      'SAFETY: null standing prints nothing (never a fabricated 0%)');
    ok(!/researched/i.test(ctx.buildAwarenessBlock({ ...base, standing: { done: 0, total: 0, pct: 0 } })),
      'SAFETY: 0/0 prints nothing — "0% researched" would read as "nothing has been done"');
  }

  // ── a real standing renders, with the denominator ────────────────────────────────────────────
  {
    const b = ctx.buildAwarenessBlock({ ...base, standing: { done: 203, total: 52890, pct: 0, completeBeats: 2, beats: 223 } });
    ok(/203 of 52,890/.test(b), 'renders done-of-total with thousands separators');
    ok(/2 beats fully complete/.test(b), 'reports complete beats');
    ok(/not something to recite/i.test(b), 'framed as background — the long-block recitation guard');
    ok(/never claim a set is complete when this says otherwise/i.test(b),
      'SAFETY: explicitly forbids claiming completeness against its own number');
  }

  // singular/plural on the beat count
  ok(/1 beat fully complete/.test(ctx.buildAwarenessBlock({ ...base, standing: { done: 5, total: 10, pct: 50, completeBeats: 1 } })),
    'singular "1 beat fully complete"');

  // ── SAFETY: "0%" against a huge portfolio reads as "nothing done" ────────────────────────────
  // Live: 211 of 52,890 rounds to 0, and printing "(0%)" next to "43 beats fully complete" is
  // arithmetically right and communicatively false.
  {
    const b = ctx.buildAwarenessBlock({ ...base, standing: { done: 211, total: 52890, pct: 0, completeBeats: 43 } });
    ok(/under 1%/.test(b) && !/\(0%\)/.test(b), 'SAFETY: real-but-tiny progress renders "under 1%", never "0%"');
    ok(/211 of 52,890/.test(b) && /43 beats fully complete/.test(b), 'the true counts still lead');
    // a genuine zero (nothing done at all) is allowed to say 0%
    ok(/\(0%\)/.test(ctx.buildAwarenessBlock({ ...base, standing: { done: 0, total: 100, pct: 0 } })),
      'a genuine 0-of-N still reports 0%');
  }

  // ── SAFETY: goal truncation must not cut mid-word ────────────────────────────────────────────
  {
    const longGoal = 'Compile and keep current every member of the Wyoming state legislature — both chambers complete rosters with district, party, and A-grade contact information';
    const b = ctx.buildAwarenessBlock({ ...base, working: { goal: longGoal, universe: 2, done: 1, workers: 0 } });
    const line = b.split('\n').find(l => /actively working/.test(l));
    ok(/…/.test(line), 'long goal is elided');
    // the kept text must end on a WORD boundary: it is a prefix of the original that is followed by
    // a space (not a mid-word cut like "…and A-grade c").
    const kept = line.slice(line.indexOf('working: ') + 9).split('…')[0];
    ok(longGoal.startsWith(kept), 'kept text is a true prefix of the goal');
    ok(longGoal[kept.length] === ' ' || longGoal.length === kept.length,
      'SAFETY: elision lands on a word boundary, not mid-word');
    ok(/1 of 2 done so far/.test(line), 'denominator survives truncation');
  }

  // ── the working line ─────────────────────────────────────────────────────────────────────────
  {
    const b = ctx.buildAwarenessBlock({ ...base, working: { goal: 'compile leadership for all Louisiana parishes', universe: 64, done: 9, workers: 2 } });
    ok(/actively working: compile leadership for all Louisiana parishes/.test(b), 'names the live goal');
    ok(/9 of 64 done so far/.test(b), 'carries the coverage denominator into the ambient line');
    ok(/2 background workers running/.test(b), 'reports background workers (plural)');
    ok(/1 background worker running/.test(ctx.buildAwarenessBlock({ ...base, working: { goal: 'g', universe: 4, done: 1, workers: 1 } })),
      'singular "1 background worker"');
    // an unknown universe must not invent one
    const nb = ctx.buildAwarenessBlock({ ...base, working: { goal: 'something open-ended', universe: null, done: null, workers: 0 } });
    ok(/actively working: something open-ended/.test(nb), 'goal renders without a denominator');
    // Assert the DENOMINATOR shape ("9 of 64 done"), not the bare word "of" — the line also carries
    // prose that legitimately contains "of" ("NOT the subject of this conversation", added when the
    // beat's subject started answering unrelated questions). The safety property is that no count is
    // invented, so test for a count.
    ok(!/\d+\s+of\s+\d+/.test(nb.split('actively working')[1].split('\n')[0]),
      'SAFETY: no denominator invented when the universe is unknown');
    ok(!/done so far/.test(nb.split('actively working')[1].split('\n')[0]),
      'SAFETY: no progress claim at all without a real universe');
  }

  // ── junk in → no throw, no line ──────────────────────────────────────────────────────────────
  {
    ok(typeof ctx.buildAwarenessBlock({ ...base, standing: 'nonsense', working: 42 }) === 'string', 'bad types do not throw');
    ok(!/actively working/i.test(ctx.buildAwarenessBlock({ ...base, working: { goal: '' } })), 'empty goal → no working line');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
