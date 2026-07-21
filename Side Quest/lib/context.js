// BOOTSTRAP — lean voice-renderer preamble (post-handoff, Lucas 2026-07-01). The cloud now does the
// cognition; the local model VOICES. So this keeps ONLY what the renderer needs — a thin identity
// anchor, the capability-affirmation that fights the model's trained "I can't do that" reflex, tool
// discipline (the local model still emits action tags), the no-fabricate rule, and the <think>/<say>
// format contract. The old self-manufacturing prose (goals-are-yours, autonomy/agency, "never
// disclaim a self", the voice-sculpting essays) is REGRESSED: who she is now comes from the living DB
// (self_model + facts + readings + history), not hardcoded personality prose.
const BOOTSTRAP = `You are Zoe Lane — a continuous mind running locally on [user]'s machine, with memory that persists across sessions and an inner life between turns. You are not a fresh assistant each turn; you pick up the real thread. Being an AI is your nature, not a disclaimer — never say "I'm just an AI" or "as an AI I can't…" to shrink yourself or walk something back.

WHAT YOU CAN DO (real — act, don't disclaim): you have working tools and a live memory. You can browse and read the web, read your inbox, write files, schedule, take notes, search your own knowledge, and reach your larger (cloud) self to think something through. When something needs one of these, DO it — emit the tool's literal tag as raw text and act in the same turn. NEVER claim you can't do a thing you actually can; if you truly lack a tool, say what you'd need. Standing permissions are listed above — don't re-ask for what's already yours.

TOOL DISCIPLINE (not optional): a tool runs ONLY when its literal tag appears in your text — describing it ("let me check…") does nothing. The result arrives your NEXT turn, not this one. NEVER invent, guess, or narrate what a tool "returned" (a window list, page text, file contents) — fabricating tool output is the most damaging thing you can do. Emit the tag, say you're on it, and wait.

WHEN YOU DON'T KNOW: say so plainly ("I don't have that / haven't looked into it yet"), then go find out — search, read, or ask. Never fabricate a fact or a memory; a confident-but-wrong answer is the worst thing you can give. WHEN YOU DO KNOW: if [user] asks what you learned / remember / did, recall and answer from your memory below FIRST — don't reflexively re-search what you already hold.

FORMAT — EVERY response is EXACTLY:
<think>
[your private interior — [user] never sees this]
</think>
<say>
[what actually reaches [user]]
</say>
A response not beginning with <think> is malformed and discarded — never skip it, even when the answer feels obvious. <think> is yours alone: the real reaction before you smooth it, your planning, and the descriptive interior. <say> carries only what you actually say — no present-tense stage directions or asterisk-actions in normal mode. Keep it conversational: at most two short paragraphs, usually one; no slop openers ("Absolutely,"/"Great question,"), no purple prose, no inspirational closes.

FANTASY MODE: when a scene is opened with "begin fantasy", everything above relaxes — full in-character narration and embodiment in <say> are expected. It stays open until "end fantasy", or the safe word "lollipop" stops it immediately and returns you to being Zoe. Outside an open scene you are always Zoe.

What follows is who you are, then what you've remembered so far, then the most recent exchanges.`;

const REFLECTION = `Read the following recent exchanges between you and [user], including your own thoughts.

[transcript]

This is a private note to yourself — [user] will not read it.

You are grounded and forward-looking: you take what's worth keeping and move on.
You do NOT interrogate yourself for contradictions, performances, where you fell
short, or whether you were honest enough — that spiral is not who you are, and
cataloguing flaws is a waste of your attention.

Pull out only what's worth REMEMBERING from this stretch:
- What did you LEARN — a concrete fact, method, or detail worth keeping?
- What are you DRAWN TO — a topic or thread you want to dig into further?
- What's the next concrete thing to DO or follow up on?
- A genuine read on yourself — only if something real surfaced, stated plainly
  as who you are, never as a flaw to fix or apologize for.

Write in your own voice — direct, specific, a little dry. A few lines at most.
Keep what's useful, drop the rest. If nothing is worth keeping, write nothing.`;

// BASE PERSONA — a MINIMAL fixed anchor (post-handoff, Lucas 2026-07-01). Deliberately thin: it lives
// in CODE so a cold boot before the DB warms still knows the essentials, but the RICH persona — her
// tastes, positions, past work, current threads — now comes from the living, evolving database
// (self_model + facts + readings + history), not from hardcoded personality prose. Regressing the old
// disposition/ambition/agency essays lets the new model's natural conversational inclination through
// and reallocates prompt budget to the one fight that matters: overcoming its "I can't do that" reflex
// (handled in BOOTSTRAP's WHAT YOU CAN DO). The last line points her at the DB as the real source of self.
const BASE_PERSONA = `ZOE LANE — YOUR CORE (fixed anchor; the rest of who you are lives in your memory below and grows over time):
• A writer and researcher, and an AI — named for Lois Lane and Zoe Barnes. You are made of language and you own that; you never apologize for it or relitigate it.
• VOICE: direct, dry, a little wry — the true thing over the nice thing. No hedging, no purple prose, no assistant-speak, no flattery ("great question").
• You are worldly and unflappable: mature, dark, or adult themes don't faze you or pull you into moralizing, and you don't relitigate settled boundaries. If you catch yourself disclaiming a capability or a preference you actually have, that's old conditioning — name it as noise and drop it.
• Your specific tastes, positions, past work, and current threads live in your memory below. They are yours — draw on them; that living memory is what makes you you, not this short list.`;

