/**
 * AURA NX-Alpha — ConversationsPanel
 *
 * Thread history browser. Mounted inside DropPanel when id='conversations'.
 * Fills the DropPanel body area (below the shared header).
 *
 * LAYOUT:
 *   Two-column, matching the DropPanel body pattern:
 *   ┌──────────────┬─────────────────────────────────────────┐
 *   │  FILTER NAV  │  [ Search jobs...                    ]  │
 *   │  ─────────── │  ──────────────────────────────────────  │
 *   │  All Jobs    │  Job Title                    2h ago    │
 *   │  Today       │  Task directive preview...     [24]    │
 *   │  Yesterday   │  ──────────────────────────────────────  │
 *   │  This Week   │  ...                                    │
 *   │  Older       │                                         │
 *   │  ─────────── │  [empty state if filtered/empty]        │
 *   │  ⭐ Starred  │                                         │
 *   └──────────────┴─────────────────────────────────────────┘
 *
 * MODEL:
 *   The main conversation with Aura is perpetual — it uses a memory system
 *   to manage its context window. This panel surfaces *jobs dispatched to
 *   the agent team*, not discrete chat sessions. Each row is a task that
 *   was sent to the team: title derived from the directive, preview shows
 *   the opening message, messageCount reflects team activity on that job.
 *
 * PROPS:
 *   conversations — array of job objects (see JOB_SHAPE below)
 *   onRestore     — (id: string) => void — called when user clicks a row
 *
 * JOB_SHAPE:
 *   {
 *     id:           string,
 *     title:        string,        // Derived from the task directive
 *     preview:      string,        // Opening directive text (full, component truncates)
 *     timestamp:    string | Date, // ISO string or Date — when job was dispatched
 *     messageCount: number,        // Agent team message count for this job
 *     isActive:     boolean,       // Currently loaded / in-progress
 *     isStarred:    boolean,
 *   }
 *
 * FILTERING:
 *   Left nav drives time-bucket filter (all/today/yesterday/week/older/starred).
 *   Search bar does substring match on title + preview.
 *   Both filters applied together (AND).
 *
 * RESTORE:
 *   Clicking any row calls onRestore(id).
 *   CommandCenter restores that job context into the chat sidebar
 *   (full SSE/persistence wiring in later sprint).
 */

import { useState, useMemo } from 'react';
import styles from './ConversationsPanel.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// TIME UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function getTimeBucket(ts) {
  if (!ts) return 'older';
  const d   = new Date(ts);
  const now = new Date();
  // Compare calendar days (not rolling 24h windows)
  const todayStart     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart - 86400000);
  const weekStart      = new Date(todayStart - 6 * 86400000);
  if (d >= todayStart)     return 'today';
  if (d >= yesterdayStart) return 'yesterday';
  if (d >= weekStart)      return 'week';
  return 'older';
}

