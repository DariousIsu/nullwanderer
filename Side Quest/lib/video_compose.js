/**
 * lib/video_compose.js — assemble a TikTok-ready vertical MP4 from her performance parts.
 *
 * PURPOSE (tiktok-avatar-tools Door 1): the deterministic back half of the video pipeline. Takes a head
 * video (Door 2's talking_head output) OR a still portrait (data/avatars/zoe_ref.jpg fallback), her voice
 * WAV (lib/tts.js output), and the script text — produces a 1080x1920 MP4 with burned captions. This is
 * the reusable seam: any lane that can make audio + a picture can make a postable vertical video.
 *
 * Fail-soft everywhere, mirroring lib/tts.js: missing binary / missing input / ffmpeg failure all resolve
 * to { ok:false, error } — compose never throws. And it never SAYS without DOING: the returned { probe }
 * is measured from the finished file with ffprobe, not assumed. ok:true means a real file on disk whose
 * dimensions and duration were read back. Callers (and gates) judge the probe, not the claim.
 *
 * Caption timing v1 is authored, not transcribed: we WROTE the script, so cards are distributed across the
 * audio duration proportional to text length. Good enough to ship; callers pass `captions` with explicit
 * {text,start,end} (e.g. whisper word alignment via lib/stt.js) when they want tighter sync — explicit
 * timings always win over the estimate.
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'video_out');

// Binaries ship in node_modules (ffmpeg-static / ffprobe-static) — no PATH dependence, no system install.
// Lazy + guarded so a clone without the packages degrades to { ok:false }, never a require-crash at boot.
function bins() {
  try {
    return { ffmpeg: require('ffmpeg-static'), ffprobe: require('ffprobe-static').path };
  } catch (e) { return null; }
}

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs || 300000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Measured facts about a media file. Every ok:true path in this module rests on this, so it returns
// null (never a guess) when ffprobe can't read the file.
async function probe(file) {
  const b = bins();
  if (!b || !fs.existsSync(file)) return null;
  const r = await run(b.ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file], 30000);
  if (r.err) return null;
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams || []).find(s => s.codec_type === 'video');
    const a = (j.streams || []).find(s => s.codec_type === 'audio');
    return {
      duration: parseFloat((j.format && j.format.duration) || 0) || 0,
      width: v ? v.width : 0, height: v ? v.height : 0,
      hasAudio: !!a, sizeBytes: parseInt((j.format && j.format.size) || 0, 10) || 0,
    };
  } catch { return null; }
}

/*
 * Script → caption cards. Short cards (<=5 words) in the TikTok register, timed by character weight so a
 * long sentence holds the screen longer than a short one. Pure estimate — see header for the upgrade path.
 */
function scriptToCaptions(script, totalDur) {
  const words = String(script || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length || !(totalDur > 0)) return [];
  const cards = [];
  for (let i = 0; i < words.length; i += 5) cards.push(words.slice(i, i + 5).join(' '));
  const weights = cards.map(c => c.length + 4); // +4: a floor so tiny cards still get readable time
  const wSum = weights.reduce((a, b) => a + b, 0);
  let t = 0;
  return cards.map((text, i) => {
    const dur = (weights[i] / wSum) * totalDur;
    const card = { text, start: t, end: Math.min(t + dur, totalDur) };
    t += dur;
    return card;
  });
}

// ASS subtitles, authored (not force-styled): bold outlined lower-third cards, the standard short-form
// look. ASS over drawtext because escaping stays sane and styling lives in one header line.
function toAss(captions) {
  const esc = s => String(s).replace(/[\r\n]+/g, ' ').replace(/[{}]/g, '');
  const ts = t => {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = (t % 60);
    return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
  };
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 1080', 'PlayResY: 1920', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, BackColour, Bold, Outline, Shadow, Alignment, MarginL, MarginR, MarginV',
    'Style: Card,Arial,78,&H00FFFFFF,&H00101010,&H80000000,-1,5,0,2,60,60,420', '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  const lines = captions.map(c => `Dialogue: 0,${ts(c.start)},${ts(c.end)},Card,,0,0,0,,${esc(c.text)}`);
  return head.concat(lines).join('\n');
}

/*
 * compose(opts) → { ok:true, path, probe } | { ok:false, error }
 *   video    — head/performance video (Door 2 output). Or:
 *   image    — still portrait, looped over the audio (the no-model fallback rung).
 *   wav      — voice track. Required with image; with video it REPLACES the video's audio when given.
 *   script   — text for estimated captions.  captions — [{text,start,end}] overrides the estimate.
 *   out      — output path (default data/video_out/compose_<ts>.mp4).
 */
