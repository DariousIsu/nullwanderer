/**
 * HeadingBlock — section title with amber rule.
 * Level 1/2/3. In-place editable (contentEditable).
 *
 * Data shape: { text: string, level?: 1|2|3 }
 */
import { useRef } from 'react';
import styles from './blocks.module.css';

const HEADING_CLASSES = { 1: styles.heading1, 2: styles.heading2, 3: styles.heading3 };

const HeadingBlock = ({ text = 'Heading', level = 1 }) => {
  const headingClass = HEADING_CLASSES[level] ?? styles.heading1;
  const Tag = `h${level}`;

  return (
    <div className={styles.root}>
      <Tag
        className={`${headingClass} ${styles.editable}`}
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Enter heading…"
        spellCheck={false}
      >
        {text}
      </Tag>
      <div className={styles.headingRule} />
    </div>
  );
};

export default HeadingBlock;
