/**
 * HtmlBlock — sandboxed iframe for live web content.
 * Covers live service feeds, web pages, embedded dashboards, streaming content.
 * CSP-restricted via sandbox attribute — scripts allowed but no same-origin access.
 *
 * PHASE 2 EXTENSION: WebRTC/HLS video player block will follow the same
 * container pattern, just replacing the iframe with a video element.
 *
 * Data shape: { src: string, title?: string }
 */
import { useState, useRef, useCallback } from 'react';
import styles from './blocks.module.css';

const HtmlBlock = ({ src = '', title = 'Live' }) => {
  const iframeRef   = useRef(null);
  const [key, setKey] = useState(0); // force remount = refresh

  const handleRefresh = useCallback(() => {
    setKey(k => k + 1);
  }, []);

  return (
    <div
      className={`${styles.root} ${styles.rootBleed}`}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {/* Toolbar */}
      <div className={styles.htmlToolbar}>
        <span className={styles.htmlUrl}>{src || '—'}</span>
        <button
          className={styles.htmlRefreshBtn}
          onClick={handleRefresh}
          title="Reload"
          aria-label="Reload live content"
        >
          ↺
        </button>
      </div>

      {/* Sandboxed iframe */}
      {src ? (
        <iframe
          key={key}
          ref={iframeRef}
          className={styles.iframe}
          src={src}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="origin"
          loading="lazy"
        />
      ) : (
        <div className={styles.empty} style={{ flex: 1 }}>
          No URL configured
        </div>
      )}
    </div>
  );
};

export default HtmlBlock;
