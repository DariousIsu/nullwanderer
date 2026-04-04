/**
 * AURA NX-Alpha — AppBar
 *
 * Horizontal service tab bar. Sits between TitleBar and workspace.
 * Each tab toggles a full-canvas drop panel (slides down to cover the work surface).
 *
 * TABS:
 *   News · Weather · Finance · Calendar · Mail · Comms · Conversations  ·  [ spacer ]  · Settings
 *
 * BEHAVIOR:
 *   Click tab    → activeDrop changes → DropPanel slides down over canvas
 *   Click again  → panel closes
 *   Active tab   → amber underline accent + amber tint background
 *
 * ICONS:
 *   Small inline SVGs — purpose-built, no icon library dependency.
 */

import styles from './AppBar.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// TAB ICONS
// ─────────────────────────────────────────────────────────────────────────────

const IconNews     = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><rect x="1" y="1" width="9" height="2" rx=".5" stroke="currentColor" strokeWidth="1.1"/><rect x="1" y="4.5" width="5" height="1.2" rx=".5" fill="currentColor"/><rect x="1" y="6.5" width="7" height="1.2" rx=".5" fill="currentColor"/><rect x="1" y="8.5" width="4" height="1.2" rx=".5" fill="currentColor"/></svg>;
const IconWeather  = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5.5" cy="4" r="2" stroke="currentColor" strokeWidth="1.1"/><path d="M2 8.5h7c0-1.5-1-2.5-3.5-2.5S2 7 2 8.5Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>;
const IconFinance  = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1 8l2.5-3 2 2 2.5-4L10 5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/><path d="M1 10h9" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".5"/></svg>;
const IconCalendar = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><rect x="1" y="2" width="9" height="8" rx="1" stroke="currentColor" strokeWidth="1.1"/><path d="M1 5h9" stroke="currentColor" strokeWidth="1" opacity=".5"/><path d="M4 1v2M7 1v2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>;
const IconMail     = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><rect x="1" y="2.5" width="9" height="6" rx="1" stroke="currentColor" strokeWidth="1.1"/><path d="M1 3.5l4.5 3 4.5-3" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/></svg>;
const IconComms    = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M1 1.5h9v6H7l-1.5 2-1.5-2H1z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round"/><path d="M3 4h5M3 6h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".7"/></svg>;
const IconSettings      = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.1"/><path d="M5.5 1v1.2M5.5 8.8V10M1 5.5h1.2M8.8 5.5H10M2.1 2.1l.85.85M8.05 8.05l.85.85M2.1 8.9l.85-.85M8.05 2.95l.85-.85" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/></svg>;
/* Two-way arrows loop — "adversarial trainer" semantic */
const IconTrainer       = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M2 3.5h7M7 2l2 1.5L7 5" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/><path d="M9 7.5H2M4 6l-2 1.5L4 9" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>;
/* Clock face — "history" semantic. Hour/minute hands frozen at approx 10:10. */
const IconConversations = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.1"/><path d="M5.5 3.2v2.5l1.6 1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>;
/* Cron clock + checkmark — "schedule" semantic */
const IconSchedule     = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5" cy="6" r="3.5" stroke="currentColor" strokeWidth="1.1"/><path d="M5 4.2V6l1 1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 2l1.5 1M8 2L6.5 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".6"/></svg>;
/* Hub-and-spoke — "satellite network" semantic */
const IconSatellites   = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.1"/><circle cx="1.5" cy="1.5" r="1" stroke="currentColor" strokeWidth="1"/><circle cx="9.5" cy="1.5" r="1" stroke="currentColor" strokeWidth="1"/><circle cx="1.5" cy="9.5" r="1" stroke="currentColor" strokeWidth="1"/><circle cx="9.5" cy="9.5" r="1" stroke="currentColor" strokeWidth="1"/><path d="M2.2 2.2l2.6 2.6M8.8 2.2L6.2 4.8M2.2 8.8l2.6-2.6M8.8 8.8L6.2 6.2" stroke="currentColor" strokeWidth=".9" opacity=".6"/></svg>;
/* Circuit / node graph — "agent creator" semantic */
const IconAgents       = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="2" cy="5.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/><circle cx="5.5" cy="2" r="1.2" stroke="currentColor" strokeWidth="1.1"/><circle cx="9" cy="5.5" r="1.2" stroke="currentColor" strokeWidth="1.1"/><circle cx="5.5" cy="9" r="1.2" stroke="currentColor" strokeWidth="1.1"/><circle cx="5.5" cy="5.5" r="1" fill="currentColor" opacity=".6"/><path d="M3.2 5.5h1.1M6.7 5.5h1.1M5.5 3.2v1.1M5.5 6.7v1.1" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".7"/></svg>;
/* Gavel — "legislation" semantic */
const IconLegislation  = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><rect x="1" y="3" width="5.5" height="2.8" rx=".5" stroke="currentColor" strokeWidth="1.1"/><path d="M6 4.4L9.5 8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/><path d="M1 8.5H5.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".5"/></svg>;
/* Antenna/signal — "station" broadcast semantic */
const IconStation      = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5.5" cy="5.5" r="1.2" fill="currentColor"/><path d="M3.2 3.2a3.3 3.3 0 0 0 0 4.6M7.8 3.2a3.3 3.3 0 0 1 0 4.6" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><path d="M1.8 1.8a5.2 5.2 0 0 0 0 7.4M9.2 1.8a5.2 5.2 0 0 1 0 7.4" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".45"/></svg>;
/* Globe/grid — "geospatial" semantic */
const IconGeo          = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5.5" cy="5.5" r="4" stroke="currentColor" strokeWidth="1.1"/><path d="M5.5 1.5c-1.2 1.2-2 2.4-2 4s.8 2.8 2 4M5.5 1.5c1.2 1.2 2 2.4 2 4s-.8 2.8-2 4" stroke="currentColor" strokeWidth=".9" opacity=".7"/><path d="M1.5 5.5h8" stroke="currentColor" strokeWidth=".9" opacity=".7"/><path d="M2 3.5h7M2 7.5h7" stroke="currentColor" strokeWidth=".8" opacity=".45"/></svg>;
/* Wrench + circuit — "tool workspace" semantic */
const IconToolWorkspace = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><rect x="1" y="4" width="4" height="3" rx=".5" stroke="currentColor" strokeWidth="1.1"/><rect x="6" y="4" width="4" height="3" rx=".5" stroke="currentColor" strokeWidth="1.1"/><path d="M5 5.5h1" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round"/><path d="M3 4V2.5M8 4V2.5M3 7v1.5M8 7v1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity=".6"/></svg>;
/* Synaptic cluster — 3 nodes + connecting arcs — "neural interface" semantic */
const IconNeural = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><circle cx="5.5" cy="2" r="1" stroke="currentColor" strokeWidth="1.1"/><circle cx="2" cy="8.5" r="1" stroke="currentColor" strokeWidth="1.1"/><circle cx="9" cy="8.5" r="1" stroke="currentColor" strokeWidth="1.1"/><path d="M5.5 3c0 2-1.8 3-3.5 4M5.5 3c0 2 1.8 3 3.5 4M2.5 8h6" stroke="currentColor" strokeWidth=".9" strokeLinecap="round" opacity=".7"/></svg>;
/* Code brackets — "dev studio" semantic */
const IconDev = () => <svg width="11" height="11" viewBox="0 0 11 11" fill="none" aria-hidden="true"><path d="M3.5 3L1 5.5L3.5 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/><path d="M7.5 3L10 5.5L7.5 8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round"/></svg>;

