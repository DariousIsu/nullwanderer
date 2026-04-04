/**
 * AURA NX-Alpha — DropPanel
 *
 * Full-canvas service overlay panel. Slides down from the top of the canvas
 * when an AppBar tab is activated. Covers the canvas and floating panels.
 *
 * VARIANTS (by service id):
 *   news · weather · finance · calendar · mail · comms · settings
 *
 * ANIMATION:
 *   Closed: translateY(-102%) — hidden above the canvas top edge
 *   Open:   translateY(0)     — fills the canvas
 *   CSS transition: 220ms cubic-bezier(.4,0,.2,1)
 *   visibility toggled with 0s delay (open) / 220ms delay (close)
 *   so it's removed from accessibility tree when fully hidden.
 *
 * Z-INDEX: 110 — above floating panels (20–80) but below peek stack (250)
 * and below TitleBar/AppBar (150+).
 *
 * LAYOUT (inside each panel):
 *   Two-column: 220px left sidebar (source/filter nav) + flex:1 main content area.
 *
 * CONTENT:
 *   Currently stub content for each service. Real data integrations are future work.
 *   The architecture (props, animation, layout) is fully wired.
 *
 * POP-OUT:
 *   onPopOut(id) → parent opens in Electron BrowserWindow.
 */

import { useRef, useEffect } from 'react';
import {
  animateDropPanelOpen,
  animateDropPanelClose,
} from '../../core/animations';
import SettingsPanel       from '../SettingsPanel/SettingsPanel';
import ConversationsPanel  from '../ConversationsPanel/ConversationsPanel';
import NewsPanel           from '../NewsPanel/NewsPanel';
import FinancePanel        from '../FinancePanel/FinancePanel';
import CalendarPanel       from '../CalendarPanel/CalendarPanel';
import MailPanel           from '../MailPanel/MailPanel';
import CommsPanel          from '../CommsPanel/CommsPanel';
import WeatherPanel        from '../WeatherPanel/WeatherPanel';
import SchedulePanel       from '../SchedulePanel/SchedulePanel';
import SatellitePanel      from '../SatellitePanel/SatellitePanel';
import AdversarialTrainerPanel from '../AdversarialTrainerPanel/AdversarialTrainerPanel';
import AgentCreatorPanel  from '../AgentCreatorPanel/AgentCreatorPanel';
import LegislationPanel   from '../LegislationPanel/LegislationPanel';
import GeoPanel           from '../GeoPanel/GeoPanel';
import StationPanel       from '../StationPanel/StationPanel';
import ToolWorkspacePanel   from '../ToolWorkspacePanel/ToolWorkspacePanel';
import DevPanel              from '../DevPanel/DevPanel';
import NeuralInterfacePanel  from '../NeuralInterfacePanel/NeuralInterfacePanel';
import styles from './DropPanel.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// PANEL CONTENT — one entry per service id
// ─────────────────────────────────────────────────────────────────────────────

const PANEL_TITLES = {
  news:          'Intel Feed',
  weather:       'Weather',
  finance:       'Markets',
  calendar:      'Calendar',
  mail:          'Mail',
  comms:         'Communications',
  conversations: 'Conversations',
  schedule:      'Scheduled Tasks',
  satellites:    'Satellite Network',
  settings:      'Settings',
  trainer:       'Trainer',
  agents:        'Agent Creator',
  legislation:   'Legislation',
  geo:           'Geo Intel',
  station:          'Station',
  'tool-workspace':   'Tool Developer',
  'neural-interface': 'Neural Interface',
  'devpanel':       'Dev Studio',
};

const PANEL_TAGS = {
  news:          'News · Analysis · Markets',
  weather:       'Current · Forecast · Alerts',
  finance:       'Equities · Crypto · Forex',
  calendar:      'Schedule · Events · Tasks',
  mail:          'Inbox · Drafts · Sent',
  comms:         'Discord · Slack · Messenger',
  conversations: 'Jobs · Dispatches · History',
  schedule:      'Tasks · Digests · Automation',
  satellites:    'Network · Provision · Governor',
  settings:      'System · Integrations · Preferences',
  trainer:       'Dataset · Evaluate · Improve',
  agents:        'Build · Publish · Run',
  legislation:   'Bills · Sessions · Analysis',
  geo:           'Map · Satellites · Street View',
  station:          'Browse · Transcribe · Monitor',
  'tool-workspace':   'Build · Train · Publish',
  'neural-interface': 'Memory · Graph · Control',
  'devpanel':       'Workhorse · Projects · Build',
};

/** Stub left sidebar items per service */
const SIDEBAR_ITEMS = {
  news:          ['All Feeds', 'Reuters', 'Bloomberg', 'TechCrunch', 'Ars Technica', 'HN'],
  weather:       ['Current', '7-Day Forecast', 'Radar', 'Alerts', 'Air Quality'],
  finance:       ['Overview', 'Watchlist', 'Equities', 'Crypto', 'Forex', 'Commodities'],
  calendar:      ['This Week', 'This Month', 'Upcoming', 'Tasks', 'Deadlines'],
  mail:          ['Inbox', 'Starred', 'Drafts', 'Sent', 'Archive', 'Trash'],
  comms:         ['Discord', 'Slack', 'Messenger', 'Teams', 'Notifications'],
  conversations: [], // ConversationsPanel manages its own sidebar layout
  agents:        [], // AgentCreatorPanel manages its own sidebar layout
  legislation:   [], // LegislationPanel manages its own sidebar layout
  settings:      ['General', 'Integrations', 'Agents', 'Notifications', 'Appearance', 'About'],
};

