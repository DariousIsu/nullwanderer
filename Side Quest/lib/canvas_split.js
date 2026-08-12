'use strict';
/**
 * lib/canvas_split.js — split ONE research canvas doc into TWO documents, one per named subject.
 *
 * "Split this into two separate documents, one for Yvonne and one for Applied Digital" was detected as
 * intent=canvas_create but had NO handler — so she acked it ("split and building") and did nothing (a
 * confabulated action). This is the honest MOVE: parse the two target subjects, partition the source
 * doc's section blocks between them, and emit two new canvas-doc specs the caller materializes.
 *
 * PURE + dependency-injected: the section→bucket ASSIGNMENT is passed in (an LLM classifier live, a
 * deterministic stub in the smoke), so the parse + partition logic is fully offline-testable. No I/O.
 */

const str = (v) => (v == null ? '' : String(v));
function slug(s) {
  const x = str(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return x.slice(0, 40) || 'doc';
}

// A subject label cleaned of the "document/doc/file/one" scaffolding + stray punctuation.
function cleanLabel(s) {
  return str(s)
    .replace(/\b(?:a\s+|its?\s+own\s+)?(?:separate\s+|new\s+)?(?:documents?|docs?|files?|pages?)\b/ig, ' ')
    .replace(/^\s*(?:one|1)\s+/i, '')
    .replace(/[^\w\s&.'’/-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

// Detect a "split X into two docs, one for A and one for B" instruction. Conservative: needs a SPLIT
// verb AND a resolvable pair of labels. Typo-tolerant on the common "on for"/"one for" slip. Returns
// { isSplit, labels:[A,B] } — labels never equal, never empty.
const _SPLIT_VERB_RE = /\bsplit\b|\bseparate\s+(?:this|it|them|the\s+\w+)?\s*(?:out\s+)?into\b|\bbreak\s+(?:this|it|them)\s+(?:up\s+|out\s+)?into\b|\bdivide\b|\binto\s+two\s+(?:separate\s+)?(?:documents?|docs?|files?)\b/i;
function parseSplitInstruction(instruction) {
  const t = str(instruction).replace(/\s+/g, ' ').trim();
  if (!t || !_SPLIT_VERB_RE.test(t)) return { isSplit: false, labels: [] };
  let m =
    // "one for A and one for B" | "one for A, and one for B" | typo "on for B"
    t.match(/\b(?:one|1)\s+for\s+(.+?)[,;]?\s+and\s+(?:one|on|1)\s+for\s+(.+?)[.!?]*$/i) ||
    // "one for A, one for B"
    t.match(/\b(?:one|1)\s+for\s+(.+?)[,;]\s+(?:one|on|1)\s+for\s+(.+?)[.!?]*$/i) ||
    // "into (two docs for) A and B"
    t.match(/\binto\s+(?:two\s+(?:separate\s+)?(?:documents?|docs?|files?)\s+)?(?:for\s+|about\s+)?(.+?)\s+and\s+(.+?)[.!?]*$/i);
  if (!m) return { isSplit: false, labels: [] };
  const a = cleanLabel(m[1]);
  const b = cleanLabel(m[2]);
  if (!a || !b || a.length < 2 || b.length < 2 || a.toLowerCase() === b.toLowerCase()) return { isSplit: false, labels: [] };
  return { isSplit: true, labels: [a, b] };
}

// Partition source blocks into the two labeled docs. `assign(block, labels) -> 0|1` picks the bucket for
// each block (an LLM classifier live; deterministic in the smoke). A block that throws / returns junk
// defaults to bucket 0 (never dropped — a split must be LOSSLESS: every source section lands somewhere).
// Returns [{ label, tabKey, title, blocks[] }, {…}] — tabKey namespaced under the source focus so re-runs
// are idempotent and the split docs sit beside their parent.
function planSplit({ sourceFocusId, sourceBlocks = [], labels = [], assign } = {}) {
  if (!Array.isArray(labels) || labels.length !== 2) return [];
  const docs = labels.map((label) => ({ label, tabKey: `directed-${slug(sourceFocusId)}-${slug(label)}`, title: label, blocks: [] }));
  for (const b of (Array.isArray(sourceBlocks) ? sourceBlocks : [])) {
    let idx = 0;
    try { idx = assign && assign(b, labels) === 1 ? 1 : 0; } catch { idx = 0; }
    docs[idx].blocks.push(b);
  }
  return docs;
}

module.exports = { parseSplitInstruction, planSplit, slug, cleanLabel };
