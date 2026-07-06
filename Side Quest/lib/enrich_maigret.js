/**
 * lib/enrich_maigret.js — Node wrapper over the maigret enrichment SIDECAR (SPIKE).
 *
 * Given usernames, spawns the Python venv runner (sidecar/maigret_enrich.py) and returns the discovered
 * public accounts per username. CONSUME-ONLY at this layer too: this returns data; it writes NOTHING to
 * the Puller or CRM. Callers decide what to persist — and per the Puller certainty model a discovered
 * account is a LOW-GRADE observation (a shared username is NOT proof of the same person) that must be
 * verified before it becomes a belief.
 *
 * MIT-licensed maigret (soxoj/maigret) runs in its own venv (sidecar/maigret_venv), isolated from the
 * forecasting sidecar's deps. PYTHONUTF8=1 is set in the child env — REQUIRED on Windows (maigret's banner
 * prints a unicode heart that crashes cp1252).
 */
'use strict';
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const VENV_PY = IS_WIN
  ? path.join(ROOT, 'sidecar', 'maigret_venv', 'Scripts', 'python.exe')
  : path.join(ROOT, 'sidecar', 'maigret_venv', 'bin', 'python');
const RUNNER = path.join(ROOT, 'sidecar', 'maigret_enrich.py');

// --- pure: candidate usernames for a contact ------------------------------------------------------
// The strongest signal is the email LOCALPART (jsmith@x.com → "jsmith"); we add a couple of name-derived
// forms (first.last / firstlast / flast). Deduped, lowercased, junk-stripped. A real integration would
// prefer a KNOWN handle (CRM social_handle) over these guesses; guesses are inherently false-positive-prone.
function candidateUsernames(contact) {
  const out = [];
  const seen = new Set();
  const add = (u) => {
    const s = String(u || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
    if (s.length >= 3 && s.length <= 40 && !seen.has(s)) { seen.add(s); out.push(s); }
  };
  const email = String((contact && contact.email) || '').trim();
  if (email.includes('@')) {
    const local = email.split('@')[0];
    if (!/^(info|contact|hello|admin|office|press|media|team|support|sales|general)$/i.test(local)) add(local);
  }
  const name = String((contact && contact.name) || '').trim();
  const toks = name.toLowerCase().split(/\s+/).filter((t) => /^[a-z][a-z'-]+$/.test(t));
  if (toks.length >= 2) {
    const first = toks[0], last = toks[toks.length - 1];
    add(`${first}.${last}`); add(`${first}${last}`); add(`${first[0]}${last}`);
  }
  return out;
}

// --- spawn the sidecar for a batch of usernames ----------------------------------------------------
// Returns { ok, count, results:[{username, accounts:[{site,url,tags,ids}]}] } | { ok:false, error }.
// Fail-soft: a spawn error, a non-zero exit, unparseable output, or a timeout all resolve to {ok:false}.
function enrichUsernames(usernames, { topSites = 50, timeout = 8, wallMs = 180000, python = VENV_PY } = {}) {
  return new Promise((resolve) => {
    const job = JSON.stringify({ usernames: usernames || [], top_sites: topSites, timeout });
    let child;
    try {
      child = spawn(python, [RUNNER], {
        cwd: ROOT,
        env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) { return resolve({ ok: false, error: 'spawn failed: ' + e.message, results: [] }); }

    let out = '', err = '', done = false;
    const finish = (v) => { if (!done) { done = true; try { clearTimeout(timer); } catch {} resolve(v); } };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, error: 'timeout', results: [] }); }, wallMs);

    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish({ ok: false, error: 'child error: ' + e.message, results: [] }));
    child.on('close', (code) => {
      if (code !== 0 && !out.trim()) return finish({ ok: false, error: `exit ${code}: ${err.slice(-300)}`, results: [] });
      try { finish(JSON.parse(out)); }
      catch { finish({ ok: false, error: 'unparseable output: ' + out.slice(0, 200), results: [] }); }
    });
    try { child.stdin.write(job); child.stdin.end(); } catch (e) { finish({ ok: false, error: 'stdin write failed: ' + e.message, results: [] }); }
  });
}

module.exports = { candidateUsernames, enrichUsernames, VENV_PY, RUNNER };
