/**
 * AURA NX-Alpha — AuraIndicator
 *
 * Represents Aura's live presence state. The only "personality" visual element
 * in the system. Lives in the command center and the chat panel header.
 *
 * STATES:
 *   idle       — Static dot. Aura is available but not active.
 *   listening  — Pulsing dot. Aura is receiving input.
 *   thinking   — Three-dot sequence. Aura is processing.
 *   responding — VU bars. Aura is generating/speaking output.
 *
 * ANIMATIONS:
 *   CSS   — ambient, per-state animations (pulse, think dots, VU bars)
 *   GSAP  — transitions between states (fade out current, fade in next)
 *
 * AUDIO UPGRADE (optional):
 *   Pass `audioData` (Float32Array from Web Audio API analyser) to drive
 *   the VU bars in responding state from real audio levels.
 *   Without it, bars use the CSS fallback animation.
 *
 * USAGE:
 *   <AuraIndicator status="thinking" />
 *   <AuraIndicator status="responding" showLabel size="sm" />
 *   <AuraIndicator status="responding" audioData={analyserData} />
 */

import { useRef, useEffect, useState, useCallback } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap }    from '../../core/animations';
import styles      from './AuraIndicator.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABELS = {
  idle:       'idle',
  listening:  'listening',
  thinking:   'thinking',
  responding: 'responding',
};

// VU bar count and their CSS animation delays (staggered for natural feel)
const VU_BARS = [
  { delay: '0s',     initHeight: '45%' },
  { delay: '0.2s',   initHeight: '70%' },
  { delay: '0.05s',  initHeight: '30%' },
  { delay: '0.35s',  initHeight: '85%' },
  { delay: '0.15s',  initHeight: '55%' },
];

// ─────────────────────────────────────────────────────────────────────────────
// STATE VISUALS — rendered per status
// ─────────────────────────────────────────────────────────────────────────────

const IdleDot = () => (
  <div className={styles.dotIdle} aria-hidden="true" />
);

const ListeningDot = () => (
  <div className={styles.dotListening} aria-hidden="true" />
);

const ThinkingDots = () => (
  <div className={styles.thinkWrap} aria-hidden="true">
    <div className={styles.thinkDot} />
    <div className={styles.thinkDot} />
    <div className={styles.thinkDot} />
  </div>
);

/**
 * VU bars — CSS animated by default.
 * When audioData (Float32Array) is provided, bar heights are driven by real levels.
 */
const VuBars = ({ audioData, vuBarRefs }) => (
  <div className={styles.vuWrap} aria-hidden="true">
    {VU_BARS.map((bar, i) => (
      <div
        key={i}
        ref={el => { if (vuBarRefs) vuBarRefs.current[i] = el; }}
        className={styles.vuBar}
        style={{
          animationDelay:    audioData ? 'none' : bar.delay,
          animationPlayState: audioData ? 'paused' : 'running',
          height:            bar.initHeight,
        }}
      />
    ))}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {'idle'|'listening'|'thinking'|'responding'} status
 * @param {boolean}    showLabel  - Show the text state label (default false)
 * @param {'sm'|undefined} size   - 'sm' for chat header use
 * @param {Float32Array}   audioData - Optional: Web Audio analyser data for live VU
 * @param {string}     className  - Additional classes
 */
const AuraIndicator = ({
  status    = 'idle',
  showLabel = false,
  size,
  audioData,
  className,
}) => {
  const rootRef      = useRef(null);
  const stateRef     = useRef(null);
  const labelRef     = useRef(null);
  const vuBarRefs    = useRef([]);
  const animFrameRef = useRef(null);

  // Internal display state — GSAP transitions between these
  const [displayStatus, setDisplayStatus] = useState(status);

  // ── STATE TRANSITION via GSAP ──
  useEffect(() => {
    if (status === displayStatus) return;
    if (!stateRef.current) { setDisplayStatus(status); return; }

    const tl = gsap.timeline();
    tl.to(stateRef.current, {
      opacity:  0,
      scale:    0.85,
      duration: 0.1,
      ease:     'power2.in',
    })
    .call(() => setDisplayStatus(status))
    .to(stateRef.current, {
      opacity:  1,
      scale:    1,
      duration: 0.18,
      ease:     'status-change',
    });

    if (labelRef.current && showLabel) {
      gsap.to(labelRef.current, {
        opacity:  0,
        duration: 0.08,
        onComplete: () => {
          gsap.to(labelRef.current, { opacity: 1, duration: 0.15 });
        },
      });
    }

    return () => tl.kill();
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── WEB AUDIO VU BARS (when audioData provided) ──
  const driveVuFromAudio = useCallback(() => {
    if (!audioData || displayStatus !== 'responding') return;

    const bars = vuBarRefs.current;
    const step = Math.floor(audioData.length / VU_BARS.length);

    bars.forEach((bar, i) => {
      if (!bar) return;
      // Average a slice of frequency data for this bar
      const start = i * step;
      const slice = audioData.slice(start, start + step);
      const avg   = slice.reduce((a, b) => a + b, 0) / slice.length;
      // Map 0-255 to 15%-95% height, with some minimum so bars are never flat
      const pct   = Math.max(15, Math.min(95, (avg / 255) * 95));
      bar.style.height = `${pct}%`;
    });

    animFrameRef.current = requestAnimationFrame(driveVuFromAudio);
  }, [audioData, displayStatus]);

  useEffect(() => {
    if (audioData && displayStatus === 'responding') {
      animFrameRef.current = requestAnimationFrame(driveVuFromAudio);
    }
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [audioData, displayStatus, driveVuFromAudio]);

  // ── RENDER STATE VISUAL ──
  const renderStateVisual = () => {
    switch (displayStatus) {
      case 'listening':  return <ListeningDot />;
      case 'thinking':   return <ThinkingDots />;
      case 'responding': return <VuBars audioData={audioData} vuBarRefs={vuBarRefs} />;
      case 'idle':
      default:           return <IdleDot />;
    }
  };

  const isActive = displayStatus !== 'idle';

  const rootClass = [
    styles.indicator,
    size === 'sm' && styles.sm,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div
      ref={rootRef}
      className={rootClass}
      role="status"
      aria-label={`Aura is ${STATUS_LABELS[displayStatus] ?? displayStatus}`}
      aria-live="polite"
    >
      <div ref={stateRef} className={styles.stateWrap}>
        {renderStateVisual()}
      </div>

      {showLabel && (
        <span
          ref={labelRef}
          className={`${styles.label} ${isActive ? styles.labelActive : ''}`}
        >
          {STATUS_LABELS[displayStatus] ?? displayStatus}
        </span>
      )}
    </div>
  );
};

export default AuraIndicator;
