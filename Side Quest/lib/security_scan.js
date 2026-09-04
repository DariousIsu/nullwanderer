'use strict';
/*
 * lib/security_scan.js — security self-audit, increment 2 (2026-09-04): the READ-ONLY secret scanner.
 * The first tool over the boundary lib/security_scope draws. It walks an IN-SCOPE root (the scope gate
 * clears every path before any file is opened), matches known secret shapes line by line, and produces a
 * finding per hit whose evidence is MASKED — the value is never stored (the mask law, via
 * lib/security_findings.maskSecret). Non-destructive: it reads files only, no network, no model, no writes
 * beyond the findings the caller records. Skips vendored/data trees and large blobs. The scheduled organ
 * (increment 3) drives this; the smoke drives it over a fixture with an injected gate, offline.
 */
const fs = require('fs');
const path = require('path');
const scope = require('./security_scope');
const secfind = require('./security_findings');

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'dist', 'build', '.venv', 'venv', '__pycache__',
  'ComfyUI-Zluda', 'foundations', 'git_mirrors', '.cache', 'coverage', '.pytest_cache',
  'sidecar', 'vendor', 'third_party', 'logs', 'tmp', 'temp', 'out']);   // vendored/generated trees, not her source
const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.py', '.json', '.toml', '.yaml', '.yml', '.env',
  '.sh', '.ps1', '.ini', '.cfg', '.conf']);
const MAX_FILE = 512 * 1024;   // a secret scanner is not for blobs
const MAX_FILES = 20000;       // a BOUNDED walk — never run away over a vendored tree (the p295 timeout: 58k sidecar files)
// The audit's OWN test fixtures intentionally carry fake secrets + weak settings to exercise the patterns — never flag them.
const SKIP_FILE_RE = /^smoke_security_\w+\.js$/;

// Each pattern captures the SECRET (group `g`, default the whole match) so it can be masked. A placeholder
// or an env reference in an assignment is not a leak, so the assignment pattern screens those out. The
// assignment name matches by SUFFIX (shared_token, admin_token, DB_PASSWORD) and tolerates a quoted key
// (JSON "password": "…"); a project-prefixed key shape (sk-proj-…) counts as an OpenAI-style key.
const PATTERNS = [
  { name: 'private key block', severity: 'critical', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', severity: 'high', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', severity: 'high', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'GitHub token', severity: 'high', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'OpenAI-style key', severity: 'high', re: /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{24,}/ },
  { name: 'secret assignment', severity: 'medium', g: 1,
    re: /\b\w*(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?token)\b\s*["']?\s*[:=]\s*["']([^"'\s]{12,})["']/i },
];

const _PLACEHOLDER = /^(?:x{3,}|\.{3,}|<[^>]+>|\$\{?[a-z_.]+\}?|process\.env|os\.environ|your[_-]?\w*|changeme|change[_-]?me|replace[_-]?me|placeholder|example|examplekey|sample|test|dummy|fake|mock|stub|null|none|true|false|redacted)/i;
const _ENV_NAME = /^[A-Z][A-Z0-9_]{5,}$/;   // `api_key = "ABUSEIPDB_API_KEY"` names the env var — it is not the value
// A secret in a test tree or a test file is almost always a fixture: still reported (a real one can land
// there), but LOW and named as such, and it never escalates the file as secret-bearing.
const _TEST_PATH = /(?:^|[\\/])(?:tests?|__tests__|spec|fixtures?)[\\/]|(?:^|[\\/])(?:test_[^\\/]+|[^\\/]+[._-](?:test|spec))\.[a-z]+$/i;

// The default file filter: code + config by extension, never the audit's own fixtures. A sibling scanner
// (lib/security_config) passes its own `accept` to widen the set (dot-env files carry no extension).
function _acceptDefault(name) { return !SKIP_FILE_RE.test(name) && SCAN_EXT.has(path.extname(name).toLowerCase()); }

function _walk(root, out, gate, cap, accept = _acceptDefault) {
  if (out.length >= cap) return;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= cap) return;
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      _walk(p, out, gate, cap, accept);
    } else if (e.isFile()) {
      if (!accept(e.name)) continue;
      if (gate && !gate(p)) continue;   // the scope gate — every file cleared before it is opened
      out.push(p);
    }
  }
}

/**
 * Scan an in-scope root for secrets. Returns { ok, scanned, found, findings }. `deps`:
 *   gate   — path→bool (default lib/security_scope.pathInScope; the smoke injects one for a fixture)
 *   record — security_findings.record-shaped; when given, each finding is recorded (masked)
 *   runId  — the audit run id to link findings to; now — the clock
 * The root itself must be in scope, or it returns { ok:false, why }.
 */
