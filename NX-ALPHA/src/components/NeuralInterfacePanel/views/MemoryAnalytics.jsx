import React, { useState, useEffect, useRef } from 'react';
import {
  BarChart, Bar, LineChart, Line,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
  Cell,
} from 'recharts';
import styles from './MemoryAnalytics.module.css';

const API          = 'http://localhost:8000';
const POLL_MS      = 15000;
const HISTORY_KEY  = 'neural_analytics_history';
const MAX_HISTORY  = 24;

// Layer definitions
const LAYERS = [
  {
    id:       'l1',
    name:     'L1 SQLite',
    sub:      'Structured Records',
    color:    '#e6a817',
    metricKey: 'record_count',
    metricUnit: 'records',
    secondaryKeys: [
      { key: 'tables',       label: 'Tables' },
      { key: 'l1_size_mb',   label: 'Size' },
    ],
    sizeKey: 'l1_size_mb',
  },
  {
    id:       'l2',
    name:     'L2 ChromaDB',
    sub:      'Vector Embeddings',
    color:    '#3b82f6',
    metricKey: 'embeddings',
    metricUnit: 'vectors',
    secondaryKeys: [
      { key: 'embedding_model', label: 'Model' },
      { key: 'l2_size_mb',     label: 'Size' },
    ],
    sizeKey: 'l2_size_mb',
  },
  {
    id:       'l3',
    name:     'L3 Neo4j',
    sub:      'Knowledge Graph',
    color:    '#8b5cf6',
    metricKey: 'facts',
    metricUnit: 'facts',
    secondaryKeys: [
      { key: 'relationships', label: 'Relations' },
      { key: 'l3_size_mb',    label: 'Size' },
    ],
    sizeKey: 'l3_size_mb',
  },
  {
    id:       'lightrag',
    name:     'LightRAG',
    sub:      'Entity Graph',
    color:    '#14b8a6',
    metricKey: 'entities',
    metricUnit: 'entities',
    secondaryKeys: [
      { key: 'chunks',      label: 'Chunks' },
      { key: 'rag_size_mb', label: 'Size' },
    ],
    sizeKey: 'rag_size_mb',
  },
];

