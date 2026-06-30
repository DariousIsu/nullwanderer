/* studio/canvas_layout.js — Zoe Canvas freeform board: PURE layout math (no I/O, no DOM).
 *
 * The engine's canvas is an ordered block STREAM with no coordinates. The freeform board is a
 * Side-Quest-owned spatial layer: a block the operator has positioned uses that saved (x,y); a block
 * that has none yet ("she just placed it on arrival") gets a deterministic auto-slot so it lands in
 * open space instead of (0,0). The renderer draws cards at these coords; dragging persists a new
 * saved position (lib/canvas_layout.js). This module is the placement decision only — pure + tested.
 */
'use strict';

// Document-sized slots (each object on the canvas is a whole document/page, not a single block).
const DEFAULTS = { cardW: 460, cardH: 360, gapX: 44, gapY: 40, perCol: 3, originX: 48, originY: 48 };

const clampN = (v) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : 0; };

// Decide a board coordinate for each block id, in stream order. saved = { blockId: {x,y} }.
// Returns [{ blockId, x, y, source: 'saved'|'auto' }] in the same order as blockIds.
function autoPlace(blockIds, saved, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  const sav = saved || {};
  const out = [];
  let autoIdx = 0;
  for (const id of (Array.isArray(blockIds) ? blockIds : [])) {
    const s = sav[id];
    if (s && Number.isFinite(Number(s.x)) && Number.isFinite(Number(s.y))) {
      out.push({ blockId: id, x: clampN(s.x), y: clampN(s.y), source: 'saved' });
    } else {
      const col = Math.floor(autoIdx / o.perCol);
      const row = autoIdx % o.perCol;
      out.push({
        blockId: id,
        x: o.originX + col * (o.cardW + o.gapX),
        y: o.originY + row * (o.cardH + o.gapY),
        source: 'auto',
      });
      autoIdx += 1;
    }
  }
  return out;
}

// Size the scrollable board so every card (incl. dragged-out-far ones) fits, plus a margin.
function boardExtent(placed, opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  let maxX = 0, maxY = 0;
  for (const p of (Array.isArray(placed) ? placed : [])) {
    maxX = Math.max(maxX, (Number(p.x) || 0) + o.cardW);
    maxY = Math.max(maxY, (Number(p.y) || 0) + o.cardH);
  }
  return { width: maxX + o.originX, height: maxY + o.originY };
}

module.exports = { DEFAULTS, clampN, autoPlace, boardExtent };
