/**
 * AURA NX-Alpha — AgentToolbar
 *
 * Top bar of the Agent Creator panel.
 * Inline-editable name, category select, Save/Publish/Run buttons,
 * and a status chip that reflects draft / published / compile-error state.
 */

import styles from './AgentToolbar.module.css';

const CATEGORIES = ['general', 'research', 'automation', 'analysis', 'comms', 'monitoring'];

export default function AgentToolbar({
  agent,
  compileError,
  onSave,
  onPublish,
  onRun,
  onUpdateMeta,
}) {
  if (!agent) {
    return (
      <div className={styles.bar}>
        <span className={styles.hint}>Select or create an agent to begin.</span>
      </div>
    );
  }

  // Status chip
  let chipLabel = 'Draft';
  let chipClass = styles.chipDraft;
  if (compileError) {
    chipLabel = 'Compile Error';
    chipClass = styles.chipError;
  } else if (agent.published) {
    chipLabel = 'Published';
    chipClass = styles.chipPublished;
  }

  return (
    <div className={styles.bar}>

      {/* Name */}
      <input
        className={styles.nameInput}
        value={agent.name ?? ''}
        onChange={e => onUpdateMeta?.({ name: e.target.value })}
        placeholder="Agent name"
        aria-label="Agent name"
      />

      {/* Category */}
      <select
        className={styles.categorySelect}
        value={agent.category ?? 'general'}
        onChange={e => onUpdateMeta?.({ category: e.target.value })}
        aria-label="Agent category"
      >
        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
      </select>

      <div className={styles.spacer} />

      {/* Status chip */}
      <span className={`${styles.chip} ${chipClass}`}>{chipLabel}</span>

      {/* Action buttons */}
      <button className={styles.btnSave} onClick={onSave}>
        Save Draft
      </button>
      <button className={styles.btnPublish} onClick={onPublish}>
        Publish → Planner
      </button>
      <button className={styles.btnRun} onClick={onRun}>
        ▶ Run Test
      </button>

    </div>
  );
}
