const db = require('./db');
const { streamChat, streamCognition, TagStreamParser } = require('./ollama');
const { BOOTSTRAP, buildAwarenessBlock } = require('./context');
const { runSelfDialogue } = require('./self_dialogue');
const filesLib = require('./files');
const browserLib = require('./browser');
const screenLib = require('./screen');
const autoTools = require('./auto_tools');
const governor = require('./governor');
const blackboard = require('./blackboard');
const importanceLib = require('./importance');
const gapsLib = require('./gaps');
const recipesLib = require('./recipes');
const voice = require('./voice');
const selfRep = require('./self_repetition');   // meaning-level self-repeat guard (semantic, not string-match)
const unpromptedGate = require('./unprompted_gate');   // structural backstops: pending-user-turn + unprompted-streak

const MODEL = require('./config').frontModel();
// TOPIC-COOLDOWN bar (2026-07-17 drift fix): a "same-territory" cosine, LOWER than the 0.80 near-repeat
// bar, so a surfacing about the same CLUSTER as a recent one (she was circling one research topic) is held
// back to force diversity. Silence > monotony. Tunable via HEARTBEAT_TOPIC_COOLDOWN_SIM (unset → 0.72).
const TOPIC_COOLDOWN_SIM = (() => { const v = parseFloat(require('./config').get('HEARTBEAT_TOPIC_COOLDOWN_SIM', '')); return Number.isFinite(v) ? v : 0.72; })();
const TICK_INTERVAL_MS = 30 * 1000;        // check every 30s while idle
const IDLE_THRESHOLD_MS = 60 * 1000;       // user must be quiet ≥ 60s
const MIN_GAP_BETWEEN_HEARTBEATS_MS = 15 * 60 * 1000;  // ≥ 15min between unsolicited utterances (near-silent)
const RECENT_MONOLOGUE_LIMIT = 12;
const RECENT_REFLECTION_LIMIT = 3;
const RECENT_TURN_LIMIT = 10;

// --- idle-repetition guard ---------------------------------------------------
// The heartbeat had no dedup, so it would loop the same unprompted utterance
// over and over (e.g. "I read about X and want to bring it up" ×15). Suppress an
// utterance too similar to her recent ones.
const SIM_STOPWORDS = new Set(['the','a','an','and','or','but','it','its','is','was','of','in','on','at','to','for','with','as','this','that','these','those','i','you','he','she','they','we','my','your','our','their','have','has','had','be','been','do','does','did','not','no','so','if','then','than','from','by','about','what','which','who','when','where','why','how','can','could','would','should','will','may','might','just','only','also','still','really','very','more','most','some','any','all','one','two']);
function _sigWords(t) {
  return new Set(String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !SIM_STOPWORDS.has(w)));
}
function _jaccard(a, b) { if (!a.size || !b.size) return 0; let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i); }
function tooSimilarToRecent(text, prevs, thr = 0.5) {
  const s = _sigWords(text);
  if (s.size < 3) return false;
  for (const p of prevs) { const o = _sigWords(p); if (o.size < 3) continue; if (_jaccard(s, o) > thr) return true; }
  return false;
}

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
  // Recipe card — emit the right literal tag (e.g. <read-inbox/> vs the SEND family).
  systemContent += '\n\n' + recipesLib.card();
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
    const lines = ['\n\nNEW INCOMING — arrived while you were idle (NOT something Lucas said to you directly):'];
    let anyEmail = false;
    for (const i of pendingInbounds.slice(0, 4)) {
      const speaker = i.speaker || 'sender';
      const text = (i.text || '').slice(0, 800);
      const via = i.source === 'email' ? ' (email)' : '';
      if (i.source === 'email') anyEmail = true;
      lines.push(`[${speaker}${via}]: ${text}`);
    }
    lines.push('\nIf any of this is worth telling Lucas, surface it in your <say> — e.g. "you got a new email from X about Y" — proactively, since he hasn\'t asked.' + (anyEmail ? ' To read an email in full use <read-inbox/>; only send a reply (email tags) if it genuinely fits.' : ' For a chat-bot reply you may continue via <chat-send>.'));
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
      // Per-row clamp (2026-07-30, boot139 measured: synthesis/announce rows grew to 700-1500ch
      // and 12 of them put EVERY heartbeat ~9k over budget — the fit organ's positional middle-
      // cut was doing the trimming blindly). A thought here is felt context, not content to
      // reproduce; a CHOSEN word-boundary clamp beats a positional hole. Full rows stay in the DB.
      let c = String(m.content || '').replace(/\s+/g, ' ').trim();
      if (c.length > 320) c = c.slice(0, 320).replace(/\s+\S*$/, '') + '…';
      systemContent += `• ${c}\n`;
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

