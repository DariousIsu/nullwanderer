'use strict';
/**
 * lib/email_prefilter.js — a SAFE, no-handshake pre-filter run BEFORE an ESP test-send, to cull obvious
 * waste without touching a mail server's SMTP dialog.
 *
 * Research (2026-07-09): a self-run SMTP port-25 RCPT-TO probe is redundant risk — it looks identical to
 * spam reconnaissance (blacklist exposure on the SAME IP the real ESP sends from) and is inconclusive
 * against catch-all / Google / Microsoft anyway. The authoritative deliverability signal is the ESP
 * send-and-bounce loop we already run. So this module deliberately does the OPPOSITE of a prober: it only
 * does cheap, zero-reputation-risk checks — syntax, MX-record PRESENCE (DNS, not SMTP), disposable-domain,
 * and role-address flagging — to avoid spending a send on something that can't possibly land.
 *
 *   verdict 'reject' — bad syntax / no MX / disposable domain (never worth a send)
 *   verdict 'flag'   — a role address (info@/support@) — kept, but marked (research: flag, don't drop)
 *   verdict 'pass'   — worth an ESP test-send; the bounce loop answers mailbox-exists authoritatively
 *
 * The MX lookup is INJECTED (default Node dns.promises.resolveMx) so the pure checks stay offline-testable
 * and a network hiccup FAILS OPEN (mx:'unknown' → not rejected — we never drop on our own DNS blip).
 */

// A compact starter list of the most common disposable/throwaway domains. Extensible via opts.disposable —
// the full ~76k-domain list is data, not code; this catches the bulk of real-world junk cheaply.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'yopmail.com', 'throwawaymail.com', 'getnada.com', 'trashmail.com', 'sharklasers.com',
  'maildrop.cc', 'dispostable.com', 'fakeinbox.com', 'mailnesia.com', 'mohmal.com', 'emailondeck.com',
  'moakt.com', 'tempinbox.com', 'mailcatch.com', 'spamgourmet.com', 'mytemp.email', 'burnermail.io',
  'temp-mail.io', '33mail.com', 'inboxbear.com', 'tempmailo.com', 'discard.email',
]);

// Role / functional local-parts — flagged (a real person may still read them; research says flag not drop).
const ROLE_LOCALPARTS = new Set([
  'info', 'support', 'admin', 'sales', 'contact', 'hello', 'team', 'office', 'billing', 'hr', 'jobs',
  'careers', 'noreply', 'no-reply', 'donotreply', 'help', 'service', 'enquiries', 'inquiries', 'press',
  'media', 'marketing', 'webmaster', 'postmaster', 'abuse', 'legal', 'accounts', 'finance', 'general',
]);

const _EMAIL_RE = /^[^\s@"()[\]:;,<>]+@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

function parts(email) {
  const s = String(email || '').trim();
  const at = s.lastIndexOf('@');
  if (at <= 0) return { local: null, domain: null };
  return { local: s.slice(0, at).toLowerCase(), domain: s.slice(at + 1).toLowerCase() };
}

// --- the cheap, pure sub-checks -------------------------------------------------------------------
function validSyntax(email) { return _EMAIL_RE.test(String(email || '').trim()); }
function isDisposable(domain, { disposable = DISPOSABLE } = {}) {
  return (disposable instanceof Set ? disposable : new Set(disposable || [])).has(String(domain || '').toLowerCase());
}
function isRole(local) {
  const l = String(local || '').toLowerCase();
  return ROLE_LOCALPARTS.has(l) || /^(noreply|no-reply|donotreply)$/.test(l);
}

// --- the async pre-filter (adds the DNS MX-presence check; still NO SMTP handshake) ---------------
async function prefilter(email, { resolveMx = null, disposable = DISPOSABLE } = {}) {
  const { local, domain } = parts(email);
  const checks = { syntax: false, mx: 'unknown', disposable: false, role: false };
  const out = (verdict, reason) => ({ email: String(email || '').trim(), local, domain, verdict, reason, checks });

  checks.syntax = validSyntax(email);
  if (!checks.syntax) return out('reject', 'syntax');

  checks.disposable = isDisposable(domain, { disposable });
  if (checks.disposable) return out('reject', 'disposable');

  checks.role = isRole(local);

  // MX PRESENCE — DNS only, never an SMTP dialog. Default to Node's resolver; injectable for tests.
  let resolver = resolveMx;
  if (!resolver) { try { resolver = require('dns').promises.resolveMx; } catch { resolver = null; } }
  if (resolver) {
    try {
      const mx = await resolver(domain);
      checks.mx = Array.isArray(mx) && mx.length > 0;
      if (checks.mx === false) return out('reject', 'no-mx');   // domain resolves but accepts no mail
    } catch (e) {
      // NXDOMAIN / ENOTFOUND → the domain can't receive mail → reject; any other (timeout, SERVFAIL) →
      // unknown → FAIL OPEN (don't drop on our own DNS blip; the ESP send will find out).
      const code = e && e.code;
      if (code === 'ENOTFOUND' || code === 'NXDOMAIN' || code === 'ENODATA') { checks.mx = false; return out('reject', 'no-mx'); }
      checks.mx = 'unknown';
    }
  }

  return out(checks.role ? 'flag' : 'pass', checks.role ? 'role-address' : null);
}

module.exports = { DISPOSABLE, ROLE_LOCALPARTS, parts, validSyntax, isDisposable, isRole, prefilter };
