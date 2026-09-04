/* smoke_security_config.js — security self-audit, increment 3c (2026-09-04): the READ-ONLY config reviewer.
 *
 * Reviews an in-scope root for weak settings — TLS verification off, Electron renderer hardening off,
 * 0.0.0.0 binds, wildcard CORS, debug ports, credentials in URLs — and asks the git index whether a .env
 * or a secret-bearing file is tracked. Comment lines never fire; a host guard that merely names 0.0.0.0 is
 * not a bind; hits aggregate per (file, check); creds are masked. Driven over a temp fixture with an
 * injected gate + tracked-predicate, offline; the real git index is read once against this repo.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const CFG = require('../lib/security_config');
const SC = require('../lib/security_scan');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── a fixture tree: weak settings, a comment-only decoy, a guard that names 0.0.0.0, tracked env/config ──
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_seccfg_'));
const w = (rel, body) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
w('src/server.js', [
  'const agent = new https.Agent({ rejectUnauthorized: false });',
  '// rejectUnauthorized: false — a comment is not a setting',
  "app.listen(8080, '0.0.0.0');",
  "res.setHeader('Access-Control-Allow-Origin', '*');",
  'const win = new BrowserWindow({ webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });',
  "const u = 'https://alice:hunter2pass@internal.example/api';",
].join('\n'));
w('src/guard.js', "if (h === 'localhost' || h === '0.0.0.0') return true;\n");        // names 0.0.0.0 — an SSRF guard, not a bind
w('src/quiet.js', '// nodeIntegration: true\n# verify=False\nconst x = 1;\n');       // comments only
w('main.js', 'a({ sandbox: false });\nb({ sandbox: false });\nc({ sandbox: false });\n');
w('svc.py', 'r = requests.get(url, verify=False)\nuvicorn.run(app, host="0.0.0.0", port=8000)\n');
w('package.json', JSON.stringify({ scripts: { debug: 'electron --inspect=9229 .' } }));
w('.env', 'API_KEY=abc\n');
w('.env.example', 'API_KEY=\n');
w('config.toml', 'admin_token = "x"\n');
w('tests/test_thing.py', 'token = "fixture"\n');
w('README.md', 'rejectUnauthorized: false\n');   // .md — not reviewed

const trackedSet = new Set(['.env', '.env.example', 'config.toml', path.join('tests', 'test_thing.py')].map((r) => path.join(dir, r)));
const res = CFG.scanConfig(dir, { deps: { gate: () => true, tracked: (f) => trackedSet.has(f), secretFiles: [
  { asset: path.join(dir, 'config.toml'), severity: 'medium' },
  { asset: path.join(dir, 'tests', 'test_thing.py'), severity: 'low' },   // a fixture's fake secret
] } });
ok(res.ok && res.scanned >= 8, `reviews the in-scope code/config files (${res.scanned} files)`);
const by = (re) => res.findings.filter((f) => re.test(f.title));

ok(by(/TLS verification disabled in server\.js/).length === 1 && by(/TLS verification disabled in svc\.py/).length === 1, 'TLS-off in JS (rejectUnauthorized:false) and Python (verify=False)');
ok(by(/renderer hardening off in server\.js/).length === 1 && by(/renderer hardening off/)[0].severity === 'high', 'nodeIntegration:true / contextIsolation:false is HIGH');
const sb = by(/sandbox disabled in main\.js/);
ok(sb.length === 1 && /\(\+2 more\)/.test(sb[0].evidence) && sb[0].severity === 'low', 'three sandbox:false lines in one file aggregate to ONE low finding (+2 more)');
ok(by(/bound to all interfaces in server\.js/).length === 1 && by(/bound to all interfaces in svc\.py/).length === 1, "listen(…,'0.0.0.0') and host=\"0.0.0.0\" are binds");
ok(!res.findings.some((f) => /guard\.js/.test(f.asset)), 'a host guard that merely NAMES 0.0.0.0 is not a bind');
ok(by(/permissive CORS/).length === 1, 'the wildcard CORS origin');
ok(by(/debug inspector/).length === 1 && /package\.json$/.test(by(/debug inspector/)[0].asset), '--inspect in a launch script');
const cu = by(/credentials embedded in a URL/);
ok(cu.length === 1 && /redacted/.test(cu[0].evidence) && !/hunter2pass/.test(cu[0].evidence), 'creds-in-URL evidence is MASKED — the credential never appears');
ok(!res.findings.some((f) => /quiet\.js/.test(f.asset)), 'comment lines never fire');
ok(!res.findings.some((f) => /README\.md/.test(f.asset)), 'a .md file is not reviewed');

// ── the git-index checks ────────────────────────────────────────────────────────────────────────
ok(by(/\.env file tracked by git \(\.env\)/).length === 1 && by(/\.env file tracked/)[0].severity === 'critical', 'a tracked .env is CRITICAL');
ok(!res.findings.some((f) => /\.env\.example/.test(f.title)), 'a tracked .env.example is a template, not a finding');
ok(by(/secret-bearing file tracked by git \(config\.toml\)/).length === 1 && by(/secret-bearing/)[0].severity === 'high', 'a tracked secret-bearing file is HIGH');
ok(!res.findings.some((f) => /test_thing/.test(f.title)), 'a LOW (fixture) secret never escalates its file');
ok(res.findings.every((f) => f.class === 'config' && f.proposed_fix && f.evidence), 'every finding is class config with evidence + a fix');
ok(CFG.scanConfig(dir, { deps: { gate: () => false } }).ok === false, 'an off-scope root is refused (the boundary holds)');

// ── the REAL git index, read once per root (this repo) ──────────────────────────────────────────
const SQ = path.join(__dirname, '..');
ok(CFG.isTracked(path.join(SQ, 'package.json'), SQ) === true, 'isTracked: package.json is in this repo\'s index');
ok(CFG.isTracked(path.join(SQ, 'no_such_file_xyz.js'), SQ) === false, 'isTracked: an absent file is not');
ok(CFG.trackedIndex(dir).size === 0, 'a root outside any repo yields an empty index (nothing escalates on a guess)');

// ── contract: never reviews its own tables or fixtures; the worker runs it after the secret scan ──
ok(CFG.SELF_RE.test('security_config.js') && CFG.SELF_RE.test('security_scan.js') && CFG.SELF_RE.test('security_deps.js'), 'the audit never reviews its own pattern tables');
ok(SC.SKIP_FILE_RE.test('smoke_security_config.js') && SC.SKIP_FILE_RE.test('smoke_security_deps.js'), 'and never its own fixtures');
const fwsrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fs_worker.js'), 'utf8');
ok(/require\('\.\/security_config'\)/.test(fwsrc) && /scanConfig\(root, \{ deps: \{ gate: scope\.pathInScope, secretFiles: r\.findings \}/.test(fwsrc),
  'the worker runs the config review after the secret scan, handing it the secret findings');
ok(CFG.CHECKS.length >= 7 && CFG.CHECKS.every((c) => c.id && c.re instanceof RegExp && c.severity && c.title && c.fix), `every check carries id, regex, severity, title, fix (${CFG.CHECKS.length} checks)`);

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nsmoke_security_config: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
