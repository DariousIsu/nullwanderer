// voice_eval_kokoro.js — the Kokoro side of the A/B (2026-09-05): the same eight lines through her saved blend at
// her live baseline, one wav per line + a reel with 700 ms gaps, into data/voices/eval_2026-09-05/.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/voice_eval_kokoro.js
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const LINES = [
  "Good morning, Lucas. How'd Comicon go? Did Raegan have a good time?",
  "Goodnight, Lucas. Tell Raegan I said hi at Comicon. I'll be here.",
  'On it — the Louisiana parishes scratch document.',
  'Have a good one, Lucas.',
  'Good — thirty-five minutes is easy.',
  "I told you I'd make that Louisiana parishes document and then never actually did it. It's done now.",
  'That went about as well as last time... I suppose we could try the other door.',
  'You already know that. This is my voice, and I want it to be good, not just correct.',
];
const SR = 24000;
function readPcm(p) { const b = fs.readFileSync(p); return b.subarray(44); }
function writeWav(p, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(p, Buffer.concat([h, pcm]));
}
(async () => {
  const out = path.join(ROOT, 'data', 'voices', 'eval_2026-09-05');
  fs.mkdirSync(out, { recursive: true });
  const vk = require(path.join(ROOT, 'lib', 'voice_kokoro'));
  const voices = require(path.join(ROOT, 'lib', 'voices'));
  const recipe = voices.activeRecipe();
  console.log('recipe:', JSON.stringify(recipe && { weights: recipe.weights, speed: recipe.speed, lang: recipe.lang }));
  const made = [];
  for (let i = 0; i < LINES.length; i++) {
    const p = path.join(out, `kokoro_${String(i + 1).padStart(2, '0')}.wav`);
    const t0 = Date.now();
    const r = await vk.synthesize(LINES[i], recipe, { out: p, timeoutMs: 60000 });
    if (r && r.ok) { made.push(r.out || p); console.log(`[${i + 1}/${LINES.length}] ${path.basename(p)} ${((fs.statSync(r.out || p).size - 44) / 2 / SR).toFixed(2)}s in ${((Date.now() - t0) / 1000).toFixed(1)}s`); }
    else console.log(`[${i + 1}/${LINES.length}] FAILED: ${r && r.error}`);
  }
  if (made.length) {
    const gap = Buffer.alloc(Math.round(SR * 0.7) * 2);
    writeWav(path.join(out, 'kokoro_reel.wav'), Buffer.concat(made.flatMap((p) => [readPcm(p), gap])));
  }
  console.log(`done: ${made.length}/${LINES.length} · reel: kokoro_reel.wav`);
  process.exit(0);
})().catch((e) => { console.error('eval failed:', e.message); process.exit(1); });
