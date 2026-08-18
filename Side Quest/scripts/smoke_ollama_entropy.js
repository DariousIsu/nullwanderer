'use strict';
// smoke_ollama_entropy.js — Wave 2: the local-model chokepoint (lib/ollama streamChat) collapses its
// expressive sampling in a reproducible test mode. Proves ollama._govern applies the entropy policy:
// prod is a no-op, deterministic mode → temperature 0 (greedy), the test modes thread a FIXED, replayable
// ollama seed, and the caller's options object is never mutated. No live model — inspects the options.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_ollama_entropy.js
const ollama = require('../lib/ollama');
const e = require('../lib/entropy');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

delete process.env.ZOE_ENTROPY_SEED;   // start from a clean prod default

// ── prod (default): a true no-op — base temperature, no forced seed ──
e.configure({ mode: 'prod', seed: 0x123 });   // explicit seed avoids a crypto draw; mode stays prod
{
  const g = ollama._govern({ temperature: 0.8, top_p: 0.9, num_ctx: 8192 });
  ok(g.temperature === 0.8, 'prod: temperature passes through unchanged (0.8)');
  ok(g.seed === undefined, 'prod: no forced seed (live variety preserved)');
  ok(g.top_p === 0.9 && g.num_ctx === 8192, 'prod: other options are carried through untouched');
}

// ── deterministic: temperature → 0 (greedy) + a fixed seed ──
e.configure({ mode: 'deterministic' });
{
  const g = ollama._govern({ temperature: 0.8 });
  ok(g.temperature === 0, 'deterministic: temperature → 0 (greedy decoding, byte-reproducible output)');
  ok(typeof g.seed === 'number' && Number.isFinite(g.seed), 'deterministic: a fixed ollama seed is threaded');
}

// ── seeded: real temperature, but a STABLE seed across calls (reproducible variety) ──
e.configure({ mode: 'seeded', seed: 999 });
{
  const g1 = ollama._govern({ temperature: 0.7 });
  const g2 = ollama._govern({ temperature: 0.7 });
  ok(g1.temperature === 0.7, 'seeded: real temperature is preserved (expressive variety)');
  ok(g1.seed === g2.seed, 'seeded: the ollama seed is stable across calls (a turn replays)');
}

// ── same master seed → same ollama seed; different seed → different ──
{
  e.configure({ mode: 'seeded', seed: 999 });
  const s1 = ollama._govern({ temperature: 0.7 }).seed;
  e.configure({ mode: 'seeded', seed: 999 });
  const s2 = ollama._govern({ temperature: 0.7 }).seed;
  ok(s1 === s2, 'same master seed → same ollama seed (replayable run-to-run)');
  e.configure({ mode: 'seeded', seed: 1000 });
  const s3 = ollama._govern({ temperature: 0.7 }).seed;
  ok(s3 !== s1, 'a different master seed → a different ollama seed');
}

// ── prod WITH a pinned ZOE_ENTROPY_SEED becomes replayable too ──
{
  process.env.ZOE_ENTROPY_SEED = '0xABC';
  e.configure({ mode: 'prod', seed: '0xABC' });
  const g = ollama._govern({ temperature: 0.8 });
  ok(g.temperature === 0.8 && typeof g.seed === 'number', 'prod with a pinned ZOE_ENTROPY_SEED threads a seed (pin a prod session for replay)');
  delete process.env.ZOE_ENTROPY_SEED;
}

// ── never mutates the caller's options object ──
e.configure({ mode: 'deterministic' });
{
  const input = { temperature: 0.9 };
  const out = ollama._govern(input);
  ok(input.temperature === 0.9 && out !== input, '_govern returns a copy — the caller\'s options are never mutated');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
