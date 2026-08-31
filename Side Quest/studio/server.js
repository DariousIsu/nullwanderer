/**
 * studio/server.js — the production Studio: a local console for the script→video pipeline.
 * Plain node http, no dependencies. Serves the UI, a small jobs API, and job artifacts (with Range
 * support so the video player can seek). The runner ticks in-process every 5s.
 *
 *   node studio/server.js        → http://127.0.0.1:8790
 *
 * File serving is restricted to the jobs directory and data/video_out — the Studio shows its own
 * work products, it is not a general file server.
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const runner = require('./runner');
const cloner = require('./cloner');
const motion = require('./motion');
const charVoices = require('./char_voices');
const images = require('./images');
const voiceKokoro = require(path.join(__dirname, '..', 'lib', 'voice_kokoro'));

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.ZOE_STUDIO_PORT || '8790', 10);
const UPLOAD_DIR = path.join(ROOT, 'data', 'studio', 'uploads');
const ALLOWED = [runner.JOBS_DIR, cloner.PERSONAS_DIR, motion.LIB_DIR, images.IMG_DIR, path.join(ROOT, 'data', 'video_out'), path.join(ROOT, 'data', 'avatars')];

const MIME = { '.html': 'text/html', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

function safePath(p) {
  const abs = path.resolve(p);
  return ALLOWED.some(dir => abs.startsWith(dir + path.sep) || abs === dir) ? abs : null;
}

function serveFile(req, res, abs) {
  const stat = fs.statSync(abs);
  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? parseInt(range[1], 10) : 0;
    const end = range[2] ? parseInt(range[2], 10) : stat.size - 1;
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1,
    });
    fs.createReadStream(abs, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
    fs.createReadStream(abs).pipe(res);
  }
}

function body(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve(null); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://x`);
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (req.method === 'GET' && u.pathname === '/api/jobs') {
      return json(res, 200, runner.listJobs().map(j => ({
        id: j.id, title: j.title, status: j.status, createdAt: j.createdAt,
        personaName: j.personaName || 'Zoe', postEligible: j.postEligible !== false,
        segments: (j.segments || []).map(s => ({ kind: s.kind, dur: s.dur, done: !!s.take || s.kind !== 'avatar', queued: !!s.promptId })),
        cut: j.cut || null,
      })));
    }
    const mJob = u.pathname.match(/^\/api\/jobs\/([\w.-]+)$/);
    if (req.method === 'GET' && mJob) {
      const j = runner.readJob(mJob[1]);
      return j ? json(res, 200, j) : json(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && u.pathname === '/api/jobs') {
      const b = await body(req);
      if (!b || (!b.script && !b.timeline)) return json(res, 400, { error: 'script or timeline required' });
      // a job may name a persona (a clone) instead of a raw image path; the persona carries its
      // pose set, voice, and post-eligibility into the job.
      if (b.personaId) {
        const p = cloner.readPersona(b.personaId);
        if (!p) return json(res, 400, { error: 'no such persona' });
        b.persona = p;
      }
      const job = runner.createJob(b);
      return json(res, 200, { id: job.id, status: job.status });
    }

    // --- avatars: the unified roster (Zoe default + clones + generated) ---
    if (req.method === 'GET' && u.pathname === '/api/avatars') {
      const roster = [{
        id: '', name: 'Zoe', type: 'default', postEligible: true,
        thumb: path.join(ROOT, 'data', 'avatars', 'zoe_ref.jpg'),
      }];
      for (const p of cloner.listPersonas()) {
        roster.push({
          id: p.id, name: p.name, type: p.origin === 'generated' ? 'generated' : 'clone',
          postEligible: !!p.postEligible, thumb: p.refImage,
          poses: (p.poses || []).length, voiceStatus: p.voiceStatus || '',
        });
      }
      return json(res, 200, roster);
    }

    // --- personas (the cloner) ---
    if (req.method === 'GET' && u.pathname === '/api/personas') {
      return json(res, 200, cloner.listPersonas().map(p => ({
        id: p.id, name: p.name, createdAt: p.createdAt, refBasename: p.refBasename,
        candidates: p.candidates, voiceStatus: p.voiceStatus, attestedBy: p.attestedBy, consent: p.consent,
        dir: path.join(cloner.PERSONAS_DIR, p.id),
      })));
    }
    if (req.method === 'POST' && u.pathname === '/api/personas') {
      // raw streamed video upload (no multipart dep); metadata rides in the query string
      const name = u.searchParams.get('name') || 'unnamed clone';
      const consent = u.searchParams.get('consent') || '';
      const attestedBy = u.searchParams.get('by') || 'operator';
      if (!consent.trim()) return json(res, 400, { error: 'consent attestation required' });
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const ext = (u.searchParams.get('ext') || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
      const dst = path.join(UPLOAD_DIR, `up_${Date.now()}.${ext}`);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dst); let size = 0;
        req.on('data', d => { size += d.length; if (size > 800 * 1024 * 1024) { req.destroy(); reject(new Error('upload too large (>800MB)')); } });
        req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
      }).catch(e => { throw e; });
      const r = await cloner.createPersona({ videoPath: dst, name, consent, attestedBy });
      return json(res, r.ok ? 200 : 400, r.ok ? { id: r.persona.id } : { error: r.error });
    }
    const mRef = u.pathname.match(/^\/api\/personas\/([\w.-]+)\/ref$/);
    if (req.method === 'POST' && mRef) {
      const b = await body(req);
      return json(res, 200, cloner.setRef(mRef[1], b && b.basename));
    }
    // available voices from the program's own generator (no clone needed) — for the persona voice picker
    if (req.method === 'GET' && u.pathname === '/api/voices') {
      let voices = [];
      try {
        const V = require(path.join(ROOT, 'lib', 'voices'));
        voices = (V.list() || []).map(v => ({
          id: v.id, name: v.name, engine: v.engine, kind: v.kind || '',
          // piper voices synth via their onnx path; the kokoro blend (Zoe) is the default, no path needed
          path: v.engine === 'piper' ? path.join(ROOT, 'data', 'voices', v.id + '.onnx') : null,
        })).filter(v => v.engine !== 'piper' || fs.existsSync(v.path));
      } catch (e) { return json(res, 200, []); }
      // tuned character voices (Kokoro blends from the tuner) join the picker
      for (const cv of charVoices.list()) voices.push({ id: cv.id, name: '★ ' + cv.name, engine: 'kokoro', kind: 'tuned', path: null });
      return json(res, 200, voices);
    }
    const mVoice = u.pathname.match(/^\/api\/personas\/([\w.-]+)\/voice$/);
    if (req.method === 'POST' && mVoice) {
      const b = await body(req);
      if (b && b.characterVoiceId) {
        const cv = charVoices.get(b.characterVoiceId);
        if (!cv) return json(res, 400, { error: 'no such character voice' });
        return json(res, 200, cloner.setVoice(mVoice[1], { engine: 'kokoro', recipe: { weights: cv.weights, lang: cv.lang, speed: cv.speed }, voiceId: cv.id, voiceName: cv.name }));
      }
      if (b && b.voicePath) return json(res, 200, cloner.setVoice(mVoice[1], { engine: 'existing', voice: b.voicePath, voiceId: b.voiceId }));
      return json(res, 200, cloner.setVoice(mVoice[1], null)); // clear → default
    }
    // character voices (tuner recipes)
    if (req.method === 'GET' && u.pathname === '/api/character_voices') return json(res, 200, charVoices.list());
    if (req.method === 'POST' && u.pathname === '/api/character_voices') {
      const b = await body(req);
      return json(res, 200, charVoices.add(b || {}));
    }
    const mCvDel = u.pathname.match(/^\/api\/character_voices\/([\w.-]+)$/);
    if (req.method === 'DELETE' && mCvDel) return json(res, 200, charVoices.remove(mCvDel[1]));
    if (req.method === 'GET' && u.pathname === '/api/tuner/status') {
      return json(res, 200, { up: await voiceKokoro.available(), url: voiceKokoro.BASE });
    }
    // live render progress: the newest ComfyUI sampling line + queue depth (for the in-flight segment)
    if (req.method === 'GET' && u.pathname === '/api/comfy/progress') {
      const out = { up: false, pct: null, label: null, running: 0, pending: 0 };
      try {
        const q = await (await fetch('http://127.0.0.1:8288/queue', { signal: AbortSignal.timeout(3000) })).json();
        out.up = true; out.running = (q.queue_running || []).length; out.pending = (q.queue_pending || []).length;
      } catch { /* comfy down */ }
      try {
        const log = fs.readFileSync('C:\\Users\\azrae\\Desktop\\ComfyUI-Zluda\\rocm_server.log', 'utf8');
        const lines = log.replace(/\r/g, '\n').split('\n');
        for (let i = lines.length - 1; i >= 0 && i > lines.length - 400; i--) {
          const m = /Sampling audio indices ([\d-]+):\s+(\d+)%/.exec(lines[i]);
          if (m) { out.pct = parseInt(m[2], 10); out.label = `window ${m[1]}`; break; }
        }
      } catch { /* no log */ }
      return json(res, 200, out);
    }
    const mPose = u.pathname.match(/^\/api\/personas\/([\w.-]+)\/pose$/);
    if (req.method === 'POST' && mPose) {
      const b = await body(req);
      return json(res, 200, cloner.togglePose(mPose[1], b && b.basename));
    }
    const mAdd = u.pathname.match(/^\/api\/personas\/([\w.-]+)\/source$/);
    if (req.method === 'POST' && mAdd) {
      // stream another video/photo into this clone (more angles → richer pose library + voice corpus)
      const ext = (u.searchParams.get('ext') || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const dst = path.join(UPLOAD_DIR, `add_${Date.now()}.${ext}`);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dst); let size = 0;
        req.on('data', d => { size += d.length; if (size > 800 * 1024 * 1024) { req.destroy(); reject(new Error('upload too large')); } });
        req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
      });
      return json(res, 200, await cloner.addSource(mAdd[1], dst));
    }
    const mPersona = u.pathname.match(/^\/api\/personas\/([\w.-]+)$/);
    if (req.method === 'GET' && mPersona) {
      const p = cloner.readPersona(mPersona[1]);
      return p ? json(res, 200, p) : json(res, 404, { error: 'not found' });
    }
    const mDec = u.pathname.match(/^\/api\/jobs\/([\w.-]+)\/decide$/);
    if (req.method === 'POST' && mDec) {
      const b = await body(req);
      return json(res, 200, runner.decide(mDec[1], b && b.verdict));
    }
    // --- motion library (white-label locomotion) ---
    if (req.method === 'GET' && u.pathname === '/api/motions') {
      return json(res, 200, motion.listMotions().map(m => ({
        id: m.id, name: m.name, createdAt: m.createdAt, frames: m.frames, fps: m.fps,
        preview: m.preview, dir: m.dir, identityStripped: m.identityStripped,
      })));
    }
    if (req.method === 'POST' && u.pathname === '/api/motions') {
      const name = u.searchParams.get('name') || 'unnamed motion';
      const url = u.searchParams.get('url');
      if (url) {
        // YouTube (or any yt-dlp URL): download → extract motion → delete the video (keep only the skeleton)
        const r = await motion.extractFromUrl(url, { name });
        return json(res, r.ok ? 200 : 400, r.ok ? { id: r.motion.id } : { error: r.error });
      }
      // raw uploaded video → extract → keep only the motion asset
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const ext = (u.searchParams.get('ext') || 'mp4').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp4';
      const dst = path.join(UPLOAD_DIR, `mo_${Date.now()}.${ext}`);
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dst); let size = 0;
        req.on('data', d => { size += d.length; if (size > 800 * 1024 * 1024) { req.destroy(); reject(new Error('too large')); } });
        req.pipe(ws); ws.on('finish', resolve); ws.on('error', reject); req.on('error', reject);
      });
      const r = await motion.extract(dst, { name });
      try { fs.unlinkSync(dst); } catch { /* white-label: source not retained */ }
      return json(res, r.ok ? 200 : 400, r.ok ? { id: r.motion.id } : { error: r.error });
    }
    const mMoDel = u.pathname.match(/^\/api\/motions\/([\w.-]+)$/);
    if (req.method === 'DELETE' && mMoDel) return json(res, 200, motion.remove(mMoDel[1]));

    // --- image suite: persona / scenery / scene creators (SDXL) ---
    if (u.pathname === '/image' || u.pathname === '/image.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(fs.readFileSync(path.join(__dirname, 'image.html')));
    }
    if (req.method === 'GET' && u.pathname === '/api/images') {
      return json(res, 200, images.listImages());
    }
    if (req.method === 'POST' && u.pathname === '/api/images') {
      const b = await body(req);
      if (!b || !b.prompt) return json(res, 400, { error: 'prompt required' });
      const r = await images.create(b);
      return json(res, r.ok ? 200 : 400, r.ok ? r.image : { error: r.error });
    }
    const mImgSave = u.pathname.match(/^\/api\/images\/([\w.-]+)\/save_avatar$/);
    if (req.method === 'POST' && mImgSave) {
      const b = await body(req);
      return json(res, 200, images.saveAsAvatar(mImgSave[1], b && b.name));
    }
    const mImgDel = u.pathname.match(/^\/api\/images\/([\w.-]+)$/);
    if (req.method === 'DELETE' && mImgDel) return json(res, 200, images.remove(mImgDel[1]));

    if (req.method === 'GET' && u.pathname === '/file') {
      const abs = safePath(u.searchParams.get('path') || '');
      if (!abs || !fs.existsSync(abs)) return json(res, 404, { error: 'not found or not allowed' });
      return serveFile(req, res, abs);
    }
    json(res, 404, { error: 'no route' });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
});

setInterval(() => { runner.tick().catch(() => {}); }, 5000);
server.listen(PORT, '127.0.0.1', () => console.log(`Studio up: http://127.0.0.1:${PORT}`));
