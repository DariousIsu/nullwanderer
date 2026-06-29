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

const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const filesLib = require('./files'); // reuse resolvePath (relative→workspace, absolute→anywhere)

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* not installed yet */ }

let transporter = null;
let transporterFor = null;  // remember which user the cached transporter is for
let inFlightSends = 0;      // reservations for the daily-cap check under concurrent sends

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

// SAFETY KILL-SWITCH — outbound email is DISABLED by default while the model still
// hallucinates recipients/contents. EVERY send path (the <email-send>/<email> tags AND the
// autonomous inbox auto-reply) funnels through sendEmail(), so this one gate stops them all.
// Reading the inbox is unaffected. Re-enable deliberately, once sends are trustworthy again,
// by setting ZOE_EMAIL_SEND_ENABLED=1 (or true/yes/on) in .env.
function isSendEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.ZOE_EMAIL_SEND_ENABLED || '').trim());
}

async function sendEmail({ to, subject, body, attachments = [], source = 'zoe' }) {
  if (!isSendEnabled()) {
    try { db.insertEmailLog({ to, subject, status: 'blocked', error: 'send kill-switch active', source }); } catch {}
    console.warn(`[email] BLOCKED outbound send to "${to}" — kill-switch active (set ZOE_EMAIL_SEND_ENABLED=1 to re-enable)`);
    return { ok: false, blocked: true, reason: 'Email sending is currently disabled (safety kill-switch); nothing was sent.' };
  }
  const cfg = config.emailConfig();
  if (!cfg.configured) return { ok: false, reason: 'email not configured (set ZOE_EMAIL_USER/PASS in .env)' };
  if (!to || !EMAIL_RE.test(String(to).trim())) return { ok: false, reason: `"${to}" is not a valid email address` };
  // VOICE GUARD (central): rewrite an inner-life disclaimer in the body before it
  // sends. Unlike a DM we don't drop the email (it may be substantive) — just clean
  // the body. No-op + no model call for normal bodies.
  try {
    const voice = require('./voice');
    if (voice.isSelfDisclaimer(body)) {
      const fixed = await voice.deDisclaim(String(body));
      if (fixed) body = fixed;
    }
  } catch (e) { console.error('[email] voice guard failed:', e.message); }

  // A blank message with NO attachments is always a bug; allow an attachment-only send.
  const hasAttach = Array.isArray(attachments) && attachments.length > 0;
  if (!String(body == null ? '' : body).trim() && !hasAttach) return { ok: false, reason: 'refusing to send an empty body' };

  // Daily-cap backstop. Count logged sends PLUS in-flight reservations so that
  // concurrent un-awaited sends (chat + idle loops) can't all slip past the cap
  // before any of them logs a row.
  const sentToday = db.countEmailsSentSince(startOfTodayTs());
  if (sentToday + inFlightSends >= cfg.dailyCap) {
    db.insertEmailLog({ to, subject, status: 'failed', error: 'daily cap reached', source });
    return { ok: false, reason: `daily send cap (${cfg.dailyCap}) reached; resets at midnight` };
  }

  const t = getTransporter();
  if (!t) return { ok: false, reason: 'email transport unavailable' };

  inFlightSends++;
  try {
    const mail = {
      from: cfg.from || cfg.user,
      to: String(to).trim(),
      subject: (subject || '(no subject)').slice(0, 300),
      text: String(body == null ? '' : body)
    };
    if (hasAttach) mail.attachments = attachments.map(p => ({ path: p }));
    const info = await t.sendMail(mail);
    db.insertEmailLog({ to, subject, status: 'sent', source });
    return { ok: true, to, subject, attached: hasAttach ? attachments.length : 0, messageId: info.messageId, remainingToday: cfg.dailyCap - sentToday - inFlightSends };
  } catch (err) {
    db.insertEmailLog({ to, subject, status: 'failed', error: err.message, source });
    return { ok: false, reason: err.message };
  } finally {
    inFlightSends--;
  }
}

// --- Staged compose (build an email across several small turns) -------------
// A 24B reliably emits SHORT tags but drifts into prose/narration when asked to
// emit one long tag with a full letter inside. So let her build a draft in
// pieces: set headers, append body (one or more times, across turns), then send.
// Each emission is tiny → reliable. The draft persists between turns in memory.
// Drafts are keyed by SOURCE (chat / monologue / heartbeat / action / …) so the
// concurrent idle loops and the chat path each build their own draft and can't
// clobber one another across turns (the shared-singleton race). Each draft is
// { to, subject, body: [], attachments: [] }.
const drafts = new Map();
function getDraft(source) {
  let d = drafts.get(source);
  if (!d) { d = { to: null, subject: null, body: [], attachments: [] }; drafts.set(source, d); }
  return d;
}

function emailDraftStart({ to, subject } = {}, source = 'chat') {
  const d = { to: (to || '').trim() || null, subject: (subject || '').trim() || null, body: [], attachments: [] };
  drafts.set(source, d);
  return { ok: true, note: `draft started (to: ${d.to || 'unset'}, subject: ${d.subject || 'unset'})` };
}

