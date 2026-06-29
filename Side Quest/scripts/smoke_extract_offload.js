/* Smoke: extraction/cognition offload (Front/Cortex — the GPU-thrash fix).
 *
 * The hang was two local 24B models (Dans front + mistral extraction) evicting each other on a
 * 20GB GPU — each reload 20–40s. The fix: extraction/cognition runs on a CLOUD model (zero local
 * VRAM) so the FRONT (Dans) is the ONLY local model ever resident → no swaps. This smoke locks the
 * invariant so it can't silently regress:
 *   1. config.extractionModel() resolves to a cloud model by default + honors ZOE_EXTRACT_MODEL.
 *   2. front / extraction / subconscious are DISTINCT, and only the front is a local model.
 *   3. NO lib module pins the local model() for its work — every extraction module routes through
 *      extractionModel() (cloud) and every voice module through frontModel() (the resident front).
 *      A module reverting to config.model() would re-introduce the second local 24B → the thrash.
 *
 * Deterministic: pure source-scan + config resolvers. No model/network. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_extract_offload.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../lib/config');
if (config.loadEnv) config.loadEnv();

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const libDir = path.join(__dirname, '..', 'lib');

// --- 1. resolver behavior ---
ok(config.extractionModel() === 'gemma4:31b-cloud' || /-cloud$/.test(config.extractionModel()),
  `extractionModel() is a cloud model (${config.extractionModel()})`);
const saved = process.env.ZOE_EXTRACT_MODEL;
process.env.ZOE_EXTRACT_MODEL = 'some-local-model:7b';
ok(config.extractionModel() === 'some-local-model:7b', 'extractionModel() honors ZOE_EXTRACT_MODEL override (revert lever)');
if (saved === undefined) delete process.env.ZOE_EXTRACT_MODEL; else process.env.ZOE_EXTRACT_MODEL = saved;
ok(/-cloud$/.test(config.extractionModel()), 'extractionModel() back to cloud default after override cleared');

// --- 2. the three cognition slots are distinct; only the front is local ---
const front = config.frontModel(), extract = config.extractionModel(), sub = config.subconsciousModel(), local = config.model();
ok(front !== extract, 'front (voice) and extraction use DIFFERENT models (no shared local 24B)');
ok(extract !== local, 'extraction is NOT the local model() — it is off-GPU');
ok(/-cloud$/.test(extract), 'extraction routes to the cloud proxy (zero local VRAM)');
ok(sub === '' || /(:120b|:?cloud|gpt-oss|deepseek|glm|kimi|nemotron)/i.test(sub), 'subconscious is a cloud reasoner (or unset → local)');

// --- 3. source invariant: no lib module pins the LOCAL model() for its work ---
// (config.js is allowed — it DEFINES model()/frontModel()/extractionModel().)
const LOCAL_CALL = /(?:require\(['"]\.\/config['"]\)|\bconfig)\.model\(\)/;
const offenders = [];
for (const f of fs.readdirSync(libDir).filter(n => n.endsWith('.js') && n !== 'config.js')) {
  const src = fs.readFileSync(path.join(libDir, f), 'utf8');
  if (LOCAL_CALL.test(src)) offenders.push(f);
}
ok(offenders.length === 0, `no lib module pins the local model() (offenders: ${offenders.join(', ') || 'none'})`);

// --- 4. spot-check the buckets are wired the way the fix intends ---
const EXTRACTION = ['memory', 'personal_facts', 'preferences', 'importance', 'commitments', 'open_threads',
  'graph_extract', 'protocols', 'continuity', 'experience', 'learning', 'self_model', 'consolidate',
  'convo_state', 'reflection', 'rumination', 'gmeet', 'media_cc'];
const VOICE = ['voice', 'byline', 'self_narrative', 'self_dialogue', 'play_session', 'heartbeat'];
const readSrc = (n) => fs.readFileSync(path.join(libDir, n + '.js'), 'utf8');
const missingExtract = EXTRACTION.filter(n => !/extractionModel\(\)/.test(readSrc(n)));
const missingVoice = VOICE.filter(n => !/frontModel\(\)/.test(readSrc(n)));
ok(missingExtract.length === 0, `all extraction modules route to extractionModel (missing: ${missingExtract.join(', ') || 'none'})`);
ok(missingVoice.length === 0, `all voice modules route to frontModel (missing: ${missingVoice.join(', ') || 'none'})`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