/** Stub main content per service */
const StubContent = ({ id }) => (
  <div className={styles.stub}>
    <div className={styles.stubIcon} aria-hidden="true">
      {id === 'news'     && '⬡'}
      {id === 'weather'  && '◈'}
      {id === 'finance'  && '△'}
      {id === 'calendar' && '▣'}
      {id === 'mail'     && '◧'}
      {id === 'comms'    && '◉'}
      {id === 'settings' && '⊕'}
    </div>
    <p className={styles.stubTitle}>{PANEL_TITLES[id]}</p>
    <p className={styles.stubSub}>Integration pending — data wiring in backlog</p>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// ICONS
// ─────────────────────────────────────────────────────────────────────────────

const IconPopOut = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M4 1H1v8h8V6M6 1h3v3M4.5 5.5L9 1"
      stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const IconClose = () => (
  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
    <path d="M2 2l6 6M8 2L2 8"
      stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// DROP PANEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string}   id                 - Service id: 'news'|'weather'|...|'conversations'|'trainer'|'settings'
 * @param {boolean}  isOpen             - Whether the panel is visible (triggered by AppBar tab)
 * @param {function} onClose            - () => void — close this panel
 * @param {function} onPopOut           - (id) => void — open in Electron window
 * @param {object}   settingsProps      - Props forwarded to SettingsPanel when id='settings'.
 * @param {object}   conversationsProps - Props forwarded to ConversationsPanel when id='conversations'.
 * @param {function} onOpenPanel        - (id: string) => void — open another drop panel.
 */
const DropPanel = ({ id, isOpen = false, onClose, onPopOut, settingsProps, conversationsProps, onOpenPanel }) => {
  const title    = PANEL_TITLES[id]   ?? id;
  const tag      = PANEL_TAGS[id]     ?? '';
  const sidebar  = SIDEBAR_ITEMS[id]  ?? [];
  const panelRef = useRef(null);
  const animating = useRef(false);

  // ── GSAP open / close — fires whenever isOpen changes ──
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    if (isOpen) {
      animateDropPanelOpen(el);
    } else {
      // Blur any focused element inside the panel before setting aria-hidden=true.
      // Without this, the browser blocks aria-hidden on a panel containing focused elements.
      if (el.contains(document.activeElement)) {
        document.activeElement.blur();
      }
      animateDropPanelClose(el);
    }
  }, [isOpen]);

  return (
    <div
      ref={panelRef}
      className={styles.panel}
      role="dialog"
      aria-label={title}
      aria-hidden={!isOpen}
    >
      {/* ── FROSTED BACKGROUND ── */}
      <div className={styles.bg} aria-hidden="true" />

      {/* ── PANEL INNER ── */}
      <div className={styles.inner}>

        {/* ── HEADER ── */}
        <div className={styles.header}>
          <div className={styles.led} aria-hidden="true" />
          <span className={styles.title}>{title}</span>
          <span className={styles.tag}>{tag}</span>
          <div className={styles.actions}>
            {onPopOut && (
              <button
                className={styles.btn}
                onClick={() => onPopOut(id)}
                aria-label={`Open ${title} in window`}
                title="Open in separate window"
              >
                <IconPopOut />
              </button>
            )}
            <button
              className={styles.btn}
              onClick={onClose}
              aria-label={`Close ${title}`}
              title="Close"
            >
              <IconClose />
            </button>
          </div>
        </div>

        {/* ── BODY ──
            Settings:      SettingsPanel owns the full two-column layout.
            Conversations: ConversationsPanel owns the full two-column layout.
            News:          NewsPanel owns the full two-column layout.
            Finance:       FinancePanel owns the full two-column layout.
            Calendar:      CalendarPanel owns the full two-column layout.
            Mail:          MailPanel owns the full two-column layout.
            Comms:         CommsPanel owns the full two-column layout.
            Weather:       WeatherPanel owns the full two-column layout. */}
        {id === 'settings' ? (
          <SettingsPanel {...(settingsProps ?? {})} />
        ) : id === 'conversations' ? (
          <ConversationsPanel {...(conversationsProps ?? {})} />
        ) : id === 'news' ? (
          <NewsPanel />
        ) : id === 'finance' ? (
          <FinancePanel />
        ) : id === 'calendar' ? (
          <CalendarPanel />
        ) : id === 'mail' ? (
          <MailPanel />
        ) : id === 'comms' ? (
          <CommsPanel />
        ) : id === 'weather' ? (
          <WeatherPanel />
        ) : id === 'schedule' ? (
          <SchedulePanel />
        ) : id === 'satellites' ? (
          <SatellitePanel />
        ) : id === 'trainer' ? (
          <AdversarialTrainerPanel />
        ) : id === 'agents' ? (
          <AgentCreatorPanel />
        ) : id === 'legislation' ? (
          <LegislationPanel onOpenPanel={onOpenPanel} />
        ) : id === 'geo' ? (
          <GeoPanel />
        ) : id === 'station' ? (
          <StationPanel />
        ) : id === 'tool-workspace' ? (
          <ToolWorkspacePanel />
        ) : id === 'neural-interface' ? (
          <NeuralInterfacePanel />
        ) : id === 'devpanel' ? (
          <DevPanel />
        ) : (
          <div className={styles.body}>

            {/* Left sidebar — source / filter navigation */}
            <div className={styles.side}>
              <div className={styles.sideLabel}>Sources</div>
              {sidebar.map((item, i) => (
                <div
                  key={item}
                  className={[styles.sideItem, i === 0 && styles.sideItemActive].filter(Boolean).join(' ')}
                >
                  <div className={styles.sideDot} aria-hidden="true" />
                  {item}
                </div>
              ))}
            </div>

            {/* Right main — content area */}
            <div className={styles.main}>
              <StubContent id={id} />
            </div>

          </div>
        )}
      </div>
    </div>
  );
};

export default DropPanel;
