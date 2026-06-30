/**
 * lib/known.js — KNOWN → UNKNOWN grounding.
 *
 * Lucas's principle: before we generate/research anything, check what we ALREADY hold — Zoe's memory DB
 * and the Echo databases — and make that intensely-mapped data the FOUNDATION every time, instead of
 * burning tokens re-deriving the same facts. So every research target starts from its known record and
 * spends effort ONLY on the gaps; the deliverable GROWS (known preserved + new filled), never re-starts.
 *
 * This module is PURE prompt assembly (the I/O — querying localdb / Echo / the prior dossier — lives in
 * main.js where the tools are). Fail-safe: empty inputs → '' / a no-op directive.
 */
'use strict';

const _clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

// Assemble the "what we already know" foundation from our own sources.
//   existing — our prior dossier/record on the entity (the biggest known)
//   local    — hits from Zoe's memory DB (notes/knowledge)
//   echo     — hits from the Echo databases (entity graph / knowledge / records)
function buildKnownBlock({ entity = '', existing = '', local = [], echo = [] } = {}, { maxChars = 2400 } = {}) {
  const parts = [];
  if (existing && existing.trim()) parts.push(`OUR EXISTING RECORD on ${entity || 'this'}:\n${_clip(existing, 1300)}`);
  const loc = (Array.isArray(local) ? local : []).map(x => _clip(x, 200)).filter(s => s.length > 3);
  if (loc.length) parts.push(`FROM ZOE'S MEMORY:\n- ${loc.slice(0, 5).join('\n- ')}`);
  const ech = (Array.isArray(echo) ? echo : []).map(x => _clip(x, 240)).filter(s => s.length > 3);
  if (ech.length) parts.push(`FROM OUR ECHO DATABASES:\n- ${ech.slice(0, 5).join('\n- ')}`);
  let block = parts.join('\n\n');
  if (block.length > maxChars) block = block.slice(0, maxChars) + '…';
  return block;
}

// The directive that turns a known block into a GAP-ONLY mandate (known→unknown).
function gapDirective(entity = '', facet = '') {
  return `KNOWN→UNKNOWN: the records above are what WE ALREADY HAVE on ${entity || 'this target'}. Treat them as the FOUNDATION — do NOT re-gather or re-verify what's already there. Spend effort ONLY on what is still MISSING for: ${facet || 'the task'}. If the records already cover something, keep it and add only genuinely new detail.`;
}

function hasKnown(block) { return !!(block && String(block).trim().length > 20); }

// Prepend the known foundation + gap directive to a research prompt body (no-op when nothing is known).
function withKnown(promptBody, { knownBlock = '', entity = '', facet = '' } = {}) {
  if (!hasKnown(knownBlock)) return String(promptBody || '');
  return `WHAT WE ALREADY KNOW (our foundation — build on it, don't redo it):\n${knownBlock}\n\n${gapDirective(entity, facet)}\n\n${String(promptBody || '')}`;
}

module.exports = { buildKnownBlock, gapDirective, hasKnown, withKnown };
