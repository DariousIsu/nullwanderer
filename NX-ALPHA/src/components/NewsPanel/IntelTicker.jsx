/**
 * AURA NX-Alpha — IntelTicker
 *
 * 28px persistent strip rendered between AppBar and workspace.
 * Visible when intelState === 'ticker' (Intel 3-state machine).
 *
 * Contains:
 *   - INTEL badge (left) — red glow, story count
 *   - Scrolling headline ticker (center) — CSS animation
 *   - Action buttons (right) — Expand + Close
 */

import { useState, useEffect } from 'react';
import styles from './IntelTicker.module.css';
import { useIntelligenceFeed, useNews } from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK ITEMS
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_ITEMS = [
  'FED HOLDS RATES — FOMC statement released at 14:00 EST',
  'S&P 500 +0.6% — Energy sector leads gains on crude rally',
  'BREAKING: EU Parliament passes AI Liability Directive, 412–189',
  'BTC $72,400 +2.1% — ETF inflows extend 8-day streak',
  'Anthropic releases Claude 4.5 with 200K context window',
  'TSMC Q1 revenue beats: $19.6B vs $18.9B est — AI demand cited',
];

// ─────────────────────────────────────────────────────────────────────────────
// INTEL TICKER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {function} onExpand  — () => void — switch intelState to 'open'
 * @param {function} onClose   — () => void — switch intelState to 'closed'
 */
const IntelTicker = ({ onExpand, onClose }) => {
  const { data: intelFeed } = useIntelligenceFeed(['news'], 20, 24, 300000);
  const { data: newsData } = useNews(300000);
  const [headlines, setHeadlines] = useState(FALLBACK_ITEMS);

  useEffect(() => {
    const items = intelFeed?.items;
    if (items && items.length > 0) {
      setHeadlines(
        items
          .slice(0, 15)
          .filter(i => i.title)
          .map(i => `${(i.source || 'NEWS').toUpperCase()} — ${i.title}`)
      );
      return;
    }
    // Fallback to plain news endpoint
    if (newsData?.articles?.length) {
      setHeadlines(
        newsData.articles
          .slice(0, 15)
          .filter(a => a.title)
          .map(a => `${(a.source || 'NEWS').toUpperCase()} — ${a.title}`)
      );
    }
  }, [intelFeed, newsData]);

  const doubled = [...headlines, ...headlines];
  const storyCount = intelFeed?.items?.length || newsData?.articles?.length || 0;

  return (
    <div className={styles.bar} role="complementary" aria-label="Intel ticker">

      {/* ── INTEL BADGE ── */}
      <div className={styles.intelBadge} aria-label="Intel feed summary">
        <span className={styles.badgeDot} aria-hidden="true" />
        <span className={styles.badgeLabel}>INTEL</span>
        {storyCount > 0 && (
          <span className={styles.badgeCount}>{storyCount}</span>
        )}
      </div>

      {/* ── SCROLLING HEADLINES ── */}
      <div className={styles.tickerWrap} aria-hidden="true">
        <div className={styles.tickerTrack}>
          {doubled.map((item, i) => (
            <span key={i} className={styles.tickerItem}>
              {item}
              <span className={styles.tickerDivider}> ◆ </span>
            </span>
          ))}
        </div>
      </div>

      {/* ── ACTIONS ── */}
      <div className={styles.actions}>
        <button
          className={styles.actionBtn}
          onClick={onExpand}
          title="Open Intel Feed"
          aria-label="Expand Intel Feed"
        >
          <span aria-hidden="true">▲</span>
        </button>
        <button
          className={styles.actionBtn}
          onClick={onClose}
          title="Close ticker"
          aria-label="Close Intel ticker"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

    </div>
  );
};

export default IntelTicker;
