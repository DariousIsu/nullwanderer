/**
 * lib/keystore.js — inherit Echo's secret resolution (so Zoe shares the engine's cloud auth).
 *
 * Zoe is built ON TOP of Echo: rather than reimplement OS-keychain access (backend-specific, and
 * a duplicate of a thing Echo already does correctly), Zoe asks Echo's OWN resolver for the key.
 * It shells to Echo's venv Python and calls `echo.api_keys.get_key(name)`, which walks the exact
 * three-tier chain Echo uses — process env → OS keychain (Windows Credential Manager, service
 * "nx-echo") → repo .env. The value is returned over stdout into Zoe's memory and (optionally)
 * set on process.env. It is NEVER written to a file or logged — same handling Echo gives it.
 *
 * This is the seam that lets the verification harness's classify leaf run on the cloud frontier:
 * once OLLAMA_API_KEY is hydrated, lib/models.sources() resolves the cloud endpoint and bearer,
 * and ollama.complete() can reach https://ollama.com — the SAME credential the engine uses.
 */
'use strict';
const { execFileSync } = require('child_process');

// Resolve a single secret via Echo's get_key (env → keychain → .env). Returns the value or null.
// Never logs the value. `python` = Echo's venv interpreter, `cwd` = Echo repo root (for the import).
function resolveEchoKey(name, { python, cwd, timeoutMs = 10000 } = {}) {
  if (!python || !cwd) return null;
  // Print only the raw value to stdout; suppress stderr so a keyring warning never leaks anything.
  const code = `from echo.api_keys import get_key\nimport sys\nv=get_key(${JSON.stringify(String(name))}, required=False)\nsys.stdout.write(v or "")`;
  try {
    const out = execFileSync(python, ['-c', code], { cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const v = (out || '').trim();
    return v || null;
  } catch (e) {
    return null;
  }
}

// Hydrate process.env from Echo's keychain for any of `names` not already present (env wins, so a
// real env var is never overwritten). Returns { resolved:[names set from Echo], missing:[unresolved] }
// — names only, never values, so the result is safe to log.
function hydrateFromEcho(names, opts = {}) {
  const resolved = [], missing = [];
  for (const name of (Array.isArray(names) ? names : [names])) {
    if (process.env[name]) { resolved.push(name); continue; }
    const v = resolveEchoKey(name, opts);
    if (v) { process.env[name] = v; resolved.push(name); } else { missing.push(name); }
  }
  return { resolved, missing };
}

module.exports = { resolveEchoKey, hydrateFromEcho };
