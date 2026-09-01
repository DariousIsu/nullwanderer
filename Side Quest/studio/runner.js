/**
 * studio/runner.js — the autonomous producer. A job is a SCRIPT plus options; the runner walks it
 * through: parse → voice (TTS per segment) → takes (InfiniteTalk render per on-camera segment,
 * sequential on the one GPU) → b-roll placeholders → cut (lib/video_compose.assemble) → review.
 *
 * Deliberate stops, per the program's laws:
 *  - The pipeline HALTS at ready_for_review. Nothing posts. The quality gate today is the human
 *    approve/reject buttons in the UI (a model QC judge slots in ahead of them later) — curators
 *    propose, gates decide.
 *  - The parser is deterministic and handles the house script FORMAT (time-range headers, ZO: lines,
 *    parenthetical cut directions). Prose it cannot parse becomes one on-camera segment plus a
 *    warning in the job log — never a silent guess. Model-grade comprehension belongs to the
 *    submitting cognition (it can send `timeline` directly and skip the parser entirely).
 *  - Every stage transition and error is appended to job.log — the job file IS the truth the UI shows.
 *
 * Jobs live at data/studio/jobs/<id>/job.json with all artifacts beside it.
 */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const JOBS_DIR = path.join(ROOT, 'data', 'studio', 'jobs');
const tts = require(path.join(ROOT, 'lib', 'tts'));
const voiceClone = require(path.join(ROOT, 'lib', 'voice_clone'));
const voiceKokoro = require(path.join(ROOT, 'lib', 'voice_kokoro'));
const vc = require(path.join(ROOT, 'lib', 'video_compose'));
const comfy = require('./comfy_client');

const DEFAULT_REF = path.join(ROOT, 'data', 'avatars', 'zoe_ref.jpg');

function listJobs() {
  try {
    return fs.readdirSync(JOBS_DIR)
      .filter(d => fs.existsSync(path.join(JOBS_DIR, d, 'job.json')))
      .map(d => readJob(d)).filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}
function readJob(id) {
  try { return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, id, 'job.json'), 'utf8')); }
  catch { return null; }
}
function saveJob(job) {
  fs.mkdirSync(path.join(JOBS_DIR, job.id), { recursive: true });
  fs.writeFileSync(path.join(JOBS_DIR, job.id, 'job.json'), JSON.stringify(job, null, 1));
}
function log(job, msg) {
  job.log = job.log || [];
  job.log.push(`${new Date().toISOString()} ${msg}`);
  if (job.log.length > 400) job.log = job.log.slice(-400);
}

/*
 * The house script format, deterministically:
 *   **0:00–0:03** style headers open a beat; ZO: "..." (or ZO: ...) lines are spoken text;
 *   a parenthetical containing "b-roll" marks the beat as b-roll (voice continues over it).
 * Returns [{ kind:'avatar'|'broll', text, direction }]; unparseable → one avatar segment + warning.
 */
function parseScript(script) {
  const warnings = [];
  const blocks = String(script).split(/\*\*\s*\d+:\d+\s*[–-]\s*\d+:\d+\s*\*\*/).slice(1);
  const segs = [];
  for (const b of blocks) {
    const spoken = [...b.matchAll(/^\s*(?:ZO|ZOE|VO)\s*:\s*["“]?(.+?)["”]?\s*$/gim)].map(m => m[1]).join(' ');
    const parens = [...b.matchAll(/\(([^)]+)\)/g)].map(m => m[1]).join(' · ');
    if (!spoken.trim()) { if (b.trim()) warnings.push('beat with no spoken line skipped'); continue; }
    segs.push({ kind: /b-?roll/i.test(parens) ? 'broll' : 'avatar', text: spoken.trim(), direction: parens || null });
  }
  if (!segs.length) {
    // No timed house format → split into sentence-sized on-camera segments (short takes cut together),
    // NEVER one giant render: a 60s single InfiniteTalk take is impractical. Group sentences so each
    // segment stays roughly a breath long (≤ ~30 words), which also gives natural jump cuts.
    const flat = String(script).replace(/\s+/g, ' ').trim();
    if (flat) {
      const sentences = (flat.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [flat]).map(s => s.trim()).filter(Boolean);
      let cur = '';
      const flush = () => { if (cur.trim()) { segs.push({ kind: 'avatar', text: cur.trim(), direction: null }); cur = ''; } };
      for (const s of sentences) {
        cur = cur ? `${cur} ${s}` : s;
        if (cur.split(/\s+/).length >= 30) flush();   // ~a breath's worth per take
      }
      flush();
      warnings.push(`no timed script format — split into ${segs.length} short on-camera segment(s)`);
    }
  }
  return { segments: segs, warnings };
}

