'use strict';
/*
 * lib/security_config.js — security self-audit, increment 3c (2026-09-04): the READ-ONLY config reviewer.
 * The "config and auth" class of the toolkit (design §3: exposed binds, weak defaults, permissive CORS,
 * hardening switched off). It rides the same walk and scope gate as the secret scanner (every path is
 * cleared before it is opened), runs a line-level CHECK table — each with a severity and a concrete fix —
 * and two FILE-level checks that ask git (read-only `ls-files`) whether a secret-bearing file is TRACKED:
 * a .env or a config carrying a token that lives in history is the highest-value config finding there is.
 * Non-destructive: reads files and the git index, no network, no model, no writes beyond the findings the
 * caller records. Findings aggregate per (file, check): seven `sandbox: false` windows in main.js are ONE
 * finding with a count, not seven rows. Comment lines never fire. The smoke drives it over a fixture with
 * an injected gate + tracked-predicate, offline.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const scope = require('./security_scope');
const secfind = require('./security_findings');
const scan = require('./security_scan');

// Each check: a line regex, a severity, a title, a proposed fix. `mask` names the capture group that is
// a credential (the mask law applies — evidence never carries the value).
const CHECKS = [
  { id: 'tls-verify-off', severity: 'high', title: 'TLS verification disabled',
    re: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[=:]\s*["']?0\b|\bverify\s*=\s*False\b|_create_unverified_context\b|CURLOPT_SSL_VERIFYPEER\s*,\s*(?:false|0)\b/,
    fix: 'verify TLS — drop rejectUnauthorized:false / verify=False; pin a CA bundle instead if the peer is self-signed' },
  { id: 'renderer-hardening-off', severity: 'high', title: 'Electron renderer hardening off',
    re: /nodeIntegration\s*:\s*true|contextIsolation\s*:\s*false|webSecurity\s*:\s*false|allowRunningInsecureContent\s*:\s*true|enableRemoteModule\s*:\s*true/,
    fix: 'keep nodeIntegration:false + contextIsolation:true + webSecurity:true on every BrowserWindow; expose only a preload bridge' },
  { id: 'renderer-sandbox-off', severity: 'low', title: 'Electron renderer sandbox disabled',
    re: /\bsandbox\s*:\s*false\b/,
    fix: 'set sandbox:true where the preload does not need Node — a sandboxed renderer confines a compromised page' },
  { id: 'bind-all-interfaces', severity: 'high', title: 'server bound to all interfaces',
    // a BIND shape only — listen(…, '0.0.0.0'), host="0.0.0.0", --host 0.0.0.0, bind(('0.0.0.0', …)); a host
    // allowlist that merely NAMES 0.0.0.0 (an SSRF guard) is not a bind
    re: /(?:\blisten\s*\([^)]*|\b(?:host|hostname|bind|address)\s*[:=]\s*|--(?:host|bind)[\s=]+|\bbind\s*\(\s*\(?\s*)["']?0\.0\.0\.0\b/i,
    fix: 'bind local services to 127.0.0.1 — her doors are loopback-only by design; a 0.0.0.0 bind widens the boundary to the LAN' },
  { id: 'cors-wildcard', severity: 'medium', title: 'permissive CORS (wildcard origin)',
    re: /Access-Control-Allow-Origin['"]?\s*[,:=]\s*['"]\*['"]|\borigin\s*:\s*['"]\*['"]|allow_origins\s*=\s*\[\s*["']\*["']\s*\]/i,
    fix: 'allow only the origins that need the door; a wildcard lets any page in a browser call it' },
  { id: 'debug-inspector', severity: 'medium', title: 'debug inspector / remote debugging flag',
    re: /--inspect(?:-brk)?\b|--remote-debugging-port\b/,
    fix: 'strip --inspect from any launch used outside a dev session; a --remote-debugging-port must stay loopback-only (never paired with --remote-debugging-address) — an open inspector is code execution for whoever reaches the port' },
  { id: 'creds-in-url', severity: 'high', title: 'credentials embedded in a URL', mask: 1,
    re: /\bhttps?:\/\/[^\s/:@'"]+:([^\s@'"]{4,})@[^\s'"]+/i,
    fix: 'move the credential out of the URL into the keychain / env and pass it as a header; URLs land in logs and history' },
];

const _COMMENT = /^(?:\/\/|#|\*|\/\*|<!--|--\s|;)/;                    // a commented-out setting is not a setting
const _ENV = /^\.env(?:\..+)?$/;                                        // .env, .env.local, .env.production …
const _ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist)$/i;     // a template holds no values
const SELF_RE = /^security_(?:config|scan|deps)\.js$/;                  // the audit's own pattern tables would fire on themselves

function _accept(name) { return !SELF_RE.test(name) && (_ENV.test(name) || scan._acceptDefault(name)); }

// Read-only: the set of files the git index carries under a root — ONE `git ls-files` per root (git decides
// which repo: the SQ tree lives under the Desktop repo, Echo's under NX ECHO), not one spawn per file.
// Any failure — no git, no repo — is an empty set, so nothing escalates on a guess.
function trackedIndex(root) {
  const set = new Set();
  try {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    for (const rel of String(out).split('\0')) if (rel) set.add(path.resolve(root, rel).toLowerCase());
  } catch {}
  return set;
}
function isTracked(file, root) { return trackedIndex(root || path.dirname(file)).has(path.resolve(file).toLowerCase()); }

function _snippet(line, m, check, secretRes) {
  if (secretRes.some((re) => re.test(line))) return '<line also carries a secret — see its secret finding>';
  let s = line.trim();
  if (check.mask && m[check.mask]) s = s.replace(m[check.mask], secfind.maskSecret(m[check.mask]));
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
}

/**
 * Review an in-scope root's configuration. Returns { ok, scanned, found, findings, capped }. `deps`:
 *   gate        — path→bool (default lib/security_scope.pathInScope; the smoke injects one for a fixture)
 *   tracked     — path→bool (default: the root's git index, read once; injectable)
 *   secretFiles — the secret scanner's findings (or paths) in this root; a TRACKED file becomes a high finding
 *   maxFiles    — the walk cap
 * The root itself must be in scope, or it returns { ok:false, why }.
 */