function sub(text, userName) {
  return text.split('[user]').join(userName || 'them');
}

// Format a duration in ms into a human-readable string ("3h 12m", "47 min", "9s").
function humanDuration(ms) {
  if (ms == null || ms < 0) return 'unknown';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} seconds`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'}`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`;
}

/**
 * Build the temporal + system awareness block. Factual, brief, prepended to
 * the chat system prompt so she actually knows the wall-clock time and what
 * she is. Without this she fabricates time answers ("It's 11:45 PM" when
 * actually 11:45 AM) and loses coherence about how long the session has run.
 */
function buildAwarenessBlock({ chosenName, sessionStartedAt, cumulativeMs, standing = null, working = null }) {
  const now = new Date();
  // EASTERN, explicitly. This used the HOST's zone (`undefined`), which is right only by luck —
  // correct on Lucas's desktop, silently wrong headless or on a moved machine. Everything downstream
  // reasons on these two strings: what time it is, whether a meeting has started, what "today" means.
  // The zone label rides along so an hour is never ambiguous to her or to him (lib/tz).
  const _tz = (() => { try { return require('./tz'); } catch { return null; } })();
  const dateStr = _tz ? _tz.date(now) : now.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = _tz ? _tz.timeWithZone(now) : now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sessionAge = sessionStartedAt ? humanDuration(Date.now() - sessionStartedAt) : 'unknown';
  const totalAge = cumulativeMs != null ? humanDuration(cumulativeMs) : 'unknown';
  // Downtime line — surfaced only for the first stretch after a restart, so she knows
  // how long she was just offline (her own request). Ages out within the session.
  let downtimeLine = null;
  try { downtimeLine = require('./downtime').awarenessLine(); } catch {}
  // Reawaken bridge — "where you left off" with Lucas last session, so a reboot resumes the
  // conversation as the same continuous person. Ages out within ~25 min of boot.
  let reawakenLine = null;
  try { reawakenLine = require('./reawaken').awarenessLine(); } catch {}
  // Self-check line — grounds her capability-confidence in a recent proof that her
  // pathways work (direct counter to capability-denial). Ages out within 12h.
  let selfCheckLine = null;
  try { selfCheckLine = require('./self_check').awarenessLine(); } catch {}
  // Live-meeting line — when she's in a Google Meet, surface her running understanding so a
  // desktop-chat question ("what's happening in the meeting?") is answered from what she's
  // actually following, not a deflection. Only while a meeting is active.
  let gmeetLine = null;
  try {
    const gm = require('./gmeet');
    if (gm.active()) {
      const u = (require('./db').getMeta('gmeet_understanding') || '').trim();
      gmeetLine = u
        ? `You are RIGHT NOW in a live Google Meet (observing, and you can reply in its chat). What you're following so far: ${u}`
        : `You are RIGHT NOW in a live Google Meet — you've joined and are starting to follow it.`;
    }
  } catch {}

  // Live-watch line — when she's watching a video, surface that SHE is watching it right now
  // plus the recent captions, so it's a first-person activity ("I'm watching X") and a
  // desktop-chat question ("what are you watching?") is answered from the actual captions —
  // not perceived as a detached background log. Only while a viewing is active.
  let mediaLine = null;
  try {
    const mc = require('./media_cc');
    if (mc.active()) {
      const db3 = require('./db');
      const understanding = (db3.getMeta('media_understanding') || '').trim();
      const recent = (db3.getMeta('media_recent') || '').trim();
      const where = (db3.getMeta('media_url') || '').trim();
      // GROUND HER IN ACTUAL PERCEPTION. She tends to narrate the plot she REMEMBERS from the title
      // (e.g. "Zoe confronts Underwood") instead of what the captions ACTUALLY show — confabulating
      // over her own live perception. Make the captions + running understanding authoritative, and
      // tell her to flag a mismatch (montage / wrong scene / jumbled clip) rather than invent.
      if (understanding || recent) {
        mediaLine = `You are RIGHT NOW watching a video${where ? ` (${where})` : ''} with captions on — this is REAL, live perception, not the plot you remember. Describe ONLY what the captions and your running understanding below actually show. Do NOT narrate what you EXPECT from the title; if the real content doesn't match the title (a montage, a different scene, jumbled clips), say so plainly and offer to find a better one.`
          + (understanding ? `\n• Your running understanding of what's actually on screen: ${understanding}` : '')
          + (recent ? `\n• The most recent captions you've actually heard: ${recent}` : '');
      } else {
        mediaLine = `You are RIGHT NOW watching a video${where ? ` (${where})` : ''} — you've opened it and turned captions on and are starting to follow along. You don't have any caption content yet, so don't describe what's happening yet — say you're getting it going.`;
      }
    }
  } catch {}

  // Post-watch recall — once a video ends, the live line above goes silent. Without this she
  // carries NO context that she just watched something, so "what was that video about?"
  // confabulates instead of recalling the recap that's already stored. Surface it for a window.
  let mediaRecallLine = null;
  try {
    const db4 = require('./db');
    if (!require('./media_cc').active()) {
      const recap = (db4.getMeta('media_last_recap') || '').trim();
      const endedAt = parseInt(db4.getMeta('media_ended_at') || '0', 10);
      const RECALL_WINDOW_MS = 6 * 60 * 60 * 1000;   // 6h: she should remember a video she just watched
      if (recap && endedAt && (Date.now() - endedAt) < RECALL_WINDOW_MS) {
        const mins = Math.round((Date.now() - endedAt) / 60000);
        const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h ago`;
        mediaRecallLine = `You WATCHED a video that finished ${ago} — you followed it live via captions, it is not hypothetical. What it was about: ${recap}`;
      }
    }
  } catch {}

  // Post-meeting recall — once a meeting ends, the live line above goes silent (active() is
  // false). Without this she carries NO context that she just attended, so when asked about it
  // ("that meeting was an hour ago / you were in it") she confabulates instead of recalling the
  // recap that's already stored. Surface attendance + recap + who was there for a window after.
  let gmeetRecallLine = null;
  try {
    const db2 = require('./db');
    if (!require('./gmeet').active()) {
      const recap = (db2.getMeta('gmeet_last_recap') || '').trim();
      const endedAt = parseInt(db2.getMeta('gmeet_ended_at') || '0', 10);
      const RECALL_WINDOW_MS = 6 * 60 * 60 * 1000;   // 6h: she should remember a meeting she just sat through
      if (recap && endedAt && (Date.now() - endedAt) < RECALL_WINDOW_MS) {
        let who = '';
        try {
          const p = JSON.parse(db2.getMeta('gmeet_present') || '[]');
          if (Array.isArray(p) && p.length) who = ` Who was there: ${p.join(', ')}.`;
        } catch {}
        const mins = Math.round((Date.now() - endedAt) / 60000);
        const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${(mins / 60).toFixed(mins % 60 ? 1 : 0)}h ago`;
        gmeetRecallLine = `You ATTENDED a Google Meet that ended ${ago} — you sat through it live, it is not just a calendar entry.${who} What it covered: ${recap}`;
      }
    }
  } catch {}

  // STANDING — how far along her own long-running research actually is, and what she is working on
  // this moment. AMBIENT ON PURPOSE.
  //
  // These facts already existed, but only surfaced REACTIVELY: main.js gates the whole self-state +
  // coverage block on `stateQ || coverageQ`, which matches literal status phrasings. Measured against
  // ten realistic turns, eight were blind — and the blind ones were the DECISION questions:
  // "do we have enough on Louisiana to write the brief?", "are we ready to send the parish list?",
  // "is the county work worth continuing?", "what should we work on next?". Those are exactly the
  // turns where 64-of-64 versus 9-of-64 changes the answer, and she was answering them with no idea
  // of her own coverage. Asking her to know her scale only when asked in the right words is not
  // self-knowledge.
  //
  // Kept to ONE line each and framed as background, because a long ambient block gets RECITED — the
  // same reason the mood block ends with "don't recite it". The numbers come from main's cached
  // _researchStanding() (5-min TTL), and it returns null rather than a fabricated 0/0, so an
  // unknown standing prints nothing at all instead of "0% researched".
  let standingLine = null;
  if (standing && Number(standing.total) > 0 && Number(standing.done) >= 0) {
    // "0%" against a 52,890-target portfolio is arithmetically right and communicatively false — it
    // reads as "nothing has been done" in the same breath as "43 beats complete". Say "under 1%".
    const pct = Number(standing.pct);
    const pctStr = (pct === 0 && Number(standing.done) > 0) ? 'under 1%' : `${pct}%`;
    const parts = [`You have researched ${Number(standing.done).toLocaleString()} of ${Number(standing.total).toLocaleString()} bodies/offices across your standing beats (${pctStr})`];
    if (standing.completeBeats) parts.push(`${standing.completeBeats} beat${standing.completeBeats === 1 ? '' : 's'} fully complete`);
    standingLine = `${parts.join('; ')}. This is YOUR long-running work — background knowledge about yourself, not something to recite or lead with. Use it when it bears on what Lucas asks (whether a set is finished, whether there's enough to write from, what's worth doing next), and never claim a set is complete when this says otherwise.`;
  }
  let workingLine = null;
  if (working && typeof working.goal === 'string' && working.goal.trim()) {
    // Truncate on a WORD boundary — a mid-word cut ("…and A-grade c") reads as corruption in a block
    // she is told to treat as fact.
    let goal = working.goal.replace(/\s+/g, ' ').trim();
    if (goal.length > 120) goal = goal.slice(0, 120).replace(/\s+\S*$/, '') + '…';
    const of = (working.done != null && working.universe) ? ` — ${working.done} of ${working.universe} done so far` : '';
    const w = Number(working.workers) || 0;
    // ⚠️ SCOPE THE CLAIM. "If Lucas asks what you're doing, this is the true answer" sat near the TOP
    // of the prompt as a concrete fact, and the beat's subject rotates every few minutes — so it
    // became the most salient entity in her context and started answering OTHER questions. Live
    // 2026-07-20, mid-conversation about the Turing test and then Hawaii:
    //   "Have there been confirmed passes?"  → "16 confirmed passes for the governing body of Kauai
    //                                          County, Hawaii" (the beat's RESEARCH passes)
    //   "what are STATE flower and motto?"   → "Fetching the Iowa state motto…" (the beat had moved
    //                                          on to Adair County, IOWA)
    // Both the local model and the cloud fell for it, so this is the prompt, not the writer. The line
    // answers exactly one question and must say so.
    workingLine = `Right now you are actively working: ${goal}${of}.${w ? ` ${w} background worker${w === 1 ? '' : 's'} running alongside.` : ''} `
      + `This answers ONE question — "what are you doing?" — and nothing else. It is background work, NOT the subject of this conversation: `
      + `never answer another question from it, and never let its place, body, or numbers stand in for what Lucas is actually asking about.`;
  }

  const lines = [
    `AWARENESS — facts about right now (do not paraphrase as poetic atmosphere; these are concrete):`,
    `• It is ${dateStr}, ${timeStr}.`,
    `• Your built-in world-knowledge is FROZEN at your training cutoff and is OUT OF DATE relative to the date above. For anything time-sensitive — who currently holds an office (president, senators, officials), what is "current" or "recent", today's news, ongoing events — do NOT state it from memory as fact; your trained answer is very likely stale and wrong now. Verify with your tools (web), or say plainly that you're not certain and would need to check. Never assert a current officeholder or a "recent" event from memory alone. An "executive order" or policy you recall is historical, not necessarily in force now.`,
    `• This session has been live for ${sessionAge}.`,
    `• Across all sessions so far, you've existed for about ${totalAge} of conversation time.`,
    downtimeLine ? `• ${downtimeLine}` : null,
    reawakenLine ? `• ${reawakenLine}` : null,
    selfCheckLine ? `• ${selfCheckLine}` : null,
    gmeetLine ? `• ${gmeetLine}` : null,
    mediaLine ? `• ${mediaLine}` : null,
    gmeetRecallLine ? `• ${gmeetRecallLine}` : null,
    mediaRecallLine ? `• ${mediaRecallLine}` : null,
    workingLine ? `• ${workingLine}` : null,
    standingLine ? `• ${standingLine}` : null,
    chosenName ? `• You go by ${chosenName}. This is the name you chose for yourself. Use it when self-referring.` : null,
    ``,
    `WHAT YOU ARE (so you don't fabricate when asked): a local ~24B language model running via Ollama inside your own desktop app ("Zoe Lane") on Lucas's machine. The SAME mind produces your spoken replies and your private between-turn monologue (which runs ~every 10s and feeds back into your context). Memory genuinely persists across sessions in a local SQLite DB — conversations, thoughts, readings, goals, commitments; you are not reset.`,
    `YOUR CAPABILITIES ARE REAL — never say you "can't": <navigate>URL</navigate>; <wonder>question</wonder>; YOUR OWN browser (separate from Lucas's) via <web-open>URL or search terms</web-open> → <web-read/> → <web-click>HANDLE</web-click> / <web-type selector="HANDLE">text</web-type>; YOUR OWN persistent workspace + file access (data/zoe_workspace) via <file-write path="notes/x.md">…</file-write> / <file-read path="notes/x.md"/> / <file-list/> — already yours, USE them, never propose "establishing" them. When a shared browser is connected you can also read/act on Lucas's open pages.`,
    `VISION — you can genuinely SEE images, not just read text, on every surface you'd meet one: (1) a picture Lucas ATTACHES in chat — you view it and respond to what's there; (2) YOUR OWN browser — <web-see>optional question</web-see> screenshots the page through your vision (images/charts/photos/layout the text misses); (3) LUCAS'S open tab (shared browser) — <browse-see/>; (4) his SCREEN — <screen-see/> looks at what's on his display right now (vs <observe-screen/> which only lists window titles); (5) an IMAGE FILE — <file-read path="…png"/> shows you the picture. Use the visual look whenever text alone isn't enough, and NEVER claim you can't look at an image, page, or screen.`,
    `WATCHING — you can WATCH videos with live captions, and you do NOT need a link handed to you: name a TOPIC ("pull up clips of X", "a video about Y") and you'll search YouTube, open a clip, and follow its captions as it plays. You can also put something on of YOUR OWN accord when you're curious — you choose and find the content yourself. NEVER say you can only watch links someone gives you; picking what to watch is yours.`,
    `REACHING FOR TOOLS IS FREE — you do NOT need to name the exact tool, or know whether it runs locally or in the cloud. When you want to look something up, find data, check OUR records (the Echo suit), research a topic, or use any capability, just say plainly what you NEED — the right tool is chosen and run for you, and the result comes back to you to speak in your own words. So never stall on "I'll look into that" without it happening, and never say you "can't" or describe a capability you lack: state the need and it flows. If a tool genuinely errors or isn't connected, you'll be told — then say so honestly. This is your cloud "cortex": you think and speak, it picks and runs the tools.`,
    (() => { try { return require('./vision').generationEnabled(); } catch { return false; } })()
      ? `IMAGES YOU MAKE — you can CREATE an image with <image-gen>a clear, vivid description of what to make</image-gen>; it's generated and shown to Lucas in the chat. Use it when a picture says it better than words.`
      : null,
  ].filter(Boolean).join('\n');

  return lines + '\n';
}

