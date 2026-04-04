/**
 * LegislationSidebar
 *
 * Left 220px column of the legislation panel.
 * Renders a search bar (cross-state when no state selected, scoped when one is)
 * and a scrollable list of states, each showing name + active session identifier.
 * Import progress banner anchored to the bottom when import is running.
 *
 * @param {object[]}    states         — array from GET /legislation/states
 * @param {object|null} selectedState  — currently selected state object
 * @param {function}    onSelectState  — (state) => void
 * @param {object|null} importStatus   — from GET /legislation/import/status
 * @param {string}      searchQuery    — controlled search input value
 * @param {function}    onSearch       — (query: string) => void
 */
import styles from './LegislationPanel.module.css';

// ── ICONS ────────────────────────────────────────────────────────────────────

const IconSearch = () => (
  <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true">
    <circle cx="4.8" cy="4.8" r="3.2" stroke="currentColor" strokeWidth="1.2"/>
    <path d="M7.3 7.3L9.5 9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);

const IconClear = () => (
  <svg width="9" height="9" viewBox="0 0 9 9" fill="none" aria-hidden="true">
    <path d="M2 2l5 5M7 2L2 7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
  </svg>
);

// ── COMPONENT ────────────────────────────────────────────────────────────────

export default function LegislationSidebar({
  states        = [],
  selectedState = null,
  onSelectState,
  importStatus  = null,
  searchQuery   = '',
  onSearch,
}) {
  const isImporting = importStatus?.running || importStatus?.progress?.running;

  return (
    <div className={styles.sidebar}>

      {/* ── SEARCH ── */}
      <div className={styles.sideSearch}>
        <div className={styles.searchWrap}>
          <span className={styles.searchIcon}><IconSearch /></span>
          <input
            type="text"
            className={styles.searchInput}
            placeholder={selectedState ? `Search ${selectedState.name}…` : 'Search all states…'}
            value={searchQuery}
            onChange={e => onSearch?.(e.target.value)}
            aria-label="Search legislation"
          />
          {searchQuery && (
            <button
              className={styles.searchClear}
              onClick={() => onSearch?.('')}
              aria-label="Clear search"
            >
              <IconClear />
            </button>
          )}
        </div>
      </div>

      {/* ── STATE LIST ── */}
      <div className={styles.sideLabel}>States</div>
      <div className={styles.stateList} role="list">
        {states.map(state => {
          const isActive = selectedState?.code === state.code;
          const session  = state.active_session?.identifier ?? state.session ?? '';
          return (
            <button
              key={state.code}
              role="listitem"
              className={[
                styles.stateItem,
                isActive && styles.stateItemActive,
              ].filter(Boolean).join(' ')}
              onClick={() => onSelectState?.(isActive ? null : state)}
              aria-pressed={isActive}
              aria-label={`${state.name}${session ? `, ${session}` : ''}`}
            >
              <span className={styles.stateName}>{state.name}</span>
              {session && (
                <span className={styles.stateSession}>{session}</span>
              )}
            </button>
          );
        })}

        {states.length === 0 && (
          <div className={styles.empty} style={{ padding: '24px 12px' }}>
            <div className={styles.emptyTitle} style={{ fontSize: '10px' }}>
              No states loaded
            </div>
          </div>
        )}
      </div>

      {/* ── IMPORT PROGRESS (bottom anchor) ── */}
      {isImporting && (
        <ImportProgress importStatus={importStatus} />
      )}

    </div>
  );
}

// Inline to avoid circular import — ImportProgress also imports from this module
function ImportProgress({ importStatus }) {
  const prog      = importStatus?.progress ?? {};
  const pct       = prog.pct       ?? 0;
  const completed = prog.completed ?? 0;
  const total     = prog.total     ?? 0;
  const zip       = prog.current_zip ? prog.current_zip.replace(/.*\//, '') : '';
  return (
    <div className={styles.importBanner}>
      <div className={styles.importLabel}>Importing legislation data</div>
      <div className={styles.importBar}>
        <div className={styles.importBarFill} style={{ width: `${pct}%` }} />
      </div>
      <div className={styles.importCount}>
        {completed}/{total} states{zip ? ` — ${zip}` : ''}
      </div>
    </div>
  );
}
