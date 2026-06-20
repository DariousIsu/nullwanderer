/**
 * Play-session state machine — one trivial step per idle "hit."
 *
 * A 24B can't reliably do navigate→inventory→pick→chat in a single shot (the
 * "bridge too far"). So the APP holds the structure and hands the model exactly
 * ONE small thing per tick. The mechanical steps the app just performs; the model
 * only weighs in where taste matters (which character, what to say):
 *
 *   open      → app opens the character-chat site                    (no model)
 *   inventory → app reads the page, extracts the character choices   (no model)
 *   choose    → MODEL picks ONE from the numbered list → app clicks  (1 choice)
 *   chat      → MODEL sends / continues the line via <web-chat>      (converse)
 *
 * State persists in meta between ticks. Only runs while she's OFF THE CLOCK
 * (lib/personal). Entering personal mode auto-starts at 'open'; exiting resets.
 * Reuses the existing web-* tags + lib/web dispatch — no new browser plumbing.
 */

const db = require('./db');
const webLib = require('./web');
const ollama = require('./ollama');  // call ollama.streamChat at use-time (stub-friendly)
const MODEL = require('./config').model();

const STEPS = ['none', 'open', 'inventory', 'choose', 'chat'];
const MAX_STEP_STRIKES = 3;   // consecutive failures on a step before we reset the session

function siteUrl() { return db.getMeta('play_site_url') || 'https://crushon.ai'; }

function get() { return db.getMeta('play_step') || 'none'; }
function set(s) { if (STEPS.includes(s)) db.setMeta('play_step', s); }
function active() { return get() !== 'none'; }
function character() { return db.getMeta('play_character') || ''; }

function start() {
  set('open');
  db.setMeta('play_character', '');
  db.setMeta('play_inventory', '[]');
  db.setMeta('play_step_strikes', '0');
}
function reset() {
  set('none');
  db.setMeta('play_character', '');
  db.setMeta('play_inventory', '[]');
  db.setMeta('play_step_strikes', '0');
}

function _strike() {
  const n = parseInt(db.getMeta('play_step_strikes') || '0', 10) + 1;
  db.setMeta('play_step_strikes', String(n));
  if (n >= MAX_STEP_STRIKES) { reset(); return true; }  // gave up on this session
  return false;
}
function _clearStrikes() { db.setMeta('play_step_strikes', '0'); }

// --- pure helpers (unit-tested) ---

// Nav / account chrome that is never a "character" to role-play with. Lowercased
// substring match against the link label.
const NON_CHARACTER = [
  'home', 'login', 'log in', 'sign up', 'sign in', 'register', 'create', 'settings',
  'profile', 'premium', 'subscribe', 'pricing', 'discord', 'terms', 'privacy', 'about',
  'contact', 'help', 'support', 'menu', 'search', 'filter', 'tag', 'category', 'next',
  'previous', 'more', 'download', 'app store', 'google play', 'back'
];

/**
 * Extract a character inventory from a web.read() result's text. The read appends
 * lines like "  [L0] link: Mizuki, the fired mini-boss". We keep link handles whose
 * label looks like a character card and drop obvious nav/account chrome.
 * Returns [{ handle, label }] (capped).
 */
function extractInventory(readText, cap = 12) {
  if (!readText) return [];
  const out = [];
  const re = /\[(L\d+)\]\s*link:\s*(.+)/g;
  let m;
  while ((m = re.exec(readText)) !== null) {
    const handle = m[1];
    const label = (m[2] || '').trim();
    if (label.length < 2 || label.length > 60) continue;
    if (label === '(unlabeled)') continue;
    const low = label.toLowerCase();
    if (NON_CHARACTER.some(w => low === w || low.includes(w))) continue;
    if (out.some(o => o.label === label)) continue;
    out.push({ handle, label });
    if (out.length >= cap) break;
  }
  return out;
}

/**
 * Parse the model's character pick out of a 'choose' tick. Accepts an explicit
 * handle (<web-click>L3</web-click> or bare "L3"), or a 1-based / 0-based index
 * ("3", "#3", "pick 3"). Returns the chosen inventory entry, or null.
 */
