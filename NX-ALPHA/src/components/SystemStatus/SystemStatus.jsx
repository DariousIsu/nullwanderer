/**
 * AURA NX-Alpha — SystemStatus
 *
 * Hardware telemetry + service health. Always-on ambient panel.
 * Reads at a glance. Peripheral awareness, not active focus.
 *
 * VARIANT: command — this is engine room data, it earns the heavy chassis.
 *
 * DATA SHAPE:
 *
 * metrics: [
 *   { id, label, value, unit?, status?: 'ok'|'warn'|'alert'|'fault', bar?: 0-100 }
 * ]
 *
 * services: [
 *   { id, name, status: 'ok'|'warn'|'fault'|'offline' }
 * ]
 *
 * uptime: string   e.g. "08:14:33"
 */

import Panel from '../Panel/Panel';
import styles from './SystemStatus.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// STATUS → COLOR MAPPING
// ─────────────────────────────────────────────────────────────────────────────

const statusColor = {
  ok:      'var(--green-bright)',
  warn:    'var(--amber-bright)',
  alert:   'var(--amber-hot)',
  fault:   'var(--status-error)',
  offline: 'var(--status-idle)',
};

// ─────────────────────────────────────────────────────────────────────────────
// METRIC ROW
// ─────────────────────────────────────────────────────────────────────────────

const MetricRow = ({ metric }) => {
  const valueColor = metric.status ? statusColor[metric.status] : 'var(--text-primary)';

  return (
    <div className={styles.metricRow}>
      <span className={styles.metricLabel}>{metric.label}</span>
      <div className={styles.metricRight}>
        {metric.bar != null && (
          <div className={styles.barTrack} aria-hidden="true">
            <div
              className={styles.barFill}
              style={{
                width: `${Math.max(0, Math.min(100, metric.bar))}%`,
                background: valueColor,
              }}
            />
          </div>
        )}
        <span className={styles.metricValue} style={{ color: valueColor }}>
          {metric.value}
          {metric.unit && <span className={styles.metricUnit}>{metric.unit}</span>}
        </span>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SERVICE INDICATOR
// ─────────────────────────────────────────────────────────────────────────────

const ServiceDot = ({ service }) => (
  <div className={styles.service}>
    <div
      className={styles.serviceDot}
      style={{ background: statusColor[service.status] ?? 'var(--status-idle)' }}
      aria-hidden="true"
    />
    <span className={styles.serviceName}>{service.name}</span>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// FOOTER
// ─────────────────────────────────────────────────────────────────────────────

const StatusFooter = ({ uptime }) => (
  <div className={styles.footer}>
    <span className={styles.footerLabel}>Uptime</span>
    <span className={styles.footerValue}>{uptime}</span>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM STATUS
// ─────────────────────────────────────────────────────────────────────────────

const SystemStatus = ({
  metrics  = [],
  services = [],
  uptime   = '—',
  isActive = false,
  onPopOut,
}) => {
  const hasFault = metrics.some(m => m.status === 'fault')
    || services.some(s => s.status === 'fault' || s.status === 'offline');

  return (
    <Panel
      title="System Status"
      variant={hasFault ? 'fault' : 'command'}
      isActive={isActive}
      onPopOut={onPopOut}
      faultMessage={hasFault ? 'One or more services reporting fault' : undefined}
      footer={<StatusFooter uptime={uptime} />}
      collapsible={true}
      defaultCollapsed={false}
    >
      {/* Metrics */}
      {metrics.length > 0 && (
        <div className={styles.section}>
          {metrics.map(m => (
            <MetricRow key={m.id} metric={m} />
          ))}
        </div>
      )}

      {/* Services */}
      {services.length > 0 && (
        <>
          <div className={styles.divider} aria-hidden="true" />
          <div className={styles.servicesGrid}>
            {services.map(s => (
              <ServiceDot key={s.id} service={s} />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
};

export default SystemStatus;
