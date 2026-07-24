'use strict';
/*
 * Gate for the MOUTH — that it opens AND closes while she speaks.
 *
 * Two real defects sat here at once and neither was visible by reading the code:
 *   1. updateFace() returned early on !FACE_ON — a toggle belonging to the PAINTED CLOUD face, default OFF —
 *      before computing face.mouthOpen, which is what the VRM's viseme is driven from. The model blinked
 *      (that clock is inline) and never opened its mouth at all.
 *   2. Once that was fixed the mouth was PINNED at 0.79-0.95: the synthetic envelope carried a 0.30 floor and
 *      was then run through the wav path's gain, so it could never close. A jaw hanging open, not speech.
 *
 * "It moves" is therefore not the assertion worth making — the broken version moved too. This asserts the
 * shape: real closes between syllables, at a plausible rate. Envelope + smoothing are lifted from the real
 * renderer source so the numbers here are the ones that ship.
 */
const fs = require('fs');
const path = require('path');
const AS = require('../lib/avatar_state');

let fail = 0;
const ok = (cond, label, extra) => { if (!cond) { console.log('FAIL:', label, extra == null ? '' : JSON.stringify(extra)); fail++; } };

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'kg3d.js'), 'utf8');

// ---- DEFECT 1: the state must be computed regardless of the painted-face toggle.
const fStart = src.indexOf('function updateFace(now)');
let depth = 0, fEnd = -1;
for (let i = src.indexOf('{', fStart); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { fEnd = i + 1; break; } }
}
ok(fStart > 0 && fEnd > fStart, 'brace-matched updateFace out of the renderer', { fStart, fEnd });
const body = src.slice(fStart, fEnd);
const iMouth = body.indexOf('face.mouthOpen =');
const iGate = body.indexOf('if (!FACE_ON)');
ok(iMouth > 0 && iGate > 0, 'found both the mouth assignment and the FACE_ON gate');
ok(iMouth < iGate, 'mouth state is computed BEFORE the painted-face gate (the VRM reads it)', { iMouth, iGate });

// ---- lift the shipped envelope + smoothing constants out of the source, so this can never drift from them
const envM = src.match(/rms = ([\d.]+) \* Math\.abs\(Math\.sin\(t \* ([\d.]+)\)\) \* \(([\d.]+) \+ ([\d.]+) \* Math\.abs\(Math\.sin\(t \* ([\d.]+) \+ ([\d.]+)\)\)\)/);
ok(!!envM, 'lifted the speech envelope from the renderer');
const smM = src.match(/smooth = \{ attack: ([\d.]+), decay: ([\d.]+) \}/);
ok(!!smM, 'lifted the synthetic smoothing profile from the renderer');

if (envM && smM) {
  const [, A, RATE, B, C, W, PH] = envM.map(Number);
  const smooth = { attack: Number(smM[1]), decay: Number(smM[2]) };
  const env = (t) => A * Math.abs(Math.sin(t * RATE)) * (B + C * Math.abs(Math.sin(t * W + PH)));

  // ---- the envelope itself must be able to reach silence. A floor here is defect 2 by construction.
  let envMin = Infinity;
  for (let i = 0; i < 600; i++) envMin = Math.min(envMin, env(i / 120));
  ok(envMin < 0.02, 'envelope reaches silence between syllables (no floor)', envMin);

  // ---- run it through the SHARED mouth curve at 60fps and look at the shape
  const s = [];
  let m = 0;
  for (let i = 0; i < 180; i++) { s.push(m); m = AS.amplitudeToMouth(env(i / 60), m, smooth); }
  const t = s.slice(30);                      // skip the onset ramp
  const peak = Math.max.apply(null, t), min = Math.min.apply(null, t);
  let cycles = 0, open = false;
  for (const v of t) { if (!open && v > 0.45) open = true; else if (open && v < 0.15) { open = false; cycles++; } }

  ok(peak > 0.75, 'mouth opens properly', peak);
  ok(min < 0.15, 'mouth CLOSES between syllables — the pinned-open defect', min);
  ok(peak - min > 0.6, 'full range of motion, not a twitch', peak - min);
  const perSec = cycles / 2.5;
  ok(perSec >= 2 && perSec <= 6, 'syllable rate is conversational (2-6/sec)', perSec);
  ok(t.every((v) => Number.isFinite(v) && v >= 0 && v <= 1), 'every value finite and in range');

  // ---- and the regression it replaced must actually fail these, or the gate proves nothing
  const oldEnv = (x) => 0.30 + 0.34 * Math.abs(Math.sin(x * 14.5)) * (0.6 + 0.4 * Math.abs(Math.sin(x * 2.3 + 1.1)));
  let om = 0; const os = [];
  for (let i = 0; i < 180; i++) { os.push(om); om = AS.amplitudeToMouth(oldEnv(i / 60), om); }
  const oMin = Math.min.apply(null, os.slice(30));
  ok(oMin > 0.15, 'NON-VACUOUS: the old envelope would fail the closes-check', oMin);
}

console.log(fail ? `\n${fail} FAILURES` : '\nPASS — mouth state survives the painted-face toggle, and she opens AND closes at a conversational rate');
process.exit(fail ? 1 : 0);
