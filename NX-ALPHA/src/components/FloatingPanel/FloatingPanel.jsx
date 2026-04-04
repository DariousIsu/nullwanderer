/**
 * AURA NX-Alpha — FloatingPanel
 *
 * Draggable, minimizable panel chassis for the canvas layer.
 * Used for: AgentMonitor, SystemStatus, Schedule, QuickNotes,
 *           and Chat when popped out to canvas.
 *
 * VARIANTS:
 *   'command' — heavy chassis. Amber L-bracket corners, segmented border edges.
 *               Full holographic glass interior. Use for: AgentMonitor, SystemStatus.
 *   'work'    — continuous border, rangefinder corners. Lighter.
 *               Use for: Schedule, QuickNotes.
 *
 * DRAG:
 *   Grab the header bar to move. Clamped to canvas bounds.
 *   The canvas element must have [data-canvas] attribute (Canvas component sets this).
 *   Button clicks in header do NOT trigger drag.
 *
 * MINIMIZE → PEEK TAB:
 *   onMinimize(id, title, variant) → parent (CommandCenter) adds to peek stack.
 *   The panel is hidden; peek tab appears on the right edge of canvas.
 *   Clicking the peek tab calls onRestore in PeekStack → CommandCenter re-shows panel.
 *
 * POP-OUT TO WINDOW:
 *   onPopOut(id) → parent handles Electron IPC (new BrowserWindow).
 *   Panel does not manage its own window — stays pure React.
 *
 * Z-INDEX:
 *   Passed as `zIndex` prop. CommandCenter manages a zMax counter and
 *   assigns z-index per panel, incremented on focus (bringToFront).
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import { useGSAP } from '@gsap/react';
import {
  animateFloatingPanelEntrance,
  animateFloatingPanelMinimize,
} from '../../core/animations';
import styles from './FloatingPanel.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// ICONS
// ─────────────────────────────────────────────────────────────────────────────

/** Dock to right sidebar (arrow + right-edge bar) */
const IconDock = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M1 5h6M5 2l3 3-3 3" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" strokeLinejoin="round"/>
    <line x1="9" y1="1" x2="9" y2="9" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round"/>
  </svg>
);

/** Minimize → tray / peek tab */
const IconMinimize = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M1 5h8M7 2l3 3-3 3"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

