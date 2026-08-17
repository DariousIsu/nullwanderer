'use strict';
/* smoke_image_intent.js — recover a PROMISED-but-undrawn image (2026-08-17 live audit).
 *
 * Live: an INDIRECT ask ("I can't picture my patio with a koi pond…") made her COMMIT ("I'll render an image…
 * give me a moment") and write the prompt as PROSE, but she emitted NO <draw> → canvasWrites:0, no image. The
 * anti-fab gate skips future-tense ("not falsifiable"), so the dangling promise was unguarded. lib/image_intent
 * detects it (regex prefilter → bounded model that extracts the prompt or NONE, FAIL CLOSED) so the harness can
 * dispatch the <draw> she meant. Proves: prefilter precision; extraction; NONE/empty/throw all → null (never a
 * spurious image); no-intent never calls the model; + the main.js wiring & manifest steer.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_image_intent.js
 */
const fs = require('fs'), path = require('path');
const ROOT = 'C:/Users/azrae/Desktop/Side Quest';
const ii = require(ROOT + '/lib/image_intent');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

(async () => {
  // 1. PREFILTER precision — committed-but-unfired image intent nominates; other shapes do not.
  ok(ii.looksLikeUnfiredImageIntent("I'll render an image of your patio with a Japanese garden. Give me a moment."), 'nominates the committed promise (I\'ll render an image …)');
  ok(ii.looksLikeUnfiredImageIntent('let me draw that for you real quick'), 'nominates "let me draw that for you"');
  ok(ii.looksLikeUnfiredImageIntent('give me a sec — I\'ll whip up a picture of it'), 'nominates "give me a sec … whip up a picture"');
  ok(!ii.looksLikeUnfiredImageIntent('here is the image I already made — it is on your canvas'), 'does NOT nominate a COMPLETED claim (no commitment marker)');
  ok(!ii.looksLikeUnfiredImageIntent("I'll look into the weather and get back to you"), 'does NOT nominate a non-image promise (no draw-verb + image-noun)');
  ok(!ii.looksLikeUnfiredImageIntent('I can describe the layout for you in words'), 'does NOT nominate "describe … in words" (describe is not a draw verb)');
  ok(!ii.looksLikeUnfiredImageIntent('the report is coming together nicely'), 'does NOT nominate ordinary non-image chat');

  const SAY = "I can see that for you — literally. I'll render an image of your patio with a Japanese-style garden and a koi pond off to one side. Give me a moment.";

  // 2. EXTRACTION — an intent + a model that returns a prompt → that prompt is dispatched.
  const gotPrompt = await ii.recoverUnfiredPrompt(SAY, { classify: async () => 'A serene back patio with a Japanese garden, a curved koi pond, stepping stones, soft morning light, photorealistic' });
  ok(gotPrompt && /koi pond/i.test(gotPrompt), 'a committed intent + a real prompt from the model → the prompt to draw');

  // 3. model preamble is stripped to the bare prompt
  const stripped = await ii.recoverUnfiredPrompt(SAY, { classify: async () => 'Prompt: a red fox asleep in snow under pines' });
  ok(stripped === 'a red fox asleep in snow under pines', 'a "Prompt:" preamble is stripped to the bare prompt');

  // 4. FAIL CLOSED — NONE, empty, too-short, and a throw ALL return null (never a spurious image)
  ok((await ii.recoverUnfiredPrompt(SAY, { classify: async () => 'NONE' })) === null, 'model says NONE (she only offered / referred elsewhere) → null, no dispatch');
  ok((await ii.recoverUnfiredPrompt(SAY, { classify: async () => '' })) === null, 'model returns empty → null (fail closed)');
  ok((await ii.recoverUnfiredPrompt(SAY, { classify: async () => 'ok' })) === null, 'model returns a too-short non-answer → null (fail closed)');
  ok((await ii.recoverUnfiredPrompt(SAY, { classify: async () => { throw new Error('cloud down'); } })) === null, 'model call throws → null (fail closed — never a spurious image)');

  // 5. NO INTENT → returns null WITHOUT ever calling the model (the prefilter is the cheap gate)
  let called = false;
  const noIntent = await ii.recoverUnfiredPrompt('the weather looks clear tomorrow', { classify: async () => { called = true; return 'x'; } });
  ok(noIntent === null && called === false, 'no image intent → null and the model is NEVER called (prefilter gates the cost)');

  // 6. WIRING — the backstop is dispatched from main.js, and the manifest carries the one-step steer.
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  ok(/require\('\.\/lib\/image_intent'\)\.recoverUnfiredPrompt\(say\)/.test(mainSrc), 'main.js calls image_intent.recoverUnfiredPrompt on the reply');
  ok(/imageGenToRun\.length === 0 && \(lastImageGenTs \|\| 0\) < _imgTurnStart/.test(mainSrc), 'the backstop fires only when NO tag AND NO image rendered this turn');
  ok(/never narrate it as .I\\?'ll render it. or .give me a moment./.test(mainSrc) || /the tag renders now or nothing does/.test(mainSrc), 'the <draw> manifest carries the ONE-STEP steer (emit now, no "give me a moment")');
})().then(() => {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('threw:', e.stack || e.message); process.exit(1); });
