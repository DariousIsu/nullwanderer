import React, { useState, useEffect, useRef, lazy, Suspense } from 'react';
import styles from './NeuralInterfacePanel.module.css';

const GraphView      = lazy(() => import('./views/GraphView'));
const MemoryAnalytics = lazy(() => import('./views/MemoryAnalytics'));
const IngestionControl = lazy(() => import('./views/IngestionControl'));

const NAV_ITEMS = [
  { id: 'graph',     icon: '⬡', label: 'Graph' },
  { id: 'analytics', icon: '◈', label: 'Analytics' },
  { id: 'ingestion', icon: '⊕', label: 'Ingestion' },
];

const POLL_INTERVAL = 15000;

const DEFAULT_STATUS = {
  available:      false,
  l1_ok:          false,
  l2_ok:          false,
  l3_ok:          false,
  lr_ok:          false,
  record_count:   0,
  embeddings:     0,
  facts:          0,
  queue_size:     0,
  ingestion_mode: false,
};

export default function NeuralInterfacePanel() {
  const [activeView, setActiveView]   = useState('graph');
  const [status, setStatus]           = useState(DEFAULT_STATUS);
  const pollRef                       = useRef(null);

  const fetchStatus = async () => {
    try {
      const res = await fetch('http://localhost:8000/neural/status');
      if (!res.ok) throw new Error('status not ok');
      const data = await res.json();
      setStatus({
        available:      true,
        l1_ok:          data.l1?.available ?? false,
        l2_ok:          data.l2?.available ?? false,
        l3_ok:          data.l3?.available ?? false,
        lr_ok:          data.lightrag?.available ?? false,
        record_count:   data.l1?.record_count ?? 0,
        embeddings:     data.l2?.total_embeddings ?? 0,
        facts:          data.l3?.fact_count ?? 0,
        queue_size:     data.lightrag?.queue_size ?? 0,
        ingestion_mode: data.ingestion_mode ?? false,
      });
    } catch {
      setStatus(prev => ({ ...prev, available: false }));
    }
  };

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, POLL_INTERVAL);
    return () => clearInterval(pollRef.current);
  }, []);

  return (
    <div className={styles.panel}>
      {/* ── Sidebar ─────────────────────────────────── */}
      <div className={styles.sidebar}>
        {status.ingestion_mode && (
          <div className={styles.ingestionModeBar}>⚡ INGESTION MODE</div>
        )}

        <nav className={styles.navList}>
          {NAV_ITEMS.map(item => (
            <button
              key={item.id}
              className={`${styles.navItem} ${activeView === item.id ? styles.navItemActive : ''}`}
              onClick={() => setActiveView(item.id)}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>

        {/* ── Live status ───────────────────────── */}
        <div className={styles.liveSection}>
          <div className={styles.liveSectionLabel}>Live</div>

          <div className={styles.liveRow}>
            <span className={`${styles.led} ${status.l1_ok ? styles.ledGreen : styles.ledRed}`} />
            <span className={styles.liveRowLabel}>L1</span>
            <span>{status.record_count.toLocaleString()}r</span>
          </div>

          <div className={styles.liveRow}>
            <span className={`${styles.led} ${status.l2_ok ? styles.ledGreen : styles.ledRed}`} />
            <span className={styles.liveRowLabel}>L2</span>
            <span>{status.embeddings.toLocaleString()}e</span>
          </div>

          <div className={styles.liveRow}>
            <span className={`${styles.led} ${status.l3_ok ? styles.ledGreen : styles.ledRed}`} />
            <span className={styles.liveRowLabel}>L3</span>
            <span>{status.facts.toLocaleString()}f</span>
          </div>

          <div className={styles.liveRow}>
            <span
              className={`${styles.led} ${status.queue_size > 0 ? styles.ledAmber : styles.ledGreen}`}
            />
            <span className={styles.liveRowLabel}>⬡ Q</span>
            <span>{status.queue_size}</span>
          </div>
        </div>
      </div>

      {/* ── Content Area ────────────────────────────── */}
      <div className={styles.content}>
        <Suspense fallback={<PanelLoader />}>
          {activeView === 'graph'     && <GraphView neuralStatus={status} />}
          {activeView === 'analytics' && <MemoryAnalytics />}
          {activeView === 'ingestion' && <IngestionControl neuralStatus={status} />}
        </Suspense>
      </div>
    </div>
  );
}

function PanelLoader() {
  return (
    <div style={{
      display:         'flex',
      alignItems:      'center',
      justifyContent:  'center',
      height:          '100%',
      color:           '#444',
      fontSize:        '11px',
      letterSpacing:   '.06em',
      fontFamily:      'var(--font-condensed, monospace)',
    }}>
      LOADING...
    </div>
  );
}
