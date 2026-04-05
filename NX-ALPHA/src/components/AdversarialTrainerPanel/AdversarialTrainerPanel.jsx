/**
 * AURA NX-Alpha — AdversarialTrainerPanel
 *
 * Native Windows adversarial training loop UI.
 * Workhorse (Ollama) poses questions, Interface Engine answers, Workhorse judges.
 * Approved / corrected pairs are stored in training_candidates + memory layers.
 *
 * LAYOUT:
 *   Left sidebar (320px) — Config form + session stats
 *   Right main          — Live turn log
 *
 * TABS:
 *   Train   — single-dataset config form (existing)
 *   History — registry of all previously run datasets with re-run / queue
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './AdversarialTrainerPanel.module.css';

const API = 'http://127.0.0.1:8000';

// ─────────────────────────────────────────────────────────────────────────────
// SUGGESTED DATASETS
// ─────────────────────────────────────────────────────────────────────────────

const SUGGESTED_DATASETS = [
  { id: 'tatsu-lab/alpaca',              label: 'Alpaca (instruction following)' },
  { id: 'HuggingFaceH4/ultrachat_200k', label: 'UltraChat (general Q&A)' },
  { id: 'nvidia/OpenMathReasoning',      label: 'OpenMath (reasoning)' },
];

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function ScoreBadge({ score }) {
  const cls = score >= 8 ? styles.scoreHigh : score >= 6 ? styles.scoreMid : styles.scoreLow;
  return <span className={[styles.scoreBadge, cls].join(' ')}>{score}/10</span>;
}

function ProgressBar({ done, total }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className={styles.progressWrap}>
      <div className={styles.progressTrack}>
        <div className={styles.progressFill} style={{ width: `${pct}%` }} />
      </div>
      <span className={styles.progressLabel}>{done} / {total} ({pct}%)</span>
    </div>
  );
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtElapsed(seconds) {
  const totalMs = Math.round((seconds || 0) * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PANEL
// ─────────────────────────────────────────────────────────────────────────────

const AdversarialTrainerPanel = () => {
  // ── Tab ──
  const [activeTab, setActiveTab] = useState('train');

  // ── Config form state ──
  const [datasetId,       setDatasetId]       = useState('tatsu-lab/alpaca');
  const [datasetSplit,    setDatasetSplit]     = useState('train');
  const [maxSamples,      setMaxSamples]       = useState(50);
  const [intervalMinutes, setIntervalMinutes]  = useState(5);
  const [judgeThreshold,  setJudgeThreshold]   = useState(6);
  const [workhorseModel,  setWorkhorseModel]   = useState('');
  const [linkedToolIds,   setLinkedToolIds]    = useState([]);
  const [availableTools,  setAvailableTools]   = useState([]);
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(false);

  // ── Session status ──
  const [status,      setStatus]      = useState(null);
  const [stats,       setStats]       = useState(null);
  const [queueStatus, setQueueStatus] = useState(null);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);

  // ── Queue builder (Train tab) ──
  const [queueList, setQueueList] = useState([]); // [{dataset_id, split, max_samples, interval_minutes, judge_threshold, workhorse_model}]

  // ── History tab ──
  const [datasets,       setDatasets]       = useState([]);
  const [selectedKeys,   setSelectedKeys]   = useState(new Set());
  const [historyLoading, setHistoryLoading] = useState(false);
  const [rerunError,     setRerunError]     = useState(null);
  const [rerunMaxSamples, setRerunMaxSamples] = useState('');

  // ── Turn log ──
  const [turnLog, setTurnLog] = useState([]);
  const [turnDetails, setTurnDetails] = useState({}); // sample_n → {question, answer, score, approved, reasoning}
  const [expandedTurn, setExpandedTurn] = useState(null);
  const pendingSampleRef = useRef(null);
  const logRef = useRef(null);

  // ── Poll status while running ──
  const pollRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API}/adversarial-trainer/status`);
      if (!r.ok) return;
      const data = await r.json();
      setStatus(prev => {
        if (prev && data.done > prev.done && data.current_sample) {
          setTurnLog(log => [
            ...log.slice(-199),
            { n: data.done, sample: data.current_sample, ts: Date.now() },
          ]);
        }
        return data;
      });
    } catch { /* non-fatal */ }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const r = await fetch(`${API}/adversarial-trainer/stats`);
      if (!r.ok) return;
      setStats(await r.json());
    } catch { /* non-fatal */ }
  }, []);

  const fetchQueueStatus = useCallback(async () => {
    try {
      const r = await fetch(`${API}/adversarial-trainer/queue`);
      if (!r.ok) return;
      setQueueStatus(await r.json());
    } catch { /* non-fatal */ }
  }, []);

  const fetchDatasets = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const r = await fetch(`${API}/adversarial-trainer/datasets`);
      if (!r.ok) return;
      setDatasets(await r.json());
    } catch { /* non-fatal */ }
    setHistoryLoading(false);
  }, []);

  // Poll on mount — fast (5s) while training is running, slow (30s) when idle
  useEffect(() => {
    fetchStatus();
    fetchStats();
    fetchQueueStatus();
    fetchDatasets();

    const tick = () => {
      fetchStatus().then(() => {
        // Only fetch stats/queue when training is actively running
        if (status?.running) {
          fetchStats();
          fetchQueueStatus();
        }
      });
    };

    // Use fast polling only when training is running
    const interval = status?.running ? 5000 : 30000;
    pollRef.current = setInterval(tick, interval);
    return () => clearInterval(pollRef.current);
  }, [fetchStatus, fetchStats, fetchQueueStatus, fetchDatasets, status?.running]);

  useEffect(() => {
    if (activeTab === 'history') fetchDatasets();
  }, [activeTab, fetchDatasets]);

  // Load available MCP tools for tool-link selector
  useEffect(() => {
    fetch(`${API}/mcp-tools`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setAvailableTools(d.tools || []))
      .catch(() => {});
  }, []);

  // SSE subscription — captures at_question / at_answer / at_judgment for detail view
  useEffect(() => {
    const es = new EventSource(`${API}/stream`);

    es.addEventListener('at_question', (e) => {
      try {
        const data = JSON.parse(e.data);
        pendingSampleRef.current = data.sample_n;
        setTurnDetails(prev => ({
          ...prev,
          [data.sample_n]: { ...(prev[data.sample_n] || {}), question: data.question },
        }));
      } catch { /* ignore */ }
    });

    es.addEventListener('at_answer', (e) => {
      try {
        const data = JSON.parse(e.data);
        const n = pendingSampleRef.current;
        if (n != null) {
          setTurnDetails(prev => ({
            ...prev,
            [n]: { ...(prev[n] || {}), answer: data.answer },
          }));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener('at_judgment', (e) => {
      try {
        const data = JSON.parse(e.data);
        const n = pendingSampleRef.current;
        if (n != null) {
          setTurnDetails(prev => ({
            ...prev,
            [n]: { ...(prev[n] || {}), score: data.score, approved: data.approved, reasoning: data.reasoning },
          }));
          setTurnLog(log => log.map(entry =>
            entry.n === n ? { ...entry, score: data.score, approved: data.approved } : entry
          ));
        }
      } catch { /* ignore */ }
    });

    return () => es.close();
  }, []);

  // Auto-scroll log — pause when a turn is expanded
  useEffect(() => {
    if (logRef.current && expandedTurn === null) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [turnLog, expandedTurn]);

  // ── Actions ──
  const handleStart = async () => {
    setLoading(true);
    setError(null);
    setTurnLog([]);
    try {
      const r = await fetch(`${API}/adversarial-trainer/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset_id:       datasetId.trim(),
          dataset_split:    datasetSplit.trim(),
          max_samples:      Number(maxSamples),
          interval_minutes: Number(intervalMinutes),
          judge_threshold:  Number(judgeThreshold),
          workhorse_model:  workhorseModel.trim() || null,
          tool_ids:         linkedToolIds,
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Start failed');
      await fetchStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await fetch(`${API}/adversarial-trainer/stop`, { method: 'POST' });
      await fetchStatus();
      await fetchQueueStatus();
    } catch { /* non-fatal */ }
    setLoading(false);
  };

  const handleAddToQueue = () => {
    if (!datasetId.trim()) return;
    setQueueList(prev => [...prev, {
      dataset_id:       datasetId.trim(),
      dataset_split:    datasetSplit.trim() || 'train',
      max_samples:      Number(maxSamples) || 50,
      interval_minutes: Number(intervalMinutes) || 0,
      judge_threshold:  Number(judgeThreshold) || 6,
      workhorse_model:  workhorseModel.trim() || null,
    }]);
  };

  const handleRemoveFromQueue = (idx) => {
    setQueueList(prev => prev.filter((_, i) => i !== idx));
  };

  const handleRunQueue = async () => {
    if (queueList.length === 0) return;
    setLoading(true);
    setError(null);
    // Use append endpoint if already running, otherwise start fresh queue
    const endpoint = running
      ? `${API}/adversarial-trainer/queue/append`
      : `${API}/adversarial-trainer/queue`;
    if (!running) setTurnLog([]);
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ datasets: queueList }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Queue failed');
      setQueueList([]);
      await fetchStatus();
      await fetchQueueStatus();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRerunSelected = async () => {
    if (selectedKeys.size === 0) return;
    setRerunError(null);
    setLoading(true);
    setTurnLog([]);
    try {
      const body = {
        dataset_keys: [...selectedKeys],
      };
      if (rerunMaxSamples && Number(rerunMaxSamples) > 0) {
        body.max_samples_override = Number(rerunMaxSamples);
      }
      const r = await fetch(`${API}/adversarial-trainer/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Re-run failed');
      setSelectedKeys(new Set());
      await fetchStatus();
      await fetchQueueStatus();
      setActiveTab('train');
    } catch (e) {
      setRerunError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRerunOne = async (key) => {
    setRerunError(null);
    setLoading(true);
    setTurnLog([]);
    try {
      const r = await fetch(`${API}/adversarial-trainer/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset_keys: [key] }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Re-run failed');
      await fetchStatus();
      await fetchQueueStatus();
      setActiveTab('train');
    } catch (e) {
      setRerunError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleKey = (key) => {
    setSelectedKeys(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    setSelectedKeys(prev =>
      prev.size === datasets.length
        ? new Set()
        : new Set(datasets.map(d => d.dataset_key))
    );
  };

  const running = status?.running === true;
  const queueRunning = queueStatus?.queue_total > 1 && (queueStatus?.active || queueStatus?.remaining > 0);

  // Merge hardcoded suggestions with registry datasets, sorted by usage
  const _knownIds = new Set(SUGGESTED_DATASETS.map(d => d.id));
  const _datasetMap = new Map(datasets.map(d => [d.dataset_id, d]));
  const allSuggestions = [
    ...SUGGESTED_DATASETS.map(d => ({
      ...d,
      _uses: _datasetMap.get(d.id)?.total_samples_done ?? 0,
      _last: _datasetMap.get(d.id)?.last_run_at ?? 0,
    })),
    ...datasets
      .filter(d => !_knownIds.has(d.dataset_id))
      .filter((d, i, arr) => arr.findIndex(x => x.dataset_id === d.dataset_id) === i)
      .map(d => ({
        id: d.dataset_id,
        label: `${d.dataset_id.split('/').pop().replace(/_/g, ' ')}${d.dataset_config ? ` (${d.dataset_config})` : ' (custom)'}`,
        _uses: d.total_samples_done ?? 0,
        _last: d.last_run_at ?? 0,
      })),
  ].sort((a, b) => (b._uses - a._uses) || (b._last - a._last));
  const visibleSuggestions = suggestionsExpanded ? allSuggestions : allSuggestions.slice(0, 5);

  return (
    <div className={styles.container}>

      {/* ── LEFT: Config + Stats ── */}
      <div className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.sidebarTitle}>Adversarial Trainer</span>
          {running && <span className={styles.runningBadge}>RUNNING</span>}
        </div>

        {/* Tab nav */}
        <div className={styles.tabNav}>
          <button
            className={[styles.tabBtn, activeTab === 'train' && styles.tabBtnActive].filter(Boolean).join(' ')}
            onClick={() => setActiveTab('train')}
          >Train</button>
          <button
            className={[styles.tabBtn, activeTab === 'history' && styles.tabBtnActive].filter(Boolean).join(' ')}
            onClick={() => setActiveTab('history')}
          >
            History
            {datasets.length > 0 && <span className={styles.tabCount}>{datasets.length}</span>}
          </button>
        </div>

        <div className={styles.sidebarBody}>

          {/* ── TRAIN TAB ── */}
          {activeTab === 'train' && (<>

            {/* Dataset */}
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Dataset</label>
              <input
                className={styles.input}
                value={datasetId}
                onChange={e => setDatasetId(e.target.value)}
                placeholder="HuggingFace dataset ID"
              />
              <div className={styles.suggestions}>
                {visibleSuggestions.map(d => (
                  <button
                    key={d.id}
                    className={[styles.suggBtn, datasetId === d.id && styles.suggActive].filter(Boolean).join(' ')}
                    onClick={() => setDatasetId(d.id)}
                  >
                    {d.label}
                  </button>
                ))}
                {allSuggestions.length > 5 && (
                  <button
                    className={styles.suggToggle}
                    onClick={() => setSuggestionsExpanded(x => !x)}
                  >
                    {suggestionsExpanded
                      ? `▲ show less`
                      : `▼ ${allSuggestions.length - 5} more`}
                  </button>
                )}
              </div>
            </div>

            {/* Split + Max Samples */}
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.label}>Split</label>
                <input
                  className={styles.input}
                  value={datasetSplit}
                  onChange={e => setDatasetSplit(e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Max Samples</label>
                <input
                  className={styles.input}
                  type="number"
                  min="1" max="10000"
                  value={maxSamples}
                  onChange={e => setMaxSamples(e.target.value)}
                />
              </div>
            </div>

            {/* Interval + Threshold */}
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.label}>Interval (min)</label>
                <input
                  className={styles.input}
                  type="number"
                  min="0" step="0.1"
                  value={intervalMinutes}
                  onChange={e => setIntervalMinutes(e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label}>Approve ≥</label>
                <input
                  className={styles.input}
                  type="number"
                  min="1" max="10"
                  value={judgeThreshold}
                  onChange={e => setJudgeThreshold(e.target.value)}
                />
              </div>
            </div>

            {/* Workhorse model override */}
            <div className={styles.fieldGroup}>
              <label className={styles.label}>Workhorse Model <span className={styles.optional}>(optional override)</span></label>
              <input
                className={styles.input}
                value={workhorseModel}
                onChange={e => setWorkhorseModel(e.target.value)}
                placeholder="e.g. mistral:7b"
              />
            </div>

            {availableTools.length > 0 && (
              <div className={styles.fieldGroup}>
                <label className={styles.label}>Link to Tool(s) <span className={styles.optional}>(optional — tags records for targeted dataset building)</span></label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 120, overflowY: 'auto' }}>
                  {availableTools.map(t => (
                    <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={linkedToolIds.includes(t.id)}
                        onChange={e => setLinkedToolIds(prev =>
                          e.target.checked ? [...prev, t.id] : prev.filter(x => x !== t.id)
                        )}
                      />
                      {t.name} <span style={{ opacity: 0.5 }}>({t.id})</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* Start / Stop / Add to Queue */}
            {error && <div className={styles.errorMsg}>{error}</div>}
            <div className={styles.actionRow}>
              {!running ? (
                <button
                  className={styles.btnStart}
                  onClick={handleStart}
                  disabled={loading || !datasetId.trim()}
                >
                  {loading ? 'Starting…' : 'Start'}
                </button>
              ) : (
                <button
                  className={styles.btnStop}
                  onClick={handleStop}
                  disabled={loading}
                >
                  {loading ? 'Stopping…' : 'Stop'}
                </button>
              )}
              <button
                className={styles.btnQueue}
                onClick={handleAddToQueue}
                disabled={!datasetId.trim()}
                title="Add to queue"
              >+ Queue</button>
            </div>

            {/* Queue builder list */}
            {queueList.length > 0 && (
              <div className={styles.queueBuilder}>
                <div className={styles.queueBuilderHeader}>
                  <span className={styles.progressTitle}>Queue — {queueList.length} dataset{queueList.length > 1 ? 's' : ''}</span>
                  <button
                    className={styles.btnRunQueue}
                    onClick={handleRunQueue}
                    disabled={loading}
                  >{running ? 'Append to Queue' : 'Run Queue'}</button>
                </div>
                {queueList.map((item, idx) => (
                  <div key={idx} className={styles.queueItem}>
                    <span className={styles.queueItemId}>{item.dataset_id}</span>
                    <span className={styles.queueItemMeta}>{item.max_samples} samples</span>
                    <button
                      className={styles.queueItemRemove}
                      onClick={() => handleRemoveFromQueue(idx)}
                    >✕</button>
                  </div>
                ))}
              </div>
            )}

            {/* Session progress */}
            {status && (status.running || status.done > 0) && (
              <div className={styles.progressSection}>
                <div className={styles.progressTitle}>Session {status.session_id}</div>
                <ProgressBar done={status.done} total={status.total} />
                <div className={styles.statRow}>
                  <span className={styles.statItem}>
                    <span className={styles.statDot} data-ok="true" /> {status.approved} approved
                  </span>
                  <span className={styles.statItem}>
                    <span className={styles.statDot} data-ok="false" /> {status.rejected} corrected
                  </span>
                  {status.elapsed_s > 0 && (
                    <span className={styles.statItem}>{fmtElapsed(status.elapsed_s)}</span>
                  )}
                </div>
              </div>
            )}

            {/* Queue progress (when queue is running) */}
            {queueRunning && (
              <div className={styles.queueSection}>
                <div className={styles.progressTitle}>
                  Queue — {queueStatus.queue_pos}/{queueStatus.queue_total}
                </div>
                <ProgressBar done={queueStatus.queue_pos} total={queueStatus.queue_total} />
                {queueStatus.current_dataset && (
                  <div className={styles.queueCurrent}>{queueStatus.current_dataset}</div>
                )}
                <div className={styles.statRow}>
                  {queueStatus.completed?.length > 0 && (
                    <span className={styles.statItem}>
                      <span className={styles.statDot} data-ok="true" /> {queueStatus.completed.length} done
                    </span>
                  )}
                  {queueStatus.remaining > 0 && (
                    <span className={styles.statItem}>{queueStatus.remaining} remaining</span>
                  )}
                </div>
              </div>
            )}

            {/* Lifetime stats */}
            {stats && stats.total_stored > 0 && (
              <div className={styles.statsSection}>
                <div className={styles.statsTitle}>Lifetime Stats</div>
                <div className={styles.statsGrid}>
                  <div className={styles.statCard}>
                    <div className={styles.statVal}>{stats.total_stored}</div>
                    <div className={styles.statLbl}>total pairs</div>
                  </div>
                  <div className={styles.statCard}>
                    <div className={styles.statVal}>{Math.round((stats.approval_rate ?? 0) * 100)}%</div>
                    <div className={styles.statLbl}>approval rate</div>
                  </div>
                  <div className={styles.statCard}>
                    <div className={styles.statVal}>{((stats.avg_quality ?? 0) * 10).toFixed(1)}</div>
                    <div className={styles.statLbl}>avg score</div>
                  </div>
                </div>
              </div>
            )}

          </>)}

          {/* ── HISTORY TAB ── */}
          {activeTab === 'history' && (<>

            {historyLoading && (
              <div className={styles.historyEmpty}>Loading…</div>
            )}

            {!historyLoading && datasets.length === 0 && (
              <div className={styles.historyEmpty}>No datasets have been run yet.</div>
            )}

            {!historyLoading && datasets.length > 0 && (<>

              {/* Bulk controls */}
              <div className={styles.historyControls}>
                <button className={styles.btnSelectAll} onClick={toggleAll} disabled={running}>
                  {selectedKeys.size === datasets.length ? 'Deselect All' : 'Select All'}
                </button>
                {selectedKeys.size > 0 && (
                  <span className={styles.selectedCount}>{selectedKeys.size} selected</span>
                )}
              </div>

              {/* Max samples override for re-runs */}
              {selectedKeys.size > 0 && (
                <div className={styles.field}>
                  <label className={styles.label}>Samples override <span className={styles.optional}>(optional)</span></label>
                  <input
                    className={styles.input}
                    type="number"
                    min="1" max="10000"
                    value={rerunMaxSamples}
                    onChange={e => setRerunMaxSamples(e.target.value)}
                    placeholder="use saved value"
                    disabled={running}
                  />
                </div>
              )}

              {rerunError && <div className={styles.errorMsg}>{rerunError}</div>}

              {/* Queue selected */}
              {selectedKeys.size > 0 && (
                <button
                  className={styles.btnStart}
                  onClick={handleRerunSelected}
                  disabled={loading || running}
                >
                  {loading ? 'Queuing…' : `Queue ${selectedKeys.size} Dataset${selectedKeys.size > 1 ? 's' : ''}`}
                </button>
              )}

              {/* Dataset list */}
              <div className={styles.historyList}>
                {datasets.map(d => (
                  <div
                    key={d.dataset_key}
                    className={[
                      styles.historyRow,
                      selectedKeys.has(d.dataset_key) && styles.historyRowSelected,
                    ].filter(Boolean).join(' ')}
                    onClick={() => toggleKey(d.dataset_key)}
                  >
                    <div className={styles.historyRowTop}>
                      <input
                        type="checkbox"
                        className={styles.historyCheck}
                        checked={selectedKeys.has(d.dataset_key)}
                        onChange={() => toggleKey(d.dataset_key)}
                        onClick={e => e.stopPropagation()}
                        disabled={running}
                      />
                      <span className={styles.historyDatasetId}>{d.dataset_id}</span>
                      <button
                        className={styles.btnRerun}
                        onClick={e => { e.stopPropagation(); handleRerunOne(d.dataset_key); }}
                        disabled={loading || running}
                      >Re-run</button>
                    </div>
                    <div className={styles.historyMeta}>
                      <span>{d.total_samples_done ?? 0} samples</span>
                      {d.dataset_config && <span>config: {d.dataset_config}</span>}
                      <span>{d.dataset_split}</span>
                      <span>{fmtDate(d.last_run_at)}</span>
                    </div>
                  </div>
                ))}
              </div>

            </>)}

          </>)}

        </div>
      </div>

      {/* ── RIGHT: Turn Log ── */}
      <div className={styles.main}>
        <div className={styles.mainHeader}>
          <span className={styles.mainTitle}>Turn Log</span>
          <button className={styles.clearBtn} onClick={() => setTurnLog([])}>Clear</button>
        </div>

        <div className={styles.logScroll} ref={logRef}>
          {turnLog.length === 0 ? (
            <div className={styles.logEmpty}>
              {running
                ? 'Waiting for first turn…'
                : 'Start a session to see live turn output here.'
              }
            </div>
          ) : (
            turnLog.map((entry, i) => {
              const detail = turnDetails[entry.n];
              const isExpanded = expandedTurn === entry.n;
              return (
                <div
                  key={i}
                  className={[
                    styles.logEntry,
                    styles.logEntryClickable,
                    isExpanded && styles.logEntryExpanded,
                  ].filter(Boolean).join(' ')}
                  onClick={() => setExpandedTurn(isExpanded ? null : entry.n)}
                >
                  <div className={styles.logEntryHeader}>
                    <span className={styles.logN}>#{entry.n}</span>
                    {entry.score != null && <ScoreBadge score={entry.score} />}
                    {entry.approved != null && (
                      <span className={entry.approved ? styles.logApproved : styles.logRejected}>
                        {entry.approved ? 'APPROVED' : 'CORRECTED'}
                      </span>
                    )}
                    <span className={styles.logSample}>{entry.sample}</span>
                    <span className={styles.logChevron}>{isExpanded ? '▲' : '▼'}</span>
                  </div>

                  {isExpanded && (
                    <div className={styles.turnDetail}>
                      {detail?.question ? (
                        <div className={styles.turnSection}>
                          <div className={styles.turnSectionLabel}>Question</div>
                          <div className={styles.turnSectionBody}>{detail.question}</div>
                        </div>
                      ) : (
                        <div className={styles.turnSectionLabel}>No question data — connect to a live session to capture details</div>
                      )}
                      {detail?.answer && (
                        <div className={styles.turnSection}>
                          <div className={styles.turnSectionLabel}>Answer</div>
                          <div className={styles.turnSectionBody}>{detail.answer}</div>
                        </div>
                      )}
                      {detail?.score != null && (
                        <div className={styles.turnSection}>
                          <div className={styles.turnSectionLabel}>Judgment</div>
                          <div className={styles.turnJudgmentRow}>
                            <ScoreBadge score={detail.score} />
                            <span className={detail.approved ? styles.logApproved : styles.logRejected}>
                              {detail.approved ? 'Approved' : 'Needs correction'}
                            </span>
                          </div>
                          {detail.reasoning && (
                            <div className={styles.turnReasoning}>{detail.reasoning}</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
          {running && status?.current_sample && (
            <div className={styles.logCurrent}>
              <span className={styles.logCurrentLabel}>Processing…</span>
              {status.current_sample}
            </div>
          )}
        </div>
      </div>

    </div>
  );
};

export default AdversarialTrainerPanel;
