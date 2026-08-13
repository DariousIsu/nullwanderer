/* Smoke: lib/voices — the voice REGISTRY foundation (voice-cloning-suite Phase 1). Proves the three
 * things Phase 1 must guarantee before anything is built on it: (1) MIGRATION mints a valid registry from
 * the on-disk world (zoe blend + stock .onnx), (2) the RESOLVE precedence ladder + legacy-.onnx SHIM pick
 * the right voice in every tier, (3) FAIL-SOFT — empty/corrupt/absent inputs never throw and degrade to
 * null. All against a throwaway temp dir (never touches the real data/voices). No GPU, no sidecar, no net.
 * Run:  ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_voices.js
 * (plain `node scripts/smoke_voices.js` works too — this module has no Electron deps.) */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const voices = require('../lib/voices');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// fresh throwaway dir per run (absolute path — CARL: no traversal ambiguity)
const TMP = path.join(os.tmpdir(), `sq_voices_smoke_${process.pid}`);
function freshDir() { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} fs.mkdirSync(TMP, { recursive: true }); return TMP; }
function writeOnnx(dir, name, license) {
  fs.writeFileSync(path.join(dir, name), '');                                  // content irrelevant — module reads the NAME
  if (license !== undefined) fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify({ license })); // piper sibling
}

// ===== (1) MIGRATION from the on-disk world =====
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'zoe_voice.json'), JSON.stringify({ weights: { af_bella: 0.318, af_nicole: 0.273, bf_isabella: 0.409 }, lang: 'b', speed: 1.13 }));
  writeOnnx(dir, 'en_US-amy-medium.onnx', 'MIT');
  writeOnnx(dir, 'en_GB-jenny_dioco-medium.onnx');            // no sibling license → should record null
  const reg = voices.createRegistry({ dir });

  const zoe = reg.get('zoe');
  ok(zoe && zoe.kind === 'blend' && zoe.engine === 'kokoro', 'migrate: mints `zoe` as a kokoro blend');
  ok(zoe && zoe.recipe && zoe.recipe.weights.bf_isabella === 0.409 && zoe.recipe.lang === 'b' && zoe.recipe.speed === 1.13, 'migrate: zoe carries the blend recipe verbatim');
  ok(zoe && zoe.license === 'Apache-2.0' && zoe.consent === null, 'migrate: zoe stamped Apache-2.0, consent null');

  const amy = reg.get('en_US-amy-medium');
  ok(amy && amy.kind === 'stock' && amy.engine === 'piper' && amy.modelPath === 'en_US-amy-medium.onnx', 'migrate: mints a piper stock entry per .onnx');
  ok(amy && amy.license === 'MIT', 'migrate: reads license from the piper sibling .json when present');
  ok(reg.get('en_GB-jenny_dioco-medium').license === null, 'migrate: license is honestly null when the sibling declares none');

  ok(reg.load().active === 'zoe', 'migrate: active defaults to the blend when present');
  ok(voices.SURFACES.every((s) => reg.load().surfaces[s] === 'zoe'), 'migrate: every surface points at active');
  ok(fs.existsSync(path.join(dir, 'registry.json')), 'migrate: persists registry.json (stable seed)');

  const list = reg.list();
  ok(list.length === 3 && list.find((v) => v.id === 'zoe').active === true, 'list: returns all voices, marks active');

  // reload reads the persisted file (not a re-migration)
  const reg2 = voices.createRegistry({ dir });
  ok(reg2.get('zoe') && reg2.load().active === 'zoe', 'reload: persisted registry.json is read back intact');
}

