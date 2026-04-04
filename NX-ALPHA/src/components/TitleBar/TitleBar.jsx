/**
 * AURA NX-Alpha — TitleBar
 *
 * Custom Electron title bar. Replaces the native Windows chrome.
 * Drag region, Aura branding, timezone clock bar, presence light, window controls.
 *
 * LAYOUT:
 *   [● AURA NX-α  ⊙ mode]  ←── TimezoneBar (full center) ──→  [_ □ ×]
 *
 * TIMEZONE BAR:
 *   Shows a configurable set of world clocks, each with a colored city label
 *   and HH:MM time. Updates every minute. Configurable in Settings → Time Zones.
 *
 * IPC:
 * Window controls call window.electronAPI if available (Electron context).
 * Falls back gracefully in browser/preview mode.
 */

import { useState, useEffect } from 'react';
import styles from './TitleBar.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// TIMEZONE DEFAULTS — exported so CommandCenter can seed state
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_TIMEZONES = [
  { id: 'nyc',     city: 'NYC',     tz: 'America/New_York',   color: '#4ec87a' },
  { id: 'la',      city: 'LA',      tz: 'America/Los_Angeles',color: '#c0c0c0' },
  { id: 'chicago', city: 'CHICAGO', tz: 'America/Chicago',    color: '#c0c0c0' },
  { id: 'london',  city: 'LONDON',  tz: 'Europe/London',      color: '#e05555' },
  { id: 'moscow',  city: 'MOSCOW',  tz: 'Europe/Moscow',      color: '#c0c0c0' },
  { id: 'dubai',   city: 'DUBAI',   tz: 'Asia/Dubai',         color: '#c8a04e' },
  { id: 'beijing', city: 'BEIJING', tz: 'Asia/Shanghai',      color: '#b87820' },
  { id: 'tokyo',   city: 'TOKYO',   tz: 'Asia/Tokyo',         color: '#c0c0c0' },
  { id: 'sydney',  city: 'SYDNEY',  tz: 'Australia/Sydney',   color: '#00ccff' },
];

// ─────────────────────────────────────────────────────────────────────────────
// WINDOW CONTROLS
// ─────────────────────────────────────────────────────────────────────────────

const WinControls = () => {
  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  return (
    <div className={styles.winControls} aria-label="Window controls">
      <button
        className={`${styles.winBtn} ${styles.winBtnMin}`}
        onClick={() => api?.windowMinimize?.()}
        aria-label="Minimize"
        title="Minimize"
      >
        <span className={styles.winBtnIcon} aria-hidden="true">—</span>
      </button>
      <button
        className={`${styles.winBtn} ${styles.winBtnMax}`}
        onClick={() => api?.windowMaximizeRestore?.()}
        aria-label="Maximize"
        title="Maximize / Restore"
      >
        <span className={styles.winBtnIcon} aria-hidden="true">□</span>
      </button>
      <button
        className={`${styles.winBtn} ${styles.winBtnClose}`}
        onClick={() => api?.windowClose?.()}
        aria-label="Close"
        title="Close"
      >
        <span className={styles.winBtnIcon} aria-hidden="true">×</span>
      </button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TIMEZONE BAR — multi-city world clock
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats HH:MM for the given IANA timezone string.
 * Returns '--:--' if the timezone is invalid.
 */
function formatTZ(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   false,
    }).format(new Date());
  } catch {
    return '--:--';
  }
}

