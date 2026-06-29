/* studio/puller_negatives.js — Puller: parse + normalize a verification-results file (one of the
 * three negative inputs; the others are the manual "mark bounced" action and a live verifier API).
 * PURE: parse CSV/TSV text → [{email, result, raw}] with statuses normalized to the canonical set
 * applyVerification understands. The actual apply (email→target resolution + belief update) is the
 * IPC/Slice-4 layer; this module only reads.
 *
 * Status mapping is grounded in published email-verification practice (validated 2026-06-26):
 *  - deliverable/valid                       → 'valid'        (credit)
 *  - undeliverable/invalid/hard-bounce       → 'invalid'      (negative → flip)
 *  - accept-all/catch-all                    → 'accept_all'   (domain untrustworthy; gate)
 *  - greylisted/timeout/risky/unknown (4xx)  → 'unknown'      (DEFER — never a hit or a miss)
 */
'use strict';

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

// Canonical result ← the many vendor spellings (Hunter, MailboxValidator, ZeroBounce, Apollo, …).
const STATUS_MAP = new Map(Object.entries({
  valid: 'valid', deliverable: 'valid', ok: 'valid', verified: 'valid', safe: 'valid', good: 'valid', exists: 'valid',
  invalid: 'invalid', undeliverable: 'invalid', bad: 'invalid', failed: 'invalid', bounce: 'invalid',
  hard_bounce: 'invalid', hardbounce: 'invalid', rejected: 'invalid', does_not_exist: 'invalid',
  no_mailbox: 'invalid', nonexistent: 'invalid', dead: 'invalid',
  accept_all: 'accept_all', acceptall: 'accept_all', 'accept-all': 'accept_all',
  catch_all: 'accept_all', 'catch-all': 'accept_all', catchall: 'accept_all',
  unknown: 'unknown', risky: 'unknown', greylisted: 'unknown', greylist: 'unknown', greylisting: 'unknown',
  timeout: 'unknown', deferred: 'unknown', temporary: 'unknown', unverifiable: 'unknown', 'do_not_mail': 'unknown',
  // sender-platform event-log vocab (Resend / SES / Postmark-style)
  bounced: 'invalid', soft_bounce: 'unknown', softbounce: 'unknown',
  delivered: 'valid', delivery: 'valid', sent: 'valid', complained: 'valid', complaint: 'valid',
  // finder-tool vocab
  unverified: 'unknown', accept_all_unverifiable: 'accept_all',
}));
function normalizeStatus(raw) {
  const s = norm(raw);
  if (!s) return null;
  const key = s.replace(/\s+/g, '_');
  if (STATUS_MAP.has(key)) return STATUS_MAP.get(key);     // whole value (handles hyphen/underscore compounds)
  // tolerate prefixed/scored values ("status: invalid", "deliverable (98)") via EXACT token match —
  // exact tokens avoid the 'valid' ⊂ 'invalid' substring trap.
  for (const tk of s.split(/[^a-z0-9]+/).filter(Boolean)) { if (STATUS_MAP.has(tk)) return STATUS_MAP.get(tk); }
  return null;   // ungradeable — caller should skip (NOT treat as a miss)
}

const EMAIL_HDR = /^(e[-_]?mail|email_address|address|recipient|to)$/i;
const STATUS_HDR = /^(status|result|verdict|state|deliverability|validation|email_status|event)$/i;
const CATCHALL_HDR = /^(accept_all|acceptall|is_catchall_email|is_catchall|catch_all|catchall)$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TRUTHY = /^(true|1|yes|y|t)$/i;

