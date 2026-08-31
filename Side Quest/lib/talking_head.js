/**
 * lib/talking_head.js — Node wrapper over the local SadTalker sidecar (sidecar/talking_head/).
 *
 * PURPOSE (tiktok-avatar-tools Door 2): her photoreal performance organ. Takes the identity portrait
 * (data/avatars/zoe_ref.jpg) plus a voice WAV (lib/tts.js output) and renders a talking-head MP4 —
 * audio-driven lip-sync, blink, and head motion from a single still. OFFLINE by design: no real-time
 * constraint, so CPU render (minutes per clip) is acceptable; the engine flag exists so a faster/better
 * model (Sonic on ROCm) can slot in later without callers changing.
 *
 * Fail-soft everywhere, mirroring lib/tts.js: missing venv / missing weights / dead process / timeout all
 * resolve to { ok:false, error } — render never throws. And it never SAYS without DOING: ok:true means the
 * output file was found, moved into place, and ffprobe'd (via lib/video_compose.probe); the measured
 * { probe } rides the result for gates to judge.
 *
 * The pipeline seam: talking_head.render() → head MP4 → video_compose.compose() → 1080x1920 captioned
 * MP4. Each stage's output is a file on disk the next stage (and a human) can inspect.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SIDE = path.join(ROOT, 'sidecar', 'talking_head');
const REPO = path.join(SIDE, 'SadTalker');
const VENV_PY = path.join(SIDE, 'th_venv', 'Scripts', 'python.exe');
const OUT_DIR = path.join(ROOT, 'data', 'video_out');

const { probe } = require('./video_compose');

// Presence probe for the capability manifest: the door exists when the venv, the repo, and the main
// checkpoint are all on disk. Measured, never asserted.
function available() {
  try {
    return fs.existsSync(VENV_PY)
      && fs.existsSync(path.join(REPO, 'inference.py'))
      && fs.existsSync(path.join(REPO, 'checkpoints', 'SadTalker_V0.0.2_512.safetensors'));
  } catch { return false; }
}

/*
 * render(opts) → { ok:true, path, probe, tookMs } | { ok:false, error }
 *   image     — source portrait (default: her identity anchor data/avatars/zoe_ref.jpg)
 *   wav       — driving voice track (required)
 *   out       — output MP4 path (default data/video_out/head_<ts>.mp4)
 *   size      — 256 | 512 face resolution (default 512; 256 is ~4x faster for drafts)
 *   preprocess— 'full' keeps the whole portrait frame and animates the face in place (default — right
 *               for composition); 'crop' returns a tight face crop.
 *   still     — true (default) damps head wander; her delivery reads composed, not bobbly.
 *   enhance   — run GFPGAN on the face (sharper, adds significant CPU time). Default false.
 *   timeoutMs — default 45min; CPU diffusion-free but face-render is minutes per clip.
 */
function render(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (r) => resolve(Object.assign(r, { tookMs: Date.now() - started }));
    try {
      if (!available()) return done({ ok: false, error: 'talking_head sidecar not installed (venv/repo/weights)' });
      const image = o.image || path.join(ROOT, 'data', 'avatars', 'zoe_ref.jpg');
      if (!fs.existsSync(image)) return done({ ok: false, error: `image missing: ${image}` });
      if (!o.wav || !fs.existsSync(o.wav)) return done({ ok: false, error: `wav missing: ${o.wav}` });

      fs.mkdirSync(OUT_DIR, { recursive: true });
      const outPath = o.out || path.join(OUT_DIR, `head_${Date.now()}.mp4`);
      // SadTalker scatters results under result_dir/<run stamp>; give each render a private dir so
      // "find the newest mp4" cannot pick up a previous run's corpse.
      const workDir = path.join(SIDE, 'results', `run_${Date.now()}`);
      fs.mkdirSync(workDir, { recursive: true });

      const args = [
        path.join(REPO, 'inference.py'),
        '--driven_audio', path.resolve(o.wav),
        '--source_image', path.resolve(image),
        '--result_dir', workDir,
        '--size', String(o.size || 512),
        '--preprocess', o.preprocess || 'full',
        '--cpu',
      ];
      if (o.still !== false) args.push('--still');
      if (o.enhance) args.push('--enhancer', 'gfpgan');

      const child = spawn(VENV_PY, args, { cwd: REPO, windowsHide: true });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d; if (stderr.length > 65536) stderr = stderr.slice(-65536); });
      child.stdout.on('data', () => {}); // progress bars; the file on disk is the only truth we read

      const t = setTimeout(() => { try { child.kill(); } catch {} }, o.timeoutMs || 45 * 60000);
      child.on('error', e => { clearTimeout(t); done({ ok: false, error: `spawn failed: ${e.message}` }); });
      child.on('close', async (code) => {
        clearTimeout(t);
        try {
          // Find the produced mp4 anywhere under this run's private dir.
          const found = [];
          const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, f.name);
            if (f.isDirectory()) walk(p); else if (/\.mp4$/i.test(f.name)) found.push(p);
          } };
          walk(workDir);
          if (!found.length) {
            return done({ ok: false, error: `no output (exit ${code}): ${stderr.split('\n').filter(Boolean).slice(-4).join(' | ')}` });
          }
          fs.copyFileSync(found[0], outPath);
          fs.rmSync(workDir, { recursive: true, force: true });
          const p = await probe(outPath);
          if (!p || !(p.duration > 0)) return done({ ok: false, error: `output failed verification: ${JSON.stringify(p)}` });
          done({ ok: true, path: outPath, probe: p });
        } catch (e) { done({ ok: false, error: String(e && e.message || e) }); }
      });
    } catch (e) { done({ ok: false, error: String(e && e.message || e) }); }
  });
}

module.exports = { render, available };