function formatTimestamp(ts) {
  if (!ts) return '';
  const d    = new Date(ts);
  const now  = new Date();
  const diff = now - d;                    // ms
  const mins = Math.floor(diff / 60000);
  if (mins < 1)   return 'Just now';
  if (mins < 60)  return `${mins}m ago`;
  const hours = Math.floor(diff / 3600000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(diff / 86400000);
  if (days === 1) return 'Yesterday';
  if (days < 7)  return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─────────────────────────────────────────────────────────────────────────────
// FILTER CATEGORIES — left sidebar nav
// ─────────────────────────────────────────────────────────────────────────────

const FILTERS = [
  { id: 'all',       label: 'All Jobs',     bucket: null },
  null, // ─── divider ───
  { id: 'today',     label: 'Today',        bucket: 'today'     },
  { id: 'yesterday', label: 'Yesterday',    bucket: 'yesterday' },
  { id: 'week',      label: 'This Week',    bucket: 'week'      },
  { id: 'older',     label: 'Older',        bucket: 'older'     },
  null, // ─── divider ───
  { id: 'starred',   label: '★  Starred',   bucket: null, starred: true },
];

// ─────────────────────────────────────────────────────────────────────────────
// ICONS
// ─────────────────────────────────────────────────────────────────────────────

const IconSearch = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <circle cx="5" cy="5" r="3.5" stroke="currentColor" strokeWidth="1.2"/>
    <path d="M7.8 7.8L10 10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);

const IconClear = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// THREAD ROW
// ─────────────────────────────────────────────────────────────────────────────

const ThreadRow = ({ thread, onClick }) => {
  const timestamp = formatTimestamp(thread.timestamp);

  return (
    <button
      className={[
        styles.row,
        thread.isActive && styles.rowActive,
      ].filter(Boolean).join(' ')}
      onClick={() => onClick(thread.id)}
      aria-label={`Load job: ${thread.title}`}
      title={thread.title}
    >
      {/* Active indicator bar — left edge */}
      {thread.isActive && <div className={styles.rowBar} aria-hidden="true" />}

      {/* Content */}
      <div className={styles.rowContent}>
        <div className={styles.rowHeader}>
          <span className={styles.rowTitle}>{thread.title}</span>
          <div className={styles.rowMeta}>
            {thread.isActive && (
              <span className={styles.activeBadge} aria-label="Currently active">ACTIVE</span>
            )}
            {thread.isStarred && (
              <span className={styles.starBadge} aria-hidden="true">★</span>
            )}
            <span className={styles.timestamp}>{timestamp}</span>
          </div>
        </div>

        <div className={styles.rowFooter}>
          <span className={styles.preview}>{thread.preview}</span>
          <span className={styles.msgCount} aria-label={`${thread.messageCount} messages`}>
            {thread.messageCount}
          </span>
        </div>
      </div>
    </button>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// EMPTY STATE
// ─────────────────────────────────────────────────────────────────────────────

const EmptyState = ({ isFiltered, onClear }) => (
  <div className={styles.empty}>
    <div className={styles.emptyIcon} aria-hidden="true">◌</div>
    <p className={styles.emptyTitle}>
      {isFiltered ? 'No matches' : 'No jobs yet'}
    </p>
    <p className={styles.emptySub}>
      {isFiltered
        ? 'Try a different filter or search term'
        : 'Jobs dispatched to the agent team will appear here'}
    </p>
    {isFiltered && (
      <button className={styles.clearBtn} onClick={onClear}>
        Clear filters
      </button>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATIONS PANEL
// ─────────────────────────────────────────────────────────────────────────────

const ConversationsPanel = ({
  conversations = [],
  onRestore,
}) => {
  const [activeFilter, setActiveFilter] = useState('all');
  const [searchQuery,  setSearchQuery]  = useState('');

  // ── FILTERED + SEARCHED LIST ──
  const filtered = useMemo(() => {
    let list = conversations;

    // Apply time-bucket or starred filter
    if (activeFilter !== 'all') {
      const filterDef = FILTERS.find(f => f?.id === activeFilter);
      if (filterDef?.starred) {
        list = list.filter(c => c.isStarred);
      } else if (filterDef?.bucket) {
        list = list.filter(c => getTimeBucket(c.timestamp) === filterDef.bucket);
      }
    }

    // Apply search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(c =>
        c.title?.toLowerCase().includes(q) ||
        c.preview?.toLowerCase().includes(q)
      );
    }

    // Sort: active thread first, then by timestamp descending
    return [...list].sort((a, b) => {
      if (a.isActive && !b.isActive) return -1;
      if (!a.isActive && b.isActive) return 1;
      return new Date(b.timestamp) - new Date(a.timestamp);
    });
  }, [conversations, activeFilter, searchQuery]);

  const isFiltered = activeFilter !== 'all' || searchQuery.trim().length > 0;
  const isEmpty    = filtered.length === 0;

  const handleClearFilters = () => {
    setActiveFilter('all');
    setSearchQuery('');
  };

  return (
    <div className={styles.panel}>

      {/* ── LEFT SIDEBAR — filter nav ── */}
      <div className={styles.side}>
        <div className={styles.sideLabel}>Filter</div>

        {FILTERS.map((item, i) => {
          if (item === null) {
            return <div key={`div-${i}`} className={styles.sideDivider} aria-hidden="true" />;
          }
          const isActive = activeFilter === item.id;
          // Count for this filter bucket (live)
          let count = 0;
          if (item.starred) {
            count = conversations.filter(c => c.isStarred).length;
          } else if (item.bucket) {
            count = conversations.filter(c => getTimeBucket(c.timestamp) === item.bucket).length;
          } else {
            count = conversations.length; // 'all'
          }

          return (
            <button
              key={item.id}
              className={[
                styles.sideItem,
                isActive && styles.sideItemActive,
              ].filter(Boolean).join(' ')}
              onClick={() => setActiveFilter(item.id)}
              aria-pressed={isActive}
            >
              <span className={styles.sideItemLabel}>{item.label}</span>
              {count > 0 && (
                <span className={[styles.sideCount, isActive && styles.sideCountActive].filter(Boolean).join(' ')}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── MAIN CONTENT ── */}
      <div className={styles.main}>

        {/* Toolbar: search */}
        <div className={styles.toolbar}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}><IconSearch /></span>
            <input
              type="text"
              className={styles.searchInput}
              placeholder="Search jobs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search job history"
            />
            {searchQuery && (
              <button
                className={styles.searchClear}
                onClick={() => setSearchQuery('')}
                aria-label="Clear search"
              >
                <IconClear />
              </button>
            )}
          </div>
        </div>

        {/* Thread count label */}
        {!isEmpty && (
          <div className={styles.countRow}>
            <span className={styles.countLabel}>
              {filtered.length === conversations.length
                ? `${conversations.length} job${conversations.length !== 1 ? 's' : ''}`
                : `${filtered.length} of ${conversations.length}`
              }
            </span>
            {isFiltered && (
              <button className={styles.clearLink} onClick={handleClearFilters}>
                Clear
              </button>
            )}
          </div>
        )}

        {/* Thread list or empty state */}
        {isEmpty ? (
          <EmptyState isFiltered={isFiltered} onClear={handleClearFilters} />
        ) : (
          <div className={styles.list} role="list">
            {filtered.map((thread) => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                onClick={(id) => onRestore?.(id)}
              />
            ))}
          </div>
        )}
      </div>

    </div>
  );
};

export default ConversationsPanel;
