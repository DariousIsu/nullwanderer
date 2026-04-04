/**
 * AURA NX-Alpha — Schedule
 *
 * Today's agenda at a glance. What's now, what's next.
 * No full calendar. Just the relevant window — today + tomorrow.
 *
 * VARIANT: work — agenda panel, frame recedes.
 *
 * EVENT SHAPE:
 * {
 *   id:       string,
 *   title:    string,
 *   time:     string,       — "15:00" or "15:00–16:00"
 *   day:      'today' | 'tomorrow',
 *   status:   'now' | 'soon' | 'later' | 'done',
 *   location?: string,
 * }
 */

import Panel from '../Panel/Panel';
import styles from './Schedule.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_LABEL = {
  now:   'NOW',
  soon:  'SOON',
  later: '',
  done:  'DONE',
};

// ─────────────────────────────────────────────────────────────────────────────
// EVENT ROW
// ─────────────────────────────────────────────────────────────────────────────

const EventRow = ({ event }) => (
  <div className={`${styles.event} ${styles[`event_${event.status}`]}`}>
    <div className={styles.eventTime}>{event.time}</div>
    <div className={styles.eventInfo}>
      <div className={styles.eventTitle}>{event.title}</div>
      {event.location && (
        <div className={styles.eventLocation}>{event.location}</div>
      )}
    </div>
    {STATUS_LABEL[event.status] && (
      <div className={`${styles.eventStatus} ${styles[`status_${event.status}`]}`}>
        {STATUS_LABEL[event.status]}
      </div>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// DAY SECTION
// ─────────────────────────────────────────────────────────────────────────────

const DaySection = ({ label, events }) => {
  if (events.length === 0) return null;
  return (
    <div className={styles.day}>
      <div className={styles.dayLabel}>{label}</div>
      {events.map(e => <EventRow key={e.id} event={e} />)}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SCHEDULE
// ─────────────────────────────────────────────────────────────────────────────

const Schedule = ({
  events    = [],
  dateLabel = '',
  isActive  = false,
  onPopOut,
}) => {
  const today    = events.filter(e => e.day === 'today');
  const tomorrow = events.filter(e => e.day === 'tomorrow');

  const upcomingCount = events.filter(e => e.status === 'now' || e.status === 'soon').length;

  const headerExtra = upcomingCount > 0 ? (
    <div className={styles.headerCount} data-urgent="true">
      {upcomingCount} soon
    </div>
  ) : null;

  const footer = dateLabel ? (
    <div className={styles.footer}>
      <span className={styles.footerDate}>{dateLabel}</span>
      <span className={styles.footerSync}>Synced</span>
    </div>
  ) : null;

  return (
    <Panel
      title="Schedule"
      variant="work"
      isActive={isActive}
      onPopOut={onPopOut}
      headerExtra={headerExtra}
      footer={footer}
      collapsible={true}
    >
      {events.length === 0 ? (
        <div className={styles.empty}>Nothing scheduled</div>
      ) : (
        <div className={styles.list}>
          <DaySection label="Today" events={today} />
          {today.length > 0 && tomorrow.length > 0 && (
            <div className={styles.daySep} aria-hidden="true" />
          )}
          <DaySection label="Tomorrow" events={tomorrow} />
        </div>
      )}
    </Panel>
  );
};

export default Schedule;
