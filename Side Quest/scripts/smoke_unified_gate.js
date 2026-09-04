/* smoke_unified_gate.js — stage 5 (2026-09-04): ONE gate over BOTH suites, gated by exit code per side.
 *
 * Runs the Side Quest smoke gate and/or the Echo pytest gate (+ ruff F821) and ANDs their exit codes.
 * Driven with an injected exec that records each spawn and returns a canned {code, stdout}, offline — so
 * the smoke pins the command shapes, the per-side AND, the ruff short-circuit, and the side selection
 * WITHOUT running either real suite.
 */
'use strict';
const path = require('path');
const G = require('../lib/unified_gate');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// A canned exec: records the spawn, returns {code, stdout} from a per-call script. Matches child_process
// execFile's (cmd, args, opts, cb) shape; a nonzero code arrives as an err carrying .code.
function mkExec(script) {
  const calls = [];
  const exec = (cmd, args, opts, cb) => {
    calls.push({ cmd, args, opts });
    const r = script({ cmd, args, opts }) || { code: 0, stdout: '' };
    const err = r.code ? Object.assign(new Error('exit'), { code: r.code }) : null;
    setTimeout(() => cb(err, r.stdout || '', r.stderr || ''), 0);
  };
  return { exec, calls };
}
const isRuff = (a) => a.includes('ruff');
const isPytest = (a) => a.includes('pytest');
const isSmokes = (a) => a.some((x) => /run_smokes\.js$/.test(String(x)));

