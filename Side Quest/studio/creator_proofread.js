/* studio/creator_proofread.js — the Creator's proofreading leaf (spelling / grammar / style).
 *
 * The FIRST model-caged analyzer in the clinical scan pipeline. Pure + testable: this module only
 * BUILDS the prompt and PARSES the response — the model call (local 24B, via lib/ollama complete)
 * is wired in main. The model is caged as a component: it returns a structured list of candidate
 * corrections; the deterministic pathway validates them and the OPERATOR accepts/rejects. The
 * model never edits the document.
 *
 * HALLUCINATION GUARD (determinism-critical): a correction is kept ONLY if its `original` span is
 * a verbatim substring of the referenced block's text and actually differs from the suggestion.
 * Anything the model invents (a span not present in the text) is dropped — the editor never shows
 * a correction it can't anchor to real text.
 */
'use strict';

const TYPES = new Set(['spelling', 'grammar', 'style']);
const PROSE = new Set(['heading', 'paragraph', 'list_item']);
const MAX_CORRECTIONS = 60;

// Prose blocks only, each tagged with its anchor so the model can reference exact spans.
function proseBlocks(blocks) {
  return (Array.isArray(blocks) ? blocks : []).filter(b => b && PROSE.has(b.type) && String(b.text || '').trim());
}

function buildMessages(blocks) {
  const prose = proseBlocks(blocks);
  const listing = prose.map(b => `[${b.anchor}] ${b.text}`).join('\n');
  const system = [
    'You are a precise proofreading engine for a document editor. Find SPELLING, GRAMMAR, and STYLE',
    'errors in the supplied text blocks. Be conservative: flag only genuine errors, not stylistic',
    'preferences you are unsure about.',
    '',
    'Return ONLY a JSON array (no prose, no code fence). Each element:',
    '  {"anchor":"<block anchor>","type":"spelling|grammar|style","original":"<exact span copied',
    '   verbatim from that block>","suggestion":"<the corrected span>","message":"<short why>"}',
    '',
    'Rules:',
    '- "original" MUST be copied character-for-character from the block text — a MINIMAL span, not',
    '  the whole sentence. Never invent or paraphrase it.',
    '- "suggestion" must differ from "original".',
    '- If a block has no errors, omit it. If the whole document is clean, return [].',
  ].join('\n');
  const user = `Proofread these blocks:\n\n${listing}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Pull the first JSON array out of a model response (tolerates stray prose / code fences).
function extractArray(text) {
  const s = String(text || '');
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try { const v = JSON.parse(s.slice(start, end + 1)); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

// Validate + de-hallucinate model output against the real block text. byAnchor: {anchor: text}.
function parseCorrections(modelText, byAnchor) {
  const raw = extractArray(modelText);
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const anchor = String(item.anchor || '');
    const blockText = byAnchor[anchor];
    if (typeof blockText !== 'string') continue;                 // unknown anchor → drop
    const original = String(item.original == null ? '' : item.original);
    const suggestion = String(item.suggestion == null ? '' : item.suggestion);
    if (!original || original === suggestion) continue;          // empty / no-op → drop
    if (!blockText.includes(original)) continue;                 // HALLUCINATION GUARD: span not in text
    const type = TYPES.has(item.type) ? item.type : 'grammar';
    const key = `${anchor}|${original}|${suggestion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `${anchor}:${out.length}`,
      anchor, type, original, suggestion,
      message: String(item.message || '').slice(0, 160),
    });
    if (out.length >= MAX_CORRECTIONS) break;
  }
  return out;
}

// Convenience: { anchor: text } map for the prose blocks (used by main + parse).
function anchorTextMap(blocks) {
  const m = {};
  for (const b of proseBlocks(blocks)) m[b.anchor] = b.text;
  return m;
}

module.exports = { buildMessages, parseCorrections, anchorTextMap, proseBlocks, extractArray, MAX_CORRECTIONS };