// Best-guess the vendor from the header signature (label only — parsing is schema-driven, not
// per-vendor). Covers the five the spec auto-detects + a generic fallback.
function detectVendor(headers) {
  const h = (headers || []).map(x => norm(x));
  const has = (n) => h.includes(n);
  if (has('accept_all') && has('result')) return 'hunter';
  if (has('sub_status') && has('status')) return 'zerobounce';
  if (has('mailboxvalidator_score') || has('is_verified')) return 'mailboxvalidator';
  if (has('email_status')) return 'apollo';
  if (has('is_catchall_email') || (has('deliverability') && has('quality_score'))) return 'abstract';
  if (has('event') && !has('status') && !has('result')) return 'resend';
  return 'generic';
}

// Reverse-engineer a probable {first, last} from an email local-part when a bounce file has no name
// column (Resend event logs are email-only). Works for separator-delimited forms (~the first.last
// family); returns null for ambiguous concatenated locals (flast/firstlast can't be split safely).
function inferName(emailOrLocal) {
  const lp = String(emailOrLocal || '').toLowerCase().split('@')[0].trim();
  const cap = (s) => s ? s[0].toUpperCase() + s.slice(1) : s;
  let m;
  if ((m = lp.match(/^([a-z]+)\.([a-z])\.([a-z]+)$/))) return { first: cap(m[1]), last: cap(m[3]), pattern: 'first.m.last' };
  if ((m = lp.match(/^([a-z]+)\.([a-z]+)\.([a-z]+)$/))) return { first: cap(m[1]), last: cap(m[3]), pattern: 'first.middle.last' };
  if ((m = lp.match(/^([a-z]+)\.([a-z]+)$/))) return { first: cap(m[1]), last: cap(m[2]), pattern: 'first.last' };
  if ((m = lp.match(/^([a-z]+)_([a-z]+)$/))) return { first: cap(m[1]), last: cap(m[2]), pattern: 'first_last' };
  return null;
}

function splitLine(line, delim) {
  // minimal quoted-field handling (verification exports are simple, but tolerate quotes/commas)
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === delim && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// Parse a verification-results file. Detects delimiter (tab vs comma), an optional header row (to
// locate the email + status columns by name), and falls back to col0=email / col1=status. Rows whose
// email isn't a valid address, or whose status doesn't map, are dropped (with a count) — never
// silently turned into a miss.
function parseResults(text) {
  const lines = String(text || '').split(/\r?\n/).filter(l => l.trim() !== '');
  const out = [], dropped = { noEmail: 0, badStatus: 0 };
  if (!lines.length) return { rows: out, dropped };
  const delim = lines[0].includes('\t') ? '\t' : ',';

  let emailCol = 0, statusCol = 1, catchAllCol = -1, start = 0, vendor = 'generic';
  const head = splitLine(lines[0], delim);
  const hasHeader = head.some(h => EMAIL_HDR.test(h) || STATUS_HDR.test(h)) || !EMAIL_RE.test(head[0]);
  if (hasHeader) {
    const ei = head.findIndex(h => EMAIL_HDR.test(h));
    const si = head.findIndex(h => STATUS_HDR.test(h));
    catchAllCol = head.findIndex(h => CATCHALL_HDR.test(h));
    if (ei >= 0) emailCol = ei;
    if (si >= 0) statusCol = si;
    vendor = detectVendor(head);
    start = 1;
  }

  for (let i = start; i < lines.length; i++) {
    const cells = splitLine(lines[i], delim);
    const email = norm(cells[emailCol]);
    if (!EMAIL_RE.test(email)) { dropped.noEmail++; continue; }
    const rawStatus = cells[statusCol];
    // a truthy catch-all boolean column wins regardless of the status value (Hunter/Abstract shape)
    let result;
    if (catchAllCol >= 0 && TRUTHY.test(norm(cells[catchAllCol]))) result = 'accept_all';
    else result = normalizeStatus(rawStatus);
    if (!result) { dropped.badStatus++; continue; }
    out.push({ email, result, raw: String(rawStatus == null ? '' : rawStatus).trim() });
  }
  return { rows: out, dropped, vendor };
}

module.exports = { normalizeStatus, parseResults, detectVendor, inferName, STATUS_MAP };
