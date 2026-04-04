/**
 * EmailBlock — email draft preview card.
 * Shows To / Subject / Body fields, all editable.
 * Send Draft posts to backend /data/mail/send endpoint.
 *
 * Data shape: { to?: string, cc?: string, subject?: string, body?: string, from?: string }
 */
import { useRef, useState } from 'react';
import styles from './blocks.module.css';

const BASE_URL = 'http://127.0.0.1:8000';

const EmailBlock = ({
  to      = '',
  cc      = '',
  subject = '',
  body    = '',
  from    = 'Aura',
  onDiscard,
}) => {
  const toRef      = useRef(null);
  const ccRef      = useRef(null);
  const subjectRef = useRef(null);
  const bodyRef    = useRef(null);
  const [sending, setSending]   = useState(false);
  const [status, setStatus]     = useState(null); // 'sent' | 'error'

  const handleSend = async () => {
    const draft = {
      to:      toRef.current?.textContent?.trim() || to,
      cc:      ccRef.current?.textContent?.trim() || cc,
      subject: subjectRef.current?.textContent?.trim() || subject,
      body:    bodyRef.current?.textContent?.trim() || body,
      from,
    };
    if (!draft.to) { setStatus('error'); return; }
    setSending(true);
    setStatus(null);
    try {
      const res = await fetch(`${BASE_URL}/data/mail/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatus('sent');
    } catch {
      setStatus('error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.root} style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 0 }}>
      {/* Fields */}
      <div className={styles.emailField}>
        <span className={styles.emailLabel}>From</span>
        <span className={styles.emailValue} style={{ color: 'var(--text-secondary)' }}>{from}</span>
      </div>
      <div className={styles.emailField}>
        <span className={styles.emailLabel}>To</span>
        <span
          ref={toRef}
          className={`${styles.emailValue} ${styles.editable}`}
          contentEditable
          suppressContentEditableWarning
          data-placeholder="recipient@domain.com"
        >
          {to}
        </span>
      </div>
      {cc && (
        <div className={styles.emailField}>
          <span className={styles.emailLabel}>Cc</span>
          <span
            ref={ccRef}
            className={`${styles.emailValue} ${styles.editable}`}
            contentEditable
            suppressContentEditableWarning
          >
            {cc}
          </span>
        </div>
      )}
      <div className={styles.emailField}>
        <span className={styles.emailLabel}>Subject</span>
        <span
          ref={subjectRef}
          className={`${styles.emailValue} ${styles.editable}`}
          contentEditable
          suppressContentEditableWarning
          data-placeholder="Subject line…"
          style={{ fontWeight: 500 }}
        >
          {subject}
        </span>
      </div>

      {/* Body */}
      <div
        ref={bodyRef}
        className={`${styles.emailBody} ${styles.editable}`}
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Email body…"
        spellCheck
        style={{ flex: 1, minHeight: 0 }}
      >
        {body}
      </div>

      {/* Actions */}
      <div className={styles.emailActions}>
        <button
          className={styles.btnPrimary}
          onClick={handleSend}
          disabled={sending}
        >
          {sending ? 'Sending…' : status === 'sent' ? 'Sent ✓' : 'Send Draft'}
        </button>
        <button className={styles.btnSecondary} onClick={onDiscard}>Discard</button>
        {status === 'error' && (
          <span style={{ color: 'var(--amber-base)', fontSize: '11px', marginLeft: '8px' }}>
            Failed — check recipient
          </span>
        )}
      </div>
    </div>
  );
};

export default EmailBlock;
