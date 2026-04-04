/**
 * AURA NX-Alpha — MailPanel (Mail)
 *
 * Unified inbox view with folder navigation.
 * Replaces stub in DropPanel for the 'mail' service.
 * Real data comes from Gmail/Outlook integrations during reconciliation.
 *
 * EMAIL SHAPE:
 * {
 *   id:        string,
 *   folder:    'inbox' | 'starred' | 'drafts' | 'sent' | 'archive' | 'trash',
 *   from:      string,   — display name
 *   fromEmail: string,
 *   subject:   string,
 *   snippet:   string,   — first ~100 chars of body
 *   time:      string,   — relative time string
 *   unread:    boolean,
 *   starred:   boolean,
 *   hasAttachment: boolean,
 * }
 */

import { useState } from 'react';
import styles from './MailPanel.module.css';
import { useInbox } from '../../hooks/useBackendData';

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT CONNECTIONS
// ─────────────────────────────────────────────────────────────────────────────

const MAIL_ACCOUNTS = [
  { id: 'gmail',   label: 'Gmail',        color: '#EA4335', icon: 'G' },
  { id: 'drive',   label: 'Google Drive', color: '#34A853', icon: '▲' },
  { id: 'outlook', label: 'Outlook',      color: '#0078D4', icon: 'O' },
];

