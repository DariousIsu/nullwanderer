/**
 * AURA NX-Alpha — StationPanel
 *
 * Full channel browser + YouTube search + live transcription.
 *
 * LAYOUT:
 *   ┌──────────────────────────────────────────────┬──────────────────────┐
 *   │  Player (webview for channels, iframe for YT)│  ● TRANSCRIPTION     │
 *   ├──────────────────────────────────────────────┤  live segments       │
 *   │  [Channel tabs: All|National|Intl|Biz|...]  │  M:SS timestamps     │
 *   │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐       │  ──────────────────  │
 *   │  │chan  │ │chan  │ │chan  │ │chan  │       │  [■ STOP]            │
 *   │  │label │ │label │ │label │ │label │       │                      │
 *   │  └──────┘ └──────┘ └──────┘ └──────┘       │                      │
 *   ├──────────────────────────────────────────────┤                      │
 *   │  [🔍 Search YouTube…]  [Search]              │                      │
 *   │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐       │                      │
 *   │  │thumb │ │thumb │ │thumb │ │thumb │       │                      │
 *   │  └──────┘ └──────┘ └──────┘ └──────┘       │                      │
 *   └──────────────────────────────────────────────┴──────────────────────┘
 *
 * Auto-transcription: selecting a video immediately calls /watch/start.
 * No manual WATCH click required.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import styles from './StationPanel.module.css';

const API = 'http://127.0.0.1:8000';

// ─────────────────────────────────────────────────────────────────────────────
// HAYSTACK CHANNEL DIRECTORY — curated from haystack.tv/channels (477 total)
// Full directory available in Station tab; Intel tab uses 15-20 curated subset
// ─────────────────────────────────────────────────────────────────────────────

const CHANNEL_CATEGORIES = [
  { id: 'all',      label: 'All' },
  { id: 'national', label: 'National' },
  { id: 'intl',     label: 'International' },
  { id: 'business', label: 'Business' },
  { id: 'tech',     label: 'Tech' },
  { id: 'politics', label: 'Politics' },
];

const HAYSTACK_CHANNELS = [
  // ── National ──
  { id: 'cnn',              label: 'CNN',            cat: 'national', url: 'https://www.haystack.tv/channel/cnn' },
  { id: 'fox-news',         label: 'Fox News',       cat: 'national', url: 'https://www.haystack.tv/channel/fox-news' },
  { id: 'msnbc',            label: 'MSNBC',          cat: 'national', url: 'https://www.haystack.tv/channel/msnbc' },
  { id: 'abc-news',         label: 'ABC News',       cat: 'national', url: 'https://www.haystack.tv/channel/abc-news' },
  { id: 'cbs-news',         label: 'CBS News',       cat: 'national', url: 'https://www.haystack.tv/channel/cbs-news' },
  { id: 'nbc-news',         label: 'NBC News',       cat: 'national', url: 'https://www.haystack.tv/channel/nbc-news' },
  { id: 'newsmax',          label: 'Newsmax',        cat: 'national', url: 'https://www.haystack.tv/channel/newsmax' },
  { id: 'ap',               label: 'AP',             cat: 'national', url: 'https://www.haystack.tv/channel/associated-press' },
  { id: 'npr',              label: 'NPR',            cat: 'national', url: 'https://www.haystack.tv/channel/npr' },
  { id: 'pbs',              label: 'PBS',            cat: 'national', url: 'https://www.haystack.tv/channel/pbs-newshour' },
  // ── International ──
  { id: 'reuters',          label: 'Reuters',        cat: 'intl',     url: 'https://www.haystack.tv/channel/reuters' },
  { id: 'bbc-news',         label: 'BBC News',       cat: 'intl',     url: 'https://www.haystack.tv/channel/bbc-news' },
  { id: 'al-jazeera',       label: 'Al Jazeera',     cat: 'intl',     url: 'https://www.haystack.tv/channel/al-jazeera' },
  { id: 'france-24',        label: 'France 24',      cat: 'intl',     url: 'https://www.haystack.tv/channel/france-24' },
  { id: 'euronews',         label: 'Euronews',       cat: 'intl',     url: 'https://www.haystack.tv/channel/euronews' },
  { id: 'dw',               label: 'DW',             cat: 'intl',     url: 'https://www.haystack.tv/channel/dw' },
  // ── Business ──
  { id: 'bloomberg-tv',     label: 'Bloomberg TV',   cat: 'business', url: 'https://www.haystack.tv/channel/bloomberg-television' },
  { id: 'cnbc',             label: 'CNBC',           cat: 'business', url: 'https://www.haystack.tv/channel/cnbc' },
  { id: 'yahoo-finance',    label: 'Yahoo Finance',  cat: 'business', url: 'https://www.haystack.tv/channel/yahoo-finance' },
  { id: 'cheddar-news',     label: 'Cheddar',        cat: 'business', url: 'https://www.haystack.tv/channel/cheddar-news' },
  // ── Tech ──
  { id: 'cnet',             label: 'CNET',           cat: 'tech',     url: 'https://www.haystack.tv/channel/cnet' },
  { id: 'the-verge',        label: 'The Verge',      cat: 'tech',     url: 'https://www.haystack.tv/channel/the-verge' },
  { id: 'wired',            label: 'Wired',          cat: 'tech',     url: 'https://www.haystack.tv/channel/wired' },
  // ── Politics ──
  { id: 'c-span',           label: 'C-SPAN',         cat: 'politics', url: 'https://www.haystack.tv/channel/c-span' },
  { id: 'the-hill',         label: 'The Hill',       cat: 'politics', url: 'https://www.haystack.tv/channel/the-hill' },
  { id: 'politico',         label: 'Politico',       cat: 'politics', url: 'https://www.haystack.tv/channel/politico' },
];

// Format milliseconds → M:SS
function formatMs(ms) {
  if (ms == null) return '';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = String(totalSec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

// Format seconds → M:SS (for video duration from search results)
function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export default function StationPanel() {
  const [videoId,    setVideoId]    = useState(null);
  const [channelUrl, setChannelUrl] = useState(null);  // Haystack channel webview
  const [channelCat, setChannelCat] = useState('all'); // channel filter
  const [channelSearch, setChannelSearch] = useState(''); // channel name filter
  const [query,      setQuery]      = useState('');
  const [results,    setResults]    = useState([]);
  const [searching,  setSearching]  = useState(false);
  const [activeId,   setActiveId]   = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [error,      setError]      = useState('');

  const txPollRef    = useRef(null);
  const txBottomRef  = useRef(null);
  const activeIdRef  = useRef(null);   // stable ref for cleanup callbacks

  // Keep ref in sync
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  // ── Auto-transcription: fires whenever a new video is selected ────────────
  useEffect(() => {
    if (!videoId) return;
    let cancelled = false;

    const run = async () => {
      // Stop any running session first
      const prev = activeIdRef.current;
      if (prev) {
        try {
          await fetch(`${API}/watch/stop`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ stream_id: prev }),
          });
        } catch (e) {
          console.warn('[StationPanel] Failed to stop previous session:', e.message);
        }
      }

      if (cancelled) return;
      setActiveId(null);
      setTranscript([]);
      setError('');

      // Retry with backoff to handle backend startup race
      const startUrl = `https://www.youtube.com/watch?v=${videoId}`;
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`${API}/watch/start`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ url: startUrl }),
          });
          const d = await r.json();
          if (cancelled) return;
          if (d.error) {
            setError(d.error);
          } else {
            setActiveId(d.stream_id);
          }
          return; // success — exit loop
        } catch (e) {
          lastErr = e;
          if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
      if (!cancelled) setError('Backend unavailable — is the AURA backend running?');
      console.warn('[StationPanel] /watch/start failed after retries:', lastErr?.message);
    };

    run();
    return () => { cancelled = true; };
  }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Transcript polling ─────────────────────────────────────────────────────
  useEffect(() => {
    clearInterval(txPollRef.current);
    if (!activeId) return;

    const poll = () =>
      fetch(`${API}/watch/transcript/${activeId}`)
        .then(r => r.json())
        .then(d => {
          const segs = d.segments || [];
          setTranscript(segs.map(s => ({
            text: s.text,
            ts:   formatMs(s.start_ms),
          })));
        })
        .catch(() => {});

    poll();
    txPollRef.current = setInterval(poll, 3000);
    return () => clearInterval(txPollRef.current);
  }, [activeId]);

  // ── Auto-scroll transcript ─────────────────────────────────────────────────
  useEffect(() => {
    txBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  // ── YouTube search ─────────────────────────────────────────────────────────
  const doSearch = useCallback(async () => {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true);
    setResults([]);
    try {
      const r = await fetch(`${API}/watch/search?q=${encodeURIComponent(q)}&limit=8`);
      const d = await r.json();
      setResults(d.results || []);
    } catch {
      setError('Search failed — backend unavailable');
    }
    setSearching(false);
  }, [query, searching]);

  // ── Stop transcription ─────────────────────────────────────────────────────
  const stopWatch = useCallback(async () => {
    if (!activeId) return;
    try {
      await fetch(`${API}/watch/stop`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ stream_id: activeId }),
      });
    } catch (e) {
      console.warn('[StationPanel] Failed to stop watch:', e.message);
    }
    setActiveId(null);
    setTranscript([]);
  }, [activeId]);

  // ── Select a video from search results ────────────────────────────────────
  const selectVideo = useCallback((id) => {
    setVideoId(id);
    setChannelUrl(null); // switch from Haystack to YouTube
  }, []);

  const isActive = Boolean(activeId);

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className={styles.root}>

      {/* ── Left: player + search ─────────────────────────────────────── */}
      <div className={styles.browser}>

        {/* Player — Haystack webview or YouTube iframe */}
        <div className={styles.playerWrap}>
          {channelUrl ? (
            <webview
              key={channelUrl}
              className={styles.player}
              src={channelUrl}
              partition="persist:haystack"
              allowpopups="true"
              useragent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            />
          ) : videoId ? (
            <iframe
              key={videoId}
              className={styles.player}
              src={`https://www.youtube.com/embed/${videoId}?autoplay=1&controls=1&rel=0&modestbranding=1&fs=1&iv_load_policy=3&enablejsapi=1`}
              allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
              allowFullScreen
              title="Station Player"
            />
          ) : (
            <div className={styles.playerPlaceholder}>
              <div className={styles.placeholderLed} />
              <div className={styles.placeholderTitle}>AURA STATION</div>
              <div className={styles.placeholderSub}>Select a channel or search YouTube</div>
            </div>
          )}
        </div>

        {/* ── Channel browser ── */}
        <div className={styles.channelBrowser}>
          <div className={styles.channelTabs}>
            {CHANNEL_CATEGORIES.map(cat => (
              <button
                key={cat.id}
                className={`${styles.channelTab} ${channelCat === cat.id ? styles.channelTabActive : ''}`}
                onClick={() => setChannelCat(cat.id)}
              >
                {cat.label}
              </button>
            ))}
          </div>
          <input
            className={styles.channelSearchInput}
            placeholder="Search channels…"
            value={channelSearch}
            onChange={e => setChannelSearch(e.target.value)}
            spellCheck={false}
          />
          <div className={styles.channelGrid}>
            {HAYSTACK_CHANNELS
              .filter(ch => channelCat === 'all' || ch.cat === channelCat)
              .filter(ch => !channelSearch || ch.label.toLowerCase().includes(channelSearch.toLowerCase()))
              .map(ch => (
                <button
                  key={ch.id}
                  className={`${styles.channelChip} ${channelUrl === ch.url ? styles.channelChipActive : ''}`}
                  onClick={() => { setChannelUrl(ch.url); setVideoId(null); }}
                  title={ch.label}
                >
                  {ch.label}
                </button>
              ))}
          </div>
        </div>

        {/* Search + results */}
        <div className={styles.searchPane}>
          <div className={styles.searchBar}>
            <input
              className={styles.searchInput}
              placeholder="Search YouTube…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              spellCheck={false}
            />
            <button
              className={styles.searchBtn}
              onClick={doSearch}
              disabled={!query.trim() || searching}
            >
              {searching ? '…' : 'Search'}
            </button>
          </div>

          <div className={styles.resultGrid}>
            {results.length === 0 && !searching && (
              <div className={styles.resultEmpty}>
                {query ? 'No results' : 'Search to find videos'}
              </div>
            )}
            {results.map(r => (
              <button
                key={r.id}
                className={`${styles.card} ${videoId === r.id ? styles.cardActive : ''}`}
                onClick={() => selectVideo(r.id)}
                title={r.title}
              >
                <div className={styles.cardThumbWrap}>
                  <img
                    className={styles.cardThumb}
                    src={`https://img.youtube.com/vi/${r.id}/mqdefault.jpg`}
                    alt=""
                    loading="lazy"
                  />
                  {r.duration && (
                    <span className={styles.cardDuration}>{formatDuration(r.duration)}</span>
                  )}
                  {videoId === r.id && (
                    <div className={styles.cardPlayingBadge}>▶ PLAYING</div>
                  )}
                </div>
                <div className={styles.cardTitle}>{r.title}</div>
                <div className={styles.cardChannel}>{r.uploader}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Right: transcription pane ─────────────────────────────────── */}
      <div className={styles.txPane}>

        {/* Header */}
        <div className={styles.txControls}>
          <div className={styles.txHeader}>
            <div className={`${styles.txLed} ${isActive ? styles.txLedActive : ''}`} />
            <span className={styles.txTitle}>Transcription</span>
          </div>
          {isActive && (
            <button className={`${styles.watchBtn} ${styles.stopBtn}`} onClick={stopWatch}>
              ■ STOP
            </button>
          )}
        </div>

        {/* Live feed */}
        <div className={styles.txFeed}>
          {error && (
            <div className={styles.txError}>{error}</div>
          )}
          {!error && transcript.length === 0 && (
            <div className={styles.txEmpty}>
              {isActive ? 'Waiting for audio…' : 'Select a video to begin'}
            </div>
          )}
          {transcript.map((seg, i) => (
            <div key={i} className={styles.txSegment}>
              {seg.ts && <span className={styles.txTs}>{seg.ts}</span>}
              <span className={styles.txText}>{seg.text}</span>
            </div>
          ))}
          <div ref={txBottomRef} />
        </div>
      </div>
    </div>
  );
}
