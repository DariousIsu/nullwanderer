/**
 * doc_store — the SHORT-TERM document landing store (Slice 1 of the short-term↔long-term memory split).
 *
 * Whole new material (a doc Lucas drops on the canvas, a finished deliverable, meeting notes) lands here
 * the moment it arrives — DURABLY in the Side Quest Zoe DB (lib/db `documents` table), full body — so it
 * survives an engine/app restart (the engine's canvas is in-memory and does NOT) and is recallable the
 * same day, before the nightly pass promotes it into Echo long-term. doc-QA reads candidates from here
 * instead of the volatile canvas, which is what makes "answer from the doc you handed me" reboot-proof.
 *
 * Thin DB wrapper + a PURE shaper (toCandidates) so the doc-QA candidate path is offline-testable. The
 * raw table CRUD lives in lib/db. Fail-safe: every function tolerates a missing DB / bad input.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// Land a new document durably. Idempotent on `ref` (the canvas tab_key): if the SAME ref+body is already
// stored, skip (the ingest poller can re-see a tab). Returns { id, landed } — landed=false when skipped.
function land({ title = null, body = '', source = null, ref = null, understanding = null, deps = {} } = {}) {
  const db = deps.db || require('./db');
  if (!str(body).trim()) return { id: null, landed: false };
  try {
    if (ref) {
      const existing = db.getDocumentByRef(ref);
      if (existing && str(existing.body) === str(body)) return { id: existing.id, landed: false };
    }
    const r = db.insertDocument({ title, body, source, ref, understanding });
    return { id: r ? r.id : null, landed: !!r };
  } catch (e) { console.error('[doc_store] land failed:', e.message); return { id: null, landed: false }; }
}

// PURE: shape document rows into the {title, markdown, openedAt} candidates doc_qa.pickRelevantDoc expects.
function toCandidates(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(r => r && str(r.body).trim())
    .map(r => ({ id: r.id, title: str(r.title), markdown: str(r.body), openedAt: Number(r.created_ts) || 0, source: str(r.source) }));
}

// Recent landed documents as doc-QA candidates (newest first).
function candidates(n = 20, { deps = {} } = {}) {
  const db = deps.db || require('./db');
  try { return toCandidates(db.recentDocuments(n)); } catch (e) { console.error('[doc_store] candidates failed:', e.message); return []; }
}

// Keyword recall over the landed documents (title+body), as candidates.
function recall(query, n = 10, { deps = {} } = {}) {
  const db = deps.db || require('./db');
  try { return toCandidates(db.searchDocuments(query, n)); } catch (e) { console.error('[doc_store] recall failed:', e.message); return []; }
}

module.exports = { land, toCandidates, candidates, recall };
