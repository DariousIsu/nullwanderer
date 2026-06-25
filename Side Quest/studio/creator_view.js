/* studio/creator_view.js — pure block-model ⇄ ProseMirror mappers for the Creator surface.
 *
 * Runs in MAIN (the renderer stays a thin Tiptap host). The Creator's editable working copy is
 * the SAME light block model the rest of the suite uses (lib/editor_import: heading / paragraph /
 * list_item / code / table, each with a stable anchor + content hash). Tiptap/ProseMirror speaks
 * its own JSON doc shape, so this module is the deterministic bridge:
 *
 *   blocksToDoc(blocks)  →  ProseMirror doc JSON   (load: stored model → editor)
 *   docToBlocks(doc)     →  block-model array      (save: editor → stored model)
 *
 * LOSSLESS-BY-CONSTRUCTION round-trip: each block keeps its plain `text` (the canonical field the
 * verify harness / stats / hashing read) AND an optional `inline` array holding the ProseMirror
 * inline content verbatim. We never re-serialize prose to markdown and re-parse it (the classic
 * source of round-trip drift) — inline content is carried through untouched. `text` is derived
 * from it for the deterministic side (hash, checks, word counts).
 *
 * The editor is configured (renderer side) to ONLY the nodes this model supports, so docToBlocks
 * sees a closed set. Unknown nodes degrade to a plain paragraph rather than throwing.
 *
 * Slice-1 scope note: markdown TABLES are preserved verbatim (round-tripped through a code node
 * tagged language='__table__'); structured table EDITING is a later slice.
 */
'use strict';
const { anchorFor, blockHash } = require('../lib/editor_import');

// ---- helpers -------------------------------------------------------------

// Plain text of a ProseMirror node subtree (text nodes joined; hard breaks → newline).
function nodeText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  return (node.content || []).map(nodeText).join('');
}
// A plain inline run from a string (used when a block has no carried inline content).
function textNode(t) { return t ? [{ type: 'text', text: t }] : []; }
// Prefer the carried verbatim inline content; fall back to a plain text run.
function inlineOf(b) { return (b.inline && b.inline.length) ? b.inline : textNode(b.text); }

// ---- blocks → ProseMirror doc (load) -------------------------------------

function blockToNode(b) {
  if (b.type === 'heading') {
    return { type: 'heading', attrs: { level: Math.min(6, Math.max(1, b.level || 1)) }, content: inlineOf(b) };
  }
  if (b.type === 'code') {
    return { type: 'codeBlock', attrs: { language: b.lang || null }, content: textNode(b.text) };
  }
  if (b.type === 'table') {
    // Slice 1: round-trip a markdown table verbatim as a tagged code node (real table editing later).
    return { type: 'codeBlock', attrs: { language: '__table__' }, content: textNode(b.text) };
  }
  return { type: 'paragraph', content: inlineOf(b) };  // default
}
function listItemNode(b) {
  return { type: 'listItem', content: [{ type: 'paragraph', content: inlineOf(b) }] };
}
// Group consecutive list_item blocks of the same kind (ordered vs bullet) into one list node.
function blocksToDoc(blocks) {
  const arr = Array.isArray(blocks) ? blocks : [];
  const content = [];
  let i = 0;
  while (i < arr.length) {
    const b = arr[i];
    if (b && b.type === 'list_item') {
      const ordered = /\d/.test(b.marker || '');
      const items = [];
      while (i < arr.length && arr[i].type === 'list_item' && (/\d/.test(arr[i].marker || '') === ordered)) {
        items.push(listItemNode(arr[i])); i++;
      }
      content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }
    content.push(blockToNode(b)); i++;
  }
  if (!content.length) content.push({ type: 'paragraph', content: [] });  // ProseMirror needs ≥1 block
  return { type: 'doc', content };
}

// ---- ProseMirror doc → blocks (save) -------------------------------------

// One PM node → zero-or-more RAW blocks (anchors/hashes applied afterward in docToBlocks).
function nodeToBlocks(node) {
  if (!node) return [];
  switch (node.type) {
    case 'heading':
      return [{ type: 'heading', level: (node.attrs && node.attrs.level) || 1, text: nodeText(node), inline: node.content || [] }];
    case 'codeBlock': {
      const lang = node.attrs && node.attrs.language;
      if (lang === '__table__') return [{ type: 'table', text: nodeText(node) }];
      return [{ type: 'code', lang: lang || null, text: nodeText(node) }];
    }
    case 'bulletList':
    case 'orderedList': {
      const marker = node.type === 'orderedList' ? '1.' : '-';
      const out = [];
      for (const li of (node.content || [])) {
        const para = (li.content || []).find(c => c.type === 'paragraph') || {};
        out.push({ type: 'list_item', marker, text: nodeText(li), inline: para.content || [] });
      }
      return out;
    }
    case 'paragraph':
      return [{ type: 'paragraph', text: nodeText(node), inline: node.content || [] }];
    default: {
      // blockquote / horizontalRule / anything unexpected: keep the text, drop the structure.
      const t = nodeText(node);
      return t ? [{ type: 'paragraph', text: t, inline: node.content || [] }] : [];
    }
  }
}
function docToBlocks(doc) {
  const raw = [];
  for (const node of ((doc && doc.content) || [])) raw.push(...nodeToBlocks(node));
  return raw.map((b, i) => ({ anchor: anchorFor(i), hash: blockHash(b.text || ''), ...b }));
}

// Build a fresh empty working copy (a single empty paragraph) for a brand-new native document.
function emptyWorkingCopy(title) {
  return {
    title: title || 'Untitled',
    format: 'native',
    blocks: [{ anchor: anchorFor(0), hash: blockHash(''), type: 'paragraph', text: '', inline: [] }],
    blockCount: 1,
    normalizedAt: Date.now(),
  };
}

module.exports = {
  blocksToDoc, docToBlocks, emptyWorkingCopy,
  // exported for tests
  nodeText, nodeToBlocks, blockToNode,
};
