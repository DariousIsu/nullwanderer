/**
 * AURA Tool Workspace — Tool Builder
 *
 * 7-station stepper pipeline:
 *   1 Intake       — NL description → Workhorse draft + clarifying questions
 *   2 Composition  — AURA tool scan + GitHub wrapper generation + sandbox
 *   3 Dataset      — data availability check + suggest prompts
 *   4 Training     — tool-scoped training run
 *   5 Optimize     — Promptim-style optimization + reevaluation
 *   6 Sandbox & Human Test — MCP server sandbox + interactive test calls
 *   7 Publish      — generate MCP packages + prompt packages
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import styles from './ToolWorkspacePanel.module.css';

const API = 'http://127.0.0.1:8000';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function fmtPct(v) {
  if (v == null) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function StageBadge({ stage }) {
  const cls = stage === 'published' ? styles.badgeGreen
    : stage === 'ready' || stage === 'human_testing' ? styles.badgeAmber
    : stage === 'reevaluation' ? styles.badgeRed
    : styles.badgeMuted;
  return <span className={`${styles.badge} ${cls}`}>{stage}</span>;
}

function ScoreBar({ value, label }) {
  const pct = Math.min((value || 0) * 100, 100);
  const isGood = (value || 0) >= 0.95;
  return (
    <div className={styles.scoreBar}>
      <span>{label}</span>
      <div className={styles.scoreTrack}>
        <div className={`${styles.scoreFill} ${isGood ? styles.scoreFillGreen : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <span>{fmtPct(value)}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATION STEPPER
// ─────────────────────────────────────────────────────────────────────────────

const STATIONS = [
  { num: 1, label: 'Intake'      },
  { num: 2, label: 'Composition' },
  { num: 3, label: 'Dataset'     },
  { num: 4, label: 'Training'    },
  { num: 5, label: 'Optimize'    },
  { num: 6, label: 'Test'        },
  { num: 7, label: 'Publish'     },
];

const STAGE_TO_STATION = {
  intake: 1, composition: 2, dataset: 3, training: 4,
  optimizing: 5, reevaluation: 5,
  sandbox: 6, human_testing: 6, ready: 7, published: 7,
};

function Stepper({ current, onSelect, tool }) {
  return (
    <div className={styles.stepper}>
      {STATIONS.map((s, i) => {
        const done   = s.num < current;
        const active = s.num === current;
        return (
          <div key={s.num} style={{ display: 'flex', alignItems: 'center' }}>
            <div
              className={`${styles.step} ${active ? styles.stepActive : ''} ${done ? styles.stepDone : ''}`}
              onClick={() => onSelect(s.num)}
            >
              <div className={styles.stepNum}>{done ? '✓' : s.num}</div>
              {s.label}
            </div>
            {i < STATIONS.length - 1 && <div className={styles.stepDivider} />}
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATION 1 — INTAKE
// ─────────────────────────────────────────────────────────────────────────────

function Station1Intake({ onCreated }) {
  const [description, setDescription] = useState('');
  const [draft,       setDraft]       = useState(null);
  const [answers,     setAnswers]     = useState({});
  const [loading,     setLoading]     = useState(false);
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState(null);

  const handleAnalyze = async () => {
    if (!description.trim()) return;
    setLoading(true);
    setError(null);
    setDraft(null);
    setAnswers({});
    try {
      const res = await fetch(`${API}/mcp-tools/draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Draft failed');
      setDraft(data);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  const handleConfirmAndSave = async () => {
    if (!draft?.draft_id) return;
    setSaving(true);
    setError(null);
    try {
      // Confirm with answers
      const confirmRes = await fetch(`${API}/mcp-tools/draft/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ draft_id: draft.draft_id, answers }),
      });
      const confirmed = await confirmRes.json();
      if (!confirmRes.ok) throw new Error(confirmed.detail || 'Confirm failed');

      // Save to store
      const saveRes = await fetch(`${API}/mcp-tools`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmed.draft || confirmed),
      });
      const saved = await saveRes.json();
      if (!saveRes.ok) throw new Error(saved.detail || 'Save failed');

      onCreated?.(saved.id);
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  };

  const d = draft?.draft;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Station 1 — Intake</span>
        <span className={styles.sectionSub}>Describe the tool you need</span>
      </div>

      <div className={styles.formGroup}>
        <label className={styles.label}>Tool Description</label>
        <textarea
          className={styles.textarea}
          rows={4}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="e.g. A citation validation tool that checks academic references against CrossRef, validates DOIs, and formats citations in APA/MLA/Chicago styles..."
        />
      </div>
      <button
        className={`${styles.btn} ${styles.btnPrimary}`}
        onClick={handleAnalyze}
        disabled={loading || !description.trim()}
      >
        {loading ? <><span className={styles.spinner} /> Analyzing...</> : 'Analyze'}
      </button>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      {d && (
        <>
          <div className={styles.card} style={{ marginTop: 8 }}>
            <span className={styles.cardTitle}>Draft Spec</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 6 }}>
              <div className={styles.formGroup}>
                <label className={styles.label}>Tool ID (slug)</label>
                <input className={styles.input} defaultValue={d.id} readOnly />
              </div>
              <div className={styles.formGroup}>
                <label className={styles.label}>Name</label>
                <input className={styles.input} defaultValue={d.name} readOnly />
              </div>
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Description</label>
              <textarea className={styles.textarea} rows={2} defaultValue={d.description} readOnly />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Base System Prompt</label>
              <textarea className={styles.textarea} rows={3} defaultValue={d.base_prompt || ''} readOnly />
            </div>
            <div className={styles.formGroup}>
              <label className={styles.label}>Input Schema</label>
              <div className={styles.codeBlock}>{JSON.stringify(d.input_schema, null, 2)}</div>
            </div>
            {d.categories?.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {d.categories.map(c => (
                  <span key={c} className={`${styles.badge} ${styles.badgeMuted}`}>{c}</span>
                ))}
              </div>
            )}
          </div>

          {/* Clarifying questions */}
          {draft.questions?.length > 0 && (
            <div className={styles.card}>
              <span className={styles.cardTitle}>Clarifying Questions</span>
              <span className={styles.cardSub}>All optional — skip any you don't need</span>
              {draft.questions.map(q => (
                <div key={q.id} className={styles.formGroup} style={{ marginTop: 10 }}>
                  <label className={styles.label}>{q.text}</label>
                  {q.type === 'free_text' && (
                    <input
                      className={styles.input}
                      placeholder="Optional answer..."
                      onChange={e => setAnswers(a => ({ ...a, [q.id]: e.target.value }))}
                    />
                  )}
                  {q.type === 'boolean' && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      {['Yes', 'No'].map(opt => (
                        <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer' }}>
                          <input
                            type="radio"
                            name={q.id}
                            value={opt === 'Yes'}
                            onChange={() => setAnswers(a => ({ ...a, [q.id]: opt === 'Yes' }))}
                          />
                          {opt}
                        </label>
                      ))}
                    </div>
                  )}
                  {(q.type === 'multiple_choice' || q.type === 'multi_select') && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {(q.options || []).map(opt => (
                        <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer' }}>
                          <input
                            type={q.type === 'multi_select' ? 'checkbox' : 'radio'}
                            name={q.id}
                            onChange={e => {
                              if (q.type === 'multi_select') {
                                setAnswers(a => {
                                  const prev = a[q.id] || [];
                                  return { ...a, [q.id]: e.target.checked ? [...prev, opt] : prev.filter(x => x !== opt) };
                                });
                              } else {
                                setAnswers(a => ({ ...a, [q.id]: opt }));
                              }
                            }}
                          />
                          {opt}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleConfirmAndSave}
            disabled={saving}
          >
            {saving ? <><span className={styles.spinner} /> Saving...</> : 'Confirm & Save → Composition'}
          </button>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATION 2 — COMPOSITION
// ─────────────────────────────────────────────────────────────────────────────

function Station2Composition({ tool, onRefresh }) {
  const [loading,       setLoading]       = useState(false);
  const [sandboxing,    setSandboxing]     = useState(null); // gap_slug being sandboxed
  const [sandboxResult, setSandboxResult] = useState({});
  const [approving,     setApproving]     = useState(false);
  const [error,         setError]         = useState(null);
  const [wrapperEdits,  setWrapperEdits]  = useState({}); // gap_slug → code
  const [resourceUrl,   setResourceUrl]   = useState('');
  const [resourceCode,  setResourceCode]  = useState('');
  const [resourceGap,   setResourceGap]   = useState('');
  const [submitting,    setSubmitting]     = useState(false);

  const plan = tool?.build_plan || {};
  const wrappers = plan.wrappers || [];

  const handleAnalyze = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/analyze`, { method: 'POST' });
      if (!res.ok) throw new Error('Analysis failed');
      // Results come via SSE — poll tool for now
      setTimeout(() => { setLoading(false); onRefresh?.(); }, 3000);
    } catch (e) {
      setError(e.message);
      setLoading(false);
    }
  };

  const handleSandbox = async (gapSlug) => {
    setSandboxing(gapSlug);
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/sandbox-wrappers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gap_slug: gapSlug }),
      });
      const data = await res.json();
      setSandboxResult(prev => ({ ...prev, [gapSlug]: data }));
    } catch (e) {
      setSandboxResult(prev => ({ ...prev, [gapSlug]: { status: 'error', error: e.message } }));
    }
    setSandboxing(null);
  };

  const handleApprove = async (approvedSlugs) => {
    setApproving(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/approve-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved_wrappers: approvedSlugs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Approve failed');
      onRefresh?.();
    } catch (e) {
      setError(e.message);
    }
    setApproving(false);
  };

  const handleSubmitResources = async () => {
    setSubmitting(true);
    try {
      await fetch(`${API}/mcp-tools/${tool.id}/submit-resources`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls: resourceUrl.split('\n').map(s => s.trim()).filter(Boolean),
          code: resourceCode,
          gap: resourceGap,
          notes: '',
        }),
      });
      setResourceUrl('');
      setResourceCode('');
      setTimeout(() => { onRefresh?.(); }, 2000);
    } catch (_) {}
    setSubmitting(false);
  };

  const passedSlugs = wrappers
    .filter(w => w.status === 'sandbox_passed' || w.status === 'approved')
    .map(w => w.gap_slug);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Station 2 — Composition</span>
        <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleAnalyze} disabled={loading}>
          {loading ? <><span className={styles.spinner} /> Scanning...</> : 'Scan Tools & GitHub'}
        </button>
      </div>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      {tool?.blocking_reason && (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>⚠ {tool.blocking_reason}</div>
      )}

      {/* AURA tools matched */}
      {plan.aura_tools?.length > 0 && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Matched AURA Tools</span>
          {plan.aura_tools.map((t, i) => (
            <div key={i} style={{ padding: '6px 0', borderBottom: '1px solid var(--border, #1a2332)', fontSize: 11 }}>
              <strong>{t.tool_name}</strong>
              {' '}
              <span className={`${styles.badge} ${styles.badgeAmber}`}>{(t.fit_score * 100 || 0).toFixed(0)}%</span>
              <div style={{ color: 'var(--text-secondary)', marginTop: 3 }}>{t.fit_reason}</div>
            </div>
          ))}
        </div>
      )}

      {/* Wrappers */}
      {wrappers.map(w => {
        const sb = sandboxResult[w.gap_slug];
        const code = wrapperEdits[w.gap_slug] ?? w.wrapper_code ?? '';
        return (
          <div key={w.gap_slug} className={styles.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontSize: 12 }}>{w.gap_description || w.gap_slug}</strong>
              <span className={`${styles.badge} ${w.status === 'sandbox_passed' || w.status === 'approved' ? styles.badgeGreen : w.status === 'sandbox_failed' ? styles.badgeRed : styles.badgeMuted}`}>
                {w.status}
              </span>
              {w.library_name && (
                <span className={styles.cardSub}>via {w.library_name}</span>
              )}
            </div>

            {w.required_packages?.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {w.required_packages.map(p => (
                  <span key={p} className={`${styles.badge} ${styles.badgeBlue}`}>{p}</span>
                ))}
              </div>
            )}

            <label className={styles.label}>Wrapper Code (editable)</label>
            <textarea
              className={styles.codeEditor}
              rows={10}
              value={code}
              onChange={e => setWrapperEdits(prev => ({ ...prev, [w.gap_slug]: e.target.value }))}
            />

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className={`${styles.btn} ${styles.btnSmall}`}
                onClick={() => handleSandbox(w.gap_slug)}
                disabled={sandboxing === w.gap_slug}
              >
                {sandboxing === w.gap_slug ? <><span className={styles.spinner} /> Running sandbox...</> : 'Run Sandbox'}
              </button>
            </div>

            {sb && (
              <div className={`${styles.banner} ${sb.status === 'passed' ? styles.bannerInfo : styles.bannerError}`}>
                <strong>{sb.status === 'passed' ? '✓ Sandbox passed' : '✗ Sandbox failed'}</strong>
                {sb.stderr && <div style={{ marginTop: 6, fontSize: 10, opacity: 0.8 }}>{sb.stderr.slice(0, 400)}</div>}
                {sb.suggested_fix && (
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 10 }}>Workhorse suggests a fix...</summary>
                    <div style={{ marginTop: 4, fontSize: 10 }}>{sb.suggested_fix}</div>
                    <div style={{ fontSize: 10, opacity: 0.8, marginTop: 2 }}>{sb.explanation}</div>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* Orchestrator */}
      {plan.orchestrator_code && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Orchestrator</span>
          <span className={styles.cardSub}>Calls all wrappers in sequence — auto-generated</span>
          <textarea
            className={styles.codeEditor}
            rows={8}
            defaultValue={plan.orchestrator_code}
          />
        </div>
      )}

      {wrappers.length > 0 && (
        <button
          className={`${styles.btn} ${styles.btnPrimary}`}
          onClick={() => handleApprove(passedSlugs)}
          disabled={approving || passedSlugs.length === 0}
        >
          {approving ? <><span className={styles.spinner} /> Committing...</> : `Approve Build Plan (${passedSlugs.length} wrappers) → Dataset`}
        </button>
      )}

      {/* Blocked — submit resources */}
      {(wrappers.length === 0 || tool?.blocking_reason) && (
        <div className={styles.card} style={{ borderColor: 'rgba(245,158,11,0.2)' }}>
          <span className={styles.cardTitle}>Submit Resources</span>
          <span className={styles.cardSub}>Paste GitHub URLs, docs, or write wrapper code manually</span>
          <div className={styles.formGroup}>
            <label className={styles.label}>GitHub / Docs URLs (one per line)</label>
            <textarea
              className={styles.textarea}
              rows={3}
              value={resourceUrl}
              onChange={e => setResourceUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Gap (which capability to fill)</label>
            <input
              className={styles.input}
              value={resourceGap}
              onChange={e => setResourceGap(e.target.value)}
              placeholder="e.g. DOI validation"
            />
          </div>
          <div className={styles.formGroup}>
            <label className={styles.label}>Manual wrapper code (optional)</label>
            <textarea
              className={styles.codeEditor}
              rows={6}
              value={resourceCode}
              onChange={e => setResourceCode(e.target.value)}
              placeholder="async def tool_handler(inputs: dict) -> dict: ..."
            />
          </div>
          <button
            className={`${styles.btn} ${styles.btnSmall}`}
            onClick={handleSubmitResources}
            disabled={submitting}
          >
            {submitting ? <><span className={styles.spinner} /> Submitting...</> : 'Submit Resources'}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATION 3 — DATASET
// ─────────────────────────────────────────────────────────────────────────────

function Station3Dataset({ tool, onRefresh }) {
  const [prompts,  setPrompts]  = useState([]);
  const [loading,  setLoading]  = useState(false);
  const [syncing,  setSyncing]  = useState(false);
  const [catalog,  setCatalog]  = useState(null);
  const [copied,   setCopied]   = useState(false);

  const loadCatalog = () =>
    fetch(`${API}/mcp-tools/dataset-catalog`)
      .then(r => r.ok ? r.json() : null)
      .then(d => d && setCatalog(d));

  useEffect(() => { loadCatalog(); }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      await fetch(`${API}/mcp-tools/sync-phoenix`, { method: 'POST' });
      // Poll catalog once after a short delay (export is async)
      setTimeout(() => { loadCatalog(); setSyncing(false); }, 4000);
    } catch (_) {
      setSyncing(false);
    }
  };

  const handleSuggest = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/suggest-prompts`, { method: 'POST' });
      const data = await res.json();
      setPrompts(data.prompts || []);
    } catch (_) {}
    setLoading(false);
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(prompts.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const totalRecords = catalog?.total || 0;
  const threshold = 50;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Station 3 — Dataset</span>
        <button
          className={`${styles.btn} ${styles.btnSmall}`}
          onClick={handleSync}
          disabled={syncing}
          title="Pull latest LLM spans from Phoenix into eval_raw.jsonl"
        >
          {syncing ? <><span className={styles.spinner} /> Syncing...</> : '↓ Sync from Phoenix'}
        </button>
      </div>

      <div className={styles.card}>
        <span className={styles.cardTitle}>Dataset Status</span>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
          {totalRecords} total records available
          {catalog?.categories?.length > 0 && (
            <span style={{ marginLeft: 8, opacity: 0.7 }}>
              across {catalog.categories.length} tier{catalog.categories.length !== 1 ? 's' : ''}
            </span>
          )}
          {totalRecords < threshold && (
            <span style={{ color: '#ef4444', marginLeft: 8 }}>
              (need {threshold} minimum)
            </span>
          )}
        </div>
        <ScoreBar value={Math.min(totalRecords / threshold, 1)} label="Data coverage" />
      </div>

      {totalRecords < threshold && (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          Not enough data. Run targeted training in the Trainer, export more Phoenix data, or use Suggest Training Prompts below.
        </div>
      )}

      {tool.golden_set_size >= 15 ? (
        <div className={`${styles.banner} ${styles.bannerInfo}`}>
          ✓ {tool.golden_set_size} golden examples — ready for optimization.
        </div>
      ) : (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Suggest Training Prompts</span>
          <span className={styles.cardSub}>Workhorse generates 25 domain-specific prompts you can use in the Trainer</span>
          <button
            className={`${styles.btn} ${styles.btnSmall}`}
            onClick={handleSuggest}
            disabled={loading}
            style={{ marginTop: 6 }}
          >
            {loading ? <><span className={styles.spinner} /> Generating...</> : 'Suggest Training Prompts'}
          </button>
          {prompts.length > 0 && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{prompts.length} prompts</span>
                <button className={`${styles.btn} ${styles.btnSmall}`} onClick={handleCopy}>
                  {copied ? '✓ Copied' : 'Copy all'}
                </button>
              </div>
              <div style={{ maxHeight: 240, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
                {prompts.map((p, i) => (
                  <div key={i} style={{ fontSize: 10, padding: '5px 8px', background: 'var(--bg-secondary)', borderRadius: 3, border: '1px solid var(--border)' }}>
                    {i + 1}. {p}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATION 4 — TRAINING
// ─────────────────────────────────────────────────────────────────────────────

function Station4Training({ tool, onRefresh }) {
  const [status, setStatus]  = useState(null);
  const [running, setRunning] = useState(false);
  const [log,     setLog]     = useState([]);
  const pollRef = useRef(null);

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/run-dataset/status`);
      if (res.ok) {
        const s = await res.json();
        setStatus(s);
        setRunning(s.running);
        if (!s.running) {
          clearInterval(pollRef.current);
          onRefresh?.();
        }
      }
    } catch (_) {}
  }, [tool.id, onRefresh]);

  const handleStart = async () => {
    setLog([]);
    setRunning(true);
    try {
      await fetch(`${API}/mcp-tools/${tool.id}/run-dataset`, { method: 'POST' });
      pollRef.current = setInterval(pollStatus, 2000);
    } catch (e) {
      setRunning(false);
    }
  };

  const handleStop = async () => {
    await fetch(`${API}/mcp-tools/${tool.id}/run-dataset/stop`, { method: 'POST' });
    clearInterval(pollRef.current);
    setRunning(false);
    onRefresh?.();
  };

  useEffect(() => () => clearInterval(pollRef.current), []);

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Station 4 — Training</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {running
            ? <button className={`${styles.btn} ${styles.btnSmall} ${styles.btnDanger}`} onClick={handleStop}>Stop</button>
            : <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleStart}>Run Training Dataset</button>
          }
        </div>
      </div>

      {tool.golden_set_size > 0 && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Golden Set</span>
          <span className={styles.cardValue}>{tool.golden_set_size}</span>
          <span className={styles.cardSub}>training examples</span>
        </div>
      )}

      {status && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Status</span>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'flex', gap: 16 }}>
            <span>Running: {status.running ? 'Yes' : 'No'}</span>
            {status.elapsed_s > 0 && <span>Elapsed: {status.elapsed_s}s</span>}
          </div>
        </div>
      )}

      {running && (
        <div className={`${styles.banner} ${styles.bannerInfo}`}>
          <span className={styles.spinner} style={{ display: 'inline-block', marginRight: 8 }} />
          Training in progress — golden examples will appear when complete.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATION 5 — OPTIMIZE
// ─────────────────────────────────────────────────────────────────────────────

function Station5Optimize({ tool, onRefresh }) {
  const [running,    setRunning]    = useState(false);
  const [reeval,     setReeval]     = useState(null);
  const [applying,   setApplying]   = useState(false);
  const [error,      setError]      = useState(null);
  const pollRef = useRef(null);

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/optimize/status`);
      if (res.ok) {
        const s = await res.json();
        setRunning(s.running);
        if (!s.running) {
          clearInterval(pollRef.current);
          onRefresh?.();
        }
      }
    } catch (_) {}
  }, [tool.id, onRefresh]);

  const handleOptimize = async () => {
    setError(null);
    setRunning(true);
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/optimize`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Failed to start');
      if (data.started) {
        pollRef.current = setInterval(pollStatus, 3000);
      }
    } catch (e) {
      setError(e.message);
      setRunning(false);
    }
  };

  const handleStop = async () => {
    await fetch(`${API}/mcp-tools/${tool.id}/optimize/stop`, { method: 'POST' });
    clearInterval(pollRef.current);
    setRunning(false);
    onRefresh?.();
  };

  const handleLoadReeval = async () => {
    const res = await fetch(`${API}/mcp-tools/${tool.id}/reevaluation`);
    if (res.ok) setReeval((await res.json()).report);
  };

  const handleApplyReeval = async () => {
    setApplying(true);
    try {
      await fetch(`${API}/mcp-tools/${tool.id}/apply-reevaluation`, { method: 'POST' });
      onRefresh?.();
    } catch (_) {}
    setApplying(false);
  };

  useEffect(() => () => clearInterval(pollRef.current), []);
  useEffect(() => {
    if (tool.stage === 'reevaluation') handleLoadReeval();
  }, [tool.stage]);

  const score = tool.optimization_score || 0;
  const cycles = tool.optimization_cycles || 0;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Station 5 — Optimize Prompt</span>
        <div style={{ display: 'flex', gap: 8 }}>
          {running
            ? <button className={`${styles.btn} ${styles.btnSmall} ${styles.btnDanger}`} onClick={handleStop}>Stop</button>
            : <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleOptimize} disabled={tool.golden_set_size < 15}>
                Run Optimization Cycle
              </button>
          }
        </div>
      </div>

      {tool.golden_set_size < 15 && (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          Need at least 15 golden examples (have {tool.golden_set_size}). Run training first.
        </div>
      )}

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      <div className={styles.cardGrid}>
        <div className={styles.card}>
          <span className={styles.cardTitle}>Optimization Score</span>
          <ScoreBar value={score} label="Best score" />
          <span className={styles.cardSub}>
            {score >= 0.95 ? '✓ Threshold reached — server.py auto-generated' : `Target: 95% (${cycles}/5 cycles used)`}
          </span>
        </div>
      </div>

      {tool.optimized_prompt && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Optimized Prompt</span>
          <textarea className={styles.codeEditor} rows={6} defaultValue={tool.optimized_prompt} readOnly />
        </div>
      )}

      {running && (
        <div className={`${styles.banner} ${styles.bannerInfo}`}>
          <span className={styles.spinner} style={{ display: 'inline-block', marginRight: 8 }} />
          Running optimization cycle (5 iterations)...
        </div>
      )}

      {/* Reevaluation panel */}
      {tool.stage === 'reevaluation' && (
        <div className={styles.card} style={{ borderColor: 'rgba(239,68,68,0.3)' }}>
          <span className={styles.cardTitle} style={{ color: '#ef4444' }}>Reevaluation Required</span>
          <span className={styles.cardSub}>5 optimization cycles failed to reach 95%. Workhorse diagnosis:</span>
          {reeval ? (
            <>
              <div style={{ fontSize: 11, marginTop: 8 }}>
                <strong>Root cause:</strong> {reeval.root_cause}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 4 }}>
                Confidence: {reeval.confidence}
              </div>
              {reeval.suggestions?.length > 0 && (
                <ul style={{ margin: '8px 0 0', padding: '0 0 0 16px', fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {reeval.suggestions.map((s, i) => (
                    <li key={i}><strong>[{s.type}]</strong> {s.change}</li>
                  ))}
                </ul>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={handleApplyReeval} disabled={applying}>
                  {applying ? 'Applying...' : 'Apply Suggestions → Dataset'}
                </button>
              </div>
            </>
          ) : (
            <button className={`${styles.btn} ${styles.btnSmall}`} onClick={handleLoadReeval}>Load Report</button>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATION 6 — SANDBOX + HUMAN TEST
// ─────────────────────────────────────────────────────────────────────────────

function Station6Test({ tool, onRefresh }) {
  const [activeTab,    setActiveTab]    = useState('sandbox');
  const [sandboxRunning, setSandboxRunning] = useState(false);
  const [sandboxResult,  setSandboxResult]  = useState(null);
  const [serverPy,     setServerPy]     = useState('');
  const [inputs,       setInputs]       = useState({});
  const [testResult,   setTestResult]   = useState(null);
  const [testCalls,    setTestCalls]    = useState(0);
  const [calling,      setCalling]      = useState(false);
  const [completing,   setCompleting]   = useState(false);
  const [error,        setError]        = useState(null);

  const handleSandbox = async () => {
    setSandboxRunning(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/sandbox`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Sandbox failed');
      setSandboxResult(data);
      onRefresh?.();
    } catch (e) {
      setError(e.message);
    }
    setSandboxRunning(false);
  };

  const handleTestCall = async () => {
    setCalling(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/test-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Call failed');
      setTestResult(data);
      setTestCalls(c => c + 1);
    } catch (e) {
      setError(e.message);
    }
    setCalling(false);
  };

  const handleComplete = async () => {
    setCompleting(true);
    try {
      await fetch(`${API}/mcp-tools/${tool.id}/test-complete`, { method: 'POST' });
      onRefresh?.();
    } catch (_) {}
    setCompleting(false);
  };

  const schema = tool?.input_schema || {};
  const properties = schema.properties || {};

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Station 6 — Sandbox & Human Testing</span>
        <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 4, overflow: 'hidden' }}>
          {['sandbox', 'human'].map(t => (
            <button
              key={t}
              className={styles.btn}
              style={{ borderRadius: 0, border: 'none', borderRight: t === 'sandbox' ? '1px solid var(--border)' : 'none', background: activeTab === t ? 'rgba(245,158,11,0.1)' : 'transparent', color: activeTab === t ? 'var(--amber-base)' : undefined }}
              onClick={() => setActiveTab(t)}
            >
              {t === 'sandbox' ? 'Sandbox' : 'Human Test'}
            </button>
          ))}
        </div>
      </div>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      {activeTab === 'sandbox' && (
        <>
          <button
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={handleSandbox}
            disabled={sandboxRunning}
          >
            {sandboxRunning ? <><span className={styles.spinner} /> Running sandbox...</> : 'Run MCP Sandbox'}
          </button>

          {sandboxResult && (
            <>
              <div className={styles.card}>
                <span className={styles.cardTitle}>Result</span>
                <ScoreBar value={sandboxResult.sandbox_pass_rate} label="Pass rate" />
                <span className={styles.cardSub}>
                  {sandboxResult.passed}/{sandboxResult.total} examples passed
                  {sandboxResult.sandbox_pass_rate >= 0.9 && ' — ✓ Advancing to Human Testing'}
                </span>
              </div>

              <table className={styles.table}>
                <thead>
                  <tr><th>Input</th><th>Expected</th><th>Actual</th><th>Result</th></tr>
                </thead>
                <tbody>
                  {(sandboxResult.results || []).slice(0, 20).map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontSize: 10 }}>{JSON.stringify(r.input).slice(0, 60)}</td>
                      <td style={{ fontSize: 10 }}>{(r.expected || '').slice(0, 80)}</td>
                      <td style={{ fontSize: 10 }}>{(r.actual || '').slice(0, 80)}</td>
                      <td>
                        {r.passed
                          ? <span className={styles.passIcon}>✓</span>
                          : <span className={styles.failIcon}>✗</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* Inline server.py editor */}
          <div className={styles.card}>
            <span className={styles.cardTitle}>Edit server.py</span>
            <span className={styles.cardSub}>Edit and re-run sandbox to test fixes</span>
            <textarea
              className={styles.codeEditor}
              rows={12}
              value={serverPy}
              placeholder="server.py content will appear here after sandbox runs..."
              onChange={e => setServerPy(e.target.value)}
            />
          </div>
        </>
      )}

      {activeTab === 'human' && (
        <>
          <div className={styles.card}>
            <span className={styles.cardTitle}>Test Inputs</span>
            {Object.entries(properties).map(([key, def]) => (
              <div key={key} className={styles.formGroup} style={{ marginBottom: 8 }}>
                <label className={styles.label}>{key} <span style={{ fontWeight: 400 }}>({def.type})</span></label>
                <input
                  className={styles.input}
                  placeholder={def.description || key}
                  onChange={e => setInputs(prev => ({ ...prev, [key]: e.target.value }))}
                />
              </div>
            ))}
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleTestCall}
              disabled={calling}
            >
              {calling ? <><span className={styles.spinner} /> Calling...</> : 'Call Tool'}
            </button>
          </div>

          {testResult && (
            <div className={styles.card}>
              <span className={styles.cardTitle}>Response</span>
              <div style={{ fontSize: 11, marginBottom: 6 }}>{testResult.response}</div>
              <details>
                <summary style={{ fontSize: 10, cursor: 'pointer', color: 'var(--text-secondary)' }}>Raw JSON</summary>
                <div className={styles.codeBlock} style={{ marginTop: 6 }}>{JSON.stringify(testResult.raw, null, 2)}</div>
              </details>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              {testCalls}/3 test calls made
            </span>
            <button
              className={`${styles.btn} ${styles.btnPrimary}`}
              onClick={handleComplete}
              disabled={testCalls < 3 || completing}
            >
              {completing ? 'Completing...' : 'Pass Testing → Ready'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATION 7 — PUBLISH
// ─────────────────────────────────────────────────────────────────────────────

const PUBLISH_TARGETS = [
  { id: 'mcp',            label: 'MCP Installer (Desktop)', desc: 'server.py + install.ps1 / install.sh + pyproject.toml' },
  { id: 'claude_project', label: 'Claude Project Package',  desc: 'System prompt doc for claude.ai Projects' },
  { id: 'chatgpt_gpt',    label: 'ChatGPT Custom GPT',      desc: 'GPT builder prompt formatted' },
  { id: 'gemini_gem',     label: 'Gemini Gem',              desc: 'Gem instructions formatted' },
];

function Station7Publish({ tool, onRefresh }) {
  const [selected,    setSelected]    = useState(['mcp']);
  const [expose,      setExpose]      = useState(true);
  const [autoUpdate,  setAutoUpdate]  = useState(tool?.auto_update ?? false);
  const [publishing,  setPublishing]  = useState(false);
  const [result,      setResult]      = useState(null);
  const [error,       setError]       = useState(null);

  const toggle = (id) => setSelected(prev =>
    prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
  );

  const handlePublish = async () => {
    setPublishing(true);
    setError(null);
    try {
      const res = await fetch(`${API}/mcp-tools/${tool.id}/publish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets: selected, expose_components: expose, auto_update: autoUpdate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Publish failed');
      setResult(data);
      onRefresh?.();
    } catch (e) {
      setError(e.message);
    }
    setPublishing(false);
  };

  const isReady = tool.stage === 'ready' || tool.stage === 'published';
  const score   = tool.optimization_score || 0;

  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>Station 7 — Publish</span>
      </div>

      {!isReady && (
        <div className={`${styles.banner} ${styles.bannerWarn}`}>
          Complete human testing first to unlock publish.
        </div>
      )}

      <div className={styles.cardGrid}>
        <div className={styles.card}>
          <span className={styles.cardTitle}>Summary</span>
          <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-secondary)' }}>
            <span>{tool.golden_set_size} golden examples</span>
            <span>Score: {fmtPct(score)}</span>
            <span>v{tool.version_tag || '1.0.0'}</span>
          </div>
          <ScoreBar value={score} label="Optimization score" />
        </div>
      </div>

      {error && <div className={`${styles.banner} ${styles.bannerError}`}>{error}</div>}

      <div className={styles.card}>
        <span className={styles.cardTitle}>Select Output Targets</span>
        {PUBLISH_TARGETS.map(t => (
          <label key={t.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer', fontSize: 11 }}>
            <input
              type="checkbox"
              checked={selected.includes(t.id)}
              onChange={() => toggle(t.id)}
              style={{ marginTop: 2 }}
            />
            <div>
              <div style={{ fontWeight: 600 }}>{t.label}</div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{t.desc}</div>
              {t.id === 'mcp' && selected.includes('mcp') && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 10 }}>
                  <input type="checkbox" checked={expose} onChange={e => setExpose(e.target.checked)} />
                  Expose sub-components (for multi-agent orchestrators)
                </label>
              )}
            </div>
          </label>
        ))}
      </div>

      <div className={styles.card} style={{ padding: '10px 14px' }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 11 }}>
          <input
            type="checkbox"
            checked={autoUpdate}
            onChange={e => setAutoUpdate(e.target.checked)}
            style={{ marginTop: 2 }}
          />
          <div>
            <div style={{ fontWeight: 600 }}>Auto-update when dataset grows</div>
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
              Every 6 hours AURA checks if the golden set has grown by {'>'}10 examples.
              If a new optimization cycle scores higher, the tool re-publishes automatically with a patch version bump.
            </div>
          </div>
        </label>
      </div>

      <button
        className={`${styles.btn} ${styles.btnPrimary}`}
        onClick={handlePublish}
        disabled={publishing || !isReady || selected.length === 0}
      >
        {publishing ? <><span className={styles.spinner} /> Publishing...</> : `Generate Selected (${selected.length})`}
      </button>

      {result && (
        <div className={styles.card}>
          <span className={styles.cardTitle}>Published</span>
          {result.targets?.map(t => (
            <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0', fontSize: 11 }}>
              <span className={`${styles.badge} ${styles.badgeGreen}`}>✓ {t}</span>
              <button
                className={`${styles.btn} ${styles.btnSmall}`}
                onClick={() => window.open(`${API}/mcp-tools/${tool.id}/download/${t}`, '_blank')}
              >
                Download
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN TOOL BUILDER
// ─────────────────────────────────────────────────────────────────────────────

export default function ToolBuilder({ initialTool, onBack }) {
  const [tool,    setTool]    = useState(initialTool || null);
  const [station, setStation] = useState(initialTool ? (STAGE_TO_STATION[initialTool.stage] || 1) : 1);
  const [loading, setLoading] = useState(false);

  const loadTool = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await fetch(`${API}/mcp-tools/${id}`);
      if (res.ok) {
        const t = await res.json();
        setTool(t);
        setStation(STAGE_TO_STATION[t.stage] || station);
      }
    } catch (_) {}
    setLoading(false);
  }, [station]);

  const handleCreated = useCallback((id) => {
    loadTool(id);
    setStation(2);
  }, [loadTool]);

  const refresh = useCallback(() => {
    if (tool?.id) loadTool(tool.id);
  }, [tool?.id, loadTool]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '10px 20px', borderBottom: '1px solid var(--border, #1a2332)', display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
        <button className={`${styles.btn} ${styles.btnSmall}`} onClick={onBack}>← Back</button>
        {tool ? (
          <>
            <span style={{ fontWeight: 700, fontSize: 12 }}>{tool.name}</span>
            <StageBadge stage={tool.stage} />
            {tool.blocking_reason && (
              <span style={{ fontSize: 10, color: '#ef4444' }}>⚠ {tool.blocking_reason}</span>
            )}
          </>
        ) : (
          <span style={{ fontWeight: 700, fontSize: 12 }}>New Tool</span>
        )}
      </div>

      {/* Stepper */}
      <Stepper current={station} onSelect={setStation} tool={tool} />

      {/* Station content */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {loading ? (
          <div className={styles.empty}><span className={styles.spinner} /></div>
        ) : station === 1 ? (
          <Station1Intake onCreated={handleCreated} />
        ) : !tool ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>◈</span>
            <span>No tool selected. Go back to Intake to create one.</span>
          </div>
        ) : station === 2 ? (
          <Station2Composition tool={tool} onRefresh={refresh} />
        ) : station === 3 ? (
          <Station3Dataset tool={tool} onRefresh={refresh} />
        ) : station === 4 ? (
          <Station4Training tool={tool} onRefresh={refresh} />
        ) : station === 5 ? (
          <Station5Optimize tool={tool} onRefresh={refresh} />
        ) : station === 6 ? (
          <Station6Test tool={tool} onRefresh={refresh} />
        ) : station === 7 ? (
          <Station7Publish tool={tool} onRefresh={refresh} />
        ) : null}
      </div>
    </div>
  );
}
