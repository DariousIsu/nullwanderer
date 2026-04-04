/**
 * AURA NX-Alpha — Phoenix Observability Section
 *
 * Manage and monitor the Arize Phoenix tracing server.
 *
 * PANELS:
 *   Status card   — Live reachability check + Open Dashboard link
 *   Configuration — Server URL + routing instrumentation toggle
 *   Trace Stats   — Aggregated routing decision telemetry from Phoenix API
 *   Data Mgmt     — Clear all traces
 *
 * API:
 *   GET    /phoenix/config    — {host, tracing_enabled}
 *   PUT    /phoenix/config    — save host / tracing toggle
 *   GET    /phoenix/status    — {reachable, host, project_count, tracing_enabled}
 *   GET    /phoenix/stats     — routing trace aggregate counts
 *   DELETE /phoenix/traces    — wipe all trace data
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './SectionPhoenix.module.css';

const BASE = 'http://localhost:8000';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const pct = (part, total) => (total > 0 ? Math.round((part / total) * 100) : 0);

// ─────────────────────────────────────────────────────────────────────────────
// STATUS CARD
// ─────────────────────────────────────────────────────────────────────────────

const StatusCard = ({ status, checking, launching, onLaunch, embedOpen, onEmbed }) => {
  const online  = !checking && status?.reachable;
  const offline = !checking && !status?.reachable;

  const cardCls = [
    styles.statusCard,
    online  ? styles.statusCard_online  : '',
    offline ? styles.statusCard_offline : '',
  ].filter(Boolean).join(' ');

  const dotCls = checking
    ? styles.dot_checking
    : online ? styles.dot_online : styles.dot_offline;

  const badgeCls = checking
    ? styles.badge_checking
    : online ? styles.badge_online : styles.badge_offline;

  const badgeLabel = checking ? 'CHECKING' : online ? 'ONLINE' : 'OFFLINE';

  return (
    <div className={cardCls}>
      <div className={styles.statusLeft}>
        <span className={styles.statusIcon} aria-hidden="true">◎</span>
        <span className={[styles.statusDot, dotCls].join(' ')} />
      </div>

      <div className={styles.statusBody}>
        <div className={styles.statusNameRow}>
          <span className={styles.statusName}>Phoenix</span>
          <span className={[styles.statusBadge, badgeCls].join(' ')}>
            {badgeLabel}
          </span>
        </div>
        <p className={styles.statusDesc}>Arize Phoenix observability server</p>
        {status && !checking && (
          <p className={styles.statusMeta}>
            {online
              ? `${status.project_count} project${status.project_count !== 1 ? 's' : ''} · ${status.host}`
              : `Unreachable · ${status.host}`}
          </p>
        )}
      </div>

      <div className={styles.statusActions}>
        {online ? (
          <>
            <button
              className={[styles.openBtn, embedOpen ? styles.openBtnActive : ''].filter(Boolean).join(' ')}
              onClick={onEmbed}
              aria-label="Toggle embedded Phoenix dashboard"
              aria-pressed={embedOpen}
            >
              {embedOpen ? 'Hide Dashboard' : 'Embed Dashboard'}
            </button>
            <a
              className={styles.openBtn}
              href={status.host}
              target="_blank"
              rel="noreferrer"
              aria-label="Open Phoenix dashboard in browser"
              style={{ marginLeft: '6px' }}
            >
              ↗
            </a>
            <span className={styles.onlinePulse} style={{ marginLeft: '10px' }} aria-hidden="true" />
          </>
        ) : (
          <button
            className={styles.launchBtn}
            onClick={onLaunch}
            disabled={launching || checking}
            aria-label="Launch Phoenix"
          >
            {launching ? 'Starting…' : 'Launch'}
          </button>
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// TIER BAR ROW
// ─────────────────────────────────────────────────────────────────────────────

const TierRow = ({ label, count, total, variant }) => (
  <div className={styles.tierRow}>
    <span className={styles.tierName}>{label}</span>
    <div className={styles.tierBarWrap}>
      <div
        className={[styles.tierBarFill, styles[`tierBarFill_${variant}`]].join(' ')}
        style={{ width: `${pct(count, total)}%` }}
      />
    </div>
    <span className={styles.tierPct}>{pct(count, total)}%</span>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION
// ─────────────────────────────────────────────────────────────────────────────

const SectionPhoenix = () => {
  const [status,     setStatus]    = useState(null);
  const [stats,      setStats]     = useState(null);
  const [config,     setConfig]    = useState({ host: 'http://localhost:6006', tracing_enabled: false });
  const [checking,   setChecking]  = useState(true);
  const [hostDraft,  setHostDraft] = useState('');
  const [saved,      setSaved]     = useState(false);
  const [clearing,   setClearing]  = useState(false);
  const [launching,  setLaunching] = useState(false);
  const [embedOpen,  setEmbedOpen] = useState(false);

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([
      fetch(`${BASE}/phoenix/config`).then(r => r.json()).catch(() => null),
      fetch(`${BASE}/phoenix/status`).then(r => r.json()).catch(() => null),
      fetch(`${BASE}/phoenix/stats`).then(r => r.json()).catch(() => null),
    ]).then(([cfg, sts, sts2]) => {
      if (cfg) {
        setConfig(cfg);
        setHostDraft(cfg.host);
      }
      if (sts) setStatus(sts);
      if (sts2) setStats(sts2);
      setChecking(false);
    });
  }, []);

  // ── Refresh status ────────────────────────────────────────────────────────
  const refreshStatus = useCallback(async () => {
    setChecking(true);
    try {
      const [sts, sts2] = await Promise.all([
        fetch(`${BASE}/phoenix/status`).then(r => r.json()),
        fetch(`${BASE}/phoenix/stats`).then(r => r.json()),
      ]);
      setStatus(sts);
      setStats(sts2);
    } catch { /* ignore */ }
    setChecking(false);
  }, []);

  // ── Save host URL ─────────────────────────────────────────────────────────
  const handleSaveHost = useCallback(async () => {
    try {
      const res = await fetch(`${BASE}/phoenix/config`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ host: hostDraft }),
      });
      const data = await res.json();
      if (data.ok) {
        setConfig(prev => ({ ...prev, host: data.host }));
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
        refreshStatus();
      }
    } catch { /* ignore */ }
  }, [hostDraft, refreshStatus]);

  // ── Toggle tracing ────────────────────────────────────────────────────────
  const handleToggleTracing = useCallback(async () => {
    const next = !config.tracing_enabled;
    try {
      const res = await fetch(`${BASE}/phoenix/config`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ tracing_enabled: next }),
      });
      const data = await res.json();
      if (data.ok) setConfig(prev => ({ ...prev, tracing_enabled: next }));
    } catch { /* ignore */ }
  }, [config.tracing_enabled]);

  // ── Launch Phoenix ────────────────────────────────────────────────────────
  const handleLaunch = useCallback(async () => {
    setLaunching(true);
    try {
      await fetch(`${BASE}/phoenix/launch`, { method: 'POST' });
      // Poll every 2s for up to 30s
      let attempts = 0;
      const poll = setInterval(async () => {
        attempts++;
        try {
          const [sts, sts2] = await Promise.all([
            fetch(`${BASE}/phoenix/status`).then(r => r.json()),
            fetch(`${BASE}/phoenix/stats`).then(r => r.json()),
          ]);
          if (sts?.reachable) {
            setStatus(sts);
            setStats(sts2);
            setLaunching(false);
            clearInterval(poll);
          }
        } catch { /* ignore */ }
        if (attempts >= 15) {
          setLaunching(false);
          clearInterval(poll);
          refreshStatus();
        }
      }, 2000);
    } catch {
      setLaunching(false);
    }
  }, [refreshStatus]);

  // ── Clear traces ──────────────────────────────────────────────────────────
  const handleClearTraces = useCallback(async () => {
    if (!window.confirm('Clear all Phoenix traces? This cannot be undone.')) return;
    setClearing(true);
    try {
      await fetch(`${BASE}/phoenix/traces`, { method: 'DELETE' });
      await refreshStatus();
    } catch { /* ignore */ }
    setClearing(false);
  }, [refreshStatus]);

  // ── Tier total ────────────────────────────────────────────────────────────
  const tierTotal = stats
    ? (stats.tier_semantic + stats.tier_llm + stats.tier_keyword + stats.tier_default)
    : 0;

  return (
    <div className={styles.section}>

      {/* ── Header ── */}
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Phoenix Observability</h2>
        <p className={styles.sectionSub}>
          Arize Phoenix tracing for routing decisions and LLM pipeline telemetry.
          Each routing classification is captured as a span — visible here once
          instrumentation is enabled.
        </p>
      </div>

      {/* ── Status Card ── */}
      <StatusCard
        status={status}
        checking={checking}
        launching={launching}
        onLaunch={handleLaunch}
        embedOpen={embedOpen}
        onEmbed={() => setEmbedOpen(v => !v)}
      />

      {/* ── Embedded Dashboard ── */}
      {embedOpen && status?.reachable && (
        <div className={styles.embedPanel}>
          {/* webview bypasses X-Frame-Options that blocks iframe in Electron */}
          <webview
            className={styles.embedFrame}
            src={status.host}
            title="Phoenix Dashboard"
            allowpopups="true"
          />
        </div>
      )}

      {/* ── Configuration ── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Configuration</span>

        <div className={styles.fieldRow}>
          <span className={styles.fieldLabel}>Server URL</span>
          <input
            className={styles.fieldInput}
            value={hostDraft}
            onChange={e => setHostDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSaveHost()}
            placeholder="http://localhost:6006"
            spellCheck={false}
            aria-label="Phoenix server URL"
          />
          <button
            className={[styles.saveBtn, saved ? styles.saveBtnSaved : ''].join(' ')}
            onClick={handleSaveHost}
            disabled={hostDraft === config.host && !saved}
          >
            {saved ? 'Saved ✓' : 'Save'}
          </button>
        </div>

        <div className={styles.toggleRow}>
          <div className={styles.toggleLabel}>
            <span className={styles.toggleTitle}>Routing Instrumentation</span>
            <span className={styles.toggleDesc}>
              Emit a Phoenix span for every routing classification decision
            </span>
          </div>
          <button
            className={[styles.toggleBtn, config.tracing_enabled ? styles.toggleBtnOn : ''].join(' ')}
            onClick={handleToggleTracing}
            aria-checked={config.tracing_enabled}
            role="switch"
            aria-label="Toggle routing instrumentation"
          >
            <span className={styles.toggleThumb} />
          </button>
        </div>
      </div>

      {/* ── Trace Stats ── */}
      <div className={styles.group}>
        <span className={styles.groupLabel}>Routing Telemetry</span>

        {stats && stats.available ? (
          <>
            <div className={styles.statsGrid}>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{stats.total_traces.toLocaleString()}</span>
                <span className={styles.statLabel}>Total Traces</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{stats.solo_count.toLocaleString()}</span>
                <span className={styles.statLabel}>Solo Routed</span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{stats.team_count.toLocaleString()}</span>
                <span className={styles.statLabel}>Team Routed</span>
              </div>
              <div className={styles.statCard}>
                <span className={[
                  styles.statValue,
                  stats.disagreements > 0 ? styles.statValue_warn : '',
                ].join(' ')}>
                  {stats.disagreements}
                </span>
                <span className={styles.statLabel}>Tier Conflicts</span>
              </div>
            </div>

            {tierTotal > 0 && (
              <div className={styles.tierList}>
                <TierRow label="Semantic"    count={stats.tier_semantic} total={tierTotal} variant="semantic" />
                <TierRow label="LLM"         count={stats.tier_llm}      total={tierTotal} variant="llm"      />
                <TierRow label="Keyword"     count={stats.tier_keyword}  total={tierTotal} variant="keyword"  />
                <TierRow label="Fallback"    count={stats.tier_default}  total={tierTotal} variant="default"  />
              </div>
            )}
          </>
        ) : (
          <div className={styles.noDataMsg}>
            {checking
              ? 'Loading trace data...'
              : status?.reachable
                ? 'No routing traces yet — enable instrumentation and send a message to start collecting data.'
                : 'Phoenix offline — start the server to view telemetry.'}
          </div>
        )}
      </div>

      {/* ── Footer actions ── */}
      <div className={styles.footerRow}>
        <button
          className={styles.clearBtn}
          onClick={handleClearTraces}
          disabled={clearing || !status?.reachable || !stats?.total_traces}
          aria-label="Clear all Phoenix traces"
        >
          {clearing ? 'Clearing...' : 'Clear All Traces'}
        </button>
        <button
          className={styles.saveBtn}
          onClick={refreshStatus}
          disabled={checking}
          aria-label="Refresh Phoenix status"
        >
          {checking ? 'Checking...' : 'Refresh'}
        </button>
      </div>

      <div className={styles.note}>
        AURA can launch Phoenix via Docker or pip (fallback). If Docker is available,
        the container <code>phoenix</code> will be started or created automatically.
        Once reachable, enable instrumentation above to begin capturing routing spans.
      </div>

    </div>
  );
};

export default SectionPhoenix;
