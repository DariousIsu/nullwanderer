'use strict';
/*
 * lib/nonverbal.js — THE NON-VERBAL BANK (the wants project, her wish zero, 2026-09-05): a breath, a sigh,
 * a laugh, a chuckle, an "hmm" — the sounds between her words. Kokoro cannot laugh or sigh, and a second
 * engine with native non-verbals (Orpheus-class) waits on RAM the box does not have tonight, so:
 *   • breath and sigh are SYNTHESIZED here as PCM — shaped noise under an envelope (a breath), and the same
 *     with a soft descending voiced tone underneath (a sigh) — deterministic (seeded), bounded, local;
 *   • laugh, chuckle and hmm are spoken by HER OWN Kokoro blend through the tuner from onomatopoeia at a
 *     tone delta (quick for a laugh, low for an hmm), so they are her voice, not a stranger's sample.
 * Every clip is cached under data/voices/nonverbal keyed by kind + the recipe's hash (a new voice identity
 * regenerates them). A clip that cannot be made answers { ok:false } and the words still play — a missing
 * laugh never blocks a sentence. Pure DSP + injected synth → offline-smokeable.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'data', 'voices', 'nonverbal');
const SR = 24000;   // the tuner's rate, so a clip splices beside a sentence without resampling

// The bank. spoken → through Kokoro (her recipe + a tone); dsp → synthesized here.
const KINDS = {
  breath:  { dsp: 'breath',  ms: 340 },
  sigh:    { dsp: 'sigh',    ms: 950 },
  laugh:   { spoken: 'Ha ha ha!',  tone: 'quick' },
  chuckle: { spoken: 'Heh heh.',   tone: 'warm' },
  hmm:     { spoken: 'Hmm.',       tone: 'low' },
};
function kinds() { return Object.keys(KINDS); }

// ── DSP (pure) ──────────────────────────────────────────────────────────────────────────────────────
function _prng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s / 4294967296) * 2 - 1; }; }
// an RBJ band-pass biquad (constant-skirt), state inside the returned function
function _bandpass(f, Q, sr) {
  const w = 2 * Math.PI * f / sr, alpha = Math.sin(w) / (2 * Q), cosw = Math.cos(w);
  const a0 = 1 + alpha, b0 = alpha / a0, b2 = -alpha / a0, a1 = -2 * cosw / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => { const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x; y2 = y1; y1 = y; return y; };
}
// A BREATH (v2, 2026-09-05 — his verdict on v1: "it just sounds like someone blowing into a mic"). v1 was white
// noise through two one-pole filters (a 6 dB/oct skirt: hiss to the top of the band, ZCR ≈ 7300/s) held at a
// plateau for a third of a second — a steady stream of air on a capsule. A catch-breath before a sentence is
// shaped by the mouth: a resonance near 950 Hz with a touch of air near 2.2 kHz, almost nothing above 3 kHz,
// a rise with no plateau and a quick fall, a slight flutter, and a level ~18 dB under speech. shape 'in' is the
// inhale (rise 70 % / fall 30 %); 'out' the exhale a sigh rides (rise 15 % / fall 85 %). Level is normalized
// to targetRms so the loudness is a decision here, not an accident of the filters.
function synthBreath({ ms = 340, amp = null, seed = 7, sr = SR, shape = 'in', targetRms = 0.0126, peakCap = 0.05 } = {}) {
  const n = Math.round(sr * ms / 1000), out = new Float32Array(n), rnd = _prng(seed);
  const body = _bandpass(950, 1.6, sr), air = _bandpass(2200, 3.0, sr);
  const aLp = 1 - Math.exp(-2 * Math.PI * 2800 / sr);
  const aHp = 1 - Math.exp(-2 * Math.PI * 300 / sr);
  let lp1 = 0, lp2 = 0, hp = 0;
  const rise = shape === 'out' ? 0.15 : 0.70;
  for (let i = 0; i < n; i++) {
    const w = rnd();
    let s = body(w) + 0.32 * air(w);
    lp1 += aLp * (s - lp1); lp2 += aLp * (lp1 - lp2);          // two poles above 2.8 kHz
    hp += aHp * (lp2 - hp); s = lp2 - hp;                          // nothing below ~300 Hz
    const t = i / n;
    let env = t < rise ? Math.pow(t / rise, 1.4) : Math.pow(Math.cos((Math.PI / 2) * ((t - rise) / (1 - rise))), 1.2);
    env *= 1 + 0.10 * Math.sin(2 * Math.PI * 12 * i / sr);         // a slight flutter — not a constant stream
    out[i] = s * env;
  }
  // level: a decision, not an accident
  let rms = 0, pk = 0; for (let i = 0; i < n; i++) { rms += out[i] * out[i]; pk = Math.max(pk, Math.abs(out[i])); }
  rms = Math.sqrt(rms / n) || 1e-9;
  let g = (amp != null ? amp : targetRms) / rms;
  if (pk * g > peakCap) g = peakCap / pk;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}
// a sigh: a longer breath with a voiced, softly descending tone underneath (a low "haaah"), two harmonics.
function synthSigh({ ms = 950, amp = 0.15, seed = 11, sr = SR } = {}) {
  const n = Math.round(sr * ms / 1000);
  const breath = synthBreath({ ms, seed, sr, shape: 'out', targetRms: 0.02, peakCap: 0.08 });
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = 210 - 70 * t;                                   // the fall
    phase += 2 * Math.PI * f / sr;
    const env = Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 1.5;   // swell then fade
    const tone = (Math.sin(phase) * 0.7 + Math.sin(2 * phase) * 0.22 + Math.sin(3 * phase) * 0.08) * env * amp * 0.55;
    out[i] = breath[i] + tone;
  }
  return out;
}
// 16-bit PCM WAV bytes from float samples in −1..1 (clipped). Deterministic.
function wavBytes(samples, sr = SR) {
  const n = samples.length, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, samples[i])); data.writeInt16LE(Math.round(v * 32767), i * 2); }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
function wavInfo(buf) {
  try { if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null; return { sampleRate: buf.readUInt32LE(24), bytes: buf.length }; } catch { return null; }
}
function peak(samples) { let p = 0; for (let i = 0; i < samples.length; i++) p = Math.max(p, Math.abs(samples[i])); return p; }

// ── the bank ────────────────────────────────────────────────────────────────────────────────────────
function _hash(o) { return crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 10); }
function clipPath(kind, recipe, { dir = DIR } = {}) {
  const spec = KINDS[kind]; if (!spec) return null;
  const key = spec.dsp ? _hash({ kind, dsp: spec.dsp, ms: spec.ms, v: 2 }) : _hash({ kind, spoken: spec.spoken, tone: spec.tone, recipe: recipe && { w: recipe.weights, l: recipe.lang, s: recipe.speed }, v: 1 });
  return path.join(dir, `${kind}.${key}.wav`);
}

/**
 * Ensure a clip exists and answer the shape the speech manager plays: { ok, out, bytes, sampleRate, kind }.
 * deps: recipe (her active recipe), synth (text, recipe, {out}) → {ok,out,bytes,sampleRate}, applyTone,
 * fs, dir. Never throws; a clip that cannot be made is { ok:false, error }.
 */
