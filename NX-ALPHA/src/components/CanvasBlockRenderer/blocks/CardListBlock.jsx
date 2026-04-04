/**
 * CardListBlock — compact list of cards (news, memory results, file matches, etc.)
 *
 * Data shape:
 *   {
 *     cards: [{
 *       title:    string,         // Bold card title (required)
 *       source?:  string,         // Muted secondary line (publication, path, etc.)
 *       date?:    string,         // Timestamp / date string
 *       summary?: string,         // Preview text — truncated at 220 chars
 *       url?:     string,         // Makes title a clickable link
 *       subtitle?: string,        // Alt secondary line (screen_awareness)
 *       icon?:    string,         // Icon hint — unused visually for now
 *     }],
 *     caption?: string,           // Optional footer label
 *   }
 */
import styles from './blocks.module.css';
import cardStyles from './CardListBlock.module.css';

const CardListBlock = ({ cards = [], caption = null }) => {
  if (!cards.length) {
    return <div className={`${styles.root} ${styles.empty}`}>No items</div>;
  }

  return (
    <div className={`${styles.root} ${cardStyles.wrap}`}>
      <ul className={cardStyles.list}>
        {cards.map((card, i) => (
          <li key={i} className={cardStyles.card}>
            {/* Title — linked if url present */}
            <div className={cardStyles.title}>
              {card.url ? (
                <a
                  href={card.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={cardStyles.titleLink}
                >
                  {card.title}
                </a>
              ) : (
                card.title
              )}
            </div>

            {/* Secondary meta: source/subtitle + date */}
            {(card.source || card.subtitle || card.date) && (
              <div className={cardStyles.meta}>
                {card.source || card.subtitle
                  ? <span className={cardStyles.source}>{card.source ?? card.subtitle}</span>
                  : null}
                {card.source && card.date
                  ? <span className={cardStyles.metaSep}>·</span>
                  : null}
                {card.date
                  ? <span className={cardStyles.date}>{card.date}</span>
                  : null}
              </div>
            )}

            {/* Summary */}
            {card.summary && (
              <div className={cardStyles.summary}>
                {card.summary.length > 220
                  ? card.summary.slice(0, 220) + '…'
                  : card.summary}
              </div>
            )}
          </li>
        ))}
      </ul>

      {caption && (
        <div className={cardStyles.caption}>{caption}</div>
      )}
    </div>
  );
};

export default CardListBlock;