function formatBytes(mb) {
  if (mb == null) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb} MB`;
}

// Custom dark tooltip for recharts
function DarkTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background:   '#1e1e1e',
      border:       '1px solid #2a2a2a',
      borderRadius: 3,
      padding:      '6px 10px',
      fontSize:     10,
      fontFamily:   'var(--font-mono, monospace)',
      color:        '#e0e0e0',
    }}>
      <div style={{ color: '#888', marginBottom: 3 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || '#e6a817' }}>
          {p.name}: {typeof p.value === 'number' ? p.value.toLocaleString() : p.value}
        </div>
      ))}
    </div>
  );
}

export default function MemoryAnalytics() {
  const [status,  setStatus]  = useState(null);
  const [history, setHistory] = useState(() => {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
  });
  const [error,   setError]   = useState(false);
  const pollRef = useRef(null);

  const loadData = async () => {
    try {
      const statusRes = await fetch(`${API}/neural/status`);
      if (!statusRes.ok) throw new Error('status error');
      const raw = await statusRes.json();

      // Normalize nested API response → flat object expected by LAYERS config
      const statusData = {
        record_count:    raw.l1?.record_count         ?? 0,
        embeddings:      raw.l2?.total_embeddings     ?? 0,
        facts:           raw.l3?.fact_count           ?? 0,
        entities:        raw.lightrag?.entity_count   ?? 0,
        l1_size_mb:      raw.l1?.db_size_mb           ?? 0,
        l2_size_mb:      0,  // ChromaDB doesn't expose storage size
        l3_size_mb:      raw.l3?.db_size_mb           ?? 0,
        rag_size_mb:     0,  // LightRAG storage size not tracked
        tables:          raw.l1?.fts_indexed != null ? `${raw.l1.fts_indexed} FTS` : '—',
        embedding_model: raw.l2?.embedding_model      || '—',
        relationships:   raw.lightrag?.relation_count ?? 0,
        chunks:          raw.lightrag?.seen_ids        ?? 0,
        queue_size:      raw.lightrag?.queue_size      ?? 0,
        l1_ok:           raw.l1?.available             ?? false,
        l2_ok:           raw.l2?.available             ?? false,
        l3_ok:           raw.l3?.available             ?? false,
        lr_ok:           raw.lightrag?.available       ?? false,
      };
      setStatus(statusData);
      setError(false);

      // Append to rolling history
      setHistory(prev => {
        const point = {
          t:     new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          total: statusData.record_count + statusData.embeddings + statusData.facts + statusData.entities,
          l1:    statusData.record_count,
          l2:    statusData.embeddings,
          l3:    statusData.facts,
          rag:   statusData.entities,
        };
        const next = [...prev, point].slice(-MAX_HISTORY);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
        return next;
      });
    } catch {
      setError(true);
    }
  };

  useEffect(() => {
    loadData();
    pollRef.current = setInterval(loadData, POLL_MS);
    return () => clearInterval(pollRef.current);
  }, []);

  // Build storage bar chart data
  const storageData = LAYERS.map(l => ({
    name:    l.name,
    size:    status?.[l.sizeKey] ?? 0,
    color:   l.color,
  }));

  if (error && !status) {
    return (
      <div className={styles.loadState}>
        NEURAL BACKEND UNAVAILABLE
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      {/* ── Metric Cards ────────────────────────────── */}
      <div>
        <div className={styles.sectionTitle}>Memory Layers</div>
        <div className={styles.cardsGrid}>
          {LAYERS.map(layer => {
            const okKey   = { l1: 'l1_ok', l2: 'l2_ok', l3: 'l3_ok', lightrag: 'lr_ok' }[layer.id];
            const available = !error && !!(status?.[okKey]);
            const primary   = status?.[layer.metricKey] ?? 0;
            return (
              <div key={layer.id} className={styles.card}>
                <div
                  className={styles.cardAccentBar}
                  style={{ background: layer.color }}
                />
                <div className={styles.cardHeader}>
                  <span
                    className={`${styles.cardLed} ${available ? styles.ledGreen : styles.ledRed}`}
                  />
                  <span className={styles.cardTitle}>{layer.name}</span>
                  <span className={styles.cardSub}>{layer.sub}</span>
                </div>
                <div className={styles.cardMetricPrimary} style={{ color: layer.color }}>
                  {primary.toLocaleString()}
                  <span className={styles.cardMetricUnit}>{layer.metricUnit}</span>
                </div>
                <div className={styles.cardSecondaryRows}>
                  {layer.secondaryKeys.map(s => (
                    <div key={s.key} className={styles.cardSecRow}>
                      <span className={styles.cardSecLabel}>{s.label}</span>
                      <span className={styles.cardSecValue}>
                        {s.key.endsWith('_mb')
                          ? formatBytes(status?.[s.key])
                          : (status?.[s.key] ?? '—')}
                      </span>
                    </div>
                  ))}
                </div>
                <div className={styles.cardDbSize}>
                  DB: {formatBytes(status?.[layer.sizeKey])}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Storage Bar Chart ────────────────────────── */}
      <div className={styles.chartSection}>
        <div className={styles.sectionTitle}>Storage Usage</div>
        <div className={styles.chartWrapper}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={storageData}
              layout="vertical"
              margin={{ top: 0, right: 20, bottom: 0, left: 80 }}
            >
              <XAxis
                type="number"
                tick={{ fill: '#555', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                tickLine={false}
                axisLine={{ stroke: '#2a2a2a' }}
                tickFormatter={v => `${v}MB`}
              />
              <YAxis
                type="category"
                dataKey="name"
                tick={{ fill: '#777', fontSize: 10, fontFamily: 'var(--font-condensed, monospace)' }}
                tickLine={false}
                axisLine={false}
                width={75}
              />
              <Tooltip content={<DarkTooltip />} />
              <Bar dataKey="size" name="Storage (MB)" radius={[0, 2, 2, 0]}>
                {storageData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} fillOpacity={0.75} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── History Line Chart ───────────────────────── */}
      <div className={styles.historySection}>
        <div className={styles.sectionTitle}>24hr Record History</div>
        <div className={styles.historyWrapper}>
          {history.length < 2 ? (
            <div className={styles.loadState} style={{ height: '100%' }}>
              Collecting data…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={history}
                margin={{ top: 4, right: 16, bottom: 0, left: 10 }}
              >
                <XAxis
                  dataKey="t"
                  tick={{ fill: '#444', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  tickLine={false}
                  axisLine={{ stroke: '#2a2a2a' }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: '#444', fontSize: 9, fontFamily: 'JetBrains Mono, monospace' }}
                  tickLine={false}
                  axisLine={false}
                  width={40}
                />
                <Tooltip content={<DarkTooltip />} />
                <Line type="monotone" dataKey="l1"    stroke="#e6a817" strokeWidth={1.5} dot={false} name="L1" />
                <Line type="monotone" dataKey="l2"    stroke="#3b82f6" strokeWidth={1.5} dot={false} name="L2" />
                <Line type="monotone" dataKey="l3"    stroke="#8b5cf6" strokeWidth={1.5} dot={false} name="L3" />
                <Line type="monotone" dataKey="rag"   stroke="#14b8a6" strokeWidth={1.5} dot={false} name="RAG" />
                <Line type="monotone" dataKey="total" stroke="#e0e0e0" strokeWidth={2}   dot={false} name="Total" strokeDasharray="4 2" />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
