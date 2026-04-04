/**
 * AURA NX-Alpha — CommsPanel (Communications)
 *
 * Unified messaging surface aggregating Discord, Slack, and other platforms.
 * Replaces stub in DropPanel for the 'comms' service.
 * Real data comes from platform MCPs/API integrations during reconciliation.
 *
 * MESSAGE SHAPE:
 * {
 *   id:        string,
 *   platform:  'discord' | 'slack' | 'messenger' | 'teams',
 *   channel:   string,   — channel/room name
 *   sender:    string,   — display name
 *   text:      string,
 *   time:      string,
 *   unread:    boolean,
 *   mentions:  boolean,  — true if message mentions the user
 * }
 *
 * CHANNEL SHAPE:
 * {
 *   id:       string,
 *   platform: string,
 *   label:    string,    — "#general", "Team Chat", etc.
 *   unread:   number,
 *   mention:  boolean,
 * }
 */

import { useState } from 'react';
import styles from './CommsPanel.module.css';

// ─────────────────────────────────────────────────────────────────────────────
// DEMO DATA
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_SECTIONS = [
  { id: 'all',       label: 'All Channels', platform: null },
  { id: 'discord',   label: 'Discord',      platform: 'discord' },
  { id: 'slack',     label: 'Slack',        platform: 'slack' },
  { id: 'messenger', label: 'Messenger',    platform: 'messenger' },
  { id: 'teams',     label: 'Teams',        platform: 'teams' },
];

const PLATFORM_COLORS = {
  discord:   '#5865f2',
  slack:     '#e01e5a',
  messenger: '#0084ff',
  teams:     '#6264a7',
};

const COMMS_ACCOUNTS = [
  { id: 'discord',   label: 'Discord',   color: '#5865f2', icon: 'D' },
  { id: 'slack',     label: 'Slack',     color: '#e01e5a', icon: 'S' },
  { id: 'teams',     label: 'Teams',     color: '#6264a7', icon: 'T' },
  { id: 'messenger', label: 'Messenger', color: '#0084ff', icon: 'M' },
];

const DEMO_CHANNELS = [
  { id: 'dc-general',   platform: 'discord',   label: '#general',       unread: 3,  mention: false },
  { id: 'dc-eng',       platform: 'discord',   label: '#engineering',   unread: 12, mention: true  },
  { id: 'dc-alerts',    platform: 'discord',   label: '#alerts',        unread: 1,  mention: false },
  { id: 'sl-team',      platform: 'slack',     label: '#team-chat',     unread: 5,  mention: true  },
  { id: 'sl-product',   platform: 'slack',     label: '#product',       unread: 0,  mention: false },
  { id: 'sl-random',    platform: 'slack',     label: '#random',        unread: 8,  mention: false },
  { id: 'ms-dm-sarah',  platform: 'messenger', label: 'Sarah Chen',     unread: 1,  mention: false },
  { id: 'ms-dm-jordan', platform: 'messenger', label: 'Jordan Kim',     unread: 0,  mention: false },
  { id: 'te-board',     platform: 'teams',     label: 'Board Channel',  unread: 2,  mention: false },
];

