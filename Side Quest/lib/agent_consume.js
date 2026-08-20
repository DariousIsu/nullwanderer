'use strict';
/*
 * lib/agent_consume.js — B1: THE CONSUME STEP (live-test run 2, 2026-08-19).
 *
 * The run-2 disease: a chat-triggered delegated agent SUCCEEDED in 21 seconds — the full brief sat
 * in skuld.agent_runs.output — and nothing on the conversation path ever read it. She re-spawned the
 * same research three times, then asked Lucas to PASTE data sitting in her own database ("the run IDs
 * aren't showing completed output in my context"). agent_inbox only carries title/summary to the inner
 * monologue; get_agent_output (the body) had no caller on the chat path.
 *
 * Three moves, all on existing rails (review_fanout's proven parsers + fireToolFollowup delivery):
 *   1. REGISTER — a chat-triggered spawn/delegate records its run_id + an input hash (echo_suit hook).
 *   2. DEDUPE  — a repeat spawn with the same input inside the window is answered from the ledger:
 *                the completed run's output (read-through), or an honest "already running, don't
 *                re-spawn" — never a third copy of the same research.
 *   3. CONSUME — a watcher (main.js) polls registered runs; on success the FULL OUTPUT is fed back
 *                through fireToolFollowup so she reads it and delivers the substance in her voice.
 *
 * Pure logic with an injected meta store ({get,set}) — no db require, no Date.now inside the pure
 * fns — so the smoke covers everything offline. Registry lives in meta 'agent_consume.pending' /
 * '.done' (small, capped JSON arrays). Every edge fails soft: a bookkeeping error never breaks a
 * dispatch, and the dedupe falls open to the real call. Run: scripts/smoke_agent_consume.js
 */

const PENDING_KEY = 'agent_consume.pending';
const DONE_KEY = 'agent_consume.done';
const CAP = 20;
const DEDUPE_WINDOW_MS = 60 * 60 * 1000;   // a same-input run inside the hour is the same request
const GIVE_UP_MS = 30 * 60 * 1000;         // stop polling a run after 30 min — log, drop, move on
const MAX_ATTEMPTS = 25;

const str = (v) => (v == null ? '' : String(v));

// Stable input hash: tool name + sorted-key JSON of the args, minus the dispatch envelope (the
// envelope is OURS, appended at dispatch — two identical tasks must hash equal with or without it).
const _ENVELOPE_RE = /\n\nYour final reply IS the return value[\s\S]*$/;
function hashInput(tool, args) {
  const norm = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') return v.replace(_ENVELOPE_RE, '').trim().toLowerCase();
    if (Array.isArray(v)) return v.map(norm);
    if (typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = norm(v[k]); return o; }
    return v;
  };
  const src = `${str(tool).toLowerCase()}|${JSON.stringify(norm(args || {}))}`;
  let h = 0xcbf29ce4 >>> 0;
  for (let i = 0; i < src.length; i++) { h ^= src.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

function _load(store, key) { try { const v = JSON.parse(store.get(key) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
function _save(store, key, arr) { try { store.set(key, JSON.stringify(arr.slice(-CAP))); } catch {} }

/** Register a freshly-spawned chat run for consumption. Dedupes by runId. Fail-soft. */
function register({ runId, tool, hash, at }, store) {
  if (!runId || !store) return false;
  const arr = _load(store, PENDING_KEY);
  if (arr.some((e) => e && e.runId === runId)) return false;
  arr.push({ runId: str(runId), tool: str(tool).slice(0, 60), hash: str(hash), at: at || 0, attempts: 0 });
  _save(store, PENDING_KEY, arr);
  return true;
}

function pending(store) { return _load(store, PENDING_KEY); }
function savePending(store, arr) { _save(store, PENDING_KEY, arr); }

/** Move a run to the done ledger (consumed or completed) so dedupe can read-through it later. */
function markDone({ runId, tool, hash, at }, store) {
  const p = _load(store, PENDING_KEY).filter((e) => e && e.runId !== runId);
  _save(store, PENDING_KEY, p);
  const d = _load(store, DONE_KEY);
  if (!d.some((e) => e && e.runId === runId)) { d.push({ runId, tool: str(tool).slice(0, 60), hash: str(hash), at: at || 0 }); _save(store, DONE_KEY, d); }
}

/** Same-input lookup for the dedupe gate: a done run wins (read-through its output); else a pending
 *  run inside the window ("already running — don't re-spawn"). Returns null when nothing matches. */
function lookup(hash, store, { now, maxAgeMs = DEDUPE_WINDOW_MS } = {}) {
  if (!hash || !store) return null;
  const fresh = (e) => e && e.hash === hash && (now == null || now - (e.at || 0) <= maxAgeMs);
  const done = _load(store, DONE_KEY).filter(fresh).pop();
  if (done) return { ...done, state: 'done' };
  const pend = _load(store, PENDING_KEY).filter(fresh).pop();
  if (pend) return { ...pend, state: 'pending' };
  return null;
}

// ── honest texts (the dedupe gate's tool results + the consume followup prompt) ─────────────────────────
const _min = (ms) => Math.max(1, Math.round(ms / 60000));
function reuseNote(runId, ageMs, output) {
  return `[REUSING the completed agent run ${runId} from ${_min(ageMs)} minute(s) ago — the SAME request already ran; do NOT re-spawn it. Its full output is below. Work from this.]\n\n${str(output)}`;
}
function stillRunningNote(runId, ageMs) {
  return `[That agent is ALREADY RUNNING — run ${runId}, started ${_min(ageMs)} minute(s) ago. Do NOT spawn it again; the result will be brought to you the moment it lands. Tell the user plainly that the run is in flight.]`;
}
function consumePrompt({ tool, runId, output, userName = 'Lucas' } = {}) {
  return `[Delegated agent run ${runId}${tool ? ` (${tool})` : ''} has COMPLETED — its FULL OUTPUT is below. Read it and deliver the substance to ${userName} now, in your own voice: lead with what it established, keep the citations, and flag what it could not establish. Do NOT re-run the agent and do NOT just acknowledge — this IS the result you owed.]\n\n${str(output)}`;
}

module.exports = { hashInput, register, pending, savePending, markDone, lookup, reuseNote, stillRunningNote, consumePrompt, PENDING_KEY, DONE_KEY, DEDUPE_WINDOW_MS, GIVE_UP_MS, MAX_ATTEMPTS };
