/**
 * AURA NX-Alpha — SettingsPanel
 *
 * Full settings surface rendered inside the DropPanel when id='settings'.
 * Replaces the standard DropPanel two-column stub layout for this service only.
 *
 * SECTIONS:
 *   General     — Operating Mode selector (4 states) + Team Gate toggle
 *   Models      — Interface Engine + Workhorse status + LLMFit suggestion card
 *   Connectors  — Per-service connection status + connect/manage actions
 *   Storage     — Per-component usage bars driven by storage_update SSE events (§4.5)
 *   Satellites  — Satellite routing config (stub — architecture placeholder)
 *   Appearance  — Reserved for future customization
 *
 * OPERATING MODE (§1.7):
 *   Quiet 🔇      Responds only when asked. Connectors idle. No alerts.
 *   Ambient 🔔    Connectors live. Message alerts on. Screen off.
 *   Proactive ⚡  Full. Screen monitoring. Unsolicited actions. (default)
 *   Self Care 🧘  Reduced. Runs self-care training. Minimal interruption.
 *
 * LLMFIT (§1.6 / Decision #25):
 *   Background suggestion only. Non-intrusive card in Models section.
 *   User reviews and accepts/declines — no auto-switching.
 *
 * PROPS:
 *   operatingMode   — 'quiet' | 'ambient' | 'proactive'
 *   onModeChange    — (mode: string) => void
 *   teamGateEnabled — boolean (default: false — §14.7 / §2B)
 *   onTeamGateToggle — (enabled: boolean) => void
 *   llmSuggestion   — null | { name, family, reason, vram }
 *   onLlmAccept     — () => void
 *   onLlmDismiss    — () => void
 *   interfaceModel  — { name, status: 'online'|'offline'|'loading' }
 *   workhorseModel  — { name, status: 'online'|'offline'|'loading' }
 *   connectors      — Array<{ id, name, status: 'connected'|'disconnected'|'error' }>
 *   storageData     — (self-contained: SectionStorage fetches its own data via GET /storage)
 *   satellites      — Array<{ id, name, model, status }>
 */

import { useState, useEffect } from 'react';
import styles from './SettingsPanel.module.css';
import { useGoogleStatus, useKnowledgeSources, triggerDownload, getGoogleAuthUrl, exchangeGoogleCode, activateGoogleAccount, removeGoogleAccount, updateWatchlist, useQueueStatus, useQueueTasks, cancelQueuedTask, useStorage, setComponentQuota, sweepCollectionFolder, getCollectionFolder, setCollectionFolder, useAPIKeys, updateAPIKeys, testAPIKey, ingestPersonalDoc, batchIngestPersonal } from '../../hooks/useBackendData';
import SectionVoice from './SectionVoice';
import SectionSystemHealth from './SectionSystemHealth';
import SectionHuggingFace from './SectionHuggingFace';
import SectionPhoenix from './SectionPhoenix';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'general',    label: 'General',       icon: '⊙' },
  { id: 'models',     label: 'Models',        icon: '◈' },
  { id: 'voice',      label: 'Voice',         icon: '◬' },
  { id: 'live_data',  label: 'Live Data',     icon: '◎' },
  { id: 'knowledge',  label: 'Knowledge DB',  icon: '⬢' },
  { id: 'connectors', label: 'Connectors',    icon: '⬡' },
  { id: 'api_keys',   label: 'API Keys',      icon: '🔑' },
  { id: 'intel_feed', label: 'Intel Feed',    icon: '⬛' },
  { id: 'timezones',  label: 'Time Zones',    icon: '◷' },
  { id: 'task_queue', label: 'Task Queue',    icon: '◫' },
  { id: 'storage',    label: 'Storage',       icon: '▣' },
  { id: 'satellites', label: 'Satellites',    icon: '△' },
  { id: 'services',      label: 'Services',      icon: '◉' },
  { id: 'system_health', label: 'System Health', icon: '◈' },
  { id: 'huggingface',   label: 'HuggingFace',   icon: '⬡' },
  { id: 'phoenix',       label: 'Phoenix',        icon: '◎' },
  { id: 'appearance',    label: 'Appearance',    icon: '◧' },
];

const MODES = [
  {
    id:   'quiet',
    icon: '🔇',
    name: 'Quiet',
    desc: 'Responds only when asked. Connectors idle. No alerts.',
    tag:  'MINIMAL',
  },
  {
    id:   'ambient',
    icon: '🔔',
    name: 'Ambient',
    desc: 'Connectors live. Message alerts on. Screen monitoring off.',
    tag:  'PASSIVE',
  },
  {
    id:   'proactive',
    icon: '⚡',
    name: 'Proactive',
    desc: 'Full engagement. Screen monitoring. Unsolicited assistance.',
    tag:  'DEFAULT',
  },
  {
    id:   'dev',
    icon: '</>',
    name: 'Dev Mode',
    desc: 'Workhorse dedicated to the Dev Studio. Full coding toolkit. Team tasks queued.',
    tag:  'ADVANCED',
  },
];

const DEFAULT_CONNECTORS = [
  { id: 'news',     name: 'News Feed',        status: 'disconnected' },
  { id: 'weather',  name: 'Weather',           status: 'disconnected' },
  { id: 'finance',  name: 'Markets',           status: 'disconnected' },
  { id: 'calendar', name: 'Google Calendar',   status: 'disconnected' },
  { id: 'mail',     name: 'Mail / IMAP',       status: 'disconnected' },
  { id: 'discord',  name: 'Discord',           status: 'disconnected' },
  { id: 'slack',    name: 'Slack',             status: 'disconnected' },
];

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: GENERAL — Operating Mode
// ─────────────────────────────────────────────────────────────────────────────

