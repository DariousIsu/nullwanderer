/**
 * lib/photo_grab.js — download an official headshot to a local file (the reference image the later
 * face-matching stage compares social avatars against). Fail-soft: validates it's an image + under a size
 * cap, never throws. Node http/https (works in Electron's main). Consume-only: just fetches + writes.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const MAX_BYTES = 5 * 1024 * 1024;   // 5MB — a headshot is small; bigger is suspect (skip)

// downloadPhoto(url, destPath) → { ok, path, bytes } | { ok:false, error }. Never throws.
function downloadPhoto(url, destPath, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const u = new URL(String(url));
      const lib = u.protocol === 'http:' ? http : https;
      try { fs.mkdirSync(path.dirname(destPath), { recursive: true }); } catch {}
      const req = lib.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return finish({ ok: false, error: `http ${res.statusCode}` }); }
        const ct = String(res.headers['content-type'] || '');
        if (!/^image\//i.test(ct)) { res.resume(); return finish({ ok: false, error: `not an image (${ct})` }); }
        const chunks = []; let n = 0;
        res.on('data', (d) => { n += d.length; if (n > MAX_BYTES) { try { req.destroy(); } catch {} return finish({ ok: false, error: 'too large' }); } chunks.push(d); });
        res.on('end', () => { try { fs.writeFileSync(destPath, Buffer.concat(chunks)); finish({ ok: true, path: destPath, bytes: n }); } catch (e) { finish({ ok: false, error: e.message }); } });
      });
      req.on('error', (e) => finish({ ok: false, error: e.message }));
      req.on('timeout', () => { try { req.destroy(); } catch {} finish({ ok: false, error: 'timeout' }); });
    } catch (e) { finish({ ok: false, error: e.message }); }
  });
}

module.exports = { downloadPhoto, MAX_BYTES };
