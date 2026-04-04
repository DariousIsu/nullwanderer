/**
 * AURA NX-Alpha — QuickNotes
 *
 * Scratchpad that syncs to Aura context.
 * Fast capture. Everything Lucas writes here is available
 * to Aura as context when it's relevant.
 *
 * VARIANT: work — content first, frame recedes.
 *
 * NOTE SHAPE:
 * { id, text, timestamp, tags?: string[] }
 */

import { useState, useRef } from 'react';
import Panel from '../Panel/Panel';
import styles from './QuickNotes.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// NOTE ITEM
// ─────────────────────────────────────────────────────────────────────────────

const NoteItem = ({ note, onDelete }) => (
  <div className={styles.note}>
    <div className={styles.noteText}>{note.text}</div>
    <div className={styles.noteMeta}>
      <span className={styles.noteTime}>{note.timestamp}</span>
      {note.tags?.map(tag => (
        <span key={tag} className={styles.noteTag}>#{tag}</span>
      ))}
    </div>
    {onDelete && (
      <button
        className={styles.noteDelete}
        onClick={() => onDelete(note.id)}
        aria-label="Delete note"
      >×</button>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// QUICK NOTES
// ─────────────────────────────────────────────────────────────────────────────

const QuickNotes = ({
  notes    = [],
  isActive = false,
  onAddNote,
  onDeleteNote,
  onPopOut,
}) => {
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  const handleSubmit = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !onAddNote) return;
    onAddNote(text);
    setDraft('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      handleSubmit(e);
    }
  };

  const footer = (
    <form className={styles.inputRow} onSubmit={handleSubmit}>
      <textarea
        ref={inputRef}
        className={styles.input}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Capture a thought…"
        rows={1}
        aria-label="New note"
      />
      <button
        type="submit"
        className={styles.submitBtn}
        disabled={!draft.trim()}
        aria-label="Add note"
      >+</button>
    </form>
  );

  return (
    <Panel
      title="Quick Notes"
      variant="work"
      isActive={isActive}
      onPopOut={onPopOut}
      footer={footer}
      collapsible={true}
    >
      {notes.length === 0 ? (
        <div className={styles.empty}>No notes yet</div>
      ) : (
        <div className={styles.list}>
          {notes.map(note => (
            <NoteItem
              key={note.id}
              note={note}
              onDelete={onDeleteNote}
            />
          ))}
        </div>
      )}
    </Panel>
  );
};

export default QuickNotes;
