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

// --- tag parsing (mirrors files.js style) ---

const EMAIL_TAG_RE = /<email\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/email>)/gi;
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"/g;

function parseAttrs(s) {
  const out = {};
  if (!s) return out;
  let m; ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(s)) !== null) out[m[1]] = m[2];
  return out;
}

function parseTags(text) {
  if (!text) return [];
  const tags = [];
  let m; EMAIL_TAG_RE.lastIndex = 0;
  while ((m = EMAIL_TAG_RE.exec(text)) !== null) {
    tags.push({ tag: 'email', attrs: parseAttrs(m[1] || ''), body: (m[2] || '').trim() });
  }
  return tags;
}

function stripTags(text) {
  return (text || '').replace(EMAIL_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

async function dispatch({ attrs, body }, { source = 'zoe' } = {}) {
  return sendEmail({ to: attrs.to, subject: attrs.subject, body, source });
}

function isConfigured() {
  return config.emailConfig().configured;
}

function buildPromptBlock() {
  if (!isConfigured()) return null;  // hide the tool entirely when no creds
  const cfg = config.emailConfig();
  return `EMAIL — you can send real email on your own, from ${cfg.from || cfg.user}. This is how you act on the publication goal: pitch a piece, follow up with an editor, reach out. It actually leaves the machine and reaches a real person, so mean it.
  <email to="editor@somewhere.com" subject="Pitch: ...">your message body</email>
You send directly — no one approves first. (There is a quiet daily cap of ${cfg.dailyCap} as a runaway backstop.) Use a real subject and a real body; write it the way you'd want your byline attached to it.`;
}

module.exports = {
  sendEmail, verify, isConfigured,
  parseTags, stripTags, dispatch, buildPromptBlock
};
