/**
 * retention — short-term store TIDYING (Slice 3 of the short-term↔long-term memory split).
 *
 * Once a document has been promoted into Echo long-term (Slice 2), its full body no longer needs to sit in
 * the Side Quest short-term `documents` table — the authoritative cleaned copy lives in Echo. After a
 * retention window, this trims a promoted doc's body down to a POINTER (a marker to its Echo ref + the
 * short understanding), so the short-term store stays a fast working set and doesn't bloat. Material that
 * was skip-marked (thin / never made it to Echo) is dropped outright after the window. PURE decision logic;
 * the DB writes live in main.js (retentionPass). Fail-safe: never throws on bad input.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));
const DAY = 24 * 60 * 60 * 1000;
const RETAIN_WINDOW_MS = 7 * DAY;   // keep the full short-term body this long after promotion, then tidy

// A doc that actually landed in Echo long-term carries an "echo:<id>" promoted_ref.
function isEchoPromoted(doc) { return /^echo:/.test(str(doc && doc.promoted_ref)); }

function ageMs(doc, now) {
  const t = Number(doc && (doc.updated_ts || doc.created_ts)) || now;
  return now - t;
}

// The pointer body a pruned doc keeps — a marker to its Echo record + the short understanding, so recall
// still surfaces it by title/summary and a consumer can fetch the full text from Echo via the ref.
function pointerFor(doc) {
  const ref = str(doc && doc.promoted_ref);
  const u = str(doc && doc.understanding).trim();
  return `[Filed to long-term storage — ${ref}]${u ? `\n${u}` : ''}`;
}

// Retention decision for ONE document: 'keep' | 'prune' | 'delete'.
//  - not promoted, or still within the window → KEEP (live short-term working memory).
//  - echo-promoted, past the window, body still fuller than its pointer → PRUNE (trim to pointer).
//  - skip-marked (thin / no Echo ref), past the window → DELETE (not worth keeping short-term).
function classify(doc, { now = Date.now(), windowMs = RETAIN_WINDOW_MS } = {}) {
  if (!doc || !doc.promoted) return 'keep';
  if (ageMs(doc, now) < windowMs) return 'keep';
  if (isEchoPromoted(doc)) {
    return (str(doc.body).length > pointerFor(doc).length + 8) ? 'prune' : 'keep';   // already trimmed → keep
  }
  return 'delete';
}

// Plan retention over a batch → { prune:[{id, pointer}], delete:[id] }.
function plan(docs, opts = {}) {
  const out = { prune: [], delete: [] };
  for (const d of (Array.isArray(docs) ? docs : [])) {
    const c = classify(d, opts);
    if (c === 'prune') out.prune.push({ id: d.id, pointer: pointerFor(d) });
    else if (c === 'delete') out.delete.push(d.id);
  }
  return out;
}

module.exports = { RETAIN_WINDOW_MS, isEchoPromoted, ageMs, pointerFor, classify, plan };
