/*
 * lib/canvas_command.js — detect an EXPLICIT "put/print X on the canvas" order. PURE + testable.
 *
 * Why (2026-08-07, the parish list, turns #11104-#11110): "Identify on a fresh canvas doc the name
 * of every parish in Louisiana" and "Please print to the canvas so I can verify" produced ZERO
 * canvas writes — the turns routed to the chat replier, which narrated ("Got it — all 64 parishes,
 * clean list") while nothing landed, and the research preflight then hijacked the ask into a study
 * monologue. Every artifact verb had a deterministic door except the most direct one: draw has the
 * image intercept, reports have report_command, retrieval has the pull-up gate — a CANVAS order had
 * nothing. This net completes the set: detect → execute → land via the deterministic canvas emit —
 * so the delivery claim is true by construction, never narration.
 *
 * STRICT by the same doctrine as its siblings: it fires only when the CANVAS is named as the
 * destination of an artifact. "Can you see my canvas", "what's on the canvas", and canvas talk
 * without an order do not fire.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// The canvas named as a DESTINATION: "on/onto/to a/the/a fresh/my canvas (doc/tab)" — or as the
// direct OBJECT of a create verb ("start a fresh canvas doc for X").
const CANVAS_DEST = /\b(?:on|onto|to|into)\s+(?:a\s+fresh\s+|a\s+new\s+|a\s+|the\s+|my\s+|your\s+)?canvas(?:\s+doc(?:ument)?|\s+tab)?\b|\b(?:start|make|create|open|spin\s+up)\s+(?:up\s+)?(?:a\s+|the\s+)?(?:fresh\s+|new\s+)?canvas(?:\s+doc(?:ument)?|\s+tab)?\b/i;
// An order verb somewhere in the message (imperative or polite).
const ORDER = /\b(?:print|put|write|list|add|create|build|draft|identify|lay\s+out|start|make|compose|assemble|update|show)\b/i;
// Questions ABOUT the canvas / references without an order — never fire.
const ABOUT = /\b(?:what(?:'s| is| are)\s+on|can you see|do you see|look at|is (?:it|that) on|already on)\b[^.?!]{0,20}\bcanvas\b/i;

/**
 * detect(text) → { order } when the message directs an artifact AT the canvas, else null.
 * `order` is the full instruction (the message itself, trimmed) — the executor needs the whole
 * ask, and recent conversation supplies the subject when the message is a bare "print it to the
 * canvas" follow-up.
 */
function detect(text) {
  const t = str(text).trim();
  if (!t) return null;                        // no length cap — a detailed order is the point
  if (!CANVAS_DEST.test(t)) return null;
  if (ABOUT.test(t)) return null;
  if (!ORDER.test(t)) return null;
  return { order: t };
}

// ── the EDIT half (2026-08-07 eve, live turns #11116-#11119) ────────────────────────────────────
// "convert the numbered list to bullets in the same document" got a 20-token narration and zero
// writes: the create net needs the canvas NAMED, but incremental work refers to the doc
// anaphorically ("the document we're building on the canvas right now", "the same document",
// "it"). While a WORKING canvas doc is fresh (the create net stamps one at every landing), an
// edit-shaped order referring to the doc — or any order while he has declared step-at-a-time
// canvas work — applies to THAT doc.

// Verbs that transform existing content (distinct from the create ORDER verbs on purpose —
// "convert/turn/reorder/bold" make no sense without a thing to transform).
const EDIT_VERB = /\b(?:convert|turn|change|reorder|re-?order|sort|alphabeti[sz]e|bullet|number|bold|italici[sz]e|retitle|rename|append|add|remove|delete|drop|insert|replace|swap|fix|correct|update|expand|fill\s+in|continue|next\s+step|step\s+\d+)\b/i;
// Anaphoric reference to the working doc.
const DOC_REF = /\b(?:the|this|that|same)\s+(?:doc(?:ument)?|list|table|canvas)\b|\bin\s+place\b|\bas\s+we\s+go\b|^\s*(?:it|that)\b/i;
// "fresh/new canvas" always means a NEW doc, never an edit of the working one.
const WANTS_FRESH = /\b(?:a\s+)?(?:fresh|new|another|separate)\s+canvas\b|\bcanvas\s+doc\b[^.?!]{0,20}\bfrom\s+scratch\b/i;

