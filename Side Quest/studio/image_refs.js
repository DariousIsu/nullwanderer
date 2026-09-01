/**
 * studio/image_refs.js — ad-hoc reference inputs for the image suite.
 *
 * Turn a reference into an image the generator can condition on (via IPAdapter): a photo (used as-is),
 * a video/clip (a representative frame), or a YouTube/any URL (downloaded at low res, one frame, video
 * discarded). These references steer a generation toward a look the operator supplies — the perchance-
 * style "upload references" that was missing. Stored at data/studio/image_refs/. Fail-soft throughout.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REF_DIR = path.join(ROOT, 'data', 'studio', 'image_refs');
const YTDLP = path.join(ROOT, 'sidecar', 'motion', 'mo_venv', 'Scripts', 'yt-dlp.exe');

function bins() {
  try { return { ffmpeg: require('ffmpeg-static') }; } catch { return null; }
}
function run(bin, args, ms) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: ms || 300000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, so, se) => resolve({ err, stderr: String(se || '') }));
  });
}

function list() {
  try {
    return fs.readdirSync(REF_DIR).filter(f => /\.png$/i.test(f))
      .map(f => ({ id: f.replace(/\.png$/i, ''), file: path.join(REF_DIR, f), createdAt: fs.statSync(path.join(REF_DIR, f)).mtimeMs }))
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}
function refPath(id) { const p = path.join(REF_DIR, `${id}.png`); return fs.existsSync(p) ? p : null; }
function remove(id) { try { fs.unlinkSync(path.join(REF_DIR, `${id}.png`)); return { ok: true }; } catch (e) { return { ok: false, error: String(e.message || e) }; } }

// a photo → copy in as a PNG reference
async function fromImage(srcPath, label) {
  const b = bins(); if (!b) return { ok: false, error: 'ffmpeg missing' };
  fs.mkdirSync(REF_DIR, { recursive: true });
  const id = `${(label || 'ref').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'ref'}_${Date.now()}`;
  const out = path.join(REF_DIR, `${id}.png`);
  const r = await run(b.ffmpeg, ['-y', '-v', 'error', '-i', srcPath, out], 60000);
  if (r.err || !fs.existsSync(out)) return { ok: false, error: 'image import failed' };
  return { ok: true, id, file: out };
}

// a video/clip on disk → its most representative frame
async function fromVideo(srcPath, label) {
  const b = bins(); if (!b) return { ok: false, error: 'ffmpeg missing' };
  fs.mkdirSync(REF_DIR, { recursive: true });
  const id = `${(label || 'clip').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'clip'}_${Date.now()}`;
  const out = path.join(REF_DIR, `${id}.png`);
  const r = await run(b.ffmpeg, ['-y', '-v', 'error', '-i', srcPath, '-vf', 'thumbnail=n=100', '-frames:v', '1', out], 180000);
  if (r.err || !fs.existsSync(out)) return { ok: false, error: 'frame extract failed' };
  return { ok: true, id, file: out };
}

// a URL (YouTube etc.) → download low-res, one frame, discard the video (keep only the reference frame)
async function fromUrl(url, label) {
  if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'a http(s) URL is required' };
  if (!fs.existsSync(YTDLP)) return { ok: false, error: 'yt-dlp not installed (motion venv)' };
  const b = bins();
  fs.mkdirSync(REF_DIR, { recursive: true });
  const tmp = path.join(REF_DIR, `_dl_${Date.now()}`); fs.mkdirSync(tmp, { recursive: true });
  const ffDir = b ? path.dirname(require('ffmpeg-static')) : '.';
  const env = Object.assign({}, process.env, { PATH: ffDir + path.delimiter + (process.env.PATH || '') });
  const r = await new Promise((resolve) => {
    execFile(YTDLP, ['-f', 'bestvideo[height<=480]+bestaudio/best[height<=480]/best', '--no-playlist',
      '--ffmpeg-location', ffDir, '-o', path.join(tmp, 'src.%(ext)s'), url],
      { timeout: 300000, maxBuffer: 16 * 1024 * 1024, env, windowsHide: true },
      (err, so, se) => resolve({ err, stderr: String(se || '') }));
  });
  try {
    const f = fs.readdirSync(tmp).filter(x => /^src\./.test(x)).map(x => path.join(tmp, x))[0];
    if (!f) { fs.rmSync(tmp, { recursive: true, force: true }); return { ok: false, error: `download failed: ${r.stderr.split('\n').filter(Boolean).slice(-1)[0] || ''}`.slice(0, 200) }; }
    const res = await fromVideo(f, label || 'url');
    fs.rmSync(tmp, { recursive: true, force: true });
    return res;
  } catch (e) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} return { ok: false, error: String(e.message || e) }; }
}

module.exports = { list, refPath, remove, fromImage, fromVideo, fromUrl, REF_DIR };
