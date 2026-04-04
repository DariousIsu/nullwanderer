import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function OutputNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeOutput} ${selected ? styles.selected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.header}>
        <span className={styles.icon}>▣</span> Output
      </div>
      <div className={styles.body}>
        {data.format || 'text'}
      </div>
    </div>
  );
}
