/**
 * AURA NX-Alpha — RightDock
 *
 * Right-side sidebar that holds floating panels in their "docked" state.
 * When one or more panels are docked here, the dock expands and the canvas
 * shrinks accordingly — panels no longer overlap canvas content.
 *
 * PANEL STATES (managed by CommandCenter):
 *   'floating'  — panel is position:absolute on the canvas (default)
 *   'docked'    — panel lives here in the right dock sidebar
 *   'minimized' — panel is collapsed to a PeekStack tray tab
 *
 * DOCK BEHAVIOR:
 *   Opens (0 → 264px) when the first panel is docked.
 *   Closes (264px → 0) when the last docked panel leaves.
 *   Panels stack vertically, each collapsible via Panel.jsx.
 *   GSAP animateRightDockOpen / animateRightDockClose drive width.
 *
 * HEADER ACTIONS per docked panel:
 *   ↙ Undock   — float the panel back to the canvas
 *   → Minimize — send to PeekStack tray tab
 *   ↗ Pop out  — open in Electron BrowserWindow
 *
 * LAYOUT:
 *   Fixed width 264px when open. border-left separates from canvas.
 *   Panels use Panel.jsx chassis (same styling, no drag handle).
 *   Scrollable if panels overflow.
 *
 * Z-INDEX: below drop panels (110), above canvas content. Sits in the flex row.
 */

import { useRef, useEffect } from 'react';
import { animateRightDockOpen, animateRightDockClose } from '../../core/animations';
import Panel from '../Panel/Panel';
import styles from './RightDock.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// ICONS
// ─────────────────────────────────────────────────────────────────────────────

/** Undock — float panel back to canvas (arrow pointing left away from bar) */
const IconUndock = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M9 5H3M5 2L2 5l3 3" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" strokeLinejoin="round"/>
    <line x1="1" y1="1" x2="1" y2="9" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round"/>
  </svg>
);

/** Minimize to tray — send to PeekStack tab */
const IconMinimizeTray = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 5h6M6 7l3-2-3-2" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// DOCK PANEL HEADER ACTIONS
// Rendered as headerExtra in Panel.jsx — sits between title and built-in actions.
// Styled to match Panel's .actionBtn class (same dimensions, same hover treatment).
// ─────────────────────────────────────────────────────────────────────────────

const DockPanelActions = ({ onUndock, onMinimize }) => (
  <div className={styles.dockActions}>
    <button
      className={styles.dockBtn}
      onClick={onUndock}
      aria-label="Undock — float to canvas"
      title="Float to canvas"
    >
      <IconUndock />
    </button>
    <button
      className={styles.dockBtn}
      onClick={onMinimize}
      aria-label="Minimize to tray"
      title="Minimize to tray"
    >
      <IconMinimizeTray />
    </button>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// RIGHT DOCK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ id: string, title: string, variant: 'command'|'work' }[]} dockedPanels
 *   — Panels currently in dock state. Ordered array (first in = top of dock).
 * @param {function} renderContent
 *   — (id: string) => ReactNode — maps panel id to its inner content
 * @param {function} onUndock     — (id: string) => void
 * @param {function} onMinimize   — (id: string, title: string, variant: string) => void
 * @param {function} onPopOut     — (id: string) => void
 */
const RightDock = ({
  dockedPanels = [],
  renderContent,
  onUndock,
  onMinimize,
  onPopOut,
}) => {
  const dockRef   = useRef(null);
  const prevCount = useRef(0);

  // ── OPEN / CLOSE ANIMATION ──
  // Fires when the number of docked panels crosses the 0 boundary.
  useEffect(() => {
    const el    = dockRef.current;
    const count = dockedPanels.length;

    if (!el) return;

    if (count > 0 && prevCount.current === 0) {
      // First panel just docked — expand dock
      animateRightDockOpen(el, 264);
    } else if (count === 0 && prevCount.current > 0) {
      // Last panel just left — collapse dock
      animateRightDockClose(el);
    }

    prevCount.current = count;
  }, [dockedPanels.length]);

  return (
    <div
      ref={dockRef}
      className={styles.dock}
      aria-label="Docked panels"
      data-empty={dockedPanels.length === 0 || undefined}
    >
      <div className={styles.inner}>

        {/* Dock label — always shown at top */}
        <div className={styles.dockLabel} aria-hidden="true">
          <span className={styles.dockLabelText}>Docked</span>
          <span className={styles.dockCount}>{dockedPanels.length}</span>
        </div>

        {/* Panel stack */}
        <div className={styles.panelStack}>
          {dockedPanels.map(panel => (
            <div key={panel.id} className={styles.panelSlot}>
              <Panel
                title={panel.title}
                variant={panel.variant}
                collapsible={true}
                onPopOut={() => onPopOut?.(panel.id)}
                headerExtra={
                  <DockPanelActions
                    onUndock={() => onUndock?.(panel.id)}
                    onMinimize={() => onMinimize?.(panel.id, panel.title, panel.variant)}
                  />
                }
              >
                {renderContent?.(panel.id)}
              </Panel>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
};

export default RightDock;
