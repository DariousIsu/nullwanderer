/**
 * AURA NX-Alpha — useAuraStream
 *
 * SSE (Server-Sent Events) hook. Connects to the Aura backend stream endpoint
 * and dispatches all 26 event types to their appropriate UI handlers.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   const { status, reconnect, disconnect } = useAuraStream(url, handlers);
 *
 *   // Dev / test — inject MockEventSource instead of the real one:
 *   const factory = createMockFactory(DEMO_SEQUENCE);
 *   const { status } = useAuraStream(null, handlers, { eventSourceFactory: factory });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HANDLERS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   ── Core conversation ────────────────────────────────────────────────────
 *
 *   onToken(data)                  — Streaming token. Append to in-progress chat message.
 *                                    data: { type, text: str }
 *
 *   onTeamGatePrompt(data)         — Team task detected but gate is closed.
 *                                    data: { type, message: str }
 *
 *   onTeamDispatched(data)         — Full team pipeline approved and dispatched.
 *                                    data: { type, plan: ExecutionPlan }
 *
 *   onAgentUpdate(data)            — Sprint agent status/progress changed.
 *                                    data: { type, agent_id: str, area_id: str,
 *                                            status: str, summary?: str }
 *
 *   ── Canvas ───────────────────────────────────────────────────────────────
 *
 *   onRenderCanvas(data)           — Render full deliverable on the canvas.
 *                                    data: { type, blocks: ContentBlock[], title: str }
 *
 *   onRenderCanvasPreview(data)    — Interface Agent preview (1–3 blocks inline).
 *                                    data: { type, blocks: ContentBlock[], title: str, preview: true }
 *                                    [GRAFT: AionUi — §23.1]
 *
 *   onCanvasClear(data)            — Clear all canvas blocks (new conversation thread).
 *                                    data: { type }
 *
 *   ── Popups / interrupts ──────────────────────────────────────────────────
 *
 *   onPendingApproval(data)        — Aura wants to run a tool, needs user approval.
 *                                    data: { type, tool: str, description?: str }
 *
 *   onExternalAlert(data)          — Proactive mode alert.
 *                                    data: { type, severity: 'info'|'warning'|'critical',
 *                                            title?: str, message?: str }
 *
 *   ── Study Mode ───────────────────────────────────────────────────────────
 *
 *   onStudyModeOpen(data)          — Study Mode activated — open study prompt UI.
 *                                    data: { type, suggested_category_path: str | null }
 *
 *   onStudyProgress(data)          — Study sprint completed.
 *                                    data: { type, sprints_done: int, facts_ingested: int,
 *                                            category_path: str }
 *
 *   ── Storage Governor ─────────────────────────────────────────────────────
 *
 *   onStorageUpdate(data)          — Storage monitor tick (every 60s).
 *                                    data: { type, component: str, used_gb: float,
 *                                            quota_gb: float, pct: float }
 *
 *   onStorageWarning(data)         — Storage at 85% quota.
 *                                    data: { type, component: str, pct: 85.0, message: str }
 *
 *   onStorageLimitReached(data)    — Storage at 100% quota.
 *                                    data: { type, component: str, eviction_pending: bool }
 *
 *   ── Voice Layer [Phase 2+] ────────────────────────────────────────────────
 *
 *   onAudioChunk(data)             — TTS streaming audio chunk.
 *                                    data: { type, data: str (base64), format: 'wav', seq: int }
 *
 *   onAudioEnd(data)               — TTS stream complete.
 *                                    data: { type, seq_total: int }
 *
 *   onVoiceProfileReady(data)      — VoiceGenerator setup complete.
 *                                    data: { type, profile_path: str }
 *
 *   ── Ambient / MOSS-TTSD [Phase 3+] ───────────────────────────────────────
 *
 *   onAmbientSound(data)           — Mode transition audio cue.
 *                                    data: { type, sound_id: str, loop: bool, volume: float }
 *
 *   onCanvasNarrationStart(data)   — MOSS-TTSD begins narrating a canvas deliverable.
 *                                    data: { type, block_count: int }
 *
 *   onCanvasNarrationChunk(data)   — MOSS-TTSD streaming narration audio.
 *                                    data: { type, block_index: int, data: str (base64),
 *                                            format: 'wav' }
 *
 *   ── System ───────────────────────────────────────────────────────────────
 *
 *   onSystemNotification(data)     — Background service notification (e.g. CLI installed).
 *                                    data: { type, type: str, message: str, data: object }
 *
 *   onStreamError(data)            — Backend reported a stream error.
 *                                    data: { type, message: str, code?: str }
 *
 *   onEnd(data)                    — Stream completed cleanly.
 *                                    data: { type, reason?: str }
 *
 *   ── No-ops (removed from scope) ──────────────────────────────────────────
 *
 *   onAvatarState(data)            — (no-op — avatar/THREE.js stage removed from scope)
 *   onRingUpdate(data)             — (no-op — ring layer removed from scope)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONNECTION STATUS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   'idle'         — No URL provided. Stream not attempted.
 *   'connecting'   — EventSource being created / waiting for open.
 *   'connected'    — EventSource open, receiving events.
 *   'disconnected' — Connection dropped. Auto-reconnect pending or exhausted.
 *   'error'        — Fatal error or max retries exceeded.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * AUTO-RECONNECT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Exponential backoff starting at 1s, max 30s, up to 10 attempts.
 *   Resets on successful connection.
 *   Manual `reconnect()` resets the counter and retries immediately.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * OPTIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   eventSourceFactory — Constructor used instead of the global `EventSource`.
 *                        Primarily for testing and dev mock injection.
 *                        Must implement the EventSource interface:
 *                          new Factory(url) → { onopen, onmessage, onerror,
 *                            addEventListener(type, fn), close(), readyState }
 */

