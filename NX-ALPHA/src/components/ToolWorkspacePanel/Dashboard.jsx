/**
 * AURA Tool Workspace — Dashboard
 *
 * Four status cards:
 *   1. Dataset Health — Phoenix span count, categories, golden set sizes
 *   2. Pipeline Kanban — tool chips per stage
 *   3. My MCPs — created/published count, avg optimization score
 *   4. Training Activity — last run stats
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './ToolWorkspacePanel.module.css';

const API = 'http://127.0.0.1:8000';

const STAGE_ORDER = [
  'intake', 'composition', 'dataset', 'training', 'optimizing',
  'reevaluation', 'sandbox', 'human_testing', 'ready', 'published',
];

export default function Dashboard({ onSelectTool }) {
  const [catalog, setCatalog] = useState(null);
  const [tools,   setTools]   = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [catRes, toolRes] = await Promise.all([
        fetch(`${API}/mcp-tools/dataset-catalog`),
        fetch(`${API}/mcp-tools`),
      ]);
      if (catRes.ok)  setCatalog(await catRes.json());
      if (toolRes.ok) setTools((await toolRes.json()).tools || []);
    } catch (_) {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Kanban: group tools by stage
  const byStage = {};
  for (const s of STAGE_ORDER) byStage[s] = [];
  for (const t of tools) {
    if (byStage[t.stage]) byStage[t.stage].push(t);
    else byStage['intake'] = [...(byStage['intake'] || []), t];
  }

  const published = tools.filter(t => t.published);
  const avgScore  = tools.length
    ? (tools.reduce((s, t) => s + (t.optimization_score || 0), 0) / tools.length).toFixed(2)
    : '—';

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Dashboard</span>
        <button className={`${styles.btn} ${styles.btnSmall}`} onClick={load} disabled={loading}>
          {loading ? <span className={styles.spinner} /> : 'Refresh'}
        </button>
      </div>

      {/* Row 1: stat cards */}
      <div className={styles.cardGrid}>

        {/* Dataset Health */}
        <div className={styles.card}>
          <span className={styles.cardTitle}>Dataset Health</span>
          <span className={styles.cardValue}>{catalog?.total ?? '—'}</span>
          <span className={styles.cardSub}>total Phoenix spans</span>
          {catalog?.categories?.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {catalog.categories.map(c => (
                <span key={c.name} className={`${styles.badge} ${styles.badgeMuted}`}>
                  {c.name} · {c.count}
                </span>
              ))}
            </div>
          )}
          {catalog?.last_export && (
            <span className={styles.cardSub}>
              Last export: {new Date(catalog.last_export * 1000).toLocaleString()}
            </span>
          )}
        </div>

        {/* My MCPs */}
        <div className={styles.card}>
          <span className={styles.cardTitle}>My MCPs</span>
          <span className={styles.cardValue}>{tools.length}</span>
          <span className={styles.cardSub}>{published.length} published</span>
          <div className={styles.scoreBar} style={{ marginTop: 6 }}>
            <span>Avg score</span>
            <div className={styles.scoreTrack}>
              <div
                className={`${styles.scoreFill} ${parseFloat(avgScore) >= 0.95 ? styles.scoreFillGreen : ''}`}
                style={{ width: `${Math.min(parseFloat(avgScore || 0) * 100, 100)}%` }}
              />
            </div>
            <span>{avgScore !== '—' ? `${(parseFloat(avgScore) * 100).toFixed(0)}%` : '—'}</span>
          </div>
        </div>

      </div>

      {/* Row 2: Pipeline Kanban */}
      <div className={styles.card} style={{ overflow: 'hidden' }}>
        <span className={styles.cardTitle}>Pipeline</span>
        <div className={styles.kanban} style={{ marginTop: 8 }}>
          {STAGE_ORDER.map(stage => (
            <div key={stage} className={styles.kanbanCol}>
              <div className={styles.kanbanColTitle}>{stage.replace('_', ' ')}</div>
              {byStage[stage]?.map(t => (
                <div
                  key={t.id}
                  className={`${styles.kanbanChip} ${t.blocking_reason ? styles.kanbanChipBlocked : ''}`}
                  onClick={() => onSelectTool?.(t)}
                  title={t.blocking_reason || t.name}
                >
                  {t.name}
                  {t.blocking_reason && (
                    <span className={styles.blockReason} title={t.blocking_reason}>
                      ⚠ blocked
                    </span>
                  )}
                </div>
              ))}
              {byStage[stage]?.length === 0 && (
                <div style={{ height: 28, border: '1px dashed rgba(255,255,255,0.06)', borderRadius: 4 }} />
              )}
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}
