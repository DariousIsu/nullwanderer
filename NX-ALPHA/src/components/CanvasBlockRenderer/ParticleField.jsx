/**
 * AURA NX-Alpha — ParticleField
 *
 * The canvas idle state. When no blocks are on the canvas, a faint amber
 * particulate field fills the work surface — dormant programmable matter
 * waiting to organize.
 *
 * ~180 nanite-particles drift with Brownian motion. Very subtle opacity
 * (0.03–0.15). When blocks are present, particles dim to ~30% to cede
 * visual priority to the content.
 *
 * Also renders a slow scan line that sweeps top→bottom every ~5 seconds,
 * suggesting the canvas is alive and monitoring.
 *
 * PERFORMANCE:
 *   Uses a single 2D canvas element with requestAnimationFrame.
 *   ResizeObserver handles layout changes. Cleanup on unmount.
 *   CSS handles the scan line (no GSAP needed for continuous ambient motion).
 */

import { useRef, useEffect } from 'react';
import styles from './ParticleField.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const PARTICLE_COUNT = 178;
const AMBER_R = 240;
const AMBER_G = 168;
const AMBER_B = 48;

// ─────────────────────────────────────────────────────────────────────────────
// PARTICLE FIELD
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {boolean} dimmed - When true, particle opacity drops to 30% (blocks present)
 */
const ParticleField = ({ dimmed = false }) => {
  const canvasRef  = useRef(null);
  const dimmedRef  = useRef(dimmed);
  const animIdRef  = useRef(null);

  // Keep dimmedRef in sync without re-running the particle loop
  useEffect(() => {
    dimmedRef.current = dimmed;
  }, [dimmed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // ── Build particles ──
    let width  = 0;
    let height = 0;

    const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
      x:           Math.random(),   // stored as fraction [0,1] — scaled on draw
      y:           Math.random(),
      size:        Math.random() * 1.3 + 0.4,
      baseOpacity: Math.random() * 0.11 + 0.03,
      dx:          (Math.random() - 0.5) * 0.22,
      dy:          (Math.random() - 0.5) * 0.22,
      wobble:      Math.random() * Math.PI * 2,
      wobbleSpeed: 0.003 + Math.random() * 0.007,
    }));

    // ── Resize handler ──
    function resize() {
      const parent = canvas.parentElement;
      if (!parent) return;
      width          = parent.offsetWidth;
      height         = parent.offsetHeight;
      canvas.width   = width;
      canvas.height  = height;
    }

    const ro = new ResizeObserver(resize);
    ro.observe(canvas.parentElement ?? document.body);
    resize();

    // ── Draw loop ──
    function draw() {
      if (!width || !height) {
        animIdRef.current = requestAnimationFrame(draw);
        return;
      }

      ctx.clearRect(0, 0, width, height);
      const dimFactor = dimmedRef.current ? 0.28 : 1.0;

      for (const p of particles) {
        p.wobble += p.wobbleSpeed;
        // Convert fractional position to pixel, apply drift + wobble
        const px = p.x * width  + Math.sin(p.wobble) * 0.7;
        const py = p.y * height + Math.cos(p.wobble * 0.6) * 0.7;

        // Advance fractional position
        p.x += p.dx / width;
        p.y += p.dy / height;

        // Wrap at edges
        if (p.x < 0) p.x = 1;
        if (p.x > 1) p.x = 0;
        if (p.y < 0) p.y = 1;
        if (p.y > 1) p.y = 0;

        const alpha = p.baseOpacity * dimFactor;
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${AMBER_R},${AMBER_G},${AMBER_B},${alpha})`;
        ctx.fill();
      }

      animIdRef.current = requestAnimationFrame(draw);
    }

    draw();

    return () => {
      if (animIdRef.current) cancelAnimationFrame(animIdRef.current);
      ro.disconnect();
    };
  }, []); // run once — dimmedRef keeps opacity in sync reactively

  return (
    <div className={styles.root} aria-hidden="true">
      <canvas ref={canvasRef} className={styles.canvas} />
      <div className={styles.scanLine} />
    </div>
  );
};

export default ParticleField;
