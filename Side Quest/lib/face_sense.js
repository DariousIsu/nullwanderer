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
// THE DARK FRAME (09-06; his words: "The camera is still not seeing when I sit back down"): the machine's hard reset
// on 09-05 15:13 left the C920 un-enumerated on USB, a default getUserMedia picked a VIRTUAL source that streams
// black, and 18 hours of "frames, no face" read as "no one is in front of the camera" — her reach went to Discord
// while he sat at the desk. A frame whose mean luminance sits under this bar is DARK: it says nothing about who is
// there, and the line says so.
const DARK_MEAN = 8;
let _device = null;                   // what the renderer looks through — { label, absent, reason, at } — or null before it says
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

/** A black frame: the sidecar's mean luminance (0..255) under the dark bar. No mean → not known to be dark. */
function _dark(r) { const m = Number(r && r.mean); return Number.isFinite(m) && m < DARK_MEAN; }

/** The pure reading from one sidecar result (the largest face) + his enrollment. */
function readingFrom(result, { owner = null, threshold = SAME_FACE_THRESHOLD, now = Date.now() } = {}) {
  const r = result || null;
  if (!r || !r.ok) return { present: false, is_him: false, looking_at_screen: false, gaze: null, confidence: 0, faces: (r && r.faces) || 0, at: now, dark: _dark(r), reason: (r && r.reason) || 'no-result' };
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
    dark: false,
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
  if (!reading || !reading.at || now - reading.at > FRESH_MS) {
    // no fresh frame: when the renderer has said the camera is ABSENT, say that — never "no one is here"
    if (_device && _device.absent) return `Camera: none is connected right now (${_device.reason || 'no physical camera is enumerated'}) — I cannot see whether anyone is at the desk.`;
    return null;
  }
  if (reading.dark) return `Camera: dark — the lens shows only black (covered, unplugged, or a virtual source), so I cannot see whether anyone is at the desk.`;
  if (!reading.present) return `Camera: no one is in front of the camera right now.`;
  const who = reading.is_him === true ? `${name} is in the room` : reading.is_him === false ? 'someone (not enrolled as him) is in front of the camera' : 'a face is in front of the camera (no enrollment yet — ask him to tap "that\'s me")';
  const look = reading.looking_at_screen === true ? 'looking at the screen' : reading.looking_at_screen === false ? 'turned away from the screen' : null;
  const expr = reading.expression ? `his face reads ${reading.expression}${reading.note ? ` — ${reading.note}` : ''}` : null;
  return `Camera: ${[who, look, expr].filter(Boolean).join('; ')}.`;
}

