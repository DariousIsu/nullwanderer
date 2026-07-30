/**
 * lib/doc_set.js — CANVAS-SET ANALYSIS reach (Lucas 2026-07-30: "I don't need the report, I need
 * the program to be able to generate it").
 *
 * The live failure (07-28): nine attendance rosters dropped on the canvas, he asked for a
 * name-frequency report. She committed to it, then tried to read the CANVAS TAB (volatile) while
 * all nine bodies sat durable in her document store — and next day asked HIM for files she
 * already held. Two gaps, both here:
 *   (1) nothing surfaced the drops AS A SET — doc-QA picks ONE document, ever;
 *   (2) counting across 400k chars is a SCRIPT job — analyze_data (the R3 lane, sq.db whitelisted
 *       read-only) existed all along and nothing routed an analytical chat ask to it.
 * This module is the pure half: the detector + the set manifest the operator receives, teaching
 * exactly where the bodies live and which tool computes. The wiring (main.js) forces such an ask
 * into operator task mode with this block in context.
 */
'use strict';

// Analytical verb + set noun — both, or it isn't a set-analysis ask. "How many senators are in
// Ohio" (no set noun) stays a lookup; "read the document" (no analytic verb) stays doc-QA.
const ANALYTIC_RE = /\b(frequen\w*|count\w*|how many|how often|tally|tabulate|compare|comparison|overlap\w*|cross-?ref\w*|dedup\w*|aggregate|distribution|most (?:common|frequent)|appear(?:s|ed|ances?)? (?:in|across|on)|report (?:across|on|over|of))\b/i;
const SET_RE = /\b(documents?|docs?|files?|rosters?|lists?|sheets?|spreadsheets?|csvs?|attachments?|drops?|dropped|canvas)\b/i;
function detectSetAnalysisAsk(text) {
  const s = String(text || '');
  return ANALYTIC_RE.test(s) && SET_RE.test(s);
}

// The recent canvas drops, as a set. Recency-bounded (default 14 days) so a months-old drop pile
// doesn't ride every ask; explicit and small. Never throws.
function dropSet(db, { limit = 12, sinceMs = 14 * 864e5, now = Date.now() } = {}) {
  try {
    return db.getDb().prepare(
      "SELECT id, title, LENGTH(body) AS chars, created_ts FROM documents WHERE source = 'canvas_drop' AND created_ts > ? ORDER BY id DESC LIMIT ?"
    ).all(now - sinceMs, Math.max(1, limit | 0));
  } catch { return []; }
}

// The manifest the operator sees. It must carry: the exact ids (reachable), the exact compute API
// (zoe_data.query against sq.documents), and the discipline (script-computed, never guessed from
// memory, never re-requested from Lucas).
function buildBlock(set) {
  if (!Array.isArray(set) || !set.length) return '';
  const lines = set.map((d) => `  - doc ${d.id} "${String(d.title || 'untitled').slice(0, 70)}" (${d.chars} chars)`);
  const ids = set.map((d) => d.id).join(',');
  return [
    `THE DOCUMENT SET YOU HOLD (${set.length} canvas drop(s), durable in your document store — the canvas tabs are just their windows):`,
    ...lines,
    'To COMPUTE across them (counts, frequencies, overlaps, comparisons), use the analyze_data tool with python — counting is a SCRIPT job, never a from-memory estimate:',
    '  import zoe_data',
    `  cols, rows = zoe_data.query('sq', "SELECT id, title, body FROM documents WHERE id IN (${ids})")`,
    '  # parse the bodies, compute, print the finished table',
    'Report discipline (learned from the first live run):',
    '  - FILTER artifacts: CSV header rows ("First Name Last Name"), column labels, and 1-2 letter tokens are NOT people — drop them before counting.',
    '  - STATE the counting method in the report header (once per document vs total row occurrences — default to once per document).',
    '  - A long table gets SAVED IN FULL with the file tool (a notes/… path) — chat carries the top ~20 rows + where the full table lives. The chat pipe clips long tables.',
    'Do NOT ask Lucas to re-share files listed here — you already hold them. Deliver the computed table itself.',
  ].join('\n');
}

module.exports = { ANALYTIC_RE, SET_RE, detectSetAnalysisAsk, dropSet, buildBlock };
