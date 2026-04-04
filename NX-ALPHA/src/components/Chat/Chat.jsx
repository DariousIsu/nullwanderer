/**
 * AURA NX-Alpha — Chat Panel
 *
 * The primary Aura conversation interface. Uses Panel as its container shell.
 * Manages the message stream, thinking indicator, and input bar.
 *
 * DESIGN RULE (from brief):
 * This panel has one job — be an unbroken conversational river.
 * The thinking indicator is the only dynamic element.
 * The immersion of persistent state lives or dies on keeping this clean.
 * Do not add status overlays, metadata, or competing UI elements here.
 *
 * DATA CONTRACT (from technical grounding):
 * - Messages: standard stream, role 'aura' or 'user'
 * - Aura status drives the thinking indicator
 * - All non-conversational output routes to Canvas — not here
 *
 * GSAP:
 * - New message entrance: slide up + fade in
 * - Thinking indicator: fade in when status → 'thinking', fade out when message arrives
 * - These are event-driven, not ambient
 *
 * USAGE:
 *   <Chat
 *     messages={messages}
 *     auraStatus={auraStatus}
 *     onSend={handleSend}
 *     isActive={isChatActive}
 *     onFocus={() => setActivePanel('chat')}
 *     onPopOut={() => ipcRenderer.send('panel:popout', 'chat')}
 *   />
 */

import {
  forwardRef,
  useRef,
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
} from 'react';
import { useGSAP }      from '@gsap/react';
import { gsap }         from '../../core/animations';
import Panel            from '../Panel/Panel';
import AuraIndicator    from '../AuraIndicator/AuraIndicator';
import TextScramble     from '../TextScramble/TextScramble';
import styles           from './Chat.module.css';

const BACKEND = 'http://localhost:8000';

// ─────────────────────────────────────────────────────────────────────────────
// SEND ICON
// ─────────────────────────────────────────────────────────────────────────────

const IconSend = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </svg>
);

// Mic icon — idle state
const IconMic = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="23" />
    <line x1="8"  y1="23" x2="16" y2="23" />
  </svg>
);

// Mic icon — recording state (stop square)
const IconMicStop = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"
    aria-hidden="true">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

// ─────────────────────────────────────────────────────────────────────────────
// THINKING BLOCK — collapsible reasoning display
// ─────────────────────────────────────────────────────────────────────────────

const ThinkingBlock = forwardRef(({ content }, ref) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div ref={ref} className={styles.thinkingBlock}>
      <button
        className={styles.thinkingToggle}
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <span className={styles.thinkingIcon}>{expanded ? '\u25BE' : '\u25B8'}</span>
        <span className={styles.thinkingLabel}>Reasoning</span>
      </button>
      {expanded && (
        <div className={styles.thinkingContent}>
          {content}
        </div>
      )}
    </div>
  );
});
ThinkingBlock.displayName = 'ThinkingBlock';

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders a single chat message in screenplay / terminal-log format.
 * Amber ▸ + amber text for user. White text for Aura (with TextScramble when streaming).
 * Animates in on mount via GSAP.
 *
 * @param {{ id, role, content, timestamp, hardware_limited?, queue_available?, task_text?, thread_id? }} message
 * @param {boolean} isStreaming — true when this message is the live SSE stream target
 * @param {{ elapsed: number, tokens: number }|null} stats     — sealed stats shown after streaming ends
 * @param {{ elapsed: number, tokens: number }|null} liveStats — live stats shown during streaming
 */
