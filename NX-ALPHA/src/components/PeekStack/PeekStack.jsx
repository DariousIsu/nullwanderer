/**
 * AURA NX-Alpha — PeekStack
 *
 * Right-edge tab strip for minimized floating panels.
 * When a FloatingPanel is minimized, a peek tab appears here.
 * Clicking the tab restores the panel.
 *
 * POSITION:
 *   Fixed to the right edge of the canvas, vertically centered.
 *   z-index: 250 — above floating panels (20–80) and drop panels (110),
 *   so tabs remain accessible when a drop panel is open.
 *
 * TAB ANATOMY:
 *   Vertical text (writing-mode: vertical-rl, rotated 180°).
 *   Left accent bar — amber for command panels, blue for work panels.
 *   Click → onRestore(id) → CommandCenter removes from peek, shows panel.
 *
 * UNCHANGED BEHAVIOR NOTE:
 *   The peek stack was explicitly locked in the design session.
 *   Do not modify z-index, positioning, or peek tab appearance
 *   without a deliberate design decision.
 */

import { useRef, useEffect } from 'react';
import { animatePeekTabEntrance } from '../../core/animations';
import styles from './PeekStack.module.css';

/**
 * @param {{ id: string, title: string, variant: 'command'|'work' }[]} tabs
 * @param {function} onRestore — (id: string) => void
 */
// ─────────────────────────────────────────────────────────────────────────────
// PEEK TAB — individual tab with entrance animation on mount
// ─────────────────────────────────────────────────────────────────────────────

const PeekTab = ({ id, title, variant, onRestore }) => {
  const tabRef = useRef(null);

  // Entrance animation — runs once on mount
  useEffect(() => {
    if (tabRef.current) {
      animatePeekTabEntrance(tabRef.current);
    }
  }, []);

  return (
    <button
      ref={tabRef}
      className={[
        styles.tab,
        variant === 'command' ? styles.tabCmd : styles.tabWork,
      ].join(' ')}
      onClick={() => onRestore?.(id)}
      role="listitem"
      aria-label={`Restore ${title}`}
      title={`Restore ${title}`}
    >
      {title}
    </button>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PEEK STACK
// ─────────────────────────────────────────────────────────────────────────────

const PeekStack = ({ tabs = [], onRestore }) => {
  if (tabs.length === 0) return null;

  return (
    <div className={styles.stack} role="list" aria-label="Minimized panels">
      {tabs.map(({ id, title, variant }) => (
        <PeekTab
          key={id}
          id={id}
          title={title}
          variant={variant}
          onRestore={onRestore}
        />
      ))}
    </div>
  );
};

export default PeekStack;
