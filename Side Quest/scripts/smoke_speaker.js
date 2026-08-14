/* Smoke: lib/speaker — the SPEAKER-ID voice gate for two-way voice. Two halves:
 *  (A) OFFLINE policy (always runs, no sidecar/model): cosine + centroid math, and the two fail-OPEN /
 *      pass-through branches that must NEVER call the model (gate disabled, not-enrolled) → match:true.
 *  (B) LIVE (only if sidecar/spk_venv + CAM++ model + data/tts fixtures exist): enroll one voice from 3
 *      clips, ACCEPT a held-out clip of the SAME voice, REJECT a clearly different voice, fail-open on a
 *      missing file. Skips gracefully (never fails the gate) when prerequisites are absent.
 * Uses an isolated ZOE_SPEAKER_STORE temp file — never touches the real operator voiceprint.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_speaker.js   (or plain node) */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_STORE = path.join(os.tmpdir(), `sq_spk_smoke_${process.pid}.json`);
process.env.ZOE_SPEAKER_STORE = TMP_STORE;          // isolate BEFORE require (STORE is captured at load)
const spk = require('../lib/speaker');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  try {
    // ===== (A) OFFLINE policy — no sidecar, no model =====
    console.log('A) offline policy math + pass-through branches');
    // cosine
    ok(Math.abs(spk._cosine([1, 0, 0], [1, 0, 0]) - 1) < 1e-6, 'cosine(identical)=1');
    ok(Math.abs(spk._cosine([1, 0], [0, 1])) < 1e-6, 'cosine(orthogonal)=0');
    ok(spk._cosine([1, 0], [1, 0]) > spk._cosine([1, 0], [1, 1]), 'cosine ranks aligned > half-aligned');
    // centroid of two unit vectors is their normalized mean
    const c = spk._centroid([{ emb: [1, 0] }, { emb: [0, 1] }]);
    ok(c && Math.abs(c[0] - c[1]) < 1e-6 && Math.abs(Math.hypot(c[0], c[1]) - 1) < 1e-6, 'centroid = normalized mean');

    // gate DISABLED → always admit, WITHOUT touching the model (would be a no-op even with no venv)
    process.env.ZOE_SPEAKER_GATE = '0';
    let v = await spk.verify('C:/nonexistent/never.wav');
    ok(v && v.match === true && v.gate === false, 'gate disabled → match:true (no model call)');

    // gate ENABLED but NOT enrolled → pass-through admit (app works until he enrolls)
    process.env.ZOE_SPEAKER_GATE = '1';
    try { fs.unlinkSync(TMP_STORE); } catch {}
    v = await spk.verify('C:/nonexistent/never.wav');
    ok(v && v.match === true && v.enrolled === false, 'enabled + not-enrolled → pass-through match:true');
    const st0 = spk.status();
    ok(st0 && st0.enrolled === false && st0.count === 0, 'status: not enrolled, count 0');

    // ===== (B) LIVE — enroll + accept/reject, only if prerequisites exist =====
    const TTS = path.join(__dirname, '..', 'data', 'tts');
    const OP = ['cmp_jenny.wav', 'tts_1783467325554_59084_0.wav', 'v1_proof.wav'];   // same voice (operator)
    const POS = 'tts_1783467412545_59084_2.wav';                                     // held-out, SAME voice
    const NEG = 'cmp_amy.wav';                                                       // clearly DIFFERENT voice
    const have = fs.existsSync(spk.VENV_PY) && fs.existsSync(process.env.ZOE_SPEAKER_MODEL || path.join(__dirname, '..', 'data', 'voices', 'models', '3dspeaker_campplus_en.onnx'))
      && [...OP, POS, NEG].every((f) => fs.existsSync(path.join(TTS, f)));
    if (!have) {
      console.log('B) LIVE section SKIPPED — spk_venv / CAM++ model / data/tts fixtures not all present (offline clone).');
    } else {
      console.log('B) live enroll + accept/reject (spins the speaker sidecar; cold model load ~1-2s)');
      for (const f of OP) { const e = await spk.enroll(path.join(TTS, f)); ok(e && e.ok, `enroll ${f} (count=${e && e.count})`); }
      const st = spk.status();
      ok(st.enrolled === true && st.count === 3 && st.dim === 512, `status: enrolled, 3 samples, dim ${st.dim}`);

      const vp = await spk.verify(path.join(TTS, POS));
      ok(vp && vp.ok && vp.match === true, `ACCEPT held-out SAME voice (score ${vp && vp.score} >= thr ${vp && vp.threshold})`);

      const vn = await spk.verify(path.join(TTS, NEG));
      ok(vn && vn.ok && vn.match === false, `REJECT different voice (score ${vn && vn.score} < thr ${vn && vn.threshold})`);

      ok(vp.score - vn.score > 0.15, `clean margin between same/different (${(vp.score - vn.score).toFixed(3)})`);

      // fail-OPEN: a broken input must ADMIT (never deafen her on a sidecar hiccup), flagged failOpen
      const vf = await spk.verify(path.join(TTS, `__nope_${process.pid}.wav`));
      ok(vf && vf.match === true && vf.failOpen === true, 'fail-open: bad input → match:true (flagged)');
    }
  } catch (e) {
    fail++; console.log('  ✗ threw:', e.message);
  } finally {
    try { spk.shutdownSpeaker(); } catch {}
    try { fs.unlinkSync(TMP_STORE); } catch {}
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
