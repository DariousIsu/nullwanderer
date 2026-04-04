/**
 * AURA NX-Alpha — AuraCanvas
 *
 * Visual display surface in the portrait mode popout.
 * AURA renders illustrations, charts, and visuals here
 * via canvas_render SSE events.
 *
 * Also accepts file drag-and-drop (images). Dropped files are displayed
 * immediately and POSTed to /canvas/image for AURA vision analysis —
 * matching the behaviour of the main workspace canvas.
 *
 * Props:
 *   content — null | { type: 'html'|'image'|'text'|'svg', payload: string }
 */

import { useState, useCallback } from 'react';
import styles from './AuraCanvas.module.css';
import { MAX_FILE_SIZE, isImageFile, isDocumentFile, uploadImage, uploadDocument } from '../../utils/canvasDrop';

const BACKEND = 'http://localhost:8000';

const AuraCanvas = ({ content }) => {
  const [dragOver,    setDragOver]    = useState(false);
  const [localImage,  setLocalImage]  = useState(null); // data URI from a dropped image
  const [localFile,   setLocalFile]   = useState(null); // { name, size } badge for dropped docs

  // SSE content from AURA takes priority over locally-dropped content
  const displayContent = content
    ?? (localImage ? { type: 'image', payload: localImage } : null)
    ?? (localFile  ? { type: 'file',  payload: localFile  } : null);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    // Only clear if leaving the canvas root, not a child element
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);

    // Accept the first accepted file (canvas is a single display surface)
    const file = Array.from(e.dataTransfer.files).find(f => isImageFile(f) || isDocumentFile(f));
    if (!file) return;

    if (file.size > MAX_FILE_SIZE) {
      console.warn(`[AuraCanvas] Skipped "${file.name}" — exceeds 100 MB limit`);
      return;
    }

    if (isImageFile(file)) {
      uploadImage(file, BACKEND).then((dataUri) => {
        setLocalImage(dataUri);
        setLocalFile(null);
      });
    } else {
      setLocalFile({ name: file.name, size: file.size });
      setLocalImage(null);
      uploadDocument(file, BACKEND);
    }
  }, []);

  return (
    <div
      className={[styles.canvas, dragOver && styles.dragOver].filter(Boolean).join(' ')}
      data-canvas
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {!displayContent ? (
        <div className={styles.idle}>
          <span className={styles.idleLabel}>canvas</span>
          <span className={styles.idleHint}>drop file</span>
        </div>
      ) : (
        <div className={styles.contentWrap}>
          {displayContent.type === 'html' && (
            <iframe
              className={styles.frame}
              srcDoc={displayContent.payload}
              sandbox="allow-scripts"
              title="AURA canvas output"
            />
          )}
          {displayContent.type === 'svg' && (
            <div
              className={styles.svgWrap}
              dangerouslySetInnerHTML={{ __html: displayContent.payload }}
            />
          )}
          {displayContent.type === 'image' && (
            <img
              className={styles.image}
              src={displayContent.payload}
              alt="AURA visual output"
            />
          )}
          {displayContent.type === 'text' && (
            <pre className={styles.text}>{displayContent.payload}</pre>
          )}
          {displayContent.type === 'file' && (
            <pre className={styles.text}>
              {`FILE: ${displayContent.payload.name}\nSIZE: ${(displayContent.payload.size / 1024).toFixed(1)} KB\n\nSent to AURA for analysis.`}
            </pre>
          )}
        </div>
      )}

      {/* Drag-over overlay */}
      {dragOver && (
        <div className={styles.dropOverlay}>
          <span className={styles.dropLabel}>drop file</span>
        </div>
      )}
    </div>
  );
};

export default AuraCanvas;
