/* Smoke: focus.isDirectedStop — the false-stop tightening + the autonomic-beat gate (D-stop + D-bleed,
 * 2026-08-16 drill). Pure logic, no DB. The live bug: "forget FEC for a second … fix it and run it again"
 * (100+ words, "it" ~word 90) matched the old stop-guard (stop-verb + bare pronoun anywhere) and park-cleared
 * the live focus, EATING the task (T7). Separately, an autonomic BEAT rotation was narrated to Lucas as
 * "you stopped that task, it's saved" (D-bleed) — the .beat gate now blocks that.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_directed_stop.js
 */
'use strict';
const { isDirectedStop } = require('../lib/focus');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── FIRE: bare pronoun RIGHT AFTER the stop-verb in a short imperative ──
ok(isDirectedStop('stop that'), '"stop that" (proximity, 2w)');
ok(isDirectedStop('forget it'), '"forget it" (proximity, 2w)');
ok(isDirectedStop('drop this'), '"drop this" (proximity, 2w)');
ok(isDirectedStop('cancel that'), '"cancel that" (proximity, 2w)');
ok(isDirectedStop('never mind, drop it'), '"never mind, drop it" (proximity on "drop it", 4w)');

// ── FIRE: the self-contained "enough" family fires FREELY (the regression the base spec missed) ──
ok(isDirectedStop("that's enough"), '"that\'s enough" (enough-family, free)');
ok(isDirectedStop("that's enough of the FEC deep dive for tonight, wrap it up"),
  'long "that\'s enough of the deep dive…" → FIRE (enough-family free at length — do not regress)');
ok(isDirectedStop("enough of that for the night, I've got what I need"),
  'long "enough of that for the night…" → FIRE (enough-family free at length)');

// ── FIRE: STRONG task-nouns fire freely at any length ──
ok(isDirectedStop('drop the project'), 'strong noun "project"');
ok(isDirectedStop('stop the research now please'), 'strong noun "research" (5w)');
ok(isDirectedStop('forget the FEC task'), 'strong noun "task"');
ok(isDirectedStop('pause your focus'), 'strong noun "focus"');
ok(isDirectedStop('ok stop working on that for now'), 'strong noun "working"');

// ── NO FIRE ──
ok(!isDirectedStop('forget FEC for a second — read the traceback and fix it and run it again, then paste me the output'),
  'T7: no strong noun, no enough-phrase, pronoun distal + >6w → NOT a stop (reaches the operator)');
ok(!isDirectedStop("drop it in the folder when you're done and email the team the summary of the analysis"),
  '>6w, no strong noun, no enough-phrase → NOT a stop');
ok(!isDirectedStop('let me know what it says'), 'no stop-verb → NOT a stop');

// ── BEAT GATE (D-bleed): an autonomic beat sweep never stop-acks, even with a real stop phrasing ──
ok(!isDirectedStop('stop working on that project', { hasBeat: true }),
  'hasBeat → NEVER a user stop (autonomic-rotate must not be narrated as "you stopped that")');
ok(isDirectedStop('stop working on that project', { hasBeat: false }),
  'same phrasing on a GENUINE user focus (no .beat) → FIRES (no regression to the happy path)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
