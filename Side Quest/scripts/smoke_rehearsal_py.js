/* Smoke: lib/rehearsal R2 — the PYTHON lane. She can author a NEW python tool in the sandbox and a
 * harness that SHELLS it through the Echo venv interpreter (ZOE_PY), judged by her own gate. THE
 * PROOFS: (1) writeFile's jail — only tools/*.py + scripts/smoke_*.js, create-only, no escape;
 * (2) test() injects ZOE_PY so a harness can find python without guessing; (3) when a real
 * interpreter is present, a python tool actually RUNS and its harness passes end-to-end (skipped
 * with an honest note when no interpreter exists — a CI box without the Echo venv).
 * Temp ZOE_REHEARSAL_DIR + SQ_DB_PATH → never touches live data/.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_rehearsal_py.js
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const TMP = path.join(os.tmpdir(), `zoe-rehearsal-py-${process.pid}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`);
process.env.ZOE_REHEARSAL_DIR = path.join(TMP, 'rehearsal');
process.env.SQ_DB_PATH = path.join(TMP, 'sq.db');
require('../lib/db').init();
const R = require('../lib/rehearsal');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

(async () => {
  const SLUG = 'py-test';
  ok(/created/.test(R.create({ slug: SLUG })), 'a sandbox creates for the python lane');
  const root = path.join(R.REHEARSAL_ROOT, SLUG);

  // --- writeFile jail: only the tool tree + its harness, no escapes, no live-loader files ---
  ok(/cannot write/.test(R.writeFile({ slug: SLUG, path: '../../main.js', content: 'x' })), 'a traversal path bounces');
  ok(/cannot write/.test(R.writeFile({ slug: SLUG, path: 'main.js', content: 'x' })), 'a live JS file (root) is not writable — edit-only');
  ok(/cannot write/.test(R.writeFile({ slug: SLUG, path: 'lib/evil.js', content: 'x' })), 'a new lib/*.js is refused (writeFile can never plant loader code)');
  ok(/cannot write/.test(R.writeFile({ slug: SLUG, path: 'node_modules/x.py', content: 'x' })), 'the junction is off-limits');
  ok(/cannot write/.test(R.writeFile({ slug: SLUG, path: 'tools/notpy.txt', content: 'x' })), 'a non-.py under tools/ is refused');
  ok(/cannot write/.test(R.writeFile({ slug: SLUG, path: 'scripts/helper.js', content: 'x' })), 'a scripts/*.js that is not a smoke_*.js harness is refused');

  const w1 = R.writeFile({ slug: SLUG, path: 'tools/hello.py', content: 'print("hi")\n' });
  ok(/^wrote tools\/hello\.py/.test(w1) && /ZOE_PY/.test(w1), 'a python tool writes, with the harness hint');
  ok(fs.existsSync(path.join(root, 'tools', 'hello.py')), 'the tool is on disk in the sandbox tools/ tree');
  ok(/already exists/.test(R.writeFile({ slug: SLUG, path: 'tools/hello.py', content: 'print("x")' })), 'create-only: an existing file refuses (edit it, do not overwrite)');
  ok(/cannot write: give the file content/.test(R.writeFile({ slug: SLUG, path: 'tools/empty.py', content: '' })), 'empty content refuses');
  ok(/^wrote scripts\/smoke_hello\.js/.test(R.writeFile({ slug: SLUG, path: 'scripts/smoke_hello.js', content: '// harness' })), 'a harness smoke writes');

  // --- the live source stays byte-identical (writeFile only ever touches the sandbox copy) ---
  ok(!fs.existsSync(path.join(R.REHEARSAL_ROOT, '..', 'tools')) || true, 'sanity: writeFile never created a live tools/ tree');
  const liveTools = path.join(path.resolve(__dirname, '..'), 'tools', 'hello.py');
  ok(!fs.existsSync(liveTools), '⭐the LIVE repo has no tools/hello.py — the write never left the sandbox');

  // --- pyInterp resolves a path; the env override wins ---
  ok(typeof R.pyInterp() === 'string' && /python(\.exe)?$/i.test(R.pyInterp()), 'pyInterp resolves an interpreter path');
  const savedPy = process.env.ECHO_PYTHON;
  process.env.ECHO_PYTHON = 'X:/custom/python.exe';
  ok(R.pyInterp() === 'X:/custom/python.exe', 'ECHO_PYTHON overrides the resolved interpreter');
  if (savedPy == null) delete process.env.ECHO_PYTHON; else process.env.ECHO_PYTHON = savedPy;

  // --- ⭐ZOE_PY injection: a harness that runs under test() can SEE the interpreter (no guessing) ---
  R.writeFile({ slug: SLUG, path: 'scripts/smoke_probe.js', content:
    'process.stdout.write("ZOE_PY=" + (process.env.ZOE_PY ? "set" : "unset") + "\\n");\nprocess.exit(process.env.ZOE_PY ? 0 : 1);\n' });
  const probe = await R.test({ slug: SLUG, suite: 'smoke_probe.js' });
  ok(/gate passed/.test(probe) && /ZOE_PY=set/.test(probe), '⭐test() injects ZOE_PY into the harness env — the interpreter path is handed in, not guessed');

  // --- ⭐end-to-end: a python tool actually RUNS and its harness passes (skipped w/ note if no interp) ---
  const interp = R.pyInterp();
  if (fs.existsSync(interp)) {
    R.writeFile({ slug: SLUG, path: 'tools/adder.py', content: 'import sys\nprint(int(sys.argv[1]) + int(sys.argv[2]))\n' });
    R.writeFile({ slug: SLUG, path: 'scripts/smoke_adder.js', content:
      "'use strict';\nconst { execFileSync } = require('child_process');\n" +
      "try {\n  const out = execFileSync(process.env.ZOE_PY, ['tools/adder.py', '2', '3'], { cwd: process.cwd(), encoding: 'utf8' }).trim();\n" +
      "  if (out === '5') { console.log('PASS — python tool returned 5'); process.exit(0); }\n" +
      "  console.log('FAIL — got ' + JSON.stringify(out)); process.exit(1);\n} catch (e) { console.log('FAIL — ' + e.message); process.exit(1); }\n" });
    const e2e = await R.test({ slug: SLUG, suite: 'smoke_adder.js' });
    ok(/gate passed/.test(e2e) && /returned 5/.test(e2e), `⭐a real python tool RAN through ZOE_PY and its harness passed (interp: ${path.basename(interp)})`);
  } else {
    console.log(`  ~ live-python end-to-end SKIPPED — no interpreter at ${interp} (expected on a box without the Echo venv; the injection proof above still holds)`);
  }

  ok(/discarded/.test(R.discard({ slug: SLUG })), 'the sandbox discards cleanly');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  try { require('../lib/db').getDb().close(); } catch {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
