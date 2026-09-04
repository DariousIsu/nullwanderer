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
  'ComfyUI-Zluda', 'foundations', 'git_mirrors', '.cache', 'coverage', '.pytest_cache']);
const SCAN_EXT = new Set(['.js', '.cjs', '.mjs', '.ts', '.py', '.json', '.toml', '.yaml', '.yml', '.env',
  '.sh', '.ps1', '.ini', '.cfg', '.conf']);
const MAX_FILE = 512 * 1024;   // a secret scanner is not for blobs

// Each pattern captures the SECRET (group `g`, default the whole match) so it can be masked. A placeholder
// or an env reference in an assignment is not a leak, so the assignment pattern screens those out.
const PATTERNS = [
  { name: 'private key block', severity: 'critical', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', severity: 'high', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', severity: 'high', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', severity: 'high', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'GitHub token', severity: 'high', re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/ },
  { name: 'OpenAI-style key', severity: 'high', re: /\bsk-[A-Za-z0-9]{24,}\b/ },
  { name: 'secret assignment', severity: 'medium', g: 1,
    re: /\b(?:api[_-]?key|secret|token|password|passwd|client[_-]?secret|access[_-]?token)\b\s*[:=]\s*["']([^"'\s]{12,})["']/i },
];

const _PLACEHOLDER = /^(?:x{3,}|\.{3,}|<[^>]+>|\$\{?[a-z_.]+\}?|process\.env|os\.environ|your[_-]?\w*|changeme|change[_-]?me|placeholder|example|examplekey|test|dummy|null|none|true|false|redacted)/i;

function _walk(root, out, gate) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      _walk(p, out, gate);
    } else if (e.isFile()) {
      if (!SCAN_EXT.has(path.extname(e.name).toLowerCase())) continue;
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
  if (!gate(root)) return { ok: false, why: `root off-scope: ${root}` };
  const files = [];
  _walk(root, files, gate);
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
        if (pat.g && _PLACEHOLDER.test(val)) continue;   // a placeholder / env-ref assignment is not a leak
        const finding = {
          asset: f, class: 'secret', severity: pat.severity,
          title: `${pat.name} in ${path.basename(f)}`,
          evidence: `${path.basename(f)}:${i + 1} — ${secfind.maskSecret(val)}`,
          proposed_fix: 'move the secret to the OS keychain / env and rotate it if it was ever committed',
        };
        findings.push(finding);
        if (record) { try { record({ ...finding, run_id: deps.runId || null }, { nowMs: now }); } catch {} }
      }
    }
  }
  return { ok: true, scanned: files.length, found: findings.length, findings };
}

module.exports = { scanSecrets, PATTERNS, SKIP_DIRS, SCAN_EXT, MAX_FILE };
