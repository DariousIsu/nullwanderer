/**
 * AURA NX-Alpha — FileBlock
 *
 * Canvas block for documents dropped onto the canvas.
 * Displays a file badge with name, size, format, and ingestion status.
 * Created immediately on drop — file is uploaded to backend memory in background.
 *
 * PROPS:
 *   name     — Original filename (e.g. "report.pdf")
 *   size     — File size in bytes
 *   mimeType — MIME type string (e.g. "application/pdf")
 */

import styles from './FileBlock.module.css';

const MIME_FORMAT = {
  'application/pdf':                                                      'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':       'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/msword':                                                   'DOC',
  'application/vnd.oasis.opendocument.text':                              'ODT',
  'application/vnd.oasis.opendocument.spreadsheet':                       'ODS',
  'application/vnd.oasis.opendocument.presentation':                      'ODP',
  'text/plain':                                                           'TXT',
  'text/markdown':                                                        'MD',
  'text/csv':                                                             'CSV',
  'application/json':                                                     'JSON',
  'text/html':                                                            'HTML',
  'application/xml':                                                      'XML',
  'text/xml':                                                             'XML',
};

const FORMAT_ICONS = {
  PDF:  '▧',
  DOCX: '▤',
  DOC:  '▤',
  XLSX: '▦',
  PPTX: '▣',
  ODT:  '▤',
  ODS:  '▦',
  ODP:  '▣',
};

function getFormat(mimeType, name) {
  if (MIME_FORMAT[mimeType]) return MIME_FORMAT[mimeType];
  // Fallback: derive from file extension
  const ext = name.split('.').pop()?.toUpperCase();
  return ext || 'FILE';
}

function formatSize(bytes) {
  if (bytes == null) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024)        return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

const FileBlock = ({
  name     = 'file',
  size,
  mimeType = '',
}) => {
  const format = getFormat(mimeType, name);
  const icon   = FORMAT_ICONS[format] ?? '▤';

  return (
    <div className={styles.wrap}>
      <div className={styles.iconCol} aria-hidden="true">{icon}</div>

      <div className={styles.info}>
        <div className={styles.label}>{name}</div>
        <div className={styles.meta}>
          <span className={styles.format}>{format}</span>
          {size != null && (
            <span className={styles.size}>{formatSize(size)}</span>
          )}
        </div>
      </div>

      <span className={styles.status}>INGESTED</span>
    </div>
  );
};

export default FileBlock;