/**
 * detectEdit(text, { workingFresh }) → { order } when a fresh working canvas doc exists and the
 * message is an edit-shaped instruction referring to it, else null. `workingFresh` is the caller's
 * statement that a working doc was landed/edited recently — without one there is nothing to edit
 * and this NEVER fires (so ordinary chat is untouched outside a canvas session).
 */
function detectEdit(text, { workingFresh = false } = {}) {
  const t = str(text).trim();
  if (!workingFresh) return null;
  if (!t) return null;                        // no length cap (same doctrine as detect)
  if (WANTS_FRESH.test(t)) return null;                       // explicit new doc → the create net's job
  if (ABOUT.test(t)) return null;
  if (!EDIT_VERB.test(t)) return null;
  if (!(DOC_REF.test(t) || CANVAS_DEST.test(t))) return null; // must point at the doc (or the canvas)
  return { order: t };
}

// ── the PAYLOAD CONTRACT (2026-08-08, the ruined parish list) ───────────────────────────────────
// The edit door's delivery is true by construction — but the PAYLOAD had no contract, and the
// operator's conversational finalize leaked through it twice live: a 340ch "here's what I'm
// gathering" narration, then 676ch of raw deliberation ("I need to understand what Lucas is
// asking for… Let me check…"), each stamped OVER the real 64-parish document. Delivery honesty
// without payload honesty destroyed the very artifact it existed to protect. This validator is
// deterministic ON PURPOSE: it judges a MODEL's output (the sanctioned place for a regex — a
// contract check, not a comprehension gate); rejection means the doc stays UNTOUCHED and the
// relay says so.

// First-person process talk — a document never opens by describing the work of making itself.
const NARRATION_OPEN = /^(?:i\s+(?:need|want|should|will|'ll|am\s+going)\b|let\s+me\b|okay|alright|first,?\s+(?:i|let)\b|looking\s+at\b|to\s+(?:apply|do)\s+this\b|sure\b|got\s+it\b)/i;
// Deliberation markers anywhere — "let me check the pipeline documents" is reasoning, not content.
const NARRATION_BODY = /\blet\s+me\s+(?:check|look|see|verify|find|start)\b|\bi(?:'ll| will)\s+(?:check|look|need|start|gather)\b/i;
// Instructions that legitimately make a doc smaller.
const SHRINK_VERB = /\b(?:remove|delete|drop|trim|cut|shorten|condense|summari[sz]e|prune|strip|collapse|dedupe|merge|clean)\b/i;

/**
 * rejectEditOutput(md, cur, order) → a one-line reason string when the model's "updated doc"
 * must NOT replace the working copy, else null (accept). cur = the current doc, order = the
 * edit instruction (its verbs decide whether shrinking is plausible).
 */
function rejectEditOutput(md, cur, order) {
  const out = str(md).trim();
  if (!out) return 'empty output';
  if (NARRATION_OPEN.test(out)) return 'output opens as narration, not a document';
  if (NARRATION_BODY.test(out)) return 'output contains deliberation, not a document';
  const curLen = str(cur).trim().length;
  // 0.4: converting/reformatting roughly preserves size; losing >60% of a doc no one asked to
  // shrink means entries were dropped or replaced by prose.
  if (curLen > 200 && out.length < curLen * 0.4 && !SHRINK_VERB.test(str(order))) {
    return `output is ${out.length}ch vs the doc's ${curLen}ch with no shrink instruction`;
  }
  return null;
}

module.exports = { detect, detectEdit, rejectEditOutput };
