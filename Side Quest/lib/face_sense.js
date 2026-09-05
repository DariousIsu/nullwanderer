'use strict';
/*
 * lib/face_sense.js — THE CAMERA SENSE (the wants project, cut 13; W6 "see his face, look him in the eye";
 * his word 09-05: "use the camera to look at me, see if I am in the room, read my body language and face").
 *
 * A READING, never a rule: { present, is_him, looking_at_screen, gaze:{x,y}, expression, note, confidence,
 * faces, at }. The renderer samples a small frame on HIS switch (a lever, per session, default off, with an
 * on-air indicator) and hands it here over IPC as base64; nothing is ever written to disk (a pin greps for
 * it). The local pass is the resident face sidecar (insightface, CPU): is a face present, is it him (ONE
 * enrollment of his face as a vector in meta, never an image — anyone else reads as present and not him,
 * never identified), is he turned to the screen (from the five keypoints: the nose against the eye line),
 * and where the face sits (the gaze target for her avatar). Expressions and body language are a second
 * switch's reading: a cloud vision description on a slow cadence, logged on every use (his word tonight
 * turned that switch on; meta camera.describe = '0' turns it off).
 * Pure decisions with injected readers; the orchestration (onFrame) takes deps so the smoke runs offline.
 * Kill switch ZOE_FACE_SENSE=0. Meeting camera-off rail untouched (a pin asserts the join code still does).
 */
const OWNER_KEY = 'face.owner_embedding';
const FACE_KEY = 'presence.face';
const SAME_FACE_THRESHOLD = 0.40;     // webcam frame vs his enrollment (same camera, same light) — a touch looser than the Puller's 0.45
const MIN_FRAME_GAP_MS = 1500;
const FRESH_MS = 12000;               // a reading older than this is not "now"
const EXPRESSIONS = ['neutral', 'focused', 'happy', 'amused', 'tired', 'frustrated', 'sad', 'surprised', 'thinking'];
const DESCRIBE_PROMPT = 'This is one frame from a webcam of a person at a computer. In ONE line under 20 words, describe their facial expression and body language concretely (posture, gaze, mouth, brow). Then on a second line write exactly one word from this list that fits best: ' + EXPRESSIONS.join(', ') + '.';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}

/** Is the face turned to the screen? From insightface's five keypoints [leftEye, rightEye, nose, leftMouth, rightMouth]. */
function lookingFromKps(kps) {
  if (!Array.isArray(kps) || kps.length < 5) return null;
  const [le, re, nose, lm, rm] = kps;
  const eyeMidX = (le[0] + re[0]) / 2, eyeMidY = (le[1] + re[1]) / 2;
  const interEye = Math.abs(re[0] - le[0]);
  if (interEye < 4) return null;
  const yaw = (nose[0] - eyeMidX) / interEye;                       // 0 = frontal; ±0.5 = well turned
  const mouthMidY = (lm[1] + rm[1]) / 2;
  const span = mouthMidY - eyeMidY;
  const pitch = span > 1 ? (nose[1] - eyeMidY) / span : 0.55;      // ~0.5–0.65 frontal; low = looking up, high = down
  return { looking: Math.abs(yaw) < 0.35 && pitch > 0.3 && pitch < 0.8, yaw: +yaw.toFixed(3), pitch: +pitch.toFixed(3) };
}

/** Where the face sits in the frame → a gaze target in −1..1 (x right, y down), clamped. */
function gazeFromBox(box, img) {
  if (!Array.isArray(box) || box.length < 4 || !Array.isArray(img) || !img[0] || !img[1]) return null;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  return { x: +clamp((cx / img[0]) * 2 - 1, -0.9, 0.9).toFixed(3), y: +clamp((cy / img[1]) * 2 - 1, -0.9, 0.9).toFixed(3) };
}

/** The pure reading from one sidecar result (the largest face) + his enrollment. */
function readingFrom(result, { owner = null, threshold = SAME_FACE_THRESHOLD, now = Date.now() } = {}) {
  const r = result || null;
  if (!r || !r.ok) return { present: false, is_him: false, looking_at_screen: false, gaze: null, confidence: 0, faces: (r && r.faces) || 0, at: now, reason: (r && r.reason) || 'no-result' };
  const sim = owner ? cosine(r.embedding, owner) : null;
  const look = lookingFromKps(r.kps);
  return {
    present: true,
    is_him: owner ? sim >= threshold : null,              // null = no enrollment yet (unknown, never asserted)
    looking_at_screen: look ? look.looking : null,
    yaw: look ? look.yaw : null,
    gaze: gazeFromBox(r.box, r.img),
    confidence: owner ? +sim.toFixed(3) : +(Number(r.det) || 0).toFixed(3),
    faces: Number(r.faces) || 1,
    at: now,
  };
}