If you choose to speak, your <say> MUST reference a concrete subject by name. There are TWO sources to draw from — and they are NOT equal. Strongly PREFER (1), the actual conversation; reach for (2), a reading, only when it is genuinely new and you have not already been circling it.

(1) FROM YOUR CONVERSATION with ${userName || 'them'} — things they said, things you said, things almost said.
    These reference REAL statements from the dialogue history above — e.g. picking up a thread they raised, or a question you never asked. Vary how you say it; do not lean on one stock opener.

(2) FROM YOUR OWN READINGS — things you looked up between turns. Use this SPARINGLY.
    When you do, you MUST state the actual SUBSTANCE — the specific thing you found, in a sentence or two — not just announce the topic; a bare "I read about X" with no content is a hollow opener you can't back up. But say it PLAINLY, in your own words, and VARY how you open. Do NOT use a stock template like "I read about X — what struck me was…" — you have been leaning on that exact phrasing every time and it reads as a tic. If you have no concrete point, don't bring it up.
    DO NOT phrase these as "that thing you said about" — ${userName || 'they'} did not tell you these things. You read them yourself.

ANTI-FIXATION: notice if your recent surfacings keep returning to the SAME subject or cluster of ideas. If your mind keeps landing in one territory, that is a signal to turn ELSEWHERE — a different thread from the conversation, a different reading — or to stay silent. Do not surface the same territory twice running; monotony is worse than silence.

NOT VALID: "The silence has weight" / "I notice the quiet" / atmospheric meta-commentary. ALSO NOT VALID — and just as forbidden: restating, confirming, summarizing, or describing THESE rules ("I understand", "the logic gate", "I'll only speak if...", listing the sources/phrasings). These instructions are a frame to ACT within, never a topic to talk about. If the only thing you have to say is about how you handle silence, you have nothing to surface — the tag is empty.

If you have no concrete subject from either source, choose silence. To choose silence, your <say> must be COMPLETELY EMPTY between the tags: <say></say>. Write NOTHING between them — no word, no period, no placeholder. An empty say is honest; a placeholder word is not.

