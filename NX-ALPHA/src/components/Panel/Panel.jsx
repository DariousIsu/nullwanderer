/**
 * AURA NX-Alpha — Panel Shell
 *
 * The foundational container. Every piece of Aura's UI lives inside a Panel.
 * Handles: entrance animation, collapse/expand, pop-out trigger, focus state.
 *
 * VARIANT SYSTEM:
 * Panels use a 3-class architecture — each class is a distinct material identity.
 *
 *   variant="command"  Type A — Command Center.
 *                      Heavy chassis. Segmented border system with corner plates.
 *                      Amber L-bracket corners (outer 2px + inner accent mark).
 *                      Full glass interior with blue internal glow + grid substrate.
 *                      Use for: AgentMonitor, primary status panels, core Aura UI.
 *
 *   variant="work"     Type B — Work Area.
 *                      Continuous border. Rangefinder corners (TL/TR only get inner marks).
 *                      Lighter touch — frame serves content, doesn't announce itself.
 *                      Use for: Canvas, QuickNotes, Schedule, secondary surfaces.
 *
 *   variant="fault"    Type C — Fault State.
 *                      Red chassis. Hazard stripe at top edge.
 *                      Red-tinted glass with red glow + red grid.
 *                      Fast-pulsing red LED. Reserved for system error / critical failure.
 *
 * GLASS INTERIOR:
 * All variants share the holographic glass body concept:
 * The header is a title plate set into the chassis (gradient metal bar).
 * The content area is a dark glass display set into that chassis.
 * Frame = physical material. Glass = display surface.
 *
 * POP-OUT ARCHITECTURE NOTE:
 * "Pop-out" calls onPopOut prop — Panel does not manage its own window.
 * Parent (CommandCenter / App) handles Electron IPC for new BrowserWindow.
 * This keeps Panel pure React. Electron layer owns window management.
 *
 * GSAP:
 * All layout transitions use functions from core/animations.js.
 * CSS handles only static styles. No inline animation in this file.
 */

import { useRef, useState, useCallback, useId } from 'react';
import { useGSAP } from '@gsap/react';
import {
  animatePanelEntrance,
  animatePanelCollapse,
  captureFlipState,
  animatePanelPopOut,
  animatePanelDock,
} from '../../core/animations';
import styles from './Panel.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// ICONS — inline SVGs, no external dependency
// ─────────────────────────────────────────────────────────────────────────────

const IconChevron = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 4.5L6 8L9.5 4.5" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconPopOut = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M7 2H10V5" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 2L5.5 6.5" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" />
    <path d="M5 3H2.5C2.22 3 2 3.22 2 3.5V9.5C2 9.78 2.22 10 2.5 10H8.5C8.78 10 9 9.78 9 9.5V7"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconDockBack = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M5 10H2V7" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2 10L6.5 5.5" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" />
    <path d="M7 9H9.5C9.78 9 10 8.78 10 8.5V2.5C10 2.22 9.78 2 9.5 2H3.5C3.22 2 3 2.22 3 2.5V5"
      stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const IconClose = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" />
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// PANEL COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string}    title            - Panel header label (shown uppercase)
 * @param {ReactNode} children         - Panel body content
 * @param {ReactNode} footer           - Optional footer content
 * @param {string}    className        - Additional CSS classes for the root element
 * @param {'command'|'work'|'fault'} variant
 *                                     - Panel visual class. Default: 'work'
 *                                       'command' = heavy chassis, segmented borders, all 4 corner plates
 *                                       'work'    = continuous border, rangefinder corners (lighter)
 *                                       'fault'   = red chassis, hazard stripe, red glass interior
 * @param {string}    faultMessage     - Short fault description rendered as alert row (fault variant only)
 * @param {boolean}   isActive         - Whether this is the focused panel (accent border + brighter glass)
 * @param {boolean}   isFloating       - Whether panel is in floating/popped-out state
 * @param {boolean}   defaultCollapsed - Start collapsed (body hidden)
 * @param {boolean}   collapsible      - Show collapse toggle (default true)
 * @param {boolean}   closable         - Show close button (default false)
 * @param {function}  onPopOut         - Called when user clicks pop-out — parent handles IPC
 * @param {function}  onDockBack       - Called when user clicks dock-back in floating state
 * @param {function}  onClose          - Called when user clicks close (if closable)
 * @param {function}  onFocus          - Called when panel receives focus (click)
 * @param {ReactNode} headerExtra      - Optional content rendered in header between title and actions
 *                                       Use for AuraIndicator, live counts, VU bars, etc.
 */
