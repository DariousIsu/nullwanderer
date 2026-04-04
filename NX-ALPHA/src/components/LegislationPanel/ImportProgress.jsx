/**
 * ImportProgress
 *
 * Shown at the bottom of the legislation sidebar while the initial 50-state
 * import is running. Hides once importStatus.running is false.
 *
 * @param {object} importStatus  — response from GET /legislation/import/status
 *   Shape: { running, progress: { running, completed, total, pct, current_zip } }
 */
import styles from './LegislationPanel.module.css';

export default function ImportProgress({ importStatus }) {
  const prog      = importStatus?.progress ?? {};
  const pct       = prog.pct       ?? 0;
  const completed = prog.completed ?? 0;
  const total     = prog.total     ?? 0;
  const zip       = prog.current_zip ? prog.current_zip.replace(/.*\//, '') : '';

  return (
    <div className={styles.importBanner}>
      <div className={styles.importLabel}>
        Importing legislation data
      </div>
      <div className={styles.importBar}>
        <div className={styles.importBarFill} style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.importCount}>
        {completed}/{total} states{zip ? ` — ${zip}` : ''}
      </div>
    </div>
  );
}
