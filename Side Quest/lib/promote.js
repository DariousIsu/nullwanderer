/**
 * promote — the PURE brain of the NIGHTLY PROMOTION pass (Slice 2 of the short-term↔long-term split).
 *
 * The nightly pass takes un-promoted short-term documents (lib/doc_store, the `documents` table) and
 * consolidates them into Echo LONG-TERM. Lucas's locked model: a new document is processed WHOLE into the
 * store (Echo vault document via ingest_file) + its entities extracted into the KG (extract_entities_from_doc);
 * an update goes in as a new ITERATION of the original (parent_id/version, never an in-place overwrite);
 * facts ride the same iteration rail. This module is the pure half — the worthiness gate, the per-type
 * recipe, the temp-file naming, and parsing Echo's result. The echoSuit calls + DB writes live in main.js
 * (promoteDocumentsPass). Fail-safe: never throws on bad input.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

const PROMOTABLE_MIN_CHARS = 40;   // below this a "document" is too thin to be worth a vault record

// Worthiness gate — promote a real, un-promoted document; thin/empty ones are skipped (marked, not retried).
function shouldPromote(doc) {
  return !!doc && !doc.promoted && str(doc.body).trim().length >= PROMOTABLE_MIN_CHARS;
}

// Per-type recipe → how this document lands in Echo long-term. Locked recipe (all current material): a
// vault DOCUMENT + KG ENTITY extraction. `projectName` defaults to '_Inbox' — ingest_file auto-scaffolds
// it and never errors on a missing project (save_document would); per-project filing is a later refinement.
function recipeFor(doc) {
  const source = str(doc && doc.source).toLowerCase();
  if (source === 'research' || source === 'deliverable') return { kind: 'deliverable', projectName: '_Inbox', extractEntities: true };
  // Conversation objects (lib/conversation_objects) go through Echo's purpose-built save_conversation —
  // they file under Vault/Archive/conversations/ with metadata, not as _Inbox documents.
  if (source === 'conversation') return { kind: 'conversation', projectName: '_Inbox', extractEntities: true };
  return { kind: 'document', projectName: '_Inbox', extractEntities: true };   // canvas_drop / notes / default
}

// A filesystem-safe basename for the temp file ingest_file reads.
function slugForDoc(doc) {
  const id = (doc && doc.id) || 'x';
  const base = str(doc && doc.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return base || `document-${id}`;
}
function tempFileName(doc) { return `${slugForDoc(doc)}.md`; }

// Parse the Echo doc_id out of an ingest_file / save_document result (JSON text or object).
function parseEchoDocId(result) {
  if (result && typeof result === 'object' && result.doc_id != null) return Number(result.doc_id) || null;
  const s = str(result);
  const m = s.match(/"doc_id"\s*:\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  try { const o = JSON.parse(s); if (o && o.doc_id != null) return Number(o.doc_id) || null; } catch {}
  return null;
}

// A first-person beat line for the curation perception note (or '' when nothing moved).
function promotionBeat({ promoted = 0, failed = 0 } = {}) {
  if (!promoted) return '';
  return `filed ${promoted} new document${promoted === 1 ? '' : 's'} into long-term storage${failed ? ` (${failed} couldn't be filed)` : ''}`;
}

module.exports = {
  PROMOTABLE_MIN_CHARS, shouldPromote, recipeFor, slugForDoc, tempFileName, parseEchoDocId, promotionBeat,
};
