/* smoke_security_deps.js — security self-audit, increment 3c (2026-09-04): the dependency advisory scanner.
 *
 * Reads package-lock.json (npm v2/v3) + uv.lock (PyPI), asks OSV which exact versions carry an advisory,
 * details each one (summary, severity, first fixed version) and produces a finding per advisory. Offline:
 * a canned fetch plays OSV and records every URL, so the smoke pins the one-fixed-host law, the dev-only
 * cap, the withdrawn skip, the fail-soft on a dead network, and the off-scope refusal.
 */
'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const D = require('../lib/security_deps');

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// ── the lockfile fixtures ───────────────────────────────────────────────────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq_secdeps_'));
fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
  '': { name: 'fixture', version: '0.0.0' },
  'node_modules/lodash': { version: '4.17.15' },
  'node_modules/leftpad': { version: '1.0.0', dev: true },
  'node_modules/a': { version: '1.0.0' },
  'node_modules/a/node_modules/lodash': { version: '4.17.15', dev: true },   // a nested dev copy of a prod package — still prod
} }));
fs.writeFileSync(path.join(dir, 'uv.lock'), [
  'version = 1', '',
  '[[package]]', 'name = "fixture-proj"', 'version = "0.1.0"', 'source = { editable = "." }', 'dependencies = [', '    { name = "requests" },', ']', '',
  '[[package]]', 'name = "requests"', 'version = "2.25.0"', 'source = { registry = "https://pypi.org/simple" }', '',
  '[[package]]', 'name = "urllib3"', 'version = "1.26.5"', 'source = { registry = "https://pypi.org/simple" }', '',
].join('\n'));

const npm = D.readNpmLock(path.join(dir, 'package-lock.json'));
ok(npm.length === 3 && !!npm.find((p) => p.name === 'lodash' && p.version === '4.17.15' && p.dev === false), `readNpmLock: 3 installed packages, lodash prod (${npm.length})`);
ok(npm.find((p) => p.name === 'leftpad').dev === true && npm.every((p) => p.ecosystem === 'npm'), 'readNpmLock: leftpad is dev-only');
const py = D.readUvLock(path.join(dir, 'uv.lock'));
ok(py.length === 2 && py.every((p) => p.ecosystem === 'PyPI') && !py.some((p) => p.name === 'fixture-proj'), `readUvLock: 2 registry packages, the editable project skipped (${py.length})`);
ok(D.manifestsOf(dir).length === 2 && D.manifestsOf(os.tmpdir()).length === 0, 'manifestsOf finds both lockfiles under a root, none elsewhere');

// ── a canned OSV ────────────────────────────────────────────────────────────────────────────────
const urls = [];
const VULNS = {
  'GHSA-1': { id: 'GHSA-1', summary: 'Prototype Pollution in lodash', aliases: ['CVE-2020-8203'], database_specific: { severity: 'HIGH' },
    affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] },
  'GHSA-2': { id: 'GHSA-2', summary: 'leftpad rce', database_specific: { severity: 'CRITICAL' }, affected: [] },
  'GHSA-3': { id: 'GHSA-3', details: 'requests leaks proxy auth\nmore text', affected: [{ package: { name: 'requests', ecosystem: 'PyPI' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '2.31.0' }] }] }] },
  'GHSA-W': { id: 'GHSA-W', summary: 'withdrawn', withdrawn: '2024-01-01T00:00:00Z' },
};
const IDS = { 'lodash@4.17.15': ['GHSA-1'], 'leftpad@1.0.0': ['GHSA-2'], 'requests@2.25.0': ['GHSA-3', 'GHSA-W'] };
const fetchImpl = async (url, init) => {
  urls.push(url);
  if (url.endsWith('/v1/querybatch')) {
    const q = JSON.parse(init.body).queries;
    return { ok: true, json: async () => ({ results: q.map((x) => ({ vulns: (IDS[`${x.package.name}@${x.version}`] || []).map((id) => ({ id })) })) }) };
  }
  const id = decodeURIComponent(url.split('/v1/vulns/')[1] || '');
  return VULNS[id] ? { ok: true, json: async () => VULNS[id] } : { ok: false, status: 404 };
};