// ===== (2) RESOLVE precedence ladder + legacy shim =====
{
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'zoe_voice.json'), JSON.stringify({ weights: { af_bella: 1 }, lang: 'b', speed: 1.0 }));
  writeOnnx(dir, 'en_US-amy-medium.onnx', 'MIT');
  writeOnnx(dir, 'en_US-lessac-medium.onnx', 'MIT');
  const reg = voices.createRegistry({ dir });
  reg.setSurface('meeting', 'en_US-amy-medium');    // registry-level surface route

  // tier 1: explicit registry id
  const t1 = reg.resolve({ voice: 'en_US-lessac-medium' }, {});
  ok(t1 && t1.id === 'en_US-lessac-medium' && t1.source === 'opts.voice', 'resolve[1]: explicit registry id wins');

  // tier 1: legacy .onnx PATH shim
  const legacyPath = path.join(dir, 'en_US-amy-medium.onnx');
  const t1b = reg.resolve({ voice: legacyPath }, {});
  ok(t1b && t1b.engine === 'piper' && t1b.params.voice === legacyPath && t1b.source === 'opts.voice', 'resolve[1]: a legacy .onnx path resolves via the shim');

  // tier 1: unknown id falls THROUGH to active (not a hard fail)
  const t1c = reg.resolve({ voice: 'no-such-voice' }, {});
  ok(t1c && t1c.id === 'zoe' && t1c.source === 'registry.active', 'resolve[1]: unknown id falls through to active');

  // tier 2: surface — config override beats registry route
  const t2reg = reg.resolve({ surface: 'meeting' }, {});
  ok(t2reg && t2reg.id === 'en_US-amy-medium' && t2reg.source === 'surface:registry', 'resolve[2]: registry surface route applies');
  const t2cfg = reg.resolve({ surface: 'meeting' }, { surfaceVoices: { meeting: 'en_US-lessac-medium' } });
  ok(t2cfg && t2cfg.id === 'en_US-lessac-medium' && t2cfg.source === 'surface:config', 'resolve[2]: config surfaceVoices override beats the registry route');

  // tier 3: config.activeVoice
  const t3 = reg.resolve({}, { activeVoice: 'en_US-lessac-medium' });
  ok(t3 && t3.id === 'en_US-lessac-medium' && t3.source === 'config.active', 'resolve[3]: config.activeVoice applies when no opts');

  // tier 4: registry.active (default)
  const t4 = reg.resolve({}, {});
  ok(t4 && t4.id === 'zoe' && t4.source === 'registry.active', 'resolve[4]: registry.active is the default');

  // descriptor shapes
  ok(t4.engine === 'kokoro' && t4.params.recipe && t4.params.recipe.weights.af_bella === 1, 'descriptor: kokoro → params.recipe with weights');
  ok(t1.engine === 'piper' && t1.params.voice === path.join(dir, 'en_US-lessac-medium.onnx') && t1.params.speaker === null, 'descriptor: piper → absolute .onnx path + speaker');
}

// ===== (3) FAIL-SOFT =====
{
  // empty dir: no zoe, no .onnx → valid-but-empty registry, resolve → null (never throws)
  const dir = freshDir();
  const reg = voices.createRegistry({ dir });
  ok(reg.load().voices && Object.keys(reg.load().voices).length === 0, 'failsoft: empty dir → empty voices, no throw');
  ok(reg.resolve({}, {}) === null, 'failsoft: nothing configured → resolve returns null');

  // tier 5: a legacy .onnx from config still speaks even with an empty registry
  const t5 = reg.resolve({}, { voice: 'C:/some/en_GB-jenny.onnx' });
  ok(t5 && t5.engine === 'piper' && t5.source === 'legacy-onnx', 'failsoft: cfg.voice .onnx → legacy shim keeps today\'s path working');

  // corrupt registry.json → falls back to migration, no throw
  const dir2 = freshDir();
  fs.writeFileSync(path.join(dir2, 'registry.json'), '{ this is not json');
  writeOnnx(dir2, 'en_US-amy-medium.onnx', 'MIT');
  const reg2 = voices.createRegistry({ dir: dir2 });
  ok(reg2.get('en_US-amy-medium') && reg2.load().active === 'en_US-amy-medium', 'failsoft: corrupt registry.json → re-migrates (active = configured/first stock)');

  // write-path validation
  ok(reg2.setActive('nope').ok === false, 'setActive: unknown id → { ok:false }, no throw');
  ok(reg2.setSurface('bogus-surface', 'en_US-amy-medium').ok === false, 'setSurface: unknown surface → { ok:false }');
  ok(reg2.upsert({ id: 'x' }).ok === false, 'upsert: missing engine → { ok:false }');
  ok(reg2.upsert({ id: 'test', name: 'T', kind: 'stock', engine: 'piper', modelPath: 'en_US-amy-medium.onnx' }).ok === true, 'upsert: valid entry persists');
  ok(reg2.remove('en_US-amy-medium').ok === true && !reg2.get('en_US-amy-medium'), 'remove: deletes entry, reassigns active away from it');
}

// cleanup
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
