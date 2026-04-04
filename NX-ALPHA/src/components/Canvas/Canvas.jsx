/**
 * AURA NX-Alpha — Canvas
 *
 * The primary work surface. Fills all remaining space after the chat sidebar.
 * FloatingPanels, DropPanels, and PeekStack all render as children here.
 *
 * ROLE:
 *   Currently a styled placeholder — the "Work Surface — awaiting build" state.
 *   The canvas will eventually be a universal renderer: text, images, video,
 *   interactive charts, live data streams. Content-type detection strategy
 *   needs to be designed before the renderer is built (see TASKS.md).
 *
 * DATA-CANVAS ATTRIBUTE:
 *   FloatingPanel uses `rootRef.closest('[data-canvas]')` to find bounds during drag.
 *   This attribute MUST be present on the canvas root element.
 *
 * POSITION:
 *   `position: relative; overflow: hidden` — FloatingPanels are `position: absolute`
 *   and clamped to this container's bounds.
 */

import styles from './Canvas.module.css';

/**
 * @param {ReactNode} children    — FloatingPanels, DropPanels, PeekStack, CanvasBlockRenderer
 * @param {string}    className   — Optional additional class
 * @param {boolean}   hasContent  — When true, idle label is hidden (blocks are present)
 */
const Canvas = ({ children, className, hasContent = false, onDragOver, onDrop }) => (
  <div
    className={[styles.canvas, className].filter(Boolean).join(' ')}
    data-canvas           /* Required: FloatingPanel + CanvasBlock drag bounds anchor */
    onDragOver={onDragOver}
    onDrop={onDrop}
  >
    {/* ── IDLE LABEL — visible when canvas has no blocks ── */}
    {!hasContent && (
      <div className={styles.idle} aria-hidden="true">
        <div className={styles.idleRule}>
          <span /><em>CANVAS</em><span />
        </div>
        <p className={styles.idleTitle}>Work Surface</p>
        <p className={styles.idleSub}>Awaiting output</p>
      </div>
    )}

    {/* ── CONTENT — floating panels, drop panels, peek stack, canvas blocks ── */}
    {children}
  </div>
);

export default Canvas;
