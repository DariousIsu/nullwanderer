/* Smoke: lib/vrm_state — the PURE mood/lip-sync/blink → VRM expression-weight adapter (voice-avatar-plan
 * V2 VRM rebuild). The three-vrm rendering needs WebGL + a .vrm (proven live via screenshot); this gate
 * covers the deterministic weight mapping.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_vrm_state.js
 */
'use strict';
const vs = require('../lib/vrm_state');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- expressionWeights: mood feeling → a VRM emotion ---
let e = vs.expressionWeights('warm and a little playful');
ok(e.mood === 'happy' && e.emotion === 'happy' && e.weights.happy > 0, '"playful" → VRM happy weight');
ok(vs.VRM_EMOTIONS.every((k) => typeof e.weights[k] === 'number'), 'weights include the full emotion set (numeric)');
ok(e.weights.sad === 0 && e.weights.angry === 0, 'inactive emotions are 0 (no leftover state)');

e = vs.expressionWeights('close and content, easy morning');
ok(e.emotion === 'relaxed' && e.weights.relaxed > 0, '"content/easy" → VRM relaxed');

e = vs.expressionWeights('slow and a bit tired');
ok(e.emotion === 'relaxed' && e.weights.relaxed > 0 && e.weights.relaxed < 0.7, 'tired → gentle relaxed (lower than warm)');

e = vs.expressionWeights('');
ok(e.emotion === 'neutral' && vs.VRM_EMOTIONS.every((k) => e.weights[k] === 0), 'empty → neutral, no active emotion');

e = vs.expressionWeights('curious, turning it over');
ok(e.mood === 'thinking' && e.emotion === 'neutral', 'thinking → neutral emotion (gaze handled in renderer)');

// --- viseme: amplitude → `aa` mouth weight, smoothed + clamped ---
ok(vs.viseme(0, 0).aa === 0, 'silence → mouth closed (aa 0)');
const open = vs.viseme(0.5, 0).aa;
ok(open > 0 && open <= 0.95, `loud → aa opens within cap (${open.toFixed(3)})`);
ok(vs.viseme(5, 0).aa <= 0.95, 'over-loud aa is clamped');
ok(vs.viseme(NaN, 0.2).aa >= 0, 'NaN amplitude → no NaN');

// --- blinkWeight: 0 open, ~1 shut, deterministic ---
ok(vs.blinkWeight(1000, { periodMs: 4200, durMs: 140 }) === 0, 'mid-cycle → eyes open (blink weight 0)');
const shut = vs.blinkWeight(70, { periodMs: 4200, durMs: 140 });
ok(shut > 0.9, `middle of blink → nearly fully shut (${shut.toFixed(3)})`);
ok(vs.blinkWeight(1000) === vs.blinkWeight(1000 + 4200), 'periodic blink (same phase one period later)');
ok(vs.blinkWeight(-70, { periodMs: 4200, durMs: 140 }) >= 0, 'negative time handled, no NaN');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
