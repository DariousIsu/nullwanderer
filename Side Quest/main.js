const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const db = require('./lib/db');
const { streamChat, TagStreamParser } = require('./lib/ollama');
const { buildChatPrompt, buildAwarenessBlock } = require('./lib/context');
const {
  startReflectionScheduler,
  stopReflectionScheduler,
  markUserActivity,
  forceReflectionIfDue
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
const {
  startContinuityScheduler,
  stopContinuityScheduler,
  pause: pauseContinuity,
  resume: resumeContinuity,
  markUserActivity: markContinuityActivity
} = require('./lib/continuity');
const selfDialogue = require('./lib/self_dialogue');

const MODEL = 'hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M';
const RECENT_TURN_LIMIT = 8;
const RECENT_REFLECTION_LIMIT = 5;
const DISPLAY_HISTORY_LIMIT = 50;

let mainWindow = null;
let currentSessionId = null;
let currentSessionStartedAt = null;

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
  db.init();
  filesLib.ensureWorkspace();
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
  }).then(() => console.log('[main] Dans-24B warmed at 8192 ctx'))
    .catch(err => console.error('[main] Dans warmup failed:', err.message));
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
  stopMonologueScheduler();
  stopHeartbeatScheduler();
  stopContinuityScheduler();
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

ipcMain.handle('chat:send', async (event, userMessage, attachments = []) => {
  if (!userMessage || !userMessage.trim()) return { ok: false, error: 'empty' };

  markUserActivity();
  markMonologueActivity();
  markHeartbeatActivity();
  markContinuityActivity();
  pauseMonologue();
  pauseHeartbeat();
  pauseContinuity();
  selfDialogue.pause();

  const sessionId = currentSessionId;
  const userTurnRow = db.insertTurn({ sessionId, speaker: 'user', content: userMessage });

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
          event.sender.send('chat:say-token', ch);
        }
        event.sender.send('chat:complete', { saidId: saidRow.id, truncated: 0, protocolInvoked: triggerMatch.protocol.id });
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
      selfDialogue.resume();

      console.log(`[main] PROTOCOL INTERCEPTED: ${triggerMatch.protocol.trigger_phrase} → ${triggerMatch.action} (${triggerMatch.matchType})`);
      return { ok: true, intercepted: true, protocolId: triggerMatch.protocol.id };
    }
  }
  // === END INTERCEPTOR ===

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

  const userName = db.getMeta('user_name') || 'them';
  const recentReflections = db.getRecentReflections(RECENT_REFLECTION_LIMIT);
  const recentMonologue = db.getRecentMonologueByType('thought', 5);
  const recentReadings = db.getRecentMonologueByType('reading', 2);
  const heldCommitments = db.getHeldCommitments(8);
  const openThreads = db.getActiveOpenThreads(5);
  const protocols = db.getActiveProtocols();
  const pendingInbounds = db.getPendingInbounds(6);

  // If the user mentioned a URL or known tab title, update the tab-mention state
  // so Eloise can resolve tab="last" correctly
  try { browserLib.noteMention(userMessage); } catch {}
  // Tools block injected into her prompt: files + screen (always available) + browser (when connected)
  const fileBlock = filesLib.buildPromptBlock();
  const screenBlock = screenLib.buildPromptBlock();
  const browserConnBlock = browserLib.isConnected() ? browserLib.buildPromptBlock() : null;
  const browserBlock = [fileBlock, screenBlock, browserConnBlock].filter(Boolean).join('\n\n') || null;
  // Pull any attachment content the renderer sent up with this turn (text/md/json)
  const attachmentText = (Array.isArray(attachments) ? attachments : [])
    .map(a => `${userName || 'Lucas'} attached "${a.name || 'file'}":\n${(a.text || '').slice(0, 6000)}`)
    .join('\n\n---\n\n');
  // Pull recent turns BEFORE the just-inserted user turn; the new message is appended separately
  const recentTurnsAll = db.getRecentTurns(RECENT_TURN_LIMIT + 1);
  const recentTurns = recentTurnsAll.slice(0, -1); // drop the freshly-inserted user turn

  // If the user shared links or attached files, surface them prominently in the message
  let composedUserMessage = userMessage;
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
    newUserMessage: composedUserMessage
  });

  // Mark these inbounds consumed — they're now in Stheno's context. If she doesn't
  // act on them, that's her call; we don't keep re-injecting forever.
  if (pendingInbounds && pendingInbounds.length > 0) {
    for (const i of pendingInbounds) {
      try { db.markInboundConsumed(i.id); } catch {}
    }
  }

  const parser = new TagStreamParser({
    onSayToken: (token) => {
      try {
        event.sender.send('chat:say-token', token);
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
    try { event.sender.send('chat:error', err.message || String(err)); } catch {}
    return { ok: false, error: err.message };
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
  const fileTagsToRun = [
    ...filesLib.parseTags(thought || ''),
    ...filesLib.parseTags(say || '')
  ];
  const screenTagsToRun = [
    ...screenLib.parseTags(thought || ''),
    ...screenLib.parseTags(say || '')
  ];

  let thoughtStripped = (thought || '').replace(/<wonder>[\s\S]*?<\/wonder>/gi, '').trim();
  thoughtStripped = openThreadsLib.stripStatusTags(thoughtStripped);
  thoughtStripped = browserLib.stripTags(thoughtStripped);
  thoughtStripped = filesLib.stripTags(thoughtStripped);
  thoughtStripped = screenLib.stripTags(thoughtStripped);

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
  // Strip any file tags that leaked into say
  sayStripped = filesLib.stripTags(sayStripped);
  // Strip any screen-observe tags that leaked into say
  sayStripped = screenLib.stripTags(sayStripped);
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
    event.sender.send('chat:complete', { saidId: saidRow.id, truncated });
  } catch {}

  db.setMeta('last_ai_utterance_at', String(Date.now()));
  resumeMonologue();
  resumeHeartbeat();
  resumeContinuity();
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
          } else if (result && result.ok && t.tag === 'file-list') {
            const listing = (result.entries || []).map(e => `${e.type === 'dir' ? '[dir] ' : ''}${e.name}`).join(', ');
            const row = db.insertMonologue({
              content: `Files in ${result.path}: ${listing || '(empty)'}`,
              model: 'file-list', type: 'reading', query: result.path
            });
            try { mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monologue:tick', { id: row.id, ts: row.ts, content: `(listed) ${result.path}`, type: 'reading', query: result.path }); } catch {}
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
        }
        console.log(`[main] screen observe: ${r?.ok ? 'ok (' + (r.windows||[]).length + ' windows)' : 'FAIL ' + r?.reason}`);
      } catch (err) { console.error('[main] screen dispatch error:', err.message); }
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
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('open_threads:added', stored);
        }
      } catch {}
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
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('protocols:added', stored);
        }
      } catch {}
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
    if (stored.length > 0) {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('commitments:added', stored);
        }
      } catch {}
    }
  }).catch(err => console.error('[main] commitment extraction failed:', err.message));

  return { ok: true };
});
