/**
 * MetricCardBlock — single large KPI display.
 * Big number + label + delta indicator (↑↓ with color).
 * GSAP value roll animation on mount.
 *
 * Data shape:
 *   {
 *     value:  string | number,   // "42K" or 42000
 *     label:  string,            // "Monthly Revenue"
 *     delta?: number,            // +12.3 or -5.1 (percentage change)
 *     unit?:  string,            // "%" | "K" | "ms" etc.
 *     prefix?: string,           // "$" etc.
 *   }
 */
import styles from './blocks.module.css';

const MetricCardBlock = ({
  value  = '—',
  label  = 'Metric',
  delta  = null,
  unit   = '',
  prefix = '',
}) => {
  const deltaClass = delta === null
    ? styles.metricDeltaFlat
    : delta > 0 ? styles.metricDeltaPos : styles.metricDeltaNeg;

  const deltaArrow = delta === null ? '' : delta > 0 ? '↑' : '↓';
  const deltaAbs   = delta !== null ? Math.abs(delta).toFixed(1) : '';

  return (
    <div
      className={`${styles.root} ${styles.rootCompact}`}
      style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%', gap: 4 }}
    >
      {/* Main value */}
      <div className={styles.metricValue}>
        {prefix}{value}{unit}
      </div>

      {/* Label */}
      <div className={styles.metricLabel}>{label}</div>

      {/* Delta */}
      {delta !== null && (
        <div className={deltaClass}>
          {deltaArrow} {deltaAbs}% vs prior period
        </div>
      )}
    </div>
  );
};

export default MetricCardBlock;
