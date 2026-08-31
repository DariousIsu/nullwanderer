/**
 * studio/cloner.js — build a PERSONA (a reusable clone identity) from an uploaded real video.
 *
 * A persona is just a reference image (+ an optional captured voice sample) that the take pipeline
 * drives exactly like it drives zoe_ref.jpg — so "cloning" reuses the whole existing engine; this
 * module only turns a video into a good, front-facing reference frame and files the identity.
 *
 * CONSENT IS STRUCTURAL. createPersona refuses without an explicit consent attestation string —
 * likeness cloning requires the depicted person's consent, and the attestation is stored with the
 * persona (who attested, when). This is not a UI nicety; the function will not mint a persona without
 * it. Everything a persona produces still halts at the review gate — nothing auto-posts.
 *
 * Fail-soft: bad video / no face frame / ffmpeg failure → { ok:false, error }, never a throw.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PERSONAS_DIR = path.join(ROOT, 'data', 'studio', 'personas');
const { probe } = require(path.join(ROOT, 'lib', 'video_compose'));

function bins() {
  try { return { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path }; }
  catch { return null; }
}
function run(bin, args, ms) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: ms || 180000, maxBuffer: 16 * 1024 * 1024 }, (err, so, se) =>
      resolve({ err, stderr: String(se || '') }));
  });
}

function listPersonas() {
  try {
    return fs.readdirSync(PERSONAS_DIR)
      .filter(d => fs.existsSync(path.join(PERSONAS_DIR, d, 'persona.json')))
      .map(d => readPersona(d)).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}
function readPersona(id) {
  try { return JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR, id, 'persona.json'), 'utf8')); }
  catch { return null; }
}
function savePersona(p) {
  fs.mkdirSync(path.join(PERSONAS_DIR, p.id), { recursive: true });
  fs.writeFileSync(path.join(PERSONAS_DIR, p.id, 'persona.json'), JSON.stringify(p, null, 1));
}

/*
 * createPersona({ videoPath, name, consent, attestedBy })
 *   videoPath  — a real video already written to disk (the server streams the upload there first)
 *   consent    — REQUIRED non-empty attestation that the depicted person consents to this use
 *   → { ok:true, persona } | { ok:false, error }
 *
 * Extracts: a representative front reference frame (ref.png, full res), up to 4 evenly-spaced
 * alternates the operator can switch to, and — if the video carries audio — a mono voice sample
 * (voice cloning itself is a SEPARATE lane; the sample is captured, not yet a synthesizable voice).
 */