const AccountRow = ({ account, connected, onConnect }) => (
  <div className={styles.accountRow}>
    <span
      className={styles.accountIcon}
      style={{ background: account.color }}
      aria-hidden="true"
    >
      {account.icon}
    </span>
    <span className={styles.accountLabel}>{account.label}</span>
    {connected ? (
      <span className={styles.accountConnected}>✓</span>
    ) : (
      <button
        className={styles.accountConnectBtn}
        onClick={() => onConnect(account.id)}
        aria-label={`Connect ${account.label}`}
      >
        Connect
      </button>
    )}
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// DEMO DATA
// ─────────────────────────────────────────────────────────────────────────────

const FOLDERS = [
  { id: 'inbox',   label: 'Inbox',   count: 4 },
  { id: 'starred', label: 'Starred', count: 2 },
  { id: 'drafts',  label: 'Drafts',  count: 1 },
  { id: 'sent',    label: 'Sent',    count: 0 },
  { id: 'archive', label: 'Archive', count: 0 },
  { id: 'trash',   label: 'Trash',   count: 0 },
];

const DEMO_EMAILS = [
  {
    id: 'm1',
    folder: 'inbox',
    from: 'Sarah Chen',
    fromEmail: 'schen@acme.io',
    subject: 'Re: NDA Review — Acme Corp partnership',
    snippet: 'Thanks for the markup. I\'ve addressed most of the redlines from your team. The liability cap clause on Section 8.3 is the remaining sticking point — our legal says 2x is their floor…',
    time: '8m ago',
    unread: true,
    starred: true,
    hasAttachment: true,
  },
  {
    id: 'm2',
    folder: 'inbox',
    from: 'Marcus Webb',
    fromEmail: 'mwebb@sequoia.com',
    subject: 'Series E — follow-up questions before Wednesday',
    snippet: 'Hey Lucas, a few clarifying questions from our investment committee before the Wednesday call: 1) Can you share updated ARR cohort retention by vintage year? 2) What does the go-to-market motion look…',
    time: '41m ago',
    unread: true,
    starred: false,
    hasAttachment: false,
  },
  {
    id: 'm3',
    folder: 'inbox',
    from: 'Priya Nair',
    fromEmail: 'p.nair@anthropic.com',
    subject: 'Claude API — enterprise tier activation',
    snippet: 'Your account has been upgraded to the Enterprise tier. New limits: 10M tokens/day, priority routing, and access to the claude-opus-4-6 model. See the attached usage guide for rate limit headers…',
    time: '2h ago',
    unread: true,
    starred: false,
    hasAttachment: true,
  },
  {
    id: 'm4',
    folder: 'inbox',
    from: 'DevOps Alerts',
    fromEmail: 'alerts@pagerduty.com',
    subject: '[RESOLVED] High memory usage on prod-api-03',
    snippet: 'Alert: prod-api-03 memory utilization reached 91% at 14:22 UTC. Auto-scaling triggered a new instance at 14:23. Utilization has returned to normal (68%). No user impact detected. Incident #INC-4821…',
    time: '3h ago',
    unread: true,
    starred: false,
    hasAttachment: false,
  },
  {
    id: 'm5',
    folder: 'inbox',
    from: 'Jordan Kim',
    fromEmail: 'j.kim@internal.com',
    subject: 'Q1 Engineering Retro — action items',
    snippet: 'Hey all, attached are the consolidated action items from yesterday\'s retro. Main themes: deployment pipeline reliability (3 items), on-call rotation fairness (2 items), documentation debt (4 items). Owners…',
    time: 'Yesterday',
    unread: false,
    starred: false,
    hasAttachment: true,
  },
  {
    id: 'm6',
    folder: 'inbox',
    from: 'AWS Billing',
    fromEmail: 'billing@amazon.com',
    subject: 'Your AWS bill for February 2026 is available',
    snippet: 'Your AWS invoice for the billing period February 1–28, 2026 is now available. Total: $14,284.18. The largest line items are EC2 On-Demand ($8,102.44) and RDS ($3,211.56). View full invoice…',
    time: '2 days ago',
    unread: false,
    starred: false,
    hasAttachment: false,
  },
  {
    id: 'm7',
    folder: 'starred',
    from: 'Sarah Chen',
    fromEmail: 'schen@acme.io',
    subject: 'Re: NDA Review — Acme Corp partnership',
    snippet: 'Thanks for the markup. I\'ve addressed most of the redlines from your team…',
    time: '8m ago',
    unread: true,
    starred: true,
    hasAttachment: true,
  },
  {
    id: 'm8',
    folder: 'starred',
    from: 'Marcus Webb',
    fromEmail: 'mwebb@sequoia.com',
    subject: 'Series E Intro — partner call',
    snippet: 'Following up from the intro email — would love to set up a call this week with our enterprise software partner…',
    time: 'Mon',
    unread: false,
    starred: true,
    hasAttachment: false,
  },
  {
    id: 'm9',
    folder: 'drafts',
    from: 'Me',
    fromEmail: 'lucas@example.com',
    subject: 'Re: Board deck — Q1 slide revisions',
    snippet: 'Hi Alex, I\'ve reviewed the latest version. A few comments on slide 4 — the ARR chart needs to be updated with the February actuals…',
    time: 'Draft',
    unread: false,
    starred: false,
    hasAttachment: false,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// INITIAL AVATAR COLOR (deterministic per sender name)
// ─────────────────────────────────────────────────────────────────────────────

const AVATAR_COLORS = [
  '#3877ee', '#b87820', '#2a6e4f', '#8b2a8b', '#2a6e6e',
  '#6e4a2a', '#1a5c8e', '#7a3535',
];

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL ROW
// ─────────────────────────────────────────────────────────────────────────────

const EmailRow = ({ email, isSelected, onClick }) => (
  <div
    className={[
      styles.emailRow,
      email.unread   && styles.emailUnread,
      isSelected     && styles.emailSelected,
    ].filter(Boolean).join(' ')}
    onClick={onClick}
    role="button"
    aria-label={`${email.unread ? 'Unread: ' : ''}${email.from} — ${email.subject}`}
  >
    {/* Unread indicator */}
    <div className={styles.emailIndicator} aria-hidden="true">
      {email.unread && <span className={styles.unreadDot} />}
    </div>

    {/* Avatar */}
    <div
      className={styles.emailAvatar}
      style={{ background: avatarColor(email.from) }}
      aria-hidden="true"
    >
      {initials(email.from)}
    </div>

    {/* Content */}
    <div className={styles.emailContent}>
      <div className={styles.emailHeader}>
        <span className={styles.emailFrom}>{email.from}</span>
        <div className={styles.emailMeta}>
          {email.hasAttachment && (
            <span className={styles.attachIcon} aria-label="Has attachment">⬡</span>
          )}
          {email.starred && (
            <span className={styles.starIcon} aria-label="Starred">★</span>
          )}
          <span className={styles.emailTime}>{email.time}</span>
        </div>
      </div>
      <div className={styles.emailSubject}>{email.subject}</div>
      <div className={styles.emailSnippet}>{email.snippet}</div>
    </div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIL PANEL
// ─────────────────────────────────────────────────────────────────────────────

const MailPanel = ({ emails: propEmails } = {}) => {
  const [activeFolder,      setActiveFolder]      = useState('inbox');
  const [selectedEmail,     setSelectedEmail]     = useState(null);
  const [connectedAccounts, setConnectedAccounts] = useState({});
  const { data: inboxData } = useInbox(120000);

  const handleConnect = (accountId) => {
    // Placeholder: real flow would open OAuth popup via Electron shell or window.open
    const origins = {
      gmail:   'https://accounts.google.com/o/oauth2/auth',
      drive:   'https://accounts.google.com/o/oauth2/auth',
      outlook: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    };
    console.info(`[MailPanel] Initiating OAuth for ${accountId} → ${origins[accountId]}`);
    // Mark optimistically connected for demo; backend will validate on next poll
    setConnectedAccounts(prev => ({ ...prev, [accountId]: true }));
  };

  // Map backend emails to component shape
  const liveEmails = inboxData?.messages
    ? inboxData.messages.map(m => ({
        id:            m.id,
        folder:        'inbox',
        from:          m.from || 'Unknown',
        fromEmail:     m.from_email || '',
        subject:       m.subject || '(no subject)',
        snippet:       m.snippet || '',
        time:          m.date ? new Date(m.date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) : '',
        unread:        Boolean(m.is_unread),
        starred:       m.labels?.includes('STARRED') ?? false,
        hasAttachment: Boolean(m.has_attachment),
      }))
    : null;

  const emails = propEmails ?? liveEmails ?? DEMO_EMAILS;

  const folderEmails = emails.filter(e => e.folder === activeFolder);
  const unreadCount  = emails.filter(e => e.folder === 'inbox' && e.unread).length;

  return (
    <div className={styles.root}>

      {/* ── SIDEBAR ── */}
      <div className={styles.side}>
        <button className={styles.composeBtn} aria-label="Compose new email">
          <span aria-hidden="true">✏</span> Compose
        </button>

        <div className={styles.sideLabel}>Folders</div>
        {FOLDERS.map(folder => (
          <button
            key={folder.id}
            className={[
              styles.sideItem,
              activeFolder === folder.id && styles.sideItemActive,
            ].filter(Boolean).join(' ')}
            onClick={() => { setActiveFolder(folder.id); setSelectedEmail(null); }}
            aria-pressed={activeFolder === folder.id}
          >
            <span className={styles.sideDot} aria-hidden="true" />
            <span className={styles.sideItemLabel}>{folder.label}</span>
            {folder.id === 'inbox' && unreadCount > 0 && (
              <span className={styles.sideCount}>{unreadCount}</span>
            )}
          </button>
        ))}

        <div className={styles.sideSep} aria-hidden="true" />
        <div className={styles.sideLabel}>Accounts</div>
        {MAIL_ACCOUNTS.map(account => (
          <AccountRow
            key={account.id}
            account={account}
            connected={!!connectedAccounts[account.id]}
            onConnect={handleConnect}
          />
        ))}
      </div>

      {/* ── EMAIL LIST ── */}
      <div className={styles.emailList}>
        <div className={styles.listHeader}>
          <span className={styles.listTitle}>
            {FOLDERS.find(f => f.id === activeFolder)?.label}
          </span>
          <span className={styles.listCount}>{folderEmails.length}</span>
        </div>

        {folderEmails.length === 0 ? (
          <div className={styles.empty}>No messages</div>
        ) : (
          folderEmails.map(email => (
            <EmailRow
              key={email.id}
              email={email}
              isSelected={selectedEmail === email.id}
              onClick={() => setSelectedEmail(email.id)}
            />
          ))
        )}
      </div>

    </div>
  );
};

export default MailPanel;