function createJob({ script, title, refImage, timeline, persona }) {
  const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  // A persona (a clone) carries its pose set, its voice, and — load-bearing — its post-eligibility.
  // Default (no persona) is Zoe: post-eligible. Any 1:1 clone is download-only.
  const poses = persona && persona.poses && persona.poses.length
    ? persona.poses.map(b => path.join(require('./cloner').PERSONAS_DIR, persona.id, b))
    : [refImage && fs.existsSync(refImage) ? refImage : DEFAULT_REF];
  const job = {
    id, title: title || 'untitled', createdAt: Date.now(), status: 'queued',
    script: script || null, timeline: timeline || null,
    personaId: persona ? persona.id : null,
    personaName: persona ? persona.name : 'Zoe',
    postEligible: persona ? !!persona.postEligible : true,
    voice: persona ? (persona.voice || null) : null,
    poses,
    refImage: poses[0],
    segments: [], log: [],
  };
  log(job, `created (${timeline ? 'explicit timeline' : 'script'}, persona=${job.personaName}, poses=${poses.length}, ${job.postEligible ? 'post-eligible' : 'DOWNLOAD-ONLY (1:1 clone)'})`);
  if (persona && persona.voice == null) log(job, '⚠ persona has no cloned voice yet — using the default program voice for this run');
  saveJob(job);
  return job;
}

