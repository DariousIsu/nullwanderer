/**
 * lib/rolling_context.js — THE ROLLING CONVERSATION WINDOW (Lucas 08-23: "keep the context open and
 * just compact as a background task when 75% of the window has been reached").
 *
 * CLOUD REPLY LANE ONLY (his call: "always cloud only"). Instead of rebuilding a 28-turn history
 * every call, the cloud writer sees a per-session RUNNING transcript: every user/ai_said turn since
 * the last compact rides verbatim, and older stretches ride as COMPACT BLOCKS — a bounded summary
 * whose full verbatim transcript is landed as a store document first, so the block carries a [dN]
 * handle the writer can dereference (<recall ref="dN"/>). Full-inference memory, not full-context
 * cost — and the STORE stays the foundation: the compact is a pointer, never the only copy.
 *
 * Invariants:
 *  - BOUNDED: the window budget is ~25k tokens (chars/4), never the model's whole context — the
 *    package (identity/grounding/tools) owns the rest.
 *  - The compact runs in the BACKGROUND after a reply, never inside a turn's latency path.
 *  - Land-then-summarize: the verbatim doc lands BEFORE the summary exists; a summarizer failure
 *    falls to a deterministic head/tail digest. Models never being trusted as the only copy.
 *  - Per-session state (db meta `context.rolling.<sessionId>`) — a new session starts EMPTY; the
 *    cross-session-bleed cure is untouched.
 *  - TOGGLE: db meta `context.rolling` === '1'. Off = the caller keeps the legacy 28-turn path
 *    (the A/B lever for the endurance sprints).
 *
 * Deps-injected end to end: { getTurnsSince, landDoc, getMeta, setMeta, complete, now }.
 */
'use strict';

const BUDGET_CHARS = 100000;          // ~25k tokens of history — bounded, per the design call
const COMPACT_AT = 0.75;              // compact when the running transcript crosses 75% of budget
const SUMMARY_CAP = 1400;             // chars per compact-block summary
const MAX_BLOCKS = 4;                 // older blocks collapse to a one-line doc pointer
const TURN_CAP = 4000;                // chars per verbatim turn in the assembled window
const BRIDGE_HORIZON_MS = 4 * 3600 * 1000;  // a prior session bridges only while its newest turn is this fresh
const BRIDGE_TURNS = 30;              // at most this many carried-over turns
const BRIDGE_TURN_CAP = 1000;         // chars per carried turn (context, not the live thread)
const BRIDGE_CHAR_CAP = 40000;        // the bridge never eats more than ~40% of the default budget

const str = (v) => (v == null ? '' : String(v));

function _stateKey(sessionId) { return `context.rolling.${sessionId}`; }

function enabled(deps) {
  try { return deps.getMeta('context.rolling') === '1'; } catch { return false; }
}

function _loadState(deps, sessionId) {
  try { const j = deps.getMeta(_stateKey(sessionId)); const s = j ? JSON.parse(j) : null; return s && Array.isArray(s.blocks) ? s : { sinceTurnId: 0, blocks: [] }; }
  catch { return { sinceTurnId: 0, blocks: [] }; }
}
function _saveState(deps, sessionId, state) {
  try { deps.setMeta(_stateKey(sessionId), JSON.stringify(state)); } catch {}
}

function _sizeOf(turns) { return turns.reduce((n, t) => n + str(t.content).length + 16, 0); }

/** The verbatim tail: user/ai_said turns after the compact horizon, excluding beyondId (the
 *  just-inserted raw user turn — the caller appends its COMPOSED form itself). */
function _tail(deps, sessionId, state, { excludeId = null } = {}) {
  const rows = deps.getTurnsSince(sessionId, state.sinceTurnId) || [];
  return rows.filter((t) => (t.speaker === 'user' || t.speaker === 'ai_said') && t.id !== excludeId);
}

/**
 * THE CROSS-BOOT BRIDGE (08-29: the 12:34 cycle minted a fresh session and the rolling window
 * started empty BY DESIGN — the ComiCon ask, 47 minutes fresh in the store, was invisible to the
 * classifier and the reply, and "just go get the information" resolved against the only thread
 * the blind window held). A reboot must not amnesia a live conversation: when this session's
 * window first assembles, the newest turns of the PRIOR sessions bridge in as one marked block —
 * but only while the newest prior turn is fresh (horizon default 4h, meta
 * `context.rolling.bridge_h` override). A stale prior session never bridges: the
 * cross-session-bleed cure keeps its teeth; only the false boundary a reboot draws inside one
 * live conversation is erased. Computed ONCE per session and saved in the state.
 */
function _bridge(deps, sessionId, state) {
  if (typeof state.bridgeText === 'string') return state.bridgeText;
  let text = '';
  try {
    if (typeof deps.getPrevTail === 'function') {
      let horizon = BRIDGE_HORIZON_MS;
      try { const h = parseFloat(deps.getMeta('context.rolling.bridge_h')); if (h > 0) horizon = h * 3600 * 1000; } catch {}
      const rows = deps.getPrevTail(sessionId, BRIDGE_TURNS) || [];
      const newest = rows.length ? Number(rows[rows.length - 1].ts || 0) : 0;
      if (rows.length && newest >= (deps.now || Date.now)() - horizon) {
        const lines = rows.map((t) => `${t.speaker === 'user' ? 'Lucas' : 'Zoe'}: ${str(t.content).replace(/\s+/g, ' ').slice(0, BRIDGE_TURN_CAP)}`);
        let body = lines.join('\n');
        while (body.length > BRIDGE_CHAR_CAP && lines.length > 2) { lines.shift(); body = lines.join('\n'); }
        text = body;
      }
    }
  } catch {}
  state.bridgeText = text;
  _saveState(deps, sessionId, state);
  return text;
}

