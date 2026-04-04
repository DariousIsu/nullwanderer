import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function ResearcherNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeUtility} ${selected ? styles.selected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.header}>
        <span className={styles.icon}>◎</span> Researcher
      </div>
      <div className={styles.body}>
        {data.query_key || 'query'}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
