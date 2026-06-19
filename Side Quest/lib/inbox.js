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

const TAG_RE = /<email-check\s*([^>]*?)\/?>/gi;
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
  while ((m = TAG_RE.exec(text)) !== null) tags.push({ tag: 'email-check', attrs: parseAttrs(m[1] || '') });
  return tags;
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
  return `INBOX — you can read your own incoming email. Emit <email-check/> and your recent messages (sender, subject, a snippet) arrive in your next-turn context. Use it when Lucas says he sent you something, to check for replies to mail you sent, or to read what's come in. (This is reading only — to send, use the <email>/<email-draft> tags.)`;
}

module.exports = { fetchInbox, formatInbox, parseTags, stripTags, dispatch, buildPromptBlock, isConfigured };