const DEMO_MESSAGES = {
  'dc-general': [
    { id: 'g1', platform: 'discord', sender: 'Alex Rivera',  text: 'Morning everyone! NX-Alpha looking really solid in the staging build.', time: '09:14',  unread: false, mentions: false },
    { id: 'g2', platform: 'discord', sender: 'Jamie Okafor', text: 'Agreed — the canvas block renderer is impressive. Those GSAP transitions are 🔥', time: '09:16',  unread: false, mentions: false },
    { id: 'g3', platform: 'discord', sender: 'Sam Park',     text: 'Quick reminder that the retro notes are in Notion — please add your +1s before EOD.', time: '10:02',  unread: true,  mentions: false },
    { id: 'g4', platform: 'discord', sender: 'Alex Rivera',  text: 'On it. Also — do we have a firm date for the backend SSE endpoint going live?', time: '10:44',  unread: true,  mentions: false },
    { id: 'g5', platform: 'discord', sender: 'Jamie Okafor', text: 'Still targeting end of month. The stream handler and tool approval flow are the last pieces.', time: '10:46',  unread: true,  mentions: false },
  ],
  'dc-eng': [
    { id: 'e1', platform: 'discord', sender: 'Sam Park',     text: 'PR #214 is up — SSE hook with exponential backoff. Please review when you get a chance.', time: '08:30',  unread: false, mentions: false },
    { id: 'e2', platform: 'discord', sender: 'Alex Rivera',  text: 'Reviewed. One comment on the handlersRef pattern — think we should document why deps=[] is safe.', time: '09:05',  unread: false, mentions: false },
    { id: 'e3', platform: 'discord', sender: 'Sam Park',     text: 'Good call. Updated the comment block. Ready to merge when you approve.', time: '09:22',  unread: false, mentions: false },
    { id: 'e4', platform: 'discord', sender: 'Jamie Okafor', text: '@Lucas the App.jsx POST handler — should we add a session token header for the backend or is that post-reconciliation?', time: '11:18',  unread: true,  mentions: true  },
    { id: 'e5', platform: 'discord', sender: 'Alex Rivera',  text: 'Also — noticed the TitleBar was calling api.minimize() before the fix. Good catch on that.', time: '11:31',  unread: true,  mentions: false },
    { id: 'e6', platform: 'discord', sender: 'Sam Park',     text: 'Staging deploy in 10 minutes. Heads up.', time: '12:04',  unread: true,  mentions: false },
  ],
  'sl-team': [
    { id: 't1', platform: 'slack',   sender: 'Priya Nair',  text: 'Q1 board deck is in Google Drive — please review slides 8–12 before Wednesday.', time: '08:45',  unread: false, mentions: false },
    { id: 't2', platform: 'slack',   sender: 'Jordan Kim',  text: 'Finance model updated with February actuals. Revenue tracking 4% ahead of plan.', time: '09:30',  unread: false, mentions: false },
    { id: 't3', platform: 'slack',   sender: 'Marcus Webb', text: '@Lucas — following up on the investor data room access. Has the Sequoia invite gone out?', time: '10:15',  unread: true,  mentions: true  },
    { id: 't4', platform: 'slack',   sender: 'Priya Nair',  text: 'Reminder: all-hands is Thursday at 15:00. Please submit discussion topics in the thread ↓', time: '11:00',  unread: true,  mentions: false },
    { id: 't5', platform: 'slack',   sender: 'Jordan Kim',  text: 'Done. Sequoia invite sent. They have access to the data room as of now.', time: '11:22',  unread: true,  mentions: false },
  ],
  'dc-alerts': [
    { id: 'a1', platform: 'discord', sender: 'AlertBot',    text: '⚠ prod-api-03: Memory at 91%. Auto-scaling triggered.', time: '14:22',  unread: false, mentions: false },
    { id: 'a2', platform: 'discord', sender: 'AlertBot',    text: '✓ prod-api-03: Memory normalized at 68%. New instance healthy.', time: '14:23',  unread: true,  mentions: false },
  ],
  'ms-dm-sarah': [
    { id: 's1', platform: 'messenger', sender: 'Sarah Chen', text: 'Hey! Sent over the updated NDA markup. Let me know if you have any questions.', time: '10:04', unread: false, mentions: false },
    { id: 's2', platform: 'messenger', sender: 'Me',         text: 'Got it, reviewing now. The liability cap on Section 8.3 is the main item I want to discuss.', time: '10:18', unread: false, mentions: false },
    { id: 's3', platform: 'messenger', sender: 'Sarah Chen', text: 'Makes sense. Our floor is 2x — we can hop on a quick call if easier.', time: '10:44', unread: true,  mentions: false },
  ],
  'sl-random': [
    { id: 'r1', platform: 'slack',   sender: 'Alex Rivera',  text: 'This is incredible https://example.com/ai-paper', time: 'Yesterday', unread: false, mentions: false },
    { id: 'r2', platform: 'slack',   sender: 'Jamie Okafor', text: '🍕 Lunch run happening at 12:30 — anyone joining?', time: 'Yesterday', unread: false, mentions: false },
    { id: 'r3', platform: 'slack',   sender: 'Sam Park',     text: 'Congrats to Jordan on the 3-year anniversary today! 🎉', time: '09:00', unread: true, mentions: false },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// AVATAR HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function avatarColor(name) {
  const COLORS = ['#3877ee','#b87820','#2a6e4f','#8b2a8b','#2a6e6e','#6e4a2a','#1a5c8e','#7a3535'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

function initials(name) {
  if (name === 'Me') return 'ME';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0][0].toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL ITEM (sidebar)
// ─────────────────────────────────────────────────────────────────────────────

const ChannelItem = ({ channel, isActive, onClick }) => (
  <button
    className={[
      styles.channelItem,
      isActive && styles.channelItemActive,
      channel.mention && styles.channelItemMention,
    ].filter(Boolean).join(' ')}
    onClick={onClick}
    aria-pressed={isActive}
    style={{ '--platform-color': PLATFORM_COLORS[channel.platform] }}
  >
    <span className={styles.channelPlatformDot} aria-hidden="true" />
    <span className={styles.channelLabel}>{channel.label}</span>
    {channel.mention && <span className={styles.mentionBadge} aria-label="Mention">@</span>}
    {!channel.mention && channel.unread > 0 && (
      <span className={styles.unreadBadge}>{channel.unread > 99 ? '99+' : channel.unread}</span>
    )}
  </button>
);

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE BUBBLE
// ─────────────────────────────────────────────────────────────────────────────

const MessageBubble = ({ msg }) => {
  const isMe = msg.sender === 'Me';
  return (
    <div className={[styles.msg, isMe && styles.msgMe, msg.mentions && styles.msgMention].filter(Boolean).join(' ')}>
      {!isMe && (
        <div
          className={styles.msgAvatar}
          style={{ background: avatarColor(msg.sender) }}
          aria-hidden="true"
        >
          {initials(msg.sender)}
        </div>
      )}
      <div className={styles.msgBody}>
        {!isMe && (
          <div className={styles.msgMeta}>
            <span className={styles.msgSender}>{msg.sender}</span>
            <span className={styles.msgTime}>{msg.time}</span>
          </div>
        )}
        <div className={[styles.msgBubble, isMe && styles.msgBubbleMe].filter(Boolean).join(' ')}>
          {msg.text}
        </div>
        {isMe && <span className={`${styles.msgTime} ${styles.msgTimeMe}`}>{msg.time}</span>}
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// COMMS PANEL
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'http://127.0.0.1:8000';

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNT ROW — shared by sidebar accounts section
// ─────────────────────────────────────────────────────────────────────────────

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

const CommsPanel = () => {
  const [activePlatform,    setActivePlatform]    = useState('all');
  const [activeChannel,     setActiveChannel]     = useState('dc-eng');
  const [inputVal,          setInputVal]          = useState('');
  const [localMessages,     setLocalMessages]     = useState({});
  const [connectedAccounts, setConnectedAccounts] = useState({});

  const handleConnect = (accountId) => {
    const origins = {
      discord:   'https://discord.com/oauth2/authorize',
      slack:     'https://slack.com/oauth/v2/authorize',
      teams:     'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      messenger: 'https://www.facebook.com/v12.0/dialog/oauth',
    };
    console.info(`[CommsPanel] Initiating OAuth for ${accountId} → ${origins[accountId]}`);
    setConnectedAccounts(prev => ({ ...prev, [accountId]: true }));
  };

  const handleSend = async () => {
    const text = inputVal.trim();
    if (!text) return;
    const msg = {
      id: `local-${Date.now()}`,
      platform: DEMO_CHANNELS.find(c => c.id === activeChannel)?.platform || 'discord',
      sender: 'Me',
      text,
      time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }),
      unread: false,
      mentions: false,
    };
    setLocalMessages(prev => ({
      ...prev,
      [activeChannel]: [...(prev[activeChannel] || []), msg],
    }));
    setInputVal('');
    // Post to backend (fire-and-forget — will fail gracefully if endpoint not yet wired)
    try {
      await fetch(`${BASE_URL}/data/comms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: activeChannel, text, platform: msg.platform }),
      });
    } catch { /* backend connector pending */ }
  };

  const visibleChannels = activePlatform === 'all'
    ? DEMO_CHANNELS
    : DEMO_CHANNELS.filter(c => c.platform === activePlatform);

  const messages   = [...(DEMO_MESSAGES[activeChannel] ?? []), ...(localMessages[activeChannel] || [])];
  const channel    = DEMO_CHANNELS.find(c => c.id === activeChannel);
  const totalUnread = DEMO_CHANNELS.reduce((n, c) => n + c.unread, 0);

  return (
    <div className={styles.root}>

      {/* ── LEFT SIDEBAR ── */}
      <div className={styles.side}>

        {/* Platform filter */}
        <div className={styles.sideLabel}>Platforms</div>
        {PLATFORM_SECTIONS.map(sec => (
          <button
            key={sec.id}
            className={[
              styles.platformItem,
              activePlatform === sec.id && styles.platformItemActive,
            ].filter(Boolean).join(' ')}
            style={{ '--platform-color': sec.platform ? PLATFORM_COLORS[sec.platform] : 'var(--amber-base)' }}
            onClick={() => setActivePlatform(sec.id)}
            aria-pressed={activePlatform === sec.id}
          >
            <span className={styles.platformDot} aria-hidden="true" />
            <span className={styles.platformLabel}>{sec.label}</span>
            {sec.id === 'all' && totalUnread > 0 && (
              <span className={styles.platformCount}>{totalUnread}</span>
            )}
          </button>
        ))}

        <div className={styles.sideSep} aria-hidden="true" />

        {/* Channel list */}
        <div className={styles.sideLabel}>Channels</div>
        {visibleChannels.map(ch => (
          <ChannelItem
            key={ch.id}
            channel={ch}
            isActive={activeChannel === ch.id}
            onClick={() => setActiveChannel(ch.id)}
          />
        ))}

        <div className={styles.sideSep} aria-hidden="true" />
        <div className={styles.sideLabel}>Accounts</div>
        {COMMS_ACCOUNTS.map(account => (
          <AccountRow
            key={account.id}
            account={account}
            connected={!!connectedAccounts[account.id]}
            onConnect={handleConnect}
          />
        ))}

      </div>

      {/* ── MESSAGE AREA ── */}
      <div className={styles.messageArea}>

        {/* Channel header */}
        <div className={styles.channelHeader}>
          <span
            className={styles.channelHeaderDot}
            style={{ background: channel ? PLATFORM_COLORS[channel.platform] : 'var(--text-muted)' }}
            aria-hidden="true"
          />
          <span className={styles.channelHeaderName}>{channel?.label ?? 'Select a channel'}</span>
          <span className={styles.channelHeaderPlatform}>{channel?.platform}</span>
        </div>

        {/* Messages */}
        <div className={styles.messages}>
          {messages.length === 0 ? (
            <div className={styles.empty}>No messages in this channel</div>
          ) : (
            messages.map(msg => <MessageBubble key={msg.id} msg={msg} />)
          )}
        </div>

        {/* Input area */}
        <div className={styles.inputArea}>
          <span className={styles.inputPlatformDot}
            style={{ background: channel ? PLATFORM_COLORS[channel.platform] : 'var(--text-muted)' }}
            aria-hidden="true"
          />
          <input
            className={styles.input}
            placeholder={`Message ${channel?.label ?? 'channel'}…`}
            aria-label="Message input"
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
          />
          <button
            className={styles.sendBtn}
            aria-label="Send"
            disabled={!inputVal.trim()}
            onClick={handleSend}
          >→</button>
        </div>

      </div>

    </div>
  );
};

export default CommsPanel;
