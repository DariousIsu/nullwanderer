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

// Personal email providers — a localpart from one of these is a plausible personal handle. A WORK-email
// localpart (jsmith@ferc.gov) is NOT treated as a handle here (that was the noisy path in the spike).
const PERSONAL_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'aol.com', 'gmx.com']);
const _norm = (s) => String(s == null ? '' : s).toLowerCase().trim();
const _tokens = (s) => _norm(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

// --- pure: the KNOWN handles for a contact (his choice: known handles only, NOT work-email/name guesses).
// Sources: (1) CRM social_handle rows already linked to this contact [{platform,handle}], carried as a
// high-provenance source; (2) the localpart of a PERSONAL email only. Returns [{username, source, platform}].
function knownHandles(contact, crmHandles = []) {
  const out = [];
  const seen = new Set();
  const add = (u, source, platform) => {
    const s = _norm(u).replace(/[^a-z0-9._-]/g, '');
    const key = s + '|' + (platform || '');
    if (s.length >= 3 && s.length <= 40 && !seen.has(key)) { seen.add(key); out.push({ username: s, source, platform: platform || null }); }
  };
  for (const h of (Array.isArray(crmHandles) ? crmHandles : [])) add(h && (h.handle || h.Handle__c), 'crm', h && (h.platform || h.Platform__c));
  const email = _norm((contact && contact.email) || '');
  if (email.includes('@')) {
    const [local, domain] = email.split('@');
    if (PERSONAL_DOMAINS.has(domain) && !/^(info|contact|hello|admin|office|press|media|team|support|sales|general|noreply)$/.test(local)) add(local, 'personal-email', null);
  }
  return out;
}

// --- pure: CORROBORATION gate (his choice: require 2+ signals before staging anything). A discovered
// account is kept ONLY if at least TWO independent signals tie it to the contact. Signals:
//   name  — the account's extracted profile name token-matches the contact's name
//   org   — the account's profile text mentions the contact's company/employer
//   prov  — the searched handle came from a CRM official/verified handle (high provenance)
// Returns { corroborated, score, signals:[...] }. Pure; no I/O.
function corroborate(account, contact, { source = null } = {}) {
  const signals = [];
  const ids = (account && account.ids) || {};
  const idsText = Object.values(ids).map((v) => _norm(v)).join(' ');
  // name signal
  const profileName = _norm(ids.fullname || ids.full_name || ids.name || [ids.first_name, ids.last_name].filter(Boolean).join(' '));
  const want = _tokens(contact && contact.name);
  if (profileName && want.length) {
    const got = new Set(_tokens(profileName));
    const overlap = want.filter((w) => got.has(w)).length;
    if (overlap >= Math.min(2, want.length)) signals.push('name');
  }
  // org signal — a distinctive company token (len>=4) appears in the profile text
  const orgToks = _tokens(contact && contact.company).filter((t) => t.length >= 4);
  if (orgToks.length && orgToks.some((t) => idsText.includes(t))) signals.push('org');
  // provenance signal — a CRM official handle (we already trust it points at this person)
  if ((source || (account && account.source)) === 'crm') signals.push('prov');
  return { corroborated: signals.length >= 2, score: signals.length, signals };
}

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

module.exports = { candidateUsernames, knownHandles, corroborate, enrichUsernames, PERSONAL_DOMAINS, VENV_PY, RUNNER };
