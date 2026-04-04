/**
 * AURA NX-Alpha — PopOutShell
 *
 * Minimal wrapper for panels that have been popped out into their own
 * Electron BrowserWindow. Loaded when the renderer URL contains ?panel=<id>.
 *
 * The panel fills the entire window. TitleBar is omitted — the panel's
 * own header provides the only chrome. No CommandCenter overhead.
 *
 * SUPPORTED PANELS:
 *   agent-monitor  — AgentMonitor (full agent status)
 *   chat           — Chat sidebar (conversation) — fully wired with SSE + history
 *   canvas         — Canvas panel (block renderer)
 *
 * CHAT POP-OUT ARCHITECTURE:
 *   Before the pop-out window is opened, CommandCenter stores the current
 *   message list in localStorage ('aura-chat-popout-messages'). ChatPopOut
 *   reads that on mount, then connects its own SSE stream for live updates.
 *   On send, it POSTs directly to /message. Both the main window and the
 *   pop-out share the same SSE channel — new messages appear in both.
 *   When this window closes, Electron sends 'panel:pop-out-closed' to the
 *   main renderer, which restores the sidebar.
 *
 * Props:
 *   panelId              — from URL param ?panel=X
 *   streamUrl            — SSE endpoint (resolved by App.jsx)
 *   eventSourceFactory   — mock factory in dev mode
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import useAuraStream from '../../hooks/useAuraStream';
import styles from './PopOutShell.module.css';
import AgentMonitor from '../AgentMonitor/AgentMonitor';
import Chat from '../Chat/Chat';
import AuraCanvas from '../AuraCanvas/AuraCanvas';

const BACKEND = 'http://localhost:8000';

// ─────────────────────────────────────────────────────────────────────────────
// CHAT POP-OUT — fully wired SSE + history + send
// ─────────────────────────────────────────────────────────────────────────────

const ChatPopOut = ({ streamUrl, eventSourceFactory, onCanvasRender }) => {
  // Load stashed messages from localStorage (set by CommandCenter before pop-out)
  const [messages, setMessages] = useState(() => {
    try {
      const stored = localStorage.getItem('aura-chat-popout-messages');
      if (stored) return JSON.parse(stored);
    } catch { /* non-critical */ }
    return [];
  });

  const [isTyping, setIsTyping] = useState(false);
  const [auraState, setAuraState] = useState('idle');

  // On mount: clear the stashed messages so a fresh pop-out doesn't re-use old data
  useEffect(() => {
    try { localStorage.removeItem('aura-chat-popout-messages'); } catch { /* ok */ }
  }, []);

  // Send message → POST /message
  const handleSend = useCallback(async (text) => {
    if (!text?.trim()) return;
    // Optimistic: add user message immediately
    setMessages(prev => [
      ...prev,
      {
        id:        `user-${Date.now()}`,
        role:      'user',
        content:   text,
        timestamp: new Date().toISOString(),
      },
    ]);
    try {
      await fetch(`${BACKEND}/message`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text }),
      });
    } catch (err) {
      console.warn('[ChatPopOut] POST /message failed:', err);
    }
  }, []);

  // SSE stream handlers — mirror the core subset from CommandCenter
  const streamHandlers = useMemo(() => ({

    onToken: ({ text = '', messageId = 'msg-stream' }) => {
      setMessages(prev => {
        const idx = prev.findIndex(m => m.id === messageId);
        if (idx !== -1) {
          const updated = [...prev];
          updated[idx] = { ...updated[idx], content: updated[idx].content + text };
          return updated;
        }
        return [
          ...prev,
          {
            id:        messageId,
            role:      'aura',
            content:   text,
            streaming: true,
            timestamp: new Date().toISOString(),
          },
        ];
      });
      setIsTyping(true);
      setAuraState('responding');
    },

    onEnd: () => {
      setIsTyping(false);
      setAuraState('idle');
    },

    onTeamResult: ({ team_id, content = '', msg_id }) => {
      if (!content) return;
      setMessages(prev => [
        ...prev,
        {
          id:        msg_id ?? `aura-team-${team_id}`,
          role:      'aura',
          content,
          timestamp: new Date().toISOString(),
          streaming: false,
        },
      ]);
      setIsTyping(false);
      setAuraState('idle');
    },

    onPmClarification: ({ question = '' }) => {
      if (!question) return;
      setMessages(prev => [
        ...prev,
        {
          id:        `pm-clarify-${Date.now()}`,
          role:      'aura',
          content:   question,
          timestamp: new Date().toISOString(),
          streaming: false,
        },
      ]);
      setIsTyping(false);
      setAuraState('idle');
    },

    // Canvas events — forward to portrait mode canvas
    onRenderCanvas: (data) => {
      if (onCanvasRender) onCanvasRender(data);
    },
    onRenderCanvasPreview: (data) => {
      if (onCanvasRender) onCanvasRender(data);
    },
    onCanvasClear: () => {
      if (onCanvasRender) onCanvasRender(null);
    },

    // Suppress expected no-ops
    onStreamError:          () => {},
    onThinking:             () => {},
    onTeamGatePrompt:       () => {},
    onTeamDispatched:       () => {},
    onAgentUpdate:          () => {},
    onPendingApproval:      () => {},
    onExternalAlert:        () => {},
    onStorageUpdate:        () => {},
    onStorageWarning:       () => {},
    onStorageLimitReached:  () => {},
    onHardwareMode:         () => {},
    onModelStatus:          () => {},
    onBootAudio:            () => {},
    onAudioChunk:           () => {},
    onAudioEnd:             () => {},
    onVoiceProfileReady:    () => {},
    onAmbientSound:         () => {},
    onCanvasNarrationStart: () => {},
    onCanvasNarrationChunk: () => {},
    onSystemNotification:   () => {},
    onKnowledgeIngested:    () => {},
    onQueueDraining:        () => {},
    onQueueDrained:         () => {},
    onHfDownloadProgress:   () => {},
    onHfDownloadComplete:   () => {},
    onHfDownloadError:      () => {},

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [onCanvasRender]);

  useAuraStream(streamUrl, streamHandlers, { eventSourceFactory });

  return (
    <Chat
      messages={messages}
      auraStatus={auraState}
      isTyping={isTyping}
      isActive
      onSend={handleSend}
      // No pop-out button in the pop-out window itself
    />
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// AGENT MONITOR POP-OUT
// ─────────────────────────────────────────────────────────────────────────────

const AgentMonitorPopOut = () => (
  <AgentMonitor
    agents={[]}
    isActive
  />
);

// ─────────────────────────────────────────────────────────────────────────────
// UNKNOWN PANEL FALLBACK
// ─────────────────────────────────────────────────────────────────────────────

const UnknownPanel = ({ panelId }) => (
  <div className={styles.unknown}>
    <div className={styles.unknownCode}>{panelId}</div>
    <div className={styles.unknownLabel}>Unknown panel</div>
  </div>
);

// ─────────────────────────────────────────────────────────────────────────────
// SHELL
// ─────────────────────────────────────────────────────────────────────────────

const PopOutShell = ({ panelId, streamUrl, eventSourceFactory }) => {
  const [portraitMode,   setPortraitMode]   = useState(false);
  const [pinned,         setPinned]         = useState(false);
  const [canvasContent,  setCanvasContent]  = useState(null);

  // Sync pin state from Electron on mount
  useEffect(() => {
    window.electronAPI?.isAlwaysOnTop?.().then(val => setPinned(val)).catch(() => {});
  }, []);

  const handleClose = () => {
    if (window.electronAPI?.closePopOut) {
      window.electronAPI.closePopOut();
    } else {
      window.close();
    }
  };

  const handlePortraitToggle = useCallback(async () => {
    const next = !portraitMode;
    try { await window.electronAPI?.setPortraitMode?.(next); } catch { /* non-Electron env */ }
    setPortraitMode(next);
  }, [portraitMode]);

  const handlePin = useCallback(async () => {
    try {
      const next = await window.electronAPI?.toggleAlwaysOnTop?.();
      setPinned(next ?? !pinned);
    } catch { setPinned(p => !p); }
  }, [pinned]);

  const handleCanvasRender = useCallback((data) => {
    if (!data) { setCanvasContent(null); return; }
    // Normalise canvas payload — backend may send {type, content} or {type, payload}
    setCanvasContent({
      type:    data.type    ?? 'html',
      payload: data.payload ?? data.content ?? '',
    });
  }, []);

  const panelLabel = panelId
    ? panelId.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : 'Panel';

  const renderPanel = () => {
    switch (panelId) {
      case 'agent-monitor': return <AgentMonitorPopOut />;
      case 'chat': return (
        <ChatPopOut
          streamUrl={streamUrl}
          eventSourceFactory={eventSourceFactory}
          onCanvasRender={handleCanvasRender}
        />
      );
      default: return <UnknownPanel panelId={panelId} />;
    }
  };

  return (
    <div className={styles.shell} data-panel={panelId} data-portrait={portraitMode || undefined}>
      {/* Draggable titlebar */}
      <div className={styles.titlebar}>
        <div className={styles.dragRegion}>{panelLabel}</div>
        {/* Pin — always-on-top toggle */}
        <button
          className={[styles.iconBtn, pinned && styles.iconBtnActive].filter(Boolean).join(' ')}
          onClick={handlePin}
          title={pinned ? 'Unpin window' : 'Pin — always on top'}
          aria-label={pinned ? 'Disable always on top' : 'Enable always on top'}
          aria-pressed={pinned}
        >
          ⊕
        </button>
        {/* Portrait mode toggle — only on chat panel */}
        {panelId === 'chat' && (
          <button
            className={[styles.iconBtn, portraitMode && styles.iconBtnActive].filter(Boolean).join(' ')}
            onClick={handlePortraitToggle}
            title={portraitMode ? 'Exit portrait mode' : 'Portrait mode — full height + canvas'}
            aria-label={portraitMode ? 'Exit portrait mode' : 'Enter portrait mode'}
            aria-pressed={portraitMode}
          >
            ⇕
          </button>
        )}
        <button
          className={styles.closeBtn}
          onClick={handleClose}
          title="Close (Ctrl+W)"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      {/* Content — always keep the panel mounted to preserve live session.
          Portrait mode just adds the canvas section below. */}
      <div className={[
        styles.content,
        portraitMode && panelId === 'chat' && styles.portraitContent,
      ].filter(Boolean).join(' ')}>
        {renderPanel()}
      </div>

      {/* Canvas strip — only shown in portrait mode */}
      {portraitMode && panelId === 'chat' && (
        <div className={styles.canvasSection}>
          <div className={styles.canvasHeader}>
            <span>canvas</span>
            <span className={styles.canvasHeaderRule} />
          </div>
          <div className={styles.canvasBody}>
            <AuraCanvas content={canvasContent} />
          </div>
        </div>
      )}
    </div>
  );
};

export default PopOutShell;
