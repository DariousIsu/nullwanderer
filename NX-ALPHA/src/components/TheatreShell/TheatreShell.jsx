/**
 * AURA NX-Alpha — TheatreShell
 *
 * Dedicated YouTube video viewer. Opens as a separate Electron BrowserWindow
 * via ?mode=theatre URL param.
 *
 * - Paste any YouTube URL (watch, youtu.be, shorts) to load
 * - Uses YouTube embed iframe with IFrame Player API for custom controls
 * - No full YouTube page, no streaming service list
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import styles from './TheatreShell.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  const str = (url || '').trim();
  const patterns = [
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/watch\?(?:.*&)?v=([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/v\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = str.match(p);
    if (m) return m[1];
  }
  // bare 11-char ID
  if (/^[A-Za-z0-9_-]{11}$/.test(str)) return str;
  return null;
}

function ytCommand(iframe, func, args = '') {
  if (!iframe) return;
  iframe.contentWindow?.postMessage(
    JSON.stringify({ event: 'command', func, args }),
    'https://www.youtube.com'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function TheatreShell() {
  const [videoId,       setVideoId]       = useState(null);
  const [urlInput,      setUrlInput]      = useState('');
  const [urlError,      setUrlError]      = useState(false);
  const [isPlaying,     setIsPlaying]     = useState(false);
  const [isMuted,       setIsMuted]       = useState(false);
  const [isMaximized,   setIsMaximized]   = useState(false);
  const [titlebarVisible, setTitlebarVisible] = useState(true);
  const [playerReady,   setPlayerReady]   = useState(false);

  const iframeRef      = useRef(null);
  const hideTimerRef   = useRef(null);

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
    if (!isMaximized) { clearTimeout(hideTimerRef.current); setTitlebarVisible(true); }
    return () => clearTimeout(hideTimerRef.current);
  }, [isMaximized]);

  // ── YT IFrame Player API state messages ────────────────────────────────────
  useEffect(() => {
    const handleMessage = (e) => {
      if (e.origin !== 'https://www.youtube.com') return;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        if (data.event === 'onReady') {
          setPlayerReady(true);
        }
        if (data.event === 'onStateChange') {
          // YT states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
          setIsPlaying(data.info === 1 || data.info === 3);
        }
      } catch {}
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // ── Load video ─────────────────────────────────────────────────────────────
  const loadVideo = useCallback(() => {
    const id = extractVideoId(urlInput);
    if (!id) {
      setUrlError(true);
      setTimeout(() => setUrlError(false), 1800);
      return;
    }
    setUrlError(false);
    setVideoId(id);
    setPlayerReady(false);
    setIsPlaying(false);
    setUrlInput('');
  }, [urlInput]);

  const handleUrlKeyDown = (e) => {
    if (e.key === 'Enter') loadVideo();
  };

  // ── Controls ────────────────────────────────────────────────────────────────
  const togglePlayPause = () => {
    ytCommand(iframeRef.current, isPlaying ? 'pauseVideo' : 'playVideo');
  };

  const toggleMute = () => {
    ytCommand(iframeRef.current, isMuted ? 'unMute' : 'mute');
    setIsMuted(m => !m);
  };

  const handleFullscreen = () => {
    iframeRef.current?.requestFullscreen?.();
  };

  const skipBack = () => ytCommand(iframeRef.current, 'seekTo', [-10, true]);
  const skipFwd  = () => ytCommand(iframeRef.current, 'seekTo', [10, true]);

  // ── Window controls ─────────────────────────────────────────────────────────
  const minimize  = () => window.electronAPI?.theatreMinimize();
  const maxToggle = () => window.electronAPI?.theatreMaximizeRestore();
  const close     = () => window.electronAPI?.theatreClose();

  const embedSrc = videoId
    ? `https://www.youtube.com/embed/${videoId}?enablejsapi=1&autoplay=1&controls=1&rel=0&modestbranding=1&fs=1&iv_load_policy=3`
    : null;

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div
      className={`${styles.shell} ${isMaximized ? styles.shellMaximized : ''}`}
      onMouseMove={resetHideTimer}
    >
      {/* Corner plates (non-maximized) */}
      {!isMaximized && (
        <>
          <div className={`${styles.corner} ${styles.cornerTL}`} />
          <div className={`${styles.corner} ${styles.cornerTR}`} />
          <div className={`${styles.corner} ${styles.cornerBL}`} />
          <div className={`${styles.corner} ${styles.cornerBR}`} />
        </>
      )}

      {/* Titlebar */}
      <div className={`${styles.titlebar} ${!titlebarVisible ? styles.titlebarHidden : ''}`}>
        <div className={styles.dragRegion}>
          <div className={styles.led} />
          <span className={styles.brand}>Theatre</span>
          {videoId && (
            <>
              <span className={styles.titleSep}>·</span>
              <span className={styles.serviceName} style={{ color: '#c4302b' }}>YouTube</span>
            </>
          )}
        </div>
        <div className={styles.winControls}>
          <button className={styles.winBtn} onClick={minimize} title="Minimize">─</button>
          <button className={styles.winBtn} onClick={maxToggle} title={isMaximized ? 'Restore' : 'Maximize'}>
            {isMaximized ? '❐' : '□'}
          </button>
          <button className={`${styles.winBtn} ${styles.winBtnClose}`} onClick={close} title="Close">✕</button>
        </div>
      </div>

      {/* Main body */}
      <div className={styles.body}>

        {/* URL input bar */}
        <div className={styles.urlBar}>
          <span className={styles.urlBarLabel}>YT</span>
          <input
            className={`${styles.urlInput} ${urlError ? styles.urlInputError : ''}`}
            placeholder="Paste YouTube URL or video ID…"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={handleUrlKeyDown}
            spellCheck={false}
          />
          <button
            className={styles.urlLoadBtn}
            onClick={loadVideo}
            disabled={!urlInput.trim()}
          >
            LOAD
          </button>
        </div>

        {/* Player area */}
        <div className={styles.playerWrap}>
          {embedSrc ? (
            <iframe
              ref={iframeRef}
              key={videoId}
              className={styles.playerFrame}
              src={embedSrc}
              title="YouTube player"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
              allowFullScreen
              frameBorder="0"
            />
          ) : (
            <div className={styles.placeholder}>
              <div className={styles.placeholderInner}>
                <div className={styles.placeholderLed} />
                <div className={styles.placeholderTitle}>AURA THEATRE</div>
                <div className={styles.placeholderSub}>Paste a YouTube URL above to begin</div>
              </div>
            </div>
          )}
        </div>

        {/* Custom control bar */}
        {videoId && (
          <div className={styles.controlBar}>
            <button
              className={styles.ctrlBtn}
              onClick={skipBack}
              title="Back 10s"
              disabled={!playerReady}
            >
              ⏮ 10
            </button>
            <button
              className={`${styles.ctrlBtn} ${styles.ctrlBtnPlay}`}
              onClick={togglePlayPause}
              title={isPlaying ? 'Pause' : 'Play'}
              disabled={!playerReady}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>
            <button
              className={styles.ctrlBtn}
              onClick={skipFwd}
              title="Forward 10s"
              disabled={!playerReady}
            >
              10 ⏭
            </button>
            <button
              className={`${styles.ctrlBtn} ${isMuted ? styles.ctrlBtnMuted : ''}`}
              onClick={toggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
              disabled={!playerReady}
            >
              {isMuted ? '🔇' : '🔊'}
            </button>
            <div className={styles.ctrlSpacer} />
            <button
              className={styles.ctrlBtn}
              onClick={handleFullscreen}
              title="Fullscreen"
            >
              ⛶
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
