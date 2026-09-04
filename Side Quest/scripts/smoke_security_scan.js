/* smoke_security_scan.js — security self-audit, increment 2 (2026-09-04): the READ-ONLY secret scanner.
 *
 * Walks an in-scope root, matches known secret shapes, records a MASKED finding per hit. The scope gate
 * clears every file first; placeholders and env refs are not leaks; vendored trees and non-code files are
 * skipped; the value never appears in a finding. Driven over a temp fixture with an injected gate, offline.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const SC = require('../lib/security_scan');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── a fixture tree with real-looking secrets, placeholders, and trees that must be skipped ──────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_secscan_'));
const w = (rel, body) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
w('src/secrets.js', 'const apiKey = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";\nconst password = "supersecret123456";\n');
w('config.env', 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\nDEBUG=true\n');
w('src/placeholder.js', 'const secret = "xxxxxxxxxxxx";\nconst password = "changeme12345";\nconst token = "your-token-here-please";\n');
w('README.md', 'Set your key like sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 in the env.\n');   // .md — not scanned
w('node_modules/leaky/index.js', 'const k = "sk-ZZZZZZZZZZZZZZZZZZZZZZZZZZ";\n');           // vendored — skipped

const hits = [];
const res = SC.scanSecrets(dir, { deps: { gate: () => true, record: (f) => hits.push(f) } });
ok(res.ok && res.scanned >= 3, `scans in-scope code/config files (${res.scanned} files)`);

const titles = res.findings.map((f) => f.title).join(' | ');
ok(/OpenAI-style key/.test(titles), 'finds the sk- OpenAI-style key');
ok(/AWS access key id/.test(titles), 'finds the AWS access key id');
ok(res.findings.some((f) => /secret assignment/.test(f.title) && /secrets\.js/.test(f.title)), 'finds the quoted password assignment');

ok(!res.findings.some((f) => /placeholder\.js/.test(f.asset)), 'a placeholder / env-ref / your-token assignment is NOT flagged');
ok(!res.findings.some((f) => /README\.md/.test(f.asset)), 'a .md file is not scanned (code + config only)');
ok(!res.findings.some((f) => /node_modules/.test(f.asset)), 'the node_modules tree is skipped');

// ── the mask law: the value never appears in a finding ──────────────────────────────────────────
const allEvidence = res.findings.map((f) => f.evidence).join('\n');
ok(/redacted/.test(allEvidence) && !/ABCDEFGHIJKLMNOPQRSTUVWXYZ/.test(allEvidence) && !/supersecret123456/.test(allEvidence),
  'evidence is MASKED — the raw secret value is never stored');
ok(res.findings.every((f) => f.class === 'secret' && ['critical', 'high', 'medium'].includes(f.severity) && f.proposed_fix),
  'every finding is class secret, carries a severity, and proposes the rotate-to-keychain fix');

// ── the recorder was fed, and the scope gate is enforced ────────────────────────────────────────
ok(hits.length === res.findings.length, 'each finding is handed to the injected recorder');
ok(SC.scanSecrets(dir, { deps: { gate: () => false } }).ok === false, 'an off-scope root is refused (the boundary holds)');

// ── contract: the scanner defaults to the real boundary + the mask door ─────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'security_scan.js'), 'utf8');
ok(/require\('\.\/security_scope'\)/.test(src) && /scope\.pathInScope/.test(src), 'defaults its gate to lib/security_scope.pathInScope');
ok(/security_findings.*maskSecret|secfind\.maskSecret/.test(src), 'masks through lib/security_findings.maskSecret');
ok(/node_modules/.test(String(SC.SKIP_DIRS.has('node_modules'))) || SC.SKIP_DIRS.has('node_modules'), 'skips vendored trees by construction');

// ── increment 3: the OFF-THREAD organ + the read door ───────────────────────────────────────────
{
  const fw = require('../lib/fs_worker');
  ok(typeof fw.securityScan === 'function' && typeof fw.securityScanSync === 'function', 'fs_worker exposes the security-scan job (off-thread) + its sync predicate');
  // securityScanSync uses the REAL scope gate, so an off-scope fixture root is SKIPPED, not scanned —
  // the boundary holds inside the worker just as at the door.
  const res3 = fw.securityScanSync({ roots: [dir] });
  ok(Array.isArray(res3) && res3[0] && res3[0].skipped && (res3[0].scanned || 0) === 0, 'securityScanSync refuses an off-scope root (the boundary holds in the worker)');

  const fwsrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'fs_worker.js'), 'utf8');
  ok(/kind === 'security-scan'/.test(fwsrc) && /require\('\.\/security_scan'\)/.test(fwsrc), 'the worker handles the security-scan job, requiring the scanner lazily');

  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  ok(/maybeSecurityScan = async/.test(main) && /ZOE_SECURITY_SCAN\b/.test(main), 'main.js runs the scan organ behind the ZOE_SECURITY_SCAN kill switch');
  ok(/fs_worker'\)\.securityScan\(/.test(main) && /secfind\.record\(/.test(main), 'the organ dispatches OFF-THREAD and records the findings on the main thread');
  ok(/last_security_scan_at/.test(main), 'the organ is cooldown-gated (nightly)');

  const tp = fs.readFileSync(path.join(__dirname, '..', 'lib', 'test_port.js'), 'utf8');
  ok(/req\.url\.startsWith\('\/security'\)/.test(tp), 'GET /security serves the boundary + the findings');
}

try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
console.log(`\nsmoke_security_scan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
