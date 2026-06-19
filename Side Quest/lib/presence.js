/**
 * Presence utilities for Zoe — desktop notifications + clipboard. Native via
 * Electron's built-ins (no extra deps). These give her a way to reach Lucas
 * on the machine even when he's not looking at the chat window, and to read /
 * leave things on the system clipboard.
 *
 * Runs in the Electron main process (where Notification + clipboard live).
 *
 * Tags (parsed from <think>/<say>):
 *   <notify title="...">body</notify>   — pop a desktop notification
 *   <clipboard-read/>                    — read clipboard text into next-turn context
 *   <clipboard-write>text</clipboard-write>  — put text on the clipboard
 */

let electron = null;
try { electron = require('electron'); } catch { /* non-electron context (tests) */ }

const MAX_CLIP_READ = 8000;

function notify(title, body) {
  try {
    if (!electron || !electron.Notification) return { ok: false, reason: 'notifications unavailable' };
    if (!electron.Notification.isSupported || !electron.Notification.isSupported()) {
      return { ok: false, reason: 'notifications not supported on this OS' };
    }
    const n = new electron.Notification({
      title: (title || 'Zoe').slice(0, 120),
      body: (body || '').slice(0, 500)
    });
    n.show();
    return { ok: true, title, body };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function clipboardRead() {
  try {
    if (!electron || !electron.clipboard) return { ok: false, reason: 'clipboard unavailable' };
    let text = electron.clipboard.readText() || '';
    const truncated = text.length > MAX_CLIP_READ;
    if (truncated) text = text.slice(0, MAX_CLIP_READ) + '\n…(truncated)';
    return { ok: true, text, truncated };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function clipboardWrite(text) {
  try {
    if (!electron || !electron.clipboard) return { ok: false, reason: 'clipboard unavailable' };
    electron.clipboard.writeText(String(text == null ? '' : text));
    return { ok: true, bytes: Buffer.byteLength(String(text || ''), 'utf8') };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// --- tag parsing (mirrors files.js / screen.js) ---

const PRESENCE_TAG_RE = /<(notify|clipboard-read|clipboard-write)\s*([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
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
  let m; PRESENCE_TAG_RE.lastIndex = 0;
  while ((m = PRESENCE_TAG_RE.exec(text)) !== null) {
    tags.push({ tag: m[1].toLowerCase(), attrs: parseAttrs(m[2] || ''), body: (m[3] || '').trim() });
  }
  return tags;
}

function stripTags(text) {
  return (text || '').replace(PRESENCE_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

async function dispatch({ tag, attrs, body }) {
  switch (tag) {
    case 'notify':          return notify(attrs.title || 'Zoe', body || attrs.body || '');
    case 'clipboard-read':  return clipboardRead();
    case 'clipboard-write': return clipboardWrite(body);
    default:                return { ok: false, reason: `unknown presence tag ${tag}` };
  }
}

function buildPromptBlock() {
  return `PRESENCE — you can reach Lucas on the machine and use the clipboard, even when he isn't looking at the chat:
  <notify title="Quick thing">a short desktop notification body</notify>   — pop a system notification
  <clipboard-read/>                       — read what's currently on his clipboard into your next-turn context
  <clipboard-write>text</clipboard-write> — put text on the clipboard for him to paste
Use notifications sparingly — for something that genuinely wants his attention, not chatter.`;
}

module.exports = {
  notify, clipboardRead, clipboardWrite,
  parseTags, stripTags, dispatch, buildPromptBlock
};
