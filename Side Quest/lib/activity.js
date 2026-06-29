/**
 * activity — the cross-lane ACTIVITY source for the poll router (docs/INTERFACE_AND_LANES_DESIGN.md §2–3).
 * (Named `activity`, not `lanes`, because lib/lanes.js is already the HERS/YOURS/OURS surfacing gate.)
 *
 * "What are you doing / working on / watching right now?" should be answered from the actual active
 * lanes (research / media / meeting), not the voice model's guess. This module classifies that question
 * and turns an injected lane SNAPSHOT into (a) a grounded activity answer the interface relays, and
 * (b) the one-line-per-lane HEARTBEAT POINTERS that let the interface "float above" without the lane
 * content polluting the prompt (§3 — point to the node, don't inline the transcript).
 *
 * PURE: the caller (main.js) builds the snapshot from meta/focus state and passes it in. No db, no I/O.
 * Fail-safe: every field is optional; a missing lane is simply absent. Returns values, never throws.
 *
 *   snapshot = {
 *     research: { goal, covered:[…], target:{name} } | null,
 *     media:    { title, url, stage, understanding }  | null,   // stage: watching | done | …
 *     meeting:  { url, stage, awaitingAdmit }          | null,   // stage: joining | awaiting_admit | in | observing
 *   }
 */
'use strict';

const ACTIVITY_RE = /\b(what(?:'?re| are| you| ya)?\s+(?:you\s+)?(?:doing|up to|working on|watching|reading|researching|in the middle of)|what'?s? (?:going on|happening) with you|are you (?:watching|in a meeting|researching|busy)|you busy|busy right now)\b/i;

function isActivityQuestion(text) { return ACTIVITY_RE.test(String(text || '')); }

function _short(s, n = 80) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, n); }

// One pointer line per active lane: "Now: <activity> "<title>" → <ref>". The ref is a handle the
// interface can dereference on demand (a node id once lanes persist nodes; the lane key for now).
function pointers(snapshot = {}) {
  const out = [];
  const s = snapshot || {};
  if (s.research && s.research.goal) {
    const n = Array.isArray(s.research.covered) ? s.research.covered.length : 0;
    const tgt = s.research.target && s.research.target.name ? `, on ${s.research.target.name}` : '';
    out.push(`Now: researching "${_short(s.research.goal, 60)}" (${n} done${tgt}) → research lane`);
  }
  if (s.media && s.media.stage && !['none', 'done'].includes(s.media.stage)) {
    out.push(`Now: watching "${_short(s.media.title || s.media.url || 'a video', 60)}" → media lane`);
  }
  if (s.meeting && s.meeting.stage && !['none', 'done'].includes(s.meeting.stage)) {
    const what = s.meeting.awaitingAdmit || s.meeting.stage === 'awaiting_admit' ? ' — awaiting admit' : '';
    out.push(`Now: in meeting ${_short(s.meeting.url || '', 50)}${what} → meeting lane`);
  }
  return out;
}

// The grounded answer to "what are you doing?" — built ONLY from the snapshot (never invented).
function summarize(snapshot = {}) {
  const s = snapshot || {};
  const parts = [];
  if (s.research && s.research.goal) {
    const n = Array.isArray(s.research.covered) ? s.research.covered.length : 0;
    const tgt = s.research.target && s.research.target.name ? `, currently on ${s.research.target.name}` : '';
    parts.push(`researching "${_short(s.research.goal, 90)}" — ${n} done so far${tgt}`);
  }
  if (s.media && s.media.stage && !['none', 'done'].includes(s.media.stage)) {
    const u = s.media.understanding ? ` (${_short(s.media.understanding, 90)})` : '';
    parts.push(`watching "${_short(s.media.title || s.media.url || 'a video', 70)}"${u}`);
  }
  if (s.meeting && s.meeting.stage && !['none', 'done'].includes(s.meeting.stage)) {
    const what = s.meeting.awaitingAdmit || s.meeting.stage === 'awaiting_admit' ? ', waiting to be let in' : '';
    parts.push(`in a meeting (${_short(s.meeting.url || '', 60)})${what}`);
  }
  const active = parts.length;
  const block = active
    ? `Right now you're ${parts.join('; and ')}.`
    : `Right now you're not in the middle of any active task — no research run, video, or meeting going.`;
  return { active, block, pointers: pointers(snapshot) };
}

module.exports = { isActivityQuestion, summarize, pointers, ACTIVITY_RE };