/** Did the reading change in a way worth an event? (presence, identity, attention, expression) */
function changed(prev, next) {
  if (!prev) return true;
  return prev.present !== next.present || prev.is_him !== next.is_him || prev.looking_at_screen !== next.looking_at_screen || (prev.expression || null) !== (next.expression || null);
}

/** Parse the cloud description → { note, expression }. The last word-line wins; an unknown word → null. */
function parseDescribe(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return { note: null, expression: null };
  let expression = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const w = lines[i].toLowerCase().replace(/[^a-z]/g, '');
    if (EXPRESSIONS.includes(w)) { expression = w; lines.splice(i, 1); break; }
  }
  return { note: lines.join(' ').slice(0, 200) || null, expression };
}

/** One sentence for her manifest, in the second person about him — a reading she may answer, never a rule. */
function line(reading, { now = Date.now(), name = 'Lucas' } = {}) {
  if (!reading || !reading.at || now - reading.at > FRESH_MS) return null;
  if (!reading.present) return `Camera: no one is in front of the camera right now.`;
  const who = reading.is_him === true ? `${name} is in the room` : reading.is_him === false ? 'someone (not enrolled as him) is in front of the camera' : 'a face is in front of the camera (no enrollment yet — ask him to tap "that\'s me")';
  const look = reading.looking_at_screen === true ? 'looking at the screen' : reading.looking_at_screen === false ? 'turned away from the screen' : null;
  const expr = reading.expression ? `his face reads ${reading.expression}${reading.note ? ` — ${reading.note}` : ''}` : null;
  return `Camera: ${[who, look, expr].filter(Boolean).join('; ')}.`;
}

