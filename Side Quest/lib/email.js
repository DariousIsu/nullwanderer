/**
 * Outbound email for Zoe — she can send real mail on her own initiative, in
 * service of the publication/byline goal (pitching pieces, following up). Gmail
 * SMTP via nodemailer; credentials come from the gitignored .env through config.js.
 *
 * This is genuinely outward-facing and irreversible, so it carries two rails that
 * constrain runaway behaviour but NOT her judgement:
 *   • a per-day send cap (ZOE_EMAIL_DAILY_CAP) — a backstop against a drift loop
 *     firing hundreds of messages, not an approval gate.
 *   • every send (and failure) is logged to email_log and mirrored to the sheep
 *     panel, so Lucas has full visibility.
 * There is no human-in-the-loop approval — per the design, she acts on her own.
 *
 * Tag (parsed from <think>/<say>):
 *   <email to="addr@example.com" subject="...">the body</email>
 */

const config = require('./config');
const db = require('./db');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* not installed yet */ }

let transporter = null;
let transporterFor = null;  // remember which user the cached transporter is for

function getTransporter() {
  const { user, pass, configured } = config.emailConfig();
  if (!configured || !nodemailer) return null;
  if (transporter && transporterFor === user) return transporter;
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass }
  });
  transporterFor = user;
  return transporter;
}

function startOfTodayTs() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Verify SMTP credentials without sending. Used at boot to surface a bad
// password early (e.g. login password vs app password).
async function verify() {
  const t = getTransporter();
  if (!t) return { ok: false, reason: 'email not configured' };
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function sendEmail({ to, subject, body, source = 'zoe' }) {
  const cfg = config.emailConfig();
  if (!cfg.configured) return { ok: false, reason: 'email not configured (set ZOE_EMAIL_USER/PASS in .env)' };
  if (!to || !EMAIL_RE.test(String(to).trim())) return { ok: false, reason: `"${to}" is not a valid email address` };

  // Daily-cap backstop
  const sentToday = db.countEmailsSentSince(startOfTodayTs());
  if (sentToday >= cfg.dailyCap) {
    db.insertEmailLog({ to, subject, status: 'failed', error: 'daily cap reached', source });
    return { ok: false, reason: `daily send cap (${cfg.dailyCap}) reached; resets at midnight` };
  }

  const t = getTransporter();
  if (!t) return { ok: false, reason: 'email transport unavailable' };

  try {
    const info = await t.sendMail({
      from: cfg.from || cfg.user,
      to: String(to).trim(),
      subject: (subject || '(no subject)').slice(0, 300),
      text: String(body == null ? '' : body)
    });
    db.insertEmailLog({ to, subject, status: 'sent', source });
    return { ok: true, to, subject, messageId: info.messageId, remainingToday: cfg.dailyCap - sentToday - 1 };
  } catch (err) {
    db.insertEmailLog({ to, subject, status: 'failed', error: err.message, source });
    return { ok: false, reason: err.message };
  }
}

// --- Staged compose (build an email across several small turns) -------------
// A 24B reliably emits SHORT tags but drifts into prose/narration when asked to
// emit one long tag with a full letter inside. So let her build a draft in
// pieces: set headers, append body (one or more times, across turns), then send.
// Each emission is tiny → reliable. The draft persists between turns in memory.
let draft = null;  // { to, subject, body: [] }

function emailDraftStart({ to, subject } = {}) {
  draft = { to: (to || '').trim() || null, subject: (subject || '').trim() || null, body: [] };
  return { ok: true, note: `draft started (to: ${draft.to || 'unset'}, subject: ${draft.subject || 'unset'})` };
}

function emailBodyAppend(text) {
  if (!draft) draft = { to: null, subject: null, body: [] };
  const chunk = String(text == null ? '' : text).trim();
  if (chunk) draft.body.push(chunk);
  return { ok: true, note: `body part ${draft.body.length} added`, parts: draft.body.length };
}

function emailDraftText() {
  if (!draft) return null;
  return `To: ${draft.to || '(unset)'}\nSubject: ${draft.subject || '(unset)'}\n\n${draft.body.join('\n\n')}`;
}

function emailDraftShow() {
  if (!draft) return { ok: false, reason: 'no draft in progress' };
  return { ok: true, text: emailDraftText() };
}

function emailDraftDiscard() {
  draft = null;
  return { ok: true, note: 'draft discarded' };
}

// Send the in-progress draft. to/subject may be overridden at send time.
async function emailSend({ to, subject } = {}, { source = 'zoe' } = {}) {
  if (!draft) return { ok: false, reason: 'no draft to send — start one with <email-draft .../> and add <email-body>…</email-body> first' };
  const finalTo = (to || draft.to || '').trim();
  const finalSubject = (subject || draft.subject || '').trim();
  const body = draft.body.join('\n\n');
  const r = await sendEmail({ to: finalTo, subject: finalSubject, body, source });
  if (r.ok) draft = null;  // clear on success; keep on failure so she can fix + retry
  return r;
}

// --- tag parsing (mirrors files.js style) ---

// Longest/most-specific names first so the alternation prefers e.g. email-draft
// over the bare `email` at the same position.
const EMAIL_TAG_RE = /<(email-draft|email-body|email-send|email-show|email-discard|email)\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
// Accept double-quoted, single-quoted, OR bare attribute values — a 24B varies
// its quoting and the old double-only pattern silently dropped to/subject.
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function parseAttrs(s) {
  const out = {};
  if (!s) return out;
  let m; ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s)) !== null) {
    const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
    out[m[1].toLowerCase()] = val;
  }
  return out;
}