function scanSecrets(root, { deps = {} } = {}) {
  const gate = deps.gate || scope.pathInScope;
  const record = deps.record || null;
  const now = deps.now || Date.now();
  const maxFiles = deps.maxFiles || MAX_FILES;
  if (!gate(root)) return { ok: false, why: `root off-scope: ${root}` };
  const files = [];
  _walk(root, files, gate, maxFiles);
  const findings = [];
  for (const f of files) {
    let text;
    try { if (fs.statSync(f).size > MAX_FILE) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const pat of PATTERNS) {
        const m = pat.re.exec(line);
        if (!m) continue;
        const val = pat.g ? m[pat.g] : m[0];
        if (!val) continue;
        if (pat.g && (_PLACEHOLDER.test(val) || _ENV_NAME.test(val))) continue;   // a placeholder / env-ref / env-NAME assignment is not a leak
        const fixture = _TEST_PATH.test(f);
        const finding = {
          asset: f, class: 'secret', severity: fixture ? 'low' : pat.severity,
          title: `${pat.name} in ${path.basename(f)}${fixture ? ' (test fixture)' : ''}`,
          evidence: `${path.basename(f)}:${i + 1} — ${secfind.maskSecret(val)}`,
          proposed_fix: 'move the secret to the OS keychain / env and rotate it if it was ever committed',
        };
        findings.push(finding);
        if (record) { try { record({ ...finding, run_id: deps.runId || null }, { nowMs: now }); } catch {} }
      }
    }
  }
  return { ok: true, scanned: files.length, found: findings.length, findings, capped: files.length >= maxFiles };
}

/**
 * Run ONE audit pass and record its findings — the reusable operation both the nightly organ (main.js)
 * and the on-demand control-port door (POST /security/scan → the universal tool surface) call, so a scan
 * is the same whether she runs it herself, an operator asks for it, or the schedule fires. Three scanners
 * ride one pass: the secret scanner + the config reviewer (lib/security_config) walk the files OFF-THREAD
 * in lib/fs_worker; the dependency scanner (lib/security_deps) then reads the lockfiles on this thread and
 * asks OSV — the one network step, a failure there is a NOTE, never the pass's failure. Findings are
 * recorded on the caller's thread. No cooldown here — the organ owns the cadence; a manual trigger is
 * always allowed. Collaborators are injected (fs_worker, findings, ledger, scope, depsScan) so the smoke
 * drives it offline. Returns { ok, scanned, packages, recorded, summary, run_id, notes }.
 */
async function runScanOnce({ deps = {} } = {}) {
  const scope = deps.scope || require('./security_scope');
  const fw = deps.fsWorker || require('./fs_worker');
  const find = deps.findings || require('./security_findings');
  const ledger = deps.ledger || (() => { try { return require('./run_ledger'); } catch { return null; } })();
  const nowFn = deps.now || Date.now;
  const roots = deps.roots || scope.describe().roots;
  const trigger_kind = deps.trigger_kind || 'scheduled';
  let runId = null;
  try { if (ledger) runId = ledger.start({ role: 'security-audit', executor: 'sq', trigger_kind, lane: 'development', input_preview: `audit pass (secrets + config + deps) over ${roots.length} owned repo(s)`, now: nowFn() }); } catch {}
  let scanned = 0, packages = 0, recorded = 0, error = null;
  const notes = [];
  const rec = (f) => { const rr = find.record({ ...f, run_id: runId }, { nowMs: nowFn() }); if (rr && rr.id != null && !rr.deduped) recorded++; };
  try {
    const out = await fw.securityScan({ roots }, { timeoutMs: deps.timeoutMs || 180000 });
    for (const r of (out || [])) {
      scanned += r.scanned || 0;
      if (r.error) notes.push(`${path.basename(r.root || '')}: ${r.error}`);
      for (const f of (r.findings || [])) rec(f);
    }
  } catch (e) { error = (e && e.message) || String(e); }
  // The dependency advisories: main thread, one fixed public host (OSV). Kill switch ZOE_SECURITY_DEPS=0;
  // `depsScan: false` skips it (a caller that must stay offline), a function replaces it (the smoke).
  const depsOff = deps.depsScan === false || /^(0|false|no|off)$/i.test(String(process.env.ZOE_SECURITY_DEPS || '').trim());
  if (!depsOff) {
    try {
      const ds = deps.depsScan || ((rs) => require('./security_deps').scanDeps(rs));
      const d = await ds(roots);
      packages = (d && d.packages) || 0;
      for (const f of ((d && d.findings) || [])) rec(f);
      for (const n of ((d && d.notes) || [])) notes.push(n);
      if (d && d.error) notes.push(`deps: ${d.error}`);
    } catch (e) { notes.push(`deps: ${(e && e.message) || String(e)}`); }
  }
  const summary = find.summary();
  const output = `scanned ${scanned} files, ${packages} packages; ${recorded} new; ${summary.open} open${notes.length ? `; notes: ${notes.join(' | ')}` : ''}`;
  try { if (ledger && runId) ledger.finish(runId, { state: error ? 'failed' : 'succeeded', output: error ? null : output, error, now: nowFn() }); } catch {}
  return { ok: !error, scanned, packages, recorded, summary, run_id: runId, error, notes };
}

module.exports = { scanSecrets, runScanOnce, PATTERNS, SKIP_DIRS, SCAN_EXT, MAX_FILE, MAX_FILES, SKIP_FILE_RE, _walk, _acceptDefault };
