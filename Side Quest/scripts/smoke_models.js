/**
 * Offline smoke for lib/models.js pure helpers — model discovery + selection.
 * No Ollama / no db needed (we mock the daemon's JSON shapes).
 *
 * Run: node scripts/smoke_models.js
 */
// Require only the pure helpers; avoid the db-backed bits by destructuring.
const M = require('../lib/models');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// --- parseTags (shape of GET /api/tags) ---
const TAGS = { models: [
  { name: 'dans-personalityengine:24b-q4_k_m', size: 14_000_000_000, details: { parameter_size: '24B', quantization_level: 'Q4_K_M', family: 'mistral' } },
  { name: 'gemma3:4b', size: 3_300_000_000, details: { parameter_size: '4B', quantization_level: 'Q4', family: 'gemma' } },
  { name: 'broken' }, // missing details
  { size: 5 },        // missing name — dropped
] };
const parsed = M.parseTags(TAGS);
ok('parseTags drops nameless entries', parsed.length === 3);
ok('parseTags normalizes size to GB', parsed[0].sizeGB === 14.0, `${parsed[0].sizeGB}`);
ok('parseTags carries paramSize/quant', parsed[0].paramSize === '24B' && parsed[0].quant === 'Q4_K_M');
ok('parseTags tolerates missing details', parsed[2].name === 'broken' && parsed[2].paramSize === null);
ok('parseTags on empty/garbage', M.parseTags(null).length === 0 && M.parseTags({}).length === 0);

// --- parseContextLength (shape of POST /api/show) ---
ok('ctx from arch-prefixed model_info', M.parseContextLength({ model_info: { 'llama.context_length': 131072, 'llama.block_count': 32 } }) === 131072);
ok('ctx from qwen2 prefix', M.parseContextLength({ model_info: { 'qwen2.context_length': 32768 } }) === 32768);
ok('ctx from parameters num_ctx fallback', M.parseContextLength({ parameters: 'num_ctx 8192\nstop "<|im_end|>"' }) === 8192);
ok('ctx null when absent', M.parseContextLength({ model_info: { 'llama.block_count': 32 } }) === null);
ok('ctx null on garbage', M.parseContextLength(null) === null);

// --- pickDefault (high-context selection) ---
const WITH_CTX = [
  { name: 'small', contextLength: 8192 },
  { name: 'big', contextLength: 131072 },
  { name: 'mid', contextLength: 32768 },
];
ok('pickDefault picks largest context', M.pickDefault(WITH_CTX) === 'big');
ok('pickDefault honors minContext floor', M.pickDefault(WITH_CTX, { minContext: 40000 }) === 'big');
ok('pickDefault floor excludes too-small', M.pickDefault([{ name: 's', contextLength: 8192 }], { minContext: 40000 }) === null);
ok('pickDefault empty → null', M.pickDefault([]) === null && M.pickDefault(null) === null);
ok('pickDefault stable on ties', M.pickDefault([{ name: 'a', contextLength: 100 }, { name: 'b', contextLength: 100 }]) === 'a');

// --- prefKey ---
ok('prefKey namespaces + lowercases', M.prefKey('Editor') === 'model.editor');
ok('prefKey trims', M.prefKey('  Chat ') === 'model.chat');

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