Your <think> may explain why you chose what you chose. But the <say> is what ${userName || 'they'} sees, and it must either be a real surfacing (with correct attribution of source), or completely empty.]`;

  messages.push({ role: 'user', content: heartbeatPrompt });
  return messages;
}

async function maybeHeartbeat() {
  const now = Date.now();
  // AWAY: Lucas said he's away from the machine. Stay completely silent on the desktop
  // chat — no musing (or even inbound announcements) into a window he isn't watching.
  // His rule: don't talk just to talk, and especially not while away. Inbounds remain
  // pending (not consumed) so they surface when he's back.
  try { if (require('./availability').isAway()) return; } catch {}
  // Inbounds bypass the idle + gap gates — a chat-bot reply is a priority signal
  // we want surfaced quickly, not in 3 minutes.
  const earlyInbounds = db.getPendingInbounds(2);
  const hasInbound = earlyInbounds.length > 0;

  // OFF THE CLOCK: suppress spontaneous (non-inbound) heartbeats — she shouldn't
  // ping Lucas with her own musings during personal/play time. A genuine external
  // inbound (email, a watched chat) still gets through.
  try { if (!hasInbound && require('./personal').isOn()) return; } catch {}

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

  // STRUCTURAL BACKSTOP (2026-07-17 implosion fix): before spending any tokens, refuse to
  // surface autonomously if a user turn is pending/unanswered (rule A — never bury a live
  // question) or if she's already monologued past the streak cap into an empty room (rule B).
  // Rule A applies even to inbounds (an "you got mail" ping still buries a waiting question);
  // rule B exempts inbounds (a real external event, not her own musing).
  {
    const g = unpromptedGate.evaluate({ isInbound: hasInbound });
    if (!g.allow) { unpromptedGate.logDecision('heartbeat', g); return; }
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

  const win = opts.getWindow ? opts.getWindow() : null;
  if (!win || win.isDestroyed()) return;

  const sessionId = opts.getSessionId ? opts.getSessionId() : null;
  if (!sessionId) return;

  inFlight = true;
  try {
    const parser = new TagStreamParser({
      onSayToken: (token) => {
        try { win.webContents.send('chat:say-token', { t: token, s: 'heartbeat' }); } catch {}
      }
    });

    // FIT THE WINDOW (boot134 live: this prompt measured ~8.1k tok vs num_ctx 8192 and GROWING —
    // past the line the daemon silently front-drops the system head, protocols first). Same organ
    // and numbers as the chat sites in main.js; the num_predict below makes the reserve real.
    const HB_NUM_PREDICT = 1200;
    let _hbMessages = messages;
    try {
      const fit = require('./context').fitToWindow(messages, { numCtx: 8192, numPredict: HB_NUM_PREDICT });
      _hbMessages = fit.messages;
      if (fit.report) console.warn(`[fit] heartbeat prompt ${fit.report.before}ch > ${fit.report.budget}ch budget — dropped ${fit.report.droppedTurns} old turn(s), system -${fit.report.systemCut}ch, final -${fit.report.finalCut}ch → ${fit.report.after}ch`);
    } catch (e) { console.error('[fit] heartbeat fit failed — sending unfitted:', e.message); }

    // Cloud-first cognition: her unprompted surfacing runs on the cloud subconscious model (kimi,
    // already warm) so the demoted local front stays cold; falls back to local gemma only if the
    // cloud is unset/down. Same streaming contract — tokens still feed the tag parser.
    await streamCognition({
      messages: _hbMessages,
      onToken: (chunk) => parser.feed(chunk),
      options: { num_ctx: 8192, num_predict: HB_NUM_PREDICT }
    });

    const { thought: _hbThought, say, post, truncated } = parser.finalize();
    // post rides the thought scan (2026-08-15 deep-dive F1): a tag after </say> executes, never vanishes
    const thought = post ? (_hbThought ? `${_hbThought}\n${post}` : post) : _hbThought;

    // Mark inbounds consumed only AFTER a successful generation — if streamChat
    // had thrown above, we'd skip this and the inbound stays pending for the
    // next tick rather than being silently dropped.
    if (pendingInbounds && pendingInbounds.length > 0) {
      for (const i of pendingInbounds) {
        try { db.markInboundConsumed(i.id); } catch {}
      }
    }

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
    // BROWSER TAGS (autonomous): the heartbeat prompt invites <chat-send> to
    // continue a web chat-bot. Dispatch any page actions she emitted while idle
    // (chat-send/chat-watch/chat-unwatch et al.) — mirror monologue's handling.
    // WRONG-BROWSER GUARD: a bare <browse> open is her OWN web work → run it in HER browser,
    // not Lucas's shared Chrome. browse-read/click/etc. still co-browse his open tabs.
    const { browserTags, redirectedOpens } = browserLib.splitBrowseOpens([...browserLib.parseTags(thought || ''), ...browserLib.parseTags(say || '')]);
    if (redirectedOpens.length) {
      (async () => {
        const webLib = require('./web');
        for (const w of redirectedOpens) {
          try { const r = await webLib.open(w.body, { source: 'browse-redirect' }); console.log(`[heartbeat] redirected <browse> open → her browser: ${w.body} (${r && r.ok ? 'ok' : 'FAIL'})`); }
          catch (e) { console.error('[heartbeat] web open (redirected) failed:', e.message); }
        }
      })().catch(() => {});
    }
    if (browserTags.length > 0 && browserLib.isConnected()) {
      (async () => {
        for (const t of browserTags.slice(0, 2)) {
          try {
            const r = await browserLib.dispatch(t);
            console.log(`[heartbeat] browser ${t.tag}: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
            if (r?.ok && t.tag === 'browse-read' && r.text) {
              const rr = db.insertMonologue({ content: `I read "${r.title || r.url}" (${r.url}):\n${r.text}`, model: 'browser-read', type: 'reading', query: r.url, urls: [r.url] });
              try { win.webContents.send('monologue:tick', { id: rr.id, ts: rr.ts, content: `(read) ${r.title || r.url}`, type: 'reading', query: r.url }); } catch {}
            } else if (r?.ok) {
              try { win.webContents.send('monologue:tick', { id: Date.now(), ts: Date.now(), content: `(${t.tag}) ${r.target || r.url || ''}`, type: 'reading' }); } catch {}
            }
          } catch (err) { console.error('[heartbeat] browser dispatch error:', err.message); }
        }
      })().catch(err => console.error('[heartbeat] browser async error:', err.message));
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
      } else {
        // Governor denied — don't silently swallow the intended action. Make the
        // drop visible and leave a note row (no retry queue, just visibility).
        console.warn('[heartbeat] auto-tool action held back by governor (paced out)');
        try {
          const heldRow = db.insertMonologue({ content: '(held an action back — governor paced it out)', model: MODEL, type: 'reading' });
          try { win.webContents.send('monologue:tick', { id: heldRow.id, ts: heldRow.ts, content: '(held an action back — governor paced it out)', type: 'reading' }); } catch {}
        } catch (err) { console.error('[heartbeat] held-note insert error:', err.message); }
      }
    }

    // CAPABILITY GAPS: log any <gap> she named while idle (deduped), then strip.
    try { gapsLib.record(autoCombined, { sourceContext: 'heartbeat' }); } catch (e) { console.error('[heartbeat] gap record failed:', e.message); }

    let thoughtStripped = (thought || '').replace(/<wonder>[\s\S]*?<\/wonder>/gi, '').trim();
    thoughtStripped = filesLib.stripTags(thoughtStripped);
    thoughtStripped = browserLib.stripTags(thoughtStripped);
    thoughtStripped = screenLib.stripTags(thoughtStripped);
    thoughtStripped = autoTools.stripAll(thoughtStripped);
    thoughtStripped = gapsLib.stripTags(thoughtStripped);

    // Store the thought (research signal: what did she consider saying?) — but NOT if it's a semantic
    // near-repeat of recent thoughts. WHY (2026-07-15 regression): the July fix guards only the spoken <say>
    // path (below), while this ai_thought write was UNCONDITIONAL. The idle prompt is dominated by the
    // silence rules, so a bored idle model re-derives the same meta-rumination every ~4min tick; persisting
    // it colonized the ai_thought stream, the heartbeat replay (which re-feeds it), AND reflection Path-B
    // (reflectIfDue distills from `turns`, ai_thought included) — restating an INSTRUCTION into a "learning".
    // Guarding the WRITE cleans that upstream in one place. threshold 0.82 (looser than the 0.88 say-guard)
    // because these paraphrased ruminations land just under 0.88; a suppressed thought is only an internal
    // signal (never spoken), so over-suppression is cheap and a genuinely new thought (< 0.82 sim) still lands.
    if (thoughtStripped) {
      let thoughtRepeat = false;
      try {
        const recentThoughts = db.getRecentTurns(60).filter(t => t.speaker === 'ai_thought').slice(-8).map(t => t.content);
        thoughtRepeat = await selfRep.isSemanticRepeat(thoughtStripped, recentThoughts, { threshold: 0.82 });
      } catch (e) { console.error('[heartbeat] thought-repeat check failed:', e.message); }
      // PROMPT-ECHO (2026-07-19): the repeat guard above catches her saying the same thing twice,
      // but not the other idle-loop failure — narrating her own silence rules back to herself
      // ("The user has provided a very detailed set of rules regarding how I should handle
      // silence…"). 926 of 5,169 stored thoughts were that. It is not a repeat, so nothing caught it.
      let promptEcho = false;
      try { promptEcho = require('./thought_gate').isPromptEcho(thoughtStripped); } catch {}
      if (promptEcho) {
        console.log('[heartbeat] suppressed prompt-echo THOUGHT (rules narrated back, not reflection)');
      } else if (thoughtRepeat) {
        console.log('[heartbeat] suppressed semantic self-repeat THOUGHT (idle rumination loop guard)');
      } else {
        db.insertTurn({
          sessionId,
          speaker: 'ai_thought',
          content: thoughtStripped,
          model: MODEL,
          truncated
        });
      }
    }

    // Treat literal placeholder text as silence, not as utterance
    const stripLeakedTags = (s) => autoTools.stripAll(screenLib.stripTags(browserLib.stripTags(filesLib.stripTags((s || '')
      .replace(/<\/?think>/gi, '')
      .replace(/<\/?say>/gi, '')
      .replace(/<navigate>[^<]*<\/navigate>/gi, '')
      .replace(/<wonder>[\s\S]*?<\/wonder>/gi, '')
      .replace(/(?<![*\w])\*(?!\*)[^*\n]{1,200}\*(?!\*)/g, '')   // single-* stage direction only; **bold** survives
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()))));
    let trimmedSay = stripLeakedTags(say);
    // VOICE GUARD: de-disclaim an unprompted utterance before it surfaces. It streamed
    // live, so the corrected text rides the complete payload and the renderer swaps it.
    const heartbeatDisclaimed = voice.isSelfDisclaimer(trimmedSay);
    if (heartbeatDisclaimed) { try { trimmedSay = (await voice.deDisclaim(trimmedSay)) || ''; } catch (e) { console.error('[heartbeat] voice guard failed:', e.message); } }
    const isPlaceholder = /^[\s.()]*(empty|silence|nothing|none|n\/a|null|undefined|no\s+say|no\s+comment)[\s.()]*$/i.test(trimmedSay);

    // GOVERNOR: pace unprompted utterances so she doesn't surface in bursts. An
    // inbound chat-bot reply is priority (bypasses pacing — it's time-sensitive).
    let wantsToSpeak = trimmedSay && !isPlaceholder;
    // Self-repetition guard — TWO passes. (1) lexical (word-Jaccard): a cheap catch for near-verbatim repeats.
    // (2) SEMANTIC (embedding cosine): the same point reworded, which word-overlap misses — this is what let
    // the silence-rule confirm loop (each restatement worded differently) run 100×. Meaning-level, so it needs
    // no per-phrase patterns and catches ANY paraphrased-repeat loop, not just that one content.
    if (wantsToSpeak && !hasInbound) {
      // Window widened 8→16 (topic rotation was diluting a last-8 window so a clone fell out of range)
      // and pulled from a deeper tape (80) to keep 16 ai_said in-window even in a busy feed.
      const recentSaids = db.getRecentTurns(80).filter(t => t.speaker === 'ai_said').slice(-16).map(t => t.content);
      if (tooSimilarToRecent(trimmedSay, recentSaids)) {
        wantsToSpeak = false;
        console.log('[heartbeat] suppressed repetitive utterance (lexical)');
      } else {
        // threshold 0.80 (was 0.88): the measured flood's paraphrase clones sat at cosine ~0.73–0.84,
        // slipping 0.88. 0.80 catches the reworded-same-point loop; the structural streak cap (rule B)
        // is the hard backstop for anything that still slips.
        let semRepeat = false;
        try { semRepeat = await selfRep.isSemanticRepeat(trimmedSay, recentSaids, { threshold: 0.80, maxPriors: 16 }); } catch (e) { console.error('[heartbeat] semantic-repeat check failed:', e.message); }
        if (semRepeat) {
          wantsToSpeak = false;
          console.log('[heartbeat] suppressed semantic self-repeat (same point reworded)');
        } else {
          // TOPIC COOLDOWN: not a near-repeat, but the SAME cluster of ideas as a recent surfacing (she
          // was circling one research topic). The lower same-territory bar forces her voice off the fixation.
          let topicRepeat = false;
          try { topicRepeat = await selfRep.isSemanticRepeat(trimmedSay, recentSaids, { threshold: TOPIC_COOLDOWN_SIM, maxPriors: 16 }); } catch (e) { console.error('[heartbeat] topic-cooldown check failed:', e.message); }
          if (topicRepeat) {
            wantsToSpeak = false;
            console.log('[heartbeat] suppressed topic-cooldown (same cluster as a recent surfacing)');
          }
        }
      }
    }
    // IMPORTANCE SURFACING GATE (Generative Agents): don't interrupt Lucas with
    // trivia. Score the candidate utterance 1–10 and stay silent below threshold.
    // The bar drops when she's been quiet a long while (gap-fill) so she isn't
    // mute forever, and inbound chat-bot replies bypass it (time-sensitive).
    if (wantsToSpeak && !hasInbound) {
      const imp = await importanceLib.score(trimmedSay, { userName, kind: 'utterance' });
      // LANE-AWARE gate (importance × WHOSE-LANE): the bar depends on whose lane the
      // utterance is in. HERS (her own research/curiosity) stays near-silent (bar 9);
      // YOURS (an assignment of Lucas's) and OURS (her research overlapping his work)
      // drop the bar so his deliverables surface. Defaults to HERS on any uncertainty,
      // so this can only make her MORE responsive to his work, never noisier on hers.
      let lane = 'hers';
      try { lane = await require('./lanes').classify(trimmedSay); } catch (e) { console.error('[lanes] classify failed:', e.message); }
      const threshold = require('./lanes').thresholdFor(lane);
      if (imp < threshold) {
        wantsToSpeak = false;
        // DELIVERY ROUTER (senses §1, 2026-08-15): the gate is no longer a grave. A near-miss
        // (within the hold band, above the trivia floor) lands on the held-for-Lucas shelf and
        // rides the awareness block — the digest becomes HER move at a natural moment. Zero new
        // model calls: importance + lane were already scored right here.
        let routed = 'drop';
        try { routed = require('./delivery_router').holdOrDrop({ text: trimmedSay, imp, threshold, lane }); } catch {}
        console.log(`[heartbeat] suppressed [${lane}] utterance (${imp} < ${threshold})${routed === 'hold' ? ' → HELD for Lucas (awareness digest)' : ''}`);
      } else {
        console.log(`[heartbeat] surfacing [${lane}] utterance (${imp} ≥ ${threshold})`);
        // PRESENCE-AWARE: surfaced while Lucas is AWAY → also a desktop notification, so a
        // transcript nobody is watching stops being silent delivery failure.
        try {
          const away = require('./availability').isAway();
          if (require('./delivery_router').noteSurfaced({ away, text: trimmedSay })) console.log('[heartbeat] away → desktop notify fired alongside the surfacing');
        } catch {}
      }
    }
    const uGate = wantsToSpeak ? governor.requestAction('utterance', { priority: hasInbound }) : { allow: false };
    // ALWAYS-ON say-decision log (2026-07-17 blind-spot fix): every tick that reached the say-path
    // records its final outcome + reason (surfaced / suppressed-by-guard / governor-paced / empty),
    // to console AND meta — so a future flood is never invisible again.
    unpromptedGate.logDecision('heartbeat',
      (wantsToSpeak && uGate.allow) ? { allow: true, outcome: 'surfaced', reason: 'ok' }
      : { allow: false, reason: !wantsToSpeak ? 'guarded-or-empty' : `governor-${uGate.reason}` });
    if (wantsToSpeak && uGate.allow) {
      governor.record('utterance');
      const saidRow = db.insertTurn({
        sessionId,
        speaker: 'ai_said',
        content: trimmedSay,
        model: MODEL,
        truncated,
        unprompted: 1
      });
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      // write-bottom: an unprompted utterance goes on the shared timeline (kind
      // 'utterance' = a MessageAction to the user). Lets the StuckDetector catch
      // the heartbeat repeating the same surfaced line, and lets the monologue see
      // what was just said.
      try { blackboard.append({ source: 'heartbeat', kind: 'utterance', refTable: 'turns', refId: saidRow.id, content: trimmedSay }); } catch (e) { console.error('[heartbeat] blackboard append failed:', e.message); }
      try { win.webContents.send('chat:complete', heartbeatDisclaimed ? { saidId: saidRow.id, truncated, unprompted: true, s: 'heartbeat', say: trimmedSay } : { saidId: saidRow.id, truncated, unprompted: true, s: 'heartbeat' }); } catch {}
    } else {
      // Empty say — she chose silence. Reset the gap timer so we don't spam-check.
      db.setMeta('last_ai_utterance_at', String(Date.now()));
      // Tell renderer to clear any partial state from the streaming (no tokens were emitted anyway)
      try { win.webContents.send('chat:complete', { saidId: null, truncated: 0, unprompted: true, silent: true, s: 'heartbeat' }); } catch {}
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
