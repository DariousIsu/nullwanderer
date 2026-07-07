/**
 * lib/email_harvest.js — pull STATED email addresses out of PUBLIC page text (a confirmed profile, an org
 * bio, an about/contact page). Public info only: this reads text the caller already fetched from a public
 * page — it never guesses/invents an address, never touches auth-gated content, and drops data-broker
 * "reveal" teasers. Emails land as CITED, grade-graded observations upstream (verify-before-promote).
 *
 * Pure → offline-smoke-testable.
 */
'use strict';

const EMAIL_RE = /[a-z0-9][a-z0-9._%+\-]*@[a-z0-9.\-]+\.[a-z]{2,}/gi;
// junk localparts / domains that are never a person's real contact address
const JUNK_LOCAL = /^(no-?reply|do-?not-?reply|noreply|donotreply|postmaster|mailer-daemon|abuse|hostmaster|webmaster|admin|root|example|test|user|name|email|your|sentry)$/i;
const JUNK_DOMAIN = /(?:^|\.)(example\.(?:com|org|net)|test\.|localhost|sentry\.io|email\.com|domain\.com|yourcompany\.com|w3\.org|schema\.org|sentry-next\.)/i;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?)$/i;
// a MASKED / partial teaser ("j***@x.com", "•••", "[redacted]") — never a real address
function looksMasked(v) { return /\*{2,}|[•●]{2,}|X{3,}|\.{4,}|\b(redacted|hidden|protected)\b/i.test(String(v || '')); }

const _tokens = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2);

// extractEmails(text, { name, orgDomain }) → [{ email, confidence, reason }], best first. `name`/`orgDomain`
// (optional) raise confidence when the localpart matches the person's name or the domain matches the org.
function extractEmails(text, { name = '', orgDomain = '' } = {}) {
  const seen = new Set(); const out = [];
  const nameToks = _tokens(name);
  const orgDom = String(orgDomain || '').toLowerCase().replace(/^www\./, '');
  const matches = String(text || '').match(EMAIL_RE) || [];
  for (const raw of matches) {
    const email = raw.toLowerCase().replace(/[.,;:)]+$/, '');
    if (seen.has(email)) continue;
    if (looksMasked(email)) continue;
    if (ASSET_EXT.test(email)) continue;                         // a filename that looked email-ish
    const at = email.indexOf('@'); if (at < 1) continue;
    const local = email.slice(0, at), domain = email.slice(at + 1);
    if (JUNK_LOCAL.test(local)) continue;
    if (JUNK_DOMAIN.test(domain)) continue;
    if (local.length < 1 || domain.length < 4 || !domain.includes('.')) continue;
    seen.add(email);
    let conf = 0.5; const why = [];
    if (nameToks.some((t) => local.includes(t))) { conf += 0.2; why.push('name-in-localpart'); }
    if (orgDom && (domain === orgDom || domain.endsWith('.' + orgDom))) { conf += 0.15; why.push('org-domain'); }
    out.push({ email, confidence: Math.min(0.85, conf), reason: why.join('+') || 'stated' });
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

module.exports = { extractEmails, looksMasked, EMAIL_RE };