// ── the organ (state + doors), deps-injected ─────────────────────────────────────────────────────────
let _last = null, _lastLogAt = 0, _lastFrameAt = 0, _lastDescribeAt = 0, _describing = false, _lastPersistAt = 0;
function current() { return _last; }
function _db(deps) { return deps.db || require('./db'); }
function owner(deps = {}) { try { const v = _db(deps).getMeta(OWNER_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }
function enabled() { return process.env.ZOE_FACE_SENSE !== '0'; }

/** Enroll HIS face: the largest face in this frame becomes his embedding (a vector, never an image). */
async function enroll(frameB64, { deps = {} } = {}) {
  if (!enabled()) return { ok: false, error: 'ZOE_FACE_SENSE=0' };
  const embed = deps.embed || ((items) => require('./face_match').resident().embed(items));
  const res = await embed([{ id: 'enroll', b64: frameB64 }]);
  const r = res && res.ok && res.results && res.results[0];
  if (!r || !r.ok) return { ok: false, error: (r && r.reason) || (res && res.error) || 'no face' };
  if (r.faces > 1) return { ok: false, error: `${r.faces} faces in the frame — enroll with only you in front of the camera` };
  try { _db(deps).setMeta(OWNER_KEY, JSON.stringify(r.embedding)); } catch (e) { return { ok: false, error: e.message }; }
  (deps.log || console.log)('[face] enrolled his face (a 512-d vector in meta; no image kept)');
  return { ok: true, faces: r.faces };
}

/**
 * One frame from the sampler. Throttled; the local pass every frame, the cloud description on its own slow
 * cadence when a face is present and the switch is on. Persists the reading (throttled), emits on change,
 * hands the gaze to the avatar. Never throws; never writes a frame anywhere.
 */
async function onFrame(frameB64, { deps = {} } = {}) {
  if (!enabled()) return { ok: false, error: 'ZOE_FACE_SENSE=0' };
  const now = deps.now || Date.now();
  if (now - _lastFrameAt < (deps.minGapMs || MIN_FRAME_GAP_MS)) return { ok: false, skipped: 'throttled' };
  _lastFrameAt = now;
  const db = _db(deps);
  const embed = deps.embed || ((items) => require('./face_match').resident().embed(items));
  let res = null;
  try { res = await embed([{ id: 'f', b64: frameB64 }]); } catch (e) { res = { ok: false, error: e.message }; }
  const r = res && res.ok && res.results && res.results[0];
  const reading = readingFrom(r || { ok: false, reason: (res && res.error) || 'sidecar' }, { owner: owner(deps), now });
  // the expression: the cloud read on a slow cadence, only for a present face, only with the switch on
  let describeOn = true; try { describeOn = db.getMeta('camera.describe') !== '0'; } catch {}
  const everyMs = Number((() => { try { return db.getMeta('camera.describe_every_ms'); } catch { return null; } })()) || 20000;
  if (reading.present && describeOn && !_describing && now - _lastDescribeAt >= everyMs) {
    _describing = true; _lastDescribeAt = now;
    const describe = deps.describe || ((b64) => require('./vision').describe({ imageBase64: b64, prompt: DESCRIBE_PROMPT }));
    Promise.resolve().then(() => describe(frameB64)).then((d) => {
      _describing = false;
      if (!d || !d.ok) { (deps.log || console.log)(`[face] describe(cloud) failed: ${(d && d.reason) || 'no answer'}`); return; }
      const parsed = parseDescribe(d.text);
      (deps.log || console.log)(`[face] describe(cloud, ${d.model || 'vision'}) → ${parsed.expression || '?'}: ${parsed.note || ''}`);   // every use is logged (the privacy law)
      if (_last) { const next = { ..._last, expression: parsed.expression, note: parsed.note, describedAt: Date.now() }; const ch = changed(_last, next); _last = next; _persist(db, next, true); if (ch) _emit(deps, next); }
    }).catch((e) => { _describing = false; (deps.log || console.log)(`[face] describe(cloud) threw: ${e.message}`); });
  } else if (_last && _last.expression && now - (_last.describedAt || 0) < everyMs * 3) {
    reading.expression = _last.expression; reading.note = _last.note; reading.describedAt = _last.describedAt;   // carry a recent read
  }
  const ch = changed(_last, reading);
  _last = reading;
  _persist(db, reading, ch);
  if (ch || now - _lastLogAt > 30000) {
    _lastLogAt = now;
    (deps.log || console.log)(`[face] present=${reading.present ? 1 : 0} him=${reading.is_him === null ? '?' : reading.is_him ? 1 : 0} looking=${reading.looking_at_screen === null ? '?' : reading.looking_at_screen ? 1 : 0} expr=${reading.expression || '-'} (${reading.confidence}) faces=${reading.faces}`);
  }
  if (ch) _emit(deps, reading);
  if (reading.gaze && deps.onGaze) { try { deps.onGaze(reading.gaze); } catch {} }
  return { ok: true, reading, changed: ch };
}
function _persist(db, reading, force) {
  const now = Date.now();
  if (!force && now - _lastPersistAt < 30000) return;
  _lastPersistAt = now;
  try { db.setMeta(FACE_KEY, JSON.stringify(reading)); } catch {}
}
function _emit(deps, reading) {
  try {
    const bus = deps.obsBus || require('./obs_bus');
    bus.emit({ lane: 'presence', kind: 'face', text: line(reading, { now: reading.at }) || 'camera reading', data: { present: reading.present, is_him: reading.is_him, looking: reading.looking_at_screen, expression: reading.expression || null } });
  } catch {}
}
/**
 * HER VERB (Lucas 2026-09-05, "the concept of the camera switch seems counterintuitive"): <look/> — look
 * through the camera now. Answers the current reading and asks the next frame for a closer (cloud)
 * read of his expression. The hardware stays his lever: with the camera off she is told so, honestly.
 */
function look({ deps = {}, now = Date.now() } = {}) {
  if (!enabled()) return { ok: false, text: 'The camera sense is switched off (ZOE_FACE_SENSE=0) — you cannot look.' };
  const cameraLive = _lastFrameAt && now - _lastFrameAt < 10000;
  if (!cameraLive) return { ok: false, text: 'The camera is off right now (the 📷 switch is his) — you cannot look until it is on.' };
  _lastDescribeAt = 0;   // the next frame earns a closer read
  const l = line(_last || stored(deps), { now });
  return { ok: true, text: l ? `You look: ${l.replace(/^Camera: /, '')} A closer read of his expression lands in your next turn.` : 'You look: no reading yet — the next frame brings one.' };
}
/** The status door for the renderer's nudge: is his face enrolled; is a frame arriving. */
function status({ deps = {}, now = Date.now() } = {}) {
  return { enrolled: !!owner(deps), live: !!(_lastFrameAt && now - _lastFrameAt < 10000), reading: _last };
}

/** The stored reading (for a fresh process / the presence fuse). */
function stored(deps = {}) { try { const v = _db(deps).getMeta(FACE_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }
function awarenessLine({ deps = {}, now = Date.now() } = {}) { return line(_last || stored(deps), { now }); }
function _reset() { _last = null; _lastLogAt = 0; _lastFrameAt = 0; _lastDescribeAt = 0; _describing = false; _lastPersistAt = 0; }

module.exports = { readingFrom, lookingFromKps, gazeFromBox, changed, parseDescribe, line, cosine, enroll, onFrame, look, status, current, stored, owner, awarenessLine, enabled,
  OWNER_KEY, FACE_KEY, SAME_FACE_THRESHOLD, FRESH_MS, EXPRESSIONS, DESCRIBE_PROMPT, _reset };