(async () => {
  // ── the SQ gate: the ELECTRON binary, ELECTRON_RUN_AS_NODE, run_smokes.js, cwd = SQ root ──────────
  {
    const { exec, calls } = mkExec(() => ({ code: 0, stdout: '✅ ALL GREEN — 621 suites passed, 0 failed' }));
    const r = await G.runSqGate({ deps: { exec } });
    ok(r.ok && r.code === 0 && /621 suites passed, 0 failed/.test(r.summary), `SQ gate green, summary parsed (${r.summary})`);
    ok(calls.length === 1 && isSmokes(calls[0].args) && /electron/i.test(calls[0].cmd), 'SQ gate spawns the electron binary on scripts/run_smokes.js');
    ok(calls[0].opts.env.ELECTRON_RUN_AS_NODE === '1' && calls[0].opts.cwd === G.SQ_ROOT, 'as node (ELECTRON_RUN_AS_NODE=1), cwd = the Side Quest root');
  }
  // a red SQ gate is red whatever it printed (exit code is the verdict)
  {
    const { exec } = mkExec(() => ({ code: 1, stdout: 'blah 3 suites passed, 2 failed' }));
    const r = await G.runSqGate({ deps: { exec } });
    ok(!r.ok && r.code === 1, 'SQ gate: a nonzero exit is red even with a printed count');
  }

  // ── the Echo gate: ruff F821 THEN pytest -q, cwd = Echo root ──────────────────────────────────────
  {
    const { exec, calls } = mkExec(({ args }) => isRuff(args) ? { code: 0, stdout: '' } : { code: 0, stdout: '4291 passed, 118 deselected in 140.2s' });
    const r = await G.runEchoGate({ deps: { exec } });
    ok(r.ok && /4291 passed, 118 deselected/.test(r.summary), `Echo gate green, pytest summary parsed (${r.summary})`);
    ok(calls.length === 2 && isRuff(calls[0].args) && isPytest(calls[1].args), 'Echo gate runs ruff F821 first, then pytest');
    ok(calls.every((c) => c.opts.cwd === G.ECHO_ROOT) && calls[1].args.join(' ').includes('pytest -q'), 'both run in the Echo root; pytest is `-q`');
    ok(/[\\/]python(\.exe)?$/i.test(calls[0].cmd) || /python/i.test(calls[0].cmd), 'the Echo gate uses the venv python');
  }
  // ruff short-circuits pytest (an undefined name would break every test)
  {
    const { exec, calls } = mkExec(({ args }) => isRuff(args) ? { code: 1, stdout: "echo/x.py:3:1: F821 undefined name 'foo'" } : { code: 0, stdout: 'should not run' });
    const r = await G.runEchoGate({ deps: { exec } });
    ok(!r.ok && /ruff F821 failed/.test(r.summary), 'a ruff F821 failure is red and named');
    ok(calls.length === 1 && isRuff(calls[0].args), 'pytest never runs when ruff is red (short-circuit)');
  }
  // a pytest failure is red (nonzero exit)
  {
    const { exec } = mkExec(({ args }) => isRuff(args) ? { code: 0, stdout: '' } : { code: 1, stdout: '4288 passed, 3 failed' });
    const r = await G.runEchoGate({ deps: { exec } });
    ok(!r.ok && r.code === 1 && /FAILURES/.test(r.summary), 'Echo gate: a pytest failure is red');
  }
  // ruff can be turned off (a caller that only wants the test verdict)
  {
    const { exec, calls } = mkExec(() => ({ code: 0, stdout: '4291 passed' }));
    await G.runEchoGate({ deps: { exec }, ruff: false });
    ok(calls.length === 1 && isPytest(calls[0].args), 'ruff:false skips ruff, runs pytest only');
  }

  // ── runGate: side selection + the per-side AND ───────────────────────────────────────────────────
  {
    const green = ({ args }) => isRuff(args) ? { code: 0, stdout: '' } : { code: 0, stdout: isSmokes(args) ? '621 suites passed, 0 failed' : '4291 passed' };
    // sq only
    let e = mkExec(green);
    let r = await G.runGate({ sides: ['sq'], deps: { exec: e.exec } });
    ok(r.ok && r.sq && r.echo === null && e.calls.length === 1, 'runGate({sides:[sq]}) runs ONLY the SQ gate');
    // echo only
    e = mkExec(green);
    r = await G.runGate({ sides: ['echo'], deps: { exec: e.exec } });
    ok(r.ok && r.echo && r.sq === null, 'runGate({sides:[echo]}) runs ONLY the Echo gate');
    // both green → ok
    e = mkExec(green);
    r = await G.runGate({ deps: { exec: e.exec } });
    ok(r.ok && r.sq.ok && r.echo.ok && r.sides.join(',') === 'sq,echo', 'runGate default runs both; both green → ok');
    // sq green, echo red → NOT ok (the AND)
    e = mkExec(({ args }) => isRuff(args) ? { code: 0, stdout: '' } : (isSmokes(args) ? { code: 0, stdout: '621 suites passed, 0 failed' } : { code: 1, stdout: '4288 passed, 3 failed' }));
    r = await G.runGate({ deps: { exec: e.exec } });
    ok(!r.ok && r.sq.ok && !r.echo.ok, 'one red side fails the whole gate (exit code ANDed per side)');
    ok(/GATE RED/.test(G.describe(r)) && /SQ ✓/.test(G.describe(r)) && /ECHO ✗/.test(G.describe(r)), 'describe() reports GATE RED with per-side marks');
  }

  // ── sidesForPaths: route a change to the side it touches ──────────────────────────────────────────
  {
    const sqFile = path.join(G.SQ_ROOT, 'lib', 'foo.js');
    const echoFile = path.join(G.ECHO_ROOT, 'echo', 'bar.py');
    ok(G.sidesForPaths([sqFile]).join() === 'sq', 'an SQ path routes to the sq side');
    ok(G.sidesForPaths([echoFile]).join() === 'echo', 'an Echo path routes to the echo side');
    ok(G.sidesForPaths([sqFile, echoFile]).sort().join() === 'echo,sq', 'a mixed change routes to both');
    ok(G.sidesForPaths(['lib/foo.js']).join() === 'sq', 'an SQ-relative path routes to sq');
  }

  console.log(`\nsmoke_unified_gate: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('unified_gate smoke threw:', e); process.exit(1); });