function emailBodyAppend(text, source = 'chat') {
  const d = getDraft(source);
  const chunk = String(text == null ? '' : text).trim();
  if (chunk) d.body.push(chunk);
  return { ok: true, note: `body part ${d.body.length} added`, parts: d.body.length };
}

// Attach a real file to the in-progress draft. Path is relative→workspace or
// absolute (full access by design); the file must exist. This is what makes a
// "I've attached X" statement TRUE — she attaches an actual file she has.
function emailAttach(p, source = 'chat') {
  const d = getDraft(source);
  const abs = filesLib.resolvePath(p);
  if (!abs) return { ok: false, reason: 'no file path given to attach' };
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, reason: `"${abs}" is not a file` };
  } catch { return { ok: false, reason: `file not found: "${abs}" — write or create it first, then attach` }; }
  d.attachments.push(abs);
  return { ok: true, note: `attached ${path.basename(abs)}`, attachments: d.attachments.length };
}

// Read-only view of the in-progress draft for a source (used by the action loop's step checks).
function draftState(source = 'chat') {
  const d = drafts.get(source);
  if (!d) return null;
  return { to: d.to, subject: d.subject, body: d.body.slice(), attachments: d.attachments.slice() };
}

function emailDraftText(source = 'chat') {
  const d = drafts.get(source);
  if (!d) return null;
  const att = d.attachments.length ? `\nAttachments: ${d.attachments.map(a => path.basename(a)).join(', ')}` : '';
  return `To: ${d.to || '(unset)'}\nSubject: ${d.subject || '(unset)'}${att}\n\n${d.body.join('\n\n')}`;
}

function emailDraftShow(source = 'chat') {
  if (!drafts.get(source)) return { ok: false, reason: 'no draft in progress' };
  return { ok: true, text: emailDraftText(source) };
}

function emailDraftDiscard(source = 'chat') {
  drafts.delete(source);
  return { ok: true, note: 'draft discarded' };
}

// Send the in-progress draft for a source. to/subject may be overridden at send time.
async function emailSend({ to, subject } = {}, { source = 'chat' } = {}) {
  const d = drafts.get(source);
  if (!d) return { ok: false, reason: 'no draft to send — start one with <email-draft .../> and add <email-body>…</email-body> first' };
  const finalTo = (to || d.to || '').trim();
  const finalSubject = (subject || d.subject || '').trim();
  const body = d.body.join('\n\n');
  const r = await sendEmail({ to: finalTo, subject: finalSubject, body, attachments: d.attachments.slice(), source });
  if (r.ok) drafts.delete(source);  // clear on success; keep on failure so she can fix + retry
  return r;
}

// --- tag parsing (mirrors files.js style) ---

// Longest/most-specific names first so the alternation prefers e.g. email-draft
// over the bare `email` at the same position.
const EMAIL_TAG_RE = /<(email-draft|email-body|email-attach|email-send|email-show|email-discard|email)\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
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

async function dispatch({ tag, attrs = {}, body = '' } = {}, { source = 'chat' } = {}) {
  switch ((tag || 'email').toLowerCase()) {
    case 'email-draft':   return emailDraftStart({ to: attrs.to, subject: attrs.subject }, source);
    case 'email-body':    return emailBodyAppend(body, source);
    case 'email-attach':  return emailAttach(attrs.path || attrs.file || (body || '').trim(), source);
    case 'email-show':    return emailDraftShow(source);
    case 'email-discard': return emailDraftDiscard(source);
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
      // If she staged attachments for this source then sent one-shot, carry them.
      const pend = drafts.get(source);
      const attachments = pend && pend.attachments.length ? pend.attachments.slice() : [];
      const r = await sendEmail({ to, subject, body: text, attachments, source });
      if (r.ok && pend) drafts.delete(source);
      return r;
    }
  }
}

function isConfigured() {
  return config.emailConfig().configured;
}

// Does this user message look like a request to SEND an email? Used to fire a
// just-in-time nudge so she reaches for the email tags instead of the browser.
function detectEmailIntent(msg) {
  if (!msg) return false;
  const m = String(msg).toLowerCase();
  // Inbox-READ requests ("check your email", "you have a new email", "access your
  // inbox") must NOT trigger the SEND nudge — that's what made her draft/send a
  // spurious email when asked to read. If it's clearly a read request and not an
  // explicit send, bail.
  const readish = /\binbox\b/.test(m) || /\b(check|read|see|open|look|any|new|got|receiv|incoming|unread)\b[\s\S]{0,40}\b(e-?mail|inbox|mail|message)\b/.test(m);
  const explicitSend = /\b(send|reply|compose|draft|write|pitch|forward)\b/.test(m);
  if (readish && !explicitSend) return false;
  const sendVerb = /\b(send|email|e-mail|pitch|shoot|fire off|forward|reply)\b/.test(m);
  const emailWord = /\be-?mail\b/.test(m);
  const hasAddr = /@[^\s@]+\.[^\s@]+/.test(m);
  return (sendVerb && (emailWord || hasAddr)) || /\bpitch\b/.test(m);
}