function scanConfig(root, { deps = {} } = {}) {
  const gate = deps.gate || scope.pathInScope;
  const secretFiles = deps.secretFiles || [];
  const maxFiles = deps.maxFiles || scan.MAX_FILES;
  if (!gate(root)) return { ok: false, why: `root off-scope: ${root}` };
  let idx = null;   // the git index, read lazily and once — only when a file-level check needs it
  const tracked = deps.tracked || ((f) => { if (!idx) idx = trackedIndex(root); return idx.has(path.resolve(f).toLowerCase()); });
  const files = [];
  scan._walk(root, files, gate, maxFiles, _accept);
  const secretRes = scan.PATTERNS.map((p) => p.re);
  const hits = new Map();   // `${file}::${check.id}` → { check, file, lines, snippet }
  let scanned = 0;
  for (const f of files) {
    let text;
    try { if (fs.statSync(f).size > scan.MAX_FILE) continue; text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    scanned++;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i], t = line.trim();
      if (!t || _COMMENT.test(t)) continue;
      for (const c of CHECKS) {
        const m = c.re.exec(line);
        if (!m) continue;
        const k = `${f}::${c.id}`;
        let h = hits.get(k);
        if (!h) { h = { check: c, file: f, lines: [], snippet: null }; hits.set(k, h); }
        h.lines.push(i + 1);
        if (h.snippet == null) h.snippet = _snippet(line, m, c, secretRes);
      }
    }
  }
  const findings = [];
  for (const h of hits.values()) {
    const base = path.basename(h.file);
    findings.push({
      asset: h.file, class: 'config', severity: h.check.severity,
      title: `${h.check.title} in ${base}`,
      evidence: `${base}:${h.lines[0]}${h.lines.length > 1 ? ` (+${h.lines.length - 1} more)` : ''} — ${h.snippet}`,
      proposed_fix: h.check.fix,
    });
  }
  // File-level: a real .env in the index, and any secret-bearing file the git index carries.
  for (const f of files) {
    const base = path.basename(f);
    if (!_ENV.test(base) || _ENV_TEMPLATE.test(base) || !tracked(f)) continue;
    findings.push({ asset: f, class: 'config', severity: 'critical', title: `.env file tracked by git (${base})`,
      evidence: `${path.relative(root, f) || base} is in the git index`,
      proposed_fix: 'git rm --cached the file, add it to .gitignore, and rotate every value it holds — it lives in history now' });
  }
  // secretFiles: paths, or finding objects — a LOW one (a test fixture's fake secret) never escalates its file
  const secretPaths = secretFiles.map((x) => (x && typeof x === 'object') ? (x.severity === 'low' ? null : x.asset) : x).filter(Boolean);
  const seen = new Set();
  for (const f of secretPaths) {
    if (seen.has(f)) continue;
    seen.add(f);
    if (!tracked(f)) continue;
    const n = secretPaths.filter((x) => x === f).length;
    findings.push({ asset: f, class: 'config', severity: 'high', title: `secret-bearing file tracked by git (${path.basename(f)})`,
      evidence: `${path.basename(f)} is in the git index and carries ${n} secret finding(s)`,
      proposed_fix: 'move the values to env / the keychain and rotate them; keep the tracked file a template' });
  }
  return { ok: true, scanned, found: findings.length, findings, capped: files.length >= maxFiles };
}

module.exports = { scanConfig, isTracked, trackedIndex, CHECKS, SELF_RE };
