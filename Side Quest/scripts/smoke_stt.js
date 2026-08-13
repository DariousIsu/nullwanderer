/* LIVE smoke: two-way voice INPUT — lib/stt.js + sidecar/stt_whisper.py (faster-whisper base int8, CPU).
 * NOT in the offline gate (loads real models + spins the GPU Kokoro sidecar to mint a known-phrase wav).
 * Proves the STT sidecar transcribes a real utterance end-to-end over the same NDJSON transport the app
 * uses, plus fail-soft on a missing file. TTS→STT round-trip = self-contained proof, no mic needed.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_stt.js   (or plain node) */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

(async () => {
  const tts = require('../lib/tts');
  const stt = require('../lib/stt');
  const PHRASE = 'The quick brown fox jumps over the lazy dog.';
  const KEYWORDS = ['quick', 'brown', 'fox', 'lazy', 'dog'];
  const tmpWav = path.join(os.tmpdir(), `zoe_stt_smoke_${process.pid}.wav`);
  let pass = 0, fail = 0;
  const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

  try {
    console.log('1) minting a known-phrase wav via the GPU Kokoro sidecar (cold ~15-20s)…');
    const synth = await tts.synthesize(PHRASE, { out: tmpWav, wallMs: 120000 });
    ok(synth && synth.ok && fs.existsSync(tmpWav), `TTS produced a wav (${synth && synth.sampleRate}Hz, ${synth && synth.bytes} bytes)`);
    if (!synth || !synth.ok) throw new Error('TTS failed: ' + (synth && synth.error));

    console.log('2) transcribing it back via the CPU faster-whisper sidecar (cold model load)…');
    const r = await stt.transcribe(tmpWav, { wallMs: 120000 });
    ok(r && r.ok, `STT returned ok (${r && r.ms}ms, lang=${r && r.lang})`);
    console.log('   transcript:', JSON.stringify(r && r.text));
    const low = ((r && r.text) || '').toLowerCase();
    const hits = KEYWORDS.filter((k) => low.includes(k));
    ok(hits.length >= 3, `transcript recovers ≥3 known keywords (${hits.length}/${KEYWORDS.length}: ${hits.join(', ')})`);

    console.log('3) fail-soft on a missing input…');
    const miss = await stt.transcribe(path.join(os.tmpdir(), `zoe_stt_nope_${process.pid}.wav`), { wallMs: 15000 });
    ok(miss && miss.ok === false, 'missing input → { ok:false }, no throw');
  } catch (e) {
    fail++; console.log('  ✗ threw:', e.message);
  } finally {
    try { fs.unlinkSync(tmpWav); } catch {}
    try { tts.shutdownTts(); } catch {}
    try { stt.shutdownStt(); } catch {}
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
