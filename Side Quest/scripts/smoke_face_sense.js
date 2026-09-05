/* smoke_face_sense.js — THE CAMERA SENSE (the wants project, cut 13; 2026-09-05).
 *
 * Pins: enroll then read with two embeddings — only his reads as him, a stranger reads present and not
 * him (never identified); the attention read from the five keypoints; the gaze follows the face and
 * clamps; an event fires once per change, not per frame; the cloud description parses and is logged on
 * every use; the reading updates presence; no frame is ever written (a grep over renderer/ and lib/);
 * the meeting camera-off rail is untouched; the switches default as designed. Offline: the sidecar and
 * the vision call are injected.
 */
'use strict';
const fs = require('fs'), path = require('path');
const LIB = process.env.SQ_MOD_DIR || path.join(__dirname, '..', 'lib');
const FS = require(path.join(LIB, 'face_sense'));
const PS = require(path.join(LIB, 'presence_state'));

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const vec = (seed) => { let s = seed * 2654435761 >>> 0; return Array.from({ length: 512 }, () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296 - 0.5; }); };   // independent pseudo-random vectors (cosine ≈ 0)
const HIM = vec(1), STRANGER = vec(9);
const kpsFrontal = [[120, 90], [180, 90], [150, 120], [128, 150], [172, 150]];
const kpsTurned = [[120, 90], [180, 90], [200, 120], [128, 150], [172, 150]];
const kpsDown = [[120, 90], [180, 90], [150, 160], [128, 170], [172, 170]];
const face = (emb, kps = kpsFrontal, box = [100, 60, 200, 180]) => ({ id: 'f', ok: true, embedding: emb, faces: 1, box, kps, img: [320, 240], det: 0.9 });

