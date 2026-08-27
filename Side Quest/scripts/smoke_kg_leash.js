/* Smoke: THE KG JUDGE LEASH (big-organs leg 1, 2026-08-27 — the dead-consumer cure).
 * Every run_dedup_adjudication dispatch rode the DEFAULT 90s ceiling and was abandoned
 * ([dispatch-timeout] ×5, nightly drained ZERO, pending grew to 32,507 while the producers kept
 * landing +63/+6/+3 per pass; the watch organ filed need #99). The organ is healthy (a batch-1
 * probe returns in seconds) — the judge is slow by design (fast ~2s/pair, fuzzy ~20s/pair on kimi
 * think). These pins hold the cure: every slow-judge dispatch carries the raised idle-op leash and
 * the bites are sized to fit it. Re-starving (dropping a leash, re-inflating a bite) fails here.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_kg_leash.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// Every run_dedup_adjudication dispatch carries a timeoutMs option.
const calls = main.match(/name: 'run_dedup_adjudication'[^\n]*/g) || [];
ok(calls.length >= 5, `all adjudication sites found (${calls.length} — paced, 20h-curation, nightly ×3)`);
ok(calls.every((c) => /timeoutMs/.test(c)), 'EVERY adjudication dispatch carries the raised leash (none rides the 90s default)');

// The leash is the shared judge envelope, env-tunable, ≥ 10 minutes.
ok(/KGJUDGE_DISPATCH_MS = \(parseFloat\(process\.env\.ZOE_KG_JUDGE_TIMEOUT_MIN\) \|\| 15\) \* 60 \* 1000/.test(main),
  'the judge envelope is 15 min default, env-tunable (ZOE_KG_JUDGE_TIMEOUT_MIN)');

// The bites fit the envelope: name-strong nightly chip is small (kimi ~20s/pair), and the 20h
// curation site no longer asks for 200.
ok(/ZOE_KG_NIGHTLY_NAMESTRONG_BATCH \|\| '', 10\) \|\| 8/.test(main), 'name-strong nightly bite = 8 (50 was ~80 min of kimi — unservable)');
ok(/ZOE_DEDUP_ADJUDICATE_BATCH, 10\) \|\| 25/.test(main), 'the 20h curation bite = 25 (200 was ~33 min even on fast tiers)');

// The link-grounding lane (web+cloud per candidate) rides the same class of leash.
ok(/name: 'run_link_grounding'[^\n]*timeoutMs/.test(main), 'run_link_grounding carries a leash (same slow-judge class)');

// The SECOND dead consumer (found chasing degree drift): run_integrity_audit died at 90s on every
// cadence too — the full audit loop re-scans an 8.75M-edge graph to convergence.
ok(/name: 'run_integrity_audit'[^\n]*timeoutMs/.test(main), 'run_integrity_audit carries the leash (the second dead consumer)');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
