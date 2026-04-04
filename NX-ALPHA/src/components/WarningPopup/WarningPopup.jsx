/**
 * AURA NX-Alpha — WarningPopup
 *
 * Shared interrupt overlay for two SSE event types:
 *   pending_approval — Aura wants to run [tool]. Approve?
 *   external_alert   — Proactive mode alert with severity indicator
 *
 * VARIANTS:
 *   pending_approval — Amber border. Tool name chip. Approve / Deny.
 *   external_alert   — Severity-coded border (info/warning/critical). Dismiss.
 *
 * Z-INDEX: 400 — above canvas blocks, floating panels, drop panels, peek stack.
 * KEYBOARD: Escape — deny (pending_approval) / dismiss (external_alert)
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { animateWarningIn, animateWarningOut } from '../../core/animations';
import styles from './WarningPopup.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// SEVERITY CONFIG — external_alert severity → display label
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_LABELS = {
  info:     'Info Alert',
  warning:  'Warning Alert',
  critical: 'Critical Alert',
};

// ─────────────────────────────────────────────────────────────────────────────
// INLINE SVG ICONS — matches AURA icon weight (1.2px stroke, rounded caps)
// ─────────────────────────────────────────────────────────────────────────────

const IconApproval = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M7 1.5L2 3.5v3.5c0 2.8 2 4.8 5 5.5 3-.7 5-2.7 5-5.5V3.5L7 1.5z"
      stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
    />
    <path
      d="M4.8 7l1.5 1.6L9.2 5.5"
      stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
    />
  </svg>
);

const IconAlert = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M7 2L12.5 11.5H1.5L7 2z"
      stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"
    />
    <line x1="7" y1="5.5" x2="7" y2="8.5"
      stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
    <circle cx="7" cy="10" r="0.65" fill="currentColor"/>
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// VARIANT CONTENT — rendered inside card body
// ─────────────────────────────────────────────────────────────────────────────

const PendingApprovalContent = ({ warning }) => (
  <>
    <div className={styles.labelRow}>
      <IconApproval />
      <span>Approval Required</span>
    </div>
    <div className={styles.body}>
      <p className={styles.bodyTitle}>Aura wants to run a tool</p>
      <div className={styles.toolChip}>
        <span className={styles.toolName}>{warning.tool ?? 'unknown_tool'}</span>
      </div>
      {warning.description && (
        <p className={styles.bodyDetail}>{warning.description}</p>
      )}
    </div>
  </>
);

const ExternalAlertContent = ({ warning }) => {
  const sevLabel = SEVERITY_LABELS[warning.severity] ?? SEVERITY_LABELS.warning;
  return (
    <>
      <div className={styles.labelRow}>
        <IconAlert />
        <span>{sevLabel}</span>
      </div>
      <div className={styles.body}>
        {warning.title && (
          <p className={styles.bodyTitle}>{warning.title}</p>
        )}
        {warning.message && (
          <p className={styles.bodyDetail}>{warning.message}</p>
        )}
      </div>
    </>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// ACCENT COLOR — drives --accent CSS var on the card
// ─────────────────────────────────────────────────────────────────────────────

function resolveAccent(warning) {
  if (!warning) return 'var(--amber-base)';
  if (warning.type === 'external_alert') {
    switch (warning.severity) {
      case 'info':     return 'var(--blue-bright)';
      case 'critical': return 'var(--status-error)';
      default:         return 'var(--amber-bright)'; // warning
    }
  }
  return 'var(--amber-base)'; // pending_approval
}

function resolveAriaLabel(type) {
  if (type === 'pending_approval') return 'Tool approval required';
  if (type === 'external_alert')   return 'System alert';
  return 'System notification';
}

// ─────────────────────────────────────────────────────────────────────────────
// WARNING POPUP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Function} onApprove — pending_approval: "Approve" clicked
 * @param {Function} onDeny    — pending_approval: "Deny" clicked
 * @param {Function} onDismiss — external_alert: "Dismiss" clicked
 */
const WarningPopup = forwardRef(({
  onApprove,
  onDeny,
  onDismiss,
}, ref) => {
  const [warning,   setWarning]   = useState(null);
  const [isVisible, setIsVisible] = useState(false);
  const closingRef  = useRef(false);
  const backdropRef = useRef(null);
  const cardRef     = useRef(null);

  // ── IMPERATIVE API (CommandCenter and useAuraStream call these) ──
  useImperativeHandle(ref, () => ({
    /**
     * Display a warning overlay.
     * @param {object} spec — { type, ...payload }
     */
    show: (spec) => {
      closingRef.current = false;
      setWarning(spec);
      setIsVisible(true);
    },
    /**
     * Programmatically hide without triggering a callback.
     * Safe to call even if nothing is showing.
     */
    hide: () => {
      if (closingRef.current) return;
      if (!backdropRef.current || !cardRef.current) {
        setWarning(null);
        setIsVisible(false);
        return;
      }
      closingRef.current = true;
      animateWarningOut(backdropRef.current, cardRef.current, () => {
        closingRef.current = false;
        setWarning(null);
        setIsVisible(false);
      });
    },
  }));

  // ── ENTRANCE ANIMATION whenever a new warning mounts ──
  useEffect(() => {
    if (isVisible && warning && backdropRef.current && cardRef.current) {
      animateWarningIn(backdropRef.current, cardRef.current);
    }
  }, [isVisible, warning]);

  // ── KEYBOARD — Escape to dismiss/deny ──
  useEffect(() => {
    if (!isVisible || !warning) return;

    const handleKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (warning.type === 'pending_approval') {
        handleAction(onDeny);
      } else {
        handleAction(onDismiss);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, warning]);

  // ── ACTION HANDLER — plays exit animation, then calls callback ──
  const handleAction = useCallback((callback) => {
    if (closingRef.current || !backdropRef.current || !cardRef.current) return;
    closingRef.current = true;
    animateWarningOut(backdropRef.current, cardRef.current, () => {
      closingRef.current = false;
      setWarning(null);
      setIsVisible(false);
      callback?.();
    });
  }, []);

  if (!isVisible || !warning) return null;

  const accentColor = resolveAccent(warning);
  const { type } = warning;

  return (
    <div
      ref={backdropRef}
      className={styles.backdrop}
      role="dialog"
      aria-modal="true"
      aria-label={resolveAriaLabel(type)}
      /* Clicking backdrop is a no-op — users must choose an action */
      onClick={(e) => e.stopPropagation()}
    >
      <div
        ref={cardRef}
        className={styles.card}
        data-warning-type={type}
        style={{ '--accent': accentColor }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Accent bar — top edge, full width ── */}
        <div className={styles.accentBar} />

        {/* ── Variant content ── */}
        {type === 'pending_approval' && <PendingApprovalContent warning={warning} />}
        {type === 'external_alert'   && <ExternalAlertContent   warning={warning} />}

        {/* ── Divider ── */}
        <div className={styles.divider} />

        {/* ── Actions ── */}
        <div className={styles.actions}>
          {type === 'pending_approval' && (<>
            <button
              className={styles.btnPrimary}
              onClick={() => handleAction(onApprove)}
            >
              Approve
            </button>
            <button
              className={styles.btnDestructive}
              onClick={() => handleAction(onDeny)}
            >
              Deny
            </button>
          </>)}

          {type === 'external_alert' && (
            <button
              className={styles.btnSecondary}
              onClick={() => handleAction(onDismiss)}
            >
              Dismiss
            </button>
          )}

        </div>
      </div>
    </div>
  );
});

WarningPopup.displayName = 'WarningPopup';

export default WarningPopup;
