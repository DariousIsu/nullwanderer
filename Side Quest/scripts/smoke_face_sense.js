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
// ── ⭐ THE DARK FRAME (09-06): a black frame says nothing about who is there ──
const r5 = FS.readingFrom({ ok: false, reason: 'no-face', faces: 0, mean: 0.3 }, { owner: HIM, now: 1000 });
ok(!r5.present && r5.dark === true && r4.dark === false && FS.readingFrom({ ...face(HIM), mean: 92.5 }, { owner: HIM, now: 1000 }).dark === false && FS.DARK_MEAN === 8,
  '⭐ a BLACK frame (mean luminance under the dark bar) reads DARK, never "no one is here"; a lit frame never does (18 hours of black frames from a virtual source)');
ok(/Camera: dark/.test(FS.line(r5, { now: 2000 })) && /cannot see whether anyone is at the desk/.test(FS.line(r5, { now: 2000 })), 'the dark line says the lens shows only black, not that the room is empty');
FS.setDevice({ label: null, absent: true, reason: 'no physical camera is present — only virtual sources (AMD Privacy View camera, OBS Virtual Camera)' });
ok(/Camera: none is connected right now/.test(FS.line(null, { now: 2000 })) && /AMD Privacy View/.test(FS.line(r4, { now: 99999 })) && FS.status().device.absent === true,
  'with no fresh frame and the camera reported ABSENT, the line names the absence and its reason; status carries the device');
