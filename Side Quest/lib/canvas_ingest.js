/**
 * canvas_ingest — detect a DOCUMENT Lucas DROPS onto Zoe's Canvas and turn it into something she has
 * actually READ (the reverse of canvas_emit, which is her writing TO the canvas).
 *
 * The gap this fills: drag-dropping a file onto the canvas creates a display block in the engine, but
 * nothing made Zoe ingest it — she kept musing, blind to the document. This module is the PURE brain of
 * the drop→ingest poller: recognize a dropped tab (the engine prefixes drag-drop tabs with "drop-",
 * distinct from her own "directed-<id>" emits), pull its text out of the canvas blocks, and shape the
 * grounded "what is this" prompt. All I/O — the /canvas fetch, the cloud understanding, the memory +
 * learning writes, the monologue tick — lives in main.js (runCanvasIngest). Fail-safe: never throws.
 */
'use strict';

// The engine's drag-drop tabs are keyed "drop-<slug>-<rand>"; her OWN emitted dossiers are "directed-<id>".
// Prefix-gating on "drop-" ingests exactly the documents Lucas drops, never her own canvas output.
const INGEST_PREFIX = 'drop-';

const str = (v) => (v == null ? '' : String(v));
const tabKeyOf = (tab) => str(tab && (tab.tab_key || tab.key));

// Is this tab a document Lucas dropped (vs Zoe's own emitted output)?
function isIngestableTab(tab) {
  const k = tabKeyOf(tab);
  return !!k && k.indexOf(INGEST_PREFIX) === 0;
}

// New dropped documents not yet ingested. `seenKeys` is the persisted ingested-tab set. Returns the
// lightweight descriptors {tabKey, title, openedAt}; the caller pulls each tab's blocks for the body.
function newDropTabs(snapshot, seenKeys = []) {
  const tabs = (snapshot && Array.isArray(snapshot.tabs)) ? snapshot.tabs : [];
  const seen = new Set((Array.isArray(seenKeys) ? seenKeys : []).map(str));
  const out = [];
  for (const t of tabs) {
    if (!isIngestableTab(t)) continue;
    const key = tabKeyOf(t);
    if (seen.has(key)) continue;
    out.push({ tabKey: key, title: str(t.title), openedAt: t.opened_at || t.openedAt || 0 });
  }
  return out;
}

// Pull readable text out of one canvas block (markdown/text/code/plain content), best-effort.
function blockText(block) {
  if (!block) return '';
  const d = block.data || block;
  return str(d.markdown || d.text || d.code || d.content || (typeof block.content === 'string' ? block.content : '')).trim();
}

// Concatenate a tab's blocks into one document string (in order, blank-line separated).
function extractMarkdown(blocks) {
  return (Array.isArray(blocks) ? blocks : [])
    .map(blockText)
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// A clean human label from a noisy block/tab title ("**📝 Notes**" → "Notes").
function cleanTitle(title) {
  let s = str(title).replace(/[*_`#]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '').replace(/\s+/g, ' ').trim();
  return s || 'Untitled document';
}

// The grounded "understand this document" prompt — a SHORT note on what it is + the key people/entities/
// dates/actions in it, so the stored reading is useful for recall. Strictly grounded (never invent).
function buildUnderstandingPrompt({ title = '', markdown = '' } = {}) {
  return [
    { role: 'system', content: `You read a document Lucas just dropped onto the canvas and write a SHORT grounded note on it for Zoe's memory. Ground ONLY in the document — never invent. Cover, in 3-6 sentences: what the document is, the key people/organizations/dates named, and any decisions, asks, or action items in it. No preamble, no "here is".` },
    { role: 'user', content: `DOCUMENT TITLE: ${cleanTitle(title)}\n\nDOCUMENT CONTENT:\n"""\n${str(markdown).slice(0, 12000)}\n"""\n\nWrite the grounded note now.` }
  ];
}

// The readable memory content for an ingested drop (the note + a clipped copy of the source).
function ingestNote({ title = '', understanding = '', markdown = '' } = {}) {
  const t = cleanTitle(title);
  const u = str(understanding).trim();
  const src = str(markdown).trim().slice(0, 2000);
  return `Document Lucas dropped on my canvas — "${t}":\n${u || src}`.trim();
}

module.exports = {
  INGEST_PREFIX, isIngestableTab, tabKeyOf, newDropTabs,
  blockText, extractMarkdown, cleanTitle, buildUnderstandingPrompt, ingestNote,
};
