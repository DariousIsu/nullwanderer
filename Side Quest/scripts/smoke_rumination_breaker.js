/**
 * Backtest — rumination escalation circuit breaker.
 * After ESC_MAX escalations in the window, escalate() must trip a long cooldown so
 * the eternal respawn (focus #56→#57→#58…) can't continue. nameFn injected so no
 * LLM/network. Temp DB via SQ_DB_PATH.
 *
 * Run: $env:ELECTRON_RUN_AS_NODE=1; .\node_modules\.bin\electron.cmd scripts\smoke_rumination_breaker.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_breaker_${Date.now()}.db`);

const D = require('../lib/db');
D.init();
const focusLib = require('../lib/focus');
const rumination = require('../lib/rumination');

// UPDATED 2026-08-12 (wave-3 triage): under the DEFAULT contract (S3 autonomic demotion),
// escalate → setFromText returns null — the escalation valve is INERT in production (the window is
// still consumed, so no spin; whether an inert valve is the intended end-state is flagged as an
// open design question). The breaker MECHANICS below (cooldown after ESC_MAX, timestamps) only
// exist on the legacy path, so this suite pins them under the documented kill switch.
process.env.ZOE_AUTONOMIC = '0';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

// distinct goals each time — mimics the reworded "stop overanalyzing typos/words/messages"
let i = 0;
const goals = ['Stop overanalyzing his typos', 'Stop overanalyzing his words', 'Stop overanalyzing his messages'];
const nameFn = async () => goals[i++ % goals.length];
const thoughts = (n) => [{ id: n * 10 + 1, content: 'x' }, { id: n * 10 + 2, content: 'y' }];

(async () => {
  console.log('escalation circuit breaker:');

  const s1 = await rumination.escalate(thoughts(1), 'Lucas', { nameFn });
  ok('escalation #1 spawns a focus', !!s1);
  ok('no cooldown after #1', parseInt(D.getMeta('rumination_cooldown_until') || '0', 10) <= Date.now());

  focusLib.clear('test');  // focus "resolves" in one tick → cleared, as in the live loop

  const s2 = await rumination.escalate(thoughts(2), 'Lucas', { nameFn });
  ok('escalation #2 spawns a focus', !!s2);
  const cd = parseInt(D.getMeta('rumination_cooldown_until') || '0', 10);
  ok('cooldown TRIPPED after #2 (breaker)', cd > Date.now());
  ok('cooldown is ~2h long', cd - Date.now() > 90 * 60 * 1000);

  // with cooldown set, detect() must refuse to fire even on fresh circling thoughts
  focusLib.clear('test');
  const det = await rumination.detect({ embedFn: async () => [1, 0, 0] });
  ok('detect() blocked while breaker cooldown active', det.ruminating === false && det.reason === 'cooldown');

  const escCount = JSON.parse(D.getMeta('rumination_escalations') || '[]').length;
  ok('escalation timestamps recorded', escCount === 2);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { D.getDb().close(); } catch {}
  try { fs.unlinkSync(process.env.SQ_DB_PATH); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
