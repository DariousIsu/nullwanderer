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

// The canvas named as a DESTINATION: "on/onto/to a/the/a fresh/my canvas (doc/tab)".
const CANVAS_DEST = /\b(?:on|onto|to|into)\s+(?:a\s+fresh\s+|a\s+new\s+|a\s+|the\s+|my\s+|your\s+)?canvas(?:\s+doc(?:ument)?|\s+tab)?\b/i;
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
  if (!t || t.length > 600) return null;
  if (!CANVAS_DEST.test(t)) return null;
  if (ABOUT.test(t)) return null;
  if (!ORDER.test(t)) return null;
  return { order: t };
}

module.exports = { detect };
