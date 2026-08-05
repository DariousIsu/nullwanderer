'use strict';
/* smoke_choke_gate.js — M1.1b: prove the ollama.js choke-point spend gate's MUTE-SAFETY invariant.
 * Stubs quota_gate.allow + global.fetch so no network/db is touched. Run: node scripts/smoke_choke_gate.js */
const path = require('path');

// Force the gate to a known verdict by replacing quota_gate in the require cache BEFORE ollama.js calls it.
const gatePath = require.resolve(path.join(__dirname, '..', 'lib', 'quota_gate'));
let GATE_VERDICT = { allow: true, reason: 'ok' };
let GATE_THROWS = false;
require.cache[gatePath] = { id: gatePath, filename: gatePath, loaded: true, exports: {
  allow: () => { if (GATE_THROWS) throw new Error('gate infra boom'); return GATE_VERDICT; },
  state: () => ({}), describe: () => '', spentLastHour: () => 0,
} };

const { streamChat } = require(path.join(__dirname, '..', 'lib', 'ollama'));
const OLLAMA_BASE = process.env.OLLAMA_BASE || 'http://localhost:11434';
const CLOUD = 'https://ollama.com';

// Stub fetch: reaching it means the gate ALLOWED the call. We throw a sentinel so we never actually stream.
global.fetch = async () => { const e = new Error('FETCH_REACHED'); e._fetchReached = true; throw e; };

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error('  FAIL:', n); } };

// Returns 'reached' (gate allowed → fetch hit), 'deferred' (gate blocked pre-fetch), or 'other:<msg>'.
async function run(lane, base) {
  try {
    await streamChat({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }], lane, base, headers: {}, inactivityMs: 0 });
    return 'nofetch';
  } catch (e) {
    if (e && e._fetchReached) return 'reached';
    if (e && e.deferred) return 'deferred';
    return 'other:' + (e && e.message);
  }
}

(async () => {
  // 1) Gate says NO.
  GATE_VERDICT = { allow: false, reason: 'pool exhausted' }; GATE_THROWS = false;
  ok('interactive cloud NEVER gated (reaches fetch)', (await run('interactive', CLOUD)) === 'reached');
  ok('idle cloud IS deferred when gate says no', (await run('idle', CLOUD)) === 'deferred');
  ok('research cloud IS deferred when gate says no', (await run('research', CLOUD)) === 'deferred');
  ok('idle LOCAL never gated (local is free → reaches fetch)', (await run('idle', OLLAMA_BASE)) === 'reached');

  // 2) Gate says YES → all lanes proceed.
  GATE_VERDICT = { allow: true, reason: 'ok' };
  ok('idle cloud proceeds when gate allows', (await run('idle', CLOUD)) === 'reached');
  ok('interactive cloud proceeds when gate allows', (await run('interactive', CLOUD)) === 'reached');

  // 3) Gate INFRA ERROR → FAIL OPEN (call proceeds, never mutes).
  GATE_THROWS = true;
  ok('gate infra error → FAILS OPEN (idle cloud reaches fetch)', (await run('idle', CLOUD)) === 'reached');

  console.log(`\nsmoke_choke_gate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
