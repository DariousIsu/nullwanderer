/**
 * AURA NX-Alpha — DiagramBlock
 *
 * Canvas block for rendered diagrams (Graphviz, Mermaid) produced by CLI-Anything tools.
 * Bible §34 — Sprint 3 CLI toolchain.
 *
 * PROPS:
 *   src        — URL or data-URI of rendered diagram image
 *   alt        — Accessible description
 *   format     — 'svg' | 'png' (default 'svg')
 *   title      — Optional diagram title
 *   source     — Optional: 'graphviz' | 'mermaid' — shown as badge
 */

import styles from './DiagramBlock.module.css';

const DiagramBlock = ({
  src    = null,
  alt    = 'Diagram',
  format = 'svg',
  title  = '',
  source = '',
}) => {
  if (!src) {
    return (
      <div className={styles.placeholder}>
        <span className={styles.icon} aria-hidden="true">◈</span>
        <span className={styles.label}>Diagram — no source provided</span>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      {title && <div className={styles.title}>{title}</div>}
      <div className={styles.frame}>
        {format === 'svg' ? (
          <img src={src} alt={alt} className={styles.svg} />
        ) : (
          <img src={src} alt={alt} className={styles.img} />
        )}
      </div>
      {source && (
        <div className={styles.badge}>{source.toUpperCase()}</div>
      )}
    </div>
  );
};

export default DiagramBlock;