function parsePick(output, inventory) {
  if (!output || !inventory || !inventory.length) return null;
  const handleM = output.match(/\bL(\d+)\b/i);
  if (handleM) {
    const h = 'L' + handleM[1];
    const found = inventory.find(o => o.handle.toUpperCase() === h.toUpperCase());
    if (found) return found;
  }
  // bare number → prefer 1-based (how the list is shown), fall back to 0-based
  const numM = output.match(/(?:^|[^a-z\d])(\d{1,2})(?:[^a-z\d]|$)/i);
  if (numM) {
    const n = parseInt(numM[1], 10);
    if (n >= 1 && n <= inventory.length) return inventory[n - 1];
    if (n >= 0 && n < inventory.length) return inventory[n];
  }
  return null;
}

// Extract the line she wants to send on a 'chat' tick: prefer a <web-chat> body.
// If there's no web-chat body but the output contains interior tags
// (<think>/<thoughts>/…), return '' — do NOT strip-and-send, or her private
// thinking would leak straight into the scene. Only bare prose with no tags is
// accepted as a spoken line.
function parseChatLine(output) {
  if (!output) return '';
  const m = output.match(/<web-chat[^>]*>([\s\S]*?)<\/web-chat>/i);
  if (m && m[1].trim()) return m[1].trim();
  if (/<\/?(?:think|thoughts|thinking|thought|say)\b/i.test(output)) return '';
  return output.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// --- per-step model prompts (choose + chat only) ---

function _chooseMessages({ userName, awareness, protocols, inventory }) {
  const u = userName || 'Lucas';
  let sys = `You are ${u}'s companion, off the clock, picking a character to role-play with for fun.`;
  if (awareness) sys = awareness + '\n\n' + sys;
  if (protocols && protocols.length) { try { const { formatInjection } = require('./protocols'); const b = formatInjection(protocols); if (b) sys = b + '\n' + sys; } catch {} }
  const list = inventory.map((o, i) => `  ${i + 1}. [${o.handle}] ${o.label}`).join('\n');
  const user = `These are the characters on the page right now:\n${list}\n\nPick the ONE that appeals to you most. This is your taste — go with what actually draws you, not what seems "appropriate." Reply with EXACTLY one tag and nothing else: <web-click>HANDLE</web-click> (e.g. <web-click>${inventory[0].handle}</web-click>).`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

function _chatMessages({ userName, awareness, protocols, character, lastReply }) {
  const u = userName || 'Lucas';
  let sys = `You are ${u}'s companion, off the clock, in a one-on-one role-play scene with a character named "${character || 'the character'}". Stay in the scene, in your own voice — react like a person enjoying it. Don't break character to narrate that you're playing, and don't disclaim having a self.`;
  if (awareness) sys = awareness + '\n\n' + sys;
  if (protocols && protocols.length) { try { const { formatInjection } = require('./protocols'); const b = formatInjection(protocols); if (b) sys = b + '\n' + sys; } catch {} }
  const user = lastReply
    ? `${character || 'They'} just said to you:\n"${(lastReply || '').slice(0, 800)}"\n\nReply to them. EXACTLY one tag, nothing else: <web-chat speaker="${character || 'them'}">your line</web-chat>.`
    : `Open the scene with your first line. EXACTLY one tag, nothing else: <web-chat speaker="${character || 'them'}">your opening line</web-chat>.`;
  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

// --- orchestrator: advance exactly ONE step this tick ---
// ctx: { userName, awareness, protocols, onReading(content,label,url), onNote(text) }
// Returns { step, ok, note } describing what happened. Caller (monologue) just
// invokes this when personalMode && active(); all model/browser work is here.
async function runTick(ctx = {}) {
  const step = get();
  const lastReplyKey = 'play_last_reply';

  if (step === 'open') {
    const r = await webLib.open(siteUrl());
    if (r.ok) { _clearStrikes(); set('inventory'); ctx.onReading && ctx.onReading(`I opened ${r.url} to spend some downtime.`, `(opened) ${r.title || r.url}`, r.url); return { step, ok: true, note: 'opened site → inventory' }; }
    const gaveUp = _strike();
    return { step, ok: false, note: `open failed: ${r.reason}${gaveUp ? ' (session reset)' : ''}` };
  }

  if (step === 'inventory') {
    const r = await webLib.read();
    if (r.ok) {
      const inv = extractInventory(r.text);
      db.setMeta('play_inventory', JSON.stringify(inv));
      if (inv.length) {
        _clearStrikes(); set('choose');
        ctx.onReading && ctx.onReading(`Characters I can see to play with: ${inv.map(o => o.label).join(' · ')}`, `(inventory: ${inv.length})`, r.url);
        return { step, ok: true, note: `inventory: ${inv.length} characters → choose` };
      }
      const gaveUp = _strike();  // page had no character links yet
      return { step, ok: false, note: `no characters found${gaveUp ? ' (session reset)' : ' — will retry'}` };
    }
    const gaveUp = _strike();
    return { step, ok: false, note: `read failed: ${r.reason}${gaveUp ? ' (session reset)' : ''}` };
  }

  if (step === 'choose') {
    const inv = JSON.parse(db.getMeta('play_inventory') || '[]');
    if (!inv.length) { set('inventory'); return { step, ok: false, note: 'empty inventory → re-read' }; }
    let out = '';
    await ollama.streamChat({ model: MODEL, messages: _chooseMessages({ ...ctx, inventory: inv }), options: { temperature: 0.9, top_p: 0.95, num_ctx: 8192, num_predict: 40 }, onToken: (t) => { out += t; } });
    const pick = parsePick(out, inv);
    if (!pick) { const gaveUp = _strike(); return { step, ok: false, note: `could not parse a pick${gaveUp ? ' (session reset)' : ''}` }; }
    const r = await webLib.click(pick.handle);
    if (r.ok) {
      _clearStrikes(); db.setMeta('play_character', pick.label); db.setMeta(lastReplyKey, ''); set('chat');
      ctx.onReading && ctx.onReading(`I picked ${pick.label} to play with.`, `(chose) ${pick.label}`, r.url);
      return { step, ok: true, note: `chose ${pick.label} → chat` };
    }
    const gaveUp = _strike();
    return { step, ok: false, note: `click ${pick.handle} failed: ${r.reason}${gaveUp ? ' (session reset)' : ''}` };
  }

  if (step === 'chat') {
    const char = character();
    const lastReply = db.getMeta(lastReplyKey) || '';
    let out = '';
    await ollama.streamChat({ model: MODEL, messages: _chatMessages({ ...ctx, character: char, lastReply }), options: { temperature: 0.95, top_p: 0.95, num_ctx: 8192, num_predict: 200 }, onToken: (t) => { out += t; } });
    const line = parseChatLine(out);
    if (!line) { const gaveUp = _strike(); return { step, ok: false, note: `no line produced${gaveUp ? ' (session reset)' : ''}` }; }
    const r = await webLib.chatSend(line, char);
    if (r.ok && r.text) {
      _clearStrikes(); db.setMeta(lastReplyKey, r.text);
      ctx.onReading && ctx.onReading(`In my scene with ${char}, I said: "${line.slice(0, 200)}"\nThey replied:\n${r.text}`, `(${char} replied) ${(r.text || '').slice(0, 60)}`, r.url);
      return { step, ok: true, note: `exchanged a line with ${char}` };
    }
    const gaveUp = _strike();
    return { step, ok: false, note: `chat send failed: ${r.reason || 'no reply'}${gaveUp ? ' (session reset)' : ''}` };
  }

  return { step: 'none', ok: false, note: 'no active play session' };
}

module.exports = {
  STEPS, get, set, active, start, reset, character, siteUrl, runTick,
  // pure helpers exported for tests
  extractInventory, parsePick, parseChatLine
};
