/**
 * lib/canvas_awareness.js — "what's on my canvas?" grounding (2026-07-25).
 *
 * When Lucas drags documents onto the canvas they LAND (source 'canvas_drop'), get an `understanding`
 * gloss, a monologue note, and are decomposed into objects (main.js canvas-ingest). But chat grounding
 * reads the knowledge/object stores by SEMANTIC relevance, and "what did I just drop on your canvas?" or
 * "did you process those papers?" doesn't semantically match any one paper's body — so she was blind to
 * the very documents sitting in front of her. This closes that loop: on a canvas/recent-drop question,
 * surface the recent drops by RECENCY (title + their understanding gloss) so she can say what they are.
 *
 * Pure detector + a deps-injectable block builder (db.recentDocuments) → offline-smoke-testable.
 */
'use strict';

// A question about the canvas or about documents Lucas recently handed her. Kept reasonably specific so an
// ordinary turn doesn't trip it — it must mention the canvas, or a drop/give/share verb paired with a
// document noun, or "what's on …".
const CANVAS_Q_RE = new RegExp([
  '\\bon (?:your|my|the) canvas\\b',
  '\\bwhat\'?s on (?:your|my|the) canvas\\b',
  '\\b(?:to|onto|into) (?:your|the) canvas\\b',
  '\\bwhat did i (?:just )?(?:drop|give|hand|share|send|put|add)\\b',
  '\\b(?:drop(?:ped)?|gave|handed|shared|sent|put|added|uploaded)\\b[^?.!]{0,32}\\b(?:canvas|docs?|documents?|papers?|files?|pdfs?)\\b',
  '\\b(?:docs?|documents?|papers?|files?|pdfs?)\\b[^?.!]{0,24}\\bi (?:just )?(?:dropped|gave|handed|shared|sent|put|uploaded)\\b',
  '\\bthe (?:papers?|docs?|documents?|files?|pdfs?) i (?:just )?(?:dropped|gave|handed|shared|sent|put|uploaded)\\b',
  '\\bdid you (?:process|read|see|get|look at)\\b[^?.!]{0,32}\\b(?:canvas|docs?|documents?|papers?|files?|dropped|gave)\\b',
].join('|'), 'i');

function recognize(userMessage) {
  return CANVAS_Q_RE.test(String(userMessage || ''));
}

// Build the grounding block from recent canvas drops. deps.recentDocuments(n) → doc rows (default lib/db).
// Returns null when there's nothing to surface. Never throws.
function buildBlock({ deps = {}, limit = 8, userName = 'Lucas' } = {}) {
  const recent = deps.recentDocuments || ((n) => { try { return require('./db').recentDocuments(n); } catch { return []; } });
  let rows = [];
  try { rows = recent(60) || []; } catch { return null; }
  const drops = rows.filter((d) => d && d.source === 'canvas_drop').slice(0, Math.max(1, limit | 0));
  if (!drops.length) return null;
  const lines = drops.map((d) => {
    const title = String(d.title || 'untitled').replace(/\s+/g, ' ').trim().slice(0, 80);
    const gloss = String(d.understanding || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    return gloss ? `  • "${title}" — ${gloss}` : `  • "${title}"`;
  });
  return `ON YOUR CANVAS — documents ${userName} recently dropped for you (you have already read and`
    + ` decomposed these into your memory; speak about them directly, do not say you don't have them):\n`
    + lines.join('\n');
}

module.exports = { recognize, buildBlock, CANVAS_Q_RE };