/** Pop out to standalone Electron window */
const IconPopOut = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M4 1H1v8h8V6M6 1h3v3M4.5 5.5L9 1"
      stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// FLOATING PANEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string}   id            - Unique panel id (e.g. 'fp-agents')
 * @param {string}   title         - Panel header title
 * @param {'command'|'work'} variant
 * @param {number}   initialX      - Initial left position (px, relative to canvas)
 * @param {number}   initialY      - Initial top position (px, relative to canvas)
 * @param {number}   width         - Panel width in px
 * @param {number}   zIndex        - Z-index (managed by parent's bringToFront)
 * @param {boolean}  isActive      - Whether this is the topmost / focused panel
 * @param {function} onFocus       - () => void — called on mousedown to bring to front
 * @param {function} onDock        - (id) => void — dock panel to right sidebar
 * @param {function} onMinimize    - (id, title, variant) => void — minimize to tray
 * @param {function} onPopOut      - (id) => void — open in Electron window
 * @param {ReactNode} headerExtra  - Counts, badges, VU bars rendered after title
 * @param {ReactNode} footer       - Footer content (e.g. heartbeat row)
 * @param {ReactNode} children     - Panel body content
 */
const FloatingPanel = ({
  id,
  title,
  variant     = 'command',
  initialX    = 16,
  initialY    = 16,
  width       = 280,
  zIndex      = 20,
  isActive    = false,
  onFocus,
  onDock,
  onMinimize,
  onPopOut,
  headerExtra,
  footer,
  children,
}) => {
  const rootRef    = useRef(null);
  const isDragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const minimizing = useRef(false);
  const [pos, setPos] = useState({ x: initialX, y: initialY });

  const isCmd = variant === 'command';

  // ── ENTRANCE ANIMATION — runs on mount (spawn + restore from peek) ──
  useGSAP(() => {
    if (rootRef.current) {
      animateFloatingPanelEntrance(rootRef.current);
    }
  }, { scope: rootRef });

  // ── DRAG START — mousedown on header ──
  const handleHeaderMouseDown = useCallback((e) => {
    // Don't drag when clicking buttons or inputs inside the header
    if (e.target.closest('button') || e.target.closest('input')) return;
    isDragging.current = true;

    const rect     = rootRef.current.getBoundingClientRect();
    const canvas   = rootRef.current.closest('[data-canvas]');
    const canvasR  = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0 };

    dragOffset.current = {
      x: e.clientX - (rect.left - canvasR.left),
      y: e.clientY - (rect.top  - canvasR.top),
    };
    onFocus?.();
    e.preventDefault();
  }, [onFocus]);

  // ── DRAG MOVE + END — window-level listeners ──
  useEffect(() => {
    const onMove = (e) => {
      if (!isDragging.current || !rootRef.current) return;
      const canvas  = rootRef.current.closest('[data-canvas]');
      if (!canvas) return;
      const cr = canvas.getBoundingClientRect();
      let x = e.clientX - cr.left - dragOffset.current.x;
      let y = e.clientY - cr.top  - dragOffset.current.y;
      // Clamp to canvas bounds
      x = Math.max(0, Math.min(x, cr.width  - rootRef.current.offsetWidth));
      y = Math.max(0, Math.min(y, cr.height - rootRef.current.offsetHeight));
      setPos({ x, y });
    };
    const onUp = () => { isDragging.current = false; };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };
  }, []);

  // ── ROOT CLASS ──
  const rootClass = [
    styles.float,
    isCmd    ? styles.floatCmd  : styles.floatWork,
    isActive ? styles.active    : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={rootRef}
      className={rootClass}
      style={{ left: pos.x, top: pos.y, width, zIndex }}
      onMouseDown={onFocus}
      role="region"
      aria-label={title}
    >

      {/* ── BORDER SEGMENTS (command variant only) ── */}
      {isCmd && (
        <>
          <div className={styles.bt} aria-hidden="true" />
          <div className={styles.bb} aria-hidden="true" />
          <div className={styles.bl} aria-hidden="true" />
          <div className={styles.br} aria-hidden="true" />
        </>
      )}

      {/* ── CORNER PLATES — outer L-brackets ── */}
      <div className={`${styles.c} ${styles.ctl}`} aria-hidden="true" />
      <div className={`${styles.c} ${styles.ctr}`} aria-hidden="true" />
      <div className={`${styles.c} ${styles.cbl}`} aria-hidden="true" />
      <div className={`${styles.c} ${styles.cbr}`} aria-hidden="true" />

      {/* ── INNER ACCENT MARKS (ci) — small inner L-notches ── */}
      <div className={`${styles.ci} ${styles.citl}`} aria-hidden="true" />
      <div className={`${styles.ci} ${styles.citr}`} aria-hidden="true" />
      {/* Command gets all 4; Work gets TL+TR only */}
      {isCmd && (
        <>
          <div className={`${styles.ci} ${styles.cibl}`} aria-hidden="true" />
          <div className={`${styles.ci} ${styles.cibr}`} aria-hidden="true" />
        </>
      )}

      {/* ── HEADER ── */}
      <div className={styles.header} onMouseDown={handleHeaderMouseDown}>
        <div className={styles.led}      aria-hidden="true" />
        <div className={styles.dragDots} aria-hidden="true" />

        <span className={styles.title}>{title}</span>

        {headerExtra && (
          <div className={styles.headerExtra}>{headerExtra}</div>
        )}

        <div className={styles.actions}>
          {onDock && (
            <button
              className={styles.btn}
              onClick={(e) => {
                e.stopPropagation();
                // Use minimize animation to slide panel toward right dock
                if (minimizing.current || !rootRef.current) return;
                minimizing.current = true;
                animateFloatingPanelMinimize(rootRef.current, () => {
                  minimizing.current = false;
                  onDock(id);
                });
              }}
              aria-label={`Dock ${title} to right sidebar`}
              title="Dock to right sidebar"
            >
              <IconDock />
            </button>
          )}
          {onMinimize && (
            <button
              className={styles.btn}
              onClick={(e) => {
                e.stopPropagation();
                // Guard against double-click during animation
                if (minimizing.current || !rootRef.current) return;
                minimizing.current = true;
                animateFloatingPanelMinimize(rootRef.current, () => {
                  minimizing.current = false;
                  onMinimize(id, title, variant);
                });
              }}
              aria-label={`Minimize ${title}`}
              title="Minimize to peek tab"
            >
              <IconMinimize />
            </button>
          )}
          {onPopOut && (
            <button
              className={styles.btn}
              onClick={(e) => { e.stopPropagation(); onPopOut(id); }}
              aria-label={`Open ${title} in window`}
              title="Open in separate window"
            >
              <IconPopOut />
            </button>
          )}
        </div>
      </div>

      {/* ── GLASS BODY ── */}
      <div className={styles.glass}>
        <div className={styles.body}>
          {children}
        </div>
        {footer && (
          <div className={styles.footer}>
            {footer}
          </div>
        )}
      </div>

    </div>
  );
};

export default FloatingPanel;
