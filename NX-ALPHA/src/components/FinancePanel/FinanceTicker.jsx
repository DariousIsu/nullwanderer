/**
 * AURA NX-Alpha — FinanceTicker
 *
 * 28px persistent strip rendered between AppBar and workspace.
 * Visible when finState === 'ticker' (Finance 3-state machine).
 *
 * Contains:
 *   - Portfolio pill (left) — total value + day P&L
 *   - Scrolling ticker tape (center) — 12 symbols × 2, CSS animation
 *   - Action buttons (right) — Expand (opens full terminal) + Close
 */

import { useState, useEffect } from 'react';
import styles from './FinanceTicker.module.css';
import { useMarketOverview } from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// TICKER DATA — fallback when backend unavailable
// ─────────────────────────────────────────────────────────────────────────────

const FALLBACK_ITEMS = [
  { sym: 'SPX',     val: '5,891.2',  chg: '+0.42%', up: true  },
  { sym: 'NDX',     val: '20,448.3', chg: '+0.71%', up: true  },
  { sym: 'VIX',     val: '14.32',    chg: '-3.10%', up: false },
  { sym: 'BTC',     val: '87,440',   chg: '+3.21%', up: true  },
  { sym: 'ETH',     val: '3,241',    chg: '+1.88%', up: true  },
  { sym: 'NVDA',    val: '924.60',   chg: '+2.14%', up: true  },
  { sym: 'AAPL',    val: '219.44',   chg: '-0.32%', up: false },
  { sym: 'TSLA',    val: '173.22',   chg: '-1.56%', up: false },
  { sym: 'EUR/USD', val: '1.0841',   chg: '-0.14%', up: false },
  { sym: 'XAU',     val: '3,044',    chg: '+0.88%', up: true  },
  { sym: 'WTI',     val: '81.24',    chg: '-0.91%', up: false },
  { sym: 'MSFT',    val: '441.18',   chg: '+0.88%', up: true  },
];

function _fmt(n) {
  if (n == null) return '—';
  return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 1 }) : n.toFixed(2);
}

function _mapOverview(data) {
  if (!data?.tickers?.length) return null;
  return data.tickers.map(t => {
    const pct = t.change_percent ?? 0;
    return {
      sym: t.symbol,
      val: _fmt(t.price),
      chg: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
      up:  pct >= 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE TICKER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {function} onExpand  — () => void — switch finState to 'open'
 * @param {function} onClose   — () => void — switch finState to 'closed'
 */
const FinanceTicker = ({ onExpand, onClose }) => {
  const { data: marketData } = useMarketOverview(60000);
  const [items, setItems] = useState(FALLBACK_ITEMS);

  useEffect(() => {
    const live = _mapOverview(marketData);
    if (live) setItems(live);
  }, [marketData]);

  // Double the items so the CSS translateX(-50%) loop is seamless
  const doubled = [...items, ...items];

  return (
    <div className={styles.bar} role="complementary" aria-label="Finance ticker">

      {/* ── PORTFOLIO PILL ── */}
      <div className={styles.portPill} aria-label="Portfolio summary">
        <span className={styles.portLabel}>PORTFOLIO</span>
        <span className={styles.portValue}>$284,391</span>
        <span className={styles.portPnl}>+$2,847</span>
        <span className={styles.portPct}>(+1.01%)</span>
      </div>

      {/* ── SCROLLING TICKER ── */}
      <div className={styles.tickerWrap} aria-hidden="true">
        <div className={styles.tickerTrack}>
          {doubled.map((item, i) => (
            <span key={i} className={styles.tickerItem}>
              <span className={styles.tickerSym}>{item.sym}</span>
              <span className={styles.tickerVal}>{item.val}</span>
              <span className={`${styles.tickerChg} ${item.up ? styles.up : styles.dn}`}>
                {item.chg}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* ── ACTIONS ── */}
      <div className={styles.actions}>
        <button
          className={styles.actionBtn}
          onClick={onExpand}
          title="Open terminal"
          aria-label="Expand finance terminal"
        >
          <span aria-hidden="true">▲</span>
        </button>
        <button
          className={styles.actionBtn}
          onClick={onClose}
          title="Close ticker"
          aria-label="Close finance ticker"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>

    </div>
  );
};

export default FinanceTicker;
