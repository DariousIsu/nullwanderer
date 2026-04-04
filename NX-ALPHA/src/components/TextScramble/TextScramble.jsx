/**
 * AURA NX-Alpha — TextScramble
 *
 * Streaming: GSAP ticker drives the scramble frontier as tokens arrive.
 * Post-stream: GSAP tween (power2.out) runs a full scramble reveal over
 *              the final text, then hands off to ReactMarkdown.
 *
 * Props:
 *   text        — the full current string (grows as tokens arrive)
 *   isStreaming — true while the SSE stream is active
 */

import { useState, useEffect, useRef } from 'react';
import { gsap } from 'gsap';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './TextScramble.module.css';

const GLYPHS = '!<>-_\\/[]{}—=+*^?#@$%∂≈Ω░▒';

const randomGlyph = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

const buildScrambled = (text, resolvedCount) => {
  const stable   = text.slice(0, resolvedCount);
  const frontier = text.length - resolvedCount;
  let noise = '';
  for (let i = 0; i < frontier; i++) noise += randomGlyph();
  return stable + noise;
};

// ─────────────────────────────────────────────────────────────────────────────

const TextScramble = ({ text, isStreaming }) => {
  const [display,  setDisplay]  = useState(text);
  const [revealed, setRevealed] = useState(!isStreaming);

  // Refs so GSAP callbacks always see current values
  const textRef       = useRef(text);
  const resolvedRef   = useRef(isStreaming ? 0 : text.length);
  const tickerFnRef   = useRef(null);
  const tweenRef      = useRef(null);
  const prevStreaming  = useRef(isStreaming);

  textRef.current = text;

  // ── Streaming: GSAP ticker advances the scramble frontier ──────────────
  useEffect(() => {
    if (!isStreaming) return;

    const tick = () => {
      const t        = textRef.current;
      const resolved = resolvedRef.current;

      if (resolved < t.length && Math.random() > 0.6) {
        resolvedRef.current = Math.min(resolved + 1, t.length);
      }

      setDisplay(buildScrambled(t, resolvedRef.current));
    };

    gsap.ticker.add(tick);
    tickerFnRef.current = tick;

    return () => {
      gsap.ticker.remove(tick);
      tickerFnRef.current = null;
    };
  }, [isStreaming]);

  // ── Transition: streaming ended → scramble reveal → ReactMarkdown ───────
  useEffect(() => {
    const wasStreaming = prevStreaming.current;
    prevStreaming.current = isStreaming;

    if (!wasStreaming || isStreaming) return; // only fires on true → false

    // Stop streaming ticker if still running
    if (tickerFnRef.current) {
      gsap.ticker.remove(tickerFnRef.current);
      tickerFnRef.current = null;
    }

    setRevealed(false);

    const finalText = textRef.current;
    const obj = { progress: 0 };

    tweenRef.current = gsap.to(obj, {
      progress: 1,
      duration: 0.7,
      ease: 'power2.out',
      onUpdate() {
        const resolved = Math.floor(obj.progress * finalText.length);
        setDisplay(buildScrambled(finalText, resolved));
      },
      onComplete() {
        setRevealed(true);
      },
    });

    return () => {
      tweenRef.current?.kill();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);

  // ── Render ───────────────────────────────────────────────────────────────
  if (isStreaming) {
    return <span>{display || text}</span>;
  }

  if (!revealed) {
    return <span>{display || text}</span>;
  }

  return (
    <div className={styles.md}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {text}
      </ReactMarkdown>
    </div>
  );
};

export default TextScramble;
