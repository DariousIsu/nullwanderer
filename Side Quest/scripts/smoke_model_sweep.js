/* Smoke: boot model sweep (ollama.selectStale) — clears a stale big resident that would collide
 * with the front model in VRAM (the "call goes nowhere" hang), while keeping the front + tiny
 * embedding models. Pure/deterministic: no daemon, no network.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_model_sweep.js
 */
'use strict';
const { selectStale } = require('../lib/ollama');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const FRONT = 'hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M';
const loaded = [
  { name: FRONT, size_vram: 16_600_000_000 },                 // the front — KEEP
  { name: 'mistral-small3.2:24b', size_vram: 17_485_471_872 },// stale squatter — EVICT
  { name: 'bge-small:latest', size_vram: 130_000_000 },       // embedding — KEEP (tiny)
];

const stale = selectStale(loaded, { keep: [FRONT], minVramBytes: 2e9 });
ok(stale.includes('mistral-small3.2:24b'), 'evicts the stale big non-front model');
ok(!stale.includes(FRONT), 'keeps the front model');
ok(!stale.some(n => /bge/.test(n)), 'keeps tiny embedding models (below the VRAM floor)');
ok(stale.length === 1, 'only the squatter is selected');

// keep can hold several; nothing to do when only the front is resident
ok(selectStale([{ name: FRONT, size_vram: 16e9 }], { keep: [FRONT] }).length === 0, 'no-op when only the front is loaded');
// multiple keeps respected
ok(selectStale(loaded, { keep: [FRONT, 'mistral-small3.2:24b'] }).length === 0, 'multiple keep entries respected');
// size_vram missing → falls back to size; still gated by the floor
ok(selectStale([{ name: 'big:70b', size: 40e9 }], { keep: [] }).includes('big:70b'), 'uses size when size_vram absent');
ok(selectStale([{ name: 'embed-nomic', size_vram: 5e9 }], { keep: [] }).length === 0, 'name-based embedding guard (nomic) even if large');
ok(selectStale([], { keep: [FRONT] }).length === 0, 'empty/none resident → []');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
