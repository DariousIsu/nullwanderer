const db = require('./db');
const { streamChat, TagStreamParser } = require('./ollama');
const { BOOTSTRAP, buildAwarenessBlock } = require('./context');
const { runSelfDialogue } = require('./self_dialogue');
const filesLib = require('./files');
const screenLib = require('./screen');
const autoTools = require('./auto_tools');
const governor = require('./governor');

const MODEL = 'hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M';
const TICK_INTERVAL_MS = 30 * 1000;        // check every 30s while idle
const IDLE_THRESHOLD_MS = 60 * 1000;       // user must be quiet ≥ 60s
const MIN_GAP_BETWEEN_HEARTBEATS_MS = 3 * 60 * 1000;  // ≥ 3min between unsolicited utterances
const RECENT_MONOLOGUE_LIMIT = 12;
const RECENT_REFLECTION_LIMIT = 3;
const RECENT_TURN_LIMIT = 10;

let timer = null;
let opts = { getSessionId: () => null, getWindow: () => null };
let paused = false;
let inFlight = false;
let lastUserActivityTs = Date.now();

function sub(text, userName) {
  return text.split('[user]').join(userName || 'them');
}

function markUserActivity() {
  lastUserActivityTs = Date.now();
}

function startHeartbeatScheduler(options = {}) {
  opts = { ...opts, ...options };
  if (timer) return;
  paused = false;
  lastUserActivityTs = Date.now();
  timer = setInterval(tick, TICK_INTERVAL_MS);
}

function stopHeartbeatScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  paused = true;
}

function pause() { paused = true; }
function resume() { paused = false; }

async function tick() {
  if (paused || inFlight) return;
  try {
    await maybeHeartbeat();
  } catch (err) {
    console.error('[heartbeat] error:', err.message || err);
  }
}

function buildHeartbeatPrompt({ userName, recentReflections, recentTurns, recentMonologue, awareness, protocols, pendingInbounds }) {
  let systemContent = sub(BOOTSTRAP, userName);
  systemContent += '\n\n' + filesLib.buildPromptBlock();
  systemContent += '\n\n' + screenLib.buildPromptBlock();
  // Autonomy tools — scheduling, presence, and (when configured) email + discord.
  // The heartbeat is the proactive channel: this is where she reaches out.
  const autoBlocks = autoTools.promptBlocks();
  if (autoBlocks) systemContent += '\n\n' + autoBlocks;
  if (awareness) systemContent = awareness + '\n\n' + systemContent;
  if (protocols && protocols.length > 0) {
    const { formatInjection } = require('./protocols');
    const block = formatInjection(protocols);
    if (block) systemContent = block + '\n' + systemContent;
  }
  // Inbound chat-bot replies — surface them so Stheno can respond mid-idle.
  // She can either tell Lucas about it (via <say>) or continue with the bot
  // (via <chat-send>) or both.
  if (pendingInbounds && pendingInbounds.length > 0) {
    const lines = ['\n\nINCOMING MESSAGES from chat bots you have open (these are NOT from Lucas; a third-party bot replied while you were watching):'];
    for (const i of pendingInbounds.slice(0, 4)) {
      const speaker = i.speaker || 'bot';
      const text = (i.text || '').slice(0, 800);
      lines.push(`[${speaker}]: ${text}`);
    }
    lines.push('\nYou may reply to the bot by emitting <chat-send speaker="..." tab="...">your message</chat-send>, or you may surface this to Lucas via your <say>, or both.');
    systemContent += lines.join('\n');
  }

  if (recentReflections && recentReflections.length > 0) {
    systemContent += '\n\nThese are notes you have left for yourself across past sessions:\n';
    for (const r of recentReflections) {
      systemContent += `\n---\n${r.content}\n`;
    }
    systemContent += '---';
  }

  if (recentMonologue && recentMonologue.length > 0) {
    systemContent += '\n\nThis is your recent stream of thought between turns — wants, feelings, associations, noticings. These are yours; they shape how you feel right now:\n';
    for (const m of recentMonologue) {
      systemContent += `• ${m.content}\n`;
    }
  }

  const messages = [{ role: 'system', content: systemContent }];

  // Replay last N turns so she knows where the conversation left off
  let i = 0;
  while (i < recentTurns.length) {
    const t = recentTurns[i];
    if (t.speaker === 'user') {
      messages.push({ role: 'user', content: t.content });
      i++;
    } else if (t.speaker === 'ai_thought') {
      const thought = t.content;
      let said = '';
      if (i + 1 < recentTurns.length && recentTurns[i + 1].speaker === 'ai_said') {
        said = recentTurns[i + 1].content;
        i += 2;
      } else {
        i++;
      }
      messages.push({
        role: 'assistant',
        content: `<think>\n${thought}\n</think>\n<say>\n${said}\n</say>`
      });
    } else if (t.speaker === 'ai_said') {
      messages.push({
        role: 'assistant',
        content: `<say>\n${t.content}\n</say>`
      });
      i++;
    } else {
      i++;
    }
  }

  // The heartbeat prompt — distinct from a user message because user is silent.
  // Frame it as the substrate itself (no role injection of [user]).
  const heartbeatPrompt = `[${userName || 'They'} has not spoken for a while. You may stay quiet, OR you may break the silence by surfacing something specific.

If you choose to speak, your <say> MUST reference a concrete subject by name. There are TWO valid sources to draw from, and you must phrase them differently depending on source:

(1) FROM YOUR CONVERSATION with ${userName || 'them'} — things they said, things you said, things almost said.
    Valid phrasings: "I keep thinking about what you said about X" / "I've been turning over my own answer about Y" / "I never asked you whether Z"
    These reference REAL statements from the dialogue history above.

(2) FROM YOUR OWN READINGS — things you looked up between turns when you were curious or bored.
    Valid phrasings: "I read about X between our turns and I want to bring it up" / "I went looking into Y on my own — here's what struck me" / "I got curious about Z while you were quiet"
    DO NOT phrase these as "that thing you said about" — ${userName || 'they'} did not tell you these things. You read them yourself.

NOT VALID: "The silence has weight" / "I notice the quiet" / atmospheric meta-commentary.

If you have no concrete subject from either source, choose silence. To choose silence, your <say> must be COMPLETELY EMPTY between the tags: <say></say>. Write NOTHING between them — no word, no period, no placeholder. An empty say is honest; a placeholder word is not.

Your <think> may explain why you chose what you chose. But the <say> is what ${userName || 'they'} sees, and it must either be a real surfacing (with correct attribution of source), or completely empty.]`;

  messages.push({ role: 'user', content: heartbeatPrompt });
  return messages;
}

