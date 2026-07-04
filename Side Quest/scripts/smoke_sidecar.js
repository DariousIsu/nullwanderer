/**
 * Offline smoke for lib/sidecar.js — the JS⇄Python bridge. Uses an injected fake execFile (no Python), so it
 * runs in the gate. Verifies the job is piped to stdin, results parse, and every failure mode is fail-soft.
 * Run: node scripts/smoke_sidecar.js
 */
const S = require('../lib/sidecar');

let pass = 0, fail = 0;
function ok(name, cond, detail = '') { if (cond) { pass++; console.log(`  PASS ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); } }

// fake execFile: returns a child with a capturing stdin, fires the callback async with canned output.
function fakeExec(canned, capture) {
  return (py, args, optsOrCb, cb) => {
    const done = typeof optsOrCb === 'function' ? optsOrCb : cb;
    if (capture) { capture.py = py; capture.args = args; capture.stdin = ''; }
    setImmediate(() => done(canned.err || null, canned.stdout != null ? canned.stdout : '', canned.stderr || ''));
    return { stdin: { write: (s) => { if (capture) capture.stdin += s; }, end: () => {} } };
  };
}

const RESULT = JSON.stringify({ ok: true, wall_ms: 12, pool: 3, ran: ['fundamentals'], results: [{ model: 'fundamentals', ok: true, seats: [{ seat: 'H-CA-22', margin: 8.3 }] }], ensemble: { method: 'mean', seats: [] } });

(async () => {
  // pythonCandidates: env + venv + launchers
  const cands = S.pythonCandidates();
  ok('pythonCandidates includes a venv path + launchers', cands.some((c) => c.includes('.venv')) && cands.includes('python'));

  // happy path: job piped to stdin, results parsed
  const cap = {};
  const r = await S.runModels({ models: ['fundamentals'], inputs: { races: [{ seat: 'H-CA-22' }] } }, { execFile: fakeExec({ stdout: RESULT }, cap), python: 'python' });
  ok('runModels parses the orchestrator result', r.ok === true && r.results[0].model === 'fundamentals' && r.results[0].seats[0].margin === 8.3);
  ok('runModels pipes the job JSON to stdin', cap.stdin.includes('"races"') && JSON.parse(cap.stdin).models[0] === 'fundamentals');
  ok('runModels invokes orchestrator.py', cap.args[0] === 'orchestrator.py');

  // fail-soft: exec error → {ok:false,error}
  const e1 = await S.runModels({ inputs: {} }, { execFile: fakeExec({ err: new Error('ENOENT python'), stderr: 'not found' }), python: 'python' });
  ok('fail-soft on spawn error', e1.ok === false && /not found|ENOENT/.test(e1.error));

  // fail-soft: non-JSON stdout → parse error
  const e2 = await S.runModels({ inputs: {} }, { execFile: fakeExec({ stdout: 'Traceback: boom' }), python: 'python' });
  ok('fail-soft on non-JSON stdout', e2.ok === false && /parse/.test(e2.error));

  // fail-soft: execFile throws synchronously
  const e3 = await S.runModels({ inputs: {} }, { execFile: () => { throw new Error('spawn EACCES'); }, python: 'python' });
  ok('fail-soft when execFile throws', e3.ok === false && /exec:/.test(e3.error));

  // listModels parses the --list output
  const models = await S.listModels({ execFile: fakeExec({ stdout: JSON.stringify({ models: ['poll_baseline', 'fundamentals'] }) }), python: 'python' });
  ok('listModels returns the registered models', Array.isArray(models) && models.includes('fundamentals'));
  const modelsErr = await S.listModels({ execFile: fakeExec({ err: new Error('x') }), python: 'python' });
  ok('listModels fail-soft → []', Array.isArray(modelsErr) && modelsErr.length === 0);

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
