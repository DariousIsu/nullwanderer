/**
 * AURA NX-Alpha — DocumentFileBlock
 *
 * Canvas block for exported document files from CLI-Anything tools (LibreOffice, etc.).
 * Presents a download/open card — the file lives on the local filesystem.
 * Bible §34 — Sprint 2 (LibreOffice priority 1).
 *
 * PROPS:
 *   path       — Absolute local path to the file
 *   filename   — Display filename
 *   format     — 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'odt' | etc.
 *   size_kb    — File size in KB
 *   title      — Optional document title (from metadata)
 */

import styles from './DocumentFileBlock.module.css';

const FORMAT_ICONS = {
  docx:  '▤',
  xlsx:  '▦',
  pptx:  '▣',
  pdf:   '▧',
  odt:   '▤',
  ods:   '▦',
  odp:   '▣',
};

const DocumentFileBlock = ({
  path      = '',
  filename  = 'document',
  format    = 'docx',
  size_kb,
  title     = '',
}) => {
  const icon  = FORMAT_ICONS[format.toLowerCase()] ?? '▤';
  const label = title || filename;

  const handleOpen = () => {
    // In Electron context — open via IPC. In browser, no-op with log.
    if (typeof window !== 'undefined' && window.electronAPI?.openFile) {
      window.electronAPI.openFile(path);
    } else {
      console.info('[DocumentFileBlock] Open file:', path);
    }
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.iconCol} aria-hidden="true">{icon}</div>

      <div className={styles.info}>
        <div className={styles.label}>{label}</div>
        <div className={styles.meta}>
          <span className={styles.format}>{format.toUpperCase()}</span>
          {size_kb != null && (
            <span className={styles.size}>
              {size_kb >= 1024
                ? `${(size_kb / 1024).toFixed(1)} MB`
                : `${size_kb} KB`}
            </span>
          )}
        </div>
      </div>

      <button
        className={styles.openBtn}
        onClick={handleOpen}
        aria-label={`Open ${filename}`}
        disabled={!path}
      >
        Open
      </button>
    </div>
  );
};

export default DocumentFileBlock;