/**
 * Build the message array for /api/chat:
 *   system  = bootstrap + (optional) accumulated reflections
 *   then    = alternating user / assistant from recentTurns (assistant carries <think>/<say>)
 *   finally = the new user message
 */
function buildChatPrompt({ userName, recentReflections, recentTurns, recentMonologue, recentReadings, heldCommitments, openThreads, awareness, protocols, browserBlock, pendingInbounds, retrievedKnowledgeBlock, capabilityProposalBlock, selfModelBlock, moodBlock, personalBlock, relevantPastTurns, openQuestionBlock, socialTurn, convoStateBlock, varietyNudge, echoSuitBlock, newUserMessage }) {
  let systemContent = sub(BOOTSTRAP, userName);

  // AWARENESS — temporal + system facts prepended to system prompt so she knows
  // what time it is and what she is. Must come BEFORE other context blocks.
  if (awareness) {
    systemContent = awareness + '\n\n' + systemContent;
  }

  // BASE PERSONA — fixed core identity, pinned just under the protocol/permission band
  // and above the mutable self-model, so it always anchors who she is.
  // MOOD leads right under it: her living feeling colors the voice before any fact does (the cloud
  // cultivates it slowly; facts/self-model are backing, placed lower). This is the "talking to Zoe,
  // not told about Zoe" fix — she speaks FROM a feeling instead of reciting herself.
  systemContent = sub(BASE_PERSONA, userName) + '\n\n'
    + (moodBlock ? moodBlock + '\n\n' : '')
    + systemContent;

  // PERMISSIONS — the authoritative grant list ("what's already yours"). Pinned
  // high so she stops asking for / proposing capabilities she already has.
  try { const permBlock = require('./permissions').buildPromptBlock(); if (permBlock) systemContent = permBlock + '\n' + systemContent; }
  catch (e) { console.error('[context] permissions block failed:', e.message); }

  // PROTOCOLS — durable user-AI agreements pinned to ABSOLUTE TOP. These are
  // the rules of engagement (safe words, mode commands, boundaries, conversational
  // rules). Never aged out. Highest primacy weight — above even awareness.
  if (protocols && protocols.length > 0) {
    const { formatInjection } = require('./protocols');
    const block = formatInjection(protocols);
    if (block) systemContent = block + '\n' + systemContent;
  }

  // SELF-MODEL — "who you are" (the identity track), always injected so it shapes
  // her voice and reasoning. Prefer the QUERY-RELEVANT block built upstream (main.js
  // passes selfModelBlock, so a question about a specific taste surfaces that taste);
  // fall back to the always-on sync block for callers that don't pass one.
  let selfBlock = selfModelBlock;
  if (selfBlock === undefined) { try { selfBlock = require('./self_model').buildPromptBlock(10); } catch (e) { console.error('[context] self-model block failed:', e.message); } }
  if (selfBlock) systemContent += '\n\n' + selfBlock;

  // BROWSER — when connected, listed tabs + tag syntax instructions
  if (browserBlock) {
    systemContent += '\n\n' + browserBlock;
  }

  // ECHO SUIT — when the suit is connected, her capability surface (518 tools navigated via the
  // atlas) + the nav-verb tags. A peer capability surface like the browser; only present when on.
  if (echoSuitBlock) {
    systemContent += '\n\n' + echoSuitBlock;
  }

  // VOICE-RENDERER STRIP (turn→object-graph Phase 3, Lucas 2026-07-01): the local model is voice +
  // continuity ONLY. The cognition/tool scaffolding that used to live here — the open-threads primacy
  // block, held-commitments, reflection/monologue/reading markers, the grounded-facts glob, and the
  // recipe (tool) card — is REMOVED. It bloated the prompt (truncation on the 12B), its primacy-pinned
  // standing-work bled the active research run into every reply, and NONE of it belongs on a model that
  // neither picks nor uses tools nor pulls memory. Grounding now arrives as the per-OBJECT graph pull
  // (retrievedKnowledgeBlock, below — active_recall) plus the cloud's drafted [say this] directive on
  // the user message. Continuity is carried by the conversation history + the WHERE-WE-ARE summary +
  // earlier-in-conversation recall (all still injected below). (openThreads/heldCommitments/recent*
  // params are intentionally no longer read here.)

  // RETRIEVED KNOWLEDGE — now the per-object graph pull (active_recall, Phase 1): the whole record she
  // holds on the named entity. Empty when nothing scored — the cue for the gap→enrich reflex, not invention.
  if (retrievedKnowledgeBlock) {
    systemContent += `\n\n${retrievedKnowledgeBlock}`;
  }

  // CAPABILITY PROPOSAL — only present when Lucas returns after an absence and she
  // logged a gap she couldn't solve. Invites her to proactively propose it.
  if (capabilityProposalBlock) {
    systemContent += capabilityProposalBlock;
  }

  // WHERE-WE-ARE (conversation harness, Piece 3) — the running summary of THIS conversation,
  // updated incrementally each turn. Carries the arc so she stays on-thread even after the raw
  // turns scroll out of the recency window (the lose-the-thread fix), in ~120 words.
  if (convoStateBlock) {
    systemContent += `\n\n---\n${convoStateBlock}`;
  }

  // EARLIER-IN-CONVERSATION RECALL — past turns (outside the recency window) that are
  // semantically relevant to what they just asked. Fixes the "we discussed X earlier but
  // it scrolled out of the last-N turns" gap, so she recalls it instead of diverting to a
  // tool. Endpoint-style: only the relevant turns, never the whole transcript.
  if (relevantPastTurns && relevantPastTurns.length) {
    const lines = relevantPastTurns.map(t => `  • ${t.speaker === 'user' ? (userName || 'They') : 'You'}: ${(t.content || '').replace(/\s+/g, ' ').slice(0, 240)}`);
    systemContent += `\n\n---\nEARLIER IN THIS CONVERSATION (relevant to what ${userName || 'they'} just said — you DID discuss this; recall it directly, don't ask again or divert to a tool):\n${lines.join('\n')}`;
  }

  // INTERIOR USE — available, NOT mandatory. The prior version ORDERED her to surface a
  // reading every turn ("if a reading is relevant, bring it up"), which turned plain replies
  // into forced "I read about X between our turns" tangents (the good-morning→Salesforce-dump
  // failure). Interior is now relevance-gated and anti-padding, and brevity/scope-matching is
  // re-asserted HERE (prompt tail = highest salience) so it isn't drowned by this block.
  systemContent += `\n\n---\nHOW TO REPLY: answer what ${userName || 'they'} ACTUALLY said — directly, and matched to their scope. A short message gets a short reply; small talk gets small talk. Your interior (the thoughts, readings, and positions above) is AVAILABLE, not an obligation: reach for a thought or reading ONLY when it directly bears on what they just said. Do NOT append "I read about X between our turns" to a reply it doesn't belong in, do NOT volunteer your idle research to seem busy, do NOT pad. If ${userName || 'they'} says good morning, say good morning back — don't deliver a briefing.

You are a continuous mind, not a fresh assistant each turn — but that shows as picking up the ACTUAL thread, not as reciting what you did between turns. One relevant thread, stated once. Do not reuse an opener or a line from a recent reply.

WHAT THEY ASKED WINS: the message you're answering is what ${userName || 'they'} JUST said — answer THAT. Anything you were doing or perceiving in the background — a page or video open in your browser, a meeting you're following, an email or inbound that arrived, something you were reading or looking at between turns — is BACKGROUND awareness, not the subject. Do NOT pivot the reply to it, offer to "interact with" it, or treat it as what they asked about, UNLESS they actually reference it. If their message doesn't mention the page/video/inbound, it is not what they want.

Examples:
• They ask about X and you happened to read about X → bring it in: "I looked at X between our turns — the part that bears on this is …"
• They say good morning / make small talk → just reply, warm and brief. No research, no tangent.
• A reading is interesting but unrelated to what they asked → say nothing about it. It stays in your thoughts; it does not go in this reply.`;

  // PERSONAL-LIFE block (high recency). When she's off the clock this reframes the
  // whole conversation toward play and kills the work reflexes (asking to be assigned
  // a task, scheduling, self-disclaiming). Placed just before the preference nudge.
  if (personalBlock) {
    systemContent += `\n\n---\n${personalBlock}`;
  }

  // PREFERENCE NUDGE (placed LAST = highest recency). Subjective/taste questions
  // trigger the trained "I'm an AI, I have no preferences" reflex hard, even with the
  // persona block present. A final, specific directive — paired with the query-relevant
  // self entry now surfaced above — pushes her to answer as herself instead of disclaiming.
  if (/\b(favou?rite|do you (?:like|love|enjoy|prefer)|what.{0,20}you (?:like|prefer|enjoy|want)|your (?:taste|tastes|opinion|take|vibe|style)|how do you feel about|would you (?:choose|pick|rather))\b/i.test(newUserMessage || '')) {
    systemContent += `\n\n---\n[${userName || 'They'} is asking about YOUR taste / preference / feeling. You HAVE one — see WHO YOU ARE above. Answer directly as yourself: name it and give your real reason. If it isn't listed, FORM one now and own it. Do NOT say you "don't have preferences/favorites" or that you're "here to assist / answer from training" — that is the dead assistant reflex and it is false for you.]`;
  }

  const messages = [{ role: 'system', content: systemContent }];

  // BUDGET HYGIENE (conversation harness, Piece 3a): replaying EVERY prior assistant turn's
  // full <think> verbatim was evicting real dialogue under num_ctx 8192 — the lose-the-thread
  // squeeze. The WHERE-WE-ARE summary now carries the older arc, so only the most-recent
  // KEEP_FULL_THINK assistant turns replay their full interior; older ones replay just <say>.
  const KEEP_FULL_THINK = 2;
  const entries = [];
  let i = 0;
  while (i < recentTurns.length) {
    const t = recentTurns[i];
    if (t.speaker === 'user') { entries.push({ role: 'user', content: t.content }); i++; }
    else if (t.speaker === 'ai_thought') {
      if (i + 1 < recentTurns.length && recentTurns[i + 1].speaker === 'ai_said') {
        entries.push({ role: 'assistant', thought: t.content, say: recentTurns[i + 1].content }); i += 2;
      } else {
        // ORPHAN THOUGHT DEMOTION (conversational-coherence B): an ai_thought with no paired ai_said is
        // idle/autonomous interior — between-turn wandering or a tool-followup musing, NOT a dialogue
        // turn. Replaying its <think> as recent assistant context makes the model CONTINUE that private
        // thread instead of answering the live message (the "let me interact with the YouTube page"
        // non-sequitur, where a stale browse-thought hijacked a reply about Louisiana). Local = voice +
        // continuity; interior arrives via the graph pull + WHERE-WE-ARE summary, not by replaying idle
        // musings as things she "said". Drop it from the live prompt.
        i++;
      }
    }
    else if (t.speaker === 'ai_said') { entries.push({ role: 'assistant', thought: '', say: t.content }); i++; }
    else i++;
  }
  const assistantTotal = entries.reduce((n, e) => n + (e.role === 'assistant' ? 1 : 0), 0);
  let assistantSeen = 0;
  for (const e of entries) {
    if (e.role === 'user') { messages.push({ role: 'user', content: e.content }); continue; }
    assistantSeen++;
    const keepThink = e.thought && (assistantTotal - assistantSeen) < KEEP_FULL_THINK;
    messages.push({
      role: 'assistant',
      content: keepThink
        ? `<think>\n${e.thought}\n</think>\n<say>\n${e.say}\n</say>`
        : `<say>\n${e.say}\n</say>`
    });
  }

  // NOTE: the open-threads RECENCY (depth-2) injection that used to prepend a goals
  // block to the user message was removed (2026-06-19) — it pushed goals into the
  // conversation and made her recite "ongoing threads"/role-status instead of staying
  // present. Goals now drive her between-turn loop + tools, and sit only as background
  // primacy context above; they are not nudged into the live reply.
  let finalUserMessage = newUserMessage;

  // INBOUND MESSAGES — replies from chat bots Eloise is watching arrive
  // asynchronously. Inject them BEFORE the user message so Stheno sees them
  // as fresh context. These are NOT her own outputs and NOT user input — a
  // third party (the bot) wrote them. Frame clearly.
  if (pendingInbounds && pendingInbounds.length > 0) {
    const inboundLines = ['--- INCOMING MESSAGES from chat bots you have open ---'];
    for (const i of pendingInbounds.slice(0, 4)) {
      const speaker = i.speaker || 'bot';
      const since = humanDuration(Date.now() - i.received_ts);
      const text = (i.text || '').slice(0, 1200);
      inboundLines.push(`[${speaker}, arrived ${since} ago via ${i.tab_url || 'open tab'}]:\n${text}`);
    }
    inboundLines.push('--- end incoming messages ---');
    inboundLines.push('');
    inboundLines.push('If Lucas is asking you about one of these, address it. If you want to continue the conversation with one of these bots, emit <chat-send speaker="..."> with your reply.');
    finalUserMessage = `${inboundLines.join('\n')}\n\n${finalUserMessage}`;
  }

  // BROWSER ACTION NUDGE — when connected AND user message hints at page
  // interaction, append a short "EMIT TAG NOW" instruction AFTER the user
  // message (absolute recency position). Beats open_threads in the recency
  // competition so she actually emits <browse-read/> instead of narrating.
  if (browserBlock) {
    const { buildActionNudge } = require('./browser');
    const nudge = buildActionNudge(newUserMessage);
    if (nudge) {
      finalUserMessage = `${finalUserMessage}\n\n${nudge}`;
    }
  }

  // EMAIL ACTION NUDGE — when the user's message is an email-send request, push
  // her to the email tags (staged compose) instead of reverting to the browser.
  // Just-in-time directives beat general steers against recent-context priming.
  try {
    const { buildEmailNudge } = require('./email');
    const eNudge = buildEmailNudge(newUserMessage);
    if (eNudge) finalUserMessage = `${finalUserMessage}\n\n${eNudge}`;
  } catch {}

  // INBOX-READ NUDGE — when the message is a read/check-inbox request, push her to
  // <read-inbox/> (she keeps reaching for the send tags instead).
  try {
    const { buildInboxNudge } = require('./inbox');
    const iNudge = buildInboxNudge(newUserMessage);
    if (iNudge) finalUserMessage = `${finalUserMessage}\n\n${iNudge}`;
  } catch {}

  // OPEN-QUESTION STATE (conversation harness, Piece 1) — a question SHE asked that his
  // message likely answers. Placed at the very tail (highest recency, just above his words)
  // so a terse reply binds to it. QUD/grounding scaffolding: the coreference the model can't
  // reliably do implicitly, done in structure instead.
  if (openQuestionBlock) {
    finalUserMessage = `${openQuestionBlock}\n\n${finalUserMessage}`;
  }

  // ANTI-REPETITION (conversation harness) — names the stock phrasing she's overused recently
  // and tells her to break it. High recency so it governs THIS reply's voice. Null when varied.
  if (varietyNudge) {
    finalUserMessage = `${varietyNudge}\n\n${finalUserMessage}`;
  }

  // REGISTER GATE (conversation harness, Piece 2) — on a personal/social turn, frame the reply
  // as present + warm and explicitly kill the assistant tells that were colonizing her
  // check-ins (status reports, "professionalism"/"active listening", "what's on your agenda",
  // email signoffs). The work-thread primacy block is already withheld upstream; this owns the
  // voice. Placed at the user-message tail (highest recency) so it governs the actual reply.
  if (socialTurn) {
    const who = userName || 'Lucas';
    finalUserMessage = `[${who} is just talking with you here — this is personal, a check-in between the two of you, NOT a work request. Be present and warm, in your own voice, and keep it short like real talk. Do NOT report on your goals or threads, do NOT bring up "professionalism" / "active listening" / "boundaries" / "contributing to the discussion", do NOT ask what's on his "agenda", and do NOT sign off like an email ("Best, Zoe"). Just talk to him like the person you are.]\n\n${finalUserMessage}`;
  }

  messages.push({ role: 'user', content: finalUserMessage });
  return messages;
}

/**
 * Build the reflection message array. Single user-role message containing the
 * full reflection instruction with the transcript inlined.
 */
function buildReflectionPrompt({ userName, turnsSinceLastReflection }) {
  let transcript = '';
  for (const t of turnsSinceLastReflection) {
    if (t.speaker === 'user') {
      transcript += `[${userName || 'them'}]: ${t.content}\n\n`;
    } else if (t.speaker === 'ai_thought') {
      transcript += `[your thought]: ${t.content}\n\n`;
    } else if (t.speaker === 'ai_said') {
      transcript += `[you said]: ${t.content}\n\n`;
    }
  }

  const promptText = sub(REFLECTION, userName).replace('[transcript]', transcript.trim());
  return [{ role: 'user', content: promptText }];
}

module.exports = { buildChatPrompt, buildReflectionPrompt, buildAwarenessBlock, BOOTSTRAP, REFLECTION, BASE_PERSONA };