async function createPersona({ videoPath, name, consent, attestedBy }) {
  try {
    const b = bins();
    if (!b) return { ok: false, error: 'ffmpeg-static not installed' };
    if (!videoPath || !fs.existsSync(videoPath)) return { ok: false, error: `video missing: ${videoPath}` };
    if (!consent || !String(consent).trim()) {
      return { ok: false, error: 'consent attestation required — a persona cannot be created without confirming the depicted person consents to this use' };
    }
    const p = await probe(videoPath);
    if (!p || !(p.duration > 0)) return { ok: false, error: 'unreadable video' };

    const id = `persona_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const dir = path.join(PERSONAS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });

    // representative frame — ffmpeg's thumbnail filter scores a batch and returns the most typical
    const ref = path.join(dir, 'ref.png');
    let r = await run(b.ffmpeg, ['-y', '-v', 'error', '-i', videoPath, '-vf', 'thumbnail=n=200', '-frames:v', '1', ref], 180000);
    if (r.err || !fs.existsSync(ref)) return { ok: false, error: `frame extract failed: ${r.stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}` };

    // evenly-spaced alternates for the operator to pick from
    const candidates = [];
    const N = 4, step = p.duration / (N + 1);
    for (let i = 1; i <= N; i++) {
      const c = path.join(dir, `cand_${i}.png`);
      const rr = await run(b.ffmpeg, ['-y', '-v', 'error', '-ss', String(step * i), '-i', videoPath, '-frames:v', '1', c], 60000);
      if (!rr.err && fs.existsSync(c)) candidates.push(`cand_${i}.png`);
    }

    // capture the voice sample if audio is present (voice cloning is a separate lane; this is capture only)
    let voiceSample = null;
    if (p.hasAudio) {
      const vs = path.join(dir, 'voice_sample.wav');
      const rr = await run(b.ffmpeg, ['-y', '-v', 'error', '-i', videoPath, '-vn', '-ac', '1', '-ar', '24000', '-t', '30', vs], 120000);
      if (!rr.err && fs.existsSync(vs)) voiceSample = 'voice_sample.wav';
    }

    // keep the source video beside the persona for provenance / re-extraction
    const srcName = 'source' + (path.extname(videoPath) || '.mp4');
    try { fs.copyFileSync(videoPath, path.join(dir, srcName)); } catch { /* non-fatal */ }

    const persona = {
      id, name: name || 'unnamed clone', createdAt: Date.now(),
      consent: String(consent).trim(), attestedBy: attestedBy || 'operator', attestedAt: Date.now(),
      // A cloner persona is a 1:1 likeness of a real person. Privacy rule (operator policy):
      // 1:1 clones are NEVER eligible for posting — their output is download-only, handed to the
      // depicted person. The posting door (future) must refuse any job whose persona is post-ineligible.
      oneToOne: true, postEligible: false,
      sources: [srcName], sourceVideo: srcName,
      refImage: ref, refBasename: 'ref.png',
      // the POSE LIBRARY: reference frames usable to render this clone. Starts with the primary; the
      // operator promotes candidates / adds more media (photos at different angles) for multi-pose cuts.
      poses: ['ref.png'], candidates,
      voiceSamples: voiceSample ? [voiceSample] : [], voiceSample,
      voice: null, // set once the voice-clone engine is trained/registered for this persona
      voiceStatus: voiceSample ? 'sample captured — voice clone not yet built' : 'no audio in source',
      sourceDuration: p.duration,
    };
    savePersona(persona);
    return { ok: true, persona };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

// switch a persona's PRIMARY reference (used for single-pose jobs and as pose[0])
function setRef(id, basename) {
  const p = readPersona(id);
  if (!p) return { ok: false, error: 'no such persona' };
  const known = new Set(['ref.png', ...(p.candidates || []), ...(p.poses || [])]);
  if (!known.has(basename) || !fs.existsSync(path.join(PERSONAS_DIR, id, basename)))
    return { ok: false, error: 'not a frame of this persona' };
  p.refImage = path.join(PERSONAS_DIR, id, basename); p.refBasename = basename;
  if (!(p.poses || []).includes(basename)) p.poses = [basename, ...(p.poses || [])];
  savePersona(p);
  return { ok: true, refImage: p.refImage };
}

// toggle a frame in/out of the multi-pose set (the frames a job rotates through for pose variety)
function togglePose(id, basename) {
  const p = readPersona(id);
  if (!p) return { ok: false, error: 'no such persona' };
  if (!fs.existsSync(path.join(PERSONAS_DIR, id, basename))) return { ok: false, error: 'no such frame' };
  p.poses = p.poses || [];
  if (p.poses.includes(basename)) p.poses = p.poses.filter(x => x !== basename);
  else p.poses.push(basename);
  if (!p.poses.length) p.poses = [p.refBasename || 'ref.png']; // never empty
  savePersona(p);
  return { ok: true, poses: p.poses };
}

/*
 * addSource(id, filePath) — grow a persona's identity from MORE media: a video (frames extracted and
 * added as candidates) or a photo (added directly as a pose). This is how "photos at all angles +
 * hours of video" become a rich pose library and a longer voice corpus for one clone.
 */
async function addSource(id, filePath) {
  try {
    const p = readPersona(id);
    if (!p) return { ok: false, error: 'no such persona' };
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'file missing' };
    const b = bins();
    const dir = path.join(PERSONAS_DIR, id);
    const ext = (path.extname(filePath) || '').toLowerCase();
    const stamp = Date.now();
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      const name = `pose_${stamp}.png`;
      await run(b.ffmpeg, ['-y', '-v', 'error', '-i', filePath, path.join(dir, name)], 30000);
      p.candidates = [...(p.candidates || []), name];
      p.poses = [...new Set([...(p.poses || []), name])]; // photos join the pose set by default
      p.sources = [...(p.sources || []), name];
      savePersona(p);
      return { ok: true, added: name, kind: 'photo' };
    }
    // video: pull a few evenly-spaced frames as new candidates, extend the voice corpus
    const pr = await probe(filePath);
    if (!pr || !(pr.duration > 0)) return { ok: false, error: 'unreadable video' };
    const added = [];
    for (let i = 1; i <= 4; i++) {
      const name = `cand_${stamp}_${i}.png`;
      const rr = await run(b.ffmpeg, ['-y', '-v', 'error', '-ss', String((pr.duration / 5) * i), '-i', filePath, '-frames:v', '1', path.join(dir, name)], 60000);
      if (!rr.err && fs.existsSync(path.join(dir, name))) added.push(name);
    }
    p.candidates = [...(p.candidates || []), ...added];
    if (pr.hasAudio) {
      const vs = `voice_${stamp}.wav`;
      const rr = await run(b.ffmpeg, ['-y', '-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', '24000', vs === '' ? '' : path.join(dir, vs)], 180000);
      if (!rr.err && fs.existsSync(path.join(dir, vs))) p.voiceSamples = [...(p.voiceSamples || []), vs];
    }
    p.sources = [...(p.sources || []), path.basename(filePath)];
    savePersona(p);
    return { ok: true, added, kind: 'video' };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/*
 * buildVoice(id) — turn a persona's captured audio into a zero-shot clone voice. Trims a clean ~12s
 * reference from the longest voice sample and sets persona.voice = { engine:'f5', refAudio }. The clone
 * then speaks any script in that voice via lib/voice_clone. No training, no WSL — reference-driven.
 */
async function buildVoice(id) {
  try {
    const p = readPersona(id);
    if (!p) return { ok: false, error: 'no such persona' };
    const samples = (p.voiceSamples || []).map(s => path.join(PERSONAS_DIR, id, s)).filter(fs.existsSync);
    if (!samples.length) return { ok: false, error: 'persona has no captured audio to build a voice from' };
    const b = bins();
    // pick the longest sample; trim a clean 12s reference clip (F5 wants a short, clean reference)
    let best = samples[0], bestDur = 0;
    for (const s of samples) { const pr = await probe(s); if (pr && pr.duration > bestDur) { best = s; bestDur = pr.duration; } }
    const ref = path.join(PERSONAS_DIR, id, 'voice_ref.wav');
    await run(b.ffmpeg, ['-y', '-v', 'error', '-i', best, '-t', '12', '-ac', '1', '-ar', '24000', ref], 60000);
    if (!fs.existsSync(ref)) return { ok: false, error: 'reference trim failed' };
    p.voice = { engine: 'f5', refAudio: ref };
    p.voiceStatus = 'zero-shot clone voice built (F5) — reference-driven';
    savePersona(p);
    return { ok: true, voice: p.voice };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}

/*
 * setVoice(id, spec) — assign a persona a voice. Two kinds:
 *   { engine:'existing', voice:<onnx path> }  — one of the program's own generator voices (no clone,
 *                                               no F5, no blocker; "pretty good" per the brief)
 *   { engine:'f5', refAudio:<path> }          — a real cloned voice (built by buildVoice)
 *   null                                      — clear → default program voice
 */
function setVoice(id, spec) {
  const p = readPersona(id);
  if (!p) return { ok: false, error: 'no such persona' };
  if (spec === null || spec === undefined) { p.voice = null; p.voiceStatus = 'default program voice'; }
  else if (spec.engine === 'existing' && spec.voice) { p.voice = { engine: 'existing', voice: spec.voice, voiceId: spec.voiceId || null }; p.voiceStatus = `existing voice: ${spec.voiceId || 'selected'}`; }
  else if (spec.engine === 'kokoro' && spec.recipe) { p.voice = { engine: 'kokoro', recipe: spec.recipe, voiceId: spec.voiceId || null }; p.voiceStatus = `tuned character voice${spec.voiceName ? ': ' + spec.voiceName : ''}`; }
  else if (spec.engine === 'f5' && spec.refAudio) { p.voice = { engine: 'f5', refAudio: spec.refAudio }; p.voiceStatus = 'cloned voice (F5)'; }
  else return { ok: false, error: 'bad voice spec' };
  savePersona(p);
  return { ok: true, voice: p.voice };
}

module.exports = { listPersonas, readPersona, createPersona, setRef, togglePose, addSource, buildVoice, setVoice, savePersona, PERSONAS_DIR };