// ── the organ (state + doors), deps-injected ─────────────────────────────────────────────────────────
let _last = null, _lastLogAt = 0, _lastFrameAt = 0, _lastDescribeAt = 0, _describing = false, _lastPersistAt = 0, _lastDarkLogAt = 0;
// THE CAMERA SWITCH A/B (his word 09-05 17:05: "we can give that a try"; the eval law: a model change is measured):
// while the face purpose model differs from the global vision model, the first AB_PAIRS reads of a boot go to BOTH,
// side by side in the log with the expression labels' agreement; the face model's line is the reading (the global's
// only when the face read failed). Then it stops and prints the tally. meta camera.describe_ab='0' turns it off.
const AB_PAIRS = 40;
let _abPairs = 0, _abAgree = 0;
function current() { return _last; }
function _db(deps) { return deps.db || require('./db'); }
function owner(deps = {}) { try { const v = _db(deps).getMeta(OWNER_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }
function enabled() { return process.env.ZOE_FACE_SENSE !== '0'; }

/**
 * THE REGISTER OF KNOWN PEOPLE (the stranger act, design §4.5b): faces she may recognize beyond his — enrolled
 * one at a time BY HIS WORD ("remember this face as Raegan, my kid"), never by her inference. meta face.people =
 * [{ name, relation, embedding, at }] (vectors, never images). A reading that is not him carries `known` = the
 * best match at or above the threshold, else null.
 */
const PEOPLE_KEY = 'face.people';
let _lastFrameB64 = null;
function people(deps = {}) { try { const v = _db(deps).getMeta(PEOPLE_KEY); const a = v ? JSON.parse(v) : []; return Array.isArray(a) ? a : []; } catch { return []; } }
function knownFrom(embedding, list, { threshold = SAME_FACE_THRESHOLD } = {}) {
  if (!embedding || !Array.isArray(list) || !list.length) return null;
  let best = null, bestSim = threshold - 1e-9;
  for (const p of list) { if (!p || !p.embedding) continue; const s = cosine(embedding, p.embedding); if (s >= bestSim) { bestSim = s; best = p; } }
  return best ? { name: best.name, relation: best.relation || null, sim: +bestSim.toFixed(3) } : null;
}
/** Enroll a person by his word from the last frame the camera saw (one face in frame). */
async function enrollPerson(name, relation = null, { deps = {} } = {}) {
  if (!enabled()) return { ok: false, error: 'ZOE_FACE_SENSE=0' };
  const nm = String(name || '').trim(); if (!nm) return { ok: false, error: 'no name' };
  const frame = deps.frameB64 || _lastFrameB64;
  if (!frame) return { ok: false, error: 'no recent frame — the camera has not seen anyone' };
  const embed = deps.embed || ((items) => require('./face_match').resident().embed(items));
  const res = await embed([{ id: 'enroll-person', b64: frame }]);
  const r = res && res.ok && res.results && res.results[0];
  if (!r || !r.ok) return { ok: false, error: (r && r.reason) || (res && res.error) || 'no face' };
  if (r.faces > 1) return { ok: false, error: `${r.faces} faces in the frame — enroll with one person in front of the camera` };
  const own = owner(deps);
  if (own && cosine(r.embedding, own) >= SAME_FACE_THRESHOLD) return { ok: false, error: 'that is you — a person must be someone else' };
  const list = people(deps).filter((p) => p && p.name && p.name.toLowerCase() !== nm.toLowerCase());
  list.push({ name: nm, relation: relation ? String(relation).trim() : null, embedding: r.embedding, at: deps.now || Date.now() });
  try { _db(deps).setMeta(PEOPLE_KEY, JSON.stringify(list)); } catch (e) { return { ok: false, error: e.message }; }
  (deps.log || console.log)(`[face] enrolled ${nm}${relation ? ` (${relation})` : ''} by his word — ${list.length} known (vectors only)`);
  return { ok: true, name: nm, relation: relation || null, known: list.length };
}

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
  _lastFrameB64 = frameB64;   // for an enrollment by his word ("remember this face as …"); never written anywhere
  const reading = readingFrom(r || { ok: false, reason: (res && res.error) || 'sidecar' }, { owner: owner(deps), now });
  if (reading.dark && now - _lastDarkLogAt > 10 * 60000) {
    _lastDarkLogAt = now;
    (deps.log || console.log)(`[face] CAMERA DARK — the frames are black (mean ${Number(r && r.mean).toFixed(1)}): a covered lens, an unplugged camera, or a virtual source; no presence is read from them`);
  }
  if (reading.present && reading.is_him === false) { const k = knownFrom(r && r.embedding, deps.people || people(deps)); reading.known = k ? k.name : null; reading.known_relation = k ? k.relation : null; }
  // the expression: the cloud read on a slow cadence, only for a present face, only with the switch on
  let describeOn = true; try { describeOn = db.getMeta('camera.describe') !== '0'; } catch {}
  const everyMs = Number((() => { try { return db.getMeta('camera.describe_every_ms'); } catch { return null; } })()) || 20000;
  if (reading.present && describeOn && !_describing && now - _lastDescribeAt >= everyMs) {
    _describing = true; _lastDescribeAt = now;
    const describe = deps.describe || ((b64, model) => require('./vision').describe({ imageBase64: b64, prompt: DESCRIBE_PROMPT, ...(model ? { model } : {}), lane: 'presence' }));
    const vm = deps.visionModels || (() => { try { const v = require('./vision'); return { face: v.visionModelFor('face').model, global: v.visionModel() }; } catch { return { face: null, global: null }; } })();
    const abLimit = Number(deps.abPairs) > 0 ? Number(deps.abPairs) : AB_PAIRS;
    let abOn = false; try { abOn = db.getMeta('camera.describe_ab') !== '0' && !!vm.face && !!vm.global && vm.face !== vm.global && _abPairs < abLimit; } catch {}
    Promise.resolve().then(() => describe(frameB64, vm.face || undefined)).then(async (d0) => {
      let d = d0;
      if (abOn) {
        let g = null; try { g = await describe(frameB64, vm.global); } catch (e) { g = { ok: false, reason: e.message }; }
        _abPairs++;
        const pf = d && d.ok ? parseDescribe(d.text) : null, pg = g && g.ok ? parseDescribe(g.text) : null;
        const agree = !!(pf && pg && pf.expression && pf.expression === pg.expression);
        if (agree) _abAgree++;
        (deps.log || console.log)(`[face] describe A/B ${_abPairs}/${abLimit} — face=${vm.face} "${pf ? `${pf.expression || '?'}: ${pf.note || ''}` : `failed (${(d && d.reason) || 'no answer'})`}" | global=${vm.global} "${pg ? `${pg.expression || '?'}: ${pg.note || ''}` : `failed (${(g && g.reason) || 'no answer'})`}" — ${agree ? 'AGREE' : 'differ'}`);
        try { (deps.obsBus || require('./obs_bus')).emit({ lane: 'presence', kind: 'face_ab', text: `${_abPairs}/${abLimit} ${agree ? 'agree' : 'differ'}`, data: { pair: _abPairs, agree, face: vm.face, global: vm.global, fexpr: pf ? pf.expression : null, gexpr: pg ? pg.expression : null } }); } catch {}
        if (_abPairs >= abLimit) (deps.log || console.log)(`[face] describe A/B done — ${_abAgree}/${abLimit} agreed on the expression label; the face read stays on ${vm.face} (meta model.vision.face decides; camera.describe_ab=0 silences the trial)`);
        if ((!d || !d.ok) && g && g.ok) d = g;   // the cheap read failed → the global's line is the reading this once
      }
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
    (deps.log || console.log)(`[face] present=${reading.present ? 1 : 0} him=${reading.is_him === null ? '?' : reading.is_him ? 1 : 0} looking=${reading.looking_at_screen === null ? '?' : reading.looking_at_screen ? 1 : 0} expr=${reading.expression || '-'} (${reading.confidence}) faces=${reading.faces}${reading.dark ? ' DARK' : ''}`);
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
  return { enrolled: !!owner(deps), live: !!(_lastFrameAt && now - _lastFrameAt < 10000), reading: _last, device: _device };
}
/** The renderer's word on the device the frames come from — { label, absent, reason } — or null to forget it. */
function setDevice(d) { _device = d ? { label: d.label || null, absent: !!d.absent, reason: d.reason || null, at: Date.now() } : null; }
function device() { return _device; }

/** The stored reading (for a fresh process / the presence fuse). */
function stored(deps = {}) { try { const v = _db(deps).getMeta(FACE_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }
function awarenessLine({ deps = {}, now = Date.now() } = {}) { return line(_last || stored(deps), { now }); }
function _reset() { _last = null; _lastLogAt = 0; _lastDarkLogAt = 0; _lastFrameAt = 0; _lastDescribeAt = 0; _describing = false; _lastPersistAt = 0; _abPairs = 0; _abAgree = 0; }

module.exports = { readingFrom, lookingFromKps, gazeFromBox, changed, parseDescribe, line, cosine, enroll, enrollPerson, people, knownFrom, onFrame, look, status, current, stored, owner, setDevice, device, DARK_MEAN, awarenessLine, enabled,
  OWNER_KEY, FACE_KEY, PEOPLE_KEY, SAME_FACE_THRESHOLD, FRESH_MS, EXPRESSIONS, DESCRIBE_PROMPT, AB_PAIRS, _reset };
