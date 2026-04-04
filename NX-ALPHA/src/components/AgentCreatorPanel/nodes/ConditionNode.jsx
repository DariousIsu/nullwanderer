import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function ConditionNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeCondition} ${selected ? styles.selected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.header}>
        <span className={styles.icon}>◇</span> Condition
      </div>
      <div className={styles.body}>
        {data.expression || 'expression…'}
      </div>
      {/* Two source handles for true/false branches */}
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        style={{ top: '35%' }}
      />
      <div className={styles.branchLabel} style={{ top: '28%' }}>T</div>
      <Handle
        type="source"
        position={Position.Right}
        id="false"
        style={{ top: '65%' }}
      />
      <div className={styles.branchLabel} style={{ top: '58%' }}>F</div>
    </div>
  );
}
