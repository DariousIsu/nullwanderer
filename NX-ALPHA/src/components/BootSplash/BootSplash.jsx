/**
 * AURA NX-Alpha — Boot Splash Screen
 *
 * Full-screen validation UI shown before the main shell loads.
 * Connects to /boot/stream SSE and shows phased startup progress.
 *
 * PHASES:
 *   0: Foundation  — DB, memory, config
 *   1: Hardware    — GPU detection, hardware gate
 *   2: Model Gate  — user reviews/confirms models (CHECKPOINT)
 *   3: Services    — weather, finance, news, etc.
 *   4: Ready       — "Launch AURA" button
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import styles from './BootSplash.module.css';
import splashLogo from '../../../Futuristic AURA logo and energy burst.png';

const API_BASE = 'http://127.0.0.1:8000';

const STATUS_ICONS = {
  pending: '\u00B7',      // middle dot
  running: '\u25E6',      // white bullet (spinning handled by CSS)
  ok:      '\u2713',      // check
  warn:    '\u25B3',      // triangle
  error:   '\u2717',      // x
};

export default function BootSplash({ onLaunch }) {
  const [steps,        setSteps]        = useState([]);
  const [phase,        setPhase]        = useState(-1);
  const [modelGate,    setModelGate]    = useState(null);
  const [bootComplete, setBootComplete] = useState(false);
  const [confirming,   setConfirming]   = useState(false);
  const esRef       = useRef(null);
  const checklistRef = useRef(null);

  // ── Auto-scroll checklist to latest step ─────────────────────────────────
  useEffect(() => {
    const el = checklistRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps]);

  // ── Connect to boot SSE stream ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;

    async function waitForBackend() {
      while (!cancelled) {
        try {
          const res = await fetch(`${API_BASE}/boot/status`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            const data = await res.json();
            if (data.steps)               setSteps(data.steps);
            if (data.current_phase >= 0)  setPhase(data.current_phase);
            if (data.model_gate_proposal) setModelGate(data.model_gate_proposal);
            if (data.boot_complete)       setBootComplete(true);
            break;
          }
        } catch { /* not ready yet */ }
        await new Promise(r => { pollTimer = setTimeout(r, 2000); });
      }
      if (cancelled) return;
      openSSE();
    }

    function openSSE() {
      if (cancelled) return;
      const es = new EventSource(`${API_BASE}/boot/stream`);
      esRef.current = es;

      es.addEventListener('boot_step', (e) => {
        const data = JSON.parse(e.data);
        setSteps(prev => {
          const idx = prev.findIndex(s => s.name === data.name);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = data;
            return updated;
          }
          return [...prev, data];
        });
      });

      es.addEventListener('boot_phase', (e) => {
        const data = JSON.parse(e.data);
        if (data.status === 'complete' || data.status === 'started') setPhase(data.phase);
      });

      es.addEventListener('model_gate',    (e) => setModelGate(JSON.parse(e.data)));
      es.addEventListener('boot_complete', ()  => setBootComplete(true));

      es.addEventListener('boot_state', (e) => {
        const data = JSON.parse(e.data);
        if (data.steps)               setSteps(data.steps);
        if (data.current_phase >= 0)  setPhase(data.current_phase);
        if (data.model_gate_proposal) setModelGate(data.model_gate_proposal);
        if (data.boot_complete)       setBootComplete(true);
      });
    }

    waitForBackend();
    return () => {
      cancelled = true;
      clearTimeout(pollTimer);
      if (esRef.current) esRef.current.close();
    };
  }, []);

  // ── Confirm models ────────────────────────────────────────────────────────
  const handleConfirm = useCallback(async () => {
    setConfirming(true);
    try {
      await fetch(`${API_BASE}/boot/confirm-models`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({}),
      });
    } catch (err) {
      console.error('[BootSplash] confirm failed:', err);
    }
    setConfirming(false);
  }, []);

  // ── Launch AURA ───────────────────────────────────────────────────────────
  const handleLaunch = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/boot/launch`, { method: 'POST' });
    } catch (err) {
      console.error('[BootSplash] launch failed:', err);
    }
    if (onLaunch) onLaunch();
  }, [onLaunch]);

  // ── Derive display ────────────────────────────────────────────────────────
  const bestGpu  = modelGate?.best_gpu;
  const proposed = modelGate?.proposed;
  const mode     = modelGate?.mode;
  const vram     = modelGate?.vram_total_mb;

  const waitingForConfirm = modelGate && !confirming && phase === 2 &&
    steps.every(s => s.name !== 'Load Interface Engine' || s.status === 'pending');

  return (
    <div className={styles.splash}>
      <div className={styles.container}>

        {/* ── Pinned header ── */}
        <div className={styles.header}>
          <img src={splashLogo} className={styles.splashLogo} alt="AURA" />
          <div className={styles.subtitle}>NX-Alpha Boot Sequence</div>
        </div>

        {/* ── Scrollable checklist ── */}
        <ul className={styles.checklist} ref={checklistRef}>
          {steps.map((step, i) => (
            <li key={step.name + i} className={styles.step} data-status={step.status}>
              <span className={`${styles.stepIcon} ${step.status === 'running' ? styles.spinner : ''}`}>
                {STATUS_ICONS[step.status] || STATUS_ICONS.pending}
              </span>
              <span className={styles.stepName}>{step.name}</span>
              {step.message && (
                <span className={styles.stepMessage} title={step.message}>
                  {step.message}
                </span>
              )}
            </li>
          ))}
        </ul>

        {/* ── Pinned footer: gate / status / launch ── */}
        <div className={styles.footer}>

          {/* Model Gate checkpoint */}
          {waitingForConfirm && modelGate && (
            <div className={styles.modelGate}>
              <div className={styles.modelGateTitle}>Model Configuration</div>

              {bestGpu && (
                <div className={styles.modelCard}>
                  <div className={styles.modelRole}>GPU</div>
                  <div className={styles.modelName}>{bestGpu.name}</div>
                  <div className={styles.modelMeta}>
                    {bestGpu.vendor} &middot; {Math.round(bestGpu.vram_total_mb / 1024)} GB VRAM
                    &middot; Mode: {mode}
                    {bestGpu.has_live_metrics && bestGpu.temp_c > 0 && ` \u00B7 ${bestGpu.temp_c}\u00B0C`}
                  </div>
                </div>
              )}

              {proposed?.interface && (
                <div className={styles.modelCard}>
                  <div className={styles.modelRole}>Interface Engine</div>
                  <div className={styles.modelName}>{proposed.interface.name}</div>
                  <div className={styles.modelMeta}>Always loaded &middot; llama-cpp-python</div>
                </div>
              )}

              {proposed?.workhorse && (
                <div className={styles.modelCard}>
                  <div className={styles.modelRole}>Workhorse</div>
                  <div className={styles.modelName}>{proposed.workhorse.name}</div>
                  <div className={styles.modelMeta}>Loads on demand &middot; Ollama</div>
                </div>
              )}

              <div className={styles.actions}>
                <button
                  className={styles.btnPrimary}
                  onClick={handleConfirm}
                  disabled={confirming}
                >
                  {confirming ? 'Loading...' : 'Accept & Load'}
                </button>
              </div>
            </div>
          )}

          {/* Loading models indicator */}
          {confirming && (
            <div className={styles.phaseLabel}>Loading models to GPU...</div>
          )}

          {/* Ready state */}
          {bootComplete && (
            <>
              <div className={styles.readyMessage}>All systems verified</div>
              <div className={styles.actions}>
                <button className={styles.btnPrimary} onClick={handleLaunch}>
                  Launch AURA
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}
