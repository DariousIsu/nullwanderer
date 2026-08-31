/**
 * studio/motion.js — the WHITE-LABEL MOTION LIBRARY.
 *
 * Upload any video of any person → extract their locomotion as a de-identified, reusable motion asset
 * (normalized skeleton trajectory + a skeleton-only preview clip; no source pixels kept). These assets
 * are white label by construction — they capture HOW a body moves, not WHO — so one library of motions
 * can improve ALL clones, Zoe, and any from-scratch avatar.
 *
 * This module owns extraction + the library (list/read/delete). APPLYING a motion to an avatar (driving
 * a render with it, e.g. Wan-Animate) is the next lane; the asset format here is what that lane consumes.
 *
 * Extraction runs on the MediaPipe sidecar (native Windows, CPU, no ROCm/GPU). Fail-soft throughout.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SIDE = path.join(ROOT, 'sidecar', 'motion');
const VENV_PY = path.join(SIDE, 'mo_venv', 'Scripts', 'python.exe');
const RUNNER = path.join(SIDE, 'extract_motion.py');
const LIB_DIR = path.join(ROOT, 'data', 'studio', 'motions');

function available() {
  try { return fs.existsSync(VENV_PY) && fs.existsSync(RUNNER); } catch { return false; }
}
function listMotions() {
  try {
    return fs.readdirSync(LIB_DIR)
      .filter(d => fs.existsSync(path.join(LIB_DIR, d, 'motion.json')))
      .map(d => readMotion(d)).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}
function readMotion(id) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(LIB_DIR, id, 'meta.json'), 'utf8'));
    return m;
  } catch { return null; }
}

/*
 * extract(videoPath, { name }) → { ok, motion } | { ok:false, error }
 * Produces data/studio/motions/<id>/motion.json (the reusable asset) + preview.mp4 (skeleton only).
 * The source video is NOT retained — only the de-identified motion. That is the white-label guarantee.
 */
function extract(videoPath, opts = {}) {
  return new Promise((resolve) => {
    try {
      if (!available()) return resolve({ ok: false, error: 'motion sidecar not installed' });
      if (!videoPath || !fs.existsSync(videoPath)) return resolve({ ok: false, error: `video missing: ${videoPath}` });
      const id = `motion_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const dir = path.join(LIB_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      const outJson = path.join(dir, 'motion.json');
      const outPreview = path.join(dir, 'preview.mp4');
      const req = JSON.stringify({ video: path.resolve(videoPath), out_json: outJson, out_preview: outPreview });
      execFile(VENV_PY, [RUNNER, req], { timeout: opts.timeoutMs || 600000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        let parsed = null;
        for (const line of String(stdout).trim().split('\n').reverse()) { try { parsed = JSON.parse(line); break; } catch { /* keep looking */ } }
        if (!parsed) return resolve({ ok: false, error: `no json from sidecar: ${String(stderr || stdout).slice(-300)}` });
        if (!parsed.ok) return resolve(parsed);
        const meta = {
          id, name: opts.name || 'unnamed motion', createdAt: Date.now(),
          frames: parsed.frames, fps: parsed.fps, identityStripped: true,
          motionFile: outJson, preview: outPreview, dir,
        };
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
        resolve({ ok: true, motion: meta });
      });
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

/*
 * extractFromUrl(url, { name }) — motion from a YouTube (or any yt-dlp-supported) URL. Downloads a
 * modest-resolution copy to a temp file, extracts the white-label motion, then DELETES the video —
 * only the de-identified skeleton is kept, never the copyrighted pixels. Uses yt-dlp from the motion
 * venv; ffmpeg-static is put on PATH for muxing. Operator uses footage they are entitled to reference.
 */
function extractFromUrl(url, opts = {}) {
  return new Promise((resolve) => {
    try {
      if (!available()) return resolve({ ok: false, error: 'motion sidecar not installed' });
      if (!/^https?:\/\//i.test(String(url || ''))) return resolve({ ok: false, error: 'a http(s) URL is required' });
      const ytdlp = path.join(SIDE, 'mo_venv', 'Scripts', 'yt-dlp.exe');
      if (!fs.existsSync(ytdlp)) return resolve({ ok: false, error: 'yt-dlp not installed in the motion venv' });
      const tmpDir = path.join(LIB_DIR, `_dl_${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      const outTpl = path.join(tmpDir, 'src.%(ext)s');
      let ffDir = '';
      try { ffDir = path.dirname(require('ffmpeg-static')); } catch { /* */ }
      const env = Object.assign({}, process.env, ffDir ? { PATH: ffDir + path.delimiter + (process.env.PATH || '') } : {});
      // cap at 480p to keep the temp file small (disk-friendly) — motion doesn't need resolution
      const args = ['-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]/best', '--no-playlist',
        '--ffmpeg-location', ffDir || '.', '-o', outTpl, url];
      execFile(ytdlp, args, { timeout: opts.timeoutMs || 600000, maxBuffer: 16 * 1024 * 1024, env }, async (err, stdout, stderr) => {
        try {
          const files = fs.readdirSync(tmpDir).filter(f => /^src\./.test(f)).map(f => path.join(tmpDir, f));
          if (!files.length) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
            return resolve({ ok: false, error: `download failed: ${String(stderr || err).split('\n').filter(Boolean).slice(-2).join(' | ').slice(-300)}` });
          }
          const r = await extract(files[0], { name: opts.name });
          fs.rmSync(tmpDir, { recursive: true, force: true }); // white-label: source video not retained
          resolve(r);
        } catch (e) { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} resolve({ ok: false, error: String(e.message || e) }); }
      });
    } catch (e) { resolve({ ok: false, error: String(e && e.message || e) }); }
  });
}

function remove(id) {
  try { fs.rmSync(path.join(LIB_DIR, id), { recursive: true, force: true }); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
}

module.exports = { available, extract, extractFromUrl, listMotions, readMotion, remove, LIB_DIR };