D.scanDeps([dir], { deps: { fetchImpl, gate: () => true } }).then(async (r) => {
  ok(r.ok && r.packages === 5 && r.advisories === 3 && r.findings.length === 3, `scanDeps: 5 packages, 3 advisories — the withdrawn one skipped (${JSON.stringify({ packages: r.packages, advisories: r.advisories })})`);
  const lo = r.findings.find((f) => /GHSA-1/.test(f.title));
  ok(!!lo && lo.severity === 'high' && /lodash@4\.17\.15/.test(lo.title) && /Prototype Pollution/.test(lo.evidence) && /CVE-2020-8203/.test(lo.evidence), 'a HIGH advisory names package@version, the summary, the CVE alias');
  ok(!!lo && /upgrade lodash to >= 4\.17\.21/.test(lo.proposed_fix) && /osv\.dev\/vulnerability\/GHSA-1/.test(lo.proposed_fix), 'the fix proposes the first FIXED version + the advisory URL');
  const lp = r.findings.find((f) => /GHSA-2/.test(f.title));
  ok(!!lp && lp.severity === 'medium' && /dev-only/.test(lp.evidence), 'a CRITICAL on a dev-only package is capped at medium and says so');
  const rq = r.findings.find((f) => /GHSA-3/.test(f.title));
  ok(!!rq && rq.severity === 'medium' && /requests leaks proxy auth/.test(rq.evidence) && /uv\.lock$/.test(rq.asset) && /2\.31\.0/.test(rq.proposed_fix),
    'a PyPI advisory without a db severity is medium; summary falls back to details line 1; asset = the lockfile');
  ok(r.findings.every((f) => f.class === 'dependency' && f.proposed_fix), 'every finding is class dependency with a fix');
  ok(urls.length >= 3 && urls.every((u) => u.startsWith(`${D.OSV_HOST}/`)), `every request goes to the ONE fixed host (${urls.length} calls)`);

  // ── fail-soft + the boundary ──────────────────────────────────────────────────────────────────
  const dead = await D.scanDeps([dir], { deps: { fetchImpl: async () => { throw new Error('offline'); }, gate: () => true } });
  ok(dead.ok === false && /offline/.test(dead.error) && dead.packages === 5 && dead.findings.length === 0, 'a dead network is reported; packages still counted; no finding invented');
  const nofetch = await D.scanDeps([dir], { deps: { fetchImpl: 42, gate: () => true } });
  ok(nofetch.ok === false && /no fetch/.test(nofetch.error), 'no fetch available → an honest error, never a throw');
  const off = await D.scanDeps([dir], { deps: { fetchImpl, gate: () => false } });
  ok(off.packages === 0 && off.findings.length === 0 && off.notes.some((n) => /off-scope/.test(n)), 'an off-scope root is noted and never read');

  // ── contract pins ─────────────────────────────────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'security_deps.js'), 'utf8');
  ok(/startsWith\(`\$\{OSV_HOST\}\/`\)/.test(src) && /refusing a non-OSV host/.test(src), '_fetchJson refuses any URL off OSV_HOST by construction');
  const scan = fs.readFileSync(path.join(__dirname, '..', 'lib', 'security_scan.js'), 'utf8');
  ok(/security_deps'\)\.scanDeps\(/.test(scan) && /ZOE_SECURITY_DEPS/.test(scan) && /depsScan === false/.test(scan),
    'runScanOnce runs the dependency scan on the main thread behind ZOE_SECURITY_DEPS, skippable per call');

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  console.log(`\nsmoke_security_deps: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('scanDeps test threw:', e); process.exit(1); });