import { useState, useEffect, useRef, useCallback } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

export const STREAM_STATUS = Object.freeze({
  IDLE:         'idle',
  CONNECTING:   'connecting',
  CONNECTED:    'connected',
  DISCONNECTED: 'disconnected',
  ERROR:        'error',
});

/** All 26 event type strings the backend may emit (§10 SSE Contract). */
export const EVENT_TYPES = Object.freeze([
  // Core conversation
  'thinking',
  'token',
  'team_gate_prompt',
  'team_dispatched',
  'team_result',
  'pm_clarification',
  'agent_update',
  // Canvas
  'render_canvas',
  'render_canvas_preview',
  'canvas_clear',
  // Popups / interrupts
  'pending_approval',
  'external_alert',
  // Voice control events
  'wake_detected',
  'voice_transcribed',
  'session_close',
  'stop_tts',
  // Study Mode
  'study_mode_open',
  'study_progress',
  // Storage Governor
  'storage_update',
  'storage_warning',
  'storage_limit_reached',
  // Voice Layer [Phase 2+]
  'audio_chunk',
  'audio_end',
  'voice_profile_ready',
  // Ambient / MOSS-TTSD [Phase 3+]
  'ambient_sound',
  'canvas_narration_start',
  'canvas_narration_chunk',
  // System
  'system_notification',
  'error',
  'end',
  // Hardware / queue
  'hardware_mode',
  'model_status',
  'boot_audio',
  'queue_draining',
  'queue_drained',
  // Knowledge DB
  'knowledge_ingested',
  // Adversarial Trainer — live turn events
  'at_question',
  'at_answer',
  'at_judgment',
  'at_stored',
  'at_progress',
  'at_complete',
  // Legislation
  'leg_import_progress',
  'legislation_update',
  // Custom agents
  'agent_run_start',
  'agent_run_complete',
  // Activity monitoring
  'activity_vision',
  'activity_browser',
  'activity_file',
  // No-ops (removed from scope — silent)
  'avatar_state',
  'ring_update',
]);

/**
 * Maps SSE event type string → handler key on the handlers object.
 * 'error' → 'onStreamError' (avoids clashing with the JS Error type name).
 */