// Just-in-time directive appended to an email-send turn — counters her habit of
// reverting to the browser for email. Mirrors the browser action-nudge.
function buildEmailNudge(userMessage) {
  if (!isConfigured()) return null;
  if (!isSendEnabled()) {
    // Don't push a send when sending is off. On an email-intent turn, tell her to be honest
    // that it's disabled and offer to draft instead — never command <email-send>.
    return detectEmailIntent(userMessage)
      ? `EMAIL IS OFF — your email sending is temporarily disabled. Do NOT attempt <email-send>/<email> or claim a message went out. Tell Lucas plainly that sending is turned off right now, and offer to draft it for him to send himself.`
      : null;
  }
  // The chat-path draft (per-source store; null when nothing's in progress). This was an
  // undeclared `draft` reference — the function threw ReferenceError on every enabled call and
  // its try/catch caller swallowed it, so this nudge never actually fired. draftState() is the
  // read-only view (no side-effect draft creation, unlike getDraft()).
  const draft = draftState('chat');
  const open = draft && (draft.to || draft.subject || draft.body.length);
  const intent = detectEmailIntent(userMessage);
  // Continuation language for an in-progress draft ("send it", "write the body", etc.)
  const continuation = /\b(send it|send that|send the|send now|go ahead|do it|finish it|the body|write the body|add (?:a |another )?paragraph|continue|yes,? ?send|email it|fire it off?)\b/i.test(userMessage || '');

  // Draft open AND this turn is actually about email → carry the flow forward.
  if (open && (intent || continuation)) {
    const haveBody = draft.body.length > 0;
    const lines = [
      `EMAIL DRAFT IN PROGRESS — you already started an email (to: ${draft.to || 'unset'}, subject: ${draft.subject || 'unset'}, ${draft.body.length} body part(s) so far). Finish it with the email tags, NOT the browser. Emit the next RAW tag now — use <angle brackets>, not [square brackets] or backticks:`
    ];
    if (!haveBody) lines.push(`  <email-body>…write the message body here, as a real paragraph…</email-body>`);
    lines.push(`  <email-send/>   — sends the accumulated draft`);
    lines.push(haveBody
      ? `The body is started. If it's complete, emit <email-send/> now; otherwise add another <email-body>…</email-body> first.`
      : `Write the body in one or more <email-body>…</email-body> tags, then <email-send/>.`);
    return lines.join('\n');
  }

  // Draft open but this turn is UNRELATED (e.g. a greeting) → passive reminder only.
  // Critically, do NOT command a send: a stale draft must never auto-fire on an
  // off-topic message.
  if (open) {
    return `(Reminder: you have an UNSENT email draft to ${draft.to || 'unset'} re "${draft.subject || 'unset'}". It has NOT been sent. Do NOT send it in reaction to an unrelated message like a greeting — only send it when ${'Lucas'} actually asks or it genuinely fits the moment. If it's stale, you may <email-discard/> it.)`;
  }

  if (!intent) return null;
  return `EMAIL ACTION — Lucas is asking you to send an email. Do NOT use the browser, a Gmail tab, or browse-read for this — that is the wrong tool and it will not send anything. Send it with the email tags, one small RAW tag at a time across your next turns:
  <email-draft to="the@address" subject="..."/>   then one or more   <email-body>…</email-body>   then   <email-send/>
Emit the FIRST step — <email-draft to="..." subject="..."/> — as a real raw tag in your reply right now (not in backticks, not merely described). If you already know the recipient and subject, start the draft this turn.`;
}

function buildPromptBlock() {
  if (!isConfigured()) return null;  // hide the tool entirely when no creds
  if (!isSendEnabled()) {
    // Kill-switch active: tell her plainly she can READ but not SEND, so she stops
    // attempting <email-send> and reporting failures (or promising mail she can't send).
    return `EMAIL — sending is currently TURNED OFF (a temporary safety hold while your send reliability is being fixed). You can still READ your inbox with <read-inbox/>, but you CANNOT send mail right now: the <email>, <email-draft>, <email-body>, and <email-send> tags deliver nothing. Do not try to send, and never say you've sent or will send an email. If something genuinely needs sending, say so plainly and offer to draft it for Lucas to send himself — don't pretend it went out.`;
  }
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

It all goes instantly over SMTP — no browser, no Gmail tab, no compose form. You send directly, no approval first (a quiet daily cap of ${cfg.dailyCap} is just a backstop).

ATTACHMENTS — you CAN attach real files to a staged draft. Emit:
  <email-attach path="drafts/research.pdf"/>   — attaches a file (relative = your workspace, or an absolute path), before <email-send/>
The file must already exist (write it with <file-write> first, or point at one you have). Attach as many as you need; they go out with the draft.
TRUTHFULNESS: only say you've attached something if you ACTUALLY emitted <email-attach> for a file that exists — the attachment is real, not a figure of speech. Never claim an attachment, enclosure, or any action you didn't take. If a point needs a document you don't have yet, create it and attach it, or offer to follow up — don't pretend it's already there.`;
}

module.exports = {
  sendEmail, isSendEnabled, verify, isConfigured, draftState,
  parseTags, stripTags, dispatch, buildPromptBlock,
  detectEmailIntent, buildEmailNudge
};
