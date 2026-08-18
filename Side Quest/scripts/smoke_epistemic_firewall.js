'use strict';
// smoke_epistemic_firewall.js — W1b of the pre-hard-testing scope (docs/PRE_HARD_TESTING_SCOPE_2026-08-18.md):
// the STRUCTURAL firewall. The program's crown jewel is deterministic grounding — randomness may pick
// WHICH behavior fires and WHEN, but never anywhere that finds, ranks, grounds, verifies, cites, or
// writes a fact. This asserts the epistemic-path modules carry NO ungoverned randomness (no
// Math.random) and never import the behavioral entropy module (lib/entropy, arrives in W2), so a
// future refactor can't quietly leak chance into a confidence, a retrieval rank, or a verdict.
//
// Today all these files are already clean (certainty.js's dead random terminal was removed in 040e35a);
// this test LOCKS that — it turns "smooth dynamics, never source" from a discipline into a gate.
// Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_epistemic_firewall.js
const fs = require('fs'), path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// The fact path: retrieval, confidence, verification, routing verdicts, extraction, consolidation.
const EPISTEMIC = [
  'memory.js', 'certainty.js', 'confidence_model.js', 'confidence_decay.js',
  'metacognition.js', 'verify_claim.js', 'route_judge.js', 'renag_judge.js',
  'importance.js', 'graph_extract.js', 'consolidate.js',
];
const ENTROPY_IMPORT_RE = /require\((['"])\.\/entropy\1\)/;

for (const f of EPISTEMIC) {
  let src = null;
  try { src = fs.readFileSync(path.join(__dirname, '..', 'lib', f), 'utf8'); } catch {}
  ok(src != null, `${f} is present`);
  if (src == null) continue;
  ok(!/Math\.random/.test(src), `${f}: no Math.random — the fact path is deterministic`);
  ok(!ENTROPY_IMPORT_RE.test(src), `${f}: does not import the behavioral entropy module`);
}

// Guard the guard: the scan MUST actually reject a leak (a test that can't fail is theater).
ok(/Math\.random/.test('x = Math.random()'), 'the Math.random scan detects an introduced leak (self-check)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
