import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import styles from './IngestionControl.module.css';

const API = 'http://localhost:8000';

// ─── Toggle Switch ─────────────────────────────────────────────────────────
function Toggle({ checked, onChange, disabled }) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className={styles.toggleTrack} />
      <span className={styles.toggleThumb} />
    </label>
  );
}

// ─── Progress Bar ──────────────────────────────────────────────────────────
function ProgressBar({ pct, color }) {
  return (
    <div className={styles.progressBar}>
      <div
        className={styles.progressFill}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color || '#e6a817' }}
      />
    </div>
  );
}

// ─── Status Badge ──────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const cls = {
    running: styles.statusBadgeRunning,
    queued:  styles.statusBadgeQueued,
    done:    styles.statusBadgeDone,
    failed:  styles.statusBadgeFailed,
  }[status?.toLowerCase()] || styles.statusBadgeQueued;
  return (
    <span className={`${styles.statusBadge} ${cls}`}>
      {status || 'unknown'}
    </span>
  );
}

// ─── SECTION 1: Coverage Map ───────────────────────────────────────────────
function CoverageMap() {
  const [sources, setSources] = useState([]);

  const load = useCallback(async () => {
    try {
      const [covRes, srcRes] = await Promise.all([
        fetch(`${API}/neural/coverage`),
        fetch(`${API}/neural/sources`).catch(() => null),
      ]);
      if (!covRes.ok) return;
      const cov = await covRes.json();
      // Merge source toggles
      let enabledMap = {};
      if (srcRes?.ok) {
        const srcData = await srcRes.json();
        (srcData.sources || []).forEach(s => { enabledMap[s.id] = s.ingestion_enabled; });
      }
      // Normalize by_source dict → array with expected field names
      const bySource = cov.by_source || {};
      const SOURCE_LABELS = {
        conversations: 'Conversations', knowledge: 'Knowledge DB',
        legislative: 'Legislative', documents: 'Documents', satellites: 'Satellites',
      };
      const arr = Object.entries(bySource).map(([id, v]) => ({
        id,
        name:              SOURCE_LABELS[id] || id,
        total_records:     v.total    ?? 0,
        ingested_records:  v.mapped   ?? 0,
        queued_records:    v.queued   ?? 0,
        unmapped_records:  v.unmapped ?? 0,
        ingestion_enabled: enabledMap[id] ?? true,
      }));
      setSources(arr);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [load]);

  const toggleSource = async (id, enabled) => {
    try {
      await fetch(`${API}/neural/sources/${id}/ingestion`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled }),
      });
      setSources(prev => prev.map(s => s.id === id ? { ...s, ingestion_enabled: enabled } : s));
    } catch { /* silent */ }
  };

  const queueSource = async (sourceId) => {
    try {
      // Get jobs list, find one for this source, and queue it
      const jobsRes = await fetch(`${API}/neural/jobs`);
      if (!jobsRes.ok) return;
      const { jobs } = await jobsRes.json();
      const job = jobs?.find(j => j.source_type === sourceId && j.status !== 'complete');
      if (job) {
        await fetch(`${API}/neural/jobs/${job.id}/action`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'ingest' }),
        });
      }
      load();
    } catch { /* silent */ }
  };

  if (sources.length === 0) {
    return (
      <div style={{ color: '#333', fontSize: 11, padding: '8px 0' }}>
        No sources found.
      </div>
    );
  }

  return (
    <div>
      {sources.map(s => {
        const total    = s.total_records || 1;
        const ingested = s.ingested_records || 0;
        const queued   = s.queued_records   || 0;
        const pctIng   = (ingested / total) * 100;
        const pctQ     = (queued   / total) * 100;

        return (
          <div key={s.id} className={styles.coverageRow}>
            <span className={styles.coverageSource} title={s.name}>{s.name}</span>
            <div className={styles.coverageBarWrap}>
              <div className={styles.coverageSegmentIngested} style={{ width: `${pctIng}%` }} />
              <div className={styles.coverageSegmentQueued}   style={{ width: `${pctQ}%` }} />
              <div className={styles.coverageSegmentUnmapped} />
            </div>
            <span className={styles.coveragePct}>{Math.round(pctIng)}%</span>
            <span className={styles.coverageCount}>{ingested.toLocaleString()}r</span>
            <div className={styles.coverageActions}>
              <Toggle
                checked={s.ingestion_enabled ?? true}
                onChange={v => toggleSource(s.id, v)}
              />
              {(s.unmapped_records || 0) > 0 && (
                <button className={styles.btnSm} onClick={() => queueSource(s.id)}>
                  Queue
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── SECTION 2: Background Mapper ─────────────────────────────────────────
function MapperStatus() {
  const [mapper,   setMapper]   = useState(null);
  const [progress, setProgress] = useState(null);
  const sseRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/neural/mapper`);
      if (!res.ok) return;
      setMapper(await res.json());
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    load();
    const iv = setInterval(load, 15000);

    // SSE progress
    try {
      const es = new EventSource(`${API}/stream`);
      sseRef.current = es;
      es.addEventListener('mapping_progress', e => {
        try { setProgress(JSON.parse(e.data)); } catch { /* ignore */ }
      });
    } catch { /* SSE unavailable */ }

    return () => {
      clearInterval(iv);
      sseRef.current?.close();
    };
  }, [load]);

  const toggleMapper = async (enabled) => {
    try {
      await fetch(`${API}/neural/mapper/toggle`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ enabled }),
      });
      setMapper(prev => prev ? { ...prev, enabled } : { enabled });
    } catch { /* silent */ }
  };

  const nextSec = mapper?.next_scan_in_seconds;
  const statusText = mapper?.scanning
    ? 'Scanning…'
    : nextSec != null
      ? `Idle — next scan in ${Math.floor(nextSec / 60)}m ${Math.round(nextSec % 60)}s`
      : mapper?.enabled === false ? 'Disabled' : 'Unknown';

  return (
    <div>
      <div className={styles.mapperRow}>
        <Toggle
          checked={mapper?.enabled ?? false}
          onChange={toggleMapper}
        />
        <span className={styles.mapperStatus}>{statusText}</span>
        {mapper?.last_scan_at && (
          <span className={styles.mapperTimestamp}>
            Last: {new Date(mapper.last_scan_at).toLocaleTimeString()}
          </span>
        )}
      </div>
      {progress && (
        <div className={styles.mapperProgress}>
          {progress.message || JSON.stringify(progress)}
        </div>
      )}
    </div>
  );
}

// ─── SECTION 3: Injection Ports ────────────────────────────────────────────

// Google Drive Port
function GoogleDrivePort() {
  const [driveStatus, setDriveStatus] = useState(null);
  const [autoIngest, setAutoIngest] = useState(
    () => localStorage.getItem('port_auto_google') === 'true'
  );

  useEffect(() => {
    fetch(`${API}/data/google/status`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setDriveStatus(d))
      .catch(() => {});
  }, []);

  const connect = async () => {
    try {
      const res = await fetch(`${API}/data/google/auth-url`);
      if (!res.ok) return;
      const { url } = await res.json();
      if (url) window.open(url, '_blank');
    } catch { /* silent */ }
  };

  const browse = () => {
    // Coming soon — endpoint /data/google/drive/list may not exist
    alert('Drive browser coming soon.');
  };

  const connected = driveStatus?.connected;

  return (
    <div className={styles.portCard}>
      <div className={styles.portCardHeader}>
        <span className={styles.portIcon}>📁</span>
        <span className={styles.portTitle}>Google Drive</span>
        <span className={`${styles.portStatus} ${connected ? styles.portStatusConnected : styles.portStatusDisconnected}`}>
          {connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      {connected && driveStatus?.email && (
        <div className={styles.portBody}>{driveStatus.email}</div>
      )}
      <div className={styles.portActions}>
        {connected
          ? <button className={styles.btnSm} onClick={browse}>Browse</button>
          : <button className={styles.btnSm} onClick={connect}>Connect</button>
        }
      </div>
      <div className={styles.autoToggleRow}>
        <Toggle
          checked={autoIngest}
          onChange={v => { setAutoIngest(v); localStorage.setItem('port_auto_google', v); }}
        />
        <span>Auto-ingest</span>
      </div>
    </div>
  );
}

// Desktop Folders Port
function DesktopFoldersPort() {
  const [paths, setPaths] = useState([]);
  const [loading, setLoading] = useState(false);
  const [autoIngest, setAutoIngest] = useState(
    () => localStorage.getItem('port_auto_desktop') === 'true'
  );

  const browse = async () => {
    try {
      const result = await window.electronAPI?.openFolder?.();
      if (result && !result.canceled && result.filePaths?.length > 0) {
        setPaths(prev => [...new Set([...prev, ...result.filePaths])]);
      }
    } catch {
      // electronAPI not available yet
      console.warn('electronAPI.openFolder not available yet');
    }
  };

  const ingest = async () => {
    if (!paths.length) return;
    setLoading(true);
    try {
      await fetch(`${API}/data/knowledge/personal/batch`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ paths }),
      });
      setPaths([]);
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.portCard}>
      <div className={styles.portCardHeader}>
        <span className={styles.portIcon}>🗂️</span>
        <span className={styles.portTitle}>Desktop Folders</span>
      </div>
      <div className={styles.pathChips}>
        {paths.map((p, i) => (
          <span key={i} className={styles.pathChip} title={p}>
            {p.split(/[\\/]/).pop()}
          </span>
        ))}
        {paths.length === 0 && (
          <span className={styles.portBody}>No folders selected</span>
        )}
      </div>
      <div className={styles.portActions}>
        <button className={styles.btnSm} onClick={browse}>Browse Folders</button>
        {paths.length > 0 && (
          <button className={styles.btnSm} onClick={ingest} disabled={loading}>
            {loading ? 'Ingesting…' : 'Ingest'}
          </button>
        )}
      </div>
      <div className={styles.autoToggleRow}>
        <Toggle
          checked={autoIngest}
          onChange={v => { setAutoIngest(v); localStorage.setItem('port_auto_desktop', v); }}
        />
        <span>Auto-ingest</span>
      </div>
    </div>
  );
}

// Document Drop Port
function DocumentDropPort() {
  const [dragging, setDragging]     = useState(false);
  const [progress, setProgress]     = useState(null);
  const [fileName, setFileName]     = useState('');
  const [autoIngest, setAutoIngest] = useState(
    () => localStorage.getItem('port_auto_drop') === 'true'
  );

  const onDragOver  = e => { e.preventDefault(); setDragging(true); };
  const onDragLeave = () => setDragging(false);

  const onDrop = async e => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setProgress(0);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${API}/canvas/document`, {
        method: 'POST',
        body:   formData,
      });
      if (res.ok) setProgress(100);
      else        setProgress(-1);
    } catch {
      setProgress(-1);
    }
  };

  return (
    <div className={styles.portCard}>
      <div className={styles.portCardHeader}>
        <span className={styles.portIcon}>📄</span>
        <span className={styles.portTitle}>Document Drop</span>
      </div>
      <div
        className={`${styles.dropZone} ${dragging ? styles.dropZoneActive : ''}`}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className={styles.dropZoneIcon}>⬇</div>
        {fileName ? fileName : 'Drop a document here'}
      </div>
      {progress !== null && (
        <ProgressBar pct={progress === -1 ? 100 : progress} color={progress === -1 ? '#ef4444' : '#e6a817'} />
      )}
      <div className={styles.autoToggleRow}>
        <Toggle
          checked={autoIngest}
          onChange={v => { setAutoIngest(v); localStorage.setItem('port_auto_drop', v); }}
        />
        <span>Auto-ingest</span>
      </div>
    </div>
  );
}

// Git Repository Port
function GitRepoPort() {
  const [url,     setUrl]     = useState('');
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [autoIngest, setAutoIngest] = useState(
    () => localStorage.getItem('port_auto_git') === 'true'
  );

  const ingest = async () => {
    if (!url.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/agent-creator/ingest/git`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url: url.trim() }),
      });
      const d = await res.json();
      setResult(res.ok ? `Queued: ${d.job_id || 'ok'}` : `Error: ${d.detail || 'failed'}`);
    } catch {
      setResult('Error: network failure');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.portCard}>
      <div className={styles.portCardHeader}>
        <span className={styles.portIcon}>⬡</span>
        <span className={styles.portTitle}>Git Repository</span>
      </div>
      <input
        className={styles.urlInput}
        placeholder="https://github.com/user/repo"
        value={url}
        onChange={e => setUrl(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && ingest()}
      />
      {result && <div className={styles.portBody}>{result}</div>}
      <div className={styles.portActions}>
        <button className={styles.btnSm} onClick={ingest} disabled={loading || !url.trim()}>
          {loading ? 'Ingesting…' : 'Ingest'}
        </button>
      </div>
      <div className={styles.autoToggleRow}>
        <Toggle
          checked={autoIngest}
          onChange={v => { setAutoIngest(v); localStorage.setItem('port_auto_git', v); }}
        />
        <span>Auto-ingest</span>
      </div>
    </div>
  );
}

// Knowledge Sources Port
const KNOWLEDGE_SOURCES = [
  { id: 'wikipedia',    name: 'Wikipedia' },
  { id: 'pubmed',       name: 'PubMed' },
  { id: 'arxiv',        name: 'ArXiv' },
  { id: 'stackexchange', name: 'StackExchange' },
];

function KnowledgeSourcesPort() {
  const [statuses,   setStatuses]   = useState({});
  const [loading,    setLoading]    = useState({});
  const [autoIngest, setAutoIngest] = useState(
    () => localStorage.getItem('port_auto_knowledge') === 'true'
  );

  useEffect(() => {
    fetch(`${API}/data/knowledge/sources`)
      .then(r => r.ok ? r.json() : {})
      .then(d => setStatuses(d))
      .catch(() => {});
  }, []);

  const download = async (id) => {
    setLoading(prev => ({ ...prev, [id]: true }));
    try {
      await fetch(`${API}/data/knowledge/download/${id}`, { method: 'POST' });
      setStatuses(prev => ({ ...prev, [id]: { active: true } }));
    } catch { /* silent */ } finally {
      setLoading(prev => ({ ...prev, [id]: false }));
    }
  };

  return (
    <div className={styles.portCard}>
      <div className={styles.portCardHeader}>
        <span className={styles.portIcon}>📚</span>
        <span className={styles.portTitle}>Knowledge Sources</span>
      </div>
      <div className={styles.knowledgePills}>
        {KNOWLEDGE_SOURCES.map(s => {
          const active = statuses[s.id]?.active;
          return (
            <div key={s.id} className={styles.knowledgePill}>
              <span className={styles.pillName}>{s.name}</span>
              <span className={`${styles.pillBadge} ${active ? styles.pillBadgeActive : styles.pillBadgeInactive}`}>
                {active ? 'active' : 'idle'}
              </span>
              <button
                className={styles.btnSm}
                onClick={() => download(s.id)}
                disabled={loading[s.id]}
              >
                {loading[s.id] ? '…' : 'Download'}
              </button>
            </div>
          );
        })}
      </div>
      <div className={styles.autoToggleRow}>
        <Toggle
          checked={autoIngest}
          onChange={v => { setAutoIngest(v); localStorage.setItem('port_auto_knowledge', v); }}
        />
        <span>Auto-ingest</span>
      </div>
    </div>
  );
}

// Knowledge Curator Port
function KnowledgeCuratorPort() {
  const [hfId,    setHfId]    = useState('');
  const [result,  setResult]  = useState(null);
  const [loading, setLoading] = useState(false);
  const [autoIngest, setAutoIngest] = useState(
    () => localStorage.getItem('port_auto_curator') === 'true'
  );

  const evaluate = async () => {
    if (!hfId.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(`${API}/data/knowledge/curator/evaluate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: hfId.trim() }),
      });
      setResult(await res.json());
    } catch {
      setResult({ error: 'Network failure' });
    } finally {
      setLoading(false);
    }
  };

  const approve = async () => {
    if (!result?.id && !hfId.trim()) return;
    try {
      await fetch(`${API}/data/knowledge/curator/ingest`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ id: result?.id || hfId.trim() }),
      });
      setResult(prev => ({ ...prev, ingested: true }));
    } catch { /* silent */ }
  };

  return (
    <div className={styles.portCard}>
      <div className={styles.portCardHeader}>
        <span className={styles.portIcon}>🔬</span>
        <span className={styles.portTitle}>Knowledge Curator</span>
      </div>
      <input
        className={styles.urlInput}
        placeholder="HuggingFace ID or URL"
        value={hfId}
        onChange={e => setHfId(e.target.value)}
        onKeyDown={e => e.key === 'Enter' && evaluate()}
      />
      {result && (
        <div className={styles.resultBox}>
          {result.error
            ? result.error
            : JSON.stringify(result, null, 2)
          }
        </div>
      )}
      <div className={styles.portActions}>
        <button className={styles.btnSm} onClick={evaluate} disabled={loading || !hfId.trim()}>
          {loading ? 'Evaluating…' : 'Evaluate'}
        </button>
        {result && !result.error && !result.ingested && (
          <button className={styles.btnSm} onClick={approve}>
            Approve &amp; Ingest
          </button>
        )}
        {result?.ingested && <span style={{ fontSize: 10, color: '#22c55e' }}>Ingested ✓</span>}
      </div>
      <div className={styles.autoToggleRow}>
        <Toggle
          checked={autoIngest}
          onChange={v => { setAutoIngest(v); localStorage.setItem('port_auto_curator', v); }}
        />
        <span>Auto-ingest</span>
      </div>
    </div>
  );
}

