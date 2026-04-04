/**
 * AURA Tool Workspace — Dataset Library
 *
 * Left: category list with counts.
 * Right: paginated record browser.
 * Toggle: All / Golden Only.
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './ToolWorkspacePanel.module.css';

const API = 'http://127.0.0.1:8000';

export default function DatasetLibrary() {
  const [catalog,    setCatalog]    = useState(null);
  const [records,    setRecords]    = useState([]);
  const [total,      setTotal]      = useState(0);
  const [category,   setCategory]   = useState('');
  const [goldenOnly, setGoldenOnly] = useState(false);
  const [page,       setPage]       = useState(1);
  const [loading,    setLoading]    = useState(false);

  const loadCatalog = useCallback(async () => {
    try {
      const res = await fetch(`${API}/mcp-tools/dataset-catalog`);
      if (res.ok) setCatalog(await res.json());
    } catch (_) {}
  }, []);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page,
        limit: 50,
        golden_only: goldenOnly,
        ...(category ? { category } : {}),
      });
      const res = await fetch(`${API}/mcp-tools/dataset-records?${params}`);
      if (res.ok) {
        const data = await res.json();
        setRecords(data.records || []);
        setTotal(data.total || 0);
      }
    } catch (_) {}
    setLoading(false);
  }, [category, goldenOnly, page]);

  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  useEffect(() => { setPage(1); loadRecords(); }, [category, goldenOnly]);
  useEffect(() => { loadRecords(); }, [page]);

  const pages = Math.ceil(total / 50);

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* Left sidebar — categories */}
      <div style={{ width: 200, minWidth: 200, borderRight: '1px solid var(--border, #1a2332)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border, #1a2332)' }}>
          <span className={styles.sectionTitle}>Categories</span>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          <div
            className={`${styles.navItem} ${category === '' ? styles.navItemActive : ''}`}
            onClick={() => { setCategory(''); setPage(1); }}
          >
            <span className={styles.navDot} />
            All
            <span className={`${styles.badge} ${styles.badgeMuted}`} style={{ marginLeft: 'auto', fontSize: 9 }}>
              {total}
            </span>
          </div>
          {(catalog?.categories || []).map(cat => (
            <div
              key={cat.name}
              className={`${styles.navItem} ${category === cat.name ? styles.navItemActive : ''}`}
              onClick={() => { setCategory(cat.name); setPage(1); }}
            >
              <span className={styles.navDot} />
              {cat.name}
              <span className={`${styles.badge} ${styles.badgeMuted}`} style={{ marginLeft: 'auto', fontSize: 9 }}>
                {cat.count}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Right main */}
      <div className={styles.section}>
        <div className={styles.sectionHeader}>
          <span className={styles.sectionTitle}>
            {category || 'All Records'}
            {' '}
            <span className={styles.sectionSub}>({total} total)</span>
          </span>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'var(--text-secondary, #94a3b8)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={goldenOnly}
                onChange={e => { setGoldenOnly(e.target.checked); setPage(1); }}
              />
              Golden only
            </label>
            <button className={`${styles.btn} ${styles.btnSmall}`} onClick={() => loadRecords()} disabled={loading}>
              {loading ? <span className={styles.spinner} /> : 'Refresh'}
            </button>
          </div>
        </div>

        {loading && records.length === 0 ? (
          <div className={styles.empty}><span className={styles.spinner} /></div>
        ) : records.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>◈</span>
            <span>No records found. Run a Phoenix export to populate the dataset.</span>
          </div>
        ) : (
          <>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Prompt</th>
                  <th>Tier</th>
                  <th>Source</th>
                  <th>Quality</th>
                  <th>Golden</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r, i) => (
                  <tr key={i}>
                    <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.prompt_preview}
                    </td>
                    <td>
                      <span className={`${styles.badge} ${styles.badgeMuted}`}>{r.tier || '—'}</span>
                    </td>
                    <td>
                      <span className={`${styles.badge} ${r.source_type === 'phoenix' ? styles.badgeBlue : styles.badgeMuted}`}>
                        {r.source_type}
                      </span>
                    </td>
                    <td>{r.quality_signal != null ? `${(r.quality_signal * 100).toFixed(0)}%` : '—'}</td>
                    <td>
                      {r.is_golden
                        ? <span className={`${styles.badge} ${styles.badgeGreen}`}>✓ golden</span>
                        : <span style={{ color: 'var(--text-secondary)' }}>—</span>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {pages > 1 && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'center', padding: '8px 0' }}>
                <button className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page <= 1}>← Prev</button>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Page {page} / {pages}</span>
                <button className={`${styles.btn} ${styles.btnSmall}`} onClick={() => setPage(p => Math.min(pages, p + 1))} disabled={page >= pages}>Next →</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
