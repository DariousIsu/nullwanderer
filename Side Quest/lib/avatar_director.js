'use strict';
/*
 * AVATAR DIRECTOR — lets a SMALL cloud model choose how her body moves.
 *
 * Lucas: "can we use one of the smaller cloud models for driving the avatar? like the gemma."
 * Yes, because the model's job here is deliberately tiny: it never touches a bone, a rotation or a frame. It
 * emits a CLIP NAME from a fixed menu. That is why a 12b is enough — the hard part (what the motion is) lives
 * in the clip data, and the model only decides WHICH and HOW MUCH.
 *
 * Three rules this module is built around, learned from the shape of the surface it drives:
 *
 *  1. NEVER IN THE CRITICAL PATH. A cloud call is ~1-3s; a body that reacts a second late reads as broken.
 *     The renderer already answers instantly from its deterministic map (hear→listen, say→speak). This runs
 *     ALONGSIDE and refines a beat later. So every failure mode here — timeout, bad JSON, model down — is
 *     harmless: the caller keeps the deterministic clip it already played.
 *  2. NEVER THROWS. A director that can crash the turn loop is worse than no director.
 *  3. THE MENU IS PASSED IN, not hardcoded. The renderer owns the clip list; this module must not drift from
 *     it. An unknown name coming back from the model is rejected against that list, never trusted.
 *
 * NOT WIRED YET, on purpose: the renderer cannot call models (preload exposes no LLM surface — chat:send is
 * the conversation path and would make her TALK). Driving this needs a main-side hook plus an IPC channel to
 * the kg3d webview, and main.js is another lane's actively-edited file. This module is self-contained and
 * committed so that hook is a few lines when we coordinate it.
 */

const { complete } = require('./ollama');
// The posture map is SHARED with the kg3d renderer (UMD, same trick as lib/avatar_state.js). It has to be one
// source: if main and the renderer each kept a copy, her body would eventually disagree with the log about
// what just happened. Everything about WHERE an answer came from lives there; this file only adds the model.
const { SOURCE_POSTURE, FALLBACK, postureFromTurn } = require('./avatar_posture');

/*
 * OPT-IN, and OFF by default — because the signal already decides.
 *
 * MEASURED 2026-07-23 on the real decision (4 turns, live models):
 *   cloud gemma4:31b   457-732ms   honored the posture exactly
 *   local gemma4:12b     1638ms    0/4 usable — restates the prompt as a bulleted analysis, never JSON,
 *                                  then truncates; at num_predict 400 it times out instead
 *   local hermes3:8b     1131ms    3/4 — and the miss OVERRODE a soft posture to emphatic on a freshly
 *                                  dug-up web fact, i.e. it made the one case it changed worse
 *   SIGNAL ALONE            0ms    4/4 (that gemma row IS the posture floor, with the model contributing
 *                                  nothing — it was right every time)
 *
 * Local is SLOWER than cloud here (it competes with the app for the GPU), so "use a small local model to
 * save the delay" does not hold. The delay is saved by not making the call. A model is now a refinement
 * you switch on, not a dependency in the path: set ZOE_AVATAR_MODEL to opt in.
 */
function directorModel() {
  return process.env.ZOE_AVATAR_MODEL || null;
}

function buildMessages({ kind, text, clips, mood, posture }) {
  const menu = clips.join(', ');
  const said = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return [
    { role: 'system', content:
      'You choose body language for an avatar. Reply with ONE line of JSON and nothing else:\n' +
      '{"clip":"<name>","intensity":<0..1>,"hold":<seconds 1-8>}\n' +
      'clip MUST be exactly one of: ' + menu + '\n' +
      'Guidance: pick the variant that fits the CONTENT, not just the event. Emphatic for strong or ' +
      'surprising material, soft for tentative or uncertain, lean for genuine interest, deep for a hard ' +
      'problem. Use nod/shake/perk only as a brief reaction. Prefer subtle; she is a calm presence.\n' +
      'If a suggested posture is given it comes from where the answer actually CAME FROM, which you cannot ' +
      'read off the wording — keep it unless the content clearly calls for another.' },
    { role: 'user', content:
      'event: ' + String(kind || 'idle') + (mood ? ('\nmood: ' + mood) : '') +
      (posture && posture.clip ? ('\nsuggested posture: ' + posture.clip + ' (' + posture.why + ')') : '') +
      (said ? ('\ncontent: "' + said + '"') : '') + '\nJSON:' },
  ];
}

// PURE, so it can be tested without a model running. Anything unparseable or off-menu returns null and the
// caller keeps its deterministic choice.
function parseChoice(raw, clips) {
  if (!raw || !Array.isArray(clips) || !clips.length) return null;
  const s = String(raw);
  // tolerate prose or fences around the object — small models wrap things
  const m = s.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[0]); } catch (e) { return null; }
  if (!o || typeof o !== 'object') return null;
  const clip = String(o.clip == null ? '' : o.clip).trim();
  if (!clips.includes(clip)) return null;                       // never trust an off-menu name
  let intensity = Number(o.intensity);
  if (!Number.isFinite(intensity)) intensity = 0.6;
  intensity = Math.max(0, Math.min(1, intensity));
  let hold = Number(o.hold);
  if (!Number.isFinite(hold)) hold = 4;
  hold = Math.max(1, Math.min(8, hold));
  return { clip, intensity, hold };
}

/*
 * Ask the model which clip to play. Resolves to a choice, or to the deterministic fallback — never rejects.
 * `clips` is the live menu from the renderer (__kg3d.anim().clips).
 */
async function chooseClip({ kind, text, clips, mood, turn, model, timeoutMs = 4000 } = {}) {
  const menu = Array.isArray(clips) && clips.length ? clips : Object.values(FALLBACK);
  // The posture from the cognition result outranks FALLBACK: it is what actually happened this turn, not a
  // guess keyed on the event name. Only fall back to the crude map when the turn told us nothing.
  const posture = postureFromTurn(Object.assign({ kind }, turn || {}));
  const floor = posture && menu.includes(posture.clip) ? posture.clip : (FALLBACK[kind] || 'idle');
  const safe = (why) => ({ clip: floor, intensity: 0.6, hold: 4, source: 'fallback', why });
  if (!menu.length) return safe('no-menu');
  // DECISIVE: an honest miss is a fact, not a reading. Spending a cloud call to second-guess it would only
  // add latency and a chance of being talked out of the truth.
  if (posture && posture.decisive && menu.includes(posture.clip)) {
    return { clip: posture.clip, intensity: 0.6, hold: 3, source: 'signal', why: posture.why };
  }
  // NO MODEL CONFIGURED = the normal case. The floor is already the posture the turn earned, so answering
  // from it costs 0ms and measured better than either local model. A call would only add latency and risk.
  const useModel = model || directorModel();
  if (!useModel) {
    return { clip: floor, intensity: 0.6, hold: 4, source: 'signal', why: (posture && posture.why) || 'no-model' };
  }
  let raw;
  try {
    raw = await complete({
      model: useModel,
      messages: buildMessages({ kind, text, clips: menu, mood, posture }),
      options: { temperature: 0.4, num_predict: 60 },
      timeoutMs,
    });
  } catch (e) {
    return safe('model-error:' + (e && e.message ? e.message.slice(0, 80) : 'unknown'));
  }
  const choice = parseChoice(raw, menu);
  if (!choice) return safe('unparseable');
  return Object.assign(choice, { source: 'model' });
}

module.exports = { chooseClip, parseChoice, buildMessages, postureFromTurn, directorModel, FALLBACK, SOURCE_POSTURE };
