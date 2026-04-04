import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function MemoryNode({ data, selected, type }) {
  const isWrite = type === 'memory_write';
  return (
    <div className={`${styles.node} ${styles.nodeMemory} ${selected ? styles.selected : ''}`}>
      {!isWrite && <Handle type="target" position={Position.Left} />}
      {isWrite && <Handle type="target" position={Position.Left} />}
      <div className={styles.header}>
        <span className={styles.icon}>◫</span> Memory {isWrite ? 'Write' : 'Read'}
      </div>
      <div className={styles.body}>
        {isWrite
          ? (data.source_label || 'source…')
          : `limit=${data.limit ?? 10}${data.query_key ? ` · ${data.query_key}` : ''}`
        }
      </div>
      {!isWrite && <Handle type="source" position={Position.Right} />}
    </div>
  );
}