const SectionGeneral = ({
  operatingMode    = 'proactive',
  onModeChange,
  teamGateEnabled  = false,
  onTeamGateToggle,
}) => (
  <div className={styles.section}>
    <div className={styles.sectionHead}>
      <h2 className={styles.sectionTitle}>Operating Mode</h2>
      <p className={styles.sectionSub}>
        Controls Aura's engagement level, resource usage, and alert behavior.
        Changes take effect immediately.
      </p>
    </div>

    <div className={styles.modeGrid}>
      {MODES.map(mode => {
        const active = operatingMode === mode.id;
        return (
          <button
            key={mode.id}
            className={[styles.modeCard, active && styles.modeCardActive].filter(Boolean).join(' ')}
            onClick={() => onModeChange?.(mode.id)}
            aria-pressed={active}
            aria-label={`Set mode: ${mode.name}`}
          >
            {/* Left accent bar — visible on active */}
            <div className={styles.modeAccent} aria-hidden="true" />

            <span className={styles.modeIcon} aria-hidden="true">{mode.icon}</span>

            <div className={styles.modeBody}>
              <div className={styles.modeNameRow}>
                <span className={styles.modeName}>{mode.name.toUpperCase()}</span>
                <span className={styles.modeTag}>{mode.tag}</span>
              </div>
              <p className={styles.modeDesc}>{mode.desc}</p>
            </div>

            {active && (
              <div className={styles.modeCheck} aria-hidden="true">✓</div>
            )}
          </button>
        );
      })}
    </div>

    <div className={styles.fieldNote}>
      Operating mode is also accessible from the title bar mode indicator.
    </div>

    {/* ── Team Gate toggle ── (§14.7 / §2B) ──────────────────────────────
        Controls state.team_enabled in the LangGraph pipeline.
        Off by default (AuraSettings.team_gate_default = False).
        When off, team-worthy requests emit team_gate_prompt and route solo. */}
    <div className={styles.toggleSection}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Team Functions</h2>
        <p className={styles.sectionSub}>
          When enabled, complex requests are routed to the full multi-agent pipeline.
          When disabled, all requests run via the Interface Engine only.
        </p>
      </div>

      <div className={styles.toggleRow}>
        <div className={styles.toggleInfo}>
          <span className={styles.toggleLabel}>Enable Team Functions</span>
          <span className={styles.toggleMeta}>
            {teamGateEnabled
              ? 'Team pipeline active — complex requests use multi-agent routing'
              : 'Disabled — all requests handled by Interface Engine (Path A only)'}
          </span>
        </div>
        <button
          className={[
            styles.toggleBtn,
            teamGateEnabled && styles.toggleBtnOn,
          ].filter(Boolean).join(' ')}
          role="switch"
          aria-checked={teamGateEnabled}
          aria-label="Enable Team Functions"
          onClick={() => onTeamGateToggle?.(!teamGateEnabled)}
        >
          <span className={styles.toggleThumb} />
        </button>
      </div>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: MODELS — Interface Engine, Workhorse, LLMFit
// ─────────────────────────────────────────────────────────────────────────────

const ModelStatusDot = ({ status }) => (
  <span
    className={[
      styles.modelDot,
      status === 'online'  && styles.modelDotOnline,
      status === 'loading' && styles.modelDotLoading,
      status === 'offline' && styles.modelDotOffline,
    ].filter(Boolean).join(' ')}
    aria-label={status}
    title={status}
  />
);

const SectionModels = ({
  interfaceModel = { name: 'Unknown', status: 'offline' },
  workhorseModel = { name: 'Unknown', status: 'offline' },
  gpuInfo        = [],
  hardwareMode   = 'interface_only',
  devStub        = false,
  llmSuggestion  = null,
  onLlmAccept,
  onLlmDismiss,
  downloadProgress = {},
}) => {
  const [suggestions, setSuggestions] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState({}); // model_id -> progress%
  const [purging, setPurging] = useState({}); // model_id -> true

  // Merge external download progress (from SSE) into local state
  useEffect(() => {
    if (downloadProgress && Object.keys(downloadProgress).length > 0) {
      setDownloading(prev => ({ ...prev, ...downloadProgress }));
    }
  }, [downloadProgress]);

  const fetchSuggestions = async () => {
    try {
      const res = await fetch('http://127.0.0.1:8000/llmfit/suggestions');
      if (res.ok) {
        setSuggestions(await res.json());
        setLoading(false);
        return true;
      }
    } catch { /* backend not ready */ }
    return false;
  };

  useEffect(() => {
    let active = true;
    let retries = 0;
    const tryFetch = async () => {
      const ok = await fetchSuggestions();
      if (!ok && active && retries < 30) {
        retries++;
        setTimeout(tryFetch, 2000); // retry every 2s until backend is up
      }
      if (!ok && retries >= 30) setLoading(false);
    };
    tryFetch();
    return () => { active = false; };
  }, []);

  // ── Actions ──

  const handleAssign = async (role, model) => {
    try {
      const res = await fetch('http://127.0.0.1:8000/models/assign', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, model }),
      });
      if (res.ok) {
        const result = await res.json();
        await fetchSuggestions(); // refresh everything
        if (result.restart_required) {
          alert('Interface engine model changed. Restart the app to load the new model.');
        }
      }
    } catch { /* ignore */ }
  };

  const handleDownload = async (role, modelId, filename) => {
    setDownloading(prev => ({ ...prev, [modelId]: 0 }));
    try {
      await fetch('http://127.0.0.1:8000/llmfit/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, model_id: modelId, filename }),
      });
      // Progress will be updated via SSE hf_download_progress events
      // On completion, refresh suggestions
      // Poll for completion as a fallback
      const pollDone = setInterval(async () => {
        try {
          const res = await fetch('http://127.0.0.1:8000/llmfit/suggestions');
          if (res.ok) {
            const data = await res.json();
            const locals = role === 'interface' ? data.local_models?.interface : data.local_models?.workhorse;
            const found = locals?.some(m => m.id === modelId || m.ollama_name === modelId);
            if (found) {
              clearInterval(pollDone);
              setSuggestions(data);
              setDownloading(prev => {
                const next = { ...prev };
                delete next[modelId];
                return next;
              });
            }
          }
        } catch { /* ignore */ }
      }, 5000);
      // Safety: clear after 10 minutes
      setTimeout(() => clearInterval(pollDone), 600_000);
    } catch {
      setDownloading(prev => {
        const next = { ...prev };
        delete next[modelId];
        return next;
      });
    }
  };

  const handlePurge = async (role, modelId) => {
    if (!window.confirm(`Delete model "${modelId}"? This cannot be undone.`)) return;
    setPurging(prev => ({ ...prev, [modelId]: true }));
    try {
      await fetch('http://127.0.0.1:8000/llmfit/purge', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role, model_id: modelId }),
      });
      await fetchSuggestions();
    } catch { /* ignore */ }
    setPurging(prev => {
      const next = { ...prev };
      delete next[modelId];
      return next;
    });
  };

  // ── Derived data ──

  const primaryGpu = gpuInfo[0];
  const gpuName = primaryGpu?.name || 'Detecting...';
  const gpuVram = primaryGpu
    ? `${Math.round(primaryGpu.vram_total_mb / 1024)}GB VRAM`
    : '? VRAM';
  const gpuUsed = primaryGpu?.vram_used_mb
    ? `${(primaryGpu.vram_used_mb / 1024).toFixed(1)}GB used`
    : '';
  const gpuFree = primaryGpu?.vram_free_mb
    ? `${(primaryGpu.vram_free_mb / 1024).toFixed(1)}GB free`
    : '';

  const localInterface   = suggestions?.local_models?.interface || [];
  const localWorkhorse   = suggestions?.local_models?.workhorse || [];
  const ifaceCandidates  = suggestions?.interface_candidates || [];
  const workhorseCandidates = suggestions?.workhorse_candidates || [];
  const workhorseLocked  = suggestions?.workhorse_locked ?? (hardwareMode === 'interface_only');
  const lockedReason     = suggestions?.workhorse_locked_reason || 'Workhorse unavailable for this hardware configuration';

  // Filter candidates to only those that fit and are not already installed
  const downloadedIfaceNames = new Set(localInterface.map(m => m.ollama_name || m.id));
  const availableIface = ifaceCandidates.filter(c => c.fits && !downloadedIfaceNames.has(c.ollama_name));

  const downloadedWorkhorseIds = new Set(localWorkhorse.map(m => m.id || m.ollama_name));
  const availableWorkhorse = workhorseCandidates.filter(
    c => c.fits && !downloadedWorkhorseIds.has(c.id) && !downloadedWorkhorseIds.has(c.ollama_name)
  );

  // Helper: format bytes to human readable
  const fmtSize = (bytes) => {
    if (!bytes) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
  };

  // Helper: headroom class
  const headroomClass = (headroom_mb) => {
    if (headroom_mb >= 1024) return styles.modelEntryFits;
    if (headroom_mb > 0) return styles.modelEntryTight;
    return '';
  };

  return (
  <div className={styles.section}>
    <div className={styles.sectionHead}>
      <h2 className={styles.sectionTitle}>AI Models</h2>
      <p className={styles.sectionSub}>
        Dual-model architecture. Interface engine is always on; workhorse loads on demand.
        {suggestions?.vram_total_mb && ` System VRAM: ${(suggestions.vram_total_mb / 1024).toFixed(1)}GB total, ${(suggestions.vram_effective_mb / 1024).toFixed(1)}GB effective.`}
      </p>
    </div>

    {/* ─── A. GPU Identity ─── */}
    <div className={styles.modelCard}>
      <div className={styles.modelCardHead}>
        <span className={styles.modelRole}>GPU</span>
        <ModelStatusDot status={primaryGpu ? 'online' : 'offline'} />
        <span className={styles.modelStatusLabel}>
          {primaryGpu ? gpuVram : 'NOT DETECTED'}
        </span>
      </div>
      <div className={styles.modelName}>{gpuName}</div>
      <div className={styles.modelMeta}>
        {gpuUsed && gpuFree ? `${gpuUsed} · ${gpuFree} · ` : ''}
        Hardware mode: {suggestions?.hardware_mode || hardwareMode}
        {devStub ? ' · STUB RESPONSES ACTIVE' : ''}
        {primaryGpu?.temp_c ? ` · ${primaryGpu.temp_c}°C` : ''}
        {primaryGpu?.util_pct ? ` · ${primaryGpu.util_pct}% util` : ''}
      </div>
    </div>

    {/* ─── B. Interface Engine ─── */}
    <div className={styles.modelCard}>
      <div className={styles.modelCardHead}>
        <span className={styles.modelRole}>Interface Engine</span>
        <ModelStatusDot status={interfaceModel.status} />
        <span className={styles.modelStatusLabel}>{interfaceModel.status.toUpperCase()}</span>
      </div>
      <div className={styles.modelName}>{interfaceModel.name}</div>
      <div className={styles.modelMeta}>Ollama · {gpuName} · keep_alive=∞ · Always loaded</div>

      {/* Installed Ollama interface models */}
      {localInterface.length > 0 && (
        <div className={styles.modelBrowser}>
          <div className={styles.modelRole} style={{ marginBottom: '6px', marginTop: '12px' }}>Installed Models</div>
          {localInterface.map(m => {
            const modelKey = m.ollama_name || m.id;
            const isActive = interfaceModel.name && modelKey && interfaceModel.name.includes(modelKey.split(':')[0]);
            const isPurging = purging[modelKey];
            return (
              <div
                key={modelKey}
                className={[styles.modelEntry, isActive && styles.modelEntryActive].filter(Boolean).join(' ')}
              >
                <div className={styles.modelEntryInfo}>
                  <span className={styles.modelEntryName}>{m.display_name || m.ollama_name}</span>
                  <span className={styles.modelEntryMeta}>
                    {m.params && `${m.params} · `}{m.quant && `${m.quant} · `}{fmtSize(m.size_bytes)}
                  </span>
                </div>
                <div className={styles.modelActions}>
                  {isActive && <span className={styles.badge}>ACTIVE</span>}
                  {!isActive && (
                    <button
                      className={styles.llmAccept}
                      onClick={() => handleAssign('interface', modelKey)}
                    >
                      Load
                    </button>
                  )}
                  <button
                    className={styles.purgeBtn}
                    onClick={() => handlePurge('interface', modelKey)}
                    disabled={isPurging}
                  >
                    {isPurging ? '...' : 'Delete'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {localInterface.length === 0 && !loading && (
        <div className={styles.modelMeta} style={{ opacity: 0.5, marginTop: '8px' }}>
          No Ollama interface models installed. Pull via: ollama pull qwen3.5:9b
        </div>
      )}

      {/* Available to pull */}
      {availableIface.length > 0 && (
        <div className={styles.modelBrowser}>
          <div className={styles.modelRole} style={{ marginBottom: '6px', marginTop: '12px' }}>Available Models</div>
          {availableIface.map(c => {
            const modelKey = c.ollama_name;
            const dlProgress = downloading[modelKey];
            const isDownloading = dlProgress !== undefined;
            return (
              <div
                key={modelKey}
                className={[styles.modelEntry, headroomClass(c.headroom_mb)].filter(Boolean).join(' ')}
              >
                <div className={styles.modelEntryInfo}>
                  <span className={styles.modelEntryName}>{c.display_name || c.ollama_name}</span>
                  <span className={styles.modelEntryMeta}>
                    {c.params} · {c.quant} · {c.vram_mb}MB VRAM · {c.headroom_mb}MB headroom
                  </span>
                </div>
                <div className={styles.modelActions}>
                  {isDownloading ? (
                    <div className={styles.downloadProgress}>
                      <div className={styles.downloadProgressFill} style={{ width: `${dlProgress}%` }} />
                      <span className={styles.downloadProgressLabel}>{dlProgress}%</span>
                    </div>
                  ) : (
                    <button
                      className={styles.llmAccept}
                      onClick={() => handleDownload('interface', modelKey, null)}
                    >
                      Pull
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>

    {/* ─── C. Workhorse ─── */}
    {workhorseLocked ? (
      <div className={[styles.modelCard, styles.modelLocked].join(' ')}>
        <div className={styles.modelCardHead}>
          <span className={styles.modelRole}>Workhorse</span>
          <ModelStatusDot status="offline" />
          <span className={styles.modelStatusLabel}>LOCKED</span>
        </div>
        <div className={styles.modelName}>Not Available</div>
        <div className={styles.modelMeta}>{lockedReason}</div>
      </div>
    ) : (
      <div className={styles.modelCard}>
        <div className={styles.modelCardHead}>
          <span className={styles.modelRole}>Workhorse</span>
          <ModelStatusDot status={workhorseModel.status} />
          <span className={styles.modelStatusLabel}>{workhorseModel.status.toUpperCase()}</span>
        </div>
        <div className={styles.modelName}>{workhorseModel.name}</div>
        <div className={styles.modelMeta}>Ollama · {gpuName} · Loads on demand</div>

        {/* Installed Ollama models */}
        {localWorkhorse.length > 0 && (
          <div className={styles.modelBrowser}>
            <div className={styles.modelRole} style={{ marginBottom: '6px', marginTop: '12px' }}>Installed Models</div>
            {localWorkhorse.map(m => {
              const modelKey = m.ollama_name || m.id;
              const isActive = workhorseModel.name && modelKey && workhorseModel.name.includes(modelKey);
              const isPurging = purging[modelKey];
              return (
                <div
                  key={modelKey}
                  className={[styles.modelEntry, isActive && styles.modelEntryActive].filter(Boolean).join(' ')}
                >
                  <div className={styles.modelEntryInfo}>
                    <span className={styles.modelEntryName}>{m.display_name || m.name || m.ollama_name}</span>
                    <span className={styles.modelEntryMeta}>
                      {m.params && `${m.params} · `}{m.quant && `${m.quant} · `}{fmtSize(m.size_bytes)}
                    </span>
                  </div>
                  <div className={styles.modelActions}>
                    {isActive && <span className={styles.badge}>ACTIVE</span>}
                    {!isActive && (
                      <button
                        className={styles.llmAccept}
                        onClick={() => handleAssign('workhorse', modelKey)}
                      >
                        Load
                      </button>
                    )}
                    <button
                      className={styles.purgeBtn}
                      onClick={() => handlePurge('workhorse', modelKey)}
                      disabled={isPurging}
                    >
                      {isPurging ? '...' : 'Delete'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Available to pull */}
        {availableWorkhorse.length > 0 && (
          <div className={styles.modelBrowser}>
            <div className={styles.modelRole} style={{ marginBottom: '6px', marginTop: '12px' }}>Available</div>
            {availableWorkhorse.map(c => {
              const modelKey = c.ollama_name || c.id;
              const dlProgress = downloading[modelKey];
              const isDownloading = dlProgress !== undefined;
              return (
                <div
                  key={modelKey}
                  className={[styles.modelEntry, headroomClass(c.headroom_mb)].filter(Boolean).join(' ')}
                >
                  <div className={styles.modelEntryInfo}>
                    <span className={styles.modelEntryName}>{c.display_name || c.name}</span>
                    <span className={styles.modelEntryMeta}>
                      {c.params} · {c.quant || 'default'} · {c.vram_mb}MB VRAM · {c.headroom_mb}MB headroom
                    </span>
                  </div>
                  <div className={styles.modelActions}>
                    {isDownloading ? (
                      <div className={styles.downloadProgress}>
                        <div className={styles.downloadProgressFill} style={{ width: `${dlProgress}%` }} />
                        <span className={styles.downloadProgressLabel}>{dlProgress}%</span>
                      </div>
                    ) : (
                      <button
                        className={styles.llmAccept}
                        onClick={() => handleDownload('workhorse', c.ollama_name || c.id, c.filename)}
                      >
                        Pull
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    )}

    {/* ─── D. LLMFit Recommendation ─── */}
    {llmSuggestion && (
      <div className={styles.llmCard}>
        <div className={styles.llmCardHead}>
          <span className={styles.llmPulse} aria-hidden="true" />
          <span className={styles.llmLabel}>LLMFit — Recommendation</span>
        </div>
        <div className={styles.llmName}>{llmSuggestion.name}</div>
        <div className={styles.llmMeta}>
          {llmSuggestion.family && <span className={styles.llmTag}>{llmSuggestion.family}</span>}
          {llmSuggestion.reason && <span className={styles.llmReason}>{llmSuggestion.reason}</span>}
        </div>
        {llmSuggestion.vram && (
          <div className={styles.llmVram}>VRAM: {llmSuggestion.vram}</div>
        )}
        <div className={styles.llmActions}>
          <button className={styles.llmAccept} onClick={onLlmAccept}>Accept</button>
          <button className={styles.llmDismiss} onClick={onLlmDismiss}>Dismiss</button>
        </div>
      </div>
    )}

    {/* Loading state */}
    {loading && (
      <div className={styles.llmQuiet}>
        <span className={styles.llmQuietDot} aria-hidden="true" />
        Loading LLMFit model data...
      </div>
    )}

    {/* Quiet state — no suggestion, done loading */}
    {!llmSuggestion && !loading && (
      <div className={styles.llmQuiet}>
        <span className={styles.llmQuietDot} aria-hidden="true" />
        LLMFit is monitoring for comparable models in the background.
      </div>
    )}
  </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: CONNECTORS
// ─────────────────────────────────────────────────────────────────────────────

const ConnectorDot = ({ status }) => (
  <span
    className={[
      styles.connDot,
      status === 'connected'    && styles.connDotOn,
      status === 'disconnected' && styles.connDotOff,
      status === 'error'        && styles.connDotErr,
    ].filter(Boolean).join(' ')}
    aria-label={status}
  />
);

const SectionConnectors = ({ connectors = DEFAULT_CONNECTORS }) => (
  <div className={styles.section}>
    <div className={styles.sectionHead}>
      <h2 className={styles.sectionTitle}>Connectors</h2>
      <p className={styles.sectionSub}>
        Live data feeds for AppBar service panels. Each connector provides
        real-time data to its corresponding drop panel.
      </p>
    </div>

    <div className={styles.connTable}>
      {connectors.map(conn => (
        <div key={conn.id} className={styles.connRow}>
          <ConnectorDot status={conn.status} />
          <span className={styles.connName}>{conn.name}</span>
          <span className={[
            styles.connStatus,
            conn.status === 'connected' && styles.connStatusOn,
            conn.status === 'error'     && styles.connStatusErr,
          ].filter(Boolean).join(' ')}>
            {conn.status.toUpperCase()}
          </span>
          <button
            className={[
              styles.connBtn,
              conn.status === 'connected' && styles.connBtnManage,
            ].filter(Boolean).join(' ')}
            aria-label={conn.status === 'connected' ? `Manage ${conn.name}` : `Connect ${conn.name}`}
          >
            {conn.status === 'connected' ? 'Manage' : 'Connect'}
          </button>
        </div>
      ))}
    </div>

    <div className={styles.fieldNote}>
      Connector authentication is configured per-service. Credentials are stored
      locally and never sent to remote servers.
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: API KEYS
// Self-contained: fetches from GET /data/api-keys, updates via PUT, tests via POST.
// ─────────────────────────────────────────────────────────────────────────────

const API_KEY_FIELDS = [
  { key: 'fred_api_key',          label: 'FRED',           service: 'fred',           desc: 'Federal Reserve Economic Data — unlimited requests' },
  { key: 'bls_api_key',           label: 'BLS',            service: 'bls',            desc: 'Bureau of Labor Statistics — 3000 req/day with key' },
  { key: 'bea_api_key',           label: 'BEA',            service: 'bea',            desc: 'Bureau of Economic Analysis — 1500 req/day' },
  { key: 'census_api_key',        label: 'Census',         service: 'census',         desc: 'US Census Bureau — 500 req/day' },
  { key: 'news_api_key',          label: 'NewsAPI',        service: 'newsapi',        desc: 'NewsAPI.com — 100 req/day (free plan)' },
  { key: 'polygon_api_key',       label: 'Polygon',        service: 'polygon',        desc: 'Polygon.io — 5 req/min (free Starter)' },
  { key: 'alpha_vantage_api_key', label: 'Alpha Vantage',  service: 'alpha_vantage',  desc: 'Alpha Vantage — 25 req/day (free)' },
  { key: 'openweathermap_api_key',label: 'OpenWeatherMap', service: 'openweathermap', desc: 'Optional — Open-Meteo (free, no key) used by default' },
  { key: 'congress_api_key',      label: 'Congress.gov',   service: 'congress',       desc: 'Congress.gov API — federal legislation data' },
  { key: 'openstates_api_key',    label: 'OpenStates',     service: 'openstates',     desc: 'OpenStates.org — state-level legislation' },
  { key: 'courtlistener_token',   label: 'CourtListener',  service: 'courtlistener',  desc: 'CourtListener.com — federal court opinions' },
  // Tool API keys
  { key: 'exa_api_key',              label: 'Exa Search',  service: 'exa',       desc: 'Exa.ai neural web search — 1K req/mo free' },
  { key: 'jina_api_key',             label: 'Jina AI',     service: 'jina',      desc: 'Jina Reader & Search — 1M tokens free/mo' },
  { key: 'nasa_api_key',             label: 'NASA',        service: 'nasa',      desc: 'NASA Open APIs — free (DEMO_KEY used if blank)' },
  { key: 'apify_api_key',            label: 'Apify',       service: 'apify',     desc: 'Apify Actors — web scraping & automation' },
  { key: 'fmp_api_key',              label: 'FMP',         service: 'fmp',       desc: 'Financial Modeling Prep — earnings, DCF data' },
  { key: 'slack_bot_token',          label: 'Slack',       service: 'slack',     desc: 'Slack Bot Token — workspace messaging' },
  { key: 'notion_integration_token', label: 'Notion',      service: 'notion',    desc: 'Notion Integration Token — workspace access' },
  { key: 'composio_api_key',         label: 'Composio',    service: 'composio',  desc: 'Composio — Salesforce, HubSpot, Microsoft 365 gateway' },
];

const SectionAPIKeys = () => {
  const { data: keysData, loading, refresh } = useAPIKeys();
  const [edits, setEdits]       = useState({});   // key → draft value
  const [testing, setTesting]   = useState({});    // key → true
  const [testResults, setTestResults] = useState({}); // key → {status, message}
  const [saving, setSaving]     = useState(false);

  const handleEdit = (key, value) => {
    setEdits(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    const updates = {};
    Object.entries(edits).forEach(([k, v]) => {
      if (v && v.trim()) updates[k] = v.trim();
    });
    if (Object.keys(updates).length === 0) return;
    setSaving(true);
    try {
      await updateAPIKeys(updates);
      setEdits({});
      setTimeout(refresh, 500);
    } catch (err) {
      console.error('[APIKeys] Save failed:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (field) => {
    // Use the draft value if editing, otherwise prompt user
    const keyValue = edits[field.key]?.trim();
    if (!keyValue) return;
    setTesting(prev => ({ ...prev, [field.key]: true }));
    setTestResults(prev => ({ ...prev, [field.key]: null }));
    try {
      const result = await testAPIKey(field.service, keyValue);
      setTestResults(prev => ({ ...prev, [field.key]: result }));
    } catch (err) {
      setTestResults(prev => ({ ...prev, [field.key]: { status: 'error', message: err.message } }));
    } finally {
      setTesting(prev => ({ ...prev, [field.key]: false }));
    }
  };

  const hasEdits = Object.values(edits).some(v => v && v.trim());

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>API Keys</h2>
        <p className={styles.sectionSub}>
          Manage API keys for external data sources. Keys are stored locally
          in <code>~/.aura/settings.json</code> and never sent to remote servers.
          Pre-configured defaults are shown censored. Enter a new key to override.
        </p>
      </div>

      <div className={styles.connTable}>
        {API_KEY_FIELDS.map(field => {
          const currentCensored = keysData?.[field.key] || '';
          const draft = edits[field.key] ?? '';
          const result = testResults[field.key];
          const isTesting = testing[field.key];
          const hasValue = currentCensored && currentCensored !== '' && currentCensored !== '****';

          return (
            <div key={field.key} className={styles.storageRow} style={{ gap: 8 }}>
              <div className={styles.storageInfo} style={{ minWidth: 160 }}>
                <span className={styles.storageLabel}>{field.label}</span>
                <span className={styles.storageMeta}>{field.desc}</span>
                {hasValue && !draft && (
                  <span style={{ fontSize: 11, color: 'var(--color-accent, #00e0ff)', fontFamily: 'monospace', marginTop: 2 }}>
                    {currentCensored}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                <input
                  className={styles.storageQuotaInput}
                  style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
                  type="text"
                  placeholder={hasValue ? 'Enter new key to override' : 'Paste API key'}
                  value={draft}
                  onChange={e => handleEdit(field.key, e.target.value)}
                  aria-label={`API key for ${field.label}`}
                />
                <button
                  className={styles.storageQuotaBtn}
                  onClick={() => handleTest(field)}
                  disabled={!draft || isTesting}
                  title="Test this key"
                  style={{ minWidth: 48 }}
                >
                  {isTesting ? '...' : 'Test'}
                </button>
              </div>
              {result && (
                <span style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: result.status === 'ok' ? '#00ff88' : result.status === 'rate_limited' ? '#ffcc00' : '#ff4444',
                  whiteSpace: 'nowrap',
                  minWidth: 60,
                }}>
                  {result.status === 'ok' ? '✓ Valid' : result.status === 'rate_limited' ? '⚡ Rate limited' : '✗ ' + (result.message || 'Failed')}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {hasEdits && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12, gap: 8 }}>
          <button
            className={styles.storageQuotaBtn}
            onClick={() => setEdits({})}
            style={{ opacity: 0.6 }}
          >
            Cancel
          </button>
          <button
            className={styles.storageQuotaBtn}
            onClick={handleSave}
            disabled={saving}
            style={{ background: 'var(--color-accent, #00e0ff)', color: '#000', fontWeight: 700 }}
          >
            {saving ? 'Saving...' : 'Save All Keys'}
          </button>
        </div>
      )}

      <div className={styles.fieldNote} style={{ marginTop: 12 }}>
        API keys with working defaults (FRED, BLS, BEA, Census, NewsAPI, Polygon, Alpha Vantage)
        are pre-loaded. Override here if you have your own keys with higher rate limits.
        Congress.gov, OpenStates, and CourtListener require you to register for a free key.
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: STORAGE (§4.5 Storage Governor)
// Self-contained: fetches own data via useStorage() hook (GET /storage).
// Quota editor writes back via PUT /storage/quota (runtime + persisted).
// ─────────────────────────────────────────────────────────────────────────────

const STORAGE_COMPONENTS = [
  { id: 'conversations', label: 'Conversations',   desc: 'SQLite sliding window · Layer 1 memory',       defaultQuota: 2   },
  { id: 'vector',        label: 'Vector Store',    desc: 'ChromaDB · Layer 2 semantic memory',           defaultQuota: 5   },
  { id: 'graph',         label: 'Knowledge Graph', desc: 'FalkorDB · Layer 3 entity graph',              defaultQuota: 2   },
  { id: 'api_cache',     label: 'API Cache',       desc: 'SQLite LRU · KRouter response cache',         defaultQuota: 50  },
  { id: 'study_data',    label: 'Study Data',      desc: 'Raw study session data · learning layer',     defaultQuota: 10  },
  { id: 'knowledge',     label: 'Knowledge DB',    desc: 'Offline ZIM/PubMed downloads · local RAG',   defaultQuota: 150 },
];

const StorageBar = ({ pct = 0, used_gb, quota_gb }) => {
  const clamped = Math.max(0, Math.min(100, pct));
  const isWarn  = clamped >= 85;
  const isCrit  = clamped >= 100;
  return (
    <div className={styles.storageBarWrap}>
      <div className={styles.storageTrack}>
        <div
          className={[
            styles.storageFill,
            isWarn && !isCrit && styles.storageFillWarn,
            isCrit && styles.storageFillCrit,
          ].filter(Boolean).join(' ')}
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className={[
        styles.storageVal,
        isWarn && styles.storageValWarn,
      ].filter(Boolean).join(' ')}>
        {used_gb != null ? `${used_gb.toFixed(1)} / ${quota_gb} GB` : `${quota_gb} GB quota`}
      </span>
    </div>
  );
};

const SectionStorage = ({ onOpenPanel }) => {
  const { data: storageData, refresh } = useStorage(30000);
  // Local draft quota values — keyed by component id
  const [draftQuotas, setDraftQuotas] = useState({});
  const [saving,      setSaving]      = useState({});

  // Build live lookup from REST response
  const liveMap = {};
  if (storageData?.components) {
    storageData.components.forEach(d => { liveMap[d.component] = d; });
  }

  const diskTotal     = storageData?.disk_total_gb ?? 0;
  const diskFree      = storageData?.disk_free_gb  ?? 0;
  const totalAlloc    = storageData?.total_allocated_gb ?? 0;
  const diskUsed      = diskTotal - diskFree;
  const diskPct       = diskTotal > 0 ? Math.min(100, (diskUsed / diskTotal) * 100) : 0;
  const allocPct      = diskTotal > 0 ? Math.min(100, (totalAlloc / diskTotal) * 100) : 0;

  const handleQuotaChange = (id, val) => {
    setDraftQuotas(prev => ({ ...prev, [id]: val }));
  };

  const handleSetQuota = async (id) => {
    const raw = draftQuotas[id];
    const quota_gb = parseFloat(raw);
    if (isNaN(quota_gb) || quota_gb < 0.1) return;
    setSaving(prev => ({ ...prev, [id]: true }));
    try {
      await setComponentQuota(id, quota_gb);
      setDraftQuotas(prev => ({ ...prev, [id]: '' }));
      setTimeout(refresh, 500);
    } catch (err) {
      console.error('[Storage] Quota set failed:', err);
    } finally {
      setSaving(prev => ({ ...prev, [id]: false }));
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Storage</h2>
        <p className={styles.sectionSub}>
          Allocate how much disk space each component is allowed to use.
          Changes take effect immediately — no restart required.
          Storage monitor checks usage every 60 seconds and auto-evicts oldest
          data when a component reaches its quota.
        </p>
      </div>

      {/* ── Neural Interface redirect banner ── */}
      <div className={styles.redirectBanner}>
        <span>Memory layer analytics and ingestion control have moved to Neural Interface.</span>
        <button
          className={styles.redirectBannerBtn}
          onClick={() => onOpenPanel?.('neural-interface')}
        >
          Open Neural Interface →
        </button>
      </div>

      {/* ── Disk pool overview ── */}
      {diskTotal > 0 && (
        <div className={styles.storageDiskPool}>
          <div className={styles.storageDiskPoolHeader}>
            <span className={styles.storageDiskPoolLabel}>Disk Pool</span>
            <span className={styles.storageDiskPoolStats}>
              {diskUsed.toFixed(1)} GB used · {diskFree.toFixed(1)} GB free · {diskTotal.toFixed(1)} GB total
            </span>
          </div>
          {/* Stacked bar: used (dark) + allocated-but-free (accent) */}
          <div className={styles.storageDiskPoolTrack}>
            <div className={styles.storageDiskPoolUsed}  style={{ width: `${(diskUsed  / diskTotal) * 100}%` }} />
            <div className={styles.storageDiskPoolAlloc} style={{ width: `${Math.max(0, allocPct - diskPct)}%` }} />
          </div>
          <div className={styles.storageDiskPoolLegend}>
            <span className={styles.storageLegendUsed}>■ Used</span>
            <span className={styles.storageLegendAlloc}>■ Allocated</span>
            <span className={styles.storageLegendFree}>■ Free</span>
            <span className={styles.storageDiskPoolAllocTotal}>
              {totalAlloc.toFixed(1)} GB total allocated
            </span>
          </div>
        </div>
      )}

      {/* ── Per-component rows ── */}
      <div className={styles.storageTable}>
        {STORAGE_COMPONENTS.map(comp => {
          const live     = liveMap[comp.id] ?? {};
          const quota_gb = live.quota_gb ?? comp.defaultQuota;
          const draft    = draftQuotas[comp.id] ?? '';

          return (
            <div key={comp.id} className={styles.storageRow}>
              <div className={styles.storageInfo}>
                <span className={styles.storageLabel}>{comp.label}</span>
                <span className={styles.storageMeta}>{comp.desc}</span>
              </div>
              <StorageBar
                pct={live.pct ?? 0}
                used_gb={live.used_gb}
                quota_gb={quota_gb}
              />
              <div className={styles.storageQuotaEdit}>
                <input
                  className={styles.storageQuotaInput}
                  type="number"
                  min="0.1"
                  step="1"
                  placeholder={`${quota_gb} GB`}
                  value={draft}
                  onChange={e => handleQuotaChange(comp.id, e.target.value)}
                  aria-label={`New quota for ${comp.label}`}
                />
                <button
                  className={styles.storageQuotaBtn}
                  onClick={() => handleSetQuota(comp.id)}
                  disabled={!draft || saving[comp.id]}
                  aria-label={`Set quota for ${comp.label}`}
                >
                  {saving[comp.id] ? '...' : 'Set'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className={styles.fieldNote}>
        Quotas persist in <code>~/.aura/settings.json</code> and survive restarts.
        Storage governor runs as a background asyncio task.
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: SATELLITES — 3-tab: Network Map · Provision · Hardware Limits
// ─────────────────────────────────────────────────────────────────────────────

const SAT_ROLES = [
  { id: 'general',              label: 'General Purpose',      desc: 'Available for any task the planner assigns.' },
  { id: 'tool_specialist',      label: 'Tool Specialist',      desc: 'Called only for specific capabilities you define.' },
  { id: 'autonomous_collector', label: 'Autonomous Collector', desc: 'Runs on a schedule to collect and ingest data.' },
];

const SAT_ROLE_COLORS = {
  general:              '#4ec87a',
  tool_specialist:      '#3D87A8',
  autonomous_collector: '#B87820',
};

const DEFAULT_HW_THRESHOLDS = {
  gpu_warn_c:   70,
  gpu_hot_c:    80,
  gpu_crit_c:   85,
  cpu_warn_c:   65,
  cpu_hot_c:    75,
  cpu_crit_c:   80,
  vram_cap_pct: 80,
  ram_cap_pct:  75,
  queue_depth:  4,
  laptop_mode:  false,
};

const PROVISION_STEPS = [
  { id: 'scan',      label: 'Scan'      },
  { id: 'connect',   label: 'Connect'   },
  { id: 'assess',    label: 'Assess'    },
  { id: 'install',   label: 'Install'   },
  { id: 'model',     label: 'Model'     },
  { id: 'configure', label: 'Configure' },
  { id: 'confirm',   label: 'Confirm'   },
];

// ── Tab 1: Network Map ────────────────────────────────────────────────────────

const NetworkMapTab = ({ sats, onCircuitReset }) => {
  const [selectedId, setSelectedId] = useState(null);

  const W = 500, H = 240, CX = W / 2, CY = H / 2, R = 95;
  const selected = sats.find(s => s.id === selectedId);

  const satNodes = sats.map((sat, i) => {
    const angle = (2 * Math.PI * i / Math.max(sats.length, 1)) - Math.PI / 2;
    return { ...sat, x: CX + R * Math.cos(angle), y: CY + R * Math.sin(angle) };
  });

  return (
    <div className={styles.mapContainer}>
      <svg className={styles.mapSvg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
        {satNodes.map(n => (
          <line key={n.id} x1={CX} y1={CY} x2={n.x} y2={n.y}
            stroke={SAT_ROLE_COLORS[n.role]} strokeWidth="1.5" opacity="0.3" />
        ))}
        {/* AURA core */}
        <circle cx={CX} cy={CY} r={30} fill="#0d0d0d" stroke="#c8a96e" strokeWidth="1.5" />
        <text x={CX} y={CY - 5} textAnchor="middle" dominantBaseline="middle"
          fill="#c8a96e" fontSize="9" fontFamily="monospace" fontWeight="600">AURA</text>
        <text x={CX} y={CY + 7} textAnchor="middle" dominantBaseline="middle"
          fill="rgba(200,169,110,0.5)" fontSize="7" fontFamily="monospace">core</text>
        {/* Satellite nodes */}
        {satNodes.map(n => (
          <g key={n.id} style={{ cursor: 'pointer' }}
            onClick={() => setSelectedId(selectedId === n.id ? null : n.id)}>
            <circle cx={n.x} cy={n.y} r={22}
              fill={selectedId === n.id ? `${SAT_ROLE_COLORS[n.role]}22` : '#111'}
              stroke={SAT_ROLE_COLORS[n.role]}
              strokeWidth={selectedId === n.id ? 2 : 1.5}
              opacity={selectedId === n.id ? 1 : 0.85} />
            {/* Status dot */}
            <circle cx={n.x + 15} cy={n.y - 14} r={4}
              fill={n.status === 'online' ? '#4ec87a' : n.status === 'tripped' ? '#c84e4e' : '#555'} />
            <text x={n.x} y={n.y + 1} textAnchor="middle" dominantBaseline="middle"
              fill="#e0d9cc" fontSize="7" fontFamily="monospace">
              {n.name.length > 9 ? n.name.slice(0, 8) + '…' : n.name}
            </text>
          </g>
        ))}
      </svg>

      {sats.length === 0 && (
        <div className={styles.mapEmpty}>
          No satellites configured. Use the <strong>Provision</strong> tab to add one.
        </div>
      )}

      {selected && (
        <div className={styles.mapDrawer}>
          <div className={styles.mapDrawerHead}>
            <span className={styles.mapDrawerName}>{selected.name}</span>
            <span className={styles.satRoleBadge} style={{
              background: `${SAT_ROLE_COLORS[selected.role]}22`,
              color: SAT_ROLE_COLORS[selected.role],
            }}>
              {SAT_ROLES.find(r => r.id === selected.role)?.label}
            </span>
            <ModelStatusDot status={selected.status || 'offline'} />
          </div>
          <div className={styles.mapDrawerBody}>
            <div className={styles.mapDrawerRow}><span>Model</span><span>{selected.model}</span></div>
            {selected.machineType === 'network' && selected.host && (
              <div className={styles.mapDrawerRow}><span>Address</span><span>{selected.host}:{selected.port}</span></div>
            )}
            {selected.machineType === 'local_gpu' && (
              <div className={styles.mapDrawerRow}><span>GPU</span><span>Device {selected.gpuIndex}</span></div>
            )}
            {selected.capabilities?.length > 0 && (
              <div className={styles.mapDrawerRow}><span>Capabilities</span><span>{selected.capabilities.join(', ')}</span></div>
            )}
            {selected.dataSource && (
              <div className={styles.mapDrawerRow}><span>Data Source</span><span>{selected.dataSource}</span></div>
            )}
            {selected.status === 'tripped' && (
              <div className={styles.mapCircuitBanner}>
                <span>⚠ Circuit breaker tripped — hardware protection activated. Manual reset required.</span>
                <button className={styles.mapResetBtn} onClick={() => onCircuitReset(selected.id)}>
                  Reset
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// ── Tab 2: Provision ──────────────────────────────────────────────────────────

const BLANK_PROV = {
  host: '', model: 'llama3.2:3b', name: '', role: 'general',
  capabilities: '', dataSource: '', ingestRate: '60', gpuIndex: '1',
};

const ProvisionTab = ({ sats, onSatsChange }) => {
  const [machineType, setMachineType] = useState('network');
  const [step,        setStep]        = useState(0);
  const [scanning,    setScanning]    = useState(false);
  const [discovered,  setDiscovered]  = useState([]);
  const [form,        setForm]        = useState(BLANK_PROV);

  const setF = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  const runScan = async () => {
    setScanning(true);
    setDiscovered([]);
    try {
      const r = await fetch('http://127.0.0.1:8000/satellites/scan');
      if (r.ok) { const d = await r.json(); setDiscovered(d.discovered || []); }
    } catch { /* backend not yet running */ }
    setScanning(false);
  };

  const bootstrapScript = form.host
    ? `# AURA Bootstrap Agent — run as Administrator on ${form.host}\n# Generated ${new Date().toLocaleDateString()}\n$Token = "${Math.random().toString(36).slice(2, 18).toUpperCase()}"\n$Port  = 7778\n\nInvoke-WebRequest \`\n  -Uri "https://github.com/yourorgrepo/aura-satellite/releases/latest/download/aura_bootstrap.exe" \`\n  -OutFile "$env:TEMP\\aura_bootstrap.exe"\n\nStart-Process "$env:TEMP\\aura_bootstrap.exe" \`\n  -ArgumentList "--token=$Token --port=$Port --callback=http://<AURA_IP>:7799" \`\n  -Verb RunAs`
    : '';

  const commitSatellite = async () => {
    if (!form.name.trim() || !form.model.trim()) return;
    const payload = {
      host:  machineType === 'network'   ? form.host.trim()    : '127.0.0.1',
      port:  machineType === 'network'   ? 7779                : 7779,
      name:  form.name.trim(),
      role:  form.role,
      model: form.model.trim(),
    };
    try {
      const r = await fetch('http://127.0.0.1:8000/satellites/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        const d = await r.json();
        onSatsChange([...sats, d.satellite ?? { ...payload, id: `sat_${Date.now()}`, status: 'offline' }]);
      }
    } catch {
      // Fall back to local state only if backend unreachable
      onSatsChange([...sats, { ...payload, id: `sat_${Date.now()}`, status: 'offline' }]);
    }
    setStep(0);
    setForm(BLANK_PROV);
  };

  // ── Step panels ────────────────────────────────────────────────────────────

  const steps = [
    /* 0 — Scan */
    <div key="scan" className={styles.provStep}>
      <div className={styles.provStepTitle}>Scan Local Network</div>
      <p className={styles.provStepDesc}>
        Discover machines on your LAN running the AURA Bootstrap Agent (port 7778)
        or already-provisioned satellites (port 7779).
      </p>
      <button className={styles.connBtn} onClick={runScan} disabled={scanning}>
        {scanning ? 'Scanning…' : 'Scan Now'}
      </button>
      {discovered.length > 0 && (
        <div className={styles.scanResultList}>
          {discovered.map(m => (
            <div key={m.host} className={styles.scanResultRow}>
              <span className={styles.scanResultHost}>{m.host}</span>
              <span className={styles.scanResultPort}>:{m.port}</span>
              <span className={styles.scanResultState}>
                {m.port === 7779 ? 'Provisioned' : 'Bootstrap Ready'}
              </span>
              <button className={styles.connBtn}
                onClick={() => { setF('host', m.host); setStep(1); }}>
                Select
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.provOrDivider}>— or enter IP manually —</div>
      <div className={styles.satFormField}>
        <label className={styles.satFormLabel}>Machine IP</label>
        <input className={styles.keyInput} type="text" placeholder="192.168.x.x"
          value={form.host} onChange={e => setF('host', e.target.value)} />
      </div>
      <button className={styles.connBtn} disabled={!form.host.trim()} onClick={() => setStep(1)}>
        Next →
      </button>
    </div>,

    /* 1 — Connect */
    <div key="connect" className={styles.provStep}>
      <div className={styles.provStepTitle}>Connect to {form.host}</div>
      <p className={styles.provStepDesc}>
        AURA will attempt to reach the Bootstrap Agent or existing satellite agent on this machine.
      </p>
      <div className={styles.assessBlock}>
        <div className={styles.assessRow}><span className={styles.assessLabel}>Target</span><span className={styles.assessVal}>{form.host}</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>Bootstrap port</span><span className={styles.assessVal}>7778</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>Satellite port</span><span className={styles.assessVal}>7779</span></div>
      </div>
      <div className={styles.provNote}>
        The Bootstrap Agent must be running on the target machine before connecting.
        Use the Install step to generate the setup script.
      </div>
      <div className={styles.satFormActions}>
        <button className={styles.connBtn} onClick={() => setStep(2)}>Assess Hardware →</button>
        <button className={styles.llmDismiss} onClick={() => setStep(0)}>← Back</button>
      </div>
    </div>,

    /* 2 — Assess */
    <div key="assess" className={styles.provStep}>
      <div className={styles.provStepTitle}>Hardware Assessment</div>
      <p className={styles.provStepDesc}>
        Results from querying {form.host} via the Bootstrap Agent.
      </p>
      <div className={styles.assessBlock}>
        <div className={styles.assessRow}><span className={styles.assessLabel}>GPU</span><span className={styles.assessVal}>Awaiting connection</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>VRAM</span><span className={styles.assessVal}>—</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>RAM</span><span className={styles.assessVal}>—</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>Form Factor</span><span className={styles.assessVal}>—</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>OS</span><span className={styles.assessVal}>—</span></div>
      </div>
      <div className={styles.provNote}>
        Hardware Governor will use these values to enforce thermal and resource limits.
        AMD GPUs require rocm-smi before inference is permitted.
      </div>
      <div className={styles.satFormActions}>
        <button className={styles.connBtn} onClick={() => setStep(3)}>Install Agent →</button>
        <button className={styles.llmDismiss} onClick={() => setStep(1)}>← Back</button>
      </div>
    </div>,

    /* 3 — Install */
    <div key="install" className={styles.provStep}>
      <div className={styles.provStepTitle}>Deploy Bootstrap Agent</div>
      <p className={styles.provStepDesc}>
        Run this script as <strong>Administrator</strong> on <strong>{form.host}</strong>.
        It installs the Bootstrap Agent (port 7778) and the permanent Satellite Agent (port 7779)
        as a Windows Service.
      </p>
      <div className={styles.scriptBlock}>
        <pre className={styles.scriptPre}>{bootstrapScript || '# Enter a host IP in the Scan step first'}</pre>
      </div>
      <div className={styles.satFormActions}>
        <button className={styles.connBtn}
          disabled={!bootstrapScript}
          onClick={() => navigator.clipboard.writeText(bootstrapScript)}>
          Copy Script
        </button>
        <span className={styles.fieldNote}>Paste into PowerShell (Admin) on the target machine</span>
      </div>
      <div className={styles.provNote}>
        Single-use token — a new one is generated each time. The agent registers back to AURA
        automatically on completion.
      </div>
      <div className={styles.satFormActions} style={{ marginTop: 8 }}>
        <button className={styles.connBtn} onClick={() => setStep(4)}>Model Selection →</button>
        <button className={styles.llmDismiss} onClick={() => setStep(2)}>← Back</button>
      </div>
    </div>,

    /* 4 — Model */
    <div key="model" className={styles.provStep}>
      <div className={styles.provStepTitle}>Model Selection</div>
      <p className={styles.provStepDesc}>
        Choose which Ollama model to deploy on this satellite. The model will be pulled on the target machine.
      </p>
      <div className={styles.satFormField}>
        <label className={styles.satFormLabel}>Model</label>
        <input className={styles.keyInput} type="text"
          placeholder="e.g. llama3.2:3b  ·  mistral:7b  ·  phi3:mini"
          value={form.model} onChange={e => setF('model', e.target.value)} />
        <span className={styles.fieldNote}>
          Model is pulled via Ollama on the remote machine. Smaller models recommended for weak hardware.
        </span>
      </div>
      <div className={styles.satFormActions}>
        <button className={styles.connBtn} disabled={!form.model.trim()} onClick={() => setStep(5)}>
          Configure Role →
        </button>
        <button className={styles.llmDismiss} onClick={() => setStep(3)}>← Back</button>
      </div>
    </div>,

    /* 5 — Configure */
    <div key="configure" className={styles.provStep}>
      <div className={styles.provStepTitle}>Configure Satellite</div>
      <div className={styles.satFormField}>
        <label className={styles.satFormLabel}>Name</label>
        <input className={styles.keyInput} type="text" placeholder="e.g. Legal Specialist"
          value={form.name} onChange={e => setF('name', e.target.value)} />
      </div>
      <div className={styles.satFormLabel} style={{ marginBottom: 6 }}>Role</div>
      <div className={styles.satRoleGroup}>
        {SAT_ROLES.map(role => (
          <button key={role.id}
            className={[styles.satRoleBtn, form.role === role.id && styles.satRoleBtnActive].filter(Boolean).join(' ')}
            style={form.role === role.id ? { borderColor: SAT_ROLE_COLORS[role.id], color: SAT_ROLE_COLORS[role.id] } : {}}
            onClick={() => setF('role', role.id)}>
            <span className={styles.satRoleBtnName}>{role.label}</span>
            <span className={styles.satRoleBtnDesc}>{role.desc}</span>
          </button>
        ))}
      </div>
      {form.role === 'tool_specialist' && (
        <div className={styles.satFormField}>
          <label className={styles.satFormLabel}>Capabilities (comma-separated)</label>
          <input className={styles.keyInput} type="text"
            placeholder="e.g. legal_research, citation_lookup"
            value={form.capabilities} onChange={e => setF('capabilities', e.target.value)} />
        </div>
      )}
      {form.role === 'autonomous_collector' && (
        <>
          <div className={styles.satFormField}>
            <label className={styles.satFormLabel}>Data Source</label>
            <input className={styles.keyInput} type="text"
              placeholder="RSS feed, news URL, stream endpoint"
              value={form.dataSource} onChange={e => setF('dataSource', e.target.value)} />
          </div>
          <div className={styles.satFormField}>
            <label className={styles.satFormLabel}>Ingestion Rate (seconds, min 10)</label>
            <input className={styles.keyInput} type="number" min="10" placeholder="60"
              value={form.ingestRate} onChange={e => setF('ingestRate', e.target.value)} />
          </div>
        </>
      )}
      <div className={styles.satFormActions}>
        <button className={styles.connBtn} disabled={!form.name.trim()} onClick={() => setStep(6)}>
          Review →
        </button>
        <button className={styles.llmDismiss} onClick={() => setStep(4)}>← Back</button>
      </div>
    </div>,

    /* 6 — Confirm */
    <div key="confirm" className={styles.provStep}>
      <div className={styles.provStepTitle}>Confirm & Provision</div>
      <div className={styles.assessBlock}>
        <div className={styles.assessRow}><span className={styles.assessLabel}>Name</span><span className={styles.assessVal}>{form.name}</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>Host</span><span className={styles.assessVal}>{form.host}</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>Model</span><span className={styles.assessVal}>{form.model}</span></div>
        <div className={styles.assessRow}><span className={styles.assessLabel}>Role</span><span className={styles.assessVal}>{SAT_ROLES.find(r => r.id === form.role)?.label}</span></div>
        {form.capabilities && <div className={styles.assessRow}><span className={styles.assessLabel}>Capabilities</span><span className={styles.assessVal}>{form.capabilities}</span></div>}
        {form.dataSource    && <div className={styles.assessRow}><span className={styles.assessLabel}>Data Source</span><span className={styles.assessVal}>{form.dataSource}</span></div>}
      </div>
      <div className={styles.satFormActions} style={{ marginTop: 12 }}>
        <button className={styles.connBtn}
          disabled={!form.name.trim() || !form.host.trim() || !form.model.trim()}
          onClick={commitSatellite}>
          Provision Satellite
        </button>
        <button className={styles.llmDismiss} onClick={() => setStep(0)}>Start Over</button>
      </div>
    </div>,
  ];

  return (
    <div className={styles.provContainer}>
      {/* Machine type */}
      <div className={styles.satFormLabel} style={{ marginBottom: 8 }}>Machine Type</div>
      <div className={styles.pollIntervalGroup} style={{ marginBottom: 20 }}>
        <button
          className={[styles.pollIntervalBtn, machineType === 'network' && styles.pollIntervalBtnActive].filter(Boolean).join(' ')}
          onClick={() => { setMachineType('network'); setStep(0); }}>
          Network Machine
        </button>
        <button
          className={[styles.pollIntervalBtn, machineType === 'local_gpu' && styles.pollIntervalBtnActive].filter(Boolean).join(' ')}
          onClick={() => { setMachineType('local_gpu'); setStep(0); }}>
          Local GPU
        </button>
      </div>

      {/* ── Network wizard ── */}
      {machineType === 'network' && (
        <>
          <div className={styles.provStepBar}>
            {PROVISION_STEPS.map((s, i) => (
              <div key={s.id}
                className={[
                  styles.provStepBead,
                  i === step && styles.provStepBeadActive,
                  i < step  && styles.provStepBeadDone,
                ].filter(Boolean).join(' ')}
                onClick={() => i < step && setStep(i)}
                style={{ cursor: i < step ? 'pointer' : 'default' }}>
                <div className={styles.provStepBeadDot}>{i < step ? '✓' : i + 1}</div>
                <div className={styles.provStepBeadLabel}>{s.label}</div>
              </div>
            ))}
          </div>
          {steps[step]}
        </>
      )}

      {/* ── Local GPU (simplified) ── */}
      {machineType === 'local_gpu' && (
        <div className={styles.provStep}>
          <div className={styles.provStepTitle}>Add Local GPU Satellite</div>
          <p className={styles.provStepDesc}>
            Assign an additional GPU in this machine to a satellite role.
            GPU 0 is reserved for the core Interface Engine and Workhorse.
          </p>
          <div className={styles.satFormField}>
            <label className={styles.satFormLabel}>GPU Device Index</label>
            <input className={styles.keyInput} type="text" placeholder="e.g. 1"
              value={form.gpuIndex} onChange={e => setF('gpuIndex', e.target.value)} />
            <span className={styles.fieldNote}>
              GPU 0 is reserved. Assign additional cards starting from index 1.
            </span>
          </div>
          <div className={styles.satFormField}>
            <label className={styles.satFormLabel}>Name</label>
            <input className={styles.keyInput} type="text" placeholder="e.g. Local GPU 1"
              value={form.name} onChange={e => setF('name', e.target.value)} />
          </div>
          <div className={styles.satFormField}>
            <label className={styles.satFormLabel}>Model</label>
            <input className={styles.keyInput} type="text" placeholder="e.g. llama3.2:3b"
              value={form.model} onChange={e => setF('model', e.target.value)} />
          </div>
          <div className={styles.satFormLabel} style={{ marginBottom: 6 }}>Role</div>
          <div className={styles.satRoleGroup}>
            {SAT_ROLES.map(role => (
              <button key={role.id}
                className={[styles.satRoleBtn, form.role === role.id && styles.satRoleBtnActive].filter(Boolean).join(' ')}
                style={form.role === role.id ? { borderColor: SAT_ROLE_COLORS[role.id], color: SAT_ROLE_COLORS[role.id] } : {}}
                onClick={() => setF('role', role.id)}>
                <span className={styles.satRoleBtnName}>{role.label}</span>
                <span className={styles.satRoleBtnDesc}>{role.desc}</span>
              </button>
            ))}
          </div>
          <div className={styles.satFormActions} style={{ marginTop: 12 }}>
            <button className={styles.connBtn}
              disabled={!form.name.trim() || !form.model.trim() || !form.gpuIndex.trim()}
              onClick={commitSatellite}>
              Add Local GPU Satellite
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

// ── Tab 3: Hardware Limits ────────────────────────────────────────────────────

const HardwareLimitsTab = ({ sats }) => {
  const [selected, setSelected] = useState('__global__');
  const [limits,   setLimits]   = useState({ __global__: { ...DEFAULT_HW_THRESHOLDS }, __main__: {} });

  const getEffective = (id) => ({ ...DEFAULT_HW_THRESHOLDS, ...limits.__global__, ...limits[id] });
  const setLimit     = (id, key, val) =>
    setLimits(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: val } }));
  const resetToGlobal = (id) =>
    setLimits(prev => ({ ...prev, [id]: {} }));

  const eff           = getEffective(selected);
  const laptopOffset  = eff.laptop_mode ? -5 : 0;

  const machines = [
    { id: '__global__', name: 'Global Defaults', sub: 'Applied to all machines unless overridden' },
    { id: '__main__',   name: 'AURA Main',        sub: 'Interface Engine + Workhorse' },
    ...sats.map(s => ({
      id:   s.id,
      name: s.name,
      sub:  s.machineType === 'local_gpu' ? `Local GPU ${s.gpuIndex}` : s.host || '',
    })),
  ];

  const TempRow = ({ label, field, color }) => (
    <div className={styles.limitsRow}>
      <span className={styles.limitsLabel} style={{ color }}>{label}</span>
      <div className={styles.limitsTempGroup}>
        {[55, 60, 65, 70, 75, 80, 85, 90, 95].map(t => (
          <button key={t}
            className={[styles.tempStepBtn, eff[field] === t && styles.tempStepBtnActive].filter(Boolean).join(' ')}
            style={eff[field] === t ? { background: color + '33', borderColor: color, color } : {}}
            onClick={() => setLimit(selected, field, t)}>
            {t + laptopOffset}°
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className={styles.limitsContainer}>
      {/* Machine list */}
      <div className={styles.limitsSelector}>
        {machines.map(m => (
          <button key={m.id}
            className={[styles.limitsMachineBtn, selected === m.id && styles.limitsMachineBtnActive].filter(Boolean).join(' ')}
            onClick={() => setSelected(m.id)}>
            {m.name}
          </button>
        ))}
      </div>

      {/* Limits panel */}
      <div className={styles.limitsPanel}>
        <div className={styles.limitsMachineName}>{machines.find(m => m.id === selected)?.name}</div>
        {selected !== '__global__' && (
          <div className={styles.limitsMachineSub}>
            {machines.find(m => m.id === selected)?.sub} ·{' '}
            <button className={styles.resetToGlobal} onClick={() => resetToGlobal(selected)}>
              Reset to Global
            </button>
          </div>
        )}

        <div className={styles.limitsGroup}>
          <div className={styles.limitsGroupTitle}>GPU Temperature</div>
          <TempRow label="Warn — reduce batch size" field="gpu_warn_c" color="#c8a96e" />
          <TempRow label="Hot — drain queue"        field="gpu_hot_c"  color="#E07050" />
          <TempRow label="Critical — halt"          field="gpu_crit_c" color="#c84e4e" />
        </div>

        <div className={styles.limitsGroup}>
          <div className={styles.limitsGroupTitle}>CPU Temperature</div>
          <TempRow label="Warn"            field="cpu_warn_c" color="#c8a96e" />
          <TempRow label="Hot"             field="cpu_hot_c"  color="#E07050" />
          <TempRow label="Critical — halt" field="cpu_crit_c" color="#c84e4e" />
        </div>

        <div className={styles.limitsGroup}>
          <div className={styles.limitsGroupTitle}>Resource Caps</div>
          <div className={styles.limitsRow}>
            <span className={styles.limitsLabel}>VRAM cap (%)</span>
            <input className={styles.keyInput} type="number" min="10" max="100"
              value={eff.vram_cap_pct}
              onChange={e => setLimit(selected, 'vram_cap_pct', Number(e.target.value))}
              style={{ width: 70 }} />
          </div>
          <div className={styles.limitsRow}>
            <span className={styles.limitsLabel}>RAM cap (%)</span>
            <input className={styles.keyInput} type="number" min="10" max="100"
              value={eff.ram_cap_pct}
              onChange={e => setLimit(selected, 'ram_cap_pct', Number(e.target.value))}
              style={{ width: 70 }} />
          </div>
          <div className={styles.limitsRow}>
            <span className={styles.limitsLabel}>Queue depth</span>
            <input className={styles.keyInput} type="number" min="1" max="32"
              value={eff.queue_depth}
              onChange={e => setLimit(selected, 'queue_depth', Number(e.target.value))}
              style={{ width: 70 }} />
          </div>
        </div>

        <div className={styles.limitsGroup}>
          <div className={styles.limitsGroupTitle}>Laptop Protection</div>
          <div className={styles.limitsRow}>
            <span className={styles.limitsLabel}>Laptop mode</span>
            <div className={styles.limitsToggleTrack}
              style={eff.laptop_mode ? { background: 'var(--accent-gold)' } : {}}
              onClick={() => setLimit(selected, 'laptop_mode', !eff.laptop_mode)}>
              <div className={styles.limitsToggleThumb}
                style={eff.laptop_mode ? { transform: 'translateX(16px)' } : {}} />
            </div>
            <span className={styles.limitsMachineSub}>{eff.laptop_mode ? 'On' : 'Off'}</span>
          </div>
          {eff.laptop_mode && (
            <div className={styles.provNote}>
              Laptop mode: all temperature thresholds reduced by 5°C. Inference suspended on battery.
              Auto-detected via Win32_SystemEnclosure chassis type.
            </div>
          )}
        </div>

        <div className={styles.provNote}>
          Hardware Governor enforces these limits every 15 seconds. Circuit breaker tripped at Critical
          requires a manual reset in the Network Map tab. These limits cannot be overridden by any task or model.
        </div>
      </div>
    </div>
  );
};

// ── Shell: 3-tab SectionSatellites ────────────────────────────────────────────

const SectionSatellites = ({ satellites: initSats = [], onSatellitesChange }) => {
  const [sats,      setSats]      = useState(initSats);
  const [activeTab, setActiveTab] = useState('map');

  const update = (next) => {
    setSats(next);
    onSatellitesChange?.(next);
  };

  const handleCircuitReset = (satId) =>
    update(sats.map(s => s.id === satId ? { ...s, status: 'offline' } : s));

  const TABS = [
    { id: 'map',      label: 'Network Map'     },
    { id: 'provision', label: 'Provision'      },
    { id: 'limits',   label: 'Hardware Limits' },
  ];

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Satellites & Model Routing</h2>
        <p className={styles.sectionSub}>
          Extend the pipeline with specialized or parallel model instances running locally or on LAN machines.
          Hardware Governor is always active — protecting all hardware at every tier.
          Circuit breaker tripped at Critical requires manual reset.
        </p>
      </div>

      <div className={styles.satTabBar}>
        {TABS.map(t => (
          <button key={t.id}
            className={[styles.satTab, activeTab === t.id && styles.satTabActive].filter(Boolean).join(' ')}
            onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'map'       && <NetworkMapTab   sats={sats} onCircuitReset={handleCircuitReset} />}
      {activeTab === 'provision' && <ProvisionTab    sats={sats} onSatsChange={update} />}
      {activeTab === 'limits'    && <HardwareLimitsTab sats={sats} />}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: APPEARANCE
// ─────────────────────────────────────────────────────────────────────────────

const SectionAppearance = () => (
  <div className={styles.section}>
    <div className={styles.sectionHead}>
      <h2 className={styles.sectionTitle}>Appearance</h2>
      <p className={styles.sectionSub}>
        Theme and display customization. Reserved for a future sprint.
      </p>
    </div>

    <div className={styles.emptyState}>
      <div className={styles.emptyIcon} aria-hidden="true">◧</div>
      <div className={styles.emptyTitle}>Not yet configurable</div>
      <div className={styles.emptySub}>
        The current design system (amber signal, blue instrument, holographic glass)
        is locked for V1. Appearance options will be added in a later sprint.
      </div>
    </div>

    {/* Preview of locked tokens */}
    <div className={styles.tokenRow}>
      <span className={styles.tokenSwatch} style={{ background: '#B87820' }} />
      <span className={styles.tokenName}>--amber-signal</span>
      <span className={styles.tokenVal}>#B87820</span>
    </div>
    <div className={styles.tokenRow}>
      <span className={styles.tokenSwatch} style={{ background: '#3D87A8' }} />
      <span className={styles.tokenName}>--blue-instrument</span>
      <span className={styles.tokenVal}>#3D87A8</span>
    </div>
    <div className={styles.tokenRow}>
      <span className={styles.tokenSwatch} style={{ background: '#04080F' }} />
      <span className={styles.tokenName}>--bg-void</span>
      <span className={styles.tokenVal}>#04080F</span>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: TIME ZONES — world clock configuration
// ─────────────────────────────────────────────────────────────────────────────

// Every IANA timezone with a major city representative, grouped by region.
// Covers all UTC offsets from UTC-12 to UTC+14 including half-hour offsets.
const TZ_CATALOG = [
  // ── Americas ──────────────────────────────────────────────────────────────
  { id: 'pago_pago',    city: 'PAGO PAGO',     tz: 'Pacific/Pago_Pago',                   region: 'Americas',     utc: 'UTC-11' },
  { id: 'honolulu',     city: 'HONOLULU',       tz: 'Pacific/Honolulu',                    region: 'Americas',     utc: 'UTC-10' },
  { id: 'anchorage',    city: 'ANCHORAGE',      tz: 'America/Anchorage',                   region: 'Americas',     utc: 'UTC-9' },
  { id: 'la',           city: 'LOS ANGELES',    tz: 'America/Los_Angeles',                 region: 'Americas',     utc: 'UTC-8' },
  { id: 'vancouver',    city: 'VANCOUVER',      tz: 'America/Vancouver',                   region: 'Americas',     utc: 'UTC-8' },
  { id: 'denver',       city: 'DENVER',         tz: 'America/Denver',                      region: 'Americas',     utc: 'UTC-7' },
  { id: 'phoenix',      city: 'PHOENIX',        tz: 'America/Phoenix',                     region: 'Americas',     utc: 'UTC-7' },
  { id: 'chicago',      city: 'CHICAGO',        tz: 'America/Chicago',                     region: 'Americas',     utc: 'UTC-6' },
  { id: 'mexico_city',  city: 'MEXICO CITY',    tz: 'America/Mexico_City',                 region: 'Americas',     utc: 'UTC-6' },
  { id: 'nyc',          city: 'NEW YORK',       tz: 'America/New_York',                    region: 'Americas',     utc: 'UTC-5' },
  { id: 'toronto',      city: 'TORONTO',        tz: 'America/Toronto',                     region: 'Americas',     utc: 'UTC-5' },
  { id: 'miami',        city: 'MIAMI',          tz: 'America/New_York',                    region: 'Americas',     utc: 'UTC-5' },
  { id: 'bogota',       city: 'BOGOTÁ',         tz: 'America/Bogota',                      region: 'Americas',     utc: 'UTC-5' },
  { id: 'lima',         city: 'LIMA',           tz: 'America/Lima',                        region: 'Americas',     utc: 'UTC-5' },
  { id: 'caracas',      city: 'CARACAS',        tz: 'America/Caracas',                     region: 'Americas',     utc: 'UTC-4' },
  { id: 'santiago',     city: 'SANTIAGO',       tz: 'America/Santiago',                    region: 'Americas',     utc: 'UTC-4' },
  { id: 'buenos_aires', city: 'BUENOS AIRES',   tz: 'America/Argentina/Buenos_Aires',      region: 'Americas',     utc: 'UTC-3' },
  { id: 'sao_paulo',    city: 'SÃO PAULO',      tz: 'America/Sao_Paulo',                   region: 'Americas',     utc: 'UTC-3' },
  { id: 'azores',       city: 'AZORES',         tz: 'Atlantic/Azores',                     region: 'Americas',     utc: 'UTC-1' },
  // ── Europe ────────────────────────────────────────────────────────────────
  { id: 'london',       city: 'LONDON',         tz: 'Europe/London',                       region: 'Europe',       utc: 'UTC+0' },
  { id: 'dublin',       city: 'DUBLIN',         tz: 'Europe/Dublin',                       region: 'Europe',       utc: 'UTC+0' },
  { id: 'lisbon',       city: 'LISBON',         tz: 'Europe/Lisbon',                       region: 'Europe',       utc: 'UTC+0' },
  { id: 'paris',        city: 'PARIS',          tz: 'Europe/Paris',                        region: 'Europe',       utc: 'UTC+1' },
  { id: 'berlin',       city: 'BERLIN',         tz: 'Europe/Berlin',                       region: 'Europe',       utc: 'UTC+1' },
  { id: 'rome',         city: 'ROME',           tz: 'Europe/Rome',                         region: 'Europe',       utc: 'UTC+1' },
  { id: 'madrid',       city: 'MADRID',         tz: 'Europe/Madrid',                       region: 'Europe',       utc: 'UTC+1' },
  { id: 'amsterdam',    city: 'AMSTERDAM',      tz: 'Europe/Amsterdam',                    region: 'Europe',       utc: 'UTC+1' },
  { id: 'zurich',       city: 'ZURICH',         tz: 'Europe/Zurich',                       region: 'Europe',       utc: 'UTC+1' },
  { id: 'stockholm',    city: 'STOCKHOLM',      tz: 'Europe/Stockholm',                    region: 'Europe',       utc: 'UTC+1' },
  { id: 'warsaw',       city: 'WARSAW',         tz: 'Europe/Warsaw',                       region: 'Europe',       utc: 'UTC+1' },
  { id: 'athens',       city: 'ATHENS',         tz: 'Europe/Athens',                       region: 'Europe',       utc: 'UTC+2' },
  { id: 'helsinki',     city: 'HELSINKI',       tz: 'Europe/Helsinki',                     region: 'Europe',       utc: 'UTC+2' },
  { id: 'kyiv',         city: 'KYIV',           tz: 'Europe/Kyiv',                         region: 'Europe',       utc: 'UTC+2' },
  { id: 'bucharest',    city: 'BUCHAREST',      tz: 'Europe/Bucharest',                    region: 'Europe',       utc: 'UTC+2' },
  { id: 'istanbul',     city: 'ISTANBUL',       tz: 'Europe/Istanbul',                     region: 'Europe',       utc: 'UTC+3' },
  { id: 'moscow',       city: 'MOSCOW',         tz: 'Europe/Moscow',                       region: 'Europe',       utc: 'UTC+3' },
  { id: 'minsk',        city: 'MINSK',          tz: 'Europe/Minsk',                        region: 'Europe',       utc: 'UTC+3' },
  // ── Middle East & Africa ──────────────────────────────────────────────────
  { id: 'cairo',        city: 'CAIRO',          tz: 'Africa/Cairo',                        region: 'Middle East',  utc: 'UTC+2' },
  { id: 'tel_aviv',     city: 'TEL AVIV',       tz: 'Asia/Jerusalem',                      region: 'Middle East',  utc: 'UTC+2' },
  { id: 'nairobi',      city: 'NAIROBI',        tz: 'Africa/Nairobi',                      region: 'Middle East',  utc: 'UTC+3' },
  { id: 'riyadh',       city: 'RIYADH',         tz: 'Asia/Riyadh',                         region: 'Middle East',  utc: 'UTC+3' },
  { id: 'baghdad',      city: 'BAGHDAD',        tz: 'Asia/Baghdad',                        region: 'Middle East',  utc: 'UTC+3' },
  { id: 'tehran',       city: 'TEHRAN',         tz: 'Asia/Tehran',                         region: 'Middle East',  utc: 'UTC+3:30' },
  { id: 'dubai',        city: 'DUBAI',          tz: 'Asia/Dubai',                          region: 'Middle East',  utc: 'UTC+4' },
  { id: 'baku',         city: 'BAKU',           tz: 'Asia/Baku',                           region: 'Middle East',  utc: 'UTC+4' },
  { id: 'kabul',        city: 'KABUL',          tz: 'Asia/Kabul',                          region: 'Middle East',  utc: 'UTC+4:30' },
  { id: 'lagos',        city: 'LAGOS',          tz: 'Africa/Lagos',                        region: 'Africa',       utc: 'UTC+1' },
  { id: 'johannesburg', city: 'JOHANNESBURG',   tz: 'Africa/Johannesburg',                 region: 'Africa',       utc: 'UTC+2' },
  { id: 'casablanca',   city: 'CASABLANCA',     tz: 'Africa/Casablanca',                   region: 'Africa',       utc: 'UTC+1' },
  // ── Asia-Pacific ──────────────────────────────────────────────────────────
  { id: 'tashkent',     city: 'TASHKENT',       tz: 'Asia/Tashkent',                       region: 'Asia-Pacific', utc: 'UTC+5' },
  { id: 'karachi',      city: 'KARACHI',        tz: 'Asia/Karachi',                        region: 'Asia-Pacific', utc: 'UTC+5' },
  { id: 'mumbai',       city: 'MUMBAI',         tz: 'Asia/Kolkata',                        region: 'Asia-Pacific', utc: 'UTC+5:30' },
  { id: 'delhi',        city: 'NEW DELHI',      tz: 'Asia/Kolkata',                        region: 'Asia-Pacific', utc: 'UTC+5:30' },
  { id: 'kathmandu',    city: 'KATHMANDU',      tz: 'Asia/Kathmandu',                      region: 'Asia-Pacific', utc: 'UTC+5:45' },
  { id: 'dhaka',        city: 'DHAKA',          tz: 'Asia/Dhaka',                          region: 'Asia-Pacific', utc: 'UTC+6' },
  { id: 'yangon',       city: 'YANGON',         tz: 'Asia/Yangon',                         region: 'Asia-Pacific', utc: 'UTC+6:30' },
  { id: 'bangkok',      city: 'BANGKOK',        tz: 'Asia/Bangkok',                        region: 'Asia-Pacific', utc: 'UTC+7' },
  { id: 'jakarta',      city: 'JAKARTA',        tz: 'Asia/Jakarta',                        region: 'Asia-Pacific', utc: 'UTC+7' },
  { id: 'ho_chi_minh',  city: 'HO CHI MINH',   tz: 'Asia/Ho_Chi_Minh',                    region: 'Asia-Pacific', utc: 'UTC+7' },
  { id: 'kuala_lumpur', city: 'KUALA LUMPUR',   tz: 'Asia/Kuala_Lumpur',                   region: 'Asia-Pacific', utc: 'UTC+8' },
  { id: 'singapore',    city: 'SINGAPORE',      tz: 'Asia/Singapore',                      region: 'Asia-Pacific', utc: 'UTC+8' },
  { id: 'beijing',      city: 'BEIJING',        tz: 'Asia/Shanghai',                       region: 'Asia-Pacific', utc: 'UTC+8' },
  { id: 'shanghai',     city: 'SHANGHAI',       tz: 'Asia/Shanghai',                       region: 'Asia-Pacific', utc: 'UTC+8' },
  { id: 'hong_kong',    city: 'HONG KONG',      tz: 'Asia/Hong_Kong',                      region: 'Asia-Pacific', utc: 'UTC+8' },
  { id: 'taipei',       city: 'TAIPEI',         tz: 'Asia/Taipei',                         region: 'Asia-Pacific', utc: 'UTC+8' },
  { id: 'perth',        city: 'PERTH',          tz: 'Australia/Perth',                     region: 'Asia-Pacific', utc: 'UTC+8' },
  { id: 'ulaanbaatar',  city: 'ULAANBAATAR',    tz: 'Asia/Ulaanbaatar',                    region: 'Asia-Pacific', utc: 'UTC+8' },
  { id: 'pyongyang',    city: 'PYONGYANG',      tz: 'Asia/Pyongyang',                      region: 'Asia-Pacific', utc: 'UTC+9' },
  { id: 'seoul',        city: 'SEOUL',          tz: 'Asia/Seoul',                          region: 'Asia-Pacific', utc: 'UTC+9' },
  { id: 'tokyo',        city: 'TOKYO',          tz: 'Asia/Tokyo',                          region: 'Asia-Pacific', utc: 'UTC+9' },
  { id: 'adelaide',     city: 'ADELAIDE',       tz: 'Australia/Adelaide',                  region: 'Asia-Pacific', utc: 'UTC+9:30' },
  { id: 'darwin',       city: 'DARWIN',         tz: 'Australia/Darwin',                    region: 'Asia-Pacific', utc: 'UTC+9:30' },
  { id: 'sydney',       city: 'SYDNEY',         tz: 'Australia/Sydney',                    region: 'Asia-Pacific', utc: 'UTC+10' },
  { id: 'brisbane',     city: 'BRISBANE',       tz: 'Australia/Brisbane',                  region: 'Asia-Pacific', utc: 'UTC+10' },
  { id: 'vladivostok',  city: 'VLADIVOSTOK',    tz: 'Asia/Vladivostok',                    region: 'Asia-Pacific', utc: 'UTC+10' },
  { id: 'honiara',      city: 'HONIARA',        tz: 'Pacific/Guadalcanal',                 region: 'Pacific',      utc: 'UTC+11' },
  { id: 'auckland',     city: 'AUCKLAND',       tz: 'Pacific/Auckland',                    region: 'Pacific',      utc: 'UTC+12' },
  { id: 'suva',         city: 'SUVA',           tz: 'Pacific/Fiji',                        region: 'Pacific',      utc: 'UTC+12' },
  { id: 'nukualofa',    city: 'NUKUALOFA',      tz: 'Pacific/Tongatapu',                   region: 'Pacific',      utc: 'UTC+13' },
  { id: 'kiritimati',   city: 'KIRITIMATI',     tz: 'Pacific/Kiritimati',                  region: 'Pacific',      utc: 'UTC+14' },
];

// Color palette for newly added zones (cycles)
const TZ_COLORS = [
  '#4ec87a', '#c0c0c0', '#00ccff', '#b87820',
  '#e05555', '#c8a04e', '#9b7ed6', '#5eaad0',
  '#e07840', '#70c8a0',
];

const TZ_REGIONS = ['Americas', 'Europe', 'Middle East', 'Africa', 'Asia-Pacific', 'Pacific'];

function formatTZPreview(tz) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
  } catch { return '--:--'; }
}

const SectionTimezones = ({ timezones = [], onTimezonesChange }) => {
  const [zones,    setZones]    = useState(timezones);
  const [search,   setSearch]   = useState('');
  const [openRegion, setOpenRegion] = useState(null);

  // Keep in sync with parent
  const update = (next) => {
    setZones(next);
    onTimezonesChange?.(next);
  };

  const activeIds = new Set(zones.map(z => z.id));

  const addZone = (entry) => {
    if (activeIds.has(entry.id)) return;
    const color = TZ_COLORS[zones.length % TZ_COLORS.length];
    update([...zones, { ...entry, color, enabled: true }]);
  };

  const removeZone = (id) => {
    update(zones.filter(z => z.id !== id));
  };

  const toggleZone = (id) => {
    update(zones.map(z => z.id === id ? { ...z, enabled: !z.enabled } : z));
  };

  const moveZone = (id, dir) => {
    const idx = zones.findIndex(z => z.id === id);
    if (idx < 0) return;
    const next = [...zones];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    update(next);
  };

  const setColor = (id, color) => {
    update(zones.map(z => z.id === id ? { ...z, color } : z));
  };

  const filteredCatalog = TZ_CATALOG.filter(entry =>
    !activeIds.has(entry.id) &&
    (search === '' ||
      entry.city.toLowerCase().includes(search.toLowerCase()) ||
      entry.utc.toLowerCase().includes(search.toLowerCase()) ||
      entry.region.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Time Zones</h2>
        <p className={styles.sectionSub}>
          Configure the world clocks shown in the title bar.
          Drag to reorder, click the dot to change color, use the toggle to show/hide without removing.
          Covers all UTC offsets from UTC−12 to UTC+14.
        </p>
      </div>

      {/* ── Active clocks ── */}
      <div className={styles.tzActiveLabel}>ACTIVE CLOCKS ({zones.filter(z => z.enabled !== false).length} visible)</div>

      {zones.length === 0 ? (
        <div className={styles.tzEmpty}>No clocks configured — add from the catalog below.</div>
      ) : (
        <div className={styles.tzActiveList}>
          {zones.map((zone, idx) => (
            <div key={zone.id} className={styles.tzActiveRow}>
              {/* Color swatch — click to cycle */}
              <button
                className={styles.tzColorDot}
                style={{ background: zone.color }}
                onClick={() => {
                  const ci = TZ_COLORS.indexOf(zone.color);
                  setColor(zone.id, TZ_COLORS[(ci + 1) % TZ_COLORS.length]);
                }}
                aria-label={`Change color for ${zone.city}`}
                title="Click to cycle color"
              />

              <div className={styles.tzActiveInfo}>
                <span className={styles.tzActiveCity} style={{ color: zone.color }}>
                  {zone.city}
                </span>
                <span className={styles.tzActiveTZ}>{zone.tz}</span>
              </div>

              <span className={styles.tzActiveTime}>{formatTZPreview(zone.tz)}</span>

              {/* Reorder */}
              <div className={styles.tzReorderBtns}>
                <button
                  className={styles.tzReorderBtn}
                  onClick={() => moveZone(zone.id, -1)}
                  disabled={idx === 0}
                  aria-label="Move up"
                >▴</button>
                <button
                  className={styles.tzReorderBtn}
                  onClick={() => moveZone(zone.id, 1)}
                  disabled={idx === zones.length - 1}
                  aria-label="Move down"
                >▾</button>
              </div>

              {/* Show/hide toggle */}
              <button
                className={[
                  styles.toggleBtn,
                  zone.enabled !== false && styles.toggleBtnOn,
                ].filter(Boolean).join(' ')}
                role="switch"
                aria-checked={zone.enabled !== false}
                aria-label={`${zone.enabled !== false ? 'Hide' : 'Show'} ${zone.city}`}
                onClick={() => toggleZone(zone.id)}
                style={{ width: 32, height: 18 }}
              >
                <span className={styles.toggleThumb} />
              </button>

              {/* Remove */}
              <button
                className={styles.tzRemoveBtn}
                onClick={() => removeZone(zone.id)}
                aria-label={`Remove ${zone.city}`}
                title="Remove"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Add from catalog ── */}
      <div className={styles.tzCatalogHead}>
        <div className={styles.tzActiveLabel} style={{ margin: 0 }}>ADD CLOCK</div>
        <input
          className={styles.tzSearch}
          type="text"
          placeholder="Search city or UTC offset..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          aria-label="Search timezone catalog"
        />
      </div>

      <div className={styles.tzCatalog}>
        {(search ? [null] : TZ_REGIONS).map(region => {
          const entries = search
            ? filteredCatalog
            : filteredCatalog.filter(e => e.region === region);
          if (entries.length === 0) return null;
          const isOpen = search || openRegion === region;

          return (
            <div key={region ?? 'search'} className={styles.tzRegionGroup}>
              {!search && (
                <button
                  className={styles.tzRegionHeader}
                  onClick={() => setOpenRegion(isOpen ? null : region)}
                  aria-expanded={isOpen}
                >
                  <span>{region}</span>
                  <span className={styles.tzRegionCount}>{entries.length}</span>
                  <span className={styles.tzRegionChevron}>{isOpen ? '▾' : '▸'}</span>
                </button>
              )}
              {isOpen && (
                <div className={styles.tzRegionEntries}>
                  {entries.map(entry => (
                    <button
                      key={entry.id}
                      className={styles.tzCatalogEntry}
                      onClick={() => addZone(entry)}
                      aria-label={`Add ${entry.city}`}
                    >
                      <span className={styles.tzCatalogCity}>{entry.city}</span>
                      <span className={styles.tzCatalogUTC}>{entry.utc}</span>
                      <span className={styles.tzCatalogTime}>{formatTZPreview(entry.tz)}</span>
                      <span className={styles.tzCatalogAdd}>+</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className={styles.fieldNote}>
        Changes take effect immediately in the title bar. Order left to right matches display order.
        Maximum ~10 clocks recommended before the bar becomes crowded.
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: INTEL FEED — news source configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_FEED_SOURCES = [
  { id: 'reuters',    label: 'Reuters',       category: 'News Wire',  enabled: true },
  { id: 'bloomberg',  label: 'Bloomberg',     category: 'Finance',    enabled: true },
  { id: 'cnbc',       label: 'CNBC',          category: 'Finance',    enabled: true },
  { id: 'bbc',        label: 'BBC World',     category: 'News Wire',  enabled: true },
  { id: 'al_jazeera', label: 'Al Jazeera',    category: 'News Wire',  enabled: false },
  { id: 'techcrunch', label: 'TechCrunch',    category: 'Technology', enabled: true },
  { id: 'ars',        label: 'Ars Technica',  category: 'Technology', enabled: true },
  { id: 'hn',         label: 'Hacker News',   category: 'Technology', enabled: true },
  { id: 'wsj',        label: 'Wall St. Journal', category: 'Finance', enabled: false },
  { id: 'ft',         label: 'Financial Times', category: 'Finance',  enabled: false },
  { id: 'wired',      label: 'Wired',         category: 'Technology', enabled: false },
  { id: 'arxiv',      label: 'arXiv',         category: 'Science',    enabled: true },
];

const FEED_CATEGORIES = ['News Wire', 'Finance', 'Technology', 'Science'];

const SectionIntelFeed = ({ feedSources = DEFAULT_FEED_SOURCES, onFeedToggle }) => {
  const [sources, setSources] = useState(feedSources);

  const toggle = (id) => {
    const updated = sources.map(s => s.id === id ? { ...s, enabled: !s.enabled } : s);
    setSources(updated);
    onFeedToggle?.(updated);
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Intel Feed Sources</h2>
        <p className={styles.sectionSub}>
          Enable or disable live feed channels displayed in the Intel Feed panel.
          Disabled sources are hidden from the feed wall and selector strip.
          Backend RSS/API connector required for live data — stub mode active until connected.
        </p>
      </div>

      {FEED_CATEGORIES.map(cat => {
        const catSources = sources.filter(s => s.category === cat);
        return (
          <div key={cat} className={styles.feedCatGroup}>
            <div className={styles.feedCatLabel}>{cat.toUpperCase()}</div>
            {catSources.map(src => (
              <div key={src.id} className={styles.toggleRow}>
                <div className={styles.toggleInfo}>
                  <span className={styles.toggleLabel}>{src.label}</span>
                  <span className={styles.toggleMeta}>
                    {src.enabled ? 'Enabled — shown in feed wall' : 'Disabled — hidden from feed wall'}
                  </span>
                </div>
                <button
                  className={[
                    styles.toggleBtn,
                    src.enabled && styles.toggleBtnOn,
                  ].filter(Boolean).join(' ')}
                  role="switch"
                  aria-checked={src.enabled}
                  aria-label={`${src.enabled ? 'Disable' : 'Enable'} ${src.label}`}
                  onClick={() => toggle(src.id)}
                >
                  <span className={styles.toggleThumb} />
                </button>
              </div>
            ))}
          </div>
        );
      })}

      <div className={styles.fieldNote}>
        Feed connections are managed in Connectors. This section controls visibility only.
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: LIVE DATA SOURCES
// ─────────────────────────────────────────────────────────────────────────────

const UPGRADE_KEYS = [
  { id: 'huggingface', label: 'HuggingFace',      placeholder: 'HF token — for gated model downloads',     href: 'https://huggingface.co/settings/tokens' },
  { id: 'newsapi',     label: 'NewsAPI',          placeholder: 'NewsAPI key — free tier available',        href: 'https://newsapi.org' },
  { id: 'openweather', label: 'OpenWeatherMap',   placeholder: 'OWM API key — optional upgrade',           href: 'https://openweathermap.org/api' },
  { id: 'polygon',     label: 'Polygon.io',       placeholder: 'Polygon key — stocks/options/forex',       href: 'https://polygon.io' },
  { id: 'alphavantage',label: 'Alpha Vantage',    placeholder: 'Alpha Vantage key — equities/FX/crypto',   href: 'https://www.alphavantage.co' },
];

const SectionLiveData = () => {
  const { data: googleStatus, refresh: refreshGoogle } = useGoogleStatus();
  const [watchlistInput, setWatchlistInput] = useState('');
  const [watchlist, setWatchlist]           = useState([]);
  const [apiKeys, setApiKeys]               = useState({});
  const [oauthPending, setOauthPending]     = useState(null); // null | account_id being connected
  const [saveMsg, setSaveMsg]               = useState('');
  const [senders, setSenders]               = useState([]);
  const [senderForm, setSenderForm]         = useState({ email: '', displayName: '', appPassword: '' });
  const [showSenderForm, setShowSenderForm] = useState(false);

  // Load persisted API keys and email senders on mount
  useEffect(() => {
    fetch('http://127.0.0.1:8000/settings')
      .then(r => r.json())
      .then(data => {
        if (data.api_keys) setApiKeys(data.api_keys);
        if (data.email_senders?.length) setSenders(data.email_senders);
      })
      .catch(() => {});
  }, []);

  const googleAccounts  = googleStatus?.accounts ?? [];
  const googleConnected = googleStatus?.authenticated ?? false;

  const handleGoogleConnect = async (accountId = null) => {
    // accountId: null = new account (auto-generate slot), or existing id to reconnect
    const slotId = accountId ?? `account_${Date.now()}`;
    setOauthPending(slotId);
    try {
      const { url } = await getGoogleAuthUrl(slotId);
      if (window.electronAPI?.openExternal) {
        await window.electronAPI.openExternal(url);
      } else {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
      // Poll for up to 2 minutes
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        refreshGoogle();
        if (attempts >= 40) {
          clearInterval(poll);
          setOauthPending(null);
        }
      }, 3000);
    } catch (err) {
      console.error('[Settings] Google OAuth error:', err);
      setOauthPending(null);
    }
  };

  const handleGoogleActivate = async (accountId) => {
    try {
      await activateGoogleAccount(accountId);
      refreshGoogle();
    } catch (err) {
      console.error('[Settings] Failed to activate account:', err);
    }
  };

  const handleGoogleRemove = async (accountId) => {
    try {
      await removeGoogleAccount(accountId);
      refreshGoogle();
    } catch (err) {
      console.error('[Settings] Failed to remove account:', err);
    }
  };

  // Clear pending state when the pending account shows up as connected
  useEffect(() => {
    if (oauthPending && googleAccounts.some(a => a.account_id === oauthPending)) {
      setOauthPending(null);
    }
  }, [googleAccounts, oauthPending]);

  const addWatchlistTicker = () => {
    const ticker = watchlistInput.trim().toUpperCase();
    if (!ticker || watchlist.includes(ticker)) return;
    const updated = [...watchlist, ticker];
    setWatchlist(updated);
    setWatchlistInput('');
    updateWatchlist(updated).catch(console.error);
  };

  const removeWatchlistTicker = (ticker) => {
    const updated = watchlist.filter(t => t !== ticker);
    setWatchlist(updated);
    updateWatchlist(updated).catch(console.error);
  };

  const saveApiKey = async (id, val) => {
    setApiKeys(prev => ({ ...prev, [id]: val }));
    try {
      const res = await fetch('http://127.0.0.1:8000/settings/api-key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key_id: id, value: val }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaveMsg('Saved');
    } catch (err) {
      console.error('Failed to save API key:', err);
      setSaveMsg('Save failed');
    }
    setTimeout(() => setSaveMsg(''), 1500);
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Live Data Sources</h2>
        <p className={styles.sectionSub}>
          Connect OAuth services and add optional API upgrade keys.
          All core data sources are free with no key required.
          Keys unlock higher rate limits or additional data sources.
        </p>
      </div>

      {/* ── Google OAuth — multi-account ── */}
      <div className={styles.sectionSubHead}>Google Services</div>

      {/* Connected accounts list */}
      {googleAccounts.map(acct => (
        <div key={acct.account_id} className={styles.connRow}>
          <span className={[styles.connDot, styles.connDotOn].join(' ')} />
          <span className={styles.connName} style={{ flex: 1 }}>
            {acct.email !== 'unknown' ? acct.email : acct.account_id}
            {acct.is_active && <span className={styles.connBadgeActive}> ACTIVE</span>}
          </span>
          {!acct.is_active && (
            <button
              className={styles.connBtn}
              onClick={() => handleGoogleActivate(acct.account_id)}
            >
              Set Active
            </button>
          )}
          <button
            className={styles.connBtn}
            onClick={() => handleGoogleConnect(acct.account_id)}
            disabled={oauthPending === acct.account_id}
          >
            {oauthPending === acct.account_id ? 'Opening...' : 'Reconnect'}
          </button>
          <button
            className={[styles.connBtn, styles.connBtnRemove].join(' ')}
            onClick={() => handleGoogleRemove(acct.account_id)}
          >
            Remove
          </button>
        </div>
      ))}

      {/* Add account row — show up to 3 slots */}
      {googleAccounts.length < 3 && (
        <div className={styles.connRow}>
          <span className={[styles.connDot, styles.connDotOff].join(' ')} />
          <span className={styles.connName} style={{ flex: 1 }}>
            {googleAccounts.length === 0 ? 'Google Calendar + Gmail' : `Add account ${googleAccounts.length + 1}`}
          </span>
          <span className={[styles.connStatus].join(' ')}>
            {googleAccounts.length === 0 ? 'NOT CONNECTED' : 'SLOT AVAILABLE'}
          </span>
          <button
            className={styles.connBtn}
            onClick={() => handleGoogleConnect(null)}
            disabled={oauthPending !== null}
          >
            {oauthPending !== null && !googleAccounts.find(a => a.account_id === oauthPending)
              ? 'Opening...' : 'Connect'}
          </button>
        </div>
      )}

      <div className={styles.fieldNote}>
        Read-only Calendar + Gmail access. Up to 3 accounts. Tokens stored at <code>~/.aura/google_tokens/</code>.
        Requires <code>google_credentials.json</code> from Google Cloud Console.
      </div>

      {/* ── Email Senders ── */}
      <div className={styles.sectionSubHead} style={{ marginTop: 20 }}>Email Senders</div>
      <p className={styles.fieldNote} style={{ marginBottom: 8 }}>
        Gmail accounts AURA uses to send scheduled task outputs and subscriber notifications.
        Requires a Google App Password — generate one at myaccount.google.com → Security → App Passwords.
      </p>

      {senders.map(sender => (
        <div key={sender.id} className={styles.senderRow}>
          <div className={styles.senderInfo}>
            <span className={styles.senderEmail}>{sender.email}</span>
            {sender.displayName && (
              <span className={styles.senderName}>{sender.displayName}</span>
            )}
          </div>
          {sender.isDefault && <span className={styles.senderDefaultBadge}>DEFAULT</span>}
          {!sender.isDefault && (
            <button
              className={styles.connBtn}
              onClick={() => setSenders(prev =>
                prev.map(s => ({ ...s, isDefault: s.id === sender.id }))
              )}
            >
              Set Default
            </button>
          )}
          <button
            className={styles.tzRemoveBtn}
            onClick={() => setSenders(prev => prev.filter(s => s.id !== sender.id))}
            aria-label={`Remove ${sender.email}`}
          >✕</button>
        </div>
      ))}

      {!showSenderForm && (
        <button className={styles.addBtnInline} onClick={() => setShowSenderForm(true)}>
          + Add Sender
        </button>
      )}

      {showSenderForm && (
        <div className={styles.satForm}>
          <div className={styles.satFormRow}>
            <div className={styles.satFormField}>
              <label className={styles.satFormLabel}>Email Address</label>
              <input
                className={styles.keyInput}
                type="email"
                placeholder="e.g. info@gleipnirconsulting.com"
                value={senderForm.email}
                onChange={e => setSenderForm(prev => ({ ...prev, email: e.target.value }))}
              />
            </div>
            <div className={styles.satFormField}>
              <label className={styles.satFormLabel}>Display Name</label>
              <input
                className={styles.keyInput}
                type="text"
                placeholder="e.g. Gleipnir Consulting"
                value={senderForm.displayName}
                onChange={e => setSenderForm(prev => ({ ...prev, displayName: e.target.value }))}
              />
            </div>
          </div>
          <div className={styles.satFormField}>
            <label className={styles.satFormLabel}>App Password</label>
            <input
              className={styles.keyInput}
              type="password"
              placeholder="16-character Google App Password"
              value={senderForm.appPassword}
              onChange={e => setSenderForm(prev => ({ ...prev, appPassword: e.target.value }))}
            />
          </div>
          <div className={styles.satFormActions}>
            <button
              className={styles.connBtn}
              disabled={!senderForm.email.trim()}
              onClick={() => {
                const entry = {
                  id:          `sender_${Date.now()}`,
                  email:       senderForm.email.trim(),
                  displayName: senderForm.displayName.trim(),
                  appPassword: senderForm.appPassword,
                  isDefault:   senders.length === 0,
                };
                const updated = [...senders, entry];
                setSenders(updated);
                setSenderForm({ email: '', displayName: '', appPassword: '' });
                setShowSenderForm(false);
                fetch('http://127.0.0.1:8000/settings/email-senders', {
                  method: 'PUT',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ senders: updated }),
                }).catch(console.error);
              }}
            >
              Add Sender
            </button>
            <button
              className={styles.llmDismiss}
              onClick={() => {
                setSenderForm({ email: '', displayName: '', appPassword: '' });
                setShowSenderForm(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Optional upgrade keys ── */}
      <div className={styles.sectionSubHead} style={{ marginTop: 20 }}>Optional Upgrade Keys</div>
      <p className={styles.fieldNote} style={{ marginBottom: 8 }}>
        All panels work without these keys. Add them to unlock higher rate limits or richer data.
      </p>
      {UPGRADE_KEYS.map(key => (
        <div key={key.id} className={styles.keyRow}>
          <div className={styles.keyInfo}>
            <span className={styles.keyLabel}>{key.label}</span>
          </div>
          <input
            className={styles.keyInput}
            type="password"
            placeholder={key.placeholder}
            value={apiKeys[key.id] || ''}
            onChange={e => setApiKeys(prev => ({ ...prev, [key.id]: e.target.value }))}
            onBlur={e => { if (e.target.value) saveApiKey(key.id, e.target.value); }}
            aria-label={`${key.label} API key`}
          />
        </div>
      ))}
      {saveMsg && <div className={styles.saveMsg}>{saveMsg}</div>}

      {/* ── Watchlist manager ── */}
      <div className={styles.sectionSubHead} style={{ marginTop: 20 }}>Finance Watchlist</div>
      <p className={styles.fieldNote} style={{ marginBottom: 8 }}>
        Tickers shown in the Finance panel watchlist. Enter symbols like AAPL, BTC-USD, ETH-USD.
      </p>
      <div className={styles.watchlistInput}>
        <input
          className={styles.keyInput}
          type="text"
          placeholder="Add ticker (e.g. AAPL, BTC-USD)"
          value={watchlistInput}
          onChange={e => setWatchlistInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addWatchlistTicker()}
          aria-label="Add ticker to watchlist"
          style={{ flex: 1 }}
        />
        <button className={styles.connBtn} onClick={addWatchlistTicker}>Add</button>
      </div>
      <div className={styles.watchlistTags}>
        {watchlist.map(ticker => (
          <span key={ticker} className={styles.watchlistTag}>
            {ticker}
            <button
              className={styles.watchlistRemove}
              onClick={() => removeWatchlistTicker(ticker)}
              aria-label={`Remove ${ticker}`}
            >✕</button>
          </span>
        ))}
        {watchlist.length === 0 && (
          <span className={styles.fieldNote}>No tickers added — default watchlist will be used.</span>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: KNOWLEDGE DATABASE
// ─────────────────────────────────────────────────────────────────────────────

const KB_SOURCES = [
  {
    id: 'wikipedia', label: 'Wikipedia', size: '~50 GB', size_gb: 50,
    desc: 'ZIM archive — full offline encyclopedia (no images)',
    variants: [
      { id: 'wikipedia_math',      label: 'Mathematics',       size: '~2 GB',   size_gb: 2    },
      { id: 'wikipedia_chemistry', label: 'Chemistry',         size: '~2 GB',   size_gb: 2    },
      { id: 'wikipedia_physics',   label: 'Physics',           size: '~2 GB',   size_gb: 2    },
      { id: 'wikipedia_history',   label: 'History',           size: '~5 GB',   size_gb: 5    },
      { id: 'wikipedia_geography', label: 'Geography',         size: '~5 GB',   size_gb: 5    },
      { id: 'wikipedia_computer',  label: 'Computer Science',  size: '~3 GB',   size_gb: 3    },
      { id: 'wikipedia_medicine',  label: 'Medicine',          size: '~2.5 GB', size_gb: 2.5  },
      { id: 'wikipedia_sociology', label: 'Sociology',         size: '~2 GB',   size_gb: 2    },
      { id: 'wikipedia_top',       label: 'Top Articles',      size: '~6 GB',   size_gb: 6    },
    ],
  },
  {
    id: 'stackoverflow', label: 'Stack Exchange', size: '~22 GB', size_gb: 22,
    desc: 'ZIM archive — Stack Overflow + specialised sites',
    variants: [
      { id: 'se_math',             label: 'Mathematics SE',    size: '~2 GB',   size_gb: 2    },
      { id: 'se_physics',          label: 'Physics SE',        size: '~1.5 GB', size_gb: 1.5  },
      { id: 'se_security',         label: 'Security SE',       size: '~1 GB',   size_gb: 1    },
      { id: 'se_superuser',        label: 'Super User',        size: '~3 GB',   size_gb: 3    },
    ],
  },
  {
    id: 'devdocs_python', label: 'DevDocs', size: '~100 MB', size_gb: 0.1,
    desc: 'Language & framework documentation from DevDocs',
    variants: [
      { id: 'devdocs_javascript',  label: 'JavaScript',        size: '~100 MB', size_gb: 0.1  },
      { id: 'devdocs_react',       label: 'React',             size: '~50 MB',  size_gb: 0.05 },
    ],
  },
  { id: 'wiktionary', label: 'Wiktionary', size: '~6 GB', size_gb: 6, desc: 'English dictionary & definitions' },
  { id: 'pubmed',     label: 'PubMed',     size: '~12 GB', size_gb: 12, desc: 'NCBI biomedical literature abstracts' },
];

const API_KEY_SOURCES = [
  { id: 'courtlistener', label: 'CourtListener',    placeholder: 'CourtListener API token',    backendKey: 'courtlistener_token' },
  { id: 'congress',      label: 'Congress.gov',     placeholder: 'Congress.gov API key',       backendKey: 'congress_api_key' },
  { id: 'govinfo',       label: 'GovInfo',          placeholder: 'GovInfo API key',            backendKey: 'govinfo_api_key' },
  { id: 'openstates',    label: 'OpenStates',       placeholder: 'OpenStates API key',         backendKey: 'openstates_api_key' },
  { id: 'caselaw',       label: 'Caselaw Access',   placeholder: 'Caselaw Access Project key', backendKey: 'caselaw_api_key' },
];

const STATUS_COLORS = {
  not_downloaded: styles.kbStatusNone,
  downloading:    styles.kbStatusDl,
  indexing:       styles.kbStatusIdx,
  ready:          styles.kbStatusReady,
  error:          styles.kbStatusErr,
};

const STATUS_LABELS = {
  not_downloaded: 'NOT DOWNLOADED',
  downloading:    'DOWNLOADING',
  indexing:       'INDEXING',
  ready:          'READY',
  error:          'ERROR',
};

const SectionTaskQueue = () => {
  const { data: queueStatus, refresh: refreshStatus } = useQueueStatus(10000);
  const { data: queueTasks, refresh: refreshTasks }   = useQueueTasks(10000);
  const [cancelling, setCancelling] = useState({});

  const hwMode      = queueStatus?.hardware_mode ?? 'unknown';
  const pendingCount = queueStatus?.pending_count ?? 0;
  const vramMb      = queueStatus?.vram_mb ?? 0;
  const vramGb      = vramMb > 0 ? (vramMb / 1024).toFixed(1) : null;

  const handleCancel = async (taskId) => {
    setCancelling(prev => ({ ...prev, [taskId]: true }));
    try {
      await cancelQueuedTask(taskId);
      refreshTasks();
      refreshStatus();
    } catch (err) {
      console.error('[Settings] Cancel task failed:', err);
    } finally {
      setCancelling(prev => ({ ...prev, [taskId]: false }));
    }
  };

  const statusColor = hwMode === 'full' ? 'var(--accent-green, #4ade80)' : 'var(--accent-amber, #f59e0b)';
  const statusLabel = hwMode === 'full' ? 'FULL PIPELINE' : hwMode === 'interface_only' ? 'INTERFACE ONLY' : 'DETECTING...';

  return (
    <div className={styles.sectionBody}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Task Queue</h2>
        <p className={styles.sectionSub}>
          Team pipeline tasks queued while hardware is limited. Drain automatically when Ollama + workhorse model come online.
        </p>
      </div>

      {/* Hardware status card */}
      <div className={styles.connRow} style={{ marginBottom: 16 }}>
        <div className={styles.connInfo}>
          <span className={styles.connName}>Hardware Mode</span>
          <span className={styles.connStatus} style={{ color: statusColor }}>{statusLabel}</span>
        </div>
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 4 }}>
          {vramGb ? `${vramGb} GB VRAM detected` : 'VRAM undetectable'}
          {' · '}
          {pendingCount} task{pendingCount !== 1 ? 's' : ''} pending
        </div>
      </div>

      {/* Task list */}
      {!queueTasks || queueTasks.length === 0 ? (
        <p className={styles.fieldNote}>No tasks in queue.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {queueTasks.map(task => (
            <div key={task.task_id} className={styles.connRow} style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
              <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className={styles.connName} style={{ textTransform: 'none', maxWidth: '75%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {task.task_text}
                </span>
                <span className={styles.connStatus} style={{
                  color: task.status === 'done' ? 'var(--accent-green, #4ade80)'
                       : task.status === 'failed' ? 'var(--accent-red, #ef4444)'
                       : task.status === 'running' ? 'var(--accent-blue, #60a5fa)'
                       : task.status === 'cancelled' ? 'var(--text-tertiary)'
                       : 'var(--accent-amber, #f59e0b)',
                }}>
                  {task.status.toUpperCase()}
                </span>
              </div>
              <div style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className={styles.fieldNote} style={{ margin: 0 }}>
                  {new Date(task.created_at).toLocaleString()}
                </span>
                {task.status === 'pending' && (
                  <button
                    className={styles.connBtn}
                    style={{ fontSize: 'var(--text-xs)', padding: '2px 8px' }}
                    onClick={() => handleCancel(task.task_id)}
                    disabled={cancelling[task.task_id]}
                  >
                    {cancelling[task.task_id] ? '...' : 'Cancel'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const KbSourceRow = ({ src, statusMap, onDownload, dlTriggered }) => {
  const live   = statusMap[src.id] || {};
  const status = live.status || 'not_downloaded';
  const pct    = live.progress_pct ?? 0;
  const dlGb   = live.downloaded_gb ?? 0;
  const isReady = status === 'ready';
  const isDl    = status === 'downloading';
  const isIdx   = status === 'indexing';
  const canDl   = status === 'not_downloaded' || status === 'error';

  return (
    <div className={styles.kbRow}>
      <div className={styles.kbInfo}>
        <div className={styles.kbLabel}>{src.label}</div>
        {src.desc && <div className={styles.kbDesc}>{src.desc}</div>}
        <div className={styles.kbSize}>{src.size}</div>
      </div>
      <div className={styles.kbRight}>
        <span className={[styles.kbStatus, STATUS_COLORS[status]].filter(Boolean).join(' ')}>
          {STATUS_LABELS[status] || status.toUpperCase()}
        </span>
        {(isDl || isIdx) && (
          <div className={styles.kbProgressWrap}>
            <div className={styles.kbProgressTrack}>
              <div className={styles.kbProgressFill} style={{ width: `${pct}%` }} />
            </div>
            <span className={styles.kbProgressLabel}>
              {isDl ? `${dlGb.toFixed(1)} GB / ${src.size}` : 'Indexing...'}
            </span>
          </div>
        )}
        {canDl && (
          <button
            className={styles.connBtn}
            onClick={() => onDownload(src.id)}
            disabled={dlTriggered[src.id]}
            aria-label={`Download ${src.label}`}
          >
            {dlTriggered[src.id] ? 'Starting...' : 'Download'}
          </button>
        )}
        {isReady && (
          <span className={styles.kbReadyCheck} aria-label="Ready">✓ Active</span>
        )}
      </div>
    </div>
  );
};

const PERSONAL_TYPES = [
  { value: 'conversation_history', label: 'Conversation History' },
  { value: 'style_guide',          label: 'Style Guide' },
  { value: 'design_standard',      label: 'Design Standard' },
  { value: 'user_context',         label: 'User Context' },
];

const SectionKnowledgeDB = () => {
  const { data: kbData, refresh: refreshKB } = useKnowledgeSources(10000);
  const [legalKeys,    setLegalKeys]    = useState({});
  const [keySaving,    setKeySaving]    = useState(false);
  const [keySaved,     setKeySaved]     = useState(false);

  // Collection folder state
  const [collectionPath, setCollectionPath] = useState('');
  const [collectionEdit, setCollectionEdit] = useState('');
  const [isEditing,      setIsEditing]      = useState(false);
  const [sweepStatus,    setSweepStatus]    = useState(null);
  const [sweepError,     setSweepError]     = useState(null);

  // Personal ingestion state
  const [piType,         setPiType]         = useState('user_context');
  const [piTitle,        setPiTitle]        = useState('');
  const [piContent,      setPiContent]      = useState('');
  const [piStatus,       setPiStatus]       = useState(null);   // null | 'ingesting' | 'done' | 'error'
  const [piError,        setPiError]        = useState(null);
  const [batchStatus,    setBatchStatus]    = useState(null);   // null | 'ingesting' | 'done' | 'error'
  const [batchResult,    setBatchResult]    = useState(null);
  const [batchError,     setBatchError]     = useState(null);

  // Load collection folder path on mount
  useEffect(() => {
    getCollectionFolder()
      .then(data => {
        setCollectionPath(data.path || '');
        setCollectionEdit(data.path || '');
      })
      .catch(() => {});
  }, []);

  // Load existing legal keys from backend on mount
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('http://127.0.0.1:8000/data/api-keys');
        if (res.ok) {
          const data = await res.json();
          // Only populate if the censored value isn't empty
          const loaded = {};
          for (const src of API_KEY_SOURCES) {
            const val = data[src.backendKey] || '';
            if (val && val !== '****') loaded[src.id] = val;
          }
          setLegalKeys(loaded);
        }
      } catch { /* backend not ready */ }
    })();
  }, []);

  // Build indexed collections from live source data
  const collections = [];
  if (kbData?.sources) {
    for (const s of kbData.sources) {
      if (s.status === 'ready' || s.status === 'indexing') {
        collections.push(s);
      }
    }
  }

  const handleSweep = async () => {
    setSweepStatus('sweeping');
    setSweepError(null);
    try {
      const result = await sweepCollectionFolder();
      setSweepStatus(result);
      setTimeout(refreshKB, 2000);
    } catch (err) {
      setSweepError(err.message);
      setSweepStatus(null);
    }
  };

  const handleSaveFolder = async () => {
    if (!collectionEdit.trim()) return;
    try {
      const result = await setCollectionFolder(collectionEdit.trim());
      setCollectionPath(result.path);
      setIsEditing(false);
    } catch (err) {
      console.error('[Settings] Failed to save collection folder:', err);
    }
  };

  const handleSaveKeys = async () => {
    setKeySaving(true);
    setKeySaved(false);
    try {
      const updates = {};
      for (const src of API_KEY_SOURCES) {
        const val = legalKeys[src.id];
        if (val && !val.includes('...')) {
          updates[src.backendKey] = val;
        }
      }
      if (Object.keys(updates).length > 0) {
        await updateAPIKeys(updates);
      }
      setKeySaved(true);
      setTimeout(() => setKeySaved(false), 3000);
    } catch (err) {
      console.error('[Settings] Failed to save legal keys:', err);
    } finally {
      setKeySaving(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Knowledge Database</h2>
        <p className={styles.sectionSub}>
          Indexed offline collections and live legal/government data sources.
          Collections are ingested from the ZIM collection folder and indexed automatically.
        </p>
      </div>

      {/* ── Indexed Collections ── */}
      <div className={styles.sectionSubHead}>Indexed Collections</div>
      {collections.length === 0 ? (
        <div className={styles.kbBlock} style={{ padding: '1rem', color: 'var(--text-tertiary)', fontSize: '0.82rem' }}>
          No collections indexed yet. Drop ZIM files into the collection folder below, then scan.
        </div>
      ) : (
        collections.map(src => {
          const sizeLabel = src.size_gb
            ? `${src.size_gb.toFixed(1)} GB`
            : src.downloaded_gb
              ? `${src.downloaded_gb.toFixed(1)} GB`
              : '—';
          const articles = src.article_count
            ? `${(src.article_count / 1000).toFixed(0)}k articles`
            : null;
          return (
            <div key={src.source_id} className={styles.kbBlock}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.88rem' }}>
                    {src.label || src.source_id}
                  </span>
                  {src.description && (
                    <span style={{ color: 'var(--text-tertiary)', fontSize: '0.78rem', marginLeft: '0.6rem' }}>
                      {src.description}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
                  {articles && (
                    <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>{articles}</span>
                  )}
                  <span style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', fontFamily: 'var(--font-mono, monospace)' }}>
                    {sizeLabel}
                  </span>
                  <span className={src.status === 'ready' ? styles.kbStatusReady : styles.kbStatusIdx}>
                    {src.status === 'ready' ? 'READY' : 'INDEXING'}
                  </span>
                </div>
              </div>
            </div>
          );
        })
      )}

      {/* ── Collection Folder ── */}
      <div className={styles.kbBlock} style={{ marginTop: '1.2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem' }}>
          <span style={{ color: 'var(--blue-bright)', fontWeight: 600, fontSize: '0.85rem', fontFamily: 'var(--font-condensed)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Collection Folder</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
            Drop ZIM files here, then scan to index
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
          {isEditing ? (
            <>
              <input
                className={styles.keyInput}
                value={collectionEdit}
                onChange={e => setCollectionEdit(e.target.value)}
                placeholder="C:\Users\you\Downloads\ZIMs"
                style={{ flex: 1 }}
              />
              <button className={styles.connBtn} onClick={handleSaveFolder}>Save</button>
              <button className={`${styles.connBtn} ${styles.connBtnManage}`} onClick={() => { setIsEditing(false); setCollectionEdit(collectionPath); }}>Cancel</button>
            </>
          ) : (
            <>
              <code style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '4px 8px', background: 'rgba(31,45,64,.30)', borderRadius: '2px', border: '1px solid rgba(61,135,168,.15)' }}>
                {collectionPath || '~/.aura/knowledge/_inbox/'}
              </code>
              <button className={`${styles.connBtn} ${styles.connBtnManage}`} onClick={() => setIsEditing(true)}>Change</button>
            </>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <button
            className={styles.connBtn}
            onClick={handleSweep}
            disabled={sweepStatus === 'sweeping'}
            style={sweepStatus === 'sweeping' ? { opacity: 0.5, cursor: 'wait' } : {}}
          >
            {sweepStatus === 'sweeping' ? 'Scanning...' : 'Scan for New Files'}
          </button>
          {sweepError && (
            <span style={{ color: 'var(--fault-red)', fontSize: '0.75rem' }}>{sweepError}</span>
          )}
        </div>
        {sweepStatus && sweepStatus !== 'sweeping' && sweepStatus.actions && (
          <div style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {sweepStatus.actions.length === 0 ? (
              <span style={{ color: 'var(--text-tertiary)' }}>No new ZIM files found.</span>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1.2rem', listStyle: 'none' }}>
                {sweepStatus.actions.map((a, i) => (
                  <li key={i} style={{ marginBottom: '0.2rem', color: a.action === 'error' ? 'var(--fault-red)' : a.action === 'new' ? 'var(--green-ok)' : a.action === 'update' ? 'var(--amber-signal)' : 'var(--text-tertiary)' }}>
                    <strong style={{ textTransform: 'uppercase', fontSize: '0.7rem', letterSpacing: '.06em' }}>{a.action}</strong>{' '}
                    {a.filename} — {a.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── Personal Context Ingestion ── */}
      <div className={styles.sectionSubHead} style={{ marginTop: 20 }}>Personal Context</div>
      <p className={styles.fieldNote} style={{ marginBottom: 8 }}>
        Ingest writing style templates, design standards, preferences, or conversation history.
        Ingested content is retrieved automatically when relevant.
      </p>

      {/* Single document ingest */}
      <div className={styles.kbBlock}>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <select
            className={styles.keyInput}
            value={piType}
            onChange={e => setPiType(e.target.value)}
            style={{ width: '180px', flex: 'none' }}
          >
            {PERSONAL_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <input
            className={styles.keyInput}
            placeholder="Document title"
            value={piTitle}
            onChange={e => setPiTitle(e.target.value)}
            style={{ flex: 1 }}
          />
        </div>
        <textarea
          className={styles.keyInput}
          placeholder="Paste document content here..."
          value={piContent}
          onChange={e => setPiContent(e.target.value)}
          rows={4}
          style={{ width: '100%', resize: 'vertical', fontFamily: 'var(--font-ui)', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.5rem' }}>
          <button
            className={styles.connBtn}
            disabled={!piTitle.trim() || !piContent.trim() || piStatus === 'ingesting'}
            onClick={async () => {
              setPiStatus('ingesting');
              setPiError(null);
              try {
                await ingestPersonalDoc({ content: piContent, type: piType, title: piTitle.trim() });
                setPiStatus('done');
                setPiTitle('');
                setPiContent('');
                setTimeout(() => setPiStatus(null), 3000);
              } catch (err) {
                setPiStatus('error');
                setPiError(err.message);
              }
            }}
          >
            {piStatus === 'ingesting' ? 'Ingesting...' : piStatus === 'done' ? 'Ingested' : 'Ingest Document'}
          </button>
          {piStatus === 'done' && (
            <span style={{ color: 'var(--green-ok)', fontSize: '0.78rem' }}>Document ingested into memory</span>
          )}
          {piStatus === 'error' && (
            <span style={{ color: 'var(--fault-red)', fontSize: '0.78rem' }}>{piError}</span>
          )}
        </div>
      </div>

      {/* Batch ingest from folder */}
      <div className={styles.kbBlock} style={{ marginTop: '0.8rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem' }}>
          <span style={{ color: 'var(--amber-bright)', fontWeight: 600, fontSize: '0.85rem', fontFamily: 'var(--font-condensed)', textTransform: 'uppercase', letterSpacing: '.08em' }}>Batch Import</span>
          <span style={{ color: 'var(--text-tertiary)', fontSize: '0.75rem' }}>
            Import all .txt and .md files from User Data folder
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.6rem' }}>
          <code style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-secondary)', padding: '4px 8px', background: 'rgba(31,45,64,.30)', borderRadius: '2px', border: '1px solid rgba(61,135,168,.15)' }}>
            C:\Users\azrae\Desktop\User Data
          </code>
          <select
            className={styles.keyInput}
            value={piType}
            onChange={e => setPiType(e.target.value)}
            style={{ width: '180px', flex: 'none' }}
          >
            {PERSONAL_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
          <button
            className={styles.connBtn}
            disabled={batchStatus === 'ingesting'}
            onClick={async () => {
              setBatchStatus('ingesting');
              setBatchResult(null);
              setBatchError(null);
              try {
                const result = await batchIngestPersonal({
                  path: 'C:\\Users\\azrae\\Desktop\\User Data',
                  type: piType,
                });
                setBatchResult(result);
                setBatchStatus('done');
                setTimeout(() => setBatchStatus(null), 8000);
              } catch (err) {
                setBatchStatus('error');
                setBatchError(err.message);
              }
            }}
          >
            {batchStatus === 'ingesting' ? 'Importing...' : 'Import User Data'}
          </button>
          {batchStatus === 'done' && batchResult && (
            <span style={{ color: 'var(--green-ok)', fontSize: '0.78rem' }}>
              {batchResult.file_count} files queued for ingestion
            </span>
          )}
          {batchStatus === 'error' && (
            <span style={{ color: 'var(--fault-red)', fontSize: '0.78rem' }}>{batchError}</span>
          )}
        </div>
      </div>

      {/* ── Legal / government API keys ── */}
      <div className={styles.sectionSubHead} style={{ marginTop: 20 }}>Legal &amp; Government API Keys</div>
      <p className={styles.fieldNote} style={{ marginBottom: 8 }}>
        Add your key to enable routing to these sources. Free registration at each provider.
      </p>
      {API_KEY_SOURCES.map(src => (
        <div key={src.id} className={styles.keyRow}>
          <div className={styles.keyInfo}>
            <span className={styles.keyLabel}>{src.label}</span>
          </div>
          <input
            className={styles.keyInput}
            type="password"
            placeholder={src.placeholder}
            value={legalKeys[src.id] || ''}
            onChange={e => setLegalKeys(prev => ({ ...prev, [src.id]: e.target.value }))}
            aria-label={`${src.label} API key`}
          />
        </div>
      ))}
      <div style={{ marginTop: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
        <button
          className={styles.connBtn}
          onClick={handleSaveKeys}
          disabled={keySaving}
        >
          {keySaving ? 'Saving...' : keySaved ? 'Saved' : 'Save Keys'}
        </button>
        {keySaved && (
          <span style={{ color: 'var(--green-ok)', fontSize: '0.78rem' }}>Keys saved successfully</span>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION: SERVICES — external service integrations & remote access
// ─────────────────────────────────────────────────────────────────────────────

const POLL_INTERVALS = [
  { label: '1 min',  value: 1  },
  { label: '5 min',  value: 5  },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
];

const SectionServices = () => {
  const [pollInterval,   setPollInterval]   = useState(5);
  const [supabaseStatus, setSupabaseStatus] = useState('disconnected');
  const [lastSynced,     setLastSynced]     = useState(null);
  const [testing,        setTesting]        = useState(false);

  const testConnection = async () => {
    setTesting(true);
    try {
      // TODO: POST to /settings/services/test-supabase when endpoint is added
      await new Promise(r => setTimeout(r, 1200));
      setSupabaseStatus('connected');
      setLastSynced(new Date().toLocaleTimeString());
    } catch {
      setSupabaseStatus('error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>External Services</h2>
        <p className={styles.sectionSub}>
          Cloud services used by the scheduled task engine and public portal.
          Credentials are stored locally and never transmitted except to the target service.
        </p>
      </div>

      {/* ── AURA Portal / Supabase ── */}
      <div className={styles.sectionSubHead}>AURA Portal — Supabase</div>

      <div className={styles.connRow}>
        <ConnectorDot status={supabaseStatus} />
        <span className={styles.connName}>Supabase</span>
        <span className={[
          styles.connStatus,
          supabaseStatus === 'connected' && styles.connStatusOn,
          supabaseStatus === 'error'     && styles.connStatusErr,
        ].filter(Boolean).join(' ')}>
          {supabaseStatus.toUpperCase()}
        </span>
        <button
          className={styles.connBtn}
          onClick={testConnection}
          disabled={testing}
        >
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
      </div>

      <div className={styles.servicesBlock}>
        <div className={styles.servicesRow}>
          <span className={styles.servicesLabel}>Project URL</span>
          <span className={styles.servicesVal}>pwcwiqqxilaltgddogvd.supabase.co</span>
        </div>
        {lastSynced && (
          <div className={styles.servicesRow}>
            <span className={styles.servicesLabel}>Last Synced</span>
            <span className={styles.syncTimestamp}>{lastSynced}</span>
          </div>
        )}
      </div>

      <div className={styles.satFormLabel} style={{ marginTop: 16, marginBottom: 6 }}>
        Request Queue Polling Interval
      </div>
      <div className={styles.pollIntervalGroup}>
        {POLL_INTERVALS.map(opt => (
          <button
            key={opt.value}
            className={[
              styles.pollIntervalBtn,
              pollInterval === opt.value && styles.pollIntervalBtnActive,
            ].filter(Boolean).join(' ')}
            onClick={() => setPollInterval(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <div className={styles.fieldNote}>
        AURA polls Supabase for pending portal requests at this interval.
        New requests surface in the Scheduled tab's Approval Queue.
      </div>

      {/* ── Remote Access ── */}
      <div className={styles.sectionSubHead} style={{ marginTop: 24 }}>Remote Access</div>
      <div className={styles.emptyState} style={{ padding: '14px 0' }}>
        <div className={styles.emptyTitle} style={{ fontSize: 13 }}>Tailscale — coming in a future sprint</div>
        <div className={styles.emptySub}>
          Secure remote access from phone or laptop via a private mesh network.
          Install Tailscale on this machine and your devices — no port forwarding required.
          A lightweight PWA will be served at <code>/remote</code> for mobile access.
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS PANEL
// ─────────────────────────────────────────────────────────────────────────────

const SettingsPanel = ({
  operatingMode      = 'proactive',
  onModeChange,
  teamGateEnabled    = false,
  onTeamGateToggle,
  llmSuggestion      = null,
  onLlmAccept,
  onLlmDismiss,
  interfaceModel     = { name: 'Unknown', status: 'offline' },
  workhorseModel     = { name: 'Unknown', status: 'offline' },
  gpuInfo            = [],
  hardwareMode       = 'interface_only',
  devStub            = false,
  downloadProgress   = {},
  connectors         = DEFAULT_CONNECTORS,
  satellites         = [],
  onSatellitesChange,
  timezones          = [],
  onTimezonesChange,
  onOpenPanel,
}) => {
  const [activeSection, setActiveSection] = useState('general');

  return (
    <div className={styles.settings}>

      {/* ── LEFT SIDEBAR ── */}
      <div className={styles.sidebar}>
        <div className={styles.sideLabel}>Configure</div>

        {SECTIONS.map(s => (
          <button
            key={s.id}
            className={[
              styles.sideItem,
              activeSection === s.id && styles.sideItemActive,
            ].filter(Boolean).join(' ')}
            onClick={() => setActiveSection(s.id)}
            aria-current={activeSection === s.id ? 'page' : undefined}
          >
            <span className={styles.sideIcon} aria-hidden="true">{s.icon}</span>
            {s.label}
          </button>
        ))}

        <div className={styles.sideSpacer} />
        <div className={styles.sideVersion}>NX-Alpha v0.1.0</div>
      </div>

      {/* ── RIGHT CONTENT ── */}
      <div className={styles.content}>
        {activeSection === 'general' && (
          <SectionGeneral
            operatingMode={operatingMode}
            onModeChange={onModeChange}
            teamGateEnabled={teamGateEnabled}
            onTeamGateToggle={onTeamGateToggle}
          />
        )}
        {activeSection === 'models' && (
          <SectionModels
            interfaceModel={interfaceModel}
            workhorseModel={workhorseModel}
            gpuInfo={gpuInfo}
            hardwareMode={hardwareMode}
            devStub={devStub}
            llmSuggestion={llmSuggestion}
            onLlmAccept={onLlmAccept}
            onLlmDismiss={onLlmDismiss}
            downloadProgress={downloadProgress}
          />
        )}
        {activeSection === 'voice' && (
          <SectionVoice />
        )}
        {activeSection === 'live_data' && (
          <SectionLiveData />
        )}
        {activeSection === 'task_queue' && (
          <SectionTaskQueue />
        )}
        {activeSection === 'knowledge' && (
          <SectionKnowledgeDB />
        )}
        {activeSection === 'connectors' && (
          <SectionConnectors connectors={connectors} />
        )}
        {activeSection === 'api_keys' && (
          <SectionAPIKeys />
        )}
        {activeSection === 'intel_feed' && (
          <SectionIntelFeed />
        )}
        {activeSection === 'timezones' && (
          <SectionTimezones
            timezones={timezones}
            onTimezonesChange={onTimezonesChange}
          />
        )}
        {activeSection === 'storage' && (
          <SectionStorage onOpenPanel={onOpenPanel} />
        )}
        {activeSection === 'satellites' && (
          <SectionSatellites satellites={satellites} onSatellitesChange={onSatellitesChange} />
        )}
        {activeSection === 'services' && (
          <SectionServices />
        )}
        {activeSection === 'system_health' && (
          <SectionSystemHealth />
        )}
        {activeSection === 'huggingface' && (
          <SectionHuggingFace />
        )}
        {activeSection === 'phoenix' && (
          <SectionPhoenix />
        )}
        {activeSection === 'appearance' && (
          <SectionAppearance />
        )}
      </div>

    </div>
  );
};

export default SettingsPanel;