async function compose(opts) {
  const o = opts || {};
  try {
    const b = bins();
    if (!b || !b.ffmpeg) return { ok: false, error: 'ffmpeg-static not installed' };
    const visual = o.video || o.image;
    if (!visual || !fs.existsSync(visual)) return { ok: false, error: `visual input missing: ${visual}` };
    if (o.image && !(o.wav && fs.existsSync(o.wav))) return { ok: false, error: 'image mode requires a wav' };
    if (o.wav && !fs.existsSync(o.wav)) return { ok: false, error: `wav missing: ${o.wav}` };

    // Duration comes from the AUDIO when we have it (the voice is the performance clock), else the video.
    const clockFile = o.wav || o.video;
    const inProbe = await probe(clockFile);
    if (!inProbe || !(inProbe.duration > 0)) return { ok: false, error: `unreadable input: ${clockFile}` };
    const dur = inProbe.duration;

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const outPath = o.out || path.join(OUT_DIR, `compose_${Date.now()}.mp4`);

    // Captions: explicit timings win; otherwise estimate from the script; no script → no caption track.
    const captions = (Array.isArray(o.captions) && o.captions.length) ? o.captions
      : (o.script ? scriptToCaptions(o.script, dur) : []);
    let assPath = null;
    if (captions.length) {
      assPath = outPath.replace(/\.mp4$/i, '.ass');
      fs.writeFileSync(assPath, toAss(captions), 'utf8');
    }

    // 1080x1920 frame: visual scaled to width, centered on the program-dark ground (#0d0d10 — her stage
    // color from renderer/avatar_vrm.html, so stills and head clips sit on the same brand surface).
    const vf = ['scale=1080:-2', 'pad=1080:1920:0:(oh-ih)/2:color=0x0d0d10'];
    // subtitles filter needs the path escaped for the filtergraph parser (windows drive colon + backslashes)
    if (assPath) vf.push(`subtitles='${assPath.replace(/\\/g, '/').replace(/:/g, '\\:')}'`);

    const args = ['-y'];
    if (o.image) args.push('-loop', '1', '-framerate', '30');
    args.push('-i', visual);
    if (o.wav) args.push('-i', o.wav);
    args.push('-vf', vf.join(','), '-t', String(dur));
    if (o.wav) args.push('-map', '0:v:0', '-map', '1:a:0');
    args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-pix_fmt', 'yuv420p', '-r', '30');
    if (o.image) args.push('-tune', 'stillimage');
    args.push('-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', outPath);

    const r = await run(b.ffmpeg, args, o.timeoutMs || 600000);
    if (r.err) return { ok: false, error: `ffmpeg failed: ${r.stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}` };

    // The say-do gate lives IN the tool: read the finished file back before claiming ok.
    const outProbe = await probe(outPath);
    if (!outProbe || !(outProbe.duration > 0) || outProbe.width !== 1080 || outProbe.height !== 1920) {
      return { ok: false, error: `output failed verification: ${JSON.stringify(outProbe)}` };
    }
    return { ok: true, path: outPath, probe: outProbe, captionCards: captions.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/*
 * assemble(timeline) → { ok:true, path, probe, segments } | { ok:false, error }
 *
 * The CUTTING ROOM: a declarative multi-segment edit executed deterministically. Her cognition
 * translates a script's stage directions ("cut to b-roll", "fade from black", "end card") into this
 * timeline; this engine never interprets prose and a model never touches an ffmpeg flag.
 *
 *   timeline.segments — in cut order, each one of:
 *     { video, wav?, text?, effects? }   a clip; wav is that segment's voice (trimmed to the wav's
 *                                        measured duration; video shorter → last frame holds)
 *     { image, wav, text?, effects? }    a still held for its wav's duration
 *     { color?, durSec, card }           a text card on flat ground (color default 0x0d0d10)
 *   effects: { fadeInSec?, zoomOutSec?, zoomFrom? }  — fade from black; open on a tight face crop
 *            easing to full frame (zoomFrom, default 2.2, over zoomOutSec).
 *   timeline.out — final MP4 path.
 *
 * The voice track is the segments' wavs concatenated in order (card/silent segments contribute
 * silence), so speech runs continuously across visual cuts — the jump-cut grammar. Captions come
 * from each segment's `text` at its true offset (explicit timings per card), plus `card` text.
 * Output is the standard 1080x1920 compose, and the same say-do rule: ok:true carries the ffprobe.
 */
async function assemble(timeline) {
  const t = timeline || {};
  const segs = Array.isArray(t.segments) ? t.segments : [];
  try {
    const b = bins();
    if (!b || !b.ffmpeg) return { ok: false, error: 'ffmpeg-static not installed' };
    if (!segs.length) return { ok: false, error: 'timeline has no segments' };
    if (!t.out) return { ok: false, error: 'timeline.out required' };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const work = path.join(OUT_DIR, `asm_${Date.now()}`);
    fs.mkdirSync(work, { recursive: true });
    const FPS = 25, W = 480, H = 832; // intermediate cutting size; compose() lifts to 1080x1920

    // pass 1: measure every segment's duration (wav is the clock when present)
    const plan = [];
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      let dur;
      if (s.wav) {
        if (!fs.existsSync(s.wav)) return { ok: false, error: `segment ${i}: wav missing: ${s.wav}` };
        const p = await probe(s.wav);
        if (!p || !(p.duration > 0)) return { ok: false, error: `segment ${i}: unreadable wav` };
        dur = p.duration;
      } else if (s.durSec > 0) dur = s.durSec;
      else return { ok: false, error: `segment ${i}: needs wav or durSec` };
      if (s.video && !fs.existsSync(s.video)) return { ok: false, error: `segment ${i}: video missing: ${s.video}` };
      if (s.image && !fs.existsSync(s.image)) return { ok: false, error: `segment ${i}: image missing: ${s.image}` };
      plan.push({ ...s, dur });
    }

    // pass 2: normalize each segment to W x H @ FPS with its effects, silent (voice is one track)
    for (let i = 0; i < plan.length; i++) {
      const s = plan[i], seg = path.join(work, `seg${i}.mp4`);
      const fx = s.effects || {};
      const vf = [`scale=${W}:-2`, `pad=${W}:${H}:0:(oh-ih)/2:color=0x0d0d10`];
      if (fx.zoomOutSec > 0) {
        const zf = fx.zoomFrom || 2.2, n = Math.round(fx.zoomOutSec * FPS);
        vf.push(`zoompan=d=1:s=${W}x${H}:fps=${FPS}:z='max(1,${zf}-${(zf - 1).toFixed(3)}*on/${n})':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*0.22'`);
      }
      if (fx.fadeInSec > 0) vf.push(`fade=t=in:st=0:d=${fx.fadeInSec}`);
      const args = ['-y', '-v', 'error'];
      if (s.video) args.push('-i', s.video);
      else if (s.image) args.push('-loop', '1', '-framerate', String(FPS), '-i', s.image);
      else args.push('-f', 'lavfi', '-i', `color=c=${s.color || '0x0d0d10'}:s=${W}x${H}:r=${FPS}:d=${s.dur}`);
      // hold the last frame if the visual runs shorter than the voice; then trim to the clock
      args.push('-vf', vf.join(',') + `,tpad=stop_mode=clone:stop_duration=${Math.ceil(s.dur)},fps=${FPS}`,
        '-t', String(s.dur), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', seg);
      const r = await run(b.ffmpeg, args, 300000);
      if (r.err) return { ok: false, error: `segment ${i} render failed: ${r.stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}` };
      plan[i].file = seg;
    }

    // pass 3: one continuous voice track — wavs in order, silence where a segment has none
    const voice = path.join(work, 'voice.wav');
    {
      // silent segments come from anullsrc lavfi inputs so one concat covers every case
      const args2 = ['-y', '-v', 'error']; const labels = [];
      let idx = 0;
      for (const s of plan) {
        if (s.wav) args2.push('-i', s.wav);
        else args2.push('-f', 'lavfi', '-t', String(s.dur), '-i', 'anullsrc=r=24000:cl=mono');
        labels.push(`[${idx}:a]`); idx++;
      }
      args2.push('-filter_complex', `${labels.join('')}concat=n=${labels.length}:v=0:a=1[a]`, '-map', '[a]', voice);
      const r = await run(b.ffmpeg, args2, 120000);
      if (r.err) return { ok: false, error: `voice concat failed: ${r.stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}` };
    }

    // pass 4: concat visuals
    const visual = path.join(work, 'visual.mp4');
    {
      const args = ['-y', '-v', 'error'];
      plan.forEach(s => args.push('-i', s.file));
      args.push('-filter_complex', plan.map((_, i) => `[${i}:v]`).join('') + `concat=n=${plan.length}:v=1:a=0[v]`,
        '-map', '[v]', '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p', visual);
      const r = await run(b.ffmpeg, args, 300000);
      if (r.err) return { ok: false, error: `visual concat failed: ${r.stderr.split('\n').filter(Boolean).slice(-2).join(' | ')}` };
    }

    // pass 5: captions at true offsets, then the standard vertical compose
    const captions = [];
    let cursor = 0;
    for (const s of plan) {
      if (s.text) scriptToCaptions(s.text, s.dur).forEach(c => captions.push({ text: c.text, start: c.start + cursor, end: c.end + cursor }));
      if (s.card) captions.push({ text: s.card, start: cursor, end: cursor + s.dur });
      cursor += s.dur;
    }
    const res = await compose({ video: visual, wav: voice, captions, out: t.out });
    if (res.ok) { res.segments = plan.length; if (!t.keepWork) fs.rmSync(work, { recursive: true, force: true }); }
    return res;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { compose, assemble, probe, scriptToCaptions };
