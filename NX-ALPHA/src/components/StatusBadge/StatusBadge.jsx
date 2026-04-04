/**
 * AURA NX-Alpha — StatusBadge
 *
 * Displays an agent or team status with a colored dot + label.
 * Supports all five status states: working, waiting, done, error, idle.
 *
 * STATUS TRANSITIONS:
 * When the `status` prop changes, GSAP animates the cross-fade via
 * animateBadgeTransition() from core/animations.js.
 * The dot pulse (ambient) is handled by CSS — it runs independently.
 *
 * USAGE:
 *   <StatusBadge status="working" />
 *   <StatusBadge status="waiting" label="Waiting" />
 *   <StatusBadge status="done" size="sm" />
 */

import { useRef, useEffect, useState } from 'react';
import { animateBadgeTransition } from '../../core/animations';
import styles from './StatusBadge.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// STATUS CONFIG
// Maps status keys to display labels and CSS module classes.
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_CONFIG = {
  working: { label: 'Working',  cssClass: styles.working },
  waiting: { label: 'Waiting',  cssClass: styles.waiting },
  done:    { label: 'Done',     cssClass: styles.done    },
  error:   { label: 'Error',    cssClass: styles.error   },
  idle:    { label: 'Queued',   cssClass: styles.idle    },
};

// Fallback for unknown status values
const FALLBACK_CONFIG = { label: 'Unknown', cssClass: styles.idle };

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {'working'|'waiting'|'done'|'error'|'idle'} status
 * @param {string}  label    - Override the default label for this status
 * @param {'sm'|undefined}  size - 'sm' for compact variant
 * @param {string}  className - Additional classes
 */
const StatusBadge = ({
  status    = 'idle',
  label,
  size,
  className,
}) => {
  const badgeRef = useRef(null);

  // Internal display state — GSAP transitions between these
  const [displayStatus, setDisplayStatus] = useState(status);

  // Animate when status prop changes
  useEffect(() => {
    if (status === displayStatus) return;
    if (!badgeRef.current) {
      setDisplayStatus(status);
      return;
    }
    animateBadgeTransition(badgeRef.current, () => {
      setDisplayStatus(status);
    });
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const config     = STATUS_CONFIG[displayStatus] ?? FALLBACK_CONFIG;
  const displayLabel = label ?? config.label;

  const rootClass = [
    styles.badge,
    config.cssClass,
    size === 'sm' && styles.sm,
    className,
  ].filter(Boolean).join(' ');

  return (
    <span
      ref={badgeRef}
      className={rootClass}
      role="status"
      aria-label={`Status: ${displayLabel}`}
    >
      <span className={styles.dot} aria-hidden="true" />
      {displayLabel}
    </span>
  );
};

export default StatusBadge;