const Panel = ({
  title,
  children,
  footer,
  className,
  variant        = 'work',
  faultMessage,
  isActive       = false,
  isFloating     = false,
  defaultCollapsed = false,
  collapsible    = true,
  closable       = false,
  onPopOut,
  onDockBack,
  onClose,
  onFocus,
  headerExtra,
}) => {
  const panelRef = useRef(null);
  const bodyRef  = useRef(null);
  const headerId = useId();

  const [collapsed, setCollapsed] = useState(defaultCollapsed);

  // ── ENTRANCE ANIMATION ──
  useGSAP(() => {
    animatePanelEntrance(panelRef.current);
  }, { scope: panelRef });

  // ── COLLAPSE / EXPAND ──
  const handleCollapseToggle = useCallback(() => {
    if (!bodyRef.current) return;
    const expanding = collapsed;
    animatePanelCollapse(bodyRef.current, expanding);
    setCollapsed(!collapsed);
  }, [collapsed]);

  // ── POP OUT ──
  const handlePopOut = useCallback(() => {
    if (!panelRef.current || !onPopOut) return;
    const state = captureFlipState(panelRef.current);
    onPopOut();
    requestAnimationFrame(() => animatePanelPopOut(state));
  }, [onPopOut]);

  // ── DOCK BACK ──
  const handleDockBack = useCallback(() => {
    if (!panelRef.current || !onDockBack) return;
    const state = captureFlipState(panelRef.current);
    onDockBack();
    requestAnimationFrame(() => animatePanelDock(state));
  }, [onDockBack]);

  // ── CSS CLASS COMPOSITION ──
  const rootClass = [
    styles.panel,
    variant === 'command' && styles.panelCommand,
    variant === 'work'    && styles.panelWork,
    variant === 'fault'   && styles.panelFault,
    isActive              && styles.panelActive,
    isFloating            && styles.panelFloating,
    className,
  ].filter(Boolean).join(' ');

  const collapseClass = [
    styles.actionBtnCollapse,
    collapsed && styles.collapsed,
  ].filter(Boolean).join(' ');

  // Command and Fault use segmented border elements instead of CSS border
  const hasSegmentedBorder = variant === 'command' || variant === 'fault';

  return (
    <div
      ref={panelRef}
      className={rootClass}
      role="region"
      aria-labelledby={headerId}
      onClick={onFocus}
    >

      {/* ── BORDER SEGMENTS ──
          Command + Fault only. Four edge pieces with gaps at the corners.
          The corners are their own structural elements (below).
          Work panels use CSS border on the root element instead. */}
      {hasSegmentedBorder && (
        <>
          <div className={styles.borderTop}    aria-hidden="true" />
          <div className={styles.borderBottom} aria-hidden="true" />
          <div className={styles.borderLeft}   aria-hidden="true" />
          <div className={styles.borderRight}  aria-hidden="true" />
        </>
      )}

      {/* ── FAULT STRIPE ──
          Diagonal hazard stripe on the top edge. Fault variant only.
          Sits between the top corner plates, above the glass header.
          Signals system failure — reserved exclusively for error state. */}
      {variant === 'fault' && (
        <div className={styles.faultStripe} aria-hidden="true" />
      )}

      {/* ── CORNER PLATES ──
          The real structural elements of the chassis.
          Each corner is independent — corners can exist even where the border segments are absent.
          Command: 2px amber L-brackets via ::before (horizontal) + ::after (vertical)
          Work: rangefinder L-brackets applied directly as border properties
          Fault: 2px red L-brackets with glow via ::before/::after */}
      <div className={`${styles.corner} ${styles.cornerTL}`} aria-hidden="true" />
      <div className={`${styles.corner} ${styles.cornerTR}`} aria-hidden="true" />
      <div className={`${styles.corner} ${styles.cornerBL}`} aria-hidden="true" />
      <div className={`${styles.corner} ${styles.cornerBR}`} aria-hidden="true" />

      {/* ── INNER CORNER ACCENT MARKS ──
          Small inner L-marks — set inward from the corner plates.
          Command: all four corners. Work: TL + TR only. Fault: none (too busy). */}
      <div className={`${styles.cornerInner} ${styles.cornerInnerTL}`} aria-hidden="true" />
      <div className={`${styles.cornerInner} ${styles.cornerInnerTR}`} aria-hidden="true" />
      <div className={`${styles.cornerInner} ${styles.cornerInnerBL}`} aria-hidden="true" />
      <div className={`${styles.cornerInner} ${styles.cornerInnerBR}`} aria-hidden="true" />

      {/* ── HEADER ──
          Title plate set into the chassis. Gradient metal bar.
          LED dot indicates Aura presence (amber) or fault state (red, fast blink).
          Drag handle gives a physical grip affordance. */}
      <div className={styles.header}>
        <div className={styles.led} aria-hidden="true" />
        <div className={styles.dragHandle} aria-hidden="true" />

        <span id={headerId} className={styles.title}>
          {title}
        </span>

        {/* Optional extra header content — AuraIndicator, live badge, VU bars, etc. */}
        {headerExtra && (
          <div className={styles.headerExtra}>
            {headerExtra}
          </div>
        )}

        <div className={styles.actions}>
          {/* Collapse toggle */}
          {collapsible && (
            <button
              className={collapseClass}
              onClick={(e) => { e.stopPropagation(); handleCollapseToggle(); }}
              aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
              aria-expanded={!collapsed}
              aria-controls={`${headerId}-body`}
            >
              <IconChevron />
            </button>
          )}

          {/* Pop-out / Dock-back */}
          {isFloating ? (
            onDockBack && (
              <button
                className={styles.actionBtn}
                onClick={(e) => { e.stopPropagation(); handleDockBack(); }}
                aria-label={`Dock ${title} back to command center`}
              >
                <IconDockBack />
              </button>
            )
          ) : (
            onPopOut && (
              <button
                className={styles.actionBtn}
                onClick={(e) => { e.stopPropagation(); handlePopOut(); }}
                aria-label={`Pop ${title} out to separate window`}
              >
                <IconPopOut />
              </button>
            )
          )}

          {/* Close */}
          {closable && onClose && (
            <button
              className={`${styles.actionBtn} ${styles.actionBtnClose}`}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              aria-label={`Close ${title}`}
            >
              <IconClose />
            </button>
          )}
        </div>
      </div>

      {/* ── GLASS BODY ──
          The holographic glass display set into the chassis.
          Background: near-black glass rgba(4,8,15,0.94).
          ::before — internal blue glow (top gradient + radial bloom).
          ::after  — 20×20 blue grid substrate.
          box-shadow: inset glass edge illumination (blue rim).
          Fault variant gets red glow, red grid, red rim instead. */}
      <div className={styles.glass}>

        {/* ── BODY — scrollable content area ── */}
        <div
          ref={bodyRef}
          id={`${headerId}-body`}
          className={collapsed ? styles.bodyCollapsed : styles.body}
          aria-hidden={collapsed}
        >
          {/* Fault alert row — shown at top of body when faultMessage is provided */}
          {variant === 'fault' && faultMessage && (
            <div className={styles.faultAlert} role="alert">
              <span className={styles.faultAlertLabel}>FAULT</span>
              <span className={styles.faultAlertMsg}>{faultMessage}</span>
            </div>
          )}

          {children}
        </div>

        {/* ── FOOTER (optional) ── */}
        {footer && !collapsed && (
          <div className={styles.footer}>
            {footer}
          </div>
        )}

        {/* Resize handle — visible only when floating */}
        {isFloating && <div className={styles.resizeHandle} aria-hidden="true" />}

      </div>
    </div>
  );
};

export default Panel;
