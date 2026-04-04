import { Handle, Position } from '@xyflow/react';
import styles from './nodes.module.css';

export function SkillGroupNode({ data, selected }) {
  return (
    <div className={`${styles.node} ${styles.nodeSkill} ${selected ? styles.selected : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className={styles.header}>
        <span className={styles.icon}>◈</span> Skill
      </div>
      <div className={styles.body}>
        {data.skill_id || 'Select skill…'}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
