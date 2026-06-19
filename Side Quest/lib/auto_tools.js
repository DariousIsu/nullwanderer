/**
 * Shared autonomous-tool surface for the between-turn loops (monologue,
 * heartbeat). The chat path in main.js dispatches scheduler/presence/email/
 * discord tags inline; this module lets the idle loops do the same without
 * duplicating the dispatch logic in each.
 *
 * promptBlocks() — combined tool descriptions (email/discord auto-omitted when
 *   their creds aren't configured).
 * parseAll(text) — which of the four tools she invoked.
 * stripAll(text) — remove their tags from stored thought/say.
 * dispatchFound(text, {onSheep, source}) — run any found tags, side-effecting
 *   DB + sheep panel; fire-and-forget friendly.
 */

const db = require('./db');
const schedulerLib = require('./scheduler');
const presenceLib = require('./presence');
const emailLib = require('./email');
const discordLib = require('./discord');

function promptBlocks() {
  return [
    schedulerLib.buildPromptBlock(),
    presenceLib.buildPromptBlock(),
    emailLib.buildPromptBlock(),     // null when unconfigured
    discordLib.buildPromptBlock()    // null when unconfigured
  ].filter(Boolean).join('\n\n');
}

function parseAll(text) {
  return {
    sched: schedulerLib.parseTags(text),
    presence: presenceLib.parseTags(text),
    email: emailLib.parseTags(text),
    discord: discordLib.parseTags(text)
  };
}

function hasAny(found) {
  return !!(found.sched.length || found.presence.length || found.email.length || found.discord.length);
}

function stripAll(text) {
  let t = text || '';
  t = schedulerLib.stripTags(t);
  t = presenceLib.stripTags(t);
  t = emailLib.stripTags(t);
  t = discordLib.stripTags(t);
  return t;
}

async function dispatchFound(text, { onSheep = () => {}, source = 'auto' } = {}) {
  const found = parseAll(text);
  for (const t of found.sched.slice(0, 3)) {
    try {
      const r = await schedulerLib.dispatch(t);
      if (r && r.ok && t.tag === 'schedule') onSheep({ id: Date.now(), ts: Date.now(), content: `(scheduled #${r.id}) ${r.summary}`, type: 'reading' });
      else if (r && r.ok && t.tag === 'schedule-list' && r.text) { const row = db.insertMonologue({ content: r.text, model: 'self-schedule', type: 'reading' }); onSheep({ id: row.id, ts: row.ts, content: '(listed schedule)', type: 'reading' }); }
      console.log(`[auto] schedule ${t.tag}: ${r && r.ok ? 'ok' : 'FAIL ' + (r && r.reason)}`);
    } catch (e) { console.error('[auto] schedule:', e.message); }
  }
  for (const t of found.presence.slice(0, 3)) {
    try {
      const r = await presenceLib.dispatch(t);
      if (r && r.ok && t.tag === 'clipboard-read' && r.text != null) { const row = db.insertMonologue({ content: `I read the clipboard:\n${r.text}`, model: 'clipboard', type: 'reading' }); onSheep({ id: row.id, ts: row.ts, content: '(read clipboard)', type: 'reading' }); }
      else if (r && r.ok) onSheep({ id: Date.now(), ts: Date.now(), content: `(${t.tag})`, type: 'reading' });
      console.log(`[auto] presence ${t.tag}: ${r && r.ok ? 'ok' : 'FAIL ' + (r && r.reason)}`);
    } catch (e) { console.error('[auto] presence:', e.message); }
  }
  for (const t of found.email.slice(0, 2)) {
    try {
      const r = await emailLib.dispatch(t, { source });
      onSheep({ id: Date.now(), ts: Date.now(), content: r.ok ? `(emailed) ${t.attrs.to}` : `(email failed) ${r.reason}`, type: 'reading' });
      console.log(`[auto] email: ${r && r.ok ? 'sent ' + t.attrs.to : 'FAIL ' + (r && r.reason)}`);
    } catch (e) { console.error('[auto] email:', e.message); }
  }
  for (const t of found.discord.slice(0, 2)) {
    try {
      const r = await discordLib.dispatch(t);
      onSheep({ id: Date.now(), ts: Date.now(), content: r.ok ? "(DM'd Lucas on Discord)" : `(discord failed) ${r.reason}`, type: 'reading' });
      console.log(`[auto] discord-dm: ${r && r.ok ? 'sent' : 'FAIL ' + (r && r.reason)}`);
    } catch (e) { console.error('[auto] discord:', e.message); }
  }
}

module.exports = { promptBlocks, parseAll, hasAny, stripAll, dispatchFound };
