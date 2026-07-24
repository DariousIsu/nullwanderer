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

// What the deterministic layer already does. Also the answer whenever the model is unavailable or wrong.
const FALLBACK = { hear: 'listen', say: 'speak', think: 'think' };

// Small + cheap by design. Overridable so the fleet can be re-pointed without a code edit.
function directorModel() {
  return process.env.ZOE_AVATAR_MODEL || process.env.ZOE_EXTRACT_MODEL || 'gemma4:31b-cloud';
}

function buildMessages({ kind, text, clips, mood }) {
  const menu = clips.join(', ');
  const said = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return [
    { role: 'system', content:
      'You choose body language for an avatar. Reply with ONE line of JSON and nothing else:\n' +
      '{"clip":"<name>","intensity":<0..1>,"hold":<seconds 1-8>}\n' +
      'clip MUST be exactly one of: ' + menu + '\n' +
      'Guidance: pick the variant that fits the CONTENT, not just the event. Emphatic for strong or ' +
      'surprising material, soft for tentative or uncertain, lean for genuine interest, deep for a hard ' +
      'problem. Use nod/shake/perk only as a brief reaction. Prefer subtle; she is a calm presence.' },
    { role: 'user', content:
      'event: ' + String(kind || 'idle') + (mood ? ('\nmood: ' + mood) : '') +
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
async function chooseClip({ kind, text, clips, mood, model, timeoutMs = 4000 } = {}) {
  const menu = Array.isArray(clips) && clips.length ? clips : Object.values(FALLBACK);
  const safe = (why) => ({ clip: FALLBACK[kind] || 'idle', intensity: 0.6, hold: 4, source: 'fallback', why });
  if (!menu.includes(FALLBACK[kind] || 'idle') && !menu.length) return safe('no-menu');
  let raw;
  try {
    raw = await complete({
      model: model || directorModel(),
      messages: buildMessages({ kind, text, clips: menu, mood }),
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

module.exports = { chooseClip, parseChoice, buildMessages, directorModel, FALLBACK };
