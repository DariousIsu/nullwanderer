/**
 * AURA NX-Alpha — CalendarPanel
 *
 * Agenda-first calendar view. Week strip + event list for the current window.
 * Replaces stub in DropPanel for the 'calendar' service.
 * Real events come from Google Calendar / other integrations during reconciliation.
 *
 * EVENT SHAPE:
 * {
 *   id:       string,
 *   title:    string,
 *   time:     string,       — "09:00", "14:30–15:30", "All day"
 *   day:      string,       — ISO date string "2026-03-26"
 *   status:   'now' | 'soon' | 'later' | 'done',
 *   type:     'meeting' | 'deadline' | 'personal' | 'block',
 *   location: string | null,
 *   attendees: number | null,
 * }
 */

import { useState, useEffect } from 'react';
import styles from './CalendarPanel.module.css';
import { useCalendar } from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function getWeekDays(anchor = new Date()) {
  // Build a Mon–Sun strip centred around the current week
  const day = anchor.getDay(); // 0=Sun … 6=Sat
  const monday = new Date(anchor);
  monday.setDate(anchor.getDate() - ((day === 0 ? 7 : day) - 1));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

const today = new Date();
const todayStr = isoDate(today);

// ─────────────────────────────────────────────────────────────────────────────
// DEMO DATA
// ─────────────────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'week',     label: 'This Week' },
  { id: 'month',    label: 'This Month' },
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'tasks',    label: 'Tasks' },
  { id: 'deadlines',label: 'Deadlines' },
];

// Compute relative dates for the demo
const d = (offset) => {
  const dt = new Date(today);
  dt.setDate(today.getDate() + offset);
  return isoDate(dt);
};

const DEMO_EVENTS = [
  {
    id: 'e1',
    title: 'Q1 Review — Leadership Sync',
    time: '09:00–10:00',
    day: todayStr,
    status: 'done',
    type: 'meeting',
    location: 'Zoom',
    attendees: 8,
  },
  {
    id: 'e2',
    title: 'Engineering Stand-up',
    time: '10:30–10:45',
    day: todayStr,
    status: 'now',
    type: 'meeting',
    location: 'Meet',
    attendees: 6,
  },
  {
    id: 'e3',
    title: 'Deep Work Block — NX-Alpha Build',
    time: '11:00–13:00',
    day: todayStr,
    status: 'soon',
    type: 'block',
    location: null,
    attendees: null,
  },
  {
    id: 'e4',
    title: 'Lunch — 1:1 with Jordan',
    time: '13:00–14:00',
    day: todayStr,
    status: 'later',
    type: 'personal',
    location: 'Blue Bottle',
    attendees: 2,
  },
  {
    id: 'e5',
    title: 'Vendor Demo — Datadog',
    time: '15:00–15:45',
    day: todayStr,
    status: 'later',
    type: 'meeting',
    location: 'Zoom',
    attendees: 4,
  },
  {
    id: 'e6',
    title: 'Acme Corp Contract — Review Deadline',
    time: '17:00',
    day: todayStr,
    status: 'later',
    type: 'deadline',
    location: null,
    attendees: null,
  },
  {
    id: 'e7',
    title: 'Investor Update Prep',
    time: '09:00–11:00',
    day: d(1),
    status: 'later',
    type: 'block',
    location: null,
    attendees: null,
  },
  {
    id: 'e8',
    title: 'Product Strategy — Board Prep',
    time: '14:00–15:30',
    day: d(1),
    status: 'later',
    type: 'meeting',
    location: 'HQ Conf Room A',
    attendees: 5,
  },
  {
    id: 'e9',
    title: 'Team Retro',
    time: '16:00–17:00',
    day: d(2),
    status: 'later',
    type: 'meeting',
    location: 'Meet',
    attendees: 12,
  },
  {
    id: 'e10',
    title: 'Board Meeting',
    time: '10:00–13:00',
    day: d(3),
    status: 'later',
    type: 'meeting',
    location: 'HQ Board Room',
    attendees: 9,
  },
];

const STATUS_LABELS = {
  now:   'NOW',
  soon:  'SOON',
  later: null,
  done:  'DONE',
};

const TYPE_ICONS = {
  meeting:  '○',
  deadline: '◆',
  personal: '◇',
  block:    '▬',
};

// ─────────────────────────────────────────────────────────────────────────────
// WEEK STRIP
// ─────────────────────────────────────────────────────────────────────────────

