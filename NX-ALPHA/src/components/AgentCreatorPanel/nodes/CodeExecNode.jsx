import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function CodeExecNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeUtility} ${selected ? styles.selected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.header}>
        <span className={styles.icon}>⬟</span> Code Exec
      </div>
      <div className={styles.body}>
        {data.language || 'python'}
        {data.code ? ` · ${data.code.split('\n')[0].slice(0, 28)}` : ''}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
