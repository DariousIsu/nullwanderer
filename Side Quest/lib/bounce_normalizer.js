'use strict';
/**
 * lib/bounce_normalizer.js — F4: the format-AGNOSTIC bounce / test-list normalizer (PURE).
 *
 * A bounce report arrives in whatever shape the sender's mail infra emits. This module sniffs the
 * format and reduces ANY of them to the SAME canonical row the Puller negative-signal loop already
 * understands ({email, result}) — so `studio/puller_negatives` (CSV/TSV) becomes just one of four
 * readers behind a single door. Sniff order (most-specific → most-forgiving):
 *
 *   1. DSN   — RFC 3464 delivery-status notification (message/delivery-status; Final-Recipient/Status)
 *   2. ARF   — RFC 5965 abuse/feedback report (Feedback-Type: abuse) — a COMPLAINT, not a bounce
 *   3. JSON  — an ESP webhook/event payload (SES / SendGrid / Mailgun / Postmark / Resend shapes)
 *   4. CSV   — a vendor verification export (delegated to studio/puller_negatives.parseResults)
 *   5. regex — last-ditch: scrape address + nearby enhanced-status / keyword from free text
 *
 * MASTER ARBITER — the RFC-3463 ENHANCED STATUS CLASS digit (the leading digit of `X.Y.Z`): 2 = success,
 * 4 = PERSISTENT-TRANSIENT (soft — defer, never a miss), 5 = PERMANENT (hard bounce — a real miss). When
 * a class digit is present it OVERRIDES any textual guess (a "failed" action with a 4.x.x status is soft,
 * not a hard bounce). This is the single most reliable hard/soft signal across every format (research
 * 2026-07-09). Canonical `result`: 'valid' (α+) | 'invalid' (β+, hard) | 'unknown' (defer) | 'accept_all'.
 *
 * SUPPRESSION ≠ VALIDITY: a complaint (ARF) or an unsubscribe means DON'T-SEND, but it is NOT evidence the
 * mailbox is invalid — such rows carry result:'unknown' + suppression:true so the caller can add them to a
 * do-not-send list WITHOUT poisoning the address's deliverability belief.
 *
 * TEST-LIST vs OPPORTUNISTIC: results from a controlled test-send batch are more trustworthy than an
 * opportunistically-scraped status, so every row is tagged `weight` ('test' when opts.testList, else
 * 'opportunistic'). `reconcileTestList(sent, rows)` closes the loop for a sent test list: an address that
 * bounced → invalid, one with an explicit delivered event → valid, and one that stayed SILENT → 'unknown'
 * (conservative — silence is not proof of delivery). The caller weights 'test' rows above opportunistic.
 */

const negatives = require('../studio/puller_negatives');