const WeekStrip = ({ weekDays, selectedDay, onSelect, events }) => {
  const eventCountByDay = events.reduce((acc, e) => {
    acc[e.day] = (acc[e.day] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className={styles.weekStrip}>
      {weekDays.map(day => {
        const iso   = isoDate(day);
        const isToday = iso === todayStr;
        const count = eventCountByDay[iso] ?? 0;
        const isSelected = iso === selectedDay;
        return (
          <button
            key={iso}
            className={[
              styles.dayCell,
              isToday    && styles.dayCellToday,
              isSelected && styles.dayCellSelected,
            ].filter(Boolean).join(' ')}
            onClick={() => onSelect(iso)}
            aria-label={`${DAY_NAMES[day.getDay()]} ${day.getDate()} ${MONTH_NAMES[day.getMonth()]}`}
            aria-pressed={isSelected}
          >
            <span className={styles.dayName}>{DAY_NAMES[day.getDay()]}</span>
            <span className={styles.dayNum}>{day.getDate()}</span>
            {count > 0 && (
              <div className={styles.dayDots} aria-hidden="true">
                {Array.from({ length: Math.min(count, 3) }).map((_, i) => (
                  <span key={i} className={styles.dayDot} />
                ))}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// EVENT ROW
// ─────────────────────────────────────────────────────────────────────────────

const EventRow = ({ event }) => {
  const statusLabel = STATUS_LABELS[event.status];
  return (
    <div className={`${styles.event} ${styles[`event_${event.status}`]} ${styles[`eventType_${event.type}`]}`}>
      <div className={styles.eventLeft}>
        <span className={styles.eventTypeIcon} aria-hidden="true">{TYPE_ICONS[event.type]}</span>
        <span className={styles.eventTime}>{event.time}</span>
      </div>
      <div className={styles.eventInfo}>
        <div className={styles.eventTitle}>{event.title}</div>
        <div className={styles.eventMeta}>
          {event.location && <span className={styles.eventLocation}>{event.location}</span>}
          {event.attendees != null && (
            <span className={styles.eventAttendees}>
              {event.attendees} {event.attendees === 1 ? 'person' : 'people'}
            </span>
          )}
        </div>
      </div>
      {statusLabel && (
        <span className={`${styles.eventBadge} ${styles[`badge_${event.status}`]}`}>
          {statusLabel}
        </span>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR PANEL
// ─────────────────────────────────────────────────────────────────────────────

const CalendarPanel = ({ events: propEvents } = {}) => {
  const [activeSection, setActiveSection] = useState('week');
  const [selectedDay, setSelectedDay]     = useState(todayStr);
  const weekDays = getWeekDays(today);
  const { data: calData } = useCalendar(300000);

  // Map backend events to component shape
  const liveEvents = calData?.events
    ? calData.events.map(e => {
        const start = e.start ? new Date(e.start) : null;
        const end   = e.end   ? new Date(e.end)   : null;
        const timeStr = start
          ? (end
            ? `${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}–${end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
            : start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }))
          : 'All day';
        const dayStr = start ? isoDate(start) : todayStr;
        const now = new Date();
        const status = end && end < now ? 'done'
          : start && start <= now && end && now <= end ? 'now'
          : start && start > now && (start - now) < 3600000 ? 'soon'
          : 'later';
        return {
          id:        e.id,
          title:     e.summary || '(no title)',
          time:      timeStr,
          day:       dayStr,
          status,
          type:      'meeting',
          location:  e.location || null,
          attendees: e.attendees || null,
        };
      })
    : null;

  const events = propEvents ?? liveEvents ?? DEMO_EVENTS;

  // Filter events for selected day when in week view, otherwise show all
  const displayedEvents = activeSection === 'week'
    ? events.filter(e => e.day === selectedDay)
    : events;

  const selectedDate  = new Date(selectedDay + 'T00:00:00');
  const selectedLabel = selectedDay === todayStr
    ? 'Today'
    : `${DAY_NAMES[selectedDate.getDay()]}, ${MONTH_NAMES[selectedDate.getMonth()]} ${selectedDate.getDate()}`;

  return (
    <div className={styles.root}>

      {/* ── SIDEBAR ── */}
      <div className={styles.side}>
        <div className={styles.sideLabel}>View</div>
        {SECTIONS.map(sec => (
          <button
            key={sec.id}
            className={[
              styles.sideItem,
              activeSection === sec.id && styles.sideItemActive,
            ].filter(Boolean).join(' ')}
            onClick={() => setActiveSection(sec.id)}
            aria-pressed={activeSection === sec.id}
          >
            <span className={styles.sideDot} aria-hidden="true" />
            {sec.label}
          </button>
        ))}

        <div className={styles.sideSep} aria-hidden="true" />
        <div className={styles.sideLabel}>Today</div>
        <div className={styles.sideDate}>
          <span className={styles.sideDateNum}>{today.getDate()}</span>
          <span className={styles.sideDateMon}>{MONTH_NAMES[today.getMonth()]}</span>
        </div>
        <div className={styles.sideEventCount}>
          {events.filter(e => e.day === todayStr).length} events
        </div>
      </div>

      {/* ── MAIN ── */}
      <div className={styles.main}>

        {activeSection === 'week' && (
          <WeekStrip
            weekDays={weekDays}
            selectedDay={selectedDay}
            onSelect={setSelectedDay}
            events={events}
          />
        )}

        {/* Day header */}
        <div className={styles.dayHeader}>
          <span className={styles.dayHeaderLabel}>{selectedLabel}</span>
          <span className={styles.dayHeaderCount}>
            {displayedEvents.length} event{displayedEvents.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Event list */}
        <div className={styles.eventList}>
          {displayedEvents.length === 0 ? (
            <div className={styles.empty}>Nothing scheduled</div>
          ) : (
            displayedEvents.map(e => <EventRow key={e.id} event={e} />)
          )}
        </div>

      </div>

    </div>
  );
};

export default CalendarPanel;
