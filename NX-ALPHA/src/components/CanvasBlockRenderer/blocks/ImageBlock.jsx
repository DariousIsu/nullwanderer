/**
 * ImageBlock — constrained image with optional caption.
 * Falls back to a placeholder graphic if src is empty or fails to load.
 *
 * Data shape: { src?: string, alt?: string, caption?: string }
 */
import { useState } from 'react';
import styles from './blocks.module.css';

const ImageBlock = ({ src = '', alt = 'Image', caption = '' }) => {
  const [error, setError] = useState(false);

  return (
    <div className={styles.root} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className={styles.imageWrap}>
        {src && !error ? (
          <img
            src={src}
            alt={alt}
            className={styles.imageEl}
            onError={() => setError(true)}
            draggable={false}
          />
        ) : (
          /* Placeholder graphic when no src or load error */
          <div
            className={styles.imageEl}
            style={{
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              flexDirection:  'column',
              gap:            8,
              color:          'var(--text-tertiary)',
              fontFamily:     'var(--font-condensed)',
              fontSize:       10,
              letterSpacing:  '0.10em',
              textTransform:  'uppercase',
              flex:           1,
            }}
          >
            {/* Simple placeholder icon */}
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <rect x="2" y="2" width="28" height="28" rx="2" stroke="currentColor" strokeWidth="1.5" />
              <circle cx="10" cy="11" r="3" stroke="currentColor" strokeWidth="1.5" />
              <path d="M2 22l8-6 6 5 4-4 10 9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            {error ? 'Failed to load' : 'No image'}
          </div>
        )}
        {caption && (
          <span className={styles.imageCaption}>{caption}</span>
        )}
      </div>
    </div>
  );
};

export default ImageBlock;
