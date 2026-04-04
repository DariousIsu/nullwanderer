import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function BrowserNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeUtility} ${selected ? styles.selected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.header}>
        <span className={styles.icon}>◧</span> Browser
      </div>
      <div className={styles.body}>
        {data.action || 'navigate'}{data.url ? ` · ${data.url.slice(0, 24)}` : ''}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
