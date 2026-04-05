/**
 * AURA NX-Alpha — CommandCenter
 *
 * The top-level application shell. Canvas-first layout.
 *
 * LAYOUT ARCHITECTURE:
 *
 *   ┌─────────────────────────────────────────────────────┐
 *   │  TitleBar (36px)   AURA NX-α    14:38   [ _ □ × ]  │
 *   ├─────────────────────────────────────────────────────┤
 *   │  AppBar (32px)  News Weather Finance Calendar ...    │
 *   ├────────────┬────────────────────────────────────────┤
 *   │            │                Canvas                  │
 *   │    Chat    │  ┌──────────┐  ┌──────────┐           │
 *   │  Sidebar   │  │  Agent   │  │  System  │           │
 *   │  (300px)   │  │ Monitor  │  │  Status  │  ←tabs→   │
 *   │            │  └──────────┘  └──────────┘           │
 *   │ ← always   │  ┌──────────┐  ┌──────────┐           │
 *   │   docked   │  │ Schedule │  │  Notes   │           │
 *   │   left  →  │  └──────────┘  └──────────┘           │
 *   └────────────┴────────────────────────────────────────┘
 *
 * CHAT SIDEBAR:
 *   Always docked left. Width transitions 300px → 24px (collapsed).
 *   Collapsed: shows rotated "Chat" label as restore button.
 *   Pop-out button: opens Chat in Electron BrowserWindow.
 *   Chat.jsx is rendered inside and stays clean — no layout awareness.
 *
 * CANVAS:
 *   flex:1, position:relative. The work surface.
 *   FloatingPanels are position:absolute within it.
 *   DropPanels slide down from top (z:110) to cover canvas.
 *   PeekStack sits on right edge (z:250), always accessible.
 *
 * FLOATING PANELS:
 *   4 panels: AgentMonitor, SystemStatus, Schedule, QuickNotes.
 *   Each managed by a 3-state machine tracked by `panelModes`:
 *     'floating'  — draggable on canvas (default)
 *     'docked'    — lives in RightDock sidebar (canvas shrinks to accommodate)
 *     'minimized' — collapsed to PeekStack tray tab on canvas right edge
 *   CommandCenter also tracks z-index per panel (bringToFront on focus).
 *
 * DROP PANELS:
 *   7 services: news, weather, finance, calendar, mail, comms, settings.
 *   One open at a time. AppBar tab toggles open/close.
 *
 * PEEK STACK:
 *   When a FloatingPanel is minimized, it's added to peekTabs array.
 *   PeekStack renders tabs on canvas right edge.
 *   Clicking tab restores the panel.
 *
 * PROPS:
 *   auraState     — 'idle'|'listening'|'thinking'|'responding'
 *   agents        — array for AgentMonitor
 *   lastHeartbeat — string for AgentMonitor
 *   events        — array for Schedule
 *   dateLabel     — string for Schedule
 *   notes         — array for QuickNotes
 *   onAddNote     — fn for QuickNotes
 *   onDeleteNote  — fn for QuickNotes
 *   metrics       — array for SystemStatus
 *   services      — array for SystemStatus
 *   uptime        — string for SystemStatus
 *   chatMessages  — array for Chat
 *   isTyping      — boolean for Chat
 *   onSendMessage — fn for Chat
 *
 *   streamUrl           — SSE endpoint URL. Pass null to stay idle.
 *                         In dev, pass 'mock://aura' to activate MockEventSource.
 *   eventSourceFactory  — EventSource replacement injected from App.jsx in dev.
 *                         createMockFactory(sequence) from mockStream.js.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { animateChatSidebar } from '../../core/animations';
import useAuraStream, { STREAM_STATUS } from '../../hooks/useAuraStream';
import { useConversations, useSystemStatus, useCalendar } from '../../hooks/useBackendData';

import TitleBar, { DEFAULT_TIMEZONES } from '../TitleBar/TitleBar';
import AppBar       from '../AppBar/AppBar';
import FinanceTicker from '../FinancePanel/FinanceTicker';
import IntelTicker from '../NewsPanel/IntelTicker';
import Chat         from '../Chat/Chat';
import AgentMonitor from '../AgentMonitor/AgentMonitor';
import SystemStatus from '../SystemStatus/SystemStatus';
import Schedule     from '../Schedule/Schedule';
import QuickNotes   from '../QuickNotes/QuickNotes';
import Canvas       from '../Canvas/Canvas';
import FloatingPanel from '../FloatingPanel/FloatingPanel';
import DropPanel    from '../DropPanel/DropPanel';
import PeekStack    from '../PeekStack/PeekStack';
import RightDock             from '../RightDock/RightDock';
import CanvasBlockRenderer  from '../CanvasBlockRenderer/CanvasBlockRenderer';
import WarningPopup         from '../WarningPopup/WarningPopup';
import Toast                from '../Toast/Toast';
import DraftReview          from '../DraftReview/DraftReview';
import styles from './CommandCenter.module.css';
import { MAX_FILE_SIZE, isImageFile, isDocumentFile, uploadImage, uploadDocument } from '../../utils/canvasDrop';

// ─────────────────────────────────────────────────────────────────────────────
// PANEL DEFINITIONS
// Position values are initial only — FloatingPanel tracks drag internally.
// Width is fixed per panel.
// ─────────────────────────────────────────────────────────────────────────────

const FLOATING_PANELS = [
  { id: 'fp-agents',   title: 'Agent Monitor', variant: 'command', initialX: 16,  initialY: 16,  width: 268 },
  { id: 'fp-status',   title: 'System Status', variant: 'command', initialX: 300, initialY: 16,  width: 280 },
  { id: 'fp-schedule', title: 'Schedule',      variant: 'work',    initialX: 16,  initialY: 240, width: 224 },
  { id: 'fp-notes',    title: 'Quick Notes',   variant: 'work',    initialX: 260, initialY: 240, width: 224 },
];

const DROP_PANEL_IDS = ['news', 'weather', 'finance', 'calendar', 'mail', 'comms', 'conversations', 'schedule', 'satellites', 'trainer', 'agents', 'legislation', 'geo', 'station', 'tool-workspace', 'neural-interface', 'settings', 'devpanel'];

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATIONS — live data fetched from GET /conversations via useConversations hook.
// Backend returns { conversations: [{thread_id, first_message, last_active, turn_count, preview}] }
// Transformed to match ConversationsPanel shape: {id, title, preview, timestamp, messageCount, ...}
// ─────────────────────────────────────────────────────────────────────────────

function transformConversations(raw) {
  if (!raw?.conversations) return [];
  return raw.conversations.map(c => ({
    id:           c.thread_id,
    title:        (c.first_message || 'Untitled conversation').slice(0, 80),
    preview:      c.preview || '',
    timestamp:    c.last_active ? new Date(parseFloat(c.last_active) * 1000).toISOString() : new Date().toISOString(),
    messageCount: c.turn_count || 0,
    isActive:     false,
    isStarred:    false,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM STATUS TRANSFORM
// /system/status → { metrics, services, uptime }
// ─────────────────────────────────────────────────────────────────────────────

function transformSystemStatus(raw) {
  if (!raw) return { metrics: [], services: [], uptime: '—' };

  const metrics = [];

  if (raw.cpu) {
    const cpuStatus = raw.cpu.usage_pct > 90 ? 'fault' : raw.cpu.usage_pct > 70 ? 'warn' : 'ok';
    metrics.push({ id: 'cpu', label: 'CPU', value: `${raw.cpu.usage_pct.toFixed(0)}%`, bar: raw.cpu.usage_pct, status: cpuStatus });
    if (raw.cpu.temp_c != null)
      metrics.push({ id: 'cpu-temp', label: 'CPU Temp', value: `${raw.cpu.temp_c.toFixed(0)}°C`, status: raw.cpu.temp_c > 85 ? 'fault' : raw.cpu.temp_c > 70 ? 'warn' : 'ok' });
  }

  if (raw.ram) {
    const ramStatus = raw.ram.usage_pct > 90 ? 'fault' : raw.ram.usage_pct > 75 ? 'warn' : 'ok';
    metrics.push({ id: 'ram', label: 'RAM', value: `${raw.ram.used_gb.toFixed(1)} / ${raw.ram.total_gb.toFixed(1)} GB`, bar: raw.ram.usage_pct, status: ramStatus });
  }

  for (const gpu of (raw.gpu ?? [])) {
    const vramPct = gpu.vram_total_mb > 0 ? (gpu.vram_used_mb / gpu.vram_total_mb) * 100 : 0;
    const gpuStatus = gpu.util_pct > 95 ? 'warn' : 'ok';
    metrics.push({ id: `gpu-${gpu.index}`, label: gpu.name.replace(/NVIDIA |AMD |Intel /i, '').slice(0, 20), value: `${gpu.util_pct.toFixed(0)}%`, bar: gpu.util_pct, status: gpuStatus });
    metrics.push({ id: `vram-${gpu.index}`, label: 'VRAM', value: `${(gpu.vram_used_mb / 1024).toFixed(1)} / ${(gpu.vram_total_mb / 1024).toFixed(1)} GB`, bar: vramPct });
    if (gpu.temp_c != null)
      metrics.push({ id: `gpu-temp-${gpu.index}`, label: 'GPU Temp', value: `${gpu.temp_c.toFixed(0)}°C`, status: gpu.temp_c > 85 ? 'fault' : gpu.temp_c > 75 ? 'warn' : 'ok' });
  }

  if (raw.disk?.length) {
    const d = raw.disk[0];
    const diskStatus = d.usage_pct > 90 ? 'fault' : d.usage_pct > 75 ? 'warn' : 'ok';
    metrics.push({ id: 'disk', label: `Disk (${d.mount})`, value: `${d.free_gb.toFixed(0)} GB free`, bar: d.usage_pct, status: diskStatus });
  }

  const s  = Math.floor(raw.uptime_s ?? 0);
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');

  return { metrics, services: [], uptime: `${hh}:${mm}:${ss}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// CALENDAR TRANSFORM
// /data/calendar → { events, dateLabel } shaped for Schedule component
// ─────────────────────────────────────────────────────────────────────────────

function transformCalendar(raw) {
  if (!raw?.events?.length) return { events: [], dateLabel: '' };

  const now    = new Date();
  const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tom    = new Date(today.getTime() + 86400000);
  const dayEnd = (d) => new Date(d.getTime() + 86400000);

  const events = raw.events
    .map(ev => {
      const start = new Date(ev.start);
      const end   = new Date(ev.end);
      let day = null;
      if (start >= today && start < dayEnd(today))        day = 'today';
      else if (start >= tom  && start < dayEnd(tom))      day = 'tomorrow';
      if (!day) return null;

      let status = 'later';
      if (!ev.all_day) {
        if (now >= start && now < end)                    status = 'now';
        else if (start > now && (start - now) < 3600000) status = 'soon';
        else if (end < now)                               status = 'done';
      }

      const fmt  = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const time = ev.all_day ? 'All day' : `${fmt(start)}–${fmt(end)}`;

      return { id: ev.id, title: ev.title, time, day, status, location: ev.location || undefined };
    })
    .filter(Boolean);

  const dateLabel = today.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  return { events, dateLabel };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND CENTER
// ─────────────────────────────────────────────────────────────────────────────

const CommandCenter = ({
  // Aura state
  auraState     = 'idle',

  // AgentMonitor
  agents        = [],
  lastHeartbeat = null,

  // Schedule
  events    = [],
  dateLabel = '',

  // QuickNotes
  notes        = [],
  onAddNote,
  onDeleteNote,

  // SystemStatus
  metrics  = [],
  services = [],
  uptime   = '—',

  // Chat
  chatMessages  = [],
  isTyping      = false,
  onSendMessage,

  // Canvas blocks — pre-seeded content (used in dev/demo; live content comes via canvasRef.addBlock)
  initialBlocks = [],

  // Conversations history — thread list for the Conversations drop panel.
  // Live data fetched from GET /conversations. Prop can override for testing.
  conversations: conversationsProp,
  onRestoreConversation,

  // ── SSE STREAM ──
  // Passed from App.jsx. CommandCenter wires useAuraStream internally so it can
  // reach canvasRef and warningRef without lifting those refs into App.
  streamUrl            = null,
  eventSourceFactory   = undefined,

  // Voice enabled ref — synced to App.jsx so POST /message includes voice_enabled
  voiceEnabledRef      = null,
}) => {

  // ── CONVERSATIONS — live data from GET /conversations (polls every 30s) ──
  const { data: convRaw } = useConversations(30000);
  const conversations = useMemo(
    () => conversationsProp || transformConversations(convRaw),
    [conversationsProp, convRaw],
  );

  // ── SYSTEM STATUS — live hardware telemetry (polls every 5s) ──
  const { data: sysRaw } = useSystemStatus(5000);

  // ── CALENDAR — today + tomorrow events (polls every 5 min) ──
  const { data: calRaw } = useCalendar(300000);

  // ── VOICE STATE ──
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const voiceInitiatedExternalRef = useRef(false);
  const stopTtsRef   = useRef(null);
  // PTT: Chat registers its mic-toggle fn here; Electron IPC fires it via Ctrl+Alt+Space
  const triggerPttRef = useRef(null);
  // Wake-detected: Chat registers a fn to externally set its voiceState to 'recording'
  const setExternalVoiceStateRef = useRef(null);

  // Sync voiceEnabled to App.jsx ref for POST /message body
  useEffect(() => {
    if (voiceEnabledRef) voiceEnabledRef.current = voiceEnabled;
  }, [voiceEnabled, voiceEnabledRef]);

  // ── CENTRALIZED AUDIO CONTROLLER ──
  // Single point of control for ALL audio playback — prevents competing Audio elements.
  const audioCurrentRef     = useRef(null);   // the one Audio element currently playing
  const audioQueueRef       = useRef([]);     // ordered array of { seq, blob }
  const audioEndSeqRef      = useRef(null);   // total expected chunks (set by audio_end)
  const nextExpectedSeqRef  = useRef(1);      // ensures in-order playback
  const audioPlayingRef     = useRef(false);  // true while audio is actively playing
  const streamingTtsActiveRef = useRef(false); // true when audio_chunk events received for current response

  const stopAllAudio = useCallback(() => {
    if (audioCurrentRef.current) {
      audioCurrentRef.current.pause();
      audioCurrentRef.current = null;
    }
    audioQueueRef.current = [];
    audioEndSeqRef.current = null;
    nextExpectedSeqRef.current = 1;
    audioPlayingRef.current = false;
    streamingTtsActiveRef.current = false;
    setExternalVoiceStateRef.current?.('idle');
  }, []);

  const playNextChunk = useCallback(() => {
    const queue = audioQueueRef.current;
    // Play next chunk if it's the expected sequence number
    if (queue.length === 0 || queue[0].seq !== nextExpectedSeqRef.current) {
      // Nothing ready yet, or next chunk hasn't arrived — wait
      if (queue.length === 0 && audioEndSeqRef.current !== null) {
        // All chunks played and audio_end received — done
        audioPlayingRef.current = false;
        streamingTtsActiveRef.current = false;
        setExternalVoiceStateRef.current?.('idle');
      } else {
        audioPlayingRef.current = false;
      }
      return;
    }
    audioPlayingRef.current = true;
    const { blob } = queue.shift();
    nextExpectedSeqRef.current += 1;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = 0.8;
    audioCurrentRef.current = audio;
    audio.onended = () => {
      URL.revokeObjectURL(url);
      audioCurrentRef.current = null;
      playNextChunk();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      audioCurrentRef.current = null;
      playNextChunk();
    };
    audio.play().catch(() => {
      URL.revokeObjectURL(url);
      audioCurrentRef.current = null;
      playNextChunk();
    });
  }, []);

  // ── OPERATING MODE STATE — shared with TitleBar mode indicator + Settings panel ──
  const [operatingMode, _setOperatingMode] = useState('proactive');
  const prevOperatingModeRef = useRef('proactive');
  const setOperatingMode = useCallback((mode) => {
    _setOperatingMode(mode);
    // Persist to backend
    fetch('http://127.0.0.1:8000/settings/operating-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }).catch(() => {});
  }, []);

  // ── TEAM GATE STATE — off by default (§14.7). Toggle calls PUT /settings/team-gate. ──
  const [teamGateEnabled, setTeamGateEnabled] = useState(false);

  // ── HARDWARE MODE — set by hardware_mode SSE. 'interface_only' | 'full' ──
  const [hardwareMode, setHardwareMode] = useState('interface_only');

  // ── MODEL STATUS — live model + GPU state from backend ──
  const [modelStatus, setModelStatus] = useState(null);

  // ── LLMFIT STATE — suggestion + download progress ──
  const [llmSuggestion, setLlmSuggestion] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState({}); // model_id -> progress%

  // ── STORAGE DATA — populated by storage_update SSE events, forwarded to Settings ──
  // Shape: { [component]: { used_gb, quota_gb, pct } }
  const [storageData, setStorageData] = useState({});

  // ── TIMEZONES — world clock config, shared between TitleBar and Settings ──
  const [timezones, setTimezones] = useState(DEFAULT_TIMEZONES);

  // ── FINANCE STATE — 3-state machine: 'closed' | 'open' | 'ticker' ──
  // 'closed'  → Finance drop panel not shown, no ticker
  // 'open'    → Finance drop panel open (DropPanel isOpen=true)
  // 'ticker'  → 28px FinanceTicker strip shown, drop panel closed
  // Cycle on tab click: closed→open→ticker→open. Close button→closed.
  const [finState, setFinState] = useState('closed');

  // ── INTEL STATE — same 3-state machine for Intel/News panel ──
  const [intelState, setIntelState] = useState('closed');

  // ── CANVAS BLOCK RENDERER REF ──
  // Exposes addBlock / clearBlocks / removeBlock for useAuraStream (SSE hook, later sprint)
  const canvasRef = useRef(null);

  // ── WARNING POPUP REF ──
  // Exposes show(spec) / hide() for useAuraStream on pending_approval,
  // external_alert SSE events.
  const warningRef = useRef(null);

  // ── TOAST REF ──
  // Exposes show({ message, level }) for system_notification SSE events.
  const toastRef = useRef(null);

  // ── CURRENT PENDING APPROVAL — for POST /approvals response ──
  const pendingApprovalRef = useRef(null);

  // Track block count so Canvas can hide its idle label when blocks exist.
  // Updated via onCountChange callback from CanvasBlockRenderer whenever
  // blocks are added/removed via SSE (addBlock/removeBlock/clearBlocks).
  const [blockCount, setBlockCount] = useState(initialBlocks.length);

  // ── CANVAS EXPORT — format picker + download handler (lives in TitleBar) ──
  const [exportFormat, setExportFormat] = useState('pdf');
  const [exporting,    setExporting]    = useState(false);
  const FORMAT_EXT = { pdf: '.pdf', docx: '.docx', html: '.html', txt: '.txt', markdown: '.md' };

  const handleCanvasDownload = useCallback(async () => {
    const blocks = canvasRef.current?.getBlocks?.() ?? [];
    if (!blocks.length || exporting) return;
    setExporting(true);
    try {
      const res = await fetch('http://127.0.0.1:8000/canvas/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blocks: blocks.map(b => ({ type: b.type, data: b.data })),
          format: exportFormat,
          title: 'aura-output',
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `aura-output${FORMAT_EXT[exportFormat] || '.pdf'}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[CommandCenter] Canvas export failed:', err);
    } finally {
      setExporting(false);
    }
  }, [exportFormat, exporting]);
  const handleBlockCountChange = useCallback((count) => setBlockCount(count), []);

  // ── DRAFT REVIEW ACTIONS ──

  // Accept: push all pending blocks onto canvas, clear draft
  const handleDraftAccept = useCallback((blocks) => {
    blocks.forEach(block => canvasRef.current?.addBlock(block));
    setPendingDraft(null);
    setDraftReviewOpen(false);
  }, []);

  // Revise: pre-fill chat input with revision prompt, clear draft
  const handleDraftRevise = useCallback((prefillText) => {
    chatPrefillRef.current?.(prefillText);
    setPendingDraft(null);
    setDraftReviewOpen(false);
  }, []);

  // ── CANVAS FILE DROP ──
  // Accept images and documents dropped on the canvas.
  // Images: shown immediately as an ImageBlock, then POSTed as base64 to /canvas/image.
  // Documents: shown as a file badge block, then POSTed as multipart to /canvas/document.
  // 100 MB limit for all files (via canvasDrop.js).

  const handleCanvasDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleCanvasDrop = useCallback((e) => {
    e.preventDefault();
    const BACKEND = 'http://127.0.0.1:8000';
    const files = Array.from(e.dataTransfer.files).filter(f => isImageFile(f) || isDocumentFile(f));
    if (files.length === 0) return;

    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        console.warn(`[CommandCenter] Skipped "${file.name}" — exceeds 100 MB limit (${(file.size / 1024 / 1024).toFixed(1)} MB)`);
        continue;
      }

      if (isImageFile(file)) {
        uploadImage(file, BACKEND).then((dataUri) => {
          canvasRef.current?.addBlock({
            id: crypto.randomUUID(),
            type: 'image',
            data: { src: dataUri, alt: file.name, caption: file.name },
          });
        });
      } else {
        // Document: add a file badge block immediately, then upload
        canvasRef.current?.addBlock({
          id: crypto.randomUUID(),
          type: 'file',
          data: { name: file.name, size: file.size, mimeType: file.type },
        });
        uploadDocument(file, BACKEND);
      }
    }
  }, []);

  // ── SSE-DRIVEN STATE ──
  // These shadow the corresponding props and are updated by the stream.
  // When the stream is idle (no streamUrl), the prop values are used directly.

  /** SSE-appended chat messages. Merged with the chatMessages prop at render. */
  const [liveMessages,   setLiveMessages]   = useState([]);

  /** True while an SSE token stream is actively arriving. */
  const [liveIsTyping,   setLiveIsTyping]   = useState(false);

  /**
   * Agent list driven by team_dispatched + agent_update SSE events.
   * null = no team dispatched yet, fall back to the `agents` prop.
   */
  const [liveAgents,     setLiveAgents]     = useState(null);

  /** Last agent_update timestamp shown in AgentMonitor footer. */
  const [liveHeartbeat, setLiveHeartbeat] = useState(null);

  /**
   * Aura indicator state derived from stream status and token flow.
   * null = no stream active, fall back to the `auraState` prop.
   */
  const [streamAuraState, setStreamAuraState] = useState(null);

  /**
   * Pending team draft — set when render_canvas SSE fires instead of immediately
   * pushing blocks onto canvas. null when no draft is pending review.
   * Shape: { blocks: ContentBlock[], title: string }
   */
  const [pendingDraft, setPendingDraft] = useState(null);
  const [draftReviewOpen, setDraftReviewOpen] = useState(false);

  /** Ref to function that pre-fills the Chat input (registered by Chat via onPrefillRegister) */
  const chatPrefillRef = useRef(null);

  // ── QUICK NOTES — localStorage-backed ──
  const [localNotes, setLocalNotes] = useState(() => {
    try { return JSON.parse(localStorage.getItem('aura-notes') ?? '[]'); } catch { return []; }
  });

  const handleAddNote = useCallback((text) => {
    const note = { id: crypto.randomUUID(), text, timestamp: new Date().toLocaleString() };
    setLocalNotes(prev => {
      const next = [note, ...prev];
      try { localStorage.setItem('aura-notes', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  const handleDeleteNote = useCallback((id) => {
    setLocalNotes(prev => {
      const next = prev.filter(n => n.id !== id);
      try { localStorage.setItem('aura-notes', JSON.stringify(next)); } catch {}
      return next;
    });
  }, []);

  // Effective (merged) values for render — stream data wins when present
  const effectiveMessages  = liveMessages.length > 0
    ? [...chatMessages, ...liveMessages]
    : chatMessages;
  const effectiveIsTyping  = liveIsTyping || isTyping;
  const effectiveAgents    = liveAgents ?? agents;
  const effectiveAuraState = streamAuraState ?? auraState;

  // ── CHAT SIDEBAR STATE ──
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const chatSideRef = useRef(null);

  // ── CHAT SIDEBAR WIDTH (resizable) ──
  // chatWidthRef is mutated imperatively during drag (no re-render).
  // chatWidth state is committed on mouseup so GSAP expand uses the right target.
  const [chatWidth, setChatWidth]   = useState(300);
  const chatWidthRef                = useRef(300);

  // ── CHAT POP-OUT STATE ──
  // When true the sidebar is hidden (CSS .chatPopped) and the real chat
  // lives in a pop-out BrowserWindow. Restores on pop-out window close.
  const [chatPopped, setChatPopped] = useState(false);

  // GSAP: animate sidebar width on collapse / expand (not when popped)
  // Replaces CSS width transition — GSAP owns state-change transitions per design system.
  useEffect(() => {
    if (chatSideRef.current && !chatPopped) {
      animateChatSidebar(chatSideRef.current, chatCollapsed, chatWidthRef.current);
    }
  }, [chatCollapsed, chatPopped]);

  // IPC: restore sidebar when the pop-out window is closed
  useEffect(() => {
    if (!window.electronAPI?.onPopOutClosed) return;
    const handler = (_evt, panelId) => {
      if (panelId === 'chat') setChatPopped(false);
    };
    window.electronAPI.onPopOutClosed(handler);
    return () => {
      window.electronAPI.removeWindowListener?.('panel:pop-out-closed', handler);
    };
  }, []);

  // Resize handle: drag the right edge of the sidebar to change its width.
  // Imperatively updates the DOM during drag; commits to state on mouseup.
  const handleResizeStart = useCallback((e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = chatWidthRef.current;

    const onMove = (moveE) => {
      const newWidth = Math.max(200, Math.min(700, startWidth + moveE.clientX - startX));
      if (chatSideRef.current) chatSideRef.current.style.width = `${newWidth}px`;
      chatWidthRef.current = newWidth;
    };

    const onUp = () => {
      setChatWidth(chatWidthRef.current);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  }, []);

  // ── RESTORE SETTINGS + FETCH MODEL STATUS on mount ──
  useEffect(() => {
    let active = true;

    // Retry helper — retries a fetch until it succeeds or maxRetries
    const retryFetch = async (url, onSuccess, retries = 20, delay = 2000) => {
      for (let i = 0; i < retries && active; i++) {
        try {
          const res = await fetch(url);
          if (res.ok) { onSuccess(await res.json()); return; }
        } catch { /* backend not ready */ }
        await new Promise(r => setTimeout(r, delay));
      }
    };

    // Restore persisted settings from backend (retries until backend up)
    retryFetch('http://127.0.0.1:8000/settings', (s) => {
      if (s.operating_mode) setOperatingMode(s.operating_mode);
      if (typeof s.team_enabled === 'boolean') setTeamGateEnabled(s.team_enabled);
    });

    // Fetch voice settings (retries until backend up)
    retryFetch('http://127.0.0.1:8000/voice/status', (s) => {
      if (typeof s.settings?.enabled === 'boolean') setVoiceEnabled(s.settings.enabled);
    });

    // Poll model status every 10s
    const poll = async () => {
      try {
        const res = await fetch('http://127.0.0.1:8000/models/status');
        if (res.ok && active) setModelStatus(await res.json());
      } catch { /* backend not ready yet */ }
    };
    poll();
    const id = setInterval(poll, 30_000);

    // Fetch LLMFit recommendation (retries until backend up)
    retryFetch('http://127.0.0.1:8000/llmfit/recommend', (data) => {
      if (data && (data.interface || data.workhorse)) setLlmSuggestion(data);
    });

    return () => { active = false; clearInterval(id); };
  }, []);

  // ── PTT KEYBIND — Electron Ctrl+Alt+Space → trigger Chat mic toggle ──
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onVoicePttToggle) return;
    const handler = () => triggerPttRef.current?.();
    api.onVoicePttToggle(handler);
    return () => api.removeVoicePttListener?.(handler);
  }, []);

  // ── DROP PANEL STATE ── (null = all closed)
  const [activeDrop, setActiveDrop] = useState(null);

  // ── AUTO-OPEN/CLOSE DEV PANEL on operating mode change ──
  useEffect(() => {
    const prev = prevOperatingModeRef.current;
    prevOperatingModeRef.current = operatingMode;
    if (operatingMode === 'dev' && prev !== 'dev') {
      setActiveDrop('devpanel');
      setFinState('closed');
    } else if (operatingMode !== 'dev' && prev === 'dev' && activeDrop === 'devpanel') {
      setActiveDrop(null);
    }
  }, [operatingMode, activeDrop]);

  // ── FLOATING PANEL STATE ──
  // panelModes: maps panel id → 'floating' | 'docked' | 'minimized'
  // All panels start floating (visible on canvas).
  const [panelModes,    setPanelModes]    = useState(() =>
    Object.fromEntries(FLOATING_PANELS.map(p => [p.id, 'floating']))
  );
  const [peekTabs,      setPeekTabs]      = useState([]);
  const [activePanelId, setActivePanelId] = useState(null);

  // Z-index management — monotonically increasing counter
  const zMaxRef  = useRef(20);
  const [panelZ, setPanelZ] = useState(() =>
    Object.fromEntries(FLOATING_PANELS.map((p, i) => [p.id, 20 + i]))
  );

  // ── BRING FLOATING PANEL TO FRONT ──
  const bringToFront = useCallback((id) => {
    zMaxRef.current += 1;
    setPanelZ(prev => ({ ...prev, [id]: zMaxRef.current }));
    setActivePanelId(id);
  }, []);

  // ── DOCK FLOATING PANEL → RIGHT DOCK ──
  const handleDock = useCallback((id) => {
    setPanelModes(prev => ({ ...prev, [id]: 'docked' }));
    if (activePanelId === id) setActivePanelId(null);
  }, [activePanelId]);

  // ── UNDOCK PANEL → BACK TO FLOATING CANVAS ──
  const handleUndock = useCallback((id) => {
    setPanelModes(prev => ({ ...prev, [id]: 'floating' }));
    bringToFront(id);
  }, [bringToFront]);

  // ── MINIMIZE FLOATING PANEL → PEEK TAB ──
  const handleMinimize = useCallback((id, title, variant) => {
    setPanelModes(prev => ({ ...prev, [id]: 'minimized' }));
    setPeekTabs(prev => {
      // Guard: don't add duplicate if already in peek
      if (prev.some(t => t.id === id)) return prev;
      return [...prev, { id, title, variant }];
    });
    if (activePanelId === id) setActivePanelId(null);
  }, [activePanelId]);

  // ── RESTORE FLOATING PANEL FROM PEEK TAB ──
  const handleRestore = useCallback((id) => {
    setPanelModes(prev => ({ ...prev, [id]: 'floating' }));
    setPeekTabs(prev => prev.filter(t => t.id !== id));
    bringToFront(id);
  }, [bringToFront]);

  // ── MINIMIZE DOCKED PANEL → PEEK TAB ──
  // Called by RightDock's minimize button — panel leaves dock AND peek-tabs in.
  const handleDockMinimize = useCallback((id, title, variant) => {
    setPanelModes(prev => ({ ...prev, [id]: 'minimized' }));
    setPeekTabs(prev => {
      if (prev.some(t => t.id === id)) return prev;
      return [...prev, { id, title, variant }];
    });
  }, []);

  // ── TOGGLE DROP PANEL ──
  // Finance & Intel tabs use 3-state machines (closed → open → ticker → open).
  // All other tabs use the standard toggle.
  const handleTabClick = useCallback((id) => {
    if (id === 'finance') {
      setFinState(prev => ({ closed: 'open', open: 'ticker', ticker: 'open' }[prev] ?? 'open'));
      setActiveDrop(null);
      setIntelState(prev => prev === 'open' ? 'ticker' : prev);
      return;
    }
    if (id === 'news') {
      setIntelState(prev => ({ closed: 'open', open: 'ticker', ticker: 'open' }[prev] ?? 'open'));
      setActiveDrop(null);
      setFinState(prev => prev === 'open' ? 'ticker' : prev);
      return;
    }
    setActiveDrop(prev => prev === id ? null : id);
    setFinState(prev => prev === 'open' ? 'ticker' : prev);
    setIntelState(prev => prev === 'open' ? 'ticker' : prev);
  }, []);

  // ── FINANCE CLOSE/EXPAND ──
  const handleFinClose   = useCallback(() => setFinState('closed'), []);
  const handleFinExpand  = useCallback(() => setFinState('open'),   []);

  // ── INTEL CLOSE/EXPAND ──
  const handleIntelClose  = useCallback(() => setIntelState('closed'), []);
  const handleIntelExpand = useCallback(() => setIntelState('open'),   []);

  // ── POP OUT TO ELECTRON WINDOW ──
  const handlePopOut = useCallback((id) => {
    if (window.electronAPI?.popOutPanel) {
      window.electronAPI.popOutPanel(id);
    } else {
      console.info(`[CommandCenter] Pop-out requested for: ${id} (Electron not available)`);
    }
  }, []);

  // ── POP OUT CHAT ──
  // Stash current messages in localStorage so the pop-out window can restore them,
  // then hide the sidebar and open the pop-out BrowserWindow.
  const handleChatPopOut = useCallback(() => {
    try {
      localStorage.setItem(
        'aura-chat-popout-messages',
        JSON.stringify(effectiveMessages.slice(-200)),  // last 200 messages max
      );
    } catch { /* non-critical */ }
    setChatPopped(true);
    if (window.electronAPI?.popOutPanel) {
      window.electronAPI.popOutPanel('chat');
    } else {
      // Browser / dev fallback — can't truly pop out, just restore sidebar
      console.info('[CommandCenter] Chat pop-out requested (Electron not available)');
      setChatPopped(false);
    }
  }, [effectiveMessages]);

  // ── WARNING POPUP HANDLERS ──
  // pending_approval: POST decision to backend /approvals endpoint
  const handleWarningApprove = useCallback(async () => {
    const approval = pendingApprovalRef.current;
    pendingApprovalRef.current = null;
    if (!approval?.approval_id) return;
    try {
      await fetch('http://localhost:8000/approvals', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ approval_id: approval.approval_id, decision: 'approved', tool: approval.tool }),
      });
    } catch (err) {
      console.warn('[CommandCenter] Approval POST failed:', err);
    }
  }, []);

  const handleWarningDeny = useCallback(async () => {
    const approval = pendingApprovalRef.current;
    pendingApprovalRef.current = null;
    if (!approval?.approval_id) return;
    try {
      await fetch('http://localhost:8000/approvals', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ approval_id: approval.approval_id, decision: 'denied', tool: approval.tool }),
      });
    } catch (err) {
      console.warn('[CommandCenter] Denial POST failed:', err);
    }
  }, []);

  // external_alert: user acknowledges + clears
  const handleWarningDismiss = useCallback(() => {
    console.info('[CommandCenter] Warning dismissed');
  }, []);

  // ── TEAM GATE TOGGLE ──
  // Optimistically updates local state, then syncs to backend.
  const handleTeamGateToggle = useCallback(async (enabled) => {
    setTeamGateEnabled(enabled);
    try {
      await fetch('http://localhost:8000/settings/team-gate', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch (err) {
      console.warn('[CommandCenter] Team gate sync failed:', err);
    }
  }, []);

  // ── LLMFIT ACCEPT / DISMISS ──
  const handleLlmAccept = useCallback(async () => {
    if (!llmSuggestion) return;
    try {
      await fetch('http://127.0.0.1:8000/llmfit/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: llmSuggestion.role || 'interface',
          model_id: llmSuggestion.model_id || llmSuggestion.id,
          filename: llmSuggestion.filename,
        }),
      });
    } catch { /* ignore */ }
    setLlmSuggestion(null);
  }, [llmSuggestion]);

  const handleLlmDismiss = useCallback(() => {
    setLlmSuggestion(null);
  }, []);

  // ── SEND MESSAGE ──
  // Optimistic: add user message to liveMessages immediately so the Chat
  // sidebar renders it before the SSE response arrives. Then calls the
  // onSendMessage prop (App.jsx POSTs to backend, which triggers the stream).
  const handleSendMessage = useCallback((text) => {
    if (!text.trim()) return;
    // Stop any playing audio when user sends a new message
    stopAllAudio();
    setLiveMessages(prev => [
      ...prev,
      {
        id:        `user-${Date.now()}`,
        role:      'user',
        content:   text,              // matches Chat.jsx message.content field
        timestamp: new Date().toISOString(),
      },
    ]);
    // Show PROCESSING indicator immediately — SSE is persistent so CONNECTING
    // never fires again after initial connect. Set thinking here so Chat.jsx
    // ThinkingIndicator shows from the moment the user sends until first token.
    setStreamAuraState('thinking');
    onSendMessage?.(text);
  }, [onSendMessage, stopAllAudio]);

  // Improve Style: send to Interface agent as a new message, clear draft
  const handleDraftImproveStyle = useCallback((blocks, title) => {
    const content = blocks
      .filter(b => b.type === 'heading' || b.type === 'paragraph')
      .map(b => b.data?.text || b.data?.content || '')
      .join('\n\n');
    const prompt = `Please improve the writing style and polish the following draft titled "${title}":\n\n${content}`;
    handleSendMessage(prompt);
    setPendingDraft(null);
    setDraftReviewOpen(false);
  }, [handleSendMessage]);

  // ── CONVERSATION HANDLERS ──

  // Restore job: load job context into chat sidebar, close Conversations panel
  const handleRestoreConversation = useCallback((id) => {
    console.info('[CommandCenter] Restore job context:', id);
    onRestoreConversation?.(id);
    // Close the Conversations panel after selecting a job
    setActiveDrop(null);
  }, [onRestoreConversation]);

  // ─────────────────────────────────────────────────────────────────────────
  // SSE STREAM — useAuraStream wired to internal refs + state
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * All 26 SSE event handlers mapped to the §10 SSE Contract payload shapes.
   * Defined with useMemo so the object reference is stable across renders.
   * useAuraStream reads via handlersRef so stability isn't strictly required,
   * but it avoids noise in React DevTools.
   *
   * canvasRef and warningRef are refs (always stable).
   * setXxx setters are stable by React guarantee.
   * Therefore deps = [] is correct.
   */
  const streamHandlers = useMemo(() => ({

    // ─── Core conversation ───────────────────────────────────────────────────

    // ── thinking — model reasoning, shown as collapsible block in chat ──
    onThinking: ({ text = '' }) => {
      if (!text) return;
      // Ensure PROCESSING indicator shows during extended reasoning phases
      setStreamAuraState('thinking');
      setLiveMessages(prev => [
        ...prev,
        {
          id:        `thinking-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          role:      'thinking',
          content:   text,
          timestamp: new Date().toISOString(),
        },
      ]);
    },

    // ── token — append streaming text to in-progress chat message ──
    // Bible §10: { text: str }. Chat.jsx displays message.content — we map text→content.
    onToken: ({ text = '', messageId = 'msg-stream' }) => {
      setLiveMessages(prev => {
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
            content:   text,         // Chat.jsx reads message.content
            streaming: true,
            timestamp: new Date().toISOString(),
          },
        ];
      });
      setLiveIsTyping(true);
      setStreamAuraState('responding');
    },

    // ── team_gate_prompt — team task hit closed gate ──
    // { message, hardware_limited?, queue_available?, task_text?, thread_id? }
    onTeamGatePrompt: ({ message = 'Team Functions are disabled.', hardware_limited = false, queue_available = false, task_text = '', thread_id = 'default' }) => {
      setLiveMessages(prev => [
        ...prev,
        {
          id:               `system-gate-${Date.now()}`,
          role:             'system',
          content:          message,
          timestamp:        new Date().toISOString(),
          hardware_limited,
          queue_available,
          task_text,
          thread_id,
        },
      ]);
    },

    // ── hardware_mode — GPU/Ollama availability changed ──
    // { mode: 'interface_only'|'full', vram_mb, model }
    onHardwareMode: ({ mode = 'interface_only', vram_mb = 0, threshold_mb = 20480 }) => {
      setHardwareMode(mode);
      const vramGb = vram_mb > 0 ? `${(vram_mb / 1024).toFixed(1)} GB` : 'unknown VRAM';
      const label = mode === 'full' ? 'Team pipeline online' : 'Interface-only mode';
      const detail = mode === 'full'
        ? `${vramGb} detected — queued tasks will run now.`
        : `${vramGb} detected (${(threshold_mb / 1024).toFixed(0)} GB required). Team tasks will be queued.`;
      setLiveMessages(prev => [
        ...prev,
        {
          id:        `system-hw-${Date.now()}`,
          role:      'system',
          content:   `${label} — ${detail}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    },

    // ── model_status — live model + GPU state from backend ──
    onModelStatus: (data) => {
      setModelStatus(data);
    },

    // ── boot_audio — play Aura's startup greeting via centralized controller ──
    onBootAudio: ({ wav_b64 }) => {
      try {
        stopAllAudio();
        const binary = atob(wav_b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/wav' });
        // Route through queue as seq=1 so centralized controller owns it
        audioQueueRef.current = [{ seq: 1, blob }];
        nextExpectedSeqRef.current = 1;
        audioEndSeqRef.current = 1;
        playNextChunk();
      } catch (e) {
        console.warn('[CommandCenter] Boot audio playback failed:', e);
      }
    },

    // ── queue_draining — queued tasks starting to execute ──
    onQueueDraining: ({ message = 'Running queued tasks...' }) => {
      setLiveMessages(prev => [
        ...prev,
        { id: `system-drain-${Date.now()}`, role: 'system', content: message, timestamp: new Date().toISOString() },
      ]);
    },

    // ── queue_drained — all queued tasks complete ──
    onQueueDrained: ({ message = 'All queued tasks complete.' }) => {
      setLiveMessages(prev => [
        ...prev,
        { id: `system-drained-${Date.now()}`, role: 'system', content: message, timestamp: new Date().toISOString() },
      ]);
    },

    // ── team_dispatched — populate AgentMonitor with the new team ──
    // Bible §10: { plan: ExecutionPlan }. Plan contains agents, task, teamId.
    onTeamDispatched: ({ plan = {} }) => {
      const { agents: newAgents = [], task = '', teamId = '' } = plan;
      setLiveAgents(
        newAgents.map(a => ({
          ...a,
          teamId,
          status:  a.status  ?? 'pending',
          task:    a.task    ?? task,
          summary: a.summary ?? '',
        }))
      );
      if (process.env.NODE_ENV === 'development') {
        console.info(`[CommandCenter] Team dispatched: ${task} — ${newAgents.length} agents`);
      }
    },

    // ── team_result — async team delivery (Phase 3+) ──
    // Fired by TeamDispatcher when the background team pipeline completes.
    // Adds a new AURA message to the chat without needing token streaming.
    // { team_id, content, canvas_title, msg_id }
    onTeamResult: ({ team_id, content = '', msg_id }) => {
      if (!content) return;
      setLiveMessages(prev => [
        ...prev,
        {
          id:        msg_id ?? `aura-team-${team_id}`,
          role:      'aura',
          type:      'team_result',
          content,
          timestamp: new Date().toISOString(),
          streaming: false,
        },
      ]);
      setLiveIsTyping(false);
      setStreamAuraState('idle');
    },

    // ── pm_clarification — PM needs user input before it can plan (Phase 5) ──
    // Fired when the PM encounters a genuine subject-matter ambiguity.
    // Renders the question as an AURA message; user's reply is intercepted by
    // the backend and routed directly to the waiting PM coroutine.
    // { question, team_id, thread_id }
    onPmClarification: ({ question = '', team_id = '', thread_id = '' }) => {
      if (!question) return;
      setLiveMessages(prev => [
        ...prev,
        {
          id:        `pm-clarify-${Date.now()}`,
          role:      'aura',
          content:   question,
          timestamp: new Date().toISOString(),
          streaming: false,
          meta:      { type: 'pm_clarification', team_id, thread_id },
        },
      ]);
      setLiveIsTyping(false);
      setStreamAuraState('idle');
    },

    // ── agent_update — upsert an agent's status row ──
    // Existing agents are updated; new ones (e.g. sprint agents) are appended.
    onAgentUpdate: ({ agent_id, status, summary, name, task }) => {
      setLiveAgents(prev => {
        if (!prev) return [{ id: agent_id, name: name ?? agent_id, task: task ?? '', status, summary: summary ?? '' }];
        const exists = prev.some(a => a.id === agent_id);
        if (exists) {
          return prev.map(a =>
            a.id === agent_id ? { ...a, status, summary: summary ?? a.summary } : a
          );
        }
        // New agent (sprint agents appear dynamically during execution)
        return [...prev, { id: agent_id, name: name ?? agent_id, task: task ?? '', status, summary: summary ?? '' }];
      });
      setLiveHeartbeat(new Date().toLocaleTimeString());
    },

    // ─── Canvas ──────────────────────────────────────────────────────────────

    // ── render_canvas — team deliverable: hold for draft review before pushing to canvas ──
    // Bible §10: { blocks: ContentBlock[], title: str }
    // Blocks are NOT added immediately — they go into pendingDraft state so the user
    // can proof the final output (Accept / Revise / Improve Style) before it hits the canvas.
    onRenderCanvas: ({ blocks = [], title = '' }) => {
      if (!blocks.length) return;
      setPendingDraft({ blocks, title });
      setDraftReviewOpen(false); // bar shows; user clicks to open modal
      if (process.env.NODE_ENV === 'development') {
        console.info(`[CommandCenter] Draft held for review: "${title}" (${blocks.length} blocks)`);
      }
    },

    // ── render_canvas_preview — Interface Agent inline preview (1-3 blocks) ──
    // Bible §10: { blocks: ContentBlock[], title: str, preview: true } [GRAFT: AionUi §23.1]
    // Previews from Interface still go straight to canvas (not full team deliverables).
    onRenderCanvasPreview: ({ blocks = [], title = '' }) => {
      if (!blocks.length) return;
      blocks.forEach(block => canvasRef.current?.addBlock({ ...block, _preview: true }));
    },

    // ── canvas_clear — wipe all canvas blocks ──
    onCanvasClear: () => {
      canvasRef.current?.clearBlocks();
    },

    // ─── Popups / interrupts ─────────────────────────────────────────────────

    // ── pending_approval — amber interrupt: Aura wants to run a tool ──
    onPendingApproval: ({ approval_id, tool, description }) => {
      pendingApprovalRef.current = { approval_id, tool };
      warningRef.current?.show({ type: 'pending_approval', approval_id, tool, description });
    },

    // ── external_alert — proactive mode alert (info / warning / critical) ──
    onExternalAlert: ({ severity, title, message }) => {
      warningRef.current?.show({ type: 'external_alert', severity, title, message });
    },

    // ─── Voice control events ────────────────────────────────────────────────

    // ── wake_detected — wake word fired; show listening state in Chat mic button ──
    onWakeDetected: () => {
      voiceInitiatedExternalRef.current = true;
      setExternalVoiceStateRef.current?.('recording');
    },

    // ── voice_transcribed — STT complete; switch to transcribing state ──
    onVoiceTranscribed: () => {
      setExternalVoiceStateRef.current?.('transcribing');
    },

    // ── session_close — conversational session ended; return to idle ──
    onSessionClose: () => {
      voiceInitiatedExternalRef.current = false;
      setExternalVoiceStateRef.current?.('idle');
    },

    // ── stop_tts — backend requests TTS abort (e.g. barge-in wake word) ──
    onStopTts: () => {
      stopAllAudio();
      stopTtsRef.current?.();
    },

    // ─── Study Mode ──────────────────────────────────────────────────────────

    // ── study_mode_open — study prompt UI activation ──
    // Bible §10: { suggested_category_path: str | null }
    // Study prompt UI not yet built — log and no-op for now.
    onStudyModeOpen: ({ suggested_category_path }) => {
      if (process.env.NODE_ENV === 'development') {
        console.info('[CommandCenter] Study Mode activated. Category:', suggested_category_path ?? 'none');
      }
      // Future Sprint 7: open study prompt overlay component
    },

    // ── study_progress — sprint completed, show inline progress in chat ──
    // Bible §10: { sprints_done: int, facts_ingested: int, category_path: str }
    onStudyProgress: ({ sprints_done, facts_ingested, category_path }) => {
      setLiveMessages(prev => [
        ...prev,
        {
          id:        `study-progress-${Date.now()}`,
          role:      'system',
          content:   `Study sprint ${sprints_done} complete — ${facts_ingested} facts ingested (${category_path})`,
          timestamp: new Date().toISOString(),
        },
      ]);
    },

    // ─── Storage Governor ────────────────────────────────────────────────────

    // ── storage_update / storage_warning / storage_limit_reached ──
    // Bible §4.5 + §10. Placeholder: logged only. Future: wire to Settings Storage section.
    onStorageUpdate: ({ component, used_gb, quota_gb, pct }) => {
      setStorageData(prev => ({
        ...prev,
        [component]: { used_gb, quota_gb, pct },
      }));
    },

    onStorageWarning: ({ component, pct, message }) => {
      const label = component ?? 'Storage';
      toastRef.current?.show({
        message: message ?? `${label} is at ${pct ?? '?'}% of quota — free up space soon.`,
        level: 'warning',
      });
    },

    onStorageLimitReached: ({ component, eviction_pending }) => {
      const label = component ?? 'Storage';
      toastRef.current?.show({
        message: `${label} quota full${eviction_pending ? ' — automatic eviction pending' : ''}. Free disk space to continue.`,
        level: 'error',
        duration: 15000,
      });
    },

    // ── knowledge_ingested — download + index complete, source now active ──
    onKnowledgeIngested: ({ source_id, source_name }) => {
      const label = source_name ?? source_id ?? 'Knowledge source';
      toastRef.current?.show({
        message: `${label} download complete — source is now active.`,
        level: 'success',
      });
    },

    // ─── System ──────────────────────────────────────────────────────────────

    // ── system_notification — background service event (e.g. CLI installed) ──
    // Bible §34 + §10: { type: str, message: str, level?: str, data: object }
    onSystemNotification: ({ type: notifType, message, level = 'info', data }) => {
      if (message) {
        toastRef.current?.show({ message, level });
      }
      if (process.env.NODE_ENV === 'development') {
        console.info(`[CommandCenter] System notification [${notifType}]: ${message}`, data);
      }
    },

    // ── error — backend reported a stream-level error ──
    onStreamError: ({ code, message }) => {
      console.error(`[CommandCenter] Stream error [${code}]: ${message}`);
      setStreamAuraState('idle');
    },

    // ── end — stream completed cleanly ──
    onEnd: ({ reason } = {}) => {
      // Seal any in-progress streaming messages
      setLiveMessages(prev =>
        prev.some(m => m.streaming)
          ? prev.map(m => m.streaming ? { ...m, streaming: false } : m)
          : prev
      );
      setLiveIsTyping(false);
      setStreamAuraState('listening'); // connected + idle = listening
      if (process.env.NODE_ENV === 'development') {
        console.info(`[CommandCenter] Stream ended: ${reason ?? 'completed'}`);
      }
    },

    // ─── HF Download Progress (LLMFit) ─────────────────────────────────────
    // Backend sends: { model_id, pct, bytes_done, total_bytes } for progress
    //                { model_id, dest_path } for complete
    //                { model_id, message } for error
    onHfDownloadProgress: (data) => {
      const key = data.model_id || data.model;
      if (key) setDownloadProgress(prev => ({ ...prev, [key]: data.pct ?? 0 }));
    },
    onHfDownloadComplete: (data) => {
      const key = data.model_id || data.model;
      setDownloadProgress(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    onHfDownloadError: (data) => {
      const key = data.model_id || data.model;
      console.error('[CommandCenter] Download error:', data.message);
      setDownloadProgress(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },

    // ─── Phase 2/3 no-ops (Voice + Ambient) ──────────────────────────────────
    // These events are dispatched by useAuraStream but have no UI surface yet.
    // Handlers registered here to suppress dev console warnings.
    onAudioChunk: ({ data, format, seq }) => {
      // Decode base64 WAV → Blob, insert into ordered queue, start playback
      try {
        streamingTtsActiveRef.current = true;
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: `audio/${format || 'wav'}` });

        // Insert sorted by seq
        const queue = audioQueueRef.current;
        const insertIdx = queue.findIndex(item => item.seq > seq);
        if (insertIdx === -1) queue.push({ seq, blob });
        else queue.splice(insertIdx, 0, { seq, blob });

        // Signal speaking state on first chunk
        if (seq === 1) {
          setExternalVoiceStateRef.current?.('speaking');
        }

        // Start playback if not already playing
        if (!audioPlayingRef.current) {
          playNextChunk();
        }
      } catch (e) {
        console.warn('[CommandCenter] audio_chunk decode error:', e);
      }
    },
    onAudioEnd: ({ seq_total }) => {
      audioEndSeqRef.current = seq_total;
      // If all chunks already played, signal done
      if (!audioPlayingRef.current && audioQueueRef.current.length === 0) {
        streamingTtsActiveRef.current = false;
        setExternalVoiceStateRef.current?.('idle');
      }
    },
    onVoiceProfileReady:     () => { /* Phase 2 */ },
    onAmbientSound:          () => { /* Phase 3 */ },
    onCanvasNarrationStart:  () => { /* Phase 3 — MOSS-TTSD */ },
    onCanvasNarrationChunk:  () => { /* Phase 3 */ },

  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []); // stable — all deps are refs or setState functions

  // ── CONNECT — run the SSE hook ──
  // streamReconnect / streamDisconnect exposed for future use (debug panel,
  // settings reconnect button, etc). Destructured here so they're ready.
  const {
    status:     streamStatus,
    reconnect:  streamReconnect,    // eslint-disable-line no-unused-vars
    disconnect: streamDisconnect,   // eslint-disable-line no-unused-vars
  } = useAuraStream(streamUrl, streamHandlers, { eventSourceFactory });

  // ── STREAM STATUS → AURA INDICATOR STATE ──
  // Update the ambient indicator whenever connection state changes.
  // Handler callbacks (onToken, onEnd) override this for transient states.
  useEffect(() => {
    if (!streamUrl) {
      setStreamAuraState(null);   // no stream — fall back to prop value
      return;
    }
    switch (streamStatus) {
      case STREAM_STATUS.CONNECTING:
        // Connecting is a startup-only state — show listening, not PROCESSING.
        // PROCESSING (thinking) is set explicitly in handleSendMessage and onThinking.
        setStreamAuraState('listening');
        break;
      case STREAM_STATUS.CONNECTED:
        // Don't override 'responding' or 'thinking' — those are set by handlers.
        // Only move to 'listening' if we're not in a more specific state.
        setStreamAuraState(prev =>
          (prev === 'responding' || prev === 'thinking') ? prev : 'listening'
        );
        break;
      case STREAM_STATUS.DISCONNECTED:
      case STREAM_STATUS.ERROR:
      case STREAM_STATUS.IDLE:
      default:
        setStreamAuraState('idle');
        break;
    }
  }, [streamStatus, streamUrl]);

  // ── PANEL CONTENT MAP ──
  const { metrics: sysMetrics, services: sysServices, uptime: sysUptime } = transformSystemStatus(sysRaw);
  const { events: calEvents, dateLabel: calDateLabel } = transformCalendar(calRaw);

  const panelContent = {
    'fp-agents': (
      <AgentMonitor
        agents={effectiveAgents}
        lastHeartbeat={liveHeartbeat}
        isActive={activePanelId === 'fp-agents'}
      />
    ),
    'fp-status': (
      <SystemStatus
        metrics={sysMetrics}
        services={sysServices}
        uptime={sysUptime}
        isActive={activePanelId === 'fp-status'}
      />
    ),
    'fp-schedule': (
      <Schedule
        events={calEvents}
        dateLabel={calDateLabel}
        isActive={activePanelId === 'fp-schedule'}
      />
    ),
    'fp-notes': (
      <QuickNotes
        notes={localNotes}
        onAddNote={handleAddNote}
        onDeleteNote={handleDeleteNote}
        isActive={activePanelId === 'fp-notes'}
      />
    ),
  };

  return (
    <div className={styles.shell}>

      {/* ── TITLE BAR — receives live mode state so switcher stays synced with Settings ── */}
      <TitleBar
        auraState={effectiveAuraState}
        operatingMode={operatingMode}
        onModeChange={setOperatingMode}
        timezones={timezones}
        canvasBlockCount={blockCount}
        exportFormat={exportFormat}
        onExportFormatChange={setExportFormat}
        onCanvasDownload={handleCanvasDownload}
        exporting={exporting}
      />

      {/* ── APP BAR — service tab row ── */}
      <AppBar
        activeDrop={activeDrop}
        financeState={finState}
        intelState={intelState}
        onTabClick={handleTabClick}
      />

      {/* ── FINANCE TICKER — 28px strip, visible when finState==='ticker' ── */}
      {finState === 'ticker' && (
        <FinanceTicker
          onExpand={handleFinExpand}
          onClose={handleFinClose}
        />
      )}

      {/* ── INTEL TICKER — 28px strip, visible when intelState==='ticker' ── */}
      {intelState === 'ticker' && (
        <IntelTicker
          onExpand={handleIntelExpand}
          onClose={handleIntelClose}
        />
      )}

      {/* ── WORKSPACE — chat sidebar + canvas ── */}
      <div className={styles.workspace}>

        {/* ── CHAT SIDEBAR ── */}
        <div
          ref={chatSideRef}
          className={[
            styles.chatSide,
            chatCollapsed && styles.chatCollapsed,
            chatPopped     && styles.chatPopped,
          ].filter(Boolean).join(' ')}
          style={{ width: chatPopped ? 0 : chatWidth }}
        >
          {/* Collapsed restore strip — only visible when collapsed */}
          <button
            className={styles.chatRestore}
            onClick={() => setChatCollapsed(false)}
            aria-label="Expand chat"
            tabIndex={chatCollapsed ? 0 : -1}
          >
            Chat
          </button>

          {/* Chat panel — hidden when sidebar is collapsed */}
          <div className={styles.chatInner}>
            <Chat
              messages={effectiveMessages}
              auraStatus={effectiveAuraState}
              isTyping={effectiveIsTyping}
              isActive={!chatCollapsed && !chatPopped}
              onSend={handleSendMessage}
              onPopOut={handleChatPopOut}
              voiceEnabled={voiceEnabled}
              voiceInitiatedExternalRef={voiceInitiatedExternalRef}
              streamingTtsActiveRef={streamingTtsActiveRef}
              onStopTtsRegister={(fn) => { stopTtsRef.current = fn; }}
              onPttRegister={(fn) => { triggerPttRef.current = fn; }}
              onExternalVoiceStateRegister={(fn) => { setExternalVoiceStateRef.current = fn; }}
              onPrefillRegister={(fn) => { chatPrefillRef.current = fn; }}
            />
          </div>

          {/* Collapse button — overlays top-right of the chat header area */}
          <button
            className={styles.chatCollapseBtn}
            onClick={() => setChatCollapsed(true)}
            aria-label="Collapse chat sidebar"
            tabIndex={chatCollapsed ? -1 : 0}
            title="Collapse chat"
          >
            {/* Left-pointing chevron */}
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M7 1L3 5l4 4" stroke="currentColor" strokeWidth="1.3"
                strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>

          {/* Resize handle — drag right edge to resize the sidebar */}
          {!chatCollapsed && !chatPopped && (
            <div
              className={styles.resizeHandle}
              onMouseDown={handleResizeStart}
              aria-hidden="true"
              title="Drag to resize"
            />
          )}
        </div>

        {/* ── CANVAS — work surface + floating panels + content blocks ── */}
        <Canvas hasContent={blockCount > 0} onDragOver={handleCanvasDragOver} onDrop={handleCanvasDrop}>

          {/* Floating panels — only rendered when mode === 'floating' */}
          {FLOATING_PANELS.map(p => panelModes[p.id] === 'floating' && (
            <FloatingPanel
              key={p.id}
              id={p.id}
              title={p.title}
              variant={p.variant}
              initialX={p.initialX}
              initialY={p.initialY}
              width={p.width}
              zIndex={panelZ[p.id] ?? 20}
              isActive={activePanelId === p.id}
              onFocus={() => bringToFront(p.id)}
              onDock={handleDock}
              onMinimize={handleMinimize}
              onPopOut={handlePopOut}
            >
              {panelContent[p.id]}
            </FloatingPanel>
          ))}

          {/* Drop panels — service overlays from AppBar.
              Settings panel receives live operatingMode state + setter.
              Conversations panel receives the job history list + restore handler. */}
          {DROP_PANEL_IDS.map(id => (
            <DropPanel
              key={id}
              id={id}
              isOpen={id === 'finance' ? finState === 'open' : id === 'news' ? intelState === 'open' : activeDrop === id}
              onClose={id === 'finance' ? handleFinClose : id === 'news' ? handleIntelClose : () => setActiveDrop(null)}
              onPopOut={handlePopOut}
              onOpenPanel={setActiveDrop}
              {...(id === 'settings' && {
                settingsProps: {
                  onOpenPanel:         setActiveDrop,
                  operatingMode,
                  onModeChange:        setOperatingMode,
                  teamGateEnabled,
                  onTeamGateToggle:    handleTeamGateToggle,
                  timezones,
                  onTimezonesChange:   setTimezones,
                  llmSuggestion,
                  onLlmAccept:     handleLlmAccept,
                  onLlmDismiss:    handleLlmDismiss,
                  downloadProgress,
                  ...(modelStatus && {
                    interfaceModel: {
                      name:   modelStatus.interface?.name   || 'Unknown',
                      status: modelStatus.interface?.status || 'offline',
                    },
                    workhorseModel: {
                      name:   modelStatus.workhorse?.name   || 'Unknown',
                      status: modelStatus.workhorse?.status || 'offline',
                    },
                    gpuInfo: modelStatus.gpu || [],
                    hardwareMode: modelStatus.hardware_mode,
                    devStub: modelStatus.dev_stub_responses,
                  }),
                },
              })}
              {...(id === 'conversations' && {
                conversationsProps: {
                  conversations,
                  onRestore: handleRestoreConversation,
                },
              })}
            />
          ))}

          {/* Peek stack — right-edge tabs for minimized panels */}
          <PeekStack
            tabs={peekTabs}
            onRestore={handleRestore}
          />

          {/* Draft Review Bar — amber banner shown when team delivers a draft.
              User must review before blocks reach the canvas. */}
          {pendingDraft && !draftReviewOpen && (
            <div className={styles.draftBar}>
              <span className={styles.draftBarTag}>DRAFT READY</span>
              <span className={styles.draftBarTitle}>{pendingDraft.title || 'Team Draft'}</span>
              <span className={styles.draftBarMeta}>{pendingDraft.blocks.length} block{pendingDraft.blocks.length !== 1 ? 's' : ''}</span>
              <button
                className={styles.draftBarBtn}
                onClick={() => setDraftReviewOpen(true)}
              >
                Review Draft
              </button>
              <button
                className={styles.draftBarDismiss}
                onClick={() => setPendingDraft(null)}
                title="Discard draft"
              >
                ✕
              </button>
            </div>
          )}

          {/* Canvas Block Renderer — spatial content artifacts from Aura's team.
              canvasRef.addBlock() called by streamHandlers on render_canvas SSE events.
              canvasRef.clearBlocks() called on canvas_clear events. */}
          <CanvasBlockRenderer
            ref={canvasRef}
            initialBlocks={initialBlocks}
            onCountChange={handleBlockCountChange}
          />

        </Canvas>

        {/* ── RIGHT DOCK — panels in docked state live here; canvas shrinks naturally ── */}
        <RightDock
          dockedPanels={FLOATING_PANELS
            .filter(p => panelModes[p.id] === 'docked')
            .map(p => ({ id: p.id, title: p.title, variant: p.variant }))
          }
          renderContent={(id) => panelContent[id]}
          onUndock={handleUndock}
          onMinimize={handleDockMinimize}
          onPopOut={handlePopOut}
        />

      </div>

      {/* ── WARNING POPUP — interrupt overlay, z-index 400, above all layers ──
          Rendered inside .shell so position:absolute inset:0 covers the
          full app (TitleBar, AppBar, workspace, canvas). Shell is position:fixed.
          warningRef.show(spec) is called by streamHandlers on pending_approval,
          external_alert SSE events. */}
      <WarningPopup
        ref={warningRef}
        onApprove={handleWarningApprove}
        onDeny={handleWarningDeny}
        onDismiss={handleWarningDismiss}
      />

      {/* ── TOAST — system_notification SSE events, z-index 500 ──
          toastRef.show({ message, level }) called by streamHandlers. */}
      <Toast ref={toastRef} />

      {/* ── DRAFT REVIEW MODAL — shown when user clicks "Review Draft" on the bar.
          z-index 350: above canvas, below warnings (400). */}
      {draftReviewOpen && pendingDraft && (
        <DraftReview
          draft={pendingDraft}
          onAccept={handleDraftAccept}
          onRevise={handleDraftRevise}
          onImproveStyle={handleDraftImproveStyle}
          onDismiss={() => setDraftReviewOpen(false)}
        />
      )}

    </div>
  );
};

export default CommandCenter;
