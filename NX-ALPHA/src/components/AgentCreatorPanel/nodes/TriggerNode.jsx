import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function TriggerNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeTrigger} ${selected ? styles.selected : ''}`}>
      <div className={styles.header}>
        <span className={styles.icon}>◷</span> Trigger
      </div>
      <div className={styles.body}>
        {data.cron || '0 * * * *'}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