const TimezoneBar = ({ zones = DEFAULT_TIMEZONES }) => {
  // Tick state — we just need a counter to force re-renders each minute
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Align first tick to the next minute boundary
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000 + 250;
    const timeout = setTimeout(() => {
      setTick(t => t + 1);
      const interval = setInterval(() => setTick(t => t + 1), 60000);
      return () => clearInterval(interval);
    }, msToNextMinute);
    return () => clearTimeout(timeout);
  }, []);

  const activeZones = zones.filter(z => z.enabled !== false);

  if (activeZones.length === 0) return null;

  return (
    <div className={styles.tzBar} aria-label="World clocks">
      {activeZones.map((zone, i) => (
        <div key={zone.id} className={styles.tzEntry}>
          <span
            className={styles.tzCity}
            style={{ color: zone.color }}
          >
            {zone.city}
          </span>
          <span className={styles.tzTime}>{formatTZ(zone.tz)}</span>
          {i < activeZones.length - 1 && (
            <span className={styles.tzSep} aria-hidden="true" />
          )}
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// OPERATING MODE SWITCHER — compact icon-only (left panel)
// ─────────────────────────────────────────────────────────────────────────────

const MODES = [
  { id: 'quiet',     icon: '🔇', label: 'Quiet',     desc: 'Silent — no proactive output' },
  { id: 'ambient',   icon: '🔔', label: 'Ambient',   desc: 'Passive monitoring only' },
  { id: 'proactive', icon: '⚡', label: 'Proactive', desc: 'Full autonomous operation' },
  { id: 'dev',       icon: '⌨',  label: 'Dev',       desc: 'Workhorse dedicated to Dev Studio' },
];

/**
 * Compact icon-only mode switcher — sits in the left panel next to branding.
 * Active mode gets amber highlight. No label text (saves horizontal space for timezone bar).
 */
const ModeSwitcher = ({ mode = 'proactive', onChange }) => (
  <div className={styles.modePill} role="group" aria-label="Operating mode">
    {MODES.map(({ id, icon, label, desc }) => (
      <button
        key={id}
        className={[
          styles.modeBtn,
          mode === id && styles.modeBtnActive,
        ].filter(Boolean).join(' ')}
        onClick={() => onChange?.(id)}
        aria-label={`${label} — ${desc}`}
        aria-pressed={mode === id}
        title={`${label}: ${desc}`}
      >
        <span className={styles.modeIcon} aria-hidden="true">{icon}</span>
      </button>
    ))}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// PRESENCE LIGHT
// ─────────────────────────────────────────────────────────────────────────────

const PresenceLight = ({ auraState = 'idle' }) => {
  const isThinking = auraState === 'thinking';
  return (
    <div
      className={`${styles.presence} ${isThinking ? styles.presenceThinking : styles.presenceAmber}`}
      aria-label={`Aura: ${auraState}`}
      title={`Aura — ${auraState}`}
    />
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TITLE BAR
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS EXPORT CONTROL — shown in title bar right when blocks are present
// ─────────────────────────────────────────────────────────────────────────────

const EXPORT_FORMATS = ['pdf', 'docx', 'html', 'txt', 'markdown'];

const CanvasExportControl = ({ blockCount, format, onFormatChange, onDownload, exporting }) => {
  if (!blockCount) return null;
  return (
    <div className={styles.exportControl} aria-label="Canvas export">
      <span className={styles.exportCount}>{blockCount}</span>
      <select
        className={styles.exportSelect}
        value={format}
        onChange={e => onFormatChange(e.target.value)}
        title="Export format"
      >
        {EXPORT_FORMATS.map(f => (
          <option key={f} value={f}>{f.toUpperCase()}</option>
        ))}
      </select>
      <button
        className={styles.exportBtn}
        onClick={onDownload}
        disabled={exporting}
        title="Download canvas"
        aria-label="Download canvas"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M5 1v6M2.5 5l2.5 2.5L7.5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M1.5 9h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
        {exporting ? '…' : 'Export'}
      </button>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TITLE BAR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string}   auraState           — 'idle'|'listening'|'thinking'|'responding'
 * @param {string}   operatingMode       — 'quiet'|'ambient'|'proactive'
 * @param {function} onModeChange        — (modeId: string) => void
 * @param {Array}    timezones           — Array<{ id, city, tz, color, enabled? }>
 * @param {string}   orientation         — 'vertical'|'horizontal' (from CommandCenter)
 * @param {boolean}  compact             — Reduce height (used in horizontal mode)
 * @param {number}   canvasBlockCount    — number of active canvas blocks (shows export control)
 * @param {string}   exportFormat        — currently selected export format
 * @param {function} onExportFormatChange — (format: string) => void
 * @param {function} onCanvasDownload    — () => void
 * @param {boolean}  exporting           — true while export is in flight
 */
const TitleBar = ({
  auraState           = 'idle',
  operatingMode       = 'proactive',
  onModeChange,
  timezones           = DEFAULT_TIMEZONES,
  orientation         = 'vertical',
  compact             = false,
  canvasBlockCount    = 0,
  exportFormat        = 'pdf',
  onExportFormatChange,
  onCanvasDownload,
  exporting           = false,
}) => (
  <div
    className={[
      styles.bar,
      compact && styles.barCompact,
    ].filter(Boolean).join(' ')}
    data-orientation={orientation}
    data-mode={operatingMode}
  >
    {/* Drag region — covers most of the bar */}
    <div className={styles.dragRegion} aria-hidden="true" />

    {/* Left — branding + compact mode switcher */}
    <div className={styles.left}>
      <PresenceLight auraState={auraState} />
      <span className={styles.brand}>AURA</span>
      <span className={styles.version}>NX-α</span>
      <span className={styles.leftDivider} aria-hidden="true" />
      <ModeSwitcher mode={operatingMode} onChange={onModeChange} />
    </div>

    {/* Center — timezone bar (fills the gap between left and right) */}
    <div className={styles.center}>
      <TimezoneBar zones={timezones} />
    </div>

    {/* Right — canvas export (when blocks present) + window controls */}
    <div className={styles.right}>
      <CanvasExportControl
        blockCount={canvasBlockCount}
        format={exportFormat}
        onFormatChange={onExportFormatChange}
        onDownload={onCanvasDownload}
        exporting={exporting}
      />
      <WinControls />
    </div>
  </div>
);

export default TitleBar;
