import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function ToolNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeTool} ${selected ? styles.selected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.header}>
        <span className={styles.icon}>◈</span> Tool
      </div>
      <div className={styles.body}>
        {data.tool_id || 'Select tool…'}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
