/**
 * lib/vrm_state.js — PURE adapter mapping Zoe's control surface onto VRM standard expression weights
 * (voice-avatar-plan V2, VRM rebuild). The rig logic (mood→expression, amplitude→mouth, blink timing) is
 * REUSED from lib/avatar_state — this module just translates those into the named blendshape weights the
 * three-vrm `expressionManager` expects (happy/relaxed/sad/angry/surprised, the `aa` mouth viseme, blink).
 *
 * Gate-covered offline (no three, no WebGL). renderer/avatar_vrm.js applies these weights to the loaded
 * character every frame. Keeping the mapping here means the visual layer is swappable (VRM today, anything
 * later) without touching the tested mood/lip-sync math.
 */
'use strict';
const AS = require('./avatar_state');

// VRM 1.0 preset expression names three-vrm normalizes to (VRM 0.x joy/sorrow/fun/a/blink map onto these).
const VRM_EMOTIONS = ['happy', 'relaxed', 'sad', 'angry', 'surprised'];

// her 5 mood buckets (from avatar_state) → a VRM emotion + intensity. `neutral` applies no emotion weight.
// `thinking`/`tired` have no direct VRM emotion; we lean relaxed (calm/soft) and let the renderer add gaze.
const MOOD_TO_VRM = {
  happy:    { emotion: 'happy',   weight: 0.85 },
  warm:     { emotion: 'relaxed', weight: 0.70 },
  thinking: { emotion: 'neutral', weight: 0.00 },
  tired:    { emotion: 'relaxed', weight: 0.40 },
  neutral:  { emotion: 'neutral', weight: 0.00 },
};

// pure: her mood `feeling` text → { mood, emotion, weights } where weights is the full VRM emotion set
// (all listed, inactive ones 0) so the renderer can lerp toward it without leftover state from a prior mood.
function expressionWeights(feeling) {
  const mood = AS.moodToExpression(feeling);
  const map = MOOD_TO_VRM[mood] || MOOD_TO_VRM.neutral;
  const weights = {};
  for (const e of VRM_EMOTIONS) weights[e] = 0;
  if (map.emotion !== 'neutral' && Object.prototype.hasOwnProperty.call(weights, map.emotion)) {
    weights[map.emotion] = map.weight;
  }
  return { mood, emotion: map.emotion, weights };
}

// pure: audio loudness (0..1 RMS) → the `aa` mouth-open viseme weight, smoothed by the same attack/decay
// envelope as the 2D rig (reused from avatar_state). Returns { aa } — the weight object to set on the VRM.
function viseme(rms, prev = 0, opts = {}) {
  return { aa: AS.amplitudeToMouth(rms, prev, opts) };
}

// pure: the VRM `blink` weight (0 open .. 1 fully shut) at time nowMs — inverse of avatar_state's eyelid
// multiplier, renormalized so a blink reaches a full closed 1. Deterministic; `phase` desyncs faces.
function blinkWeight(nowMs, opts = {}) {
  const mult = AS.blinkMultiplier(nowMs, opts);   // 1 open .. ~0.1 shut
  return Math.max(0, Math.min(1, (1 - mult) / 0.9));
}

module.exports = { expressionWeights, viseme, blinkWeight, VRM_EMOTIONS, MOOD_TO_VRM };
