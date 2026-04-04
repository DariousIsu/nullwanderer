/**
 * AURA NX-Alpha — mockStream
 *
 * Development / testing utilities for useAuraStream.
 *
 * Provides a MockEventSource class that implements the browser EventSource API
 * but fires events from a predefined in-memory sequence instead of a real SSE
 * connection. Use this to develop and test the full UI pipeline without a backend.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE IN App.jsx (dev mode)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   import useAuraStream from '../hooks/useAuraStream';
 *   import { createMockFactory, DEMO_SEQUENCE } from '../hooks/mockStream';
 *
 *   const streamUrl = process.env.NODE_ENV === 'development'
 *     ? 'mock://aura'          // non-null triggers the hook; MockFactory ignores the URL
 *     : 'https://api/stream';
 *
 *   const mockFactory = process.env.NODE_ENV === 'development'
 *     ? createMockFactory(DEMO_SEQUENCE, { intervalMs: 1800 })
 *     : undefined;
 *
 *   const { status } = useAuraStream(streamUrl, handlers, {
 *     eventSourceFactory: mockFactory,
 *   });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MOCK EVENT FORMAT
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Each event in a sequence is a plain object with a `type` field matching
 *   one of the 26 EVENT_TYPES. All other fields are the event payload,
 *   shaped to match the Bible §10 SSE Contract exactly.
 *
 *   { type: 'token', text: 'Hello' }
 *   { type: 'render_canvas', blocks: [{ type: 'metric_card', value: '42%' }], title: 'Result' }
 *   { type: 'end' }
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEMO_SEQUENCE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   A realistic multi-step job simulation that exercises every major UI path:
 *     1. Token stream  → chat sidebar streaming response
 *     2. team_dispatched → AgentMonitor panel
 *     3. agent_update  → agent progress rows
 *     4. render_canvas (metric_card, chart, heading, callout) → Canvas blocks
 *     5. pending_approval → WarningPopup amber interrupt
 *     6. external_alert (critical) → WarningPopup red interrupt
 *     7. self_care_handoff → WarningPopup self-care interrupt
 *     8. end            → stream closed
 */

// ─────────────────────────────────────────────────────────────────────────────
// MOCK EVENT SOURCE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for the browser's EventSource API.
 * Fires events from a sequence at a configurable interval.
 *
 * Implements: onopen, onmessage, onerror, addEventListener, close, readyState
 */
export class MockEventSource {
  static CONNECTING = 0;
  static OPEN       = 1;
  static CLOSED     = 2;

  constructor(url, sequence = [], intervalMs = 1500) {
    this.url       = url;
    this.readyState = MockEventSource.CONNECTING;
    this.onopen    = null;
    this.onmessage = null;
    this.onerror   = null;

    this._listeners = {};   // { eventType: [fn, ...] }
    this._sequence  = sequence;
    this._intervalMs = intervalMs;
    this._timer     = null;
    this._index     = 0;
    this._closed    = false;

    // Simulate async open — same tick delay as a real network connection
    setTimeout(() => {
      if (this._closed) return;
      this.readyState = MockEventSource.OPEN;
      this.onopen?.({ type: 'open' });
      this._startPlayback();
    }, 120);
  }

  addEventListener(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }

  removeEventListener(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(f => f !== fn);
  }

  close() {
    this._closed    = true;
    this.readyState = MockEventSource.CLOSED;
    clearTimeout(this._timer);
    this._timer = null;
  }

  // ── Programmatically emit a single event (for test harnesses) ──
  emit(type, payload = {}) {
    if (this._closed) return;
    const data = JSON.stringify({ type, ...payload });

    // Match real EventSource behavior:
    //   - Named events (event: token) fire ONLY addEventListener('token', ...)
    //   - Unnamed events (no event: line) fire ONLY onmessage
    // The previous implementation fired BOTH, causing every handler to run twice.
    const namedListeners = this._listeners[type] ?? [];
    if (namedListeners.length > 0) {
      namedListeners.forEach(fn => {
        try { fn({ type, data }); } catch { /* swallow */ }
      });
    } else {
      // No named listener registered — fall back to onmessage (unnamed event)
      try { this.onmessage?.({ type: 'message', data }); } catch { /* swallow */ }
    }
  }

