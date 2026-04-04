/**
 * AURA NX-Alpha — SatellitePanel
 *
 * Network Map + Provisioning Wizard + Hardware Limits.
 * Renders inside DropPanel for 'satellites'.
 *
 * TAB 1: Network Map — hub-and-spoke topology with satellite node cards
 * TAB 2: Provision   — multi-step wizard (Scan -> Assess -> Install -> Model -> Configure)
 * TAB 3: Hardware Limits — global defaults + per-machine threshold overrides
 *
 * DATA: useSatellites() for fleet polling, action helpers for mutations.
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './SatellitePanel.module.css';
import {
  useSatellites,
  useSatelliteNetworkMap,
  scanNetwork,
  registerSatellite,
  resetCircuitBreaker,
  swapModel,
  assessHost,
  provisionHost,
  configureHost,
  removeSatellite,
  useSatelliteMetrics,
  getGovernorDefaults,
  setGovernorThresholds,
  getBootstrapScript,
  downloadBootstrapScript,
} from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'network',   label: 'Network Map' },
  { id: 'provision',  label: 'Provision' },
  { id: 'limits',     label: 'Hardware Limits' },
];

const WIZARD_STEPS = ['scan', 'assess', 'install', 'model', 'configure'];

const STATUS_DOT_MAP = {
  online:          'dotOnline',
  warm:            'dotWarm',
  throttled:       'dotThrottled',
  cooldown:        'dotCooldown',
  circuit_breaker: 'dotBreaker',
  offline:         'dotOffline',
  stale:           'dotOffline',
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function timeAgo(epoch) {
  if (!epoch) return 'Never';
  const diff = (Date.now() / 1000) - epoch;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

export default function SatellitePanel() {
  const [activeTab, setActiveTab] = useState('network');
  const [selectedSat, setSelectedSat] = useState(null);

  return (
    <div className={styles.satRoot}>
      {/* Tab Bar */}
      <div className={styles.tabBar}>
        {TABS.map(t => (
          <button
            key={t.id}
            className={`${styles.tab} ${activeTab === t.id ? styles.tabActive : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className={styles.tabContent}>
        {activeTab === 'network'  && <NetworkMapTab onSelect={setSelectedSat} />}
        {activeTab === 'provision' && <ProvisionTab />}
        {activeTab === 'limits'    && <HardwareLimitsTab />}
      </div>

      {/* Detail Drawer */}
      {selectedSat && (
        <DetailDrawer satellite={selectedSat} onClose={() => setSelectedSat(null)} />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 1: NETWORK MAP
// ─────────────────────────────────────────────────────────────────────────────

function NetworkMapTab({ onSelect }) {
  const { data: mapData, loading, refresh } = useSatelliteNetworkMap(15000);
  const hub = mapData?.hub || { name: 'AURA Main', status: 'online' };
  const nodes = mapData?.nodes || [];

  return (
    <div className={styles.mapContainer}>
      {/* Hub Node (Main AURA) */}
      <div className={styles.hubNode}>
        <div className={styles.hubIcon}>A</div>
        <div className={styles.hubInfo}>
          <div className={styles.hubName}>{hub.name}</div>
          <div className={styles.hubMeta}>
            {hub.gpu || 'Unknown GPU'} — {hub.vram_used_mb || 0}/{hub.vram_total_mb || 0} MB VRAM
          </div>
        </div>
        <button className={styles.btnSecondary} onClick={refresh}>Refresh</button>
      </div>

      {/* Connector line */}
      {nodes.length > 0 && <div className={styles.connector} />}

      {/* Satellite Grid */}
      {nodes.length > 0 ? (
        <div className={styles.satGrid}>
          {nodes.map(sat => (
            <SatelliteNodeCard key={sat.id} satellite={sat} onClick={() => onSelect(sat)} />
          ))}
        </div>
      ) : (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>&#9737;</div>
          <div>No satellites registered</div>
          <div style={{ opacity: 0.6, marginTop: 4 }}>
            Use the Provision tab to scan your network and add machines
          </div>
        </div>
      )}
    </div>
  );
}

function SatelliteNodeCard({ satellite: s, onClick }) {
  const dotClass = STATUS_DOT_MAP[s.status] || 'dotOffline';
  return (
    <div className={styles.nodeCard} onClick={onClick}>
      <div className={styles.nodeHeader}>
        <span className={`${styles.statusDot} ${styles[dotClass]}`} />
        <span className={styles.nodeName}>{s.name}</span>
        <span className={styles.nodeRole}>{s.role}</span>
      </div>
      <div className={styles.nodeDetails}>
        {s.model && <div className={styles.nodeModel}>{s.model}</div>}
        {s.gpu_type && <div className={styles.nodeGpu}>{s.gpu_type} — {s.vram_mb || 0} MB</div>}
        <div className={styles.nodeLastSeen}>
          {s.status === 'circuit_breaker' ? 'CIRCUIT BREAKER' : `Last seen: ${timeAgo(s.last_seen)}`}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL DRAWER
// ─────────────────────────────────────────────────────────────────────────────

function DetailDrawer({ satellite: s, onClose }) {
  const { data: metricsData } = useSatelliteMetrics(s.id, 10000);
  const metrics = metricsData?.metrics;
  const events = metricsData?.events || [];
  const [swapInput, setSwapInput] = useState('');

  const handleReset = useCallback(async () => {
    try {
      await resetCircuitBreaker(s.id);
    } catch (err) {
      console.error('Reset failed:', err);
    }
  }, [s.id]);

  const handleSwap = useCallback(async () => {
    if (!swapInput.trim()) return;
    try {
      await swapModel(s.id, swapInput.trim());
      setSwapInput('');
    } catch (err) {
      console.error('Swap failed:', err);
    }
  }, [s.id, swapInput]);

  const handleRemove = useCallback(async () => {
    try {
      await removeSatellite(s.id);
      onClose();
    } catch (err) {
      console.error('Remove failed:', err);
    }
  }, [s.id, onClose]);

  return (
    <div className={styles.drawer}>
      <div className={styles.drawerHeader}>
        <div className={styles.drawerTitle}>{s.name}</div>
        <button className={styles.drawerClose} onClick={onClose}>&#x2715;</button>
      </div>

      {/* Identity */}
      <MetricRow label="ID" value={s.id} />
      <MetricRow label="Host" value={`${s.host}:${s.port}`} />
      <MetricRow label="Role" value={s.role} />
      <MetricRow label="Model" value={s.model || '(none)'} />
      <MetricRow label="GPU" value={s.gpu_type || 'Unknown'} />
      <MetricRow label="VRAM" value={`${s.vram_mb || 0} MB`} />
      <MetricRow label="Status" value={s.status} />
      <MetricRow label="Last Seen" value={timeAgo(s.last_seen)} />

      {/* Live Metrics (if available) */}
      {metrics && (
        <>
          <div style={{ marginTop: 12, marginBottom: 4, fontSize: 11, fontWeight: 700, color: 'var(--sat-teal-lite)' }}>
            LIVE METRICS
          </div>
          {metrics.gpu_temp_c != null && <MetricRow label="GPU Temp" value={`${metrics.gpu_temp_c}°C`} />}
          {metrics.vram_used_mb != null && <MetricRow label="VRAM Used" value={`${metrics.vram_used_mb}/${metrics.vram_total_mb || '?'} MB`} />}
          {metrics.ram_used_gb != null && <MetricRow label="RAM Used" value={`${metrics.ram_used_gb?.toFixed(1)}/${metrics.ram_total_gb?.toFixed(1) || '?'} GB`} />}
        </>
      )}

      {/* Actions */}
      <div className={styles.drawerActions}>
        {s.circuit_breaker_tripped && (
          <button className={styles.btnDanger} onClick={handleReset}>Reset Circuit Breaker</button>
        )}
        <button className={styles.btnDanger} onClick={handleRemove}>Remove</button>
      </div>

      {/* Model Swap */}
      <div style={{ marginTop: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--sat-teal-lite)', marginBottom: 6 }}>
          HOT-SWAP MODEL
        </div>
        <div className={styles.manualEntry}>
          <input
            className={styles.ipInput}
            placeholder="model name (e.g., llama3.2:3b)"
            value={swapInput}
            onChange={e => setSwapInput(e.target.value)}
          />
          <button className={styles.btnPrimary} onClick={handleSwap}>Swap</button>
        </div>
      </div>

      {/* Recent Events */}
      {events.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--sat-teal-lite)', marginBottom: 6 }}>
            RECENT EVENTS
          </div>
          {events.slice(0, 10).map((ev, i) => (
            <div key={i} className={styles.metricRow}>
              <span className={styles.metricLabel}>{ev.event_type}</span>
              <span className={styles.metricValue}>{timeAgo(ev.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricRow({ label, value }) {
  return (
    <div className={styles.metricRow}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={styles.metricValue}>{value}</span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 2: PROVISION WIZARD
// ─────────────────────────────────────────────────────────────────────────────

function ProvisionTab() {
  const [step, setStep] = useState(0); // 0=scan, 1=assess, 2=install, 3=model, 4=configure
  const [scanResults, setScanResults] = useState([]);
  const [scanDone, setScanDone] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [connectError, setConnectError] = useState('');
  const [manualIp, setManualIp] = useState('');
  const [selectedHost, setSelectedHost] = useState(null);
  const [assessment, setAssessment] = useState(null);
  const [provisionResults, setProvisionResults] = useState(null);
  const [configName, setConfigName] = useState('');
  const [configRole, setConfigRole] = useState('general');
  const [selectedModel, setSelectedModel] = useState('');
  const [scriptLoading, setScriptLoading] = useState(false);
  const [scriptError, setScriptError] = useState('');

  const handleGetBootstrapScript = useCallback(async () => {
    setScriptLoading(true);
    setScriptError('');
    try {
      const script = await getBootstrapScript();
      downloadBootstrapScript(script);
    } catch (err) {
      setScriptError('Could not generate script — is AURA running?');
      console.error('Bootstrap script fetch failed:', err);
    }
    setScriptLoading(false);
  }, []);

  const handleScan = useCallback(async () => {
    setScanning(true);
    setScanDone(false);
    setConnectError('');
    try {
      const data = await scanNetwork();
      setScanResults(data.discovered || []);
    } catch (err) {
      console.error('Scan failed:', err);
      setScanResults([]);
    }
    setScanning(false);
    setScanDone(true);
  }, []);

  const handleSelectHost = useCallback(async (ip) => {
    setConnectError('');
    setSelectedHost(ip);
    setStep(1);
    try {
      const data = await assessHost(ip);
      setAssessment(data);
      if (data.model_recommendations?.length) {
        setSelectedModel(data.model_recommendations[0]);
      }
      if (data.error) {
        setConnectError(`Cannot reach ${ip}: ${data.error}. Run the Bootstrap Script on that machine first, then retry.`);
        setStep(0);
      }
    } catch (err) {
      setConnectError(`Connection to ${ip} failed: ${err.message}`);
      setStep(0);
    }
  }, []);

  const handleProvision = useCallback(async () => {
    if (!assessment?.checklist) return;
    setStep(2);
    try {
      const stepsToRun = assessment.checklist.filter(c => !c.installed);
      const data = await provisionHost(selectedHost, stepsToRun);
      setProvisionResults(data);
      setStep(data.all_success ? 4 : 2);
    } catch (err) {
      console.error('Provision failed:', err);
    }
  }, [assessment, selectedHost]);

  const handleConfigure = useCallback(async () => {
    try {
      await configureHost(selectedHost, {
        name: configName || `Satellite-${selectedHost}`,
        role: configRole,
        model: selectedModel,
      });
      // Reset wizard
      setStep(0);
      setSelectedHost(null);
      setAssessment(null);
      setProvisionResults(null);
    } catch (err) {
      console.error('Configure failed:', err);
    }
  }, [selectedHost, configName, configRole, selectedModel]);

  return (
    <div>
      {/* Wizard Step Indicators */}
      <div className={styles.wizardSteps}>
        {WIZARD_STEPS.map((s, i) => (
          <div
            key={s}
            className={`${styles.wizardStep} ${i === step ? styles.wizardStepActive : ''} ${i < step ? styles.wizardStepDone : ''}`}
          >
            {s}
          </div>
        ))}
      </div>

      {/* Step 0: Scan */}
      {step === 0 && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
            <button className={styles.btnPrimary} onClick={handleScan} disabled={scanning}>
              {scanning ? 'Scanning...' : 'Scan Network'}
            </button>
            <button
              className={styles.btnSecondary}
              onClick={handleGetBootstrapScript}
              disabled={scriptLoading}
              title="Generate aura_bootstrap.ps1 to install on target machine before scanning"
            >
              {scriptLoading ? 'Generating...' : 'Get Bootstrap Script'}
            </button>
          </div>
          {scriptError && (
            <div style={{ color: '#e05252', fontSize: 12, marginBottom: 8 }}>{scriptError}</div>
          )}
          {connectError && (
            <div style={{ color: '#e05252', fontSize: 11, marginBottom: 8, lineHeight: 1.4, background: 'rgba(224,82,82,0.08)', border: '1px solid rgba(224,82,82,0.25)', borderRadius: 4, padding: '6px 8px' }}>
              {connectError}
            </div>
          )}
          <div className={styles.manualEntry}>
            <input
              className={styles.ipInput}
              placeholder="Manual IP (e.g., 192.168.1.42)"
              value={manualIp}
              onChange={e => { setManualIp(e.target.value); setConnectError(''); }}
            />
            <button className={styles.btnSecondary} onClick={() => manualIp && handleSelectHost(manualIp)}>
              Connect
            </button>
          </div>
          {scanDone && scanResults.length === 0 && (
            <div style={{ color: '#888', fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
              No satellite software detected on the network.<br />
              To set up a new machine: click <strong style={{ color: '#c8a04e' }}>Get Bootstrap Script</strong>, run it on the target machine, then scan again.
            </div>
          )}
          {scanResults.length > 0 && (
            <div className={styles.scanResults}>
              {scanResults.map((r, i) => (
                <div key={i} className={styles.scanItem}>
                  <span className={styles.scanIp}>{r.ip}</span>
                  <span className={`${styles.scanType} ${r.type === 'bootstrap' ? styles.typeBootstrap : r.type === 'agent' ? styles.typeAgent : ''}`}
                    style={r.type === 'host' ? { color: '#888', fontSize: 9 } : {}}>
                    {r.type === 'host' ? 'reachable' : r.type}
                  </span>
                  {r.type === 'host' ? (
                    <button
                      className={styles.btnSecondary}
                      onClick={() => handleGetBootstrapScript()}
                      title="Download bootstrap script to install on this machine"
                    >
                      Get Bootstrap
                    </button>
                  ) : (
                    <button className={styles.btnSecondary} onClick={() => handleSelectHost(r.ip)}>
                      Select
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step 1: Assess */}
      {step === 1 && assessment && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
            Assessment: {selectedHost}
          </div>
          {assessment.status_data && (
            <div style={{ fontSize: 10, marginBottom: 8, opacity: 0.7 }}>
              {assessment.status_data.os || ''} — {assessment.status_data.cpu?.name || ''}
            </div>
          )}
          {assessment.checklist?.map((c, i) => (
            <div key={i} className={styles.checklistItem}>
              <span className={`${styles.checkIcon} ${c.installed ? styles.checkDone : styles.checkPending}`}>
                {c.installed ? '\u2713' : '\u2022'}
              </span>
              <span style={{ flex: 1 }}>{c.label}</span>
              <span style={{ fontSize: 9, opacity: 0.5 }}>{c.installed ? 'Installed' : 'Required'}</span>
            </div>
          ))}
          {assessment.warnings?.map((w, i) => (
            <div key={i} className={styles.warningBox}>{w}</div>
          ))}
          <div style={{ marginTop: 12 }}>
            <button className={styles.btnPrimary} onClick={handleProvision}>
              Begin Provisioning
            </button>
          </div>
        </div>
      )}

      {/* Step 2-3: Install + Model */}
      {(step === 2 || step === 3) && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>
            {provisionResults?.all_success ? 'Provisioning Complete' : 'Provisioning...'}
          </div>
          {provisionResults?.results?.map((r, i) => (
            <div key={i} className={styles.checklistItem}>
              <span className={`${styles.checkIcon} ${r.status === 'success' ? styles.checkDone : styles.checkFailed}`}>
                {r.status === 'success' ? '\u2713' : '\u2717'}
              </span>
              <span>{r.step}</span>
            </div>
          ))}
          {provisionResults?.all_success && (
            <button className={styles.btnPrimary} onClick={() => setStep(4)} style={{ marginTop: 12 }}>
              Continue to Configure
            </button>
          )}
        </div>
      )}

      {/* Step 4: Configure */}
      {step === 4 && (
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>Configure Satellite</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div>
              <label style={{ fontSize: 10, color: 'var(--sat-text-dim)' }}>Name</label>
              <input
                className={styles.ipInput}
                value={configName}
                onChange={e => setConfigName(e.target.value)}
                placeholder={`Satellite-${selectedHost}`}
                style={{ width: '100%', marginTop: 2 }}
              />
            </div>
            <div>
              <label style={{ fontSize: 10, color: 'var(--sat-text-dim)' }}>Role</label>
              <select
                className={styles.ipInput}
                value={configRole}
                onChange={e => setConfigRole(e.target.value)}
                style={{ width: '100%', marginTop: 2 }}
              >
                <option value="general">General Purpose</option>
                <option value="tool_specialist">Tool Specialist</option>
                <option value="autonomous_collector">Autonomous Collector</option>
              </select>
            </div>
            <div>
              <label style={{ fontSize: 10, color: 'var(--sat-text-dim)' }}>Model</label>
              <input
                className={styles.ipInput}
                value={selectedModel}
                onChange={e => setSelectedModel(e.target.value)}
                placeholder="e.g., llama3.2:3b"
                style={{ width: '100%', marginTop: 2 }}
              />
              {assessment?.model_recommendations?.length > 0 && (
                <div style={{ fontSize: 9, color: 'var(--sat-text-dim)', marginTop: 4 }}>
                  Recommended: {assessment.model_recommendations.join(', ')}
                </div>
              )}
            </div>
          </div>
          <button className={styles.btnPrimary} onClick={handleConfigure} style={{ marginTop: 12 }}>
            Complete Setup
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TAB 3: HARDWARE LIMITS
// ─────────────────────────────────────────────────────────────────────────────

function HardwareLimitsTab() {
  const { data: satData } = useSatellites(30000);
  const satellites = satData?.satellites || [];
  const [defaults, setDefaults] = useState(null);
  const [overrides, setOverrides] = useState({});

  useEffect(() => {
    getGovernorDefaults().then(d => setDefaults(d)).catch(() => {});
  }, []);

  const handleOverrideChange = useCallback((satId, field, value) => {
    setOverrides(prev => ({
      ...prev,
      [satId]: { ...(prev[satId] || {}), [field]: parseFloat(value) || 0 },
    }));
  }, []);

  const handleSaveOverrides = useCallback(async (satId) => {
    const ov = overrides[satId];
    if (!ov) return;
    try {
      await setGovernorThresholds(satId, ov);
    } catch (err) {
      console.error('Save thresholds failed:', err);
    }
  }, [overrides]);

  if (!defaults) return <div className={styles.emptyState}>Loading governor defaults...</div>;

  const THRESHOLD_FIELDS = [
    { key: 'temp_nominal_max', label: 'Temp Nominal Max', unit: '°C' },
    { key: 'temp_warm_max',    label: 'Temp Warm Max',    unit: '°C' },
    { key: 'temp_hot_max',     label: 'Temp Hot/Critical', unit: '°C' },
    { key: 'vram_cap_pct',     label: 'VRAM Cap',         unit: '%' },
    { key: 'vram_hard_cap_pct',label: 'VRAM Hard Cap',    unit: '%' },
    { key: 'ram_caution_pct',  label: 'RAM Caution',      unit: '%' },
    { key: 'ram_hard_cap_pct', label: 'RAM Hard Cap',     unit: '%' },
  ];

  return (
    <div>
      {/* Global Defaults */}
      <div className={styles.limitsSection}>
        <div className={styles.limitsTitle}>Global Defaults</div>
        {THRESHOLD_FIELDS.map(f => (
          <div key={f.key} className={styles.limitRow}>
            <span className={styles.limitLabel}>{f.label}</span>
            <span>
              <span className={styles.metricValue}>{defaults[f.key]}</span>
              <span className={styles.limitUnit}>{f.unit}</span>
            </span>
          </div>
        ))}
      </div>

      {/* Per-Machine Overrides */}
      {satellites.length > 0 && (
        <div className={styles.limitsSection}>
          <div className={styles.limitsTitle}>Per-Machine Overrides</div>
          {satellites.map(sat => (
            <div key={sat.id} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, color: 'var(--sat-teal-lite)' }}>
                {sat.name} ({sat.host}) {sat.is_laptop ? '— Laptop' : ''}
              </div>
              {THRESHOLD_FIELDS.map(f => (
                <div key={f.key} className={styles.limitRow}>
                  <span className={styles.limitLabel}>{f.label}</span>
                  <span style={{ display: 'flex', alignItems: 'center' }}>
                    <input
                      className={styles.limitInput}
                      type="number"
                      step={f.unit === '°C' ? 1 : 5}
                      placeholder={String(defaults[f.key])}
                      value={overrides[sat.id]?.[f.key] ?? ''}
                      onChange={e => handleOverrideChange(sat.id, f.key, e.target.value)}
                    />
                    <span className={styles.limitUnit}>{f.unit}</span>
                  </span>
                </div>
              ))}
              <button
                className={styles.btnSecondary}
                onClick={() => handleSaveOverrides(sat.id)}
                style={{ marginTop: 6 }}
              >
                Save Overrides
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
