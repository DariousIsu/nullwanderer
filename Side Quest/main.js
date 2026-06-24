const path = require('path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

const db = require('./lib/db');
const editorRegistry = require('./lib/editor_registry');   // Editor Studio: document registry + lifecycle
const editorImport = require('./lib/editor_import');         // Editor Studio: normalize-on-import
const { streamChat, TagStreamParser } = require('./lib/ollama');
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
const { detectHardPull, pickBusyLine } = require('./lib/snapback');
const {
  startHeartbeatScheduler,
  stopHeartbeatScheduler,
  pause: pauseHeartbeat,
  resume: resumeHeartbeat,
  markUserActivity: markHeartbeatActivity
} = require('./lib/heartbeat');
const { extractCommitments } = require('./lib/commitments');
const { fetchPage } = require('./lib/web_search');
const echoSuitLib = require('./lib/echo_suit');
const { EngineSupervisor } = require('./lib/engine');   // Zoe OWNS the absorbed engine (adopt-or-spawn)
const recallLib = require('./lib/recall');   // <recall ref="rID"/> — expand a memory marker on demand
let echoSuit = null;   // Echo "suit" — the MCP tool surface Zoe wears; bound to the engine she owns
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

const MODEL = config.model();
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
  echoSuit = echoSuitLib.createSuit({ client: require('./lib/echo').fromEnv({ url: echoCfg.url, token: echoCfg.token }) });
  // Spawn path uses Echo's OWN venv interpreter by default (its deps aren't on bare `python`);
  // ECHO_PYTHON env still overrides. The adopt path doesn't touch this.
  const ECHO_PYTHON = process.env.ECHO_PYTHON || path.join(ECHO_CWD, '.venv', 'Scripts', 'python.exe');
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

  // Warm the single Dans-24B model at boot. One model now serves both chat and
  // the between-turn monologue. Mistral-3 arch unlocks KV-cache quantization
  // (set OLLAMA_FLASH_ATTENTION=1 + OLLAMA_KV_CACHE_TYPE=q8_0 in env), which keeps
  // 24B Q4 + 16K context comfortably inside the RX 7900 XT's ~18GB usable VRAM.
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
            if (candidate) {
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
    try { sendBusy(pickBusyLine(Date.now())); } catch {}
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
    if (webIntent) {
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
  const openThreads = socialTurn ? [] : db.getActiveOpenThreads(3);
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
  // ECHO NUDGE (F1) — when Lucas explicitly invokes the suit / our data ("use the db", "the power
  // suit", "our records/KB/graph", "echo"), bind that to the echo tags right at the message tail
  // (highest recency) so she reaches for Echo instead of defaulting to her web browser (the LAMP →
  // Japanese-band miss). Only when the suit is actually connected.
  if (echoSuit && echoSuit.connected && ECHO_INVOKE_RE.test(userMessage)) {
    composedUserMessage = `${composedUserMessage}\n\n[You are wearing the Echo suit and ${userName} is asking you to use it / OUR data — not the open web. Do this with your echo tags: <echo-find>what you need</echo-find> then <echo-do name="tool">{json}</echo-do> (or directly if you know the tool). Echo is our knowledge base / entity graph / contacts / bills / the LAMP network. Do NOT use <web-open> for this — that's the open internet, the wrong tool for our data.]`;
  }

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
  try {
    const rk = qClass === 'narrow'
      ? await memoryLib.retrieve(userMessage, { k: 3, preferLeaf: true })   // entity-exact, leaf-first
      : await memoryLib.retrieveScored(userMessage, { k: 6 });             // open, high-signal, wider
    retrievedKnowledgeBlock = memoryLib.formatForPrompt(rk, userName);
  } catch (err) { console.error('[main] knowledge retrieve failed:', err.message); }

  // SELF-MODEL block — query-relevant self entries (so a question about a specific
  // taste/preference surfaces THAT entry, e.g. "favorite flower" → her ranunculus)
  // plus her always-on core self. Async (embeds the query).
  let selfModelBlock = null;
  try { selfModelBlock = await require('./lib/self_model').buildContextBlock(userMessage); }
  catch (e) { console.error('[main] self-model block failed:', e.message); }

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

  // OPEN-QUESTION SURFACING (conversation harness, Piece 1) — if she asked Lucas something on
  // a prior turn, his message is very likely the answer. Surface it (exactly once) as
  // high-recency state so a terse reply binds to her question instead of floating free;
  // takePending resolves it in the same breath so it doesn't nag next turn.
  let openQuestionBlock = null;
  try {
    const pend = require('./lib/open_questions').takePending(sessionId, userTurnRow && userTurnRow.id);
    openQuestionBlock = require('./lib/open_questions').buildBlock(pend, userName);
  } catch (e) { console.error('[main] open-question surface failed:', e.message); }

  // SCOPED CONTEXT — relevance-gate the recency blocks (recent monologue + readings) against
  // the message so off-topic between-turn musing can't ride along. Runs when the TASK should
  // own the turn: a NARROW factual question OR an ACTIONABLE turn (a URL/file/imperative —
  // classifyQuery defaults to 'broad' and misses these, which is exactly how idle water-shortage
  // rumination bled into reading a shared spreadsheet). On a genuinely open/social turn we keep
  // them raw — that's her continuous-mind texture, and there's no task to corrupt. This is the
  // structural fix that replaces the earlier prompt-level "treat these as idle musing" reframe.
  if ((qClass === 'narrow' || isActionable(userMessage)) && userQv) {
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

  const messages = buildChatPrompt({
    userName,
    recentReflections,
    recentTurns,
    recentMonologue,
    recentReadings,
    heldCommitments,
    openThreads,
    awareness,
    protocols,
    browserBlock,
    pendingInbounds,
    retrievedKnowledgeBlock,
    capabilityProposalBlock,
    selfModelBlock,
    personalBlock,
    relevantPastTurns,
    openQuestionBlock,
    socialTurn,
    convoStateBlock,
    varietyNudge,
    echoSuitBlock: echoSuit ? echoSuit.suitContextBlock() : null,
    newUserMessage: composedUserMessage
  });

  const parser = new TagStreamParser({
    onSayToken: (token) => {
      try {
        emit(token);
      } catch {}
    }
  });

  try {
    await streamChat({
      model: MODEL,
      messages,
      onToken: (chunk) => parser.feed(chunk)
    });
  } catch (err) {
    console.error('[main] streamChat failed:', err);
    try { sendError(err.message || String(err)); } catch {}
    resumeMonologue();
    resumeHeartbeat();
    resumeContinuity();
    resumeReflection();
    selfDialogue.resume();
    return { ok: false, error: err.message, say: null };
  }

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
          } else if (r && r.ok && t.tag === 'web-open') {
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `[You opened ${r.url} in your own browser. Emit <web-read/> to see it, then tell ${userName} what you find — don't describe the page until you've read it.]` }); }
          } else if (r && r.ok && t.tag === 'web-chat' && r.text) {
            const who = r.speaker || 'the character';
            const content = `In my own browser I sent a line to ${who}, and they replied:\n${r.text}`;
            const row = db.insertMonologue({ content, model: 'web-chat', type: 'reading', query: r.url, urls: r.url ? [r.url] : null });
            try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(${who} replied) ${(r.text || '').slice(0, 80)}`, type: 'reading', query: r.url }); } catch {}
            if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: `[${who} replied to you:\n${r.text}\n\nThat's the actual reply — react to it in your own voice.]` }); }
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
          if (result && result.ok && (t.tag === 'file-read') && result.text != null) {
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
    (async () => {
      try {
        const r = await screenLib.dispatch();
        if (r && r.ok) {
          const row = db.insertMonologue({ content: r.text, model: 'screen-observe', type: 'reading' });
          try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(observed screen — focused: ${r.foreground || '?'})`, type: 'reading' }); } catch {}
          if (!followupFired) { followupFired = true; fireToolFollowup({ io, channel, sessionId, resultText: r.text }); }
        }
        console.log(`[main] screen observe: ${r?.ok ? 'ok (' + (r.windows||[]).length + ' windows)' : 'FAIL ' + r?.reason}`);
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
    const parser = new TagStreamParser({ onSayToken: (t) => { try { emit(t); } catch {} } });
    await streamChat({ model: MODEL, messages, onToken: (c) => parser.feed(c) });
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
    // Deliver her words (the visible step — "I'll run db_query…" or the final answer). May be
    // empty when she emitted only a tag — that's fine; the Echo chain below still runs.
    if (sayOut) {
      const followupDisclaimed = voice.isSelfDisclaimer(sayOut);
      if (followupDisclaimed) { try { sayOut = (await voice.deDisclaim(sayOut)) || ''; } catch (e) { console.error('[main] followup voice guard failed:', e.message); } }
      if (sayOut) {
        const thoughtClean = (thought || '').replace(/<\/?(think|say)>/gi, '').trim();
        if (thoughtClean) db.insertTurn({ sessionId, speaker: 'ai_thought', content: thoughtClean, model: MODEL });
        const saidRow = db.insertTurn({ sessionId, speaker: 'ai_said', content: sayOut, model: MODEL });
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
