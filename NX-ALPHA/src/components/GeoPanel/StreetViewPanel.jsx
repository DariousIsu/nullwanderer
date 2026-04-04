/**
 * AURA NX-Alpha — StreetViewPanel
 *
 * Displays KartaView street-level imagery for a clicked map location.
 *
 * IMPLEMENTATION NOTE (Phase 9):
 *   KartaView sends X-Frame-Options: SAMEORIGIN, so <iframe> fails silently
 *   in Electron. Instead we use the /media/browser/stream MJPEG endpoint —
 *   a headless Chrome screencasts the KartaView page and streams JPEG frames
 *   as multipart/x-mixed-replace. Chromium's <img> tag handles this natively.
 *
 *   DO NOT revert to <iframe>. See p9-browser-media.md "Note for Phase 7".
 */

import { useState, useEffect } from 'react';
import styles from './StreetViewPanel.module.css';

const API = 'http://localhost:8000';

export default function StreetViewPanel({ location }) {
  const [streamKey, setStreamKey] = useState(0);

  // Re-mount the img when location changes so the previous stream stops
  useEffect(() => {
    if (location) setStreamKey(k => k + 1);
  }, [location?.lat, location?.lon]);

  if (!location) {
    return (
      <div className={styles.placeholder}>
        <div className={styles.placeholderIcon} aria-hidden="true">◎</div>
        <p>Click map for street view</p>
      </div>
    );
  }

  const { lat, lon } = location;
  const kartaUrl = `https://kartaview.org/map/@${lat},${lon},z17`;
  const streamUrl = `${API}/media/browser/stream`
    + `?url=${encodeURIComponent(kartaUrl)}`
    + `&fps=4&max_frames=60`;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.label}>Street View — KartaView</span>
        <span className={styles.coords}>{lat.toFixed(5)}, {lon.toFixed(5)}</span>
      </div>

      {/*
        MJPEG stream via <img> — NOT an iframe.
        multipart/x-mixed-replace is handled natively by Chromium.
        The key prop forces a fresh request when location changes.
      */}
      <img
        key={streamKey}
        src={streamUrl}
        alt={`KartaView street view at ${lat.toFixed(4)}, ${lon.toFixed(4)}`}
        className={styles.stream}
      />
    </div>
  );
}