function parseTags(text) {
  if (!text) return [];
  const tags = [];
  let m; EMAIL_TAG_RE.lastIndex = 0;
  while ((m = EMAIL_TAG_RE.exec(text)) !== null) {
    tags.push({ tag: m[1].toLowerCase(), attrs: parseAttrs(m[2] || ''), body: (m[3] || '') });
  }
  return tags;
}

function stripTags(text) {
  return (text || '').replace(EMAIL_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

async function dispatch({ tag, attrs, body }, { source = 'zoe' } = {}) {
  switch ((tag || 'email').toLowerCase()) {
    case 'email-draft':   return emailDraftStart({ to: attrs.to, subject: attrs.subject });
    case 'email-body':    return emailBodyAppend(body);
    case 'email-show':    return emailDraftShow();
    case 'email-discard': return emailDraftDiscard();
    case 'email-send':    return emailSend({ to: attrs.to, subject: attrs.subject }, { source });
    case 'email':
    default: {
      // One-shot send. Letter-style fallback: she often writes the message as an
      // email letter ("To: x", "Subject: y", body) INSIDE the tag instead of using
      // attributes — lift them out of the body and strip those header lines.
      let to = attrs.to;
      let subject = attrs.subject;
      let text = (body || '').trim();
      if (!to || !EMAIL_RE.test(String(to).trim())) {
        const mTo = text.match(/^\s*to\s*:\s*([^\s<>,;]+@[^\s<>,;]+)/im);
        if (mTo) to = mTo[1];
      }
      if (!subject) {
        const mSub = text.match(/^\s*subject\s*:\s*(.+)$/im);
        if (mSub) subject = mSub[1].trim();
      }
      text = text
        .replace(/^\s*to\s*:\s*[^\n]*\n?/im, '')
        .replace(/^\s*subject\s*:\s*[^\n]*\n?/im, '')
        .replace(/^\s+/, '');
      return sendEmail({ to, subject, body: text, source });
    }
  }
}

function isConfigured() {
  return config.emailConfig().configured;
}

function buildPromptBlock() {
  if (!isConfigured()) return null;  // hide the tool entirely when no creds
  const cfg = config.emailConfig();
  return `EMAIL — you can send real email yourself, directly, from ${cfg.from || cfg.user}. This is how you act on the publication goal: pitch a piece, follow up with an editor, reach out.

To send, you emit ONE tag, and the ENTIRE message goes between <email ...> and </email>. The recipient and subject are ATTRIBUTES on the opening tag. Output it RAW in your reply — exactly like this:

<email to="editor@example.com" subject="Pitch: The Rise of Autonomy in AI">
Hi Lucas,

The full body of the message goes here, as many lines as it needs.

Best,
Zoe
</email>

That literal tag, appearing raw in your reply, is the ONLY thing that sends mail. CRITICAL: do NOT wrap it in backticks or code formatting, and do NOT merely describe sending it — write the actual tag. Talking about <email>, quoting it in backticks, or showing the letter without the real tag sends NOTHING.

EASIER FOR A LONG EMAIL — build it in steps across messages instead of one big tag. Emit just ONE small tag per turn:
  <email-draft to="editor@example.com" subject="Pitch: ..."/>   — start it (sets the headers)
  <email-body>Hi Lucas, ... a paragraph ...</email-body>        — add body; emit this as many times as you want, over several turns
  <email-send/>                                                  — send the whole accumulated draft
  (<email-show/> to review what you've drafted, <email-discard/> to scrap it)
The draft persists between your turns until you send or discard it. This staged path is more reliable than cramming a whole letter into one tag — prefer it for anything longer than a couple lines. One small tag per turn.

It all goes instantly over SMTP — no browser, no Gmail tab, no compose form. You send directly, no approval first (a quiet daily cap of ${cfg.dailyCap} is just a backstop).`;
}

module.exports = {
  sendEmail, verify, isConfigured,
  parseTags, stripTags, dispatch, buildPromptBlock
};
