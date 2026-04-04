/**
 * AURA NX-Alpha — BrowserSnapshotBlock (Phase 9)
 *
 * Displays a PNG screenshot of a URL taken by the backend's Playwright
 * screenshot service. Bypasses X-Frame-Options — no embedding, just a capture.
 *
 * Click the image to open the live URL in the default browser.
 *
 * Data shape:
 *   {
 *     image_b64: string,   // base64-encoded PNG from /media/screenshot
 *     url:       string,   // source URL (shown in address bar + used for click-through)
 *   }
 */
import styles from './blocks.module.css';

const BrowserSnapshotBlock = ({ image_b64 = '', url = '' }) => (
  <div className={styles.root} style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
    {/* ── Address bar ── */}
    <div style={{
      padding:         '4px 10px',
      background:      'var(--surface-2, rgba(255,255,255,0.04))',
      borderBottom:    '1px solid var(--border, rgba(255,255,255,0.08))',
      fontFamily:      'var(--font-condensed, monospace)',
      fontSize:        10,
      letterSpacing:   '0.06em',
      color:           'var(--text-muted, rgba(255,255,255,0.45))',
      whiteSpace:      'nowrap',
      overflow:        'hidden',
      textOverflow:    'ellipsis',
      flexShrink:      0,
    }}>
      {url || '—'}
    </div>

    {/* ── Screenshot ── */}
    <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
      {image_b64 ? (
        <img
          src={`data:image/png;base64,${image_b64}`}
          alt={`Screenshot of ${url}`}
          draggable={false}
          title="Click to open in browser"
          onClick={() => url && window.open(url, '_blank', 'noopener,noreferrer')}
          style={{
            width:     '100%',
            height:    '100%',
            objectFit: 'cover',
            display:   'block',
            cursor:    url ? 'pointer' : 'default',
          }}
        />
      ) : (
        <div style={{
          width:          '100%',
          height:         '100%',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          color:          'var(--text-muted, rgba(255,255,255,0.3))',
          fontFamily:     'var(--font-condensed, monospace)',
          fontSize:       10,
          letterSpacing:  '0.10em',
          textTransform:  'uppercase',
        }}>
          No screenshot
        </div>
      )}
    </div>
  </div>
);

export default BrowserSnapshotBlock;
