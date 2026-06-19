/**
 * Inbox reading for Zoe — the receive half of email (send lives in email.js).
 * Gmail IMAP via imapflow (pure JS, no native deps); same app password as SMTP.
 *
 * This is what lets her "check her email" — and it's the front half of the
 * newsletter→read→integrate flow: incoming mail can be surfaced to her and
 * synthesized into the knowledge store.
 *
 * Tag (parsed from <think>/<say>): <email-check/>  (optionally unread="true")
 *   → fetches the most recent inbox messages, surfaced to her next turn.
 *
 * Requires IMAP enabled on the Gmail account (Settings → Forwarding and POP/IMAP).
 */

const config = require('./config');

let ImapFlow = null;
try { ImapFlow = require('imapflow').ImapFlow; } catch { /* not installed yet */ }

const HOST = 'imap.gmail.com';

async function fetchInbox({ limit = 5, unreadOnly = false } = {}) {
  const cfg = config.emailConfig();
  if (!cfg.configured) return { ok: false, reason: 'email not configured' };
  if (!ImapFlow) return { ok: false, reason: 'imapflow not installed' };

  const client = new ImapFlow({
    host: HOST, port: 993, secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false
  });

  try {
    await client.connect();
  } catch (e) {
    return { ok: false, reason: 'IMAP login failed (check app password + that IMAP is enabled in Gmail): ' + e.message };
  }

  let lock;
  const messages = [];
  try {
    lock = await client.getMailboxLock('INBOX');
    const status = await client.status('INBOX', { messages: true });
    const total = status.messages || 0;
    if (total === 0) return { ok: true, messages: [] };

    let range;
    if (unreadOnly) {
      const unseen = await client.search({ seen: false });
      if (!unseen || unseen.length === 0) return { ok: true, messages: [] };
      range = unseen.slice(-limit);
    } else {
      const start = Math.max(1, total - limit + 1);
      range = `${start}:${total}`;
    }

    for await (const msg of client.fetch(range, { envelope: true, flags: true, bodyParts: ['text'] })) {
      let snippet = '';
      try {
        const part = msg.bodyParts && msg.bodyParts.get ? msg.bodyParts.get('text') : null;
        if (part) snippet = part.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600);
      } catch {}
      const env = msg.envelope || {};
      const fromObj = (env.from && env.from[0]) || {};
      messages.push({
        from: fromObj.name || fromObj.address || 'unknown',
        fromAddr: fromObj.address || '',
        subject: env.subject || '(no subject)',
        date: env.date ? new Date(env.date).toISOString() : '',
        unread: !(msg.flags && msg.flags.has && msg.flags.has('\\Seen')),
        snippet
      });
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { if (lock) lock.release(); } catch {}
    try { await client.logout(); } catch {}
  }

  messages.reverse(); // newest first
  return { ok: true, messages };
}

// Autonomous poll: return UNREAD messages she hasn't surfaced yet (by UID).
// "Unread = unhandled", so the existing unread backlog gets surfaced too, not just
// mail that arrives after startup. Capped per call so a big backlog drains paced,
// not in a flood. Caller persists the surfaced UIDs so nothing repeats.
async function pollUnread(surfacedUids = [], cap = 3) {
  const cfg = config.emailConfig();
  if (!cfg.configured || !ImapFlow) return { ok: false, reason: 'email not configured' };
  const client = new ImapFlow({ host: HOST, port: 993, secure: true, auth: { user: cfg.user, pass: cfg.pass }, logger: false });
  try { await client.connect(); } catch (e) { return { ok: false, reason: e.message }; }

  let lock;
  const messages = [];
  try {
    lock = await client.getMailboxLock('INBOX');
    let unseen = [];
    try { unseen = await client.search({ seen: false }, { uid: true }); } catch {}
    if (!unseen || unseen.length === 0) return { ok: true, messages: [] };
    const surf = new Set((surfacedUids || []).map(Number));
    const fresh = unseen.filter(u => !surf.has(u)).sort((a, b) => a - b).slice(-cap); // newest few
    if (fresh.length === 0) return { ok: true, messages: [] };
    for await (const msg of client.fetch(fresh, { uid: true, envelope: true, bodyParts: ['text'] }, { uid: true })) {
      let snippet = '';
      try {
        const part = msg.bodyParts && msg.bodyParts.get ? msg.bodyParts.get('text') : null;
        if (part) snippet = part.toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
      } catch {}
      const env = msg.envelope || {};
      const fromObj = (env.from && env.from[0]) || {};
      messages.push({ uid: msg.uid, from: fromObj.name || fromObj.address || 'unknown', subject: env.subject || '(no subject)', snippet });
    }
  } catch (e) {
    return { ok: false, reason: e.message };
  } finally {
    try { if (lock) lock.release(); } catch {}
    try { await client.logout(); } catch {}
  }
  return { ok: true, messages };
}

