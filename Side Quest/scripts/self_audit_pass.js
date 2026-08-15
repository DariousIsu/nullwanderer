/* scripts/self_audit_pass.js — the Stage-1 self-audit SWEEP, in a child process (spawned by
 * lib/self_audit.spawnPass). The full-repo detector run measures ~8s — on the main thread that is
 * a daily stall, so the expensive half lives here. No DB access: prints ONE JSON line
 * {findings:[...]} and exits; the parent does the ledger/mint/obs work.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/self_audit_pass.js
 */
'use strict';
try {
  const sa = require(require('path').join(__dirname, '..', 'lib', 'self_audit'));
  const corpus = sa.collectCorpus({});
  const findings = sa.runDetectors(corpus, { nowMs: Date.now() });
  console.log(JSON.stringify({ findings }));
} catch (e) {
  console.log(JSON.stringify({ findings: null, error: e.message }));
}
