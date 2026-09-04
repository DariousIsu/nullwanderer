'use strict';
/*
 * scripts/gate_all.js — stage 5: the ONE gate command over BOTH suites (Side Quest + Echo).
 *
 * `npm run gate` runs both suites and gates by exit code PER SIDE — green only when both are green. This is
 * the manual/developer form of lib/unified_gate; the pen's apply pipeline calls unified_gate directly for
 * the side(s) a change touches. It only TESTS — nothing here commits or pushes (Echo stays local by law).
 *
 * Run under electron-as-node (better-sqlite3 ABI):
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/gate_all.js  [--sq] [--echo] [--no-ruff]
 * With no side flag, both run.
 */
const gate = require('../lib/unified_gate');

(async () => {
  const argv = process.argv.slice(2);
  const only = [];
  if (argv.includes('--sq')) only.push('sq');
  if (argv.includes('--echo')) only.push('echo');
  const sides = only.length ? only : ['sq', 'echo'];
  const ruff = !argv.includes('--no-ruff');
  console.log(`[gate] running ${sides.join(' + ')} …`);
  const r = await gate.runGate({ sides, ruff });
  for (const s of sides) {
    const side = r[s];
    if (!side) continue;
    console.log(`\n──── ${s.toUpperCase()} ${side.ok ? 'PASS' : 'FAIL'} (exit ${side.code}) — ${side.summary}`);
    if (!side.ok) console.log(side.tail);
  }
  console.log(`\n${gate.describe(r)}`);
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('[gate] threw:', e && e.message); process.exit(1); });
