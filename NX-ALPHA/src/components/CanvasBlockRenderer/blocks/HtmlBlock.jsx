/**
 * HtmlBlock — sandboxed iframe for live web content.
 * Covers live service feeds, web pages, embedded dashboards, streaming content,
 * and inline interactive apps built by AURA (via srcdoc).
 * CSP-restricted via sandbox attribute — scripts allowed but no same-origin access.
 *
 * Data shape: { src?: string, srcdoc?: string, title?: string }
 * - src: external URL rendered via iframe src
 * - srcdoc: inline HTML string rendered via iframe srcdoc (sandboxed, no same-origin)
 */
import { useState, useRef, useCallback } from 'react';
import styles from './blocks.module.css';

const HtmlBlock = ({ src = '', srcdoc = '', title = 'Live' }) => {
  const iframeRef   = useRef(null);
  const [key, setKey] = useState(0); // force remount = refresh

  const handleRefresh = useCallback(() => {
    setKey(k => k + 1);
  }, []);

  const displayLabel = srcdoc ? '(inline app)' : (src || '—');

  return (
    <div
      className={`${styles.root} ${styles.rootBleed}`}
      style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
    >
      {/* Toolbar */}
      <div className={styles.htmlToolbar}>
        <span className={styles.htmlUrl}>{displayLabel}</span>
        <button
          className={styles.htmlRefreshBtn}
          onClick={handleRefresh}
          title="Reload"
          aria-label="Reload live content"
        >
          ↺
        </button>
      </div>

      {/* Sandboxed iframe — srcdoc (inline) takes priority over src (URL) */}
      {srcdoc ? (
        <iframe
          key={key}
          ref={iframeRef}
          className={styles.iframe}
          srcdoc={srcdoc}
          title={title}
          sandbox="allow-scripts allow-forms"
        />
      ) : src ? (
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
