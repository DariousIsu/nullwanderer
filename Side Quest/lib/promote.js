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

// THE JUNK NET (continuity cure #3, 2026-09-02): the last nightly pass filed "IIS 8.5 Detailed Error -
// 404.0 - Not Found" into long-term memory as a document. A captured error/challenge page is not memory —
// it is the SHAPE of a failed fetch. Deterministic, conservative: an error-page title, or a short body that
// opens with an error/challenge marker. Anything longer than a real page of text is never junk by this net.
const JUNK_TITLE_RE = /^\s*(?:IIS \d|HTTP Error \d{3}|Error \d{3}\b|\d{3} - |4\d\d\b|Access Denied|Page Not Found|Not Found|Just a moment|Attention Required|Forbidden|Service Unavailable|Bad Gateway|Request Rejected)/i;
const JUNK_BODY_RE = /^\s*(?:#[^\n]*\n\s*)?(?:HTTP Error \d{3}|\d{3}\.\d+ - |Not Found|Access Denied|Forbidden|Just a moment\.\.\.|Checking your browser|Enable JavaScript and cookies|The requested URL was not found|Service Unavailable|Bad Gateway|Request Rejected)/i;
const JUNK_MAX_CHARS = 2000;
function looksLikeJunk(doc) {
  const body = str(doc && doc.body);
  if (body.trim().length > JUNK_MAX_CHARS) return false;
  return JUNK_TITLE_RE.test(str(doc && doc.title)) || JUNK_BODY_RE.test(body);
}

// Why a doc is NOT worth a vault record: 'thin' (too short), 'junk' (an error/challenge page), or null.
function skipReason(doc) {
  if (!doc) return 'thin';
  if (str(doc.body).trim().length < PROMOTABLE_MIN_CHARS) return 'thin';
  if (looksLikeJunk(doc)) return 'junk';
  return null;
}

// Worthiness gate — promote a real, un-promoted document; thin/junk ones are skipped (marked, not retried).
function shouldPromote(doc) {
  return !!doc && !doc.promoted && skipReason(doc) === null;
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
  PROMOTABLE_MIN_CHARS, JUNK_MAX_CHARS, shouldPromote, skipReason, looksLikeJunk, recipeFor, slugForDoc, tempFileName, parseEchoDocId, promotionBeat,
};
