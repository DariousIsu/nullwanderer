/* studio/creator_stats.js — deterministic document statistics (Creator clinical panel, Slice 2).
 *
 * The FIRST analyzer in the Creator's background scan pipeline. Pure + model-free: given the block
 * model, return counts the panel displays live as you write (word/sentence/paragraph counts +
 * reading time). Later analyzers (spelling/grammar, DB source-flagging, fact-check) join the same
 * pipeline; this one proves the plumbing with zero model cost.
 *
 * Prose metrics (words/chars/sentences/reading-time) count ONLY prose blocks (heading / paragraph
 * / list_item). Code and table blocks are tallied separately and excluded from prose counts so a
 * code listing doesn't inflate the word count or reading time.
 */
'use strict';

const PROSE = new Set(['heading', 'paragraph', 'list_item']);
const WPM = 200;  // standard silent-reading pace for the reading-time estimate

function computeStats(blocks) {
  const arr = Array.isArray(blocks) ? blocks : [];
  let words = 0, chars = 0, sentences = 0, paragraphs = 0, headings = 0, listItems = 0, codeBlocks = 0;
  for (const b of arr) {
    const type = b && b.type;
    const text = String((b && b.text) || '').trim();
    if (type === 'heading') headings++;
    else if (type === 'list_item') listItems++;
    else if (type === 'paragraph' && text) paragraphs++;
    if (type === 'code' || type === 'table') { codeBlocks++; continue; }  // not prose
    if (PROSE.has(type) && text) {
      words += text.split(/\s+/).filter(Boolean).length;
      chars += text.length;
      sentences += text.split(/[.!?]+(?=\s|$)/).map(s => s.trim()).filter(Boolean).length;
    }
  }
  const readingMin = words ? Math.max(1, Math.round(words / WPM)) : 0;
  return { words, chars, sentences, paragraphs, headings, listItems, codeBlocks, readingMin };
}

module.exports = { computeStats };
