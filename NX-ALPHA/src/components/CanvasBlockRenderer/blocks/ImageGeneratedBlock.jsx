/**
 * AURA NX-Alpha — ImageGeneratedBlock
 *
 * Canvas block for AI-generated images from CLI-Anything image generation tools.
 * Bible §34 — Sprint 3 CLI toolchain.
 *
 * PROPS:
 *   src        — URL or data-URI of the generated image
 *   alt        — Accessible description / prompt summary
 *   prompt     — Full generation prompt (shown in tooltip / expand)
 *   model      — Model used (e.g. 'stable-diffusion', 'flux')
 *   width      — Original image width
 *   height     — Original image height
 */

import { useState } from 'react';
import styles from './ImageGeneratedBlock.module.css';

const ImageGeneratedBlock = ({
  src    = null,
  alt    = 'Generated image',
  prompt = '',
  model  = '',
  width,
  height,
}) => {
  const [showPrompt, setShowPrompt] = useState(false);

  if (!src) {
    return (
      <div className={styles.placeholder}>
        <span className={styles.icon} aria-hidden="true">⬡</span>
        <span className={styles.label}>Image — generating…</span>
      </div>
    );
  }

  const aspectStyle = (width && height)
    ? { aspectRatio: `${width} / ${height}` }
    : {};

  return (
    <div className={styles.wrap}>
      <div className={styles.imgFrame} style={aspectStyle}>
        <img src={src} alt={alt} className={styles.img} />
      </div>

      <div className={styles.footer}>
        {model && <span className={styles.badge}>{model}</span>}
        {prompt && (
          <button
            className={styles.promptBtn}
            onClick={() => setShowPrompt(p => !p)}
            aria-expanded={showPrompt}
          >
            {showPrompt ? 'Hide prompt' : 'Show prompt'}
          </button>
        )}
      </div>

      {showPrompt && prompt && (
        <div className={styles.promptText}>{prompt}</div>
      )}
    </div>
  );
};

export default ImageGeneratedBlock;