const HANDLER_MAP = {
  // Core conversation
  thinking:               'onThinking',
  token:                  'onToken',
  team_gate_prompt:       'onTeamGatePrompt',
  team_dispatched:        'onTeamDispatched',
  team_result:            'onTeamResult',
  pm_clarification:       'onPmClarification',
  agent_update:           'onAgentUpdate',
  // Canvas
  render_canvas:          'onRenderCanvas',
  render_canvas_preview:  'onRenderCanvasPreview',
  canvas_clear:           'onCanvasClear',
  // Popups / interrupts
  pending_approval:       'onPendingApproval',
  external_alert:         'onExternalAlert',
  // Voice control events
  wake_detected:          'onWakeDetected',
  voice_transcribed:      'onVoiceTranscribed',
  session_close:          'onSessionClose',
  stop_tts:               'onStopTts',
  // Study Mode
  study_mode_open:        'onStudyModeOpen',
  study_progress:         'onStudyProgress',
  // Storage Governor
  storage_update:         'onStorageUpdate',
  storage_warning:        'onStorageWarning',
  storage_limit_reached:  'onStorageLimitReached',
  // Voice Layer [Phase 2+]
  audio_chunk:            'onAudioChunk',
  audio_end:              'onAudioEnd',
  voice_profile_ready:    'onVoiceProfileReady',
  // Ambient / MOSS-TTSD [Phase 3+]
  ambient_sound:          'onAmbientSound',
  canvas_narration_start: 'onCanvasNarrationStart',
  canvas_narration_chunk: 'onCanvasNarrationChunk',
  // System
  system_notification:    'onSystemNotification',
  error:                  'onStreamError',
  end:                    'onEnd',
  // Hardware / queue
  hardware_mode:          'onHardwareMode',
  model_status:           'onModelStatus',
  boot_audio:             'onBootAudio',
  queue_draining:         'onQueueDraining',
  queue_drained:          'onQueueDrained',
  // Knowledge DB
  knowledge_ingested:     'onKnowledgeIngested',
  // HuggingFace / LLMFit downloads
  hf_download_progress:   'onHfDownloadProgress',
  hf_download_complete:   'onHfDownloadComplete',
  hf_download_error:      'onHfDownloadError',
  // Adversarial Trainer — live turn events
  at_question:            'onAtQuestion',
  at_answer:              'onAtAnswer',
  at_judgment:            'onAtJudgment',
  at_stored:              'onAtStored',
  at_progress:            'onAtProgress',
  at_complete:            'onAtComplete',
  // Legislation
  leg_import_progress:    'onLegImportProgress',
  legislation_update:     'onLegislationUpdate',
  // Custom agents
  agent_run_start:        'onAgentRunStart',
  agent_run_complete:     'onAgentRunComplete',
  // Todo / task tracking
  todo_update:            'onTodoUpdate',
  // Activity monitoring
  activity_vision:        'onActivityVision',
  activity_browser:       'onActivityBrowser',
  activity_file:          'onActivityFile',
  // No-ops (removed from scope)
  avatar_state:           'onAvatarState',
  ring_update:            'onRingUpdate',
};

/** Silent no-ops — expected to have no handler registered. */
const SILENT_NOOPS = new Set([
  'avatar_state', 'ring_update', 'heartbeat',
  // Adversarial Trainer events — handled by AdversarialTrainerPanel's own stream subscription.
  'at_question', 'at_answer', 'at_judgment', 'at_stored', 'at_progress', 'at_complete',
]);

const BASE_BACKOFF_MS = 1000;   // 1s initial backoff
const MAX_BACKOFF_MS  = 30000;  // 30s cap
const MAX_RETRIES     = 10;

// ─────────────────────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string|null}  url      — SSE endpoint URL. Pass null to stay idle.
 * @param {object}       handlers — Event handler functions (see HANDLERS above).
 * @param {object}       options
 * @param {Function}     [options.eventSourceFactory] — EventSource replacement for testing.
 */