// Notion Port
function NotionPort() {
  const [notionStatus, setNotionStatus] = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [autoIngest, setAutoIngest]     = useState(
    () => localStorage.getItem('port_auto_notion') === 'true'
  );

  useEffect(() => {
    fetch(`${API}/settings/api-keys`)
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        setNotionStatus({ connected: !!(d?.notion_token) });
      })
      .catch(() => {});
  }, []);

  const ingestPages = async () => {
    setLoading(true);
    try {
      await fetch(`${API}/data/notion/ingest`, { method: 'POST' });
    } catch { /* silent */ } finally {
      setLoading(false);
    }
  };

  const connected = notionStatus?.connected;

  return (
    <div className={styles.portCard}>
      <div className={styles.portCardHeader}>
        <span className={styles.portIcon}>◈</span>
        <span className={styles.portTitle}>Notion</span>
        <span className={`${styles.portStatus} ${connected ? styles.portStatusConnected : styles.portStatusDisconnected}`}>
          {connected == null ? '…' : connected ? 'Connected' : 'Disconnected'}
        </span>
      </div>
      {!connected && connected != null && (
        <div className={styles.portBody}>
          Add a Notion token in Settings → API Keys to enable.
        </div>
      )}
      {connected && (
        <div className={styles.portActions}>
          <button className={styles.btnSm} onClick={ingestPages} disabled={loading}>
            {loading ? 'Ingesting…' : 'Ingest Pages'}
          </button>
        </div>
      )}
      <div className={styles.autoToggleRow}>
        <Toggle
          checked={autoIngest}
          onChange={v => { setAutoIngest(v); localStorage.setItem('port_auto_notion', v); }}
        />
        <span>Auto-ingest</span>
      </div>
    </div>
  );
}