FS.setDevice({ label: 'HD Pro Webcam C920', absent: false });
ok(FS.line(null, { now: 2000 }) === null && FS.status().device.label === 'HD Pro Webcam C920', 'a named live device: no frame → no line (nothing to claim); status names the device');
FS.setDevice(null);
{
  const now = 10 * 3600000;
  const dark = PS.fuse({ now, lastUserTurnTs: now - 3 * 3600000, face: { at: now, present: false, dark: true }, prev: { state: 'here', since: now - 4 * 3600000, emptySince: now - 3 * 3600000 } });
  const empty = PS.fuse({ now, lastUserTurnTs: now - 3 * 3600000, face: { at: now, present: false }, prev: { state: 'here', since: now - 4 * 3600000, emptySince: now - 3 * 3600000 } });
  ok(!/camera/.test(dark.reason) && dark.emptySince === null && /camera: no one/.test(empty.reason) && empty.state === 'away',
    `⭐ a dark frame says nothing to presence (${dark.state}: ${dark.reason}); a truly empty chair still reads away by the camera`);
}
{
  const chat = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'chat.js'), 'utf8');
  ok(/const VIRTUAL_RE = \/virtual\|privacy view/.test(chat) && /deviceId: \{ exact: device\.deviceId \}/.test(chat) && /addEventListener\('devicechange'/.test(chat) && /camera\.device_label/.test(chat),
    '⭐ the renderer picks a PHYSICAL camera by label (a remembered one first), never a virtual source, and looks again on device change');
  ok(/camAbsent\(`no physical camera is present/.test(chat) && /cameraState\(true, \{ label: camLabel/.test(chat), 'an absent camera is said and reported; a live one is named to main');
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/\[face\] camera ABSENT — \$\{i\.reason\}/.test(main) && /face_sense'\)\.setDevice\(/.test(main), 'main logs the device or the absence and hands it to the sense');
  ok(/_lastCamAbsent\.reason !== _absentKey \|\| Date\.now\(\) - _lastCamAbsent\.at > 10 \* 60000/.test(main), 'the same absence is logged once per 10 min, not on every 30 s look');
  // THE EXPRESSION READ RIDES THE PRESENCE LANE (09-06): five cloud describes in p329's first two minutes at 100% of the pool
  const sense = fs.readFileSync(path.join(__dirname, '..', 'lib', 'face_sense.js'), 'utf8');
  ok(/DESCRIBE_PROMPT, \.\.\.\(model \? \{ model \} : \{\}\), lane: 'presence' \}\)/.test(sense), 'the face sense names its lane on every cloud describe');
  const VZ = require(path.join(LIB, 'vision'));
  let seenArgs = null;
  VZ.describe({ imageBase64: 'data:image/jpeg;base64,xxx', lane: 'presence', source: { tier: 'local', base: 'http://127.0.0.1:1' }, completeFn: async (a) => { seenArgs = a; return 'neutral'; } })
    .then((d) => ok(d.ok && seenArgs && seenArgs.lane === 'presence' && seenArgs.model, '⭐ vision.describe threads the lane into the cloud call, so the quota gate can hold the expression read at the edge of the pool'));

  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  ok(/cameraState: \(on, info\) => ipcRenderer\.invoke\('camera:state', !!on, info \|\| null\)/.test(pre), 'preload carries the device info');
  const consc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'consciousness.js'), 'utf8');
  ok(/if \(f && !f\.dark\) percept\(\{ sense: 'face'/.test(consc), 'the fast loop takes no face percept from a dark frame');
  const py = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'face_embed.py'), 'utf8');
  ok(/"mean": mean/.test(py) && /img\.mean\(\)/.test(py), 'the sidecar rides the frame\'s mean luminance on every result');
}
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
  const deps = () => ({ db, embed: mk(HIM), obsBus: bus, log: (m) => logs.push(m), now: t, onGaze: (gz) => gazes.push(gz), visionModels: { face: 'vision-test', global: null }, describe: async () => ({ ok: true, text: 'Leaning in, eyes on the screen, slight smile.\nFocused', model: 'vision-test' }) });
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
  // ── THE CAMERA SWITCH + ITS A/B (Lucas 09-05 17:05: "do the camera switch too we can give that a try") ──────────
  {
    const V = require('../lib/vision');
    ok(V.PURPOSE_DEFAULTS.face === 'gemma4:31b-cloud' && /PURPOSE_DEFAULTS\[purpose\] \|\| visionModel\(\)/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'vision.js'), 'utf8')), 'the face read defaults to the cheap multimodal model; meta model.vision.face still overrides; the global pin is untouched');
    FS._reset(); delete meta['camera.describe']; const abLogs = []; let t2 = 900000; const calls = [];
    const two = async (b64, model) => { calls.push(model); return model === 'minimax-test' ? { ok: true, text: 'Slumped, eyes down.\nTired', model } : { ok: true, text: 'Leaning in, eyes on the screen.\nFocused', model }; };
    const dAB = () => ({ db, embed: mk(HIM), obsBus: bus, log: (m) => abLogs.push(m), now: t2, describe: two, visionModels: { face: 'gemma-test', global: 'minimax-test' }, abPairs: 2 });
    await FS.onFrame('frame', { deps: dAB() }); await new Promise((r) => setTimeout(r, 30));
    ok(calls.join(',') === 'gemma-test,minimax-test' && abLogs.some((l) => /describe A\/B 1\/2 — face=gemma-test "focused: Leaning in, eyes on the screen\." \| global=minimax-test "tired: Slumped, eyes down\." — differ/.test(l)) && FS.current().expression === 'focused', `both models read the same frame, side by side in the log, and the face model's line is the reading (${FS.current().expression})`);
    t2 += 30000; await FS.onFrame('frame', { deps: dAB() }); await new Promise((r) => setTimeout(r, 30));
    ok(abLogs.some((l) => /describe A\/B done — 0\/2 agreed/.test(l)), 'after the trial\'s pairs the tally prints');
    t2 += 30000; calls.length = 0; await FS.onFrame('frame', { deps: dAB() }); await new Promise((r) => setTimeout(r, 30));
    ok(calls.join(',') === 'gemma-test', 'past the trial only the face model reads');
    FS._reset(); calls.length = 0; meta['camera.describe_ab'] = '0'; t2 += 30000; await FS.onFrame('frame', { deps: dAB() }); await new Promise((r) => setTimeout(r, 30));
    ok(calls.join(',') === 'gemma-test', 'camera.describe_ab=0 → no trial, the face model alone'); delete meta['camera.describe_ab'];
    FS._reset(); const failFirst = async (b64, model) => (model === 'gemma-test' ? { ok: false, reason: 'no answer' } : { ok: true, text: 'Slumped, eyes down.\nTired', model });
    t2 += 30000; await FS.onFrame('frame', { deps: { ...dAB(), describe: failFirst } }); await new Promise((r) => setTimeout(r, 30));
    ok(FS.current().expression === 'tired', 'when the cheap read fails during the trial the global\'s line is the reading');
  }
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
  const camSection = chat.slice(chat.indexOf('THE CAMERA SENSE'), chat.indexOf('THE CAMERA SENSE') + 12000);   // the section grew with the device picker (09-06)
  ok(camSection.length > 100 && !/toBlob|download|localStorage\.setItem\([^)]*frame|indexedDB|writeFile/.test(camSection), 'the renderer sampler never stores a frame');
  ok(/camera-off|camera OFF|Turn camera off/i.test(scan('lib/teams_canvas.js')) && /camera/i.test(scan('lib/meet_canvas.js')), 'the meeting camera-off rail is untouched');
  ok(/always_on_camera/.test(camSection) && /await cameraStart\(\)/.test(camSection) && /pref !== '0'/.test(camSection) && /on-air|onair/i.test(camSection), 'ALWAYS ON like the mic: auto-starts unless he turned it off (persisted always_on_camera), with an on-air indicator');
  ok(/faceStatus\(\)/.test(camSection) && /tap "👤 that\\?'s me" once/.test(camSection), 'the first start without an enrollment nudges him once');

  // ── HER VERB <look/> (Lucas 09-05: "the concept of the camera switch seems counterintuitive") ─────────
  FS._reset(); delete meta['camera.describe'];   // an earlier pin turned the cloud read off; the look block wants it on
  const offLook = FS.look({ deps: { db }, now: 1 });
  ok(!offLook.ok && /camera is off/.test(offLook.text) && /switch is his/.test(offLook.text), 'with no frame arriving, <look/> says the camera is off — honestly, never a guess');
  {
    let t2 = 900000; const d2 = () => ({ db, embed: mk(HIM), obsBus: { emit: () => {} }, log: () => {}, now: t2, describe: async () => ({ ok: true, text: 'Leaning in.\nFocused', model: 'v' }) });
    await FS.onFrame('frame', { deps: d2() }); await new Promise((r) => setTimeout(r, 20));
    const lk = FS.look({ deps: { db }, now: t2 + 500 });
    ok(lk.ok && /^You look: Lucas is in the room; looking at the screen/.test(lk.text) && /closer read/.test(lk.text), `<look/> answers the current reading in her own frame ("${lk.text.slice(0, 60)}…")`);
    let describes = 0; t2 += 2000;
    await FS.onFrame('frame', { deps: { ...d2(), describe: async () => { describes++; return { ok: true, text: 'Smiling.\nHappy', model: 'v' }; } } }); await new Promise((r) => setTimeout(r, 20));
    ok(describes === 1, 'a look asks the next frame for a closer read even inside the 20 s cadence');
    const st = FS.status({ deps: { db }, now: t2 + 100 });
    ok(st.enrolled === true && st.live === true && st.reading && st.reading.present === true, 'status: enrolled + live + the reading');
    ok(FS.status({ deps: { db }, now: t2 + 60000 }).live === false, 'status: no frame for 10 s → not live');
  }
  const PR = require(path.join(LIB, 'presence'));
  const tags = PR.parseTags('<think>let me check</think><say><look/> Are you still there?</say>');
  ok(tags.length === 1 && tags[0].tag === 'look' && /<look\/>/.test(PR.buildPromptBlock()) && !/<look/.test(PR.stripTags('<look/> hi')), '<look/> parses as a presence tag, is named in her vocabulary, and is stripped from the bubble');
  const looked = await PR.dispatch(tags[0]);
  ok(looked && typeof looked.text === 'string' && /You look|camera is off/.test(looked.text), 'dispatching <look/> reaches face_sense.look');
  ok(/t\.tag === 'look' && r && r\.text/.test(fs.readFileSync(path.join(root, 'main.js'), 'utf8')) && /model: 'camera', type: 'reading'/.test(fs.readFileSync(path.join(root, 'main.js'), 'utf8')), 'what she saw lands as a camera reading in her monologue (her next turn carries it)');
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
  // ── THE GATE'S HOLD IS NOT A READ (09-06): a deferred describe counts no A/B pair, is said once, and backs off ──
  {
    FS._reset();
    const meta2 = {}; const db2 = { getMeta: (k) => meta2[k], setMeta: (k, v) => { meta2[k] = v; } };
    const logs2 = []; let calls = 0;
    const held = async () => { calls++; return { ok: false, reason: 'quota: presence deferred — presence stops at 99% of the pool (now 100%)' }; };
    const deps2 = (now) => ({ db: db2, now, minGapMs: 0, embed: async () => ({ ok: true, results: [face(HIM)] }), describe: held, visionModels: { face: 'gemma4:31b-cloud', global: 'minimax-m3:cloud' }, log: (m) => logs2.push(m), obsBus: { emit: () => {} } });
    meta2[FS.OWNER_KEY] = JSON.stringify(HIM);
    const t0 = 1000000;
    await FS.onFrame('f1', { deps: deps2(t0) }); await new Promise((r) => setTimeout(r, 20));
    await FS.onFrame('f2', { deps: deps2(t0 + 25000) }); await new Promise((r) => setTimeout(r, 20));
    ok(calls === 1 && !logs2.some((m) => /describe A\/B/.test(m)) && logs2.filter((m) => /held by the quota gate/.test(m)).length === 1,
      `⭐ a deferred expression read counts NO A/B pair, is said once, and is not retried 25 s later (calls=${calls})`);
    await FS.onFrame('f3', { deps: deps2(t0 + FS.DESCRIBE_DEFER_BACKOFF_MS + 1000) }); await new Promise((r) => setTimeout(r, 20));
    ok(calls === 2 && logs2.filter((m) => /held by the quota gate/.test(m)).length === 1, 'after the backoff it tries again, and the same hold is not said twice inside 10 min');
    FS._reset();
  }
  console.log(`\nsmoke_face_sense: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