// ── pure readings ─────────────────────────────────────────────────────────────────────────────────
ok(FS.lookingFromKps(kpsFrontal).looking === true && FS.lookingFromKps(kpsTurned).looking === false && FS.lookingFromKps(kpsDown).looking === false, 'attention from the keypoints: frontal looks at the screen; turned or looking down does not');
ok(FS.lookingFromKps(null) === null && FS.lookingFromKps([[1, 1]]) === null, 'no keypoints → unknown, never a guess');
const g = FS.gazeFromBox([100, 60, 200, 180], [320, 240]);
ok(g && Math.abs(g.x - (-0.0625)) < 0.01 && g.y === 0, `the gaze target is the face's position in the frame (${JSON.stringify(g)})`);
ok(FS.gazeFromBox([300, 0, 340, 40], [320, 240]).x === 0.9 && FS.gazeFromBox([-40, 220, 0, 260], [320, 240]).y === 0.9, 'the gaze clamps at ±0.9');
const r1 = FS.readingFrom(face(HIM), { owner: HIM, now: 1000 });
ok(r1.present && r1.is_him === true && r1.looking_at_screen === true && r1.confidence > 0.99 && r1.gaze, `enrolled + his face → present, him, looking (${r1.confidence})`);
const r2 = FS.readingFrom(face(STRANGER), { owner: HIM, now: 1000 });
ok(r2.present && r2.is_him === false && r2.confidence < 0.4, `a stranger → present, NOT him, never identified (${r2.confidence})`);
const r3 = FS.readingFrom(face(HIM), { owner: null, now: 1000 });
ok(r3.present && r3.is_him === null, 'no enrollment yet → is_him unknown (null), never asserted');
const r4 = FS.readingFrom({ ok: false, reason: 'no-face', faces: 0 }, { owner: HIM, now: 1000 });
ok(!r4.present && r4.is_him === false && r4.gaze === null, 'no face → not present');
ok(FS.changed(null, r1) && FS.changed(r1, r2) && !FS.changed(r1, { ...r1, confidence: 0.5, gaze: { x: 0.2, y: 0 } }) && FS.changed(r1, { ...r1, expression: 'amused' }), 'changed(): presence, identity, attention, expression — not confidence or gaze');
const pd = FS.parseDescribe('Leaning back, arms crossed, brow slightly furrowed, eyes on the screen.\nFocused');
ok(pd.expression === 'focused' && /arms crossed/.test(pd.note), 'the cloud description parses into a note + one expression word');
ok(FS.parseDescribe('Smiling broadly.\nEcstatic').expression === null && FS.parseDescribe('').expression === null, 'an off-list word or nothing → no expression');
ok(/Lucas is in the room; looking at the screen/.test(FS.line(r1, { now: 2000 })) && /someone \(not enrolled/.test(FS.line(r2, { now: 2000 })) && /no one is in front/.test(FS.line(r4, { now: 2000 })) && FS.line(r1, { now: 1000 + FS.FRESH_MS + 1 }) === null, 'the manifest line reads the state in the second person and goes stale honestly');
ok(/no enrollment yet/.test(FS.line(r3, { now: 2000 })), 'without an enrollment the line asks for the tap');

// ── the organ, offline ────────────────────────────────────────────────────────────────────────────
(async () => {
  const meta = {}; const db = { getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } };
  const logs = [], events = [], gazes = [];
  const bus = { emit: (e) => events.push(e) };
  const mk = (emb, kps) => async () => ({ ok: true, results: [face(emb, kps)] });
  FS._reset();
  const en = await FS.enroll('data:image/jpeg;base64,xxx', { deps: { db, embed: mk(HIM), log: (m) => logs.push(m) } });
  ok(en.ok && JSON.parse(meta[FS.OWNER_KEY]).length === 512 && /no image kept/.test(logs.join(' ')), 'enroll stores a 512-d vector in meta — never an image');
  const two = await FS.enroll('x', { deps: { db, embed: async () => ({ ok: true, results: [{ ...face(HIM), faces: 2 }] }), log: () => {} } });
  ok(!two.ok && /2 faces/.test(two.error), 'enrollment refuses a frame with two faces');
  let t = 100000;   // past the describe cadence (20 s) so the first present frame earns a cloud read
  const deps = () => ({ db, embed: mk(HIM), obsBus: bus, log: (m) => logs.push(m), now: t, onGaze: (gz) => gazes.push(gz), describe: async () => ({ ok: true, text: 'Leaning in, eyes on the screen, slight smile.\nFocused', model: 'vision-test' }) });
  const f1 = await FS.onFrame('frame', { deps: deps() });
  ok(f1.ok && f1.reading.is_him === true && f1.changed === true && events.length === 1 && events[0].lane === 'presence' && events[0].kind === 'face', 'the first frame reads him and emits ONE presence/face event');
  t += 100; const f2 = await FS.onFrame('frame', { deps: deps() });
  ok(!f2.ok && f2.skipped === 'throttled', 'frames closer than the gap are dropped (throttle)');
  await new Promise((r) => setTimeout(r, 20));   // the cloud read resolves (a microtask chain) — before any later frame
  ok(FS.current().expression === 'focused' && logs.some((l) => /describe\(cloud, vision-test\) → focused/.test(l)), 'the cloud read lands as the expression and every use is LOGGED');
  ok(events.length === 2 && events[1].data.expression === 'focused', 'the expression change emits once');
  t += 2000; const evBefore = events.length; const f3 = await FS.onFrame('frame', { deps: deps() });
  ok(f3.ok && f3.changed === false && events.length === evBefore && FS.current().expression === 'focused', 'an unchanged reading emits nothing (once per change, not per frame) and carries the recent expression');
  t += 2000; const f4 = await FS.onFrame('frame', { deps: { ...deps(), embed: mk(STRANGER) } });
  ok(f4.reading.is_him === false && f4.changed && events.length === 3, 'a stranger replaces him → a change event');
  ok(gazes.length >= 2 && gazes.every((gz) => Math.abs(gz.x) <= 0.9), 'the gaze target is handed to the avatar every frame');
  ok(JSON.parse(meta[FS.FACE_KEY]).present === true, 'the reading persists to meta presence.face');
  meta['camera.describe'] = '0'; const before = logs.filter((l) => /describe\(cloud/.test(l)).length;
  t += 60000; await FS.onFrame('frame', { deps: deps() }); await new Promise((r) => setTimeout(r, 20));
  ok(logs.filter((l) => /describe\(cloud/.test(l)).length === before, 'camera.describe=0 → no cloud read');
  process.env.ZOE_FACE_SENSE = '0';
  ok(!(await FS.onFrame('frame', { deps: deps() })).ok && !(await FS.enroll('x', { deps: deps() })).ok, 'ZOE_FACE_SENSE=0 reads nothing and enrolls nothing');
  delete process.env.ZOE_FACE_SENSE;

  // ── presence consumes the reading ─────────────────────────────────────────────────────────────
  const now = 500000;
  const fresh = { present: true, is_him: true, looking_at_screen: true, at: now - 1000 };
  ok(PS.fuse({ now, lastUserTurnTs: now - 3 * 3600e3, face: fresh }).state === 'here' && /camera: him, looking/.test(PS.fuse({ now, lastUserTurnTs: now - 3 * 3600e3, face: fresh }).reason), 'the camera (him, fresh) says HERE even after hours of idle keyboard');
  ok(PS.fuse({ now, lastUserTurnTs: now - 3 * 3600e3, face: { ...fresh, at: now - 60000 } }).state === 'away', 'a stale camera reading does not count');
  ok(PS.fuse({ now, lastUserTurnTs: now - 60000, face: { present: false, at: now - 1000 } }).state === 'here' && PS.fuse({ now, lastUserTurnTs: now - 3 * 3600e3, face: { present: false, at: now - 1000 } }).state === 'away', 'no face: recent keys = here, long idle = away');

  // ── privacy in code ───────────────────────────────────────────────────────────────────────────
  const root = path.join(__dirname, '..');
  const scan = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; } };
  const faceSrc = fs.readFileSync(path.join(LIB, 'face_sense.js'), 'utf8');
  ok(!/writeFileSync|createWriteStream|appendFileSync/.test(faceSrc), 'face_sense never writes a file (no frame persists)');
  const chat = scan('renderer/chat.js');
  const camSection = chat.slice(chat.indexOf('THE CAMERA SENSE'), chat.indexOf('THE CAMERA SENSE') + 6000);
  ok(camSection.length > 100 && !/toBlob|download|localStorage\.setItem\([^)]*frame|indexedDB|writeFile/.test(camSection), 'the renderer sampler never stores a frame');
  ok(/camera-off|camera OFF|Turn camera off/i.test(scan('lib/teams_canvas.js')) && /camera/i.test(scan('lib/meet_canvas.js')), 'the meeting camera-off rail is untouched');
  ok(/cameraOn = false|let cameraOn = false/.test(camSection) && /on-air|onair/i.test(camSection), 'the switch defaults OFF per session and an on-air indicator exists');
  // ── the resident sidecar client over a fake child (NDJSON in/out, resolved by id, fail-soft) ───────
  const { EventEmitter } = require('events'); const { PassThrough } = require('stream');
  const FM = require(path.join(LIB, 'face_match'));
  const spawned = [];
  const fakeSpawn = () => { const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kill = () => { c.killed = true; c.emit('exit', 0); }; c.stdin.on('data', (d) => { for (const line of d.toString().split('\n').filter(Boolean)) { const job = JSON.parse(line); c.lastJob = job; if (job.items[0] && job.items[0].b64 === 'slow') return; c.stdout.write(JSON.stringify({ ok: true, id: job.id, results: [{ id: 'f', ok: true, embedding: [1], faces: 1, box: [0, 0, 10, 10], img: [320, 240] }] }) + '\n'); } }); spawned.push(c); setTimeout(() => c.stdout.write('{"ok":true,"ready":true}\n'), 0); return c; };
  const res = FM.createResident({ spawnFn: fakeSpawn, wallMs: 60, idleMs: 80 });
  const e1 = await res.embed([{ id: 'f', b64: 'abc' }]);
  ok(e1.ok && e1.results[0].embedding[0] === 1 && spawned.length === 1 && spawned[0].lastJob.items[0].b64 === 'abc' && /--serve/.test('--serve'), 'the resident client spawns once, writes one JSON line per job, resolves the answer by id');
  const e2 = await res.embed([{ id: 'f', b64: 'def' }]);
  await new Promise((r) => setTimeout(r, 5));   // the fake's ready line rides a timer; let it land
  ok(e2.ok && spawned.length === 1 && res.alive() && res.isReady(), `a second job reuses the process (the model loads once) ${JSON.stringify({ ok: e2.ok, spawned: spawned.length, alive: res.alive(), ready: res.isReady() })}`);
  const slow = await res.embed([{ id: 'f', b64: 'slow' }]);
  ok(!slow.ok && slow.error === 'timeout', 'a job with no answer times out fail-soft');
  await new Promise((r) => setTimeout(r, 120));
  ok(!res.alive() && spawned[0].killed === true, 'idle → the process is stopped (RAM)');
  const e3 = await res.embed([{ id: 'f', b64: 'ghi' }]);
  ok(e3.ok && spawned.length === 2, 'the next job respawns it');
  const pendingP = res.embed([{ id: 'f', b64: 'slow' }]); spawned[1].emit('exit', 1);
  ok(!(await pendingP).ok && /exited/.test((await pendingP).error), 'a sidecar exit fails the pending job honestly');
  res.stop();
  console.log(`\nsmoke_face_sense: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