const norm = (s) => String(s == null ? '' : s).trim();
const lc = (s) => norm(s).toLowerCase();
const EMAIL_RE = /[^\s@"'<>()[\]:;,]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+/i;
const EMAIL_G = new RegExp(EMAIL_RE.source, 'gi');
// enhanced status X.Y.Z — the class digit (2/4/5) is the arbiter. Bare `.` compounds only (not "5 items").
const ENH_STATUS_RE = /\b([245])\.\d{1,3}\.\d{1,3}\b/;

// class digit → canonical result. 2 = success, 4 = transient (defer), 5 = permanent (hard miss).
function classResult(digit) {
  const d = Number(digit);
  if (d === 2) return 'valid';
  if (d === 4) return 'unknown';
  if (d === 5) return 'invalid';
  return null;
}
// The FIRST enhanced-status class digit found in a blob, or null.
function statusClassOf(text) {
  const m = ENH_STATUS_RE.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

// ---- format sniff --------------------------------------------------------------------------------

function sniff(text) {
  const s = String(text || '');
  const head = s.slice(0, 4000);
  const hl = head.toLowerCase();
  // JSON first if it parses as an object/array (ESP webhooks are JSON, never look like the others)
  const t = s.trim();
  if (t && (t[0] === '{' || t[0] === '[')) { try { JSON.parse(t); return 'json'; } catch { /* not json */ } }
  // ARF is a report whose report-type is feedback; a Feedback-Type header clinches it
  if (/report-type=["']?feedback-report/i.test(hl) || /^feedback-type:/im.test(head)) return 'arf';
  // DSN: a delivery-status part, or the RFC-3464 recipient headers
  if (/content-type:\s*message\/delivery-status/i.test(hl) ||
      (/^final-recipient:/im.test(head) && /^(action|status):/im.test(head))) return 'dsn';
  // otherwise treat as tabular if it smells like CSV/TSV (a delimiter + an @), else free text
  const firstLine = s.split(/\r?\n/).find(l => l.trim()) || '';
  if ((firstLine.includes(',') || firstLine.includes('\t')) && /@/.test(s)) return 'csv';
  return 'unknown';
}

// ---- DSN (RFC 3464) ------------------------------------------------------------------------------
// Parse the per-recipient delivery-status groups. Each group has Final-Recipient/Original-Recipient
// (the address), Action (failed/delivered/delayed/relayed), and Status (X.Y.Z). The class digit of
// Status wins; Action is the fallback when there's no status.
function parseDsn(text) {
  const rows = [], dropped = { noEmail: 0, badStatus: 0 };
  const blocks = String(text || '').split(/\r?\n\r?\n/);
  const recips = [];
  for (const b of blocks) {
    if (!/^(final|original)-recipient:/im.test(b) && !/^action:/im.test(b)) continue;
    const emailM = (b.match(/^(?:final|original)-recipient:\s*(?:rfc822;\s*)?(.+)$/im) || [])[1];
    const email = emailM ? (EMAIL_RE.exec(emailM) || [])[0] : (EMAIL_RE.exec(b) || [])[0];
    const action = lc((b.match(/^action:\s*(.+)$/im) || [])[1] || '');
    const statusLine = (b.match(/^status:\s*(.+)$/im) || [])[1] || '';
    const cls = statusClassOf(statusLine) || statusClassOf(b);
    recips.push({ email, action, cls, raw: statusLine.trim() || action });
  }
  for (const r of recips) {
    if (!r.email || !EMAIL_RE.test(r.email)) { dropped.noEmail++; continue; }
    let result = r.cls ? classResult(r.cls) : null;
    if (!result) {                                   // no enhanced status → lean on Action
      if (r.action === 'failed') result = 'invalid';
      else if (r.action === 'delivered' || r.action === 'relayed') result = 'valid';
      else if (r.action === 'delayed') result = 'unknown';
    }
    if (!result) { dropped.badStatus++; continue; }
    rows.push({ email: lc(r.email), result, statusClass: r.cls || null, raw: r.raw, suppression: false });
  }
  return { rows, dropped };
}

// ---- ARF (RFC 5965) ------------------------------------------------------------------------------
// An abuse/feedback report = a COMPLAINT. The recipient (who complained) is in Original-Rcpt-To (or
// the embedded original message's To). A complaint is a SUPPRESS signal, NOT proof of an invalid box.
function parseArf(text) {
  const rows = [], dropped = { noEmail: 0, badStatus: 0 };
  const s = String(text || '');
  const fbType = lc((s.match(/^feedback-type:\s*(.+)$/im) || [])[1] || 'abuse');
  // prefer the machine-readable Original-Rcpt-To / Original-Mail-From-adjacent recipient
  let email = (s.match(/^original-rcpt-to:\s*(?:rfc822;\s*)?(.+)$/im) || [])[1];
  if (!email) email = (s.match(/^(?:removal-recipient|original-recipient):\s*(?:rfc822;\s*)?(.+)$/im) || [])[1];
  if (email) email = (EMAIL_RE.exec(email) || [])[0];
  if (!email) {                                       // fall back to the To: of the embedded message
    const toM = s.match(/^to:\s*(.+)$/im);
    if (toM) email = (EMAIL_RE.exec(toM[1]) || [])[0];
  }
  if (!email || !EMAIL_RE.test(email)) { dropped.noEmail++; return { rows, dropped, feedbackType: fbType }; }
  // complaint/abuse/fraud → don't-send, but deliverability UNKNOWN (the box exists — it received the mail)
  rows.push({ email: lc(email), result: 'unknown', statusClass: null, raw: `arf:${fbType}`, suppression: true });
  return { rows, dropped, feedbackType: fbType };
}

// ---- ESP JSON webhooks ---------------------------------------------------------------------------
// One payload, many shapes. We fingerprint by key presence rather than a vendor allow-list, so a new
// ESP with a familiar shape still parses. Each event → a canonical row; the enhanced-status class digit
// (when the ESP echoes the SMTP status, e.g. SES bouncedRecipients[].status) still arbitrates hard/soft.
const SES_HARD = 'invalid', SES_SOFT = 'unknown';
function eventResult(evtType, subType, statusText) {
  const cls = statusClassOf(statusText || '');
  if (cls) return classResult(cls);                  // status digit wins whenever present
  const e = lc(evtType), st = lc(subType);
  if (/deliver|delivered|delivery/.test(e)) return 'valid';
  if (/complain|complaint|spam/.test(e)) return { result: 'unknown', suppression: true };
  if (/bounce|dropped|failed|reject/.test(e)) {
    if (/perm|hard/.test(st)) return SES_HARD;
    if (/trans|soft|temporary|defer|delay/.test(st)) return SES_SOFT;
    if (/drop/.test(e)) return SES_HARD;             // SendGrid "dropped" = suppressed hard
    return SES_HARD;                                 // an unqualified bounce defaults hard
  }
  return null;
}
function pushEvent(rows, dropped, email, evtType, subType, statusText) {
  if (!email || !EMAIL_RE.test(email)) { dropped.noEmail++; return; }
  const r = eventResult(evtType, subType, statusText);
  if (!r) { dropped.badStatus++; return; }
  const result = typeof r === 'string' ? r : r.result;
  const suppression = typeof r === 'object' ? !!r.suppression : false;
  rows.push({ email: lc(email), result, statusClass: statusClassOf(statusText || '') || null,
              raw: `${evtType || ''}${subType ? '/' + subType : ''}`.trim() || 'event', suppression });
}
function parseJsonPayload(text) {
  const rows = [], dropped = { noEmail: 0, badStatus: 0 };
  let data; try { data = JSON.parse(text); } catch { return { rows, dropped }; }
  const events = Array.isArray(data) ? data : [data];
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    // SES (SNS-wrapped or raw): notificationType Bounce/Complaint/Delivery
    if (ev.notificationType || ev.eventType) {
      const nt = ev.notificationType || ev.eventType;
      if (ev.bounce && Array.isArray(ev.bounce.bouncedRecipients)) {
        for (const br of ev.bounce.bouncedRecipients) pushEvent(rows, dropped, br.emailAddress, 'bounce', ev.bounce.bounceType, br.status || ev.bounce.bounceSubType);
        continue;
      }
      if (ev.complaint && Array.isArray(ev.complaint.complainedRecipients)) {
        for (const cr of ev.complaint.complainedRecipients) pushEvent(rows, dropped, cr.emailAddress, 'complaint', '', '');
        continue;
      }
      if (ev.delivery && Array.isArray(ev.delivery.recipients)) {
        for (const em of ev.delivery.recipients) pushEvent(rows, dropped, em, 'delivery', '', '');
        continue;
      }
      pushEvent(rows, dropped, ev.mail && (ev.mail.destination || [])[0], nt, ev.bounce && ev.bounce.bounceType, '');
      continue;
    }
    // Mailgun event-data { event, recipient, severity, 'delivery-status': { code, message } }
    if (ev['event-data'] || (ev.event && ev.recipient)) {
      const ed = ev['event-data'] || ev;
      const ds = ed['delivery-status'] || {};
      pushEvent(rows, dropped, ed.recipient, ed.event, ed.severity, `${ds.code || ''} ${ds.message || ''}`);
      continue;
    }
    // Postmark { RecordType/Type: HardBounce/SoftBounce, Email }
    if (ev.RecordType || ev.Type || ev.Email) {
      const type = ev.Type || ev.RecordType || '';
      pushEvent(rows, dropped, ev.Email || ev.Recipient, /bounce/i.test(type) ? 'bounce' : type, type, ev.Details || '');
      continue;
    }
    // Resend / SendGrid-ish { type|event, email|data.to, reason }
    const t = ev.type || ev.event;
    const em = ev.email || (ev.data && (ev.data.to || (Array.isArray(ev.data.to) ? ev.data.to[0] : ev.data.to)));
    if (t && em) { pushEvent(rows, dropped, Array.isArray(em) ? em[0] : em, String(t).replace(/^email\./, ''), ev.bounce_type || ev.type, ev.reason || ''); continue; }
    dropped.badStatus++;
  }
  return { rows, dropped };
}

// ---- regex fallback (free-text / mystery format) -------------------------------------------------
function parseFreeText(text) {
  const rows = [], dropped = { noEmail: 0, badStatus: 0 }, seen = new Set();
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(EMAIL_G);
    if (!m) continue;
    const cls = statusClassOf(line);
    for (const raw of m) {
      const email = lc(raw);
      if (seen.has(email)) continue;
      let result = cls ? classResult(cls) : null;
      if (!result) {                                 // keyword sniff on the surrounding line
        const l = lc(line);
        if (/deliver|delivered|valid|success/.test(l)) result = 'valid';
        else if (/hard.?bounce|undeliverable|invalid|no such|does not exist|user unknown|mailbox.*(full|unavailable|not found)/.test(l)) result = 'invalid';
        else if (/soft.?bounce|deferred|greylist|temporar|try again|timeout/.test(l)) result = 'unknown';
      }
      if (!result) { dropped.badStatus++; continue; }
      seen.add(email);
      rows.push({ email, result, statusClass: cls || null, raw: line.trim().slice(0, 200), suppression: false });
    }
  }
  return { rows, dropped };
}

// ---- the single door -----------------------------------------------------------------------------
// parse(text, { format?, testList? }) → { format, rows, dropped, meta }. `rows` are always canonical:
//   { email, result: valid|invalid|unknown|accept_all, statusClass, raw, suppression, weight }.
function parse(text, opts = {}) {
  const format = opts.format || sniff(text);
  const weight = opts.testList ? 'test' : 'opportunistic';
  let res, meta = {};
  switch (format) {
    case 'dsn': res = parseDsn(text); break;
    case 'arf': res = parseArf(text); meta.feedbackType = res.feedbackType; break;
    case 'json': res = parseJsonPayload(text); break;
    case 'csv': {
      const c = negatives.parseResults(text);        // {rows:[{email,result,raw}], dropped, vendor}
      res = { rows: c.rows.map(r => ({ email: lc(r.email), result: r.result, statusClass: null, raw: r.raw, suppression: false })), dropped: c.dropped };
      meta.vendor = c.vendor; break;
    }
    default: res = parseFreeText(text); break;
  }
  const rows = (res.rows || []).map(r => ({ ...r, weight }));
  return { format, rows, dropped: res.dropped || { noEmail: 0, badStatus: 0 }, meta };
}

// ---- test-list reconciliation --------------------------------------------------------------------
// Close the loop for a SENT test list: given the addresses we sent to and the bounce/event rows that
// came back, classify EVERY sent address. bounced → invalid; explicit delivered → valid; SILENT → an
// 'unknown' NON-observation (conservative: silence after a send is not proof of delivery, so it earns
// no credit — it just means "still unverified, try again / enrich"). Test rows carry weight:'test'.
// Invalid beats valid beats silence when an address has multiple events (a hard bounce is decisive).
function reconcileTestList(sent, rows) {
  const order = { invalid: 3, valid: 2, unknown: 1 };
  const best = new Map();                            // email → strongest result seen
  for (const r of (rows || [])) {
    const e = lc(r.email); if (!e) continue;
    const cur = best.get(e);
    if (!cur || (order[r.result] || 0) > (order[cur] || 0)) best.set(e, r.result);
  }
  const out = [];
  for (const s of (sent || [])) {
    const email = lc(typeof s === 'string' ? s : (s && (s.email || s.value)) || '');
    if (!EMAIL_RE.test(email)) continue;
    const r = best.get(email) || 'unknown';          // no news → unknown (silent, unconfirmed)
    out.push({ email, result: r, weight: 'test', silent: !best.has(email) });
  }
  return out;
}

module.exports = {
  sniff, parse, reconcileTestList,
  parseDsn, parseArf, parseJsonPayload, parseFreeText,
  statusClassOf, classResult, ENH_STATUS_RE, EMAIL_RE,
};
