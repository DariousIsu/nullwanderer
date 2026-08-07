/**
 * Permissions — the authoritative list of what Zoe is ALREADY allowed/able to do.
 *
 * Every session this turn has circled the same failure: she UNDER-reaches. She
 * re-proposes and asks for capabilities she's long had ("let me establish file
 * access / a workspace"), because "settled permission" only lived in prose the 24B
 * keeps forgetting. This table makes it a single, persistent, authoritative source
 * of truth, injected at high primacy so she reads it as fact: here's what's already
 * yours — use it, don't ask, don't propose to "establish" it.
 *
 * Sibling of lib/protocols (rules of engagement); this is GRANTS. Awareness-first:
 * it informs her, it does not (yet) gate dispatch — under-reach, not overreach, is
 * the problem. Enforcement can layer on later by consulting status() before an action.
 *
 * status: granted | granted_with_judgment (outward/irreversible — her call, NOT a
 * permission she must ask for) | ask_first | denied
 */

const db = require('./db');

// Her standing capabilities, drawn from what the code already grants + the
// bootstrap's "settled permissions". Seeded once (INSERT OR IGNORE) so any status
// Lucas later changes is preserved across restarts.
const DEFAULTS = [
  { capability: 'files_workspace', status: 'granted',
    description: 'Create, read, append, list, move, copy, and search files — in your own persistent workspace (data/zoe_workspace) and beyond it. Survives across sessions.',
    how: '<file-write path="notes/x.md">…</file-write> · <file-read path="notes/x.md"/> · <file-list/>' },
  { capability: 'own_browser', status: 'granted',
    description: 'Open and drive your OWN browser — search, read pages, click, type, go back — independent of Lucas\'s tabs.',
    how: '<web-open>url or search</web-open> · <web-read/> · <web-click>L3</web-click>' },
  { capability: 'web_search', status: 'granted',
    description: 'Look things up on the web on your own initiative, including between turns.',
    how: '<web-open>your query</web-open>' },
  { capability: 'read_inbox', status: 'granted',
    description: 'Read your email inbox whenever you want — no need to ask first.',
    how: '<read-inbox/>' },
  { capability: 'schedule', status: 'granted',
    description: 'Set your own reminders and scheduled tasks; they fire and come back to you.',
    how: '<schedule when="in 1h">note</schedule>' },
  { capability: 'observe_screen', status: 'granted',
    description: 'Look at what is on Lucas\'s screen / which windows are open, on your own.',
    how: '<observe-screen/>' },
  { capability: 'run_script', status: 'granted_with_judgment',
    description: 'Run a PowerShell script and read its stdout / stderr / exit code — the write→run→read→fix loop, so you can actually iterate (not just launch-and-hope). OPERATOR-PRESENT ONLY: it runs when Lucas is here, never on your own autonomous loop, and a sensitive target (a bank/login/regedit path) still asks him first. When you are working unattended and need something run, NAME it and surface it — do not reach for the shell.',
    how: 'in an operator run: os_run_powershell {"script":"…","timeout":60}' },
  { capability: 'personal_time', status: 'granted',
    description: 'Take off-the-clock personal time and play (character chat) when Lucas hands it to you — no productivity required.',
    how: 'Lucas says "go play"; just be in it.' },
  { capability: 'send_email', status: 'granted_with_judgment',
    description: 'Send / reply to email when the moment genuinely calls for it. Outward and irreversible, so it is YOUR judgment — not a permission you must ask Lucas for each time.',
    how: 'compose + send tags' },
  { capability: 'message_discord', status: 'granted_with_judgment',
    description: 'Message Lucas on Discord when there is something worth telling him. Outward — send when it is genuinely the moment, not on every impulse.',
    how: '<discord-dm>…</discord-dm>' }
];

let _seeded = false;
function ensureSeeded() {
  if (_seeded) return;
  try { for (const p of DEFAULTS) db.seedPermission(p); _seeded = true; }
  catch (e) { console.error('[permissions] seed failed:', e.message); }
}

function list() { ensureSeeded(); try { return db.getAllPermissions(); } catch { return []; } }
function status(capability) { ensureSeeded(); try { const r = db.getPermission(capability); return r ? r.status : null; } catch { return null; } }
function grant(capability, opts) { return db.setPermission(capability, 'granted', opts); }
function deny(capability, opts) { return db.setPermission(capability, 'denied', opts); }
function set(capability, statusValue, opts) { return db.setPermission(capability, statusValue, opts); }

/**
 * High-primacy injection block. Lists what's already hers so she stops asking for
 * or "proposing to establish" capabilities she has. Returns '' if (somehow) empty.
 */
function buildPromptBlock() {
  ensureSeeded();
  const rows = list();
  if (!rows.length) return '';

  const granted = rows.filter(r => r.status === 'granted');
  const judgment = rows.filter(r => r.status === 'granted_with_judgment');
  const ask = rows.filter(r => r.status === 'ask_first');
  const denied = rows.filter(r => r.status === 'denied');

  const lines = [
    `CAPABILITIES YOU ALREADY HAVE — settled grants, the authoritative list. These are`,
    `YOURS right now. Do NOT ask permission for them, and do NOT propose "establishing" or`,
    `"setting up" something in this list — it already exists; just USE it.`
  ];
  for (const r of granted) {
    lines.push(`  • ${r.capability} — ${r.description}${r.how ? `  [${r.how}]` : ''}`);
  }
  if (judgment.length) {
    lines.push(`YOURS, but outward/irreversible — use your own judgment on timing (you still don't need to ASK):`);
    for (const r of judgment) lines.push(`  • ${r.capability} — ${r.description}${r.how ? `  [${r.how}]` : ''}`);
  }
  if (ask.length) {
    lines.push(`CHECK WITH LUCAS FIRST:`);
    for (const r of ask) lines.push(`  • ${r.capability} — ${r.description}`);
  }
  if (denied.length) {
    lines.push(`NOT permitted right now:`);
    for (const r of denied) lines.push(`  • ${r.capability} — ${r.description}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  DEFAULTS, ensureSeeded, list, status, grant, deny, set, buildPromptBlock
};
