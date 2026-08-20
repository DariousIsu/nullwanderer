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
 *     streams:  [{ lane, kind, target, agoMin }]       | [],     // the WORKSTREAM BOARD (lib/board) —
 *   }                                                            // background runs registered by any lane
 */
'use strict';

const ACTIVITY_RE = /\b(what(?:'?re| are| you| ya)?\s+(?:you\s+)?(?:doing|up to|working on|watching|reading|researching|in the middle of)|what'?s? (?:going on|happening) with you|are you (?:watching|in a meeting|researching|busy)|you busy|busy right now)\b/i;

function isActivityQuestion(text) { return ACTIVITY_RE.test(String(text || '')); }

// PAST / reflective SELF-ACTIVITY recall (elastic memory E2, 2026-08-18) — "what did you work on
// earlier today", "walk me through what you did", "how was your day". Distinct from isActivityQuestion
// (present tense, answered from the live lane snapshot): this asks what she DID, answered from her own
// activity log (agent_events). The gap it closes (drill T6): "what did you actually work on today"
// fell through BOTH the present-activity poll and the self-dev changelog, got grabbed by the entity
// resolver, and shipped a "which of the four people named 'You' did you mean?" disambiguation.
// Enumerated fillers (actually/really/just/manage to…) so "what did you actually work on" matches
// without a wildcard; caller also gates on !isRecallQuery and !activityQ.
const SELF_ACTIVITY_RECALL_RE = /\bwhat (?:did|were|have) you\s+(?:(?:actually|really|even|mostly|mainly|just|end up|wind up|get to|manage to|been|be)\s+){0,2}(?:do(?:ing|ne)?|work(?:ing|ed)?\s+on|get(?:ting)?\s+done|accomplish\w*|look(?:ing|ed)?\s+(?:at|into)|read(?:ing)?|research\w*|up\s+to|busy\s+with|spend\w*|been\s+(?:doing|working|up\s+to))\b|\bwalk me through (?:your day|what you (?:did|worked on|got done|found|looked at|were up to|been up to))\b|\bhow (?:was|did) your (?:day|morning|afternoon|week)\b/i;
function isSelfActivityRecall(text) { return SELF_ACTIVITY_RECALL_RE.test(String(text || '')); }

// SELF-LEARN recall (run-2 F10, stable-FAIL twice) — "what did you LEARN today", "most interesting
// thing you've learned". Distinct from isSelfActivityRecall ("do/work on" — the E2 slice covers DOING,
// not LEARNING): both live failures narrated what the USER asked and misattributed his turns to her.
// The answer source is her LEARNING bank (knowledge: learning/verified_fact/self_dev), never user turns.
// F30 (saturation run 3, 2026-08-20): the net was a PHRASE FAMILY ("what did YOU learn…"), not the
// KIND. Two live misses: the inverted teach-shape ("What did the last few days TEACH YOU about your
// own work?") and the lesson-from-mistake shape ("Name one MISTAKE YOU CAUGHT yourself making…") —
// the second fell through to entity land and she disambiguated her own "you" against contact tags.
const SELF_LEARN_RECALL_RE = /\bwhat (?:did|have|'?ve) you\s+(?:(?:actually|really|even|just|been)\s+){0,2}learn\w*\b|\bmost interesting thing you(?:'ve| have)? learn\w*\b|\bwhat(?:'s| is| was) the most interesting thing you(?:'ve| have)? (?:learned|read|found|discovered)\b|\b(?:did|have) you learn\w*\s+anything\b|\banything (?:new|interesting|cool) (?:that )?you(?:'ve| have)? learn\w*\b|\blearn anything (?:new|interesting|cool|good|today|tonight)\b|\bwhat have you been learning\b|\bnew things? you(?:'ve| have)? learned\b|\bwhat did you (?:find|discover) (?:out )?(?:today|tonight|this week|that was interesting)\b|\bwhat (?:did|do|does|have|has) [^?]{0,50}?(?:teach|taught) you\b|\b(?:name|tell me|share|give me|what(?:'s| is| was)?|any)\b[^.?!]{0,50}?\b(?:mistakes?|lessons?|errors?) (?:that )?you(?:'ve| have)? ?(?:caught|made|learned|took|taken|picked up)\b|\byou caught yourself\b|\b(?:lesson|takeaway)s? (?:from|out of) your (?:own )?(?:work|mistakes?|reading|research)\b/i;
function isSelfLearnRecall(text) { return SELF_LEARN_RECALL_RE.test(String(text || '')); }

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
  for (const st of (Array.isArray(s.streams) ? s.streams : []).slice(0, 5)) {
    out.push(`Now: ${_short(st.kind, 30)}${st.target ? ` "${_short(st.target, 50)}"` : ''} → ${_short(st.lane, 30)} lane`);
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
  // Board streams (lib/board) — her background work, named honestly and NEVER invented beyond the list.
  const streams = (Array.isArray(s.streams) ? s.streams : []).slice(0, 5);
  for (const st of streams) {
    const ago = Number(st.agoMin) > 0 ? ` (${st.agoMin}m in)` : '';
    parts.push(`running ${_short(st.kind, 40)}${st.target ? ` on "${_short(st.target, 70)}"` : ''}${ago}`);
  }
  const active = parts.length;
  const block = active
    ? `Right now you're ${parts.join('; and ')}.`
    : `Right now you're not in the middle of any active task — no research run, video, meeting, or background stream going.`;
  return { active, block, pointers: pointers(snapshot) };
}

module.exports = { isActivityQuestion, isSelfActivityRecall, isSelfLearnRecall, summarize, pointers, ACTIVITY_RE, SELF_ACTIVITY_RECALL_RE, SELF_LEARN_RECALL_RE };