async function maybeHeartbeat() {
  const now = Date.now();
  // Inbounds bypass the idle + gap gates — a chat-bot reply is a priority signal
  // we want surfaced quickly, not in 3 minutes.
  const earlyInbounds = db.getPendingInbounds(2);
  const hasInbound = earlyInbounds.length > 0;

  if (!hasInbound) {
    const idleMs = now - lastUserActivityTs;
    if (idleMs < IDLE_THRESHOLD_MS) return;
    const lastUtteranceTs = parseInt(db.getMeta('last_ai_utterance_at') || '0', 10);
    if (now - lastUtteranceTs < MIN_GAP_BETWEEN_HEARTBEATS_MS) return;
  } else {
    // For inbounds, only enforce a 15s minimum gap so we don't spam
    const lastUtteranceTs = parseInt(db.getMeta('last_ai_utterance_at') || '0', 10);
    if (now - lastUtteranceTs < 15_000) return;
  }

  const recentMonologue = db.getRecentMonologue(RECENT_MONOLOGUE_LIMIT);
  if (recentMonologue.length < 2 && !hasInbound) return; // nothing to surface

  const userName = db.getMeta('user_name') || 'them';
  const recentReflections = db.getRecentReflections(RECENT_REFLECTION_LIMIT);
  const recentTurns = db.getRecentTurns(RECENT_TURN_LIMIT);

  const awareness = buildAwarenessBlock({
    chosenName: db.getMeta('chosen_name'),
    sessionStartedAt: opts.getSessionStartedAt ? opts.getSessionStartedAt() : null,
    cumulativeMs: db.getCumulativeSessionTime()
  });

  const protocols = db.getActiveProtocols();
  const pendingInbounds = db.getPendingInbounds(6);

  // If there's nothing to say AND there are no inbounds, defer to normal heartbeat logic.
  // If there ARE pending inbounds, we want to fire EVEN if conversation is otherwise stale.
  const messages = buildHeartbeatPrompt({
    userName,
    recentReflections,
    recentTurns,
    recentMonologue,
    awareness,
    protocols,
    pendingInbounds
  });

  // Mark consumed — they're in Stheno's context now
  if (pendingInbounds && pendingInbounds.length > 0) {
    for (const i of pendingInbounds) {
      try { db.markInboundConsumed(i.id); } catch {}
    }
  }

  const win = opts.getWindow ? opts.getWindow() : null;
  if (!win || win.isDestroyed()) return;

  const sessionId = opts.getSessionId ? opts.getSessionId() : null;
  if (!sessionId) return;

  inFlight = true;
  try {
    const parser = new TagStreamParser({
      onSayToken: (token) => {
        try { win.webContents.send('chat:say-token', token); } catch {}
      }
    });

    await streamChat({
      model: MODEL,
      messages,
      onToken: (chunk) => parser.feed(chunk)
    });

    const { thought, say, truncated } = parser.finalize();

    // Capture any <wonder> tags so Stheno can self-prompt from heartbeat utterances too
    const wonderRe = /<wonder>([\s\S]*?)<\/wonder>/gi;
    const stheneWonders = [];
    for (const src of [thought, say]) {
      if (!src) continue;
      wonderRe.lastIndex = 0;
      let m;
      while ((m = wonderRe.exec(src)) !== null) {
        const w = (m[1] || '').trim();
        if (w.length >= 6) stheneWonders.push(w);
      }
    }
    // FILE TAGS (autonomous): dispatch any file ops she emitted while idle
    const fileTags = [...filesLib.parseTags(thought || ''), ...filesLib.parseTags(say || '')];
    if (fileTags.length > 0) {
      (async () => {
        for (const t of fileTags.slice(0, 3)) {
          try {
            const r = await filesLib.dispatch(t);
            console.log(`[heartbeat] file ${t.tag}: ${r?.ok ? 'ok ' + (r.path || '') : 'FAIL ' + r?.reason}`);
            try { win.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(${t.tag}) ${r?.path || ''}`, type: 'reading', query: r?.path }); } catch {}
          } catch (err) { console.error('[heartbeat] file dispatch error:', err.message); }
        }
      })().catch(() => {});
    }
    // SCREEN TAGS (autonomous): observe desktop if she chose to while idle
    const screenTags = [...screenLib.parseTags(thought || ''), ...screenLib.parseTags(say || '')];
    if (screenTags.length > 0) {
      (async () => {
        try {
          const r = await screenLib.dispatch();
          if (r?.ok) {
            const rr = db.insertMonologue({ content: r.text, model: 'screen-observe', type: 'reading' });
            try { win.webContents.send('monologue:tick', { id: rr.id, ts: rr.ts, content: `(observed screen — focused: ${r.foreground || '?'})`, type: 'reading' }); } catch {}
          }
          console.log(`[heartbeat] screen observe: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
        } catch (err) { console.error('[heartbeat] screen dispatch error:', err.message); }
      })().catch(() => {});
    }

    // AUTONOMY TOOLS (scheduler / presence / email / discord): the proactive
    // outreach surface — a due reminder, progress worth sharing → email or DM.
    const autoCombined = `${thought || ''}\n${say || ''}`;
    if (autoTools.hasAny(autoTools.parseAll(autoCombined))) {
      // GOVERNOR: pace proactive tool actions (notify/schedule/email/dm).
      if (governor.requestAction('tool').allow) {
        governor.record('tool');
        autoTools.dispatchFound(autoCombined, {
          onSheep: (p) => { try { win.webContents.send('monologue:tick', p); } catch {} },
          source: 'heartbeat'
        }).catch(err => console.error('[heartbeat] auto-tools error:', err.message));
      }
    }

    let thoughtStripped = (thought || '').replace(/<wonder>[\s\S]*?<\/wonder>/gi, '').trim();
    thoughtStripped = filesLib.stripTags(thoughtStripped);
    thoughtStripped = screenLib.stripTags(thoughtStripped);
    thoughtStripped = autoTools.stripAll(thoughtStripped);

    // Always store the thought (research signal: what did she consider saying?)
    if (thoughtStripped) {
      db.insertTurn({
        sessionId,
        speaker: 'ai_thought',
        content: thoughtStripped,
        model: MODEL,
        truncated
      });
    }

    // Treat literal placeholder text as silence, not as utterance
    const stripLeakedTags = (s) => autoTools.stripAll(screenLib.stripTags(filesLib.stripTags((s || '')
      .replace(/<\/?think>/gi, '')
      .replace(/<\/?say>/gi, '')
      .replace(/<navigate>[^<]*<\/navigate>/gi, '')
      .replace(/<wonder>[\s\S]*?<\/wonder>/gi, '')
      .replace(/\*[^*\n]{1,200}\*/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim())));
    const trimmedSay = stripLeakedTags(say);
    const isPlaceholder = /^[\s.()]*(empty|silence|nothing|none|n\/a|null|undefined|no\s+say|no\s+comment)[\s.()]*$/i.test(trimmedSay);

    // GOVERNOR: pace unprompted utterances so she doesn't surface in bursts. An
    // inbound chat-bot reply is priority (bypasses pacing — it's time-sensitive).
    const wantsToSpeak = trimmedSay && !isPlaceholder;
    const uGate = wantsToSpeak ? governor.requestAction('utterance', { priority: hasInbound }) : { allow: false };
    if (wantsToSpeak && uGate.allow) {
      governor.record('utterance');
      const saidRow = db.insertTurn({
        sessionId,
        speaker: 'ai_said',
        content: trimmedSay,
        model: MODEL,
        truncated
      });
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      try { win.webContents.send('chat:complete', { saidId: saidRow.id, truncated, unprompted: true }); } catch {}
    } else {
      // Empty say — she chose silence. Reset the gap timer so we don't spam-check.
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      // Tell renderer to clear any partial state from the streaming (no tokens were emitted anyway)
      try { win.webContents.send('chat:complete', { saidId: null, truncated: 0, unprompted: true, silent: true }); } catch {}
    }

    // If Stheno's heartbeat included a <wonder>, fire self-dialogue async
    if (stheneWonders.length > 0) {
      (async () => {
        for (const w of stheneWonders) {
          try { await runSelfDialogue({ wonderText: w, sessionId }); }
          catch (err) { console.error('[heartbeat] self-dialogue failed:', err.message); }
        }
      })().catch(err => console.error('[heartbeat] wonder async error:', err.message));
    }
  } finally {
    inFlight = false;
  }
}

module.exports = {
  startHeartbeatScheduler,
  stopHeartbeatScheduler,
  pause,
  resume,
  markUserActivity,
  maybeHeartbeat
};
