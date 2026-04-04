/**
 * ParagraphBlock — body text, Space Grotesk. In-place editable.
 *
 * Data shape: { text: string }
 */
import styles from './blocks.module.css';

const ParagraphBlock = ({ text = '' }) => (
  <div className={styles.root}>
    <p
      className={`${styles.bodyText} ${styles.editable}`}
      contentEditable
      suppressContentEditableWarning
      data-placeholder="Start typing…"
      spellCheck
    >
      {text}
    </p>
  </div>
);

export default ParagraphBlock;
