const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const db = require('./lib/db');
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
  markUserActivity: markMonologueActivity
} = require('./lib/monologue');
const {
  startHeartbeatScheduler,
  stopHeartbeatScheduler,
  pause: pauseHeartbeat,
  resume: resumeHeartbeat,
  markUserActivity: markHeartbeatActivity
} = require('./lib/heartbeat');
const { extractCommitments } = require('./lib/commitments');
const { fetchPage } = require('./lib/web_search');
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
const RECENT_TURN_LIMIT = 8;
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
    title: 'Side Quest',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  config.loadEnv();
  db.init();
  // Curator: deterministic hygiene at session start — age long-stalled threads to
  // 'abandoned' so they stop resurfacing in the idle loop. Never deletes.
  try { curatorLib.curateThreads(); curatorLib.curateGaps(); } catch (e) { console.error('[main] curator failed:', e.message); }
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
            memoryLib.store({ kind: 'reference', content: `Email I received — from ${m.from}, subject "${m.subject}": ${(m.snippet || '').slice(0, 300)}`, source: 'inbox', importance: 0.55 }).catch(() => {});
          }
          const merged = [...surfaced, ...r.messages.map(m => m.uid)].slice(-300);
          db.setMeta('inbox_surfaced_uids', JSON.stringify(merged));
          const newest = r.messages[r.messages.length - 1];
          if (newest && newest.fromAddr) {
            db.setMeta('last_inbound_from', newest.fromAddr);
            db.setMeta('last_inbound_subject', newest.subject || '');
            db.setMeta('last_inbound_snippet', (newest.snippet || '').slice(0, 300));
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
        //  - sender must be a real person (skip no-reply / bulk / list senders);
        //  - NEVER her own address — replying to self creates an infinite loop
        //    (each self-reply lands as new unread → another reply → cascade);
        //  - she must have ALREADY emailed this address (thread continuation only —
        //    never a cold reply to an unknown sender).
        if (!actionLoop.isActive()) {
          const replied = JSON.parse(db.getMeta('auto_replied_uids') || '[]');
          const self = (config.emailConfig().user || '').toLowerCase();
          const rr = await inboxLib.pollUnread(replied, 6);
          if (rr.ok && rr.messages && rr.messages.length) {
            const NOREPLY = /(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|notification|notifications|bounce|newsletter|mailing|@.*\.(list|lists)\.)/i;
            const candidate = [...rr.messages].reverse().find(m =>
              m.fromAddr && m.fromAddr.toLowerCase() !== self
              && !NOREPLY.test(m.fromAddr) && db.hasEmailedAddress(m.fromAddr));
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

const { detectWebIntent } = require('./lib/intent');
const preferences = require('./lib/preferences');
const personal = require('./lib/personal');
const playSession = require('./lib/play_session');

// Core chat turn — shared by the IPC handler (renderer) and the Discord bridge.
// io.emit(token) streams say-tokens; io.onComplete/onError fire UI events. For
// headless callers (Discord) these default to no-ops and the final say is
// returned in { ok, say } so the caller can deliver it however it likes.
async function runChatTurn(userMessage, attachments = [], io = {}) {
  if (!userMessage || !userMessage.trim()) return { ok: false, error: 'empty', say: null };
  const emit = io.emit || (() => {});
  const sendComplete = io.onComplete || (() => {});
  const sendError = io.onError || (() => {});
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

  const sessionId = currentSessionId;
  const userTurnRow = db.insertTurn({ sessionId, speaker: 'user', content: userMessage });
  // Blackboard: a user message is the StuckDetector's reset boundary — events
  // after it start a fresh "interactive slice" so a new instruction is never read
  // as part of a prior spiral.
  try { blackboard.markUser(userMessage, userTurnRow && userTurnRow.id); } catch (e) { console.error('[main] blackboard.markUser failed:', e.message); }

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
  } catch (err) { console.error('[web-intent] interceptor failed:', err.message); }
  // === END WEB-INTENT ===

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
  for (const url of sharedUrls) {
    try {
      const page = await fetchPage(url, { maxChars: 2800, timeoutMs: 8000 });
      if (page.ok && page.text) sharedPages.push(page);
    } catch (err) { console.error('[main] user url fetch failed:', url, err.message); }
  }

  // Persist any shared-link content as a reading-type monologue row tagged as user-shared
  for (const p of sharedPages) {
    db.insertMonologue({
      content: `${userName || 'Lucas'} shared this link: ${p.title || p.url}\n${p.text}`,
      model: 'user-shared',
      type: 'reading',
      query: p.url,
      urls: [p.url]
    });
  }

  const recentReflections = db.getRecentReflections(RECENT_REFLECTION_LIMIT);
  const recentMonologue = db.getRecentMonologueByType('thought', 5);
  const recentReadings = db.getRecentMonologueByType('reading', 2);
  const heldCommitments = db.getHeldCommitments(8);
  const openThreads = db.getActiveOpenThreads(3);
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

  // If the user shared links or attached files, surface them prominently in the message
  let composedUserMessage = userMessage;
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

  const chosenName = db.getMeta('chosen_name');
  const awareness = buildAwarenessBlock({
    chosenName,
    sessionStartedAt: currentSessionStartedAt,
    cumulativeMs: db.getCumulativeSessionTime()
  });

  // KNOWLEDGE RETRIEVAL (the RETRIEVED tail) — pull the few most relevant stored
  // notes/facts/trajectories for THIS message, by relevance not recency. Graceful:
  // empty on miss, so the gap-response reflex handles "I don't know" cleanly.
  let retrievedKnowledgeBlock = null;
  try {
    // Generative-Agents scored retrieval: recency × relevance × importance, so
    // high-signal notes/insights outrank stale or idle ones (not pure relevance).
    const rk = await memoryLib.retrieveScored(userMessage, { k: 4 });
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
  if (idleSinceLastTurn > RETURN_IDLE_MS) {
    try { capabilityProposalBlock = gapsLib.buildReturnProposalBlock(userName); } catch (e) { console.error('[main] gap proposal failed:', e.message); }
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

  const { thought, say, truncated } = parser.finalize();

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
  const browserTagsToRun = [
    ...browserLib.parseTags(thought || ''),
    ...browserLib.parseTags(say || '')
  ];
  const webTagsToRun = [
    ...webLib.parseTags(thought || ''),
    ...webLib.parseTags(say || '')
  ];
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
  const schedTagsToRun = [
    ...schedulerLib.parseTags(thought || ''),
    ...schedulerLib.parseTags(say || '')
  ];
  const presenceTagsToRun = [
    ...presenceLib.parseTags(thought || ''),
    ...presenceLib.parseTags(say || '')
  ];
  const emailTagsToRun = [
    ...emailLib.parseTags(thought || ''),
    ...emailLib.parseTags(say || '')
  ];
  const discordTagsToRun = [
    ...discordLib.parseTags(thought || ''),
    ...discordLib.parseTags(say || '')
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
  const trimmedSay = sayStripped;
  const isPlaceholder = /^[\s.()]*(empty|silence|nothing|none|n\/a|null|undefined)[\s.()]*$/i.test(trimmedSay);
  const finalSaid = (trimmedSay && !isPlaceholder) ? trimmedSay : '…';
  const saidRow = db.insertTurn({
    sessionId,
    speaker: 'ai_said',
    content: finalSaid,
    model: MODEL,
    truncated
  });

  try {
    sendComplete({ saidId: saidRow.id, truncated });
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
          if (r && r.ok && t.tag === 'web-read' && r.text) {
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
            memoryLib.store({ kind: 'reference', content: `Email I received from ${m.from} — subject "${m.subject}": ${(m.snippet || '').slice(0, 300)}`, source: 'inbox', importance: 0.5 }).catch(() => {});
          }
          const newest = (r.messages || [])[0];
          if (newest && newest.fromAddr) {
            db.setMeta('last_inbound_from', newest.fromAddr);
            db.setMeta('last_inbound_subject', newest.subject || '');
            db.setMeta('last_inbound_snippet', (newest.snippet || '').slice(0, 300));
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
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        actionLoop.start(actionLoop.emailReplyAction({
          to,
          subject: db.getMeta('last_inbound_subject') || '',
          snippet: db.getMeta('last_inbound_snippet') || ''
        }));
        console.log('[action] email-reply started → to', to);
        setTimeout(() => { runActionStep(io, 0).catch(() => {}); }, 1200);
      } else {
        console.log('[action] reply intent but no valid target address in last_inbound_from');
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
    onError: (e) => { try { event.sender.send('chat:error', e); } catch {} }
  });
});

// Auto-continuation: a chat-initiated tool (observe-screen / browse-read / file-read /
// file-list) returns its result AFTER the turn that emitted the tag — so without this,
// she emits the tag, says "checking…", and never voices the answer (the result just sits
// in next-turn context with nothing to trigger a next turn). This fires ONE follow-up
// generation with the result in hand so she answers naturally. Renderer: streams as a
// new message (like a heartbeat). Discord: DMs the reply back. No tool tags are dispatched
// in the follow-up (stripped) — no recursion.
async function fireToolFollowup({ io, channel, sessionId, resultText }) {
  try {
    const userName = db.getMeta('user_name') || 'them';
    const recentTurns = db.getRecentTurns(8);
    const awareness = buildAwarenessBlock({
      chosenName: db.getMeta('chosen_name'),
      sessionStartedAt: currentSessionStartedAt,
      cumulativeMs: db.getCumulativeSessionTime()
    });
    const protocols = db.getActiveProtocols();
    const note = `[A tool you just used returned the result below. Respond to ${userName} NOW, in your own voice, using it directly to answer what they asked. Do NOT emit any more tool tags — just talk to them.]\n\n${String(resultText || '').slice(0, 4000)}`;
    const messages = buildChatPrompt({
      userName, recentReflections: [], recentTurns, recentMonologue: [], recentReadings: [],
      heldCommitments: [], openThreads: [], awareness, protocols, browserBlock: null,
      pendingInbounds: [], newUserMessage: note
    });
    const emit = io && io.emit ? io.emit : (() => {});
    const parser = new TagStreamParser({ onSayToken: (t) => { try { emit(t); } catch {} } });
    await streamChat({ model: MODEL, messages, onToken: (c) => parser.feed(c) });
    const { thought, say } = parser.finalize();
    // Strip ALL tags from the follow-up output — it must not trigger more tool dispatch.
    let sayOut = (say || '')
      .replace(/<\/?(think|say)>/gi, '')
      .replace(/\*[^*\n]{1,200}\*/g, '')
      .replace(/[ \t]+/g, ' ')
      .trim();
    sayOut = screenLib.stripTags(filesLib.stripTags(browserLib.stripTags(sayOut)));
    sayOut = sayOut.replace(/<[^>]+>/g, '').trim();
    if (!sayOut) return;
    const thoughtClean = (thought || '').replace(/<\/?(think|say)>/gi, '').trim();
    if (thoughtClean) db.insertTurn({ sessionId, speaker: 'ai_thought', content: thoughtClean, model: MODEL });
    const saidRow = db.insertTurn({ sessionId, speaker: 'ai_said', content: sayOut, model: MODEL });
    db.setMeta('last_ai_utterance_at', String(Date.now()));
    if (channel === 'discord') {
      try { await discordLib.sendDM(sayOut); } catch (e) { console.error('[main] followup discord DM failed:', e.message); }
    } else {
      try { if (io && io.onComplete) io.onComplete({ saidId: saidRow.id, truncated: 0, unprompted: true }); } catch {}
    }
    console.log('[main] tool follow-up delivered via', channel);
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