const ChatMessage = ({ message, isStreaming, stats, liveStats }) => {
  const msgRef   = useRef(null);
  const statsRef = useRef(null);
  const [queued,   setQueued]   = useState(false);
  const [queueing, setQueueing] = useState(false);

  // Entrance — runs once on mount
  useGSAP(() => {
    gsap.from(msgRef.current, {
      opacity:  0,
      y:        8,
      duration: 0.25,
      ease:     'panel-out',
      clearProps: 'transform',
    });
  }, { scope: msgRef });

  // Stats fade-in — runs when stats become available (streaming just ended)
  useEffect(() => {
    if (!stats || !statsRef.current) return;
    gsap.fromTo(statsRef.current,
      { opacity: 0 },
      { opacity: 1, duration: 0.4, ease: 'power2.out' }
    );
  }, [stats]);

  const timestamp = message.timestamp
    ? `[${new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}]`
    : null;

  const handleQueue = async () => {
    if (queueing || queued) return;
    setQueueing(true);
    try {
      const res = await fetch(`${BACKEND}/queue/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task_text: message.task_text || message.content,
          thread_id: message.thread_id || 'default',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setQueued(true);
    } catch (err) {
      console.error('[Chat] Queue task failed:', err);
    } finally {
      setQueueing(false);
    }
  };

  // ── Thinking block (collapsible reasoning) ──
  if (message.role === 'thinking') {
    return <ThinkingBlock ref={msgRef} content={message.content} />;
  }

  // ── System message ──
  if (message.role === 'system') {
    return (
      <div ref={msgRef} className={styles.msgRow}>
        <span className={styles.msgTs}>{timestamp}</span>
        <span className={styles.msgArrow}> </span>
        <span className={`${styles.msgBody} ${styles.msgBodySystem}`}>
          {message.content}
          {message.queue_available && (
            <span className={styles.msgActions}>
              {queued
                ? <span className={styles.queuedBadge}>◈ queued</span>
                : <button className={styles.queueBtn} onClick={handleQueue} disabled={queueing}>
                    {queueing ? 'queuing...' : '+ queue'}
                  </button>
              }
            </span>
          )}
        </span>
      </div>
    );
  }

  // ── Aura message ──
  if (message.role === 'aura') {
    // Strip any leaked thinking text from GGUF tokenizer edge cases
    const content = (message.content || '').replace(
      /^(?:Thinking Process:|(?:\d+\.\s+)?\*{0,2}Analyze the Request\*{0,2}:)[\s\S]*?(?=\n{2}[A-Z])/i,
      ''
    ).trim() || message.content;

    return (
      <div ref={msgRef} className={styles.msgRow}>
        <span className={styles.msgTs}>{timestamp}</span>
        <span className={styles.msgArrow}> </span>
        <span className={`${styles.msgBody} ${styles.msgBodyAura}`}>
          <TextScramble text={content} isStreaming={isStreaming} />
          {message.type === 'team_result' && (
            <span className={styles.msgActions}>
              <button
                className={styles.downloadBtn}
                onClick={() => {
                  const blob = new Blob([message.content], { type: 'text/markdown' });
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement('a');
                  a.href = url; a.download = 'team-output.md'; a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                ↓ .md
              </button>
            </span>
          )}
          {(isStreaming ? liveStats : stats) && (() => {
            const s = isStreaming ? liveStats : stats;
            const elapsedStr = s.elapsed < 60
              ? (isStreaming ? `${Math.floor(s.elapsed)}s` : `${s.elapsed.toFixed(1)}s`)
              : `${Math.floor(s.elapsed / 60)}m ${Math.round(s.elapsed % 60)}s`;
            return (
              <span
                ref={statsRef}
                className={`${styles.msgStats} ${isStreaming ? styles.msgStatsLive : ''}`}
              >
                {elapsedStr} · ↓ {s.tokens.toLocaleString()} tokens
              </span>
            );
          })()}
        </span>
      </div>
    );
  }

  // ── User message ──
  return (
    <div ref={msgRef} className={styles.msgRow}>
      <span className={styles.msgTs}>{timestamp}</span>
      <span className={`${styles.msgArrow} ${styles.msgArrowUser}`}>▸ </span>
      <span className={`${styles.msgBody} ${styles.msgBodyUser}`}>{message.content}</span>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// THINKING INDICATOR
// ─────────────────────────────────────────────────────────────────────────────

const GLYPHS  = '!<>-_\\/[]{}—=+*^?#@$%∂≈Ω░▒';
const TH_LABEL = 'PROCESSING';

/**
 * GSAP ticker scrambles chars in "PROCESSING" with random glyphs — constant noise
 * that communicates active computation without a reveal cycle.
 * Row pulses a faint amber wash via CSS.
 * Accepts liveElapsed (integer seconds) to show a ticking timer.
 */
const ThinkingIndicator = ({ visible, liveElapsed }) => {
  const ref      = useRef(null);
  const textRef  = useRef(null);
  const tickRef  = useRef(null);
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  useEffect(() => {
    if (!mounted || !ref.current) return;

    if (visible) {
      gsap.fromTo(ref.current,
        { opacity: 0, y: 6 },
        { opacity: 1, y: 0, duration: 0.22, ease: 'panel-out', clearProps: 'transform' }
      );
      // Scramble ticker — randomly flips ~40% of chars to glyphs each frame
      let frame = 0;
      const tick = () => {
        if (!textRef.current) return;
        if (++frame % 4 !== 0) return;  // throttle to ~15fps
        let out = '';
        for (let i = 0; i < TH_LABEL.length; i++) {
          out += Math.random() > 0.4
            ? TH_LABEL[i]
            : GLYPHS[Math.floor(Math.random() * GLYPHS.length)];
        }
        textRef.current.textContent = out;
      };
      gsap.ticker.add(tick);
      tickRef.current = tick;
    } else {
      if (tickRef.current) { gsap.ticker.remove(tickRef.current); tickRef.current = null; }
      gsap.to(ref.current, {
        opacity:    0,
        duration:   0.15,
        ease:       'power2.in',
        onComplete: () => setMounted(false),
      });
    }

    return () => {
      if (tickRef.current) { gsap.ticker.remove(tickRef.current); tickRef.current = null; }
    };
  }, [visible, mounted]);

  if (!mounted) return null;

  const ts = `[${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}]`;

  return (
    <div ref={ref} className={`${styles.msgRow} ${styles.msgRowThinking}`} role="status" aria-label="Aura is thinking">
      <span className={styles.msgTs}>{ts}</span>
      <span className={styles.msgArrow}> </span>
      <span className={styles.thinkingText} aria-hidden="true">
        <span ref={textRef}>{TH_LABEL}</span>
        <span className={styles.thinkingEllipsis}>...</span>
        {liveElapsed > 0 && (
          <span className={styles.thinkingElapsed}>{liveElapsed}s</span>
        )}
      </span>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// CHAT PANEL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Array}    messages      - [{id, role:'aura'|'user', content, timestamp}]
 * @param {string}   auraStatus    - 'idle'|'listening'|'thinking'|'responding'
 * @param {function} onSend        - (messageText: string) => void
 * @param {boolean}  isActive      - Whether this is the focused panel
 * @param {boolean}  isFloating    - Whether panel is popped out
 * @param {function} onFocus       - Called when panel gains focus
 * @param {function} onPopOut      - Called when pop-out button clicked
 * @param {function} onDockBack    - Called when dock-back button clicked
 * @param {Float32Array} audioData - Optional: Web Audio data for AuraIndicator VU
 */
const Chat = ({
  messages    = [],
  auraStatus  = 'idle',
  onSend,
  isActive    = false,
  isFloating  = false,
  onFocus,
  onPopOut,
  onDockBack,
  audioData,
  voiceEnabled = false,
  voiceInitiatedExternalRef,
  streamingTtsActiveRef,
  onStopTtsRegister,
  onPttRegister,
  onExternalVoiceStateRegister,
  onPrefillRegister,
}) => {
  const [inputValue,    setInputValue]    = useState('');
  const [isThinking,    setIsThinking]    = useState(false);
  const [liveElapsed,   setLiveElapsed]   = useState(0);
  // Voice state: 'idle' | 'recording' | 'transcribing' | 'speaking'
  const [voiceState,    setVoiceState]    = useState('idle');
  // Response stats: messageId → { elapsed (seconds), tokens (estimated) }
  const [messageStats,  setMessageStats]  = useState({});
  const messagesEndRef      = useRef(null);
  const inputRef            = useRef(null);
  const prevStatusRef       = useRef(auraStatus);
  const prevMsgCountRef     = useRef(messages.length);
  const thinkingStartRef    = useRef(null);
  const liveTimerRef        = useRef(null);
  const mediaRecorderRef    = useRef(null);
  const audioChunksRef      = useRef([]);
  // Track whether the current exchange was voice-initiated so we auto-speak the response
  const voiceInitiatedRef   = useRef(false);

  // ── REGISTER STOP-TTS CALLBACK ──
  // CommandCenter's stopAllAudio() handles actual audio pause + queue clear.
  // This callback just resets Chat's local voice state.
  useEffect(() => {
    if (onStopTtsRegister) {
      onStopTtsRegister(() => {
        setVoiceState('idle');
      });
    }
  }, [onStopTtsRegister]);

  // ── REGISTER EXTERNAL VOICE STATE — driven by wake_detected/session_close SSE ──
  // PTT registration happens after handleMicToggle is defined (below).
  useEffect(() => {
    if (onExternalVoiceStateRegister) {
      onExternalVoiceStateRegister((state) => setVoiceState(state));
    }
  }, [onExternalVoiceStateRegister]);

  // ── LIVE ELAPSED TIMER — starts on thinking, runs through responding ──
  useEffect(() => {
    if (auraStatus === 'thinking') {
      setLiveElapsed(0);
      thinkingStartRef.current = Date.now();
      if (liveTimerRef.current) clearInterval(liveTimerRef.current);
      liveTimerRef.current = setInterval(() => setLiveElapsed(s => s + 1), 1000);
    } else if (auraStatus !== 'responding' && liveTimerRef.current) {
      clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    return () => {
      if (liveTimerRef.current) { clearInterval(liveTimerRef.current); liveTimerRef.current = null; }
    };
  }, [auraStatus]);

  // ── THINKING STATE + SEAL STATS — track status transitions ──
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = auraStatus;

    if (auraStatus === 'thinking' && prev !== 'thinking') setIsThinking(true);
    if (prev === 'thinking' && auraStatus !== 'thinking') setIsThinking(false);

    // Seal stats when responding finishes (responding → anything else)
    if (prev === 'responding' && auraStatus !== 'responding') {
      const elapsed = thinkingStartRef.current
        ? (Date.now() - thinkingStartRef.current) / 1000
        : null;
      thinkingStartRef.current = null;
      if (elapsed !== null && messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last.role === 'aura' && last.id != null) {
          const tokens = Math.round((last.content?.length ?? 0) / 4);
          setMessageStats(p => ({ ...p, [last.id]: { elapsed, tokens } }));
        }
      }
    }
  }, [auraStatus, messages]);

  // ── AUTO-SCROLL — when new messages arrive ──
  useLayoutEffect(() => {
    const prevCount = prevMsgCountRef.current;
    prevMsgCountRef.current = messages.length;

    if (messages.length > prevCount && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length]);

  // ── AUTO-SCROLL — during streaming (content grows without message count changing) ──
  const lastMsgContent = messages.length > 0 ? messages[messages.length - 1].content : '';
  useLayoutEffect(() => {
    if (auraStatus === 'responding' && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'instant', block: 'end' });
    }
  }, [lastMsgContent, auraStatus]);

  // TTS PLAYBACK — now handled by CommandCenter's centralized audio controller.
  // Backend emits audio_chunk SSE events per-sentence during token streaming.
  // CommandCenter receives them and plays via a single ordered queue.
  // voiceInitiatedRef is still used by the mic toggle below to mark voice-initiated exchanges.

  // ── Mic button: start / stop recording ──────────────────────────────────
  // Phase 2 note: wake_detected / voice_transcribed / stop_tts SSE events will route
  // through the main useAuraStream hook (CommandCenter) when voice layer is built.
  // The standalone EventSource was removed — it competed with the main stream on the
  // backend's single-consumer asyncio.Queue, causing random token loss.
  const handleMicToggle = useCallback(async () => {
    if (voiceState === 'recording') {
      // Stop recording → transcribe
      if (mediaRecorderRef.current?.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      return;
    }

    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        setVoiceState('transcribing');

        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType });
        const form = new FormData();
        form.append('audio', blob, 'utterance.webm');

        try {
          const res  = await fetch(`${BACKEND}/voice/transcribe`, { method: 'POST', body: form });
          if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
            const reason = err.detail || 'Transcription failed';
            console.warn('[Chat] transcribe error:', reason);
            // Surface error in chat as a system message
            if (onSend) {
              onSend(`⚠ Voice input unavailable — ${reason}`);
            }
          } else {
            const data = await res.json();
            if (data.text && onSend) {
              // Auto-submit the transcribed text and mark as voice-initiated
              voiceInitiatedRef.current = true;
              onSend(data.text);
            }
          }
        } catch (err) {
          console.warn('[Chat] transcribe fetch error:', err);
          if (onSend) {
            onSend('⚠ Voice input unavailable — network error');
          }
        }
        setVoiceState('idle');
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setVoiceState('recording');
    } catch (err) {
      console.warn('[Chat] mic access error:', err);
      setVoiceState('idle');
    }
  }, [voiceState]);

  // ── REGISTER PTT CALLBACK — Ctrl+Alt+Space from Electron triggers mic toggle ──
  useEffect(() => {
    if (onPttRegister) {
      onPttRegister(handleMicToggle);
    }
  }, [onPttRegister, handleMicToggle]);

  // ── REGISTER PREFILL CALLBACK — allows CommandCenter to pre-fill the input
  //    (e.g. when routing a "Revise draft" prompt from the DraftReview modal) ──
  useEffect(() => {
    if (onPrefillRegister) {
      onPrefillRegister((text) => {
        setInputValue(text);
        inputRef.current?.focus();
      });
    }
  }, [onPrefillRegister]);

  // ── SEND MESSAGE ──
  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || !onSend) return;
    onSend(text);
    setInputValue('');
    // Return focus to input after send
    inputRef.current?.focus();
  }, [inputValue, onSend]);

  // ── KEYBOARD — Enter to send, Shift+Enter for newline ──
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  // ── TEXTAREA AUTO-RESIZE ──
  const handleInputChange = useCallback((e) => {
    const el = e.target;
    setInputValue(el.value);
    // Reset height then grow to fit content
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, []);

  // ── PANEL HEADER — AuraIndicator lives here ──
  const headerExtra = (
    <AuraIndicator
      status={auraStatus}
      showLabel
      size="sm"
      audioData={audioData}
    />
  );

  return (
    <Panel
      title="Aura"
      headerExtra={headerExtra}
      isActive={isActive}
      isFloating={isFloating}
      onFocus={onFocus}
      onPopOut={onPopOut}
      onDockBack={onDockBack}
      collapsible={false}  /* Chat should never collapse — it's always present */
      footer={
        /* ── INPUT BAR — lives in Panel footer slot ── */
        <div className={styles.inputBar}>
          <textarea
            ref={inputRef}
            className={styles.input}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Message Aura..."
            rows={1}
            aria-label="Message input"
            disabled={auraStatus === 'thinking'}
          />
          {/* Mic button */}
          <button
            className={[
              styles.micBtn,
              voiceState === 'recording'    && styles.micBtnRecording,
              voiceState === 'transcribing' && styles.micBtnTranscribing,
              voiceState === 'speaking'     && styles.micBtnSpeaking,
            ].filter(Boolean).join(' ')}
            onClick={handleMicToggle}
            disabled={auraStatus === 'thinking' || voiceState === 'transcribing' || voiceState === 'speaking'}
            aria-label={voiceState === 'recording' ? 'Stop recording' : 'Start voice input'}
            title={
              voiceState === 'recording'    ? 'Recording — click to stop' :
              voiceState === 'transcribing' ? 'Transcribing...' :
              voiceState === 'speaking'     ? 'Aura is speaking' :
              'Voice input'
            }
          >
            {voiceState === 'recording' ? <IconMicStop /> : <IconMic />}
          </button>
          <button
            className={styles.sendBtn}
            onClick={handleSend}
            disabled={!inputValue.trim() || auraStatus === 'thinking'}
            aria-label="Send message"
          >
            <IconSend />
          </button>
        </div>
      }
    >
      {/* ── MESSAGE LIST ── */}
      <div
        className={styles.chat}
        role="log"
        aria-label="Conversation with Aura"
        aria-live="polite"
        aria-relevant="additions"
      >
        <div className={styles.messages}>
          {messages.map((msg, index) => {
            // Insert date divider when day changes
            const showDivider = index > 0 &&
              msg.timestamp &&
              messages[index - 1].timestamp &&
              new Date(msg.timestamp).toDateString() !==
              new Date(messages[index - 1].timestamp).toDateString();

            return (
              <div key={msg.id ?? index}>
                {showDivider && (
                  <div className={styles.divider}>
                    <span className={styles.dividerLabel}>
                      {new Date(msg.timestamp).toLocaleDateString([], {
                        weekday: 'long', month: 'short', day: 'numeric'
                      })}
                    </span>
                  </div>
                )}
                {(() => {
                  const isStreamingMsg =
                    auraStatus === 'responding' &&
                    index === messages.length - 1 &&
                    msg.role === 'aura';
                  const liveTokens = isStreamingMsg
                    ? Math.round((msg.content?.length ?? 0) / 4)
                    : 0;
                  return (
                    <ChatMessage
                      message={msg}
                      isStreaming={isStreamingMsg}
                      stats={msg.role === 'aura' && msg.id != null ? messageStats[msg.id] ?? null : null}
                      liveStats={isStreamingMsg && liveElapsed > 0
                        ? { elapsed: liveElapsed, tokens: liveTokens }
                        : null}
                    />
                  );
                })()}
              </div>
            );
          })}

          {/* Thinking indicator — appears after last message */}
          <ThinkingIndicator visible={isThinking} liveElapsed={liveElapsed} />

          {/* Scroll anchor */}
          <div ref={messagesEndRef} className={styles.scrollAnchor} aria-hidden="true" />
        </div>
      </div>
    </Panel>
  );
};

export default Chat;