// ─────────────────────────────────────────────────────────────────────────────
// TAB DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

const SERVICE_TABS = [
  { id: 'news',          label: 'News',          Icon: IconNews          },
  { id: 'weather',       label: 'Weather',       Icon: IconWeather       },
  { id: 'finance',       label: 'Finance',       Icon: IconFinance       },
  { id: 'calendar',      label: 'Calendar',      Icon: IconCalendar      },
  { id: 'mail',          label: 'Mail',          Icon: IconMail          },
  { id: 'comms',         label: 'Comms',         Icon: IconComms         },
  { id: 'conversations', label: 'Conversations', Icon: IconConversations },
  { id: 'schedule',      label: 'Schedule',      Icon: IconSchedule      },
  { id: 'satellites',    label: 'Satellites',    Icon: IconSatellites    },
  { id: 'trainer',       label: 'Trainer',       Icon: IconTrainer       },
  { id: 'agents',        label: 'Agents',        Icon: IconAgents        },
  { id: 'legislation',  label: 'Legislation',  Icon: IconLegislation  },
  { id: 'geo',            label: 'Geo Intel',     Icon: IconGeo           },
  { id: 'station',       label: 'Station',       Icon: IconStation       },
  { id: 'tool-workspace',    label: 'Tool Dev',  Icon: IconToolWorkspace },
  { id: 'neural-interface', label: 'Neural',     Icon: IconNeural        },
  { id: 'devpanel',         label: 'Dev',        Icon: IconDev           },
];

// ─────────────────────────────────────────────────────────────────────────────
// APP BAR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string|null} activeDrop    — Currently open drop panel id, or null
 * @param {string}      financeState  — Finance 3-state: 'closed'|'open'|'ticker'
 * @param {string}      intelState    — Intel 3-state: 'closed'|'open'|'ticker'
 * @param {function}    onTabClick    — (id: string) => void — called with tab id
 */
const AppBar = ({ activeDrop = null, financeState = 'closed', intelState = 'closed', onTabClick }) => (
  <div className={styles.bar} role="toolbar" aria-label="Service panels">

    {/* ── SERVICE TABS — scrollable so additional tabs never overflow ── */}
    <div className={styles.tabsScroll}>
      {SERVICE_TABS.map(({ id, label, Icon }) => {
        // Finance & Intel tabs are active in both 'open' and 'ticker' states
        const isActive = id === 'finance'
          ? (financeState === 'open' || financeState === 'ticker')
          : id === 'news'
          ? (intelState === 'open' || intelState === 'ticker')
          : activeDrop === id;
        return (
          <button
            key={id}
            className={[styles.tab, isActive && styles.tabActive].filter(Boolean).join(' ')}
            onClick={() => onTabClick?.(id)}
            aria-pressed={isActive}
            aria-label={`${isActive ? 'Close' : 'Open'} ${label} panel`}
          >
            <Icon />
            <span>{label}</span>
          </button>
        );
      })}
    </div>

    {/* ── SETTINGS — right-aligned ── */}
    <button
      className={[styles.tab, activeDrop === 'settings' && styles.tabActive].filter(Boolean).join(' ')}
      onClick={() => onTabClick?.('settings')}
      aria-pressed={activeDrop === 'settings'}
      aria-label={`${activeDrop === 'settings' ? 'Close' : 'Open'} Settings panel`}
    >
      <IconSettings />
      <span>Settings</span>
    </button>

  </div>
);

export default AppBar;
