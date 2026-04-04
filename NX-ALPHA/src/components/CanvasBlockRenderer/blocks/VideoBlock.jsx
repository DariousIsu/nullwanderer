/**
 * AURA NX-Alpha — VideoBlock (Phase 2)
 *
 * Video and live stream player embedded in a CanvasBlock.
 * Custom dark-theme controls: play/pause, seek, time, volume, fullscreen.
 * HLS stream support (adaptive bitrate, live feeds) via hls.js when needed.
 *
 * FORMAT DETECTION:
 *   .m3u8 → HLS adaptive stream (hls.js or native on Safari/iOS)
 *   .mp4 / .webm / .ogg → native HTML5 video
 *   rtmp:// → not supported in browser; use a relay that outputs HLS
 *
 * HLS.JS:
 *   Install: npm install hls.js
 *   Falls back to native <video src> if hls.js is not available.
 *
 * PHASE 2 EXTENSION POINTS:
 *   - WebRTC: replace the <video> src with a MediaStream from RTCPeerConnection
 *   - Multi-quality selector: expose hls.js levels via a quality menu
 *   - Subtitles/captions: TextTrack API
 *   - Picture-in-picture: videoEl.requestPictureInPicture()
 *
 * Data shape:
 *   {
 *     src:         string,    // video URL or HLS .m3u8 manifest URL
 *     title?:      string,    // shown in top-left corner
 *     poster?:     string,    // thumbnail shown before play
 *     autoPlay?:   boolean,   // default false
 *     muted?:      boolean,   // default false (required for autoPlay in browsers)
 *     loop?:       boolean,
 *     live?:       boolean,   // shows LIVE badge, disables seek
 *   }
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import styles from './VideoBlock.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const isHLS = (src) => /\.m3u8(\?.*)?$/i.test(src);

function formatTime(secs) {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ICONS (inline SVG — no external dep)
// ─────────────────────────────────────────────────────────────────────────────

const IconPlay = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M3 2l9 5-9 5V2z" fill="currentColor" />
  </svg>
);
const IconPause = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <rect x="2.5" y="2" width="3" height="10" rx="1" fill="currentColor" />
    <rect x="8.5" y="2" width="3" height="10" rx="1" fill="currentColor" />
  </svg>
);
const IconVolume = ({ muted }) => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path d="M2 5h3l4-3v10l-4-3H2V5z" fill="currentColor" />
    {!muted && <path d="M9 4.5a3 3 0 010 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
    {muted && <path d="M9 5.5l3 3M12 5.5l-3 3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />}
  </svg>
);
const IconFullscreen = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M1 4V1h3M8 1h3v3M11 8v3H8M4 11H1V8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// VIDEO BLOCK
// ─────────────────────────────────────────────────────────────────────────────

const VideoBlock = ({
  src      = '',
  title    = '',
  poster   = '',
  autoPlay = false,
  muted    = false,
  loop     = false,
  live     = false,
}) => {
  const videoRef    = useRef(null);
  const hlsRef      = useRef(null);
  const [playing,   setPlaying]   = useState(false);
  const [currentT,  setCurrentT]  = useState(0);
  const [duration,  setDuration]  = useState(0);
  const [vol,       setVol]       = useState(muted ? 0 : 1);
  const [isMuted,   setIsMuted]   = useState(muted);
  const [buffering, setBuffering] = useState(false);
  const [error,     setError]     = useState(false);
  const [showCtrl,  setShowCtrl]  = useState(true);
  const hideTimer   = useRef(null);

  // ── HLS / native source setup ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;
    setError(false);
    setPlaying(false);
    setCurrentT(0);
    setDuration(0);

    const attachDirect = () => {
      video.src = src;
      if (autoPlay) video.play().catch(() => {});
    };

    if (isHLS(src)) {
      // Try hls.js; fall back to native (Safari / Edge)
      import('hls.js').then(({ default: Hls }) => {
        if (Hls.isSupported()) {
          const hls = new Hls({ lowLatencyMode: true });
          hls.loadSource(src);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            if (autoPlay) video.play().catch(() => {});
          });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) setError(true);
          });
          hlsRef.current = hls;
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          attachDirect();
        } else {
          setError(true);
        }
      }).catch(() => {
        // hls.js not installed — try native
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          attachDirect();
        } else {
          // HLS not natively supported and hls.js missing
          attachDirect(); // try anyway — will fail gracefully
        }
      });
    } else {
      attachDirect();
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [src, autoPlay]);

  // ── Video event listeners ──
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay     = () => setPlaying(true);
    const onPause    = () => setPlaying(false);
    const onEnded    = () => { setPlaying(false); setCurrentT(0); };
    const onTime     = () => setCurrentT(video.currentTime);
    const onMeta     = () => setDuration(video.duration);
    const onWaiting  = () => setBuffering(true);
    const onCanPlay  = () => setBuffering(false);
    const onError    = () => setError(true);
    const onVolChg   = () => { setVol(video.volume); setIsMuted(video.muted); };

    video.addEventListener('play',          onPlay);
    video.addEventListener('pause',         onPause);
    video.addEventListener('ended',         onEnded);
    video.addEventListener('timeupdate',    onTime);
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('waiting',       onWaiting);
    video.addEventListener('canplay',       onCanPlay);
    video.addEventListener('error',         onError);
    video.addEventListener('volumechange',  onVolChg);

    return () => {
      video.removeEventListener('play',          onPlay);
      video.removeEventListener('pause',         onPause);
      video.removeEventListener('ended',         onEnded);
      video.removeEventListener('timeupdate',    onTime);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('waiting',       onWaiting);
      video.removeEventListener('canplay',       onCanPlay);
      video.removeEventListener('error',         onError);
      video.removeEventListener('volumechange',  onVolChg);
    };
  }, []);

  // ── Controls auto-hide ──
  const resetHideTimer = useCallback(() => {
    setShowCtrl(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => { if (playing) setShowCtrl(false); }, 2800);
  }, [playing]);

  useEffect(() => {
    if (!playing) { setShowCtrl(true); clearTimeout(hideTimer.current); }
    return () => clearTimeout(hideTimer.current);
  }, [playing]);

  // ── Controls ──
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    playing ? v.pause() : v.play().catch(() => {});
  }, [playing]);

  const handleSeek = useCallback((e) => {
    const v = videoRef.current;
    if (!v || live) return;
    v.currentTime = parseFloat(e.target.value);
  }, [live]);

  const handleVolume = useCallback((e) => {
    const v = videoRef.current;
    if (!v) return;
    const val = parseFloat(e.target.value);
    v.volume = val;
    v.muted  = val === 0;
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, []);

  const handleFullscreen = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.requestFullscreen)             v.requestFullscreen();
    else if (v.webkitRequestFullscreen)  v.webkitRequestFullscreen();
  }, []);

  const progress = duration > 0 ? (currentT / duration) * 100 : 0;

  return (
    <div
      className={styles.root}
      onMouseMove={resetHideTimer}
      onClick={resetHideTimer}
    >
      {/* ── Video element ── */}
      <video
        ref={videoRef}
        className={styles.video}
        poster={poster}
        muted={isMuted}
        loop={loop}
        playsInline
        preload="metadata"
      />

      {/* ── Buffering spinner ── */}
      {buffering && !error && (
        <div className={styles.bufferOverlay}>
          <div className={styles.bufferSpinner} />
        </div>
      )}

      {/* ── Error state ── */}
      {error && (
        <div className={styles.errorOverlay}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <circle cx="14" cy="14" r="13" stroke="currentColor" strokeWidth="1.5" />
            <path d="M14 8v7M14 18v1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>Stream unavailable</span>
        </div>
      )}

      {/* ── Large center play button (visible when paused) ── */}
      {!playing && !error && (
        <button className={styles.playCenter} onClick={togglePlay} aria-label="Play">
          <IconPlay />
        </button>
      )}

      {/* ── Top bar: title + LIVE badge ── */}
      {(title || live) && (
        <div className={`${styles.topBar} ${showCtrl ? '' : styles.hidden}`}>
          {title && <span className={styles.videoTitle}>{title}</span>}
          {live && <span className={styles.liveBadge}>● LIVE</span>}
        </div>
      )}

      {/* ── Bottom controls ── */}
      <div className={`${styles.controls} ${showCtrl ? '' : styles.hidden}`}>
        {/* Seek bar — hidden for live streams */}
        {!live && (
          <div className={styles.seekWrap}>
            <div className={styles.seekTrack}>
              <div className={styles.seekFill} style={{ width: `${progress}%` }} />
            </div>
            <input
              type="range"
              className={styles.seekRange}
              min={0}
              max={duration || 100}
              step={0.25}
              value={currentT}
              onChange={handleSeek}
              aria-label="Seek"
            />
          </div>
        )}

        <div className={styles.controlRow}>
          {/* Play / Pause */}
          <button className={styles.ctrlBtn} onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>

          {/* Time */}
          {!live && (
            <span className={styles.timeDisplay}>
              {formatTime(currentT)} / {formatTime(duration)}
            </span>
          )}
          {live && (
            <span className={styles.liveIndicator}>● LIVE</span>
          )}

          {/* Spacer */}
          <div style={{ flex: 1 }} />

          {/* Volume */}
          <button className={styles.ctrlBtn} onClick={toggleMute} aria-label={isMuted ? 'Unmute' : 'Mute'}>
            <IconVolume muted={isMuted || vol === 0} />
          </button>
          <input
            type="range"
            className={styles.volRange}
            min={0}
            max={1}
            step={0.02}
            value={isMuted ? 0 : vol}
            onChange={handleVolume}
            aria-label="Volume"
          />

          {/* Fullscreen */}
          <button className={styles.ctrlBtn} onClick={handleFullscreen} aria-label="Fullscreen">
            <IconFullscreen />
          </button>
        </div>
      </div>
    </div>
  );
};

export default VideoBlock;
