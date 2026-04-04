/**
 * AURA Tool Workspace — My MCPs
 *
 * Cards for each published tool: name, version, golden_set_size, optimization_score, last published.
 * Actions: Re-publish | View Golden Set | Delete
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './ToolWorkspacePanel.module.css';

const API = 'http://127.0.0.1:8000';

export default function MyMCPs({ onSelectTool }) {
  const [tools,   setTools]   = useState([]);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mcp-tools`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setTools((data.tools || []).filter(t => t.published || t.stage === 'ready' || t.stage === 'published'));
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = useCallback(async (tool) => {
    if (!window.confirm(`Delete "${tool.name}"? (Files preserved, published MCPs continue working.)`)) return;
    try {
      await fetch(`${API}/mcp-tools/${tool.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      alert(`Delete failed: ${e.message}`);
    }
  }, [load]);

  const handleDownload = useCallback(async (tool, target) => {
    window.open(`${API}/mcp-tools/${tool.id}/download/${target}`, '_blank');
  }, []);

  if (loading) return (
    <div className={styles.section}>
      <div className={styles.empty}><span className={styles.spinner} /></div>
    </div>
  );

  if (error) return (
    <div className={styles.section}>
      <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>
    </div>
  );

  if (tools.length === 0) return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>My MCPs</span>
      </div>
      <div className={styles.empty}>
        <span className={styles.emptyIcon}>◧</span>
        <span>No published MCPs yet. Build and publish a tool from the Tool Builder.</span>
      </div>
    </div>
  );

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>My MCPs</span>
        <button className={`${styles.btn} ${styles.btnSmall}`} onClick={load}>Refresh</button>
      </div>

      <div className={styles.cardGrid}>
        {tools.map(tool => (
          <div key={tool.id} className={styles.card}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)' }}>{tool.name}</span>
              <span className={`${styles.badge} ${tool.stage === 'published' ? styles.badgeGreen : styles.badgeAmber}`}>
                {tool.stage}
              </span>
            </div>

            <span className={styles.cardSub}>{tool.description?.slice(0, 100)}</span>

            <div style={{ display: 'flex', gap: 12, fontSize: 10, color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
              <span>v{tool.version_tag || '1.0.0'}</span>
              <span>{tool.golden_set_size} golden examples</span>
              <span>Score: {tool.optimization_score ? `${(tool.optimization_score * 100).toFixed(0)}%` : '—'}</span>
              {tool.auto_update && (
                <span title="Re-optimizes and re-publishes automatically when golden set grows" style={{ color: 'var(--accent-green, #4ade80)' }}>
                  ⟳ auto-update on
                </span>
              )}
            </div>

            {/* Publish targets */}
            {tool.publish_targets?.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {tool.publish_targets.map(t => (
                  <button
                    key={t}
                    className={`${styles.btn} ${styles.btnSmall}`}
                    onClick={() => handleDownload(tool, t)}
                    title={`Download ${t} package`}
                  >
                    ↓ {t}
                  </button>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <button
                className={`${styles.btn} ${styles.btnSmall}`}
                onClick={() => onSelectTool?.(tool)}
              >
                Open
              </button>
              {tool.auto_update && (
                <button
                  className={`${styles.btn} ${styles.btnSmall}`}
                  title="Run auto-update check now"
                  onClick={async () => {
                    await fetch(`${API}/mcp-tools/${tool.id}/auto-update-check`, { method: 'POST' });
                    alert(`Auto-update check started for ${tool.name}`);
                  }}
                >
                  ⟳ Check Now
                </button>
              )}
              <button
                className={`${styles.btn} ${styles.btnSmall} ${styles.btnDanger}`}
                onClick={() => handleDelete(tool)}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