// ─── SECTION 4: Ingestion Mode ─────────────────────────────────────────────

const MODELS = ['Default', 'llama3.2', 'mistral', 'deepseek-r1:7b'];

function IngestionModeLauncher({ neuralStatus, onStarted }) {
  const [showModal, setShowModal] = useState(false);
  const [model,     setModel]     = useState(MODELS[0]);
  const [workers,   setWorkers]   = useState(4);
  const [aggr,      setAggr]      = useState(5);
  const [launching, setLaunching] = useState(false);

  const launch = async () => {
    setLaunching(true);
    try {
      await fetch(`${API}/neural/ingestion-mode/start`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, workers, aggressiveness: aggr }),
      });
      setShowModal(false);
      onStarted?.();
    } catch { /* silent */ } finally {
      setLaunching(false);
    }
  };

  return (
    <>
      <button
        className={styles.launchBtn}
        onClick={() => setShowModal(true)}
        disabled={neuralStatus?.ingestion_mode}
      >
        Launch Ingestion Mode ▶
      </button>

      {showModal && (
        <div className={styles.modalOverlay} onClick={e => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div className={styles.modal}>
            <div className={styles.modalTitle}>⊕ Launch Ingestion Mode</div>

            <div className={styles.modalField}>
              <label className={styles.modalLabel}>Model</label>
              <select
                className={styles.modalSelect}
                value={model}
                onChange={e => setModel(e.target.value)}
              >
                {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>

            <div className={styles.modalField}>
              <label className={styles.modalLabel}>Workers ({workers})</label>
              <div className={styles.sliderRow}>
                <input
                  type="range"
                  className={styles.modalSlider}
                  min={2} max={8} step={1}
                  value={workers}
                  onChange={e => setWorkers(Number(e.target.value))}
                />
                <span className={styles.sliderValue}>{workers}</span>
              </div>
            </div>

            <div className={styles.modalField}>
              <label className={styles.modalLabel}>Aggressiveness ({aggr}/10)</label>
              <div className={styles.sliderRow}>
                <input
                  type="range"
                  className={styles.modalSlider}
                  min={1} max={10} step={1}
                  value={aggr}
                  onChange={e => setAggr(Number(e.target.value))}
                />
                <span className={styles.sliderValue}>{aggr}</span>
              </div>
            </div>

            <div className={styles.modalActions}>
              <button className={styles.btnCancel} onClick={() => setShowModal(false)}>
                Cancel
              </button>
              <button className={styles.btnConfirm} onClick={launch} disabled={launching}>
                {launching ? 'Launching…' : 'Launch ▶'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function IngestionModeLockScreen({ jobs }) {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);

  const stop = async () => {
    try {
      await fetch(`${API}/neural/ingestion-mode/stop`, { method: 'POST' });
    } catch { /* silent */ }
  };

  const fmtTime = s => `${Math.floor(s / 60)}m ${s % 60}s`;

  const activeJob = jobs.find(j => j.status === 'running') || jobs[0];
  const totalRate = jobs.reduce((acc, j) => acc + (j.rate || 0), 0);
  const totalWorkers = jobs.reduce((acc, j) => acc + (j.workers || 0), 0);

  return (
    <div className={styles.lockScreen}>
      <div className={styles.lockHeader}>
        <span className={styles.lockTitle}>◈ AURA · INGESTION MODE</span>
        <button className={styles.lockStopBtn} onClick={stop}>■ Stop</button>
      </div>

      {/* Job progress bars */}
      {jobs.map(job => (
        <div key={job.id} className={styles.lockJobRow}>
          <div className={styles.lockJobLabel}>
            {job.label || job.id}
          </div>
          <ProgressBar
            pct={job.total ? (job.done / job.total) * 100 : 0}
          />
          <div style={{ fontSize: 9, color: '#555', marginTop: 3, fontFamily: 'var(--font-mono, monospace)' }}>
            chunk {job.done || 0}/{job.total || 0}
          </div>
        </div>
      ))}

      {activeJob && (
        <div className={styles.lockStats}>
          <div className={styles.lockStat}>
            <span className={styles.lockStatLabel}>Processing:</span>
            <span className={styles.lockStatValue}>{activeJob.label || activeJob.id}</span>
          </div>
          <div className={styles.lockStat}>
            <span className={styles.lockStatLabel}>Rate:</span>
            <span className={styles.lockStatValue}>{totalRate}/min</span>
          </div>
          <div className={styles.lockStat}>
            <span className={styles.lockStatLabel}>Workers:</span>
            <span className={styles.lockStatValue}>{totalWorkers} active</span>
          </div>
          <div className={styles.lockStat}>
            <span className={styles.lockStatLabel}>Elapsed:</span>
            <span className={styles.lockStatValue}>{fmtTime(elapsed)}</span>
          </div>
          {activeJob.eta_seconds != null && (
            <div className={styles.lockStat}>
              <span className={styles.lockStatLabel}>ETA:</span>
              <span className={styles.lockStatValue}>{fmtTime(activeJob.eta_seconds)}</span>
            </div>
          )}
        </div>
      )}

      {/* Worker dots */}
      {totalWorkers > 0 && (
        <div className={styles.workerDots}>
          {Array.from({ length: 8 }).map((_, i) => (
            <span
              key={i}
              className={`${styles.workerDot} ${i < totalWorkers ? styles.workerDotActive : styles.workerDotInactive}`}
            />
          ))}
        </div>
      )}

      {/* GPU info */}
      {activeJob?.model && (
        <div style={{ fontSize: 10, color: '#555', fontFamily: 'var(--font-mono, monospace)' }}>
          GPU: {activeJob.model}
        </div>
      )}

      <div className={styles.lockNote}>
        High-frequency records ingesting naturally. Do not close the application during active ingestion.
      </div>
    </div>
  );
}

// ─── Activity Feed ─────────────────────────────────────────────────────────

const MAX_EVENTS = 50;

function ActivityFeed() {
  const [events, setEvents] = useState([]);
  const logRef   = useRef(null);
  const sseRef   = useRef(null);

  useEffect(() => {
    try {
      const es = new EventSource(`${API}/stream`);
      sseRef.current = es;

      const TRACKED = [
        'lightrag_ingest_entity', 'lightrag_ingest_chunk', 'lightrag_ingest_start',
        'storage_update', 'mapping_progress',
      ];

      TRACKED.forEach(evName => {
        es.addEventListener(evName, e => {
          const ts   = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
          let summary;
          try {
            const d = JSON.parse(e.data);
            summary = d.message || d.entity || d.status || JSON.stringify(d).slice(0, 80);
          } catch {
            summary = e.data?.slice(0, 80) || evName;
          }
          setEvents(prev => [
            { id: Date.now() + Math.random(), ts, type: evName, summary },
            ...prev,
          ].slice(0, MAX_EVENTS));
        });
      });
    } catch { /* SSE unavailable */ }

    return () => sseRef.current?.close();
  }, []);

  // Auto-scroll to top when new events come in
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = 0;
  }, [events.length]);

  const isAmber = type => type.startsWith('lightrag');
  const isBlue  = type => type === 'storage_update';

  return (
    <div className={styles.eventLog} ref={logRef}>
      {events.length === 0 && (
        <span style={{ color: '#2a2a2a' }}>Listening for events…</span>
      )}
      {events.map(ev => (
        <div
          key={ev.id}
          className={`${styles.eventLine} ${isAmber(ev.type) ? styles.eventLineAmber : isBlue(ev.type) ? styles.eventLineBlue : ''}`}
        >
          <span className={styles.eventTs}>{ev.ts}</span>
          [{ev.type}] {ev.summary}
        </div>
      ))}
    </div>
  );
}

// ─── Jobs Table ────────────────────────────────────────────────────────────

function JobsTable({ jobs }) {
  if (!jobs.length) {
    return (
      <div style={{ fontSize: 11, color: '#333', padding: '8px 0' }}>
        No active jobs.
      </div>
    );
  }

  return (
    <table className={styles.jobsTable}>
      <thead>
        <tr>
          <th>Job</th>
          <th>Status</th>
          <th style={{ width: 100 }}>Progress</th>
          <th>Rate</th>
          <th>ETA</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map(job => {
          const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
          const eta = job.eta_seconds != null
            ? `${Math.floor(job.eta_seconds / 60)}m ${job.eta_seconds % 60}s`
            : '—';
          return (
            <tr key={job.id}>
              <td title={job.id}>{(job.label || job.id || '').slice(0, 24)}</td>
              <td><StatusBadge status={job.status} /></td>
              <td>
                <ProgressBar pct={pct} />
                <div style={{ fontSize: 9, color: '#444', marginTop: 2 }}>{pct}%</div>
              </td>
              <td>{job.rate != null ? `${job.rate}/min` : '—'}</td>
              <td>{eta}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ─── Main IngestionControl ─────────────────────────────────────────────────

export default function IngestionControl({ neuralStatus }) {
  const [jobs,    setJobs]    = useState([]);
  const pollRef               = useRef(null);

  const active = neuralStatus?.ingestion_mode ?? false;

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetch(`${API}/neural/jobs`);
      if (!res.ok) return;
      const data = await res.json();
      setJobs(Array.isArray(data) ? data : data.jobs || []);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    loadJobs();
    const interval = active ? 5000 : 30000;
    pollRef.current = setInterval(loadJobs, interval);
    return () => clearInterval(pollRef.current);
  }, [loadJobs, active]);

  return (
    <div className={styles.wrapper} style={{ position: 'relative' }}>
      {/* ── Section 1: Coverage Map ──────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>
          Coverage Map
          <span className={styles.sectionTitleRight}>30s refresh</span>
        </div>
        <CoverageMap />
      </div>

      {/* ── Section 2: Background Mapper ─────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Background Mapper</div>
        <MapperStatus />
      </div>

      {/* ── Section 3: Injection Ports ────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Injection Ports</div>
        <div className={styles.portGrid}>
          <GoogleDrivePort />
          <DesktopFoldersPort />
          <DocumentDropPort />
          <GitRepoPort />
          <KnowledgeSourcesPort />
          <KnowledgeCuratorPort />
          <NotionPort />
        </div>
      </div>

      {/* ── Section 4: Ingestion Mode ─────────── */}
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Ingestion Mode</div>

        <div className={styles.launchSection}>
          {!active && <JobsTable jobs={jobs} />}
          <IngestionModeLauncher
            neuralStatus={neuralStatus}
            onStarted={loadJobs}
          />
        </div>

        <div style={{ marginTop: 16 }}>
          <div className={styles.sectionTitle} style={{ fontSize: 11, borderBottom: 'none', paddingBottom: 0, marginBottom: 8 }}>
            Activity Feed
          </div>
          <ActivityFeed />
        </div>
      </div>

      {/* ── Lock Screen (active ingestion) ─── */}
      {active && <IngestionModeLockScreen jobs={jobs} />}
    </div>
  );
}
