/**
 * lib/conversation_objects — CONVERSATIONS BECOME OBJECTS (memory slice 1A, 2026-07-22).
 *
 * The gap this closes: turns NEVER reached long-term memory. The nightly promotion pass is
 * documents-only, so every conversation Zoe has ever had lived solely in the rolling `turns` table —
 * "that talk last Tuesday" was not an addressable thing she could recall, cite, or promote. Echo even
 * ships a purpose-built `save_conversation` tool; it had zero callers (the same severed-wire class as
 * agent_inbox).
 *
 * The model: a CONVERSATION WINDOW is a contiguous run of spoken turns (`user` + `ai_said` — thoughts
 * are her inner life, never part of the shared record) delimited by 45 minutes of chat silence. A
 * cheap periodic pass finds windows that have CLOSED, renders each into a markdown transcript, and
 * lands it in the short-term document store with source 'conversation' — from that moment it rides
 * every existing document surface (same-day keyword recall, nightly promotion into Echo via
 * save_conversation + entity extraction, retention trim to a pointer). Sessions are NOT the boundary:
 * a session spans a whole app run (boot→quit, sometimes days), and a quick reboot mid-chat should not
 * split what Lucas experienced as one conversation.
 *
 * The watermark (`meta conversation_objects.after_turn_id`) starts at 0, so the FIRST passes walk the
 * entire history — the backfill IS the feature ("reference ANY conversation she's had"), paced at
 * maxLand windows per pass. Ref `conversation-<firstId>-<lastId>` makes landing idempotent.
 *
 * Pure logic here (window split, worthiness, render); the pass takes injected {db, land} deps so the
 * whole thing is offline-testable. Fail-safe: a landing failure STOPS the pass without advancing the
 * watermark (the window retries next tick) — advancing past a failed land would lose that
 * conversation forever.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

const GAP_MS = 45 * 60 * 1000;          // 45 min of silence closes a conversation window
const WATERMARK_KEY = 'conversation_objects.after_turn_id';
const MIN_TURNS = 2;                     // a lone unprompted announce with no reply is not a conversation
const MIN_CHARS = 80;                    // and neither is "hi" / "hey"

// Split spoken turns (ordered by id) into windows on gapMs silence. Returns ONLY closed windows —
// the tail window stays open until nowMs says the silence has lasted gapMs.
function findClosedWindows(turns = [], { gapMs = GAP_MS, nowMs = Date.now() } = {}) {
  const rows = (Array.isArray(turns) ? turns : [])
    .filter((t) => t && t.ts != null && (t.speaker === 'user' || t.speaker === 'ai_said'));
  const wins = [];
  let cur = null;
  for (const t of rows) {
    const ts = Number(t.ts) || 0;
    if (cur && ts - cur.lastTs >= gapMs) { wins.push(cur); cur = null; }
    if (!cur) cur = { turns: [], firstTs: ts, lastTs: ts };
    cur.turns.push(t);
    cur.lastTs = ts;
  }
  if (cur && nowMs - cur.lastTs >= gapMs) wins.push(cur);
  return wins;
}

// Worth landing as an object? Needs a real exchange: ≥2 turns, at least one from Lucas, ≥80 chars total.
function worthLanding(win) {
  const t = win && Array.isArray(win.turns) ? win.turns : [];
  if (t.length < MIN_TURNS) return false;
  if (!t.some((x) => x && x.speaker === 'user')) return false;
  return t.reduce((n, x) => n + str(x && x.content).length, 0) >= MIN_CHARS;
}

// Stable idempotency key for a window — the turn-id span cannot change once the window is closed.
function refFor(win) {
  const t = win && Array.isArray(win.turns) ? win.turns : [];
  if (!t.length) return null;
  return `conversation-${t[0].id}-${t[t.length - 1].id}`;
}

// Render a window into {title, body}. Title carries the Eastern start time + the first thing Lucas
// said (that opening line is usually the best recall handle a conversation has); body is a plain
// speaker-labeled transcript with a small facts header. No `# title` line — the promotion path
// prepends the title itself.
function renderConversation(win) {
  const tz = require('./tz');
  const t = win.turns;
  const first = t[0], last = t[t.length - 1];
  const firstUser = t.find((x) => x.speaker === 'user');
  const raw = firstUser ? str(firstUser.content).replace(/\s+/g, ' ').trim() : '';
  const snippet = raw.slice(0, 60);
  const title = `Conversation — ${tz.short(first.ts)}${snippet ? ` — "${snippet}${raw.length > 60 ? '…' : ''}"` : ''}`;
  const header = `_${t.length} turns · ${tz.date(first.ts)}, ${tz.time(first.ts)}–${tz.time(last.ts)} ${tz.label(last.ts)}_`;
  const lines = t.map((x) => `**${x.speaker === 'user' ? 'Lucas' : 'Zoe'}:** ${str(x.content).trim()}`);
  return { title, body: `${header}\n\n${lines.join('\n\n')}` };
}

/**
 * The periodic pass: read spoken turns past the watermark, land closed windows as documents, advance
 * the watermark. Returns { landed, duplicates, skipped, windows, halted }.
 *
 * Two rules that keep it lossless:
 *  - A truncated scan (rows == scanLimit) DROPS its final window — the cut may have split a real
 *    window in half, and half a conversation must never land. It re-forms whole next pass.
 *  - A landing FAILURE halts the pass before advancing past that window (retry next tick). Duplicates
 *    and not-worth windows advance normally — they are processed, not lost.
 */
function pass({ deps = {}, gapMs = GAP_MS, maxLand = 10, scanLimit = 4000, nowMs = Date.now() } = {}) {
  const db = deps.db || require('./db');
  const land = deps.land || require('./doc_store').land;
  const out = { landed: 0, duplicates: 0, skipped: 0, windows: 0, halted: false };
  let after = 0;
  try { after = parseInt(db.getMeta(WATERMARK_KEY) || '0', 10) || 0; } catch {}
  let rows = [];
  try { rows = db.turnsAfter(after, scanLimit) || []; } catch (e) { console.error('[conversation] turn scan failed:', e.message); return out; }
  if (!rows.length) return out;

  const wins = findClosedWindows(rows, { gapMs, nowMs });
  if (rows.length >= scanLimit && wins.length) wins.pop();
  out.windows = wins.length;

  let mark = after;
  for (const w of wins) {
    if (out.landed >= maxLand) break;
    if (worthLanding(w)) {
      const { title, body } = renderConversation(w);
      const r = land({ title, body, source: 'conversation', ref: refFor(w) });
      if (!r || r.id == null) { out.halted = true; break; }   // real failure — do not advance past it
      if (r.landed) {
        out.landed++;
        // Graph-lane contract (docs/LANE_BOUNDARY_2026-07-22_GRAPH.md §3A): a conversation becoming a
        // real object is a node BIRTH — the panel draws it in the short-term region and "that talk
        // last Tuesday" becomes clickable. emit() is a safe no-op headless and never throws.
        require('./kg_activity').emit({ db: 'sidequest', kind: 'node.born', anchor: title });
      } else out.duplicates++;
    } else out.skipped++;
    mark = w.turns[w.turns.length - 1].id;
  }
  try { if (mark > after) db.setMeta(WATERMARK_KEY, String(mark)); } catch (e) { console.error('[conversation] watermark write failed:', e.message); }
  return out;
}

module.exports = { GAP_MS, WATERMARK_KEY, MIN_TURNS, MIN_CHARS, findClosedWindows, worthLanding, refFor, renderConversation, pass };
