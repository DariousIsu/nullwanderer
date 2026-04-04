/**
 * AURA NX-Alpha — CanvasBlock
 *
 * Spatial wrapper for all canvas content blocks.
 * Handles drag (move), resize, close, z-index, and entrance animation.
 *
 * DIFFERS FROM FloatingPanel:
 *   FloatingPanel = operational tool (monitor, schedule, notes).
 *   CanvasBlock   = content artifact dropped by Aura's team (output surface).
 *   Lighter visual weight — thinner frame, no operational chrome.
 *
 * DRAG:
 *   Drag handle is the thin type-label bar at the top.
 *   Bounds are clamped to the nearest [data-canvas] ancestor.
 *
 * RESIZE:
 *   Bottom-right corner handle. Min dimensions enforced (160×80).
 *
 * CLOSE:
 *   Animates out (animateBlockExit), then calls onClose after onComplete.
 */

import { useRef, useCallback } from 'react';
import { useGSAP } from '@gsap/react';
import { animateMaterialize, animateBlockExit } from '../../core/animations';
import styles from './CanvasBlock.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const MIN_W = 160;
const MIN_H = 80;

// Human-readable type labels for the drag handle
const TYPE_LABELS = {
  // Phase 1
  heading:     'Heading',
  paragraph:   'Text',
  list:        'List',
  table:       'Table',
  chart:       'Chart',
  code:        'Code',
  email:       'Email Draft',
  image:       'Image',
  metric_card: 'Metric',
  callout:     'Callout',
  html:        'Live',
  // Phase 2
  scene_3d:    '3D Scene',
  video:       'Video',
  // Phase 9
  browser_snapshot: 'Browser',
};

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS BLOCK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string}   id       — Unique block identifier
 * @param {string}   type     — Block content type (heading, chart, etc.)
 * @param {number}   x        — Left position on canvas (px)
 * @param {number}   y        — Top position on canvas (px)
 * @param {number}   w        — Block width (px)
 * @param {number}   h        — Block height (px)
 * @param {number}   zIndex   — Stack order
 * @param {function} onFocus  — Called on mousedown — bring to front
 * @param {function} onClose  — Called after exit animation completes
 * @param {function} onMove   — (id, x, y) => void — position update
 * @param {function} onResize — (id, w, h) => void — size update
 * @param {ReactNode} children — The block content component
 */
const CanvasBlock = ({
  id,
  type     = 'paragraph',
  x        = 80,
  y        = 80,
  w        = 400,
  h        = 200,
  zIndex   = 10,
  onFocus,
  onClose,
  onMove,
  onResize,
  children,
}) => {
  const rootRef    = useRef(null);
  const contentRef = useRef(null);  // passed to animateMaterialize for phased content reveal
  const closingRef = useRef(false);
  const dragRef    = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 });
  const resizeRef  = useRef({ active: false, startX: 0, startY: 0, origW: 0, origH: 0 });

  // ── PROGRAMMABLE MATTER ENTRANCE ──
  // Runs once after React has positioned and sized the block in the DOM.
  // Three phases: blueprint border → voxel fill → surface lock + content reveal.
  useGSAP(() => {
    if (rootRef.current && contentRef.current) {
      animateMaterialize(rootRef.current, contentRef.current);
    }
  }, { scope: rootRef });

  // ── DRAG ──
  const handleDragMove = useCallback((e) => {
    if (!dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    // Clamp to canvas bounds
    const canvas = rootRef.current?.closest('[data-canvas]');
    let newX = dragRef.current.origX + dx;
    let newY = dragRef.current.origY + dy;
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      newX = Math.max(0, Math.min(rect.width  - w, newX));
      newY = Math.max(0, Math.min(rect.height - h, newY));
    }
    onMove?.(id, newX, newY);
  }, [id, w, h, onMove]);

  const handleDragEnd = useCallback(() => {
    dragRef.current.active = false;
    window.removeEventListener('mousemove', handleDragMove);
    window.removeEventListener('mouseup',  handleDragEnd);
  }, [handleDragMove]);

  const handleDragStart = useCallback((e) => {
    e.preventDefault();
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, origX: x, origY: y };
    window.addEventListener('mousemove', handleDragMove);
    window.addEventListener('mouseup',  handleDragEnd);
    onFocus?.();
  }, [x, y, handleDragMove, handleDragEnd, onFocus]);

  // ── RESIZE ──
  const handleResizeMove = useCallback((e) => {
    if (!resizeRef.current.active) return;
    const dw = e.clientX - resizeRef.current.startX;
    const dh = e.clientY - resizeRef.current.startY;
    onResize?.(id, Math.max(MIN_W, resizeRef.current.origW + dw), Math.max(MIN_H, resizeRef.current.origH + dh));
  }, [id, onResize]);

  const handleResizeEnd = useCallback(() => {
    resizeRef.current.active = false;
    window.removeEventListener('mousemove', handleResizeMove);
    window.removeEventListener('mouseup',  handleResizeEnd);
  }, [handleResizeMove]);

  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { active: true, startX: e.clientX, startY: e.clientY, origW: w, origH: h };
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup',  handleResizeEnd);
  }, [w, h, handleResizeMove, handleResizeEnd]);

  // ── CLOSE (with programmable matter dissolution) ──
  const handleClose = useCallback((e) => {
    e.stopPropagation();
    if (closingRef.current || !rootRef.current) return;
    closingRef.current = true;
    animateBlockExit(rootRef.current, contentRef.current, () => {
      closingRef.current = false;
      onClose?.(id);
    });
  }, [id, onClose]);

  return (
    <div
      ref={rootRef}
      className={styles.block}
      data-block-type={type}
      style={{ left: x, top: y, width: w, height: h, zIndex }}
      onMouseDown={onFocus}
    >
      {/* Drag handle — thin type label bar */}
      <div
        className={styles.handle}
        onMouseDown={handleDragStart}
      >
        <span className={styles.typeLabel}>{TYPE_LABELS[type] ?? type}</span>
        <button
          className={styles.closeBtn}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={handleClose}
          aria-label="Close block"
          title="Remove from canvas"
        >
          ×
        </button>
      </div>

      {/* Content area — ref passed to animateMaterialize for phased reveal */}
      <div ref={contentRef} className={styles.content}>
        {children}
      </div>

      {/* Resize handle — bottom-right corner */}
      <div
        className={styles.resizeHandle}
        onMouseDown={handleResizeStart}
        title="Drag to resize"
        aria-hidden="true"
      />
    </div>
  );
};

export default CanvasBlock;
