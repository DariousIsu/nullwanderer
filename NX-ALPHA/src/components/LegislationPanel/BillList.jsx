/**
 * BillList
 *
 * Scrollable list of bill cards in the main legislation panel area.
 * Each card shows: identifier (bold) + title (2-line clamp) + status badge + last action date.
 *
 * @param {object[]}    bills           — bill array from useLegislation
 * @param {string|null} selectedBillId  — id of the currently selected bill
 * @param {function}    onSelectBill    — (bill) => void
 */
import styles from './LegislationPanel.module.css';

// ── STATUS BADGE ─────────────────────────────────────────────────────────────

const STATUS_CLASS = {
  active:  styles.badgeActive,
  pending: styles.badgePending,
  passed:  styles.badgePassed,
  dropped: styles.badgeDropped,
};

function StatusBadge({ status }) {
  return (
    <span className={[styles.billStatusBadge, STATUS_CLASS[status] ?? styles.badgeUnknown].join(' ')}>
      {status ?? 'unknown'}
    </span>
  );
}

// ── BILL CARD ─────────────────────────────────────────────────────────────────

function BillCard({ bill, isSelected, onClick }) {
  // last_action_date may be a full ISO string or YYYY-MM-DD
  const dateStr = bill.last_action_date
    ? new Date(bill.last_action_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
    : '';

  return (
    <button
      className={[
        styles.billCard,
        isSelected && styles.billCardSelected,
      ].filter(Boolean).join(' ')}
      onClick={() => onClick(bill)}
      aria-pressed={isSelected}
      aria-label={`${bill.identifier}: ${bill.title}`}
      title={bill.title}
    >
      <div className={styles.billTop}>
        <span className={styles.billId}>{bill.identifier}</span>
        <span className={styles.billTitle}>{bill.title}</span>
      </div>
      <div className={styles.billFooter}>
        <StatusBadge status={bill.status} />
        {dateStr && <span className={styles.billDate}>{dateStr}</span>}
      </div>
    </button>
  );
}

// ── BILL LIST ─────────────────────────────────────────────────────────────────

export default function BillList({ bills = [], selectedBillId = null, onSelectBill }) {
  if (bills.length === 0) {
    return (
      <div className={styles.empty}>
        <div className={styles.emptyIcon} aria-hidden="true">◌</div>
        <p className={styles.emptyTitle}>No bills</p>
        <p className={styles.emptySub}>Try a different filter or select another state</p>
      </div>
    );
  }

  return (
    <>
      <div className={styles.billCount}>
        {bills.length} bill{bills.length !== 1 ? 's' : ''}
      </div>
      <div className={styles.billList} role="list">
        {bills.map(bill => (
          <BillCard
            key={bill.id}
            bill={bill}
            isSelected={bill.id === selectedBillId}
            onClick={onSelectBill}
          />
        ))}
      </div>
    </>
  );
}
