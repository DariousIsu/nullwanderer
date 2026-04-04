/**
 * AURA NX-Alpha — DraftReview
 *
 * Modal overlay shown when the team delivers a draft via render_canvas.
 * Fetches the actual rendered artifact (HTML → iframe) from the backend
 * so the user can proof the final output before accepting or requesting changes.
 *
 * Actions:
 *   Accept        → push blocks onto canvas, dismiss
 *   Revise        → pre-fill chat with revision prompt, dismiss
 *   Improve Style → send to Interface agent for rewriting, dismiss
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './DraftReview.module.css';

const BACKEND = 'http://127.0.0.1:8000';

// Determine preview format from block types
function pickPreviewFormat(blocks) {
  const types = new Set(blocks.map(b => b.type));
  if (types.has('chart') && blocks.length <= 3) return 'html';
  return 'html'; // always use HTML for live preview; PDF/DOCX generated on export
}

export default function DraftReview({ draft, onAccept, onRevise, onImproveStyle, onDismiss }) {
  const [previewUrl,  setPreviewUrl]  = useState(null);
  const [loading,     setLoading]     = useState(true);
  const [loadError,   setLoadError]   = useState(null);
  const [reviseNote,  setReviseNote]  = useState('');
  const [showRevise,  setShowRevise]  = useState(false);
  const blobUrlRef  = useRef(null);
  const iframeRef   = useRef(null);

  const { blocks = [], title = 'Team Draft' } = draft ?? {};

  // ── Fetch preview HTML from backend ──────────────────────────────────────
  useEffect(() => {
    if (!blocks.length) return;
    setLoading(true);
    setLoadError(null);

    const format = pickPreviewFormat(blocks);

    fetch(`${BACKEND}/canvas/export`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ blocks, title, format }),
    })
      .then(async r => {
        if (!r.ok) throw new Error(`Export failed: ${r.status}`);
        const blob = await r.blob();
        // Revoke previous blob URL to avoid memory leak
        if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;
        setPreviewUrl(url);
        setLoading(false);
      })
      .catch(err => {
        setLoadError(err.message ?? 'Preview failed');
        setLoading(false);
      });

    return () => {
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
    };
  }, [blocks, title]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const handleAccept = useCallback(() => {
    onAccept?.(blocks);
  }, [blocks, onAccept]);

  const handleReviseSubmit = useCallback(() => {
    const note = reviseNote.trim();
    onRevise?.(note
      ? `Please revise the draft — "${title}" — with these changes: ${note}`
      : `Please revise the draft — "${title}".`
    );
  }, [reviseNote, title, onRevise]);

  const handleImproveStyle = useCallback(() => {
    onImproveStyle?.(blocks, title);
  }, [blocks, title, onImproveStyle]);

  const blockCount = blocks.length;

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Draft Review">
      <div className={styles.modal}>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.headerTag}>DRAFT READY</span>
            <span className={styles.headerTitle}>{title}</span>
            <span className={styles.headerMeta}>{blockCount} block{blockCount !== 1 ? 's' : ''}</span>
          </div>
          <button className={styles.dismissBtn} onClick={onDismiss} title="Dismiss (keep as pending)">✕</button>
        </div>

        {/* Preview area */}
        <div className={styles.previewArea}>
          {loading && (
            <div className={styles.loadingState}>
              <div className={styles.loadingSpinner} />
              <span className={styles.loadingText}>Rendering draft…</span>
            </div>
          )}
          {loadError && !loading && (
            <div className={styles.errorState}>
              <span className={styles.errorIcon}>⚠</span>
              <span className={styles.errorText}>{loadError}</span>
              <span className={styles.errorSub}>You can still accept or revise without preview.</span>
            </div>
          )}
          {previewUrl && !loading && (
            <iframe
              ref={iframeRef}
              className={styles.previewFrame}
              src={previewUrl}
              title="Draft preview"
              sandbox="allow-same-origin allow-scripts"
            />
          )}
        </div>

        {/* Revision note input (shown when Revise is clicked) */}
        {showRevise && (
          <div className={styles.reviseRow}>
            <textarea
              className={styles.reviseInput}
              placeholder="Describe the changes you want… (optional)"
              value={reviseNote}
              onChange={e => setReviseNote(e.target.value)}
              rows={2}
              autoFocus
            />
            <button className={styles.reviseSubmitBtn} onClick={handleReviseSubmit}>
              Send for Revisions
            </button>
            <button className={styles.reviseCancelBtn} onClick={() => setShowRevise(false)}>
              Cancel
            </button>
          </div>
        )}

        {/* Action bar */}
        {!showRevise && (
          <div className={styles.actionBar}>
            <button className={styles.actionAccept} onClick={handleAccept}>
              ✓ Accept
            </button>
            <button className={styles.actionRevise} onClick={() => setShowRevise(true)}>
              ↩ Revise
            </button>
            <button className={styles.actionImprove} onClick={handleImproveStyle}>
              ✦ Improve Style
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
