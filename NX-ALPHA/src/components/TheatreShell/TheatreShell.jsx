/**
 * AURA NX-Alpha — TheatreShell
 *
 * Streaming theatre window. Opens as a separate Electron BrowserWindow
 * via ?mode=theatre URL param. Uses <webview> with persist:theatre session
 * so all service logins survive across app restarts.
 *
 * LAYOUT (selector open):
 *   [ webview 75% ][ channel selector 25% ]
 *
 * LAYOUT (service selected / selector closed):
 *   [ webview 100% ]  ← slim reopen tab on right edge
 *
 * Non-maximized: AURA style guide (dark glass, amber corners, titlebar).
 * Maximized: immersive — titlebar collapses on idle, controls auto-hide.
 *
 * Bottom drawer: headless transcription sessions via /watch endpoints.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './TheatreShell.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const SERVICES = [
  { id: 'youtube',   label: 'YouTube',    url: 'https://www.youtube.com',       accent: '#c4302b' },
  { id: 'netflix',   label: 'Netflix',    url: 'https://www.netflix.com',       accent: '#E50914' },
  { id: 'hulu',      label: 'Hulu',       url: 'https://www.hulu.com',          accent: '#1CE783' },
  { id: 'disney',    label: 'Disney+',    url: 'https://www.disneyplus.com',    accent: '#113CCF' },
  { id: 'prime',     label: 'Prime',      url: 'https://www.primevideo.com',    accent: '#00A8E1' },
  { id: 'twitch',    label: 'Twitch',     url: 'https://www.twitch.tv',         accent: '#9146FF' },
  { id: 'max',       label: 'Max',        url: 'https://www.max.com',           accent: '#4B5EFA' },
  { id: 'peacock',   label: 'Peacock',    url: 'https://www.peacocktv.com',     accent: '#F6C800' },
  { id: 'paramount', label: 'Paramount+', url: 'https://www.paramountplus.com', accent: '#0064FF' },
  { id: 'appletv',   label: 'Apple TV+',  url: 'https://tv.apple.com',          accent: '#999999' },
];

const API = 'http://127.0.0.1:8000';

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function TheatreShell() {
  const [activeService,   setActiveService]   = useState(null);   // currently loaded service
  const [selectorOpen,    setSelectorOpen]    = useState(true);   // channel guide visible
  const [isMaximized,     setIsMaximized]     = useState(false);
  const [titlebarVisible, setTitlebarVisible] = useState(true);   // auto-hide when maximized
  const [drawerOpen,      setDrawerOpen]      = useState(false);
  const [sessions,        setSessions]        = useState([]);
  const [watchUrl,        setWatchUrl]        = useState('');
  const [watchLabel,      setWatchLabel]      = useState('');
  const [watchLoading,    setWatchLoading]    = useState(false);

  const hideTimerRef    = useRef(null);
  const pollRef         = useRef(null);

  // ── Window state sync ──────────────────────────────────────────────────────
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    api.windowIsMaximized().then(setIsMaximized).catch(() => {});

    const onMax   = () => setIsMaximized(true);
    const onUnmax = () => { setIsMaximized(false); setTitlebarVisible(true); };
    api.onWindowMaximize(onMax);
    api.onWindowUnmaximize(onUnmax);
    return () => {
      api.removeWindowListener('window:maximized',   onMax);
      api.removeWindowListener('window:unmaximized', onUnmax);
    };
  }, []);

  // ── Titlebar auto-hide (maximized only) ────────────────────────────────────
  const resetHideTimer = useCallback(() => {
    if (!isMaximized) return;
    setTitlebarVisible(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => setTitlebarVisible(false), 3000);
  }, [isMaximized]);

  useEffect(() => {
    if (!isMaximized) {
      clearTimeout(hideTimerRef.current);
      setTitlebarVisible(true);
    }
    return () => clearTimeout(hideTimerRef.current);
  }, [isMaximized]);

  // ── Session poll (when drawer open) ────────────────────────────────────────
  useEffect(() => {
    if (!drawerOpen) {
      clearInterval(pollRef.current);
      return;
    }
    const fetchSessions = () => {
      fetch(`${API}/watch/sessions`)
        .then(r => r.json())
        .then(d => setSessions(d.sessions || []))
        .catch(() => {});
    };
    fetchSessions();
    pollRef.current = setInterval(fetchSessions, 4000);
    return () => clearInterval(pollRef.current);
  }, [drawerOpen]);

  // ── Service selection — opens in Chrome app-mode (no browser UI, full DRM) ──
  const selectService = useCallback((svc) => {
    setActiveService(svc);
    window.electronAPI?.openServiceApp(svc.url);
  }, []);

  // ── Headless watch ─────────────────────────────────────────────────────────
  const startWatch = useCallback(async () => {
    if (!watchUrl.trim()) return;
    setWatchLoading(true);
    try {
      const r = await fetch(`${API}/watch/start`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: watchUrl.trim(), label: watchLabel.trim() }),
      });
      const d = await r.json();
      if (!d.error) {
        setWatchUrl('');
        setWatchLabel('');
        setSessions(prev => [...prev, d]);
      }
    } catch {}
    setWatchLoading(false);
  }, [watchUrl, watchLabel]);

  const stopWatch = useCallback(async (stream_id) => {
    try {
      await fetch(`${API}/watch/stop`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ stream_id }),
      });
      setSessions(prev => prev.filter(s => s.stream_id !== stream_id));
    } catch {}
  }, []);

  // ── Window controls ────────────────────────────────────────────────────────
  const minimize  = () => window.electronAPI?.windowMinimize();
  const maxToggle = () => window.electronAPI?.windowMaximizeRestore();
  const close     = () => window.electronAPI?.windowClose();

  const activeCount = sessions.filter(s => s.status === 'watching').length;

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      className={`${styles.shell} ${isMaximized ? styles.shellMaximized : ''}`}
      onMouseMove={resetHideTimer}
    >
      {/* ── Corner plates (non-maximized only) ── */}
      {!isMaximized && (
        <>
          <div className={`${styles.corner} ${styles.cornerTL}`} />
          <div className={`${styles.corner} ${styles.cornerTR}`} />
          <div className={`${styles.corner} ${styles.cornerBL}`} />
          <div className={`${styles.corner} ${styles.cornerBR}`} />
        </>
      )}

      {/* ── Titlebar ── */}
      <div className={`${styles.titlebar} ${!titlebarVisible ? styles.titlebarHidden : ''}`}>
        <div className={styles.dragRegion}>
          {/* LED */}
          <div className={styles.led} />
          {/* Brand */}
          <span className={styles.brand}>Theatre</span>
          {activeService && (
            <>
              <span className={styles.titleSep}>·</span>
              <span
                className={styles.serviceName}
                style={{ color: activeService.accent }}
              >
                {activeService.label}
              </span>
            </>
          )}
        </div>


        {/* Window controls */}
        <div className={styles.winControls}>
          <button className={styles.winBtn} onClick={minimize} title="Minimize">─</button>
          <button className={styles.winBtn} onClick={maxToggle} title={isMaximized ? 'Restore' : 'Maximize'}>
            {isMaximized ? '❐' : '□'}
          </button>
          <button className={`${styles.winBtn} ${styles.winBtnClose}`} onClick={close} title="Close">✕</button>
        </div>
      </div>

      {/* ── Main body ── */}
      <div className={styles.body}>

        {/* ── Now playing display ── */}
        <div className={styles.webviewArea}>
          <div className={styles.placeholder}>
            <div className={styles.placeholderInner}>
              <div
                className={styles.placeholderLed}
                style={activeService ? { background: activeService.accent, boxShadow: `0 0 10px ${activeService.accent}` } : {}}
              />
              {activeService ? (
                <>
                  <div className={styles.placeholderTitle} style={{ color: activeService.accent }}>
                    {activeService.label}
                  </div>
                  <button
                    className={styles.relaunchBtn}
                    style={{ borderColor: activeService.accent, color: activeService.accent }}
                    onClick={() => window.electronAPI?.openServiceApp(activeService.url)}
                  >
                    ▶ Relaunch
                  </button>
                </>
              ) : (
                <>
                  <div className={styles.placeholderTitle}>AURA THEATRE</div>
                  <div className={styles.placeholderSub}>Select a channel</div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Channel selector panel ── */}
        <div className={`${styles.selectorPanel} ${!selectorOpen ? styles.selectorPanelClosed : ''}`}>
          <div className={styles.selectorHeader}>
            <span className={styles.selectorTitle}>Channels</span>
          </div>
          <div className={styles.serviceList}>
            {SERVICES.map(svc => (
              <button
                key={svc.id}
                className={`${styles.serviceItem} ${activeService?.id === svc.id ? styles.serviceItemActive : ''}`}
                style={activeService?.id === svc.id ? { '--accent': svc.accent } : {}}
                onClick={() => selectService(svc)}
                onMouseEnter={e => e.currentTarget.style.setProperty('--accent', svc.accent)}
                onMouseLeave={e => activeService?.id !== svc.id && e.currentTarget.style.removeProperty('--accent')}
              >
                <span
                  className={styles.serviceAccent}
                  style={{ background: svc.accent }}
                />
                <span className={styles.serviceLabel}>{svc.label}</span>
                {activeService?.id === svc.id && (
                  <span className={styles.serviceActiveDot} style={{ color: svc.accent }}>◉</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Transcription drawer ── */}
      <div className={styles.drawerWrap}>
        {/* Drawer tab — always visible */}
        <button
          className={styles.drawerTab}
          onClick={() => setDrawerOpen(o => !o)}
        >
          <span className={styles.drawerTabIcon}>{drawerOpen ? '▾' : '▴'}</span>
          <span className={styles.drawerTabLabel}>STREAMS</span>
          {activeCount > 0 && (
            <span className={styles.drawerBadge}>{activeCount}</span>
          )}
        </button>

        {/* Drawer body */}
        <div className={`${styles.drawer} ${drawerOpen ? styles.drawerOpen : ''}`}>
          {/* Input row */}
          <div className={styles.drawerInputRow}>
            <input
              className={styles.drawerInput}
              placeholder="Stream or video URL…"
              value={watchUrl}
              onChange={e => setWatchUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && startWatch()}
            />
            <input
              className={`${styles.drawerInput} ${styles.drawerInputLabel}`}
              placeholder="Label (optional)"
              value={watchLabel}
              onChange={e => setWatchLabel(e.target.value)}
            />
            <button
              className={styles.drawerWatchBtn}
              onClick={startWatch}
              disabled={!watchUrl.trim() || watchLoading}
            >
              {watchLoading ? '…' : 'WATCH'}
            </button>
          </div>

          {/* Session list */}
          <div className={styles.drawerSessions}>
            {sessions.length === 0 ? (
              <div className={styles.drawerEmpty}>No active transcription sessions</div>
            ) : (
              sessions.map(s => (
                <div key={s.stream_id} className={styles.sessionRow}>
                  <div
                    className={styles.sessionDot}
                    style={{ background: s.status === 'watching' ? '#2ecc71' : '#888' }}
                  />
                  <div className={styles.sessionInfo}>
                    <div className={styles.sessionLabel}>{s.label || s.stream_id}</div>
                    <div className={styles.sessionMeta}>
                      {s.segment_count} segments · {Math.floor((s.duration_s || 0) / 60)}m {(s.duration_s || 0) % 60}s
                    </div>
                  </div>
                  <button
                    className={styles.sessionStopBtn}
                    onClick={() => stopWatch(s.stream_id)}
                    title="Stop"
                  >
                    ◼
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
