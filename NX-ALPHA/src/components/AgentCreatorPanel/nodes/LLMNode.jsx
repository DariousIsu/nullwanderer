import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function LLMNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeLlm} ${selected ? styles.selected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.header}>
        <span className={styles.icon}>⬡</span> LLM
      </div>
      <div className={styles.body}>
        {data.model || 'llama3'} · t={data.temperature ?? 0.7}
      </div>
      {data.system_prompt && (
        <div className={styles.preview}>{data.system_prompt.slice(0, 48)}{data.system_prompt.length > 48 ? '…' : ''}</div>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
