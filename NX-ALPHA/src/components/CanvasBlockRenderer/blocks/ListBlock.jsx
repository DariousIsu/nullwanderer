/**
 * ListBlock — ordered or unordered list. Items are editable inline.
 * Supports adding new items via Enter key or + button.
 *
 * Data shape: { ordered?: boolean, items: string[] }
 */
import { useState } from 'react';
import styles from './blocks.module.css';

/** Convert basic markdown (bold, italic, inline code) to HTML string. */
function mdToHtml(text) {
  return String(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

const ListBlock = ({ ordered = false, items: initialItems = ['Item'] }) => {
  const [items, setItems] = useState(initialItems);

  const handleItemChange = (i, value) => {
    setItems(prev => prev.map((it, idx) => idx === i ? value : it));
  };

  const handleAddItem = () => {
    setItems(prev => [...prev, '']);
  };

  const handleKeyDown = (e, i) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setItems(prev => {
        const next = [...prev];
        next.splice(i + 1, 0, '');
        return next;
      });
      // Focus next item — handled via DOM after state update
      requestAnimationFrame(() => {
        const inputs = e.target.closest('ul,ol')?.querySelectorAll('[contenteditable]');
        inputs?.[i + 1]?.focus();
      });
    }
    if (e.key === 'Backspace' && e.target.textContent === '' && items.length > 1) {
      e.preventDefault();
      setItems(prev => prev.filter((_, idx) => idx !== i));
    }
  };

  const Tag = ordered ? 'ol' : 'ul';

  return (
    <div className={styles.root}>
      <Tag className={styles.list}>
        {items.map((item, i) => (
          <li key={i} className={styles.listItem}>
            {ordered
              ? <span className={styles.listBulletOrdered}>{i + 1}.</span>
              : <span className={styles.listBullet}>▸</span>
            }
            <span
              className={styles.editable}
              contentEditable
              suppressContentEditableWarning
              data-placeholder="List item…"
              onInput={(e) => handleItemChange(i, e.target.innerText)}
              onKeyDown={(e) => handleKeyDown(e, i)}
              style={{ flex: 1 }}
              dangerouslySetInnerHTML={{ __html: mdToHtml(item) }}
            />
          </li>
        ))}
      </Tag>
      <button
        className={styles.btnSecondary}
        onClick={handleAddItem}
        style={{ marginTop: 8, fontSize: 10 }}
      >
        + Add Item
      </button>
    </div>
  );
};

export default ListBlock;
