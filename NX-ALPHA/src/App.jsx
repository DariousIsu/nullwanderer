/**
 * AURA NX-Alpha — App
 *
 * Root application component. Sits between main.jsx (React mount) and
 * CommandCenter (full application shell).
 *
 * Responsibilities:
 *   1. Environment detection — dev vs prod, Electron vs browser.
 *   2. Stream URL resolution — IPC in Electron, env var in browser.
 *   3. Mock SSE injection — dev mode substitutes MockEventSource
 *      so the full UI pipeline can be exercised without a backend.
 *   4. Active-sequence selection — expose a dev utility to switch
 *      between DEMO / WARNING / CANVAS / TOKEN sequences at runtime
 *      via the console (window.__aura_setSequence).
 *
 * CommandCenter receives `streamUrl` and `eventSourceFactory` and
 * internally runs `useAuraStream`, wiring all 26 SSE event types (§10)
 * to their respective UI handlers (canvas, warning popup, agent monitor,
 * chat sidebar, study progress, storage governor).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENVIRONMENT VARIABLES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   VITE_STREAM_URL   — Backend SSE endpoint URL (browser / non-Electron dev).
 *                       Defaults to http://localhost:8000/stream.
 *                       Not used when running in Electron (resolved via IPC).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEV CONSOLE UTILITIES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   window.__aura_setSequence('demo')     → full demo sequence (default)
 *   window.__aura_setSequence('warning')  → warning popup variants only
 *   window.__aura_setSequence('canvas')   → canvas blocks only
 *   window.__aura_setSequence('token')    → rapid token stream only
 *   window.__aura_setSequence('none')     → no auto-play (keep SSE idle)
 *
 *   After calling, close and re-open the app or call window.__aura_reload()
 *   to restart the stream with the new sequence.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

import CommandCenter from './components/CommandCenter/CommandCenter';
import PopOutShell from './components/PopOutShell/PopOutShell';
import BootSplash from './components/BootSplash/BootSplash';
import TheatreShell from './components/TheatreShell/TheatreShell';
import {
  createMockFactory,
  DEMO_SEQUENCE,
  WARNING_SEQUENCE,
  CANVAS_SEQUENCE,
  TOKEN_SEQUENCE,
} from './hooks/mockStream';

// ─────────────────────────────────────────────────────────────────────────────
// POP-OUT DETECTION
// Pop-out windows are opened with ?panel=<panelId> in the URL.
// If the param is present this renderer is a pop-out, not the main window.
// ─────────────────────────────────────────────────────────────────────────────

const _searchParams = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.search : ''
);
const POP_OUT_PANEL  = _searchParams.get('panel');
const IS_THEATRE     = _searchParams.get('mode') === 'theatre';

// ─────────────────────────────────────────────────────────────────────────────
// ENVIRONMENT FLAGS
// ─────────────────────────────────────────────────────────────────────────────

/** True during `npm run dev` (Vite dev server). */
const IS_DEV      = import.meta.env.DEV;

/** True when running inside Electron (preload injects window.electronAPI). */
const IS_ELECTRON = typeof window !== 'undefined' && Boolean(window?.electronAPI);

/** Fallback stream URL for browser-based (non-Electron) usage. */
const BROWSER_STREAM_URL = import.meta.env.VITE_STREAM_URL ?? 'http://localhost:8000/stream';

// ─────────────────────────────────────────────────────────────────────────────
// DEV SEQUENCE REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const SEQUENCES = {
  demo:    DEMO_SEQUENCE,
  warning: WARNING_SEQUENCE,
  canvas:  CANVAS_SEQUENCE,
  token:   TOKEN_SEQUENCE,
  none:    [],
};

// ─────────────────────────────────────────────────────────────────────────────
// APP
// ─────────────────────────────────────────────────────────────────────────────