function useAuraStream(url, handlers = {}, options = {}) {
  const { eventSourceFactory } = options;

  const [status,        setStatus]        = useState(STREAM_STATUS.IDLE);
  const [connectSignal, setConnectSignal] = useState(0); // increment to force reconnect

  // Stable refs — updated each render without triggering effects
  const handlersRef = useRef(handlers);
  const esRef       = useRef(null);
  const retryRef    = useRef({ count: 0, timer: null });
  const mountedRef  = useRef(true);

  useEffect(() => { handlersRef.current = handlers; });

  // Resolve the EventSource constructor to use
  const ESClass = eventSourceFactory
    ?? (typeof EventSource !== 'undefined' ? EventSource : null);

  // ── DISPATCH — route an event to its registered handler ──
  const dispatch = useCallback((type, data) => {
    const handlerKey = HANDLER_MAP[type];

    if (handlerKey && typeof handlersRef.current[handlerKey] === 'function') {
      try {
        handlersRef.current[handlerKey](data);
      } catch (err) {
        console.error(`[useAuraStream] Handler "${handlerKey}" threw an error:`, err);
      }
      return;
    }

    // Dev: warn on unrecognized types (except known no-ops)
    if (
      process.env.NODE_ENV === 'development' &&
      !SILENT_NOOPS.has(type) &&
      handlerKey
    ) {
      console.debug(
        `[useAuraStream] No handler registered for "${type}" (expected: handlers.${handlerKey})`,
        data
      );
    }
  }, []); // stable — reads handlersRef

  // ── MAIN CONNECT EFFECT ──
  useEffect(() => {
    mountedRef.current = true;

    if (!url || !ESClass) {
      setStatus(STREAM_STATUS.IDLE);
      return () => { mountedRef.current = false; };
    }

    // ── Close any existing connection ──
    clearTimeout(retryRef.current.timer);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    setStatus(STREAM_STATUS.CONNECTING);

    let es;
    try {
      es = new ESClass(url);
      esRef.current = es;
    } catch (err) {
      console.error('[useAuraStream] Failed to create EventSource:', err);
      setStatus(STREAM_STATUS.ERROR);
      return () => { mountedRef.current = false; };
    }

    // ── Connection opened ──
    es.onopen = () => {
      if (!mountedRef.current) return;
      retryRef.current.count = 0;
      setStatus(STREAM_STATUS.CONNECTED);
      if (process.env.NODE_ENV === 'development') {
        console.info('[useAuraStream] Connected to:', url);
      }
    };

    // ── Unnamed message events — type comes from JSON payload's `type` field ──
    // Handles: data: {"type":"token","content":"..."}  (no `event:` line)
    es.onmessage = (evt) => {
      if (!mountedRef.current) return;
      try {
        const data = JSON.parse(evt.data);
        if (data.type) dispatch(data.type, data);
      } catch {
        if (process.env.NODE_ENV === 'development') {
          console.debug('[useAuraStream] Could not parse message:', evt.data);
        }
      }
    };

    // ── Named event listeners — handles: event: token\ndata: {...} ──
    // These fire instead of onmessage when the server sends a named event field.
    EVENT_TYPES.forEach(type => {
      es.addEventListener(type, (evt) => {
        if (!mountedRef.current) return;
        try {
          const payload = JSON.parse(evt.data);
          // Ensure `type` is always present on the data object
          dispatch(type, { ...payload, type });
        } catch {
          dispatch(type, { type, raw: evt.data });
        }
      });
    });

    // ── Connection error / closed ──
    es.onerror = () => {
      if (!mountedRef.current) return;

      if (es.readyState === 2 /* CLOSED */) {
        setStatus(STREAM_STATUS.DISCONNECTED);

        const attempt = retryRef.current.count;
        if (attempt < MAX_RETRIES) {
          const delay = Math.min(BASE_BACKOFF_MS * (2 ** attempt), MAX_BACKOFF_MS);
          retryRef.current.count = attempt + 1;

          if (process.env.NODE_ENV === 'development') {
            console.info(
              `[useAuraStream] Disconnected. Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
            );
          }

          retryRef.current.timer = setTimeout(() => {
            if (mountedRef.current) {
              // Trigger a reconnect by bumping the signal
              setConnectSignal(s => s + 1);
            }
          }, delay);

        } else {
          setStatus(STREAM_STATUS.ERROR);
          console.warn('[useAuraStream] Max reconnect attempts reached. Call reconnect() to retry manually.');
        }

      } else {
        // readyState 0 (CONNECTING) or 1 (OPEN) with an error — transient, browser will retry
        setStatus(STREAM_STATUS.ERROR);
      }
    };

    // ── Cleanup on url change / unmount ──
    return () => {
      mountedRef.current = false;
      clearTimeout(retryRef.current.timer);
      if (es) {
        es.close();
        esRef.current = null;
      }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, connectSignal]); // ESClass and dispatch are stable

  // ── MANUAL RECONNECT — resets backoff, fires immediately ──
  const reconnect = useCallback(() => {
    retryRef.current.count = 0;
    setConnectSignal(s => s + 1);
  }, []);

  // ── MANUAL DISCONNECT — closes and stays idle ──
  const disconnect = useCallback(() => {
    clearTimeout(retryRef.current.timer);
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    setStatus(STREAM_STATUS.DISCONNECTED);
  }, []);

  return { status, reconnect, disconnect };
}

export default useAuraStream;
