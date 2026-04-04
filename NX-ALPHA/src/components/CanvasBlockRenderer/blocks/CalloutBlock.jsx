/**
 * CalloutBlock — bordered alert/note block.
 * Tone controls left border and background tint.
 *
 * Data shape:
 *   {
 *     tone?:  'amber'|'blue'|'red'|'green',  // default: 'amber'
 *     title?: string,
 *     body:   string,
 *   }
 */
import styles from './blocks.module.css';

const TONE_CLASSES = {
  amber: styles.calloutAmber,
  blue:  styles.calloutBlue,
  red:   styles.calloutRed,
  green: styles.calloutGreen,
};

const TONE_TITLE_COLORS = {
  amber: 'var(--amber-base)',
  blue:  'var(--blue-bright)',
  red:   'var(--status-error)',
  green: 'var(--green-bright)',
};

const CalloutBlock = ({ tone = 'amber', title = '', body = '' }) => {
  const toneClass   = TONE_CLASSES[tone] ?? TONE_CLASSES.amber;
  const titleColor  = TONE_TITLE_COLORS[tone] ?? TONE_TITLE_COLORS.amber;

  return (
    <div
      className={`${styles.root} ${toneClass}`}
      style={{ borderRadius: 2, height: '100%' }}
    >
      {title && (
        <div className={styles.calloutTitle} style={{ color: titleColor }}>
          {title}
        </div>
      )}
      <div
        className={`${styles.bodyText} ${styles.editable}`}
        contentEditable
        suppressContentEditableWarning
        data-placeholder="Callout text…"
        spellCheck
      >
        {body}
      </div>
    </div>
  );
};

export default CalloutBlock;