async function ensureClip(kind, { deps = {} } = {}) {
  const spec = KINDS[kind];
  if (!spec) return { ok: false, error: `unknown non-verbal: ${kind}` };
  if (process.env.ZOE_NONVERBAL === '0') return { ok: false, error: 'ZOE_NONVERBAL=0' };
  const fsx = deps.fs || fs;
  const dir = deps.dir || DIR;
  const recipe = deps.recipe !== undefined ? deps.recipe : (() => { try { return require('./voices').activeRecipe(); } catch { return null; } })();
  const out = clipPath(kind, recipe, { dir });
  try {
    if (fsx.existsSync(out)) { const info = wavInfo(fsx.readFileSync(out)); if (info) return { ok: true, out, ...info, kind, cached: true }; }
  } catch {}
  try { fsx.mkdirSync(dir, { recursive: true }); } catch {}
  if (spec.dsp) {
    const samples = spec.dsp === 'sigh' ? synthSigh({ ms: spec.ms }) : synthBreath({ ms: spec.ms });
    const buf = wavBytes(samples);
    try { fsx.writeFileSync(out, buf); } catch (e) { return { ok: false, error: `write: ${e.message}` }; }
    return { ok: true, out, bytes: buf.length, sampleRate: SR, kind, cached: false };
  }
  // spoken: her own blend at the kind's tone
  if (!recipe || !recipe.weights) return { ok: false, error: 'no active recipe' };
  const applyTone = deps.applyTone || ((r, t) => require('./voices').applyTone(r, t));
  const toned = applyTone(recipe, spec.tone).recipe;
  const synth = deps.synth || ((text, rc, o) => require('./voice_kokoro').synthesize(text, rc, o));
  try {
    const r = await synth(spec.spoken, toned, { out, timeoutMs: 20000 });
    if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'synth failed' };
    const info = (r.bytes && r.sampleRate) ? { bytes: r.bytes, sampleRate: r.sampleRate } : (wavInfo(fsx.readFileSync(r.out || out)) || { bytes: 0, sampleRate: SR });
    return { ok: true, out: r.out || out, ...info, kind, cached: false };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { KINDS, kinds, ensureClip, clipPath, synthBreath, synthSigh, wavBytes, wavInfo, peak, SR, DIR };
