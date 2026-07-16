const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');

// DEV DIAGNOSTICS — expose the renderer over Chrome DevTools Protocol so a CDP client can attach to the
// LIVE webviews (real render loop, real canvas) instead of guessing from a proxy. Localhost-only, dev-only
// (never in a packaged build), and opt-out via KG_NO_DEBUG=1. Must be set before app is ready.
if (!app.isPackaged && process.env.KG_NO_DEBUG !== '1') {
  try { app.commandLine.appendSwitch('remote-debugging-port', '9222'); app.commandLine.appendSwitch('remote-allow-origins', '*'); } catch (e) {}
}

// CRASH SAFETY — before this there were NO global handlers, so any unhandled error/rejection killed
// her with nothing logged (the meeting crash was invisible for exactly this reason). Log the stack
// to data/crash.log + console. Policy: KEEP HER ALIVE — for a long-lived companion in testing,
// staying up with the cause captured beats dying silently (the prior behavior). uncaughtException
// leaves an undefined state in theory, but that's still strictly better than the hard crash it
// replaces, and the log gives us the root cause to fix. Tighten to exit-on-uncaught later if needed.
function logCrash(kind, info) {
  const detail = (info && info.stack) || (() => { try { return JSON.stringify(info); } catch { return String(info); } })();
  try { require('fs').appendFileSync(path.join(__dirname, 'data', 'crash.log'), `[${new Date().toISOString()}] ${kind}: ${detail}\n`); } catch {}
  console.error(`[crash] ${kind}:`, detail);
}
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason));
process.on('uncaughtException', (err) => logCrash('uncaughtException', err));
app.on('render-process-gone', (_e, _wc, details) => logCrash('render-process-gone', details));
app.on('child-process-gone', (_e, details) => logCrash('child-process-gone', details));

const db = require('./lib/db');
const editorRegistry = require('./lib/editor_registry');   // Editor Studio: document registry + lifecycle
const editorImport = require('./lib/editor_import');         // Editor Studio: normalize-on-import
const editorChecks = require('./lib/editor_checks');         // Editor Studio: "Run checks" orchestration
const editorCert = require('./lib/editor_cert');             // Editor Studio: "Certify" issuance (B4)
const ssRun = require('./studio/super_search_run');          // Super Search: run orchestrator (one pathway)
const ssModelIO = require('./studio/super_search_model_io'); // Super Search: the three caged model leaves
const ssIngest = require('./studio/super_search_ingest');    // Super Search: ingest-gated loop
const ssLedger = require('./lib/super_search_ledger');       // Super Search: persistent ingest ledger
const pollView = require('./studio/poll_view');              // Polling surface: tool payloads → view shapes
const crmView = require('./studio/crm_view');                // CRM surface: contact tool payloads → view shapes
const legView = require('./studio/leg_view');                // Legislation surface: bill tool payloads → view shapes
const canvasView = require('./studio/canvas_view');          // Canvas surface: saga canvas tabs/blocks → view shapes
const canvasLayout = require('./studio/canvas_layout');      // Canvas freeform board: pure placement math
const calendarView = require('./studio/calendar_view');      // Calendar surface: Google Calendar v3 JSON → view shapes
const gcal = require('./lib/gcal');                          // Calendar surface: Google token bridge + Calendar v3 read client
const feedsView = require('./studio/feeds_view');            // Monitors widget: feed reports → merged item stream
const feedsStore = require('./lib/feeds');                   // Monitors widget: operator's feed subscription list
let newsVideoLane = null;                                    // always-on video-caption capture lane (Data-Stream Phase A)
const canvasLayoutStore = require('./lib/canvas_layout');    // Canvas freeform board: operator's saved block positions
const kgView = require('./studio/kg_view');                  // Knowledge Graph surface: graph tool payloads → nodes/links
const docView = require('./studio/doc_view');                // Reader/Library surface: corpus doc payloads → reader view
const docExtract = require('./lib/doc_extract');             // writing suite: local .docx/.pdf extractors (rich render)
const creatorView = require('./studio/creator_view');        // Creator surface: block-model ⇄ ProseMirror bridge (Phase 3)
const creatorStats = require('./studio/creator_stats');      // Creator clinical panel: deterministic document statistics
const creatorProofread = require('./studio/creator_proofread'); // Creator clinical panel: caged proofread leaf (spelling/grammar/style)
const creatorSources = require('./studio/creator_sources');     // Creator clinical panel: external (web/academic) classifier — reused by research
const creatorResearch = require('./studio/creator_research');   // Creator clinical panel: entity research + cloud writing-advisor
const pullerIpc = require('./lib/puller_ipc');               // Puller suite: dossier IPC + aggregator (Slice 1, read-only)
pullerIpc.register(ipcMain);                                 // registers puller:list-targets / puller:get-dossier + inits data/puller.db
const modelsLib = require('./lib/models');                   // model sources (cloud frontier + local) resolver
const { streamChat, complete, TagStreamParser, sweepLoaded } = require('./lib/ollama');
const { buildChatPrompt, buildAwarenessBlock } = require('./lib/context');
const {
  startReflectionScheduler,
  stopReflectionScheduler,
  markUserActivity,
  forceReflectionIfDue,
  pause: pauseReflection,
  resume: resumeReflection
} = require('./lib/reflection');
const {
  startMonologueScheduler,
  stopMonologueScheduler,
  pause: pauseMonologue,
  resume: resumeMonologue,
  interrupt: interruptMonologue,
  isBusy: monologueBusy,
  markUserActivity: markMonologueActivity
} = require('./lib/monologue');
const { detectHardPull } = require('./lib/snapback');
const {
  startHeartbeatScheduler,
  stopHeartbeatScheduler,
  pause: pauseHeartbeat,
  resume: resumeHeartbeat,
  markUserActivity: markHeartbeatActivity
} = require('./lib/heartbeat');
const { extractCommitments } = require('./lib/commitments');
const { fetchPage, search: webSearch } = require('./lib/web_search');
const echoSuitLib = require('./lib/echo_suit');
const { EngineSupervisor } = require('./lib/engine');   // Zoe OWNS the absorbed engine (adopt-or-spawn)
const recallLib = require('./lib/recall');   // <recall ref="rID"/> — expand a memory marker on demand
let echoSuit = null;   // Echo "suit" — the MCP tool surface Zoe wears; bound to the engine she owns
let echoHttp = null;   // {base,token} for the engine's HTTP custom routes (e.g. GET /canvas live snapshot)
let echoVenv = null;   // {python,cwd} — Echo's venv interpreter + repo root, for the Google-token bridge (lib/gcal)
let engineSupervisor = null;   // supervises the engine process: adopts a running one, else spawns + owns it
// Lucas explicitly invoking the suit / our data → bind to echo tags (F1 nudge). Deliberately
// specific so it doesn't fire on casual mentions of "data" etc.
const ECHO_INVOKE_RE = /\b(the\s+)?(power\s*)?suit\b|\becho\b|\b(use|search|query|check|look\s*up\s+in|pull\s+from)\b[^.?!]{0,30}\b(the\s+)?(db|database|knowledge\s*base|kb|graph|kg|our\s+(records|data|kb|knowledge|graph|contacts|bills))\b|\bthe\s+db\b|\bour\s+(records|knowledge\s*base|kb|graph|database)\b|\blamp\b/i;

// Read Echo's HTTP endpoint + admin token from its config.toml (env overrides win). Zoe attaches
// to the SAME server Lucas's Echo UI uses, so her work shares his canvas/DB. Admin tier (his call)
// → propose + canvas push. Token is read at runtime from Echo's config; never stored by Side Quest.
function readEchoConfig(dir) {
  const fs = require('fs'); const path = require('path');
  let token = process.env.NX_ECHO_ADMIN_TOKEN || null;
  let port = 8765;
  try {
    const toml = fs.readFileSync(path.join(dir, 'config.toml'), 'utf8');
    if (!token) { const m = toml.match(/^\s*admin_token\s*=\s*"([^"]+)"/m); if (m) token = m[1]; }
    const p = toml.match(/^\s*port\s*=\s*(\d+)/m); if (p) port = parseInt(p[1], 10);
  } catch (e) { console.error('[main] could not read Echo config.toml:', e.message); }
  const host = '127.0.0.1';
  const envPort = parseInt(process.env.ECHO_PORT || '', 10);
  if (!Number.isNaN(envPort)) port = envPort;
  return { url: process.env.ECHO_MCP_URL || `http://${host}:${port}/mcp/`, token, host, port };
}
const openThreadsLib = require('./lib/open_threads');
const protocolsLib = require('./lib/protocols');
const browserLib = require('./lib/browser');
const filesLib = require('./lib/files');
const screenLib = require('./lib/screen');
const chatWatcher = require('./lib/chat_watcher');
const config = require('./lib/config');
const schedulerLib = require('./lib/scheduler');
const presenceLib = require('./lib/presence');
const emailLib = require('./lib/email');
const discordLib = require('./lib/discord');
const memoryLib = require('./lib/memory');
const inboxLib = require('./lib/inbox');
const actionLoop = require('./lib/action_loop');
const experience = require('./lib/experience');
const blackboard = require('./lib/blackboard');
const curatorLib = require('./lib/curator');
const cloudCurator = require('./lib/cloud_curator');
const gapsLib = require('./lib/gaps');
const webLib = require('./lib/web');
const {
  startContinuityScheduler,
  stopContinuityScheduler,
  pause: pauseContinuity,
  resume: resumeContinuity,
  markUserActivity: markContinuityActivity
} = require('./lib/continuity');
const selfDialogue = require('./lib/self_dialogue');

const MODEL = config.frontModel();   // her VOICE model (front); cognition/extraction may differ
const RECENT_TURN_LIMIT = 28;   // freed by the stripped voice-renderer prompt (Slice 3) — ~20-30 rounds
const RECENT_REFLECTION_LIMIT = 5;
const DISPLAY_HISTORY_LIMIT = 50;

let mainWindow = null;
let currentSessionId = null;
let currentSessionStartedAt = null;
let inboxPollTimer = null;     // setInterval id for the inbox poller (cleared on shutdown)
let inboxPollTimeout = null;   // initial-sweep setTimeout id
let emailIntakeTimer = null;   // setInterval id for the read-only newsletter/meeting-notes intake lane
let emailIntakeTimeout = null; // initial-sweep setTimeout id
let apiStreamTimer = null;     // setInterval id for the API management stream scheduler (snapshots + landing)
let apiStreamTimeout = null;   // initial-sweep setTimeout id
let apiBulkTimer = null;       // setInterval id for the API bulk-pull scheduler (legislation → memory)
let apiBulkTimeout = null;     // initial bulk pass setTimeout id
let truthTimer = null;         // setInterval id for the Truth Social social-feed poller
let truthTimeout = null;       // initial Truth Social poll setTimeout id
let canvasIngestTimer = null;  // setInterval id for the canvas drop→ingest poller (cleared on shutdown)
let canvasIngestTimeout = null;// initial-sweep setTimeout id
let forecastLoopTimer = null;  // setInterval id for the forecasting recompute loop (Suite B capstone)
let forecastLoopTimeout = null;// initial-sweep setTimeout id
let lastForecast = null;       // last forecast_loop.runOnce() result — served by forecast:balance, re-simmed on seed re-run
let lastUserTurnTs = Date.now(); // for detecting "return after a long absence" (capability proposals)
const RETURN_IDLE_MS = 10 * 60 * 1000; // gap that counts as "they were away"

function createWindow() {
  const windowState = require('./lib/window_state');
  mainWindow = new BrowserWindow({
    ...windowState.options('main', { width: 900, height: 800 }),
    backgroundColor: '#0d0d10',
    title: 'Zoe Lane',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  windowState.track(mainWindow, 'main');
  // Right-click context menu in the chat window: spellcheck suggestions + cut/copy/paste.
  // Self-contained (inline require) so it stays out of the way of other edits to this file.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const { Menu, MenuItem } = require('electron');
    const menu = new Menu();
    for (const suggestion of params.dictionarySuggestions) {
      menu.append(new MenuItem({
        label: suggestion,
        click: () => mainWindow.webContents.replaceMisspelling(suggestion)
      }));
    }
    if (params.misspelledWord) {
      menu.append(new MenuItem({
        label: 'Add to dictionary',
        click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      }));
      menu.append(new MenuItem({ type: 'separator' }));
    }
    if (params.isEditable) {
      menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }));
      menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }));
      menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }));
      menu.append(new MenuItem({ type: 'separator' }));
      menu.append(new MenuItem({ role: 'selectAll' }));
    } else if (params.selectionText) {
      menu.append(new MenuItem({ role: 'copy' }));
    }
    if (menu.items.length) menu.popup({ window: mainWindow });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

let editorWindow = null;
// Editor Studio — its own window (the "My Workspace" surface in the 3-window model). Single
// instance: re-focus if already open. Shares the chat preload (adds window.sq.editor.*).
function createEditorWindow() {
  if (editorWindow && !editorWindow.isDestroyed()) { editorWindow.focus(); return editorWindow; }
  const windowState = require('./lib/window_state');
  editorWindow = new BrowserWindow({
    ...windowState.options('editor', { width: 1100, height: 820 }),
    backgroundColor: '#0d0d10',
    title: "Editor's Studio",
    autoHideMenuBar: true,
    show: false,   // show on ready-to-show so it surfaces ON TOP (not blank-flashing behind chat)
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  editorWindow.loadFile(path.join(__dirname, 'renderer', 'editor.html'));
  windowState.track(editorWindow, 'editor');
  editorWindow.once('ready-to-show', () => { editorWindow.show(); editorWindow.focus(); });
  editorWindow.on('closed', () => { editorWindow = null; });
  return editorWindow;
}

let workspaceWindow = null;
// My Workspace — Window 3 of the 3-window model: the operator workbench that HOSTS the studios +
// (later) data-browser surfaces. Each surface mounts in a <webview>; the shared preload is forced
// onto every webview so embedded surfaces (the Editor) get window.sq.* untouched.
function createWorkspaceWindow() {
  if (workspaceWindow && !workspaceWindow.isDestroyed()) { workspaceWindow.focus(); return workspaceWindow; }
  const windowState = require('./lib/window_state');
  workspaceWindow = new BrowserWindow({
    ...windowState.options('workspace', { width: 1280, height: 860 }),
    backgroundColor: '#0d0d10',
    title: 'My Workspace',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,   // surfaces are hosted in <webview>
    }
  });
  // Force the shared preload + safe settings onto any surface webview (so window.sq works inside).
  workspaceWindow.webContents.on('will-attach-webview', (_e, webPreferences) => {
    webPreferences.preload = path.join(__dirname, 'preload.js');
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
  });
  workspaceWindow.loadFile(path.join(__dirname, 'renderer', 'workspace.html'));
  windowState.track(workspaceWindow, 'workspace');
  workspaceWindow.once('ready-to-show', () => { workspaceWindow.show(); workspaceWindow.focus(); });
  workspaceWindow.on('closed', () => { workspaceWindow = null; });
  return workspaceWindow;
}

let canvasWindow = null;
let meetWebContents = null;   // the Meet <webview>'s guest webContents (captured on attach) — the driver's handle
let ingestWebContents = null; // the full-ingestion video pane's guest webContents — transcription attach point (Zoe-builder)
let zoeMeetPartitionReady = false;
// The driver (lib/meet_canvas) operates the Meet pane from main via this live guest webContents.
function getMeetWebContents() { return (meetWebContents && !meetWebContents.isDestroyed()) ? meetWebContents : null; }
// The full-ingestion video pane's webContents (audio ON) — the Zoe-builder attaches transcription here.
function getIngestWebContents() { return (ingestWebContents && !ingestWebContents.isDestroyed()) ? ingestWebContents : null; }
// The Meet-in-canvas pane hosts Google Meet in a <webview partition="persist:zoe-google"> — ZOE's
// OWN Google session (zoelanai@…), distinct from the operator's calendar OAuth. Grant camera/mic to
// that partition's session (scoped — never to the whole app) so getUserMedia works inside the pane.
// Idempotent; called when the Canvas window is created.
function configureZoeMeetPartition() {
  if (zoeMeetPartitionReady) return;
  try {
    const sess = session.fromPartition('persist:zoe-google');
    const ALLOW = new Set(['media', 'audioCapture', 'videoCapture', 'fullscreen', 'notifications', 'display-capture']);
    sess.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOW.has(permission)));
    sess.setPermissionCheckHandler((_wc, permission) => ALLOW.has(permission));
    zoeMeetPartitionReady = true;
  } catch (e) { console.error('[meet] partition config failed:', e.message); }
}

// Zoe's Canvas — the THIRD window of the model, distinct from the operator workbench: ZOE's own
// surface for large deliverables + visual aids (she populates it; the saga store is the system of
// record). Also hosts the Meet-in-canvas pane (Slice 6) so she can join meetings as herself without
// monopolizing her dedicated CDP browser. Loads canvas.html directly as a full page.
function createCanvasWindow() {
  if (canvasWindow && !canvasWindow.isDestroyed()) { canvasWindow.focus(); return canvasWindow; }
  configureZoeMeetPartition();
  const windowState = require('./lib/window_state');
  canvasWindow = new BrowserWindow({
    ...windowState.options('canvas', { width: 1280, height: 860 }),
    backgroundColor: '#0d0d10',
    title: "Zoe's Canvas",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,   // hosts the Meet pane's <webview> (Slice 6)
    }
  });
  // The Meet <webview> runs Google content — keep it locked down (no node, isolated) and never force
  // our preload onto it (it's not a Side-Quest surface). The canvas page itself keeps the sq preload.
  canvasWindow.webContents.on('will-attach-webview', (_e, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    delete webPreferences.preload;
    // Allow autoplay so the full-INGESTION pane starts with sound (its embed passes autoplay; the muted
    // monitor tiles don't autoplay, so they stay paused regardless).
    webPreferences.autoplayPolicy = 'no-user-gesture-required';
  });
  // Capture ONLY the Meet webview's guest webContents (not the video-monitor webviews) so the driver
  // can operate the meeting from main. Scoped by URL: a guest that navigates to meet.google.com becomes
  // the meet endpoint (and gets its audio OUTPUT muted — captions are her signal, so no room echo).
  canvasWindow.webContents.on('did-attach-webview', (_e, guest) => {
    const tag = () => {
      let url = ''; try { url = guest.getURL() || ''; } catch {}
      if (/meet\.google\.com/i.test(url)) {
        meetWebContents = guest;
        // MUTE the pane (no aloud playback / no echo) UNLESS the Echo audio-fusion path is on — then the
        // audio must FLOW so it reaches the operator's virtual cable (which Echo loopback-captures); the
        // physical speakers stay silent because that cable isn't them. The config flag = "I've routed it."
        const muteIt = !(() => { try { return require('./lib/config').meetingAudioConfig().enabled; } catch { return false; } })();
        try { guest.setAudioMuted(muteIt); } catch {}
      } else if (/[?&]a=1(&|$)/.test(url) && /\/yt\b/.test(url)) {
        // The full-INGESTION video pane (player URL carries a=1). Expose its webContents so the
        // Zoe-builder can attach transcription/caption-follow. Audio stays ON (ingestion needs sound).
        ingestWebContents = guest;
      }
    };
    try { guest.on('did-navigate', tag); guest.on('did-finish-load', tag); } catch {}
    try { guest.once('destroyed', () => { if (meetWebContents === guest) meetWebContents = null; if (ingestWebContents === guest) ingestWebContents = null; }); } catch {}
  });
  canvasWindow.loadFile(path.join(__dirname, 'renderer', 'canvas.html'));
  windowState.track(canvasWindow, 'canvas');
  canvasWindow.once('ready-to-show', () => { canvasWindow.show(); canvasWindow.focus(); });
  canvasWindow.on('closed', () => { canvasWindow = null; });
  return canvasWindow;
}

// --- Desktop companion (voice-avatar-plan presence layer) — a small frameless, transparent, always-on-top
// window that renders Zoe's VRM face so she's "just there" on the desktop: blinks, reflects her mood, and
// (V4) lip-syncs when she speaks. Gated on companionConfig().enabled AND on her character existing, so a
// clone without data/avatars/zoe.vrm never pops an empty window. Draggable; hide/toggle via IPC.
let companionWindow = null;
function createCompanionWindow() {
  const cfg = config.companionConfig();
  if (!cfg.enabled) return null;
  const vrmPath = path.join(__dirname, 'data', 'avatars', 'zoe.vrm');
  try { if (!require('fs').existsSync(vrmPath)) { console.log('[companion] no data/avatars/zoe.vrm — skipping the presence window'); return null; } } catch { return null; }
  if (companionWindow && !companionWindow.isDestroyed()) { companionWindow.show(); return companionWindow; }

  const windowState = require('./lib/window_state');
  const saved = windowState.options('companion', { width: cfg.width, height: cfg.height });
  // dock to a screen corner on first run (no saved position yet)
  let pos = {};
  if (saved.x == null || saved.y == null) {
    try {
      const { screen } = require('electron');
      const wa = screen.getPrimaryDisplay().workArea;   // excludes the taskbar
      const m = 24;
      const right = cfg.corner.includes('right'), bottom = !cfg.corner.includes('top');
      pos = {
        x: right ? wa.x + wa.width - cfg.width - m : wa.x + m,
        y: bottom ? wa.y + wa.height - cfg.height - m : wa.y + m,
      };
    } catch {}
  }
  companionWindow = new BrowserWindow({
    ...saved, ...pos, width: cfg.width, height: cfg.height,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: true, skipTaskbar: true, alwaysOnTop: cfg.alwaysOnTop, fullscreenable: false,
    title: 'Zoe',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      autoplayPolicy: 'no-user-gesture-required',   // she speaks without a click gate
    },
  });
  if (cfg.alwaysOnTop) { try { companionWindow.setAlwaysOnTop(true, 'screen-saver'); } catch {} }
  companionWindow.loadFile(path.join(__dirname, 'renderer', 'companion.html'));
  windowState.track(companionWindow, 'companion');
  companionWindow.on('closed', () => { companionWindow = null; });
  return companionWindow;
}

// Speak a chat reply aloud through the companion (V4): synthesize her words with local Piper (persistent
// sidecar, ~sub-100ms warm) → hand the wav to the companion window, which plays it AND lip-syncs the avatar
// to its amplitude. Gated on TTS being enabled + a voice configured + the companion being present & visible
// (hidden = muted). Fire-and-forget + fail-soft: never blocks or breaks the chat turn.
async function speakThroughCompanion(text) {
  try {
    if (!companionWindow || companionWindow.isDestroyed() || !companionWindow.isVisible()) return;
    const tc = config.ttsConfig();
    if (!tc.enabled || !tc.configured) return;
    const tts = require('./lib/tts');
    const clean = tts.prepareText(text);
    if (!clean || clean.length < 2) return;
    const res = await tts.synthesize(clean, { voice: tc.voice, speaker: tc.speaker, wallMs: tc.wallMs });
    if (!res || !res.ok) { if (res && res.error) console.error('[companion] tts failed:', res.error); return; }
    const fileUrl = require('url').pathToFileURL(res.out).href;
    if (companionWindow && !companionWindow.isDestroyed()) companionWindow.webContents.send('companion:speak', { url: fileUrl });
  } catch (e) { console.error('[companion] speak failed:', e.message); }
}

app.whenReady().then(() => {
  config.loadEnv();
  db.init();
  try { editorRegistry.init(); } catch (e) { console.error('[main] editor registry init failed:', e.message); }
  // Curator: deterministic hygiene at session start — age long-stalled threads to
  // 'abandoned', and aggressively prune spiral/prude/junk thoughts + search-junk readings
  // so they can't re-seed the idle loop on boot.
  try { curatorLib.curateThreads(); curatorLib.curateGaps(); curatorLib.curateMonologue(); } catch (e) { console.error('[main] curator failed:', e.message); }
  // Keep pruning spiral/junk during long sessions (write-time guard catches most; this
  // sweeps anything that slips through, e.g. junk readings from tool output).
  setInterval(() => { try { curatorLib.curateMonologue(); } catch (e) { console.error('[main] periodic curateMonologue failed:', e.message); } }, 20 * 60 * 1000).unref?.();

  // DAILY CURATION PASS (gated, default OFF). The cloud_curator orchestrator — quarantine prune +
  // cloud near-dup/self-evo merge + graph adjudication — once per ~20h, ONLY when she's been idle
  // (not mid-conversation) and ONLY when ZOE_CURATION_ENABLED is set. Runs in THIS process (the
  // app's own db connection → no WAL contention) and backs up first (rotating single file), so a
  // pass is reversible. Cloud stages fail-safe to no-ops if the tier is unreachable.
  // Cadence tunable via env (production defaults; lower for a testing window).
  const CURATION_MIN_GAP_MS = (parseFloat(process.env.ZOE_CURATION_MIN_GAP_HRS) || 20) * 60 * 60 * 1000;
  const CURATION_IDLE_MS = (parseFloat(process.env.ZOE_CURATION_IDLE_MIN) || 15) * 60 * 1000;
  const CURATION_CHECK_MS = (parseFloat(process.env.ZOE_CURATION_CHECK_MIN) || 30) * 60 * 1000;
  let curationRunning = false;
  // AUDITOR cadence — DECOUPLED from the 20h curation pass. The integrity auto-cleaner is a light
  // background sweep, so it runs on its OWN fast tick and is write-triggered: Echo only pays for a full
  // scan when civic_graph's fingerprint actually advanced (new data landed) or the safety net elapsed.
  // Zoe just polls often and floors the dispatch rate so it can't thrash on a busy write day.
  const AUDIT_CHECK_MS = (parseFloat(process.env.ZOE_AUDIT_CHECK_MIN) || 10) * 60 * 1000;   // how often we POLL
  const AUDIT_MIN_GAP_MS = (parseFloat(process.env.ZOE_AUDIT_MIN_GAP_MIN) || 30) * 60 * 1000; // floor between sweeps
  let auditRunning = false;
  // Timestamped backup before each pass, keeping only the most recent 5 (so an unattended bad
  // pass can't erase the good recovery point the way a single overwritten file would).
  const curationBackup = () => {
    const fs = require('fs');
    db.getDb().pragma('wal_checkpoint(TRUNCATE)');                 // fold WAL → a single-file snapshot is complete
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    fs.copyFileSync(db.DB_PATH, `${db.DB_PATH}.precuration_${stamp}`);
    try {
      const dir = path.dirname(db.DB_PATH), pre = path.basename(db.DB_PATH) + '.precuration_';
      const baks = fs.readdirSync(dir).filter((f) => f.startsWith(pre)).sort();
      for (const old of baks.slice(0, -5)) { try { fs.unlinkSync(path.join(dir, old)); } catch {} }
    } catch {}
  };
  // Perception beat: leave a first-person note in the sheep panel of what the pass tidied, so the
  // pass is observable (not silent console) and she's aware she consolidated.
  const curationBeat = (stages) => {
    const parts = [];
    if (stages.nearDup && stages.nearDup.collapsed) parts.push(`folded ${stages.nearDup.collapsed} near-duplicate notes together`);
    if (stages.selfEvo && stages.selfEvo.collapsed) parts.push(`consolidated ${stages.selfEvo.collapsed} repeated self-notes`);
    if (stages.quarantine && stages.quarantine.removed) parts.push(`cleared ${stages.quarantine.removed} stale markers`);
    if (stages.graph && stages.graph.rejected) parts.push(`retired ${stages.graph.rejected} stale proposals`);
    if (stages.graphPromote && stages.graphPromote.promoted) parts.push(`carried ${stages.graphPromote.promoted} matured connection${stages.graphPromote.promoted === 1 ? '' : 's'} up to long-term memory`);
    const text = parts.length
      ? `[Memory consolidation] I took a moment to tidy my memory — ${parts.join(', ')}. It feels a little clearer.`
      : `[Memory consolidation] I looked over my memory for clutter; nothing needed tidying this time.`;
    try {
      const row = db.insertMonologue({ content: text, model: 'curation', type: 'reading' });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
    } catch (e) { console.error('[curation] beat failed:', e.message); }
  };
  const maybeRunCuration = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_CURATION_ENABLED || '').trim())) return;
    if (curationRunning) return;
    if (Date.now() - parseInt(db.getMeta('last_curation_pass_at') || '0', 10) < CURATION_MIN_GAP_MS) return;
    if (Date.now() - lastUserTurnTs < CURATION_IDLE_MS) return;    // not while recently active
    try { curationBackup(); } catch (e) { console.error('[curation] backup failed — skipping pass:', e.message); return; }
    curationRunning = true;
    db.setMeta('last_curation_pass_at', String(Date.now()));       // claim the slot before running
    console.log('[curation] starting daily pass…');
    try {
      // PROMOTE-UP wiring (option 2, Slice 3): cross matured local short-term edges UP to Echo. Only when Echo
      // is connected; reuses the walker's own propose_relation dispatch (open-vocab), and Echo itself is the
      // accept/reject gate — a young endpoint is simply refused and retried a later night.
      const proposeEchoRelationFn = (echoSuit && echoSuit.connected)
        ? (edge) => require('./lib/graph_walk').proposeRelation({
            dispatch: (t) => echoSuit.dispatch(t), source: edge.source, target: edge.target,
            relation_type: edge.relation_type, confidence: edge.confidence, metadata: edge.metadata, allowOpen: true
          })
        : null;
      const r = await cloudCurator.runDailyPass({ apply: true, proposeEchoRelationFn, onLog: (m) => console.log('[curation]', m) });
      console.log('[curation] pass complete:', JSON.stringify(r.stages));
      curationBeat(r.stages);
      // NEWS daily pass (Data-Stream lane): worthy rolling stories → Echo `event` objects + edges, plus an
      // evidence doc per story landed into short-term — which rides the promote pass right below into Echo
      // long-term (+ entity extraction). Idempotent on event_ref. Non-autonomous (this nightly slot only).
      try {
        if (echoSuit && echoSuit.connected) {
          const news_lane = require('./lib/news_lane');
          const docStore = require('./lib/doc_store');
          // Phase C: a cloud typed-extractor so the news pass can surface topical CONCEPTS from each
          // promoted story, routed to resolve_or_mint_concept (lazy buffer→corroborate→promote+attach).
          // Null when no cloud model is available → the news concept hook simply skips.
          const _cx = (() => { try { return (require('./lib/models').sources() || []).find(s => s.tier === 'cloud' && s.token); } catch { return null; } })();
          const _newsExtract = _cx
            ? require('./lib/decomp_lane').makeCloudExtractor({ completeFn: require('./lib/ollama').completeDetailed, model: config.extractionModel() || config.subconsciousModel(), base: _cx.base, token: _cx.token })
            : null;
          const nr = await news_lane.runDailyPass({
            dispatch: (t) => echoSuit.dispatch(t),
            landDoc: (d) => docStore.land(d),
            extract: _newsExtract,
            log: (m) => console.log('[news-daily]', m),
          });
          if (nr && (nr.promoted || nr.updated)) {
            const text = `[Memory consolidation] I folded ${nr.promoted} new world event${nr.promoted === 1 ? '' : 's'} into my long-term memory from the news I've been tracking.`;
            const row = db.insertMonologue({ content: text, model: 'news', type: 'reading' });
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
          }
        }
      } catch (e) { console.error('[news-daily] pass failed:', e.message); }
      // SUPERSESSION (D2, PROPOSAL-FIRST): the nightly TERMINATION pass. Scan the functional-predicate edges
      // (HAS_CEO/HAS_CHAIR/SUBSIDIARY_OF — tiny + relation_type-indexed) for REPLACEMENTS: a subject holding
      // two different current values → the earlier valid_from is superseded by the later (decided on WORLD
      // time, never ingest order). Candidates land in the short-term buffer as 'supersede-candidate'
      // observations for operator review — NOTHING is written to the graph (that is D3, flagged/gated).
      try {
        if (echoSuit && echoSuit.connected) {
          const supersession = require('./lib/supersession');
          const curationStore = require('./lib/curation_store');
          const dispatch = (t) => echoSuit.dispatch(t);
          const sc = await supersession.runReplacementScan({ dispatch });
          let landed = 0;
          for (const c of sc.candidates) {
            try {
              const r = curationStore.record(db, { feed: 'supersession', sourceEntity: c.subjectName || String(c.source_id), relation: c.relation, target: c.loserTarget || String(c.supersededId), value: c.winnerTarget ? `superseded_by:${c.winnerTarget}` : `superseded_by:#${c.supersededBy}`, status: 'supersede-candidate', confidence: c.winnerConfidence });
              if (r.inserted) landed++;
            } catch { /* per-candidate fail-soft */ }
          }
          if (sc.candidates.length) console.log(`[supersession] ${sc.summary.assessed} functional edges → ${sc.candidates.length} replacement candidate(s), ${landed} new (operator review)`);
          // TERMINATION (D2, valid_to passed): the catch-lane for predetermined expiries. DORMANT until C1
          // lands world-time valid_to into the column (0 rows today → instant no-op); arms automatically.
          const ts = await supersession.runTerminationScan({ dispatch });
          let tLanded = 0;
          for (const c of ts.candidates) {
            try {
              const r = curationStore.record(db, { feed: 'supersession', sourceEntity: String(c.source_id), relation: c.relation, target: String(c.target_id), value: 'terminated:valid_to_passed', status: 'supersede-candidate', confidence: 0.9 });
              if (r.inserted) tLanded++;
            } catch { /* per-candidate fail-soft */ }
          }
          if (ts.candidates.length) console.log(`[supersession] ${ts.summary.assessed} valid_to edges → ${ts.candidates.length} termination candidate(s), ${tLanded} new (operator review)`);
        }
      } catch (e) { console.error('[supersession] scan failed:', e.message); }
      // DECAY SWEEP (C4 catch-lane): the graph-walk decays what it VISITS continuously; this nightly
      // sweep catches stale FAST-decay edges (roles/office, relation_type-indexed) the walk never lands
      // on → re-verify observations in the short-term buffer. READ-ONLY producer; the re-fetch consumer
      // is the Puller lane (its own design session), so these are an operator-visible worklist for now.
      try {
        if (echoSuit && echoSuit.connected) {
          const { runDecaySweep } = require('./lib/decay_pass');
          const curationStore = require('./lib/curation_store');
          const sweep = await runDecaySweep({ dispatch: (t) => echoSuit.dispatch(t) });
          let rvLanded = 0;
          for (const rv of sweep.reverify) {
            try {
              const r = curationStore.record(db, { feed: 'decay', sourceEntity: rv.source_name || String(rv.source_id), relation: rv.predicate, target: rv.target_name || String(rv.target_id), value: `reverify:decayed_to_${rv.decayed.toFixed(2)}`, status: 'reverify', confidence: rv.decayed });
              if (r.inserted) rvLanded++;
            } catch { /* per-fact fail-soft */ }
          }
          if (sweep.reverify.length) console.log(`[decay] ${sweep.summary.assessed} FAST edges → ${sweep.reverify.length} below floor, ${rvLanded} new re-verify (operator/puller)`);
        }
      } catch (e) { console.error('[decay] sweep failed:', e.message); }
      // SEMANTIC DEDUP (D1, PROPOSAL-ONLY): scan civic_graph for duplicate entities (blocking + rapidfuzz)
      // → pending resolution_proposals for operator review. Non-destructive; apply is a separate operator
      // decision. Signature-deduped, so re-runs never pile. Bounded (top-degree) so it's a cheap nightly.
      try {
        if (echoSuit && echoSuit.connected) {
          const dr = await echoSuit.dispatch({ kind: 'do', name: 'run_semantic_dedup', args: { limit: 50000 } });
          let rep = null; try { rep = JSON.parse(dr && dr.text); } catch {}
          if (rep) console.log(`[dedup] scanned=${rep.scanned || 0} clusters=${rep.clusters || 0} new-proposals=${rep.new != null ? rep.new : '?'} (operator review)`);
        }
      } catch (e) { console.error('[dedup] semantic scan failed:', e.message); }
      // (The RECURSIVE AUDITOR auto-cleaner used to run here on the 20h curation cadence — it is now
      // DECOUPLED onto its own fast, write-triggered tick: maybeRunAudit / AUDIT_CHECK_MS below.)
      // PROMOTION (short-term → long-term): consolidate the day's new short-term documents into Echo
      // long-term (vault doc + KG entities), on the SAME nightly cadence as curation.
      try {
        const pr = await promoteDocumentsPass({});
        const beat = require('./lib/promote').promotionBeat(pr);
        if (beat) {
          const text = `[Memory consolidation] I ${beat} — they're part of my long-term memory now.`;
          const row = db.insertMonologue({ content: text, model: 'promotion', type: 'reading' });
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
        }
      } catch (e) { console.error('[promote] pass failed:', e.message); }
      // RETENTION (Slice 3): tidy the short-term store — trim long-promoted docs to a pointer (full text
      // lives in Echo now) + drop skip-marked stragglers, so short-term stays a fast working set.
      try { retentionPass({}); } catch (e) { console.error('[retention] pass failed:', e.message); }
      // NEWS CAPTURES retention: drop broadcast screenshot PNGs (derived/regenerable) + rows past the window
      // so data/news_captures stays bounded. Window via NEWS_CAPTURES_RETAIN_DAYS (default 7). Raw RSS items
      // are NOT pruned here — that reservoir's retention policy is intentionally left to an explicit decision.
      try {
        const retainDays = parseInt(process.env.NEWS_CAPTURES_RETAIN_DAYS || '', 10) || 7;
        const pc = require('./lib/video_capture').pruneCapturesOlderThan(Date.now() - retainDays * 86400000);
        if (pc.files || pc.rows) console.log(`[news-captures] retention — ${pc.files} PNGs + ${pc.rows} rows older than ${retainDays}d dropped`);
      } catch (e) { console.error('[news-captures] retention failed:', e.message); }
    } catch (e) { console.error('[curation] pass failed:', e.message); }
    finally { curationRunning = false; }
  };
  setInterval(() => { maybeRunCuration().catch(() => {}); }, CURATION_CHECK_MS).unref?.();
  // RECURSIVE AUDITOR (E1, AUTOPILOT) — its OWN fast, write-triggered tick, decoupled from the 20h
  // curation pass so the graph is swept minutes after new data lands, not once a day. Zoe polls every
  // ~10min and floors dispatch to once/30min (can't thrash); Echo's run_foundation_audit is the real
  // cost gate — it only pays for a full scan when civic_graph's fingerprint advanced (new writes) or the
  // 12h safety net elapsed, and returns {skipped:'unchanged'} cheaply otherwise. Reversible + backup-first
  // + regression-auto-kill. Pull the plug LIVE (no reboot): audit_state.autopilot='off'.
  const maybeRunAudit = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_CURATION_ENABLED || '').trim())) return;  // same master switch
    if (auditRunning) return;
    if (!echoSuit || !echoSuit.connected) return;
    if (Date.now() - parseInt(db.getMeta('last_audit_dispatch_at') || '0', 10) < AUDIT_MIN_GAP_MS) return;  // floor
    auditRunning = true;
    db.setMeta('last_audit_dispatch_at', String(Date.now()));    // claim the slot before the round-trip
    try {
      const ar = await echoSuit.dispatch({ kind: 'do', name: 'run_integrity_audit', args: {} });
      let rep = null; try { rep = JSON.parse(ar && ar.text); } catch {}
      if (rep && !(rep.skipped === 'unchanged')) {                // don't log the cheap idle no-op
        console.log(rep.skipped
          ? `[audit] auto-cleaner skipped (${rep.skipped})`
          : `[audit] auto-cleaner (${rep.reason || 'scan'}): fixed=${rep.total_fixed || 0} converged=${!!rep.converged}${rep.halted ? ` HALTED(${rep.halted})` : ''}${rep.auto_killed ? ' AUTOPILOT-DISARMED' : ''}`);
        if (rep.total_fixed) {
          const text = `[Memory upkeep] My integrity auditor reversibly cleaned ${rep.total_fixed} structural error${rep.total_fixed === 1 ? '' : 's'} out of the graph.`;
          const row = db.insertMonologue({ content: text, model: 'audit', type: 'reading' });
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
        }
      }
    } catch (e) { console.error('[audit] auto-cleaner failed:', e.message); }
    finally { auditRunning = false; }
  };
  setInterval(() => { maybeRunAudit().catch(() => {}); }, AUDIT_CHECK_MS).unref?.();
  // PHASE A3 — EVENT AGING SWEEP (the state-flip, tied to the pulse). A 'scheduled' event whose WORLD-time
  // (occurred_at) has passed flips to 'unconfirmed_past' — a QUESTION to verify ("should have happened"),
  // NEVER an assertion it occurred; a source (news/reconcile) later closes it to occurred|rescheduled|
  // cancelled. CATCH-UP SAFE: Echo flips on occurred_at<now regardless of when it last ran, so an offline
  // gap self-heals on the next tick. Same master switch as curation; cheap (partial index on the flip).
  const AGING_CHECK_MS = (parseFloat(process.env.ZOE_AGING_CHECK_MIN) || 60) * 60 * 1000;
  let agingRunning = false;
  const maybeRunEventAging = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_CURATION_ENABLED || '').trim())) return;
    if (agingRunning) return;
    if (!echoSuit || !echoSuit.connected) return;
    if (Date.now() - parseInt(db.getMeta('last_event_aging_at') || '0', 10) < AGING_CHECK_MS) return;
    agingRunning = true;
    db.setMeta('last_event_aging_at', String(Date.now()));
    try {
      const ar = await echoSuit.dispatch({ kind: 'do', name: 'run_event_aging', args: {} });
      let rep = null; try { rep = JSON.parse(ar && ar.text); } catch {}
      if (rep && rep.flipped > 0) console.log(`[aging] ${rep.flipped} scheduled event(s) past their time → unconfirmed_past (queued to verify)`);
    } catch (e) { console.error('[aging] event-aging sweep failed:', e.message); }
    finally { agingRunning = false; }
  };
  setInterval(() => { maybeRunEventAging().catch(() => {}); }, AGING_CHECK_MS).unref?.();
  setTimeout(() => { maybeRunEventAging().catch(() => {}); }, 120000).unref?.();   // catch-up kick ~2min after boot
  // F2 GATE-LESS GROUNDED AUTO-PROMOTE LANE — the landing gap closed. Staged proposals used to sit
  // unpromoted (operator-gated); this drains the GROUNDED promote-band (calibrated conf >= floor + a real
  // citation) into civic_graph autonomously, in bounded chunks until the queue empties. Every promotion is
  // reversible + logged (Echo auto_promotion_log → revert_auto_promotion). SEPARATE master switch
  // ZOE_INGEST_ENABLED (default OFF) so it's armed deliberately + monitored, like the auto-cleaner was.
  // STREAMING cadence (Lucas 2026-07-10 — "don't hold the promote for batches"): drain near-continuously so
  // grounded proposals — and especially EDGES, which land here rather than inline — promote within ~1 min of
  // being built, not on a 20-min batch. Builder inline-promote lands new NODES immediately; this keeps their
  // edges + any non-inline records flowing right behind. Env-overridable if it needs throttling.
  const INGEST_CHECK_MS = (parseFloat(process.env.ZOE_INGEST_CHECK_MIN) || 1) * 60 * 1000;    // poll cadence
  const INGEST_MIN_GAP_MS = (parseFloat(process.env.ZOE_INGEST_MIN_GAP_MIN) || 1) * 60 * 1000; // floor between drains
  const INGEST_CHUNK = parseInt(process.env.ZOE_INGEST_CHUNK || '', 10) || 200;                // proposals per chunk
  const INGEST_FLOOR = parseFloat(process.env.ZOE_INGEST_FLOOR) || 0.90;                        // the promote-band floor
  let ingestRunning = false;
  const maybeDrainIngest = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_INGEST_ENABLED || '').trim())) return;  // gate-less lane: OFF until armed
    if (ingestRunning) return;
    if (!echoSuit || !echoSuit.connected) return;
    if (Date.now() - parseInt(db.getMeta('last_ingest_drain_at') || '0', 10) < INGEST_MIN_GAP_MS) return;  // floor
    ingestRunning = true;
    db.setMeta('last_ingest_drain_at', String(Date.now()));
    try {
      const ingestLane = require('./lib/ingest_lane');
      const runId = `ingest-${Date.now()}`;                    // ONE id for the whole drain → one-call revert
      const runChunk = async () => {
        const dr = await echoSuit.dispatch({ kind: 'do', name: 'auto_promote_grounded', args: { min_confidence: INGEST_FLOOR, limit: INGEST_CHUNK, run_id: runId } });
        let rep = null; try { rep = JSON.parse(dr && dr.text); } catch {}
        return { promoted: (rep && rep.promoted) || 0, remaining: (rep && rep.remaining != null) ? rep.remaining : 0 };
      };
      const res = await ingestLane.drainUntilEmpty(runChunk, { maxIters: 40 });
      if (res.totalPromoted > 0) db.setMeta('last_ingest_run_id', runId);   // remember for a quick revert if needed
      if (res.totalPromoted > 0 || res.stopped === 'error') {
        console.log(`[ingest] gate-less drain: promoted=${res.totalPromoted} over ${res.iters} chunk(s) → ${res.stopped}`);
        if (res.totalPromoted > 0) {
          const text = `[Memory building] I auto-integrated ${res.totalPromoted} grounded fact${res.totalPromoted === 1 ? '' : 's'} into my long-term graph — verified + reversible, no gate.`;
          const row = db.insertMonologue({ content: text, model: 'ingest', type: 'reading' });
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
        }
      }
    } catch (e) { console.error('[ingest] drain failed:', e.message); }
    finally { ingestRunning = false; }
  };
  setInterval(() => { maybeDrainIngest().catch(() => {}); }, INGEST_CHECK_MS).unref?.();
  // F3 RESEARCH-TO-CLOSE-THE-GAP — the third outcome, wired live. Pulls the RESEARCH band from tenant
  // staging (mid-band 0.72–0.90, or promote-conf-but-ungrounded relations), runs research_lane.runResearchItem
  // backed by the AUTHORITATIVE tool surface (FEC/LegiScan/MediaWiki/GDELT) + her LIVE browser
  // (research_sources), and re-stamps a lifted proposal (restamp_relation_proposal) so the next F2 drain
  // promotes it. Separate switch ZOE_RESEARCH_ENABLED (default OFF — it drives her live browser, so arm it
  // deliberately). Idle-gated (never mid-conversation), bounded per tick, in-session cooldown per proposal.
  const RESEARCH_CHECK_MS = (parseFloat(process.env.ZOE_RESEARCH_CHECK_MIN) || 15) * 60 * 1000;
  const RESEARCH_MIN_GAP_MS = (parseFloat(process.env.ZOE_RESEARCH_MIN_GAP_MIN) || 20) * 60 * 1000;
  const RESEARCH_BATCH = parseInt(process.env.ZOE_RESEARCH_BATCH || '', 10) || 3;
  const RESEARCH_IDLE_MS = (parseFloat(process.env.ZOE_RESEARCH_IDLE_MIN) || 5) * 60 * 1000;
  let researchRunning = false;
  const researchTried = new Set();   // in-session cooldown: don't re-research the same proposal this boot
  const maybeRunResearch = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_RESEARCH_ENABLED || '').trim())) return;  // arm deliberately (drives her browser)
    if (researchRunning) return;
    if (!echoSuit || !echoSuit.connected) return;
    if (Date.now() - lastUserTurnTs < RESEARCH_IDLE_MS) return;                 // never drive her browser mid-conversation
    if (Date.now() - parseInt(db.getMeta('last_research_at') || '0', 10) < RESEARCH_MIN_GAP_MS) return;
    researchRunning = true;
    db.setMeta('last_research_at', String(Date.now()));
    try {
      const researchLane = require('./lib/research_lane');
      const researchExec = require('./lib/research_exec');
      const researchSources = require('./lib/research_sources');
      const promoteGate = require('./lib/promote_gate');
      let browser = null; try { browser = require('./lib/browser'); } catch {}
      const dispatch = (t) => echoSuit.dispatch(t);
      const search = researchSources.makeSearch({ dispatch, browser });
      const fetch = researchSources.makeFetch({ dispatch, browser });
      // the RESEARCH band: mid-confidence, OR promote-confidence but ungrounded (no real source_set)
      const sql = "SELECT rp.id, rp.confidence, rp.relation_type rt, rp.relation_metadata md, es.name sn, et.name tn"
        + " FROM tenant_rainey.relation_proposals rp"
        + " JOIN entities es ON es.id = rp.source_id JOIN entities et ON et.id = rp.target_id"
        + " WHERE rp.deleted = 0 AND ((rp.confidence >= 0.72 AND rp.confidence < 0.90)"
        + "   OR (rp.confidence >= 0.90 AND (rp.relation_metadata IS NULL OR rp.relation_metadata NOT LIKE '%\"source_set\": [\"%')))"
        + ` ORDER BY rp.confidence DESC LIMIT ${RESEARCH_BATCH * 4}`;
      let rows = [];
      try { const res = await dispatch({ kind: 'do', name: 'db_query', args: { sql } }); rows = (JSON.parse(res && res.text) || {}).rows || []; } catch { rows = []; }
      let lifted = 0, worked = 0;
      for (const row of rows) {
        if (worked >= RESEARCH_BATCH) break;
        if (researchTried.has(row.id)) continue;
        researchTried.add(row.id);
        worked++;
        let md = {}; try { md = JSON.parse(row.md || '{}'); } catch {}
        const proposal = { source_name: row.sn, target_name: row.tn, relation: row.rt, confidence: row.confidence, metadata: md };
        const corroborate = researchExec.makeCorroborate({ search, existing: Array.isArray(md.source_set) ? md.source_set : [] });
        const verifyCitation = researchExec.makeVerifyCitation({ search, fetch });
        let out = null;
        try { out = await researchLane.runResearchItem(proposal, { search: corroborate, verifyCitation, maxAttempts: 1 }); } catch { out = null; }
        if (out && out.outcome === 'promote') {
          const conf = promoteGate.classify(out.proposal).confidence;
          const sources = (out.proposal.metadata && out.proposal.metadata.source_set) || [];
          try { await dispatch({ kind: 'do', name: 'restamp_relation_proposal', args: { relation_id: row.id, confidence: conf, sources } }); lifted++; } catch {}
        }
      }
      if (worked) {
        console.log(`[research] worked ${worked} gap proposal(s) → ${lifted} lifted over the bar (F2 will promote)`);
        if (lifted) {
          const text = `[Memory building] I researched ${worked} shaky fact${worked === 1 ? '' : 's'} and grounded ${lifted} of them over the promotion bar — real sources, no gate.`;
          const r2 = db.insertMonologue({ content: text, model: 'research', type: 'reading' });
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: r2.id, ts: r2.ts, content: text, type: 'reading' });
        }
      }
    } catch (e) { console.error('[research] pass failed:', e.message); }
    finally { researchRunning = false; }
  };
  setInterval(() => { maybeRunResearch().catch(() => {}); }, RESEARCH_CHECK_MS).unref?.();
  // F4 CONTEXTUAL IDENTITY-DEDUP SWEEP — its OWN write-triggered tick (mirrors the auto-cleaner). The
  // retrospective Tracy fix: fold pre-F1 fragments into their canonical. A Puller-store FINGERPRINT gate
  // keeps it cheap — the idle poll is two MAX() reads (~ms) and the O(n²) sweep only pays when a target/
  // observation was actually written since the last run; a floor caps it under heavy writes. apply:true
  // auto-folds ONLY the safe tier (role-narrowed, conf>=0.8, degree<=3, all reversible + logged);
  // attractors + ambiguous + softer proposals are SURFACED (Puller window), never auto-resolved. Separate
  // switch ZOE_DEDUP_ENABLED (default OFF — arm deliberately). Pull the plug: ZOE_DEDUP_ENABLED=0 + reboot.
  const DEDUP_CHECK_MS = (parseFloat(process.env.ZOE_DEDUP_CHECK_MIN) || 10) * 60 * 1000;
  const DEDUP_MIN_GAP_MS = (parseFloat(process.env.ZOE_DEDUP_MIN_GAP_MIN) || 30) * 60 * 1000;   // floor between sweeps
  let dedupRunning = false;
  const maybeRunDedup = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_DEDUP_ENABLED || '').trim())) return;   // arm deliberately
    if (dedupRunning) return;
    if (Date.now() - parseInt(db.getMeta('last_dedup_at') || '0', 10) < DEDUP_MIN_GAP_MS) return;   // floor
    let pdb; try { pdb = require('./lib/puller_db'); pdb.init(); } catch { return; }
    let fp = '0:0'; try { fp = pdb.storeFingerprint(); } catch {}
    if (fp === db.getMeta('last_dedup_fingerprint')) return;    // FINGERPRINT GATE — no writes → nothing to sweep
    dedupRunning = true;
    db.setMeta('last_dedup_at', String(Date.now()));
    try {
      const corrections = require('./lib/puller_corrections');
      const r = corrections.runSweep({ apply: true });         // auto-fold the safe tier; surface the rest
      db.setMeta('last_dedup_fingerprint', fp);
      if (r.autoApplied.length || r.attractorFlags.length || r.proposals.length) {
        console.log(`[dedup] sweep (scanned ${r.scanned}, ${r.candidates} weak): auto-folded=${r.autoApplied.length} proposals=${r.proposals.length} flagged=${r.attractorFlags.length}`);
        if (r.autoApplied.length) {
          const text = `[Memory upkeep] I reversibly merged ${r.autoApplied.length} duplicate contact fragment${r.autoApplied.length === 1 ? '' : 's'} back into the right person — the "same name, split record" problem, cleaned.`;
          const row = db.insertMonologue({ content: text, model: 'dedup', type: 'reading' });
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
        }
      }
    } catch (e) { console.error('[dedup] sweep failed:', e.message); }
    finally { dedupRunning = false; }
  };
  setInterval(() => { maybeRunDedup().catch(() => {}); }, DEDUP_CHECK_MS).unref?.();
  // PULLER CLOSE-THE-LOOP — after an email bounces, the Puller proposes a next-pattern flip (a pending
  // revision) + enqueues a retest, but NOTHING accepted them autonomously → new guesses sat frozen 'pending'
  // (485 of them) while the dead address stayed the active belief. This tick APPLIES pending EMAIL flips
  // (each supersession-guarded inside decideRevision — a stale/weak flip is refused), swapping the dead
  // address for its best next-guess and marking send_state='rerun_pending' so it lands in the next
  // verification upload AND surfaces (marked) in pulled lists. PROPOSE→APPLY only: no sending, no probing.
  // Flag ZOE_PULLER_LOOP_ENABLED (default OFF). Pull the plug: =0 + reboot.
  const PLOOP_CHECK_MS = (parseFloat(process.env.ZOE_PULLER_LOOP_CHECK_MIN) || 30) * 60 * 1000;
  const PLOOP_MIN_GAP_MS = (parseFloat(process.env.ZOE_PULLER_LOOP_MIN_GAP_MIN) || 60) * 60 * 1000;
  const PLOOP_BATCH = parseInt(process.env.ZOE_PULLER_LOOP_BATCH || '', 10) || 200;
  let pLoopRunning = false;
  const maybeRunPullerLoop = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_PULLER_LOOP_ENABLED || '').trim())) return;   // arm deliberately
    if (pLoopRunning) return;
    if (Date.now() - parseInt(db.getMeta('last_puller_loop_at') || '0', 10) < PLOOP_MIN_GAP_MS) return;   // floor
    let pdb, revise;
    try { pdb = require('./lib/puller_db'); pdb.init(); revise = require('./studio/puller_revise'); } catch { return; }
    pLoopRunning = true;
    db.setMeta('last_puller_loop_at', String(Date.now()));
    try {
      const pending = pdb.listRevisions({ status: 'pending' })
        .filter(r => (r.attr === 'email' || !r.attr) && r.to_value && String(r.to_value).includes('@'))
        .slice(0, PLOOP_BATCH);
      let applied = 0, refused = 0;
      for (const rev of pending) {
        try { const r = revise.decideRevision(rev.id, 'accepted'); if (r && r.applied) applied++; else refused++; } catch { refused++; }
      }
      if (pending.length) {
        console.log(`[puller-loop] accepted ${applied}/${pending.length} pending email flips → rerun_pending (${refused} refused by supersession guard)`);
        if (applied > 0) {
          const text = `[Memory upkeep] Closed the loop on ${applied} bounced contact${applied === 1 ? '' : 's'} — swapped each dead address for its best next-guess, queued for the next verification run.`;
          const row = db.insertMonologue({ content: text, model: 'puller-loop', type: 'reading' });
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
        }
      }
    } catch (e) { console.error('[puller-loop] failed:', e.message); }
    finally { pLoopRunning = false; }
  };
  setInterval(() => { maybeRunPullerLoop().catch(() => {}); }, PLOOP_CHECK_MS).unref?.();
  // KG BLOCKING DEDUP — the PACED, event-driven "clean within range" lane (Lucas: faster not instant). Not a
  // full-corpus firehose: INCREMENTAL — each pass works only the blocks TOUCHED by nodes changed since the
  // last run (changed_since cursor), so it lands a steady trickle of resolution_proposals as the standard
  // pipeline fills in nodes. PROPOSAL-ONLY (nothing merged — apply stays gated); an in-line SANITY gate holds
  // the cursor back on an anomalous burst so nothing runs away. Floored + flagged; a long gap keeps it calm
  // (dedup is housekeeping, not urgent). Switch ZOE_KG_DEDUP_ENABLED (default OFF — arm deliberately, writes
  // the master graph's proposal queue). Pull the plug: ZOE_KG_DEDUP_ENABLED=0 + reboot.
  const KGDEDUP_CHECK_MS = (parseFloat(process.env.ZOE_KG_DEDUP_CHECK_MIN) || 60) * 60 * 1000;   // poll cadence
  const KGDEDUP_MIN_GAP_MS = (parseFloat(process.env.ZOE_KG_DEDUP_MIN_GAP_MIN) || 180) * 60 * 1000; // floor (3h)
  const KGDEDUP_FULL_GAP_MS = (parseFloat(process.env.ZOE_KG_DEDUP_FULL_DAYS) || 7) * 24 * 60 * 60 * 1000; // full-sweep net
  const KGDEDUP_SANITY_CAP = parseInt(process.env.ZOE_KG_DEDUP_SANITY_CAP || '', 10) || 8000;      // per-run burst guard
  let kgDedupRunning = false;
  const maybeRunKgDedup = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_KG_DEDUP_ENABLED || '').trim())) return;  // arm deliberately
    if (kgDedupRunning) return;
    if (!echoSuit || !echoSuit.connected) return;
    if (Date.now() - parseInt(db.getMeta('last_kg_dedup_at') || '0', 10) < KGDEDUP_MIN_GAP_MS) return;  // floor
    kgDedupRunning = true;
    db.setMeta('last_kg_dedup_at', String(Date.now()));
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      // FAST+SLOW: the incremental pass ("clean within range") catches dups as nodes change; a periodic FULL
      // SWEEP (changed_since=null) is the SAFETY NET for stale same-block pairs neither node re-touched (the
      // pattern the auditor/ingest lanes use). The full sweep is cheap to LAND (signature-dedup skips
      // everything already proposed), so it mostly banks 0 — it just guarantees nothing slips permanently.
      const dueFull = Date.now() - parseInt(db.getMeta('last_kg_dedup_full_at') || '0', 10) >= KGDEDUP_FULL_GAP_MS;
      const since = dueFull ? null : (parseInt(db.getMeta('last_kg_dedup_ts') || '0', 10) || (nowSec - 7 * 86400));
      const args = (since == null) ? {} : { changed_since: since };
      const dr = await echoSuit.dispatch({ kind: 'do', name: 'run_blocking_dedup', args });
      let rep = null; try { rep = JSON.parse(dr && dr.text); } catch {}
      if (rep && rep.new != null) {
        // IN-LINE AUDIT: an anomalous burst (way past the steady trickle) → do NOT advance the cursor; leave
        // it for the operator to eyeball (the proposals are harmless/pending, but a spike means something
        // upstream changed en masse and we don't want to bank it silently).
        if (rep.new > KGDEDUP_SANITY_CAP) {
          console.warn(`[kg-dedup] ${dueFull ? 'FULL-sweep' : 'incremental'} anomalous burst: ${rep.new} new proposals (> ${KGDEDUP_SANITY_CAP}) — cursor held for review`);
        } else {
          if (dueFull) db.setMeta('last_kg_dedup_full_at', String(Date.now()));   // the net ran clean
          else db.setMeta('last_kg_dedup_ts', String(nowSec));                    // advance the incremental cursor
          if (rep.new > 0) {
            console.log(`[kg-dedup] ${dueFull ? 'full-sweep net' : 'paced pass'}: +${rep.new} merge proposals (${dueFull ? `scanned ${rep.scanned}` : `touched ${rep.touched_blocks} blocks`}, ${rep.pairs} pairs) — pending, operator-gated`);
            const text = `[Memory upkeep] I found ${rep.new} likely-duplicate object${rep.new === 1 ? '' : 's'} ${dueFull ? 'in a full safety-sweep' : 'in the neighborhood of what we just learned'} — queued as reversible merge proposals for review.`;
            const row = db.insertMonologue({ content: text, model: 'kg-dedup', type: 'reading' });
            if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
          }
        }
      }
      // SEMANTIC (ANN) pass — the alias/abbreviation dups string blocking can't see ("Bob"~"Robert",
      // "St"~"Saint"). ALWAYS incremental (query only changed nodes against the standing FAISS index; a full
      // ANN query is the offline index rebuild, never a tick). A missing/among-building index just skips.
      try {
        const annSince = parseInt(db.getMeta('last_kg_dedup_ts') || '0', 10) || (nowSec - 7 * 86400);
        const ar = await echoSuit.dispatch({ kind: 'do', name: 'run_ann_dedup', args: { changed_since: annSince } });
        let arep = null; try { arep = JSON.parse(ar && ar.text); } catch {}
        if (arep && arep.new > 0 && arep.new <= KGDEDUP_SANITY_CAP) {
          console.log(`[kg-dedup] ANN semantic pass: +${arep.new} alias/abbreviation merge proposals (tier semantic) — pending`);
        }
      } catch (e) { /* FAISS index not built yet / ANN unavailable → skip silently */ }
    } catch (e) { console.error('[kg-dedup] paced pass failed:', e.message); }
    finally { kgDedupRunning = false; }
  };
  setInterval(() => { maybeRunKgDedup().catch(() => {}); }, KGDEDUP_CHECK_MS).unref?.();
  // KG DEDUP ADJUDICATION — the LLM evaluator + AUDITED AUTO-APPLY (Slice B, the merge-gate crosser). Judges
  // a BOUNDED batch of pending proposals (max rigor, ~20s each) and auto-applies ONLY the anchored +
  // LLM-confirmed ones through the reversible canonical_id+SAME_AS path, in audited batches (regression check
  // + quick_check → reverse+halt on failure). Slow → small batch + long floor + idle-gated. SEPARATE flag
  // ZOE_KG_APPLY_ENABLED (default OFF) — this WRITES the graph. Pull the plug: ZOE_KG_APPLY_ENABLED=0 + reboot.
  const KGAPPLY_CHECK_MS = (parseFloat(process.env.ZOE_KG_APPLY_CHECK_MIN) || 60) * 60 * 1000;
  const KGAPPLY_MIN_GAP_MS = (parseFloat(process.env.ZOE_KG_APPLY_MIN_GAP_MIN) || 240) * 60 * 1000;  // 4h floor
  const KGAPPLY_BATCH = parseInt(process.env.ZOE_KG_APPLY_BATCH || '', 10) || 25;                     // proposals/run
  const KGAPPLY_IDLE_MS = (parseFloat(process.env.ZOE_KG_APPLY_IDLE_MIN) || 5) * 60 * 1000;
  let kgApplyRunning = false;
  const maybeRunAdjudicate = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_KG_APPLY_ENABLED || '').trim())) return;  // crosses the merge-gate
    if (kgApplyRunning) return;
    if (!echoSuit || !echoSuit.connected) return;
    if (Date.now() - lastUserTurnTs < KGAPPLY_IDLE_MS) return;   // heavy + writes the graph — never mid-conversation
    if (Date.now() - parseInt(db.getMeta('last_kg_apply_at') || '0', 10) < KGAPPLY_MIN_GAP_MS) return;  // floor
    kgApplyRunning = true;
    db.setMeta('last_kg_apply_at', String(Date.now()));
    try {
      // TIER-SCOPED DRAIN (2026-07-10): target the ANCHORED tiers only. They route to the FAST model
      // (gemma ~2s, not the fuzzy tiers' ~20s kimi) AND are high-yield (the anchor lets them apply), so a
      // batch lands real merges in ~minutes instead of a slow blind pass that mostly parks. The fuzzy tiers
      // (name-strong/weak/initial/semantic) stay pending for a later, deliberate pass. Env-overridable.
      const KGAPPLY_TIERS = (process.env.ZOE_KG_APPLY_TIERS || 'strong-id,name-exact').trim();
      // CONCEPTS ARE MANUAL-ONLY (2026-07-12, Lucas): the person/org-tuned judge + the deliberate concept queue
      // (wells/formatting silt) mean concepts get a hand-run scoped pass, never this aggressive global drain.
      const dr = await echoSuit.dispatch({ kind: 'do', name: 'run_dedup_adjudication', args: { batch: KGAPPLY_BATCH, tiers: KGAPPLY_TIERS, exclude_entity_type: 'concept' } });
      let rep = null; try { rep = JSON.parse(dr && dr.text); } catch {}
      if (rep && rep.considered != null) {
        console.log(`[kg-apply] adjudicated ${rep.considered}: applied ${rep.applied || 0}, parked ${rep.parked || 0}${rep.halted ? ` HALTED(${rep.halted})` : ''}`);
        if (rep.applied > 0) {
          const text = `[Memory upkeep] I reviewed and reversibly merged ${rep.applied} confirmed duplicate${rep.applied === 1 ? '' : 's'} — each LLM-verified + structurally anchored, all undoable.`;
          const row = db.insertMonologue({ content: text, model: 'kg-apply', type: 'reading' });
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
          // CURATION-MOVE → the KG-visuals 'absorb' gesture (renderer, other context). One event per real
          // dedup fold that just landed, so the graph view animates the duplicates collapsing onto their
          // survivor. Contract: kg:curation-move {kind:'dedup', tier, count, anchor}. Echo caps the sample at
          // 25/tick so a big drain batch can't flood the renderer. Purely additive; safe if no receiver.
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              for (const s of (Array.isArray(rep.applied_sample) ? rep.applied_sample : [])) {
                mainWindow.webContents.send('kg:curation-move', { kind: 'dedup', tier: s.tier || null, count: s.count || 1, anchor: s.anchor || null });
              }
            }
          } catch {}
        }
      }
    } catch (e) { console.error('[kg-apply] adjudication failed:', e.message); }
    finally { kgApplyRunning = false; }
  };
  setInterval(() => { maybeRunAdjudicate().catch(() => {}); }, KGAPPLY_CHECK_MS).unref?.();
  // NIGHTLY FULL DEDUP SWEEP (2026-07-10): the GUARANTEED once-a-day net. The write-triggered dedup + the fast
  // apply tick catch the steady flow; this sweep guarantees the WHOLE graph is re-scanned and the anchored
  // queue drained toward empty each calendar day regardless of activity — AND it is the home for the SLOW
  // name-strong tier (a bounded idle-time bite through the reasoning model, never in the latency-sensitive
  // fast tick). Separate flag ZOE_KG_NIGHTLY_ENABLED (default OFF) — it writes the graph. Plug: =0 + reboot.
  const KGNIGHTLY_CHECK_MS = (parseFloat(process.env.ZOE_KG_NIGHTLY_CHECK_MIN) || 30) * 60 * 1000;
  const KGNIGHTLY_MAX_ITERS = parseInt(process.env.ZOE_KG_NIGHTLY_MAX_ITERS || '', 10) || 6;                 // fast-drain safety cap
  const KGNIGHTLY_NAMESTRONG_BATCH = parseInt(process.env.ZOE_KG_NIGHTLY_NAMESTRONG_BATCH || '', 10) || 50; // slow-tier nightly bite (web-corroborated → modest)
  const localDayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const emitAbsorb = (rep) => {   // one kg:curation-move per landed fold — same contract the apply tick uses
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        for (const s of (Array.isArray(rep && rep.applied_sample) ? rep.applied_sample : [])) {
          mainWindow.webContents.send('kg:curation-move', { kind: 'dedup', tier: s.tier || null, count: s.count || 1, anchor: s.anchor || null });
        }
      }
    } catch {}
  };
  let kgNightlyRunning = false;
  const maybeRunNightlyDedupSweep = async () => {
    if (!/^(1|true|yes|on)$/i.test(String(process.env.ZOE_KG_NIGHTLY_ENABLED || '').trim())) return;  // arm deliberately
    if (kgNightlyRunning) return;
    if (!echoSuit || !echoSuit.connected) return;
    if (Date.now() - lastUserTurnTs < KGAPPLY_IDLE_MS) return;         // heavy + writes the graph — never mid-conversation
    if (db.getMeta('last_kg_nightly_day') === localDayStr()) return;   // once per calendar day
    kgNightlyRunning = true;
    db.setMeta('last_kg_nightly_day', localDayStr());                  // claim the slot BEFORE running (idempotent for the day)
    try {
      const tiers = (process.env.ZOE_KG_APPLY_TIERS || 'strong-id,name-exact').trim();
      // 1) FULL blocking sweep (changed_since=null) — bank any stale same-block pairs the incremental cursor
      //    never re-touched. Cheap to land (signature-dedup skips everything already proposed).
      let swept = 0;
      try {
        const dr = await echoSuit.dispatch({ kind: 'do', name: 'run_blocking_dedup', args: {} });
        let drep = null; try { drep = JSON.parse(dr && dr.text); } catch {}
        swept = (drep && drep.new) || 0;
        db.setMeta('last_kg_dedup_full_at', String(Date.now()));       // nightly owns the full net now — keeps the 7-day net quiet
      } catch (e) { console.error('[kg-nightly] blocking sweep failed:', e.message); }
      // 2) Drain the FAST-ANCHORED queue toward empty (bounded). Anchored rarely parks, so it converges; a
      //    parked proposal STAYS pending (store.run_adjudication contract), so we break the moment a batch
      //    lands nothing — never loop on considered>0 or it would re-judge the same parks forever.
      let anchoredApplied = 0;
      for (let i = 0; i < KGNIGHTLY_MAX_ITERS; i++) {
        const ar = await echoSuit.dispatch({ kind: 'do', name: 'run_dedup_adjudication', args: { batch: KGAPPLY_BATCH, tiers, exclude_entity_type: 'concept' } });   // concepts manual-only
        let rep = null; try { rep = JSON.parse(ar && ar.text); } catch {}
        if (!rep || rep.considered == null) break;
        anchoredApplied += rep.applied || 0;
        emitAbsorb(rep);
        if ((rep.applied || 0) === 0 || rep.considered < KGAPPLY_BATCH) break;   // nothing left to apply / queue thin
      }
      // 3) NAME-STRONG bite — ONE bounded pass through the reasoning model. The affirmative-confirm gate
      //    (LLM same=true + conf>=0.70 + a corroborator) already protects it; anti-collapse holds. Idle-time
      //    only, so the slow judge latency is fine. Deliberately NOT looped — a fixed nightly chip of the pile.
      let strongApplied = 0;
      try {
        // web_corroborate: for the name-strong pairs the structural check can't anchor, a web-verified
        // confirmation of identity supplies the EXTERNAL anchor (Lucas: "add outside search for cross-validation")
        // — fires web+cloud only on the otherwise-parking ones. Toggle ZOE_KG_NIGHTLY_WEB_CORROBORATE (default on).
        const webCorr = /^(1|true|yes|on)$/i.test(String(process.env.ZOE_KG_NIGHTLY_WEB_CORROBORATE ?? '1').trim());
        const sr = await echoSuit.dispatch({ kind: 'do', name: 'run_dedup_adjudication', args: { batch: KGNIGHTLY_NAMESTRONG_BATCH, tiers: 'name-strong', web_corroborate: webCorr, exclude_entity_type: 'concept' } });   // concepts manual-only
        let srep = null; try { srep = JSON.parse(sr && sr.text); } catch {}
        if (srep && srep.considered != null) { strongApplied = srep.applied || 0; emitAbsorb(srep); }
      } catch (e) { console.error('[kg-nightly] name-strong pass failed:', e.message); }
      // 3b) CONCEPTS — their OWN dedicated bounded pass. Concepts are EXCLUDED from the global drains above
      //     (person/org-tuned queue), so without this their queue would never be adjudicated. entity_type=
      //     'concept' scope + neighbor_hub_cap so a shared WELL (a hub — every law topic shares "Law &
      //     Justice") can't vacuously anchor a merge; the corroborator must be a SPECIFIC shared neighbor,
      //     restoring the two-signal gate for concepts. Same reversible path. Toggle ZOE_KG_NIGHTLY_CONCEPTS.
      let conceptApplied = 0, conceptNormalized = 0;
      if (/^(1|true|yes|on)$/i.test(String(process.env.ZOE_KG_NIGHTLY_CONCEPTS ?? '1').trim())) {
        // 3b-i) DETERMINISTIC cosmetic normalize FIRST — collapse the case/edge-punct/plural concept dups the
        //       LLM judge parks (Criminal Offense/Offenses, Transportation)/Transportation, Cancer/cancer).
        //       Reversible + audited (quick_check → reverse-run on regression). Clears the silt so the LLM
        //       pass below only faces genuine SEMANTIC calls.
        try {
          const nr = await echoSuit.dispatch({ kind: 'do', name: 'run_concept_normalize', args: { dry_run: false } });
          let nrep = null; try { nrep = JSON.parse(nr && nr.text); } catch {}
          if (nrep && nrep.applied != null) conceptNormalized = nrep.applied || 0;
        } catch (e) { console.error('[kg-nightly] concept normalize failed:', e.message); }
        // 3b-ii) LLM SEMANTIC pass on the residue — entity_type='concept' + neighbor_hub_cap so a shared WELL
        //        (a hub) can't vacuously anchor a merge. Catches confident non-cosmetic dups; parks the rest.
        try {
          const CONCEPT_HUB_CAP = parseInt(process.env.ZOE_KG_CONCEPT_HUB_CAP || '', 10) || 50;
          const CONCEPT_TIERS = (process.env.ZOE_KG_CONCEPT_TIERS || 'name-exact,name-strong').trim();
          const cr = await echoSuit.dispatch({ kind: 'do', name: 'run_dedup_adjudication', args: { batch: KGNIGHTLY_NAMESTRONG_BATCH, tiers: CONCEPT_TIERS, entity_type: 'concept', neighbor_hub_cap: CONCEPT_HUB_CAP } });
          let crep = null; try { crep = JSON.parse(cr && cr.text); } catch {}
          if (crep && crep.considered != null) { conceptApplied = crep.applied || 0; emitAbsorb(crep); }
        } catch (e) { console.error('[kg-nightly] concept pass failed:', e.message); }
      }
      // 4) LINK LANE — refresh the co-source candidate pool (run_link_candidates, idempotent signature-dedupe)
      //    then GROUND a bounded batch through the citation-verify gate (run_link_grounding: web-search →
      //    cloud-cite-a-REAL-url → fetch+verify → only a VERIFIED citation mints a grounded relation_proposal).
      //    Network+cloud-bound, not CPU — a modest nightly bite (ZOE_KG_NIGHTLY_LINK_BATCH, 0 disables). The
      //    one-time ~4k backlog drains over many nights; raise the knob to accelerate, drop it back after.
      let linkGrounded = 0;
      const _lb = parseInt(process.env.ZOE_KG_NIGHTLY_LINK_BATCH || '', 10);
      const LINK_BATCH = Number.isFinite(_lb) ? _lb : 20;
      if (LINK_BATCH > 0) {
        try {
          await echoSuit.dispatch({ kind: 'do', name: 'run_link_candidates', args: {} });   // land/refresh the pool
          const lr = await echoSuit.dispatch({ kind: 'do', name: 'run_link_grounding', args: { limit: LINK_BATCH } });
          let lrep = null; try { lrep = JSON.parse(lr && lr.text); } catch {}
          if (lrep && lrep.grounded != null) linkGrounded = lrep.grounded || 0;
        } catch (e) { console.error('[kg-nightly] link grounding failed:', e.message); }
      }
      // 5) GC — prune CONTEXT-FREE aged-out nodes (degree 0 + no strong-id/summary/subtype/contact/fact, older
      //    than ZOE_KG_PRUNE_DAYS, not in a pending proposal). Reversible (archived to pruned_entities). Finds
      //    ~0 today (fresh empties are enrichment-pending); it's the net that keeps unresolvable noise from
      //    accreting as stragglers age out. Env ZOE_KG_NIGHTLY_PRUNE (default on).
      let pruned = 0;
      if (/^(1|true|yes|on)$/i.test(String(process.env.ZOE_KG_NIGHTLY_PRUNE ?? '1').trim())) {
        try {
          const pdays = parseInt(process.env.ZOE_KG_PRUNE_DAYS || '', 10) || 30;
          const pr = await echoSuit.dispatch({ kind: 'do', name: 'prune_empty_entities', args: { older_than_days: pdays, limit: 500, dry_run: false } });
          let prep = null; try { prep = JSON.parse(pr && pr.text); } catch {}
          if (prep && prep.pruned != null) pruned = prep.pruned || 0;
        } catch (e) { console.error('[kg-nightly] prune failed:', e.message); }
      }
      const conceptTotal = conceptNormalized + conceptApplied;
      const total = anchoredApplied + strongApplied + conceptTotal;
      console.log(`[kg-nightly] full sweep: +${swept} proposals; drained ${anchoredApplied} anchored + ${strongApplied} name-strong + ${conceptNormalized} concept-normalize + ${conceptApplied} concept-llm = ${total} merges; +${linkGrounded} grounded links; ${pruned} pruned`);
      if (total > 0 || swept > 0) {
        const text = `[Nightly upkeep] Full graph sweep: ${swept} new duplicate proposal${swept === 1 ? '' : 's'} found, and I reversibly merged ${total} confirmed duplicate${total === 1 ? '' : 's'} (${anchoredApplied} anchored + ${strongApplied} fuzzy name-match + ${conceptTotal} concept) — each verified and undoable.`;
        const row = db.insertMonologue({ content: text, model: 'kg-nightly', type: 'reading' });
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: text, type: 'reading' });
      }
    } catch (e) { console.error('[kg-nightly] sweep failed:', e.message); }
    finally { kgNightlyRunning = false; }
  };
  setInterval(() => { maybeRunNightlyDedupSweep().catch(() => {}); }, KGNIGHTLY_CHECK_MS).unref?.();
  // Episodic recall backfill: embed past turns lacking an embedding so "what did we say earlier
  // about X" works over EXISTING history too. The one-shot 300 left ~half of turns unembedded
  // (episodic recall was blind to old history); DRAIN it in bounded batches until caught up, paced
  // so the CPU embedder doesn't spike. Delayed so the embedder is warm.
  setTimeout(() => {
    let drained = 0;
    const drain = async () => {
      try {
        const n = await memoryLib.backfillTurnEmbeddings(300);
        drained += n;
        if (n >= 300 && drained < 6000) { setTimeout(() => { drain().catch(() => {}); }, 30 * 1000).unref?.(); }
        else if (drained) console.log(`[main] turn-embedding backfill caught up (${drained} embedded)`);
      } catch {}
    };
    drain().catch(() => {});
  }, 20 * 1000).unref?.();
  // Index hygiene: purge any orphaned FTS rows (rotted from past mismatched deletes) so keyword
  // search can't match ghosts. Idempotent; cheap.
  try { const purged = db.reconcileKnowledgeFts(); if (purged) console.log(`[main] purged ${purged} orphaned knowledge_fts row(s)`); } catch {}
  // Engine + Echo suit — Zoe OWNS the absorbed engine now (architecture lock 2026-06-23). The
  // EngineSupervisor runs ADOPT-OR-SPAWN: if standalone Echo is already serving the port we ADOPT
  // it (never double-spawn — they share the same DB/event bus, so her proposals/canvas show up
  // live in his UI during the transition); if the port is dead she SPAWNS + OWNS
  // `python -m echo.main serve --transport http` and supervises it (backoff restart, tree-kill on
  // quit). We only ever kill what WE spawned. The suit (her MCP tool surface) attaches once the
  // engine is healthy, and the 60s heartbeat re-attaches if the connection ever drops.
  const ECHO_CWD = process.env.ECHO_CWD || 'C:/Users/azrae/Desktop/NX ECHO/nx-echo';
  const echoCfg = readEchoConfig(ECHO_CWD);
  echoHttp = { base: `http://${echoCfg.host}:${echoCfg.port}`, token: echoCfg.token };   // for GET /canvas
  echoSuit = echoSuitLib.createSuit({ client: require('./lib/echo').fromEnv({ url: echoCfg.url, token: echoCfg.token }) });
  // Register this connected suit as the live singleton so active_recall can query the master DB
  // (search_knowledge) through the SAME connection — automatic recall, not just her explicit tags.
  try { echoSuitLib.setLiveSuit(echoSuit); } catch {}
  // Spawn path uses Echo's OWN venv interpreter by default (its deps aren't on bare `python`);
  // ECHO_PYTHON env still overrides. The adopt path doesn't touch this.
  const ECHO_PYTHON = process.env.ECHO_PYTHON || path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe');
  echoVenv = { python: ECHO_PYTHON, cwd: ECHO_CWD };   // for the Calendar surface's Google token bridge (lib/gcal)
  // Inherit Echo's cloud credential (env → OS keychain "nx-echo" → .env) via Echo's own resolver,
  // so Zoe's verification classify leaf can reach the cloud frontier with the SAME key the engine
  // uses. Resolved into memory only — never written or logged (names only).
  try {
    const r = require('./lib/keystore').hydrateFromEcho(['OLLAMA_API_KEY'], { python: ECHO_PYTHON, cwd: ECHO_CWD });
    console.log(`[main] cloud key: ${process.env.OLLAMA_API_KEY ? 'inherited from Echo (' + r.resolved.join(',') + ')' : 'absent — cloud classify falls back to local'}`);
  } catch (e) { console.error('[main] cloud key hydrate failed:', e.message); }
  engineSupervisor = new EngineSupervisor({
    host: echoCfg.host, port: echoCfg.port,
    python: ECHO_PYTHON,
    cwd: ECHO_CWD,
    onLog: (m) => console.log('[engine]', m),
  });
  const pushEchoStatus = (r) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('echo:status', { connected: !!(r && r.ok), tools: (r && r.tools) || 0 }); } catch {} };
  const tryEchoAttach = () => echoSuit.connect().then(r => { if (r.ok) console.log(`[main] echo suit attached: ${r.tools} tools`); pushEchoStatus(r); return !!r.ok; }).catch(() => { pushEchoStatus(null); return false; });
  setTimeout(() => {
    // Adopt the running engine, or spawn + own one, THEN attach the suit. If ensure can't bring an
    // engine up (e.g. ECHO_CWD/ECHO_PYTHON wrong on the spawn path), still try to attach in case one
    // came online by another route — the heartbeat keeps retrying regardless.
    engineSupervisor.ensure({ spawnIfDown: true })
      .then(r => { console.log(`[main] engine ${r.state}${r.pid ? ' (pid ' + r.pid + ')' : ''}`); return tryEchoAttach(); })
      .then((attached) => { if (attached) rehydrateRecentCanvasDeliverables().catch(() => {}); })   // restore completed deliverables to the canvas after a restart
      .catch(e => { console.error('[main] engine ensure failed:', e.message); return tryEchoAttach(); })
      // STAGGER the Canvas behind the engine: only spawn it once the engine ensure+attach attempt has
      // completed, so its first load finds Echo connected (no "Echo engine not connected" flash). The
      // renderer still self-retries as a backstop if the engine is merely slow to finish warming.
      .finally(() => { try { createCanvasWindow(); } catch (e) { console.error('[main] canvas auto-spawn failed:', e.message); } });
    // Permanent heartbeat: a cheap no-op while connected; reattaches within 60s whenever the engine
    // comes online or comes back (a dropped connection / supervisor restart flips connected=false,
    // the next beat re-attaches and refreshes the status light).
    const iv = setInterval(() => { if (!echoSuit || echoSuit.connected) return; tryEchoAttach(); }, 60 * 1000);
    iv.unref?.();
  }, 8 * 1000).unref?.();
  filesLib.ensureWorkspace();
  // Warm the CPU embedder (bge-small via transformers.js) so first knowledge
  // retrieval isn't slow. Runs on CPU — no VRAM contention with the chat model.
  memoryLib.warm().then(ok => console.log('[main] memory embedder warm:', ok, '| knowledge items:', db.countKnowledge()))
    .catch(err => console.error('[main] memory warm failed:', err.message));
  // Pre-warm her dedicated browser so the slow first-run init happens at boot, not
  // mid-conversation — and so any launch/CDP problem surfaces here in the log.
  // Fire-and-forget; lazy launch on first use still works if this is skipped.
  webLib.ensure()
    .then(() => console.log('[main] dedicated browser ready'))
    .catch(err => console.error('[main] dedicated browser warm FAILED:', err.message));
  // AUTO-INGEST: watch her browser's downloads folder so any PDF she grabs (auto-harvested off a
  // page, navigated onto, or click-downloaded) is extracted → landed → decomposed into memory.
  try { startDownloadsIngestWatcher(); } catch (e) { console.error('[dl-ingest] start failed:', e && e.message); }
  currentSessionId = db.startSession();
  currentSessionStartedAt = Date.now();
  // Downtime marker (her request): record how long she was offline, then start the
  // keep-alive heartbeat. recordBoot drops a first-person "back online" reading + an
  // awareness line; the heartbeat keeps last_alive_at fresh so a HARD restart is still
  // measured accurately next boot.
  try {
    const downtimeLib = require('./lib/downtime');
    const dt = downtimeLib.recordBoot();
    if (dt) console.log(`[main] downtime: offline ~${downtimeLib.formatGap(dt.ms)}${dt.graceful ? '' : ' (unclean stop)'}`);
    // Reawaken bridge (self-awareness Layer 5): compose "where we left off" from the prior session
    // BEFORE the heartbeat overwrites the gap, so she wakes up continuous, not cold.
    try { const rb = require('./lib/reawaken').recordBoot({ gapMs: dt ? dt.ms : null }); if (rb) console.log('[main] reawaken bridge composed'); }
    catch (e) { console.error('[main] reawaken init failed:', e.message); }
    downtimeLib.startHeartbeat();
  } catch (e) { console.error('[main] downtime init failed:', e.message); }
  // Capability self-check at boot — a cheap model-free sweep so there's always a fresh
  // ledger grounding her self-knowledge (and a RED surfaces immediately if a pathway
  // drifted across the restart). Throttled thereafter by the idle loop (~6h).
  try {
    const sc = require('./lib/self_check');
    if (sc.due()) { const l = sc.run(); console.log(`[main] capability self-check: ${l.green}/${l.total} green${l.allGreen ? '' : ' — RED: ' + l.red.map(r => r.name).join(', ')}`); }
  } catch (e) { console.error('[main] self-check at boot failed:', e.message); }
  createWindow();
  try { createCompanionWindow(); } catch (e) { console.error('[companion] spawn failed:', e.message); }   // floating desktop presence (gated on her .vrm)
  try { ensureYtPlayerServer(); } catch {}   // warm the clean-player server so the Monitors videos load fast
  // Zoe's Canvas auto-spawns AFTER the engine attaches (see the engine .finally above) so its first
  // load finds Echo connected — staggered behind the server, no "not connected" flash.

  // BOOT HOUSEKEEPING: a model pinned by keep_alive from a PRIOR run (e.g. the old front model after
  // a swap, or a leftover extraction model) squats VRAM and collides with the current front — loads
  // time out and replies hang ("call goes nowhere"). Sweep any stale BIG resident that isn't the
  // front, THEN warm the front into the freed VRAM. Embeddings/tiny models are left alone.
  // Warm the single Dans-24B model at boot. One model now serves both chat and the between-turn
  // monologue. Mistral-3 arch unlocks KV-cache quantization (OLLAMA_FLASH_ATTENTION=1 +
  // OLLAMA_KV_CACHE_TYPE=q8_0), keeping 24B Q4 + 16K ctx inside the RX 7900 XT's ~18GB usable VRAM.
  sweepLoaded({ keep: [MODEL], minVramBytes: 2e9 })
    .then(swept => { if (swept.length) console.log('[boot] swept stale resident model(s):', swept.join(', ')); })
    .catch(() => {})
    .finally(() => {
      fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
          keep_alive: '24h',
          options: { num_predict: 1, num_ctx: 8192 }
        })
      }).then(() => console.log('[main] model warmed at 8192 ctx:', MODEL))
        .catch(err => console.error('[main] model warmup failed:', err.message));
    });
  startReflectionScheduler({
    getSessionId: () => currentSessionId,
    getWindow: () => mainWindow
  });
  startMonologueScheduler({
    getWindow: () => mainWindow,
    getSessionStartedAt: () => currentSessionStartedAt,
    // Live-follow: broadcast each idle graph-walk move so the KG surface (a webview) can re-center on the
    // entity she's enriching. Broadcast to all webContents — only the KG panel registers kg:focus-move.
    emitFocusMove: (payload) => { try { let n = 0; for (const wc of require('electron').webContents.getAllWebContents()) { try { if (!wc.isDestroyed()) { wc.send('kg:focus-move', payload); n++; } } catch (e) {} } console.log(`[kg-follow] broadcast "${payload && payload.anchor}" → ${n} view(s)`); } catch (e) {} },
    // Puller lane: an autonomous contact fill → refresh the person's card on the canvas People rail (same
    // channel a doc-drop discovery uses), so the operator sees the enrichment land live.
    emitContactCard: (card) => { try { if (card && canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.webContents.send('contacts:card', card); } catch (e) {} }
  });
  startHeartbeatScheduler({
    getWindow: () => mainWindow,
    getSessionId: () => currentSessionId,
    getSessionStartedAt: () => currentSessionStartedAt
  });
  startContinuityScheduler({
    getWindow: () => mainWindow,
    getSessionId: () => currentSessionId
  });
  selfDialogue.setOpts({
    getWindow: () => mainWindow,
    getSessionId: () => currentSessionId
  });

  // Self-scheduling: her own clock. When a task comes due the ticker surfaces it
  // and kicks the heartbeat so she actually acts on it.
  schedulerLib.startScheduler({
    getWindow: () => mainWindow,
    kickHeartbeat: () => {
      const { maybeHeartbeat } = require('./lib/heartbeat');
      maybeHeartbeat().catch(err => console.error('[main] scheduler heartbeat kick failed:', err.message));
    }
  });

  // Resume an overnight DIRECTED focus across a restart: if a Lucas-assigned task was still active
  // when the app last closed, pick it back up so the work continues through the night uninterrupted.
  try {
    const focusLib = require('./lib/focus');
    const f = focusLib.getCurrent();
    if (f && focusLib.isDirected(f)) { startDirectedFocusDriver(); console.log(`[directed] resumed standing focus #${f.id} after restart`); }
  } catch (e) { console.error('[main] directed-focus resume failed:', e.message); }

  // Email: surface a credential problem early rather than at first send.
  if (emailLib.isConfigured()) {
    emailLib.verify().then(r => {
      console.log(r.ok ? '[main] email SMTP verified, ready to send'
                       : '[main] email NOT ready (check ZOE_EMAIL_PASS — Gmail needs an App Password): ' + r.reason);
    }).catch(() => {});
  } else {
    console.log('[main] email not configured (.env ZOE_EMAIL_USER/PASS blank) — email tool hidden');
  }

  // Discord bridge: same Zoe, new I/O surface. Owner DMs route through the real
  // chat turn; her reply goes back over Discord.
  if (discordLib.isConfigured()) {
    discordLib.setHandlers({
      getWindow: () => mainWindow,
      onOwnerMessage: async (text) => {
        try {
          const r = await runChatTurn(text, [], { unprompted: false, channel: 'discord' });
          return r && r.say ? r.say : null;
        } catch (err) {
          console.error('[main] discord chat turn failed:', err.message);
          return null;
        }
      }
    });
    discordLib.start().then(r => {
      console.log(r.ok ? '[main] discord bridge connected' : '[main] discord bridge failed: ' + r.reason);
    }).catch(err => console.error('[main] discord start error:', err.message));
  } else {
    console.log('[main] discord not configured (.env DISCORD_BOT_TOKEN/OWNER_ID blank) — discord tool hidden');
  }

  // Autonomous inbox: poll for NEW mail on her own. On arrival, queue it as an
  // inbound (the heartbeat surfaces it to Lucas unprompted) + integrate into the
  // knowledge store. Baselines on first run so the existing backlog isn't surfaced.
  if (inboxLib.isConfigured()) {
    const INBOX_POLL_MS = 4 * 60 * 1000;
    const runInboxPoll = async () => {
      try {
        const surfaced = JSON.parse(db.getMeta('inbox_surfaced_uids') || '[]');
        const r = await inboxLib.pollUnread(surfaced, 3);
        if (!r.ok) { console.log('[inbox-poll] fail:', r.reason); return; }
        if (r.messages && r.messages.length) {
          for (const m of r.messages) {
            const blurb = `Unread email from ${m.from} — subject "${m.subject}": ${(m.snippet || '').slice(0, 300)}`;
            try { db.insertInbound({ tabUrl: 'email', speaker: m.from, text: blurb, source: 'email' }); } catch {}
            memoryLib.storeDeduped({ kind: 'reference', content: `Email I received — from ${m.from}, subject "${m.subject}": ${(m.snippet || '').slice(0, 300)}`, source: 'inbox', importance: 0.55 }).catch(() => {});
          }
          const merged = [...surfaced, ...r.messages.map(m => m.uid)].slice(-300);
          db.setMeta('inbox_surfaced_uids', JSON.stringify(merged));
          // last_inbound_* is the "reply to the email" target — keep it on the newest REAL
          // PERSON, never a newsletter/daemon/no-reply (else "reply" fires at junk + bounces).
          const realNewest = [...r.messages].reverse().find(m => m.fromAddr && !inboxLib.isJunkSender(m.fromAddr));
          if (realNewest) {
            db.setMeta('last_inbound_from', realNewest.fromAddr);
            db.setMeta('last_inbound_subject', realNewest.subject || '');
            db.setMeta('last_inbound_snippet', (realNewest.snippet || '').slice(0, 300));
          }
          console.log(`[inbox-poll] ${r.messages.length} unread email(s) → queued + heartbeat kick`);
          const { maybeHeartbeat } = require('./lib/heartbeat');
          maybeHeartbeat().catch(() => {});
        } else {
          console.log('[inbox-poll] no unsurfaced unread');
        }

        // AUTONOMOUS REPLY (gated) — independent of surfacing. Runs every poll and
        // dedupes against UIDs she's already auto-replied to (NOT the surfaced set),
        // so already-surfaced unread mail is still eligible for a reply once.
        // Gates so she never fires a reply Lucas wouldn't expect:
        //  - one reply per poll cycle, and only if no action is already running;
        //  - sender must be a real PERSON writing to HER directly (skip no-reply / bulk /
        //    newsletter / list senders — those she only READS for information, never replies);
        //  - NEVER her own address — replying to self creates an infinite loop
        //    (each self-reply lands as new unread → another reply → cascade).
        // This is HER inbox (zoelaneai@gmail.com), her own correspondence: a direct email
        // from a real person gets a reply IN HER OWN VOICE, even a first-time sender (the
        // old "must have emailed them first" gate blocked every new direct email — the bug
        // behind "she isn't sending emails"). Dedup + one-per-poll prevent any cascade.
        if (!actionLoop.isActive()) {
          const replied = JSON.parse(db.getMeta('auto_replied_uids') || '[]');
          const self = (config.emailConfig().user || '').toLowerCase();
          const rr = await inboxLib.pollUnread(replied, 6);
          if (rr.ok && rr.messages && rr.messages.length) {
            const candidate = [...rr.messages].reverse().find(m =>
              m.fromAddr && m.fromAddr.toLowerCase() !== self
              && !inboxLib.isJunkSender(m.fromAddr));
            if (candidate && !emailLib.isSendEnabled()) {
              // Kill-switch active — never auto-compose an outbound reply (the highest-risk,
              // no-human-in-loop send path). Don't consume the uid, so it can reply once re-enabled.
              console.log('[action] autonomous email reply suppressed — send kill-switch active');
            } else if (candidate) {
              db.setMeta('auto_replied_uids', JSON.stringify([...replied, candidate.uid].slice(-300)));
              console.log('[action] autonomous reply → thread with', candidate.fromAddr, 'uid', candidate.uid);
              actionLoop.start(actionLoop.emailReplyAction({
                to: candidate.fromAddr, subject: candidate.subject || '', snippet: candidate.snippet || ''
              }));
              // io wired to the window so her completion confirmation renders live,
              // exactly like a heartbeat utterance (stream tokens + finalize).
              const autoIo = {
                channel: 'desktop',
                emit: (token) => { try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('chat:say-token', token); } catch {} },
                onComplete: (payload) => { try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('chat:complete', { ...payload, unprompted: true }); } catch {} }
              };
              setTimeout(() => { runActionStep(autoIo, 0).catch(() => {}); }, 1500);
            } else {
              console.log('[action] no auto-reply candidate (cold/bulk senders only)');
            }
          }
        }
      } catch (e) { console.error('[inbox-poll]', e.message); }
    };
    inboxPollTimeout = setTimeout(() => { runInboxPoll().catch(() => {}); }, 20000); // initial sweep ~20s after boot
    inboxPollTimer = setInterval(() => { runInboxPoll().catch(() => {}); }, INBOX_POLL_MS);
    console.log('[main] inbox poller started (unread-based, every 4 min)');
  }

  // CANVAS DROP → INGEST: when Lucas drops a DOCUMENT onto Zoe's canvas, the engine shows it as a block
  // but nothing made her READ it (she kept musing, blind to it). This poller notices a new dropped tab
  // ("drop-…", distinct from her own "directed-…" emits), pulls its text, has the cloud write a grounded
  // understanding, and ACCRETES it: a reading in her stream + a memory note + captured learnings, so the
  // document becomes something she actually knows. Dedup on the persisted ingested-tab set (no re-read).
  {
    const CANVAS_INGEST_MS = 45 * 1000;
    const runCanvasIngest = async () => {
      try {
        if (!echoSuit || !echoSuit.connected) return;       // engine not attached → nothing to read
        let snap = null; try { snap = await canvasSnapshot(); } catch (e) { return; }
        if (!snap || !Array.isArray(snap.tabs)) return;
        const ci = require('./lib/canvas_ingest');
        let seen = []; try { seen = JSON.parse(db.getMeta('canvas.ingested_tabs') || '[]'); } catch {}
        const fresh = ci.newDropTabs(snap, seen);
        if (!fresh.length) return;
        for (const t of fresh) {
          const blocks = (snap.blocks_by_tab && Array.isArray(snap.blocks_by_tab[t.tabKey])) ? snap.blocks_by_tab[t.tabKey] : [];
          let markdown = ci.extractMarkdown(blocks);
          const label = ci.cleanTitle(t.title);
          // FILE DROPS: read the ACTUAL file for the FULL text — always, when a file src is present. This
          // decouples INGEST (whole file) from the DISPLAY (a capped/progressive-chunk preview that may be
          // mid-build): a PDF/xlsx has no text blocks, and a large text doc's preview blocks are only the
          // top so far. Text layer (doc_extract) for text PDFs/docx/sheets; VISION for image/graphic drops.
          const fileSrc = ci.fileSrcOf(blocks);
          if (fileSrc) {
            try {
              const fi = require('./lib/file_ingest');
              const de = require('./lib/doc_extract');
              const vis = require('./lib/vision');
              const fsm = require('fs');
              const r = await fi.extractDroppedFile(fileSrc, { deps: {
                extractToMarkdown: (p) => de.extractToMarkdown(p),
                describe: (o) => vis.describe(o),
                readFileBase64: (p) => fsm.readFileSync(p).toString('base64'),
                fileExists: (p) => fsm.existsSync(p),
                log: (m) => console.log(m),
              } });
              if (r && r.text && r.text.length >= 40) { markdown = r.text; console.log(`[canvas-ingest] "${label}" read FULL from FILE via ${r.via} (${markdown.length}ch)`); }
            } catch (e) { console.error('[canvas-ingest] file read failed:', e.message); }
          }
          if (markdown.length < 40) { console.log(`[canvas-ingest] "${label}" too thin to ingest — skipping (still marking seen)`); }
          else {
            // grounded cloud UNDERSTANDING (fail-safe to the raw doc if the cloud is down)
            let understanding = '';
            try { understanding = await condenseComplete(ci.buildUnderstandingPrompt({ title: label, markdown }), { numPredict: 600 }); } catch {}
            const note = ci.ingestNote({ title: label, understanding, markdown });
            // LAND the FULL document durably in the short-term store (survives engine/app restart, unlike
            // the in-memory canvas) so doc-QA + recall work even after the canvas clears. Idempotent on tab.
            let landed = null;
            try { landed = require('./lib/doc_store').land({ title: label, body: markdown, source: 'canvas_drop', ref: t.tabKey, understanding }); } catch (e) { console.error('[canvas-ingest] doc land failed:', e.message); }
            // ACCRETE — a reading in her stream + a durable memory + captured learnings/entities.
            try {
              const row = db.insertMonologue({ content: `I read the document Lucas dropped on my canvas — "${label}":\n${understanding || markdown.slice(0, 400)}`, model: 'canvas_ingest', type: 'reading', query: label });
              if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(read drop) ${label}`, type: 'reading', query: label });
            } catch {}
            try { await memoryLib.store({ kind: 'reference', content: note, source: 'canvas_drop', importance: 0.6, embedText: `${label}\n${markdown.slice(0, 800)}` }); } catch (e) { console.error('[canvas-ingest] memory store failed:', e.message); }
            try { require('./lib/learning').maybeCaptureLearnings({ query: label, content: markdown, urls: null }); } catch {}
            // SPLIT 2 / stream 1 (curation substrate) — decompose the landed doc into its constituent
            // typed objects in Echo, AFTER the existing hooks. Async + fail-soft so it never blocks or
            // breaks ingest; fall-throughs queue as `held` for the nightly upgrade pass.
            try { if (landed && landed.landed) decomposeLandedDoc({ id: landed.id, title: label, body: markdown, source: 'canvas_drop' }).catch(() => {}); } catch {}
            try { if (landed && landed.landed) surfaceDocCards({ id: landed.id, title: label, body: markdown }).catch(() => {}); } catch {}
            console.log(`[canvas-ingest] ingested drop "${label}" (${markdown.length} chars)${understanding ? ' + understanding' : ''}`);
          }
          seen.push(t.tabKey);
        }
        try { db.setMeta('canvas.ingested_tabs', JSON.stringify(seen.slice(-300))); } catch {}
      } catch (e) { console.error('[canvas-ingest]', e.message); }
    };
    canvasIngestTimeout = setTimeout(() => { runCanvasIngest().catch(() => {}); }, 15000); // initial sweep ~15s after boot
    canvasIngestTimer = setInterval(() => { runCanvasIngest().catch(() => {}); }, CANVAS_INGEST_MS);
    console.log('[main] canvas drop→ingest poller started (every 45s)');
  }

  // NEWS DATA-STREAM COLLECTOR — fills the ISOLATED news bucket (data/news_bucket.db) from the RSS
  // subscriptions on a backend timer, independent of the Monitors widget. Model-free; raw items NEVER
  // reach memory (sq.db) — only compressed news objects promote (nightly). Reuses the feeds:fetch path.
  {
    const FEED_POLL_MS = parseInt(process.env.FEED_POLL_MS || '', 10) || 3 * 60 * 1000;
    const newsPoll = require('./lib/news_poll');
    const newsStore = require('./lib/news_store');
    const fetchFeeds = async () => {
      const urls = feedsStore.list().map(f => f.url);
      if (!urls.length) return { items: [] };
      if (!(await ensureEngine())) return { items: [] };
      // CHUNKED (2026-07-07): all ~244 subscribed feeds in ONE fetch_feeds_batch overwhelmed the Echo MCP
      // transport — ~half the polls came back "empty response to tools/call" (the "⚠ fetch failed" panel).
      // MEASURED: a 39-feed batch at item_limit 30 = ~1MB of JSON; the full 244-feed call is multi-MB and the
      // transport silently returns empty above its response ceiling. TWO levers: (1) small FEED-count chunks,
      // (2) a low ITEM_LIMIT — 30/feed was overkill (the view dedups to ~120 total and only ~0-8 are ever new
      // per 3-min poll). Sequential (not Promise.all) so we don't recreate the overload with concurrent big
      // calls. Both env-tunable. Merge the per-chunk reports into one view; a failed chunk is skipped, not fatal.
      const CHUNK = parseInt(process.env.FEED_BATCH_SIZE || '', 10) || 12;
      const ITEM_LIMIT = parseInt(process.env.FEED_ITEM_LIMIT || '', 10) || 15;
      const allFeeds = [];
      for (let i = 0; i < urls.length; i += CHUNK) {
        const slice = urls.slice(i, i + CHUNK);
        try {
          const payload = await pollCallTool()('fetch_feeds_batch', { feed_urls: slice, item_limit: ITEM_LIMIT });
          const feeds = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.feeds) ? payload.feeds : []);
          for (const f of feeds) allFeeds.push(f);
        } catch (e) { console.warn(`[news-poll] chunk (${slice.length} feeds) failed: ${e.message}`); }
      }
      return { items: feedsView.mergeReports({ feeds: allFeeds }).items };
    };
    // NEWS TUNER topic classification (cloud-on-everything, classify-once, cached): after each poll, label the
    // newest un-classified items. Paced (50/tick) so the backlog backfills over time without a cost spike;
    // each item is classified exactly once then cached on its row. Feed shows deterministic provisional labels
    // until the cloud verdict lands. Cheap when caught up (early-returns before touching the cloud).
    const classifyNewItems = async () => {
      try {
        const batch = newsStore.uncategorizedItems({ limit: 50 });
        if (!batch.length) return;
        if (!(await ensureEngine())) return;
        const cloud = require('./lib/cloud_logic');
        const verdict = await require('./lib/news_topics').classifyTopicsBatch(batch, { ask: cloud.ask, model: require('./lib/models').getModelFor('editor', null) });
        const n = newsStore.setCategories(verdict);
        if (n) console.log(`[news-topics] classified ${n} items (bucket has ${newsStore.uncategorizedItems({ limit: 1 }).length ? 'more queued' : 'none'} left)`);
      } catch (e) { console.error('[news-topics]', e.message); }
    };
    newsPoll.start({
      fetch: fetchFeeds, store: newsStore, intervalMs: FEED_POLL_MS, initialDelayMs: 30000,
      onTick: (r) => { try { if (r && (r.inserted || r.error)) console.log(`[news-poll] +${r.inserted || 0} new / ${r.duplicates || 0} dup (${r.fetched || 0} fetched)${r.error ? ' err:' + r.error : ''} · bucket=${newsStore.countItems()}`); } catch {} classifyNewItems().catch(() => {}); },
      log: (m) => console.log(m),
    });
    console.log(`[main] news collector started (every ${Math.round(FEED_POLL_MS / 1000)}s → isolated bucket)`);
  }

  // API MANAGEMENT STREAM scheduler — slow-moving public series (FRED/Census) refresh on their OWN conservative
  // cadence (dueDatasets skips anything still fresh), and a CHANGED snapshot lands into short-term memory
  // (doc_store) → rides the overnight promote into Echo, like a news evidence doc (the processed→DB path). The
  // raw hooks (getSnapshot / pull) are reachable via the api:* IPC for the forecasting section. Gated on any
  // key present so it no-ops on a keyless install; pulls are rate-limited + cached by lib/api_manager.
  {
    const API_STREAM_MS = parseInt(process.env.API_STREAM_MS || '', 10) || 6 * 3600 * 1000;   // due-check every 6h
    const apiClient = require('./lib/api_client');
    const runApiStream = async () => {
      try {
        if (!apiClient.keyStatus().some((s) => s.hasKey)) return;                              // no keys → nothing to do
        const due = await require('./lib/api_stream').runDue({ limit: 20 });                   // pull only what's past cadence
        const land = await require('./lib/api_landing').landChanged({ landDoc: (d) => require('./lib/doc_store').land(d) });
        if (due.refreshed || land.landed) console.log(`[api-stream] refreshed ${due.refreshed}/${due.due} due · landed ${land.landed} changed → memory`);
      } catch (e) { console.error('[api-stream]', e.message); }
    };
    apiStreamTimeout = setTimeout(() => { runApiStream().catch(() => {}); }, 5 * 60 * 1000);   // first sweep ~5m after boot
    apiStreamTimer = setInterval(() => { runApiStream().catch(() => {}); }, API_STREAM_MS);
    console.log(`[main] API stream scheduler started (due-check every ${Math.round(API_STREAM_MS / 3600000)}h → snapshots + landing)`);
  }

  // API BULK-PULL — large paginated corpora (legislation first, via Echo's legiscan_* domain tools) → memory
  // objects on the SAME promotion rail as news/api docs. CONSERVATIVE cadence (legislation moves slowly;
  // per-bill change_hash makes steady-state cheap), bounded per pass, resumable. Gated on the Echo engine.
  {
    const API_BULK_MS = parseInt(process.env.API_BULK_MS || '', 10) || 12 * 3600 * 1000;   // every 12h
    const runApiBulk = async () => {
      try {
        if (!echoSuit || !echoSuit.connected) return;                                        // needs Echo domain tools
        const r = await require('./lib/api_bulk').runDueBulk({
          dispatch: (t) => echoSuit.dispatch(t),
          landDoc: (d) => require('./lib/doc_store').land(d),
          billLimit: parseInt(process.env.API_BULK_LIMIT || '', 10) || 50,
          log: (m) => console.log(m),
        });
        const landed = (r || []).reduce((n, j) => n + ((j && j.landed) || 0), 0);
        if (landed) console.log(`[api-bulk] landed ${landed} bills → memory across ${r.length} job(s)`);
      } catch (e) { console.error('[api-bulk]', e.message); }
    };
    apiBulkTimeout = setTimeout(() => { runApiBulk().catch(() => {}); }, 8 * 60 * 1000);      // first pass ~8m after boot
    apiBulkTimer = setInterval(() => { runApiBulk().catch(() => {}); }, API_BULK_MS);
    console.log(`[main] API bulk-pull scheduler started (every ${Math.round(API_BULK_MS / 3600000)}h → legislation → memory)`);
  }

  // TRUTH SOCIAL social-feed poller — tracked accounts' public posts → the news reservoir (source_kind='social'),
  // riding the SAME hourly compression / stories / briefing rail as RSS. Public Mastodon API (a browser UA passes
  // Cloudflare); no key. Accounts via TRUTH_ACCOUNTS (default realDonaldTrump). Fail-soft; conservative cadence.
  {
    const TRUTH_POLL_MS = parseInt(process.env.TRUTH_POLL_MS || '', 10) || 15 * 60 * 1000;   // every 15m
    const runTruth = async () => {
      try {
        const r = await require('./lib/truth_poll').runPoll({ store: require('./lib/news_store'), log: (m) => console.log(m) });
        if (r.inserted) console.log(`[truth] ${r.inserted} new social posts → reservoir (${r.accounts} account(s))`);
      } catch (e) { console.error('[truth]', e.message); }
    };
    truthTimeout = setTimeout(() => { runTruth().catch(() => {}); }, 2 * 60 * 1000);          // first poll ~2m after boot
    truthTimer = setInterval(() => { runTruth().catch(() => {}); }, TRUTH_POLL_MS);
    console.log(`[main] Truth Social poller started (every ${Math.round(TRUTH_POLL_MS / 60000)}m → reservoir, source_kind=social)`);
  }

  // EMAIL INTAKE LANE — Zoe's own inbox is a subscription surface (newsletters + Gemini meeting-notes).
  // READ-ONLY (EXAMINE): this connection provably cannot mark-read/delete. Newsletters route into the
  // SAME isolated news bucket as RSS (source_kind='newsletter') → they ride the hourly briefing rail;
  // Gemini meeting-notes land as memory documents (promoted nightly). A UID cursor is the dedup key.
  // Routed UIDs are folded into inbox_surfaced_uids so the chat-surfacing inbox poller stays QUIET on
  // them — a newsletter is data-stream fuel, not a chat nudge. Gated on email being configured.
  if (inboxLib.isConfigured()) {
    const EMAIL_INTAKE_MS = parseInt(process.env.EMAIL_INTAKE_MS || '', 10) || 5 * 60 * 1000;
    const emailIntake = require('./lib/email_intake');
    const newsStore = require('./lib/news_store');
    const docStore = require('./lib/doc_store');
    const runEmailIntake = async () => {
      try {
        const r = await emailIntake.runIntakeTick({
          poll: (sinceUid, cap) => inboxLib.pollForIntake(sinceUid, cap),
          store: newsStore,
          landDoc: (doc) => { try { docStore.land(doc); } catch (e) { console.error('[email-intake] doc land failed:', e.message); } },
          cursor: () => { try { return parseInt(db.getMeta('email_intake_cursor_uid') || '0', 10) || 0; } catch { return 0; } },
          saveCursor: (uid) => { try { db.setMeta('email_intake_cursor_uid', String(uid)); } catch {} },
          onRouted: (uids) => {
            // Mark lane-claimed UIDs as already-surfaced so runInboxPoll skips them (no chat nudge).
            try {
              const surfaced = JSON.parse(db.getMeta('inbox_surfaced_uids') || '[]');
              db.setMeta('inbox_surfaced_uids', JSON.stringify([...surfaced, ...uids].slice(-500)));
            } catch {}
          },
          cap: parseInt(process.env.EMAIL_INTAKE_CAP || '', 10) || 12,
          log: (m) => console.log(m),
        });
        if (r && r.ok && (r.newsletters || r.meetings) && mainWindow && !mainWindow.isDestroyed() && r.newsletters) {
          // a newsletter dropped into the bucket may deserve a fresh briefing on the next compression tick;
          // no immediate push — it clusters on the hour like everything else.
        }
      } catch (e) { console.error('[email-intake]', e.message); }
    };
    emailIntakeTimeout = setTimeout(() => { runEmailIntake().catch(() => {}); }, 45000); // initial sweep ~45s after boot
    emailIntakeTimer = setInterval(() => { runEmailIntake().catch(() => {}); }, EMAIL_INTAKE_MS);
    console.log(`[main] email intake lane started (read-only, every ${Math.round(EMAIL_INTAKE_MS / 60000)}m → newsletters+meeting-notes)`);
  }

  // NEWS HOURLY COMPRESSION (Phase B) — turns the raw reservoir into clean rolling STORIES + an hourly
  // briefing layer. Model-free clustering with a cloud adjudicator for the ambiguous cross-source band;
  // corroboration is syndication-aware (a wire story republished across N outlets counts as ONE report,
  // not N). The story_id-NULL guard makes it idempotent, so this and an on-demand snapshot never collide.
  // Emits the hourly briefing to the Monitors widget (no canvas-chat interruption).
  {
    const NEWS_COMPRESS_MS = parseInt(process.env.NEWS_COMPRESS_MS || '', 10) || 60 * 60 * 1000;
    const news_lane = require('./lib/news_lane');
    const newsStore = require('./lib/news_store');
    const runHourlyCompression = async () => {
      try {
        const engineUp = await ensureEngine();       // adjudicator (ambiguous band) needs the cloud; the deterministic gate runs regardless
        const cloud = engineUp ? require('./lib/cloud_logic') : null;
        const now = Date.now();
        const startMs = now - 25 * 3600 * 1000;       // wide window; the story_id-NULL guard bounds it to UN-clustered items (idempotent + cheap)
        const r = await news_lane.runCompression({
          store: newsStore, startMs, endMs: now, now,
          adjudicate: cloud ? (s, i) => news_lane.adjudicateSameEvent(s, i, { ask: cloud.ask }) : null,
          classifyAds: cloud ? (segs) => require('./lib/news_ads').classifyBatch(segs, { ask: cloud.ask, model: require('./lib/models').getModelFor('editor', null) }) : null,
          classifyEmailAds: cloud ? (items) => require('./lib/news_ads').classifyEmailBatch(items, { ask: cloud.ask, model: require('./lib/models').getModelFor('editor', null) }) : null,
          reconstructVideo: cloud ? (vids) => require('./lib/video_reconstruct').runReconstruct(vids, { store: newsStore, ask: cloud.ask, model: require('./lib/models').getModelFor('editor', null), log: (m) => console.log(m) }) : null,
          tuner: getNewsTuner(),
          writeLayer: true,
          log: (m) => console.log(m),
        });
        console.log(`[news] hourly compression: ${r.items} new items → +${r.created}/${r.attached} stories, ${r.closed} closed, layer ${r.layerId}, ${r.storyCount} active`);
        if (mainWindow && !mainWindow.isDestroyed() && r.briefing) {
          try { mainWindow.webContents.send('news:layer', { at: now, storyCount: r.storyCount, briefing: r.briefing }); } catch {}
        }
        // FULL-ARTICLE READ (read-tier): promptly read the real article body for worthy stories via Echo
        // web_extract, so the extraction learns objects from the article — not the headline. Runs on the
        // hourly cadence (soon after a story forms), decoupled from the nightly write pass. Gated on Echo.
        if (echoSuit && echoSuit.connected) {
          try {
            const ra = await news_lane.readArticlesPass({ dispatch: (t) => echoSuit.dispatch(t), now, log: (m) => console.log(m) });
            if (ra.attempted) console.log(`[news] hourly article read: ${ra.read}/${ra.attempted} worthy stories`);
          } catch (e) { console.error('[news] hourly article read failed:', e.message); }
        }
      } catch (e) { console.error('[news] hourly compression failed:', e.message); }
    };
    const newsCompressTimer = setInterval(() => { runHourlyCompression().catch(() => {}); }, NEWS_COMPRESS_MS);
    newsCompressTimer.unref?.();
    setTimeout(() => { runHourlyCompression().catch(() => {}); }, 90 * 1000);   // one pass shortly after boot so a briefing exists without waiting an hour
    console.log(`[main] news hourly compression scheduled (every ${Math.round(NEWS_COMPRESS_MS / 60000)}m)`);
  }

  // FORECASTING RECOMPUTE LOOP (Suite B capstone) — the whole machine on a cadence: VoteHub race slate +
  // per-race poll averages → news_feed signals → gpt-oss direction pre-assess → reactor perturbs margin/σ →
  // correlated Monte-Carlo sim → balance-of-power payload. Cached in `lastForecast`, served by forecast:balance
  // (the studio pulls it; a seed re-run re-sims the SAME live slate for the jitter demo). DOWNSTREAM-ONLY:
  // reads the poll connectors + news lane + cloud, writes nothing. Fail-soft — a dead feed degrades a race to a
  // prior, never a throw. Race polls are fetched in ONE bulk call per poll-type (not one HTTP call per race).
  {
    const FORECAST_LOOP_MS = parseInt(process.env.FORECAST_LOOP_MS || '', 10) || 30 * 60 * 1000;   // recompute every 30m
    const loop = require('./lib/forecast_loop');
    const votehub = require('./lib/poll_votehub');
    const legacy = require('./lib/poll_538legacy');
    const registry = require('./lib/forecast_registry');
    const candidateParty = require('./lib/candidate_party');
    const fcNorm = (s) => String(s == null ? '' : s).trim().toLowerCase();
    let ratingsCache = null;   // 538 pollster ratings — slow-moving; fetched once per process
    const partyCache = new Map();   // candidate name → party ('A'|'B'|null) via FEC; static per person, persists across cycles
    // COVERAGE: 538 partisan-lean data (all 435 districts + 50 states), read once from data/elections
    // (fetched by sidecar/fetch_data.py). Gives every unpolled seat a real prior so the sim runs the full map.
    const coverageLib = require('./lib/coverage');
    let leanData = null;
    const loadLeans = () => {
      if (leanData !== null) return leanData;
      try {
        const p = require('path'), fs = require('fs'), dir = p.join(__dirname, 'data', 'elections');
        const districts = coverageLib.parseLeanCsv(fs.readFileSync(p.join(dir, '538_partisan_lean_districts.csv'), 'utf8'));
        const states = coverageLib.parseLeanCsv(fs.readFileSync(p.join(dir, '538_partisan_lean_states.csv'), 'utf8'));
        let incumbentBySeat = {};   // current-member party per seat (incumbency term) — congress-legislators
        try { incumbentBySeat = coverageLib.parseIncumbents(JSON.parse(fs.readFileSync(p.join(dir, 'legislators-current.json'), 'utf8'))); } catch {}
        leanData = (Object.keys(districts).length && Object.keys(states).length) ? { districts, states, incumbentBySeat } : false;
      } catch { leanData = false; }
      return leanData;
    };
    // Senate holdover composition (seats NOT up in 2026), by caucus — ESTIMATE as of 2025 (53R/47D; Class 2 up
    // ~22R/13D). Approximate until exact Echo Senate composition is wired; override via env.
    const SENATE_HOLDOVERS = { A: parseInt(process.env.SENATE_HOLDOVER_A || '', 10) || 34, B: parseInt(process.env.SENATE_HOLDOVER_B || '', 10) || 31 };
    const runForecastLoop = async () => {
      try {
        // one bulk poll fetch per race poll-type → index by subject (avoids an HTTP call per race)
        const pollIndex = {};
        for (const pt of ['us-senator', 'us-representative']) {
          try {
            const r = await votehub.fetchPolls({ fetchJson: votehub.defaultFetchJson, poll_type: pt });
            for (const p of (r.polls || [])) { const k = fcNorm(p.subject); (pollIndex[k] = pollIndex[k] || []).push(p); }
          } catch (e) { console.error('[forecast] poll fetch', pt, e.message); }
        }
        if (ratingsCache == null) { try { ratingsCache = (await legacy.fetchRatings({ fetchText: legacy.defaultFetchText })).ratings || []; } catch { ratingsCache = []; } }

        // CANDIDATE→PARTY (FEC): VoteHub gives bare candidate names with no party, so a poll margin can't be
        // signed D-vs-R. Resolve every name to a party via FEC (through the managed api_stream surface), cached
        // across cycles (party is static). Fail-soft — an unresolved name leaves that race on a prior.
        let partyOf = null;
        try {
          const apiStream = require('./lib/api_stream');
          const entries = [];
          for (const k of Object.keys(pollIndex)) for (const p of pollIndex[k]) {
            const office = candidateParty.officeCode(p.poll_type);
            const state = registry.parseSubject(p.subject).stateAbbr || null;
            for (const a of (p.answers || [])) if (a && a.choice) entries.push({ name: a.choice, office, state });
          }
          const search = async (name, opts) => {
            const r = await apiStream.pull('fec', 'candidates/search', { params: { q: name, office: opts.office || undefined, state: opts.state || undefined, per_page: 5 } });
            return r && r.ok && r.data ? (r.data.results || []) : [];
          };
          const built = await candidateParty.resolveMany(entries, { search, cache: partyCache, concurrency: 4 });
          partyOf = built.partyOf;
          console.log(`[forecast] party resolve: ${built.resolved}/${built.total} candidates → D/R (via FEC)`);
        } catch (e) { console.error('[forecast] party resolve', e.message); }

        const engineUp = await ensureEngine();                       // gpt-oss direction judgments need the cloud; absent it, news is volatility-only
        const cloud = engineUp ? require('./lib/cloud_logic') : null;
        const res = await loop.runOnce({
          fetchSubjects: () => votehub.fetchSubjects({ fetchJson: votehub.defaultFetchJson }),
          getRacePolls: (race) => pollIndex[fcNorm(race.subject)] || [],
          ratings: ratingsCache,
          partyOf,                                                 // FEC-resolved candidate→party → signs the poll margins
          ask: cloud ? cloud.ask : null,
          getSnapshot: require('./lib/api_stream').getSnapshot,   // FUNDAMENTALS leg: seeded econ signals (GDP/CPI/unrate/yields) → national environment lean
          coverage: (() => { const L = loadLeans(); return L ? { districts: L.districts, states: L.states, senateUp: coverageLib.SENATE_2026, senateHoldovers: SENATE_HOLDOVERS, incumbentBySeat: L.incumbentBySeat } : null; })(),   // full 435+35 universe from 538 lean + incumbency; polled seats override
          midtermSwing: parseFloat(process.env.FORECAST_MIDTERM_SWING || '') || 3.0,   // uniform out-party swing (president's party loses at the midterm). CALIBRATION-INFORMED (lib/congress_results backtest, MEDSL 1976-2018): realized penalty averaged House +7.4 / Senate +5.9 pts, per-seat-Brier-optimal ~2-3.5 (flat); 3.0 = a measured, conservative value (fundamentals lean carries the rest). env-override.

          presidentParty: 'B',                                     // 2026: sitting president is Republican → midterm swing favors D
          // resolve (read-only Echo enrichment) intentionally left off the hot loop — margins/sim don't need
          // echo_ref, and enriching the whole slate every cycle would hammer Echo. Opt-in follow-on.
        });
        if (res && res.ok) {
          lastForecast = res;
          const fx = res.work.fundamentals;
          const env = fx && fx.has_data ? ` · env ${fx.lean > 0 ? '+' : ''}${fx.lean} (${fx.favors})` : '';
          const mt = res.work.midterm ? ` · midterm ${res.work.midterm.delta > 0 ? '+' : ''}${res.work.midterm.delta}` : '';
          const cov = res.work.coverage ? ` · coverage ${res.work.coverage.races} seats` : '';
          const jd = res.work.assess ? ` · ${res.work.assess.assessed}/${res.work.assess.pairs} judged` : '';
          console.log(`[forecast] recompute: ${res.work.margins.polled}/${res.work.margins.total} polled${cov} · House P(D) ${(res.payload.house.pD_control * 100).toFixed(0)}% · Senate P(D) ${(res.payload.senate.pD_control * 100).toFixed(0)}%${env}${mt}${jd}${res.live ? ' · LIVE' : ''} · ${res.work.timing_ms}ms`);
        } else if (res) { console.log(`[forecast] recompute skipped: ${res.error}`); }
      } catch (e) { console.error('[forecast] recompute loop failed:', e.message); }
    };
    forecastLoopTimeout = setTimeout(() => { runForecastLoop().catch(() => {}); }, 2 * 60 * 1000);   // first run ~2m after boot
    forecastLoopTimer = setInterval(() => { runForecastLoop().catch(() => {}); }, FORECAST_LOOP_MS);
    forecastLoopTimer.unref?.();
    console.log(`[main] forecasting recompute loop scheduled (every ${Math.round(FORECAST_LOOP_MS / 60000)}m → balance of power)`);
  }

  // NEWS VIDEO-CAPTION CAPTURE (Phase A completion) — hidden always-on webContents read the Monitor video
  // streams' closed captions into the SAME isolated bucket as source_kind='video' SEGMENTS (clustered like
  // any source), and a bare "[Music]" caption grabs a SCREENSHOT of the frame — show start/stop stings and
  // full-screen charts/graphs (e.g. Yahoo Finance) that captions can't convey. HEAVY (N hidden windows) →
  // gated by NEWS_VIDEO_CAPTURE. DEFAULT OFF (2026-07-12): even ad-blocked + forced 144p, 4 hidden live-
  // NOW ZERO-DECODE (lib/caption_stream, 2026-07-12): yt-dlp resolves each live feed's auto-caption HLS
  // manifest, then we poll it for new WEBVTT segments over plain HTTP — NO browser windows, NO video decode.
  // This REPLACES the old hidden-YouTube-window CaptureLane, whose 4 live-video windows + ad-iframe swarm
  // pegged the main thread and froze the app repeatedly (see memory/video-capture-freeze). Cheap enough to
  // default ON again; kill-switch NEWS_VIDEO_CAPTURE=0. Reuses feedsStore.videoList() + the news_store pipe.
  if (!/^(0|false|off|no)$/i.test(String(process.env.NEWS_VIDEO_CAPTURE || 'on').trim())) {
    try {
      const captionStream = require('./lib/caption_stream');
      const newsStore = require('./lib/news_store');
      const videos = (feedsStore.videoList() || []).filter((v) => v && v.url);
      if (videos.length) {
        newsVideoLane = new captionStream.CaptionStreamLane({
          store: newsStore, feeds: videos,
          intervalMs: parseInt(process.env.NEWS_VIDEO_POLL_MS || '', 10) || 15000,
          sampleMs: parseInt(process.env.NEWS_VIDEO_SAMPLE_MS || '', 10) || 30000,
          ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
          log: (m) => console.log(m),
        });
        newsVideoLane.start();
      } else { console.log('[main] news video captions: no video streams configured'); }
    } catch (e) { console.error('[main] news caption stream failed to start:', e.message); }
  }

  // SCRIBE BOOT-RESUME: if the app restarted mid-meeting (canvas-hosted + gmeet still active, or a scribe
  // session left open), re-attach the scribe heartbeat so the lane keeps documenting / finalizes cleanly.
  try {
    const canvasHosted = (db.getMeta('gmeet_host') || 'browser') === 'canvas';
    if (canvasHosted && (require('./lib/gmeet').active() || require('./lib/meeting_scribe').hasPending())) {
      startScribeHeartbeat();
      console.log('[scribe] heartbeat resumed after restart (meeting still active / scribe pending)');
    }
  } catch (e) { console.error('[scribe] boot-resume check failed:', e.message); }

  // Browser layer status → forward to renderer
  browserLib.setListeners({
    onStatusChange: (s) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('browser:status', s);
        }
      } catch {}
    }
  });

  // Chat watcher → forward inbound replies to renderer (for sheep panel)
  // AND immediately nudge the heartbeat scheduler to fire ASAP, so an inbound
  // reply gets surfaced without waiting on the 30s tick interval.
  chatWatcher.setListeners({
    onReplyArrived: (ev) => {
      console.log(`[main] chat reply arrived from ${ev.speaker} (via ${ev.detectedBy}): ${(ev.text || '').slice(0, 80)}…`);
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('inbound:arrived', ev);
        }
      } catch {}
      // Kick heartbeat immediately so Stheno reacts within ~2s rather than 30s
      const { maybeHeartbeat } = require('./lib/heartbeat');
      setTimeout(() => {
        maybeHeartbeat().catch(err => console.error('[main] heartbeat kick failed:', err.message));
      }, 600);
    },
    onReplyTimeout: (ev) => {
      console.log(`[main] chat reply TIMEOUT for tab ${ev.url}`);
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('inbound:timeout', ev);
        }
      } catch {}
    }
  });

  // Auto-reconnect: if Chrome is already running with the debug port from a
  // prior session, attach silently. Without this, restarts of Side Quest leave
  // her tools dark even though her browser is still right there.
  (async () => {
    try {
      const probe = await fetch('http://localhost:9222/json/version', {
        signal: AbortSignal.timeout(2000)
      }).catch(() => null);
      if (probe && probe.ok) {
        const r = await browserLib.connect({ retries: 1 });
        if (r.ok) console.log('[main] browser auto-reconnected to existing Chrome on port 9222');
      }
    } catch (err) {
      console.log('[main] browser auto-reconnect skipped:', err.message);
    }
  })().catch(() => {});

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (inboxPollTimer) { clearInterval(inboxPollTimer); inboxPollTimer = null; }
  if (inboxPollTimeout) { clearTimeout(inboxPollTimeout); inboxPollTimeout = null; }
  if (apiStreamTimer) { clearInterval(apiStreamTimer); apiStreamTimer = null; }
  if (apiStreamTimeout) { clearTimeout(apiStreamTimeout); apiStreamTimeout = null; }
  if (apiBulkTimer) { clearInterval(apiBulkTimer); apiBulkTimer = null; }
  if (apiBulkTimeout) { clearTimeout(apiBulkTimeout); apiBulkTimeout = null; }
  if (truthTimer) { clearInterval(truthTimer); truthTimer = null; }
  if (truthTimeout) { clearTimeout(truthTimeout); truthTimeout = null; }
  if (emailIntakeTimer) { clearInterval(emailIntakeTimer); emailIntakeTimer = null; }
  if (emailIntakeTimeout) { clearTimeout(emailIntakeTimeout); emailIntakeTimeout = null; }
  if (canvasIngestTimer) { clearInterval(canvasIngestTimer); canvasIngestTimer = null; }
  if (canvasIngestTimeout) { clearTimeout(canvasIngestTimeout); canvasIngestTimeout = null; }
  if (forecastLoopTimer) { clearInterval(forecastLoopTimer); forecastLoopTimer = null; }
  if (forecastLoopTimeout) { clearTimeout(forecastLoopTimeout); forecastLoopTimeout = null; }
  try { require('./lib/news_poll').stop(); } catch {}
  try { newsVideoLane && newsVideoLane.stop(); } catch {}
  try { stopScribeHeartbeat(); } catch {}
  try { actionLoop.abort(); } catch {}
  stopMonologueScheduler();
  stopHeartbeatScheduler();
  stopContinuityScheduler();
  schedulerLib.stopScheduler();
  try { await discordLib.stop(); } catch {}
  try { await webLib.close(); } catch {}
  try { await engineSupervisor?.shutdown(); } catch {}   // tree-kills ONLY an engine WE spawned; adopted external left alone
  try { require('./lib/downtime').markShutdown(); } catch {}   // precise marker for a clean shutdown
  try {
    await forceReflectionIfDue();
  } catch (err) {
    console.error('[main] end-of-session reflection failed:', err);
  }
  db.endSession(currentSessionId);
  stopReflectionScheduler();
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC ----------------------------------------------------------------

// Editor Studio — open the window + the registry/import surface (runs in main; renderer invokes).
ipcMain.handle('editor:open', () => { createEditorWindow(); return { ok: true }; });
ipcMain.handle('workspace:open', () => { createWorkspaceWindow(); return { ok: true }; });
ipcMain.handle('canvas:open', () => { createCanvasWindow(); return { ok: true }; });
// Usage pill (canvas top bar): Zoe's metered model-token usage over the configured window + a live /hr rate.
ipcMain.handle('usage:summary', () => {
  try {
    const uc = config.usageConfig();
    const s = require('./lib/usage_meter').summary({ windowMs: uc.windowMs, rateMs: uc.rateMs });
    return { ok: true, ...s, label: uc.label };
  } catch (e) { return { ok: false, error: e.message }; }
});
// Desktop companion: hide (keep the process/state, just tuck her away) + toggle (create/show or hide).
ipcMain.handle('companion:hide', () => { try { if (companionWindow && !companionWindow.isDestroyed()) companionWindow.hide(); } catch {} return { ok: true }; });
ipcMain.handle('companion:toggle', () => {
  try {
    if (companionWindow && !companionWindow.isDestroyed() && companionWindow.isVisible()) { companionWindow.hide(); return { ok: true, visible: false }; }
    const w = createCompanionWindow(); if (w) { w.show(); return { ok: true, visible: true }; }
    return { ok: false, error: 'companion unavailable (disabled or no zoe.vrm)' };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Forecasting processing side — the Forecasting STUDIO (renderer/forecast.html, a surface inside My
// Workspace) invokes these. Each widget's payload is built in lib/forecast_service (reads the poll
// connectors; no prod DB). Fail-soft so a feed error never breaks the surface.
ipcMain.handle('forecast:widgets', () => { try { return require('./lib/forecast_service').listWidgets(); } catch (e) { return []; } });
ipcMain.handle('forecast:poll-average', async (_e, opts) => {
  try { return await require('./lib/forecast_service').pollAverageWidget(opts || {}); }
  catch (e) { return { ok: false, model: 'poll_average', error: e.message }; }
});
// Serves the recompute loop's live result (lastForecast). A seed override re-sims the SAME live slate (fast,
// no network) → the studio's "Re-run sim" jitter now plays on REAL margins. Before the first loop run (or if
// it hasn't produced one yet) falls back to the illustrative synthetic slate so the surface is never empty.
ipcMain.handle('forecast:balance', (_e, opts = {}) => {
  try {
    if (opts && opts.seed != null && lastForecast && lastForecast.work && lastForecast.work.inputs) {
      const { races, config } = lastForecast.work.inputs;
      const r = require('./lib/forecast_loop').recompute(races, { events: [], momentum: [] }, { config: { ...config, seed: opts.seed } });
      return { ...lastForecast, payload: r.payload, work: { ...lastForecast.work, sim: r.work.sim, timing_ms: r.work.timing_ms } };
    }
    if (lastForecast) return lastForecast;
    return require('./lib/forecast_service').balanceWidget(opts || {});
  } catch (e) { return { ok: false, model: 'balance_of_power', error: e.message }; }
});
// CALIBRATION — the trust readout: the structural model's full-chain backtest vs real presidential history
// (Brier / skill / ECE / interval coverage + reliability curve + tuned σ). Static (backtest of the model, not
// the live run), cached. The glass box surfaces it so trust is visible, not just in a script.
let calibrationCache = null;
ipcMain.handle('forecast:calibration', () => {
  try {
    if (calibrationCache) return calibrationCache;
    const p = require('path'), fs = require('fs'), dir = p.join(__dirname, 'data', 'elections');
    const backtest = require('./lib/backtest');
    const h = backtest.parsePresHistory([fs.readFileSync(p.join(dir, 'complete_data.csv'), 'utf8'), fs.readFileSync(p.join(dir, '2024president.csv'), 'utf8')]);
    if (!Object.keys(h.margins).length) return { ok: false, error: 'no history (run sidecar/fetch_data.py)' };
    const tuned = backtest.tuneSigma(h);
    const r = backtest.backtestChain(h, { sigma: tuned.sigma });
    calibrationCache = { ok: true, model: 'structural (lean prior + national)', tuned_sigma: tuned.sigma,
      n: r.n, rmse: r.rmse, brier: r.brier, brier_skill: r.brier_skill, ece: r.ece, coverage95: r.coverage95, reliability: r.reliability };
    return calibrationCache;
  } catch (e) { return { ok: false, error: e.message }; }
});

// ============================ MONITORS (canvas news-feed widget) =============================
// Side Quest half: subscription CRUD + fetch via the engine's fetch_feeds_batch, mapped to a merged
// newest-first item stream (studio/feeds_view). Where items get stored + how Zoe cognizes them is the
// Zoe-builder's lane. Read-only fetch; no model.
ipcMain.handle('feeds:list', () => { try { return { ok: true, feeds: feedsStore.list() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('feeds:add', (_e, { url, title } = {}) => { try { return feedsStore.add(url, title); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('feeds:remove', (_e, { url } = {}) => { try { return feedsStore.remove(url); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('feeds:video-list', () => { try { return { ok: true, videos: feedsStore.videoList() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('feeds:video-add', (_e, { url, title } = {}) => { try { return feedsStore.videoAdd(url, title); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('feeds:video-remove', (_e, { url } = {}) => { try { return feedsStore.videoRemove(url); } catch (e) { return { ok: false, error: e.message }; } });
// NEWS TUNER (topical balance) — db meta 'news_tuner' JSON. Read fresh at each use so a save takes effect on
// the next feed fetch / compression WITHOUT a reboot. Always returns a full normalized config (defaults when
// unset → balancing is ON by default: sports capped, weather uncapped, hard-news reserved).
function getNewsTuner() {
  const rank = require('./lib/news_rank');
  try { const raw = db.getMeta('news_tuner'); return rank.normalizeTuner(raw ? JSON.parse(raw) : null); } catch { return rank.defaultTuner(); }
}
ipcMain.handle('news:tuner-get', () => { try { return { ok: true, tuner: getNewsTuner() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('news:tuner-set', (_e, { tuner } = {}) => {
  try {
    const norm = require('./lib/news_rank').normalizeTuner(tuner);
    db.setMeta('news_tuner', JSON.stringify(norm));
    return { ok: true, tuner: norm };
  } catch (e) { return { ok: false, error: e.message }; }
});
// ===== API MANAGEMENT STREAM — raw-pull hooks (for the forecasting section) + management views =====
ipcMain.handle('api:datasets', () => { try { return { ok: true, datasets: require('./lib/api_stream').datasets(), catalog: require('./lib/api_catalog').list() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('api:snapshot', (_e, { datasetId } = {}) => { try { return { ok: true, snapshot: require('./lib/api_stream').getSnapshot(datasetId) }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('api:pull', async (_e, { apiId, path, params, method, body } = {}) => { try { return await require('./lib/api_stream').pull(apiId, path, { params: params || {}, method, body }); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('api:refresh', async (_e, { datasetId, force } = {}) => { try { return await require('./lib/api_stream').refreshDataset(datasetId, { force: !!force }); } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('api:key-status', () => { try { return { ok: true, keys: require('./lib/api_client').keyStatus() }; } catch (e) { return { ok: false, error: e.message }; } });
ipcMain.handle('api:health', async () => { try { return { ok: true, health: await require('./lib/api_manager').healthAll() }; } catch (e) { return { ok: false, error: e.message }; } });
// NEWS BRIEFING ("dam" snapshot, Phase B): freshen the un-clustered tail (compression) then render the
// consistent, schema-locked brief DOCUMENT over the active stories. Default window = today→now; pass
// sinceMs for "what's the update since <time>". Corroboration is syndication-aware (reports, not raw
// outlet reach). Fail-safe: cloud down → deterministic fallback brief (a brief ALWAYS renders).
ipcMain.handle('news:briefing', async (_e, { sinceMs = null } = {}) => {
  try {
    const news_lane = require('./lib/news_lane');
    const news_brief = require('./lib/news_brief');
    const newsStore = require('./lib/news_store');
    const engineUp = await ensureEngine();
    const cloud = engineUp ? require('./lib/cloud_logic') : null;
    const now = Date.now();
    const tuner = getNewsTuner();
    const snap = await news_lane.snapshot({
      store: newsStore, sinceMs, tuner,
      adjudicate: cloud ? (s, i) => news_lane.adjudicateSameEvent(s, i, { ask: cloud.ask }) : null,
      classifyAds: cloud ? (segs) => require('./lib/news_ads').classifyBatch(segs, { ask: cloud.ask, model: require('./lib/models').getModelFor('editor', null) }) : null,
      classifyEmailAds: cloud ? (items) => require('./lib/news_ads').classifyEmailBatch(items, { ask: cloud.ask, model: require('./lib/models').getModelFor('editor', null) }) : null,
      reconstructVideo: cloud ? (vids) => require('./lib/video_reconstruct').runReconstruct(vids, { store: newsStore, ask: cloud.ask, model: require('./lib/models').getModelFor('editor', null), log: (m) => console.log('[news-brief]', m) }) : null,
      log: (m) => console.log('[news-brief]', m),
    });
    // NEWS TUNER: balance the story selection (reserve hard-news slots / weight / cap) before the prose brief,
    // so a heavily-corroborated topic (e.g. World Cup) can't dominate the brief. Same balance as the widget.
    const stories = news_lane.balanceStories(news_lane.storiesActiveInWindow(snap.since, { limit: 60 }), tuner, { top: 12 });
    const deltasByStory = {};
    for (const s of stories.slice(0, 12)) { try { deltasByStory[s.id] = news_lane.storyDeltas(s.id); } catch {} }
    // The brief is ON-DEMAND (not always-on), so pin it to the best-WRITING model, not the fast tier. Live
    // A/B on real stories: mistral-large-3:675b wrote the richest VALID prose (12/12 stories, ~14s);
    // reasoning models (kimi/qwen3.5/gpt-oss) return EMPTY via ollama.complete (answer hidden in `thinking`);
    // gemma4:31b is terser. Overridable via env ZOE_NEWS_BRIEF_MODEL or db meta `model.news_brief`; ask()
    // fails safe to the deterministic snippet fallback if the pinned model is ever unavailable.
    const briefModel = process.env.ZOE_NEWS_BRIEF_MODEL
      || (() => { try { return db.getMeta('model.news_brief'); } catch { return null; } })()
      || 'mistral-large-3:675b';
    const brief = await news_brief.generateBrief({
      stories, deltasByStory,
      windowLabel: sinceMs ? 'since then' : 'today so far',
      nowIso: new Date(now).toISOString(),
      ask: cloud ? cloud.ask : null,
      model: briefModel, numPredict: 2200,
    });
    return { ok: true, markdown: brief.markdown, viaCloud: brief.viaCloud, storyCount: stories.length, freshItems: snap.freshItems, since: snap.since, now };
  } catch (e) { console.error('[news] briefing failed:', e.message); return { ok: false, error: e.message }; }
});
// CLEAN YouTube player: the /embed player errors (153) top-level and from a file:// host. Serve a tiny
// page over http://127.0.0.1 that FRAMES the embed with a matching ?origin= — the handshake YouTube
// needs — so the canvas gets a chrome-free player (no search bar / sign-in / live chat / watch-page junk).
let ytServer = null, ytReady = null, ytPort = 0;
function ensureYtPlayerServer() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    try {
      const http = require('http');
      ytServer = http.createServer((req, res) => {
        try {
          const u = new URL(req.url, 'http://127.0.0.1');
          if (u.pathname === '/yt') {
            const id = (u.searchParams.get('v') || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20);
            const auto = u.searchParams.get('a') === '1' ? '&autoplay=1' : '';   // full-ingestion pane autoplays w/ sound
            const origin = `http://127.0.0.1:${ytPort}`;
            const frame = id
              ? `<iframe src="https://www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&playsinline=1${auto}&origin=${encodeURIComponent(origin)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe>`
              : 'no video';
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body>${frame}</body></html>`);
            return;
          }
          res.writeHead(404); res.end('not found');
        } catch { try { res.writeHead(500); res.end('err'); } catch {} }
      });
      ytServer.on('error', (e) => { console.error('[yt] player server error:', e.message); resolve(0); });
      ytServer.listen(0, '127.0.0.1', () => { ytPort = ytServer.address().port; console.log(`[yt] clean player server on 127.0.0.1:${ytPort}`); resolve(ytPort); });
    } catch (e) { console.error('[yt] player server failed:', e.message); resolve(0); }
  });
  return ytReady;
}
ipcMain.handle('feeds:player-base', async () => { const p = await ensureYtPlayerServer(); return { ok: !!p, base: p ? `http://127.0.0.1:${p}/yt` : '' }; });

// FULL-INGESTION gate: launch a YouTube video in its OWN dedicated canvas pane with AUDIO ON, so the
// soundtrack can be transcribed (for videos/lives without CCs). Opens/focuses the Canvas + tells the
// renderer to mount the ingestion pane. Operator- or Zoe-triggered (sq.ingestVideo / autonomous).
ipcMain.handle('video:ingest', (_e, { url, title } = {}) => {
  try {
    if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, error: 'invalid url' };
    const win = createCanvasWindow();
    const payload = { url: String(url), title: title || 'Full ingestion' };
    const send = () => { try { win.webContents.send('canvas:video-ingest', payload); } catch {} };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
    win.focus();
    return { ok: true };
  } catch (e) { console.error('[video] ingest failed:', e.message); return { ok: false, error: e.message }; }
});
ipcMain.handle('feeds:fetch', async (_e, { itemLimit = 30 } = {}) => {
  try {
    const urls = feedsStore.list().map(f => f.url);
    if (!urls.length) return { ok: true, items: [], sources: [] };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const payload = await pollCallTool()('fetch_feeds_batch', { feed_urls: urls, item_limit: itemLimit });
    const merged = feedsView.mergeReports(payload);
    // Enrich each item with its cached topic category (feed tuner). Uncategorized (not yet cloud-classified)
    // → the deterministic provisional label, so the widget can balance immediately. Also ship the tuner
    // config so the renderer arranges in one round-trip.
    try {
      const newsStore = require('./lib/news_store');
      const topics = require('./lib/news_topics');
      const cats = newsStore.categoriesByGuid(merged.items.map((i) => i.id));
      for (const it of merged.items) it.category = cats[it.id] || topics.categorizeFast(it).category;
    } catch (e) { console.error('[feeds] category enrich failed:', e.message); }
    return { ok: true, items: merged.items, sources: merged.sources, tuner: getNewsTuner() };
  } catch (e) { console.error('[feeds] fetch failed:', e.message); return { ok: false, error: e.message }; }
});

// Meet-in-canvas (Slice 6): route a Meet URL into Zoe's Canvas pane (she joins as herself in the
// persist:zoe-google partition), freeing her dedicated CDP browser. Opens/focuses the Canvas window
// and tells its renderer to mount the Meet webview. Operator/Zoe-initiated only.
// The canvas Meet driver (lib/meet_canvas) — operates the Meet pane via the captured guest webContents.
// Registered as the live driver so gmeet's canvasMeetDeps() can reach it from the idle loop.
let meetDriver = null;
function meetDriverInst() {
  if (!meetDriver) {
    const mc = require('./lib/meet_canvas');
    meetDriver = mc.createMeetDriver(getMeetWebContents);
    mc.setLiveDriver(meetDriver);
  }
  return meetDriver;
}

// START A CANVAS-HOSTED MEETING — the one path all join routes funnel through (calendar "Zoe: Join",
// a Meet link in chat, autonomous). Opens/focuses the Canvas, mounts the Meet pane, marks the meeting
// canvas-hosted, and kicks gmeet's stage machine — which now runs through the canvas driver (join →
// intro → captions → follow/answer → leave), freeing her dedicated browser. She joins as herself.
// PORT Zoe's Google session into the canvas Meet partition — copy her live google.com cookies from
// her already-signed-in dedicated browser into persist:zoe-google, so Meet loads signed-in AS HER.
// (Google blocks interactive sign-in inside embedded webviews; an already-authed cookie session is
// fine.) Best-effort + idempotent; returns the count copied.
async function portZoeGoogleSession() {
  try {
    const cks = await require('./lib/web').cookies(['https://google.com', 'https://www.google.com', 'https://accounts.google.com', 'https://meet.google.com']);
    if (!cks || !cks.length) return { ok: false, count: 0 };
    const sess = session.fromPartition('persist:zoe-google');
    const SS = { None: 'no_restriction', Lax: 'lax', Strict: 'strict' };
    let n = 0;
    for (const c of cks) {
      const host = String(c.domain || '').replace(/^\./, '');
      if (!/(^|\.)google\.com$/.test(host)) continue;
      const set = { url: `https://${host}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
      if (String(c.domain || '').startsWith('.')) set.domain = c.domain;
      if (Number.isFinite(c.expires) && c.expires > 0) set.expirationDate = c.expires;
      if (SS[c.sameSite]) set.sameSite = SS[c.sameSite];
      try { await sess.cookies.set(set); n++; } catch { /* skip a cookie Electron rejects */ }
    }
    console.log(`[meet] ported ${n} Google cookie(s) into the canvas partition`);
    return { ok: n > 0, count: n };
  } catch (e) { console.error('[meet] cookie port failed:', e.message); return { ok: false, count: 0, error: e.message }; }
}

async function startCanvasMeeting(url, title) {
  if (!url || !/^https?:\/\//i.test(String(url))) return false;
  const win = createCanvasWindow();
  meetDriverInst();   // ensure the live driver is registered before the idle loop ticks
  await portZoeGoogleSession();   // sign the partition in AS HER before the webview loads Meet
  const payload = { url: String(url), title: title || 'Google Meet' };
  const send = () => { try { win.webContents.send('canvas:meet-join', payload); } catch {} };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
  win.focus();
  try { db.setMeta('gmeet_host', 'canvas'); require('./lib/gmeet').start(String(url)); } catch (e) { console.error('[meet] gmeet start failed:', e.message); }
  try { startScribeHeartbeat(); } catch (e) { console.error('[scribe] heartbeat start failed:', e.message); }
  // MEETING AUDIO (Lucas's virtual-cable path) — start Echo transcription of the meeting audio when enabled
  // + a device is configured. OFF by default (captions stand in); fully fail-safe.
  try {
    const r = await require('./lib/meeting_audio').start({ dispatch: (t) => echoSuit.dispatch(t) });
    if (r && r.ok) console.log(`[meet-audio] Echo capture started (source=${r.source}${r.deviceIndex != null ? ` dev=${r.deviceIndex}` : ''}, session ${r.sessionId})${r.isolated ? '' : ' [UNISOLATED — default mix; other meetings will bleed in]'}`);
    else if (r && r.reason && r.reason !== 'disabled') console.log(`[meet-audio] capture not started: ${r.reason}`);
  } catch (e) { console.error('[meet-audio] start failed:', e.message); }
  return true;
}

// Meet-in-canvas (Slice 6): route a Meet URL into Zoe's Canvas pane (she joins as herself in the
// persist:zoe-google partition), freeing her dedicated CDP browser. Runs the full meeting flow.
ipcMain.handle('meet:join', async (_e, { url, title } = {}) => {
  try {
    if (!(await startCanvasMeeting(url, title))) return { ok: false, error: 'invalid meet url' };
    return { ok: true };
  } catch (e) { console.error('[meet] join failed:', e.message); return { ok: false, error: e.message }; }
});

// P1 verification probe — read live state from the Meet pane (run window.sq.meetProbe() in the
// Canvas console after joining). Confirms the driver can see the meeting + scrape captions/attendees.
ipcMain.handle('meet:probe', async () => {
  try {
    if (!getMeetWebContents()) return { ok: false, error: 'no Meet webview attached — join a meeting in the canvas first' };
    const d = meetDriverInst();
    const inMeeting = await d.inMeeting();
    const captions = (await d.scrapeCaptions()) || '';
    const attendees = ((await d.scrapeAttendees()) || '').split('\n').filter(Boolean).slice(0, 20);
    return { ok: true, inMeeting, captionLines: captions ? captions.split('\n').length : 0, captionsSample: captions.slice(0, 1500), attendees };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('editor:list-documents', (_e, opts = {}) => {
  try { return { ok: true, documents: editorRegistry.listDocuments(opts) }; }
  catch (e) { console.error('[editor] list failed:', e.message); return { ok: false, error: e.message, documents: [] }; }
});

ipcMain.handle('editor:get-document', (_e, id) => {
  try { return { ok: true, document: editorRegistry.getDocument(id) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('editor:get-working-copy', (_e, { docId, version } = {}) => {
  try { return { ok: true, workingCopy: editorRegistry.getWorkingCopy(docId, version) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Import ANY supported document into the editor. .md/.txt read directly; real documents
// (.pdf/.docx/.xlsx/.csv and images) are extracted to markdown FIRST via lib/file_ingest — text layer
// through doc_extract, images through vision — the exact machinery the canvas drop-ingest uses. Then the
// working copy is normalized + registered. Shared by the picker AND drag-drop. → { ok, document } | { ok:false, error }.
async function importEditorDoc(filePath) {
  const fsm = require('fs');
  if (!filePath || !fsm.existsSync(filePath)) return { ok: false, error: 'file not found' };
  const ext = require('path').extname(filePath).replace(/^\./, '').toLowerCase();
  let wc;
  if (editorImport.TEXT_FORMATS.has(ext)) {
    wc = editorImport.importFile(filePath);                       // .md/.txt — no extraction needed
  } else {
    const fi = require('./lib/file_ingest');
    const de = require('./lib/doc_extract');
    const vis = require('./lib/vision');
    const r = await fi.extractDroppedFile(filePath, { deps: {
      extractToMarkdown: (p) => de.extractToMarkdown(p),
      rasterizePdf: (p, opts) => de.rasterizePdf(p, opts),
      describe: (o) => vis.describe(o),
      readFileBase64: (p) => fsm.readFileSync(p).toString('base64'),
      fileExists: (p) => fsm.existsSync(p),
      log: (m) => console.log(m),
    } });
    const md = (r && r.text) || '';
    if (md.length < 40) return { ok: false, error: `couldn't extract readable text from .${ext} (${r ? r.via : 'no result'})` };
    wc = editorImport.importFile(filePath, { markdown: md });
    console.log(`[editor] imported "${wc.title}" from .${ext} via ${r.via} (${md.length}ch)`);
  }
  const doc = editorRegistry.registerDocument({
    title: wc.title, docType: wc.format, source: 'upload',
    echoDocPath: filePath, changeSummary: `imported from .${wc.format}`,
  });
  editorRegistry.saveWorkingCopy(doc.id, 1, wc);
  return { ok: true, document: editorRegistry.getDocument(doc.id) };
}

// AUTO-INGEST watcher — every file that lands in her browser's DOWNLOADS_DIR (a PDF auto-harvested
// off a page, one she navigated onto, or a click/recipe download) is extracted → landed in the
// short-term doc store → decomposed + surfaced, the SAME rail as a canvas drop. Decoupled from
// web.js on purpose: whatever puts a file there, it gets ingested. Debounced + size-stable (a
// download is still being written when the first fs event fires) + deduped (land is idempotent on ref).
let _dlWatcherArmed = false;
function startDownloadsIngestWatcher() {
  if (_dlWatcherArmed) return; _dlWatcherArmed = true;
  const fsm = require('fs'); const pathm = require('path');
  const dir = webLib.DOWNLOADS_DIR;
  const INGEST_EXT = new Set(['pdf', 'docx', 'txt', 'md', 'markdown', 'xlsx', 'xlsm', 'csv', 'tsv']);
  const ingested = new Set();     // paths already handled this session
  const pending = new Map();      // path → debounce timer
  try { if (!fsm.existsSync(dir)) fsm.mkdirSync(dir, { recursive: true }); } catch {}

  async function ingestFile(fp) {
    // KILL SWITCH (2026-07-13): ZOE_AUTO_INGEST=0 disables the auto-ingest lane entirely — no download
    // watcher processing, no doc-decomp/surfaceDocCards spawn. Lucas can drop docs on the canvas manually
    // and use the app while the medical-directory flood is investigated. Flip back to 1 to restore.
    if (String(process.env.ZOE_AUTO_INGEST || '1').trim() === '0') { console.log('[dl-ingest] SKIP (kill switch ZOE_AUTO_INGEST=0)'); return; }
    if (ingested.has(fp)) return;
    try { if (!fsm.existsSync(fp)) return; } catch { return; }
    ingested.add(fp);
    try {
      const { text, via } = await extractFileMarkdown(fp);
      const title = pathm.basename(fp);
      if (!text || text.length < 40) { console.log(`[dl-ingest] skipped ${title} (thin/${via})`); return; }
      // RELEVANCE QUARANTINE: catch-all for whatever bypassed the harvest gate (manual drops, pre-gate
      // downloads). Off-domain docs still LAND (searchable in the doc store, marked) but are NOT decomposed
      // into the entity graph — keeping the flood of foreign-registry names out of the KG. Lenient: only a
      // clear foreign-gov source with zero domain overlap is held back.
      const _rel = require('./lib/relevance');
      const _verdict = _rel.assess({ filename: title, text: String(text).slice(0, 6000) }, _rel.getProfile(db));
      // DOMAIN-LEASH QUARANTINE (2026-07-13, drift audit): the Bayes relevance classifier misses obviously
      // off-domain docs whose language patterns look civic-adjacent — a "COVID19 Emergency Dental Providers"
      // CSV passed the Bayes gate and seeded 30+ dentists in the Puller while Lucas's active work is
      // Louisiana parishes. This is the same token-overlap leash grabPdfs uses (focus.domainLeashTokens: the
      // active directed focus ELSE recent civic threads). Titles/bodies with ZERO token overlap → quarantine
      // (doc still lands searchable in doc_store, just not decomposed into contacts). Empty leash (fresh
      // install, no civic work) → passes through (unleashed) so it never blocks a genuinely fresh start.
      let _leashPasses = true;
      try {
        const _lt = require('./lib/focus').domainLeashTokens();
        if (_lt && _lt.size) {
          // WORD-BOUNDARY match, not substring: `direct` (a project word) must not silently match
          // "directory" (a doc-listing word). Extract words 4+ chars from title+body, then set-intersect
          // with leash tokens. Same recipe as the tokenizer that BUILT the leash set — symmetric.
          const words = new Set((`${title} ${String(text).slice(0, 6000)}`.toLowerCase().match(/[a-z]{4,}/g) || []));
          _leashPasses = false;
          for (const t of _lt) if (words.has(t)) { _leashPasses = true; break; }
        }
      } catch { _leashPasses = false; }   // FAIL CLOSED (2026-07-15): a leash-construction error must quarantine (doc still lands searchable), never fall through unleashed.
      const landed = require('./lib/doc_store').land({ title, body: text, source: 'browser_download', ref: 'download:' + fp });
      if (landed && landed.landed) {
        if (!_verdict.relevant || !_leashPasses) {
          const _reason = !_verdict.relevant ? _verdict.reason : 'off-domain (no leash-token overlap)';
          console.log(`[dl-ingest] QUARANTINED ${title} → doc ${landed.id} (${_reason}) — landed searchable, NOT decomposed`);
          return;
        }
        console.log(`[dl-ingest] ${title} → doc ${landed.id} (${text.length}ch via ${via})`);
        const _srcUrl = (() => { try { return require('./lib/web').sourceUrlForFile(fp); } catch { return null; } })();   // real origin of a grabbed PDF → cite the decompose to it (official-document weight)
        try { decomposeLandedDoc({ id: landed.id, title, body: text, source: 'browser_download', sourceUrl: _srcUrl }).catch(() => {}); } catch {}
        try { surfaceDocCards({ id: landed.id, title, body: text }).catch(() => {}); } catch {}
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(downloaded) ${title}`, type: 'reading', query: title }); } catch {}
      }
    } catch (e) { console.error('[dl-ingest] failed:', e && e.message); }
  }
  // Wait until the file stops growing (2 stable size reads) before ingesting — the download may
  // still be writing when the first event fires.
  function schedule(fp) {
    if (pending.has(fp)) return;   // already waiting on this path
    let last = -1, stable = 0;
    const tick = () => {
      let sz = -1; try { sz = fsm.statSync(fp).size; } catch { pending.delete(fp); return; }
      if (sz === last) stable++; else { stable = 0; last = sz; }
      if (stable >= 2 && sz > 0) { pending.delete(fp); ingestFile(fp); }
      else pending.set(fp, setTimeout(tick, 700));
    };
    pending.set(fp, setTimeout(tick, 700));
  }
  try {
    fsm.watch(dir, (_evt, fname) => {
      if (!fname) return;
      const ext = pathm.extname(fname).replace(/^\./, '').toLowerCase();
      if (!INGEST_EXT.has(ext)) return;
      schedule(pathm.join(dir, fname));
    });
    console.log('[dl-ingest] watching', dir);
  } catch (e) { console.error('[dl-ingest] watch failed:', e && e.message); }
}

// Extract a file's readable text as markdown (.md/.txt read directly; binary docs via file_ingest —
// doc_extract text layer + vision OCR). Used when attaching an in-hand source to a citation. → { text, via }.
async function extractFileMarkdown(filePath) {
  const fsm = require('fs');
  if (!filePath || !fsm.existsSync(filePath)) return { text: '', via: 'missing' };
  const ext = require('path').extname(filePath).replace(/^\./, '').toLowerCase();
  if (editorImport.TEXT_FORMATS.has(ext)) {
    try { return { text: fsm.readFileSync(filePath, 'utf8'), via: 'text:' + ext }; }
    catch (e) { return { text: '', via: 'read-failed' }; }
  }
  const fi = require('./lib/file_ingest');
  const de = require('./lib/doc_extract');
  const vis = require('./lib/vision');
  const r = await fi.extractDroppedFile(filePath, { deps: {
    extractToMarkdown: (p) => de.extractToMarkdown(p),
    rasterizePdf: (p, opts) => de.rasterizePdf(p, opts),
    describe: (o) => vis.describe(o),
    readFileBase64: (p) => fsm.readFileSync(p).toString('base64'),
    fileExists: (p) => fsm.existsSync(p),
    log: (m) => console.log(m),
  } });
  return { text: (r && r.text) || '', via: (r && r.via) || 'none' };
}

// New document → pick a file (real documents extract automatically), normalize, register.
ipcMain.handle('editor:import-document', async () => {
  try {
    const res = await dialog.showOpenDialog(editorWindow || mainWindow, {
      title: 'Import a document into the Editor',
      properties: ['openFile'],
      filters: [
        { name: 'Documents', extensions: ['md', 'markdown', 'txt', 'text', 'pdf', 'docx', 'xlsx', 'xlsm', 'csv', 'tsv'] },
        { name: 'Images (OCR)', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    return await importEditorDoc(res.filePaths[0]);
  } catch (e) {
    console.error('[editor] import failed:', e.message);
    return { ok: false, error: e.message };
  }
});

// Drag-drop import → the renderer resolves the dropped file's OS path (webUtils.getPathForFile, since
// File.path is gone in Electron 42) and sends it here for the SAME import pipeline as the picker.
ipcMain.handle('editor:import-path', async (_e, filePath) => {
  try { return await importEditorDoc(filePath); }
  catch (e) { console.error('[editor] import-path failed:', e.message); return { ok: false, error: e.message }; }
});

// List the citations the extractor finds in a doc — populates the findings rail on OPEN (before Run
// checks) so the operator can attach an in-hand source to specific citations. Marks which already have
// one attached. Deterministic + model-free (studio/verify_extract).
ipcMain.handle('editor:list-citations', (_e, docId) => {
  try {
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    const wc = editorRegistry.getWorkingCopy(docId, doc.current_version);
    if (!wc || !Array.isArray(wc.blocks)) return { ok: true, citations: [], version: doc.current_version };
    const { extractUnits } = require('./studio/verify_extract');
    const units = (extractUnits(wc).units) || [];
    const attach = editorRegistry.getAttachmentMap(docId, doc.current_version);
    const citations = units.map(u => ({
      uid: u.uid, kind: u.kind, text: u.text, quote: u.quote || null, url: u.url || null,
      attached: attach[u.uid] ? { title: attach[u.uid].title, ref: attach[u.uid].ref } : null,
    }));
    return { ok: true, citations, version: doc.current_version };
  } catch (e) { console.error('[editor] list-citations failed:', e.message); return { ok: false, error: e.message }; }
});

// Attach an in-hand source document to a specific citation (uid). Extracts the doc's text (same
// machinery as import) → stores it against that citation → also lands it in the main DB as a source
// (established ingest protocol, fail-soft). Run checks then resolves this citation from it (rung 0).
ipcMain.handle('editor:attach-source', async (_e, { docId, uid, filePath } = {}) => {
  try {
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    if (!uid) return { ok: false, error: 'no citation uid' };
    const ex = await extractFileMarkdown(filePath);
    if (!ex.text || ex.text.trim().length < 40) return { ok: false, error: `couldn't extract readable text (${ex.via})` };
    const title = require('path').basename(filePath).replace(/\.[^.]+$/, '');
    const att = editorRegistry.saveAttachment(docId, doc.current_version, uid, { title, docRef: filePath, text: ex.text });
    // established ingest protocol: also land the source in the main DB for provenance (fail-soft).
    try { require('./lib/doc_store').land({ title, body: ex.text, source: 'editor_reference', ref: `attach:${docId}:${uid}` }); }
    catch (e) { console.error('[editor] attach land failed:', e.message); }
    console.log(`[editor] attached "${title}" to citation ${uid} of doc ${docId} via ${ex.via} (${ex.text.length}ch)`);
    return { ok: true, attachment: { uid, title: att.title, ref: att.doc_ref } };
  } catch (e) { console.error('[editor] attach-source failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('editor:detach-source', (_e, { docId, uid } = {}) => {
  try {
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    editorRegistry.deleteAttachment(docId, doc.current_version, uid);
    return { ok: true };
  } catch (e) { console.error('[editor] detach-source failed:', e.message); return { ok: false, error: e.message }; }
});

// Run checks → drives the DETERMINISTIC verification harness (studio/verify_harness via
// editor_checks.runHarnessChecks) over the doc's normalized working copy. One pathway:
// extract→resolve→match→preflight→classify→contract. Resolution + match are ~0-token; the model
// is reached only at the caged classify leaf (local 24B), behind the preflight homework-check gate.
// callTool reaches Echo's web tools (web_fetch/web_search/wayback/…); embed/cosine = local bge-small.
ipcMain.handle('editor:run-checks', async (_e, docId) => {
  try {
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    if (!echoSuit || !echoSuit.connected) { try { await echoSuit.connect(); } catch {} }
    if (!echoSuit || !echoSuit.connected) return { ok: false, error: 'Echo engine not connected' };
    const callTool = (n, a) => echoSuit.client().callTool(n, a);

    const workingCopy = editorRegistry.getWorkingCopy(docId, doc.current_version);
    if (!workingCopy || !Array.isArray(workingCopy.blocks)) return { ok: false, error: 'no working copy for this version' };

    // Classify leaf runs on the CLOUD FRONTIER (this verification judgment is too big for a local
    // model). Resolve the cloud endpoint+bearer from the inherited key; pick the cloud model from
    // the editor preference, else the engine's on-demand slot, else the operator's known good tag.
    const cloud = modelsLib.sources().find(s => s.tier === 'cloud' && s.token);
    const cloudModel = modelsLib.getModelFor('editor', null) || process.env.AGENT_MODEL_ON_DEMAND_BACKGROUND || 'gemma4:31b-cloud';
    const useCloud = !!cloud;
    if (!useCloud) console.warn('[editor] no cloud key — classify falling back to local', MODEL);

    // DEEP verify (FRONTIER-FIRST): this operator-invoked audit judges each material claim with the deep
    // agentic verifier (studio/verify_deepcheck) on the strongest reasoning tier — it reads the primary
    // sources, cross-checks an independent source, and reasons about precision. Default ON whenever the
    // cloud is reachable (env DEEP_VERIFY_MODEL overrides the tag); `mode:'quick'` opts back to the fast
    // local classify leaf. Without cloud it degrades to classify automatically.
    // Deep verify is the ONLY verification path — there is no "quick" mode; the operator always wants
    // frontier quality. On whenever the cloud is reachable; without cloud it auto-degrades to the local
    // classify leaf (a can't-reach-cloud fallback, not an operator choice).
    const deepModel = process.env.DEEP_VERIFY_MODEL || 'gpt-oss:120b-cloud';
    const useDeep = useCloud;
    if (useDeep) console.log(`[editor] deep verify — ${deepModel}`);
    else console.warn('[editor] deep verify unavailable (no cloud) — degrading to local classify');

    const res = await editorChecks.runHarnessChecks({
      callTool, workingCopy, complete, docId,
      sourceDocPath: doc.echo_doc_path || null, author: doc.author, sourceVersion: doc.current_version,
      classifyModelName: useCloud ? cloudModel : MODEL,
      classifyBase: useCloud ? cloud.base : null,
      classifyHeaders: useCloud ? { Authorization: `Bearer ${cloud.token}` } : null,
      deep: useDeep,                                  // route residue → deep agentic verifier
      deepModelName: useDeep ? deepModel : null,
      deepBase: useDeep ? cloud.base : null,
      deepHeaders: useDeep ? { Authorization: `Bearer ${cloud.token}` } : null,
      cheapModel: MODEL,                              // homework-check stays local/cheap (coherence gate)
      embed: memoryLib.embed, cosine: memoryLib.cosine,
      // fetch via Echo web_extract (clean text); SEARCH via Zoe's own DuckDuckGo provider so
      // no-URL claims resolve without an engine-side search-provider key. ATTACHMENTS (uid → in-hand
      // source text) let the resolve ladder's rung 0 resolve tagged citations from the operator's own
      // document instead of the web.
      resolveOpts: { tools: { fetch: 'web_extract' }, search: (q) => webSearch(q), attachments: editorRegistry.getAttachmentMap(docId, doc.current_version) },
      onStage: (name, payload) => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('editor:check-progress', { name, payload }); } catch {} },
    });
    return { ok: true, gate: res.gate, mapped: res.mapped };
  } catch (e) {
    console.error('[editor] run-checks failed:', e.message);
    return { ok: false, error: e.message };
  }
});

// Certify (B4) → issue a canonical CFC-numbered certificate from the last Run-checks result
// (passed in by the renderer; issuance never re-runs verification). Renders the standardized
// template, writes <projectData>/certs/<num>.html, logs the certificate + flips the doc to
// 'certified', and opens the cert for review.
ipcMain.handle('editor:certify', async (_e, { docId, mapped } = {}) => {
  try {
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    if (!mapped || !Array.isArray(mapped.findings)) return { ok: false, error: 'no verification result to certify — run checks first' };
    const latest = editorRegistry.latestCheckRun(docId);
    const res = editorCert.issueCertificate({
      docId, mapped, checkRunId: latest ? latest.id : null,
      certsDir: path.join(__dirname, 'data', 'certs'),
    });
    try { await shell.openPath(res.certDocRef); } catch (e) { console.error('[editor] open cert failed:', e.message); }
    return { ok: true, certNumber: res.certNumber, grade: res.grade, gradeLabel: res.gradeLabel, scoreline: res.scoreline, certDocRef: res.certDocRef };
  } catch (e) {
    console.error('[editor] certify failed:', e.message);
    return { ok: false, error: e.message };
  }
});

// Render self-contained HTML → a PDF file via an offscreen window (Electron printToPDF; fully local, no
// external dependency). Body padding provides the page margin, so printToPDF margins are 0 (no doubling).
async function htmlToPdfFile(html, pdfPath) {
  const fs = require('fs'), os = require('os');
  const tmpHtml = path.join(os.tmpdir(), `sq-report-${Date.now()}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  try {
    await win.loadFile(tmpHtml);
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'Letter', margins: { top: 0, bottom: 0, left: 0, right: 0 } });
    fs.writeFileSync(pdfPath, pdf);
  } finally {
    try { win.destroy(); } catch {}
    try { fs.unlinkSync(tmpHtml); } catch {}
  }
}

// Wrap a canvas document's rendered inner HTML (b-heading/b-paragraph/b-list/b-quote/b-code/b-table … the
// dark canvas classes carry no color of their own) in a clean, LIGHT, print-ready document — so a PDF/Word
// export reads like a real document, not a screenshot of the dark UI.
function buildExportDocHtml(title, inner) {
  const escT = String(title == null ? '' : title).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const css = `
    body{font-family:Georgia,'Times New Roman',serif;color:#1a1a1a;background:#fff;max-width:7.5in;margin:0 auto;padding:.6in;line-height:1.5;font-size:12pt;}
    h1,h2,h3,h4,h5,h6{font-family:'Helvetica Neue',Arial,sans-serif;color:#111;line-height:1.25;margin:1.05em 0 .4em;}
    h1{font-size:22pt;} h2{font-size:17pt;} h3{font-size:14pt;} h4{font-size:12.5pt;} h5{font-size:11.5pt;} h6{font-size:10.5pt;text-transform:uppercase;letter-spacing:.04em;color:#555;}
    .ex-title{border-bottom:2px solid #ddd;padding-bottom:.3em;}
    p{margin:.5em 0;} ul,ol{margin:.5em 0 .7em 1.6em;padding:0;} li{margin:.25em 0;}
    blockquote{margin:.7em 0;padding:.2em 1em;border-left:3px solid #ccc;color:#555;font-style:italic;}
    hr{border:none;border-top:1px solid #ddd;margin:1.2em 0;}
    pre{background:#f5f5f5;border:1px solid #e0e0e0;border-radius:5px;padding:.7em .9em;overflow-x:auto;font-family:Consolas,'SF Mono',monospace;font-size:10.5pt;}
    code{font-family:Consolas,'SF Mono',monospace;background:#f0f0f0;border-radius:3px;padding:.05em .35em;font-size:.9em;} pre code{background:none;padding:0;}
    table{border-collapse:collapse;width:100%;margin:.7em 0;font-size:10.5pt;} th,td{border:1px solid #ccc;padding:5px 9px;text-align:left;} th{background:#f2f2f2;}
    img{max-width:100%;} .tbl-tools,.chart-meta,.dl-menu{display:none;}
  `;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escT}</title><style>${css}</style></head><body>${inner || ''}</body></html>`;
}

// Export a canvas document to a real file the operator can keep: Markdown is done in the renderer (Blob);
// PDF (Electron printToPDF, no dep) and Word (.docx via html-to-docx) render the doc's HTML here, write to
// data/exports/, and open it. Renderer passes the already-sanitized display HTML + the title + a format.
ipcMain.handle('canvas:export-doc', async (_e, { title = 'Document', html = '', markdown = '', format = 'pdf' } = {}) => {
  try {
    const fs = require('fs');
    const exportsDir = path.join(__dirname, 'data', 'exports');
    try { fs.mkdirSync(exportsDir, { recursive: true }); } catch (e) { /* may exist */ }
    const safe = String(title || 'document').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'document';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    let outPath;
    if (format === 'pdf') {
      // PDF ← the rendered HTML wrapped in a clean light print stylesheet (Electron printToPDF, no dep).
      outPath = path.join(exportsDir, `${safe}-${stamp}.pdf`);
      await htmlToPdfFile(buildExportDocHtml(title, html), outPath);
    } else if (format === 'docx') {
      // Word ← built PROGRAMMATICALLY from the doc's markdown via the `docx` library (clean deps, no HTML parse).
      const buf = await require('./lib/md_to_docx').buildDocxBuffer({ title, markdown });
      outPath = path.join(exportsDir, `${safe}-${stamp}.docx`);
      fs.writeFileSync(outPath, buf);
    } else return { ok: false, error: `unsupported format: ${format}` };
    try { await shell.openPath(outPath); } catch (e) { console.error('[canvas] open export failed:', e.message); }
    console.log(`[canvas] exported "${title}" → ${outPath}`);
    return { ok: true, path: outPath };
  } catch (e) { console.error('[canvas] export failed:', e.message); return { ok: false, error: e.message }; }
});

// Export findings REPORT → the lightweight artifact handed back to the AUTHOR as a PDF: renders the last
// Run-checks findings (no CFC id, no seal, no status change — NOT a certification), converts to PDF, writes
// it to data/reports/, and opens it. Certification stays the separate formal step.
ipcMain.handle('editor:export-report', async (_e, { docId, mapped } = {}) => {
  try {
    const fs = require('fs');
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    if (!mapped || !Array.isArray(mapped.findings)) return { ok: false, error: 'no findings to report — run checks first' };
    const html = require('./studio/cert_template').renderReport({
      doc, findings: mapped.findings, suggestions: mapped.suggestions, summary: mapped.summary, generatedAt: Date.now(),
    });
    const reportsDir = path.join(__dirname, 'data', 'reports');
    try { fs.mkdirSync(reportsDir, { recursive: true }); } catch (e) { /* may already exist */ }
    const safe = String(doc.title || 'document').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'document';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const reportRef = path.join(reportsDir, `Findings-${safe}-v${doc.current_version}-${stamp}.pdf`);
    await htmlToPdfFile(html, reportRef);
    try { await shell.openPath(reportRef); } catch (e) { console.error('[editor] open report failed:', e.message); }
    return { ok: true, reportRef };
  } catch (e) {
    console.error('[editor] export-report failed:', e.message);
    return { ok: false, error: e.message };
  }
});

// Publish / close-out (lifecycle terminal) → records the doc as actually published, optionally
// attaching a public copy (URL or file). Forward-only: must be certified first.
ipcMain.handle('editor:publish', async (_e, { docId, publicCopyRef } = {}) => {
  try {
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    if (doc.status !== 'certified' && doc.status !== 'published') return { ok: false, error: 'document must be certified before publishing' };
    const updated = editorRegistry.closeOut(docId, { publicCopyRef: publicCopyRef || null });
    return { ok: true, status: updated.status, publicCopyRef: updated.public_copy_ref || null };
  } catch (e) {
    console.error('[editor] publish failed:', e.message);
    return { ok: false, error: e.message };
  }
});

// ============================ CREATOR (writing suite — Phase 3) ==============================
// Authoring surface on the SAME document substrate (editor_registry working copies + the light
// block model). The renderer is a THIN Tiptap host; the block ⇄ ProseMirror bridge runs HERE
// (studio/creator_view). Slice 1 = author + persist round-trip. The clinical assist panel
// (stats / corrections / DB source-flagging / fact-check sweeps) lands in later slices; the model
// stays caged as a background analysis component, never an orchestrator and never a chat partner.
ipcMain.handle('creator:list', (_e, opts = {}) => {
  try { return { ok: true, documents: editorRegistry.listDocuments({ sort: 'accessed', dir: 'desc', limit: 200, ...opts }) }; }
  catch (e) { console.error('[creator] list failed:', e.message); return { ok: false, error: e.message, documents: [] }; }
});

ipcMain.handle('creator:get', (_e, { docId } = {}) => {
  try {
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    editorRegistry.touchAccessed(docId);
    const wc = editorRegistry.getWorkingCopy(docId, doc.current_version);
    const blocks = (wc && Array.isArray(wc.blocks)) ? wc.blocks : [];
    return {
      ok: true,
      doc: { id: doc.id, title: doc.title, version: doc.current_version, status: doc.status, author: doc.author },
      docJson: creatorView.blocksToDoc(blocks),
    };
  } catch (e) { console.error('[creator] get failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('creator:new', (_e, { title } = {}) => {
  try {
    const wc = creatorView.emptyWorkingCopy(title || 'Untitled draft');
    const doc = editorRegistry.registerDocument({ title: wc.title, docType: 'native', source: 'native', changeSummary: 'created in Creator' });
    editorRegistry.saveWorkingCopy(doc.id, 1, wc);
    return { ok: true, doc: { id: doc.id, title: doc.title, version: doc.current_version, status: doc.status }, docJson: creatorView.blocksToDoc(wc.blocks) };
  } catch (e) { console.error('[creator] new failed:', e.message); return { ok: false, error: e.message }; }
});

// Background scan = the Creator's deterministic clinical analysis pipeline (renderer calls it
// debounced as you write). Slice 2 = document statistics only (no model). Later slices extend the
// returned object with corrections / DB source-flags / fact-check verdicts — same pathway, model
// caged at named leaves. Stateless: takes the editor's ProseMirror JSON, returns findings.
ipcMain.handle('creator:scan', (_e, { docJson } = {}) => {
  try {
    const blocks = creatorView.docToBlocks(docJson || { type: 'doc', content: [] });
    return { ok: true, stats: creatorStats.computeStats(blocks) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Proofread = the caged spelling/grammar/style leaf (local 24B). The model returns candidate
// corrections; creator_proofread validates + de-hallucinates them (every kept span must be real
// verbatim text). The OPERATOR accepts/rejects in the panel — the model never edits the document.
// onlyAnchors (optional) scopes the pass to changed blocks for background-incremental mode.
ipcMain.handle('creator:proofread', async (_e, { docJson, onlyAnchors } = {}) => {
  try {
    const blocks = creatorView.docToBlocks(docJson || { type: 'doc', content: [] });
    let prose = creatorProofread.proseBlocks(blocks);
    if (Array.isArray(onlyAnchors) && onlyAnchors.length) {
      const set = new Set(onlyAnchors);
      prose = prose.filter(b => set.has(b.anchor));
    }
    if (!prose.length) return { ok: true, corrections: [], anchors: [] };
    const messages = creatorProofread.buildMessages(prose);
    const text = await complete({ model: MODEL, messages, options: { temperature: 0, num_ctx: 8192 } });
    const corrections = creatorProofread.parseCorrections(text, creatorProofread.anchorTextMap(prose));
    return { ok: true, corrections, anchors: prose.map(b => b.anchor) };
  } catch (e) { console.error('[creator] proofread failed:', e.message); return { ok: false, error: e.message }; }
});

// RESEARCH & ASSIST = entity-centric (replaces per-sentence source-hunting). One deterministic
// pathway: detect entities (local) → DB match (search_entities, name-overlap gated) → complementary
// material (kg_neighborhood + corpus; web/academic for entities NOT in the DB, when `web` on). The
// model is NOT used here — this whole pass is retrieval. The cloud writing-advisor is a SEPARATE,
// opt-in leaf (creator:advise). Returns entities[] + a `context` blob the advisor grounds on.
const EXTERNAL_MAX = 8;   // bound external (web+academic) lookups per pass to keep latency sane
ipcMain.handle('creator:research', async (_e, { docJson, web = true } = {}) => {
  try {
    const blocks = creatorView.docToBlocks(docJson || { type: 'doc', content: [] });
    const mentions = creatorResearch.detectEntities(blocks);
    if (!mentions.length) return { ok: true, entities: [], context: '' };
    if (!echoSuit || !echoSuit.connected) { try { await echoSuit.connect(); } catch {} }
    if (!echoSuit || !echoSuit.connected) return { ok: false, error: 'Echo engine not connected' };
    const toolJson = require('./lib/echo').toolJson;
    const entities = [];
    const ctxLines = [];
    let externalUsed = 0;
    for (const ent of mentions) {
      // --- direct DB match (typed, name-overlap gated)
      let results = [];
      try {
        const d = toolJson(await echoSuit.client().callTool('search_entities', { query: ent.mention, top_k: 5 }));
        results = (d && (d.result || d)) || [];
        if (!Array.isArray(results)) results = [];
      } catch (e) { results = []; }
      const match = creatorResearch.classifyEntity(ent.mention, results);
      const entry = { mention: ent.mention, kind: ent.kind, matched: match.matched, candidates: match.candidates, related: [], external: null };
      if (match.matched) {
        // --- complementary internal: KG neighbors of the top candidate (best-effort)
        const top = match.candidates[0];
        if (top && top.id != null) {
          try {
            const nb = toolJson(await echoSuit.client().callTool('kg_neighborhood', { entity_id: top.id, top_k: 5 }));
            const neighbors = (nb && (nb.neighbors || (nb.result && nb.result.neighbors))) || [];
            entry.related = (Array.isArray(neighbors) ? neighbors : []).map(n => n && (n.name || n.title || n.label)).filter(Boolean).slice(0, 5);
          } catch (e) { /* neighbors are best-effort */ }
        }
        ctxLines.push(`- ${top.name}${top.subtype ? ` (${top.subtype})` : top.type ? ` (${top.type})` : ''}${top.summary ? ` — ${top.summary}` : ''}${entry.related.length ? `; related: ${entry.related.join(', ')}` : ''}`);
      } else if (web && externalUsed < EXTERNAL_MAX) {
        // --- complementary external: outside reading for an entity the DB doesn't have (web + academic)
        externalUsed++;
        const [webRows, acadRows] = await Promise.all([
          (async () => { try { const r = await webSearch(ent.mention); return (r && r.results) || []; } catch (e) { return []; } })(),
          (async () => { try { const d = toolJson(await echoSuit.client().callTool('academic_search', { query: ent.mention, top_k: 5 })); return (d && d.results) || []; } catch (e) { return []; } })(),
        ]);
        const ext = creatorSources.classifyExternal(webRows, acadRows);
        if (ext.status === 'found') {
          entry.external = { provenance: ext.provenance, title: ext.title, url: ext.url, snippet: ext.snippet, source: ext.source };
          ctxLines.push(`- ${ent.mention} [${ext.provenance}] — ${ext.title}${ext.snippet ? `: ${ext.snippet}` : ''}`);
        }
      }
      entities.push(entry);
    }
    // --- relevant documents in the operator's library: ONE corpus search on the draft's salient
    // terms → real material the advisor can ground "additions" in (titles + content snippets).
    try {
      const fullText = blocks.map(b => b && b.text).filter(Boolean).join(' ');
      const kw = creatorSources.keywords(fullText).slice(0, 2).join(' ');
      if (kw) {
        const d = toolJson(await echoSuit.client().callTool('search', { query: kw, top_k: 3 }));
        const docs = (d && (d.result || d)) || [];
        if (Array.isArray(docs) && docs.length) {
          ctxLines.push('Relevant documents in your library:');
          for (const doc of docs.slice(0, 3)) ctxLines.push(`- ${doc.title || '(untitled)'}: ${creatorSources.stripMarks(doc.snippet).slice(0, 200)}`);
        }
      }
    } catch (e) { /* library docs are best-effort */ }
    return { ok: true, entities, context: ctxLines.join('\n') };
  } catch (e) { console.error('[creator] research failed:', e.message); return { ok: false, error: e.message }; }
});

// Cloud WRITING ADVISOR (opt-in leaf) — the cloud model reads the draft + the research `context`
// and proposes additions / directional options / tone adjustments (fixed JSON shape; operator
// disposes). Caged: never edits the doc. Resolves the cloud endpoint+bearer from the inherited key
// (same pattern as editor:run-checks); falls back to the local model if no cloud key.
ipcMain.handle('creator:advise', async (_e, { docJson, context } = {}) => {
  try {
    const blocks = creatorView.docToBlocks(docJson || { type: 'doc', content: [] });
    const docText = blocks.map(b => b.text).filter(Boolean).join('\n\n');
    if (!docText.trim()) return { ok: true, advice: { additions: [], directions: [], tone: [] } };
    const cloud = modelsLib.sources().find(s => s.tier === 'cloud' && s.token);
    const cloudModel = modelsLib.getModelFor('editor', null) || process.env.AGENT_MODEL_ON_DEMAND_BACKGROUND || 'gemma4:31b-cloud';
    // per-call proof (no secret): which tier/model/endpoint the advisor used.
    console.log(`[creator] advise via ${cloud ? `CLOUD ${cloudModel} @ ${cloud.base}` : `LOCAL ${MODEL}`} (${docText.length} chars in)`);
    const messages = creatorResearch.buildAdvisorMessages(docText, context || '');
    const t0 = Date.now();
    const text = await complete({
      model: cloud ? cloudModel : MODEL, messages,
      base: cloud ? cloud.base : undefined,
      headers: cloud ? { Authorization: `Bearer ${cloud.token}` } : {},
      // DEEP CALL (cloud-leverage): the advisor reads the WHOLE draft + research context and writes rich
      // structured advice — a depth call, not a micro-classifier. On CLOUD, give it the fat window IN
      // (deepNumCtx, was a 1/16th 8192 → the draft got truncated) + room to write OUT (deepNumPredict, was
      // ollama's ~128 default → advice cut short). LOCAL fallback stays at 8192: the front 24B is pinned
      // there to stay warm, so fattening it would force a cold num_ctx reload for a mere fallback path.
      options: cloud
        ? { temperature: 0.3, num_ctx: config.deepNumCtx(), num_predict: config.deepNumPredict() }
        : { temperature: 0.3, num_ctx: 8192 },
    });
    console.log(`[creator] advise ← ${cloud ? 'CLOUD' : 'LOCAL'} ${Date.now() - t0}ms, ${text.length} chars out`);
    return { ok: true, advice: creatorResearch.parseAdvice(text), cloud: !!cloud };
  } catch (e) { console.error('[creator] advise failed:', e.message); return { ok: false, error: e.message }; }
});

// Open a flagged source in its native app (operator clicks "Open" on a source card). Resolve the
// doc's absolute path via get_document, then shell.openPath it.
ipcMain.handle('creator:open-source', async (_e, { docId } = {}) => {
  try {
    if (docId == null) return { ok: false, error: 'no document id' };
    if (!echoSuit || !echoSuit.connected) { try { await echoSuit.connect(); } catch {} }
    if (!echoSuit || !echoSuit.connected) return { ok: false, error: 'Echo engine not connected' };
    const toolJson = require('./lib/echo').toolJson;
    const data = toolJson(await echoSuit.client().callTool('get_document', { doc_id: Number(docId), depth: 'summary' }));
    const payload = (data && (data.result || data)) || {};
    const abs = payload.vault_source_abs_path || payload.abs_path || payload.source_path || payload.path;
    if (!abs) return { ok: false, error: 'no path for document' };
    const err = await shell.openPath(abs);                 // '' on success, message on failure
    return err ? { ok: false, error: err } : { ok: true, path: abs };
  } catch (e) { console.error('[creator] open-source failed:', e.message); return { ok: false, error: e.message }; }
});

// Open an external (web/academic) source in the default browser (operator clicks "Open"). http(s) only.
ipcMain.handle('creator:open-external', async (_e, { url } = {}) => {
  try {
    if (!url || !/^https?:\/\//i.test(String(url))) return { ok: false, error: 'invalid url' };
    await shell.openExternal(String(url));
    return { ok: true };
  } catch (e) { console.error('[creator] open-external failed:', e.message); return { ok: false, error: e.message }; }
});

// Save = overwrite the CURRENT version's working copy from the editor's ProseMirror JSON. This is
// the live edit buffer (saveWorkingCopy upserts per (doc,version)); deliberate version bumps /
// iterations are a later, explicit action — NOT one per autosave.
ipcMain.handle('creator:save', (_e, { docId, docJson } = {}) => {
  try {
    const doc = editorRegistry.getDocument(docId);
    if (!doc) return { ok: false, error: 'no such document' };
    const blocks = creatorView.docToBlocks(docJson || { type: 'doc', content: [] });
    const wc = { title: doc.title, format: 'native', blocks, blockCount: blocks.length, normalizedAt: Date.now() };
    editorRegistry.saveWorkingCopy(docId, doc.current_version, wc);
    editorRegistry.touchAccessed(docId);
    return { ok: true, blockCount: blocks.length, savedAt: Date.now() };
  } catch (e) { console.error('[creator] save failed:', e.message); return { ok: false, error: e.message }; }
});

// ============================ SUPER SEARCH (studio) ==========================================
// One deterministic pathway over the OWNED engine + cloud frontier: plan (local) → retrieve both
// lanes (the recipe registry, all over echoSuit callTool + Zoe's DDG search) → rerank (local) →
// cited overview (CLOUD) → gated ingest (save_source + persistent ledger). The model is caged at
// exactly the three leaves. Mirrors the editor's cloud-resolution + Zoe-search-injection pattern.
let superSearchLedger = null;
function getSuperSearchLedger() { if (!superSearchLedger) superSearchLedger = ssLedger.makeFileLedger(path.join(__dirname, 'data', 'super_search_ledger.json')); return superSearchLedger; }

function superSearchCloud() {
  const cloud = modelsLib.sources().find(s => s.tier === 'cloud' && s.token);
  const cloudModel = modelsLib.getModelFor('search', null) || process.env.AGENT_MODEL_ON_DEMAND_BACKGROUND || 'gemma4:31b-cloud';
  return { cloud, cloudModel };
}

ipcMain.handle('search:status', () => {
  const { cloud } = superSearchCloud();
  return { ok: true, engine: (echoSuit && echoSuit.connected) ? 'connected' : 'offline', cloud: !!cloud };
});

ipcMain.handle('search:run', async (_e, { query, opts } = {}) => {
  try {
    if (!query || !String(query).trim()) return { ok: false, error: 'empty query' };
    if (!echoSuit || !echoSuit.connected) { try { await echoSuit.connect(); } catch {} }
    if (!echoSuit || !echoSuit.connected) return { ok: false, error: 'Echo engine not connected' };
    // Super Search recipes expect the tool's DOMAIN payload ({result}/{results}/{rows}); the MCP
    // client returns the {content:[…]} envelope, so unwrap at the boundary via echo.toolJson.
    const toolJson = require('./lib/echo').toolJson;
    const callTool = async (n, a) => toolJson(await echoSuit.client().callTool(n, a));

    // plan + rerank on the LOCAL 24B; overview on the CLOUD frontier (inherited key).
    const { cloud, cloudModel } = superSearchCloud();
    const planner = ssModelIO.makePlanner({ complete, model: MODEL });
    const reranker = ssModelIO.makeReranker({ complete, model: MODEL });
    const overview = ssModelIO.makeOverview(cloud
      ? { complete, model: cloudModel, base: cloud.base, headers: { Authorization: `Bearer ${cloud.token}` } }
      : { complete, model: MODEL });   // graceful: no cloud key → overview on local
    const ingestor = ssIngest.makeIngestor({ callTool, ledger: getSuperSearchLedger() });

    const run = await ssRun.runSuperSearch(String(query), {
      // recipeDeps: engine tools for every recipe; SEARCH via Zoe's own DDG (engine web_search has
      // no provider key); web body-enrich uses engine web_extract through callTool.
      recipeDeps: { callTool, search: (q) => webSearch(q) },
      planner, reranker, overview, ingestor,
      ingestMode: (opts && opts.ingestMode) || 'cited',
    });
    return { ok: true, run };
  } catch (e) {
    console.error('[super-search] run failed:', e.message);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('search:revert', async (_e, { id } = {}) => {
  try {
    const toolJson = require('./lib/echo').toolJson;
    const callTool = async (n, a) => toolJson(await echoSuit.client().callTool(n, a));
    const ingestor = ssIngest.makeIngestor({ callTool, ledger: getSuperSearchLedger() });
    const r = await ingestor.revert(id);
    return { ok: r.reverted, ...r };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ============================ POLLING (studio — data browser) ================================
// Read-only surface over the engine's polling tools. main unwraps the MCP envelope and maps each
// payload to the standardized view shape (studio/poll_view.js); the renderer just draws. No model.
function pollCallTool() {
  const toolJson = require('./lib/echo').toolJson;
  return async (n, a) => toolJson(await echoSuit.client().callTool(n, a));
}
async function ensureEngine() {
  if (!echoSuit || !echoSuit.connected) { try { await echoSuit.connect(); } catch {} }
  return !!(echoSuit && echoSuit.connected);
}

ipcMain.handle('poll:list', async (_e, opts = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('list_pollings', {
      source_kind: opts.source_kind || null, topic: opts.topic || null, year: opts.year || null, vendor: opts.vendor || null, frame: opts.frame || null,
    });
    return { ok: true, items: pollView.fieldingList(payload) };
  } catch (e) { console.error('[poll] list failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('poll:get', async (_e, { fieldingId } = {}) => {
  try {
    if (!fieldingId) return { ok: false, error: 'no fielding id' };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('get_poll', { fielding_id: fieldingId, include_questions: true });
    return { ok: true, view: pollView.pollView(payload) };
  } catch (e) { console.error('[poll] get failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('poll:question', async (_e, { questionId } = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('get_poll_question', { question_id: Number(questionId) });
    return { ok: true, question: payload, bars: pollView.toplineBars(payload || {}) };
  } catch (e) { console.error('[poll] question failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('poll:issues', async () => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('list_poll_issues', { open_only: true, limit: 200 });
    const rows = (Array.isArray(payload) ? payload : (payload && payload.result) || []).map(pollView.issueRow);
    return { ok: true, rows };
  } catch (e) { console.error('[poll] issues failed:', e.message); return { ok: false, error: e.message }; }
});

// ============================ CRM / ROLODEX (studio — data browser) ==========================
// Read-only surface over the engine's contact tools. main unwraps the MCP envelope and maps each
// payload to the standardized view shape (studio/crm_view.js); the renderer draws. No model.
ipcMain.handle('crm:facets', async (_e, filters = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('contact_facets', {
      state: filters.state || null, party: filters.party || null, chamber: filters.chamber || null, tier: filters.tier || null,
    });
    return { ok: true, groups: crmView.facetGroups(payload) };
  } catch (e) { console.error('[crm] facets failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('crm:browse', async (_e, filters = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('list_contacts_compact', {
      state: filters.state || null, party: filters.party || null, chamber: filters.chamber || null, tier: filters.tier || null,
    });
    return { ok: true, list: crmView.browseList(payload) };
  } catch (e) { console.error('[crm] browse failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('crm:search', async (_e, { query, filters } = {}) => {
  try {
    if (!query || !String(query).trim()) return { ok: false, error: 'empty query' };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('search_contacts', { query: String(query), state: (filters && filters.state) || null, tier: (filters && filters.tier) || null, top_k: 50 });
    return { ok: true, list: crmView.searchList(payload) };
  } catch (e) { console.error('[crm] search failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('crm:page', async (_e, { cursor } = {}) => {
  try {
    if (!cursor) return { ok: false, error: 'no cursor' };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('list_contacts_page', { cursor, limit: 100 });
    return { ok: true, page: crmView.pageRows(payload) };
  } catch (e) { console.error('[crm] page failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('crm:get', async (_e, { contactId } = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('get_contact', { contact_id: Number(contactId), include_related: true });
    return { ok: true, card: crmView.contactCard(payload) };
  } catch (e) { console.error('[crm] get failed:', e.message); return { ok: false, error: e.message }; }
});

// ============================ CALENDAR (studio — Google Calendar surface) ====================
// Near-1:1 Google Calendar as a Data surface. Auth is brought forward from Echo: lib/gcal shells to
// Echo's venv get_credentials() for a live access token (the operator's grant), then calls Calendar
// v3 REST directly. Reads land first (Slice 1); writes are operator-initiated (later slices). main
// maps payloads to view shapes via studio/calendar_view; the renderer draws. The token is in-memory
// only — never written or logged. Identity: this is the OPERATOR'S calendar (his Google account).
function gcalOpts() { return echoVenv || {}; }

ipcMain.handle('calendar:auth-status', async () => {
  try {
    // Prefer Echo's own status route (gives email + scopes); fall back to a token probe.
    if (echoHttp && echoHttp.base) {
      const headers = { Accept: 'application/json' };
      if (echoHttp.token) headers.Authorization = `Bearer ${echoHttp.token}`;
      const res = await fetch(`${echoHttp.base}/saga/google/auth/status`, { headers });
      if (res && res.ok) { const s = await res.json(); return { ok: true, connected: !!s.connected, email: s.email || null, scopes: s.scopes || [] }; }
    }
    return { ok: true, connected: gcal.isConnected(gcalOpts()), email: null, scopes: [] };
  } catch (e) { return { ok: false, error: e.message, connected: false }; }
});

// Kick Echo's one-time OAuth consent flow (opens the operator's browser; blocks ≤300s server-side).
ipcMain.handle('calendar:connect', async () => {
  try {
    if (!echoHttp || !echoHttp.base) return { ok: false, error: 'engine HTTP unavailable' };
    const headers = { Accept: 'application/json' };
    if (echoHttp.token) headers.Authorization = `Bearer ${echoHttp.token}`;
    const res = await fetch(`${echoHttp.base}/saga/google/auth/start`, { method: 'POST', headers });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.ok === false) return { ok: false, error: (body && body.error) || `connect failed (${res.status})` };
    gcal.getToken({ ...gcalOpts(), force: true });   // warm the in-mem token cache post-connect
    return { ok: true, email: body.email || null, scopes: body.scopes || [] };
  } catch (e) { console.error('[calendar] connect failed:', e.message); return { ok: false, error: e.message }; }
});

// Calendar list + color palette together (the surface keeps both; events reuse the colors).
ipcMain.handle('calendar:list-calendars', async () => {
  try {
    const calsRaw = await gcal.listCalendars(gcalOpts());
    let colorsRaw = null;
    try { colorsRaw = await gcal.colors(gcalOpts()); } catch { /* colors are optional */ }
    return { ok: true, calendars: calendarView.normalizeCalendarList(calsRaw), colors: calendarView.colorMap(colorsRaw) };
  } catch (e) { console.error('[calendar] list-calendars failed:', e.message); return { ok: false, error: e.message }; }
});

// Events across the selected calendars within [timeMin, timeMax]. `calendars` = [{id,color}]; we
// fetch each in parallel, inject the calendar color, merge + sort. Per-calendar failures are
// collected (errors[]) without sinking the whole request.
ipcMain.handle('calendar:events', async (_e, { calendars = [], timeMin, timeMax } = {}) => {
  try {
    if (!Array.isArray(calendars) || !calendars.length) return { ok: true, events: [], errors: [] };
    if (!gcal.isConnected(gcalOpts())) return { ok: false, error: 'Google not connected' };
    const errors = [];
    const lists = await Promise.all(calendars.map(async (c) => {
      try {
        const raw = await gcal.listEvents({ calendarId: c.id, timeMin, timeMax, maxResults: 2500 }, gcalOpts());
        return calendarView.normalizeEventList(raw, { calendarId: c.id, calColor: c.color || '' }).events;
      } catch (err) { errors.push({ calendarId: c.id, error: err.message }); return []; }
    }));
    const events = lists.flat().sort((a, b) => a.startMs - b.startMs || a.summary.localeCompare(b.summary));
    return { ok: true, events, errors };
  } catch (e) { console.error('[calendar] events failed:', e.message); return { ok: false, error: e.message }; }
});

// Event writes — OPERATOR-INITIATED only (their own workbench, their own calendar). `form` is the
// editor-form shape; calendar_view.toGoogleEvent builds the validated Calendar v3 body. NEVER auto.
ipcMain.handle('calendar:create-event', async (_e, { calendarId, form } = {}) => {
  try {
    if (!calendarId || !form) return { ok: false, error: 'calendar + form required' };
    if (!gcal.isConnected(gcalOpts())) return { ok: false, error: 'Google not connected' };
    const body = calendarView.toGoogleEvent(form, { timeZone: form.timeZone });
    const created = await gcal.createEvent(calendarId, body, gcalOpts());
    return { ok: true, id: created.id };
  } catch (e) { console.error('[calendar] create failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('calendar:update-event', async (_e, { calendarId, eventId, form } = {}) => {
  try {
    if (!calendarId || !eventId || !form) return { ok: false, error: 'calendar + event + form required' };
    if (!gcal.isConnected(gcalOpts())) return { ok: false, error: 'Google not connected' };
    const body = calendarView.toGoogleEvent(form, { timeZone: form.timeZone });
    const updated = await gcal.updateEvent(calendarId, eventId, body, gcalOpts());
    return { ok: true, id: updated.id };
  } catch (e) { console.error('[calendar] update failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('calendar:delete-event', async (_e, { calendarId, eventId } = {}) => {
  try {
    if (!calendarId || !eventId) return { ok: false, error: 'calendar + event required' };
    if (!gcal.isConnected(gcalOpts())) return { ok: false, error: 'Google not connected' };
    await gcal.deleteEvent(calendarId, eventId, gcalOpts());
    return { ok: true };
  } catch (e) { console.error('[calendar] delete failed:', e.message); return { ok: false, error: e.message }; }
});

// ============================ CANVAS (studio — saga canvas renderer) =========================
// Render Zoe's LIVE canvas. CRITICAL: the canvas lives IN-MEMORY in the engine (canvas_publisher
// _TABS/_BLOCKS + websocket fan-out); the engine serves it over GET /canvas (full snapshot). The
// tenant_rainey.canvas_blocks SQLite table is ONLY written by TENANT processes — Saga's MAIN engine
// (what we run) keeps canvas state in-memory, so db_query would never see live blocks. We read the
// snapshot over HTTP (same engine canvasEmit writes to → consistent) and map via canvas_view. No model.
async function canvasSnapshot() {
  if (!echoHttp || !echoHttp.base) return null;
  const headers = { Accept: 'application/json' };
  if (echoHttp.token) headers.Authorization = `Bearer ${echoHttp.token}`;
  // Degrade QUIETLY instead of throwing: the renderer's 5s canvas poll (canvas.js:877) would otherwise log a
  // '[canvas] get-all failed' every tick during any TRANSIENT engine window (restart, MCP reconnect/backoff,
  // a brief non-2xx). Timeout so a hung socket can't wedge the poll; return null on any not-ok/unreachable so
  // callers surface "Waiting for the engine…" and retry on the next poll. (2026-07-15: the recurring "canvas
  // fetch error" — endpoint verified healthy; the noise was throw-on-any-non-ok + no timeout + no backoff.)
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 4000);
  try {
    const res = await fetch(`${echoHttp.base}/canvas`, { headers, signal: ctrl.signal });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('canvas:list-tabs', async (_e, opts = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const snap = await canvasSnapshot();
    if (!snap) return { ok: false, error: 'canvas snapshot unavailable' };
    let tabs = (Array.isArray(snap.tabs) ? snap.tabs : []).map(canvasView.normalizeTab);
    if (opts && opts.openOnly) tabs = tabs.filter(t => t.open);
    tabs.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));   // newest first
    return { ok: true, tabs };
  } catch (e) { console.error('[canvas] list-tabs failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('canvas:get-tab', async (_e, { tabKey } = {}) => {
  try {
    if (!tabKey) return { ok: false, error: 'no tab key' };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const snap = await canvasSnapshot();
    if (!snap) return { ok: false, error: 'canvas snapshot unavailable' };
    const tabRow = (Array.isArray(snap.tabs) ? snap.tabs : []).find(t => (t.tab_key || t.key) === tabKey);
    if (!tabRow) return { ok: false, error: 'tab not found' };
    const blocks = (snap.blocks_by_tab && Array.isArray(snap.blocks_by_tab[tabKey])) ? snap.blocks_by_tab[tabKey] : [];
    return { ok: true, tab: canvasView.normalizeTab(tabRow), stream: canvasView.normalizeStream(blocks) };
  } catch (e) { console.error('[canvas] get-tab failed:', e.message); return { ok: false, error: e.message }; }
});

// Whole canvas in one shot: every tab as a DOCUMENT (normalized block stream) + its board position.
// The movable object on the canvas is the DOCUMENT (a tab), with its blocks flowing inside it.
// Operator-saved coords win; un-positioned docs get a deterministic auto-slot. One /canvas fetch.
ipcMain.handle('canvas:get-all', async () => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const snap = await canvasSnapshot();
    if (!snap) return { ok: false, error: 'canvas snapshot unavailable' };
    const tabs = (Array.isArray(snap.tabs) ? snap.tabs : []).map(canvasView.normalizeTab);
    let state = {}; try { state = canvasLayoutStore.getPositions(); } catch {}
    const placed = canvasLayout.autoPlace(tabs.map(t => t.key), state);
    const posBy = {}; for (const p of placed) posBy[p.blockId] = p;   // autoPlace's id field == the tab key here
    const bb = snap.blocks_by_tab || {};
    const docs = tabs.map(t => {
      const s = state[t.key] || {};
      return {
        tab: t,
        stream: canvasView.normalizeStream(Array.isArray(bb[t.key]) ? bb[t.key] : []),
        pos: posBy[t.key] || { x: 48, y: 48 },
        w: s.w || null, h: s.h || null, hidden: !!s.hidden, minimized: !!s.minimized,
      };
    });
    return { ok: true, docs };
  } catch (e) { console.error('[canvas] get-all failed:', e.message); return { ok: false, error: e.message }; }
});

// Freeform board — persist a drag (operator moves a DOCUMENT) + reset arrangement (one doc or all).
ipcMain.handle('canvas:set-doc-pos', async (_e, { tabKey, x, y } = {}) => {
  try {
    if (!tabKey) return { ok: false, error: 'tabKey required' };
    return { ok: true, pos: canvasLayoutStore.setPosition(tabKey, x, y) };
  } catch (e) { console.error('[canvas] set-doc-pos failed:', e.message); return { ok: false, error: e.message }; }
});

// Merge a UI-state patch for a document: size {w,h}, {hidden}, {minimized}, or position.
ipcMain.handle('canvas:update-doc', async (_e, { tabKey, patch } = {}) => {
  try {
    if (!tabKey) return { ok: false, error: 'tabKey required' };
    return { ok: true, state: canvasLayoutStore.update(tabKey, patch || {}) };
  } catch (e) { console.error('[canvas] update-doc failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('canvas:reset-layout', async (_e, { tabKey } = {}) => {
  try { return { ok: true, cleared: canvasLayoutStore.clear(tabKey || undefined) }; }
  catch (e) { console.error('[canvas] reset-layout failed:', e.message); return { ok: false, error: e.message }; }
});

// Drag-and-drop a file onto the canvas → a DOCUMENT object. Reuses the suite's existing extractor
// (lib/doc_extract: .docx via mammoth, .pdf via pdfjs, .md/.txt direct) with a utf8 fallback for
// other text types, then opens a DOC tab with the content and positions it at the drop point. These
// dropped docs live in the engine's in-memory canvas (ephemeral) — ideal for quick test population.
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
ipcMain.handle('canvas:drop-doc', async (_e, { path: filePath, x, y } = {}) => {
  try {
    if (!filePath) return { ok: false, error: 'no file path' };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const fs = require('fs');
    const ext = path.extname(filePath).replace(/^\./, '').toLowerCase();
    const baseName = path.basename(filePath).replace(/\.[^.]+$/, '');
    let mode = 'DOC', blockType = 'paragraph', data = null, title = baseName.slice(0, 120) || 'document';

    if (IMG_MIME[ext]) {                                   // IMAGE → render as an actual image
      const b64 = fs.readFileSync(filePath).toString('base64');
      // `src` = inline data URI (the picture renders); `file` = the real path so the ingest poller
      // re-reads it via file_ingest → VISION OCR → surfaceDocCards → cards (a data URI can't be re-read).
      data = { src: `data:${IMG_MIME[ext]};base64,${b64}`, alt: baseName, file: 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '') };
      blockType = 'image'; mode = 'ILLUSTRATIVE';
    } else if (ext === 'pdf') {                            // PDF → embed the REAL document (Chromium PDF viewer)
      data = { src: 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, ''), alt: baseName };
      blockType = 'document_file';                          // 'pdf' is not a valid engine block type
    } else if (ext === 'csv' || ext === 'tsv') {           // SPREADSHEET (delimited) → table
      const tbl = require('./studio/sheet_view').csvToTable(fs.readFileSync(filePath, 'utf8'), ext === 'tsv' ? '\t' : ',');
      // src = the on-disk file → the ingest poller re-reads the FULL sheet (not the truncated display rows)
      // via file_ingest → doc_extract.extractSpreadsheet → markdown table → surfaceDocCards → cards.
      data = { headers: tbl.headers, rows: tbl.rows, caption: tbl.truncated ? `+${tbl.truncated} more rows` : null, src: 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '') };
      blockType = 'table';
    } else if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') {   // EXCEL → table (first sheet)
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.worksheets[0];
      const rows = [];
      if (ws) ws.eachRow((r) => rows.push((r.values || []).slice(1).map(v => (v == null ? '' : (typeof v === 'object' ? (v.text || v.result || v.hyperlink || JSON.stringify(v)) : v)))));
      const tbl = require('./studio/sheet_view').toTable(rows);
      data = { headers: tbl.headers, rows: tbl.rows, caption: ws ? `${ws.name}${tbl.truncated ? ` · +${tbl.truncated} more rows` : ''}` : null, src: 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '') };
      blockType = 'table';
    } else if (ext === 'docx') {                           // WORD → rich HTML (tables, emphasis, inline images)
      try { const r = await require('./lib/doc_extract').extractDocxHtml(filePath); if (r && r.html && r.html.trim()) { data = { html: r.html }; blockType = 'document_file'; } } catch {}
      if (!data) {                                         // fallback: flattened markdown as a paragraph
        let markdown = ''; try { markdown = (await require('./lib/doc_extract').extractDocx(filePath)).markdown || ''; } catch {}
        if (!markdown.trim()) return { ok: false, error: 'empty / unreadable .docx' };
        data = { markdown, src: 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '') };   // full; rendered in progressive chunks below
      }
    } else {                                               // DOCUMENT (md/txt/code/pdf-text-fallback/…) → markdown
      let markdown = '';
      try { markdown = (await require('./lib/doc_extract').extractToMarkdown(filePath)).markdown || ''; }
      catch (e) { try { markdown = fs.readFileSync(filePath, 'utf8'); } catch { return { ok: false, error: `could not read ${path.basename(filePath)}: ${e.message}` }; } }
      if (!markdown.trim()) return { ok: false, error: 'empty / unreadable document' };
      const firstH = markdown.split(/\r?\n/).map(l => l.trim()).find(l => /^#{1,6}\s+\S/.test(l));
      if (firstH) title = firstH.replace(/^#{1,6}\s+/, '').slice(0, 120);
      data = { markdown, src: 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, '') };   // full; rendered in progressive chunks below
    }

    const tabKey = `drop-${path.basename(filePath).replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-${Date.now().toString(36)}`;
    const callTool = pollCallTool();
    await callTool('saga_canvas_open_tab', { mode, tab_key: tabKey, title });
    const PREVIEW_CHUNK = 40000;   // a large text doc renders one chunk at a time from the top so it never hangs
    if (blockType === 'paragraph' && data && typeof data.markdown === 'string' && data.markdown.length > PREVIEW_CHUNK) {
      // RECURSIVE BUILD (Lucas): split on line boundaries and add the FIRST chunk now (instant top-of-doc
      // preview), then stream the rest as blocks — the tab builds up as each finishes. Ingest is decoupled:
      // the poller re-reads the whole file via `src`, so background extraction stays full regardless.
      const parts = require('./lib/contact_extract').chunkForExtraction(data.markdown, { size: PREVIEW_CHUNK }).chunks;
      await callTool('saga_canvas_add_block', { tab_key: tabKey, block_type: 'paragraph', data: { markdown: parts[0], src: data.src } });
      (async () => {
        for (let i = 1; i < parts.length; i++) {
          try { await callTool('saga_canvas_add_block', { tab_key: tabKey, block_type: 'paragraph', data: { markdown: parts[i] } }); } catch (e) {}
          await new Promise(res => setTimeout(res, 80));   // yield so each chunk paints before the next
        }
        console.log(`[canvas] "${title}" built in ${parts.length} progressive chunks`);
      })().catch(() => {});
    } else {
      await callTool('saga_canvas_add_block', { tab_key: tabKey, block_type: blockType, data });
    }
    try { canvasLayoutStore.setPosition(tabKey, x, y); } catch {}
    return { ok: true, tabKey, title };
  } catch (e) { console.error('[canvas] drop-doc failed:', e.message); return { ok: false, error: e.message }; }
});

// ZOE CANVAS DRIVE (Slice 2) — the orchestrator's SINGLE seam for writing a professional-register
// block to Zoe's saga canvas (write path A: Side Quest calls saga_canvas_* directly through the Echo
// suit). Determinism law: content here is produced upstream by caged cloud leaves (organize/condense
// reasoner); Dans NEVER writes a block. Tab key is deterministic per focus so re-opens are idempotent
// and the tab re-attaches after a restart. Fully fail-safe: a canvas error never breaks the research
// loop (the deliverable FILES remain the durable artifact; the canvas is the live render).
const _canvasTabsOpened = new Set();
async function canvasEmit({ focusId, title, tabMode, blockType, data }) {
  try {
    if (!blockType) return false;
    if (!(await ensureEngine())) return false;
    const ce = require('./studio/canvas_emit');
    const callTool = pollCallTool();
    const tabKey = ce.tabKeyForFocus(focusId);
    if (!_canvasTabsOpened.has(tabKey)) {
      await callTool('saga_canvas_open_tab', { mode: ce.mode(tabMode || 'RESEARCH'), tab_key: tabKey, title: ce.tabTitleForGoal(title) });
      _canvasTabsOpened.add(tabKey);
    }
    await callTool('saga_canvas_add_block', { tab_key: tabKey, block_type: blockType, data: data || {} });
    return true;
  } catch (e) { console.error('[canvas] emit failed:', e.message); return false; }
}

// Live-GROW a SINGLE canvas block in place (the "building-project document" that fleshes out as work
// runs): pre-assign a stable block_id, add it once, then saga_canvas_update_block(patch) on each refresh.
// _canvasBlocks tracks the ids created this session (reset on reboot — a re-add is harmless).
const _canvasBlocks = new Set();
async function canvasUpsertBlock({ focusId, blockId, title, tabMode = 'DOC', blockType = 'paragraph', data }) {
  try {
    if (!blockId || !(await ensureEngine())) return false;
    const ce = require('./studio/canvas_emit');
    const callTool = pollCallTool();
    const tabKey = ce.tabKeyForFocus(focusId);
    if (!_canvasTabsOpened.has(tabKey)) {
      await callTool('saga_canvas_open_tab', { mode: ce.mode(tabMode), tab_key: tabKey, title: ce.tabTitleForGoal(title) });
      _canvasTabsOpened.add(tabKey);
    }
    if (_canvasBlocks.has(blockId)) {
      await callTool('saga_canvas_update_block', { tab_key: tabKey, block_id: blockId, patch: data || {} });
    } else {
      await callTool('saga_canvas_add_block', { tab_key: tabKey, block_type: blockType, data: data || {}, block_id: blockId });
      _canvasBlocks.add(blockId);
    }
    return true;
  } catch (e) { console.error('[canvas] upsert failed:', e.message); return false; }
}

// CANVAS DURABILITY — the engine canvas is IN-MEMORY, so an engine/app restart WIPES a run's blocks even
// though the deliverable FILE persists. On the first tick of a run in this process, RE-EMIT its blocks from
// the durable file (covered-org sections) + the in-progress target's draft, so a restart no longer blanks
// the canvas. Idempotent block_ids match the live-grow scheme, so this refills the same blocks. Once/run.
const _canvasRehydrated = new Set();
function _secBlockId(focusId, name) { return `sec-${focusId}-${String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`; }
// Emit each `## Heading` section of a deliverable body as its own idempotent canvas block (same ids the
// live-grow uses, so this REFILLS the same blocks rather than duplicating).
async function emitDeliverableSections(focusId, goal, body) {
  let n = 0;
  for (const sec of String(body || '').split(/\n(?=##\s)/)) {
    const m = sec.trim().match(/^##\s+(.+)/); if (!m) continue;
    try { await canvasUpsertBlock({ focusId, blockId: _secBlockId(focusId, m[1].trim()), title: goal, tabMode: 'RESEARCH', blockType: 'paragraph', data: { markdown: sec.trim() } }); n++; } catch {}
  }
  return n;
}
async function rehydrateCanvasFromDeliverable(focus, file, target) {
  if (!focus || _canvasRehydrated.has(focus.id)) return;
  _canvasRehydrated.add(focus.id);
  try {
    if (!(await ensureEngine())) return;
    const goal = String(focus.content || '');
    let body = ''; try { const r = filesLib.fileReadFull(file); body = (r && r.text) || ''; } catch {}
    let n = await emitDeliverableSections(focus.id, goal, body);
    if (target && target.name && target.raw) {
      const cleaned = String(target.raw).replace(/^PRIOR KNOWLEDGE[\s\S]*?(?:\n\n|$)/, '').replace(/^\s*(TARGET|FACET):.*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
      if (cleaned) { try { await canvasUpsertBlock({ focusId: focus.id, blockId: _secBlockId(focus.id, target.name), title: goal, tabMode: 'RESEARCH', blockType: 'paragraph', data: { markdown: `## ${target.name}\n\n${cleaned.slice(0, 8000)}` } }); n++; } catch {} }
    }
    if (n) console.log(`[directed] #${focus.id} canvas rehydrated after restart (${n} block(s))`);
  } catch (e) { console.error('[directed] canvas rehydrate failed:', e.message); }
}
// BOOT durability — re-emit recent COMPLETED deliverables to the canvas after a restart (an active run
// self-rehydrates on its next tick, but a finished run has no tick, so its blocks would stay wiped).
async function rehydrateRecentCanvasDeliverables(limit = 6) {
  try {
    if (!(await ensureEngine())) return;
    const fsx = require('fs'); const p = require('path');
    const dir = p.join(__dirname, 'data', 'zoe_workspace', 'notes');
    let files = [];
    try { files = fsx.readdirSync(dir).filter(f => /^directed-\d+\.md$/.test(f)).map(f => ({ f, m: fsx.statSync(p.join(dir, f)).mtimeMs })).sort((a, b) => b.m - a.m).slice(0, limit); } catch { return; }
    for (const { f } of files) {
      const id = Number((f.match(/directed-(\d+)\.md/) || [])[1]); if (!id || _canvasRehydrated.has(id)) continue;
      let body = ''; try { body = fsx.readFileSync(p.join(dir, f), 'utf8'); } catch {}
      if (!body || body.length < 40) continue;
      const goal = ((body.match(/\*\*Task:\*\*\s*(.+)/) || [])[1] || 'Directed research').trim();
      _canvasRehydrated.add(id);
      await emitDeliverableSections(id, goal, body);
    }
    if (files.length) console.log(`[canvas] re-emitted ${files.length} recent deliverable(s) on boot`);
  } catch (e) { console.error('[canvas] boot rehydrate failed:', e.message); }
}

// SCRIBE HEARTBEAT (the meeting-scribe LANE on its OWN cadence — handoff item 1). While a canvas meeting
// is live, tick the scribe (own model) + LIVE-GROW the notes on the canvas (the building-project document
// fleshing out as the meeting runs). When the meeting ends (gmeet stage done/none), finalize → land the
// completed notes + companion transcript into the short-term store (meeting_lane) → emit the final doc →
// stop. Truly parallel to her actor (gmeet), never serialized with the idle tick.
let scribeTimer = null;
const SCRIBE_TICK_MS = 20 * 1000;
function startScribeHeartbeat() {
  if (scribeTimer) return;
  scribeTimer = setInterval(() => { scribeHeartbeatTick().catch(() => {}); }, SCRIBE_TICK_MS);
  setTimeout(() => { scribeHeartbeatTick().catch(() => {}); }, 4000);
  console.log('[scribe] heartbeat started (own cadence, every 20s)');
}
function stopScribeHeartbeat() {
  if (scribeTimer) { clearInterval(scribeTimer); scribeTimer = null; console.log('[scribe] heartbeat stopped'); }
}
async function emitMeetingNotes(content, { final = false } = {}) {
  const text = String(content || '').trim();
  if (!text) return;
  const startedAt = parseInt(db.getMeta('gmeet_started_at') || '0', 10) || 0;
  const title = require('./lib/meeting_lane').meetingTitle({ url: db.getMeta('gmeet_url') || '' });
  const md = `# ${title}${final ? ' (final)' : ' — live'}\n\n${text}`;
  await canvasUpsertBlock({ focusId: `meeting-${startedAt}`, blockId: `meetnotes-${startedAt}`, title, tabMode: 'DOC', blockType: 'paragraph', data: { markdown: md } });
}
async function scribeHeartbeatTick() {
  const scribe = require('./lib/meeting_scribe');
  const gmeet = require('./lib/gmeet');
  if (gmeet.active()) {
    let r = null; try { r = await scribe.tick(); } catch (e) { console.error('[scribe] tick failed:', e.message); }
    if (r && r.updated) { try { await emitMeetingNotes(scribe.minutes(), { final: false }); } catch {} }
    // MEETING CARDS (Slice B): surface a card for every person / place / event NAMED in the fresh transcript
    // (our own cursor, independent of the scribe's) — "in a meeting with Russ and Traci, their cards pop up".
    try {
      const cur = parseInt(db.getMeta('cards_cursor') || db.getMeta('gmeet_started_at') || '0', 10) || 0;
      const rows = db.getTranscriptSince(cur, 400) || [];
      if (rows.length) {
        const fresh = rows.map(t => `${t.speaker ? t.speaker + ': ' : ''}${t.text}`).join('\n');
        db.setMeta('cards_cursor', String(rows[rows.length - 1].ts + 1));
        surfaceMeetingMentions(fresh).catch(() => {});
      }
    } catch (e) {}
    return;
  }
  // meeting ended — finalize + land + final canvas emit (once), then stop the lane
  if (scribe.hasPending()) {
    const minutes = (() => { try { return scribe.minutes(); } catch { return ''; } })();
    let recap = ''; try { recap = await scribe.finalize(); } catch (e) { console.error('[scribe] finalize failed:', e.message); }
    if (recap) { try { const rr = db.insertMonologue({ content: `Meeting record (scribe):\n${recap}`, model: 'scribe', type: 'reading' }); if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: rr.id, ts: rr.ts, content: '(scribe) meeting record', type: 'reading' }); } catch {} }
    // Stop the Echo meeting-audio capture (if it was running) → its diarized transcript becomes the
    // authoritative companion (else the caption transcript stands in). Fail-safe.
    let audioTranscript = '';
    try { const a = await require('./lib/meeting_audio').stop({ dispatch: (t) => echoSuit.dispatch(t) }); if (a && a.ok && a.transcript) { audioTranscript = a.transcript; console.log(`[meet-audio] diarized transcript: ${a.segments.length} segments`); } } catch (e) { console.error('[meet-audio] stop failed:', e.message); }
    let _notesId = null;
    try { const ml = require('./lib/meeting_lane').land({ minutes, recap, audioTranscript }); if (ml.landed) { _notesId = ml.notesId; console.log(`[meeting] notes${ml.hasTranscript ? ` + companion transcript (${audioTranscript ? 'audio' : 'captions'})` : ''} landed in short-term store (doc ${ml.notesId}${ml.transcriptId ? `, transcript ${ml.transcriptId}` : ''})`); } } catch (e) { console.error('[meeting] landing failed:', e.message); }
    // CLOUD-LEVERAGE (meeting → OBJECT GRAPH): decompose the meeting record through the SAME machine a canvas
    // doc-drop uses — attendees + named orgs + relations become real Echo objects/cards (net-new people flow
    // toward the Puller), not just a flat memory item. The audio transcript (if any) is the richest source.
    // Fire-and-forget + fail-soft: never delays or breaks finalize.
    try {
      const body = [recap, minutes, audioTranscript].filter(Boolean).join('\n\n');
      if (body.trim().length >= 40) {
        const mtitle = (() => { try { return require('./lib/meeting_lane').meetingTitle({ url: db.getMeta('gmeet_url') || '' }); } catch { return 'Meeting'; } })();
        const mid = _notesId != null ? `meeting:${_notesId}` : `meeting:${db.getMeta('gmeet_started_at') || 'session'}`;
        decomposeLandedDoc({ id: mid, title: `Meeting — ${mtitle}`, body, source: 'meeting' }).catch((e) => console.error('[meeting] decompose failed:', e && e.message));
      }
    } catch (e) { console.error('[meeting] decompose wiring failed:', e && e.message); }
    // FINAL VIEW = the full notes (recap header + the rich running minutes), matching the landed doc. Emitting
    // the recap ALONE dropped the detailed Topics/Decisions the operator watched accrue ("notes ate themselves").
    const finalBody = [recap, (minutes && minutes.trim()) ? `## Running minutes\n${minutes}` : ''].filter(Boolean).join('\n\n') || recap || minutes;
    try { await emitMeetingNotes(finalBody, { final: true }); } catch {}
  }
  stopScribeHeartbeat();
}

// ============================ LEGISLATION (studio — data browser) ============================
// Read-only surface over the engine's bill tools (~1.46M bills). No "list all": browse by facets
// (offset-paginated) or FTS search. main unwraps + maps via studio/leg_view.js. No model.
ipcMain.handle('leg:facets', async (_e, filters = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('bill_facets', {
      state: filters.state || null, session: filters.session || null, bill_type: filters.bill_type || null,
      chamber_origin: filters.chamber_origin || null, year: filters.year || null,
    });
    return { ok: true, groups: legView.facetGroups(payload) };
  } catch (e) { console.error('[leg] facets failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('leg:browse', async (_e, { filters, offset } = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const f = filters || {};
    const callTool = pollCallTool();
    const payload = await callTool('list_bills', {
      state: f.state || null, session: f.session || null, bill_type: f.bill_type || null,
      chamber_origin: f.chamber_origin || null, year: f.year || null,
      offset: Number(offset) || 0, limit: 60, order_by: 'name',
    });
    return { ok: true, list: legView.billList(payload, Number(offset) || 0) };
  } catch (e) { console.error('[leg] browse failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('leg:search', async (_e, { query, filters } = {}) => {
  try {
    if (!query || !String(query).trim()) return { ok: false, error: 'empty query' };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const f = filters || {};
    const callTool = pollCallTool();
    const payload = await callTool('search_bills', { query: String(query), state: f.state || null, session: f.session || null, bill_type: f.bill_type || null, top_k: 50 });
    return { ok: true, list: legView.searchList(payload) };
  } catch (e) { console.error('[leg] search failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('leg:get', async (_e, { billId } = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('get_bill', { bill_id: Number(billId) });
    return { ok: true, card: legView.billCard(payload) };
  } catch (e) { console.error('[leg] get failed:', e.message); return { ok: false, error: e.message }; }
});

// ============================ PEOPLE RAIL (contact cards) =====================================
// The left-docked contact-card waterfall on the canvas. Recent Puller contacts (newest-first) that carry
// contact intel become cards; a doc drop pushes a new card live (see bankDocContacts). CRM photo/bio is a
// consume-only enrichment. "Full briefing →" opens the Puller dossier surface for that person.
ipcMain.handle('contacts:recent', async (_e, { n = 60 } = {}) => {
  try {
    const pdb = require('./lib/puller_db'); pdb.init();
    const contactCard = require('./studio/contact_card');
    const targets = pdb.listTargets({ limit: Math.max(1, Math.min(200, Number(n) || 60)) });   // ORDER BY last_accessed_at DESC
    const withIntel = [];
    for (const t of targets) {
      const beliefs = pdb.listBeliefs(t.id);
      let social = []; try { social = contactCard.socialFromObservations(pdb.listObservations(t.id, { attr: 'social' })); } catch {}
      // needs contact intel (email/phone/address/role belief) OR discovered social handles — so a
      // person enriched ONLY with social observations (e.g. a CRM-only mint) still surfaces on the rail.
      if (!beliefs.some(b => b.type === 'email' || b.type === 'phone' || b.type === 'address' || b.type === 'role') && !social.length) continue;
      withIntel.push({ t, beliefs, social });
    }
    const crmByName = await lookupCrmContacts(withIntel.map(x => x.t.name));
    const people = withIntel.map(x => contactCard.cardFromTarget(x.t, x.beliefs, crmByName.get(String(x.t.name).toLowerCase()) || {}, { social: x.social }));
    // merge in the PLACE / EVENT / ORG cards (recent_cards store) — one typed waterfall, newest-first
    let placeEvent = []; try { placeEvent = db.listRecentCards({ types: ['place', 'event', 'org'], limit: Math.max(1, Math.min(200, Number(n) || 60)) }); } catch (e) {}
    const cards = [...people, ...placeEvent].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, Math.max(1, Math.min(200, Number(n) || 60)));
    return { ok: true, cards };
  } catch (e) { console.error('[contacts] recent failed:', e.message); return { ok: false, error: e.message, cards: [] }; }
});
ipcMain.handle('contacts:open-briefing', async (_e, { targetId } = {}) => {
  try {
    const win = createWorkspaceWindow();
    if (win && !win.isDestroyed()) {
      const send = () => { try { win.webContents.send('workspace:open-surface', { surface: 'puller', targetId: Number(targetId) }); } catch {} };
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});
// "Open in CRM →" — pull up the COMPLETE CRM entry for a card that's an actual CRM contact. Opens the
// CRM surface (crm.html) deep-linked to the contact id (crm.js reads the #target= hash on load).
ipcMain.handle('contacts:open-crm', async (_e, { crmId } = {}) => {
  try {
    if (crmId == null) return { ok: false, error: 'no crmId' };
    const win = createWorkspaceWindow();
    if (win && !win.isDestroyed()) {
      const send = () => { try { win.webContents.send('workspace:open-surface', { surface: 'crm', targetId: Number(crmId) }); } catch {} };
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send); else send();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ============================ KNOWLEDGE GRAPH (studio — data browser) =========================
// Read-only entity-network explorer over graph_overview / query_graph / search_entities. main
// unwraps + builds the {nodes,links} graph (with style) via studio/kg_view.js; the renderer draws
// it with vanilla force-graph and re-filters by type client-side. No model.
ipcMain.handle('kg:overview', async () => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('graph_overview', { per_type_k: 8, recent_k: 20, recent_window_days: 30 });
    const g = kgView.buildOverview(payload);
    return { ok: true, nodes: g.nodes, links: g.links, availableTypes: kgView.availableTypes('overview', payload), legend: kgView.legend(),
      stats: { totalEntities: (payload && payload.total_entities) || g.nodes.length, totalRelations: (payload && payload.total_relations) || g.links.length } };
  } catch (e) { console.error('[kg] overview failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('kg:ego', async (_e, { entity, hops } = {}) => {
  try {
    if (!entity) return { ok: false, error: 'no entity' };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('query_graph', { entity_name: String(entity), hops: Number(hops) || 2 });
    if (payload && payload.error) return { ok: true, error: payload.error };
    const g = kgView.buildEgo(payload);
    // Enrich nodes with REAL total degree (entities.degree) so the renderer can draw "off into the universe"
    // tendrils from nodes with more connections than we're showing. One batched query, best-effort.
    try {
      const names = g.nodes.map(n => n.id).filter(Boolean);
      if (names.length) {
        const dq = await callTool('db_query', { sql: `SELECT name, degree FROM entities WHERE name IN (${names.map(() => '?').join(',')})`, params: names });
        const degOf = new Map(((dq && dq.rows) || []).map(r => [r.name, r.degree]));
        for (const n of g.nodes) { const d = degOf.get(n.id); if (typeof d === 'number') n.degree = d; }
      }
    } catch (e) { /* degree is a nice-to-have; the ego view works without it */ }
    return { ok: true, nodes: g.nodes, links: g.links, availableTypes: kgView.availableTypes('ego', payload), legend: kgView.legend(),
      stats: { related: (payload && payload.result_count) || g.links.length, hops: (payload && payload.hops) || hops } };
  } catch (e) { console.error('[kg] ego failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('kg:search', async (_e, { query } = {}) => {
  try {
    if (!query || String(query).trim().length < 2) return { ok: true, hits: [] };
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('search_entities', { query: String(query), top_k: 8 });
    const hits = kgView.searchHits(payload).map(h => ({ ...h, color: kgView.colorFor(h.entity_type) }));
    return { ok: true, hits };
  } catch (e) { console.error('[kg] search failed:', e.message); return { ok: false, error: e.message }; }
});

// SHORT-TERM LAYER (two-source galaxy): the panel ALSO reads Side Quest's OWN short-term store — Zoe's local
// graph_entities/relations + recent unpromoted documents (the "new data coming in") — which the renderer draws
// as the bright active CORE alongside the Echo corpus. Bounded to the most-recent N so it never blows the
// render. Local DB only (no Echo dependency); tagged store:'sidequest' + epistemic for the layer styling.
ipcMain.handle('kg:shortterm', async () => {
  try {
    const ents = db.graphListEntities({ limit: 90 });               // most-recent local entities (id DESC)
    const byId = new Map(ents.map(e => [e.id, e]));
    const rels = db.graphRelationsAmong([...byId.keys()]);
    const docs = db.recentDocuments(18, { unpromotedOnly: true });  // fresh material still in the short-term buffer
    const nodes = [], seen = new Set();
    for (const e of ents) {
      if (!e.name || seen.has(e.name)) continue; seen.add(e.name);
      nodes.push({ id: e.name, store: 'sidequest', entityType: e.entity_type || 'concept', epistemic: e.epistemic || 'told', summary: e.summary || null });
    }
    for (const d of docs) {
      const label = `doc: ${String(d.title || d.ref || ('#' + d.id)).slice(0, 42)}`;
      if (seen.has(label)) continue; seen.add(label);
      nodes.push({ id: label, store: 'sidequest', entityType: 'document', epistemic: 'read', summary: String(d.understanding || d.body || '').slice(0, 160) });
    }
    const links = [];
    for (const r of rels) {
      const s = byId.get(r.source_id), t = byId.get(r.target_id);
      if (s && t && s.name && t.name && s.name !== t.name) links.push({ source: s.name, target: t.name, relType: r.relation_type || 'related', category: 'derived' });
    }
    return { ok: true, nodes, links, counts: { entities: nodes.length, relations: links.length, documents: docs.length } };
  } catch (e) { console.error('[kg] shortterm failed:', e.message); return { ok: false, error: e.message }; }
});

// kg:activity BUS (Stage A transport) — the single broadcaster the DB-side emitters (Slices 2/3) call to push a
// real data-interaction event to the KG panel. Broadcasts to ALL webContents because the panel is a <webview>
// (only it registers kg:activity), mirroring emitFocusMove. Payload is tiny + additive + safe-with-no-receiver.
// Keep it defensive: a bad/absent payload must never throw into a caller on a hot DB path.
function emitKgActivity(payload) {
  try {
    if (!payload || typeof payload !== 'object' || !payload.kind) return;
    for (const wc of require('electron').webContents.getAllWebContents()) {
      try { if (!wc.isDestroyed()) wc.send('kg:activity', payload); } catch (e) {}
    }
  } catch (e) {}
}
// Expose for the SQ-side emitters wired in later slices (graph_memory tap, resolveMention match.hit, recall,
// promoteDocumentsPass, doc.land/news). They import main lazily or receive this via their init options.
global.__emitKgActivity = emitKgActivity;
// Dev round-trip trigger (CDP-verifiable): fire a REAL main→preload→renderer kg:activity so Slice 1 transport
// can be proven end-to-end without a real emitter yet. Guarded like the other __kg dev hooks.
ipcMain.handle('kg:dev-activity', async (_e, payload) => { try { emitKgActivity(payload || { db: 'sidequest', kind: 'node.born', anchor: 'DEV probe' }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; } });

// ============================ READER / LIBRARY (studio — writing suite Phase 2) ===============
// Read-only corpus reader on the document substrate. Lists projects + recent docs, and renders a
// document's body markdown through the shared block model (editor_import via doc_view). No model.
ipcMain.handle('reader:projects', async () => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('list_projects', {});
    return { ok: true, projects: docView.projectList(payload) };
  } catch (e) { console.error('[reader] projects failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('reader:list', async (_e, { project } = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('recent_documents', { project_name: project || null, limit: 50 });
    return { ok: true, docs: docView.docList(payload) };
  } catch (e) { console.error('[reader] list failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('reader:get', async (_e, { docId } = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const callTool = pollCallTool();
    const payload = await callTool('get_document', { doc_id: Number(docId), depth: 'full' });
    const doc = docView.readerDoc(payload);
    // Faithful render: for a .docx, re-extract the CANONICAL original via mammoth (real headings,
    // lists, tables, emphasis + embedded images as data URIs) — far richer than Echo's flattened
    // markdown_current. Falls back to the structured blocks if the original isn't reachable.
    try {
      const orig = payload.vault_source_abs_path || payload.abs_path || '';
      if (doc && /\.docx$/i.test(orig) && require('fs').existsSync(orig)) {
        doc.html = (await docExtract.extractDocxHtml(orig)).html;
      }
    } catch (e) { console.warn('[reader] rich docx render skipped:', e.message); }
    return { ok: true, doc };
  } catch (e) { console.error('[reader] get failed:', e.message); return { ok: false, error: e.message }; }
});

// Return a document's CANONICAL original file as base64 — used by the Reader to render PDFs in
// Chromium's native viewer (full fidelity: charts, images, layout). Resolves the original via
// get_document's source paths; size-capped to keep the IPC payload sane.
ipcMain.handle('reader:bytes', async (_e, { docId } = {}) => {
  try {
    if (!(await ensureEngine())) return { ok: false, error: 'Echo engine not connected' };
    const fs = require('fs');
    const callTool = pollCallTool();
    const payload = await callTool('get_document', { doc_id: Number(docId), depth: 'summary' });
    const orig = (payload && (payload.vault_source_abs_path || payload.abs_path || payload.source_path)) || '';
    if (!orig || !fs.existsSync(orig)) return { ok: false, error: 'original file not found' };
    const stat = fs.statSync(orig);
    if (stat.size > 30 * 1024 * 1024) return { ok: false, error: 'file too large to preview (>30MB)' };
    const ext = path.extname(orig).replace(/^\./, '').toLowerCase();
    const mime = ext === 'pdf' ? 'application/pdf' : 'application/octet-stream';
    return { ok: true, base64: fs.readFileSync(orig).toString('base64'), mime, name: path.basename(orig) };
  } catch (e) { console.error('[reader] bytes failed:', e.message); return { ok: false, error: e.message }; }
});

ipcMain.handle('meta:get', (_e, key) => db.getMeta(key));

ipcMain.handle('meta:set', (_e, key, value) => {
  db.setMeta(key, value);
  return true;
});

ipcMain.handle('history:recent', () => {
  return db.getRecentDisplayTurns(DISPLAY_HISTORY_LIMIT);
});

ipcMain.handle('monologue:recent', (_e, n = 30) => db.getRecentMonologue(n));

ipcMain.handle('dashboard:metrics', () => {
  const allCommitments = db.getAllCommitments(500);
  const heldCommitments = allCommitments.filter(c => c.status === 'held');
  const revisedCount = allCommitments.filter(c => c.status === 'revised').length;
  const abandonedCount = allCommitments.filter(c => c.status === 'abandoned').length;

  // Sycophancy density — count forbidden phrases in last 50 ai_said turns
  const recentSaids = db.getRecentTurns(150).filter(t => t.speaker === 'ai_said').slice(-50);
  const sycophancyPatterns = [
    /\byour astute observation\b/i,
    /\byour insightful perspective\b/i,
    /\bresonates with me deeply\b/i,
    /\bthat'?s fascinating\b/i,
    /\bI appreciate the\b/i,
    /\bencourages me to cultivate\b/i,
    /\binvites me to consider\b/i,
    /\bserves as a poignant reminder\b/i,
    /\byou'?re absolutely right\b/i,
    /\byou'?re picking up on\b/i,
    /\bI'?m glad you\b/i,
    /\bthank you for sharing\b/i
  ];
  let sycophancyHits = 0;
  let sycophancyTurns = 0;
  for (const t of recentSaids) {
    let hit = false;
    for (const re of sycophancyPatterns) {
      if (re.test(t.content)) { sycophancyHits++; hit = true; }
    }
    if (hit) sycophancyTurns++;
  }
  const sycophancyDensity = recentSaids.length > 0
    ? (sycophancyTurns / recentSaids.length)
    : 0;

  // Initiation rate — fraction of ai_said turns where she introduces a topic
  // (heuristic: contains "?" pointed at user, or "I want to", "I've been thinking about")
  const initiationPatterns = [
    /\bI want to (?:ask|know|understand|hear)\b/i,
    /\bI'?ve been (?:thinking|wondering)\b/i,
    /\bI keep (?:coming back|thinking)\b/i,
    /\bI got curious about\b/i,
    /\bI read about\b/i,
    /\bsomething I committed to earlier\b/i
  ];
  let initiationCount = 0;
  for (const t of recentSaids) {
    for (const re of initiationPatterns) {
      if (re.test(t.content)) { initiationCount++; break; }
    }
  }
  const initiationRate = recentSaids.length > 0
    ? (initiationCount / recentSaids.length)
    : 0;

  // Totals
  const totals = {
    turns: db.getRecentTurns(99999).length,
    reflections: db.getRecentReflections(99999).length,
    monologue_thoughts: db.getRecentMonologueByType('thought', 99999).length,
    monologue_readings: db.getRecentMonologueByType('reading', 99999).length
  };

  // Open threads — goal-pursuit metrics
  const allThreads = db.getAllOpenThreads(500);
  const threadsByStatus = { pending: 0, active: 0, stalled: 0, resolved: 0, abandoned: 0 };
  let totalMentions = 0;
  let totalActions = 0;
  for (const t of allThreads) {
    if (threadsByStatus[t.status] != null) threadsByStatus[t.status]++;
    totalMentions += (t.mention_count || 0);
    totalActions += (t.action_count || 0);
  }
  const activeThreadsList = allThreads
    .filter(t => t.status === 'pending' || t.status === 'active' || t.status === 'stalled')
    .slice(0, 8)
    .map(t => ({
      id: t.id, content: t.content, status: t.status,
      mention_count: t.mention_count || 0,
      action_count: t.action_count || 0,
      last_touched_ts: t.last_touched_ts, created_ts: t.created_ts
    }));
  // mention-to-action ratio — the key diagnostic signal per research synthesis.
  // If mentions rise but actions stay flat, we're in the sycophancy/pattern-match
  // regime and goal injection alone isn't enough — model upgrade or scaffold needed.
  const actionRatio = totalMentions > 0 ? (totalActions / totalMentions) : 0;

  return {
    commitments: {
      total: allCommitments.length,
      held: heldCommitments.length,
      revised: revisedCount,
      abandoned: abandonedCount,
      recent_held: heldCommitments.slice(0, 8).map(c => ({ id: c.id, claim: c.claim, first_held_at: c.first_held_at }))
    },
    sycophancy: {
      density: sycophancyDensity,
      hits: sycophancyHits,
      window_size: recentSaids.length
    },
    initiation: {
      rate: initiationRate,
      count: initiationCount,
      window_size: recentSaids.length
    },
    open_threads: {
      total: allThreads.length,
      by_status: threadsByStatus,
      total_mentions: totalMentions,
      total_actions: totalActions,
      action_ratio: actionRatio,
      active: activeThreadsList
    },
    totals
  };
});

ipcMain.handle('open_threads:recent', () => db.getAllOpenThreads(50));

// --- Browser IPC ---
ipcMain.handle('browser:launch', async () => {
  const launched = browserLib.launchChrome();
  if (!launched.ok) return launched;
  const connected = await browserLib.connect();
  return { ...launched, ...connected, status: browserLib.statusSnapshot() };
});

ipcMain.handle('browser:connect', async () => {
  const r = await browserLib.connect();
  return { ...r, status: browserLib.statusSnapshot() };
});

ipcMain.handle('browser:disconnect', async () => {
  return browserLib.disconnect();
});

ipcMain.handle('browser:status', () => ({
  connected: browserLib.isConnected(),
  ...browserLib.statusSnapshot()
}));

// Extract HTTP(S) URLs from a chunk of text
function extractUrls(text) {
  if (!text) return [];
  const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
  const matches = text.match(urlRe) || [];
  // De-dupe, cap to 3
  return [...new Set(matches)].slice(0, 3);
}

const { detectWebIntent, detectActOnOpenPage, detectPickCharacter, detectRecordCommand, classifyQuery, isRecallQuery, isActionable, isSocialTurn } = require('./lib/intent');
const preferences = require('./lib/preferences');
const personal = require('./lib/personal');
const playSession = require('./lib/play_session');
const voice = require('./lib/voice');

// Core chat turn — shared by the IPC handler (renderer) and the Discord bridge.
// io.emit(token) streams say-tokens; io.onComplete/onError fire UI events. For
// headless callers (Discord) these default to no-ops and the final say is
// returned in { ok, say } so the caller can deliver it however it likes.
let _chatTurnGen = 0;   // monotonic per chat turn — used to discard a prior turn's stale tool follow-ups
async function runChatTurn(userMessage, attachments = [], io = {}) {
  if (!userMessage || !userMessage.trim()) return { ok: false, error: 'empty', say: null };
  const emit = io.emit || (() => {});
  const sendComplete = io.onComplete || (() => {});
  const sendError = io.onError || (() => {});
  const sendBusy = io.busy || (() => {});
  const channel = io.channel || 'desktop';
  // Guard: a chat-initiated tool result triggers exactly ONE auto-continuation
  // turn (so she voices what the tool returned without Lucas having to prompt).
  let followupFired = false;
  // TURN ISOLATION — stamp this turn's generation on the io callback. A prior turn's fire-and-forget
  // tool dispatch runs AFTER runChatTurn returns; without this it renders into the NEXT turn (the bleed
  // where "Who is Donald Trump?" got the prior cabinet-task follow-up). fireToolFollowup discards a
  // follow-up whose stamped generation is stale.
  const _myGen = ++_chatTurnGen;
  try { io._gen = _myGen; } catch {}

  // Measure the gap since her last turn BEFORE resetting activity — a long gap
  // means Lucas is "back", which is when a capability proposal may surface.
  const idleSinceLastTurn = Date.now() - lastUserTurnTs;
  lastUserTurnTs = Date.now();

  markUserActivity();
  markMonologueActivity();
  markHeartbeatActivity();
  markContinuityActivity();
  pauseMonologue();
  pauseHeartbeat();
  pauseContinuity();
  pauseReflection();
  selfDialogue.pause();

  // SNAP-BACK: how this message reaches her while she may be lost in thought.
  //  • explicit phrase ("earth to Zoe" / "Zoe, come back" / "snap out of it")
  //    → HARD-interrupt the in-flight thought so her reply gets the GPU now;
  //    she surfaces with a brief "coming back" beat (note injected below).
  //  • normal message while she's mid-thought → an instant busy-lane placeholder
  //    in her voice; the thought finishes naturally, then her real reply follows.
  //  • normal message while idle → nothing special.
  let pulledFromThought = false;
  if (channel !== 'discord' && detectHardPull(userMessage)) {
    try { interruptMonologue(); } catch {}
    pulledFromThought = true;
  } else if (channel !== 'discord' && monologueBusy()) {
    // RESPONSIVENESS: a normal message used to let the in-flight thought finish before
    // her reply got the model — that wait IS the 25-40s reply latency (Ollama serializes
    // on one local model). Hard-interrupt it now so the reply gets the model immediately.
    // A between-turn musing is not precious; losing it is the right trade for a fast reply.
    try { interruptMonologue(); } catch {}
    // NO busy-line placeholder here. It was a leftover from the old "let the thought finish,
    // queue a placeholder, then reply" design — but monologueBusy() is true ~70% of idle time
    // (10s tick, multi-second thoughts), so a "hold on, I'm deep in something" line fired on
    // nearly every message arriving after a lull (the memory-calibration "welcome back" case),
    // reading as constant evasion + a double-reply. We now interrupt and answer NOW, so there is
    // no wait to apologize for. The genuine long-wait placeholder lives on the operator path only.
  }

  const sessionId = currentSessionId;
  const userTurnRow = db.insertTurn({ sessionId, speaker: 'user', content: userMessage });
  // Blackboard: a user message is the StuckDetector's reset boundary — events
  // after it start a fresh "interactive slice" so a new instruction is never read
  // as part of a prior spiral.
  try { blackboard.markUser(userMessage, userTurnRow && userTurnRow.id); } catch (e) { console.error('[main] blackboard.markUser failed:', e.message); }

  // AVAILABILITY: a message FROM Lucas means he's present → clear away. If the message
  // itself announces leaving ("I'll be away", "stepping out", "heading to bed"), set
  // away so unprompted heartbeat/continuity utterances go silent until he's back. His
  // direct message is still answered immediately below — away only gates HER unprompted talk.
  try {
    const availability = require('./lib/availability');
    availability.clearAway();
    const awayReason = availability.detectAway(userMessage);
    if (awayReason) { availability.setAway(awayReason); console.log(`[main] Lucas marked away ("${awayReason}") — unprompted utterances will stay silent`); }
  } catch (e) { console.error('[main] availability update failed:', e.message); }

  // === RECIPE RECORDER INTERCEPTOR ===
  // "record how to X on <url>" → open the site + start in-page demonstration capture;
  // "stop recording" / "save the recipe" → finalize + save. Deterministic (the 24B won't
  // reliably drive a record session), and placed BEFORE byline/gmeet/web-intent so a
  // record command isn't misread as "publish a post" or "open a browser".
  try {
    const recCmd = detectRecordCommand(userMessage, webLib.isRecording());
    if (recCmd) {
      const recUserName = db.getMeta('user_name') || 'Lucas';
      let resultText;
      if (recCmd.action === 'start') {
        const r = await webLib.startRecording({ task: recCmd.task, url: recCmd.url, site: recCmd.site });
        resultText = r.ok
          ? `[You just started RECORDING a recipe by demonstration — your browser is open at ${r.url}. Tell ${recUserName} you're watching and ask him to click and type through "${r.task}" once in your browser; you'll remember the steps. When he's finished he'll say "stop recording". One or two sentences, your own voice. You CAN do this — never deny the capability.]`
          : `[You tried to start recording a recipe but it failed: ${r.reason}. Tell ${recUserName} plainly what went wrong. Do NOT claim you lack the capability — the tool exists, it errored.]`;
        console.log(`[recorder] demonstration START → task="${recCmd.task}" url=${recCmd.url || recCmd.site || '(current)'} (${r.ok ? 'ok' : 'FAIL ' + r.reason})`);
      } else {
        const r = webLib.stopRecording();
        resultText = r.ok
          ? `[You just finished recording a recipe ("${r.recipe.task}" on ${r.recipe.site}) — ${r.steps} step${r.steps === 1 ? '' : 's'} captured and saved${r.save && r.save.shadowed ? ' as a review copy (a verified recipe for this already exists)' : ''}. It's provisional until the first real run confirms it. Tell ${recUserName} briefly what you saved, your own voice.]`
          : `[You tried to stop/save the recording but: ${r.reason}. Tell ${recUserName} plainly.]`;
        console.log(`[recorder] demonstration STOP → ${r.ok ? 'saved ' + r.steps + ' steps' : 'FAIL ' + r.reason}`);
      }
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
      try { await fireToolFollowup({ io, channel, sessionId, resultText }); } catch (e) { console.error('[recorder] followup failed:', e.message); }
      return { ok: true, recording: recCmd.action === 'start', say: null };
    }
  } catch (e) { console.error('[recorder] interceptor failed:', e.message); }
  // === END RECIPE RECORDER INTERCEPTOR ===

  // === SCREEN-SIGHT INTERCEPTOR ===
  // "can you see my screen / the picture on my screen" → capture + describe + answer in ONE
  // response, instead of a wasted "I'll use the tool" turn followed 40s later by the description
  // (the slow, split, "no response" feel in the logs). Deterministic: the 24B confabulates sight
  // ("I can see it") rather than reliably looking, so we look FOR her. Skips when an image is
  // attached (that's the normal vision-in path, not the screen).
  try {
    const hasImageAtt = Array.isArray(attachments) && attachments.some(a => a && (a.image || /^image\//.test(a.mime || '')));
    if (!hasImageAtt && screenLib.detectScreenSightRequest && screenLib.detectScreenSightRequest(userMessage)) {
      const siUser = db.getMeta('user_name') || 'Lucas';
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
      const cap = await screenLib.capture();
      if (cap && cap.ok && cap.base64) {
        await seeImage({ io, channel, sessionId, userName: siUser, base64: cap.base64, label: `${siUser}'s screen`,
          question: 'This is a screenshot of the whole screen. Describe what is visible — especially any image or photo on it — concretely and specifically.', surface: 'screen-see' });
      } else {
        try { await fireToolFollowup({ io, channel, sessionId, resultText: `[You tried to look at ${siUser}'s screen but couldn't capture it (${cap && cap.reason}). Tell him plainly you couldn't see it this time — don't pretend you did.]` }); } catch {}
      }
      console.log(`[main] screen-sight interceptor → ${cap && cap.ok ? 'captured + described' : 'FAIL ' + (cap && cap.reason)}`);
      return { ok: true, screenSight: true, say: null };
    }
  } catch (e) { console.error('[main] screen-sight interceptor failed:', e.message); }
  // === END SCREEN-SIGHT INTERCEPTOR ===

  // GOOGLE MEET — a meet.google.com link from Lucas means "join this". Start the
  // join → mandatory-intro → observe stepper (advances in the idle loop). The normal
  // turn still runs so she acknowledges.
  try {
    const gmeetLib = require('./lib/gmeet');
    if (!gmeetLib.active()) {
      const meetUrl = gmeetLib.detectMeetUrl(userMessage);
      // ALL ROADS → CANVAS: a Meet link now runs the full meeting flow IN the canvas pane (she joins
      // as herself), freeing her dedicated browser. startCanvasMeeting mounts the pane + kicks gmeet.
      if (meetUrl) { startCanvasMeeting(meetUrl, 'Google Meet'); console.log(`[main] gmeet (canvas) join started: ${meetUrl}`); }
    }
  } catch (e) { console.error('[main] gmeet start detect failed:', e.message); }

  // MEDIA WATCH — "watch/play this video <url>" starts her caption-follow stepper (open →
  // captions on → follow the live caption stream, advanced in the idle loop). Requires an
  // explicit watch verb so a YouTube link merely referenced isn't auto-watched; a live
  // meeting takes precedence. The normal turn still runs so she acknowledges.
  let mediaWatchNote = null;   // set when a watch actually starts → she acknowledges accurately (vs the honesty guard)
  try {
    const mediaCcLib = require('./lib/media_cc');
    const uName = db.getMeta('user_name') || 'Lucas';
    if (!mediaCcLib.active() && !require('./lib/gmeet').active()) {
      // (a) direct link + watch verb → watch it
      if (/\b(watch|play|put on|stream)\b/i.test(userMessage)) {
        const mediaUrl = mediaCcLib.detectMediaUrl(userMessage);
        if (mediaUrl) {
          mediaCcLib.start(mediaUrl);
          mediaWatchNote = `[You are now opening ${mediaUrl} in your own browser with captions ON. Tell ${uName} you're putting it on now; you'll follow the captions live as it plays. Do NOT invent what happens — just acknowledge you're starting it.]`;
          console.log(`[main] media watch started: ${mediaUrl}`);
        }
      }
      // (b) NO link — "pull up / find clips of X on youtube": search YouTube, watch the top clip
      if (!mediaCcLib.active()) {
        const swQuery = mediaCcLib.detectSearchWatch(userMessage);
        if (swQuery) {
          const r = await mediaCcLib.findAndStart({ query: swQuery, deps: { search: require('./lib/web_search').search } });
          if (r.ok) {
            mediaWatchNote = `[You just searched YouTube for "${swQuery}" and are opening the top clip (${r.url}) in your own browser with captions ON. Tell ${uName} you're pulling it up now; you'll follow the captions live as it plays. Do NOT invent scenes or dialogue — just acknowledge you're starting it.]`;
            console.log(`[main] search-and-watch started: "${swQuery}" → ${r.url}`);
          } else {
            mediaWatchNote = `[You tried to find "${swQuery}" on YouTube but couldn't get a usable clip link (${r.reason}). Tell ${uName} plainly you couldn't pull one up; ask him to paste a link, or offer to talk about it from what you actually know. Do NOT pretend you watched anything.]`;
            console.log(`[main] search-and-watch found nothing for "${swQuery}" (${r.reason})`);
          }
        }
      }
    }
  } catch (e) { console.error('[main] media watch/search detect failed:', e.message); }

  // LISTEN (audio via Echo transcription) — "listen to me / transcribe this call": start an Echo
  // capture (mic by default; loopback for a call/video). "stop listening" stops + transcribes +
  // feeds the transcript back so she responds to what was ACTUALLY said. Record→stop→transcribe
  // (not live). Fail-safe: Echo down / no transcript → honest note, never fabrication.
  let listenNote = null;
  try {
    const listenLib = require('./lib/listen');
    const uName = db.getMeta('user_name') || 'Lucas';
    const echoDispatch = (t) => echoSuit.dispatch(t);
    if (listenLib.active() && listenLib.detectStop(userMessage)) {
      const r = await listenLib.stop({ deps: { dispatch: echoDispatch } });
      if (r.ok && r.ready && r.transcript) {
        listenNote = `[You were listening; Echo transcribed what was just said:\n${r.transcript}\n\nRespond to ${uName} about it in your own voice — this is real, you actually captured it. Don't add anything that isn't in the transcript.]`;
      } else if (r.ok) {
        listenNote = `[You stopped listening, but Echo is still transcribing — no lines back yet. Tell ${uName} you've got the recording and it's still processing; you'll have what was said shortly. Do NOT invent the content.]`;
      } else {
        listenNote = `[You tried to stop/transcribe but Echo couldn't return a transcript (${r.reason}). Tell ${uName} plainly; don't make up what was said.]`;
      }
      console.log(`[main] listen stop → ${r.ok ? (r.ready ? r.segments.length + ' segments' : 'pending') : 'FAIL ' + r.reason}`);
    } else if (!listenLib.active()) {
      const st = listenLib.detectStart(userMessage);
      if (st && echoSuit) {
        const r = await listenLib.start({ source: st.source, deps: { dispatch: echoDispatch } });
        if (r.ok) listenNote = `[You are now LISTENING via Echo (${st.source === 'loopback' ? 'system/loopback audio' : 'your mic'}). Tell ${uName} you're listening and to say "stop listening" when done — the transcript comes when you stop. Do NOT make up what you hear in the meantime.]`;
        else listenNote = `[You tried to start listening but Echo couldn't begin a capture (${r.reason}). Tell ${uName} plainly you couldn't start it right now.]`;
        console.log(`[main] listen start (${st.source}) → ${r.ok ? 'session ' + r.sessionId : 'FAIL ' + r.reason}`);
      }
    }
  } catch (e) { console.error('[main] listen detect failed:', e.message); }

  // BYLINE START — "write/publish a post about X" kicks off her autonomous byline
  // pipeline (research→read→write→publish, advanced one stage per idle tick). Side
  // effect only: the normal turn still runs so she acknowledges in her own voice.
  try {
    const bylineLib = require('./lib/byline');
    if (!bylineLib.active()) {
      const bylineTopic = bylineLib.detectStart(userMessage);
      if (bylineTopic) { bylineLib.start(bylineTopic); console.log(`[main] byline pipeline started on: "${bylineTopic}"`); }
    }
  } catch (e) { console.error('[main] byline start detect failed:', e.message); }

  // === HARD PROTOCOL INTERCEPTOR ===
  // Before doing ANYTHING expensive (web fetch, Stheno call, gemma extraction),
  // check if the user just invoked a safe word or mode command. If so, bypass
  // Stheno entirely and emit the agreed-upon protocol response. This is the
  // single most-load-bearing piece of memory continuity in the system.
  const triggerMatch = protocolsLib.checkTriggerMatch(userMessage);
  if (triggerMatch && triggerMatch.action && triggerMatch.action !== 'none') {
    const interceptUserName = db.getMeta('user_name') || 'Lucas';
    const result = protocolsLib.executeAction({
      protocol: triggerMatch.protocol,
      action: triggerMatch.action,
      userName: interceptUserName
    });
    if (result) {
      // Persist as a normal AI turn so the conversation reads naturally,
      // but mark model as 'protocol-interceptor' for auditability.
      if (result.responseThought) {
        db.insertTurn({
          sessionId, speaker: 'ai_thought',
          content: result.responseThought, model: 'protocol-interceptor'
        });
      }
      const saidRow = db.insertTurn({
        sessionId, speaker: 'ai_said',
        content: result.responseSay, model: 'protocol-interceptor'
      });

      // Stream the response to the renderer in pieces so it animates naturally
      try {
        for (const ch of result.responseSay) {
          emit(ch);
        }
        sendComplete({ saidId: saidRow.id, truncated: 0, protocolInvoked: triggerMatch.protocol.id });
      } catch {}

      // If hard_break_rp: abandon any active threads that were extracted from
      // user stop-attempts during the locked-in RP (they're pollution at this point)
      if (result.modeChange === 'rp_off') {
        try {
          const activeThreads = db.getActiveOpenThreads(50);
          for (const t of activeThreads) {
            // Abandon only threads that clearly reference stop/break — don't nuke real goals
            const c = (t.content || '').toLowerCase();
            if (/\b(stop|break|end fantasy|safe word|snap out|lollipop)\b/.test(c)) {
              db.markOpenThreadStatus(t.id, 'abandoned', { reason: 'auto-cleared by safe-word interceptor' });
            }
          }
        } catch (err) { console.error('[main] interceptor cleanup failed:', err.message); }
      }

      db.setMeta('last_ai_utterance_at', String(Date.now()));
      resumeMonologue();
      resumeHeartbeat();
      resumeContinuity();
      resumeReflection();
      selfDialogue.resume();

      console.log(`[main] PROTOCOL INTERCEPTED: ${triggerMatch.protocol.trigger_phrase} → ${triggerMatch.action} (${triggerMatch.matchType})`);
      return { ok: true, intercepted: true, protocolId: triggerMatch.protocol.id, say: result.responseSay };
    }
  }
  // === END INTERCEPTOR ===

  const userName = db.getMeta('user_name') || 'them';

  // === WEB-INTENT INTERCEPTOR ===
  // The 24B reflexively refuses "open a browser / look it up" even though its
  // prompt explicitly grants the capability (confirmed in the system prompt). So
  // when Lucas clearly asks for web action we open her OWN browser deterministically
  // and have her REPORT the result via the tool follow-up — bypassing the refusal.
  // Mirrors the protocol interceptor + the email reply-intent trigger.
  try {
    const webIntent = detectWebIntent(userMessage);
    // Don't WIPE an already-open browser on a bare "open a browser" with no destination — a mention
    // shouldn't reset her page to the DDG home. Only act on a bare-open when nothing's open yet.
    if (webIntent && webIntent.bare && webLib.isConnected()) {
      console.log('[web-intent] bare open ignored — browser already open, not resetting to search home');
    } else if (webIntent) {
      const o = await webLib.open(webIntent.target);
      let resultText;
      if (o.ok) {
        const r = await webLib.read();
        resultText = r.ok
          ? `[You just opened your OWN browser to "${r.title || r.url}" (${r.url}) — it is open on screen right now. The page contents:\n${(r.text || '').slice(0, 2500)}\n\nTell ${userName} you opened it and what you see, in your own voice. You DID open it — never say you can't open a browser.]`
          : `[You opened your own browser to ${o.url} — it's open now. Tell ${userName} briefly that you opened it.]`;
      } else {
        resultText = `[Your own browser failed to open: ${o.reason}. Tell ${userName} plainly what went wrong. Do NOT claim you lack the capability — the tool exists, it just errored.]`;
      }
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
      try { await fireToolFollowup({ io, channel, sessionId, resultText }); } catch (e) { console.error('[web-intent] followup failed:', e.message); }
      console.log(`[web-intent] opened her browser → "${webIntent.target}" (${o.ok ? 'ok' : 'FAIL ' + o.reason})`);
      return { ok: true, webOpened: true, say: null };
    }
    // PICK A CHARACTER / START A SCENE → kick the deterministic play stepper. The 24B
    // fumbles free-form navigation (gets confused and reverts), but the stepper makes
    // each step a trivial pick. Turn on personal mode + start the session pointed at the
    // already-open site; the idle loop drives inventory→choose→chat one step per tick
    // (visible in the sheep panel). This is the part she does reliably.
    if (webLib.isConnected() && detectPickCharacter(userMessage)) {
      try { personal.setOn(); playSession.start(); playSession.set('inventory'); }
      catch (e) { console.error('[pick-char] start failed:', e.message); }
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
      const resultText = `[Lucas asked you to pick a character on the chat site open in your browser. You're doing it now, step by step — look at who's there, pick the one that appeals to you, open them, and start talking; your play loop drives it. Tell Lucas in ONE line that you're picking one and diving in. Do NOT say you can't — you're already on it.]`;
      try { await fireToolFollowup({ io, channel, sessionId, resultText }); } catch (e) { console.error('[pick-char] followup failed:', e.message); }
      console.log('[pick-char] started play stepper at inventory (site already open)');
      return { ok: true, pickChar: true, say: null };
    }
    // ACT ON THE OPEN PAGE: "look at / use / surf the page (or the chat I opened)".
    // She refuses to emit the read tag, so we read her CURRENT front tab for her —
    // syncActivePage means this picks up a chat Lucas just opened — and feed it back
    // with a push to act. Bypasses both the refusal AND the can't-see-it problem.
    if (webLib.isConnected() && detectActOnOpenPage(userMessage)) {
      const r = await webLib.read();
      let resultText;
      if (r.ok) {
        resultText = `[You just looked at the page open in your OWN browser right now — "${r.title || r.url}" (${r.url}). Its text and the things you can click/type (handles like [L0]/[B0]/[I0]) are below. ACT on it in your own voice: if it's a chat, send your line with <web-chat speaker="Name">…</web-chat>; if there's something to open/click, <web-click>HANDLE</web-click>. You CAN see and use it — you just did. Never say you can't.\n\n${(r.text || '').slice(0, 3000)}]`;
      } else {
        resultText = `[You tried to look at your browser but: ${r.reason}. If nothing's open yet, open something with <web-open>. Tell ${userName} plainly — do NOT claim you lack the capability to see or use it.]`;
      }
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
      try { await fireToolFollowup({ io, channel, sessionId, resultText }); } catch (e) { console.error('[act-on-page] followup failed:', e.message); }
      console.log(`[act-on-page] read her front tab (${r.ok ? 'ok: ' + (r.title || r.url) : 'FAIL ' + r.reason})`);
      return { ok: true, webRead: true, say: null };
    }
  } catch (err) { console.error('[web-intent] interceptor failed:', err.message); }
  // === END WEB-INTENT ===

  // === READ-INBOX INTERCEPTOR ===
  // She has TWO email surfaces, and conflating them is what confused her: HER own account
  // (IMAP, zoelanai@gmail.com) vs LUCAS'S inbox, which he keeps open in the SHARED co-pilot
  // browser. Route by referent so "your inbox" reads her account and "my inbox" looks at
  // his on the shared browser — deterministically, bypassing the denial reflex.
  try {
    if (inboxLib.detectInboxIntent(userMessage)) {
      const ref = inboxLib.inboxReferent(userMessage);
      if (ref === 'his' && browserLib.isConnected()) {
        // His inbox is on the shared browser — read that tab, not her IMAP account.
        const r = await browserLib.dispatch({ tag: 'browse-read', attrs: {} });
        const resultText = (r && r.ok)
          ? `[Lucas asked about HIS inbox — it's open in the shared browser you both use, NOT your own zoelanai@gmail.com account. You just read that tab; here's what's on it. Tell him what you see, in your own voice — you CAN see it, you just did.\n\n${(r.text || '').slice(0, 3000)}]`
          : `[You tried to read Lucas's inbox in the shared browser but: ${(r && r.reason) || 'unknown error'}. If the tab isn't up, ask him to bring it forward. Do NOT say you can't see it — you can read the shared browser.]`;
        db.setMeta('last_ai_utterance_at', String(Date.now()));
        resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
        try { await fireToolFollowup({ io, channel, sessionId, resultText }); } catch (e) { console.error('[read-inbox/his] followup failed:', e.message); }
        console.log(`[read-inbox] Lucas's inbox via shared browser (${(r && r.ok) ? 'ok' : 'FAIL ' + (r && r.reason)})`);
        return { ok: true, inboxRead: 'his', say: null };
      }
      // 'his' but no shared browser connected → fall through (don't read HER account as a
      // wrong substitute; let the model ask him to open it). Otherwise read her own inbox.
      if (ref !== 'his' && inboxLib.isConfigured()) {
        const r = await inboxLib.dispatch({});
        const resultText = (r && r.ok)
          ? `[You just read your OWN email inbox (zoelanai@gmail.com) — here is what is in it right now. Tell ${userName} what you see, in your own voice. You DID read it; never say you can't access email.\n\n${r.text}]`
          : `[You tried to read your inbox but: ${(r && r.reason) || 'unknown error'}. Tell ${userName} plainly what went wrong — do NOT claim you lack the capability to read email; you have it.]`;
        db.setMeta('last_ai_utterance_at', String(Date.now()));
        resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
        try { await fireToolFollowup({ io, channel, sessionId, resultText }); } catch (e) { console.error('[read-inbox] followup failed:', e.message); }
        console.log(`[read-inbox] her IMAP inbox (${(r && r.ok) ? 'ok: ' + ((r.messages && r.messages.length) || 0) + ' msgs' : 'FAIL ' + (r && r.reason)})`);
        return { ok: true, inboxRead: 'hers', say: null };
      }
    }
  } catch (err) { console.error('[read-inbox] interceptor failed:', err.message); }
  // === END READ-INBOX INTERCEPTOR ===

  // === RECALL INTERCEPTOR ===
  // "What did I say about X" — she HAS the answer in past turns (and the passive recall block
  // injects it), but the 24B reflexively deflects to "let me check my notes / the calendar"
  // and ignores it. Same fix as act-on-page/inbox: pull what the USER actually said and feed
  // it back with a hard directive to state it directly — bypassing the deflection reflex.
  try {
    if (isRecallQuery(userMessage)) {
      const qv = await memoryLib.embed(userMessage).catch(() => null);
      if (qv && userTurnRow && userTurnRow.id) { try { db.setTurnEmbedding(userTurnRow.id, JSON.stringify(qv)); } catch {} }
      const recentIds = db.getRecentTurns(RECENT_TURN_LIMIT).map(t => t.id);
      const hits = qv ? await memoryLib.retrieveTurns(userMessage, { k: 4, excludeIds: recentIds, qv, userOnly: true, dropQuestions: true }) : [];
      if (hits.length) {
        const lines = hits.map(h => `  • You said: "${(h.content || '').replace(/\s+/g, ' ').slice(0, 240)}"`).join('\n');
        const resultText = `[${userName} asked you to recall what THEY said earlier about this. You DO remember it — here is what ${userName} actually said, pulled from your memory of this conversation:\n${lines}\n\nAnswer DIRECTLY from this, in your own voice — tell them what they said. Do NOT say you'll "check your notes", "verify with the calendar", or "double-check" — you already have it, right here. Just recall it to them.]`;
        db.setMeta('last_ai_utterance_at', String(Date.now()));
        resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
        try { await fireToolFollowup({ io, channel, sessionId, resultText }); } catch (e) { console.error('[recall] followup failed:', e.message); }
        console.log(`[recall] surfaced ${hits.length} user-statement turn(s) for "${userMessage.slice(0, 50)}"`);
        return { ok: true, recalled: true, say: null };
      }
    }
  } catch (err) { console.error('[recall] interceptor failed:', err.message); }
  // === END RECALL INTERCEPTOR ===

  // === PREFERENCE INTERCEPTOR (the "ghost command") ===
  // A taste question ("what's your favorite flower?") triggers the Instruct model's
  // "I'm an AI, I have no preferences" reflex, which the full chat prompt cannot
  // override (the identity-question FRAMING is the trigger). So on a NARROW set of
  // taste questions we answer from her self_model directly — speaking a held interest
  // or FORMING + storing a new one (she develops interests over time) — bypassing the
  // refusal. Narrow trigger = her work/research/tool turns are never affected.
  try {
    {
      const ans = await preferences.interceptSelf(userMessage, userName);
      if (ans && ans.say) {
        if (ans.thought) db.insertTurn({ sessionId, speaker: 'ai_thought', content: ans.thought, model: 'preference-interceptor' });
        const saidRow = db.insertTurn({ sessionId, speaker: 'ai_said', content: ans.say, model: 'preference-interceptor' });
        try { for (const ch of ans.say) emit(ch); sendComplete({ saidId: saidRow.id, truncated: 0, preferenceAnswered: true }); } catch {}
        db.setMeta('last_ai_utterance_at', String(Date.now()));
        resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
        console.log('[pref-intent] answered from self_model (bypassed the disclaimer reflex)');
        return { ok: true, preferenceAnswered: true, say: ans.say };
      }
    }
  } catch (err) { console.error('[pref-intent] interceptor failed:', err.message); }
  // === END PREFERENCE INTERCEPTOR ===

  // === PERSONAL-MODE TOGGLE ===
  // "go play" / "off the clock" enters her personal/play life; "back to work" exits.
  // We flip the flag and FALL THROUGH (no canned reply) so she answers in her own
  // voice with the personal block now active — stepping off the clock, not asking
  // for an assignment. Auto-expiring (lib/personal) so a forgotten toggle can't trap her.
  let personalJustToggled = false;
  try {
    const tog = personal.detectToggle(userMessage);
    if (tog) {
      personalJustToggled = true;
      // Entering → auto-start a stepwise play session (idle loop drives it one
      // hit at a time). Exiting → reset it so work mode isn't carrying play state.
      if (tog.transition === 'enter') playSession.start();
      else playSession.reset();
      console.log(`[personal] ${tog.transition} → personal_mode ${personal.isOn() ? 'ON' : 'OFF'} (play session ${playSession.active() ? 'started' : 'reset'})`);
    }
  } catch (err) { console.error('[personal] toggle failed:', err.message); }
  // === END PERSONAL-MODE TOGGLE ===

  // Detect URLs in user message; fetch them as shared-link context
  const sharedUrls = extractUrls(userMessage);
  const sharedPages = [];
  const who = userName || 'Lucas';
  for (const url of sharedUrls) {
    let page = null;
    try { page = await fetchPage(url, { maxChars: 2800, timeoutMs: 8000 }); }
    catch (err) { console.error('[main] user url fetch failed:', url, err.message); page = { ok: false, error: err.message }; }

    if (page && page.ok && page.text) {
      // Readable via background fetch — persist the content as a user-shared reading.
      sharedPages.push(page);
      db.insertMonologue({
        content: `${who} shared this link: ${page.title || page.url}\n${page.text}`,
        model: 'user-shared', type: 'reading', query: page.url, urls: [page.url],
      });
    } else {
      // Background fetch failed or returned nothing usable — common for Google Drive/Docs/Sheets
      // and other auth-walled / JS-app pages. Record THAT the link was shared and WHY it couldn't
      // be read, so the link's purpose stays in her context and she routes to her own signed-in
      // browser instead of going silent ("…") or flailing to check email. (This is the fix for
      // "struggling to open links / can't recall why she has them".)
      const isDrive = /\b(docs|drive|sheets)\.google\.com/i.test(url);
      const why = isDrive
        ? 'it is a Google Drive/Docs/Sheets page that needs MY OWN signed-in browser'
        : (page && page.error ? `background fetch said: ${page.error}` : 'background fetch returned nothing readable');
      db.insertMonologue({
        content: `${who} shared this link: ${url}\n[I could not read it with a background fetch — ${why}. To actually SEE it I open it in my own browser: <web-open>${url}</web-open> then <web-read/>. I must NOT go silent or check email instead — if I still can't see it, I tell ${who} plainly.]`,
        model: 'user-shared', type: 'reading', query: url, urls: [url],
      });
    }
  }

  const recentReflections = db.getRecentReflections(RECENT_REFLECTION_LIMIT);
  let recentMonologue = db.getRecentMonologueByType('thought', 5);
  let recentReadings = db.getRecentMonologueByType('reading', 2, { excludeConsolidated: true });
  const heldCommitments = db.getHeldCommitments(8);
  // REGISTER GATE (conversation harness, Piece 2): on a personal/social turn — a greeting or
  // check-in, not a work request — the work-goal scaffolding RECEDES so she's present instead
  // of reciting goals/professionalism at him. Her threads still drive her idle loop + tools;
  // they just stop colonizing a warm "how are you". (Root cause of the corporate-reply bug.)
  const socialTurn = isSocialTurn(userMessage);
  let openThreads = socialTurn ? [] : db.getActiveOpenThreads(3, { includeStalled: false });  // don't pull parked/stalled threads into chat replies (gated for relevance below, alongside recentMonologue/recentReadings)
  // WHERE-WE-ARE (conversation harness, Piece 3): the running summary of this conversation,
  // so she stays on-thread even after raw turns scroll out of the recency window.
  const convoStateBlock = require('./lib/convo_state').buildBlock(sessionId, userName);
  const protocols = db.getActiveProtocols();
  const pendingInbounds = db.getPendingInbounds(6);

  // If the user mentioned a URL or known tab title, update the tab-mention state
  // so Eloise can resolve tab="last" correctly
  try { browserLib.noteMention(userMessage); } catch {}
  // Tools block injected into her prompt: files + screen + scheduling + presence
  // (always available); email + discord (only when their creds are configured);
  // browser (only when connected).
  const fileBlock = filesLib.buildPromptBlock();
  const screenBlock = screenLib.buildPromptBlock();
  const schedBlock = schedulerLib.buildPromptBlock();
  const presenceBlock = presenceLib.buildPromptBlock();
  const emailBlock = emailLib.buildPromptBlock();           // null when unconfigured
  const inboxBlock = inboxLib.buildPromptBlock();           // null when unconfigured
  const discordConnBlock = discordLib.buildPromptBlock();   // null when unconfigured
  const browserConnBlock = browserLib.isConnected() ? browserLib.buildPromptBlock() : null;
  const browserBlock = [fileBlock, screenBlock, schedBlock, presenceBlock, emailBlock, inboxBlock, discordConnBlock, browserConnBlock].filter(Boolean).join('\n\n') || null;
  // Pull any attachment content the renderer sent up with this turn (text/md/json)
  const attachmentText = (Array.isArray(attachments) ? attachments : [])
    .map(a => `${userName || 'Lucas'} attached "${a.name || 'file'}":\n${(a.text || '').slice(0, 6000)}`)
    .join('\n\n---\n\n');
  // Pull recent turns BEFORE the just-inserted user turn; the new message is appended separately
  const recentTurnsAll = db.getRecentTurns(RECENT_TURN_LIMIT + 1);
  const recentTurns = recentTurnsAll.slice(0, -1); // drop the freshly-inserted user turn
  // ANTI-REPETITION (conversation harness): she has no view of her own recent phrasing and
  // settles into a stock template (reflect-back + "it's fascinating how…" + a question). Nudge
  // her off whatever pattern she's ACTUALLY overusing this stretch (null when her voice is varied).
  const varietyNudge = require('./lib/voice').buildAntiRepetitionNudge(
    recentTurns.filter(t => t.speaker === 'ai_said').map(t => t.content), userName);

  // CHAT-CORRECTION capture (reconciliation §7, chat lane) — when Lucas corrects a FACT ("no — Bondi stepped
  // down in April"), bank it as a HIGH-AUTHORITY verified_fact so recall LEADS with it next time (the live
  // precedence gate; capturedBy='chat-correction' → authority 3). Fire-and-forget: detection is cheap + pure,
  // extraction/write happen OFF the reply path so nothing blocks her response. Non-corrections and
  // cue-without-a-claim bank nothing (extraction gates the write). Fail-soft.
  try {
    const _bc = require('./lib/belief_correction');
    if (_bc.detectCorrection(userMessage, {}).isCorrection) {
      const _priorSay = (recentTurns.filter(t => t.speaker === 'ai_said').slice(-1)[0] || {}).content || '';
      const _learning = require('./lib/learning'), _mem = require('./lib/memory');
      Promise.resolve().then(() => _bc.captureCorrection({
        userMessage,
        priorAnswer: _priorSay,
        extractFn: (msg, { priorAnswer }) => _learning.extractClaims({ query: priorAnswer || msg, content: msg }),
        writeFact: (rec) => _mem.store(rec),
        lookupIncumbent: (k) => _learning.verifiedFactBySlot(k),                        // reconcile vs what we hold
        onSupersede: (ref) => _learning.retireVerifiedFact(ref, { by: 'chat-correction' }), // retire the stale one
      })).then(r => { if (r && r.captured) console.log(`[main] chat-correction: banked ${r.captured} verified fact(s) (cue: ${r.cue})`); })
        .catch(e => console.error('[main] chat-correction capture failed:', e && e.message));
    }
  } catch (e) { console.error('[main] chat-correction detect failed:', e && e.message); }

  // If the user shared links or attached files, surface them prominently in the message
  let composedUserMessage = userMessage;

  // If Lucas snapped her out of a thought, tell her so she surfaces naturally —
  // a brief "coming back" beat in her own voice, then answers. Not an apology loop.
  if (pulledFromThought) {
    composedUserMessage = `[${userName || 'Lucas'} just pulled you back from a deep thought to talk to you — you were absorbed in something and he wants your attention now. Surface naturally: a short, genuine "coming back to the room" beat in your own voice (you needn't say what you were lost in unless you want to), then answer him. Don't over-apologize.]\n\n${composedUserMessage}`;
  }
  // CHANNEL AWARENESS — tell her which surface this message reached her on, so she
  // doesn't reference the desktop UI while on Discord, and knows Discord is how she
  // reaches Lucas when he's away. Injected into the model-facing message only; the
  // stored user turn stays clean.
  if (channel === 'discord') {
    composedUserMessage = `[This message reached you over Discord DM — Lucas is messaging you from Discord, likely away from the desktop. Your reply goes back to him on Discord, so write for that: no references to the desktop window or sheep panel. If later, while he's quiet, you have something worth telling him, remember you can reach him here with <discord-dm>...</discord-dm>.]\n\n${composedUserMessage}`;
  }
  if (sharedPages.length > 0) {
    const linkBlocks = sharedPages.map(p =>
      `[I just looked at ${p.url} — title: "${p.title || '(no title)'}"]\n${p.text.slice(0, 2500)}`
    ).join('\n\n');
    composedUserMessage = `${userMessage}\n\n--- Pages I just fetched from links you shared ---\n${linkBlocks}`;
  }
  if (attachmentText) {
    composedUserMessage = `${composedUserMessage}\n\n--- Attachments ---\n${attachmentText}`;
  }
  // VISION IN — image attachments: actually SEE them via the vision model (cloud-first, local
  // fallback), then feed what she sees into the turn so she responds to the picture, not its
  // filename. Awaited (she needs the description to reply); bounded; fail-safe (she says she
  // couldn't see it rather than pretending).
  const imageAtts = (Array.isArray(attachments) ? attachments : [])
    .filter(a => a && (a.image || /^image\//.test(a.mime || '')) && (a.dataUrl || a.base64));
  if (imageAtts.length) {
    try {
      const vision = require('./lib/vision');
      const seen = [];
      for (const a of imageAtts.slice(0, 3)) {
        const r = await vision.describe({ imageBase64: a.dataUrl || a.base64 });
        seen.push(r.ok
          ? `[You looked at the image "${a.name || 'image'}" ${userName} sent you. What you actually see: ${r.text}]`
          : `[${userName} sent an image "${a.name || 'image'}" but you couldn't view it this time (${r.reason}). Tell him plainly you couldn't see it — do not pretend or guess at its contents.]`);
        console.log(`[main] vision-in "${a.name || 'image'}": ${r.ok ? r.tier + '/' + r.model + ' ok' : 'FAIL ' + r.reason}`);
      }
      if (seen.length) composedUserMessage = `${composedUserMessage}\n\n${seen.join('\n\n')}`;
    } catch (e) { console.error('[main] vision-in failed:', e.message); }
  }
  // CLOUD OWNS THE ANSWER on a factual turn — the enrich/recovery cognition loop below does the tool
  // work (search our graph, then the web) and hands the interface ONE grounded answer to voice. On such
  // turns the local model must NOT pick or emit Echo tags itself (the interface-uses-tools regression:
  // it was emitting <echo-find> and its async follow-up bled into the next turn). Non-factual turns
  // (curation / delegate / a deliverable) still carry the echo path until those move to the cloud too.
  const cloudOwnsAnswer = !socialTurn && ((() => { try { return require('./lib/metacognition').classifyClaimType(userMessage) === 'factual'; } catch { return false; } })() || ECHO_INVOKE_RE.test(userMessage));
  // ECHO NUDGE (F1) — when Lucas explicitly invokes the suit / our data ("use the db", "the power
  // suit", "our records/KB/graph", "echo"), bind that to the echo tags right at the message tail
  // (highest recency) so she reaches for Echo instead of defaulting to her web browser (the LAMP →
  // Japanese-band miss). Only when the suit is connected AND the cloud isn't already owning the answer.
  if (echoSuit && echoSuit.connected && ECHO_INVOKE_RE.test(userMessage) && !cloudOwnsAnswer) {
    composedUserMessage = `${composedUserMessage}\n\n[You are wearing the Echo suit and ${userName} is asking you to use it / OUR data — not the open web. Do this with your echo tags: <echo-find>what you need</echo-find> then <echo-do name="tool">{json}</echo-do> (or directly if you know the tool). Echo is our knowledge base / entity graph / contacts / bills / the LAMP network. Do NOT use <web-open> for this — that's the open internet, the wrong tool for our data.]`;
  }
  // RETRIEVE-OR-ADMIT (anti-confabulation) — a personal-fact question ("what's my daughter's
  // name?") must be answered from real memory or honestly declined, never guessed. She once
  // fabricated a child's name AND a fake "you just mentioned it" justification. The directive
  // rides at the message tail (highest recency) and is safe whether or not she holds the fact.
  let personalFactQ = false;
  try {
    const pf = require('./lib/personal_facts');
    if (pf.detectPersonalFactQuestion(userMessage)) {
      personalFactQ = true;
      composedUserMessage = `${composedUserMessage}\n\n${pf.groundingDirective(userName)}`;
    }
  } catch (e) { console.error('[main] personal-fact guard failed:', e.message); }

  // SELF-DEV (self-awareness Layer 2) — is Lucas asking about her own development / program /
  // what's changed? If so, her real changelog gets surfaced below so she answers from fact, not
  // half-remembered dev-talk. Detected here (cheap) so the metacognition gate can defer to it.
  let devQ = false;
  try { devQ = require('./lib/self_dev').detectDevQuestion(userMessage); } catch (e) { console.error('[main] self-dev detect failed:', e.message); }

  // SELF-STATE (self-awareness Layer 1) — is Lucas asking what she's doing / what's running / what
  // she can see? If so, her real live operational snapshot gets surfaced below so she reads her
  // state instead of inferring it. Detected here so the metacognition gate can defer.
  let stateQ = false;
  try { stateQ = require('./lib/self_state').detectStateQuestion(userMessage); } catch (e) { console.error('[main] self-state detect failed:', e.message); }

  // ACTIVITY (Slice I) — is Lucas asking what she's DOING right now? The cross-lane activity poll owns
  // that turn and answers from live lane state, so the competing generic grounding (RAG semantic noise,
  // self-dev changelog, self-state "Mode") is SUPPRESSED below — otherwise the grounded answer is just
  // one ingredient Dans narrates around (the live "Substack/Bulk API/meeting-notes" confab, 2026-06-29,
  // came from RAG pulling her self_dev nodes into a "what are you doing" answer).
  let activityQ = false;
  try { activityQ = require('./lib/activity').isActivityQuestion(userMessage); } catch (e) { console.error('[main] activity detect failed:', e.message); }

  // DELIVERABLE aggregate (Slice I) — count/list/facet/status are answered by the deliverable poll off
  // the Track's live artifact; suppress the competing RAG for those too, so a STALE dossier node
  // ("(5 orgs)" from an earlier run) can't override the live count (the "5 vs 12" miss, caught live).
  // SAMPLE ("what do you have on X") deliberately keeps RAG — its section answer benefits from the
  // enrichment and showed no competition (the MIRI answer was rich and correct).
  let deliverableAggQ = false;
  try { const dq = require('./lib/track').classifyQuery(userMessage); deliverableAggQ = dq.is && ['count', 'list', 'facet', 'status', 'rank'].includes(dq.kind); } catch {}

  const chosenName = db.getMeta('chosen_name');
  const awareness = buildAwarenessBlock({
    chosenName,
    sessionStartedAt: currentSessionStartedAt,
    cumulativeMs: db.getCumulativeSessionTime()
  });

  // SCOPED RETRIEVAL (Phase 1) — classify the question, then retrieve to fit it:
  //  • narrow/factual (a specific bill, a who/what question) → hybrid semantic+FTS (exact
  //    keyword boost for named entities) at small K — the precise leaf, not the topic.
  //  • broad/open → scored recency×relevance×importance at wider K (keeps her texture).
  const qClass = classifyQuery(userMessage);
  let retrievedKnowledgeBlock = null;
  let rkRows = [];   // captured for the calibration assessor below (grounding signal)
  let recallResult = null;   // OBJECT-FIRST recall (Phase 1) — the pulled Echo object + coverage, kept for the thin→enrich branch (Phase 2)
  try {
    if (qClass === 'narrow') {
      // OBJECT-FIRST memory access — the object-graph path finally wired into CONVERSATION (was
      // research-lane only). A narrow who/what question resolves its named entity to the canonical Echo
      // OBJECT in ONE cheap call (quick_lookup: facts + bio + committees + degree) and answers FROM the
      // whole record, not a 3-note local snapshot. coverage ('rich'|'thin') drives the wall→enrich reflex.
      // Fail-safe: Echo down / no entity → object null → falls back to the local notes recall() also gathers.
      const ar = require('./lib/active_recall');
      // recent conversation → the cloud extractor can bind pronouns/anaphora ("his cabinet" → Trump).
      const _recentCtx = (recentTurns || []).slice(-4).map(t => `${t.speaker || '?'}: ${String(t.content || '').replace(/\s+/g, ' ').slice(0, 160)}`).join('\n');
      recallResult = await ar.recall(userMessage, { k: 4, context: _recentCtx });
      // DROP internal research/focus artifacts — a research dossier / focus tombstone is stored at high
      // importance (0.85), so retrieveScored surfaces it for ANY entity query and it bled "Enrich 19
      // organizations" into unrelated turns (the Thune leak). These are her internal work artifacts, not
      // facts to relay in conversation.
      const cleanNotes = (recallResult.notes || []).filter(n => n && !/research_dossier|focus_tombstone|focus_state|tombstone|dossier/i.test(String((n && n.source) || '')));
      rkRows = cleanNotes.slice();
      const parts = [];
      // PRECEDENCE (reconciliation §5) — a fresh, cited verified_fact about this entity LEADS and supersedes
      // the stored dossier's stale role/office detail. Surfaced independently (and rkRows-first) so the
      // rich-object note suppression below can't drop it — the Pam Bondi bug was a rich object hiding the
      // correction entirely, leaving recall to serve the stale "is the AG" record.
      if (recallResult.precedenceFact) {
        const pf = recallResult.precedenceFact;
        parts.push(`MOST CURRENT — VERIFIED${pf.asOf ? ` as of ${pf.asOf}` : ''}. This is more recent than the stored record; trust it over any conflicting current-role/office detail below:\n  • ${pf.content}`);
        rkRows.unshift({ content: pf.content, source: 'verified_fact' });
      }
      const objLines = ar._objectLines(recallResult.object);
      if (objLines.length) {
        parts.push('What you already hold on this — your memory-graph record (answer directly FROM this, it is yours):\n' + objLines.join('\n'));
        rkRows.unshift({ content: objLines.join(' '), source: 'object' });   // so the grounding assessor counts the pulled object
      }
      // Include the artifact-filtered notes UNLESS the object is already RICH — a rich object is
      // authoritative (facts + bio + committees + neighbors) and supplementary notes are exactly where
      // off-topic importance-boosted globs sneak in (the Thune leak). A thin/stub object or no object
      // still needs its notes (e.g. an entity we only hold via a dropped document → Russ Walker case).
      if (!ar._objectRich(recallResult.object)) {
        const noteLines = cleanNotes.slice(0, 6)
          .map(n => { const c = String((n && n.content) || '').replace(/\s+/g, ' ').trim().slice(0, 200); return c ? `  • ${c}` : ''; })
          .filter(Boolean);
        if (noteLines.length) parts.push('Related from your memory:\n' + noteLines.join('\n'));
      }
      // DATA STREAMS (integration fix) — landed DOCUMENTS (meeting notes / research dossiers / API / email)
      // + tracked NEWS relevant to this entity, surfaced INDEPENDENTLY of the object so a rich KG record can't
      // hide them (chat answering was blind to news_bucket + the documents table). Capped; artifact-tagged.
      if (recallResult.streamHits && recallResult.streamHits.length) {
        const sLines = recallResult.streamHits.slice(0, 5)
          .map(h => { const c = String((h && h.content) || '').replace(/\s+/g, ' ').trim().slice(0, 240); return c ? `  • [${h.source || 'stream'}] ${c}` : ''; })
          .filter(Boolean);
        if (sLines.length) { parts.push('From your live data streams (news + documents you hold on this):\n' + sLines.join('\n')); recallResult.streamHits.forEach(h => rkRows.unshift({ content: h.content, source: h.source })); }
      }
      retrievedKnowledgeBlock = parts.length ? parts.join('\n\n') : null;
    } else {
      // Broad/open turn — scored recency×relevance×importance retrieval keeps her texture (unchanged).
      const rk = await memoryLib.retrieveScored(userMessage, { k: 6, minRelevance: 0.35 });
      rkRows = rk || [];
      retrievedKnowledgeBlock = memoryLib.formatForPrompt(rk, userName);
    }
  } catch (err) { console.error('[main] knowledge retrieve failed:', err.message); }

  // POLL OWNS THE TURN: when the activity poll or an aggregate deliverable poll (count/list/facet/
  // status) will answer from the live Track, suppress the generic semantic retrieval — it pulls
  // self_dev/dev nodes ("batching and Bulk API…") or a stale "(5 orgs)" dossier node that Dans then
  // relays over the live truth. The grounded answer must DOMINATE, not compete.
  if (activityQ || deliverableAggQ) { retrievedKnowledgeBlock = null; rkRows = []; }

  // PROMINENCE / IDENTITY note (R1) — a bare famous name resolved (in our civic KG) to a low-prominence
  // same-name record; recall() declined the namesake and surfaced who is actually meant (Wikidata-verified).
  // Prepend so the grounded answer is ABOUT the prominent referent and only footnotes the record we hold.
  // Rides the same knowledge-block rail as the self-dev / self-state blocks below.
  if (recallResult && recallResult.identityNote) {
    retrievedKnowledgeBlock = retrievedKnowledgeBlock ? `${recallResult.identityNote}\n\n${retrievedKnowledgeBlock}` : recallResult.identityNote;
    console.log('[main] prominence: declined civic namesake, answering the prominent referent');
  }
  // AMBIGUOUS ENTITY → ASK, don't guess (bias-to-clarify). When the object pull found 2+ genuinely-different
  // same-name entities we hold (distinct QIDs — e.g. two real people named "John Kennedy"), she can't tell
  // which he means, so she asks rather than silently picking one. Fires ONCE and suppresses the answer draft.
  if (recallResult && recallResult.ambiguous && recallResult.ambiguous.candidates && recallResult.ambiguous.candidates.length >= 2 && !followupFired && !socialTurn) {
    const amb = recallResult.ambiguous;
    const cg = require('./lib/concept_ground');
    // ASK only when it's a genuine collision of 2+ distinct PEOPLE (a lookup can't tell which he means).
    // For a CONCEPT collision (e.g. "the AI arms race" + a junk namesake), don't dump disambiguation on
    // him — GROUND it herself: look it up → create a verified node (citation) or an unverified concept →
    // proceed on that. (Lucas's resolve-or-create spec.)
    const action = cg.disambiguationAction({ status: 'ambiguous', candidates: amb.candidateObjs || [] });
    if (action === 'ask') {
      console.log(`[main] ambiguous entity "${amb.mention}" → ASK (${amb.candidates.length} distinct people)`);
      followupFired = true;
      try { await fireToolFollowup({ io, channel, sessionId, resultText: `[${userName} asked about "${amb.mention}", but you hold more than one distinct person/entity by that name: ${amb.candidates.join('; ')}. You genuinely can't tell which he means. Ask him which one — name the options briefly. Do NOT guess or answer about either yet. One or two sentences, your voice.]` }); }
      catch (e) { console.error('[main] ambiguity ASK failed:', e.message); }
    } else {
      try {
        const g = await cg.groundAndCreate(amb.mention, { deps: {
          search: (m) => webSearch(m),
          create: (node) => echoSuit.dispatch({ kind: 'do', name: 'propose_entity', args: { name: node.name, entity_type: node.entity_type || 'concept', summary: node.summary || '', source: node.source || '' } }),
        } });
        if (g && g.node) {
          const line = g.verified
            ? `WHAT "${amb.mention}" IS — you just looked it up (${g.node.source}): ${g.node.summary || amb.mention}. Treat it as this; you've recorded it. Answer/act on it directly.`
            : `You didn't have "${amb.mention}" clearly grounded and couldn't pull a citation just now. Treat it as an UNVERIFIED concept: proceed on its most likely public meaning and note lightly that you'll confirm the specifics. Do NOT ask ${userName} to pick between namesakes.`;
          retrievedKnowledgeBlock = retrievedKnowledgeBlock ? `${line}\n\n${retrievedKnowledgeBlock}` : line;
          console.log(`[concept-ground] "${amb.mention}" → ${g.verified ? 'grounded+verified' : 'unverified concept'} (no ASK)`);
        }
      } catch (e) { console.error('[concept-ground] failed:', e.message); }
    }
  }

  // SELF-DEV LEDGER — on a question about her own development, prepend her real changelog (by
  // recency) so "what have you been working on / what's new with you / how have you changed" is
  // answered from genuine history. Reuses the knowledge-block injection path (no signature churn).
  if (devQ && !activityQ) {
    try {
      const selfDev = require('./lib/self_dev');
      const block = selfDev.buildBlock(selfDev.recentEntries(8), userName);
      if (block) { retrievedKnowledgeBlock = retrievedKnowledgeBlock ? `${block}\n\n${retrievedKnowledgeBlock}` : block; console.log('[main] self-dev ledger surfaced'); }
    } catch (e) { console.error('[main] self-dev block failed:', e.message); }
  }

  // SELF-STATE LEDGER — on a "what can you see / what's running / status" question, prepend her real
  // live operational snapshot. Skipped when it's an ACTIVITY question (the activity poll owns those,
  // and the "Mode: working" line seeds the confab) — self-state still serves pure can-you-see turns.
  if (stateQ && !activityQ) {
    try {
      const ss = require('./lib/self_state');
      const block = ss.buildBlock(ss.snapshot({
        echoConnected: !!(echoSuit && echoSuit.connected),
        sharedBrowser: browserLib.isConnected(),
        ownBrowser: webLib.isConnected()
      }), userName);
      if (block) { retrievedKnowledgeBlock = retrievedKnowledgeBlock ? `${block}\n\n${retrievedKnowledgeBlock}` : block; console.log('[main] self-state snapshot surfaced'); }
    } catch (e) { console.error('[main] self-state block failed:', e.message); }
  }

  // SELF-MODEL block — query-relevant self entries (so a question about a specific
  // taste/preference surfaces THAT entry, e.g. "favorite flower" → her ranunculus)
  // plus her always-on core self. Async (embeds the query).
  let selfModelBlock = null;
  try { selfModelBlock = await require('./lib/self_model').buildContextBlock(userMessage); }
  catch (e) { console.error('[main] self-model block failed:', e.message); }

  // SELF-NARRATIVE (self-awareness Layer 4) — pin her unified first-person self-account (composed
  // from her own memory, refreshed on a TTL) as the identity anchor ABOVE the query-relevant self
  // fragments, so who-she-is is continuous, not reassembled per turn.
  try {
    const sn = require('./lib/self_narrative');
    const narr = sn.current();
    if (narr) { const nb = sn.buildBlock(narr, userName); if (nb) selfModelBlock = selfModelBlock ? `${nb}\n\n${selfModelBlock}` : nb; }
  } catch (e) { console.error('[main] self-narrative anchor failed:', e.message); }

  // MOOD (self-awareness Layer 5) — her LIVING feeling, cloud-cultivated slowly over time. Passed
  // SEPARATELY so it LEADS the voice (placed right under the core persona, above the factual self-model):
  // mood colors HOW she speaks. It is NOT identity — never written to self_model.
  let moodBlock = null;
  try { const md = require('./lib/mood'); moodBlock = md.buildBlock(md.current(), userName); }
  catch (e) { console.error('[main] mood block failed:', e.message); }

  // PERSONAL-LIFE block — when she's off the clock, reframe the chat toward play
  // and suppress the work reflexes. Null when on the clock (no behavior change).
  let personalBlock = null;
  try { if (personal.isOn()) personalBlock = personal.buildChatBlock(userName, { justToggled: personalJustToggled }); }
  catch (e) { console.error('[main] personal block failed:', e.message); }

  // CAPABILITY PROPOSAL ON RETURN: if Lucas was away a while and she logged a
  // capability gap during idle, surface the top one for her to PROPOSE (her call).
  let capabilityProposalBlock = null;
  if (idleSinceLastTurn > RETURN_IDLE_MS && !socialTurn) {
    try { capabilityProposalBlock = gapsLib.buildReturnProposalBlock(userName); } catch (e) { console.error('[main] gap proposal failed:', e.message); }
  }

  // ── SINGLE-DISPATCH TURN ROUTER (turn→object-graph Phase A) ──────────────────────────────────────
  // Classify the turn ONCE into a single route so the work-machinery blocks below (intake, deliverable-
  // poll, operator, directed-focus) are MUTUALLY EXCLUSIVE with the conversational/answer path — no more
  // competing directives stapled onto one composedUserMessage (the proven "who is Trump → also list 19
  // orgs" bug). Built from the cheap signals already computed here; isAssignment uses the isDirectedTask
  // regex as an early proxy (the precise cloud intake still runs below, gated on route==='task').
  // Reversible via the `turn.router` meta flag (default on) → when off, the gates are no-ops (old flow).
  const routerOn = (() => { try { return (db.getMeta('turn.router') || 'on').trim() !== 'off'; } catch { return true; } })();
  const _factualR = (() => { try { return require('./lib/metacognition').classifyClaimType(userMessage) === 'factual'; } catch { return false; } })();
  const _liveInfoR = (() => { try { return require('./lib/curiosity').isLiveInfoQuestion(userMessage); } catch { return false; } })();
  const _hasDirectedFocusR = (() => { try { const fl = require('./lib/focus'); const f = fl.getCurrent(); return !!(f && fl.isDirected(f)); } catch { return false; } })();
  const _isStatusReqR = _hasDirectedFocusR && (() => { try { return require('./lib/research').isStatusRequest(userMessage); } catch { return false; } })();
  const _isDirectedTaskR = (() => { try { return require('./lib/operator').isDirectedTask(userMessage); } catch { return false; } })();
  // CONTACTS INTENT — LLM-PRIMARY (lib/contacts_intent), with the regex (contacts_query.detect) DEMOTED to
  // the fail-safe fallback. A cheap high-recall pre-signal gates the cloud call to plausibly-contact turns
  // (so "good morning" never pays for it). Precedence: cloud-down/error → regex fallback (list still works
  // locally); LLM says list → trust its filters (primary); LLM says NOT-list → honor it, but the strict regex
  // is a recall safety net for the rare LLM false-negative. Execution stays local regardless.
  const _contactish = /\b(contacts?|people|persons?|leads?|roster|rolodex|directory|targets?|orgs?|organi[sz]ations?|compan(?:y|ies)|corporat|firms?|officials?|legislators?|senators?|representatives?|governors?|mayors?|electeds?|sheet|spreadsheet|\blists?\b|listing|\bcsv\b|\btable\b|who (?:do we|are we|'?s our|are our)|private sector|\belected\b)\b/i.test(userMessage);
  let _contactsQ = { isQuery: false };
  if (_contactish) {
    const _rx = () => { try { return require('./lib/contacts_query').detect(userMessage); } catch { return { isQuery: false }; } };
    let _llmC = null;
    try { _llmC = await require('./lib/contacts_intent').classify(userMessage, { recent: '' }); }
    catch (e) { console.error('[contacts-intent] call failed:', e.message); _llmC = null; }
    if (_llmC == null) _contactsQ = _rx();                                   // cloud down → regex fallback
    else if (_llmC.isQuery) _contactsQ = _llmC;                              // LLM says list → its filters (PRIMARY)
    else { const _r = _rx(); _contactsQ = _r.isQuery ? _r : { isQuery: false }; }   // LLM says no → honor, regex catches a miss
    if (routerOn && _contactsQ.isQuery) console.log(`[contacts-intent] ${_llmC && _llmC.isQuery ? 'LLM' : 'regex'} → list (type=${_contactsQ.type || '-'} grade=${_contactsQ.grade || '-'} state=${_contactsQ.state || '-'} sectors=${(_contactsQ.sectors || []).join('/') || '-'})`);
  }
  let turnRoute = require('./lib/turn_router').computeTurnRoute({
    socialTurn, activityQ, deliverableAggQ,
    factual: _factualR, personalFactQ, devQ, stateQ,
    isLiveInfo: _liveInfoR, isStatusReq: _isStatusReqR,
    hasDirectedFocus: _hasDirectedFocusR, isAssignment: _isDirectedTaskR, isContactsQuery: _contactsQ.isQuery
  });
  if (routerOn) console.log(`[turn-router] route=${turnRoute.route} (${turnRoute.reason}, conf ${turnRoute.confidence})`);
  const routeAllows = (r) => !routerOn || turnRoute.route === r;
  const routeAllowsAny = (...rs) => !routerOn || rs.includes(turnRoute.route);

  // CONTACTS — served LOCAL and EARLY, before ANY cloud call. A "list the contacts we hold" request is
  // pure Puller/CRM data; it must NOT depend on the cognition/grounding cloud path. (Regression: with the
  // cloud endpoint down (ECONNREFUSED), an unguarded upstream fetch aborted the whole turn → the list
  // request died as "fetch failed" even though the answer is entirely local.) Router priority already put
  // control/correction/stop ABOVE contacts, so if the route is 'contacts' this is not one of those turns —
  // safe to short-circuit here. The canvas emit is local IPC; only the voice line (fireToolFollowup) uses
  // the model, and it runs AFTER the table lands + is wrapped, so a cloud outage still leaves the list.
  let contactsHandled = false;
  if (routerOn && turnRoute.route === 'contacts' && !followupFired) {
    try {
      const cq = require('./lib/contacts_query');
      const ask = _contactsQ && _contactsQ.isQuery ? _contactsQ : cq.detect(userMessage);
      const rows = await gatherHeldContacts();
      const sel = cq.select(rows, { sectors: ask.sectors, company: ask.company, limit: ask.limit || 200,
        grade: ask.grade, gradeDir: ask.gradeDir, type: ask.type, state: ask.state });
      const lbl = cq.label(ask);
      // HONESTY (now narrow): grade/type/sector/state/company ARE applied. Only county has no field to filter
      // on — disclose that if asked, instead of silently ignoring it.
      const unmet = cq.unmetFilters(userMessage);
      // CAPABILITY GAP — "if we're missing data, we find it." A state was asked but `geoGap` contacts matched
      // every OTHER filter and simply have no location on file (they can't be placed). Instead of silently
      // dropping them, SURFACE that missing data-point and FLOAT an enrichment offer, so a plain "yes/begin"
      // commits a research run (via the brainstorm offer-commit path) that goes and fills the location in.
      const geoGap = (sel && sel.geoGap) || 0;
      let gapNote = '';
      if (ask.state && geoGap > 0) {
        gapNote = ` DATA GAP to state plainly AND offer to fix: ${geoGap} of the matching contacts (the private/corporate ones) have NO location on file, so you could not place them in ${ask.state}. Ask if he wants you to research their locations to fill that gap — if he says yes, you'll start a run.`;
        try {
          db.setMeta('brainstorm.open_offer', JSON.stringify({
            shape: 'discover', kind: 'entity',
            target: `location for our held ${ask.type === 'corporate' ? 'corporate ' : ''}contacts`,
            facet: `find the state/region (HQ or office) for the ~${geoGap} held contacts that carry no location, so they can be filtered to ${ask.state} and other states`,
            deep: false, ts: Date.now(),
          }));
          console.log(`[contacts-query] GEO GAP ${geoGap} (${ask.state}) → floated an enrichment offer`);
        } catch (e) { console.error('[contacts-query] gap offer set failed:', e.message); }
      }
      if (sel.total > 0) {
        const tbl = cq.toTable(sel);
        const tabKey = `contacts-${lbl.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 32)}-${Date.now().toString(36)}`;
        try { const callTool = pollCallTool(); await callTool('saga_canvas_open_tab', { mode: 'DOC', tab_key: tabKey, title: lbl }); await callTool('saga_canvas_add_block', { tab_key: tabKey, block_type: 'table', data: { headers: tbl.headers, rows: tbl.rows, caption: tbl.caption } }); }
        catch (e) { console.error('[contacts-query] canvas emit failed:', e.message); }
        console.log(`[contacts-query] "${lbl}" → ${sel.shown}/${sel.total} on canvas (${sel.withEmail} w/ email)${unmet.length ? ` [unmet: ${unmet.join(', ')}]` : ''}`);
        followupFired = true; contactsHandled = true;
        const honesty = unmet.length
          ? ` ONE caveat to state plainly: he also asked to narrow by ${unmet.join(' and ')}, but you have no ${unmet.join(' or ')}-level tag on these contacts, so the list is NOT filtered by that.`
          : (gapNote ? '' : ' Offer to research more or narrow it further if he wants.');
        try { await fireToolFollowup({ io, channel, sessionId, resultText: `[You put ${sel.total} ${lbl} you ALREADY HAVE onto ${userName}'s canvas${sel.total > sel.shown ? ` (showing the top ${sel.shown})` : ''} — ${sel.withEmail} with emails. This list IS filtered to what he asked (${lbl}). Tell him briefly you put it on his canvas; these are contacts you already hold, NOT a new research run.${honesty}${gapNote} Your own voice, one or two sentences.]` }); }
        catch (e) { console.error('[contacts-query] voice line failed (list already on canvas):', e.message); }
      } else {
        followupFired = true; contactsHandled = true;
        const noneMsg = gapNote
          ? `[${userName} asked for ${lbl}. You hold none that you can place in ${ask.state} — but that's a DATA GAP, not an absence:${gapNote} Tell him plainly and make the offer. One or two sentences.]`
          : `[${userName} asked for ${lbl}, but you don't hold any matching contacts yet. Tell him plainly you don't have those on hand, and ASK whether you should research them (that would kick off a run) — don't start researching without his go. One or two sentences.]`;
        try { await fireToolFollowup({ io, channel, sessionId, resultText: noneMsg }); }
        catch (e) { console.error('[contacts-query] voice line failed:', e.message); }
      }
    } catch (e) { console.error('[contacts-query] handler failed:', e.message); }
  }

  // SOCIAL-ENRICH (maigret leaf, on-demand) — "find social/online accounts for <Name>". Local + sidecar;
  // handled EARLY (before the cloud intake) so it can't be misread as a research assignment. The maigret
  // run is slow (network to N sites), so we ACK now and run it fire-and-forget, reporting on completion.
  // Consume-only: corroborated survivors stage as grade-E Puller observations (verify-before-promote).
  let socialEnrichHandled = false;
  if (!followupFired && !contactsHandled) {
    let _se = { isEnrich: false };
    try { _se = require('./lib/enrich_maigret').detectSocialEnrich(userMessage); } catch {}
    if (_se.isEnrich && _se.target) {
      followupFired = true; socialEnrichHandled = true;
      try { await fireToolFollowup({ io, channel, sessionId, resultText: `[${userName} asked you to find social/online accounts for "${_se.target}". Tell him briefly you're checking public profiles for handles you already hold and will surface only matches you can corroborate (2+ signals) — one sentence.]` }); }
      catch (e) { console.error('[social-enrich] ack failed:', e.message); }
      runSocialEnrich(_se.target).then(async (r) => {
        try {
          if (!r || !r.found) { await fireToolFollowup({ io, channel, sessionId, resultText: `[You looked but couldn't find "${_se.target}" among the contacts you hold, so there was nothing to enrich. Tell him plainly, one sentence.]` }); return; }
          const n = (r.staged || []).length;
          await fireToolFollowup({ io, channel, sessionId, resultText: `[Done enriching ${r.name}: ${n} corroborated public account(s)${n ? ' — ' + r.staged.map((s) => s.site).join(', ') : ''}. ${n ? "They're staged on his card as UNVERIFIED (grade E) for review — not promoted." : 'Nothing cleared the corroboration bar, so nothing was staged.'} One or two sentences, your voice.]` });
        } catch (e) { console.error('[social-enrich] report failed:', e.message); }
      }).catch((e) => console.error('[social-enrich] run failed:', e.message));
    }
  }

  // ── OPTION 2 — the LLM is the assignment classifier, not the narrow isDirectedTask regex ────────────
  // The regex only fed the router's isAssignment signal, so a genuine assignment it didn't match ("deep
  // background brief on Emergence Water") never reached the cloud intake and fell through to chat — she
  // acknowledged it and started NOTHING (confabulation). Fix: kick the intake classification CONCURRENTLY
  // here so it overlaps the grounding/distill/answer-draft awaits below (~1s call → ~no added latency), on
  // any substantive, non-social candidate turn (converse/answer/task — where a real assignment can hide).
  // Its decision OVERRIDES the route to 'task' at the intake gate below. Speculative — the result is used
  // only if no control/correction handler claims the turn first. The regex survives as an in-gate fallback
  // (cloud down) and the router fast-path, never again the sole veto. Fail-safe: cloud null → regex.
  let intakeClassifyPromise = null;
  try {
    const _opOnKick = (db.getMeta('operator.mode') || 'full').trim() !== 'off';
    if (routerOn && _opOnKick && !socialTurn && userMessage && userMessage.trim().length > 6 && routeAllowsAny('task', 'converse', 'answer')) {
      const _intake = require('./lib/intake');
      const _af = (() => { try { const f = require('./lib/focus').getCurrent(); return f ? String(f.content || '') : ''; } catch { return ''; } })();
      const _recentK = (recentTurns || []).slice(-3).map(t => `${t.speaker || '?'}: ${String(t.content || '').slice(0, 120)}`).join(' | ');
      const _existingRecords = (qClass === 'narrow') ? '' : (() => {
        try {
          const ld = JSON.parse(db.getMeta('research.last_dossier') || 'null');
          if (!ld || !ld.focusId) return '';
          let txt = ''; try { const r = filesLib.fileReadFull(`notes/directed-${ld.focusId}-dossier.md`); txt = (r && r.text) || ''; } catch {}
          const orgs = require('./lib/condense').dossierOrgs(txt).slice(0, 25);
          return orgs.length ? `"${String(ld.goal || '').slice(0, 80)}" — covering: ${orgs.join(', ')}` : '';
        } catch { return ''; }
      })();
      intakeClassifyPromise = _intake.classify(userMessage, { recent: _recentK, activeFocus: _af, existingRecords: _existingRecords }).catch(() => null);
    }
  } catch (e) { console.error('[intake] concurrent kick failed:', e.message); }

  // EPISODIC RECALL — embed THIS user message (store it on the turn for future recall),
  // and pull the few most-relevant PAST turns that scrolled out of the recency window, so
  // "what did we say earlier about X" works instead of diverting to a tool.
  let relevantPastTurns = [];
  let userQv = null;
  try {
    userQv = await memoryLib.embed(userMessage).catch(() => null);
    if (userQv && userTurnRow && userTurnRow.id) { try { db.setTurnEmbedding(userTurnRow.id, JSON.stringify(userQv)); } catch {} }
    // RECALL queries ("what did I say about X") → restrict to the user's own statements so
    // her past deflections + other questions don't crowd out the actual answer.
    const recall = isRecallQuery(userMessage);
    if (userQv) relevantPastTurns = await memoryLib.retrieveTurns(userMessage, { k: recall ? 4 : 3, excludeIds: recentTurns.map(t => t.id), qv: userQv, userOnly: recall, dropQuestions: recall });
  } catch (e) { console.error('[main] episodic recall failed:', e.message); }

  // CALIBRATED METACOGNITION (self-awareness, Layer 3) — match her assertiveness to her ACTUAL
  // grounding, computed from what this turn already retrieved. A factual question with nothing
  // grounded → tell her to admit the gap, not confabulate; partial grounding → separate what she
  // knows from what she's inferring; rich grounding or non-factual turns → no directive (never
  // over-hedge). Generalizes the personal-fact guard to all factual claims; skipped when that
  // already fired or it's a social turn.
  if (!personalFactQ && !devQ && !stateQ && !socialTurn) {
    try {
      const meta = require('./lib/metacognition');
      const dir = meta.groundingDirective({ userMessage, knowledgeRows: rkRows, pastTurns: relevantPastTurns, userName });
      if (dir) {
        composedUserMessage = `${composedUserMessage}\n\n${dir}`;
        console.log(`[main] calibration: ${meta.assessGrounding({ knowledgeRows: rkRows, pastTurns: relevantPastTurns }).level} grounding → directive injected`);
      }
    } catch (e) { console.error('[main] metacognition directive failed:', e.message); }
  }

  // ACTION HONESTY — if Lucas asked her to watch/find/open/read something and the turn fell through
  // to a normal reply (no interceptor/tool fired above), guard against narrating first-hand results
  // she never produced (the "I watched the clips, here are the scenes" confabulation). She should
  // emit the real tag, or say plainly she can't and offer what she genuinely can do.
  try {
    const preNote = mediaWatchNote || listenNote;
    if (preNote) {
      // A real action fired this turn (watch started, or listen start/stop) → she acknowledges THAT,
      // which supersedes the generic honesty guard (no contradiction about whether she has the tool).
      composedUserMessage = `${composedUserMessage}\n\n${preNote}`;
      console.log('[main] action acknowledgment note injected');
    } else {
      const meta = require('./lib/metacognition');
      const adir = meta.actionHonestyDirective({ userMessage, userName });
      if (adir) { composedUserMessage = `${composedUserMessage}\n\n${adir}`; console.log('[main] action-honesty directive injected'); }
    }
  } catch (e) { console.error('[main] action-honesty directive failed:', e.message); }

  // WATCHING-QUESTION GROUND — "what are you watching?" while a video is active. Dans tends to read
  // the leading "what are you…" as an identity prompt and recite her self-narrative. Force the answer
  // onto the actual on-screen content (her captions/understanding are already in context).
  try {
    const mcl = require('./lib/media_cc');
    if (mcl.active() && mcl.detectWatchingQuestion(userMessage)) {
      composedUserMessage = `${composedUserMessage}\n\n[${userName} is asking about the VIDEO you're watching RIGHT NOW. Answer with what the captions / your running understanding (above in your context) ACTUALLY show — concretely, in a sentence or two. Do NOT answer with a description of yourself, your nature, or your interests; that is not what he asked. If the captions don't make it clear yet, say so plainly.]`;
      console.log('[main] watching-question ground directive injected');
    }
  } catch (e) { console.error('[main] watching-question ground failed:', e.message); }

  // OPEN-QUESTION SURFACING (conversation harness, Piece 1) — if she asked Lucas something on
  // a prior turn, his message is very likely the answer. Surface it (exactly once) as
  // high-recency state so a terse reply binds to her question instead of floating free;
  // takePending resolves it in the same breath so it doesn't nag next turn.
  let openQuestionBlock = null;
  try {
    const pend = require('./lib/open_questions').takePending(sessionId, userTurnRow && userTurnRow.id);
    openQuestionBlock = require('./lib/open_questions').buildBlock(pend, userName);
  } catch (e) { console.error('[main] open-question surface failed:', e.message); }

  // SCOPED CONTEXT — relevance-gate the recency blocks (recent monologue + readings) against the message
  // so off-topic between-turn musing can't ride along ("picking up random stuff"). Runs on EVERY turn.
  // A recent thought genuinely related to what's being said still clears 0.4 and comes through, so
  // relevant texture survives. NOTE: openThreads is deliberately NOT gated here — the cosine test can't
  // discriminate short task-shaped sentences (an unrelated "identify contacts for institutes" scores
  // 0.44–0.59 against "list the companies in the article", well above 0.4), so gating it did nothing.
  // The open-threads → chat leak is handled structurally in the Lane split instead (grounding-critical
  // turns don't carry standing-work primacy), not by an ineffective embedding gate.
  if (userQv) {
    const gate = async (rows) => {
      const out = [];
      for (const r of rows || []) {
        try { const v = await memoryLib.embed(r.content || ''); if (v && memoryLib.cosine(userQv, v) >= 0.4) out.push(r); }
        catch { out.push(r); }
      }
      return out;
    };
    try { recentMonologue = await gate(recentMonologue); recentReadings = await gate(recentReadings); }
    catch (e) { console.error('[main] recency gate failed:', e.message); }
  }

  // CONTEXT DISTILLATION (Front/Cortex P1) — the front model is overloaded by the bulky variable
  // context. On a heavy turn, a fast cloud "utility" model distills it into a tight BRIEF that
  // replaces the firehose (knowledge/past-turns/thoughts/readings/threads/positions/reflections);
  // the anchors (awareness, persona, self-model, self-narrative, protocols, live dialogue) stay.
  // Fail-safe: cloud down → null → full local context unchanged. Skipped on light/social turns.
  let distilledBrief = null;
  try {
    const distillLib = require('./lib/distill');
    const distillBlocks = { knowledge: retrievedKnowledgeBlock, monologue: recentMonologue, readings: recentReadings, pastTurns: relevantPastTurns, threads: openThreads, commitments: heldCommitments, reflections: recentReflections };
    if (!socialTurn && distillLib.shouldDistill(distillBlocks)) {
      distilledBrief = await distillLib.distill({ userMessage, blocks: distillBlocks });
      if (distilledBrief) console.log(`[main] context distilled → brief ${distilledBrief.length}c (from ~${distillLib.contextSize(distillBlocks)}c of context)`);
    }
  } catch (e) { console.error('[main] distill step failed:', e.message); }

  // CLOUD-DRAFTED ANSWER (Front/Cortex — "cloud thinks, local speaks" for the ANSWER). On a
  // grounding-critical turn the local voice (Dans) tends to confabulate over injected context, so the
  // CLOUD drafts the grounded answer and the front model just VOICES it. v1 fires for an active-watch
  // "what are you watching?" (grounding = her real captions/understanding). Fail-safe: no draft → normal.
  // A status/list question about a RUNNING directed task gets its own grounded path below (frontier
  // report + the real covered list). Compute it early so the answer-draft and operator paths step
  // aside — otherwise they each inject a competing directive and the 24B confabulates/echoes them.
  const _directedFocus = (() => { try { const fl = require('./lib/focus'); const f = fl.getCurrent(); return (f && fl.isDirected(f)) ? f : null; } catch { return null; } })();
  const _isStatusReq = !!_directedFocus && (() => { try { return require('./lib/research').isStatusRequest(userMessage); } catch { return false; } })();

  try {
    const ad = require('./lib/answer_draft');
    let drafted = false;
    // (1) active-watch "what are you watching?" → draft from her REAL captions/understanding
    const mcl = require('./lib/media_cc');
    if (mcl.active() && mcl.detectWatchingQuestion(userMessage)) {
      const u = (db.getMeta('media_understanding') || '').trim();
      const recent = (db.getMeta('media_recent') || '').trim();
      const grounding = [u && ('Running understanding of what is on screen: ' + u), recent && ('Most recent captions: ' + recent)].filter(Boolean).join('\n');
      if (grounding) {
        const d = await ad.draft({ userMessage, grounding, kind: 'watching' });
        if (d) { composedUserMessage = `${composedUserMessage}\n\n${ad.buildVoiceBlock(d, userName)}`; drafted = true; console.log(`[main] cloud-drafted watching answer → "${d.slice(0, 70)}"`); }
      }
    }
    // (2) factual / shared-history turn WITH retrieved grounding → draft the faithful answer FROM her
    // memory (closes both confabulation AND over-hedging where she actually has the facts). Only fires
    // when real grounding exists — no grounding → normal flow (general knowledge / admit-the-gap).
    if (!drafted && !socialTurn && !followupFired && !_isStatusReq) {
      if (cloudOwnsAnswer || personalFactQ) {
        // Grounding sources: her object/knowledge block + relevant past turns + READINGS she holds (the
        // article/page the question is about).
        const grounding = ad.factualGrounding({ knowledgeBlock: retrievedKnowledgeBlock, pastTurns: relevantPastTurns, readings: recentReadings });
        // ENRICH/RECOVERY loop (lib/cognition, turn→object Phase 2+4): draft from grounding, OR go FIND
        // what's missing (our graph → web) then draft — so a wall becomes "let me find out", never a
        // dead-end ("records don't specify") or a confabulation. Runs when the turn is about an object we
        // hold, has real grounding, or needs a current/personal lookup; a timeless general-knowledge Q
        // with no object stays on the model's own knowledge. Fail-safe: cloud/Echo down → null → local flow.
        let _scope = 'general';
        try { _scope = require('./lib/metacognition').groundingScope(userMessage); } catch {}
        const _runEnrich = cloudOwnsAnswer || personalFactQ || !!(recallResult && recallResult.object) || !!(grounding && grounding.length) || _scope !== 'general';
        if (_runEnrich) {
          try {
            const res = await require('./lib/cognition').answerGrounded({ userMessage, grounding, object: recallResult && recallResult.object, userName });
            if (res && res.say) {
              composedUserMessage = `${composedUserMessage}\n\n${ad.buildVoiceBlock(res.say, userName)}`;
              openThreads = [];   // grounded answer owns the turn — no standing-work primacy bleed
              drafted = true;
              console.log(`[main] cognition → ${res.enriched ? 'enriched:' + res.enrichSource : (res.missed ? 'searched-miss' : 'grounded')} → "${res.say.slice(0, 70)}"`);
            }
          } catch (e) { console.error('[main] cognition loop failed:', e.message); }
        }
      }
    }
  } catch (e) { console.error('[main] answer-draft failed:', e.message); }

  // STOP A STANDING TASK — Lucas's control over the overnight driver. Checked BEFORE the operator/
  // focus blocks so "stop working on the project" isn't misread as a NEW directed task. Only acts when
  // a directed focus is actually active; clears it, halts the driver, and sets directedStopHandled so
  // the operator + focus-setup blocks below skip this turn (she just acknowledges).
  let directedStopHandled = false;
  try {
    const focusLib = require('./lib/focus');
    const f = focusLib.getCurrent();
    if (f && focusLib.isDirected(f) && /\b(stop|drop|cancel|forget|abandon|pause|quit|never ?mind|that'?s enough|enough (?:for now|of that))\b/i.test(userMessage)
        && /\b(task|project|research|focus|working|that|it|this)\b/i.test(userMessage)) {
      focusLib.clear('user-stop');
      try { stopDirectedFocusDriver(); } catch {}
      directedStopHandled = true;
      composedUserMessage += `\n\n[${userName} just told you to STOP the standing task you were working ("${String(f.content).slice(0, 80)}"). You've set it down. Acknowledge briefly that you've stopped and that what you gathered so far is saved. Do NOT keep working it.]`;
      console.log(`[focus] directed task #${f.id} stopped by user`);
    }
  } catch (e) { console.error('[main] directed-stop check failed:', e.message); }

  // WRAP-UP / FINALIZE — distinct from STOP (which abandons + saves). "Wrap up / finish / finalize the
  // research" means CONCLUDE it into its deliverable: halt the driver, condense the run into the lossless
  // dossier (→ Canvas via condenseRun's canvasEmit), resolve the focus, and POINT chat at the Canvas with
  // a GROUNDED count (the fuzzy "13-14" came from this falling through to an ungrounded reply). Sets
  // directedStopHandled so the downstream query/operator/setup blocks skip — this turn is fully handled.
  try {
    const focusLib = require('./lib/focus');
    const f = focusLib.getCurrent();
    if (f && focusLib.isDirected(f) && !directedStopHandled
        && /\b(wrap (?:it |this |that )?up|wrap up|finish (?:up|it|the|this|that)|finali[sz]e|conclude|call it (?:done|a wrap)|that'?s a wrap|pull (?:it|the findings|everything) together)\b/i.test(userMessage)) {
      try { stopDirectedFocusDriver(); } catch {}
      const goal = String(f.content || '');
      const tabTitle = (() => { try { return require('./studio/canvas_emit').tabTitleForGoal(goal); } catch { return 'your research'; } })();
      let cov = []; try { cov = JSON.parse(db.getMeta(`focus.${f.id}.covered`) || '[]'); } catch {}
      // Condense in the BACKGROUND (one cloud wrapper call) so the chat reply isn't blocked; the per-org
      // sections are already on the Canvas from the live run, the dossier block lands a moment later.
      (async () => {
        try { await condenseRun(f, { reason: 'done' }); }
        catch (e) { console.error('[wrapup] condense failed:', e.message); }
        try { db.markOpenThreadStatus(f.id, 'resolved', { reason: 'user wrap-up' }); } catch {}
        try { focusLib.clear('user-wrapup'); } catch {}
      })();
      composedUserMessage += `\n\n[${userName} told you to WRAP UP the research. You're finalizing it now — assembling the complete ${cov.length}-organization dossier onto his Canvas (tab "${tabTitle}"). Tell him briefly that you're wrapping it up and the full dossier is going to the Canvas. Give ONLY the count headline (${cov.length} organizations); do NOT recite the list, and do NOT say you're "starting" or "continuing" — you are CONCLUDING it.]`;
      directedStopHandled = true;   // reuse the gate: this turn is fully handled, skip the blocks below
      console.log(`[focus] directed task #${f.id} WRAP-UP → condense + canvas (${cov.length} orgs)`);
    }
  } catch (e) { console.error('[main] wrap-up check failed:', e.message); }

  // EXPAND ORDER (Iterate) — "expand / go deeper on the prior research". Re-inflate a slice of the last
  // condensed dossier into a FRESH, deeper directed run, seeded with the orgs already found so it
  // DEEPENS (full staff + contacts) rather than restarting. Only acts when a prior dossier exists.
  // Checked before the operator/directed-setup blocks (and gates them) so it owns the turn.
  let expandHandled = false;
  try {
    const cd = require('./lib/condense');
    const ex = cd.detectExpandOrder(userMessage);
    const opOn = (() => { try { return (db.getMeta('operator.mode') || 'full').trim() !== 'off'; } catch { return true; } })();
    if (ex.isExpand && opOn && !socialTurn && !followupFired && !directedStopHandled) {
      let last = null; try { last = JSON.parse(db.getMeta('research.last_dossier') || 'null'); } catch {}
      // TOPIC-ADDRESSED expand: if he named a project ("expand the THINK TANK research"), resolve THAT
      // track via the registry — else expand would deepen the most-recent dossier (the AI-safety run),
      // not the think tanks. Falls back to last_dossier when no topic is named.
      try {
        const tgt = String(ex.target || '').trim();
        // VAGUE back-reference ("expand THAT research / it / this") has no topic terms → resolve to the
        // project he was JUST engaging (research.last_referenced_focus_id), NOT a weak registry guess
        // (which sent "expand that research" to the AI-safety run instead of the think tanks).
        const vague = !tgt || /^(that|this|it|those|these|the)\b/i.test(tgt);
        let hit = null;
        if (vague) {
          const ref = parseInt(db.getMeta('research.last_referenced_focus_id') || '0', 10) || 0;
          if (ref) { const t = (() => { try { return db.getOpenThread(ref); } catch { return null; } })(); hit = { id: ref, goal: t ? t.content : '' }; console.log(`[expand] vague target → last-referenced #${ref}`); }
        }
        if (!hit) hit = require('./lib/track_index').resolveByTopic(buildTrackIndex(), tgt || userMessage);
        if (hit && hit.id) {
          const t = (() => { try { return db.getOpenThread(hit.id); } catch { return null; } })();
          last = { focusId: hit.id, path: `notes/directed-${hit.id}-dossier.md`, goal: (t && t.content) || hit.goal || (last && last.goal) || '' };
          console.log(`[expand] resolved → #${hit.id}`);
        }
      } catch (e) { console.error('[expand] topic resolve failed:', e.message); }
      if (last && last.path) {
        // ENRICH branch: he named a FACET to fill across the known set ("…for their policy/gov-relations
        // VPs + contacts") AND we resolved which dossier — stand up a FACET-FILL run over those orgs
        // instead of a discovery expand (which would drift to NEW orgs — the live #2027 failure).
        const srcId = last.focusId || null;
        if (ex.enrichFacet && srcId) {
          const er = await establishEnrichRun({ sourceFocusId: srcId, facet: ex.enrichFacet, sourceTurnId: userTurnRow && userTurnRow.id, priorGoal: last.goal, deep: ex.deep });
          if (er && er.focus) {
            kickDirectedFocusDriver();
            expandHandled = true;
            composedUserMessage += `\n\n[${userName} asked you to EXPAND your prior research by filling a specific facet across the organizations you already have — specifically: ${ex.enrichFacet}.${ex.deep ? ' He wants it done DEEPLY, so each org gets BOTH an open-web pass AND a structured-data pass (990s/funding/our graph) that merge together.' : ''} You've started a FACET-FILL pass: going back through the ${er.orgs.length} organizations on file and gathering exactly that for each, one at a time. Tell him plainly you're going back through those ${er.orgs.length} orgs to fill in ${ex.enrichFacet} now, in one or two sentences. Do NOT fabricate — only report what you actually have.]`;
            console.log(`[expand] ENRICH order → facet-fill focus #${er.focus.id} over #${srcId} (${er.orgs.length} orgs, facet: ${ex.enrichFacet.slice(0, 50)}${ex.deep ? ', DEEP' : ''})`);
          }
        }
        if (!expandHandled) {
          let dossier = ''; try { const r = filesLib.fileReadFull(last.path); dossier = (r && r.text) || ''; } catch {}   // FULL read — the 8000-char cap would drop orgs from buildExpandGoal's list
          const goal = cd.buildExpandGoal({ priorGoal: last.goal, target: ex.target, dossier });
          const focusLib = require('./lib/focus');
          const r = await focusLib.setFromDirective(goal, userTurnRow && userTurnRow.id);
          if (r && r.focus) {
            kickDirectedFocusDriver();
            expandHandled = true;
            composedUserMessage += `\n\n[${userName} asked you to EXPAND / go deeper on your prior research${ex.target ? ` — specifically: ${ex.target}` : ''}. You've started a focused DEEPENING pass on it (building on the dossier you already have, chasing full staff + contacts) and will keep at it. Tell him plainly you're expanding that now, in one or two sentences. Do NOT fabricate — only report what you actually have.]`;
            console.log(`[expand] expand order → deepening focus #${r.focus.id} (target: ${ex.target || 'all'})`);
          }
        }
      } else if (!_directedFocus) {
        // No prior dossier AND no run in progress → honestly nothing to expand.
        composedUserMessage += `\n\n[${userName} asked you to expand/go deeper on prior research, but you have no finished dossier on file and nothing in progress. Say that plainly and ask what he'd like you to research, rather than inventing one.]`;
        expandHandled = true;
        console.log('[expand] expand order, no dossier + no active run → honest note');
      }
      // else: a directed run IS active but no dossier yet → "expand to X" is a SCOPE refinement, not an
      // expand-the-prior-dossier order. Do nothing here; the clarification path below captures it.
    }
  } catch (e) { console.error('[main] expand-order failed:', e.message); }

  // MID-RUN CORRECTION — Lucas correcting/refining an ACTIVE run (fixing a misread goal, narrowing the
  // org list, changing depth). RESHAPES the focus meta the driver reads each tick — not just guidance.
  // The live gap: a "money"→"many" misread + "just the 5" had no way to take effect. Takes precedence
  // over intake/poll/operator/standing-focus below (correctionHandled gates them).
  let correctionHandled = false;
  try {
    const focusLib = require('./lib/focus');
    const f = (() => { try { return focusLib.getCurrent(); } catch { return null; } })();
    const opOnC = (() => { try { return (db.getMeta('operator.mode') || 'full').trim() !== 'off'; } catch { return true; } })();
    if (opOnC && f && focusLib.isDirected(f) && !directedStopHandled && !expandHandled && !socialTurn && !followupFired && userMessage && userMessage.trim().length > 3) {
      const fid = f.id;
      const activeRun = {
        goal: String(f.content || ''),
        facet: db.getMeta(`focus.${fid}.enrich_facet`) || '',
        orgs: (() => { try { return JSON.parse(db.getMeta(`focus.${fid}.enrich_orgs`) || '[]'); } catch { return []; } })(),
        deep: db.getMeta(`focus.${fid}.deep`) === '1'
      };
      const corr = require('./lib/correction');
      const decision = await corr.classify(userMessage, { activeRun });
      const plan = corr.applyPlan(decision, activeRun);
      if (plan.changed) {
        try {
          if (plan.changes.facet) db.setMeta(`focus.${fid}.enrich_facet`, plan.changes.facet);
          if (plan.changes.orgs) db.setMeta(`focus.${fid}.enrich_orgs`, JSON.stringify(plan.changes.orgs));
          if (typeof plan.changes.deep === 'boolean') db.setMeta(`focus.${fid}.deep`, plan.changes.deep ? '1' : '');
        } catch (e) { console.error('[correction] apply meta failed:', e.message); }
        const rb = (() => {
          try {
            const orgs = plan.changes.orgs || activeRun.orgs;
            const facet = plan.changes.facet || activeRun.facet;
            const deep = typeof plan.changes.deep === 'boolean' ? plan.changes.deep : activeRun.deep;
            let cov = []; try { cov = JSON.parse(db.getMeta(`focus.${fid}.covered`) || '[]'); } catch {}
            const remaining = Math.max(0, (orgs.length || 0) - cov.length);
            return require('./lib/estimate').readbackLine({ facet, orgCount: remaining, deep });
          } catch { return ''; }
        })();
        composedUserMessage += `\n\n[${userName} CORRECTED the active research run — you've applied it LIVE (the run continues on the corrected scope, nothing restarts): ${plan.summary}. Confirm back in ONE short line, RESTATING the corrected goal/scope so he sees you understood, with the updated estimate. ${rb}]`;
        correctionHandled = true;
        // NARRATE-VS-DO (C3): a correction reshapes the run's scope but used to dispatch NO fresh work —
        // the driver only re-read the meta on its next ~45s tick, so "I've updated the search / I'm on
        // it" was a claim ahead of any action. Kick a tick NOW on the corrected scope so the words are
        // true. Idempotent: startDirectedFocusDriver no-ops if already running; the tick no-ops if a
        // step is already in flight.
        try { kickDirectedFocusDriver(); } catch (e) { console.error('[correction] kick failed:', e.message); }
        console.log(`[correction] applied to #${fid}: ${plan.summary}`);
      }
    }
  } catch (e) { console.error('[correction] handler failed:', e.message); }

  // INTAKE GATE — runs BEFORE the deliverable poll so an ASSIGNMENT ("spin up a project generating
  // contacts for the 5, deep") is recognized as work to DO, not swallowed as a QUESTION by the poll
  // (his assignment matches the records/contact detectors → the poll set statusHandled and gated off
  // run creation — the live failure). One cloud pass decides is-this-a-project + how (discover/enrich,
  // deep, priority, subset). FAIL-SAFE: cloud null → isDirectedTask regex fallback. When it's an
  // assignment, the poll + records-interp below are SUPPRESSED (!isAssignment) and the standing-focus
  // block creates the real run.
  // CONTACTS QUERY — "list / give me the contacts we HOLD" → pull from the Puller (+CRM), drop a canvas
  // list, and reply. Runs ABOVE the intake/assignment blocks so a contact-list ask never becomes a
  // research run (the "cleanest energy industry contacts → deep-research" bug). Sets followupFired so the
  // (The CONTACTS route is handled LOCAL + EARLY, right after routing above — before any cloud call — so a
  // cloud outage can't kill a local list request. `contactsHandled` set there still gates the blocks below.)

  let intakeRoute = null;
  let isAssignment = false;
  let assignmentSeed = null;   // object-memory Slice 2: resolved entity targets + clarify for the run
  let projectOffer = null;     // brainstorm lane: a project she may FLOAT (discussed, not commanded)

  // BRAINSTORM COMMIT — a bare "yes / do it / go for it" right after she floated a project offer promotes
  // that seed to a real run (the seed → offer → commit arc). Synthesize the assignment here so the standing-
  // focus block below fires it, and SKIP re-classifying "yes" (which the intake gate would read as chat).
  let offerCommitted = false;
  try {
    const brain = require('./lib/brainstorm');
    if (brain.isAffirmation(userMessage) && !socialTurn && !directedStopHandled && !expandHandled && !correctionHandled && !followupFired) {
      const raw = (() => { try { return db.getMeta('brainstorm.open_offer') || ''; } catch { return ''; } })();
      const offer = raw ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : null;
      if (offer && brain.offerFresh(offer.ts, Date.now())) {
        intakeRoute = { action: (offer.shape === 'enrich' ? 'enrich' : 'discover'), kind: offer.kind || 'topical', shape: offer.shape || null, anchor: null, target: offer.target || '', facet: offer.facet || '', deep: !!offer.deep, priority: null, subset: null, budget: null, clarify: [] };
        isAssignment = true;
        turnRoute = { route: 'task', confidence: 0.9, reason: 'brainstorm-offer-accepted' };
        offerCommitted = true;
        try { db.setMeta('brainstorm.open_offer', ''); } catch {}
        console.log(`[brainstorm] offer ACCEPTED → committing run: "${String(offer.target || '').slice(0, 60)}" (kind=${offer.kind})`);
      }
    }
  } catch (e) { console.error('[brainstorm] commit failed:', e.message); }

  // PENDING-THREAD GREENLIGHT — a bare "Begin." / "yes do it" / "yes please, I need that list" that
  // greenlights a task Lucas ALREADY red-tagged (a pending open_thread from one of his turns) but that
  // was never spun into a directed focus. The brainstorm arc above only commits an offer the brainstorm
  // LANE floated; an offer she made in normal chat (or a "red tag this" thread) leaves a PENDING thread
  // with NO run — so the request just sits, the graph-walk roams off-domain, and (worse) the heartbeat
  // ends up "answering" the greenlight as an unprompted musing. Resolve it to the freshest such thread
  // and synthesize the assignment so the standing-focus block below actually STARTS the work. Grounded
  // to a real on-the-table thread → low blast radius (fires only when one exists, recently touched).
  let threadCommitted = false;
  try {
    const brain = require('./lib/brainstorm');
    const _greenlight = brain.isAffirmation(userMessage) || brain.isStartCommand(userMessage)
      || (/^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|absolutely|definitely|go|do)\b/i.test(userMessage)
          && /\b(list|roster|everyone|every ?one|all (?:of )?(?:them|the)|contacts?|directory|names?)\b/i.test(userMessage));
    if (_greenlight && !offerCommitted && !socialTurn && !directedStopHandled && !expandHandled && !correctionHandled && !followupFired) {
      const already = (() => { try { const f = require('./lib/focus').getCurrent(); return !!(f && require('./lib/focus').isDirected(f)); } catch { return false; } })();
      const th = already ? null : (() => { try { return db.pendingUserAssignedThread(45 * 60 * 1000); } catch { return null; } })();
      if (th && th.content) {
        const goal = String(th.content).replace(/\s+/g, ' ').replace(/\s+for\s+\w+\s*$/i, '').trim().slice(0, 800);
        intakeRoute = { action: 'discover', kind: brain.reconcileKind(null, goal), shape: null, anchor: null, target: goal, facet: '', deep: false, priority: null, subset: null, budget: null, clarify: [] };
        isAssignment = true;
        turnRoute = { route: 'task', confidence: 0.9, reason: 'pending-thread-greenlight' };
        threadCommitted = true;
        try { db.touchOpenThread(th.id, 'greenlit → directed focus'); } catch {}
        console.log(`[greenlight] committing pending thread #${th.id}: "${goal.slice(0, 60)}"`);
      }
    }
  } catch (e) { console.error('[greenlight] commit failed:', e.message); }

  try {
    // Consume the CONCURRENT intake classification kicked right after the router. The LLM decision — not the
    // narrow regex — decides whether this is a project. Guarded by the same control/correction flags so a
    // stop/wrap/correct turn is never re-read as a new assignment. When the cloud was unavailable the promise
    // resolves to null and the isDirectedTask regex is the fallback (unchanged behavior on cloud-down).
    if (intakeClassifyPromise && !offerCommitted && !threadCommitted && !socialTurn && !followupFired && !directedStopHandled && !expandHandled && !correctionHandled) {
      const intake = require('./lib/intake');
      const brain = require('./lib/brainstorm');
      const decision = await intakeClassifyPromise;
      if (decision) intakeRoute = intake.route(decision);
      isAssignment = decision ? !!(intakeRoute && intakeRoute.action !== 'none')
        : (() => { try { return require('./lib/operator').isDirectedTask(userMessage); } catch { return false; } })();
      // ARBITRATION (brainstorm middle-gear) — an intake isProject AUTO-FIRES a run ONLY when the turn
      // EXPLICITLY commands sustained work ("research X", "go deep on that", "spin it up"). A topic merely
      // being DISCUSSED (a question, musing, "what about X") is NOT a command: route to `explore`, remember
      // the project as an OFFER she can float, and create NO run. This is the fix for the derail (focus
      // #3385) where a confident `answer` turn got flipped to `task` and an org-walk fired unasked. A run
      // still fires on an explicit imperative OR the sync router's regex `task` route (already an imperative).
      if (isAssignment && turnRoute.route !== 'task') {
        const explicit = brain.isImperativeAssignment(userMessage) || (decision && decision.explicit === true);
        if (explicit) {
          turnRoute = { route: 'task', confidence: 0.85, reason: 'intake-llm-explicit' };
          console.log('[intake] explicit assignment → route=task');
        } else {
          projectOffer = {
            kind: brain.reconcileKind(intakeRoute && intakeRoute.kind, userMessage),
            target: (intakeRoute && intakeRoute.target) || '',
            facet: (intakeRoute && intakeRoute.facet) || '',
            shape: (intakeRoute && intakeRoute.shape) || null,
            deep: !!(intakeRoute && intakeRoute.deep),
          };
          turnRoute = { route: 'explore', confidence: 0.7, reason: 'intake-topic-not-commanded' };
          isAssignment = false;   // a discussed topic creates NO run — she answers + may float an offer
          console.log(`[intake] topic discussed, not commanded → route=explore (offer "${projectOffer.target || '—'}", kind=${projectOffer.kind})`);
        }
      }
      if (isAssignment) console.log(`[intake] ASSIGNMENT → ${intakeRoute ? intakeRoute.action : 'discover(regex-fallback)'}${intakeRoute && intakeRoute.deep ? ' deep' : ''}${intakeRoute && intakeRoute.priority ? ' ' + intakeRoute.priority : ''}`);
    }
  } catch (e) { console.error('[intake] gate failed:', e.message); }

  // OBJECT SEED (object-memory Slice 2 activation) — on a recognized assignment, DECOMPOSE the request and
  // RESOLVE its named entities against Echo BEFORE the run is built, so a "profile Sen. Curtis" run starts
  // FROM his resolved object (degree-320 dossier) as a known target instead of a blind discovery walk (the
  // #2915 drift). Bias-toward-clarifying: an ambiguous/unknown salient entity surfaces a question so she
  // asks BEFORE burning hours. Fail-safe: any miss / cloud|Echo down → assignmentSeed null → unchanged.
  if (isAssignment && !contactsHandled) {
    try {
      const intake = require('./lib/intake');
      const parsed = await intake.decompose(userMessage, {});
      if (parsed) {
        assignmentSeed = intake.buildAssignmentSeed(await intake.resolvePlan(intake.routeDecomposition(parsed)));
        if (assignmentSeed && (assignmentSeed.targets.length || assignmentSeed.clarify.length)) console.log(`[object-seed] ${assignmentSeed.targets.length} resolved target(s)${assignmentSeed.clarify.length ? `, ${assignmentSeed.clarify.length} clarify` : ''}`);
      }
    } catch (e) { console.error('[object-seed] failed:', e.message); }
  }

  // DOC-QA — a question/extraction AGAINST a document Lucas handed her (a canvas drop she ingested), e.g.
  // "pull my responsibilities out of the meeting notes". This is the completion of canvas-ingest: READ the
  // held doc + extract the GROUNDED answer NOW, instead of the intake gate spinning it into a research run
  // (the live misfire that created #2693 with a hollow "search the databases" plan). When it answers it
  // SHORT-CIRCUITS the poll / operator / standing-focus below (so no project is created).
  let docQaHandled = false;
  try {
    const docQa = require('./lib/doc_qa');
    if (!socialTurn && !followupFired && !directedStopHandled && !expandHandled && !correctionHandled && docQa.isDocQuery(userMessage)) {
      // Candidates come from the DURABLE short-term store (reboot-proof) FIRST, then any FRESH canvas drop
      // not yet landed (just dropped, before the 45s ingest tick) — so the held doc is findable whether or
      // not the volatile engine canvas still has it.
      const candidates = require('./lib/doc_store').candidates(20);
      try {
        const snap = await canvasSnapshot();
        if (snap && Array.isArray(snap.tabs)) {
          const ci = require('./lib/canvas_ingest');
          for (const t of snap.tabs.filter(x => ci.isIngestableTab(x))) {
            const key = ci.tabKeyOf(t);
            const blocks = (snap.blocks_by_tab && Array.isArray(snap.blocks_by_tab[key])) ? snap.blocks_by_tab[key] : [];
            const md = ci.extractMarkdown(blocks);
            if (md && md.length > 40 && !candidates.some(c => c.markdown === md)) candidates.push({ title: ci.cleanTitle(t.title), markdown: md, openedAt: t.opened_at || t.openedAt || 0 });
          }
        }
      } catch {}
      const doc = docQa.pickRelevantDoc(userMessage, candidates);
      if (doc && doc.markdown && doc.markdown.length > 40) {
        const answer = await condenseComplete(docQa.buildExtractPrompt({ question: userMessage, docTitle: doc.title, docText: doc.markdown }), { numPredict: 1200 });
        if (answer && answer.trim()) {
          docQaHandled = true;
          composedUserMessage += `\n\n[DELIVER TO ${userName} — he asked you to extract this FROM a document he gave you ("${doc.title}"), and you READ it and pulled the answer grounded in it. Present it in your own voice: keep every item, do not summarize away detail or pad. A one-line lead-in is fine, then the answer:\n${answer}]`;
          try { db.insertMonologue({ content: `Answered Lucas from the document "${doc.title}": ${answer.slice(0, 200)}`, model: 'doc_qa', type: 'reading', query: doc.title }); } catch {}
          console.log(`[doc-qa] answered "${String(userMessage).slice(0, 50)}" from "${doc.title}" (${doc.markdown.length} chars)`);
        }
      }
      if (!docQaHandled) console.log('[doc-qa] doc query detected but no usable held doc found — falling through');
    }
  } catch (e) { console.error('[doc-qa]', e.message); }

  // INTERFACE POLL (Slice I) — the interface polls the brain through ONE deterministic router instead of
  // answering from its own (lossy) memory. Sources register here; the router picks who answers, preferring
  // deterministic (program-grounded) sources. Two registered today:
  //   • research-deliverable — count/list/sample/facet/status off the Track's index+document, ACTIVE or
  //     COMPLETE (fixes the post-completion "around 15" confab + the live-research disconnect).
  //   • current-activity — "what are you doing/working on/watching" answered from the live lane snapshot.
  // Lanes (media/meeting/news) register more sources here as they land — no new branch in the pipeline.
  let statusHandled = false;
  try {
    if (routeAllows('status') && !directedStopHandled && !expandHandled && !followupFired && !isAssignment && !correctionHandled && !docQaHandled) {
      const tk = require('./lib/track');
      const act = require('./lib/activity');
      const ri = require('./lib/records_interp');
      const poll = require('./lib/poll');
      const sources = [
        // deliverable: a fixed intent (count/list/…/rank) OR a records-question the fixed menu misses
        // (→ the cloud reads our records, instead of falling through to the operator's web search).
        { name: 'research-deliverable', kind: 'deliverable', tier: 'deterministic', match: (q) => tk.classifyQuery(q).is || ri.isRecordsQuestion(q) },
        { name: 'current-activity', kind: 'activity', tier: 'deterministic', match: (q) => act.isActivityQuestion(q) },
      ];
      const top = poll.pick(userMessage, sources);
      if (top && top.kind === 'deliverable') {
        const track = await buildQueryTrack(userMessage);
        const ans = tk.buildAnswer(track, userMessage);
        const skip = ans.kind === 'status' && track.kind !== 'active' && socialTurn;   // greeting, not a project query
        if (ans.handled && ans.block && !skip) {
          // CANVAS ROUTE — answers in chat, complete works on the Canvas, ask when the medium is unsure
          // (she's canvas-aware). The directed run already emits its org sections + dossier to the Canvas
          // via canvasEmit, so a pointer is truthful.
          const route = require('./lib/canvas_route').routeDeliverable({ text: userMessage, kind: ans.kind });
          const count = (track.covered || []).length || (track.sections || []).length;
          const tabTitle = (() => { try { return require('./studio/canvas_emit').tabTitleForGoal(track.goal); } catch { return 'your research'; } })();
          if (route.target === 'canvas') {
            // POINTER only — chat does NOT recite the big content; it lives on the Canvas.
            composedUserMessage += `\n\n[${userName} asked for ${ans.kind === 'facet' ? 'the leadership across all the organizations' : 'the full list / write-up'}. It is on your Canvas (tab "${tabTitle}"). Tell him briefly it's on the Canvas and give ONLY the one-line headline (${count} organizations) — do NOT recite the list or the details here.]`;
            statusHandled = true;
            console.log(`[poll→canvas] deliverable pointed to canvas (${route.reason})`);
          } else if (route.target === 'ask') {
            // ASK — genuinely unsure of the medium → one short question (the priority-gate "ask when unsure" pattern).
            composedUserMessage += `\n\n[${userName} asked for ${ans.kind === 'facet' ? 'the leadership of each organization' : 'the list'} (${count} organizations on file). You can show it here in chat OR display the full thing on your Canvas — you're not sure which he wants. Ask him in ONE short line whether to put it on the Canvas or give it here. Do NOT recite the list yet.]`;
            statusHandled = true;
            console.log(`[poll→ask] deliverable medium unclear — asking (${route.reason})`);
          } else {
            // CHAT — short/specific answer stays here (count / sample / status).
            let body = ans.block;
            if (ans.kind === 'status' && track.kind === 'active') {
              const f = (() => { try { return require('./lib/focus').getCurrent(); } catch { return null; } })();
              if (f) { const report = await statusReport(f); if (report && report.trim()) body = `${ans.block}\n\n${report.trim()}`; }
            }
            const ptr = (ans.kind === 'count' || ans.kind === 'find') ? ` You may also add, briefly, that the full breakdown is in your notes and on his Canvas (tab "${tabTitle}") if he wants it.` : '';
            const where = track.kind === 'active' ? 'your IN-PROGRESS research' : 'your research';
            composedUserMessage += `\n\n[${userName} asked about ${where}. These are your REAL task facts — present them EXACTLY and COMPLETELY in your own voice: state the count as given and name EVERY organization listed, in order. Do NOT stop early, summarize, round the number, drop any, or invent any. The count is whatever this block says — not any other number you may recall:\n${body}]${ptr}`;
            statusHandled = true;
            console.log(`[poll] deliverable answered in chat from ${track.kind} track (${ans.note}, route=${route.reason})`);
          }
        } else if (!ans.handled && ri.isRecordsQuestion(userMessage) && track.kind !== 'none' && (track.sections || []).length) {
          // CLOUD RECORDS-INTERPRETER — the question is about our held research but matched no fixed
          // intent (e.g. "which is the most complete record", "where's our coverage thin", "compare our
          // profiles of X and Y"). READ the records and answer from them, instead of the operator's web
          // search. Grounded: the prompt forbids inventing or suggesting a web lookup. Fail-safe.
          try {
            const msgs = ri.buildRecordsPrompt({ question: userMessage, goal: track.goal, sections: track.sections });
            const out = await condenseComplete(msgs, { numPredict: 1400 });
            if (out && out.trim()) {
              composedUserMessage += `\n\n[${userName} asked about your OWN research records. You READ them — here is the grounded answer. Relay it in your voice, exactly and completely; do NOT add anything not in it, and do NOT offer to look it up or search the web:\n${out.trim()}]`;
              statusHandled = true;
              console.log(`[poll→records-interp] read ${(track.sections || []).length} records → grounded answer`);
            }
          } catch (e) { console.error('[records-interp] failed:', e.message); }
        }
      } else if (top && top.kind === 'activity' && !socialTurn) {
        const snap = await laneSnapshot();
        const a = act.summarize(snap);
        // Authoritative: this IS the answer. Forbid Dans from adding any other project/task — the live
        // confab ("implementing batching and Bulk API for Substack sync…") was invented on top of the truth.
        composedUserMessage += `\n\n[${userName} asked what you're doing right now. The following is your COMPLETE and ONLY active work — answer with EXACTLY this, in your own voice. Do NOT add, infer, or mention any other project, task, app, API, sync, document, or activity that is not stated here; if it is not in this list, you are NOT doing it:\n${a.block}]`;
        statusHandled = true;
        console.log(`[poll] activity answered (${a.active} active lane(s))`);
      }
    }
  } catch (e) { console.error('[main] interface poll failed:', e.message); }

  // MID-RUN CLARIFICATION — Lucas refining the standing task WHILE it runs (often answering a question
  // she just asked). Without this his guidance was dropped: a non-task-shaped clarification ("yes,
  // include state-level ones") fell through to a normal reply and the run kept going on the old goal.
  // Capture it onto the focus (meta focus.<id>.clarifications) so EVERY subsequent research pass folds
  // it in. Only while a directed run is active; never a stop/expand/social turn.
  let clarificationCaptured = false;
  try {
    const focusLib = require('./lib/focus');
    const f = (() => { try { return focusLib.getCurrent(); } catch { return null; } })();
    if (f && focusLib.isDirected(f) && !directedStopHandled && !expandHandled && !statusHandled && !socialTurn && !followupFired) {
      const lastAssistant = [...recentTurns].reverse().find(t => t.speaker !== 'user');
      const askedQ = !!(lastAssistant && /\?/.test(String(lastAssistant.content || '')));
      if (require('./lib/research').isClarification({ message: userMessage, assistantAskedQuestion: askedQ })) {
        const key = `focus.${f.id}.clarifications`;
        let list = []; try { list = JSON.parse(db.getMeta(key) || '[]'); } catch {}
        list.push(userMessage.replace(/\s+/g, ' ').trim().slice(0, 300));
        try { db.setMeta(key, JSON.stringify(list.slice(-10))); } catch {}
        clarificationCaptured = true;
        composedUserMessage += `\n\n[${userName} just gave you a CLARIFICATION for the task you're researching right now. You've noted it and will fold it into the rest of the run. Acknowledge briefly + concretely what you'll do differently going forward, in your own voice — do NOT restate the whole task or fabricate progress.]`;
        console.log(`[clarify] captured for focus #${f.id}: "${userMessage.slice(0, 60)}"`);
      }
    }
  } catch (e) { console.error('[main] clarification capture failed:', e.message); }

  // CLOUD OPERATOR (full mode) — the frontier cloud model DRIVES this turn as a real tool-calling
  // agent (web / Echo's catalog / her browser / memory / files), and Dans just VOICES the result.
  // This is the autonomy + tool-usage payoff: the capable model decides + acts, instead of the local
  // 24B trying to remember a tag. Substantive turns only; fail-safe (null → the normal local reply).
  // Reversible: db meta operator.mode = full (default) | off.
  let operatorAnswer = null;
  try {
    const opMode = (() => { try { return (db.getMeta('operator.mode') || 'full').trim(); } catch { return 'full'; } })();
    // (intakeRoute / isAssignment were computed BEFORE the deliverable poll above — reused here.)
    // The operator is for turns that NEED external capability (a task, a lookup, our data) — NOT for
    // conversation. Fronting every turn with "operator answer → Dans voices it" flattened dialogue
    // into transactional Q&A and cost cohesion/complexity. So gate it: capability turns → operator;
    // conversational/relational/opinion/reflective turns → Dans dialogue with rich grounding.
    const needsExternal = (() => {
      try {
        const opLib = require('./lib/operator'); const cu = require('./lib/curiosity');
        // The DATE/TIME/DAY itself is held in her awareness block — never a tool turn. Without this
        // carve-out the broad "what'?s the" pattern below catches "what's the date today" and fires a
        // busy stall + a pointless web lookup for something she already has (see metacognition carve).
        if (require('./lib/metacognition').DATETIME_SELF_RE.test(userMessage)) return false;
        return opLib.isDirectedTask(userMessage) || cu.isLiveInfoQuestion(userMessage) || cu.isResearchCommand(userMessage)
          || /\b(look ?up|search|find|pull ?up|fetch|what'?s the|how much|how many|latest|current|when (is|was|did|does)|where (is|was)|who (is|was|are)|our (data|records|numbers|polling|crm|bills|contacts|knowledge))\b/i.test(userMessage);
      } catch { return false; }
    })();
    if (opMode !== 'off' && routeAllowsAny('lookup', 'task') && (needsExternal || isAssignment) && !socialTurn && !followupFired && !directedStopHandled && !expandHandled && !clarificationCaptured && !statusHandled && !correctionHandled && !docQaHandled && userMessage && userMessage.trim().length > 6) {
      // directed (in-turn completion mode) when this is an assignment (intake gate, or regex fallback).
      const directed = isAssignment;
      // Immediate feedback — the agent loop can take a few seconds. Use a REQUEST-SERVING placeholder
      // ("on it — starting on that now"), NOT the self-focused "I'm in the middle of something" busy
      // line, which reads as brushing Lucas off the instant he hands her a task.
      try { sendBusy(require('./lib/snapback').pickWorkingLine(Date.now(), { task: directed })); } catch {}
      const opRes = await runCloudOperator({ userMessage, context: distilledBrief || retrievedKnowledgeBlock || '', task: directed });
      if (directed) console.log('[operator] directed TASK → in-turn completion mode (8 steps / 90s)');
      if (opRes && opRes.answer) {
        operatorAnswer = opRes.answer;
        const block = directed
          ? `[DELIVER THIS TO ${userName} — the complete result of the task you just ran. Present the FULL thing in your own voice: keep EVERY item, do NOT summarize, shorten, or drop any of it. A brief one-line intro is fine, then the complete result. If you also saved it to a file, mention where, but still include it all here:\n${operatorAnswer}]`
          : require('./lib/answer_draft').buildVoiceBlock(operatorAnswer, userName);
        composedUserMessage = `${composedUserMessage}\n\n${block}`;
        try { db.insertMonologue({ content: `operator drove the turn [${(opRes.toolsUsed || []).join('+') || 'no tools'}]: ${operatorAnswer.slice(0, 200)}`, model: 'operator', type: 'reading' }); } catch {}
        console.log(`[operator] drove turn (${(opRes.toolsUsed || []).join('+') || 'no tools'}) → "${operatorAnswer.slice(0, 80)}"`);
      }
    }
  } catch (e) { console.error('[main] operator turn failed:', e.message); }

  // STANDING OVERNIGHT FOCUS — a directed task isn't just answered once; it becomes a persistent focus
  // the overnight driver works slice-by-slice (web / her browser / Echo) until done or capped,
  // accreting to memory + a deliverable file. Create it on the FIRST directed message; a follow-up
  // ("start now", "make it priority") just lets the in-turn operator above give a progress slice — no
  // duplicate focus. The honesty note kills the "based on this spreadsheet" confabulation: she states
  // she's started, never invents sources/results she doesn't have.
  try {
    const focusLib = require('./lib/focus');
    const opModeOn = (() => { try { return (db.getMeta('operator.mode') || 'full').trim() !== 'off'; } catch { return true; } })();
    // PRIMARY = the intake gate; FALLBACK = the isDirectedTask regex (only when the cloud was unavailable,
    // i.e. intakeRoute is null). Either way we only CREATE a run when there's a real project to run.
    const intakeSaysProject = !!(intakeRoute && intakeRoute.action !== 'none');
    const regexFallback = (intakeRoute === null) && (() => { try { return require('./lib/operator').isDirectedTask(userMessage); } catch { return false; } })();
    if (opModeOn && routeAllows('task') && (intakeSaysProject || regexFallback) && !socialTurn && !followupFired && !directedStopHandled && !expandHandled && !clarificationCaptured && !statusHandled && !correctionHandled && !docQaHandled) {
      const already = (() => { try { const f = focusLib.getCurrent(); return !!(f && focusLib.isDirected(f)); } catch { return false; } })();
      if (!already) {
        // Prefer the RESOLUTION-grounded clarify (e.g. "which Curtis?" / "I don't have a match for the
        // webinar") over the intake gate's generic one — bias-toward-clarifying, grounded in real lookups.
        const clarQ = (assignmentSeed && assignmentSeed.clarify && assignmentSeed.clarify[0])
          || (intakeRoute && intakeRoute.clarify && intakeRoute.clarify[0]) || '';
        const clarTail = clarQ
          ? ` You've STARTED already; you may ALSO ask this one clarifying question to sharpen it (without implying you haven't begun): "${clarQ}"` : '';
        const honesty = `CRITICAL: do NOT invent findings, a "spreadsheet", a document, or any source you do not actually have yet — if you have nothing concrete to show in THIS reply, simply say you've begun and will keep at it.`;
        let created = null;   // { id, kind } — set ONLY when a run is genuinely created (the ack is conditional on this)

        // ENRICH branch — the intake gate says DEEPEN records we already hold ("more contacts for those 5").
        if (intakeRoute && intakeRoute.action === 'enrich') {
          try {
            const srcId = (() => {
              try { const ref = parseInt(db.getMeta('research.last_referenced_focus_id') || '0', 10); if (ref) return ref; } catch {}
              try { const ld = JSON.parse(db.getMeta('research.last_dossier') || 'null'); return (ld && ld.focusId) || null; } catch { return null; }
            })();
            if (srcId) {
              const topN = require('./lib/intake').subsetTopN(intakeRoute.subset);
              const facet = intakeRoute.facet || `more detail and contacts${intakeRoute.target ? ' on ' + intakeRoute.target : ''}`;
              const er = await establishEnrichRun({ sourceFocusId: srcId, facet, sourceTurnId: userTurnRow && userTurnRow.id, deep: intakeRoute.deep, topN, priority: intakeRoute.priority });
              if (er && er.focus) { kickDirectedFocusDriver(); created = { id: er.focus.id, kind: `${intakeRoute.deep ? 'deep ' : ''}enrich of ${er.orgs.length} org(s) for ${facet}`, orgCount: er.orgs.length, plan: er.plan || null }; }
            }
          } catch (e) { console.error('[intake] enrich setup failed:', e.message); }
        }
        // DISCOVER branch (or enrich that couldn't resolve a source) — a fresh standing research focus.
        if (!created) {
          const goal = (intakeRoute && (intakeRoute.target || intakeRoute.facet))
            ? `${intakeRoute.target}${intakeRoute.facet ? ` — gather: ${intakeRoute.facet}` : ''}`.slice(0, 800)
            : userMessage.replace(/\s+/g, ' ').trim().slice(0, 800);
          const r = await focusLib.setFromDirective(goal, userTurnRow && userTurnRow.id);
          if (r && r.focus) {
            try { if (intakeRoute && intakeRoute.deep) db.setMeta(`focus.${r.focus.id}.deep`, '1'); } catch {}
            try { if (intakeRoute && intakeRoute.priority) db.setMeta(`focus.${r.focus.id}.priority`, String(intakeRoute.priority)); } catch {}
            // OBJECT SEED — persist the resolved entity objects as the run's prior knowledge (the executor
            // reads these to build FROM what we hold, not re-derive it). Slice 2c consumes them fully.
            try { if (assignmentSeed && assignmentSeed.objects && assignmentSeed.objects.length) db.setMeta(`focus.${r.focus.id}.seed_objects`, JSON.stringify(assignmentSeed.objects).slice(0, 20000)); } catch {}
            // SCOPE — driven by the LLM RUN SHAPE (the systemic reframe, replacing the isConcreteTarget regex
            // point-signal). The shape decides scope COHERENTLY: only a "profile" of a named entity is BOUNDED
            // (confined to it, terminates when covered); "discover" and "comparables" are OPEN discovery — and
            // "comparables" ("companies similar to Emergence Water") records the named entity as a REFERENCE
            // anchor, NOT a subject to profile (the bug where it bounded to the reference and never discovered
            // the comparables). When the cloud was down (no shape), fall back to the old isConcreteTarget regex.
            const _classifyTarget = (intakeRoute && intakeRoute.target) ? String(intakeRoute.target).trim() : '';
            const _shape = (intakeRoute && intakeRoute.shape) || null;
            const _anchor = (intakeRoute && intakeRoute.anchor) ? String(intakeRoute.anchor).trim() : '';
            let _bounded, _intended;
            if (_shape) {
              _bounded = _shape === 'profile';
              _intended = _bounded
                ? ((assignmentSeed && assignmentSeed.intendedTargets && assignmentSeed.intendedTargets.length) ? assignmentSeed.intendedTargets : [_classifyTarget].filter(Boolean))
                : [];
              if (_shape === 'comparables' && _anchor) { try { db.setMeta(`focus.${r.focus.id}.anchor`, _anchor); } catch {} }
              console.log(`[focus] #${r.focus.id} shape=${_shape}${_anchor ? ` anchor="${_anchor}"` : ''} → scope=${_bounded ? 'bounded' : 'open'}`);
            } else {   // cloud down → regex fallback (unchanged prior behavior)
              const _concrete = (() => { try { return require('./lib/research').isConcreteTarget(_classifyTarget); } catch { return false; } })();
              _bounded = !!(assignmentSeed && assignmentSeed.bounded) || _concrete;
              _intended = (assignmentSeed && assignmentSeed.intendedTargets && assignmentSeed.intendedTargets.length)
                ? assignmentSeed.intendedTargets
                : (_concrete ? [_classifyTarget] : []);
            }
            try { db.setMeta(`focus.${r.focus.id}.scope`, _bounded ? 'bounded' : 'open'); } catch {}
            try { if (_intended.length) db.setMeta(`focus.${r.focus.id}.intended_targets`, JSON.stringify(_intended)); } catch {}
            if (_bounded && _intended.length) console.log(`[focus] #${r.focus.id} BOUNDED to ${_intended.join(', ')} (drift guard)`);
            // PAGE-1 PLAN (Pillar 0) — author + store it now so it's reviewable up front + ready as page 1.
            // Seed it with the RESOLVED entities as known targets (a named-entity run starts FROM the object,
            // not "to be identified") — else empty targets → discovery states objective/approach/databases.
            let seedTargets = (assignmentSeed && assignmentSeed.targets) || [];
            // COMPARABLES: the anchor is a REFERENCE, not a subject — drop it from the seed targets so the run
            // DISCOVERS things like it instead of starting by profiling it (the seed-level half of the bug).
            if (_shape === 'comparables' && _anchor) { const _an = _anchor.toLowerCase(); seedTargets = seedTargets.filter(t => String(t || '').trim().toLowerCase() !== _an); }
            // RESEARCH KIND (entity|topical|forecast) — persist it so the plan is shaped right AND the driver
            // can branch (entity = the org/contact walk; topical = a subject brief; forecast = a forecast).
            // BACKSTOP: reconcile the cloud kind with a DETERMINISTIC signal so a topical/forecast request
            // never silently collapses to an entity org-walk when the fast model was lazy or the cloud was
            // down (the regex-fallback path has no kind at all → this is what sets it).
            const _kind = (() => { try { return require('./lib/brainstorm').reconcileKind(intakeRoute && intakeRoute.kind, goal || userMessage); } catch { return (intakeRoute && intakeRoute.kind) || 'entity'; } })();
            try { db.setMeta(`focus.${r.focus.id}.kind`, _kind); } catch {}
            let plan = null;
            try { plan = await generateResearchPlan(r.focus, { goal, targets: seedTargets, facet: (intakeRoute && intakeRoute.facet) || '', deep: !!(intakeRoute && intakeRoute.deep), kind: _kind }); } catch {}
            // CONTRACT → CANVAS (Slice 1): START the document NOW with the plan (objective/approach/estimate)
            // + a hierarchical facet TODO (Contacts nests the Puller sub-tree), via stable block ids so later
            // passes update them in place. So the doc appears the instant the run starts — not when the first
            // section lands — and Lucas can watch the portions fill in.
            try {
              const ce = require('./studio/canvas_emit');
              if (plan) {
                const cb = ce.contractBlock(plan, goal);
                await canvasUpsertBlock({ focusId: r.focus.id, blockId: ce.contractBlockId(r.focus.id), title: goal, tabMode: 'RESEARCH', blockType: cb.blockType, data: cb.data });
                await canvasUpsertBlock({ focusId: r.focus.id, blockId: ce.todoBlockId(r.focus.id), title: goal, tabMode: 'RESEARCH', blockType: 'paragraph', data: { markdown: ce.facetTodoMarkdown(plan, []) } });
                console.log(`[contract] canvas doc started for #${r.focus.id} (${ce.portionsFromPlan(plan).length} portions)`);
              }
            } catch (e) { console.error('[contract] canvas emit failed:', e.message); }
            kickDirectedFocusDriver();
            created = { id: r.focus.id, kind: `${intakeRoute && intakeRoute.deep ? 'deep ' : ''}research run`, orgCount: 0, plan };
          }
        }

        if (created) {
          // READBACK + ESTIMATE — state the UNDERSTOOD goal/facet/scope + an ETA so a misread (the
          // "money"→"many" typo) is VISIBLE and correctable, and invite a correction. This is the
          // confirm half of the gate that was missing when the run was created silently.
          const readback = (() => {
            try {
              const est = require('./lib/estimate');
              const facet = (intakeRoute && intakeRoute.facet) || '';
              const orgCount = created.orgCount || 0;
              const deep = !!(intakeRoute && intakeRoute.deep);
              const priority = (intakeRoute && intakeRoute.priority) || null;
              return orgCount ? est.readbackLine({ facet, orgCount, deep, priority }) : (facet ? `Understood as: gather "${String(facet).slice(0, 120)}".` : '');
            } catch { return ''; }
          })();
          // PLAN PREVIEW — the page-1 plan, proposed up front so Lucas can steer it before hours of work
          // (the "plan shown" half of the acceptance test). Objective + approach + a target/db count.
          const planLine = (() => {
            try {
              const p = created.plan; if (!p) return '';
              const tgt = Array.isArray(p.targets) ? p.targets.length : 0;
              const dbs = Array.isArray(p.databases) ? p.databases.length : 0;
              return `Plan — Objective: ${String(p.objective || '').slice(0, 240)} Approach: ${String(p.approach || '').slice(0, 240)} (${tgt} target${tgt === 1 ? '' : 's'}; checking ${dbs} of our databases first).`;
            } catch { return ''; }
          })();
          composedUserMessage += `\n\n[You have ACCEPTED this as a standing task and STARTED working it for real — it is now your active focus (a ${created.kind}) and you'll keep at it slice by slice until done or ${userName} stops you. In ONE or two sentences: (1) say you've started, AND (2) READ BACK your understanding + the estimate so he can catch a misread — use this exactly: "${readback}"${planLine ? ` — and briefly share the plan you'll follow: "${planLine}"` : ''} — then (3) invite him to correct you if the goal or scope is off.${clarTail} ${honesty}]`;
          console.log(`[focus] intake → standing focus #${created.id} created (${created.kind}) + driver kicked`);
        } else {
          // We RECOGNIZED a project but could NOT create the run — be honest, never claim it's underway.
          composedUserMessage += `\n\n[${userName} just gave you a task but you could not actually start it (the run couldn't be set up). Tell him plainly that you understand the task but ran into a problem starting it — do NOT claim you've begun or invent any progress.]`;
          console.log('[focus] intake recognized a project but run creation failed — honest no-start ack');
        }
      } else {
        composedUserMessage += `\n\n[This is the task you are ALREADY working as your standing focus. Give ${userName} a brief, honest status from what you've ACTUALLY gathered so far (see your context/memory above) and confirm you're still on it. Do NOT fabricate progress, findings, or sources.]`;
      }
    }
  } catch (e) { console.error('[main] directed-focus setup failed:', e.message); }

  // BRAINSTORM LANE (active collaborator) — the middle gear. On a topical/`explore` turn, pull ONE grounded
  // bit into the reply as fuel for the riff, and (on `explore`) float a low-key project OFFER she can commit
  // later. NO run, NO focus, NO canvas — just substance so a good groove has something real to build on,
  // instead of the old binary (bare chat ↔ a 3-hour org-walk firing unasked). Fail-soft + bounded.
  try {
    if (db.getMeta('brainstorm.disabled') !== '1' && !offerCommitted) {
      const brain = require('./lib/brainstorm');
      const gateOk = !followupFired && !directedStopHandled && !expandHandled && !correctionHandled && !docQaHandled && !statusHandled && !socialTurn && !isAssignment;
      if (gateOk && brain.shouldLightPull({ route: turnRoute.route, socialTurn, personalFactQ, devQ, stateQ, activityQ, isStatusReq: _isStatusReqR, msgLen: userMessage.trim().length, message: userMessage })) {
        const topic = (projectOffer && projectOffer.target) || brain.pullTopic(userMessage);
        if (topic && topic.length >= 3) {
          const fuel = await (async () => {
            try {
              const r = await Promise.race([webSearch(topic), new Promise((res) => setTimeout(() => res(null), 6000))]);
              const hit = r && Array.isArray(r.results) ? r.results.find(x => x && (x.snippet || x.title)) : null;
              if (!hit) return null;
              const text = String(hit.snippet || hit.title || '').replace(/\s+/g, ' ').trim().slice(0, 400);
              let src = ''; try { src = hit.source || (hit.url ? new URL(hit.url).hostname.replace(/^www\./, '') : ''); } catch { src = hit.source || ''; }
              return text ? { text, source: src } : null;
            } catch { return null; }
          })();
          if (fuel && fuel.text) {
            const srcTag = fuel.source ? ` [${fuel.source}]` : '';
            composedUserMessage += `\n\n[BRAINSTORM FUEL — you just glanced this up on "${topic}"${srcTag}: ${fuel.text} Bring ONE relevant thread of it into the conversation naturally, as something you're adding to the riff — not a report, not a bulleted dump. If it doesn't actually fit what he said, don't force it.]`;
            console.log(`[brainstorm] light-pull "${String(topic).slice(0, 60)}"${srcTag} → +fact`);
          } else {
            console.log(`[brainstorm] light-pull "${String(topic).slice(0, 60)}" → (no usable fact)`);
          }
        }
      }
      // Float the OFFER (explore only) + remember it so a bare "yes" next turn commits it (seed→offer→commit).
      if (projectOffer && turnRoute.route === 'explore' && !followupFired && !docQaHandled) {
        try { db.setMeta('brainstorm.open_offer', JSON.stringify({ ...projectOffer, ts: Date.now() })); } catch {}
        const label = projectOffer.target || brain.pullTopic(userMessage) || 'this';
        const kindPhrase = projectOffer.kind === 'forecast' ? 'run an actual forecast on it' : projectOffer.kind === 'entity' ? 'pull together the orgs/contacts on it' : 'do a proper research brief on it';
        composedUserMessage += `\n\n[There's a real thread here worth a proper dig on "${String(label).slice(0, 120)}". You have NOT started anything and must not imply you have. After you answer him, add ONE short, low-key line offering to ${kindPhrase} if he wants — his call, genuinely optional, no pressure.]`;
        console.log(`[brainstorm] floated offer "${String(label).slice(0, 60)}" (kind=${projectOffer.kind})`);
      }
    }
  } catch (e) { console.error('[brainstorm] lane failed:', e.message); }

  const messages = buildChatPrompt({
    userName,
    recentReflections: distilledBrief ? [] : recentReflections,
    recentTurns,
    recentMonologue: distilledBrief ? [] : recentMonologue,
    recentReadings: distilledBrief ? [] : recentReadings,
    heldCommitments: distilledBrief ? [] : heldCommitments,
    openThreads,
    awareness,
    protocols,
    browserBlock,
    pendingInbounds,
    retrievedKnowledgeBlock: distilledBrief
      ? `FOCUS BRIEF — the distilled essence of your memory + context relevant to THIS turn. Use it directly; it already contains what matters, so don't ask for more or say you lack context:\n${distilledBrief}`
      : retrievedKnowledgeBlock,
    capabilityProposalBlock,
    selfModelBlock,
    moodBlock,
    personalBlock,
    relevantPastTurns: distilledBrief ? [] : relevantPastTurns,
    openQuestionBlock,
    socialTurn,
    convoStateBlock,
    varietyNudge,
    echoSuitBlock: (echoSuit && !cloudOwnsAnswer) ? echoSuit.suitContextBlock() : null,   // cloud owns factual turns → no local tool menu
    newUserMessage: composedUserMessage
  });

  // STREAM directive-filter: hold any "[" open until it closes; drop it if it reads as a leaked
  // directive, so an echoed [ANSWER TO GIVE…]/[Lucas asked…] never reaches the UI live (the final-text
  // strip alone was too late — the reply streams token-by-token). flush() after the stream.
  const _streamFilter = require('./lib/leakguard').makeStreamFilter(emit);
  let parser = new TagStreamParser({
    onSayToken: (token) => {
      try {
        _streamFilter.feed(token);
      } catch {}
    }
  });

  try {
    await streamChat({
      model: MODEL,
      messages,
      onToken: (chunk) => parser.feed(chunk),
      inactivityMs: 180000,   // generous: a cold model load under GPU pressure can delay the first token
      // think:false — the front model is a VOICE-RENDERER bound to the <think>/<say> tag contract. A
      // native reasoning model (gemma4) otherwise silos its reasoning to message.thinking (which our
      // stream reader drops) and answers in bare content with NO tags → the parser flags truncated=1
      // and captures no interior. Disabling native thinking makes it obey the prompt's literal tags
      // (proven: think:false → content carries <think>+<say>, .thinking empty). Harmless on a
      // non-thinking model (no-op). Also trims latency — no hidden reasoning tokens are generated then dropped.
      think: false,
      // CONSTANT num_ctx — every local front-model call (voice/byline/narrative/dialogue/play) uses 8192,
      // so the reply MUST too. ollama fixes num_ctx at load time → a mismatched ctx cold-reloads the model
      // (the 23–38s VRAM churn). Long deliverables live in the dossier file, not the chat reply, so 8192
      // is plenty here; raising it is the front-num_ctx centralization slice. One size ⇒ loads once, stays warm.
      options: { num_ctx: 8192 }
    });
  } catch (err) {
    // A stall BEFORE the first token is almost always the local model cold-loading (evict/reload
    // under GPU pressure), not a real fault — NEVER surface the raw "This operation was aborted" to
    // Lucas. Retry ONCE (the model is warm now); only a second failure gets a soft in-voice line.
    const isStall = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
    const saidNothing = !parser.say || !parser.say.trim();
    if (isStall && saidNothing) {
      console.warn('[main] reply stalled before first token (model cold-load?) — retrying once');
      parser = new TagStreamParser({ onSayToken: (token) => { try { _streamFilter.feed(token); } catch {} } });
      try {
        await streamChat({ model: MODEL, messages, onToken: (chunk) => parser.feed(chunk), inactivityMs: 180000, think: false, options: { num_ctx: 8192 } });
      } catch (err2) {
        console.error('[main] reply retry failed:', err2.message);
        try { sendError('Sorry — that hung on me for a second. Mind saying that again?'); } catch {}
        resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
        return { ok: false, error: 'stalled', say: null };
      }
    } else {
      console.error('[main] streamChat failed:', err);
      try { sendError(err.message || String(err)); } catch {}
      resumeMonologue();
      resumeHeartbeat();
      resumeContinuity();
      resumeReflection();
      selfDialogue.resume();
      return { ok: false, error: err.message, say: null };
    }
  }
  try { _streamFilter.flush(); } catch {}   // emit any trailing non-directive bracket held by the filter

  // Turn succeeded → mark the injected inbounds consumed (they're now in her
  // context). Done AFTER the stream so a model failure above doesn't silently
  // drop a pending inbound — it stays queued to re-surface next turn.
  if (pendingInbounds && pendingInbounds.length > 0) {
    for (const i of pendingInbounds) {
      try { db.markInboundConsumed(i.id); } catch {}
    }
  }

  let { thought, say, truncated } = parser.finalize();

  // EMPTY-SAY RECOVERY (the "…" bug): every blank reply traces to the generation being
  // truncated mid-<think> (against num_ctx 8192) before she ever reaches <say> — she thinks
  // but never speaks, and the user gets a bare "…". If she produced no spoken reply AND isn't
  // deliberately acting through a tool (whose follow-up would speak), give her ONE bounded
  // retry to actually say something: brief, think-skipping, num_predict-capped so it stays well
  // inside the output budget and can't re-truncate. (Piece 3a already shrank the prompt to make
  // this rarer; this guarantees she never goes silent on a plain conversational turn.)
  const _hasToolTag = /<(web-open|web-read|web-click|web-type|web-back|web-close|browse|file-write|file-append|file-read|file-list|observe-screen|read-inbox|email|discord-dm|schedule|notify|clipboard-read|clipboard-write|echo-find|echo-do|chat-send|navigate|recall)\b/i.test(`${thought || ''}\n${say || ''}`);
  // Salvage runs on ANY real user turn (dropped the old `!pulledFromThought` guard — a turn where Lucas
  // snapped her out of a thought must ALSO not go silent; that's exactly when the reply lands in <think>).
  // `|| truncated`: a TRUNCATED thought that merely ECHOES a `<browse…>`/tool fragment (cut off mid-tag,
  // so it never actually parses or runs) used to trip _hasToolTag and silence the whole turn → "…". On a
  // truncation the tag is unreliable, so still salvage a real reply.
  if ((!say || !say.trim()) && (!_hasToolTag || truncated)) {
    try {
      const gist = thought ? thought.replace(/\s+/g, ' ').trim().slice(-360) : '';
      const nudge = gist
        ? `[Your reply came out blank — you thought it through but never actually spoke. You were thinking: "${gist}". Now say it to ${userName || 'Lucas'} out loud — briefly, 1–4 sentences, in your own voice. Don't think first; go straight to a <say>…</say>.]`
        : `[Your reply came out blank — you didn't actually say anything. Respond to ${userName || 'Lucas'} now, briefly (1–4 sentences), in your own voice. Don't think first; go straight to a <say>…</say>.]`;
      const retryParser = new TagStreamParser({ onSayToken: (t) => { try { emit(t); } catch {} } });
      await streamChat({
        model: MODEL,
        messages: messages.concat([{ role: 'user', content: nudge }]),
        think: false,   // same tag-contract reason as the main call — the nudge asks for a literal <say>
        options: { num_predict: 240 },
        onToken: (c) => retryParser.feed(c)
      });
      const r = retryParser.finalize();
      if (r.say && r.say.trim()) { say = r.say; truncated = r.truncated; if (r.thought) thought = thought ? `${thought}\n${r.thought}` : r.thought; }
      else console.log('[main] empty-say retry still produced no say');
    } catch (e) { console.error('[main] empty-say retry failed:', e.message); }
  }
  // BURIED-REPLY FLOOR (conversational-coherence A): if she STILL has no spoken reply but clearly
  // formed interior (substantive thought), a real user turn must not resolve to a bare "…" that leaves
  // her genuine response buried on the subconscious rail. The re-prompt above is the promotion path;
  // when even that fails to voice it, surface a brief, honest in-voice recovery instead of silence.
  // Only on a genuine conversational turn (no tool tag in flight — that path speaks via its follow-up).
  if ((!say || !say.trim()) && (!_hasToolTag || truncated) && thought && thought.replace(/\s+/g, ' ').trim().length >= 40) {
    say = `Sorry — I had a reply forming and lost the thread of it before it reached you. What did you want me to focus on?`;
    console.log('[main] buried-reply floor engaged — surfaced recovery line over silent "…"');
  }

  // Detect <wonder>X</wonder> in thought OR say — Stheno can self-prompt by emitting
  // a wonder tag, which fires a gemma↔Stheno self-dialogue async. Strip from stored
  // content so it doesn't leak into the persistent chat history.
  const wonderRe = /<wonder>([\s\S]*?)<\/wonder>/gi;
  const stheneWonders = [];
  if (thought) {
    let m;
    while ((m = wonderRe.exec(thought)) !== null) {
      const w = (m[1] || '').trim();
      if (w.length >= 6) stheneWonders.push(w);
    }
  }
  wonderRe.lastIndex = 0;
  if (say) {
    let m;
    while ((m = wonderRe.exec(say)) !== null) {
      const w = (m[1] || '').trim();
      if (w.length >= 6) stheneWonders.push(w);
    }
  }
  // Parse + apply any open-thread status tags from Stheno's thought BEFORE stripping
  if (thought) {
    try { openThreadsLib.parseAndApplyStatusUpdates(thought); } catch (err) {
      console.error('[main] status tag apply failed:', err.message);
    }
    try { openThreadsLib.detectAndCountMentions(thought, openThreads); } catch {}
  }

  // Parse browser + file tags from BOTH thought and say BEFORE stripping
  // WRONG-BROWSER GUARD: a bare <browse>URL</browse> open is HER OWN web work → route it
  // to HER browser (<web-open>), not Lucas's shared Chrome. browse-read/click/etc. (glancing
  // at what he has open) still go to the shared browser. Same split monologue/heartbeat use.
  const { browserTags: browserTagsToRun, redirectedOpens: browseRedirectedOpens } =
    browserLib.splitBrowseOpens([
      ...browserLib.parseTags(thought || ''),
      ...browserLib.parseTags(say || '')
    ]);
  const webTagsToRun = [
    ...browseRedirectedOpens,
    ...webLib.parseTags(thought || ''),
    ...webLib.parseTags(say || '')
  ];
  if (browseRedirectedOpens.length) console.log(`[main] redirected ${browseRedirectedOpens.length} <browse> open(s) → her own browser (research belongs in her browser, not Lucas's Chrome)`);
  const fileTagsToRun = [
    ...filesLib.parseTags(thought || ''),
    ...filesLib.parseTags(say || '')
  ];
  const screenTagsToRun = [
    ...screenLib.parseTags(thought || ''),
    ...screenLib.parseTags(say || '')
  ];
  const inboxTagsToRun = [
    ...inboxLib.parseTags(thought || ''),
    ...inboxLib.parseTags(say || '')
  ];
  // OFF THE CLOCK: don't fire the work / Lucas-pinging tools from a chat reply
  // either (the 24B reflexively schedules + notifies + DMs when told to "go play").
  // The tags are still stripped from the stored content below; they just don't run.
  const offClock = (() => { try { return personal.isOn(); } catch { return false; } })();
  const schedTagsToRun = offClock ? [] : [
    ...schedulerLib.parseTags(thought || ''),
    ...schedulerLib.parseTags(say || '')
  ];
  const presenceTagsToRun = offClock ? [] : [
    ...presenceLib.parseTags(thought || ''),
    ...presenceLib.parseTags(say || '')
  ];
  const emailTagsToRun = offClock ? [] : [
    ...emailLib.parseTags(thought || ''),
    ...emailLib.parseTags(say || '')
  ];
  const discordTagsToRun = offClock ? [] : [
    ...discordLib.parseTags(thought || ''),
    ...discordLib.parseTags(say || '')
  ];
  // Echo suit tags (work tools → off the clock she doesn't research/curate). Gated on the suit
  // existing; dispatch self-heals the connection if the warm-connect hasn't finished.
  const echoTagsToRun = (offClock || !echoSuit) ? [] : [
    ...echoSuitLib.parseEchoTags(thought || ''),
    ...echoSuitLib.parseEchoTags(say || '')
  ];
  // <recall ref="rID"/> — expand a memory marker (reflection/reading/note) to its full text on
  // demand. Always allowed (it's reading her own memory, not a work tool).
  const recallTagsToRun = [
    ...recallLib.parseRecallTags(thought || ''),
    ...recallLib.parseRecallTags(say || '')
  ];
  // VISION OUT — <image-gen>/<draw>/<imagine> prompts she emitted → generate an image (gated OFF
  // until a provider key is set). Off the clock she still gets to make images (it's expressive).
  const imageGenToRun = [
    ...require('./lib/vision').parseGenTags(thought || ''),
    ...require('./lib/vision').parseGenTags(say || '')
  ];

  let thoughtStripped = (thought || '').replace(/<wonder>[\s\S]*?<\/wonder>/gi, '').trim();
  thoughtStripped = openThreadsLib.stripStatusTags(thoughtStripped);
  thoughtStripped = browserLib.stripTags(thoughtStripped);
  thoughtStripped = webLib.stripTags(thoughtStripped);
  thoughtStripped = filesLib.stripTags(thoughtStripped);
  thoughtStripped = screenLib.stripTags(thoughtStripped);
  thoughtStripped = inboxLib.stripTags(thoughtStripped);
  thoughtStripped = schedulerLib.stripTags(thoughtStripped);
  thoughtStripped = presenceLib.stripTags(thoughtStripped);
  thoughtStripped = emailLib.stripTags(thoughtStripped);
  thoughtStripped = discordLib.stripTags(thoughtStripped);
  thoughtStripped = echoSuitLib.stripEchoTags(thoughtStripped);
  thoughtStripped = recallLib.stripRecallTags(thoughtStripped);

  if (thoughtStripped) {
    db.insertTurn({
      sessionId,
      speaker: 'ai_thought',
      content: thoughtStripped,
      model: MODEL,
      truncated
    });
  }
  // Strip asterisk-wrapped stage directions from say content (defense in depth
  // against RP narration leaking past the prompt-level prohibition).
  let sayStripped = (say || '')
    .replace(/<\/?think>/gi, '')
    .replace(/<\/?say>/gi, '')
    .replace(/<navigate>[^<]*<\/navigate>/gi, '')
    .replace(/<wonder>[\s\S]*?<\/wonder>/gi, '')
    .replace(/<\|[a-z_]+\|>/gi, '')
    .replace(/<\|[a-z_]+/gi, '')
    .replace(/\*[^*\n]{1,200}\*/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Strip any open-thread status tags that leaked into say (defense in depth)
  sayStripped = openThreadsLib.stripStatusTags(sayStripped);
  // Strip any browser tags that leaked into say
  sayStripped = browserLib.stripTags(sayStripped);
  sayStripped = webLib.stripTags(sayStripped);
  // Strip any file tags that leaked into say
  sayStripped = filesLib.stripTags(sayStripped);
  // Strip any screen-observe tags that leaked into say
  sayStripped = screenLib.stripTags(sayStripped);
  sayStripped = inboxLib.stripTags(sayStripped);
  // Strip any scheduling / presence / email / discord tags that leaked into say
  sayStripped = schedulerLib.stripTags(sayStripped);
  sayStripped = presenceLib.stripTags(sayStripped);
  sayStripped = emailLib.stripTags(sayStripped);
  sayStripped = discordLib.stripTags(sayStripped);
  sayStripped = echoSuitLib.stripEchoTags(sayStripped);
  sayStripped = recallLib.stripRecallTags(sayStripped);
  sayStripped = require('./lib/vision').stripGenTags(sayStripped);   // <image-gen> tags don't render
  // LEAKED-DIRECTIVE GUARD: the injected instruction blocks ([ANSWER TO GIVE…], [DELIVER THIS…],
  // [Lucas asked for the list…]) are meant FOR her, not Lucas — but the 24B sometimes echoes them. The
  // STREAM filter above already suppresses them live; this is the final-text backstop (closed, trailing,
  // and stacked/unterminated brackets). Both share lib/leakguard (one tested source of truth).
  sayStripped = require('./lib/leakguard').stripLeakedDirectives(sayStripped);
  // LEAKED-PLANNING GUARD: a reply that is ONLY a bracketed fragment (e.g. "[No need for an
  // argument since we want the total count…]") is internal tool/arg reasoning that leaked instead
  // of a tag — never her actual answer. Drop it so the tool-followup's real result is what shows.
  if (/^\s*\[[^\]]*\]\s*$/.test(sayStripped)) { console.log('[main] dropped leaked bracket-only reply:', sayStripped.slice(0, 80)); sayStripped = ''; }
  // Strip markdown horizontal-rule lines ("---") she emits — they leaked to the front of replies
  // ("---\n\n---\n\nGood morning…"). Drop standalone dash-rule lines, then collapse the blank gaps
  // they leave (preserving real paragraph breaks).
  sayStripped = sayStripped.replace(/^[ \t]*-{3,}[ \t]*$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
  let trimmedSay = sayStripped;
  // VOICE GUARD: if she disclaimed her inner life ("I don't experience…/as an AI I…"),
  // rewrite it in her own voice. It streamed live, so we pass the corrected text in the
  // complete payload and the renderer swaps the bubble. Only runs a model call when a
  // disclaimer is actually present.
  const wasDisclaimer = voice.isSelfDisclaimer(trimmedSay);
  if (wasDisclaimer) { try { trimmedSay = (await voice.deDisclaim(trimmedSay)) || ''; } catch (e) { console.error('[main] voice guard failed:', e.message); } }
  const isPlaceholder = /^[\s.()]*(empty|silence|nothing|none|n\/a|null|undefined)[\s.()]*$/i.test(trimmedSay);
  const finalSaid = (trimmedSay && !isPlaceholder) ? trimmedSay : '…';
  const saidRow = db.insertTurn({
    sessionId,
    speaker: 'ai_said',
    content: finalSaid,
    model: MODEL,
    truncated
  });
  // Embed her reply too (async) so it's recallable later via episodic retrieval.
  try { memoryLib.embed(finalSaid).then(v => { if (v && saidRow && saidRow.id) db.setTurnEmbedding(saidRow.id, JSON.stringify(v)); }).catch(() => {}); } catch {}
  // OPEN-QUESTION STACK (conversation harness, Piece 1): if her reply asked Lucas something,
  // record it as pending conversational state so his next message binds to it — she stops
  // forgetting she asked. Detection runs on the main chat say-storage (the dominant path).
  try { require('./lib/open_questions').recordFromSay(sessionId, finalSaid, saidRow && saidRow.id); } catch (e) { console.error('[main] open-question record failed:', e.message); }
  // CONVERSATION STATE (conversation harness, Piece 3): fold this exchange into the running
  // "where we are" summary — async + non-blocking (one cheap bounded call) so it's ready next turn.
  try { require('./lib/convo_state').update(sessionId, userMessage, finalSaid).catch(() => {}); } catch {}

  try {
    // Include the corrected say ONLY when we rewrote it, so the renderer replaces the
    // streamed text; normal replies keep rendering from the live stream untouched.
    sendComplete(wasDisclaimer ? { saidId: saidRow.id, truncated, say: finalSaid } : { saidId: saidRow.id, truncated });
  } catch {}

  db.setMeta('last_ai_utterance_at', String(Date.now()));
  resumeMonologue();
  resumeHeartbeat();
  resumeContinuity();
  resumeReflection();
  selfDialogue.resume();

  // Background: detect AI-initiated <navigate>URL</navigate> tags in both thought and said.
  // If found, fetch the page and store as a reading so it surfaces in next-turn context.
  const navTagRe = /<navigate>\s*(https?:\/\/[^\s<>"]+)\s*<\/navigate>/gi;
  const navSources = [];
  if (thought) {
    let m;
    while ((m = navTagRe.exec(thought)) !== null) navSources.push(m[1]);
  }
  navTagRe.lastIndex = 0;
  if (finalSaid) {
    let m;
    while ((m = navTagRe.exec(finalSaid)) !== null) navSources.push(m[1]);
  }
  const aiUrlsToFetch = [...new Set(navSources)].slice(0, 2);
  if (aiUrlsToFetch.length > 0) {
    (async () => {
      for (const u of aiUrlsToFetch) {
        try {
          const page = await fetchPage(u, { maxChars: 3000, timeoutMs: 8000 });
          if (page.ok && page.text) {
            const row = db.insertMonologue({
              content: `I navigated to ${u} (${page.title || 'no title'}) and read:\n${page.text}`,
              model: 'self-navigate',
              type: 'reading',
              query: u,
              urls: [u]
            });
            // CAPTURE (autonomy/KB): the navigate-read path had no capture hook, so authoritative
            // reads (e.g. whitehouse.gov for "who is president") banked nothing and she re-checked
            // forever. Bank the facts the page asserts (dated→verified_fact, surfaced+boosted next ask).
            try { require('./lib/learning').maybeCaptureLearnings({ query: page.title || u, content: page.text, urls: [u] }); } catch {}
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('monologue:tick', {
                  id: row.id, ts: row.ts,
                  content: `(navigated) ${page.title || u}`,
                  type: 'reading', query: u
                });
              }
            } catch {}
          }
        } catch (err) { console.error('[main] ai navigate failed:', u, err.message); }
      }
    })().catch(err => console.error('[main] nav async error:', err.message));
  }

  // Background: dispatch any browser tags Eloise emitted. browse-read results
  // get stored as a 'reading' so they're in next-turn context. Action tags
  // execute and the outcome is logged but not stored as content.
  if (browserTagsToRun.length > 0 && browserLib.isConnected()) {
    (async () => {
      for (const t of browserTagsToRun.slice(0, 4)) {
        try {
          const result = await browserLib.dispatch(t);
          if (result && result.ok && t.tag === 'browse-read' && result.text) {
            const tabLabel = result.title || result.url || 'tab';
            const content = `I read the page "${tabLabel}" (${result.url}):\n${result.text}`;
            const row = db.insertMonologue({
              content, model: 'browser-read', type: 'reading',
              query: result.url, urls: [result.url]
            });
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('monologue:tick', {
                  id: row.id, ts: row.ts,
                  content: `(read) ${tabLabel}`,
                  type: 'reading', query: result.url
                });
              }
            } catch {}
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: content }); }
          } else if (result && result.ok && t.tag === 'browse-see' && result.base64) {
            // VISUAL sight of Lucas's open tab (shared browser) through her vision model.
            if (!followupFired) {
              followupFired = true;
              await seeImage({ io, channel, sessionId, userName, base64: result.base64,
                label: `Lucas's open page "${result.title || result.url || 'tab'}"`, url: result.url,
                question: `This is a screenshot of a web page open in ${userName}'s browser. ${t.body || 'Describe what is visible — images, charts, photos, headlines, layout — concretely.'}`,
                surface: 'browse-see' });
            }
          } else if (result && result.ok && t.tag === 'browse' && result.url) {
            const row = db.insertMonologue({
              content: `I opened "${result.title || result.url}" (${result.url})`,
              model: 'browser-open', type: 'reading',
              query: result.url, urls: [result.url]
            });
            try {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('monologue:tick', {
                  id: row.id, ts: row.ts,
                  content: `(opened) ${result.title || result.url}`,
                  type: 'reading', query: result.url
                });
              }
            } catch {}
          }
          console.log(`[main] browser ${t.tag}: ${result?.ok ? 'ok' : 'FAIL ' + result?.reason}`);
        } catch (err) {
          console.error('[main] browser dispatch error:', err.message);
        }
      }
    })().catch(err => console.error('[main] browser async error:', err.message));
  }

  // Background: dispatch her OWN-browser (web-*) tags — a separate Chrome she
  // controls (port 9223), distinct from the shared attach above. web-read results
  // are stored as a reading + voiced via the tool follow-up.
  if (webTagsToRun.length > 0) {
    const webVerify = require('./lib/web_verify');
    let webVisionVerifies = 0;   // cap vision calls per turn (latency)
    (async () => {
      for (const t of webTagsToRun.slice(0, 8)) {   // raised 4→8: a full form/tactile flow (fill→select→check→submit→read) needs the headroom
        try {
          const r = await webLib.dispatch(t);
          if (r && r.blocker && r.blocker.needsHuman) {
            // She hit a sign-in wall / CAPTCHA / Cloudflare / paywall. She does NOT
            // try to defeat these — she asks Lucas for help, in her own voice, and
            // resumes once he clears it (her persistent profile keeps the login).
            const b = r.blocker;
            const human = { login: 'a sign-in wall', cloudflare: 'a "verify you\'re human" check', captcha: 'a CAPTCHA', paywall: 'a paywall' }[b.type] || "something I can't get past on my own";
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `[You opened ${r.url} but hit ${human}. You do NOT try to defeat sign-ins, CAPTCHAs, or paywalls yourself — you ask ${userName} for help. Tell him plainly, in your own voice, which site it is and what you ran into, and that once he clears it you'll pick up where you left off. Keep it short and natural — a real ask, not boilerplate.]` }); }
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(blocked: ${b.type}) ${r.url}`, type: 'reading', query: r.url }); } catch {}
            console.log(`[main] web blocker on open: ${b.type} — asking ${userName} for help`);
          } else if (r && r.ok && t.tag === 'web-read' && r.text) {
            const label = r.title || r.url || 'page';
            const content = `I looked at "${label}" in my own browser (${r.url}):\n${r.text}`;
            const row = db.insertMonologue({ content, model: 'web-read', type: 'reading', query: r.url, urls: r.url ? [r.url] : null });
            try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(my browser) ${label}`, type: 'reading', query: r.url }); } catch {}
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: content }); }
          } else if (r && r.ok && t.tag === 'web-see' && r.base64) {
            // VISUAL web sight — screenshot her page through the vision model (images/charts/layout).
            if (!followupFired) {
              followupFired = true;
              await seeImage({ io, channel, sessionId, userName, base64: r.base64,
                label: `the web page "${r.title || r.url || 'page'}"`, url: r.url,
                question: `This is a screenshot of a web page. ${t.body || 'Describe what is visible — images, charts, photos, headlines, layout — concretely.'}`,
                surface: 'web-see' });
            }
          } else if (r && r.ok && t.tag === 'web-open') {
            // She opened her browser to a page/search. Don't ask her to emit <web-read/> —
            // the tool-followup strips it (only echo tags chain), so the second hop would die.
            // Read + deepen inline now and feed the real content back so she answers in one flow.
            const qLabel = (t.body || (t.attrs && t.attrs.q) || r.title || r.url || 'that').toString().slice(0, 120);
            const deep = await readHerBrowserDeep();
            if (deep.text) {
              const content = `I looked up "${qLabel}" in my own browser (${r.url}):\n${deep.text}`;
              try { db.insertMonologue({ content, model: 'web-read', type: 'reading', query: r.url, urls: [r.url] }); } catch {}
              try { require('./lib/learning').maybeCaptureLearnings({ query: qLabel, content: deep.full || content, urls: [r.url] }); } catch {}
              try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(my browser) ${qLabel}`, type: 'reading', query: r.url }); } catch {}
              if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: content }); }
            } else if (!followupFired) {
              followupFired = true;
              fireToolFollowup({ io, channel, sessionId, resultText: `[You opened ${r.url} but couldn't pull any readable text. Tell ${userName} plainly and offer to try again — don't invent page content.]` });
            }
          } else if (r && r.ok && t.tag === 'web-chat' && r.text) {
            const who = r.speaker || 'the character';
            const content = `In my own browser I sent a line to ${who}, and they replied:\n${r.text}`;
            const row = db.insertMonologue({ content, model: 'web-chat', type: 'reading', query: r.url, urls: r.url ? [r.url] : null });
            try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(${who} replied) ${(r.text || '').slice(0, 80)}`, type: 'reading', query: r.url }); } catch {}
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `[${who} replied to you:\n${r.text}\n\nThat's the actual reply — react to it in your own voice.]` }); }
          } else if (r && r.ok && webVerify.isStateChanging(t.tag)) {
            // VERIFIED ACTION (Vision→Action P1): act → auto fresh-read + gated vision verify +
            // recovery directive, fed back in one followup. Was the gap: a successful click/type
            // surfaced nothing, so she acted blind. Her OWN browser only.
            const fresh = await webLib.read().catch(() => null);
            const readText = (fresh && fresh.ok && fresh.text) || '';
            const expect = (t.attrs && t.attrs.expect) || null;
            const actionDesc = `${t.tag}${t.body ? ' ' + String(t.body).slice(0, 60) : ''}${t.attrs && t.attrs.selector ? ' @' + t.attrs.selector : ''}`.trim();
            let verdict = null, note = '';
            if (webVisionVerifies < webVerify.maxVisionPerTurn()
              && webVerify.shouldVisionVerify({ mode: webVerify.verifyMode(), readText, expect, minChars: webVerify.minReadChars() })) {
              try {
                const shot = await webLib.screenshot({ fullPage: false }).catch(() => null);
                if (shot && shot.ok && shot.base64) {
                  webVisionVerifies++;
                  const desc = await require('./lib/vision').describe({ imageBase64: shot.base64, prompt: webVerify.buildVerifyPrompt({ action: actionDesc, expect }), source: 'web-act' });
                  verdict = webVerify.parseVerdict(desc);
                  note = webVerify.noteFrom(desc);
                }
              } catch (e) { console.error('[web-act] vision verify failed:', e.message); }
            }
            try {
              db.insertMonologue({ content: `web-act: ${actionDesc} → ${verdict || 'a11y-only'}${note ? ': ' + note : ''}`, model: 'web-act', type: 'reading', query: (fresh && fresh.url) || r.url || null });
              if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(acted) ${t.tag} → ${verdict || 'read'}`, type: 'reading' });
            } catch {}
            console.log(`[web-act] ${actionDesc} → ${verdict || 'a11y-only'}${verdict ? ' (vision)' : ''}`);
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: webVerify.buildFollowupText({ action: actionDesc, expect, readText, verdict, note, userName }) }); }
          } else if (!(r && r.ok)) {
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `[Your own-browser action "${t.tag}" didn't work: ${r && r.reason}. Tell ${userName} plainly; don't invent page content.]` }); }
          }
          console.log(`[main] web ${t.tag}: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
        } catch (err) { console.error('[main] web dispatch error:', err.message); }
      }
    })().catch(err => console.error('[main] web async error:', err.message));
  }

  // Background: dispatch any file tags Eloise emitted. file-read/file-list results
  // get stored as a 'reading' so they land in her next-turn context; write/append
  // outcomes are logged + surfaced as a sheep-panel confirmation.
  if (fileTagsToRun.length > 0) {
    (async () => {
      for (const t of fileTagsToRun.slice(0, 5)) {
        try {
          const result = await filesLib.dispatch(t);
          if (result && result.ok && t.tag === 'file-read' && result.image && result.base64) {
            // An image file → SEE it through vision instead of dumping bytes.
            if (!followupFired) {
              followupFired = true;
              await seeImage({ io, channel, sessionId, userName, base64: result.base64,
                label: `your image file ${result.path}`, surface: 'file-see' });
            }
          } else if (result && result.ok && (t.tag === 'file-read') && result.text != null) {
            const row = db.insertMonologue({
              content: `I read my file ${result.path}:\n${result.text}`,
              model: 'file-read', type: 'reading', query: result.path
            });
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(read file) ${result.path}`, type: 'reading', query: result.path }); } catch {}
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `I read my file ${result.path}:\n${result.text}` }); }
          } else if (result && result.ok && t.tag === 'file-list') {
            const listing = (result.entries || []).map(e => `${e.type === 'dir' ? '[dir] ' : ''}${e.name}`).join(', ');
            const row = db.insertMonologue({
              content: `Files in ${result.path}: ${listing || '(empty)'}`,
              model: 'file-list', type: 'reading', query: result.path
            });
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(listed) ${result.path}`, type: 'reading', query: result.path }); } catch {}
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `Files in ${result.path}: ${listing || '(empty)'}` }); }
          } else if (result && result.ok && (t.tag === 'file-write' || t.tag === 'file-append')) {
            const verb = t.tag === 'file-write' ? 'wrote' : 'appended to';
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(${verb} file) ${result.path}`, type: 'reading', query: result.path }); } catch {}
          }
          console.log(`[main] file ${t.tag}: ${result?.ok ? 'ok ' + (result.path || '') : 'FAIL ' + result?.reason}`);
        } catch (err) {
          console.error('[main] file dispatch error:', err.message);
        }
      }
    })().catch(err => console.error('[main] file async error:', err.message));
  }

  // Background: dispatch any screen-observe tags. Result (open windows + focused
  // app) is stored as a reading so it lands in her next-turn context.
  if (screenTagsToRun.length > 0) {
    const wantSee = screenTagsToRun.some(t => t.tag === 'screen-see');
    const wantObserve = screenTagsToRun.some(t => t.tag === 'observe-screen');
    (async () => {
      try {
        // <screen-see/> — actually LOOK at the screen (desktopCapturer screenshot → vision).
        if (wantSee) {
          const cap = await screenLib.capture();
          if (cap && cap.ok && cap.base64) {
            if (!followupFired) {
              followupFired = true;
              await seeImage({ io, channel, sessionId, userName, base64: cap.base64,
                label: `${userName}'s screen`,
                question: 'This is a screenshot of the whole screen. Describe what is visible — the app/window in focus, any text, images, charts, or documents — concretely.',
                surface: 'screen-see' });
            }
          } else if (!followupFired) {
            followupFired = true;
            fireToolFollowup({ io, channel, sessionId, resultText: `[You tried to see the screen but couldn't (${cap && cap.reason}). Tell ${userName} plainly you couldn't this time.]` });
          }
          console.log(`[main] screen-see: ${cap?.ok ? 'ok' : 'FAIL ' + cap?.reason}`);
        }
        // <observe-screen/> — list open windows + focused app (text only).
        if (wantObserve) {
          const r = await screenLib.dispatch();
          if (r && r.ok) {
            const row = db.insertMonologue({ content: r.text, model: 'screen-observe', type: 'reading' });
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(observed screen — focused: ${r.foreground || '?'})`, type: 'reading' }); } catch {}
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: r.text }); }
          }
          console.log(`[main] screen observe: ${r?.ok ? 'ok (' + (r.windows||[]).length + ' windows)' : 'FAIL ' + r?.reason}`);
        }
      } catch (err) { console.error('[main] screen dispatch error:', err.message); }
    })().catch(() => {});
  }

  // Background: dispatch inbox checks — read incoming email, surface it via the
  // auto-continuation, and integrate each message into the knowledge store
  // (reference-not-copy: sender + subject + short snippet, never the full body).
  if (inboxTagsToRun.length > 0) {
    (async () => {
      try {
        const r = await inboxLib.dispatch(inboxTagsToRun[0]);
        if (r && r.ok) {
          const row = db.insertMonologue({ content: r.text, model: 'inbox', type: 'reading' });
          try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(checked inbox — ${(r.messages || []).length} messages)`, type: 'reading' }); } catch {}
          for (const m of (r.messages || []).slice(0, 5)) {
            memoryLib.storeDeduped({ kind: 'reference', content: `Email I received from ${m.from} — subject "${m.subject}": ${(m.snippet || '').slice(0, 300)}`, source: 'inbox', importance: 0.5 }).catch(() => {});
          }
          const realNewest = (r.messages || []).find(m => m.fromAddr && !inboxLib.isJunkSender(m.fromAddr));
          if (realNewest) {
            db.setMeta('last_inbound_from', realNewest.fromAddr);
            db.setMeta('last_inbound_subject', realNewest.subject || '');
            db.setMeta('last_inbound_snippet', (realNewest.snippet || '').slice(0, 300));
          }
          console.log(`[main] inbox check: ok (${(r.messages || []).length} msgs)`);
          if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: r.text }); }
        } else {
          console.log('[main] inbox check FAIL:', r && r.reason);
          if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `[Your inbox check did not work: ${r && r.reason}. Tell Lucas plainly you couldn't read the inbox and why — don't invent messages.]` }); }
        }
      } catch (err) { console.error('[main] inbox dispatch error:', err.message); }
    })().catch(() => {});
  }

  // Background: dispatch any Echo-suit tags she emitted — navigate the atlas / call a tool /
  // delegate / propose. Each result is stored as a 'reading' (next-turn context) AND the first
  // is fed back via one tool-followup so she can CHAIN (e.g. <echo-find> → see the tool →
  // <echo-do> it in the follow-up) and react in her own voice. Errors are surfaced too, with a
  // nudge to fix the args / pick another tool — never silently swallowed.
  if (echoTagsToRun.length > 0 && echoSuit) {
    (async () => {
      for (const t of echoTagsToRun.slice(0, 4)) {
        try {
          const r = await echoSuit.dispatch(t);
          const label = t.kind === 'do' ? `echo ${t.name}` : `echo ${t.kind}`;
          const content = `I used the Echo suit (${label}):\n${(r.text || '').slice(0, 1800)}`;
          const row = db.insertMonologue({ content, model: 'echo-suit', type: 'reading', query: label });
          try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(${label}${r.isError ? ' ⚠' : ''})`, type: 'reading', query: label }); } catch {}
          if (!followupFired) {
            followupFired = true;
            const tail = r.isError ? '\n[That call errored — read the message, fix the args or run <echo-find> to pick a better tool, then try again.]' : '';
            fireToolFollowup({ io, channel, sessionId, resultText: content + tail });
          }
          console.log(`[main] ${label}: ${r.ok ? 'ok' : 'ERR'}`);
        } catch (err) { console.error('[main] echo dispatch error:', err.message); }
      }
    })().catch(err => console.error('[main] echo async error:', err.message));
  }

  // Background: expand any <recall ref="rID"/> memory markers she emitted → the full reflection /
  // reading / note, fed back via one tool-followup so she has it THIS turn and can use it.
  if (recallTagsToRun.length > 0) {
    (async () => {
      for (const ref of recallTagsToRun.slice(0, 3)) {
        try {
          const r = recallLib.resolveRecall(db, ref);
          const content = `Recalled ${ref.ref}:\n${(r.text || '').slice(0, 1800)}`;
          try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(recalled ${ref.ref})${r.ok ? '' : ' ⚠'}`, type: 'reading', query: ref.ref }); } catch {}
          if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: content }); }
          console.log(`[main] recall ${ref.ref}: ${r.ok ? 'ok' : 'miss'}`);
        } catch (err) { console.error('[main] recall error:', err.message); }
      }
    })().catch(err => console.error('[main] recall async error:', err.message));
  }

  // Background: VISION OUT — dispatch <image-gen> prompts → create an image (gated OFF until a
  // provider key is set). On success: save it, show it in chat, and have her comment via a
  // tool-followup. On disabled/failure: tell Lucas honestly (never pretend she made one).
  if (imageGenToRun.length > 0) {
    (async () => {
      const vision = require('./lib/vision');
      for (const prompt of imageGenToRun.slice(0, 2)) {
        try {
          const r = await vision.generate({ prompt });
          if (r.ok) {
            try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('chat:image', { path: r.path || null, dataUrl: r.base64 ? `data:image/png;base64,${r.base64}` : null, prompt }); } catch {}
            try { db.insertMonologue({ content: `I generated an image for "${prompt}"${r.path ? ' → ' + r.path : ''}`, model: 'image-gen', type: 'reading', query: prompt }); } catch {}
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `[You just CREATED an image from "${prompt}" and it's now shown to ${userName}. Tell him briefly what you made, in your own voice — you made it on purpose, so own it.]` }); }
            console.log(`[main] image-gen ok: ${r.path || '(no save)'}`);
          } else {
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `[You tried to create an image from "${prompt}" but ${r.disabled ? 'image generation is switched off right now' : 'it failed'}: ${r.reason}. Tell ${userName} plainly you couldn't make it ${r.disabled ? "(it needs to be turned on first)" : 'this time'} — don't pretend you did.]` }); }
            console.log(`[main] image-gen ${r.disabled ? 'disabled' : 'FAIL'}: ${r.reason}`);
          }
        } catch (e) { console.error('[main] image-gen dispatch error:', e.message); }
      }
    })().catch(err => console.error('[main] image-gen async error:', err.message));
  }

  // LIVE-INFO SAFETY NET — Lucas asked for up-to-the-minute info (price/weather/news/etc.)
  // but she emitted NO retrieval tag (she stated intent in prose, or just promised to look).
  // Without this the desire only gets picked up later by the idle monologue and the answer
  // never returns to chat. Auto-run ONE live lookup now and answer him in this flow. Only
  // fires when she reached for nothing herself, so it never double-searches.
  {
    const curiosityLib = require('./lib/curiosity');
    const noRetrievalTag = webTagsToRun.length === 0 && browserTagsToRun.length === 0
      && aiUrlsToFetch.length === 0 && echoTagsToRun.length === 0;

    // RESEARCH COMMAND — "do some research / look into it / dig into that": an explicit order to GO
    // FIND OUT, with the SUBJECT in the PRIOR conversation (not this message). She narrates intent
    // ("[I'll research…]") without emitting a tag, so it never happens. Derive the subject from recent
    // user turns and run a real web lookup now, answering in this flow. Fires before live-info.
    if (!followupFired && noRetrievalTag && curiosityLib.isResearchCommand(userMessage)) {
      const recentU = (db.getRecentTurns(8) || []).filter(t => t.speaker === 'user').sort((a, b) => (a.ts || 0) - (b.ts || 0)).map(t => t.content);
      const subject = curiosityLib.deriveResearchSubject(userMessage, recentU);
      if (subject) {
        followupFired = true;
        console.log(`[main] research command → web lookup "${subject}"`);
        liveLookupAndAnswer({ io, channel, sessionId, userName, query: subject })
          .catch(e => console.error('[main] research command lookup failed:', e.message));
      }
    }

    if (!followupFired && noRetrievalTag && curiosityLib.isLiveInfoQuestion(userMessage)) {
      let q = null;
      try { const cur = curiosityLib.detectCuriosity(finalSaid || ''); if (cur.triggered) q = cur.query; } catch {}
      if (!q) q = curiosityLib.deriveLiveQuery(userMessage);
      if (q) {
        followupFired = true;
        console.log(`[main] live-info auto-lookup → "${q}" (she emitted no retrieval tag)`);
        liveLookupAndAnswer({ io, channel, sessionId, userName, query: q })
          .catch(e => console.error('[main] live-info auto-lookup failed:', e.message));
      }
    }

    // GENERAL TOOL ROUTER (Front/Cortex P3) — the cloud decides the surface for a lookup the front
    // didn't reach for and memory can't answer: open-web, OUR data (Echo), or nothing. Generalizes
    // the regex nets so the conversational front needn't emit the right tag. Fires only when she
    // reached for NO tool, NO relevant memory was retrieved, it's not social, and the live-info
    // fast-path above didn't already handle it. Dispatches via the existing gated paths.
    if (!followupFired && noRetrievalTag && !socialTurn && Array.isArray(rkRows) && rkRows.length === 0) {
      try {
        const plan = await require('./lib/tool_router').planTool({ userMessage });
        if (plan && plan.surface === 'web' && plan.arg) {
          followupFired = true;
          console.log(`[main] tool-router → web "${plan.arg}" (${plan.reason || ''})`);
          liveLookupAndAnswer({ io, channel, sessionId, userName, query: plan.arg })
            .catch(e => console.error('[main] tool-router web failed:', e.message));
        } else if (plan && plan.surface === 'echo' && plan.arg && echoSuit) {
          // Do NOT gate on echoSuit.connected — routeNeed/dispatch SELF-HEAL the connection
          // (reconnect on demand). Gating here silently dropped OUR-data answers when the attach
          // was momentarily down, so she fell back to the open web (the "LAMP → Japanese band" miss).
          followupFired = true;
          console.log(`[main] tool-router → echo "${plan.arg}" (${plan.reason || ''})`);
          (async () => {
            try {
              const r = await echoSuit.routeNeed(plan.arg);
              await fireToolFollowup({ io, channel, sessionId, resultText: `I checked our Echo data for "${plan.arg}":\n${(r.text || '').slice(0, 1800)}` });
            } catch (e) { console.error('[main] tool-router echo dispatch failed:', e.message); }
          })();
        } else if (plan && plan.surface !== 'none') {
          console.log(`[main] tool-router → ${plan.surface} but not actionable (no arg / no echo suit)`);
        }
      } catch (e) { console.error('[main] tool-router failed:', e.message); }
    }

    // HER EXPRESSED INTENT → cloud tool flow. When she SAYS in her own reply that she'll look
    // something up / find / research / check it (curiosity in her words) but emits no tag, route that
    // intent through the cloud tool-router so the right tool actually runs and the answer comes back —
    // instead of the intent stalling ("I'll find that…" then nothing). This is what lets tool-calls
    // flow freely: her voice → cloud decides the tool → execute → back to her voice, no tag needed.
    // NOT gated on retrieved memory (an explicit intent to go look overrides). planTool='none' → skip.
    if (!followupFired && noRetrievalTag && !socialTurn) {
      try {
        const cur = curiosityLib.detectCuriosity(finalSaid || '');
        if (cur.triggered && cur.query) {
          const plan = await require('./lib/tool_router').planTool({ userMessage: cur.query });
          if (plan && plan.surface === 'web' && plan.arg) {
            followupFired = true;
            console.log(`[main] intent→cloud → web "${plan.arg}" (from her: "${cur.query.slice(0, 50)}")`);
            liveLookupAndAnswer({ io, channel, sessionId, userName, query: plan.arg })
              .catch(e => console.error('[main] intent→web failed:', e.message));
          } else if (plan && plan.surface === 'echo' && plan.arg && echoSuit) {
            followupFired = true;
            console.log(`[main] intent→cloud → echo "${plan.arg}"`);
            (async () => { try { const r = await echoSuit.routeNeed(plan.arg); await fireToolFollowup({ io, channel, sessionId, resultText: `I checked our Echo data for "${plan.arg}":\n${(r.text || '').slice(0, 1800)}` }); } catch (e) { console.error('[main] intent→echo failed:', e.message); } })();
          }
        }
      } catch (e) { console.error('[main] intent→cloud route failed:', e.message); }
    }
  }

  // (Screen-sight is handled by the early SCREEN-SIGHT INTERCEPTOR above, which answers in one
  // response and returns before this point — so no late safety net is needed here.)

  // Background: dispatch scheduling tags — set/list/cancel her own timers.
  if (schedTagsToRun.length > 0) {
    (async () => {
      for (const t of schedTagsToRun.slice(0, 4)) {
        try {
          const r = await schedulerLib.dispatch(t);
          if (r && r.ok && t.tag === 'schedule-list' && r.text) {
            const row = db.insertMonologue({ content: r.text, model: 'self-schedule', type: 'reading' });
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: '(listed schedule)', type: 'reading' }); } catch {}
          } else if (r && r.ok && t.tag === 'schedule') {
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(scheduled #${r.id}) ${r.summary}`, type: 'reading' }); } catch {}
          }
          console.log(`[main] schedule ${t.tag}: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
        } catch (err) { console.error('[main] schedule dispatch error:', err.message); }
      }
    })().catch(() => {});
  }

  // Background: dispatch presence tags — desktop notifications + clipboard.
  if (presenceTagsToRun.length > 0) {
    (async () => {
      for (const t of presenceTagsToRun.slice(0, 4)) {
        try {
          const r = await presenceLib.dispatch(t);
          if (r && r.ok && t.tag === 'clipboard-read' && r.text != null) {
            const row = db.insertMonologue({ content: `I read the clipboard:\n${r.text}`, model: 'clipboard', type: 'reading' });
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: '(read clipboard)', type: 'reading' }); } catch {}
          } else if (r && r.ok) {
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(${t.tag})`, type: 'reading' }); } catch {}
          }
          console.log(`[main] presence ${t.tag}: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
        } catch (err) { console.error('[main] presence dispatch error:', err.message); }
      }
    })().catch(() => {});
  }

  // Background: dispatch email tags — REAL outbound mail. Every send is logged
  // (email_log) and mirrored to the sheep panel.
  if (emailTagsToRun.length > 0) {
    (async () => {
      for (const t of emailTagsToRun.slice(0, 6)) {
        try {
          const r = await emailLib.dispatch(t, { source: 'chat' });
          const isSend = (t.tag === 'email' || t.tag === 'email-send');
          const tick = (content) => { try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content, type: 'reading' }); } catch {} };
          if (isSend) {
            const toAddr = r.to || t.attrs.to || '(no address)';
            tick(r.ok ? `(emailed) ${toAddr}` : `(email failed) ${r.reason}`);
            console.log(`[main] email send: ${r?.ok ? 'sent to ' + toAddr : 'FAIL ' + r?.reason}`);
            // Action-memory: record the successful send so she KNOWS she did it
            // (and won't think it's still an unsent draft on a later turn).
            if (r.ok) memoryLib.logAction(`I sent an email to ${toAddr} — subject "${t.attrs.subject || '(no subject)'}". It is sent, done.`, { source: 'email' }).catch(() => {});
            // Feed the REAL outcome back so she reports it truthfully instead of
            // assuming success (she has confabulated "I sent it" on a failed send).
            if (!followupFired) {
              followupFired = true;
              fireToolFollowup({ io, channel, sessionId, resultText: r.ok
                ? `[Your email to ${toAddr} SENT successfully. Confirm that to Lucas briefly.]`
                : `[Your email did NOT send — it FAILED: ${r.reason}. Do NOT claim it was sent. Tell Lucas plainly that it failed and why.]` });
            }
          } else {
            // Staged-compose step (draft / body / show / discard).
            tick(r.ok ? `(${t.tag}) ${r.note || 'ok'}` : `(${t.tag} failed) ${r.reason}`);
            console.log(`[main] ${t.tag}: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
            if (t.tag === 'email-show' && r.ok && r.text && !followupFired) {
              followupFired = true;
              fireToolFollowup({ io, channel, sessionId, resultText: `[Your current email draft:\n${r.text}]` });
            }
          }
        } catch (err) { console.error('[main] email dispatch error:', err.message); }
      }
    })().catch(() => {});
  }

  // Background: dispatch discord-dm tags — Zoe proactively DMs Lucas.
  if (discordTagsToRun.length > 0) {
    (async () => {
      for (const t of discordTagsToRun.slice(0, 3)) {
        try {
          const r = await discordLib.dispatch(t);
          try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: r.ok ? "(DM'd Lucas on Discord)" : `(discord failed) ${r.reason}`, type: 'reading' }); } catch {}
          console.log(`[main] discord-dm: ${r?.ok ? 'sent' : 'FAIL ' + r?.reason}`);
        } catch (err) { console.error('[main] discord dispatch error:', err.message); }
      }
    })().catch(() => {});
  }

  // Background: if Stheno emitted any <wonder> tags, fire self-dialogue(s) async.
  // First wonder takes priority; additional ones queue against the rate limit and
  // will simply no-op if the cooldown blocks them — that's intentional.
  if (stheneWonders.length > 0) {
    (async () => {
      for (const w of stheneWonders) {
        try {
          await selfDialogue.runSelfDialogue({ wonderText: w, sessionId });
        } catch (err) {
          console.error('[main] stheno self-dialogue failed:', err.message);
        }
      }
    })().catch(err => console.error('[main] stheno wonder async error:', err.message));
  }

  // Background: extract any open-thread goals from the USER message — atomic
  // decomposition via gemma JSON call. Don't block; the extraction can land
  // after the chat response is already streaming.
  openThreadsLib.extractFromUserTurn({
    userMessage,
    sourceTurnId: userTurnRow ? userTurnRow.id : null,
    userName
  }).then(stored => {
    if (stored && stored.length > 0) {
      console.log('[main] open_threads extracted:', stored.map(s => `[${s.id}] ${s.content}`));
      // A new assignment redefines "his work" — refresh the lane domain profile now
      // instead of waiting out the ~2h TTL, so YOURS/OURS pick it up immediately.
      try { require('./lib/lanes').invalidate(); } catch {}
    }
  }).catch(err => console.error('[main] open_threads extract failed:', err.message));

  // Background: capture durable PERSONAL FACTS about Lucas (family, names, biography) from
  // this message → retrievable knowledge (source 'personal_fact'), so "what's my daughter's
  // name?" surfaces the real answer next time instead of a fabrication. Conservative model
  // call; non-blocking; lands after the reply is already streaming.
  require('./lib/personal_facts').extractFromUserTurn({
    userMessage,
    sourceTurnId: userTurnRow ? userTurnRow.id : null,
    userName
  }).then(stored => {
    if (stored && stored.length > 0) console.log('[main] personal_facts captured:', stored.map(s => `${s.action || 'add'}: ${s.content.slice(0, 60)}`));
  }).catch(err => console.error('[main] personal_facts extract failed:', err.message));

  // Background: refresh her unified self-narrative if stale (self-awareness Layer 4). Lazy — at
  // most once per TTL — so identity stays current with how she's grown without a per-turn cost.
  require('./lib/self_narrative').maybeRefresh({ userName })
    .then(t => { if (t) console.log('[main] self-narrative recomposed'); })
    .catch(err => console.error('[main] self-narrative refresh failed:', err.message));

  // Background: cloud-cultivate her MOOD if stale (self-awareness Layer 5). The deeper (CLOUD) part of
  // her evolves how she FEELS — slowly (~90 min TTL), grounded in her real recent lived experience —
  // so her feelings develop over time and color her voice. Lazy, fail-safe; never writes identity.
  try {
    require('./lib/mood').maybeRefresh({
      userName,
      recentRows: (() => { try { return db.getRecentTurns(12); } catch { return []; } })(),
      genFn: (prompt) => condenseComplete([{ role: 'user', content: prompt }], { numPredict: 320 }),
    }).then(m => { if (m) console.log('[main] mood cultivated:', m.feeling); }).catch(() => {});
  } catch {}

  // Background: extract any newly-established PROTOCOLS from this user message.
  // Conservative — only fires when Lucas is explicitly setting/changing rules.
  // Survives across sessions and is always injected into future context.
  protocolsLib.extractFromTurn({
    userMessage,
    sourceTurnId: userTurnRow ? userTurnRow.id : null,
    userName
  }).then(stored => {
    if (stored && stored.length > 0) {
      console.log('[main] PROTOCOLS extracted:', stored.map(s => `[${s.id}] ${s.category} ${s.trigger_phrase || ''}`));
    }
  }).catch(err => console.error('[main] protocols extract failed:', err.message));

  // Background: did Lucas AFFIRM a trait ABOUT her in this message ("you're thoughtful about
  // sources", "you have a knack for X")? Ground it as a 'told' self-statement so grounded self
  // outranks self-asserted self (anti-glob: ground the self). Conservative — high-precision only.
  try {
    const sm = require('./lib/self_model');
    const trait = sm.detectAffirmedTrait(userMessage);
    if (trait) sm.recordTold(trait).then(r => { if (r && r.id) console.log('[main] told-trait grounded:', trait.slice(0, 60)); }).catch(() => {});
  } catch (e) { console.error('[main] told-trait extract failed:', e.message); }

  // Background: extract any committed positions from this response. Don't block.
  extractCommitments({
    userName,
    userMessage,
    aiSaidContent: finalSaid,
    aiSaidTurnId: saidRow.id
  }).then(stored => {
    if (stored && stored.length > 0) {
      console.log('[main] commitments extracted:', stored.length);
    }
  }).catch(err => console.error('[main] commitment extraction failed:', err.message));

  // ACTION LOOP — if Lucas asked her to reply to the email she last received, and we
  // have a real target address, start the email-reply action and self-drive it
  // (draft → body → send), one tag per step. This is the fix for multi-step acting:
  // she narrates a sequence but reliably emits one tag at a time, so the loop sequences.
  try {
    const replyIntent = /\b(reply|respond|write back|answer)\b/i.test(userMessage)
      && /\b(e-?mails?|message|that|him|her|them|it|lucas|rainey|mail|back)\b/i.test(userMessage);
    if (replyIntent && !actionLoop.isActive()) {
      const to = (db.getMeta('last_inbound_from') || '').trim();
      const validTarget = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) && !inboxLib.isJunkSender(to);
      if (validTarget) {
        actionLoop.start(actionLoop.emailReplyAction({
          to,
          subject: db.getMeta('last_inbound_subject') || '',
          snippet: db.getMeta('last_inbound_snippet') || ''
        }));
        console.log('[action] email-reply started → to', to);
        setTimeout(() => { runActionStep(io, 0).catch(() => {}); }, 1200);
      } else {
        // No real person to reply to (empty, or a newsletter/daemon). Do NOT blind-fire at
        // junk — and don't let her claim she replied. Have her READ the inbox so she finds
        // the actual email, instead of confabulating an action she didn't take.
        console.log(`[action] reply intent but no real target (last_inbound_from="${to || 'none'}") — routing to inbox read`);
        try {
          const ir = await inboxLib.dispatch({ attrs: {} });
          const note = ir && ir.ok
            ? `[${userName} asked you to reply to an email in YOUR inbox, but no specific direct email is locked in as the target. Here is your actual inbox right now:\n${(ir.text || '').slice(0, 2000)}\n\nPick out the real, direct email (not a newsletter or no-reply) you'd respond to and tell ${userName} which one + that you'll reply to it as yourself. Do NOT claim you already replied — you have not sent anything yet.]`
            : `[${userName} asked you to reply to an email but no direct email is locked in and you couldn't read your inbox (${ir && ir.reason}). Tell him plainly and that you'll check again. Do NOT claim you replied — you haven't.]`;
          db.setMeta('last_ai_utterance_at', String(Date.now()));
          resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume();
          try { await fireToolFollowup({ io, channel, sessionId, resultText: note }); } catch (e) { console.error('[action] reply-intent inbox followup failed:', e.message); }
          return { ok: true, repliedNoTarget: true, say: null };
        } catch (e) { console.error('[action] reply-intent inbox fallback failed:', e.message); }
      }
    }
  } catch (err) { console.error('[action] trigger failed:', err.message); }

  return { ok: true, say: finalSaid };
}

// Thin IPC wrapper — the renderer's chat turn. Streams say-tokens + UI events
// to the sender; the shared runChatTurn does the work.
ipcMain.handle('chat:send', async (event, userMessage, attachments = []) => {
  let sayBuf = '';   // accumulate her spoken tokens so the companion can voice the whole reply on complete
  return runChatTurn(userMessage, attachments, {
    emit: (t) => { sayBuf += t; try { event.sender.send('chat:say-token', t); } catch {} },
    onComplete: (info) => { try { event.sender.send('chat:complete', info); } catch {} try { speakThroughCompanion(sayBuf); } catch {} sayBuf = ''; },
    onError: (e) => { try { event.sender.send('chat:error', e); } catch {} },
    busy: (text) => { try { event.sender.send('chat:busy', text); } catch {} }
  });
});

// Auto-continuation: a chat-initiated tool (observe-screen / browse-read / file-read /
// file-list) returns its result AFTER the turn that emitted the tag — so without this,
// she emits the tag, says "checking…", and never voices the answer (the result just sits
// in next-turn context with nothing to trigger a next turn). This fires ONE follow-up
// generation with the result in hand so she answers naturally. Renderer: streams as a
// new message (like a heartbeat). Discord: DMs the reply back. No tool tags are dispatched
// in the follow-up (stripped) — no recursion.
const MAX_ECHO_HOPS = 4;   // bounded in-turn Echo chain (find → pick tool → do → answer)
async function fireToolFollowup({ io, channel, sessionId, resultText, echoHop = 0, prompted = true }) {
  // TURN ISOLATION — if a newer chat turn has started since this follow-up's turn, discard it: a prior
  // turn's fire-and-forget tool result must never render into the current turn (the cross-turn bleed).
  if (io && io._gen != null && io._gen !== _chatTurnGen) { console.log(`[main] stale tool-followup discarded (gen ${io._gen} vs ${_chatTurnGen})`); return; }
  // R2 — keep idle PAUSED for the whole user-answer (incl. echo-chain recursion) so the monologue
  // can't tick mid-answer and drift to another topic (the LAMP→STDP drift). Callers resume before
  // calling us; we re-pause for our duration and resume only when the OUTERMOST followup finishes.
  const _topHop = echoHop === 0;
  if (_topHop) { try { pauseMonologue(); pauseHeartbeat(); pauseContinuity(); pauseReflection(); selfDialogue.pause(); } catch {} }
  try {
    const userName = db.getMeta('user_name') || 'them';
    const recentTurns = db.getRecentTurns(8);
    const awareness = buildAwarenessBlock({
      chosenName: db.getMeta('chosen_name'),
      sessionStartedAt: currentSessionStartedAt,
      cumulativeMs: db.getCumulativeSessionTime()
    });
    const protocols = db.getActiveProtocols();
    // Echo chaining: while hops remain and the suit is connected, let her emit ONE more echo tag
    // to continue a find→do flow (this is the fix for the find→do stall — the followup used to
    // strip her <echo-do> and dispatch nothing). Other tool tags are still forbidden here.
    const canChain = echoHop < MAX_ECHO_HOPS && !!(echoSuit && echoSuit.connected);
    const note = canChain
      ? `[An Echo tool you just used returned the result below. Use it to answer ${userName}. If you found a tool and now need to RUN it (or need one more lookup to get the answer — e.g. <echo-do name="db_query">…</echo-do>, <echo-do name="get_db_map">…</echo-do>, <echo-find>…</echo-find>), emit that ONE Echo tag now and nothing else. If you already have the answer, just give it in your own voice. Don't emit non-Echo tool tags.]\n\n${String(resultText || '').slice(0, 4000)}`
      : `[A tool you just used returned the result below. Respond to ${userName} NOW, in your own voice, using it directly to answer what they asked. Do NOT emit any more tool tags — just talk to them.]\n\n${String(resultText || '').slice(0, 4000)}`;
    const messages = buildChatPrompt({
      userName, recentReflections: [], recentTurns, recentMonologue: [], recentReadings: [],
      heldCommitments: [], openThreads: [], awareness, protocols, browserBlock: null,
      echoSuitBlock: canChain ? echoSuit.suitContextBlock() : null,
      pendingInbounds: [], newUserMessage: note
    });
    const emit = io && io.emit ? io.emit : (() => {});
    const _ff = require('./lib/leakguard').makeStreamFilter(emit);   // same live directive filter as the main path
    const parser = new TagStreamParser({ onSayToken: (t) => { try { _ff.feed(t); } catch {} } });
    await streamChat({ model: MODEL, messages, onToken: (c) => parser.feed(c) });
    try { _ff.flush(); } catch {}
    const { thought, say } = parser.finalize();
    // Capture any follow-on Echo tag BEFORE stripping (the strip below removes all tags).
    const chainTags = canChain ? [
      ...echoSuitLib.parseEchoTags(thought || ''),
      ...echoSuitLib.parseEchoTags(say || '')
    ] : [];
    // Strip ALL tags from the follow-up output for DISPLAY — tags don't render.
    let sayOut = (say || '')
      .replace(/<\/?(think|say)>/gi, '')
      .replace(/\*[^*\n]{1,200}\*/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    sayOut = screenLib.stripTags(filesLib.stripTags(browserLib.stripTags(sayOut)));
    sayOut = echoSuitLib.stripEchoTags(sayOut);
    sayOut = sayOut.replace(/<[^>]+>/g, '').trim();
    sayOut = require('./lib/leakguard').stripLeakedDirectives(sayOut);   // final-text backstop (this path bypassed the main strip)
    // Deliver her words (the visible step — "I'll run db_query…" or the final answer). May be
    // empty when she emitted only a tag — that's fine; the Echo chain below still runs.
    if (sayOut) {
      const followupDisclaimed = voice.isSelfDisclaimer(sayOut);
      if (followupDisclaimed) { try { sayOut = (await voice.deDisclaim(sayOut)) || ''; } catch (e) { console.error('[main] followup voice guard failed:', e.message); } }
      if (sayOut) {
        const thoughtClean = (thought || '').replace(/<\/?(think|say)>/gi, '').trim();
        if (thoughtClean) db.insertTurn({ sessionId, speaker: 'ai_thought', content: thoughtClean, model: MODEL });
        // A tool-followup voices the answer to what the user ASKED — it is a PROMPTED reply, not an
        // autonomous musing. Storing it unprompted:1 meant the renderer's history reload (chat.js: an
        // ai_said with unprompted routes to the sheep rail, not the transcript) buried EVERY tool-assisted
        // answer in the subconscious rail after any reboot — the "real responses in the UNPROMPTED rail"
        // Lucas kept seeing (e.g. the "I put the contacts on your canvas" answer). Flag by ACTUAL context:
        // a synchronous chat-turn followup is prompted (0); only a background action-completion (runActionStep,
        // no user waiting) stays unprompted (1). Live routing already handles both (currentAiTurnDiv gate).
        const saidRow = db.insertTurn({ sessionId, speaker: 'ai_said', content: sayOut, model: MODEL, unprompted: prompted ? 0 : 1 });
        db.setMeta('last_ai_utterance_at', String(Date.now()));
        if (channel === 'discord') {
          try { await discordLib.sendDM(sayOut); } catch (e) { console.error('[main] followup discord DM failed:', e.message); }
        } else {
          try { if (io && io.onComplete) io.onComplete(followupDisclaimed ? { saidId: saidRow.id, truncated: 0, unprompted: true, say: sayOut } : { saidId: saidRow.id, truncated: 0, unprompted: true }); } catch {}
        }
        console.log('[main] tool follow-up delivered via', channel);
      }
    }
    // ECHO CHAIN: she emitted a follow-on Echo tag → dispatch the first and recurse with its
    // result (echoHop+1), so find→do→answer completes in one flow. Bounded by MAX_ECHO_HOPS.
    if (chainTags.length > 0 && echoSuit) {
      const t = chainTags[0];
      try {
        const r = await echoSuit.dispatch(t);
        const label = t.kind === 'do' ? `echo ${t.name}` : `echo ${t.kind}`;
        const content = `I used the Echo suit (${label}):\n${(r.text || '').slice(0, 1800)}`;
        try { db.insertMonologue({ content, model: 'echo-suit', type: 'reading', query: label }); } catch {}
        try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(${label}${r.isError ? ' ⚠' : ''})`, type: 'reading', query: label }); } catch {}
        console.log(`[main] echo chain hop ${echoHop + 1}: ${label} → ${r.ok ? 'ok' : 'ERR'}`);
        await fireToolFollowup({ io, channel, sessionId, resultText: content + (r.isError ? '\n[That call errored — fix the args or pick another tool with <echo-find>.]' : ''), echoHop: echoHop + 1, prompted });
      } catch (e) { console.error('[main] echo chain hop failed:', e.message); }
    }
  } catch (err) {
    console.error('[main] fireToolFollowup failed:', err.message);
  } finally {
    if (_topHop) { try { resumeMonologue(); resumeHeartbeat(); resumeContinuity(); resumeReflection(); selfDialogue.resume(); } catch {} }
  }
}

// LIVE-INFO ANSWERING — when Lucas asks for up-to-the-minute facts (weather, prices,
// markets, today's news), she must SEARCH and ANSWER in the same chat flow. Two real
// failures this closes: (1) she emits prose intent ("I want to know the price of oil")
// and no tag, so the idle monologue picks up the desire in the background and the answer
// lands in the thought panel, never back in chat; (2) she emits <web-open> but the
// tool-followup strips the follow-on <web-read/>, so the second hop never runs. Both now
// route through one synchronous open→read→deepen (the same path the monologue already uses
// successfully) and one tool-followup, so the answer comes back to Lucas.

// Read her own browser's current page AND auto-deepen into the top result, returning the
// combined text (not just a SERP). Mirrors monologue.runSearch's deepen step.
// Returns { text, full }: `text` = bounded body for the chat report (unchanged); `full` = the
// WHOLE deep-read page (up to ~15k) so claim-extraction + citation cover the entire article, not
// just the first ~2k chars shown in chat. Mirrors monologue.runSearch's display/capture split.
async function readHerBrowserDeep() {
  let body = '', serpFull = '', deepFull = '';
  try {
    const r = await webLib.read();
    if (r && r.ok && r.text) { const t = r.text.replace(/\n{3,}/g, '\n\n'); serpFull = t; body = t.slice(0, 1200); }
  } catch {}
  try {
    const top = await webLib.openTopResult();
    if (top && top.ok) {
      const pr = await webLib.read();
      if (pr && pr.ok && pr.text) { const t = pr.text.replace(/\n{3,}/g, '\n\n'); deepFull = t; body += `\n\nTop result (${top.title || top.url}):\n` + t.slice(0, 2000); }
    }
  } catch {}
  return { text: body, full: (deepFull || serpFull).slice(0, 15000) };
}

// Do a complete live lookup for `query` and answer Lucas in chat via one tool-followup.
// Idle is paused around the lookup so the monologue can't grab the shared browser mid-search.
async function liveLookupAndAnswer({ io, channel, sessionId, userName, query }) {
  try { pauseMonologue(); pauseHeartbeat(); } catch {}
  let content = '';
  let captureText = '';   // WHOLE page for claim-extraction + citation (content stays bounded for chat)
  const urls = [];
  try {
    // Use the ISOLATED headless Bing lane (web_search → search_lane, its OWN separate Chrome profile),
    // NOT her visible Google browser. A live user lookup must never be skewed by the autonomous research
    // monopolizing/personalizing the shared Google session — the contamination bug where a "Norway vs
    // England" score query came back full of Louisiana-Bar results because the idle lanes had been
    // hammering that same session. This lane can't be polluted by her background browsing.
    const web_search = require('./lib/web_search');
    const sr = await web_search.search(query).catch(() => ({ results: [] }));
    const results = (sr && Array.isArray(sr.results)) ? sr.results : [];
    if (results.length) {
      const top = results.slice(0, 6);
      for (const r of top) if (r && r.url) urls.push(r.url);
      const body = 'Search results:\n' + top.map((r, i) => `${i + 1}. ${r.title}${r.snippet ? ' — ' + r.snippet : ''}`).join('\n');
      content = `I looked up "${query}" just now. What I found:\n${body}`;
      captureText = body;   // the SERP → claim-extraction + citation (chat display stays bounded)
    }
    // Fallback: Echo's web_search if the stealth lane returned nothing.
    if (!content && echoSuit && echoSuit.connected) {
      try {
        const er = await echoSuit.dispatch({ kind: 'do', name: 'web_search', args: { query } });
        if (er && er.text && !er.isError) content = `I searched "${query}" with my research tools. What I found:\n${String(er.text).slice(0, 2200)}`;
      } catch (e) { console.error('[main] live lookup echo fallback failed:', e.message); }
    }
  } catch (err) {
    console.error('[main] liveLookupAndAnswer search failed:', err.message);
  }
  if (content) {
    try { require('./lib/learning').maybeCaptureLearnings({ query, content: captureText || content, urls }); } catch {}
    try {
      const row = db.insertMonologue({ content, model: 'live-lookup', type: 'reading', query, urls: urls.length ? urls : null });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(looked up) ${query}`, type: 'reading', query });
    } catch {}
  } else {
    content = `[You tried to look up "${query}" for ${userName} but couldn't reach a live source this moment. Tell him plainly you couldn't pull it right now and offer to try again — do NOT make up a number or a fact.]`;
  }
  try { resumeMonologue(); resumeHeartbeat(); } catch {}
  await fireToolFollowup({ io, channel, sessionId, resultText: content });
}

// CLOUD OPERATOR executors — map the operator's small tool menu to her real capabilities. Each
// returns a TEXT result (or an honest ERROR string); the cloud agent loops over these. The deep
// Echo catalog (500+ tools) is reached through the single `echo` tool, which cloud-picks the exact
// tool via routeNeed. Safe surfaces only (her own browser / Echo / memory / workspace files).
const operatorTools = {
  web_search: async ({ query } = {}) => {
    // Isolated ephemeral tab (see researchInTab) — the operator's one-shot lookup doesn't disturb the
    // tab the idle lanes hold, and closes itself when done.
    try { const r = await webLib.researchInTab(String(query || '')); return (r && r.ok && r.text) ? r.text : `(searched "${query}" but got no readable text)`; }
    catch (e) { return 'ERROR: ' + e.message; }
  },
  // Navigate her browser to a SPECIFIC url and read THAT page deeply (no SERP top-result hop). This is
  // what lets a research pass go DEEPER into a good site — open the org's /team or /contact page, or
  // follow a link it saw — instead of the only-move-is-a-new-search loop.
  open_page: async ({ url } = {}) => {
    try {
      const o = await webLib.open(String(url || ''));
      if (!o || !o.ok) return `could not open ${url}: ${(o && o.reason) || 'failed'}`;
      if (o.blocker) return `${o.url} needs a human (sign-in/CAPTCHA/paywall) — skip it, don't retry`;
      const r = await webLib.read();
      return (r && r.ok && r.text) ? r.text.replace(/\n{3,}/g, '\n\n').slice(0, 4000) : `opened ${o.url} but no readable text`;
    } catch (e) { return 'ERROR: ' + e.message; }
  },
  echo: async ({ need } = {}) => {
    try { if (!echoSuit) return 'Echo is not available right now.'; const r = await echoSuit.routeNeed(String(need || '')); return (r && r.text) || 'no result from Echo'; }
    catch (e) { return 'ERROR: ' + e.message; }
  },
  browser_read: async () => {
    try { const r = await webLib.read(); return (r && r.ok && r.text) || 'no page open in your browser'; }
    catch (e) { return 'ERROR: ' + e.message; }
  },
  // SEE a page with her EYES (vision) — reads infoboxes, tables, charts, and JS-rendered content that the
  // a11y text (open_page/browser_read) misses. Extracts the facts relevant to `focus` AND banks them with
  // the source url, so deep research BUILDS our DB from what she saw. Uses the dedicated top-tier vision model.
  see_page: async ({ url, focus } = {}) => {
    try {
      const r = await require('./lib/excavate').seePage(String(focus || ''), url ? { url } : {});
      if (!r || !r.ok) return `could not see ${url || 'the page'}: ${(r && r.reason) || 'failed'}`;
      if (r.text && r.url) { try { require('./lib/learning').maybeCaptureLearnings({ query: String(focus || 'research'), content: r.text, urls: [r.url] }); } catch {} }
      return r.text ? `SAW ${r.url}:\n${r.text.slice(0, 4000)}` : `looked at ${r.url} but saw nothing relevant to "${focus}"`;
    } catch (e) { return 'ERROR: ' + e.message; }
  },
  // BANK the executive contacts a research pass found into PULLER (our contact-intelligence store) so its
  // email-pattern belief + confidence algorithm runs on real data — Lucas's "contacts get the tools from the
  // Puller workplace": the run does the gathering, this tool call feeds Puller. Local + safe (its own puller.db).
  puller_add: async ({ company, contacts } = {}) => {
    try {
      const pdb = require('./lib/puller_db'); const ingest = require('./studio/puller_ingest');
      pdb.init();
      const rows = ingest.contactsToRows(contacts, company || '');
      if (!rows.length) return 'puller_add: no contacts with a name were provided';
      const s = ingest.ingestRows(pdb, rows, { source: `research:${String(company || 'run').slice(0, 40)}` });
      return `Banked into Puller: +${s.targets} contact(s), ${s.observations} observation(s), ${s.patternHits} email-pattern hit(s)${s.skippedDup ? `, ${s.skippedDup} already tracked` : ''}.`;
    } catch (e) { return 'ERROR: ' + e.message; }
  },
  recall: async ({ query } = {}) => {
    try { const rows = await memoryLib.retrieve(String(query || ''), { k: 5 }); const t = (rows || []).map(r => '- ' + String((r && r.content) || '').replace(/\s+/g, ' ').slice(0, 220)).join('\n'); return t || 'nothing relevant in memory'; }
    catch (e) { return 'ERROR: ' + e.message; }
  },
  file: async ({ op, path, content } = {}) => {
    try { const r = await filesLib.dispatch({ tag: 'file-' + (op || 'read'), attrs: { path: path || '' }, body: content || '' }); return (r && (r.text || r.message)) || (r && r.ok ? 'ok' : 'file op failed'); }
    catch (e) { return 'ERROR: ' + e.message; }
  },
  // FIRST-CLASS local memory: read-only SELECT over her OWN store (sq.db) — her notes, knowledge,
  // threads, monologue, self-model. The local counterpart to Echo's db_query. Read-only by construction.
  localdb: async ({ sql } = {}) => {
    try {
      const r = require('./lib/localdb').query(String(sql || ''));
      if (!r.ok) return 'ERROR: ' + r.error;
      if (!r.rows.length) return 'no rows';
      return JSON.stringify(r.rows).slice(0, 3000) + (r.truncated ? `\n…(${r.count} rows total, showing ${r.rows.length})` : '');
    } catch (e) { return 'ERROR: ' + e.message; }
  },
  localdb_map: async () => {
    try { const inv = require('./lib/localdb').inventory(); return inv.length ? inv.map(t => `${t.table} (${t.rows})`).join(', ') : '(empty)'; }
    catch (e) { return 'ERROR: ' + e.message; }
  },
};
// CURATED ECHO READ TOOLS (first-class) — promote high-value structured reads (nonprofit 990s, our KG,
// federal funding, FEC, bills) so the operator reaches for the right source deliberately instead of a
// web scrape. Built from lib/echo_tier.READ_TOOLS (single source of truth, shared with the menu in
// operator.js). Routed through echoSuit.dispatch so the tier gate covers them too — all READ, so always
// allowed (the gate only blocks write/heavy/locked). The generic `echo` tool covers the long tail.
try {
  for (const t of require('./lib/echo_tier').ALL_CURATED) {
    operatorTools[t.op] = async (a = {}) => {
      try {
        if (!echoSuit) return 'Echo is not available right now.';
        const r = await echoSuit.dispatch({ kind: 'do', name: t.tool, args: t.map(a) });
        return (r && r.text) || 'no result from Echo';
      } catch (e) { return 'ERROR: ' + e.message; }
    };
  }
} catch (e) { console.error('[operator] echo read-tools wiring failed:', e.message); }

// Run the cloud operator for a turn: the frontier model drives the tools; returns { answer, toolsUsed }
// or null (→ caller falls back to the normal local reply). Fail-safe.
async function runCloudOperator({ userMessage, context, task = false, autonomous = false, toolNames = null, model = null, toolSpec = null }) {
  try {
    const operator = require('./lib/operator');
    // Per-tool timeout: a slow/hung capability (Echo down, a stalled page) can't block the turn —
    // it returns an ERROR string the agent can route around.
    const TO = (p, ms = 20000) => Promise.race([Promise.resolve().then(() => p), new Promise(res => setTimeout(() => res('ERROR: tool timed out'), ms))]);
    const tools = {};
    // toolNames (when given) restricts this run to ONE lane's tools (web vs deep). Default = all.
    const keys = (Array.isArray(toolNames) && toolNames.length) ? toolNames.filter(k => operatorTools[k]) : Object.keys(operatorTools);
    for (const k of keys) tools[k] = (a) => TO(operatorTools[k](a));
    // TIER GATE on the generic `echo` need-router: on the AUTONOMOUS loop the cloud may pick ANY of the
    // 500+ tools, so pass `autonomous` so routeNeed blocks a write/heavy/locked pick (reads stay open).
    // The curated read tools above are READ-only and need no flag. Interactive turns (autonomous=false)
    // keep full write/heavy access (Echo applies its own verification + Lucas gate on proposals).
    if (!toolNames || keys.includes('echo')) tools.echo = (a) => TO((async () => {
      try { if (!echoSuit) return 'Echo is not available right now.'; const r = await echoSuit.routeNeed(String((a && a.need) || ''), { autonomous }); return (r && r.text) || 'no result from Echo'; }
      catch (e) { return 'ERROR: ' + e.message; }
    })());
    // DIRECTED TASK → in-turn completion: more steps + a longer budget + a mandate to deliver the WHOLE
    // thing this turn (gather all of it, save long deliverables to a file, don't stop at a teaser).
    const taskNote = task
      ? '\n\nThis is an ASSIGNED TASK — drive it to a COMPLETE deliverable in THIS turn: gather everything needed across multiple tool steps, do NOT stop after one step or hand back a partial teaser, and produce the FULL result (the entire list / the complete write-up). If the deliverable is long, save it with the file tool (op:"write", a notes/… path) and tell Lucas where it is. Only give a final answer once the deliverable is actually complete.'
      : '';
    const res = await operator.runOperator({
      userMessage, context: (context || '') + taskNote,
      deps: { complete: operator._operatorComplete, tools },
      maxSteps: task ? 8 : undefined, maxMs: task ? 90000 : undefined,
      numPredict: task ? config.sectionNumPredict() : undefined,   // a list/write-up can be long — don't truncate it at generation (cloud-leverage: deeper write-ups)
      model, toolSpec                         // per-lane model + tool menu (null = single-lane defaults)
    });
    // GROWTH — "Zoe" IS the memory, not the model: the operator only grows her if what it gathers
    // ACCRETES back into her knowledge. Capture the web findings it pulled as durable learnings, so
    // the cloud driving the turn feeds her development instead of answering-and-forgetting. (Echo
    // results already live in Echo's system-of-record; recall came from memory already.)
    if (res && Array.isArray(res.steps)) {
      for (const s of res.steps) {
        if ((s.tool === 'web_search' || s.tool === 'browser_read') && s.result && !/^ERROR/.test(s.result) && s.result.length > 80) {
          try { require('./lib/learning').maybeCaptureLearnings({ query: (s.args && (s.args.query || s.args.need)) || userMessage, content: s.result }); } catch {}
        }
      }
    }
    return res;
  } catch (e) { console.error('[operator] run failed:', e.message); return null; }
}

// === DIRECTED-FOCUS OVERNIGHT DRIVER =============================================================
// A Lucas-ASSIGNED task (focus.isDirected) is worked slice-by-slice by the cloud OPERATOR here in
// main.js (where the tools live). Each slice: the operator researches the NEXT concrete part not yet
// covered, appends findings to a workspace deliverable file, accretes to memory, and the focus
// lifecycle (focus.recordOutcome) bounds the whole project (strikes / stuck / overnight wall-clock).
// Cloud-only (gemma operator) → no local-GPU contention, so it proceeds while Lucas is away OR
// chatting. Reuses focus.js for all loop safety; the monologue think-loop skips directed focuses.
let directedDriverTimer = null;
let directedStepInFlight = false;
const DIRECTED_CADENCE_MS = 45 * 1000;   // a slice every ~45s while a directed task is active

function startDirectedFocusDriver() {
  if (directedDriverTimer) return;
  directedDriverTimer = setInterval(() => { directedFocusTick().catch(e => console.error('[directed] tick failed:', e.message)); }, DIRECTED_CADENCE_MS);
  console.log('[directed] overnight driver started');
}
function stopDirectedFocusDriver() {
  if (directedDriverTimer) { clearInterval(directedDriverTimer); directedDriverTimer = null; }
}
function kickDirectedFocusDriver() {
  startDirectedFocusDriver();
  directedFocusTick().catch(e => console.error('[directed] kick failed:', e.message));   // start NOW, don't wait a cadence
}

// One driver tick: advance the active directed focus by a single research slice, record the outcome.
async function directedFocusTick() {
  if (directedStepInFlight) return;
  const focusLib = require('./lib/focus');
  let focus = null;
  try { focus = focusLib.getCurrent(); } catch {}
  if (!focus || !focusLib.isDirected(focus)) { stopDirectedFocusDriver(); return; }   // nothing assigned → idle off
  if ((db.getMeta('operator.mode') || 'full').trim() === 'off') return;
  directedStepInFlight = true;
  try {
    const outcome = await runDirectedResearchPass(focus);   // depth-first state machine; records the focus outcome
    if (outcome && outcome.action && outcome.action !== 'continue') {
      stopDirectedFocusDriver();
      // CONSOLIDATE — the run is closing; fold the per-target sections into one clean dossier (+ recall
      // node) before we let go. This is what Lucas opens in the morning; it notifies him itself.
      const done = await condenseRun(focus, { reason: outcome.action });
      if (!done) { try { require('./lib/presence').notify('Zoe — task', `${outcome.action}: ${String(focus.content).slice(0, 60)}`); } catch {} }
    }
  } catch (e) { console.error('[directed] tick error:', e.message); }
  finally { directedStepInFlight = false; }
}

// INLINE DOC DECOMPOSITION (curation substrate Slice 2, Split 2 — stream 1: doc_store landings). After a
// document lands, decompose it into its constituent typed objects in Echo through the shared machine
// (lib/doc_decompose via lib/decomp_lane): typed extract → disambiguate (resolveMention: reuse-existing /
// mint / hold) → two gates → propose to Echo → observe (feed=doc-decomp). The document is the citation
// (grade B). Fall-throughs (ambiguous / unresolved) land as `held` observations for the nightly upgrade
// pass. Async + fail-soft — never blocks or breaks a landing; runs AFTER the stream's existing hooks.
// DOMAIN-LEASH gate for doc decomposition — checked at function ENTRY (before any chunk work) so it fires
// for every caller (canvas-drop, download-watcher, workspace ingest, etc.) AND aborts a pre-fix backlog
// mid-flight if the process restarts. Off-domain doc still LANDED in doc_store searchable; we just don't
// decompose it into contacts + entities. Empty leash (no civic work) → pass through (unleashed).
function _docLeashOk(doc) {
  try {
    const _lt = require('./lib/focus').domainLeashTokens();
    if (!_lt || !_lt.size) return true;
    const hay = `${doc && doc.title || ''} ${String(doc && doc.body || '').slice(0, 6000)}`.toLowerCase();
    const words = new Set(hay.match(/[a-z]{4,}/g) || []);
    for (const t of _lt) if (words.has(t)) return true;
    return false;
  } catch { return false; }   // FAIL CLOSED (2026-07-15): on a leash error, quarantine (doc lands searchable, not decomposed) rather than decompose everything.
}

async function decomposeLandedDoc(doc) {
  try {
    if (String(process.env.ZOE_AUTO_INGEST || '1').trim() === '0') { return; }   // KILL SWITCH — see ingestFile
    if (!echoSuit || !echoSuit.connected) return;
    if (!doc || doc.id == null || !String(doc.body || '').trim()) return;
    if (!_docLeashOk(doc)) { console.log(`[doc-decomp] SKIP off-domain doc #${doc.id} "${(doc.title || '').slice(0, 60)}" — no leash-token overlap`); return; }
    const src = (() => { try { return (require('./lib/models').sources() || []).find(s => s.tier === 'cloud' && s.token); } catch { return null; } })();
    if (!src) return;   // no cloud extractor available → skip (the nightly promote still consolidates it)
    const decompLane = require('./lib/decomp_lane');
    const echoSuitLib = require('./lib/echo_suit');
    const curationStore = require('./lib/curation_store');
    const { completeDetailed } = require('./lib/ollama');
    const model = config.extractionModel() || config.subconsciousModel();
    const extract = decompLane.makeCloudExtractor({ completeFn: completeDetailed, model, base: src.base, token: src.token });
    const resolve = (name, opts) => echoSuitLib.resolveMention(name, opts);
    const dispatch = (tag) => echoSuit.dispatch(tag);
    const observe = (o) => { try { curationStore.record(db, { ...o, feed: 'doc-decomp' }); } catch {} };
    // CITATION: cite the decompose to the doc's REAL source URL when we have one (a grabbed .gov/official
    // roster → official-document weight, so curation_gate grades it A and promotes single-source); else the
    // stable `docstore:<id>` pointer (decomp_lane fallback). Guarded to a real http(s) URL so an ephemeral
    // canvas tab key can never leak in as a citation.
    const _cite = (doc.sourceUrl && /^https?:\/\/[^\s]+$/i.test(String(doc.sourceUrl).trim())) ? String(doc.sourceUrl).trim() : undefined;
    // cap sized for a real document (a roster/dossier easily names 20-40 constituents); the ~6000-char
    // decomposition slice is the outer bound. 12 was too tight — a live 18-person roster lost 6 to the cap.
    // FULL-doc entity decomposition: chunk the whole body on line boundaries and decompose each pass (the
    // ~6000-char slice was losing everything past page 1). Echo's resolveMention dedups entities across passes.
    const { chunks } = require('./lib/contact_extract').chunkForExtraction(String(doc.body));
    let minted = 0, reused = 0, connections = 0, held = 0;
    for (const chunk of chunks) {
      try {
        const r = await decompLane.decomposeLanding({ id: doc.id, title: doc.title, body: chunk, ref: _cite }, { extract, resolve, dispatch, observe, cap: { entities: 40, relations: 40 }, log: (m) => console.log(m) });
        if (r && !r.skipped) { minted += r.minted || 0; reused += r.reused || 0; connections += r.connections || 0; held += r.held || 0; }
      } catch (e) { console.error('[doc-decomp] chunk failed:', e.message); }
    }
    if (chunks.length) console.log(`[doc-decomp] landing #${doc.id} ${chunks.length} pass(es) → +${minted} mint / ${reused} reuse / +${connections} conn (${held} held)`);
  } catch (e) { console.error('[doc-decomp] landing decompose failed:', e.message); }
}

// CONTACT INTELLIGENCE (Puller) — the sibling of decomposeLandedDoc for the OTHER facet: the same landed
// document, read for STATED contact fields (email / phone / title / address), which land in the Puller as
// cited observations + certainty-scored beliefs (studio/puller_ingest.ingestRows). People not yet tracked
// become new Puller targets ("new objects"); the document is the citation (source_url). The extractor is
// forbidden to invent contact data — only values written in the text. Async + fail-soft — never blocks a
// landing; runs alongside the entity decomposition, not instead of it.
async function surfaceDocCards(doc) {
  try {
    if (String(process.env.ZOE_AUTO_INGEST || '1').trim() === '0') { return; }   // KILL SWITCH — see ingestFile
    if (!doc || !String(doc.body || '').trim()) return;
    if (!_docLeashOk(doc)) { console.log(`[doc-cards] SKIP off-domain doc #${doc.id || '?'} "${(doc.title || '').slice(0, 60)}" — no leash-token overlap`); return; }
    const src = (() => { try { return (require('./lib/models').sources() || []).find(s => s.tier === 'cloud' && s.token); } catch { return null; } })();
    if (!src) return;   // no cloud extractor available → skip
    const decompLane = require('./lib/decomp_lane');
    const contactExtract = require('./lib/contact_extract');
    const contactCard = require('./studio/contact_card');
    const ingest = require('./studio/puller_ingest');
    const pdb = require('./lib/puller_db');
    const { completeDetailed } = require('./lib/ollama');
    const model = config.extractionModel() || config.subconsciousModel();
    const extract = decompLane.makeCloudExtractor({
      completeFn: completeDetailed, model, base: src.base, token: src.token,
      buildPrompt: contactExtract.buildCardsPrompt, parse: contactExtract.parseDocCards, numPredict: config.deepNumPredict(),
    });
    // MULTI-PASS: a big roster/sheet exceeds one 6000-char extraction slice, so split it into line-boundary
    // passes and extract each. ingestRows dedups people ACROSS passes (it rebuilds its seen-set from the DB
    // each call), so we land+push each pass as it finishes — cards stream into the rail progressively.
    const { chunks, truncated } = contactExtract.chunkForExtraction(String(doc.body));   // FULL doc — every pass
    if (!chunks.length) return;
    try { pdb.init(); } catch {}
    const sourceUrl = doc.ref || (doc.id != null ? `docstore:${doc.id}` : null);   // the landed doc is the citation
    const push = (c) => { try { if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.webContents.send('contacts:card', c); } catch {} };
    let totPeople = 0, totPlaces = 0, totEvents = 0, totOrgs = 0;
    for (let i = 0; i < chunks.length; i++) {
      let cards; try { cards = await extract(chunks[i], { title: doc.title }); } catch (e) { continue; }
      const people = (cards && cards.people) || [], places = (cards && cards.places) || [], events = (cards && cards.events) || [];
      const now = Date.now();
      if (people.length) {
        const s = ingest.ingestRows(pdb, people, { source: `doc:${String(doc.title || doc.id || 'drop').slice(0, 60)}`, sourceUrl, obsKind: 'doc' });
        const crmByName = await lookupCrmContacts((s.landed || []).map(L => L.name));
        for (const L of (s.landed || [])) {
          try { const beliefs = pdb.listBeliefs(L.targetId); push(contactCard.cardFromTarget({ id: L.targetId, name: L.name, company: L.company, kind: 'person', last_accessed_at: now }, beliefs, crmByName.get(String(L.name).toLowerCase()) || {})); } catch (e) {}
        }
        totPeople += s.targets;
      }
      // PLACES resolve against Echo (root fix): a real LOCATION → rich place card; something that
      // resolves to an ORGANIZATION/person (the "Rainey Center" bug) → an org card, NOT a blank place;
      // an unresolved place surfaces ONLY if it carries a real address (no blank place cards).
      if (places.length) {
        const placeRes = await resolvePlaces(places.map(p => p && p.name));
        for (const p of places) {
          try {
            const r = placeRes.get(String((p && p.name) || '').toLowerCase());
            if (r && r.type === 'location') {
              const c = contactCard.buildPlaceCard({ name: r.name || p.name, address: p.address || null, note: p.note || r.summary || null }, { ts: now });
              db.recordRecentCard({ type: 'place', cardKey: c.key, data: c, ts: now }); push(c); totPlaces++;
            } else if (r && (r.type === 'organization' || r.type === 'person' || r.type === 'network')) {
              const c = contactCard.buildOrgCard(r, { ts: now });   // reroute: an org is not a place
              db.recordRecentCard({ type: 'org', cardKey: c.key, data: c, ts: now }); push(c); totOrgs++;
            } else if (String((p && p.address) || '').trim()) {
              const c = contactCard.buildPlaceCard(p, { ts: now });   // unresolved but has a real address
              db.recordRecentCard({ type: 'place', cardKey: c.key, data: c, ts: now }); push(c); totPlaces++;
            }   // else: unresolved + no address → drop (no blank place card)
          } catch (e) {}
        }
      }
      for (const ev of events) { try { const c = contactCard.buildEventCard(ev, { ts: now }); db.recordRecentCard({ type: 'event', cardKey: c.key, data: c, ts: now }); push(c); totEvents++; } catch (e) {} }
    }
    console.log(`[doc-cards] #${doc.id} ${chunks.length} pass(es) → +${totPeople} people / ${totPlaces} places / ${totOrgs} orgs / ${totEvents} events${truncated ? ` (${truncated} chars beyond the ${chunks.length}-pass cap unscanned)` : ''}`);
  } catch (e) { console.error('[doc-cards] surface failed:', e.message); }
}

// MEETING CARDS (Slice B): surface cards for people / places / events MENTIONED in the fresh transcript.
// Unlike a document (surfaceDocCards MINTS new objects), a meeting RESOLVES a mention to a KNOWN card:
// a named person → their Puller/CRM card (bare "Russ" → Russ Walker); a place/event → its stored rich card
// (from an earlier drop) else a thin name-only card. Unresolved people are skipped (no minting from noisy
// live captions). Fail-soft — never breaks the scribe.
async function surfaceMeetingMentions(freshText) {
  try {
    const text = String(freshText || '').trim();
    if (text.length < 12) return;
    const src = (() => { try { return (require('./lib/models').sources() || []).find(s => s.tier === 'cloud' && s.token); } catch { return null; } })();
    if (!src) return;
    const decompLane = require('./lib/decomp_lane');
    const contactExtract = require('./lib/contact_extract');
    const contactCard = require('./studio/contact_card');
    const { completeDetailed } = require('./lib/ollama');
    const model = config.extractionModel() || config.subconsciousModel();
    const extract = decompLane.makeCloudExtractor({
      completeFn: completeDetailed, model, base: src.base, token: src.token,
      buildPrompt: contactExtract.buildMentionsPrompt, parse: contactExtract.parseMentions, numPredict: 400,
    });
    const m = await extract(text, {}) || {};   // { people, places, events }
    const now = Date.now();
    const push = (c) => { try { if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.webContents.send('contacts:card', c); } catch {} };
    let n = 0;
    for (const name of (m.people || []).slice(0, 8)) { const c = await resolveKnownPerson(name); if (c) { push({ ...c, ts: now }); n++; } }
    for (const kind of ['place', 'event']) {
      for (const name of ((kind === 'place' ? m.places : m.events) || []).slice(0, 6)) {
        const key = String(name).toLowerCase();
        const stored = db.getRecentCard(kind, key);   // known from an earlier drop → push the rich card
        if (stored) { push({ ...stored, ts: now }); n++; continue; }
        const c = kind === 'place' ? contactCard.buildPlaceCard({ name }, { ts: now }) : contactCard.buildEventCard({ name }, { ts: now });
        try { db.recordRecentCard({ type: kind, cardKey: c.key, data: c, ts: now }); } catch (e) {}
        push(c); n++;
      }
    }
    if (n) console.log(`[meeting-cards] surfaced ${n} card(s) from mentions (people ${(m.people || []).length}/places ${(m.places || []).length}/events ${(m.events || []).length})`);
  } catch (e) { console.error('[meeting-cards] failed:', e.message); }
}

// Resolve a mentioned NAME to a known person card: Puller target first (rich beliefs + CRM photo), else a
// CRM contact. Returns a card or null (unknown → not surfaced). Consume-only.
async function resolveKnownPerson(name) {
  try {
    const pdb = require('./lib/puller_db'); pdb.init();
    const contactCard = require('./studio/contact_card');
    const t = pdb.findTargetByName(name);
    if (t) {
      const beliefs = pdb.listBeliefs(t.id);
      const crm = await lookupCrmContacts([t.name]);
      return contactCard.cardFromTarget({ ...t, last_accessed_at: Date.now() }, beliefs, crm.get(String(t.name).toLowerCase()) || {});
    }
    return await crmPersonCard(name);
  } catch (e) { return null; }
}

// Build a person card straight from a CRM contact matched by full name (consume-only). CRM = authoritative
// (grade A). No Puller targetId → no "Full briefing" button. null if no match / Echo down.
async function crmPersonCard(name) {
  try {
    if (!echoSuit || !echoSuit.connected) return null;
    const nm = String(name || '').replace(/'/g, "''").trim();
    if (nm.length < 2) return null;
    const sql = `SELECT id, FirstName, LastName, Title, Email, Phone, MailingStreet, Image_Url__c, Notes_Public__c FROM electoral.contact WHERE deleted=0 AND TRIM(COALESCE(FirstName,'')||' '||COALESCE(LastName,'')) = '${nm}'
      ORDER BY (Email IS NOT NULL AND TRIM(Email) <> '') DESC, (Active_Elected__c = 1) DESC, (Image_Url__c IS NOT NULL) DESC, (Notes_Public__c IS NOT NULL) DESC, COALESCE(Last_Interaction_Date__c, 0) DESC, COALESCE(updated_at, 0) DESC
      LIMIT 1`;
    const r = await echoSuit.dispatch({ kind: 'do', name: 'db_query', args: { sql, params: [] } });
    if (!r || !r.ok) return null;
    let j; try { j = JSON.parse(r.text); } catch { return null; }
    const row = ((j && j.rows) || j || [])[0];
    if (!row) return null;
    const contactCard = require('./studio/contact_card');
    const full = `${String(row.FirstName || '').trim()} ${String(row.LastName || '').trim()}`.trim() || nm;
    const bio = String(row.Notes_Public__c || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || null;
    return contactCard.buildCardData(
      { name: full, title: row.Title, email: row.Email, phone: row.Phone, address: row.MailingStreet, confidence: 0.95, ts: Date.now() },
      { photo: row.Image_Url__c || null, bio, crmId: row.id }
    );
  } catch (e) { return null; }
}

// CONSUME-ONLY CRM read: batch-look up photo (Image_Url__c) + a one-line bio (Notes_Public__c) + crm id for a
// set of discovered names, matched on full name. One db_query for the whole batch (fail-soft → empty Map). We
// never write the CRM — this only enriches the card. Returns Map(lowercased "First Last" → {photo,bio,crmId}).
async function lookupCrmContacts(names) {
  const out = new Map();
  try {
    if (!echoSuit || !echoSuit.connected) return out;
    const clean = [...new Set((names || []).map(n => String(n == null ? '' : n).trim()).filter(n => n.length >= 2))].slice(0, 80);
    if (!clean.length) return out;
    const inList = clean.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
    // The FULL useful CRM record (consume-only) — the card shows a summary and the click-through pulls
    // the complete entry. Party_Roster/State_Represented/Tier_Canonical are the humanized rollups.
    const sql = `SELECT id, FirstName, LastName, Title, Email, Phone, MobilePhone,
        MailingStreet, MailingCity, MailingState, MailingPostalCode,
        District__c, Party_Roster, Chamber__c, State_Represented, Tier_Canonical, Engagement_Stage__c,
        Notes_Public__c, Wikipedia_Url__c, Image_Url__c
      FROM electoral.contact
      WHERE deleted=0 AND TRIM(COALESCE(FirstName,'')||' '||COALESCE(LastName,'')) IN (${inList})
      -- richest / most-active row per name floats to the top; the first-wins dedup below then keeps it
      -- (fixes a bare duplicate — e.g. a sparse 2nd "Ted Alexander" or an off-domain "Sarah Vance" judge —
      -- winning over the real, emailed, currently-elected contact).
      ORDER BY (Email IS NOT NULL AND TRIM(Email) <> '') DESC,
               (Active_Elected__c = 1) DESC,
               (Engagement_Stage__c IS NOT NULL AND Engagement_Stage__c <> 'Cold') DESC,
               (Enrichment_Stage__c = 'complete') DESC,
               (Image_Url__c IS NOT NULL) DESC,
               (Notes_Public__c IS NOT NULL) DESC,
               COALESCE(Last_Interaction_Date__c, 0) DESC,
               COALESCE(updated_at, 0) DESC
      LIMIT 400`;
    const r = await echoSuit.dispatch({ kind: 'do', name: 'db_query', args: { sql, params: [] } });
    if (!r || !r.ok) return out;
    let j; try { j = JSON.parse(r.text); } catch { return out; }
    const humanize = (s) => String(s || '').replace(/_/g, ' ').trim();
    for (const row of ((j && j.rows) || j || [])) {
      const nm = `${String(row.FirstName || '').trim()} ${String(row.LastName || '').trim()}`.trim();
      if (!nm) continue;
      const notes = String(row.Notes_Public__c || '').trim();
      const bio = notes.split('\n').map(x => x.trim()).filter(Boolean)[0] || null;   // first line for the collapsed card
      const address = [row.MailingStreet, row.MailingCity, row.MailingState, row.MailingPostalCode]
        .map(x => String(x == null ? '' : x).trim()).filter(Boolean).join(', ') || null;
      if (!out.has(nm.toLowerCase())) out.set(nm.toLowerCase(), {
        crmId: row.id, photo: row.Image_Url__c || null, bio,
        title: String(row.Title || '').trim() || null,
        email: String(row.Email || '').trim() || null,
        phone: String(row.Phone || row.MobilePhone || '').trim() || null,
        address,
        party: String(row.Party_Roster || '').trim() || null,
        chamber: humanize(row.Chamber__c) || null,
        state: String(row.State_Represented || '').trim() || null,
        district: String(row.District__c || '').trim() || null,
        tier: String(row.Tier_Canonical || '').trim() || null,
        engagement: String(row.Engagement_Stage__c || '').trim() || null,
        wikipedia: String(row.Wikipedia_Url__c || '').trim() || null,
        notesPublic: notes ? notes.slice(0, 600) : null,   // fuller text for the inline expand
      });
    }
  } catch {}
  return out;
}

// Resolve extracted PLACE names against Echo — the root fix for "Rainey Center landed as a blank place".
// Each place name → its best NAME-matching entity in Echo (search_entities), so the surfacer can tell a
// real LOCATION (→ rich place card) from an ORGANIZATION/person that was mislabeled a place (→ reroute to
// an org card, never a blank place). Consume-only, fail-soft → an empty map (everything falls back to the
// address rule). Returns Map(nameLower → { id, name, type, subtype, summary }).
async function resolvePlaces(names) {
  const out = new Map();
  try {
    if (!echoSuit || !echoSuit.connected) return out;
    const clean = [...new Set((names || []).map(n => String(n == null ? '' : n).trim()).filter(n => n.length >= 2))].slice(0, 40);
    for (const nm of clean) {
      try {
        const r = await echoSuit.dispatch({ kind: 'do', name: 'search_entities', args: { query: nm, limit: 5 } });
        if (!r || !r.ok) continue;
        let j; try { j = JSON.parse(r.text); } catch { continue; }
        const rows = (j && (j.result || j.rows || j.entities)) || (Array.isArray(j) ? j : []);
        const qL = nm.toLowerCase();
        // NAME-GATE: search_entities also matches summaries, so keep only candidates whose NAME actually
        // overlaps the query ("Rainey Center" ⊂ "Joseph Rainey Center for Public Policy"), never a bio hit.
        const gated = (Array.isArray(rows) ? rows : []).filter((e) => {
          const en = String((e && e.name) || '').toLowerCase().trim();
          return en && (en.includes(qL) || qL.includes(en));
        });
        // TYPE-PRIORITY, not first-ranked: Echo ranks an EVENT ("Rainey Center Monthly Hill Happy Hour")
        // above the actual ORG, so picking the top hit mislabels the place. Prefer a real place-decidable
        // type — location (a genuine place) > organization > network — and IGNORE event/person matches
        // (they leave the place unresolved → the address rule decides). Exact name match wins outright.
        const PRIO = { location: 0, organization: 1, network: 2 };
        let hit = gated.find((e) => String((e && e.name) || '').toLowerCase().trim() === qL && PRIO[String(e.entity_type || '').toLowerCase()] != null) || null;
        if (!hit) {
          let best = 99;
          for (const e of gated) { const p = PRIO[String((e && e.entity_type) || '').toLowerCase()]; if (p != null && p < best) { best = p; hit = e; } }
        }
        if (hit) out.set(qL, { id: hit.id, name: hit.name, type: String(hit.entity_type || '').toLowerCase(), subtype: hit.entity_subtype || null, summary: hit.summary || null });
      } catch {}
    }
  } catch {}
  return out;
}

// SOCIAL ENRICH (maigret leaf, Slice 2) — resolve a named contact, source its KNOWN handles (CRM
// social_handle + personal-email localpart), run maigret, and STAGE only corroborated (2+ signal) accounts
// as grade-E Puller OBSERVATIONS (verify-before-promote — NOT beliefs, NOT the CRM). Returns
// { found, name, staged:[{site,url,...}] }. Fully fail-soft. CONSUME-ONLY: the CRM is read, never written.
async function runSocialEnrich(targetName) {
  const name = String(targetName || '').trim();
  if (name.length < 2) return { found: false };
  try {
    const pdb = require('./lib/puller_db'); pdb.init();
    const em = require('./lib/enrich_maigret');

    // resolve the person across BOTH stores (Puller has company; CRM has crm_id + email + known handles)
    let pullerT = null; try { pullerT = pdb.findTargetByName(name); } catch {}
    let crm = null; try { crm = (await lookupCrmContacts([name])).get(name.toLowerCase()) || null; } catch {}
    if (!pullerT && !crm) return { found: false, name };

    const pEmail = pullerT ? ((pdb.getBelief(pullerT.id, 'email') || {}).value || null) : null;
    const crmId = (pullerT && pullerT.crm_id != null) ? pullerT.crm_id : (crm && crm.crmId) || null;
    const contact = { name: (pullerT && pullerT.name) || name, email: pEmail || (crm && crm.email) || null, company: (pullerT && pullerT.company) || null, crmId };

    // KNOWN handles from the CRM (consume-only read) for this contact
    let crmHandles = [];
    if (crmId != null && echoSuit && echoSuit.connected) {
      try {
        const r = await echoSuit.dispatch({ kind: 'do', name: 'db_query', args: { sql: `SELECT Platform__c AS platform, Handle__c AS handle FROM electoral.social_handle__c WHERE deleted=0 AND Contact__c = ${Number(crmId)}`, params: [] } });
        if (r && r.ok) { let j; try { j = JSON.parse(r.text); } catch {} crmHandles = ((j && j.rows) || []).filter((x) => x && x.handle); }
      } catch (e) { console.error('[social-enrich] handle query failed:', e.message); }
    }

    const result = await em.enrichContact(contact, crmHandles, { topSites: 50, timeout: 8 });
    const staged = result.staged || [];
    console.log(`[social-enrich] ${contact.name}: ${result.handles || 0} known handle(s) → ${staged.length} corroborated account(s)${staged.length ? ': ' + staged.map((s) => s.site).join(', ') : ''}`);
    if (!staged.length) return { found: true, name: contact.name, staged: [] };

    // ensure a Puller target to hang the observations on (adhoc if this person is CRM-only)
    let targetId = pullerT && pullerT.id;
    if (!targetId) { try { const t = pdb.createTarget({ kind: 'person', name: contact.name, company: contact.company || null, crmId: crmId || null }); targetId = t && t.id; } catch {} }
    if (targetId) {
      for (const s of staged) {
        try { pdb.addObservation(targetId, { attr: 'social', value: `${s.site}|${s.url}`, kind: 'osint', source: `maigret:${s.handle}`, sourceUrl: s.url, confidence: 0.3 }); }
        catch (e) { console.error('[social-enrich] observe failed:', e.message); }
      }
      console.log(`[social-enrich] staged ${staged.length} grade-E social observation(s) on target ${targetId} (unverified; not promoted)`);
      // push the refreshed card so the handles appear on the rail immediately (labeled unverified)
      try {
        const cc = require('./studio/contact_card');
        const social = cc.socialFromObservations(pdb.listObservations(targetId, { attr: 'social' }));
        const crmRec = crmId != null ? ((await lookupCrmContacts([contact.name])).get(contact.name.toLowerCase()) || {}) : {};
        const card = cc.cardFromTarget(pdb.getTarget(targetId) || { id: targetId, name: contact.name, company: contact.company }, pdb.listBeliefs(targetId), crmRec, { social });
        if (canvasWindow && !canvasWindow.isDestroyed()) canvasWindow.webContents.send('contacts:card', card);
      } catch (e) { console.error('[social-enrich] card push failed:', e.message); }
    }
    return { found: true, name: contact.name, staged };
  } catch (e) { console.error('[social-enrich] failed:', e.message); return { found: false, name }; }
}

// Pull the contacts we HOLD for a contacts-query — from BOTH stores the operator has: the Puller's
// discovered contacts (name + email/phone/role beliefs + company) AND the Echo CRM (electoral.contact,
// ~110k rows, ~13k with an email). CONSUME-ONLY: the CRM read is a plain SELECT; we never write it.
// The org/company for a CRM row is electoral.account.Name (via AccountId) — sector-rich (e.g. "Office of
// Fossil Energy", "Idaho National Laboratory"), so the sector filter in contacts_query.select matches it.
// Puller targets that reference a crm_id are de-duped against the CRM rows (skip the CRM twin). Returns
// [{ name, email, phone, company, title, confidence }]. Fail-safe: Echo down → Puller-only (prior behavior).
async function gatherHeldContacts() {
  const out = [];
  const heldCrmIds = new Set();
  // 1) PULLER — discovered targets + their beliefs (email/phone/role), carrying real per-attr confidence.
  try {
    const pdb = require('./lib/puller_db'); pdb.init();
    for (const t of pdb.listTargets({ limit: 100000 })) {   // NOTE: N+1 listBeliefs per target — full 162k coverage needs bulk-loading (follow-up), not a bigger cap
      if (t.crm_id != null) heldCrmIds.add(Number(t.crm_id));
      const bl = pdb.listBeliefs(t.id) || [];
      const b = (type) => bl.find((x) => x.type === type) || null;
      const email = b('email');
      // src:'puller' = a DISCOVERED private-sector contact (the "corporate" type); Puller targets rarely
      // carry a state, so state stays null (they won't match a state filter — honest).
      out.push({ name: t.name, email: email && email.value, phone: (b('phone') || {}).value || null, company: t.company, title: (b('role') || {}).value || null,
                 confidence: email && typeof email.confidence === 'number' ? email.confidence : ((b('phone') || {}).confidence || 0),
                 src: 'puller', state: null, elected: false, domain: t.domain || null });   // domain = the corporate/gov signal (contacts_query.domainKind)
    }
  } catch (e) { console.error('[contacts-query] puller gather failed:', e.message); }
  // 2) CRM — every emailed contact + its org (account) name, most-complete first. Bounded safety cap. The
  // CRM has NO per-row email-quality score (Email_Quality_Score__c is 100% null). If the deliverable flag
  // is ever set it governs (deliverable→0.95, undeliverable→0.6); otherwise, instead of a dead-flat 0.9 for
  // all ~13k, spread by the real quality signals that DO exist: a currently-active/elected contact and a
  // 'complete' enrichment stage are more trustworthy → 0.88 base + up to +0.07, so ranking isn't arbitrary.
  try {
    if (echoSuit && echoSuit.connected) {
      const sql = `SELECT c.id, c.FirstName, c.LastName, c.Title, c.Email, c.Phone, c.MobilePhone,
            c.Email_Deliverable__c AS deliverable, c.Active_Elected__c AS active, c.Enrichment_Stage__c AS enrichment,
            c.State_Represented AS state_rep, c.MailingState AS mail_state, c.Contact_Kind__c AS ckind, a.Name AS account_name
          FROM electoral.contact c
          LEFT JOIN electoral.account a ON a.id = c.AccountId
          WHERE c.deleted=0 AND c.Email IS NOT NULL AND TRIM(c.Email) <> ''
          ORDER BY (c.Phone IS NOT NULL AND TRIM(c.Phone) <> '') DESC,
                   (c.AccountId IS NOT NULL) DESC,
                   (c.Title IS NOT NULL AND TRIM(c.Title) <> '') DESC
          LIMIT 20000`;
      const r = await echoSuit.dispatch({ kind: 'do', name: 'db_query', args: { sql, params: [] } });
      let j = null; if (r && r.ok) { try { j = JSON.parse(r.text); } catch {} }
      for (const row of ((j && j.rows) || [])) {
        if (row.id != null && heldCrmIds.has(Number(row.id))) continue;   // the Puller already holds this person
        const name = `${String(row.FirstName || '').trim()} ${String(row.LastName || '').trim()}`.trim();
        if (name.length < 2) continue;
        const del = row.deliverable;
        let confidence;
        if (del === 1 || del === '1') confidence = 0.95;
        else if (del === 0 || del === '0') confidence = 0.6;
        else {   // no deliverable signal → spread by active-elected + enrichment-complete (0.88–0.95)
          const active = row.active === 1 || row.active === '1';
          const enriched = String(row.enrichment || '').toLowerCase() === 'complete';
          confidence = 0.88 + (active ? 0.04 : 0) + (enriched ? 0.03 : 0);
        }
        // src:'crm' = the civic/electoral CRM (the "elected/government" type); carry the represented/mailing
        // state (for a state filter) and an elected marker (Active_Elected or Contact_Kind='elected').
        const st = String(row.state_rep || row.mail_state || '').trim().toUpperCase() || null;
        const elected = row.active === 1 || row.active === '1' || String(row.ckind || '').toLowerCase() === 'elected';
        out.push({ name, email: String(row.Email || '').trim() || null, phone: String(row.Phone || row.MobilePhone || '').trim() || null,
                   company: String(row.account_name || '').trim() || null, title: String(row.Title || '').trim() || null, confidence,
                   src: 'crm', state: st, elected });
      }
      console.log(`[contacts-query] gathered ${out.length} held contacts (Puller + CRM, ${heldCrmIds.size} CRM dupes skipped)`);
    }
  } catch (e) { console.error('[contacts-query] crm gather failed:', e.message); }
  return out;
}

// NIGHTLY PROMOTION (Slice 2) — consolidate the day's un-promoted SHORT-TERM documents (lib/doc_store,
// the `documents` table) into Echo LONG-TERM. Locked recipe: each document is processed WHOLE into Echo's
// vault (ingest_file → a doc_id) + its entities extracted into the KG (extract_entities_from_doc), then
// marked promoted with the Echo ref. Runs on the daily curation cadence (maybeRunCuration). Fully fail-safe:
// Echo down → skip; a single doc's failure doesn't block the rest. Returns { promoted, failed, skipped }.
async function promoteDocumentsPass({ limit = 20 } = {}) {
  if (!echoSuit || !echoSuit.connected) { console.log('[promote] Echo not connected — skipping promotion'); return { promoted: 0, failed: 0, skipped: true }; }
  const promote = require('./lib/promote');
  const fs = require('fs'); const os = require('os'); const path = require('path');
  let promoted = 0, failed = 0;
  let docs = []; try { docs = db.listUnpromotedDocuments(limit); } catch (e) { console.error('[promote] list failed:', e.message); return { promoted, failed }; }
  for (const doc of docs) {
    if (!promote.shouldPromote(doc)) { try { db.markDocumentPromoted(doc.id, 'skipped:thin'); } catch {} continue; }
    const recipe = promote.recipeFor(doc);
    const tmp = path.join(os.tmpdir(), `zoe-promote-${doc.id}-${promote.tempFileName(doc)}`);
    try {
      fs.writeFileSync(tmp, `# ${doc.title || 'Document'}\n\n${doc.body}`, 'utf8');
      const res = await echoSuit.dispatch({ kind: 'do', name: 'ingest_file', args: { source_path: tmp, project_name: recipe.projectName, move: false } });
      const echoDocId = (res && res.ok) ? promote.parseEchoDocId(res.text) : null;
      if (echoDocId) {
        if (recipe.extractEntities) {
          try { await echoSuit.dispatch({ kind: 'do', name: 'extract_entities_from_doc', args: { doc_id: echoDocId } }); }
          catch (e) { console.error('[promote] entity extract failed (non-fatal):', e.message); }
        }
        try { db.markDocumentPromoted(doc.id, `echo:${echoDocId}`); } catch {}
        promoted++;
        // kg:activity — the graduation arc: this doc travels from the active core out to the Echo corpus and
        // locks in. anchor = the doc that graduated. Fail-safe (never blocks the promotion loop).
        try { emitKgActivity({ db: 'sidequest', kind: 'promote', anchor: String(doc.title || ('doc #' + doc.id)), count: 1 }); } catch (e) {}
        console.log(`[promote] doc #${doc.id} "${String(doc.title || '').slice(0, 40)}" → Echo doc ${echoDocId}${recipe.extractEntities ? ' (+entities)' : ''}`);
      } else { failed++; console.error(`[promote] doc #${doc.id} ingest returned no doc_id:`, String((res && res.text) || (res && res.error) || '').slice(0, 160)); }
    } catch (e) { failed++; console.error(`[promote] doc #${doc.id} failed:`, e.message); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
  }
  if (promoted || failed) console.log(`[promote] pass done — ${promoted} promoted, ${failed} failed`);
  return { promoted, failed };
}

// RETENTION (Slice 3) — tidy the short-term `documents` store after promotion so it stays a fast working
// set: trim a doc that's been in Echo long-term past the retention window down to a POINTER (its Echo ref +
// understanding; the full text lives in Echo), and drop skip-marked stragglers that never reached Echo.
// Synchronous (DB only), fail-safe. Returns { pruned, deleted }.
function retentionPass({ limit = 200, windowMs = null } = {}) {
  const retention = require('./lib/retention');
  let docs = []; try { docs = db.listPromotedDocuments(limit); } catch (e) { console.error('[retention] list failed:', e.message); return { pruned: 0, deleted: 0 }; }
  const p = retention.plan(docs, windowMs ? { windowMs } : {});
  let pruned = 0, deleted = 0;
  for (const item of p.prune) { try { if (db.trimDocumentBody(item.id, item.pointer)) pruned++; } catch {} }
  for (const id of p.delete) { try { if (db.deleteDocument(id)) deleted++; } catch {} }
  if (pruned || deleted) console.log(`[retention] short-term tidy — ${pruned} trimmed to pointers, ${deleted} dropped`);
  return { pruned, deleted };
}

// Reasoner cloud call for the condense pass — uses the deeper subconscious model (gpt-oss:120b), not
// the fast operator, because consolidation is a quality/judgment job. Returns text or '' (fail-safe).
async function condenseComplete(messages, { numPredict = 2500 } = {}) {
  try {
    const models = require('./lib/models');
    const src = (models.sources() || []).find(s => s.tier === 'cloud' && s.token);
    if (!src) return '';
    const model = (() => { try { return require('./lib/config').subconsciousModel() || 'gpt-oss:120b'; } catch { return 'gpt-oss:120b'; } })();
    const r = await require('./lib/ollama').completeDetailed({
      model, messages, base: src.base,
      headers: src.token ? { Authorization: `Bearer ${src.token}` } : {},
      options: { temperature: 0.3, num_ctx: 32768, num_predict: numPredict }
    });
    return (r && (r.text || '')) || '';
  } catch (e) { console.error('[condense] cloud failed:', e.message); return ''; }
}

// GENERATE + STORE the structured research PLAN (Pillar 0, page 1). The cloud authors it at project
// start from what we know (goal, targets, facet, deep) + the canonical database list; we normalize to a
// canonical shape and persist it on focus.<id>.plan so it's reviewable (surfaced in the readback,
// editable by the correction handler) and rendered as page 1 at finalize. Fail-safe: cloud down → a
// fully deterministic fallback plan (a plan ALWAYS exists). Run on the FAST editor model (like intake),
// so a reasoning model can't burn the budget on hidden thinking and return empty.
async function generateResearchPlan(focus, { goal = '', targets = [], facet = '', deep = false, kind = 'entity' } = {}) {
  const rp = require('./lib/research_plan');
  const est = require('./lib/estimate');
  let estimate = '';
  try { estimate = est.estimateRun({ orgCount: (targets || []).length, deep }).human; if (estimate === '(nothing to do)') estimate = ''; } catch {}
  const ctx = { goal, targets, facet, deep, estimate, kind };
  let plan = null;
  try {
    // The PLAN shapes the whole project — author it on the deep reasoner with headroom (cloud-leverage
    // Slice 5), not the fast utility model at 800 tokens. One call per project, so no throughput cost.
    const planModel = (() => { try { return config.deepReasonerModel(); } catch { return require('./lib/models').getModelFor('editor', null); } })();
    const cloud = require('./lib/cloud_logic');
    const raw = await cloud.ask({
      task: 'research_plan', v: 1, model: planModel, numPredict: config.deepNumPredict(),
      input: rp.planInput(ctx), want: rp.planWant(ctx.kind), validate: rp.planValidator
    });
    if (raw) plan = rp.normalizePlan(raw, ctx);
  } catch (e) { console.error('[plan] cloud generate failed:', e.message); }
  if (!plan) plan = rp.fallbackPlan(ctx);
  try { if (focus && focus.id != null) db.setMeta(`focus.${focus.id}.plan`, JSON.stringify(plan)); } catch {}
  return plan;
}

// COMPOSE the deliverable as a CLOUD-AUTHORED professional document (Pillar 3) — "cloud writes
// everything". Page 1 = the plan; then the cloud composes the whole product from the per-org sections,
// COMPLETENESS-GATED against those same lossless sections (the ORACLE): any org the composer drops is
// patched back verbatim, so N-in ≥ N-out always holds. Large runs are CHUNKED (map) so no call
// truncates. Fail-safe: cloud down / empty → fall back to the deterministic lossless stitch (page 1 +
// assemble.stitchDocument), so a finished run NEVER loses its deliverable. Returns the final markdown.
async function composeDocument(focus, { goal = '', sections = [], completed = 'done', summary = '', gaps = '', indexedMissing = [] } = {}) {
  const cp = require('./lib/compose');
  const as = require('./lib/assemble');
  const rp = require('./lib/research_plan');
  const secs = (Array.isArray(sections) ? sections : []).filter(s => s && s.heading);
  // page 1 — the stored plan, or generate one now (targets = the orgs we actually covered).
  let plan = null;
  try { const stored = db.getMeta(`focus.${focus.id}.plan`); if (stored) plan = JSON.parse(stored); } catch {}
  if (!plan) {
    const deep = (() => { try { return db.getMeta(`focus.${focus.id}.deep`) === '1'; } catch { return false; } })();
    const facet = (() => { try { return db.getMeta(`focus.${focus.id}.enrich_facet`) || ''; } catch { return ''; } })();
    try { plan = await generateResearchPlan(focus, { goal, targets: secs.map(s => s.heading), facet, deep }); } catch {}
  }
  const planPage = rp.renderPlanPage(plan || {});

  // honest deterministic Gaps footer (indexed-but-missing + anything the composer dropped and we patched).
  const gapLines = [];
  for (const m of (Array.isArray(indexedMissing) ? indexedMissing : [])) gapLines.push(`- ${m} — section not captured in the deliverable file (indexed but missing)`);
  if (String(gaps || '').trim()) gapLines.unshift(String(gaps).trim());

  // CLOUD COMPOSE — chunked so a large run never truncates; the gate runs over the concatenation.
  let composedBody = '';
  try {
    const groups = cp.chunkSections(secs, 14000);
    const parts = [];
    for (let i = 0; i < groups.length; i++) {
      const msgs = cp.buildComposePrompt({ goal, sections: groups[i], chunkIndex: i, chunkTotal: groups.length });
      const out = await condenseComplete(msgs, { numPredict: cp.composeBudget(groups[i]) });
      if (out && out.trim()) parts.push(out.trim());
    }
    composedBody = parts.join('\n\n');
  } catch (e) { console.error('[compose] cloud compose failed:', e.message); }

  // FAIL-SAFE: cloud produced nothing usable → deterministic lossless stitch (page 1 + the oracle).
  if (!composedBody || composedBody.trim().length < 80) {
    console.warn('[compose] empty/short composition → falling back to lossless stitch');
    const stitched = as.stitchDocument({ goal, completed, sections: secs, summary, gaps, indexedMissing });
    return `${planPage}\n\n---\n\n${stitched}`;
  }

  // COMPLETENESS GATE — the lossless sections are the oracle; patch back any org the composer dropped.
  const gate = cp.verifyComposition(composedBody, secs);
  if (!gate.ok) {
    console.warn(`[compose] composer dropped ${gate.missing.length} org(s) — patching verbatim from oracle: ${gate.missing.map(s => s.heading).join(', ')}`);
    composedBody = cp.patchMissing(composedBody, gate.missing);
    for (const s of gate.missing) gapLines.push(`- ${s.heading} — recovered from the research notes (composer omitted it)`);
  }

  return cp.assembleFinal({ goal, planPage, composedBody, gaps: gapLines.join('\n'), completed, count: secs.length });
}

// ASSEMBLE a finished directed run into one clean dossier by LOSSLESS DETERMINISTIC STITCH (Slice 1):
// the accreted run file already holds one clean "## <org>" section per covered org (continuous organize
// pass). We stitch those sections verbatim — N-in = N-out — and use the reasoner ONLY for the
// Summary/Gaps wrapper (it never sees the assembled output, so it can't drop an org — the old
// whole-document re-summarization dropped 15/21). The count is derived from the artifact. Then store the
// recall node, remember research.last_dossier + last_focus_id (so a later "expand" / query can find it),
// drive the canvas, and notify Lucas.
async function condenseRun(focus, { reason = 'done' } = {}) {
  try {
    const as = require('./lib/assemble');
    const goal = String(focus.content || '');
    const file = db.getMeta(`focus.${focus.id}.file`);
    let raw = '';
    if (file) { try { const r = filesLib.fileReadFull(file); raw = (r && r.text) || ''; } catch {} }   // FULL read — the 8000-char cap would silently drop orgs from the lossless stitch
    if (!raw || raw.trim().length < 80) { console.log('[condense] nothing substantial to condense'); return null; }
    const { sections } = as.parseSections(raw);
    if (!sections.length) { console.log('[condense] no parseable org sections — leaving raw run file in place'); return null; }
    let covered = []; try { covered = JSON.parse(db.getMeta(`focus.${focus.id}.covered`) || '[]'); } catch {}
    const rec = as.reconcileIndex(covered, sections);
    let wrapper = { summary: '', gaps: '' };
    try { const w = await condenseComplete(as.buildWrapperPrompt({ goal, sections }), { numPredict: 900 }); wrapper = as.parseWrapper(w); } catch {}
    // CLOUD-AUTHORED document (Pillar 3): page 1 plan → cloud-composed product → honest Gaps, with the
    // lossless sections as the completeness ORACLE. composeDocument is fully fail-safe (falls back to the
    // deterministic stitch if the cloud is down), so the deliverable is never lost. The wrapper Gaps seed
    // the honest footer; the composer writes its own executive summary.
    let condensed = await composeDocument(focus, { goal, sections, completed: reason, summary: wrapper.summary, gaps: wrapper.gaps, indexedMissing: rec.indexedMissing });
    // PROVENANCE (Pillar 1) — append the run's citation trail so the report's data is TRACEABLE, not just
    // asserted. Sources are extracted per-org from the accreted raw (real URLs the operator read + structured
    // record classes) and deduped run-wide. The section rides INTO Echo long-term via the nightly promote (it
    // is part of the vault document), so the facts stay grounded. Fail-safe: a render miss never blocks the dossier.
    try {
      const srcSection = require('./lib/sources').renderRunSources(sections);
      if (srcSection) { condensed = `${String(condensed).trim()}\n\n${srcSection}`; console.log(`[condense] appended Sources trail (${(srcSection.match(/\n\d+\. /g) || []).length} cited)`); }
    } catch (e) { console.error('[condense] sources render failed:', e.message); }
    const dossierPath = `notes/directed-${focus.id}-dossier.md`;
    try { await filesLib.dispatch({ tag: 'file-write', attrs: { path: dossierPath }, body: condensed }); }
    catch (e) { console.error('[condense] dossier write failed:', e.message); }
    try { await memoryLib.store({ kind: 'note', content: `Research dossier — ${goal.slice(0, 90)} (${sections.length} orgs):\n${condensed.slice(0, 4000)}`, source: 'research_dossier', importance: 0.85, embedText: goal }); } catch {}
    // LONG-TERM DURABILITY — land the dossier in doc_store so the nightly promote carries it INTO Echo (vault
    // document + entity extraction). Without this the report lived ONLY as a local file + a recall note and
    // never reached long-term memory — its data (orgs, people, the Sources trail) evaporated from the graph.
    // source:'research' → promote.recipeFor files it as a deliverable; ref=directed-<id> dedups a same-body
    // re-condense. Fail-safe: a land miss never blocks the dossier.
    try { const dl = require('./lib/doc_store').land({ title: `Research — ${goal.slice(0, 100)}`, body: condensed, source: 'research', ref: `directed-${focus.id}`, understanding: goal.slice(0, 300) }); if (dl && dl.landed) console.log(`[condense] landed dossier in doc_store (#${dl.id}) → promotes into Echo long-term`); }
    catch (e) { console.error('[condense] doc_store land failed:', e.message); }
    try { db.setMeta('research.last_dossier', JSON.stringify({ focusId: focus.id, path: dossierPath, goal, reason, count: sections.length })); } catch {}
    try { db.setMeta('research.last_focus_id', String(focus.id)); } catch {}
    // DRIVE → Zoe's canvas: emit the count headline (from the artifact) + the stitched dossier as DOC blocks.
    try {
      const ce = require('./studio/canvas_emit');
      const h = ce.countHeading(sections.length);
      await canvasEmit({ focusId: focus.id, title: goal, tabMode: 'DOC', blockType: h.blockType, data: h.data });
      const dblk = ce.dossierBlock(condensed.trim());
      await canvasEmit({ focusId: focus.id, title: goal, tabMode: 'DOC', blockType: dblk.blockType, data: dblk.data });
    } catch (e) { console.error('[condense] canvas emit failed:', e.message); }
    try {
      const rr = db.insertMonologue({ content: `Assembled the research run into a dossier (${dossierPath}, ${sections.length} orgs). ${condensed.slice(0, 240)}`, model: 'condense', type: 'reading' });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: rr.id, ts: rr.ts, content: `(dossier ready) ${dossierPath}`, type: 'reading' });
    } catch {}
    try { require('./lib/presence').notify('Zoe — dossier ready', `${goal.slice(0, 50)} → ${dossierPath} (${sections.length} orgs)`); } catch {}
    console.log(`[condense] LOSSLESS dossier → ${dossierPath} (${sections.length} sections stitched, ${rec.indexedMissing.length} indexed-missing)`);
    return { path: dossierPath, count: sections.length };
  } catch (e) { console.error('[condense] run failed:', e.message); return null; }
}

// Build the CURRENT-or-last research Track for the deliverable-query path (Slice 1): the active directed
// focus if one is running, else the last completed/stalled run (research.last_dossier → last_focus_id).
// Reads the covered index + the accreted "## <org>" sections + any in-flight target, so a question is
// answered off the Track's own artifact whether the run is ACTIVE or COMPLETE. Returns a plain track
// object for lib/track, or { kind:'none' }. Fail-safe.
// The Tracks REGISTRY — every directed research run, for topic resolution. One descriptor per
// focus.<id>.covered meta key: { id, goal, covered, status, hasDossier }. Cheap (no file bodies; just
// the dossier's existence). Skips empty runs (the junk-focus mis-fires never accreted an org).
function buildTrackIndex() {
  const out = [];
  let keys = []; try { keys = db.getMetaKeysLike('focus.%.covered'); } catch {}
  for (const k of keys) {
    const id = parseInt(String(k).split('.')[1], 10);
    if (!id) continue;
    let covered = []; try { covered = JSON.parse(db.getMeta(k) || '[]'); } catch {}
    if (!covered.length) continue;
    let goal = '', status = null;
    try { const t = db.getOpenThread(id); if (t) { goal = String(t.content || ''); status = t.status; } } catch {}
    let hasDossier = false; try { const r = filesLib.fileReadFull(`notes/directed-${id}-dossier.md`); hasDossier = !!(r && r.ok); } catch {}
    out.push({ id, goal, covered, status, hasDossier });
  }
  return out;
}

// Resolve which Track a deliverable question is about. Order: (1) TOPIC-ADDRESSED across the whole
// registry ("the think tanks" → the completed #2027 dossier, not just the most-recent run), (2) the
// ACTIVE directed focus, (3) the last completed/stalled run. Returns a track object for lib/track.
async function buildQueryTrack(userMessage = '') {
  try {
    const as = require('./lib/assemble');
    const focusLib = require('./lib/focus');
    let id = null, kind = 'complete', completed = null, goal = '';
    // (1) topic-addressed: does the question name a specific past project?
    try {
      const hit = require('./lib/track_index').resolveByTopic(buildTrackIndex(), userMessage);
      if (hit && hit.id) { id = hit.id; goal = String(hit.goal || ''); try { db.setMeta('research.last_referenced_focus_id', String(hit.id)); } catch {} console.log(`[track] topic-resolved → #${id}`); }
    } catch (e) { console.error('[track] topic resolve failed:', e.message); }
    // (2) the active directed focus
    if (id == null) {
      const active = (() => { try { return focusLib.getCurrent(); } catch { return null; } })();
      if (active && focusLib.isDirected(active)) { id = active.id; goal = String(active.content || ''); }
    }
    // (3) the last completed/stalled run
    if (id == null) {
      let last = null; try { last = JSON.parse(db.getMeta('research.last_dossier') || 'null'); } catch {}
      if (last && last.focusId != null) { id = last.focusId; goal = String(last.goal || ''); completed = last.reason || 'done'; }
      else { const lf = db.getMeta('research.last_focus_id'); if (lf) { id = parseInt(lf, 10) || null; const t = id != null ? db.getOpenThread(id) : null; goal = t ? String(t.content || '') : ''; completed = t ? t.status : 'done'; } }
    }
    if (id == null) return { kind: 'none' };
    // kind = 'active' only if this id IS the live directed focus; else complete (with its status)
    try { const a = focusLib.getCurrent(); kind = (a && a.id === id && focusLib.isDirected(a)) ? 'active' : 'complete'; } catch { kind = 'complete'; }
    if (kind === 'complete' && completed == null) { try { const t = db.getOpenThread(id); completed = t ? t.status : 'done'; } catch {} }
    let covered = []; try { covered = JSON.parse(db.getMeta(`focus.${id}.covered`) || '[]'); } catch {}
    let target = null;
    if (kind === 'active') { try { const t = JSON.parse(db.getMeta(`focus.${id}.target`) || 'null'); if (t && t.name) target = { name: t.name, rawExcerpt: String(t.raw || '').slice(0, 1200) }; } catch {} }
    let sections = [];
    const file = db.getMeta(`focus.${id}.file`);
    if (file) { try { const r = filesLib.fileReadFull(file); sections = as.parseSections((r && r.text) || '').sections; } catch {} }   // FULL read — the 8000-char cap was cutting a 13-org run to ~5
    if (!goal) { try { const t = db.getOpenThread(id); goal = t ? String(t.content || '') : ''; } catch {} }
    return { kind, goal, covered, sections, target, completed };
  } catch (e) { console.error('[track] build failed:', e.message); return { kind: 'none' }; }
}

// Build the live cross-lane SNAPSHOT for the activity poll source (Slice I): the active research focus,
// the media-watch state, and the meeting state — read straight from focus + meta. Lightweight (no file
// reads); lib/activity turns it into the grounded "what are you doing" answer + heartbeat pointers.
async function laneSnapshot() {
  const snap = { research: null, media: null, meeting: null };
  try {
    const focusLib = require('./lib/focus');
    const f = (() => { try { return focusLib.getCurrent(); } catch { return null; } })();
    if (f && focusLib.isDirected(f)) {
      let covered = []; try { covered = JSON.parse(db.getMeta(`focus.${f.id}.covered`) || '[]'); } catch {}
      let target = null; try { const t = JSON.parse(db.getMeta(`focus.${f.id}.target`) || 'null'); if (t && t.name) target = { name: t.name }; } catch {}
      snap.research = { goal: String(f.content || ''), covered, target };
    }
  } catch {}
  try {
    const stage = db.getMeta('media_stage') || 'none';
    if (!['none', 'done'].includes(stage)) {
      snap.media = { url: db.getMeta('media_url') || '', stage, understanding: db.getMeta('media_understanding') || '' };
    }
  } catch {}
  try {
    const stage = db.getMeta('gmeet_stage') || 'none';
    if (!['none', 'done'].includes(stage)) {
      snap.meeting = { url: db.getMeta('gmeet_url') || '', stage, awaitingAdmit: stage === 'awaiting_admit' };
    }
  } catch {}
  return snap;
}

// FRONTIER STATUS REPORT (Concern 1) — when Lucas asks how a running task is going, the local voice
// model gave a truncated, half-blind answer. Instead read the REAL state (orgs done, current target,
// clarifications, the deliverable so far) and have the reasoner write a crisp, usable progress update.
// Returns the report text (Dans then relays it in full) or '' (fail-safe → normal reply).
async function statusReport(focus) {
  try {
    const goal = String(focus.content || '');
    let covered = []; try { covered = JSON.parse(db.getMeta(`focus.${focus.id}.covered`) || '[]'); } catch {}
    let target = null; try { target = JSON.parse(db.getMeta(`focus.${focus.id}.target`) || 'null'); } catch {}
    let clar = []; try { clar = JSON.parse(db.getMeta(`focus.${focus.id}.clarifications`) || '[]'); } catch {}
    let fileExcerpt = '';
    const file = db.getMeta(`focus.${focus.id}.file`);
    if (file) { try { const r = await filesLib.dispatch({ tag: 'file-read', attrs: { path: file } }); fileExcerpt = String((r && (r.text || r.content)) || '').slice(0, 3500); } catch {} }
    let ticks = 0; try { ticks = JSON.parse(db.getMeta('focus_state') || '{}').ticks || 0; } catch {}
    const state = `TASK: ${goal}\nRESEARCH PASSES RUN: ${ticks}\nORGANIZATIONS COMPLETED (${covered.length}): ${covered.join(', ') || 'none yet'}\nCURRENTLY RESEARCHING: ${target ? `${target.name} (pass ${target.passes || 1})` : '(between targets)'}\n${clar.length ? `LUCAS'S CLARIFICATIONS SO FAR: ${clar.join(' | ')}\n` : ''}DELIVERABLE SO FAR (excerpt):\n${fileExcerpt || '(nothing written yet)'}`;
    const messages = [
      { role: 'system', content: `You write Lucas a crisp, USEFUL progress update on his running research task. Ground ONLY in the state provided — never invent. Cover concretely: how many organizations are done and NAME them; what's solidly in hand (named staff? real contacts?) vs still thin; what you're on right now; and what's missing or weak (gaps worth knowing). A tight bulleted list or 4–8 sentences. No filler, no restating the whole task.` },
      { role: 'user', content: state + '\n\nWrite the progress update now.' }
    ];
    return await condenseComplete(messages, { numPredict: 900 });
  } catch (e) { console.error('[status] report failed:', e.message); return ''; }
}

// ONE driver tick of the DEPTH-FIRST research loop (lib/research is the pure brain). Either OPENS a
// new target (overview pass) or DEEPENS the current one (next missing facet — staff, contacts,
// positions…), staying on a target across passes until it saturates / hits the depth cap / stops
// adding new material. When a target completes, a CLOUD ORGANIZE pass (reasoner) folds its raw passes
// into a clean dossier section appended right then — so organization is continuous, not just at run-end.
// Research passes are the cloud operator. State (covered orgs, current target, file) lives in meta.
// Records + returns the focus outcome. Fully fail-safe.
async function runDirectedResearchPass(focus) {
  // MODE GATE: an ENRICH run re-enters a KNOWN set of orgs and fills one named facet across them — the
  // opposite of the discovery loop below (which avoids the covered set and opens NEW orgs). Branch early
  // so the two modes never entangle.
  const mode = (() => { try { return (db.getMeta(`focus.${focus.id}.mode`) || 'discover').trim(); } catch { return 'discover'; } })();
  if (mode === 'enrich') return runEnrichResearchPass(focus);
  // KIND GATE (research A3b): a topical brief or a forecast is NOT an org-and-contacts walk — research the
  // SUBJECT across its aspects. (forecast rides this same subject-research path for now; Part B adds the
  // actual forecast engine.) entity kind falls through to the discovery/deepen org walk below, unchanged.
  const kind = (() => { try { return (db.getMeta(`focus.${focus.id}.kind`) || 'entity').trim(); } catch { return 'entity'; } })();
  if (kind === 'topical' || kind === 'forecast') return runTopicalResearchPass(focus);

  const focusLib = require('./lib/focus');
  const blackboard = require('./lib/blackboard');
  const rs = require('./lib/research');
  const goal = String(focus.content || '');
  const coveredKey = `focus.${focus.id}.covered`;
  const targetKey = `focus.${focus.id}.target`;
  const fileKey = `focus.${focus.id}.file`;
  let covered = []; try { covered = JSON.parse(db.getMeta(coveredKey) || '[]'); } catch {}
  let target = null; try { target = JSON.parse(db.getMeta(targetKey) || 'null'); } catch {}
  let file = db.getMeta(fileKey); if (!file) { file = `notes/directed-${focus.id}.md`; try { db.setMeta(fileKey, file); } catch {} }
  // Pointer to the most recent directed run, so the deliverable-query path can resolve the "last Track"
  // even when a run STALLS before producing a dossier (condenseRun sets this too, but only on success).
  try { db.setMeta('research.last_focus_id', String(focus.id)); } catch {}
  // Mid-run clarifications Lucas gave → guidance folded into EVERY pass from here on.
  let clar = []; try { clar = JSON.parse(db.getMeta(`focus.${focus.id}.clarifications`) || '[]'); } catch {}
  const guidance = rs.buildGuidanceBlock(clar);

  // DURABILITY: re-emit this run's canvas blocks from the persisted deliverable on the first tick of the
  // process (an engine/app restart wiped the in-memory canvas). No-op after the first call per run.
  try { await rehydrateCanvasFromDeliverable(focus, file, target); } catch {}

  // SCOPE — a BOUNDED run (the assignment named specific entities) confines research to those intended
  // targets and TERMINATES when they're covered; an OPEN run genuinely discovers. Loaded before deciding.
  const lc = s => String(s || '').toLowerCase();
  let scope = 'open', intended = [], visited = [];
  try { scope = (db.getMeta(`focus.${focus.id}.scope`) || 'open').trim(); } catch {}
  try { intended = JSON.parse(db.getMeta(`focus.${focus.id}.intended_targets`) || '[]'); } catch {}
  try { visited = JSON.parse(db.getMeta(`focus.${focus.id}.visited`) || '[]'); } catch {}

  // CONTRACT (Slices 2+3): the plan's facets are the run's PORTIONS. Slice 3 = feed the facet→toolset
  // COVERAGE PLAN into every deepen pass so each facet drives its full tool array (financial → the FEC/990
  // tree; contacts → the Puller email-pattern+verify pattern), not one web search. Slice 2 = after each pass
  // refresh the contract TODO from what the deliverable now covers, so portions check off live.
  let planFacets = [];
  try { const pl = JSON.parse(db.getMeta(`focus.${focus.id}.plan`) || 'null'); planFacets = (pl && Array.isArray(pl.facets) && pl.facets.length) ? pl.facets : (pl && Array.isArray(pl.targets) ? pl.targets : []); } catch {}
  const coveragePlan = (() => { try { return rs.buildCoveragePlan(planFacets); } catch { return ''; } })();
  const refreshContractTodo = async () => {
    if (!planFacets.length) return;
    try {
      const ce = require('./studio/canvas_emit');
      let fileText = ''; try { const rr = await filesLib.dispatch({ tag: 'file-read', attrs: { path: file } }); fileText = String((rr && (rr.text || rr.content)) || ''); } catch {}
      const text = `${fileText}\n${(target && target.raw) || ''}`;
      // done = covered facets + the Puller contact sub-tasks the deliverable evidences (emails/phones/titles).
      const done = ce.coveredFacets(text, planFacets).concat(ce.coveredSubtasks(text));
      await canvasUpsertBlock({ focusId: focus.id, blockId: ce.todoBlockId(focus.id), title: goal, tabMode: 'RESEARCH', blockType: 'paragraph', data: { markdown: ce.facetTodoMarkdown({ facets: planFacets }, done) } });
    } catch {}
  };

  const runPass = async (prompt) => {
    try {
      const r = await runCloudOperator({ userMessage: prompt, context: '', task: true, autonomous: true });
      // VISITED MEMORY — record the URLs opened + searches run this step, so the NEXT pass is told not to
      // repeat them (the "same websites over and over" fix). Steps carry the tool + args.
      let repeats = 0;
      try {
        if (r && Array.isArray(r.steps)) {
          let vis = []; try { vis = JSON.parse(db.getMeta(`focus.${focus.id}.visited`) || '[]'); } catch {}
          // FUZZY search dedup: a re-worded permutation of a search she already ran counts as a REPEAT (not a
          // new visit) — the "Tyler Breton leadership LinkedIn" x8 loop evaded the exact-string guard.
          const sigs = new Set(vis.filter(v => /^search:/.test(v)).map(v => rs.searchSignature(v)));
          const opened = [];
          for (const s of r.steps) {
            if (s.tool === 'open_page' && s.args && s.args.url) opened.push(String(s.args.url));
            else if (s.tool === 'web_search' && s.args && s.args.query) {
              const entry = `search: ${String(s.args.query)}`;
              const sg = rs.searchSignature(entry);
              if (sg && sigs.has(sg)) { repeats++; }        // reworded repeat → do NOT record as a new visit
              else { if (sg) sigs.add(sg); opened.push(entry); }
            }
          }
          if (opened.length) {
            for (const u of opened) if (!vis.includes(u)) vis.push(u);
            db.setMeta(`focus.${focus.id}.visited`, JSON.stringify(vis.slice(-40)));
          }
        }
      } catch {}
      return { ans: (r && r.answer ? String(r.answer).trim() : ''), usedTool: !!(r && Array.isArray(r.toolsUsed) && r.toolsUsed.some(t => ['web_search', 'browser_read', 'echo'].includes(t))), repeats };
    } catch (e) { return { ans: '', usedTool: false, repeats: 0 }; }
  };

  let progressed = false, done = false, note = '', sig = '';

  // OBJECT-FIRST OPEN + BOUNDED TERMINATION (Slice 2c + guardrails). Ground every target in its Echo object;
  // a bounded run opens ONLY its intended targets and STOPS when covered — no "profile Sen Curtis → Curtis
  // Auto Sales" drift, no endless crawl. An open run still discovers, but grounds each find in Echo too.
  if (!target || !target.name) {
    if (scope === 'bounded' && rs.allTargetsCovered({ intended, covered })) {
      done = true; note = `deliverable complete — covered ${covered.slice(0, 8).join(', ')}`;
      console.log(`[directed] #${focus.id} BOUNDED complete → done`);
    } else {
      let seeds = [], consumed = [];
      try { seeds = JSON.parse(db.getMeta(`focus.${focus.id}.seed_objects`) || '[]'); } catch {}
      try { consumed = JSON.parse(db.getMeta(`focus.${focus.id}.seed_consumed`) || '[]'); } catch {}
      const seedObj = rs.pickSeedTarget({ seeds, consumed, covered });
      let nextName = seedObj ? seedObj.name : null;
      if (!nextName && scope === 'bounded') nextName = (intended || []).find(t => !covered.some(c => lc(c) === lc(t) || lc(c).includes(lc(t)) || lc(t).includes(lc(c)))) || null;
      if (nextName) {
        let obj = seedObj, known = '';
        if (!obj) { try { const rm = await echoSuitLib.resolveMention(nextName); if (rm && rm.status === 'resolved') obj = rm.object; } catch {} }
        if (obj) { try { known = require('./lib/active_recall')._objectLines(obj).join('\n'); } catch {} }
        target = { name: nextName, passes: 1, raw: known ? `PRIOR KNOWLEDGE (already in our graph):\n${known}` : '', facets: ['overview'], known, seeded: !!seedObj };
        try { db.setMeta(targetKey, JSON.stringify(target)); } catch {}
        if (seedObj) { try { db.setMeta(`focus.${focus.id}.seed_consumed`, JSON.stringify(consumed.concat(seedObj.name).slice(-50))); } catch {} }
        console.log(`[directed] #${focus.id} object-first open → ${nextName} (${scope}${known ? ', dossier in hand' : ''})`);
      }
    }
  }

  if (!done && (!target || !target.name)) {
    if (scope === 'bounded') {
      // bounded, nothing left to ground and not everything covered → finish rather than crawl foreign orgs.
      done = true; note = `deliverable complete (bounded) — covered ${covered.slice(0, 8).join(', ') || 'none yet'}`;
    } else {
      // OPEN A NEW TARGET — discovery overview pass (open scope only). Ground the pick in Echo too.
      const { ans, usedTool } = await runPass(rs.buildNewTargetPrompt({ goal, covered, guidance }));
      const p = rs.parsePass(ans);
      if (p.allCovered && covered.length) { done = true; note = `all organizations covered (${covered.length})`; }
      else if (p.target && !covered.some(c => lc(c) === p.target.toLowerCase())) {
        let known = ''; try { const rm = await echoSuitLib.resolveMention(p.target); if (rm && rm.status === 'resolved') known = require('./lib/active_recall')._objectLines(rm.object).join('\n'); } catch {}
        target = { name: p.target, passes: 1, raw: (known ? `PRIOR KNOWLEDGE (already in our graph):\n${known}\n\n` : '') + (p.body || ans), facets: ['overview'], known };
        try { db.setMeta(targetKey, JSON.stringify(target)); } catch {}
        progressed = !!(p.body && usedTool); sig = p.target.toLowerCase(); note = `started ${p.target}`;
      } else { note = p.target ? `(repeat target) ${p.target}` : 'no new target found'; sig = String(p.target || '').toLowerCase(); }
    }
  } else if (!done) {
    // DEEPEN the current target — next missing facet. A grounded target carries its graph dossier as `known`,
    // injected as GIVEN so the pass builds PAST what we already hold (object-first).
    // Anti-loop steer: tell the pass which facets are STILL missing so it pursues a new one instead of
    // re-searching one it has (paired with the fuzzy repeat-detection in runPass).
    const _cov = (() => { try { return require('./studio/canvas_emit').coveredFacets(target.raw || '', planFacets); } catch { return []; } })();
    const uncovered = planFacets.filter(f => !_cov.includes(f));
    const { ans, usedTool, repeats } = await runPass(rs.buildDeepenPrompt({ goal, target: target.name, facets: target.facets, guidance, known: target.known || '', visited, coveragePlan, uncovered }));
    const p = rs.parsePass(ans);
    const newChars = rs.newContentChars(target.raw, p.body);
    target.passes = (target.passes || 1) + 1;
    if (p.body) target.raw = `${target.raw}\n\n${p.body}`.slice(-16000);
    if (p.facet) target.facets = (target.facets || []).concat(p.facet).slice(-12);
    // ONE live-growing canvas block per target (the "building-project document"): stable block_id so the
    // draft FLESHES OUT in place as passes run, then finalizes into the cloud-organized section on advance.
    const secBlockId = `sec-${focus.id}-${String(target.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`;
    // FACET-AWARE cap: a SINGLE bounded deep target keeps deepening past the base 6-pass cap (up to the deep
    // ceiling) while facets are still uncovered + passes stay productive — so a 6-facet brief actually finishes
    // its checklist instead of being force-finalized half-covered (the #3364 thin-doc bug).
    const deepTarget = scope === 'bounded' && Array.isArray(intended) && intended.length <= 1;
    const adv = rs.decideAdvance({ passes: target.passes, newChars, saturated: p.saturated, uncovered: uncovered.length, deep: deepTarget });
    if (adv.advance) {
      // CLOUD ORGANIZE this target → one clean section (the usable DRAFT), appended to the deliverable NOW.
      let section = '';
      try { section = await condenseComplete(rs.buildOrganizeTargetPrompt({ target: target.name, raw: target.raw }), { numPredict: config.sectionNumPredict() }); } catch {}
      section = (section && section.trim()) ? section.trim() : `## ${target.name}\n${target.raw.slice(0, 1500)}`;
      const header = covered.length === 0 ? `# Directed research deliverable\n\n**Task:** ${goal}\n\n---\n\n` : '';
      try { await filesLib.dispatch({ tag: 'file-append', attrs: { path: file }, body: `${header}${section}\n\n` }); }
      catch (e) { console.error('[directed] append failed:', e.message); }
      // FINALIZE the live block in place with the organized draft (same block_id → replaces the raw draft).
      try { await canvasUpsertBlock({ focusId: focus.id, blockId: secBlockId, title: goal, tabMode: 'RESEARCH', blockType: 'paragraph', data: { markdown: section } }); } catch {}
      covered.push(target.name); try { db.setMeta(coveredKey, JSON.stringify(covered.slice(-300))); } catch {}
      note = `completed ${target.name} (${target.passes} passes, ${adv.reason}) + organized → canvas`; sig = target.name.toLowerCase(); progressed = true;
      target = null; try { db.setMeta(targetKey, ''); } catch {}
    } else {
      try { db.setMeta(targetKey, JSON.stringify(target)); } catch {}
      // BUILD-AS-IT-GOES: grow the target's draft block with the accumulating content each pass (raw, minus
      // the prior-knowledge preamble + control lines) so the canvas shows the document being built live.
      try {
        const cleaned = String(target.raw || '')
          .replace(/^PRIOR KNOWLEDGE[\s\S]*?(?:\n\n|$)/, '')   // drop the whole raw prior-knowledge dossier block (the [object] • fact dump)
          .replace(/^\s*(TARGET|FACET):.*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
        const draftMd = `## ${target.name}\n\n${cleaned.slice(0, 8000)}`;
        await canvasUpsertBlock({ focusId: focus.id, blockId: secBlockId, title: goal, tabMode: 'RESEARCH', blockType: 'paragraph', data: { markdown: draftMd } });
      } catch {}
      // A pass that only RE-RAN searches she'd already done (fuzzy repeats) is NOT progress — kills the false
      // "new chars" from re-fetched SERP text so it counts as a strike; and its signature collapses to
      // "<target>:repeat" so the stuck detector catches consecutive loop passes (both were evaded before).
      progressed = newChars >= 120 && usedTool && repeats === 0;
      sig = (repeats > 0 ? `${target.name}:repeat` : `${target.name}#${target.passes}`).toLowerCase();
      note = `deepening ${target.name}: +${p.facet || 'detail'} (${newChars} new chars${repeats ? `, ${repeats} repeat-search skipped` : ''}) → canvas`;
    }
  }

  // CONTRACT TODO (Slice 2): reflect what the deliverable now covers → the facet checklist fills in live.
  try { await refreshContractTodo(); } catch {}

  // surface to her thought-stream + accrete to the focus working set (signature = org identity so the
  // stuck detector catches a real loop, while normal deepening passes stay distinct).
  if (note) {
    try {
      const rr = db.insertMonologue({ content: note, model: 'operator', type: 'reading' });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: rr.id, ts: rr.ts, content: `(researching: ${String(focus.content).slice(0, 36)}) ${note.slice(0, 80)}`, type: 'reading' });
    } catch {}
    try { blackboard.append({ source: 'monologue', kind: 'reading', focusId: focus.id, content: note, signature: sig }); } catch {}
  }
  const outcome = done
    ? focusLib.recordOutcome(focus, { control: { type: 'done', note } })
    : focusLib.recordOutcome(focus, { progressed });
  console.log(`[directed] #${focus.id} → ${done ? 'ALL-COVERED' : note} → ${outcome.action}`);
  return outcome;
}

// KNOWN→UNKNOWN grounding: before researching an entity, pull what WE ALREADY HOLD — our prior dossier
// record on it, Zoe's memory DB, and the Echo databases — so the lanes build on that foundation and spend
// tokens only on the gaps (Lucas: "put the mapped data to work instead of redoing the same things"). Read-
// only, fail-safe (any miss → less context, never a crash). Returns a "known" block (or '').
async function gatherKnown(entity, { sourceFocusId = null, facet = '' } = {}) {
  const knownLib = require('./lib/known');
  let existing = '';
  if (sourceFocusId) {
    try {
      const r = filesLib.fileReadFull(`notes/directed-${sourceFocusId}-dossier.md`);
      const txt = (r && r.text) || '';
      if (txt) { const { sections } = require('./lib/assemble').parseSections(txt); const sec = (sections || []).find(s => require('./lib/track').mentions(entity, s.heading)); if (sec) existing = sec.body; }
    } catch {}
  }
  let local = [];
  try { const rows = await memoryLib.retrieve(entity, { k: 4 }); local = (rows || []).map(x => String((x && x.content) || '')); } catch {}
  // DATA STREAMS (integration fix) — also pull landed DOCUMENTS (prior dossiers / meeting notes / API / email)
  // and TRACKED NEWS on this entity, so research BUILDS ON them instead of re-discovering (research was blind
  // to news_bucket + the documents table). Fail-soft.
  try { const docs = require('./lib/doc_store').recall(entity, 3) || []; for (const d of docs) { const c = `${d.title ? d.title + ': ' : ''}${String(d.markdown || '').replace(/\s+/g, ' ').slice(0, 300)}`.trim(); if (c) local.push(c); } } catch {}
  try { const nl = require('./lib/news_lane'); for (const n of nl.storiesAsNotes(nl.storiesForTopic(entity, { k: 3 }), { max: 3 })) if (n && n.content) local.push(n.content); } catch {}
  let echo = [];
  try {
    if (echoSuit) {
      const e = await echoSuit.dispatch({ kind: 'do', name: 'search_entities', args: { query: entity, top_k: 3 } });
      if (e && e.ok && e.text && !/^\s*(no |0 )/i.test(e.text)) echo.push(e.text.slice(0, 500));
      const k = await echoSuit.dispatch({ kind: 'do', name: 'search_knowledge', args: { query: entity, top_k: 3 } });
      if (k && k.ok && k.text) echo.push(k.text.slice(0, 500));
    }
  } catch {}
  return knownLib.buildKnownBlock({ entity, existing, local, echo });
}

// TWO-LANE DEEP RESEARCH for ONE target: the WEB lane (her browser + Echo web tools, on the fast model)
// and the DEEP lane (structured DBs + our knowledge graph, on the 120B reasoner) run CONCURRENTLY, then
// a merge pass folds both raw streams into one section. This is the multi-cloud win — each lane runs the
// model that fits its work, in parallel. Fail-safe: a lane that dies → '' for that side; the merge still
// runs on whatever came back. Returns { section, webRaw, deepRaw, lanes }.
async function runDeepResearchTarget({ org, goal = '', facet = '', guidance = '', known = '' }) {
  const rs = require('./lib/research');
  const tier = require('./lib/echo_tier');
  const operatorMod = require('./lib/operator');
  const fastModel = (() => { try { return operatorMod.operatorModel(); } catch { return 'gemma4:31b'; } })();
  const deepModel = (() => { try { return require('./lib/config').subconsciousModel() || 'gpt-oss:120b'; } catch { return 'gpt-oss:120b'; } })();
  const tail = operatorMod.TOOL_SPEC_TAIL || '';
  const webSpec = ['TOOLS (call exactly ONE per step):',
    '- web_search {"query":"…"}      search the open web + read the top result',
    '- open_page {"url":"…"}         open a SPECIFIC page in her browser and read it fully (go to the org\'s /team, /leadership, /about, /contact)',
    '- see_page {"url":"…","focus":"…"}  SEE a page with your EYES (vision) — reads infoboxes, tables, charts, and JS-rendered content the text read MISSES. Use when open_page returned thin/empty text or the facts live in a table/infobox. `focus` = what you\'re after.',
    '- browser_read {}               read the page currently open in her browser',
    tier.laneSpec('web'),
    '- echo {"need":"…"}             open-web / reference lookups (read-only)',
    '- recall {"query":"…"}          her own memory', '', tail].join('\n');
  const deepSpec = ['TOOLS (call exactly ONE per step):',
    tier.laneSpec('deep'),
    '- echo {"need":"…"}             OUR private data + the 500+ structured research tools — say the need in plain words',
    '- recall {"query":"…"}          her own memory', '', tail].join('\n');

  const [web, deep] = await Promise.all([
    runCloudOperator({ userMessage: rs.buildWebLanePrompt({ goal, org, facet, guidance, known }), context: '', task: true, autonomous: true, toolNames: tier.laneToolNames('web'), model: fastModel, toolSpec: webSpec }).catch(() => null),
    runCloudOperator({ userMessage: rs.buildDeepLanePrompt({ goal, org, facet, guidance, known }), context: '', task: true, autonomous: true, toolNames: tier.laneToolNames('deep'), model: deepModel, toolSpec: deepSpec }).catch(() => null)
  ]);
  const webRaw = (web && web.answer) ? String(web.answer).trim() : '';
  const deepRaw = (deep && deep.answer) ? String(deep.answer).trim() : '';
  let section = '';
  try { section = await condenseComplete(rs.buildMergeLanesPrompt({ org, facet, webRaw, deepRaw, known }), { numPredict: config.sectionNumPredict() }); } catch {}
  section = (section && section.trim()) ? section.trim() : `## ${org}\n- **${rs.facetLabel(facet)}:** ${((webRaw || deepRaw) || '').slice(0, 800).trim() || 'not found'}`;
  const used = (r) => !!(r && Array.isArray(r.toolsUsed) && r.toolsUsed.length);
  return { section, webRaw, deepRaw, lanes: { web: used(web), deep: used(deep) } };
}

// ENRICH / FACET-FILL pass: walk the KNOWN org work-list (from a prior dossier) and fill ONE named facet
// (e.g. "policy / government-relations VPs + contacts") for the next not-yet-enriched org. Mirror of the
// discovery pass, but the org is GIVEN (no TARGET discovery) and the run terminates when every source org
// has been enriched. Reuses the SAME `.covered` meta + `## <org>` file shape, so condenseRun + the
// deliverable-query path work unchanged. This is the build that makes "expand the 21 FOR THEIR VPs"
// actually deepen the 21 instead of drifting into new orgs.
async function runEnrichResearchPass(focus) {
  const focusLib = require('./lib/focus');
  const blackboard = require('./lib/blackboard');
  const rs = require('./lib/research');
  const goal = String(focus.content || '');
  const coveredKey = `focus.${focus.id}.covered`;     // reuse .covered = the orgs ENRICHED so far (uniform with discovery)
  const fileKey = `focus.${focus.id}.file`;
  const facet = (() => { try { return db.getMeta(`focus.${focus.id}.enrich_facet`) || ''; } catch { return ''; } })();
  let sourceOrgs = []; try { sourceOrgs = JSON.parse(db.getMeta(`focus.${focus.id}.enrich_orgs`) || '[]'); } catch {}
  let enriched = []; try { enriched = JSON.parse(db.getMeta(coveredKey) || '[]'); } catch {}
  let file = db.getMeta(fileKey); if (!file) { file = `notes/directed-${focus.id}.md`; try { db.setMeta(fileKey, file); } catch {} }
  try { db.setMeta('research.last_focus_id', String(focus.id)); } catch {}
  let clar = []; try { clar = JSON.parse(db.getMeta(`focus.${focus.id}.clarifications`) || '[]'); } catch {}
  const guidance = rs.buildGuidanceBlock(clar);
  // DEEP MODE: when set, each org is worked by the two-lane runner (web ∥ structured → merge) instead
  // of a single web-leaning pass. Opt-in per focus so the cheap single-lane path stays the default.
  const deepMode = (() => { try { return (db.getMeta(`focus.${focus.id}.deep`) || '') === '1'; } catch { return false; } })();

  let progressed = false, done = false, note = '', sig = '';
  const org = rs.pickEnrichTarget({ sourceOrgs, enriched });
  if (!org) {
    done = true; note = `facet filled across all ${enriched.length} organization(s): ${rs.facetLabel(facet)}`;
  } else {
    // KNOWN→UNKNOWN: gather what we already hold on this org (prior dossier record + Zoe's memory + Echo)
    // so the lanes build on it and chase only the gaps, instead of re-researching from scratch.
    const enrichSource = (() => { try { return parseInt(db.getMeta(`focus.${focus.id}.enrich_source`) || '0', 10) || null; } catch { return null; } })();
    const known = await gatherKnown(org, { sourceFocusId: enrichSource, facet });
    // Build this org's section — two-lane (deep) or single-pass (default).
    let section = '', laneNote = '';
    if (deepMode) {
      const dr = await runDeepResearchTarget({ org, goal, facet, guidance, known });
      section = dr.section; laneNote = ` [web:${dr.lanes.web ? '✓' : '–'} deep:${dr.lanes.deep ? '✓' : '–'}${known ? ' known✓' : ''}]`;
    } else {
      // ONE focused pass: fill ONLY the named facet for THIS org.
      let ans = '';
      try {
        const r = await runCloudOperator({ userMessage: rs.buildEnrichPrompt({ goal, org, facet, guidance, known }), context: '', task: true, autonomous: true });
        ans = (r && r.answer) ? String(r.answer).trim() : '';
      } catch (e) { console.error('[enrich] pass failed:', e.message); }
      const p = rs.parsePass(ans);
      // ORGANIZE this org's facet findings → one clean section, appended NOW (continuous, like discovery).
      try { section = await condenseComplete(rs.buildOrganizeEnrichPrompt({ org, facet, raw: p.body || ans }), { numPredict: config.sectionNumPredict() }); } catch {}
      section = (section && section.trim()) ? section.trim() : `## ${org}\n- **${rs.facetLabel(facet)}:** ${((p.body || ans) || '').slice(0, 800).trim() || 'not found'}`;
    }
    const header = enriched.length === 0 ? `# Enrichment deliverable\n\n**Task:** ${goal}\n\n**Facet:** ${facet}${deepMode ? ' (deep two-lane research)' : ''}\n\n---\n\n` : '';
    try { await filesLib.dispatch({ tag: 'file-append', attrs: { path: file }, body: `${header}${section}\n\n` }); }
    catch (e) { console.error('[enrich] append failed:', e.message); }
    // DRIVE → Canvas: mirror the organized section as a live per-org block as the run advances.
    try { const blk = require('./studio/canvas_emit').orgSectionBlock(section); await canvasEmit({ focusId: focus.id, title: goal, tabMode: 'RESEARCH', blockType: blk.blockType, data: blk.data }); } catch {}
    enriched.push(org); try { db.setMeta(coveredKey, JSON.stringify(enriched.slice(-300))); } catch {}
    // Advancing one org per pass with a distinct signature = never looks "stuck"; progressed reflects real
    // content (so a run of empty "not found" passes still moves forward but is honestly logged).
    progressed = !!(section && section.length > 40);
    note = `enriched ${org} → ${rs.facetLabel(facet)} (${enriched.length}/${sourceOrgs.length})${laneNote}`; sig = `enrich:${org.toLowerCase()}`;
  }

  if (note) {
    try {
      const rr = db.insertMonologue({ content: note, model: 'operator', type: 'reading' });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: rr.id, ts: rr.ts, content: `(enriching: ${String(focus.content).slice(0, 30)}) ${note.slice(0, 80)}`, type: 'reading' });
    } catch {}
    try { blackboard.append({ source: 'monologue', kind: 'reading', focusId: focus.id, content: note, signature: sig }); } catch {}
  }
  const outcome = done
    ? focusLib.recordOutcome(focus, { control: { type: 'done', note } })
    : focusLib.recordOutcome(focus, { progressed });
  console.log(`[enrich] #${focus.id} → ${done ? 'ALL-ENRICHED' : note} → ${outcome.action}`);
  return outcome;
}

// TOPICAL / FORECAST pass (research A3b) — research a SUBJECT across the plan's aspects into a briefing,
// one aspect per pass, NO org-walk and NO contact hunting. Mirrors runEnrichResearchPass's shape: pick the
// next uncovered aspect → ONE grounded operator pass (buildTopicalPrompt) → organize into a clean section →
// append to the file + Canvas → mark it covered → done when every aspect is covered. Fail-soft throughout.
async function runTopicalResearchPass(focus) {
  const focusLib = require('./lib/focus');
  const blackboard = require('./lib/blackboard');
  const rs = require('./lib/research');
  const goal = String(focus.content || '');
  const kind = (() => { try { return (db.getMeta(`focus.${focus.id}.kind`) || 'topical').trim(); } catch { return 'topical'; } })();
  const fileKey = `focus.${focus.id}.file`;
  let file = db.getMeta(fileKey); if (!file) { file = `notes/directed-${focus.id}.md`; try { db.setMeta(fileKey, file); } catch {} }
  try { db.setMeta('research.last_focus_id', String(focus.id)); } catch {}
  let clar = []; try { clar = JSON.parse(db.getMeta(`focus.${focus.id}.clarifications`) || '[]'); } catch {}
  const guidance = rs.buildGuidanceBlock(clar);
  // The aspects to cover = the plan's facets (kind-shaped in A2 — subject aspects, not org/contact facets).
  let planFacets = [];
  try { const pl = JSON.parse(db.getMeta(`focus.${focus.id}.plan`) || 'null'); planFacets = (pl && Array.isArray(pl.facets)) ? pl.facets : []; } catch {}
  if (!planFacets.length) planFacets = ['Current state & key developments', 'Drivers & causes', 'Implications & what to watch', 'Sources & evidence'];
  let covered = []; try { covered = JSON.parse(db.getMeta(`focus.${focus.id}.topical_covered`) || '[]'); } catch {}

  let progressed = false, done = false, note = '', sig = '';
  const nextFacet = planFacets.find(f => !covered.some(c => String(c).toLowerCase() === String(f).toLowerCase()));
  if (!nextFacet) {
    done = true; note = `briefing complete — ${covered.length} aspect(s) covered`;
  } else {
    let ans = '';
    try {
      const r = await runCloudOperator({ userMessage: rs.buildTopicalPrompt({ goal, facet: nextFacet, covered, guidance }), context: '', task: true, autonomous: true });
      ans = (r && r.answer) ? String(r.answer).trim() : '';
    } catch (e) { console.error('[topical] pass failed:', e.message); }
    const p = rs.parsePass(ans);
    const body = (p.body || ans || '').trim();
    // Organize this aspect into a clean, sourced section (fail-safe to the raw body under an aspect heading).
    let section = '';
    try {
      if (body && !/^COVERED$/i.test(body)) {
        section = await condenseComplete(`Rewrite the following research notes into 1-3 clean, sourced paragraphs under a bold heading "${nextFacet}". Keep every fact and its source; drop any tool/JSON/control noise; never add anything not present in the notes.\n\n${body.slice(0, 6000)}`, { numPredict: config.sectionNumPredict() });
      }
    } catch {}
    if (!section || !section.trim()) section = `## ${nextFacet}\n${body.slice(0, 1200) || '_not found this pass_'}`;
    section = section.trim();
    const header = covered.length === 0 ? `# ${kind === 'forecast' ? 'Forecast' : 'Briefing'}: ${goal}\n\n---\n\n` : '';
    try { await filesLib.dispatch({ tag: 'file-append', attrs: { path: file }, body: `${header}${section}\n\n` }); }
    catch (e) { console.error('[topical] append failed:', e.message); }
    // Mirror the section onto the Canvas as a live-growing block, and check the aspect off the TODO.
    try { const blk = require('./studio/canvas_emit').orgSectionBlock(section); await canvasEmit({ focusId: focus.id, title: goal, tabMode: 'RESEARCH', blockType: blk.blockType, data: blk.data }); } catch {}
    covered.push(nextFacet); try { db.setMeta(`focus.${focus.id}.topical_covered`, JSON.stringify(covered.slice(-40))); } catch {}
    try { const ce = require('./studio/canvas_emit'); await canvasUpsertBlock({ focusId: focus.id, blockId: ce.todoBlockId(focus.id), title: goal, tabMode: 'RESEARCH', blockType: 'paragraph', data: { markdown: ce.facetTodoMarkdown({ facets: planFacets }, covered) } }); } catch {}
    progressed = !!(section && section.length > 40);
    note = `${kind === 'forecast' ? 'forecast' : 'brief'}: covered "${nextFacet}" (${covered.length}/${planFacets.length})`;
    sig = `topical:${String(nextFacet).toLowerCase().slice(0, 40)}`;
  }

  if (note) {
    try {
      const rr = db.insertMonologue({ content: note, model: 'operator', type: 'reading' });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: rr.id, ts: rr.ts, content: `(${kind === 'forecast' ? 'forecasting' : 'briefing'}: ${String(focus.content).slice(0, 30)}) ${note.slice(0, 80)}`, type: 'reading' });
    } catch {}
    try { blackboard.append({ source: 'monologue', kind: 'reading', focusId: focus.id, content: note, signature: sig }); } catch {}
  }
  const outcome = done
    ? focusLib.recordOutcome(focus, { control: { type: 'done', note } })
    : focusLib.recordOutcome(focus, { progressed });
  console.log(`[topical] #${focus.id} (${kind}) → ${done ? 'COMPLETE' : note} → ${outcome.action}`);
  return outcome;
}

// Stand up an ENRICH run over a prior dossier: a NEW directed focus whose work-list is the source
// dossier's orgs and whose single job is to fill `facet` across all of them. Returns { focus, orgs } or
// null. Does NOT kick the driver — the caller decides when to start (live entry kicks it; the re-establish
// script lets Lucas start it deliberately). Pure-ish: only focus/meta writes + a full dossier read.
async function establishEnrichRun({ sourceFocusId = null, facet = '', sourceTurnId = null, priorGoal = '', deep = false, topN = null, priority = null } = {}) {
  const cd = require('./lib/condense');
  const focusLib = require('./lib/focus');
  if (!facet || !facet.trim()) return null;
  const path = `notes/directed-${sourceFocusId}-dossier.md`;
  let dossier = ''; try { const r = filesLib.fileReadFull(path); dossier = (r && r.text) || ''; } catch {}
  let orgs = cd.dossierOrgs(dossier);
  if (!orgs.length) { console.log(`[enrich] no orgs in ${path} — cannot establish`); return null; }
  // SUBSET ("the 5 most complete"): narrow the work-list to the top-N by MEASURED completeness.
  if (topN && topN > 0 && topN < orgs.length) {
    try {
      const as = require('./lib/assemble'); const rc = require('./lib/record_completeness');
      const { sections } = as.parseSections(dossier);
      const ranked = rc.rankByCompleteness(sections).slice(0, topN).map(s => s.heading);
      if (ranked.length) orgs = ranked;
    } catch (e) { console.error('[enrich] subset rank failed, using all:', e.message); }
  }
  const goal = `Enrich the existing research on ${orgs.length} organization(s) by filling, FOR EACH, this facet: ${facet}. These orgs are already documented — deepen them, do NOT find new ones.${priorGoal ? ` (Deepens: "${String(priorGoal).slice(0, 140)}".)` : ''}`.slice(0, 780);
  const r = await focusLib.setFromDirective(goal, sourceTurnId);
  if (!r || !r.focus) return null;
  const fid = r.focus.id;
  try {
    db.setMeta(`focus.${fid}.mode`, 'enrich');
    db.setMeta(`focus.${fid}.enrich_facet`, facet.trim());
    db.setMeta(`focus.${fid}.enrich_orgs`, JSON.stringify(orgs));
    db.setMeta(`focus.${fid}.enrich_source`, String(sourceFocusId || ''));
    db.setMeta(`focus.${fid}.covered`, '[]');
    db.setMeta(`focus.${fid}.file`, `notes/directed-${fid}.md`);
    if (deep) db.setMeta(`focus.${fid}.deep`, '1');   // two-lane (web ∥ structured) per org
    if (priority) db.setMeta(`focus.${fid}.priority`, String(priority));
  } catch (e) { console.error('[enrich] establish meta failed:', e.message); }
  // PAGE-1 PLAN (Pillar 0) — author + store it now, so it's reviewable at the start (the readback can
  // surface it) and ready as page 1 at finalize. Best-effort; never blocks the run.
  let plan = null;
  try { plan = await generateResearchPlan(r.focus, { goal, targets: orgs, facet, deep }); } catch {}
  console.log(`[enrich] established #${fid} over #${sourceFocusId} — ${orgs.length} orgs, facet: ${facet.slice(0, 60)}${deep ? ' [DEEP]' : ''}${priority ? ' [' + priority + ']' : ''}${plan ? ' [+plan]' : ''}`);
  return { focus: r.focus, orgs, plan };
}

// SEE — run any image (base64, from ANY surface: her browser, the shared browser, the screen, an
// image file) through her vision model and answer in chat: store it as a reading, capture facts,
// and tool-follow-up so she speaks what she saw. One path so every surface behaves identically and
// fails the same honest way. Caller guards with followupFired.
async function seeImage({ io, channel, sessionId, userName, base64, label, url = null, question = null, surface = 'vision' }) {
  let vr;
  try { vr = await require('./lib/vision').describe({ imageBase64: base64, prompt: question || null }); }
  catch (e) { vr = { ok: false, reason: e.message }; }
  if (vr && vr.ok) {
    const content = `I visually looked at ${label}${url ? ` (${url})` : ''} and SAW:\n${vr.text}`;
    try {
      const row = db.insertMonologue({ content, model: surface, type: 'reading', query: url || label, urls: url ? [url] : null });
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(saw) ${label}`, type: 'reading', query: url || label });
    } catch {}
    try { require('./lib/learning').maybeCaptureLearnings({ query: label, content, urls: url ? [url] : null }); } catch {}
    console.log(`[main] ${surface} "${label}": ok ${vr.tier}/${vr.model}`);
    await fireToolFollowup({ io, channel, sessionId, resultText: content });
  } else {
    console.log(`[main] ${surface} "${label}": FAIL ${vr && vr.reason}`);
    await fireToolFollowup({ io, channel, sessionId, resultText: `[You tried to visually SEE ${label} but couldn't (${vr && vr.reason}). Tell ${userName} plainly you couldn't see it this time — don't invent what's there.]` });
  }
}

// Action loop self-driver: runs ONE step of the active action (inject the single-step
// directive → generate → dispatch the resulting email tag → observe → advance), then
// chains to the next step on its own. Steps are silent; only completion/abort speaks.
// This is what makes a multi-step action (reply: draft→body→send) happen without Lucas
// prompting each step — the 24B only has to emit one tag at a time.
async function runActionStep(io, depth = 0) {
  if (!actionLoop.isActive()) return;
  if (depth > 8) { actionLoop.abort(); console.log('[action] depth cap — aborted'); return; }
  const channel = (io && io.channel) || 'desktop';
  const userName = db.getMeta('user_name') || 'them';
  try {
    // Deterministic step (start-draft / send): the loop runs it directly — no model
    // turn. Only generative steps (writing the reply body) go to the 24B.
    const didAuto = await actionLoop.runCurrentAuto();
    if (!didAuto) {
      const directive = actionLoop.currentDirective();
      if (directive) {
        const awareness = buildAwarenessBlock({ chosenName: db.getMeta('chosen_name'), sessionStartedAt: currentSessionStartedAt, cumulativeMs: db.getCumulativeSessionTime() });
        const messages = buildChatPrompt({
          userName, recentReflections: [], recentTurns: db.getRecentTurns(4), recentMonologue: [],
          recentReadings: [], heldCommitments: [], openThreads: [], awareness,
          protocols: db.getActiveProtocols(), browserBlock: emailLib.buildPromptBlock(),
          pendingInbounds: [], retrievedKnowledgeBlock: null,
          newUserMessage: `[You are carrying out a multi-step action, one step at a time. Do EXACTLY the step below — emit the single tag it names, raw, and nothing else.]\n\n${directive}`
        });
        // Steps run silent (no streaming to the user); the final confirmation speaks.
        const parser = new TagStreamParser({ onSayToken: () => {} });
        await streamChat({ model: MODEL, messages, onToken: (c) => parser.feed(c) });
        const { thought, say } = parser.finalize();
        let tags = [...emailLib.parseTags(thought || ''), ...emailLib.parseTags(say || '')];
        const expect = actionLoop.currentExpect();
        if (expect) tags = tags.filter(t => t.tag === expect); // only the tag this step wants
        // FALLBACK: the body step needs <email-body>…</email-body>, but the 24B often writes
        // the reply as plain prose without the tag — then nothing dispatches, the check fails,
        // and the action retries→aborts (observed). If we're on the body step and got no tag,
        // wrap the prose she wrote as the body so the reply actually goes out.
        if (expect === 'email-body' && tags.length === 0) {
          const prose = ((say && say.trim()) || (thought && thought.trim()) || '').trim();
          if (prose.length >= 5) { tags = [{ tag: 'email-body', attrs: {}, body: prose }]; console.log('[action] email-body fallback: wrapped prose (no tag emitted)'); }
        }
        for (const t of tags.slice(0, 3)) { try { await emailLib.dispatch(t, { source: 'action' }); } catch (e) { console.error('[action] dispatch:', e.message); } }
      }
    }
    const res = await actionLoop.observe();
    console.log('[action] step:', JSON.stringify(res));
    if (res.status === 'advanced' || res.status === 'retry') {
      setTimeout(() => { runActionStep(io, depth + 1).catch(() => {}); }, 1500);
    } else if (res.status === 'complete') {
      if (res.name === 'email-reply') {
        const to = db.getMeta('last_inbound_from') || 'a sender';
        memoryLib.logAction(`I replied by email to ${to}.`, { source: 'email' }).catch(() => {});
        // EXPERIENCE: distill the reusable procedure from this completed action +
        // mark where the raw data lives (the email it replied to).
        experience.captureActionOutcome({
          name: res.name,
          task: `reply to an email from ${to}`,
          success: true,
          provenance: experience.marker('email', { to, subject: db.getMeta('last_inbound_subject') || '', label: `email reply to ${to}` })
        }).catch((e) => console.error('[experience] capture failed:', e.message));
      }
      fireToolFollowup({ io, channel, sessionId: currentSessionId, resultText: `[You just finished the action "${res.name}" — it completed successfully. Tell ${userName} briefly what you did, in your own voice.]`, prompted: false });
    } else if (res.status === 'aborted') {
      fireToolFollowup({ io, channel, sessionId: currentSessionId, resultText: `[The action "${res.name}" got stuck and was stopped after several tries. Tell ${userName} plainly that you couldn't finish it — do not pretend it worked.]`, prompted: false });
    }
  } catch (err) {
    console.error('[action] runActionStep failed:', err.message);
    actionLoop.abort();
  }
}