function App() {
  // Boot state — splash screen shown until user clicks Launch
  const [bootComplete, setBootComplete] = useState(false);

  // Stream URL is resolved asynchronously in Electron (IPC round-trip).
  // null = do not connect yet; CommandCenter treats null as idle.
  const [streamUrl, setStreamUrl] = useState(null);

  // Persistent thread ID for the current conversation session.
  // All messages in the same session share this ID so the backend can
  // maintain conversation history and memory context across turns.
  const threadIdRef = useRef(crypto.randomUUID());

  // Voice state — set by CommandCenter, read by handleSendMessage to include in POST body
  const voiceEnabledRef = useRef(false);

  // In dev, expose sequence switching via the browser console.
  // The factory is rebuilt whenever the sequence changes.
  const [devSequence, setDevSequence] = useState('demo');
  const mockFactory = IS_DEV
    ? createMockFactory(SEQUENCES[devSequence] ?? DEMO_SEQUENCE, { intervalMs: 1500 })
    : undefined;

  // ── STREAM URL RESOLUTION ──
  useEffect(() => {
    if (IS_ELECTRON && window.electronAPI?.getStreamUrl) {
      // Electron: resolve from main process config (env var / settings store)
      window.electronAPI.getStreamUrl()
        .then(url => setStreamUrl(url))
        .catch(err => {
          console.error('[App] IPC getStreamUrl failed, using default:', err);
          setStreamUrl(BROWSER_STREAM_URL);
        });
      return;
    }

    if (IS_DEV && !IS_ELECTRON) {
      // Pure browser dev (no Electron) — use mock stream
      setStreamUrl('mock://aura');
      return;
    }

    // Browser fallback (non-Electron, non-dev) — use env var or default
    setStreamUrl(BROWSER_STREAM_URL);
  }, []); // Run once on mount

  // ── DEV CONSOLE UTILITIES ──
  useEffect(() => {
    if (!IS_DEV) return;

    window.__aura_setSequence = (name) => {
      if (!SEQUENCES[name]) {
        console.warn(
          `[AURA dev] Unknown sequence "${name}". Available:`,
          Object.keys(SEQUENCES).join(', ')
        );
        return;
      }
      console.info(`[AURA dev] Switching to sequence: "${name}". Reload to apply.`);
      setDevSequence(name);
      // Force a reconnect by briefly toggling the URL
      setStreamUrl(null);
      setTimeout(() => setStreamUrl('mock://aura'), 50);
    };

    window.__aura_reload = () => {
      setStreamUrl(null);
      setTimeout(() => setStreamUrl('mock://aura'), 50);
    };

    console.info(
      '%c AURA NX-α dev mode ',
      'background:#b87820;color:#030810;font-weight:bold;padding:2px 6px;border-radius:2px',
      '\n  Sequence: ' + devSequence,
      '\n  Use window.__aura_setSequence("demo"|"warning"|"canvas"|"token"|"none")',
      '\n  Use window.__aura_reload() to restart the stream'
    );

    return () => {
      delete window.__aura_setSequence;
      delete window.__aura_reload;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devSequence]);

  // ── SEND MESSAGE → POST ──
  // Derives the message endpoint from the stream URL by replacing the
  // trailing path segment (/stream → /message). In dev mode the mock
  // factory handles responses; we skip the fetch.
  //
  // Backend contract: POST /message  { text: string }
  // Response: 202 Accepted — the SSE stream delivers the reply.
  const handleSendMessage = useCallback(async (text) => {
    if (!text?.trim()) return;

    // Pure mock mode — MockEventSource auto-plays the sequence,
    // no real HTTP call needed. Skip if running in Electron (real backend).
    if ((!IS_ELECTRON && IS_DEV) || !streamUrl || streamUrl.startsWith('mock://')) return;

    // Derive message endpoint from stream URL.
    // e.g. http://localhost:8000/stream  →  http://localhost:8000/message
    const messageUrl = streamUrl.replace(/\/[^/]+$/, '/message');

    try {
      const res = await fetch(messageUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, thread_id: threadIdRef.current, voice_enabled: voiceEnabledRef.current }),
      });
      if (!res.ok) {
        console.error(`[App] POST /message failed: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      console.error('[App] POST /message network error:', err);
    }
  }, [streamUrl]);

  // ── Check boot status on mount (handles page refresh after boot) ──
  // Delay 3s to let backend start before the one-shot check
  useEffect(() => {
    const timer = setTimeout(() => {
      fetch('http://127.0.0.1:8000/boot/status')
        .then(res => res.json())
        .then(data => {
          if (data.launched) {
            setBootComplete(true);
          }
        })
        .catch(() => {
          // Backend not ready yet — splash will connect via SSE
        });
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  // ── RENDER ──

  // Theatre window — streaming service browser
  if (IS_THEATRE) {
    return <TheatreShell />;
  }

  // Pop-out window — render only the requested panel, not the full shell
  if (POP_OUT_PANEL) {
    return (
      <PopOutShell
        panelId={POP_OUT_PANEL}
        streamUrl={streamUrl}
        eventSourceFactory={(IS_DEV && !IS_ELECTRON) ? mockFactory : undefined}
      />
    );
  }

  // Boot splash — shown until user launches
  if (!bootComplete) {
    return <BootSplash onLaunch={() => setBootComplete(true)} />;
  }

  return (
    <CommandCenter
      streamUrl={streamUrl}
      eventSourceFactory={(IS_DEV && !IS_ELECTRON) ? mockFactory : undefined}
      onSendMessage={handleSendMessage}
      voiceEnabledRef={voiceEnabledRef}
    />
  );
}

export default App;
