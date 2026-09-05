// smoke_face_people — the register of known people (the stranger act, §4.5b): enrolled by HIS WORD only, one at
// a time, vectors never images; a reading that is not him carries `known`. No camera, no sidecar: a fake embedder.
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const FS = require(path.join(__dirname, '..', 'lib', 'face_sense'));
const meta = {}; const db = { getMeta: (k) => meta[k], setMeta: (k, v) => { meta[k] = v; } };
// xorshift with far-apart seeds: adjacent LCG seeds give nearly collinear vectors (this morning's trap)
const vec = (seed) => { let s = (seed * 2654435761) >>> 0 || 1; const v = []; for (let i = 0; i < 64; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; v.push((s / 4294967296) * 2 - 1); } return v; };
const HIM = vec(11), RAEGAN = vec(2027), STRANGER = vec(90001);
meta[FS.OWNER_KEY] = JSON.stringify(HIM);
const embedOf = (emb, faces = 1) => async () => ({ ok: true, results: [{ ok: true, embedding: emb, faces, kps: null, box: null }] });
(async () => {
  FS._reset && FS._reset();
  ok((await FS.enrollPerson('Raegan', 'his kid', { deps: { db, embed: embedOf(RAEGAN), frameB64: 'x', log: () => {} } })).ok, 'his word enrolls a person from the last frame');
  const people = FS.people({ db });
  ok(people.length === 1 && people[0].name === 'Raegan' && people[0].relation === 'his kid' && Array.isArray(people[0].embedding) && !('image' in people[0]), 'meta face.people holds name, relation and a vector — never an image');
  const r1 = await FS.enrollPerson('Someone', null, { deps: { db, embed: embedOf(HIM), frameB64: 'x', log: () => {} } });
  ok(!r1.ok && /that is you/.test(r1.error), 'his own face is never enrolled as a person');
  const r2 = await FS.enrollPerson('Two', null, { deps: { db, embed: embedOf(RAEGAN, 2), frameB64: 'x', log: () => {} } });
  ok(!r2.ok && /2 faces/.test(r2.error), 'two faces in the frame → refused (one person at a time)');
  ok(!(await FS.enrollPerson('Nobody', null, { deps: { db, embed: embedOf(RAEGAN), frameB64: null, log: () => {} } })).ok, 'no recent frame → refused, honestly');
  await FS.enrollPerson('Raegan', 'his kid, again', { deps: { db, embed: embedOf(RAEGAN), frameB64: 'x', log: () => {} } });
  ok(FS.people({ db }).length === 1 && FS.people({ db })[0].relation === 'his kid, again', 'the same name re-enrolled (any casing) replaces, never duplicates');
  const k1 = FS.knownFrom(RAEGAN, FS.people({ db })); const k2 = FS.knownFrom(STRANGER, FS.people({ db }));
  ok(k1 && k1.name === 'Raegan' && k1.sim >= FS.SAME_FACE_THRESHOLD && k2 === null, `knownFrom: Raegan matches (${k1 && k1.sim}); a stranger does not (${JSON.stringify(k2)}; cos stranger/raegan ${FS.cosine(STRANGER, RAEGAN).toFixed(3)}, raegan/him ${FS.cosine(RAEGAN, HIM).toFixed(3)})`);
  // a frame: him → is_him, no known; Raegan → not him, known Raegan; a stranger → not him, known null
  const dep = (emb) => ({ db, embed: embedOf(emb), obsBus: { emit: () => {} }, log: () => {}, now: Date.now(), minGapMs: 0 });
  meta['camera.describe'] = '0';
  const a = await FS.onFrame('f1', { deps: dep(HIM) });
  const b = await FS.onFrame('f2', { deps: { ...dep(RAEGAN), now: Date.now() + 5000 } });
  const c = await FS.onFrame('f3', { deps: { ...dep(STRANGER), now: Date.now() + 10000 } });
  ok(a.reading.is_him === true && a.reading.known === undefined, 'him: is_him, no known');
  ok(b.reading.is_him === false && b.reading.known === 'Raegan' && b.reading.known_relation === 'his kid, again', 'Raegan: not him, known by name and relation');
  ok(c.reading.is_him === false && c.reading.known === null, 'a stranger: not him, known null — the loop asks who they are');
  console.log(`\nsmoke_face_people: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('smoke threw:', e); process.exit(1); });
