/**
 * AURA NX-Alpha — System Health Section
 *
 * Displays live status of all managed background services:
 *   Ollama, Docker, FalkorDB, Blender
 *
 * Each card shows:
 *   - Status dot (running / starting / stopped / not_installed / error)
 *   - Service name + description
 *   - Detail text (version info, error message, etc.)
 *   - Launch button (if stopped and launchable)
 *
 * Status updates arrive via SSE `service_status` events — no polling.
 * Initial state fetched from GET /system/services on mount.
 */

import { useState, useEffect, useCallback } from 'react';
import styles from './SectionSystemHealth.module.css';

const BASE = 'http://localhost:8000';

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE METADATA (display config, not runtime state)
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_META = {
  ollama:   { icon: '◈', launchable: true,  installUrl: 'https://ollama.com' },
  docker:   { icon: '⬡', launchable: true,  installUrl: 'https://docs.docker.com/desktop/install/windows-install/' },
  falkordb: { icon: '△', launchable: true,  installUrl: null },   // needs Docker
  blender:  { icon: '◬', launchable: false, installUrl: 'https://www.blender.org/download/' },
};

const STATUS_LABELS = {
  running:       'ONLINE',
  starting:      'STARTING',
  stopped:       'OFFLINE',
  error:         'ERROR',
  not_installed: 'NOT INSTALLED',
  unknown:       'UNKNOWN',
};

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE CARD
// ─────────────────────────────────────────────────────────────────────────────

const ServiceCard = ({ service, onLaunch, launching }) => {
  const meta   = SERVICE_META[service.id] || { icon: '◉', launchable: false };
  const status = service.status || 'unknown';

  return (
    <div className={[styles.card, styles[`card_${status}`]].filter(Boolean).join(' ')}>
      <div className={styles.cardLeft}>
        <span className={styles.cardIcon} aria-hidden="true">{meta.icon}</span>
        <span className={[styles.statusDot, styles[`dot_${status}`]].filter(Boolean).join(' ')} />
      </div>

      <div className={styles.cardBody}>
        <div className={styles.cardNameRow}>
          <span className={styles.cardName}>{service.name}</span>
          <span className={[styles.statusBadge, styles[`badge_${status}`]].filter(Boolean).join(' ')}>
            {STATUS_LABELS[status] || status.toUpperCase()}
          </span>
        </div>
        <p className={styles.cardDesc}>{service.description}</p>
        {service.details && (
          <p className={styles.cardDetail}>{service.details}</p>
        )}
      </div>

      <div className={styles.cardActions}>
        {status !== 'running' && meta.launchable && (
          <button
            className={styles.launchBtn}
            onClick={() => onLaunch(service.id)}
            disabled={launching === service.id || status === 'starting'}
          >
            {launching === service.id || status === 'starting' ? 'Starting...' : 'Launch'}
          </button>
        )}
        {status === 'not_installed' && meta.installUrl && (
          <a
            className={styles.installLink}
            href={meta.installUrl}
            target="_blank"
            rel="noreferrer"
          >
            Install ↗
          </a>
        )}
        {status === 'running' && (
          <span className={styles.onlinePulse} aria-hidden="true" />
        )}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SECTION
// ─────────────────────────────────────────────────────────────────────────────

const SectionSystemHealth = () => {
  const [services,  setServices]  = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [launching, setLaunching] = useState(null);

  // ── Fetch initial state ───────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${BASE}/system/services`)
      .then(r => r.json())
      .then(d => {
        setServices(d.services || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // ── SSE: service_status events ────────────────────────────────────────────
  useEffect(() => {
    const es = new EventSource(`${BASE}/stream`);
    es.addEventListener('service_status', (e) => {
      try {
        const updated = JSON.parse(e.data);
        setServices(prev => {
          const idx = prev.findIndex(s => s.id === updated.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = { ...next[idx], ...updated };
            return next;
          }
          return [...prev, updated];
        });
        // Clear launching spinner if service is now running or errored
        if (updated.status === 'running' || updated.status === 'error' || updated.status === 'not_installed') {
          setLaunching(prev => prev === updated.id ? null : prev);
        }
      } catch { /* ignore */ }
    });
    return () => es.close();
  }, []);

  // ── Manual launch ─────────────────────────────────────────────────────────
  const handleLaunch = useCallback(async (serviceId) => {
    setLaunching(serviceId);
    try {
      await fetch(`${BASE}/system/services/${serviceId}/launch`, { method: 'POST' });
    } catch (err) {
      console.error('[SystemHealth] launch error:', err);
      setLaunching(null);
    }
  }, []);

  // ── Summary counts ────────────────────────────────────────────────────────
  const running = services.filter(s => s.status === 'running').length;
  const total   = services.length;

  if (loading) {
    return (
      <div className={styles.section}>
        <div className={styles.loadingMsg}>Checking services...</div>
      </div>
    );
  }

  return (
    <div className={styles.section}>

      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>System Health</h2>
        <p className={styles.sectionSub}>
          Background services required by AURA. Stopped services launch automatically on startup.
          Manual launch available below.
        </p>
        <div className={styles.summary}>
          <span className={running === total ? styles.summaryGood : styles.summaryWarn}>
            {running}/{total} services online
          </span>
        </div>
      </div>

      <div className={styles.cardList}>
        {services.length === 0 ? (
          <div className={styles.emptyMsg}>No services registered.</div>
        ) : (
          services.map(svc => (
            <ServiceCard
              key={svc.id}
              service={svc}
              onLaunch={handleLaunch}
              launching={launching}
            />
          ))
        )}
      </div>

      <div className={styles.note}>
        AURA only stops services it launched. Services already running when AURA starts
        are left running when AURA exits.
      </div>

    </div>
  );
};

export default SectionSystemHealth;
