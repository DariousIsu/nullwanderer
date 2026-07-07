/**
 * lib/avatar_state.js — the PURE state core for Zoe's 2D avatar face (voice-avatar-plan V2).
 *
 * This is the testable, deterministic brain of the avatar: expression presets, the mood→expression mapping
 * (her real lib/mood `feeling` text → a face), amplitude→mouth lip-sync smoothing (V1's TTS audio drives the
 * jaw), and a time-based blink. The DRAWING (canvas) lives in renderer/avatar.js and consumes these values;
 * keeping the math here means it's gate-covered offline, mirroring the pure/sidecar split in lib/face_match.
 *
 * No DOM, no canvas, no randomness-at-call — every function is a pure map of its inputs (time is passed in),
 * so the smoke is fully deterministic. UMD-wrapped so the SAME tested code loads in both the Node smoke
 * (require) and the browser renderer (<script> → window.AvatarState) — one source of truth, no drift.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.AvatarState = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

// Expression presets — normalized facial targets the renderer interpolates toward:
//   brow: -1 furrowed … +1 raised      eye: 0 shut … 1 wide      mouthCurve: -1 frown … +1 smile
//   gazeY: -1 up … +1 down             (mouthOpen is driven separately by amplitude while talking)
const EXPRESSIONS = {
  neutral:  { brow: 0.00, eye: 1.00, mouthCurve: 0.12, gazeY: 0.0 },
  happy:    { brow: 0.30, eye: 0.85, mouthCurve: 0.80, gazeY: 0.0 },
  warm:     { brow: 0.15, eye: 0.92, mouthCurve: 0.48, gazeY: 0.0 },
  thinking: { brow: -0.22, eye: 0.80, mouthCurve: 0.02, gazeY: -0.5 },
  tired:    { brow: -0.08, eye: 0.55, mouthCurve: -0.06, gazeY: 0.15 },
};
const DEFAULT_EXPRESSION = 'neutral';

// keyword → expression buckets, checked in priority order (first hit wins). Maps her free-text mood
// `feeling` (e.g. "warm and a little playful", "slow, a bit tired") onto a face. Unmatched → neutral.
const MOOD_BUCKETS = [
  ['happy',    ['playful', 'happy', 'excited', 'bright', 'joy', 'light', 'buoyant', 'giddy', 'delighted', 'cheer']],
  ['warm',     ['warm', 'close', 'tender', 'affection', 'content', 'calm', 'easy', 'soft', 'fond', 'cozy', 'gentle', 'settled']],
  ['thinking', ['think', 'curious', 'focus', 'pensive', 'wonder', 'restless', 'pondering', 'intent', 'absorbed']],
  ['tired',    ['tired', 'slow', 'weary', 'drained', 'quiet', 'low', 'heavy', 'sleepy', 'flat', 'worn', 'foggy']],
];

// pure: her mood `feeling` string → an expression NAME. Case-insensitive keyword match, priority-ordered.
function moodToExpression(feeling) {
  const s = String(feeling || '').toLowerCase();
  if (!s.trim()) return DEFAULT_EXPRESSION;
  for (const [name, words] of MOOD_BUCKETS) {
    if (words.some((w) => s.includes(w))) return name;
  }
  return DEFAULT_EXPRESSION;
}

// pure: an expression NAME → its preset object (falls back to neutral for unknown names).
function expressionPreset(name) {
  return EXPRESSIONS[name] || EXPRESSIONS[DEFAULT_EXPRESSION];
}
// convenience: mood feeling string straight to a preset.
function presetForFeeling(feeling) { return expressionPreset(moodToExpression(feeling)); }

// pure: RMS (0..1 loudness of an audio frame) → mouth-open target (0..1), smoothed from the previous value
// with asymmetric attack/decay so the jaw snaps open on a syllable but closes gently (no jitter/flicker).
// This is the lip-sync core: renderer/avatar.js computes RMS from a WebAudio AnalyserNode and calls this
// every frame while a TTS wav plays. gain lifts quiet speech; max caps a natural open mouth.
function amplitudeToMouth(rms, prev = 0, { gain = 1.9, attack = 0.55, decay = 0.22, max = 0.95, floor = 0.04 } = {}) {
  const r = Number.isFinite(rms) ? Math.max(0, rms) : 0;
  let target = r * gain;
  target = Math.max(0, Math.min(max, target));
  if (target < floor) target = 0;                    // treat near-silence as a closed mouth
  const p = Number.isFinite(prev) ? prev : 0;
  const k = target > p ? attack : decay;             // open fast, close slow
  const next = p + (target - p) * k;
  return Math.max(0, Math.min(max, next));
}

// pure: RMS of a sample buffer (values in -1..1, or 0..255 from a byte AnalyserNode → pass normalized).
// Exposed so the renderer and the smoke share one definition.
function rms(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i]; sum += v * v; }
  return Math.sqrt(sum / samples.length);
}

// pure: eyelid-open MULTIPLIER (0..1) at time `nowMs`, producing a periodic blink. 1 = fully open; dips
// toward ~0.1 for `durMs` every `periodMs`. Deterministic function of time (a per-avatar `phase` offset
// desyncs multiple faces). Uses a raised-cosine so the lid closes and reopens smoothly.
function blinkMultiplier(nowMs, { periodMs = 4200, durMs = 140, phase = 0 } = {}) {
  if (!Number.isFinite(nowMs)) return 1;
  const t = ((nowMs + phase) % periodMs + periodMs) % periodMs;   // 0..periodMs, safe for negative
  if (t >= durMs) return 1;
  const x = t / durMs;                       // 0..1 across the blink
  const closed = 0.5 - 0.5 * Math.cos(2 * Math.PI * x);   // 0→1→0 (down then up)
  return 1 - 0.9 * closed;                   // 1 → ~0.1 → 1
}

  return {
    EXPRESSIONS, DEFAULT_EXPRESSION, MOOD_BUCKETS,
    moodToExpression, expressionPreset, presetForFeeling,
    amplitudeToMouth, rms, blinkMultiplier,
  };
}));