  // ── Internal playback loop ──
  _startPlayback() {
    if (this._closed || this._index >= this._sequence.length) return;

    const fire = () => {
      if (this._closed || this._index >= this._sequence.length) return;

      const event = this._sequence[this._index++];
      this.emit(event.type, event);

      if (this._index < this._sequence.length) {
        // Use per-event delay if provided, otherwise default interval
        const delay = event._delay ?? this._intervalMs;
        this._timer = setTimeout(fire, delay);
      }
    };

    this._timer = setTimeout(fire, this._intervalMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FACTORY HELPER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns an eventSourceFactory compatible with useAuraStream's options.
 *
 * @param {object[]} sequence   — Array of event objects to fire in order.
 * @param {object}   opts
 * @param {number}   opts.intervalMs — Default delay between events (ms). Default 1500.
 *
 * @returns {Function} — Constructor function: `new Factory(url)` → MockEventSource
 */
export function createMockFactory(sequence, { intervalMs = 1500 } = {}) {
  return function MockEventSourceFactory(url) {
    return new MockEventSource(url, sequence, intervalMs);
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK EVENT BUILDERS
// Quick constructors for each event type. Use in custom sequences.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bible §10-aligned event builders.
 * Field names match the backend SSE contract exactly so handlers work
 * identically against mock and live data.
 */
export const MOCK_EVENT = {
  // Bible §10: { text: str }  (NOT content)
  token: (text, messageId = 'msg-1') =>
    ({ type: 'token', text, messageId }),

  // Bible §10: { plan: ExecutionPlan }
  teamDispatched: (task, agents = []) => ({
    type: 'team_dispatched',
    plan: {
      teamId:  `team-${Date.now()}`,
      task,
      agents,
    },
  }),

  // Bible §10: { agent_id: str, area_id: str, status: str, summary?: str }
  agentUpdate: (agent_id, status, summary = '', area_id = 'main') =>
    ({ type: 'agent_update', agent_id, area_id, status, summary }),

  // Bible §10: { blocks: ContentBlock[], title: str }
  renderCanvas: (block, title = '') =>
    ({ type: 'render_canvas', blocks: [block], title }),

  // Bible §10: { blocks: ContentBlock[], title: str, preview: true }  [GRAFT: AionUi]
  renderCanvasPreview: (blocks, title = '') =>
    ({ type: 'render_canvas_preview', blocks, title, preview: true }),

  canvasClear: () =>
    ({ type: 'canvas_clear' }),

  pendingApproval: (tool, description) =>
    ({ type: 'pending_approval', tool, description }),

  externalAlert: (severity, title, message) =>
    ({ type: 'external_alert', severity, title, message }),

  // Bible §10: { handoff_id: str, checkpoint_count: int }
  selfCareHandoff: (checkpoint_count = 3, handoff_id = `handoff-${Date.now()}`) =>
    ({ type: 'self_care_handoff', checkpoint_count, handoff_id }),

  // Study Mode
  studyModeOpen: (suggested_category_path = null) =>
    ({ type: 'study_mode_open', suggested_category_path }),
  studyProgress: (sprints_done, facts_ingested, category_path) =>
    ({ type: 'study_progress', sprints_done, facts_ingested, category_path }),

  // Team gate
  teamGatePrompt: (message = 'Team Functions are disabled. Enable them in Settings → General.') =>
    ({ type: 'team_gate_prompt', message }),

  // Storage
  storageUpdate: (component, used_gb, quota_gb, pct) =>
    ({ type: 'storage_update', component, used_gb, quota_gb, pct }),

  // System
  systemNotification: (notifType, message, data = {}) =>
    ({ type: 'system_notification', type: notifType, message, data }),

  streamError: (message, code = 'STREAM_ERROR') =>
    ({ type: 'error', code, message }),

  end: (reason = 'completed') =>
    ({ type: 'end', reason }),
};

// ─────────────────────────────────────────────────────────────────────────────
// DEMO SEQUENCE
// A realistic full-session simulation. Exercises every major UI path.
// Intervals: _delay overrides the factory's default intervalMs per event.
// ─────────────────────────────────────────────────────────────────────────────

export const DEMO_SEQUENCE = [

  // ── 1. AURA initial response tokens ──
  // Bible §10: { text: str }
  { ...MOCK_EVENT.token("I've received your request. "),             _delay: 300  },
  { ...MOCK_EVENT.token("Let me dispatch a team to work on this."),  _delay: 400  },
  { ...MOCK_EVENT.token(" Analyzing Q1 data now..."),                _delay: 500  },

  // ── 2. TEAM DISPATCHED → AgentMonitor panel ──
  // Bible §10: { plan: ExecutionPlan }
  {
    ...MOCK_EVENT.teamDispatched('Q1 Revenue Analysis', [
      { id: 'agent-1', name: 'DataAgent',    task: 'Data Retrieval'     },
      { id: 'agent-2', name: 'AnalystAgent', task: 'Financial Analysis' },
      { id: 'agent-3', name: 'WriterAgent',  task: 'Report Generation'  },
    ]),
    _delay: 800,
  },

  // ── 3. AGENT UPDATES — progress through the job ──
  // Bible §10: { agent_id, area_id, status, summary }
  { ...MOCK_EVENT.agentUpdate('agent-1', 'working',  'Fetching Q1 ledger data…'),   _delay: 1200 },
  { ...MOCK_EVENT.agentUpdate('agent-2', 'working',  'Running variance analysis…'), _delay: 1400 },
  { ...MOCK_EVENT.agentUpdate('agent-1', 'done',     'Data retrieved: 4,820 rows'), _delay: 1000 },
  { ...MOCK_EVENT.agentUpdate('agent-2', 'working',  'Identifying growth drivers…'), _delay: 1200 },

  // ── 4a. CANVAS BLOCK — Heading ──
  // Bible §10: { blocks: ContentBlock[], title: str }
  {
    ...MOCK_EVENT.renderCanvas(
      { type: 'heading', level: 1, text: 'Q1 2026 — Revenue Analysis' },
      'Q1 Revenue Analysis'
    ),
    _delay: 1000,
  },

  // ── 4b. CANVAS BLOCK — Metric cards ──
  {
    ...MOCK_EVENT.renderCanvas(
      { type: 'metric_card', label: 'Total Revenue', value: '$4.2M', delta: '+18%', trend: 'up' },
      ''
    ),
    _delay: 800,
  },
  {
    ...MOCK_EVENT.renderCanvas(
      { type: 'metric_card', label: 'Operating Margin', value: '31.4%', delta: '+2.8pp', trend: 'up' },
      ''
    ),
    _delay: 400,
  },

  // ── 4c. CANVAS BLOCK — Chart ──
  {
    ...MOCK_EVENT.renderCanvas({
      type:      'chart',
      title:     'Revenue by Month',
      chartType: 'bar',
      data: [
        { name: 'Jan', value: 1240000 },
        { name: 'Feb', value: 1380000 },
        { name: 'Mar', value: 1590000 },
      ],
    }, 'Revenue by Month'),
    _delay: 900,
  },

  // ── 4d. AGENT UPDATE — writer starting ──
  { ...MOCK_EVENT.agentUpdate('agent-3', 'working',  'Drafting executive summary…'), _delay: 1000 },
  { ...MOCK_EVENT.agentUpdate('agent-2', 'done',     'Analysis complete'),           _delay: 800  },

  // ── 4e. CANVAS BLOCK — Callout ──
  {
    ...MOCK_EVENT.renderCanvas({
      type:  'callout',
      tone:  'blue',
      title: 'Key Driver',
      body:  'EMEA subscription growth (+34%) accounted for 60% of the revenue increase, outperforming the APAC expansion forecast by 12 points.',
    }, ''),
    _delay: 1000,
  },

  // ── 5. PENDING APPROVAL interrupt (WarningPopup — amber) ──
  {
    ...MOCK_EVENT.pendingApproval(
      'send_report_email',
      'Send Q1 analysis to finance@company.com and board@company.com'
    ),
    _delay: 1400,
  },

  // Small gap after approval pop-up fires
  { ...MOCK_EVENT.agentUpdate('agent-3', 'done', 'Summary drafted'), _delay: 600 },

  // ── 6. EXTERNAL ALERT (WarningPopup — critical/red) ──
  {
    ...MOCK_EVENT.externalAlert(
      'critical',
      'Data Pipeline Stalled',
      'The finance data feed has not updated in 47 minutes. Manual verification may be required.'
    ),
    _delay: 2000,
  },

  // ── 7. SELF CARE HANDOFF (WarningPopup — amber/self-care) ──
  // Bible §10: { checkpoint_count: int, handoff_id: str }
  {
    ...MOCK_EVENT.selfCareHandoff(3),
    _delay: 3000,
  },

  // ── 8. END ──
  { ...MOCK_EVENT.end('completed'), _delay: 2000 },
];

// ─────────────────────────────────────────────────────────────────────────────
// ISOLATED SEQUENCES — test specific UI paths without the full demo
// ─────────────────────────────────────────────────────────────────────────────

/** Fire only the WarningPopup variants, useful for interrupt UI testing. */
export const WARNING_SEQUENCE = [
  { ...MOCK_EVENT.pendingApproval('run_query', 'Execute SELECT * on production users table'), _delay: 1000 },
  { ...MOCK_EVENT.externalAlert('warning', 'API Rate Limit', 'OpenAI API at 82% of hourly quota'), _delay: 3000 },
  { ...MOCK_EVENT.externalAlert('info', 'Scheduled Maintenance', 'System maintenance window starts in 30 min'), _delay: 3000 },
  { ...MOCK_EVENT.selfCareHandoff(5), _delay: 3000 },
  { ...MOCK_EVENT.end(), _delay: 1000 },
];

/** Fire only canvas blocks, useful for CanvasBlockRenderer testing. */
export const CANVAS_SEQUENCE = [
  { ...MOCK_EVENT.renderCanvas({ type: 'heading', level: 1, text: 'Canvas Block Test' }), _delay: 800 },
  { ...MOCK_EVENT.renderCanvas({ type: 'paragraph', text: 'This is a paragraph block rendered from a mock SSE event.' }), _delay: 600 },
  { ...MOCK_EVENT.renderCanvas({ type: 'metric_card', label: 'Uptime', value: '99.98%', delta: '+0.02%', trend: 'up' }), _delay: 600 },
  { ...MOCK_EVENT.renderCanvas({ type: 'callout', tone: 'amber', title: 'Note', body: 'This callout came from the stream.' }), _delay: 600 },
  {
    ...MOCK_EVENT.renderCanvas({
      type: 'chart',
      title: 'Weekly Activity',
      chartType: 'line',
      data: [
        { name: 'Mon', value: 42 },
        { name: 'Tue', value: 67 },
        { name: 'Wed', value: 55 },
        { name: 'Thu', value: 88 },
        { name: 'Fri', value: 73 },
      ],
    }),
    _delay: 700,
  },
  { ...MOCK_EVENT.renderCanvas({ type: 'code', language: 'python', code: 'def hello():\n    return "Aura says hi"' }), _delay: 700 },
  { ...MOCK_EVENT.end(), _delay: 1000 },
];

/** Rapid token stream for chat streaming UI testing. Bible §10: { text: str } */
export const TOKEN_SEQUENCE = (
  "This is a simulated streaming response from Aura. Each word arrives as a separate token event, exactly as the real backend would send them during a Path A conversational response. The interface agent maintains a perpetual conversation context using the memory system to manage its window."
    .split(' ')
    .map((word, i) => ({ type: 'token', text: (i === 0 ? '' : ' ') + word, messageId: 'msg-stream-1', _delay: 80 }))
    .concat([{ ...MOCK_EVENT.end(), _delay: 400 }])
);
