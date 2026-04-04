/**
 * AURA NX-Alpha — FinancePanel (Bloomberg Terminal)
 *
 * Full-density trading terminal. Replaces stub. Renders inside DropPanel for 'finance'.
 *
 * LAYOUT:
 *   Header (36px)     — holographic animated border, symbol strip, market status
 *   Portfolio Strip   — total value, day P&L, index bar (SPX/NDX/VIX/BTC/ETH)
 *   3-Column Body:
 *     Left  (212px)   — Positions, P&L Summary, Watchlist
 *     Center (flex:1) — Candlestick chart, Order Book, Time & Sales
 *     Right  (216px)  — Executions, News
 *   Order Bar (36px)  — side, symbol, qty, type, price, TIF, route, notional, BUY/SELL/STAGE
 *
 * DATA: Stub arrays — wire to real feed in Connectors sprint.
 * CHART: Canvas 2D via useRef + ResizeObserver.
 * TIME & SALES: Ring buffer (max 24 rows), simulated via setInterval.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './FinancePanel.module.css';
import { useMarketOverview, useWatchlist } from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// STUB DATA
// ─────────────────────────────────────────────────────────────────────────────

const PORTFOLIO_SUMMARY = {
  totalValue:   '$284,391',
  dayPnl:       '+$2,847',
  dayPct:       '+1.01%',
  dayUp:        true,
  totalPnl:     '+$41,234',
  totalPct:     '+16.95%',
  totalUp:      true,
  cashBalance:  '$18,420',
  buyingPower:  '$36,840',
};

const INDEX_STRIP = [
  { sym: 'SPX', val: '5,891.2',  chg: '+0.42%', up: true  },
  { sym: 'NDX', val: '20,448.3', chg: '+0.71%', up: true  },
  { sym: 'VIX', val: '14.32',    chg: '-3.10%', up: false },
  { sym: 'BTC', val: '87,440',   chg: '+3.21%', up: true  },
  { sym: 'ETH', val: '3,241',    chg: '+1.88%', up: true  },
];

const POSITIONS = [
  { sym: 'NVDA', qty: 100,  avgPx: '877.10', lastPx: '924.60', pnl: '+$4,750', pct: '+5.42%', up: true  },
  { sym: 'MSFT', qty: 50,   avgPx: '438.85', lastPx: '441.18', pnl: '+$116',   pct: '+0.53%', up: true  },
  { sym: 'AAPL', qty: 75,   avgPx: '220.38', lastPx: '219.44', pnl: '-$70',    pct: '-0.43%', up: false },
  { sym: 'TSLA', qty: 40,   avgPx: '178.08', lastPx: '173.22', pnl: '-$194',   pct: '-2.73%', up: false },
  { sym: 'BTC',  qty: 0.5,  avgPx: '81,210', lastPx: '87,440', pnl: '+$3,115', pct: '+7.67%', up: true  },
];

const PNL_ROWS = [
  { label: 'Day P&L',      val: '+$2,847', up: true  },
  { label: 'Open P&L',     val: '+$7,717', up: true  },
  { label: 'Realized P&L', val: '+$1,280', up: true  },
  { label: 'Total Return',  val: '+16.95%', up: true  },
];

const WATCHLIST = [
  { sym: 'SPY',  val: '564.21', chg: '+0.41%', up: true  },
  { sym: 'QQQ',  val: '480.12', chg: '+0.69%', up: true  },
  { sym: 'AMZN', val: '210.44', chg: '+1.12%', up: true  },
  { sym: 'META', val: '582.71', chg: '+0.44%', up: true  },
  { sym: 'GOOG', val: '196.34', chg: '-0.18%', up: false },
  { sym: 'SOL',  val: '182.44', chg: '+5.41%', up: true  },
  { sym: 'XAU',  val: '3,044',  chg: '+0.88%', up: true  },
  { sym: 'WTI',  val: '81.24',  chg: '-0.91%', up: false },
];

const ASKS = [
  { px: '924.80', sz: '142' },
  { px: '924.75', sz: '289' },
  { px: '924.70', sz: '512' },
  { px: '924.65', sz: '187' },
  { px: '924.60', sz: '341' },
];

const BIDS = [
  { px: '924.55', sz: '298' },
  { px: '924.50', sz: '441' },
  { px: '924.45', sz: '156' },
  { px: '924.40', sz: '687' },
  { px: '924.35', sz: '234' },
];

const EXECUTIONS = [
  { id: 'e1', side: 'B', sym: 'NVDA', qty: 50,   px: '921.20', time: '09:32:14', status: 'FILL' },
  { id: 'e2', side: 'S', sym: 'AAPL', qty: 25,   px: '220.15', time: '09:41:08', status: 'FILL' },
  { id: 'e3', side: 'B', sym: 'MSFT', qty: 20,   px: '439.84', time: '10:02:31', status: 'PART' },
  { id: 'e4', side: 'B', sym: 'BTC',  qty: 0.5,  px: '86,910', time: '10:15:44', status: 'FILL' },
  { id: 'e5', side: 'S', sym: 'TSLA', qty: 10,   px: '175.48', time: '10:28:19', status: 'FILL' },
];

const NEWS_ITEMS = [
  { id: 'n1', headline: 'Fed holds rates; signals two cuts in H2 2026', time: '10:31', src: 'WIRE' },
  { id: 'n2', headline: 'NVIDIA beats Q1 EPS estimates by $0.18',       time: '10:18', src: 'EARN' },
  { id: 'n3', headline: 'BTC ETF inflows reach $2.1B weekly high',      time: '09:55', src: 'CRPT' },
  { id: 'n4', headline: 'Apple China sales down 8% YoY in March',       time: '09:40', src: 'MKTS' },
  { id: 'n5', headline: 'Gold hits $3,044 ATH on dollar weakness',      time: '09:12', src: 'CMDTY'},
];

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS CHART
// ─────────────────────────────────────────────────────────────────────────────

// Synthetic 30-candle OHLCV — replace with real OHLCV fetch
const CANDLES = (() => {
  let price = 880;
  return Array.from({ length: 30 }, () => {
    const o = price + (Math.random() - 0.5) * 8;
    const c = o + (Math.random() - 0.46) * 14;
    const h = Math.max(o, c) + Math.random() * 5;
    const l = Math.min(o, c) - Math.random() * 5;
    price = c;
    return { o, h, l, c };
  });
})();

function drawFinChart(canvas) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w   = canvas.offsetWidth;
  const h   = canvas.offsetHeight;
  if (!w || !h) return;

  canvas.width  = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Background
  ctx.fillStyle = 'rgba(4,0,12,0.97)';
  ctx.fillRect(0, 0, w, h);

  // Grid
  ctx.strokeStyle = 'rgba(77,64,112,0.28)';
  ctx.lineWidth = 0.5;
  for (let i = 1; i < 4; i++) {
    const y = Math.round(h * i / 4) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  for (let i = 1; i < 7; i++) {
    const x = Math.round(w * i / 7) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
  }

  // Price range
  const padX = 14, padY = 16;
  const lo    = Math.min(...CANDLES.map(c => c.l)) - 3;
  const hi    = Math.max(...CANDLES.map(c => c.h)) + 3;
  const range = hi - lo;
  const chartW = w - padX * 2;
  const chartH = h - padY * 2;
  const barW   = Math.max(2, chartW / CANDLES.length * 0.6);
  const step   = chartW / CANDLES.length;

  const toY = val => padY + (1 - (val - lo) / range) * chartH;
  const toX = i   => padX + i * step + step / 2;

  // Candles
  CANDLES.forEach((cd, i) => {
    const x     = toX(i);
    const isUp  = cd.c >= cd.o;
    const upCol = '#4ade80';
    const dnCol = '#F43F5E';
    const col   = isUp ? upCol : dnCol;

    // Wick
    ctx.strokeStyle = col;
    ctx.lineWidth   = 0.8;
    ctx.beginPath();
    ctx.moveTo(x, toY(cd.h));
    ctx.lineTo(x, toY(cd.l));
    ctx.stroke();

    // Body
    const bodyT = toY(Math.max(cd.o, cd.c));
    const bodyH = Math.max(1, Math.abs(toY(cd.o) - toY(cd.c)));
    ctx.fillStyle = isUp ? 'rgba(74,222,128,0.75)' : 'rgba(244,63,94,0.75)';
    ctx.fillRect(x - barW / 2, bodyT, barW, bodyH);
  });

  // Last-price dashed line
  const lastPx = CANDLES[CANDLES.length - 1].c;
  const py = toY(lastPx);
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = 'rgba(168,85,247,0.55)';
  ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(w - 52, py); ctx.stroke();
  ctx.setLineDash([]);

  // Price label
  ctx.fillStyle   = '#A855F7';
  ctx.font        = `${10 * dpr / dpr}px "JetBrains Mono", monospace`;
  ctx.textAlign   = 'right';
  ctx.fillText(lastPx.toFixed(2), w - 2, py - 2);
  ctx.textAlign   = 'left';
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME & SALES — ring buffer
// ─────────────────────────────────────────────────────────────────────────────

const MAX_TAS = 24;
let _tasId = 0;

function genTick() {
  _tasId++;
  const px  = (920 + Math.random() * 10).toFixed(2);
  const sz  = Math.floor(Math.random() * 800 + 10);
  const up  = Math.random() > 0.46;
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2, '0');
  const mm  = String(now.getMinutes()).padStart(2, '0');
  const ss  = String(now.getSeconds()).padStart(2, '0');
  return { id: _tasId, time: `${hh}:${mm}:${ss}`, px, sz, up };
}

// ─────────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

const SectionHead = ({ label, accent }) => (
  <div className={styles.sectionHead}>
    <span className={styles.sectionLabel} style={accent ? { color: accent } : undefined}>
      {label}
    </span>
    <span className={styles.sectionLine} aria-hidden="true" />
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE PANEL
// ─────────────────────────────────────────────────────────────────────────────

const FinancePanel = () => {

  // ── Order entry state ──
  const [side,    setSide]    = useState('BUY');
  const [sym,     setSym]     = useState('NVDA');
  const [qty,     setQty]     = useState('100');
  const [orderType, setOrderType] = useState('LMT');
  const [price,   setPrice]   = useState('924.60');
  const [tif,     setTif]     = useState('DAY');
  const [route,   setRoute]   = useState('SMART');

  const { data: overviewData } = useMarketOverview(60000);
  const { data: watchlistData } = useWatchlist(30000);

  // Live data — falls back to stub if backend unavailable
  const liveIndexStrip = overviewData?.indices
    ? overviewData.indices.map(idx => ({
        sym: idx.symbol || idx.sym,
        val: idx.price != null ? idx.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '--',
        chg: idx.change_pct != null ? `${idx.change_pct >= 0 ? '+' : ''}${idx.change_pct.toFixed(2)}%` : '--',
        up:  (idx.change_pct ?? 0) >= 0,
      }))
    : null;

  const liveWatchlist = watchlistData?.quotes
    ? watchlistData.quotes.map(q => ({
        sym: q.symbol,
        val: q.price != null ? q.price.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '--',
        chg: q.change_pct != null ? `${q.change_pct >= 0 ? '+' : ''}${q.change_pct.toFixed(2)}%` : '--',
        up:  (q.change_pct ?? 0) >= 0,
      }))
    : null;

  const activeIndexStrip = liveIndexStrip || INDEX_STRIP;
  const activeWatchlist  = liveWatchlist  || WATCHLIST;

  // Notional = qty × price (live calculation)
  const notional = (() => {
    const q = parseFloat(qty)   || 0;
    const p = parseFloat(price.replace(/,/g, '')) || 0;
    return (q * p).toLocaleString('en-US', { maximumFractionDigits: 0 });
  })();

  // ── Time & Sales ring buffer ──
  const [tasRows, setTasRows] = useState(() =>
    Array.from({ length: 8 }, () => genTick())
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setTasRows(prev => {
        const next = [genTick(), ...prev];
        return next.length > MAX_TAS ? next.slice(0, MAX_TAS) : next;
      });
    }, 1400 + Math.random() * 1200);
    return () => clearInterval(interval);
  }, []);

  // ── Canvas chart ──
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    drawFinChart(canvas);

    const ro = new ResizeObserver(() => drawFinChart(canvas));
    ro.observe(canvas.parentElement || canvas);
    return () => ro.disconnect();
  }, []);

  // ── Order submit stub ──
  const handleOrder = useCallback((action) => {
    console.info(`[FinancePanel] Order: ${action} ${qty} ${sym} @ ${price} (${orderType} ${tif} via ${route})`);
    // Future: POST to order management endpoint
  }, [qty, sym, price, orderType, tif, route]);

  return (
    <div className={styles.finRoot}>

      {/* ══ HEADER ══ */}
      <div className={styles.finHeader}>
        <div className={styles.finHeaderInner}>

          <div className={styles.finHeaderLeft}>
            <span className={styles.finSymLabel}>NVDA</span>
            <span className={styles.finNameLabel}>NVIDIA Corp · NASDAQ</span>
            <span className={styles.finPrice}>924.60</span>
            <span className={`${styles.finDelta} ${styles.up}`}>+19.41 (+2.14%)</span>
          </div>

          <div className={styles.finHeaderRight}>
            <span className={styles.finMktDot} data-open="true" aria-hidden="true" />
            <span className={styles.finMktLabel}>US MARKET OPEN</span>
            <span className={styles.finSessionTime}>09:30 – 16:00 ET</span>
          </div>

        </div>
      </div>

      {/* ══ PORTFOLIO STRIP ══ */}
      <div className={styles.portStrip}>

        <div className={styles.portBlock}>
          <span className={styles.portBlockLabel}>TOTAL VALUE</span>
          <span className={styles.portBlockVal}>{PORTFOLIO_SUMMARY.totalValue}</span>
        </div>

        <div className={styles.portSep} aria-hidden="true" />

        <div className={styles.portBlock}>
          <span className={styles.portBlockLabel}>DAY P&amp;L</span>
          <span className={`${styles.portBlockVal} ${PORTFOLIO_SUMMARY.dayUp ? styles.up : styles.dn}`}>
            {PORTFOLIO_SUMMARY.dayPnl} ({PORTFOLIO_SUMMARY.dayPct})
          </span>
        </div>

        <div className={styles.portSep} aria-hidden="true" />

        <div className={styles.portBlock}>
          <span className={styles.portBlockLabel}>OPEN P&amp;L</span>
          <span className={`${styles.portBlockVal} ${styles.up}`}>+$7,717 (+2.79%)</span>
        </div>

        <div className={styles.portSep} aria-hidden="true" />

        <div className={styles.portBlock}>
          <span className={styles.portBlockLabel}>CASH</span>
          <span className={styles.portBlockVal}>{PORTFOLIO_SUMMARY.cashBalance}</span>
        </div>

        {/* Index strip */}
        <div className={styles.portIndexStrip}>
          {activeIndexStrip.map(idx => (
            <span key={idx.sym} className={styles.portIdx}>
              <span className={styles.portIdxSym}>{idx.sym}</span>
              <span className={styles.portIdxVal}>{idx.val}</span>
              <span className={`${styles.portIdxChg} ${idx.up ? styles.up : styles.dn}`}>{idx.chg}</span>
            </span>
          ))}
        </div>

      </div>

      {/* ══ BODY — 3 COLUMNS ══ */}
      <div className={styles.finBody}>

        {/* ── LEFT COLUMN ── */}
        <div className={styles.finColL}>

          <SectionHead label="POSITIONS" />
          <div className={styles.posTable}>
            <div className={styles.posHeader}>
              <span>SYM</span><span>QTY</span><span>AVG</span><span>LAST</span><span>P&amp;L</span>
            </div>
            {POSITIONS.map(p => (
              <div key={p.sym} className={styles.posRow}>
                <span className={styles.posSym}>{p.sym}</span>
                <span className={styles.posQty}>{p.qty}</span>
                <span className={styles.posAvg}>{p.avgPx}</span>
                <span className={styles.posLast}>{p.lastPx}</span>
                <span className={`${styles.posPnl} ${p.up ? styles.up : styles.dn}`}>{p.pct}</span>
              </div>
            ))}
          </div>

          <SectionHead label="P&L SUMMARY" />
          <div className={styles.pnlTable}>
            {PNL_ROWS.map(r => (
              <div key={r.label} className={styles.pnlRow}>
                <span className={styles.pnlLabel}>{r.label}</span>
                <span className={`${styles.pnlVal} ${r.up ? styles.up : styles.dn}`}>{r.val}</span>
              </div>
            ))}
          </div>

          <SectionHead label="WATCHLIST" />
          <div className={styles.watchList}>
            {activeWatchlist.map(w => (
              <div key={w.sym} className={styles.watchRow}>
                <span className={styles.watchSym}>{w.sym}</span>
                <span className={styles.watchVal}>{w.val}</span>
                <span className={`${styles.watchChg} ${w.up ? styles.up : styles.dn}`}>{w.chg}</span>
              </div>
            ))}
          </div>

        </div>

        {/* ── CENTER COLUMN ── */}
        <div className={styles.finColC}>

          {/* Chart */}
          <div className={styles.chartWrap}>
            <div className={styles.chartToolbar}>
              {['1m','5m','15m','1h','4h','1D'].map(tf => (
                <button key={tf} className={`${styles.tfBtn} ${tf === '15m' ? styles.tfBtnActive : ''}`}>
                  {tf}
                </button>
              ))}
              <span className={styles.chartSym}>NVDA · 15m · NYSE</span>
            </div>
            <canvas ref={canvasRef} className={styles.chartCanvas} />
          </div>

          {/* Order book */}
          <SectionHead label="ORDER BOOK" />
          <div className={styles.obWrap}>
            <div className={styles.obGrid}>

              {/* Asks (reversed — lowest ask at bottom) */}
              <div className={styles.obAsks}>
                {[...ASKS].reverse().map(a => (
                  <div key={a.px} className={styles.obRow}>
                    <span className={styles.obPx} data-side="ask">{a.px}</span>
                    <span className={styles.obSz}>{a.sz}</span>
                    <div className={styles.obDepthAsk}
                      style={{ width: `${Math.min(100, parseInt(a.sz) / 6)}%` }} aria-hidden="true" />
                  </div>
                ))}
              </div>

              {/* Spread */}
              <div className={styles.obSpread}>
                <span className={styles.obSpreadVal}>0.05 spread</span>
              </div>

              {/* Bids */}
              <div className={styles.obBids}>
                {BIDS.map(b => (
                  <div key={b.px} className={styles.obRow}>
                    <span className={styles.obPx} data-side="bid">{b.px}</span>
                    <span className={styles.obSz}>{b.sz}</span>
                    <div className={styles.obDepthBid}
                      style={{ width: `${Math.min(100, parseInt(b.sz) / 8)}%` }} aria-hidden="true" />
                  </div>
                ))}
              </div>

            </div>
          </div>

          {/* Time & Sales */}
          <SectionHead label="TIME & SALES" />
          <div className={styles.tasTable} aria-label="Time and sales">
            <div className={styles.tasHeader}>
              <span>TIME</span><span>PRICE</span><span>SIZE</span>
            </div>
            <div className={styles.tasBody}>
              {tasRows.map(row => (
                <div key={row.id} className={`${styles.tasRow} ${row.up ? styles.tasUp : styles.tasDn}`}>
                  <span className={styles.tasTime}>{row.time}</span>
                  <span className={styles.tasPx}>{row.px}</span>
                  <span className={styles.tasSz}>{row.sz}</span>
                </div>
              ))}
            </div>
          </div>

        </div>

        {/* ── RIGHT COLUMN ── */}
        <div className={styles.finColR}>

          <SectionHead label="EXECUTIONS" />
          <div className={styles.execTable}>
            <div className={styles.execHeader}>
              <span>TIME</span><span>SIDE</span><span>SYM</span><span>QTY</span><span>PX</span><span>ST</span>
            </div>
            {EXECUTIONS.map(ex => (
              <div key={ex.id} className={styles.execRow}>
                <span className={styles.execTime}>{ex.time}</span>
                <span className={`${styles.execSide} ${ex.side === 'B' ? styles.sideB : styles.sideS}`}>
                  {ex.side}
                </span>
                <span className={styles.execSym}>{ex.sym}</span>
                <span className={styles.execQty}>{ex.qty}</span>
                <span className={styles.execPx}>{ex.px}</span>
                <span className={`${styles.execSt} ${ex.status === 'FILL' ? styles.stFill : styles.stPart}`}>
                  {ex.status}
                </span>
              </div>
            ))}
          </div>

          <SectionHead label="NEWS" />
          <div className={styles.newsList}>
            {NEWS_ITEMS.map(n => (
              <div key={n.id} className={styles.newsItem}>
                <div className={styles.newsHead}>
                  <span className={styles.newsSrc}>{n.src}</span>
                  <span className={styles.newsTime}>{n.time}</span>
                </div>
                <p className={styles.newsHeadline}>{n.headline}</p>
              </div>
            ))}
          </div>

        </div>

      </div>

      {/* ══ ORDER ENTRY BAR ══ */}
      <div className={styles.orderBar}>

        {/* Side toggle */}
        <div className={styles.sideToggle}>
          <button
            className={`${styles.sideBtn} ${side === 'BUY' ? styles.sideBuyActive : ''}`}
            onClick={() => setSide('BUY')}
            aria-pressed={side === 'BUY'}
          >
            BUY
          </button>
          <button
            className={`${styles.sideBtn} ${side === 'SELL' ? styles.sideSellActive : ''}`}
            onClick={() => setSide('SELL')}
            aria-pressed={side === 'SELL'}
          >
            SELL
          </button>
        </div>

        {/* Symbol */}
        <input
          className={styles.orderInput}
          style={{ width: 60 }}
          value={sym}
          onChange={e => setSym(e.target.value.toUpperCase())}
          placeholder="SYMB"
          aria-label="Symbol"
          spellCheck={false}
        />

        {/* Qty */}
        <input
          className={styles.orderInput}
          style={{ width: 60 }}
          value={qty}
          onChange={e => setQty(e.target.value)}
          placeholder="QTY"
          aria-label="Quantity"
          inputMode="numeric"
        />

        {/* Order type */}
        <select
          className={styles.orderSelect}
          value={orderType}
          onChange={e => setOrderType(e.target.value)}
          aria-label="Order type"
        >
          <option>MKT</option>
          <option>LMT</option>
          <option>STP</option>
          <option>STP LMT</option>
          <option>MOC</option>
        </select>

        {/* Price */}
        <input
          className={styles.orderInput}
          style={{ width: 72 }}
          value={price}
          onChange={e => setPrice(e.target.value)}
          placeholder="PRICE"
          aria-label="Limit price"
          inputMode="decimal"
          disabled={orderType === 'MKT'}
        />

        {/* TIF */}
        <select
          className={styles.orderSelect}
          value={tif}
          onChange={e => setTif(e.target.value)}
          aria-label="Time in force"
        >
          <option>DAY</option>
          <option>GTC</option>
          <option>IOC</option>
          <option>FOK</option>
          <option>OPG</option>
        </select>

        {/* Route */}
        <select
          className={styles.orderSelect}
          value={route}
          onChange={e => setRoute(e.target.value)}
          aria-label="Route"
        >
          <option>SMART</option>
          <option>NASDAQ</option>
          <option>NYSE</option>
          <option>DARK</option>
          <option>MIDPX</option>
        </select>

        {/* Notional display */}
        <span className={styles.notional} aria-label="Notional value">
          <span className={styles.notionalLabel}>NTL</span>
          ${notional}
        </span>

        {/* Action buttons */}
        <div className={styles.orderActions}>
          <button
            className={`${styles.orderBtn} ${styles.orderBtnBuy}`}
            onClick={() => handleOrder('BUY')}
            aria-label={`Buy ${qty} ${sym}`}
          >
            BUY
          </button>
          <button
            className={`${styles.orderBtn} ${styles.orderBtnSell}`}
            onClick={() => handleOrder('SELL')}
            aria-label={`Sell ${qty} ${sym}`}
          >
            SELL
          </button>
          <button
            className={`${styles.orderBtn} ${styles.orderBtnStage}`}
            onClick={() => handleOrder('STAGE')}
            aria-label="Stage order"
          >
            STAGE
          </button>
        </div>

      </div>

    </div>
  );
};

export default FinancePanel;