/**
 * Assemble the rolling history for the cloud call: the cross-boot bridge (if fresh), compact
 * blocks (oldest first), then the verbatim tail as role turns. Returns { messages, sizeChars,
 * tailTurns } — messages EXCLUDES the newest user turn (pass its id as excludeId); the caller
 * appends the composed form.
 */
function assemble(deps, sessionId, { excludeId = null } = {}) {
  const state = _loadState(deps, sessionId);
  const messages = [];
  const bridge = _bridge(deps, sessionId, state);
  if (bridge) {
    messages.push({ role: 'system', content: `CARRIED OVER FROM BEFORE A RESTART (the app rebooted mid-conversation; these are the newest turns of the SAME live conversation — treat them as this conversation's own history, not another session's):\n${bridge}` });
  }
  const older = state.blocks.slice(0, -MAX_BLOCKS);
  const recent = state.blocks.slice(-MAX_BLOCKS);
  if (older.length) {
    messages.push({ role: 'system', content: `EARLIER STILL (compacted long ago — full verbatim transcripts live in the store): ${older.map((b) => `doc#${b.docId} (turns ${b.fromId}–${b.toId})`).join(', ')}.` });
  }
  for (const b of recent) {
    messages.push({ role: 'system', content: `EARLIER IN THIS SESSION (turns ${b.fromId}–${b.toId}, compacted — the FULL verbatim transcript is [d${b.docId}]; pull it with <recall ref="d${b.docId}"/> before quoting or re-litigating anything from that stretch):\n${b.summary}` });
  }
  const tail = _tail(deps, sessionId, state, { excludeId });
  for (const t of tail) {
    messages.push({ role: t.speaker === 'user' ? 'user' : 'assistant', content: str(t.content).slice(0, TURN_CAP) });
  }
  return { messages, sizeChars: _sizeOf(tail), tailTurns: tail.length };
}

/** Deterministic fallback digest — first/last turns, verbatim gists. Never invents. */
function _deterministicDigest(slice) {
  const gist = (t) => `${t.speaker === 'user' ? 'He' : 'She'}: ${str(t.content).replace(/\s+/g, ' ').slice(0, 200)}`;
  const head = slice.slice(0, 2).map(gist);
  const tailArr = slice.length > 4 ? slice.slice(-2).map(gist) : slice.slice(2).map(gist);
  return [`${slice.length} turns.`, ...head, slice.length > 4 ? `… (${slice.length - head.length - tailArr.length} turns elided — the doc holds them all)` : '', ...tailArr].filter(Boolean).join('\n').slice(0, SUMMARY_CAP);
}

/**
 * Background compact: when the verbatim tail crosses 75% of budget, land the OLDEST HALF as a
 * store document (verbatim — the doc IS the truth), summarize it into a compact block, and move
 * the horizon. Returns { compacted, docId?, fromId?, toId?, reason? }. Callers run this OFF the
 * turn path (post-reply timer / tick) and single-flight it.
 */
async function maybeCompact(deps, sessionId, { budget = BUDGET_CHARS } = {}) {
  const state = _loadState(deps, sessionId);
  const tail = _tail(deps, sessionId, state);
  const size = _sizeOf(tail);
  if (size <= budget * COMPACT_AT) return { compacted: false, reason: `under threshold (${size}/${Math.round(budget * COMPACT_AT)})` };
  // Oldest half by size — the newest stretch stays verbatim where recency matters.
  let acc = 0, cut = 0;
  for (let i = 0; i < tail.length; i++) { acc += str(tail[i].content).length + 16; cut = i + 1; if (acc >= size / 2) break; }
  if (cut >= tail.length) cut = Math.max(1, tail.length - 2);   // always keep a live tail
  const slice = tail.slice(0, cut);
  if (!slice.length) return { compacted: false, reason: 'nothing to compact' };
  const fromId = slice[0].id, toId = slice[slice.length - 1].id;
  // LAND FIRST — the verbatim transcript is the durable copy; the summary is only a pointer.
  const body = slice.map((t) => `**${t.speaker === 'user' ? 'Lucas' : 'Zoe'}** (turn ${t.id}):\n${str(t.content)}`).join('\n\n');
  const landed = deps.landDoc({
    title: `Conversation window compact — session ${sessionId}, turns ${fromId}–${toId}`,
    body, source: 'context-compact', ref: `ctx-compact-${sessionId}-${fromId}-${toId}`,
  });
  if (!landed || !landed.id) return { compacted: false, reason: 'doc landing failed — never compact without the durable copy' };
  let summary = '';
  if (typeof deps.complete === 'function') {
    try {
      summary = str(await deps.complete([
        { role: 'system', content: `Summarize this conversation stretch for a running context window in under ${SUMMARY_CAP} characters. Keep: every decision, open question, correction, name, and number EXACTLY as stated. Drop pleasantries. Never add anything the transcript does not contain. Plain prose.` },
        { role: 'user', content: body.slice(0, 24000) },
      ])).trim().slice(0, SUMMARY_CAP);
    } catch { summary = ''; }
  }
  if (summary.length < 40) summary = _deterministicDigest(slice);
  state.blocks.push({ docId: landed.id, summary, fromId, toId, ts: (deps.now || Date.now)() });
  state.sinceTurnId = toId;
  _saveState(deps, sessionId, state);
  return { compacted: true, docId: landed.id, fromId, toId, turns: slice.length, summaryChars: summary.length };
}

module.exports = { enabled, assemble, maybeCompact, BUDGET_CHARS, COMPACT_AT, MAX_BLOCKS, SUMMARY_CAP, BRIDGE_HORIZON_MS, BRIDGE_TURNS, _stateKey };
