/**
 * AURA NX-Alpha — CanvasBlockRenderer
 *
 * Spatial state manager for canvas content blocks.
 * Renders all active CanvasBlock instances on the canvas work surface.
 *
 * ARCHITECTURE:
 *   - Manages block array internally (position, size, z-index)
 *   - Exposes an imperative API via ref for external control:
 *       ref.current.addBlock(spec)    — place a new block
 *       ref.current.clearBlocks()     — remove all blocks
 *       ref.current.removeBlock(id)   — remove a specific block
 *   - CommandCenter holds the ref; useAuraStream will call addBlock on
 *     render_canvas SSE events. canvas_clear calls clearBlocks.
 *
 * BLOCK PLACEMENT:
 *   - Blocks without explicit (x, y) are auto-placed using a cascade
 *     pattern to avoid exact overlap.
 *   - Each block type has default dimensions (BLOCK_DEFAULTS).
 *
 * SPATIAL MANIPULATION:
 *   - User drags blocks to reposition (updates x, y in state).
 *   - User drags bottom-right corner to resize (updates w, h in state).
 *   - User clicks × to remove a block (exit animation, then state purge).
 *
 * PHASE 2 EXTENSION:
 *   - Adding 3D or video block types requires only:
 *       1. Create the component in blocks/
 *       2. Add it to blocks/index.js BLOCK_MAP
 *     No changes needed here.
 */

import { useState, useRef, useCallback, forwardRef, useImperativeHandle, useEffect } from 'react';
import CanvasBlock     from './CanvasBlock';
import ParticleField   from './ParticleField';
import { BlockContent } from './blocks/index';
// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT DIMENSIONS PER BLOCK TYPE
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_DEFAULTS = {
  // Phase 1
  heading:     { w: 440, h: 90  },
  paragraph:   { w: 440, h: 150 },
  list:        { w: 320, h: 180 },
  table:       { w: 520, h: 250 },
  chart:       { w: 480, h: 310 },
  code:        { w: 480, h: 240 },
  email:       { w: 420, h: 300 },
  image:       { w: 400, h: 280 },
  metric_card: { w: 220, h: 130 },
  callout:     { w: 440, h: 120 },
  html:        { w: 600, h: 430 },
  // Phase 2
  scene_3d:    { w: 480, h: 400 },
  video:       { w: 520, h: 340 },
  // Phase 9
  browser_snapshot: { w: 640, h: 400 },
  // Canvas drop upload placeholder
  file:        { w: 400, h: 100 },
  // Card list
  'card-list': { w: 420, h: 320 },
};

// Auto-placement cascade — offset each new block slightly so they don't overlap
const AUTO_PLACE_BASE = { x: 88, y: 72 };
const AUTO_PLACE_STEP = 28;
const AUTO_PLACE_WRAP = 5; // wrap cascade after this many steps

function getAutoPosition(index) {
  const step = index % AUTO_PLACE_WRAP;
  return {
    x: AUTO_PLACE_BASE.x + step * AUTO_PLACE_STEP,
    y: AUTO_PLACE_BASE.y + step * AUTO_PLACE_STEP,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS BLOCK RENDERER
// ─────────────────────────────────────────────────────────────────────────────

const CanvasBlockRenderer = forwardRef(({ initialBlocks = [], onCountChange }, ref) => {
  const [blocks, setBlocks] = useState(() =>
    initialBlocks.map((spec, i) => ({
      ...spec,
      id: spec.id ?? `block-init-${i}`,
      x:  spec.x  ?? getAutoPosition(i).x,
      y:  spec.y  ?? getAutoPosition(i).y,
      w:  spec.w  ?? BLOCK_DEFAULTS[spec.type]?.w ?? 400,
      h:  spec.h  ?? BLOCK_DEFAULTS[spec.type]?.h ?? 200,
    }))
  );

  const zMaxRef  = useRef(10);
  const countRef = useRef(initialBlocks.length); // tracks total ever added for cascade

  const [blockZ, setBlockZ] = useState(() =>
    Object.fromEntries(
      initialBlocks.map((spec, i) => [spec.id ?? `block-init-${i}`, 10 + i])
    )
  );

  // ── BRING TO FRONT ──
  const bringToFront = useCallback((id) => {
    zMaxRef.current += 1;
    setBlockZ(prev => ({ ...prev, [id]: zMaxRef.current }));
  }, []);

  // ── MOVE ──
  const handleMove = useCallback((id, x, y) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, x, y } : b));
  }, []);

  // ── RESIZE ──
  const handleResize = useCallback((id, w, h) => {
    setBlocks(prev => prev.map(b => b.id === id ? { ...b, w, h } : b));
  }, []);

  // ── CLOSE (called after exit animation completes in CanvasBlock) ──
  const handleClose = useCallback((id) => {
    setBlocks(prev => prev.filter(b => b.id !== id));
    setBlockZ(prev => { const next = { ...prev }; delete next[id]; return next; });
  }, []);

  // ── IMPERATIVE API (exposed via ref for CommandCenter / useAuraStream) ──
  useImperativeHandle(ref, () => ({
    /**
     * Add a new block to the canvas.
     * @param {object} spec — { type, data, id?, x?, y?, w?, h? }
     */
    addBlock: (spec) => {
      const id  = spec.id ?? `block-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const idx = countRef.current++;
      const pos = spec.x != null ? { x: spec.x, y: spec.y } : getAutoPosition(idx);
      const newBlock = {
        ...spec,
        id,
        x:  pos.x,
        y:  pos.y,
        w:  spec.w ?? BLOCK_DEFAULTS[spec.type]?.w ?? 400,
        h:  spec.h ?? BLOCK_DEFAULTS[spec.type]?.h ?? 200,
      };
      zMaxRef.current += 1;
      setBlocks(prev => [...prev, newBlock]);
      setBlockZ(prev => ({ ...prev, [id]: zMaxRef.current }));
      return id;
    },

    /**
     * Remove a specific block immediately (no animation — use when SSE clears it).
     */
    removeBlock: (id) => {
      setBlocks(prev => prev.filter(b => b.id !== id));
      setBlockZ(prev => { const next = { ...prev }; delete next[id]; return next; });
    },

    /**
     * Remove all blocks from the canvas (canvas_clear SSE event).
     */
    clearBlocks: () => {
      setBlocks([]);
      setBlockZ({});
      countRef.current = 0;
    },

    /** Current block count — useful for CommandCenter to toggle idle state */
    get count() { return blocks.length; },

    /** Return current blocks array for export — called by CommandCenter download handler */
    getBlocks: () => blocks,
  }), [blocks]);

  // Notify parent when block count changes so Canvas can hide its idle label
  useEffect(() => {
    onCountChange?.(blocks.length);
  }, [blocks.length, onCountChange]);

  return (
    <>
      {/* Programmable matter idle field — always rendered.
          Dims when blocks are present so matter cedes visual priority
          to the content it has already formed. */}
      <ParticleField dimmed={blocks.length > 0} />

      {blocks.map(block => (
        <CanvasBlock
          key={block.id}
          id={block.id}
          type={block.type}
          x={block.x}
          y={block.y}
          w={block.w}
          h={block.h}
          zIndex={blockZ[block.id] ?? 10}
          onFocus={() => bringToFront(block.id)}
          onClose={handleClose}
          onMove={handleMove}
          onResize={handleResize}
        >
          <BlockContent type={block.type} data={block.data ?? {}} />
        </CanvasBlock>
      ))}
    </>
  );
});

CanvasBlockRenderer.displayName = 'CanvasBlockRenderer';

export default CanvasBlockRenderer;
