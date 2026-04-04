/**
 * AURA NX-Alpha — HuggingFace Model Browser
 *
 * Provides full model discovery and download management inside AURA.
 * No browser, no terminal, no manual wget.
 *
 * TABS:
 *   Browse    — search HF hub, view model cards, download individual files
 *   Downloads — active download progress bars (SSE-driven)
 *   Installed — all files in ~/.aura/models/ with delete
 *
 * SMART ROUTING:
 *   Each file shows its auto-detected destination before download.
 *   GGUF → interface/, piper ONNX → voice/piper/, etc.
 *   User can see the destination, cannot override (keeps paths clean).
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import styles from './SectionHuggingFace.module.css';

const BASE = 'http://localhost:8000';

const TASK_OPTIONS = [
  { value: '',                          label: 'All Tasks' },
  { value: 'text-generation',           label: 'Text Generation' },
  { value: 'text2text-generation',      label: 'Text-to-Text' },
  { value: 'automatic-speech-recognition', label: 'Speech Recognition' },
  { value: 'text-to-speech',            label: 'Text to Speech' },
  { value: 'feature-extraction',        label: 'Embeddings' },
  { value: 'image-to-text',             label: 'Vision / Image-to-Text' },
  { value: 'visual-question-answering', label: 'Visual QA' },
];

const SORT_OPTIONS = [
  { value: 'downloads', label: 'Most Downloaded' },
  { value: 'likes',     label: 'Most Liked' },
  { value: 'modified',  label: 'Recently Updated' },
];

async function apiFetch(path, opts = {}) {
  try {
    const r = await fetch(`${BASE}${path}`, opts);
    return await r.json();
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// BROWSE TAB
// ─────────────────────────────────────────────────────────────────────────────

const BrowseTab = ({ onDownloadStarted }) => {
  const [query,      setQuery]      = useState('');
  const [task,       setTask]       = useState('');
  const [sort,       setSort]       = useState('downloads');
  const [results,    setResults]    = useState([]);
  const [searching,  setSearching]  = useState(false);
  const [expanded,   setExpanded]   = useState(null);   // model_id of expanded card
  const [modelInfo,  setModelInfo]  = useState({});     // { model_id: info }
  const [loadingInfo, setLoadingInfo] = useState(null);
  const [starting,   setStarting]   = useState({});     // { filename: bool }

  const searchTimeout = useRef(null);

  const doSearch = useCallback(async (q, t, s) => {
    if (!q.trim() && !t) return;
    setSearching(true);
    const params = new URLSearchParams({ q, sort: s, limit: '20' });
    if (t) params.set('task', t);
    const data = await apiFetch(`/hf/search?${params}`);
    setSearching(false);
    if (data?.models) setResults(data.models);
  }, []);

  const handleSearch = useCallback((q, t, s) => {
    clearTimeout(searchTimeout.current);
    searchTimeout.current = setTimeout(() => doSearch(q, t, s), 500);
  }, [doSearch]);

  const handleExpand = useCallback(async (modelId) => {
    if (expanded === modelId) { setExpanded(null); return; }
    setExpanded(modelId);
    if (modelInfo[modelId]) return;

    setLoadingInfo(modelId);
    const info = await apiFetch(`/hf/model/${encodeURIComponent(modelId)}`);
    setLoadingInfo(null);
    if (info && !info.error) {
      setModelInfo(prev => ({ ...prev, [modelId]: info }));
    }
  }, [expanded, modelInfo]);

  const handleDownload = useCallback(async (modelId, filename) => {
    const key = `${modelId}/${filename}`;
    setStarting(prev => ({ ...prev, [key]: true }));
    const result = await apiFetch('/hf/download', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model_id: modelId, filename }),
    });
    setStarting(prev => ({ ...prev, [key]: false }));
    if (result?.download_id) onDownloadStarted(result);
  }, [onDownloadStarted]);

  return (
    <div className={styles.browseTab}>
      {/* ── SEARCH BAR ── */}
      <div className={styles.searchRow}>
        <input
          className={styles.searchInput}
          type="text"
          value={query}
          onChange={e => { setQuery(e.target.value); handleSearch(e.target.value, task, sort); }}
          placeholder="Search models... e.g. qwen3 gguf, whisper, piper"
          aria-label="Search HuggingFace models"
        />
        <select
          className={styles.filterSelect}
          value={task}
          onChange={e => { setTask(e.target.value); handleSearch(query, e.target.value, sort); }}
        >
          {TASK_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          className={styles.filterSelect}
          value={sort}
          onChange={e => { setSort(e.target.value); handleSearch(query, task, e.target.value); }}
        >
          {SORT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button
          className={styles.searchBtn}
          onClick={() => doSearch(query, task, sort)}
          disabled={searching}
        >
          {searching ? '...' : '⊙'}
        </button>
      </div>

      {/* ── RESULTS ── */}
      {results.length === 0 && !searching && (
        <div className={styles.emptyMsg}>
          Search the HuggingFace model hub above. Results appear here.
        </div>
      )}

      <div className={styles.resultList}>
        {results.map(model => {
          const isExpanded = expanded === model.id;
          const info = modelInfo[model.id];
          const isLoadingThis = loadingInfo === model.id;

          return (
            <div key={model.id} className={[styles.modelCard, isExpanded && styles.modelCardExpanded].filter(Boolean).join(' ')}>
              {/* Model header row */}
              <button className={styles.modelHeader} onClick={() => handleExpand(model.id)}>
                <div className={styles.modelMeta}>
                  <span className={styles.modelName}>{model.name}</span>
                  <span className={styles.modelAuthor}>{model.author}</span>
                </div>
                <div className={styles.modelStats}>
                  {model.task && <span className={styles.modelTag}>{model.task}</span>}
                  <span className={styles.modelStat}>↓ {(model.downloads / 1000).toFixed(0)}K</span>
                  <span className={styles.modelStat}>♥ {model.likes}</span>
                  <span className={styles.expandIcon}>{isExpanded ? '▲' : '▼'}</span>
                </div>
              </button>

              {/* Expanded file list */}
              {isExpanded && (
                <div className={styles.fileList}>
                  {isLoadingThis && (
                    <div className={styles.loadingFiles}>Loading files...</div>
                  )}
                  {info?.error && (
                    <div className={styles.fileError}>{info.error}</div>
                  )}
                  {info && !info.error && (
                    <>
                      <div className={styles.modelDetailRow}>
                        {info.license !== 'unknown' && (
                          <span className={styles.licenseTag}>License: {info.license}</span>
                        )}
                        {info.task && <span className={styles.taskTag}>{info.task}</span>}
                      </div>
                      {info.files?.map(file => {
                        const key = `${model.id}/${file.filename}`;
                        const isStarting = starting[key];
                        return (
                          <div
                            key={file.filename}
                            className={[styles.fileRow, file.suggested && styles.fileRowSuggested].filter(Boolean).join(' ')}
                          >
                            <div className={styles.fileInfo}>
                              <span className={styles.fileName}>{file.filename}</span>
                              <span className={styles.fileSize}>{file.size_human}</span>
                              <span className={styles.fileDest}>→ {file.dest_dir.split('models/').pop()}</span>
                            </div>
                            <button
                              className={styles.downloadBtn}
                              onClick={() => handleDownload(model.id, file.filename)}
                              disabled={isStarting}
                            >
                              {isStarting ? '...' : '↓'}
                            </button>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// DOWNLOADS TAB
// ─────────────────────────────────────────────────────────────────────────────

const DownloadsTab = ({ downloads, onCancel }) => {
  if (downloads.length === 0) {
    return <div className={styles.emptyMsg}>No active downloads.</div>;
  }

  return (
    <div className={styles.downloadList}>
      {downloads.map(dl => (
        <div key={dl.download_id} className={styles.dlCard}>
          <div className={styles.dlHeader}>
            <div className={styles.dlNames}>
              <span className={styles.dlModel}>{dl.model_id}</span>
              <span className={styles.dlFile}>{dl.filename}</span>
            </div>
            <button
              className={styles.cancelBtn}
              onClick={() => onCancel(dl.download_id)}
              title="Cancel download"
            >
              ✕
            </button>
          </div>
          <div className={styles.progressBar}>
            <div
              className={styles.progressFill}
              style={{ width: `${dl.pct ?? 0}%` }}
            />
          </div>
          <div className={styles.dlMeta}>
            <span className={styles.dlPct}>{dl.pct ?? 0}%</span>
            {dl.bytes_done != null && dl.total_bytes != null && (
              <span className={styles.dlBytes}>
                {(dl.bytes_done / 1024 / 1024).toFixed(0)} / {(dl.total_bytes / 1024 / 1024).toFixed(0)} MB
              </span>
            )}
            <span className={styles.dlDest}>{dl.dest_dir?.split('models/').pop()}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// INSTALLED TAB
// ─────────────────────────────────────────────────────────────────────────────

const InstalledTab = () => {
  const [groups,     setGroups]     = useState({});
  const [totalSize,  setTotalSize]  = useState('');
  const [loading,    setLoading]    = useState(true);
  const [deleting,   setDeleting]   = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);

  const fetchLocal = useCallback(async () => {
    setLoading(true);
    const data = await apiFetch('/hf/local');
    setLoading(false);
    if (data) {
      setGroups(data.groups || {});
      setTotalSize(data.total_size || '');
    }
  }, []);

  useEffect(() => { fetchLocal(); }, [fetchLocal]);

  const handleDelete = useCallback(async (filePath) => {
    if (confirmDel !== filePath) {
      setConfirmDel(filePath);
      setTimeout(() => setConfirmDel(c => c === filePath ? null : c), 4000);
      return;
    }
    setDeleting(filePath);
    setConfirmDel(null);
    await apiFetch('/hf/local', {
      method:  'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ file_path: filePath }),
    });
    setDeleting(null);
    fetchLocal();
  }, [confirmDel, fetchLocal]);

  const CATEGORY_LABELS = {
    interface:   'Interface Engine (GGUF)',
    voice:       'Voice Models',
    embeddings:  'Embeddings',
    misc:        'Miscellaneous',
  };

  if (loading) return <div className={styles.emptyMsg}>Scanning models...</div>;

  const allEmpty = Object.keys(groups).length === 0 ||
    Object.values(groups).every(g => g.length === 0);

  return (
    <div className={styles.installedList}>
      {totalSize && (
        <div className={styles.totalSize}>Total: {totalSize}</div>
      )}
      {allEmpty ? (
        <div className={styles.emptyMsg}>
          No models downloaded yet. Use Browse to discover and download models.
        </div>
      ) : (
        Object.entries(groups).map(([cat, files]) => (
          <div key={cat} className={styles.modelGroup}>
            <div className={styles.groupLabel}>
              {CATEGORY_LABELS[cat] || cat}
              <span className={styles.groupCount}>{files.length} file{files.length !== 1 ? 's' : ''}</span>
            </div>
            {files.map(f => (
              <div key={f.path} className={styles.installedRow}>
                <div className={styles.installedInfo}>
                  <span className={styles.installedName}>{f.filename}</span>
                  <span className={styles.installedSize}>{f.size_human}</span>
                </div>
                <button
                  className={[
                    styles.deleteBtn,
                    confirmDel === f.path && styles.deleteBtnConfirm,
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleDelete(f.path)}
                  disabled={deleting === f.path}
                  title={confirmDel === f.path ? 'Click again to confirm' : 'Delete model file'}
                >
                  {deleting === f.path ? '...' : confirmDel === f.path ? 'Confirm' : '✕'}
                </button>
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION ROOT
// ─────────────────────────────────────────────────────────────────────────────

const SectionHuggingFace = () => {
  const [activeTab,  setActiveTab]  = useState('browse');
  const [downloads,  setDownloads]  = useState([]);

  // ── SSE: download progress events ─────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource(`${BASE}/stream`);

    es.addEventListener('hf_download_progress', (e) => {
      try {
        const d = JSON.parse(e.data);
        setDownloads(prev => {
          const idx = prev.findIndex(x => x.download_id === d.download_id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...d };
            return next;
          }
          return [...prev, d];
        });
      } catch { /* ignore */ }
    });

    es.addEventListener('hf_download_complete', (e) => {
      try {
        const d = JSON.parse(e.data);
        setDownloads(prev => prev.filter(x => x.download_id !== d.download_id));
      } catch { /* ignore */ }
    });

    es.addEventListener('hf_download_error', (e) => {
      try {
        const d = JSON.parse(e.data);
        setDownloads(prev => prev.filter(x => x.download_id !== d.download_id));
      } catch { /* ignore */ }
    });

    return () => es.close();
  }, []);

  const handleDownloadStarted = useCallback((dl) => {
    setDownloads(prev => [...prev, { ...dl, pct: 0 }]);
    setActiveTab('downloads');
  }, []);

  const handleCancel = useCallback(async (downloadId) => {
    await apiFetch(`/hf/download/${downloadId}`, { method: 'DELETE' });
    setDownloads(prev => prev.filter(x => x.download_id !== downloadId));
  }, []);

  const TABS = [
    { id: 'browse',    label: 'Browse' },
    { id: 'downloads', label: `Downloads${downloads.length > 0 ? ` (${downloads.length})` : ''}` },
    { id: 'installed', label: 'Installed' },
  ];

  return (
    <div className={styles.section}>

      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>HuggingFace Models</h2>
        <p className={styles.sectionSub}>
          Browse, download, and manage models directly inside AURA.
          Files route automatically to the correct directory.
        </p>
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={[styles.tab, activeTab === t.id && styles.tabActive].filter(Boolean).join(' ')}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.tabContent}>
        {activeTab === 'browse'    && <BrowseTab    onDownloadStarted={handleDownloadStarted} />}
        {activeTab === 'downloads' && <DownloadsTab downloads={downloads} onCancel={handleCancel} />}
        {activeTab === 'installed' && <InstalledTab />}
      </div>

    </div>
  );
};

export default SectionHuggingFace;
