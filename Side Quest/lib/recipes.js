/**
 * Recipe card — Zoe's PROCEDURAL memory (the layer SQ didn't have as a first
 * class thing). Borrowed from Echo's atlas `fast_paths`: a tight, footprint-
 * bounded "need → emit EXACTLY this tag (raw, not narrated) / not the trap" map,
 * surfaced at primacy so a 24B lands on the right action by default instead of
 * confabulating or narrating a tag (SQ's single worst recurring failure).
 *
 * It does NOT replace the verbose per-tool prompt blocks — it's the quick-
 * reference that sits above them. Every example here is validated against the
 * REAL parser in scripts/smoke_recipes.js, so the card can never drift from the
 * grammar the dispatchers actually accept (the atlas "recipes must execute" gate).
 *
 * Each recipe: { need, emit (canonical tag), trap (what NOT to do), check (runs
 * the live parser on `emit` — returns true if recognized) }. Recipes whose tool
 * isn't configured (email/discord) are omitted, mirroring promptBlocks().
 */

const inboxLib = require('./inbox');
const emailLib = require('./email');
const filesLib = require('./files');
const screenLib = require('./screen');
const schedulerLib = require('./scheduler');
const presenceLib = require('./presence');
const discordLib = require('./discord');
const browserLib = require('./browser');
const gapsLib = require('./gaps');
const focusLib = require('./focus');
const { detectCuriosity } = require('./curiosity');

const FOCUS_OPEN_RE = /<focus>([\s\S]*?)<\/focus>/i;
const WONDER_RE = /<wonder>([\s\S]*?)<\/wonder>/i;

function _safe(fn) { try { return !!fn(); } catch { return false; } }

// readiness mirrors promptBlocks(): a tool whose creds are absent returns a null
// prompt block, so we don't advertise a recipe she can't run.
function emailReady() { return _safe(() => emailLib.buildPromptBlock()); }
function discordReady() { return _safe(() => discordLib.buildPromptBlock()); }

// The full recipe table (data + live-parser check). `tier` gates inclusion.
function allRecipes() {
  return [
    // --- always available (no creds) ---
    { tier: 'core', need: 'think a question through with your larger self', emit: '<wonder>the specific question</wonder>', trap: "don't just muse — emit the tag to actually trigger it", check: t => WONDER_RE.test(t) },
    { tier: 'core', need: 'set an intention to carry across ticks', emit: '<focus>the goal</focus>', trap: 'one focus at a time; finish with <focus-done>…</focus-done> or <focus-stalled>why</focus-stalled>', check: t => FOCUS_OPEN_RE.test(t) },
    { tier: 'core', need: 'mark a focus complete / blocked', emit: '<focus-done>what you landed on</focus-done>', trap: '<focus-stalled>reason</focus-stalled> if truly blocked — not just because it is hard', check: t => !!focusLib.parseControlTags(t) },
    { tier: 'core', need: "flag a capability you don't have yet", emit: '<gap>what you can\'t do :: how you\'d solve it</gap>', trap: 'it becomes a proposal later — it is NOT acted on now', check: t => gapsLib.parseTags(t).length > 0 },
    { tier: 'core', need: 'keep a note, draft, or finding', emit: '<file-write path="notes/topic.md">the content</file-write>', trap: 'append <file-append>, read <file-read>; no delete exists', check: t => filesLib.parseTags(t).length > 0 },
    { tier: 'core', need: 'look something up on the web', emit: 'say plainly: I want to know <the specific thing>', trap: 'this is PHRASING, not a tag — it triggers a search next tick; do not invent a <search> tag', check: () => detectCuriosity('I want to know how the Maastricht treaty set its convergence criteria.').triggered },
    { tier: 'core', need: "see what Lucas has open on his machine", emit: '<observe-screen/>', trap: 'titles only, result arrives NEXT turn — never guess the window list', check: t => screenLib.parseTags(t).length > 0 },
    { tier: 'core', need: 'remind yourself / schedule work', emit: '<schedule when="in 2h" note="follow up on X"/>', trap: 'recurring <schedule every=…>; <schedule-list/>; <schedule-cancel id=N/>', check: t => schedulerLib.parseTags(t).length > 0 },
    { tier: 'core', need: 'pop a desktop notification to Lucas', emit: '<notify title="Quick thing">the body</notify>', trap: 'transient popup; for a real away-message use Discord', check: t => presenceLib.parseTags(t).length > 0 },
    // --- browser (only meaningful when connected, but grammar always valid) ---
    { tier: 'core', need: 'read the page you have open', emit: '<browse-read/>', trap: 'follow a link/button by HANDLE: <browse-click>L3</browse-click>; never guess a CSS selector', check: t => browserLib.parseTags(t).length > 0 },
    // --- email (configured only) ---
    { tier: 'email', need: 'READ your inbox', emit: '<read-inbox/>', trap: 'NOT <email>/<email-draft>/<email-send> — those SEND mail, the wrong action for reading', check: t => inboxLib.parseTags(t).length > 0 },
    { tier: 'email', need: 'SEND an email', emit: '<email to="addr@x.com" subject="...">the whole body here</email>', trap: 'recipient/subject are ATTRIBUTES; body goes BETWEEN the tags; never put To:/Subject: lines in the body, never backtick the tag', check: t => emailLib.parseTags(t).some(x => x.tag === 'email') },
    { tier: 'email', need: 'attach a file to an email', emit: '<email-attach path="drafts/x.pdf"/>', trap: 'only claim an attachment if you actually emitted this for a real file', check: t => emailLib.parseTags(t).some(x => x.tag === 'email-attach') },
    // --- discord (configured only) ---
    { tier: 'discord', need: 'message Lucas when he is away', emit: '<discord-dm>your message</discord-dm>', trap: 'DM only; for an active desktop chat just answer normally', check: t => discordLib.parseTags(t).length > 0 },
  ];
}

// The recipes that apply right now (email/discord gated on configuration).
function activeRecipes() {
  const eOk = emailReady(), dOk = discordReady();
  return allRecipes().filter(r => r.tier === 'core' || (r.tier === 'email' && eOk) || (r.tier === 'discord' && dOk));
}

/**
 * The card text injected at primacy. Concise on purpose (footprint-bounded). The
 * one-line discipline header is the load-bearing part: emit the LITERAL tag.
 */
function card() {
  const lines = activeRecipes().map(r => `• ${r.need} → ${r.emit}${r.trap ? `   (${r.trap})` : ''}`);
  return `HOW TO ACT — emit the LITERAL tag as raw text (never in backticks, never merely described); the result arrives your NEXT turn; never write or guess a tool's output. Quick map of need → tag:\n${lines.join('\n')}`;
}

module.exports = { card, activeRecipes, allRecipes, emailReady, discordReady };
