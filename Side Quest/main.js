const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

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
const RECENT_TURN_LIMIT = 14;
const RECENT_REFLECTION_LIMIT = 5;
const DISPLAY_HISTORY_LIMIT = 50;

let mainWindow = null;
let currentSessionId = null;
let currentSessionStartedAt = null;
let inboxPollTimer = null;     // setInterval id for the inbox poller (cleared on shutdown)
let inboxPollTimeout = null;   // initial-sweep setTimeout id
let lastUserTurnTs = Date.now(); // for detecting "return after a long absence" (capability proposals)
const RETURN_IDLE_MS = 10 * 60 * 1000; // gap that counts as "they were away"

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 800,
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
  editorWindow = new BrowserWindow({
    width: 1100,
    height: 820,
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
  workspaceWindow = new BrowserWindow({
    width: 1280,
    height: 860,
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
  workspaceWindow.once('ready-to-show', () => { workspaceWindow.show(); workspaceWindow.focus(); });
  workspaceWindow.on('closed', () => { workspaceWindow = null; });
  return workspaceWindow;
}

let canvasWindow = null;
// Zoe's Canvas — the THIRD window of the model, distinct from the operator workbench: ZOE's own
// surface for large deliverables + visual aids (she populates it; the saga store is the system of
// record). Loads canvas.html directly as a full page (no webview host). Read-only in Slice 1.
function createCanvasWindow() {
  if (canvasWindow && !canvasWindow.isDestroyed()) { canvasWindow.focus(); return canvasWindow; }
  canvasWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#0d0d10',
    title: "Zoe's Canvas",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  canvasWindow.loadFile(path.join(__dirname, 'renderer', 'canvas.html'));
  canvasWindow.once('ready-to-show', () => { canvasWindow.show(); canvasWindow.focus(); });
  canvasWindow.on('closed', () => { canvasWindow = null; });
  return canvasWindow;
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
      const r = await cloudCurator.runDailyPass({ apply: true, onLog: (m) => console.log('[curation]', m) });
      console.log('[curation] pass complete:', JSON.stringify(r.stages));
      curationBeat(r.stages);
    } catch (e) { console.error('[curation] pass failed:', e.message); }
    finally { curationRunning = false; }
  };
  setInterval(() => { maybeRunCuration().catch(() => {}); }, CURATION_CHECK_MS).unref?.();
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
      .catch(e => { console.error('[main] engine ensure failed:', e.message); return tryEchoAttach(); });
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
  // Zoe's Canvas auto-spawns at launch (it's a primary surface, not on-demand). The renderer
  // self-retries its first load until the engine attaches, so an early spawn is fine.
  try { createCanvasWindow(); } catch (e) { console.error('[main] canvas auto-spawn failed:', e.message); }

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
    getSessionStartedAt: () => currentSessionStartedAt
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

// New document → pick a text file, normalize it to a working copy, register it into the pipeline.
// Slice 1 supports .md/.txt directly (editor_import reads them); .docx/.pdf land later via Echo
// extraction (they need opts.markdown from the engine's ingest).
ipcMain.handle('editor:import-document', async () => {
  try {
    const res = await dialog.showOpenDialog(editorWindow || mainWindow, {
      title: 'Import a document into the Editor',
      properties: ['openFile'],
      filters: [{ name: 'Text / Markdown', extensions: ['md', 'markdown', 'txt', 'text'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const filePath = res.filePaths[0];
    const wc = editorImport.importFile(filePath);
    const doc = editorRegistry.registerDocument({
      title: wc.title, docType: wc.format, source: 'upload',
      echoDocPath: filePath, changeSummary: `imported from .${wc.format}`,
    });
    editorRegistry.saveWorkingCopy(doc.id, 1, wc);
    return { ok: true, document: editorRegistry.getDocument(doc.id) };
  } catch (e) {
    console.error('[editor] import failed:', e.message);
    return { ok: false, error: e.message };
  }
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

    const res = await editorChecks.runHarnessChecks({
      callTool, workingCopy, complete, docId,
      sourceDocPath: doc.echo_doc_path || null, author: doc.author, sourceVersion: doc.current_version,
      classifyModelName: useCloud ? cloudModel : MODEL,
      classifyBase: useCloud ? cloud.base : null,
      classifyHeaders: useCloud ? { Authorization: `Bearer ${cloud.token}` } : null,
      cheapModel: MODEL,                              // homework-check stays local/cheap (coherence gate)
      embed: memoryLib.embed, cosine: memoryLib.cosine,
      // fetch via Echo web_extract (clean text); SEARCH via Zoe's own DuckDuckGo provider so
      // no-URL claims resolve without an engine-side search-provider key.
      resolveOpts: { tools: { fetch: 'web_extract' }, search: (q) => webSearch(q) },
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
      options: { temperature: 0.3, num_ctx: 8192 },
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
  const res = await fetch(`${echoHttp.base}/canvas`, { headers });
  if (!res || !res.ok) throw new Error(`canvas snapshot ${res ? res.status : 'no response'}`);
  return await res.json();
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
      data = { src: `data:${IMG_MIME[ext]};base64,${b64}`, alt: baseName };
      blockType = 'image'; mode = 'ILLUSTRATIVE';
    } else if (ext === 'pdf') {                            // PDF → embed the REAL document (Chromium PDF viewer)
      data = { src: 'file:///' + filePath.replace(/\\/g, '/').replace(/^\/+/, ''), alt: baseName };
      blockType = 'document_file';                          // 'pdf' is not a valid engine block type
    } else if (ext === 'csv' || ext === 'tsv') {           // SPREADSHEET (delimited) → table
      const tbl = require('./studio/sheet_view').csvToTable(fs.readFileSync(filePath, 'utf8'), ext === 'tsv' ? '\t' : ',');
      data = { headers: tbl.headers, rows: tbl.rows, caption: tbl.truncated ? `+${tbl.truncated} more rows` : null };
      blockType = 'table';
    } else if (ext === 'xlsx' || ext === 'xlsm' || ext === 'xls') {   // EXCEL → table (first sheet)
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(filePath);
      const ws = wb.worksheets[0];
      const rows = [];
      if (ws) ws.eachRow((r) => rows.push((r.values || []).slice(1).map(v => (v == null ? '' : (typeof v === 'object' ? (v.text || v.result || v.hyperlink || JSON.stringify(v)) : v)))));
      const tbl = require('./studio/sheet_view').toTable(rows);
      data = { headers: tbl.headers, rows: tbl.rows, caption: ws ? `${ws.name}${tbl.truncated ? ` · +${tbl.truncated} more rows` : ''}` : null };
      blockType = 'table';
    } else if (ext === 'docx') {                           // WORD → rich HTML (tables, emphasis, inline images)
      try { const r = await require('./lib/doc_extract').extractDocxHtml(filePath); if (r && r.html && r.html.trim()) { data = { html: r.html }; blockType = 'document_file'; } } catch {}
      if (!data) {                                         // fallback: flattened markdown as a paragraph
        let markdown = ''; try { markdown = (await require('./lib/doc_extract').extractDocx(filePath)).markdown || ''; } catch {}
        if (!markdown.trim()) return { ok: false, error: 'empty / unreadable .docx' };
        data = { markdown: markdown.slice(0, 200000) };    // blockType stays 'paragraph'
      }
    } else {                                               // DOCUMENT (md/txt/code/pdf-text-fallback/…) → markdown
      let markdown = '';
      try { markdown = (await require('./lib/doc_extract').extractToMarkdown(filePath)).markdown || ''; }
      catch (e) { try { markdown = fs.readFileSync(filePath, 'utf8'); } catch { return { ok: false, error: `could not read ${path.basename(filePath)}: ${e.message}` }; } }
      if (!markdown.trim()) return { ok: false, error: 'empty / unreadable document' };
      const firstH = markdown.split(/\r?\n/).map(l => l.trim()).find(l => /^#{1,6}\s+\S/.test(l));
      if (firstH) title = firstH.replace(/^#{1,6}\s+/, '').slice(0, 120);
      data = { markdown: markdown.slice(0, 200000) };
    }

    const tabKey = `drop-${path.basename(filePath).replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}-${Date.now().toString(36)}`;
    const callTool = pollCallTool();
    await callTool('saga_canvas_open_tab', { mode, tab_key: tabKey, title });
    await callTool('saga_canvas_add_block', { tab_key: tabKey, block_type: blockType, data });
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
      if (meetUrl) { gmeetLib.start(meetUrl); console.log(`[main] gmeet join started: ${meetUrl}`); }
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
  const openThreads = socialTurn ? [] : db.getActiveOpenThreads(3, { includeStalled: false });  // don't pull parked/stalled threads into chat replies
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
  // ECHO NUDGE (F1) — when Lucas explicitly invokes the suit / our data ("use the db", "the power
  // suit", "our records/KB/graph", "echo"), bind that to the echo tags right at the message tail
  // (highest recency) so she reaches for Echo instead of defaulting to her web browser (the LAMP →
  // Japanese-band miss). Only when the suit is actually connected.
  if (echoSuit && echoSuit.connected && ECHO_INVOKE_RE.test(userMessage)) {
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
  try {
    const rk = qClass === 'narrow'
      ? await memoryLib.retrieve(userMessage, { k: 3, preferLeaf: true })   // entity-exact, leaf-first
      : await memoryLib.retrieveScored(userMessage, { k: 6, minRelevance: 0.35 }); // floored: off-topic notes can't fill K (retrieveScored embeds the query itself)
    rkRows = rk || [];
    retrievedKnowledgeBlock = memoryLib.formatForPrompt(rk, userName);
  } catch (err) { console.error('[main] knowledge retrieve failed:', err.message); }

  // POLL OWNS THE TURN: when the activity poll or an aggregate deliverable poll (count/list/facet/
  // status) will answer from the live Track, suppress the generic semantic retrieval — it pulls
  // self_dev/dev nodes ("batching and Bulk API…") or a stale "(5 orgs)" dossier node that Dans then
  // relays over the live truth. The grounded answer must DOMINATE, not compete.
  if (activityQ || deliverableAggQ) { retrievedKnowledgeBlock = null; rkRows = []; }

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

  // SCOPED CONTEXT — relevance-gate the recency blocks (recent monologue + readings) against the
  // message so off-topic between-turn musing can't ride along ("picking up random stuff"). Now runs
  // on EVERY turn (was: only narrow/actionable). The texture argument lost to the symptom — on a
  // social turn her recent permitting-rumination IS the random noise; a recent thought genuinely
  // related to what's being said still clears 0.4 and comes through, so relevant texture survives.
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
      const factual = (() => { try { return require('./lib/metacognition').classifyClaimType(userMessage) === 'factual'; } catch { return false; } })();
      if (factual || personalFactQ) {
        const grounding = ad.factualGrounding({ knowledgeBlock: retrievedKnowledgeBlock, pastTurns: relevantPastTurns });
        if (grounding) {
          const d = await ad.draft({ userMessage, grounding, kind: 'knowledge' });
          if (d) { composedUserMessage = `${composedUserMessage}\n\n${ad.buildVoiceBlock(d, userName)}`; console.log(`[main] cloud-drafted knowledge answer → "${d.slice(0, 70)}"`); }
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

  // INTAKE GATE — runs BEFORE the deliverable poll so an ASSIGNMENT ("spin up a project generating
  // contacts for the 5, deep") is recognized as work to DO, not swallowed as a QUESTION by the poll
  // (his assignment matches the records/contact detectors → the poll set statusHandled and gated off
  // run creation — the live failure). One cloud pass decides is-this-a-project + how (discover/enrich,
  // deep, priority, subset). FAIL-SAFE: cloud null → isDirectedTask regex fallback. When it's an
  // assignment, the poll + records-interp below are SUPPRESSED (!isAssignment) and the standing-focus
  // block creates the real run.
  let intakeRoute = null;
  let isAssignment = false;
  try {
    const opOn2 = (() => { try { return (db.getMeta('operator.mode') || 'full').trim() !== 'off'; } catch { return true; } })();
    if (opOn2 && !socialTurn && !followupFired && !directedStopHandled && !expandHandled && userMessage && userMessage.trim().length > 6) {
      const intake = require('./lib/intake');
      const af = (() => { try { const f = require('./lib/focus').getCurrent(); return f ? String(f.content || '') : ''; } catch { return ''; } })();
      const recent = (recentTurns || []).slice(-3).map(t => `${t.speaker || '?'}: ${String(t.content || '').slice(0, 120)}`).join(' | ');
      const decision = await intake.classify(userMessage, { recent, activeFocus: af });
      if (decision) intakeRoute = intake.route(decision);
      // PRIMARY = the cloud decision; the regex is the FALLBACK only when the cloud was unavailable (null).
      isAssignment = decision ? !!(intakeRoute && intakeRoute.action !== 'none')
        : (() => { try { return require('./lib/operator').isDirectedTask(userMessage); } catch { return false; } })();
      if (isAssignment) console.log(`[intake] ASSIGNMENT → ${intakeRoute ? intakeRoute.action : 'discover(regex-fallback)'}${intakeRoute && intakeRoute.deep ? ' deep' : ''}${intakeRoute && intakeRoute.priority ? ' ' + intakeRoute.priority : ''}`);
    }
  } catch (e) { console.error('[intake] gate failed:', e.message); }

  // INTERFACE POLL (Slice I) — the interface polls the brain through ONE deterministic router instead of
  // answering from its own (lossy) memory. Sources register here; the router picks who answers, preferring
  // deterministic (program-grounded) sources. Two registered today:
  //   • research-deliverable — count/list/sample/facet/status off the Track's index+document, ACTIVE or
  //     COMPLETE (fixes the post-completion "around 15" confab + the live-research disconnect).
  //   • current-activity — "what are you doing/working on/watching" answered from the live lane snapshot.
  // Lanes (media/meeting/news) register more sources here as they land — no new branch in the pipeline.
  let statusHandled = false;
  try {
    if (!directedStopHandled && !expandHandled && !followupFired && !isAssignment) {
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
            const out = await condenseComplete(msgs, { numPredict: 700 });
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
    if (opMode !== 'off' && (needsExternal || isAssignment) && !socialTurn && !followupFired && !directedStopHandled && !expandHandled && !clarificationCaptured && !statusHandled && userMessage && userMessage.trim().length > 6) {
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
    if (opModeOn && (intakeSaysProject || regexFallback) && !socialTurn && !followupFired && !directedStopHandled && !expandHandled && !clarificationCaptured && !statusHandled) {
      const already = (() => { try { const f = focusLib.getCurrent(); return !!(f && focusLib.isDirected(f)); } catch { return false; } })();
      if (!already) {
        const clarTail = (intakeRoute && intakeRoute.clarify && intakeRoute.clarify.length)
          ? ` You've STARTED already; you may ALSO ask this one clarifying question to sharpen it (without implying you haven't begun): "${intakeRoute.clarify[0]}"` : '';
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
              if (er && er.focus) { kickDirectedFocusDriver(); created = { id: er.focus.id, kind: `${intakeRoute.deep ? 'deep ' : ''}enrich of ${er.orgs.length} org(s) for ${facet}` }; }
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
            kickDirectedFocusDriver();
            created = { id: r.focus.id, kind: `${intakeRoute && intakeRoute.deep ? 'deep ' : ''}research run` };
          }
        }

        if (created) {
          composedUserMessage += `\n\n[You have ACCEPTED this as a standing task and STARTED working it for real — it is now your active focus (a ${created.kind}) and you will keep working it slice by slice (saving what you find) until it's done or ${userName} tells you to stop. Tell him plainly you've started and are on it, in one or two sentences, in your own voice.${clarTail} ${honesty}]`;
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
    echoSuitBlock: echoSuit ? echoSuit.suitContextBlock() : null,
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
      // CONSTANT num_ctx — every local Dans call (voice/byline/narrative/dialogue/play) uses 8192, so
      // the reply MUST too. The old `bigReply ? 16384 : 8192` flipped the context size between turns,
      // and ollama fixes num_ctx at load time → each flip cold-reloaded the 24B (the 23–38s VRAM
      // 20→0→20 churn). Long deliverables now live in the dossier file, not the chat reply, so 8192
      // is plenty here. One context size ⇒ Dans loads once and stays warm (keep_alive 24h).
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
        await streamChat({ model: MODEL, messages, onToken: (chunk) => parser.feed(chunk), inactivityMs: 180000, options: { num_ctx: 8192 } });
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
  if ((!say || !say.trim()) && !_hasToolTag && !pulledFromThought) {
    try {
      const gist = thought ? thought.replace(/\s+/g, ' ').trim().slice(-360) : '';
      const nudge = gist
        ? `[Your reply came out blank — you thought it through but never actually spoke. You were thinking: "${gist}". Now say it to ${userName || 'Lucas'} out loud — briefly, 1–4 sentences, in your own voice. Don't think first; go straight to a <say>…</say>.]`
        : `[Your reply came out blank — you didn't actually say anything. Respond to ${userName || 'Lucas'} now, briefly (1–4 sentences), in your own voice. Don't think first; go straight to a <say>…</say>.]`;
      const retryParser = new TagStreamParser({ onSayToken: (t) => { try { emit(t); } catch {} } });
      await streamChat({
        model: MODEL,
        messages: messages.concat([{ role: 'user', content: nudge }]),
        options: { num_predict: 240 },
        onToken: (c) => retryParser.feed(c)
      });
      const r = retryParser.finalize();
      if (r.say && r.say.trim()) { say = r.say; truncated = r.truncated; if (r.thought) thought = thought ? `${thought}\n${r.thought}` : r.thought; }
      else console.log('[main] empty-say retry still produced no say');
    } catch (e) { console.error('[main] empty-say retry failed:', e.message); }
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
      for (const t of webTagsToRun.slice(0, 4)) {
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
            const body = await readHerBrowserDeep();
            if (body) {
              const content = `I looked up "${qLabel}" in my own browser (${r.url}):\n${body}`;
              try { db.insertMonologue({ content, model: 'web-read', type: 'reading', query: r.url, urls: [r.url] }); } catch {}
              try { require('./lib/learning').maybeCaptureLearnings({ query: qLabel, content, urls: [r.url] }); } catch {}
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
  return runChatTurn(userMessage, attachments, {
    emit: (t) => { try { event.sender.send('chat:say-token', t); } catch {} },
    onComplete: (info) => { try { event.sender.send('chat:complete', info); } catch {} },
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
async function fireToolFollowup({ io, channel, sessionId, resultText, echoHop = 0 }) {
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
        const saidRow = db.insertTurn({ sessionId, speaker: 'ai_said', content: sayOut, model: MODEL, unprompted: 1 });
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
        await fireToolFollowup({ io, channel, sessionId, resultText: content + (r.isError ? '\n[That call errored — fix the args or pick another tool with <echo-find>.]' : ''), echoHop: echoHop + 1 });
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
async function readHerBrowserDeep() {
  let body = '';
  try {
    const r = await webLib.read();
    if (r && r.ok && r.text) body = r.text.replace(/\n{3,}/g, '\n\n').slice(0, 1200);
  } catch {}
  try {
    const top = await webLib.openTopResult();
    if (top && top.ok) {
      const pr = await webLib.read();
      if (pr && pr.ok && pr.text) body += `\n\nTop result (${top.title || top.url}):\n` + pr.text.replace(/\n{3,}/g, '\n\n').slice(0, 2000);
    }
  } catch {}
  return body;
}

// Do a complete live lookup for `query` and answer Lucas in chat via one tool-followup.
// Idle is paused around the lookup so the monologue can't grab the shared browser mid-search.
async function liveLookupAndAnswer({ io, channel, sessionId, userName, query }) {
  try { pauseMonologue(); pauseHeartbeat(); } catch {}
  let content = '';
  const urls = [];
  try {
    const opened = await webLib.open(query).catch(() => ({ ok: false }));
    if (opened && opened.ok) {
      if (opened.url) urls.push(opened.url);
      const body = await readHerBrowserDeep();
      if (body) content = `I looked up "${query}" just now in my own browser. What I found:\n${body}`;
    }
    // Fallback: Echo's web_search if her browser couldn't read anything.
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
    try { require('./lib/learning').maybeCaptureLearnings({ query, content, urls }); } catch {}
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
    try { const o = await webLib.open(String(query || '')); if (o && o.ok) { const body = await readHerBrowserDeep(); return body || `(opened ${o.url} but no readable text)`; } return 'search did not open a page'; }
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
      numPredict: task ? 3000 : undefined,   // a list/write-up can be long — don't truncate it at generation
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
    const condensed = as.stitchDocument({ goal, completed: reason, sections, summary: wrapper.summary, gaps: wrapper.gaps, indexedMissing: rec.indexedMissing });
    const dossierPath = `notes/directed-${focus.id}-dossier.md`;
    try { await filesLib.dispatch({ tag: 'file-write', attrs: { path: dossierPath }, body: condensed }); }
    catch (e) { console.error('[condense] dossier write failed:', e.message); }
    try { await memoryLib.store({ kind: 'note', content: `Research dossier — ${goal.slice(0, 90)} (${sections.length} orgs):\n${condensed.slice(0, 4000)}`, source: 'research_dossier', importance: 0.85, embedText: goal }); } catch {}
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

  const runPass = async (prompt) => {
    try {
      const r = await runCloudOperator({ userMessage: prompt, context: '', task: true, autonomous: true });
      return { ans: (r && r.answer ? String(r.answer).trim() : ''), usedTool: !!(r && Array.isArray(r.toolsUsed) && r.toolsUsed.some(t => ['web_search', 'browser_read', 'echo'].includes(t))) };
    } catch (e) { return { ans: '', usedTool: false }; }
  };

  let progressed = false, done = false, note = '', sig = '';

  if (!target || !target.name) {
    // OPEN A NEW TARGET — overview pass.
    const { ans, usedTool } = await runPass(rs.buildNewTargetPrompt({ goal, covered, guidance }));
    const p = rs.parsePass(ans);
    if (p.allCovered && covered.length) { done = true; note = `all organizations covered (${covered.length})`; }
    else if (p.target && !covered.some(c => String(c).toLowerCase() === p.target.toLowerCase())) {
      target = { name: p.target, passes: 1, raw: p.body || ans, facets: ['overview'] };
      try { db.setMeta(targetKey, JSON.stringify(target)); } catch {}
      progressed = !!(p.body && usedTool); sig = p.target.toLowerCase(); note = `started ${p.target}`;
    } else { note = p.target ? `(repeat target) ${p.target}` : 'no new target found'; sig = String(p.target || '').toLowerCase(); }
  } else {
    // DEEPEN the current target — next missing facet.
    const { ans, usedTool } = await runPass(rs.buildDeepenPrompt({ goal, target: target.name, facets: target.facets, guidance }));
    const p = rs.parsePass(ans);
    const newChars = rs.newContentChars(target.raw, p.body);
    target.passes = (target.passes || 1) + 1;
    if (p.body) target.raw = `${target.raw}\n\n${p.body}`.slice(-16000);
    if (p.facet) target.facets = (target.facets || []).concat(p.facet).slice(-12);
    const adv = rs.decideAdvance({ passes: target.passes, newChars, saturated: p.saturated });
    if (adv.advance) {
      // CLOUD ORGANIZE this target → one clean section, appended to the deliverable NOW (continuous).
      let section = '';
      try { section = await condenseComplete(rs.buildOrganizeTargetPrompt({ target: target.name, raw: target.raw }), { numPredict: 1500 }); } catch {}
      section = (section && section.trim()) ? section.trim() : `## ${target.name}\n${target.raw.slice(0, 1500)}`;
      const header = covered.length === 0 ? `# Directed research deliverable\n\n**Task:** ${goal}\n\n---\n\n` : '';
      try { await filesLib.dispatch({ tag: 'file-append', attrs: { path: file }, body: `${header}${section}\n\n` }); }
      catch (e) { console.error('[directed] append failed:', e.message); }
      // DRIVE → Zoe's canvas: mirror the organized section as a live per-org block as the run advances.
      try { const blk = require('./studio/canvas_emit').orgSectionBlock(section); await canvasEmit({ focusId: focus.id, title: goal, tabMode: 'RESEARCH', blockType: blk.blockType, data: blk.data }); } catch {}
      covered.push(target.name); try { db.setMeta(coveredKey, JSON.stringify(covered.slice(-300))); } catch {}
      note = `completed ${target.name} (${target.passes} passes, ${adv.reason}) + organized`; sig = target.name.toLowerCase(); progressed = true;
      target = null; try { db.setMeta(targetKey, ''); } catch {}
    } else {
      try { db.setMeta(targetKey, JSON.stringify(target)); } catch {}
      progressed = newChars >= 120 && usedTool; sig = `${target.name}#${target.passes}`.toLowerCase();
      note = `deepening ${target.name}: +${p.facet || 'detail'} (${newChars} new chars)`;
    }
  }

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

// TWO-LANE DEEP RESEARCH for ONE target: the WEB lane (her browser + Echo web tools, on the fast model)
// and the DEEP lane (structured DBs + our knowledge graph, on the 120B reasoner) run CONCURRENTLY, then
// a merge pass folds both raw streams into one section. This is the multi-cloud win — each lane runs the
// model that fits its work, in parallel. Fail-safe: a lane that dies → '' for that side; the merge still
// runs on whatever came back. Returns { section, webRaw, deepRaw, lanes }.
async function runDeepResearchTarget({ org, goal = '', facet = '', guidance = '' }) {
  const rs = require('./lib/research');
  const tier = require('./lib/echo_tier');
  const operatorMod = require('./lib/operator');
  const fastModel = (() => { try { return operatorMod.operatorModel(); } catch { return 'gemma4:31b'; } })();
  const deepModel = (() => { try { return require('./lib/config').subconsciousModel() || 'gpt-oss:120b'; } catch { return 'gpt-oss:120b'; } })();
  const tail = operatorMod.TOOL_SPEC_TAIL || '';
  const webSpec = ['TOOLS (call exactly ONE per step):',
    '- web_search {"query":"…"}      search the open web + read the top result',
    '- open_page {"url":"…"}         open a SPECIFIC page in her browser and read it fully (go to the org\'s /team, /leadership, /about, /contact)',
    '- browser_read {}               read the page currently open in her browser',
    tier.laneSpec('web'),
    '- echo {"need":"…"}             open-web / reference lookups (read-only)',
    '- recall {"query":"…"}          her own memory', '', tail].join('\n');
  const deepSpec = ['TOOLS (call exactly ONE per step):',
    tier.laneSpec('deep'),
    '- echo {"need":"…"}             OUR private data + the 500+ structured research tools — say the need in plain words',
    '- recall {"query":"…"}          her own memory', '', tail].join('\n');

  const [web, deep] = await Promise.all([
    runCloudOperator({ userMessage: rs.buildWebLanePrompt({ goal, org, facet, guidance }), context: '', task: true, autonomous: true, toolNames: tier.laneToolNames('web'), model: fastModel, toolSpec: webSpec }).catch(() => null),
    runCloudOperator({ userMessage: rs.buildDeepLanePrompt({ goal, org, facet, guidance }), context: '', task: true, autonomous: true, toolNames: tier.laneToolNames('deep'), model: deepModel, toolSpec: deepSpec }).catch(() => null)
  ]);
  const webRaw = (web && web.answer) ? String(web.answer).trim() : '';
  const deepRaw = (deep && deep.answer) ? String(deep.answer).trim() : '';
  let section = '';
  try { section = await condenseComplete(rs.buildMergeLanesPrompt({ org, facet, webRaw, deepRaw }), { numPredict: 1300 }); } catch {}
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
    // Build this org's section — two-lane (deep) or single-pass (default).
    let section = '', laneNote = '';
    if (deepMode) {
      const dr = await runDeepResearchTarget({ org, goal, facet, guidance });
      section = dr.section; laneNote = ` [web:${dr.lanes.web ? '✓' : '–'} deep:${dr.lanes.deep ? '✓' : '–'}]`;
    } else {
      // ONE focused pass: fill ONLY the named facet for THIS org.
      let ans = '';
      try {
        const r = await runCloudOperator({ userMessage: rs.buildEnrichPrompt({ goal, org, facet, guidance }), context: '', task: true, autonomous: true });
        ans = (r && r.answer) ? String(r.answer).trim() : '';
      } catch (e) { console.error('[enrich] pass failed:', e.message); }
      const p = rs.parsePass(ans);
      // ORGANIZE this org's facet findings → one clean section, appended NOW (continuous, like discovery).
      try { section = await condenseComplete(rs.buildOrganizeEnrichPrompt({ org, facet, raw: p.body || ans }), { numPredict: 1100 }); } catch {}
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
  console.log(`[enrich] established #${fid} over #${sourceFocusId} — ${orgs.length} orgs, facet: ${facet.slice(0, 60)}${deep ? ' [DEEP]' : ''}${priority ? ' [' + priority + ']' : ''}`);
  return { focus: r.focus, orgs };
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
      fireToolFollowup({ io, channel, sessionId: currentSessionId, resultText: `[You just finished the action "${res.name}" — it completed successfully. Tell ${userName} briefly what you did, in your own voice.]` });
    } else if (res.status === 'aborted') {
      fireToolFollowup({ io, channel, sessionId: currentSessionId, resultText: `[The action "${res.name}" got stuck and was stopped after several tries. Tell ${userName} plainly that you couldn't finish it — do not pretend it worked.]` });
    }
  } catch (err) {
    console.error('[action] runActionStep failed:', err.message);
    actionLoop.abort();
  }
}
