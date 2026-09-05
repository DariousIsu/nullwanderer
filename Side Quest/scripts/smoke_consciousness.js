// smoke_consciousness — the consciousness subroutine's fast loop (sidecar/consciousness.py) is Python; its pins
// are pytest (sidecar/tests). This smoke runs them under the Echo venv so the SQ gate carries them, and pins the
// --once wire shape from this side. A missing venv is a loud red, never a silent skip (every red is mine).
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const ROOT = path.join(__dirname, '..');
const PY = process.env.ECHO_PY || path.join(ROOT, '..', 'NX ECHO', 'nx-echo', '.venv', 'Scripts', 'python.exe');
ok(fs.existsSync(PY), `the Echo venv python exists (${PY})`);
const r = spawnSync(PY, ['-m', 'pytest', path.join(ROOT, 'sidecar', 'tests'), '-q', '-p', 'no:cacheprovider'], { encoding: 'utf8', timeout: 120000 });
const tail = String(r.stdout || '').trim().split('\n').slice(-3).join(' | ');
ok(r.status === 0 && /passed/.test(r.stdout || '') && !/failed/.test(r.stdout || ''), `pytest sidecar/tests is green by exit code (${tail})`);
// the wire: --once takes {now, percepts} and answers {state, outputs}; a stranger after 9 s while he is away → shield + deliver + a perform ask
const M = 60000;
const st0 = JSON.parse(spawnSync(PY, [path.join(ROOT, 'sidecar', 'consciousness.py'), '--once'], { input: JSON.stringify({ now: 0, percepts: [{ kind: 'percept', sense: 'face', present: true, is_him: true }] }), encoding: 'utf8' }).stdout).state;
const st1 = JSON.parse(spawnSync(PY, [path.join(ROOT, 'sidecar', 'consciousness.py'), '--once'], { input: JSON.stringify({ state: st0, now: 30 * M, percepts: [{ kind: 'percept', sense: 'presence', state: 'away' }, { kind: 'percept', sense: 'face', present: true, is_him: false }] }), encoding: 'utf8' }).stdout).state;
const res = JSON.parse(spawnSync(PY, [path.join(ROOT, 'sidecar', 'consciousness.py'), '--once'], { input: JSON.stringify({ state: st1, now: 30 * M + 9000, percepts: [{ kind: 'percept', sense: 'face', present: true, is_him: false }] }), encoding: 'utf8' }).stdout);
const acts = res.outputs.map((o) => o.act || o.op);
ok(acts.includes('shield') && acts.includes('deliver') && acts.includes('perform') && res.state.shield.on === true, `the wire: a stranger at his desk → ${acts.join(', ')}`);
ok(res.outputs.every((o) => o.kind === 'act' || o.kind === 'reason') && res.outputs.find((o) => o.kind === 'reason').budget_ms > 0, 'every output is an act or a budgeted reasoning request — never a decision to act asked of a model');
console.log(`\nsmoke_consciousness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
