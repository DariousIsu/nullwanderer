/**
 * AURA NX-Alpha — Toast
 *
 * System notification toasts. Stacks in the top-right corner.
 * Imperative API via ref:
 *   toastRef.current.show({ message, level, duration })
 *
 * LEVELS:
 *   info      — blue-bright, 5s auto-dismiss
 *   warning   — amber-bright, 7s auto-dismiss
 *   error     — status-error, 10s auto-dismiss (manual dismiss required for critical)
 *   success   — green-bright, 4s auto-dismiss
 *
 * SPEC SHAPE (§10 system_notification event):
 *   { type: string, message: string, data?: object, level?: string }
 */

import {
  useState,
  useCallback,
  forwardRef,
  useImperativeHandle,
} from 'react';
import styles from './Toast.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const LEVEL_CONFIG = {
  info:    { duration: 5000,  icon: 'ℹ',  label: 'Info' },
  warning: { duration: 7000,  icon: '⚠',  label: 'Warning' },
  error:   { duration: 10000, icon: '✕',  label: 'Error' },
  success: { duration: 4000,  icon: '✓',  label: 'Done' },
};

// ─────────────────────────────────────────────────────────────────────────────
// SINGLE TOAST
// ─────────────────────────────────────────────────────────────────────────────

const ToastItem = ({ id, message, level = 'info', onDismiss }) => {
  const cfg = LEVEL_CONFIG[level] ?? LEVEL_CONFIG.info;

  return (
    <div
      className={`${styles.toast} ${styles[`toast_${level}`]}`}
      role="alert"
      aria-live="polite"
    >
      <span className={styles.icon} aria-hidden="true">{cfg.icon}</span>
      <span className={styles.message}>{message}</span>
      <button
        className={styles.dismiss}
        onClick={() => onDismiss(id)}
        aria-label="Dismiss notification"
      >
        ✕
      </button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TOAST STACK
// ─────────────────────────────────────────────────────────────────────────────

let _nextId = 1;

const Toast = forwardRef((_props, ref) => {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  useImperativeHandle(ref, () => ({
    /**
     * Show a toast notification.
     * @param {object} spec
     * @param {string} spec.message   — notification text
     * @param {string} [spec.level]   — 'info' | 'warning' | 'error' | 'success'
     * @param {number} [spec.duration]— override auto-dismiss delay (ms)
     */
    show({ message, level = 'info', duration }) {
      const id = _nextId++;
      const cfg = LEVEL_CONFIG[level] ?? LEVEL_CONFIG.info;
      const delay = duration ?? cfg.duration;

      setToasts(prev => [...prev.slice(-4), { id, message, level }]);

      // Auto-dismiss
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, delay);
    },

    /** Dismiss all toasts immediately. */
    clear() {
      setToasts([]);
    },
  }));

  if (toasts.length === 0) return null;

  return (
    <div className={styles.stack} aria-label="Notifications">
      {toasts.map(t => (
        <ToastItem
          key={t.id}
          id={t.id}
          message={t.message}
          level={t.level}
          onDismiss={dismiss}
        />
      ))}
    </div>
  );
});

Toast.displayName = 'Toast';

export default Toast;