// One tick advances at most one stage of one job — cheap, restart-safe, no long awaits held open.
async function tick() {
  const jobs = listJobs();
  // externally-managed jobs (e.g. a render driven outside the Studio) are display-only — the runner
  // never advances them; whoever owns the external render updates the record.
  const active = jobs.find(j => !j.external && !['ready_for_review', 'approved', 'delivered', 'rejected', 'error'].includes(j.status));
  if (!active) return;
  const job = active;
  const dir = path.join(JOBS_DIR, job.id);
  try {
    if (job.status === 'queued') {
      const parsed = job.timeline ? { segments: [], warnings: [] } : parseScript(job.script);
      if (!job.timeline) {
        job.segments = parsed.segments.map((s, i) => ({ ...s, i, wav: null, take: null }));
        parsed.warnings.forEach(w => log(job, `⚠ parse: ${w}`));
        log(job, `parsed ${job.segments.length} segments (${job.segments.filter(s => s.kind === 'avatar').length} on-camera)`);
      }
      job.status = job.timeline ? 'cutting' : 'voicing';
    } else if (job.status === 'voicing') {
      const seg = job.segments.find(s => !s.wav);
      if (!seg) { job.status = 'rendering'; log(job, 'voice complete'); }
      else {
        // Voice routing, in preference order:
        //  - a real cloned voice (F5, the person's own timbre) IF built and the engine runs;
        //  - a chosen EXISTING voice (the program's Piper/Kokoro generator) — no clone needed, no blocker;
        //  - the default program voice (Zoe).
        // A cloned-voice failure DEGRADES to the existing/default voice, never tanks the video.
        let r = null;
        if (job.voice && job.voice.engine === 'f5' && voiceClone.available()) {
          r = await voiceClone.synthesize(seg.text, job.voice);
          if (!r.ok) { log(job, `⚠ clone voice failed (${String(r.error).slice(0, 80)}) — falling back to a program voice`); r = null; }
        }
        if (!r && job.voice && job.voice.engine === 'kokoro' && job.voice.recipe && await voiceKokoro.available()) {
          r = await voiceKokoro.synthesize(seg.text, job.voice.recipe); // a tuned character voice (via the tuner)
          if (!r.ok) { log(job, `⚠ tuned voice failed (${String(r.error).slice(0, 60)}) — falling back`); r = null; }
        }
        if (!r && job.voice && job.voice.engine === 'existing' && job.voice.voice) {
          r = await tts.synthesize(seg.text, { voice: job.voice.voice }); // an existing registry voice (onnx path)
        }
        if (!r) r = await tts.synthesize(seg.text, {}); // default program voice
        if (!r.ok) throw new Error(`tts segment ${seg.i}: ${r.error}`);
        const wav = path.join(dir, `seg${seg.i}.wav`);
        fs.copyFileSync(r.out, wav);
        const p = await vc.probe(wav);
        seg.wav = wav; seg.dur = p ? p.duration : null;
        log(job, `voiced segment ${seg.i} (${seg.dur}s)`);
      }
    } else if (job.status === 'rendering') {
      if (!(await comfy.alive())) { log(job, '⚠ render server unreachable — will retry'); saveJob(job); return; }
      const inFlight = job.segments.find(s => s.kind === 'avatar' && s.promptId && !s.take);
      if (inFlight) {
        const c = await comfy.checkTake(inFlight.promptId);
        if (c.ok && c.state === 'done') { inFlight.take = c.file; log(job, `take ${inFlight.i} done: ${path.basename(c.file)}`); }
        else if (c.ok && c.state === 'error') throw new Error(`take ${inFlight.i} render error: ${c.error}`);
      } else {
        const next = job.segments.find(s => s.kind === 'avatar' && !s.take && !s.promptId);
        if (!next) { job.status = 'cutting'; log(job, 'all takes rendered'); }
        else {
          // MULTI-POSE: rotate through the persona's pose set so consecutive on-camera cuts vary the
          // angle/framing (the visual variety that reads as a real multi-shot edit, not one locked take).
          const poses = (job.poses && job.poses.length) ? job.poses : [job.refImage];
          const camIdx = job.segments.filter(s => s.kind === 'avatar' && (s.take || s.promptId)).length;
          const pose = poses[camIdx % poses.length];
          next.pose = path.basename(pose);
          const image = comfy.stageInput(pose);
          const audio = comfy.stageInput(next.wav);
          const r = await comfy.submitTake({
            image, audio, durSec: next.dur, prefix: `${job.id}_seg${next.i}`,
            prompt: next.direction && !/b-?roll/i.test(next.direction)
              ? `A person speaks directly to the camera, ${next.direction}, soft frontal lighting, natural gestures`
              : 'A person speaks directly to the camera with natural hand gestures and engaged expression, soft frontal lighting',
          });
          if (!r.ok) throw new Error(`submit take ${next.i}: ${r.error}`);
          next.promptId = r.promptId;
          log(job, `take ${next.i} queued on the render server (${Math.ceil(next.dur * 25 / 81)} windows)`);
        }
      }
    } else if (job.status === 'cutting') {
      let timeline = job.timeline;
      if (!timeline) {
        // b-roll v1 is an HONEST placeholder: the direction text as a card over brand ground —
        // never a fabricated document. Real b-roll sources arrive with the b-roll tool.
        timeline = {
          out: path.join(dir, 'cut.mp4'),
          segments: job.segments.map((s, i) => s.kind === 'avatar'
            ? { video: s.take, wav: s.wav, text: s.text, ...(i === 0 ? { effects: { fadeInSec: 0.6 } } : {}) }
            : { color: '0x14141a', durSec: 0, wav: s.wav, text: s.text, card: s.direction ? `[ b-roll: ${s.direction.slice(0, 60)} ]` : '[ b-roll ]' }),
        };
      }
      const r = await vc.assemble(timeline);
      if (!r.ok) throw new Error(`assemble: ${r.error}`);
      job.cut = r.path; job.probe = r.probe;
      log(job, `cut assembled: ${path.basename(r.path)} (${r.probe.duration}s ${r.probe.width}x${r.probe.height})`);
      job.status = 'ready_for_review';
      log(job, job.postEligible
        ? 'HALT — awaiting review (quality gate). Nothing posts without approval.'
        : 'HALT — DOWNLOAD-ONLY (1:1 clone). This cut is not eligible for posting; deliver it to the depicted person.');
    }
    saveJob(job);
  } catch (e) {
    job.status = 'error';
    log(job, `✗ ${String(e.message || e)}`);
    saveJob(job);
  }
}

function decide(id, verdict) {
  const job = readJob(id);
  if (!job) return { ok: false, error: 'no such job' };
  if (job.status !== 'ready_for_review' && verdict !== 'retry') return { ok: false, error: `job is ${job.status}, not ready_for_review` };
  if (verdict === 'approve') {
    // The privacy gate, enforced (not just UI): a 1:1 clone can never be approved for posting.
    if (!job.postEligible) return { ok: false, error: '1:1 clone — not eligible for posting; use download' };
    job.status = 'approved'; log(job, 'APPROVED for posting by operator (posting is a separate, future door)');
  }
  else if (verdict === 'download') { job.status = 'delivered'; log(job, 'marked DELIVERED — cut downloaded for hand-off to the depicted person (never posted)'); }
  else if (verdict === 'reject') { job.status = 'rejected'; log(job, 'rejected by operator'); }
  else if (verdict === 'retry') { job.status = 'queued'; job.segments = []; job.cut = null; log(job, 'retry from the top'); }
  else return { ok: false, error: 'verdict must be approve|download|reject|retry' };
  saveJob(job);
  return { ok: true, status: job.status };
}

module.exports = { listJobs, readJob, createJob, tick, decide, parseScript, JOBS_DIR };
