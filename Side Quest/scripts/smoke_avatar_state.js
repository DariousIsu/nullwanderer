/* Smoke: lib/avatar_state — the PURE avatar face-state core (voice-avatar-plan V2). The canvas DRAW lives
 * in renderer/avatar.js (browser); this gate covers the deterministic math: mood→expression, amplitude→mouth
 * lip-sync smoothing, blink timing, rms.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_avatar_state.js
 */
'use strict';
const av = require('../lib/avatar_state');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- moodToExpression: her real `feeling` text → a face ---
ok(av.moodToExpression('warm and a little playful') === 'happy', '"playful" → happy (priority over warm)');
ok(av.moodToExpression('close and content, easy morning') === 'warm', '"content/easy" → warm');
ok(av.moodToExpression('curious, turning something over') === 'thinking', '"curious" → thinking');
ok(av.moodToExpression('slow and a bit tired') === 'tired', '"tired" → tired');
ok(av.moodToExpression('') === 'neutral' && av.moodToExpression(null) === 'neutral', 'empty/null → neutral');
ok(av.moodToExpression('utterly nondescript') === 'neutral', 'no keyword → neutral');

// --- presets: shape + fallback ---
const keys = ['brow', 'eye', 'mouthCurve', 'gazeY'];
ok(keys.every((k) => typeof av.EXPRESSIONS.happy[k] === 'number'), 'happy preset has all numeric fields');
ok(av.expressionPreset('nope') === av.EXPRESSIONS.neutral, 'unknown name → neutral preset');
ok(av.presetForFeeling('playful') === av.EXPRESSIONS.happy, 'presetForFeeling maps through mood');
ok(av.EXPRESSIONS.happy.mouthCurve > av.EXPRESSIONS.tired.mouthCurve, 'happy smiles more than tired');
ok(av.EXPRESSIONS.tired.eye < av.EXPRESSIONS.neutral.eye, 'tired eyes more lidded than neutral');

// --- amplitudeToMouth: envelope smoothing + clamps ---
ok(av.amplitudeToMouth(0, 0) === 0, 'silence from closed → stays closed');
const opened = av.amplitudeToMouth(0.5, 0);
ok(opened > 0 && opened <= 0.95, `loud from closed → opens within cap (${opened.toFixed(3)})`);
ok(av.amplitudeToMouth(2.0, 0) <= 0.95, 'over-loud is clamped to max');
const attackStep = av.amplitudeToMouth(0.5, 0);
const decayStep = av.amplitudeToMouth(0, 0.5);
ok(attackStep > (0.5 - decayStep), 'attack (open) is faster than decay (close)');
ok(av.amplitudeToMouth(0.01, 0.0) === 0, 'sub-floor amplitude reads as closed');
ok(av.amplitudeToMouth(NaN, 0.3) >= 0 && av.amplitudeToMouth(0.3, NaN) >= 0, 'NaN inputs never produce NaN');

// --- rms ---
ok(av.rms([]) === 0 && av.rms(null) === 0, 'empty/null rms → 0');
ok(Math.abs(av.rms([1, -1, 1, -1]) - 1) < 1e-9, 'full-scale square → rms 1');
ok(av.rms([0.5, -0.5]) > 0 && av.rms([0.5, -0.5]) < 1, 'partial signal → 0<rms<1');

// --- blinkMultiplier: open most of the time, closes periodically, deterministic ---
ok(av.blinkMultiplier(1000, { periodMs: 4200, durMs: 140 }) === 1, 'mid-cycle (t=1000) → eyes open');
const mid = av.blinkMultiplier(70, { periodMs: 4200, durMs: 140 });   // t=70 is the middle of the blink
ok(mid < 0.3, `middle of blink → nearly shut (${mid.toFixed(3)})`);
ok(av.blinkMultiplier(0) === 1, 't=0 → open (blink starts closing after)');
ok(av.blinkMultiplier(-70, { periodMs: 4200, durMs: 140 }) >= 0, 'negative time is handled (no NaN)');
ok(av.blinkMultiplier(1000) === av.blinkMultiplier(1000 + 4200), 'periodic: same phase one period later');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