function formatInbox(result) {
  if (!result || !result.ok) return `(couldn't read the inbox: ${result?.reason || 'unknown'})`;
  if (!result.messages || result.messages.length === 0) return 'Your inbox has no messages to show right now.';
  const lines = ['Your inbox (most recent first):'];
  for (const m of result.messages) {
    lines.push(`  • ${m.unread ? '[unread] ' : ''}From ${m.from} — "${m.subject}"${m.date ? ' (' + m.date.slice(0, 16).replace('T', ' ') + ')' : ''}`);
    if (m.snippet) lines.push(`      ${m.snippet.slice(0, 300)}`);
  }
  return lines.join('\n');
}

// --- tag parsing (mirrors screen.js) ---

// Accept several names; primary is <read-inbox/> (doesn't collide with the
// <email…> SEND family, which she kept confusing it with).
const TAG_RE = /<(?:read-inbox|check-inbox|inbox|email-check)\s*([^>]*?)\/?>/gi;
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
  let m; TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) tags.push({ tag: 'read-inbox', attrs: parseAttrs(m[1] || '') });
  return tags;
}

// Is this a request to READ the inbox (not send)? Drives the just-in-time nudge.
function detectInboxIntent(msg) {
  if (!msg) return false;
  const m = String(msg).toLowerCase();
  const explicitSend = /\b(send|compose|draft|write|pitch|forward|reply)\b/.test(m);
  if (explicitSend) return false;
  return /\binbox\b/.test(m)
    || /\b(check|read|see|look at|open|any|new|got|receiv|incoming|unread|what)\b[\s\S]{0,40}\b(e-?mails?|inbox|mails?|messages?)\b/.test(m);
}

// Just-in-time directive: push her to <read-inbox/> instead of the send tags.
function buildInboxNudge(userMessage) {
  if (!isConfigured()) return null;
  if (!detectInboxIntent(userMessage)) return null;
  return `READ-INBOX ACTION — Lucas is asking you to READ the email you've received, NOT to send anything. Emit this exact raw tag now:
  <read-inbox/>
That fetches your inbox. Do NOT emit <email-draft>, <email-send>, or <email> — those compose/send mail, which is the wrong action here. Your reply should contain <read-inbox/> and nothing about drafting or recipients.`;
}

function stripTags(text) {
  return (text || '').replace(TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

async function dispatch({ attrs } = {}) {
  const r = await fetchInbox({ limit: 5, unreadOnly: !!(attrs && /true/i.test(attrs.unread || '')) });
  return { ...r, text: formatInbox(r) };
}

function isConfigured() { return config.emailConfig().configured; }

function buildPromptBlock() {
  if (!isConfigured()) return null;
  return `INBOX — to READ the email you've received, emit this exact tag:
  <read-inbox/>
Your recent messages (sender, subject, snippet) then arrive in your next-turn context. Use it whenever Lucas asks you to check or read your email/inbox, or to see replies to mail you sent. This is a DIFFERENT action from sending: <read-inbox/> READS; <email>/<email-draft>/<email-send> SEND. When asked to read, emit <read-inbox/> — never draft or send.`;
}

module.exports = { fetchInbox, pollUnread, formatInbox, parseTags, stripTags, dispatch, buildPromptBlock, isConfigured, detectInboxIntent, buildInboxNudge };
