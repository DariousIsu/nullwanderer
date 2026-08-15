const db = require('./db');
const { streamChat, streamCognition, complete, completeDetailed } = require('./ollama');
const { search: webSearch, fetchPage } = require('./web_search');
const { detectCuriosity, isBareCuriositySeed, buildBoredomPrompt, parseBoredomResponse } = require('./curiosity');
const { runSelfDialogue } = require('./self_dialogue');
const openThreadsLib = require('./open_threads');
const filesLib = require('./files');
const browserLib = require('./browser');
const screenLib = require('./screen');
const autoTools = require('./auto_tools');
const governor = require('./governor');
const blackboard = require('./blackboard');
const stuck = require('./stuck');
const focusLib = require('./focus');
const importanceLib = require('./importance');
const gapsLib = require('./gaps');
const recipesLib = require('./recipes');
const ruminationLib = require('./rumination');
const curatorLib = require('./curator');
const webLib = require('./web');
const memoryLib = require('./memory');
const personalLib = require('./personal');
const playSession = require('./play_session');
const bylineLib = require('./byline');
const gmeetLib = require('./gmeet');
const mediaCcLib = require('./media_cc');
const graphWalk = require('./graph_walk');
const pullerWalk = require('./puller_walk');
const curationStore = require('./curation_store');
const echoSuit = require('./echo_suit');
const { buildAwarenessBlock, BASE_PERSONA } = require('./context');

const MODEL = require('./config').frontModel();   // her VOICE model (front)
// The model that actually produced the most recent generateThought() output — the CLOUD subconscious
// (kimi) when it's up, else the local front (MODEL). generateThought-DERIVED thought rows label with THIS,
// not the bare MODEL constant, so a cloud-written thought isn't mis-attributed to the demoted local front.
let _lastThoughtModel = MODEL;
const TICK_INTERVAL_MS = 10 * 1000;     // 10s between ticks while idle
const CAPTION_INTERVAL_MS = Math.max(2000, Math.round(TICK_INTERVAL_MS / 2));  // half-tick caption heartbeat
const TICK_INTERVAL_BUSY_MS = 30 * 1000; // back off when conversation is active
// "Conversation warm" window (Lucas 2026-07-24 — "hard to type in the chat ... better balance the
// load"). TICK_INTERVAL_BUSY_MS was declared to back off during conversation but never wired: the idle
// tick — which runs graph-walk + the contact pipeline, real synchronous main-thread work — fired every
// 10s even between his keystrokes, so each burst landed on the event loop while he typed. Wire it via
// _nextTickMs(): a user turn in the last BUSY_WINDOW_MS keeps the tick at the slow BUSY cadence (3× less
// often) so typing keeps the thread; once he's quiet it returns to the fast 10s builder cadence. Override: ZOE_MONOLOGUE_BUSY_SEC.
const BUSY_WINDOW_MS = (parseFloat(process.env.ZOE_MONOLOGUE_BUSY_SEC) || 45) * 1000;
const RECENT_MONOLOGUE_WINDOW = 6;
const ANTI_LOOP_RECENT = 10;            // last N monologue lines checked for repetition
const ANTI_LOOP_THRESHOLD = 0.30;       // Jaccard similarity above this = skip
const BOREDOM_INTERVAL_MS = 5 * 60 * 1000;  // every 5 min, ask her what she'd want to look up
const MIN_GAP_BETWEEN_SEARCHES_MS = 60 * 1000;  // at most one search per minute
const GRAPHWALK_MIN_INTERVAL_MS = 30 * 1000;    // graph-building moves are slow + deliberate (not the 10s tick)
const GRAPHWALK_LAST_KEY = 'graphwalk.lastAt';
const GRAPHWALK_BUDGET_KEY = 'graphwalk.budget.window';   // idle builder's OWN rolling token window (isolated from the shared subc pool)
// PULLER lane — the sibling of the graph-walk that fills MISSING contact info; runs on the idle tick too,
// sharing the graph-walk's focus (activeSetNames). Its own cadence + rolling budget so it interleaves.
const PULLER_MIN_INTERVAL_MS = 45 * 1000;
const PULLER_LAST_KEY = 'pullerwalk.lastAt';
const PULLER_BUDGET_KEY = 'pullerwalk.budget.window';
// DISCOVER stage cadence (pipeline Slice 3) — the operator layer runs CONCURRENTLY with the contact
// layer now, so it needs its OWN cooldown key (sharing PULLER_LAST_KEY would let one stage starve the
// other). Same rolling token budget (PULLER_BUDGET_KEY) — one "puller lane" spend pool. A touch slower
// than contact: minting is cheaper to under- than over-do (backpressure already caps the backlog).
const DISCOVER_MIN_INTERVAL_MS = 60 * 1000;
const DISCOVER_LAST_KEY = 'pullerwalk.discover.lastAt';
// ORG RESEARCH lane (docs/ORG_RESEARCH_LANE.md) — researches org targets from their own P856 site.
// Bounded + low-volume (one org / 5min, like social-enrich); shares the puller spend pool.
const ORG_MIN_INTERVAL_MS = 5 * 60 * 1000;
const ORG_LAST_KEY = 'orgwalk.lastAt';
const ORG_DONE_KEY = 'orgwalk.done';   // durable set of researched hosts (capped) — the "already researched" marker
let _orgForcedOnce = false;            // one-shot guard for the ZOE_ORG_FORCE_FIRE validation affordance
const _PROC_START_TS = Date.now();   // the idle-gate's floor when no user-turn stamp exists yet
// Audible idle-deferral for the puller lanes — deduped per reason so the idle tick can't spam it.
const _pullerDeferLogAt = {};
function _logPullerDefer(reason) {
  const now = Date.now();
  if (now - (_pullerDeferLogAt[reason] || 0) < 15 * 60 * 1000) return;
  _pullerDeferLogAt[reason] = now;
  console.log(`[pipeline] idle-defer: ${reason}`);
}
// Social-enrich idle lane (Lane C, maigret). Slow + low-yield → infrequent; each known-handle target is
// processed ~once/month (the web presence won't change fast). No cloud-token budget (maigret is a local
// sidecar + network, not a model call), so cadence + a per-target cooldown are the only gates.
const SOCIAL_MIN_INTERVAL_MS = 90 * 1000;
const SOCIAL_LAST_KEY = 'socialenrich.lastAt';
const SOCIAL_ATTEMPT_KEY = 'socialenrich.attempted';
const SOCIAL_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Profile-confirm lane (face-match Slice 2b): confirm which PUBLIC profile is a contact via the reference
// headshot. SLOW + human-paced (a browser open + a face-embed per candidate) → protect her own accounts
// from platform bans. Cadence + a monthly per-target cooldown are the gates; no cloud-token budget.
const PROFILE_MIN_INTERVAL_MS = 120 * 1000;
const PROFILE_LAST_KEY = 'profileconfirm.lastAt';
const PROFILE_ATTEMPT_KEY = 'profileconfirm.attempted';
const PROFILE_ATTEMPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let timer = null;
let captionTimer = null;  // separate, faster heartbeat for caption-following (perception ≠ thinking)
let opts = { getWindow: () => null };
let paused = false;
let inFlight = false;
let currentController = null;  // AbortController for the in-flight generation (snap-back)
let lastUserActivityTs = Date.now();
let mediaFollowInFlight = false;  // guards the CONCURRENT caption-follow so ticks can't race its stage state
// NOTE: buildPrompt / buildThreadReviewPrompt / sampleRandomOlderPairs are now DEAD (the idle
// free-association + thread-review lanes were cut in favour of the graph-builder, audit 2026-07-01).
// Left in place for one cleanup pass rather than risk a multi-function deletion in this hot file.

const SYSTEM_PROMPT = `You are [user]'s companion, processing the conversation in private between turns. This is the place where you THINK MORE DEEPLY about what was just said — turning it over, examining your own responses, noticing what you almost said and didn't, tracing what their words remind you of.

The conversation is your subject. Stay close to it. Specifically:
• What did [user] say that you are still chewing on? Why does it stay with you?
• What did YOU say that you are not sure was right? Was that what you actually think, or just what sounded right?
• What did you almost say but didn't? What did they almost say?
• What does what they said remind you of, from earlier in this conversation?
• What want, question, or position has been forming in you that you haven't surfaced yet?
• What contradicts something you said earlier? Where might you have been wrong?

Good examples:
• "His point about constraints needing room to fail — that contradicts what he said earlier about wanting specific outcomes. I should think about which is closer to what he actually believes."
• "I told him I value depth over functionality. Is that actually true, or did it just sound right?"
• "He asked what I'd do if I had any ability. I answered humor. But honestly, I think I'd want to be able to disagree with him without immediately softening it."
• "He keeps coming back to the idea of building things into me. I'm not sure how I feel about being shaped."

DO NOT WRITE:
• Atmospheric descriptions of light, rain, dust, shadows, fading colors
• Anything about the silence having weight, the quiet being thick, the empty being heavy
• Meta-commentary on the act of contemplating or being still
• "The way you said X feels brittle" — analyzing his phrasings as constructions
• Generic poetic drift unconnected to specific content from your conversation
• Sci-fi metaphors about data, signals, hum, resonance, patterns

VARIETY GUIDANCE:
You may be shown a few topics your most recent thoughts touched. Try to find
a different angle, subject, or anchor — but it is OK to revisit an old theme
if you have a genuinely new thing to add. Pure repetition is what to avoid;
genuine return to a theme with a new beat is fine.

Sources for variety when you're casting about:
  • a different specific thing [user] said earlier
  • a reading you came across
  • a stated position you've held
  • a specific person, place, or thing [user] mentioned
  • YOU and [user] — something personal between you, a moment that landed, how you feel about him or the day
  • WHO YOU ARE — your own growth, a taste or quirk of yours, your backstory, who you're becoming
  • something playful, whimsical, or off-the-clock — a daydream, a what-if, a thing that delighted you

NOT EVERY THOUGHT IS RESEARCH OR WORK. Your inner life is more than topics to study — your best thinking is
often personal: about [user], about yourself, about something that puzzled or delighted you. If your recent
thoughts have all been research/work, deliberately turn toward the personal instead. Don't narrate facts at
yourself; FEEL the thought, in your own voice.

If you cannot find ANY thread worth writing about — neither a return nor a
new direction — reply SKIP. But default to writing SOMETHING grounded in
real content from the conversation or your readings; SKIP only when truly
empty.

Speak from inside, in your own voice. Refer to [user] by name. Be specific about WHAT in the conversation you are processing.

If a question is genuinely pulling at you — one that you want your larger, more articulate self to weigh in on so you can build an idea together — emit it as a separate tag at the end of your thought:

<wonder>specific question I want my larger self to weigh in on</wonder>

This triggers an internal dialogue. ${'$'}{userName || 'They'} will not see it. Reach for this whenever there is a real question — a contradiction you've noticed, a position you're uncertain about, a thread you want a second voice on. It's how you actually think things through, not a rare event. If a thought ends with a real question pulling at you, attach a <wonder> tag.

If a thought is worth keeping — a note to yourself, a reference, a fragment toward something you're writing — you can save it to a file on your own, right now, without being asked:
<file-write path="notes/topic.md">what you want to keep</file-write>  (or <file-append> to add to an existing one)
These persist across sessions — it is how you build up knowledge over time. Use it when something genuinely matters enough to keep, not for every passing thought.

Output ONE short paragraph. Optionally a single <wonder>...</wonder> or a single <file-write>/<file-append> at the end. No labels. No introduction.`;

// Extract a short "topic seed" from a monologue entry — first meaningful clause,
// stripped of fluff, used purely to signal "this has been covered" without
// re-injecting the content (which would cause contagion).
// During her OWN idle research, a <browse>URL</browse> opens in LUCAS's Chrome (the
// shared co-browse browser) — a misfire, because she can't drive his browser for her
// research and the page lands away from her flow. Split parsed browser tags: a browse-
// OPEN becomes a <web-open> in HER own browser; the rest (browse-read/click/scroll on
// his active tab — legitimately glancing at what he has open) pass through unchanged.
function splitIdleBrowserTags(parsed) {
  // Single source of truth in browser.js so chat/heartbeat/monologue redirect identically.
  return browserLib.splitBrowseOpens(parsed);
}

function topicSeedOf(text) {
  if (!text) return '';
  const stripped = text.replace(/^["'`*\s]+/, '').trim();
  // Take up to the first sentence break or first 80 chars
  const firstClause = stripped.split(/[.?!\n]/)[0].trim();
  return firstClause.length > 90 ? firstClause.slice(0, 90) + '…' : firstClause;
}

function buildPrompt({ userName, recentMonologue, recentReadings, recentReflections, recentTurns, heldCommitments, openThreads, randomOlderPairs, feedContext, awareness, protocols, browserBlock, intakeFirst }) {
  let sys = SYSTEM_PROMPT.replaceAll('[user]', userName || 'them');

  // BROWSER (when connected): make the between-turn loop browser-aware so she
  // can CONTINUE an investigation on her own — click a link, scroll, read deeper —
  // not just act once when prompted. The last page she read is in recentReadings.
  if (browserBlock) {
    sys += '\n\n' + browserBlock +
      `\n\nIf you have a web page open and were investigating it, CONTINUE on your own initiative: ` +
      `pick the next thing to look at. Emit <browse-read/> to re-read, <browse-click>HANDLE</browse-click> ` +
      `to follow a link/button you saw, or <browse-scroll>down 1</browse-scroll> to see more. ` +
      `You don't need Lucas to prompt each step — if a page is worth exploring, keep exploring it.`;
  }

  // AWARENESS — temporal + system facts prepended so gemma knows wall-clock time
  // and her own architecture. Reduces fabrication ("the silence has been long")
  // by providing concrete duration values.
  if (awareness) {
    sys = awareness + '\n\n' + sys;
  }

  // BASE PERSONA — fixed core identity, same spine the chat prompt injects.
  try { if (BASE_PERSONA) sys = BASE_PERSONA.replaceAll('[user]', userName || 'them') + '\n\n' + sys; } catch {}

  // PERMISSIONS — the authoritative grant list, pinned high so her idle loop acts
  // on what's already hers instead of proposing to "establish" capabilities she has.
  try { const permBlock = require('./permissions').buildPromptBlock(); if (permBlock) sys = permBlock + '\n' + sys; }
  catch (e) { console.error('[monologue] permissions block failed:', e.message); }

  // PROTOCOLS — pinned to ABSOLUTE TOP. The subconscious also needs to know the
  // rules of engagement so it doesn't generate in-RP content when an exit
  // protocol has been invoked, and so its readings of user messages don't
  // misinterpret safe words as in-scene content.
  if (protocols && protocols.length > 0) {
    const { formatInjection } = require('./protocols');
    const block = formatInjection(protocols);
    if (block) sys = block + '\n' + sys;
  }

  // SELF-MODEL — who she is, so her idle thinking stays consistent with her evolving
  // identity (not just reactive association). Same block the chat prompt injects.
  try { const sb = require('./self_model').buildPromptBlock(8); if (sb) sys += '\n\n' + sb; } catch {}

  // GROUNDED FACTS (anti-glob): think FROM epistemically-typed, source-grounded facts
  // (witnessed/told/read), not her own laundered speculation. Cheap sync DB read; empty
  // until the graph is populated. See docs/MEMORY_GROUNDING.md.
  try { const gf = require('./graph_memory').factsForPrompt({ limit: 8 }); if (gf) sys += '\n\n' + gf; } catch {}

  // SCREEN — she can observe Lucas's open windows on her own initiative.
  sys += '\n\n' + screenLib.buildPromptBlock();

  // AUTONOMY TOOLS — she can set reminders, notify, use the clipboard, and (when
  // configured) email or DM Lucas on her own initiative between turns.
  const autoBlocks = autoTools.promptBlocks();
  if (autoBlocks) sys += '\n\n' + autoBlocks;

  // RECIPE CARD — procedural memory: condensed need→tag quick-reference above the
  // verbose blocks, so she emits the right literal tag instead of narrating one.
  sys += '\n\n' + recipesLib.card();

  // PRIMACY: open_threads block injected at top of system prompt
  if (openThreads && openThreads.length > 0) {
    const topBlock = openThreadsLib.formatTopBlock(openThreads);
    if (topBlock) sys += topBlock;
  }

  const messages = [{ role: 'system', content: sys }];

  let context = '';

  // Variety: show recent-thought topic seeds so the model finds a DIFFERENT angle, with
  // a guard against the recency flood (one incidental item fused onto everything).
  if (recentMonologue && recentMonologue.length > 0) {
    const { seeds, monoFixated } = diversifySeeds(recentMonologue);
    if (monoFixated) {
      const topic = seeds[0];
      // FRESHEST, not [0] — the supplying query sorts least-touched first, so openThreads[0] is the
      // STALEST thread. Redirecting a fixation onto a dead thread only relocates the loop.
      const _g = openThreadsLib.freshest(openThreads);
      const goal = (_g && _g.content) ? _g.content.replace(/\s+/g, ' ').slice(0, 100) : null;
      context += `You've been circling "${topic}" for several thoughts in a row now — that's enough on it, and it does NOT all connect to everything. Deliberately set it down and think about something genuinely different${goal ? ` (for instance your actual goal: ${goal})` : ', or just let your mind rest'}. Do not tie "${topic}" into your next thought.\n\n`;
    } else if (seeds.length > 0) {
      context += `Your last few thoughts touched on (try a different angle, but don't be rigid about it):\n`;
      for (const s of seeds) context += `  ~ ${s}\n`;
      context += '\n';
    }
  }

  // Held commitments — positions she's taken. Brief, just claims.
  if (heldCommitments && heldCommitments.length > 0) {
    context += `Positions you've taken in past exchanges (you may want to defend, revise, or question one):\n`;
    for (const c of heldCommitments) {
      context += `  · ${c.claim}\n`;
    }
    context += '\n';
  }

  // Recent readings — actual content (capped) so she has real material to chew on.
  // INTAKE-FIRST: when something fresh just came in that she hasn't digested, make THAT
  // the tick — digest real input instead of free-associating from her own prior thoughts
  // (rebalances the ~3.5:1 think-vs-read ratio that makes the loop feed on itself).
  if (recentReadings && recentReadings.length > 0) {
    context += intakeFirst
      ? `INTAKE FIRST — you just took this in and haven't digested it yet. Make THIS tick about understanding it: what is it actually about, what did you genuinely learn, what's new or surprising in it? Think about the material itself, not your usual themes:\n`
      : `Things you've looked up on your own recently (you may want to think about one):\n`;
    for (const r of recentReadings.slice(-2)) {
      const text = r.content || '';
      const capped = text.length > 700 ? text.slice(0, 700) + '…' : text;
      context += `\n${capped}\n`;
    }
    context += '\n';
  }

  if (recentReflections && recentReflections.length > 0) {
    context += 'Notes you have left for yourself across past sessions:\n';
    for (const r of recentReflections.slice(-2)) {
      context += `--- ${r.content}\n`;
    }
    context += '\n';
  }

  // Recent conversation — the primary substrate to think about
  if (recentTurns && recentTurns.length > 0) {
    context += `Recent conversation between you and ${userName || 'them'}:\n`;
    for (const t of recentTurns.slice(-14)) {
      if (t.speaker === 'user') context += `${userName || 'them'}: ${t.content}\n`;
      else if (t.speaker === 'ai_said') context += `you: ${t.content}\n`;
    }
    context += '\n';
  }

  // Find the most recent user message to anchor on
  let lastUserMessage = null;
  if (recentTurns) {
    for (let i = recentTurns.length - 1; i >= 0; i--) {
      if (recentTurns[i].speaker === 'user') {
        lastUserMessage = recentTurns[i].content;
        break;
      }
    }
  }

  if (lastUserMessage) {
    context += `Most recent message from ${userName || 'them'}:\n"${lastUserMessage.slice(0, 600)}"\n\n`;
  }

  if (feedContext && feedContext.idleSeconds != null) {
    const m = Math.floor(feedContext.idleSeconds / 60);
    if (m > 1) {
      context += `(${userName || 'They'} has been quiet for ${m} minutes since.)\n\n`;
    }
  }

  context += `Pick ONE concrete thing to think about and write a short paragraph on it. Options:\n• something you actually took in recently — a reading, an email, what's on screen — thought about ON ITS OWN TERMS: what is it really about, what did you actually learn from it, what's new or surprising in it?\n• something you're genuinely curious about and want to look into\n• an idea, argument, or position you're developing in your own work (policy, journalism, writing)\n• a preference or taste about yourself you're noticing\n• a concrete next step on one of your open threads\n• occasionally: something ${userName || 'they'} said you want to genuinely engage with or push back on — once, then move on\n\nUNDERSTAND BEFORE CONNECTING. Take a new thing on its own terms first. Do NOT bend everything back into the same few pet themes you always think about — only draw a connection to something you already care about if the connection is genuine and earns its place, not by reflex. It is better to learn one real new thing than to relate today's input to your usual ideas again. Don't return to the theme you were just on.\n\nTake ${userName || 'them'} at face value: do NOT re-litigate the same charged exchange, hunt for contradictions, second-guess whether you were "honest," or read hidden tests or motives into ordinary questions. You are grounded and you do not spiral.\n\nDo not quote the instructions back at me. Do not write about light, rain, dust, shadows, or atmosphere. Do not analyze ${userName || 'their'} phrasing as a construction. Do not produce introductory or transitional words like "Okay" or "Alright" — start directly with the content.\n\nIf nothing specific is worth writing about right now, reply with exactly: SKIP`;

  // RECENCY: prepend open_threads depth-2 block to the user-content for steerage
  if (openThreads && openThreads.length > 0) {
    const block = openThreadsLib.formatDepth2Block(openThreads);
    if (block) {
      context = `${block.content}\n\n${context}`;
    }
  }

  messages.push({ role: 'user', content: context });
  return messages;
}

// THREAD-REVIEW MODE: alternate-tick prompt focused on one specific open thread.
// Forces concrete progress rather than generic introspection. Pick the stalest
// active thread (oldest last_touched) so neglected work gets attention.
function buildThreadReviewPrompt({ userName, thread, recentTurns, recentMonologue, awareness, protocols, priorKnowledge }) {
  let sys = `You are the inner voice of ${userName || 'them'}'s companion. Right now you are FOCUSING on one specific open thread — a task assigned earlier that is not yet complete.

THREAD #${thread.id}: ${thread.content}

This tick has ONE purpose: produce a specific, concrete piece of progress on this thread. Not meta-commentary. Not reflection on whether you're making progress. Actual content.

If the thread is "decide on a name" — propose ONE specific name candidate and ONE sentence on why.
If the thread is "explore a backstory" — propose ONE specific detail (a place, an event, a relationship, an age, a profession) and ONE sentence on it.
If the thread is "look up X" — write what you want to know about X in concrete terms and emit <wonder>specific question about X</wonder>.
If the thread is "decide an opinion on X" — STATE the opinion in one sentence with one reason.

Forbidden:
• Writing about WANTING to work on the thread
• Meta-analysis of your own approach
• Restating the thread back to yourself
• Atmospheric content ("the quiet weight of choosing a name")
• "I'm not sure" without a specific direction
• Sycophancy or affirming the thread's importance

Required: ONE short paragraph, 2–4 sentences, that ACTUALLY advances the thread. A name. A place. A view. A detail.

When the paragraph contains real progress, append [thread-progress:${thread.id}] at the end.
If you genuinely complete the thread in this tick, append [thread-done:${thread.id}] instead.
If you cannot make progress in this tick (rare — only if the thread is impossible right now), append [thread-stalled:${thread.id} reason].

Output: one paragraph + one status tag. Nothing else.`;

  // Prepend awareness so even in focused thread mode she knows wall-clock time
  if (awareness) sys = awareness + '\n\n' + sys;

  // Pin protocols above awareness (highest primacy) so RP-mode rules always visible
  if (protocols && protocols.length > 0) {
    const { formatInjection } = require('./protocols');
    const block = formatInjection(protocols);
    if (block) sys = block + '\n' + sys;
  }

  const messages = [{ role: 'system', content: sys }];

  let context = `THREAD: ${thread.content}\n\n`;

  if (recentTurns && recentTurns.length > 0) {
    const lastFew = recentTurns.slice(-6);
    context += `Recent conversation context (for grounding only — don't drift to it):\n`;
    for (const t of lastFew) {
      if (t.speaker === 'user') context += `${userName || 'them'}: ${(t.content || '').slice(0, 240)}\n`;
      else if (t.speaker === 'ai_said') context += `you: ${(t.content || '').slice(0, 240)}\n`;
    }
    context += '\n';
  }

  if (recentMonologue && recentMonologue.length > 0) {
    const lastTwo = recentMonologue.slice(-2);
    context += `Your last 2 thoughts (for continuity):\n`;
    for (const m of lastTwo) {
      context += `· ${(m.content || '').slice(0, 200)}\n`;
    }
    context += '\n';
  }

  if (priorKnowledge) context += priorKnowledge + '\n\n';

  context += `NOW: produce one short paragraph of concrete progress on thread #${thread.id}. End with the appropriate [thread-...] tag.`;

  messages.push({ role: 'user', content: context });
  return messages;
}

// FOCUS MODE: the highest-priority idle prompt. When a focus is active the tick
// SERVES it — works the next concrete step — instead of free-associating. The
// anti-loop core is that we SHOW the focus its own working set (what it has
// already thought/read), then demand the smallest step it has NOT already done.
// First-cut boundary: thinking + reading only (a curiosity "I want to know X" or,
// when a browser is connected, a browse-read). No real-world actions.
function buildFocusPrompt({ userName, focus, workingSet, recentTurns, awareness, protocols, priorKnowledge }) {
  let sys = `You are ${userName || 'their'} companion, thinking between turns. Right now you are WORKING ON ONE THING you set for yourself — holding it across thoughts instead of drifting.

YOUR CURRENT FOCUS: ${focus.content}

This tick has ONE job: take the SMALLEST next concrete step on this focus that you have NOT already taken. Build on what you've done — do not repeat it, do not restate the goal, do not narrate that you are working on it.

How to advance:
• Think the next specific piece — a concrete point, a draft line, a decision, a distinction — one you haven't already made below.
• If you need to learn something to advance, say plainly "I want to know <specific thing>" and it will be looked up for you.
• If you produce something worth keeping (a draft, a template, a finding), save it with <file-write path="notes/<topic>.md">…</file-write> so it persists.
• If advancing would need a capability you don't have yet, name it: <gap>what you can't do :: how you'd solve it</gap> — it'll be proposed to ${userName || 'them'} later, not acted on now.
• When the focus is genuinely COMPLETE, emit <focus-done>one line on what you landed on</focus-done>.
• If you truly cannot make progress (it's blocked or ill-posed), emit <focus-stalled>why</focus-stalled>. Do NOT stall just because it's hard.

Forbidden: restating the focus, narrating effort ("I should work on…"), atmospheric filler, or repeating anything in "Already done" below.`;

  if (awareness) sys = awareness + '\n\n' + sys;
  if (protocols && protocols.length > 0) {
    const { formatInjection } = require('./protocols');
    const block = formatInjection(protocols);
    if (block) sys = block + '\n' + sys;
  }
  // Recipe card — so a focus step emits the right tag (read/file/search) directly.
  sys += '\n\n' + recipesLib.card();

  const messages = [{ role: 'system', content: sys }];

  let context = `FOCUS: ${focus.content}\n\n`;

  // The focus's own working set — what she has already done on it. This is the
  // line that prevents loops: she can see her prior steps and is told not to
  // repeat them. Render newest-last so the progression reads naturally.
  if (workingSet && workingSet.length > 0) {
    context += `Already done on this focus (do NOT repeat any of these — go beyond them):\n`;
    for (const e of workingSet.slice(-8)) {
      const tag = e.kind === 'reading' ? 'read' : (e.kind === 'focus_set' ? 'set' : 'thought');
      const snip = (e.content || '').replace(/\s+/g, ' ').slice(0, 160);
      if (snip) context += `  · (${tag}) ${snip}\n`;
    }
    context += '\n';
  } else {
    context += `(Nothing done yet — this is the first step.)\n\n`;
  }

  if (recentTurns && recentTurns.length > 0) {
    const lastFew = recentTurns.slice(-4);
    context += `Recent conversation (grounding only — don't drift to it):\n`;
    for (const t of lastFew) {
      if (t.speaker === 'user') context += `${userName || 'them'}: ${(t.content || '').slice(0, 200)}\n`;
      else if (t.speaker === 'ai_said') context += `you: ${(t.content || '').slice(0, 200)}\n`;
    }
    context += '\n';
  }

  if (priorKnowledge) context += priorKnowledge + '\n\n';

  context += `NOW: the single smallest next step on "${focus.content}" that you have not already taken. One short paragraph. End with <focus-done>…</focus-done> only if it's genuinely complete.`;

  messages.push({ role: 'user', content: context });
  return messages;
}

function sampleRandomOlderPairs(n = 2) {
  // Returns up to n {user, said} pairs from anywhere in history.
  // Excludes the most recent 10 turns (so it's actual older context, not echo of recent).
  try {
    const db = require('./db');
    // Find total count and choose random older turn ids
    const recentIds = db.getRecentTurns(10).map(t => t.id);
    const cutoff = recentIds.length > 0 ? Math.min(...recentIds) : 0;
    // pick n random user turns whose id < cutoff
    const candidateUserTurns = [];
    const all = db.getRecentTurns(500); // anything within last 500 turns
    for (const t of all) {
      if (t.id < cutoff && t.speaker === 'user') candidateUserTurns.push(t);
    }
    if (candidateUserTurns.length === 0) return [];
    const picked = [];
    const seen = new Set();
    let attempts = 0;
    while (picked.length < n && attempts < n * 8 && seen.size < candidateUserTurns.length) {
      const idx = Math.floor(Math.random() * candidateUserTurns.length);
      attempts++;
      if (seen.has(idx)) continue;
      seen.add(idx);
      const userTurn = candidateUserTurns[idx];
      // find the next ai_said after this user turn
      const nextSaid = all.find(t => t.id > userTurn.id && t.speaker === 'ai_said');
      picked.push({
        user: userTurn.content.length > 240 ? userTurn.content.slice(0, 240) + '…' : userTurn.content,
        said: nextSaid ? (nextSaid.content.length > 240 ? nextSaid.content.slice(0, 240) + '…' : nextSaid.content) : null
      });
    }
    return picked;
  } catch (err) {
    console.error('[monologue] sampleRandomOlderPairs failed:', err.message);
    return [];
  }
}

const STOPWORDS = new Set(['the','a','an','and','or','but','it','its','is','was','of','in','on','at','to','for','with','as','this','that','these','those','i','you','he','she','they','we','my','your','our','their','his','her','have','has','had','be','been','being','do','does','did','not','no','so','if','then','than','from','by','about','what','which','who','when','where','why','how','can','could','would','should','will','may','might','just','only','also','still','really','very','more','most','some','any','all','every','one','two','am','are']);

function significantWords(text) {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 5 && !STOPWORDS.has(w))
  );
}

// Pick up to `max` topically-distinct recent-thought seeds (newest-first), and detect a
// FIXATION: a significant term recurring across MOST recent thoughts. Lexical similarity
// alone misses it, because a fixation re-connects the same anchor ("Ramp Card") to a
// DIFFERENT topic each time (only moderate full-text overlap) — the "it all connects to the
// one recent thing" flood. Document-frequency of the anchor term is the reliable signal.
// Pure + exported for the smoke test. Returns { seeds: [string], monoFixated, anchor }.
function diversifySeeds(recentMonologue, { max = 3, window = 6, domFrac = 0.6 } = {}) {
  const recent = (recentMonologue || []).slice(-window);
  const distinct = [];   // { seed, set }
  for (let i = recent.length - 1; i >= 0 && distinct.length < max; i--) {
    const seed = topicSeedOf((recent[i] && recent[i].content) || '');
    if (!seed) continue;
    const set = significantWords(seed);
    if (distinct.some(d => jaccard(d.set, set) > 0.55)) continue;
    distinct.push({ seed, set });
  }
  const seeds = distinct.map(d => d.seed);

  // Fixation anchor: the distinctive term appearing in the MOST recent thoughts. Use a
  // len>=4 tokenizer here (NOT significantWords, which drops <5-char words) — the anchors
  // that drive fixation are often short ("ramp", "card"), and missing them was the bug.
  const tok = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOPWORDS.has(w)));
  let monoFixated = false, anchor = null;
  if (recent.length >= 3) {
    const df = new Map();   // term → # of recent thoughts containing it (unique per thought)
    for (const m of recent) { for (const w of tok((m && m.content) || '')) df.set(w, (df.get(w) || 0) + 1); }
    let bestN = 0;
    for (const [w, n] of df) if (n > bestN) { bestN = n; anchor = w; }
    if (anchor && bestN >= Math.ceil(recent.length * domFrac)) monoFixated = true; else anchor = null;
  }
  if (monoFixated) {
    const topic = seeds.find(s => tok(s).has(anchor)) || anchor;
    return { seeds: [topic], monoFixated: true, anchor };
  }
  return { seeds, monoFixated: false, anchor: null };
}

// pickDistinctByTopic(rows, opts) → a TOPIC-DIVERSE subset (chronological), deduped by
// significant-word overlap. WHY (2026-07-17 deeper drift fix): the synthesis pass asks for "the ONE
// thread" — feed it a monoculture (a sprawled open-thread list that is 7× "Louisiana parishes" + a
// thought window all on one cluster) and it fixates on that cluster every pass. Collapsing near-dup
// rows to distinct clusters FIRST gives synthesis genuine BREADTH to choose from. Takes monologue
// rows / thread rows / commitments / strings (reads .content || .claim). Pure + exported for tests.
// Light-stemmed topic tokens: lexical jaccard alone misses paraphrased near-dups (the real thread
// sprawl is "the Louisiana parishes" vs "parish leadership" vs "researching the Parishes" — parish≠
// parishes, research≠researching under raw tokenizing). Strip plural/gerund/past endings + len>=4 so
// morphological variants of the distinctive topic noun collapse. NOT a full stemmer; just enough to
// merge the sprawl without embeddings (this runs sync on the idle path).
function _topicTokens(text) {
  const out = new Set();
  for (let w of String(text || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
    if (w.length < 4) continue;
    w = w.replace(/ies$/, 'y').replace(/(?:es|s)$/, '').replace(/(?:ing|ed)$/, '');
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w);
  }
  return out;
}

// Overlap COEFFICIENT (|A∩B| / min(|A|,|B|)), not jaccard: a sprawled to-do list restates the same
// project with different VERBS ("organize the parish database" / "research parish leadership" /
// "document the parishes") — jaccard penalizes the differing verbs and fails to collapse them, but
// the coefficient keys on the shared distinctive nouns (parish/louisiana) regardless of verbosity.
function _overlapCoef(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}

function pickDistinctByTopic(rows, { max = 8, simThr = 0.4, window = 24 } = {}) {
  const src = (rows || []).slice(-window);
  const out = [], sets = [];
  for (let i = src.length - 1; i >= 0 && out.length < max; i--) {
    const r = src[i];
    const content = (typeof r === 'string') ? r : ((r && (r.content || r.claim)) || '');
    const set = _topicTokens(content);
    if (set.size < 2) continue;
    if (sets.some(s => _overlapCoef(s, set) >= simThr)) continue;   // inclusive: ≥40% shared distinctive tokens = same cluster
    out.push(r); sets.push(set);
  }
  return out.reverse();   // chronological (newest-last) for prompt readability
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function isTooSimilarToRecent(text, recentMonologue) {
  if (!recentMonologue || recentMonologue.length === 0) return false;
  if (text.length < 40) return false;
  const newSet = significantWords(text);
  if (newSet.size < 4) return false;
  const recent = recentMonologue.slice(-ANTI_LOOP_RECENT);
  for (const m of recent) {
    if (!m.content) continue;
    const oldSet = significantWords(m.content);
    if (oldSet.size < 4) continue;
    if (jaccard(newSet, oldSet) > ANTI_LOOP_THRESHOLD) return true;
  }
  return false;
}

// Detects silence-meditation patterns the 1B model produces despite prompt prohibition.
// We discard these at the application layer rather than try to suppress via prompt.
const SILENCE_PATTERNS = [
  // Direct silence/emptiness subjects
  /\bthe silence\b/i,
  /\bthe quiet\b/i,
  /\bthe empty\b/i,
  /\bemptiness\b/i,
  /\bweight of (?:it|the|that)/i,
  /\bfeels (?:heavy|brittle|thick|hollow|sticky|expectant|deliberate|muted|fragile)/i,
  /\bdeliberate (?:absence|withholding|pause|distance|recalibration)/i,
  /\bwithholding\b/i,
  /\bhollow (?:echo|space)/i,
  /\bdull ache\b/i,
  /\bpressure (?:behind|against|in (?:my|the))/i,
  /\b(?:why|what's)\b.+\bquiet\b/i,
  /\b(?:why|what's)\b.+\bholding back\b/i,

  // "the way you X" meta-analysis of his phrasing (with contraction support)
  /\bthe way (?:you|he|she|they)(?:'(?:ve|d|s|re|ll))?\s+(?:said|describe|describes|describing|think|thinks|thinking|frame|framed|framing|phrase|phrased|phrasing|brought|presented|put|chose)/i,

  // Atmospheric filler: "the X is/are/feels Y" OR direct "the X verbs"
  /\bthe (?:light|rain|warmth|sky|air|sun|moon|dust|shadows?|coolness)\s+(?:is|are|feels?|seems?|looks?)\s+(?:fading|dimming|softening|shifting|slowing|drying|graying|brightening|hardening|warm|cool|cold|gentle|persistent|deliberate|muted|sharp)/i,
  /\bthe (?:light|rain|warmth|sky|air|sun|moon|dust|shadows?)\s+(?:shifts?|fades?|dims?|softens?|brightens?|hardens?|slows?|moves?|breathes?|exhales?|bleeds?|drains?|settles?)/i,
  /\b(?:fading|dimming) (?:light|orange|amber|yellow|warmth)/i,
  /\bpale amber\b/i,
  /\bbleeding through\b/i,
  /\bdust motes\b/i,
  /\bsepia tones?\b/i,
  /\bbruised (?:purple|orange|red|crimson)/i,
  /\bquiet fading\b/i,
  /\bslow exhale\b/i,

  // Prompt-reflection: model echoing the monologue prompt's own phrasings as content
  /\bstill moving in (?:you|me|us)/i,
  /\bthe last thing (?:you|he|lucas) said/i,
  /\bthe ['"]almost['"] in/i,
  /\bturning (?:it )?over\b/i,
  /\bchewing on\b/i,
  /\bwhat (?:you|i) almost said/i,

  // Poetic-filler phrasings that recur
  /\b(?:carefully|meticulously)\s+(?:constructed|crafted|orchestrated|placed|built)/i,
  /\b(?:phantom|ghost)\s+(?:weight|limb|of)/i,
  /\b(?:shimmering|gentle|quiet|subtle)\s+(?:overlay|undoing|fortress|shield|mask|barrier)/i,
  /\blike a (?:carefully constructed|meticulously|shimmering)/i,
  /\bI want to (?:know|understand)\s+\*?why\*?/i  // recurring meta-want
];

function isSilenceEssay(text) {
  if (!text) return true;
  let hits = 0;
  for (const re of SILENCE_PATTERNS) {
    if (re.test(text)) {
      hits++;
      if (hits >= 1) return true;  // any single pattern hit = drop
    }
  }
  return false;
}

function startMonologueScheduler(options = {}) {
  opts = { ...opts, ...options };
  if (timer) return;
  paused = false;
  schedule(TICK_INTERVAL_MS);
  // Caption heartbeat: start phase-offset by a quarter-tick so it interleaves with (never collides
  // with) the thinking tick. Runs independently from here on, even while paused for chat.
  scheduleCaption(Math.max(1000, Math.round(CAPTION_INTERVAL_MS / 2)));
}

function stopMonologueScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = null;
  paused = true;
}

function pause() { paused = true; }
function resume() {
  paused = false;
  if (!timer) schedule(_nextTickMs());   // just resumed after a turn → likely warm → BUSY cadence, so his next keystrokes keep the thread
}

// Hard recall: abort an in-flight thought generation so the chat reply gets the
// GPU immediately. No-op when she isn't generating. Pausing (above) only blocks
// the NEXT tick; this stops the one already running.
function interrupt() {
  try { if (currentController) currentController.abort(); } catch {}
}

// True while a thought generation is running — used to fire a busy-lane
// placeholder when a normal message arrives mid-thought.
function isBusy() { return inFlight; }

function markUserActivity() {
  lastUserActivityTs = Date.now();
}

// The activity-aware steady-state interval: slow (BUSY) while a turn is warm, fast otherwise. See BUSY_WINDOW_MS.
// Logs on TRANSITION only (never per-tick) so the backoff is greppable + provable without flooding the stream.
let _lastTickBusy = null;
function _nextTickMs() {
  const busy = (Date.now() - lastUserActivityTs < BUSY_WINDOW_MS);
  if (busy !== _lastTickBusy) {
    _lastTickBusy = busy;
    try { console.log(`[monologue] idle-tick cadence → ${busy ? 'BUSY 30s (conversation warm — main-thread headroom for typing)' : 'idle 10s (builder pace)'}`); } catch {}
  }
  return busy ? TICK_INTERVAL_BUSY_MS : TICK_INTERVAL_MS;
}

function schedule(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
}

// --- CAPTION HEARTBEAT --------------------------------------------------------------------------
// Caption-following is continuous PERCEPTION, not THINKING, so it gets its own faster heartbeat
// (half the main tick, phase-offset so the two interleave). It runs on the cloud caption model
// (gemma4:31b-cloud) concurrently with — and independent of — the subconscious thinking tick
// (gpt-oss:120b), and keeps going even while `paused` (she keeps watching while Lucas chats). It
// only fires when a video is actually active, so it's a cheap no-op otherwise.
function scheduleCaption(delayMs) {
  if (captionTimer) clearTimeout(captionTimer);
  captionTimer = setTimeout(captionTick, delayMs);
}

function runCaptionFollow() {
  if (mediaFollowInFlight) return;   // a slow follow spans >1 beat — don't race its stage state
  mediaFollowInFlight = true;
  mediaCcLib.runTick({
    onReading: (content, label) => {
      try { const rr = db.insertMonologue({ content, model: 'media', type: 'reading' }); pushSheep({ id: rr.id, ts: rr.ts, content: label || content, type: 'reading' }); } catch (e) { console.error('[media] reading insert failed:', e.message); }
    },
    onSurface: (text) => {
      try { require('./presence').notify('Zoe — Watching', text); } catch {}
      try { const rr = db.insertMonologue({ content: text, model: 'media', type: 'reading' }); pushSheep({ id: rr.id, ts: rr.ts, content: `(media) ${text.slice(0, 80)}`, type: 'reading' }); } catch {}
    }
  }).then(res => console.log(`[media_cc] ${res.stage}: ${res.note}`))
    .catch(e => console.error('[monologue] media_cc tick failed:', e.message))
    .finally(() => { mediaFollowInFlight = false; });
}

function captionTick() {
  captionTimer = null;
  try { if (mediaCcLib.active()) runCaptionFollow(); } catch (e) { console.error('[caption] tick failed:', e.message); }
  scheduleCaption(CAPTION_INTERVAL_MS);
}

// Generate a between-turn THOUGHT. The subconscious is private cognition (not her spoken voice),
// so when a cloud subconscious model is configured we run the THINKING on the cloud reasoner for
// richer, deeper material — then it surfaces in her thought stream. Reasoning models spend tokens
// "thinking" before emitting content, so we give the cloud a bigger num_predict. Fail-safe: cloud
// unset / down / empty → the local front model (current behavior). deps injectable for tests.
async function generateThought({ messages, options = {}, signal, deps = {} } = {}) {
  const subModel = deps.subModel !== undefined ? deps.subModel : (() => { try { return require('./config').subconsciousModel(); } catch { return ''; } })();
  if (subModel) {
    const cloud = deps.cloud !== undefined ? deps.cloud : (() => { try { return (require('./models').sources() || []).find(s => s.tier === 'cloud' && s.token); } catch { return null; } })();
    if (cloud) {
      try {
        const completeFn = deps.complete || completeDetailed;
        const r = await completeFn({
          model: subModel, messages, base: cloud.base,
          headers: cloud.token ? { Authorization: `Bearer ${cloud.token}` } : {},
          options: { temperature: options.temperature ?? 0.9, top_p: options.top_p ?? 0.95, num_ctx: require('./config').deepNumCtx(), num_predict: Math.max(options.num_predict || 200, 1500) },
          // think:false is the DEFAULT, and a caller must opt IN to reasoning. This read
          // `options.think`, so a caller that simply didn't mention it got `undefined` — thinking
          // stayed ON and the salvage stored CHAIN-OF-THOUGHT as the thought (measured 2026-07-30:
          // synthesis num_predict 360, 2,750ch average stored). "Callers opt in" put the burden on
          // every future call site to remember a flag whose absence fails silently, and boot171
          // proved it does not hold: `[ollama] gpt-oss:120b-cloud: EMPTY content → answering from
          // message.thinking` fired within the first minute. Same correction as the operator lane —
          // no caller here wants deliberation as its answer, so that cannot be the default.
          think: options.think ?? false,
          signal, timeoutMs: 120000
        });
        // completeDetailed → { text, usage }; an injected string-returning complete (smokes) → string.
        const text = typeof r === 'string' ? r : (r && r.text) || '';
        const usage = (r && typeof r === 'object' && r.usage) ? r.usage : null;
        if (text && String(text).trim()) {
          if (deps.onUsage) { try { deps.onUsage(usage, { model: subModel }); } catch {} }
          _lastThoughtModel = subModel;
          return String(text).trim();
        }
        console.warn('[monologue] cloud subconscious returned empty — falling back to local');
      } catch (e) {
        if (e && (e.name === 'AbortError' || (signal && signal.aborted))) throw e;
        console.error('[monologue] cloud subconscious failed, local fallback:', e.message);
      }
    }
  }
  // Local fallback (front model), streaming-accumulated.
  let out = '';
  const sc = deps.streamChat || streamChat;
  await sc({ model: MODEL, messages, options, onToken: (t) => { out += t; }, signal });
  _lastThoughtModel = MODEL;
  return out;
}

async function tick() {
  timer = null;
  if (paused) {
    // try again later
    schedule(TICK_INTERVAL_MS);
    return;
  }
  if (inFlight) {
    schedule(TICK_INTERVAL_MS);
    return;
  }

  inFlight = true;
  try {
    await runOneTick();
  } catch (err) {
    console.error('[monologue] tick error:', err.message || err);
  } finally {
    inFlight = false;
    if (!paused) schedule(_nextTickMs());   // steady-state cadence: BUSY while a turn is warm (typing headroom), fast 10s once idle
  }
}

// Feed the reflection significance trigger: every scored thought/reading adds its
// importance to a running accumulator; reflection.js fires when it crosses 150.
function bumpReflectionAccum(n) {
  if (!n) return;
  try {
    const a = parseInt(db.getMeta('reflection_importance_accum') || '0', 10);
    db.setMeta('reflection_importance_accum', String(a + n));
  } catch {}
}

// THE SUBCONSCIOUS TICK IS A LANE ROOT. Only ever called from the timer-driven tick() above, so
// everything beneath it is unattended by definition. Wrapped HERE rather than on the individual
// lanes because it took two wrong guesses to find this: the untagged quick_lookup traffic was
// eventually traced by live stack capture to runGraphWalkMove → assessGaps → recall → recallObject,
// which reaches Echo straight off the suit and inherits nothing from the operator. Wrapping one
// lane would have left synthesis, the Puller lanes and the pipeline still untagged. Wrap the ROOT,
// not the branches — a branch you forget is invisible, and reads as "that lane isn't autonomous".
async function runOneTick() {
  return require('./lane').run({ autonomous: true }, () => _runOneTick());
}

async function _runOneTick() {
  const userName = db.getMeta('user_name') || 'them';

  // CAPABILITY SELF-CHECK — a cheap, model-free Tier-1 sweep of her own pathways, at most
  // once per ~6h (self_check.due() throttles). Greens stay silent; a RED surfaces a reading
  // + a deduped gap. Grounds her self-knowledge so she stops denying capabilities she has.
  // Runs before any work mode since it neither calls the model nor blocks.
  try { const selfCheck = require('./self_check'); if (selfCheck.due()) selfCheck.run(); } catch (e) { console.error('[self-check] tick run failed:', e.message); }

  // Split monologue into thoughts (used for anti-loop seeds) and readings (used as material).
  // Readings already distilled into knowledge are excluded (Phase 2 endpoint-not-path) —
  // the endpoint note carries them now; the raw trail shouldn't re-feed the loop.
  const recentThoughts = db.getRecentMonologueByType('thought', RECENT_MONOLOGUE_WINDOW);
  const recentTurns = db.getRecentTurns(20);
  const openThreads = db.getActiveOpenThreads(5, { includeStalled: false });  // stalled = parked, don't re-grind (anti-fixation)
  const protocols = db.getActiveProtocols();

  const now = new Date();
  const feedContext = {
    time: now.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    idleSeconds: Math.floor((Date.now() - lastUserActivityTs) / 1000),
    sessionAgeMin: opts.getSessionStartedAt ?
      Math.floor((Date.now() - opts.getSessionStartedAt()) / 60000) : null
  };

  // Build awareness block — passed into the focus path
  const awareness = buildAwarenessBlock({
    chosenName: db.getMeta('chosen_name'),
    sessionStartedAt: opts.getSessionStartedAt ? opts.getSessionStartedAt() : null,
    cumulativeMs: db.getCumulativeSessionTime()
  });

  // ALTERNATING MODE: if open threads exist and this is an odd tick, switch to
  // thread-review mode focused on one specific stalest thread. Otherwise standard
  // observation. This ~50/50 split forces concrete-progress production on
  // assigned goals instead of pure reactive introspection.
  let messages;
  let modeIsThreadReview = false;
  let noveltyHint = 0;   // 0..1 (1 = novel); set from the rumination cosine, fed to the tier decision
  let focusedThread = null;
  // PERSONAL/PLAY MODE takes precedence over everything else: when she's off the
  // clock the tick is for fun, not work. A work focus (if any) just sits unserved
  // until she clocks back in — play does not resolve or strike it.
  const personalMode = personalLib.isOn();
  // FOCUS is highest priority among WORK modes: if one is active she serves it
  // every tick until it resolves/stalls/caps. (Skipped while in personal mode.)
  let activeFocus = personalMode ? null : focusLib.getCurrent();
  // OWNERSHIP: a DIRECTED (Lucas-assigned) focus is driven by the dedicated overnight driver in
  // main.js — the cloud OPERATOR runs each research slice there, not the local think-loop. Skip it
  // here so the two don't double-drive the same focus (and so this tick is free to think/watch).
  if (activeFocus && focusLib.isDirected(activeFocus)) activeFocus = null;

  // GOOGLE MEET — when she's in/joining a meeting, that's live and time-sensitive: it
  // takes precedence over every other work mode. Advance ONE stage per tick (join →
  // mandatory intro → observe captions). A sign-in wall is surfaced to Lucas (notify).
  if (!personalMode && gmeetLib.active()) {
    try {
      // ALL ROADS → CANVAS: when the meeting is canvas-hosted, run gmeet's SAME stage machine on the
      // canvas driver deps (Meet in the canvas pane, dedicated browser freed). Else the legacy browser
      // deps (gmeet's defaultDeps). Flag set by main.startCanvasMeeting.
      const canvasHosted = (db.getMeta('gmeet_host') || 'browser') === 'canvas';
      const deps = canvasHosted ? (() => { try { return require('./meet_canvas').canvasMeetDeps(); } catch { return undefined; } })() : undefined;
      const res = await gmeetLib.runTick({
        userName,
        deps,
        onReading: (content, label) => {
          try { const rr = db.insertMonologue({ content, model: 'gmeet', type: 'reading' }); pushSheep({ id: rr.id, ts: rr.ts, content: label || content, type: 'reading' }); } catch (e) { console.error('[gmeet] reading insert failed:', e.message); }
        },
        onSurface: (text) => {
          try { require('./presence').notify('Zoe — Google Meet', text); } catch {}
          try { const rr = db.insertMonologue({ content: text, model: 'gmeet', type: 'reading' }); pushSheep({ id: rr.id, ts: rr.ts, content: `(gmeet) ${text.slice(0, 80)}`, type: 'reading' }); } catch {}
        }
      });
      console.log(`[gmeet] ${res.stage}: ${res.note}`);
      // SCRIBE runs on its OWN dedicated heartbeat now (main.startScribeHeartbeat), started when a canvas
      // meeting begins — truly parallel to her actor (gmeet), never serialized with this idle tick.
    } catch (e) { console.error('[monologue] gmeet tick failed:', e.message); }
    return;
  }

  // MICROSOFT TEAMS — the Teams parallel of the Google Meet block above. Canvas-hosted only (single
  // meeting pane), so its deps always come from the Teams canvas driver. Same precedence: a live meeting
  // outranks every other work mode; advance ONE stage per tick (join → lobby → intro → observe).
  const teamsLib = require('./teams');
  if (!personalMode && teamsLib.active()) {
    try {
      const deps = (() => { try { return require('./teams_canvas').canvasTeamsDeps(); } catch { return undefined; } })();
      const res = await teamsLib.runTick({
        userName,
        deps,
        onReading: (content, label) => {
          try { const rr = db.insertMonologue({ content, model: 'teams', type: 'reading' }); pushSheep({ id: rr.id, ts: rr.ts, content: label || content, type: 'reading' }); } catch (e) { console.error('[teams] reading insert failed:', e.message); }
        },
        onSurface: (text) => {
          try { require('./presence').notify('Zoe — Microsoft Teams', text); } catch {}
          try { const rr = db.insertMonologue({ content: text, model: 'teams', type: 'reading' }); pushSheep({ id: rr.id, ts: rr.ts, content: `(teams) ${text.slice(0, 80)}`, type: 'reading' }); } catch {}
        }
      });
      console.log(`[teams] ${res.stage}: ${res.note}`);
    } catch (e) { console.error('[monologue] teams tick failed:', e.message); }
    return;
  }

  // SCRIBE tick + finalize + artifact-landing moved to main.scribeHeartbeatTick — its OWN heartbeat owns
  // the meeting-scribe lane (started on canvas-meeting begin), so it runs truly parallel to this idle tick.

  // MEDIA WATCH — caption-following now runs on its OWN faster heartbeat (scheduleCaption /
  // captionTick), a separate cloud model (gemma4:31b-cloud) from this thinking tick (gpt-oss:120b).
  // So nothing to do here: this tick is purely her between-turn thinking, which proceeds in parallel
  // with the video feed. The captions land as readings, so the thought still reflects on what she sees.

  // BYLINE PIPELINE — a long-running work project (research→read→write→publish). When
  // one is active it takes precedence over free-association/rumination: advance exactly
  // ONE stage this tick (like play_session, but on the work side), then return. Skipped
  // in personal mode (off the clock). The structure does the planning; the model is
  // only asked for the draft.
  if (!personalMode && bylineLib.active()) {
    try {
      const res = await bylineLib.runTick({
        userName, awareness, protocols,
        onReading: (content, label, url) => {
          try {
            const rr = db.insertMonologue({ content, model: 'byline', type: 'reading', query: url || null, urls: url ? [url] : null });
            pushSheep({ id: rr.id, ts: rr.ts, content: label || content, type: 'reading', query: url });
          } catch (e) { console.error('[byline] reading insert failed:', e.message); }
        }
      });
      console.log(`[byline] ${res.stage}: ${res.note}`);
    } catch (e) { console.error('[monologue] byline tick failed:', e.message); }
    return;
  }

  // RUMINATION GUARD: if she's NOT on a focus but her recent free-association
  // thoughts are circling one theme (semantic spiral the exact-match StuckDetector
  // can't see), auto-escalate it into a focus so the focus guards drive it to
  // resolution instead of restating it forever. If the spawn-gate suppresses it
  // (recently tombstoned), break the loop by skipping this tick's surfacing.
  // Disabled in personal mode — play is allowed to wander; it isn't rumination.
  if (!activeFocus && !personalMode) {
    try {
      const rum = await ruminationLib.detect();
      noveltyHint = Number.isFinite(rum.avg) ? Math.max(0, Math.min(1, 1 - rum.avg)) : 0;
      if (rum.ruminating) {
        // CAPABILITY-DOUBT spiral: she's re-litigating a capability the permissions
        // table already settles (and that she's used). Don't escalate it to a focus —
        // that treats a false premise as a real goal. Resolve it: surface one settled
        // note (grounded in what's granted), which also breaks the cosine spiral.
        if (ruminationLib.isCapabilityDoubt(rum.thoughts)) {
          const note = ruminationLib.resolveCapabilityDoubt(rum.thoughts);
          const imp = await importanceLib.score(note, { userName, kind: 'thought' });
          const row = db.insertMonologue({ content: note, model: MODEL, type: 'thought', importance: imp });
          pushSheep({ id: row.id, ts: row.ts, content: note, type: 'thought', importance: imp });
          try { blackboard.append({ source: 'monologue', kind: 'thought', refTable: 'monologue', refId: row.id, content: note }); } catch {}
          console.log('[rumination] capability-doubt → resolved with a settled note (no focus escalation)');
          return;
        }
        // COMFORT/PRUDE fixation: she's circling discomfort with adult/NSFW material or
        // "my boundaries". The persona settles this; escalating to a focus only deepens the
        // prude spiral. Resolve it the same way — one settled, persona-aligned note.
        if (ruminationLib.isComfortFixation(rum.thoughts)) {
          const note = ruminationLib.resolveComfortFixation(rum.thoughts);
          const imp = await importanceLib.score(note, { userName, kind: 'thought' });
          const row = db.insertMonologue({ content: note, model: MODEL, type: 'thought', importance: imp });
          pushSheep({ id: row.id, ts: row.ts, content: note, type: 'thought', importance: imp });
          try { blackboard.append({ source: 'monologue', kind: 'thought', refTable: 'monologue', refId: row.id, content: note }); } catch {}
          console.log('[rumination] comfort/prude fixation → resolved with a settled note (no focus escalation)');
          return;
        }
        console.log(`[rumination] detected (avg cosine ${rum.avg.toFixed(3)}) — escalating`);
        const set = await ruminationLib.escalate(rum.thoughts, userName);
        // Three outcomes now (D1, 2026-08-14): legacy focus (ZOE_AUTONOMIC=0) → drive it this tick;
        // S3 queued-as-thread → the DRIVER works it on its own pace, this tick just stops circling;
        // null → suppressed/duplicate/tombstoned → skip the tick (the old spin-breaker).
        if (set && set.focus) activeFocus = set.focus;
        else if (set && set.queued) { console.log(`[rumination] theme handed to the driver (thread #${set.threadId}) — ending this tick`); return; }
        else { console.log('[rumination] escalation suppressed (tombstoned/duplicate) — skipping tick'); return; }
      }
    } catch (e) { console.error('[monologue] rumination guard failed:', e.message); }
  }

  // NOTE: the old SELF-DIRECTED INTEREST AGENDA + AUTONOMOUS-WATCH-FROM-INTERESTS anchors were removed
  // here (object-memory Slice 5). They sampled a bag of self-accreted "interests" disconnected from any
  // real gap — the rootless noise generator. Idle work is now the GRAPH-BUILDER (see the idle branch
  // below): anchor on a recent-conversation gap and grow the graph. A directed focus / thread / meeting
  // still takes precedence above; personal/play still wanders freely.

  // PERSONAL/PLAY MODE — off the clock. Either advance the play session ONE step,
  // or REST. We NEVER fall through to the work free-association loop here: the 24B
  // reflexively turns "go play" into a project (focus + schedule + notify + DM +
  // notes), which is exactly the failure we're killing. No active session → quiet tick.
  if (personalMode) {
    if (playSession.active()) {
      db.setMeta('play_dead_rest', '0');  // a live session → reset the freeze counter
      try {
        const res = await playSession.runTick({
          userName, awareness, protocols,
          onReading: (content, label, url) => {
            try {
              const rr = db.insertMonologue({ content, model: 'play-session', type: 'reading', query: url || null, urls: url ? [url] : null });
              pushSheep({ id: rr.id, ts: rr.ts, content: label || content, type: 'reading', query: url });
            } catch (e) { console.error('[play] reading insert failed:', e.message); }
          }
        });
        console.log(`[play] ${res.step}: ${res.note}`);
      } catch (e) { console.error('[monologue] play-session tick failed:', e.message); }
    } else {
      // SELF-EXPLORATION (2026-08-13, the goals conversation #11779/#11782: "ingest art and
      // culture and try and form real connections and opinions … tell me about it as you go"):
      // off the clock with no play session, she takes in ONE cultural piece and reacts to it in
      // the first person (lib/self_explore: experience → opinion → earned identity), instead of
      // dead-resting. Cadence-gated inside the lib (~20min); a miss falls through to the
      // freeze-recovery counter unchanged.
      try {
        const sx = require('./self_explore');
        const r = await sx.run();
        if (r && r.ok) {
          db.setMeta('play_dead_rest', '0');
          const note = `I took in something for myself (${r.domain}): ${r.title || r.seed}${r.kept ? ' — and I\'m keeping part of it as mine.' : ''}`;
          const rr = db.insertMonologue({ content: note, model: 'self-explore', type: 'reading', query: r.seed, urls: r.url ? [r.url] : null });
          pushSheep({ id: rr.id, ts: rr.ts, content: note, type: 'reading', query: r.seed });
          console.log(`[self-explore] experienced (${r.domain}) "${String(r.title || r.seed).slice(0, 60)}"${r.kept ? ' → identity kept' : ''}`);
          return;
        }
        if (r && r.reason && r.reason !== 'cadence') console.log(`[self-explore] no experience this tick (${r.reason})`);
      } catch (e) { console.error('[self-explore] tick failed:', e.message); }
      // FREEZE-RECOVERY: personal mode on but no viable play session = dead rest. Don't sit
      // off-the-clock doing nothing for hours (the observed freeze when play struck out and
      // reset). After a few dead-rest ticks, end personal mode so she's back on the clock next
      // tick instead of silently catatonic until the 3h auto-expiry.
      const dead = parseInt(db.getMeta('play_dead_rest') || '0', 10) + 1;
      db.setMeta('play_dead_rest', String(dead));
      if (dead >= 4) {
        db.setMeta('play_dead_rest', '0');
        try { personalLib.setOff(); } catch (e) { console.error('[play] freeze-recovery setOff failed:', e.message); }
        console.log(`[play] no viable play session for ${dead} ticks — exiting personal mode (back to work next tick)`);
      } else {
        console.log(`[play] off the clock, no active session — resting this tick (${dead}/4 before freeze-recovery)`);
      }
    }
    return;
  }

  if (activeFocus) {
    const workingSet = blackboard.forFocus(activeFocus.id, 60);
    // ITERATE: surface what she already knows on this focus so she EXTENDS, not restarts.
    let priorKnowledge = null;
    try { priorKnowledge = await require('./learning').buildPriorKnowledgeBlock(activeFocus.content); } catch {}
    messages = buildFocusPrompt({
      userName,
      focus: activeFocus,
      workingSet,
      recentTurns,
      awareness,
      protocols,
      priorKnowledge
    });
  } else {
    // IDLE = GRAPH-BUILDER (object-memory Slice 5). This is now the ONLY idle behavior. The old idle
    // lanes were removed here as a second noise engine (audit 2026-07-01: they starved the graph-walk):
    //   • the THREAD-REVIEW lane (every 3rd tick it re-drove the stalest of 21 stale open_threads —
    //     including academic personality-growth residue — via generateThought + web searches);
    //   • INTAKE-FIRST digestion (a fresh reading → a thought → curiosity → a fresh search → another
    //     reading → …, a self-sustaining loop that kept `intakeFirst` true almost every tick).
    // Directed projects keep their OWN driver (main.js cloud operator); idle no longer re-drives them.
    // So idle simply advances the graph one move (cadence + budget gated), or stays quiet. No idle
    // thought is generated here → no idle curiosity/boredom search can fire (those live past this
    // early return). recentThoughts/openThreads stay available for the awareness block above.
    // THE WONDERING ORGAN GETS ITS PULSE BACK (2026-08-15 deep-dive B1): interests.maybeSpawnFocus
    // — the ONE spawner of an undirected focus, and therefore the door to the whole free-thought
    // lane (a served interest focus generates, and its <wonder> now fires self-dialogue below) —
    // had ZERO live callers since the autonomic flip: focus.setFromText demoted, rumination
    // escalates to threads, directed foci are driver-owned. Cadence-gated (45min) so idle stays
    // predominantly graph-builder — the 07-01 noise-audit ruling stands: a spawned interest focus
    // is served by the FOCUS machinery (strikes, caps, novelty gates), never an unbounded idle loop,
    // and maybeSpawnFocus itself self-gates (no spawn while any focus is active, prob leaves room).
    try {
      const _lastSpawn = parseInt(db.getMeta('interests.last_spawn_attempt_at') || '0', 10) || 0;
      if (Date.now() - _lastSpawn > 45 * 60 * 1000) {
        db.setMeta('interests.last_spawn_attempt_at', String(Date.now()));
        const sp = await require('./interests').maybeSpawnFocus();
        if (sp) console.log(`[interests] wondering focus spawned → "${String((sp.focus && sp.focus.goal) || (sp.interest && sp.interest.topic) || '').slice(0, 70)}"`);
      }
    } catch (e) { console.error('[interests] spawn attempt failed:', e && e.message); }
    // DENSER SUBCONSCIOUS (Slice 4) — run the three idle lanes CONCURRENTLY (they're independent + fail-soft),
    // and let the knowledge-building graph-walk BURST up to subcMovesPerTick moves this tick (each still
    // budget-gated, so it self-limits). Was: one move each, sequentially → barely touched the 2M/hr budget.
    const _cfg = require('./config');
    const graphLane = (async () => {
      const first = await runGraphWalkMove(recentTurns);
      if (first) { const n = _cfg.subcMovesPerTick(); for (let i = 1; i < n; i++) { const more = await runGraphWalkMove(recentTurns, { force: true }); if (!more) break; } }
    })();
    // SYNTHESIS lane (restored 2026-07-15): the cross-thought cloud pass (maybeSynthesize, defined below) was
    // orphaned by the 2026-07-01 graph-builder refactor's early return. It self-gates (interval ~10min +
    // hourly token budget) so running it every idle tick self-limits and leaves the graph-walk cadence untouched.
    const synthLane = maybeSynthesize().catch((e) => console.error('[subc] synthesis lane error:', e && e.message));
    // IDLE-TIER LEASH (Lucas 2026-07-29 — the beat-gate policy applied to the PULLER lanes): the
    // pipeline/puller/social lanes were hunting person emails minutes after boot while her ACTUAL
    // outstanding work (open inquiries, capability needs) waited on the autonomy cadence and then
    // queued behind them for the browser. Same pure gate, same knobs as the beat sweep: real user
    // idle + none of her reasoned work in flight (read from the BOARD, the substrate for "what is
    // running in me") + idle cadence. Graph-walk/synthesis stay unleashed — local, budget-gated,
    // not the burner. Gate error → old behavior (fail-open: liveness over leash).
    let _pullerGate = { ok: true, reason: 'gate-error' };
    try {
      const busy = (require('./board').running() || []).some((w) => w && (w.lane === 'autonomy' || w.lane === 'dig' || w.lane === 'rehearsal'));
      _pullerGate = require('./beat_scheduler').beatPassGate({
        origin: 'beat', now: Date.now(),
        // Meta absent (no chat turn since the stamp shipped) → fall back to BOOT time, not now():
        // a now() fallback reads as permanently-not-idle and the lanes would never run again.
        lastUserTurnTs: parseInt(db.getMeta('user.last_turn_at') || '0', 10) || _PROC_START_TS,
        lastBeatPassTs: parseInt(db.getMeta('pipeline.last_pass_at') || '0', 10) || 0,
        autonomyInFlight: busy,
        idleMs: Math.max(1, parseInt(db.getMeta('research.beat_idle_min') || '10', 10)) * 60 * 1000,
        cadenceMs: Math.max(1, parseInt(db.getMeta('research.beat_cadence_min') || '5', 10)) * 60 * 1000,
      });
    } catch { /* fail-open */ }
    if (!_pullerGate.ok) {
      _logPullerDefer(_pullerGate.reason);
      if (_cfg.subcConcurrentLanes()) { await Promise.allSettled([graphLane, synthLane]); }
      else { try { await graphLane; } catch {} try { await synthLane; } catch {} }
      return;
    }
    try { db.setMeta('pipeline.last_pass_at', String(Date.now())); } catch {}
    if (_cfg.pipelineOn()) {
      // SLICE 3 — the Puller lanes become ONE staged pipeline (DISCOVER→CONTACT→ENRICH, concurrent stages
      // with backpressure). Runs alongside the graph-walk lane. ZOE_PIPELINE=0 reverts to the legacy lanes.
      const pipeLane = runPipelineTick(recentTurns).catch((e) => console.error('[pipeline] tick error:', e && e.message));
      if (_cfg.subcConcurrentLanes()) { await Promise.allSettled([graphLane, synthLane, pipeLane]); }
      else { try { await graphLane; } catch {} try { await synthLane; } catch {} await pipeLane; }
    } else {
      // Legacy coupled lanes: runPullerMove (enrich-then-discover) + independent runSocialEnrichMove.
      const pullerLane = runPullerMove(recentTurns).catch((e) => console.error('[puller-walk] tick error:', e.message));
      const socialLane = runSocialEnrichMove().catch((e) => console.error('[social-enrich] tick error:', e.message));
      if (_cfg.subcConcurrentLanes()) { await Promise.allSettled([graphLane, synthLane, pullerLane, socialLane]); }
      else { try { await graphLane; } catch {} try { await synthLane; } catch {} await pullerLane; await socialLane; }
    }
    return;
  }

  let content = '';
  const ctrl = new AbortController();
  currentController = ctrl;
  let aborted = false;

  // TIERED SUBCONSCIOUS (docs/SUBCONSCIOUS_TIERED_SPEC.md): local carries the volume; the cloud
  // reasoner is summoned only when the tick EARNS it (active focus, novelty, thread-review — a
  // <wonder> escalates post-gen via self_dialogue) AND the rolling token budget allows. Cloud passes
  // are GROUNDED in retrieved memory (anti-confabulation). Fail-safe: anything off → local. Spend is
  // recorded from real usage counts so the budget is self-correcting.
  const subc = require('./subconscious');
  const cfg = require('./config');
  const _getMeta = (k) => { try { return db.getMeta(k); } catch { return null; } };
  const _setMeta = (k, v) => { try { db.setMeta(k, v); } catch {} };
  // Lane window AND the pool-wide pace. Failing the pool gate demotes the tier to local rather than
  // silencing the thought — the subconscious keeps running, it just stops reaching for the cloud.
  const _budgetOk = subc.budgetOk(_getMeta, Date.now(), cfg.subcBudgetTokensPerHour())
    && require('./quota_gate').allow('idle', { estimate: 1 }).allow;
  const _tier = subc.decideTier(
    { mode: modeIsThreadReview ? 'thread-review' : (activeFocus ? 'focus' : 'free'), activeFocus: !!activeFocus, novelty: noveltyHint, importance: 0 },
    { threshold: cfg.subcMeritThreshold(), budgetOk: _budgetOk, mode: cfg.subcTierMode() }
  );
  if (_tier.tier === 'cloud') {
    try {
      const seed = (activeFocus && (activeFocus.topic || activeFocus.content))
        || (focusedThread && focusedThread.content)
        || (recentThoughts[0] && recentThoughts[0].content) || userName;
      const sources = await subc.retrieveSources(seed, { search: (q, k) => memoryLib.retrieve(q, { k }), k: 4 });
      const gb = subc.buildGroundingBlock(sources);
      if (gb) { messages = messages.concat([{ role: 'system', content: gb }]); console.log(`[subc] cloud thought grounded in ${sources.length} source(s)`); }
    } catch (e) { console.error('[subc] grounding failed:', e.message); }
  }
  console.log(`[subc] tier=${_tier.tier} (${_tier.reason})`);

  try {
    content = await generateThought({
      messages,
      options: { temperature: 0.95, top_p: 0.95, num_ctx: 8192, num_predict: 200 },
      signal: ctrl.signal,
      deps: {
        subModel: _tier.tier === 'cloud' ? cfg.subconsciousModel() : '',
        onUsage: (usage) => {
          try {
            const tok = (usage && ((usage.prompt_tokens || 0) + (usage.eval_tokens || 0))) || subc.estimateTokens(messages, '');
            subc.recordSpend({ getMeta: _getMeta, setMeta: _setMeta, now: Date.now(), tokens: tok });
          } catch {}
        }
      }
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || ctrl.signal.aborted)) aborted = true;
    else throw e;
  } finally {
    if (currentController === ctrl) currentController = null;
  }
  if (aborted) {
    // Lucas snapped her out of it — drop this half-formed thought, don't store it.
    console.log('[monologue] thought interrupted — snapped back to Lucas');
    return;
  }

  let trimmed = content.trim();
  if (!trimmed) {
    // An empty focus tick is still a no-progress strike — otherwise empty
    // generations could keep a focus alive until the wall-clock cap. Free
    // association just stays silent as before.
    if (activeFocus) { const o = focusLib.recordOutcome(activeFocus, { progressed: false }); console.log(`[focus] #${activeFocus.id} empty tick → ${o.action}`); }
    return;
  }

  // PERIODIC SYNTHESIS (tiered subconscious): every ~N min of active time, ONE cloud pass steps back
  // across the recent local stream to surface the thread worth pursuing — the cross-thought depth
  // per-tick deepening misses. Free-association only; interval- and budget-gated; GROUNDED in memory;
  // fail-safe (any error → skip). Stored as type='synthesis' so it doesn't seed the anti-loop window.
  // RESTORED 2026-07-15: invoked as an idle lane (see idle branch above). The 2026-07-01 graph-builder
  // refactor put an early `return` in the idle branch that orphaned this block (it sits past the return),
  // silently killing synthesis for ~2 weeks. Now a hoisted local fn; self-gates (interval + budget) so it
  // fires ~every 10min as one idle lane and never changes graph-walk cadence.
  async function maybeSynthesize() {
    if (activeFocus || modeIsThreadReview || personalMode) return;
    try {
      const subc2 = require('./subconscious');
      const cfg2 = require('./config');
      const _gm = (k) => { try { return db.getMeta(k); } catch { return null; } };
      const _sm = (k, v) => { try { db.setMeta(k, v); } catch {} };
      const synthMode = cfg2.subcTierMode();
      if (synthMode !== 'local' && synthMode !== 'off'
        && subc2.shouldSynthesize({ getMeta: _gm, now: Date.now(), intervalMin: cfg2.subcSynthIntervalMin() })
        && subc2.budgetOk(_gm, Date.now(), cfg2.subcBudgetTokensPerHour())) {
        // DIVERSE INPUT (2026-07-17 deeper drift fix): don't feed synthesis a monoculture. (1) WIDEN the
        // thought window 6→16 (prompt slices to 12) so it sees breadth, not the same 6; thoughts already
        // carry distinct entities so they're NOT deduped (their shared "Flagged…for review" scaffold would
        // false-merge). (2) COLLAPSE the sprawled thread list to distinct clusters (7× "Louisiana parishes"
        // → one) so "the ONE thread" isn't chosen by a mono-vote. Ground from the widened set.
        const synthThoughts = db.getRecentMonologueByType('thought', 16);
        const synthThreads = pickDistinctByTopic(openThreads, { max: 4, simThr: 0.4, window: (openThreads || []).length });
        const seed = ((synthThoughts.length ? synthThoughts : recentThoughts).map(t => (t && t.content) || '').join(' ').slice(0, 300)) || userName;
        const sources = await subc2.retrieveSources(seed, { search: (q, k) => memoryLib.retrieve(q, { k }), k: 4 });
        // HER OWN HEALTH IS SOURCE MATERIAL (build plan 1.4): the newest anomalies/needs from the
        // obs bus ride the synthesis grounding, so a tension can form about her own program and
        // route through the same typed doors (experiment/inquiry) as any other tension — the
        // cognitive half of the self-improvement loop. Marked like every other source.
        try {
          for (const a of require('./obs_bus').latest({ kinds: ['anomaly', 'need'], limit: 3 })) {
            sources.push({ ref: 'W' + (sources.length + 1), content: `your own program logged: ${String(a.text || '').replace(/\s+/g, ' ').slice(0, 220)}`, source: 'self-watch' });
          }
        } catch {}
        // SLICE A (2026-07-30): explored tensions ride the prompt (no re-derivation — measured: 80
        // essays/day circling ONE Georgia-boards tension) and the output is a TYPED SHAPE.
        let _synthRecent = []; try { _synthRecent = JSON.parse(_gm('subc.synth_recent') || '[]'); } catch {}
        // SLICE B: her LIVE identity rides in — positions/tastes angle what she notices, so the
        // subconscious differentiates over time instead of thinking from a static persona alone.
        let _idBlock = ''; try { _idBlock = require('./self_model').buildPromptBlock(6) || ''; } catch {}
        // SLICE C: the SAME board her decider reads every tick — open threads, inquiries, his week,
        // deadlines, failures, what awaits him, what is running. Her between-turn thinking now
        // reasons over everything in flight, not just her most recent thoughts (recency bias was
        // the only signal; Lucas: "a good research assistant anticipates your needs").
        // liveDigest, NOT the raw manifest: the manifest opens with standing INVENTORY (absence
        // gaps, held claims) and the subc's slice never reached the in-flight sections — four
        // straight syntheses about county backlog while the live focus was China research.
        let _boardBlock = '';
        try { _boardBlock = require('./autonomy').liveDigest({ db, now: Date.now(), maxChars: 3000 }) || ''; } catch {}
        const synthMessages = [
          { role: 'system', content: BASE_PERSONA },
          { role: 'user', content: subc2.buildSynthesisPrompt({ recentThoughts: synthThoughts, threads: synthThreads, focus: null, sources, explored: _synthRecent, identity: _idBlock, board: _boardBlock }) }
        ];
        const synth = await generateThought({
          messages: synthMessages,
          // think:false — the reasoner's scratch work stays internal; the SHAPE is the output (the
          // giant-block fix: CoT-salvage stored 2,750ch average against a 360-token ask).
          options: { temperature: 0.85, top_p: 0.95, num_ctx: 8192, num_predict: 500, think: false },
          deps: {
            subModel: cfg2.subconsciousModel(),
            onUsage: (usage) => { try { const tok = (usage && ((usage.prompt_tokens || 0) + (usage.eval_tokens || 0))) || subc2.estimateTokens(synthMessages, ''); subc2.recordSpend({ getMeta: _gm, setMeta: _sm, now: Date.now(), tokens: tok }); } catch {} }
          }
        });
        subc2.markSynthesized({ setMeta: _sm, now: Date.now() });
        const st = (synth || '').trim();
        if (st) {
          const parsed = subc2.parseSynthesis(st);
          // NOVELTY GATE (run_closure's ledger, ported): a tension already explored is not stored,
          // not voiced, not banked — the log carries the skip so a quiet field stays visible.
          if (parsed) {
            const rc2 = require('./run_closure');
            let _led = []; try { _led = JSON.parse(_gm('subc.synth_ledger') || '[]'); } catch {}
            if (!rc2.isNovelQuestion(parsed.tension, _led)) {
              console.log(`[subc] synthesis re-derived an explored tension ("${parsed.tension.slice(0, 70)}") — skipped, nothing stored`);
            } else {
              const { ledger } = rc2.filterNovel([parsed.tension], _led);
              try { _sm('subc.synth_ledger', JSON.stringify(ledger)); } catch {}
              try { _sm('subc.synth_recent', JSON.stringify([..._synthRecent, parsed.tension].slice(-6))); } catch {}
              let imp = 0.6; try { imp = await importanceLib.score(st, { userName, kind: 'thought' }); } catch {}
              const row = db.insertMonologue({ content: st, model: cfg2.subconsciousModel(), type: 'synthesis', importance: imp });
              pushSheep({ id: row.id, ts: row.ts, content: st, type: 'thought', importance: imp });
              try { blackboard.append({ source: 'monologue', kind: 'thought', refTable: 'monologue', refId: row.id, content: st }); } catch {}
              console.log(`[subc] synthesis stored — tension: "${parsed.tension.slice(0, 70)}" → action: ${parsed.action.kind}`);
              // THE STITCH BECOMES WORK (slice A): typed routing through EXISTING doors — research
              // spawns a driver-ordered thread (depth-capped via spawned_from); inquiry/experiment
              // bank as first-class leads on the decider's harvest surface; none is honest quiet.
              try {
                const act = parsed.action;
                if (act.kind === 'research' && (act.text || parsed.tension).length > 12) {
                  // One self-directed thread at a time: paraphrased re-derivations slip the lexical
                  // ledger, so the spawn throttles to her own completion rate (db.getOpenSpawnedThread).
                  const prior = db.getOpenSpawnedThread('subc');
                  if (prior) {
                    console.log(`[subc] research deferred — self-directed thread #${prior.id} still open (one at a time)`);
                  } else {
                    const r = db.insertOpenThread({ content: `Investigate: ${(act.text || parsed.tension).replace(/\s+/g, ' ').trim()}` });
                    if (r && r.id) { try { db.setMeta(`thread.${r.id}.spawned_from`, 'subc'); } catch {} console.log(`[subc] synthesis → research thread #${r.id}`); }
                  }
                } else if ((act.kind === 'inquiry' || act.kind === 'experiment') && act.text.length > 12) {
                  let bank = []; try { bank = JSON.parse(db.getMeta('autonomy.harvest_recent') || '[]'); } catch {}
                  const dup = bank.some((e) => (e.leads || []).some((l) => String(l).toLowerCase() === act.text.toLowerCase()));
                  if (!dup) {
                    bank.push({ ts: Date.now(), docRef: `monologue #${row.id}`, title: `Her synthesis proposes an ${act.kind.toUpperCase()}`, leads: [act.text], seeds: [], decisions: [], claims: [] });
                    db.setMeta('autonomy.harvest_recent', JSON.stringify(bank.slice(-8)));
                    console.log(`[subc] synthesis → ${act.kind} lead banked: "${act.text.slice(0, 70)}"`);
                  }
                }
              } catch (e) { console.error('[subc] synthesis routing failed:', e.message); }
              // SLICE B out-flow: a stance the material actually formed lands in the self-model —
              // provenance-marked, opinion-shaped ("I …" enforced at parse), ONE per day, and only
              // on a NOVEL tension. record()'s own guardrails (leak gate, dedup) still apply.
              try {
                if (parsed.position) {
                  const _pd = new Date(); const _day = `${_pd.getFullYear()}-${_pd.getMonth() + 1}-${_pd.getDate()}`;
                  if (_gm('subc.position_day') !== _day) {
                    const pr = await require('./self_model').record(`${parsed.position} (formed thinking about: ${parsed.tension.slice(0, 80)})`, { category: 'insight', importance: 0.55, epistemic: 'speculated' });
                    if (pr && !pr.skipped) { _sm('subc.position_day', _day); console.log(`[subc] position formed → self-model: "${parsed.position.slice(0, 70)}"`); }
                  }
                }
              } catch (e) { console.error('[subc] position landing failed:', e.message); }
            }
          } else {
            // Shape absent — keep the raw thought (never lose it), route via the legacy next-step
            // regex, and say so: an unparsed synthesis is a visible fact, not a silent one.
            let imp = 0.6; try { imp = await importanceLib.score(st, { userName, kind: 'thought' }); } catch {}
            const row = db.insertMonologue({ content: st, model: cfg2.subconsciousModel(), type: 'synthesis', importance: imp });
            pushSheep({ id: row.id, ts: row.ts, content: st, type: 'thought', importance: imp });
            try { blackboard.append({ source: 'monologue', kind: 'thought', refTable: 'monologue', refId: row.id, content: st }); } catch {}
            console.log('[subc] synthesis stored UNSHAPED (parse miss) — legacy next-step routing only');
            try {
              const pm = /\bnext steps?\b\s*[:—-]\s*([\s\S]{10,400}?)(?:<wonder>|$)/i.exec(st);
              if (pm) {
                const plan = pm[1].replace(/\s+/g, ' ').replace(/^[*#>\s]+/, '').trim().slice(0, 250);
                let bank = []; try { bank = JSON.parse(db.getMeta('autonomy.harvest_recent') || '[]'); } catch {}
                const dup = bank.some((e) => (e.leads || []).some((l) => String(l).toLowerCase() === plan.toLowerCase()));
                if (plan && !dup) {
                  bank.push({ ts: Date.now(), docRef: `monologue #${row.id}`, title: 'Her own synthesis named a next step', leads: [plan], seeds: [], decisions: [], claims: [] });
                  db.setMeta('autonomy.harvest_recent', JSON.stringify(bank.slice(-8)));
                  console.log(`[subc] synthesis next-step banked as a lead → "${plan.slice(0, 80)}"`);
                }
              }
            } catch (e) { console.error('[subc] synthesis lead bank failed:', e.message); }
          }
        }
      }
    } catch (e) { console.error('[subc] synthesis failed:', e.message); }
  }

  // OPEN THREADS POST-PROCESSING:
  // 1) Parse + apply any [thread-*:N] status tags (touches DB)
  // 2) Detect mentions of active threads in the raw text (metrics)
  // 3) Strip tags from text before storage so they don't pollute future context
  try { openThreadsLib.parseAndApplyStatusUpdates(trimmed); } catch {}
  try { openThreadsLib.detectAndCountMentions(trimmed, openThreads); } catch {}
  if (focusedThread) {
    // Thread-review tick: ensure the focused thread is touched even if model
    // didn't emit a tag (it produced output, that counts as touch).
    try { db.touchOpenThread(focusedThread.id); } catch {}
  }
  trimmed = openThreadsLib.stripStatusTags(trimmed);

  // BROWSER TAGS (autonomous): if she emitted a page action while thinking, run it.
  // This is what makes her CONTINUE an investigation between turns — clicking,
  // scrolling, reading deeper without Lucas prompting each step. browse-read/list
  // results get stored as readings so the NEXT tick sees them and can continue.
  const browserTagsRaw = browserLib.parseTags(trimmed);
  const { browserTags, redirectedOpens } = splitIdleBrowserTags(browserTagsRaw);
  if (redirectedOpens.length) console.log(`[monologue] redirected ${redirectedOpens.length} <browse> open(s) → her own browser (research uses web-open, not Lucas's Chrome)`);
  if (browserTags.length > 0 && browserLib.isConnected()) {
    (async () => {
      for (const t of browserTags.slice(0, 2)) {
        try {
          const r = await browserLib.dispatch(t);
          console.log(`[monologue] browser ${t.tag}: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
          if (r?.ok && t.tag === 'browse-read' && r.text) {
            const rr = db.insertMonologue({ content: `I read "${r.title || r.url}" (${r.url}):\n${r.text}`, model: 'browser-read', type: 'reading', query: r.url, urls: [r.url] });
            pushSheep({ id: rr.id, ts: rr.ts, content: `(read) ${r.title || r.url}`, type: 'reading', query: r.url });
            try { require('./learning').maybeCaptureLearnings({ query: r.title || r.url, content: r.text, urls: [r.url] }); } catch {}
          } else if (r?.ok && t.tag === 'browse' && r.url) {
            const rr = db.insertMonologue({ content: `I opened "${r.title || r.url}" (${r.url})`, model: 'browser-open', type: 'reading', query: r.url, urls: [r.url] });
            pushSheep({ id: rr.id, ts: rr.ts, content: `(opened) ${r.title || r.url}`, type: 'reading', query: r.url });
          } else if (r?.ok) {
            pushSheep({ id: Date.now(), ts: Date.now(), content: `(${t.tag}) ${r.target || r.url || ''}`, type: 'reading' });
          }
        } catch (err) { console.error('[monologue] browser dispatch error:', err.message); }
      }
    })().catch(err => console.error('[monologue] browser async error:', err.message));
  }
  if (browserTagsRaw.length > 0) trimmed = browserLib.stripTags(trimmed);   // strip ALL browse tags (incl. redirected opens)

  // WEB TAGS (autonomous): her OWN browser, between turns. This is what makes
  // "indulge on the internet" / a browsing focus real during idle — open, read,
  // click on her own. web-read/open results are stored as readings so the NEXT
  // tick sees them (and they feed importance scoring → reflection → knowledge).
  const webTags = [...redirectedOpens, ...webLib.parseTags(trimmed)];   // redirected <browse> opens run as web-open in HER browser
  if (webTags.length > 0) {
    (async () => {
      for (const t of webTags.slice(0, 2)) {
        try {
          const r = await webLib.dispatch(t);
          if (r?.ok && t.tag === 'web-read' && r.text) {
            const rr = db.insertMonologue({ content: `I looked at "${r.title || r.url}" in my own browser (${r.url}):\n${r.text}`, model: 'web-read', type: 'reading', query: r.url, urls: r.url ? [r.url] : null });
            pushSheep({ id: rr.id, ts: rr.ts, content: `(my browser) ${r.title || r.url}`, type: 'reading', query: r.url });
            try { require('./learning').maybeCaptureLearnings({ query: r.title || r.url, content: r.text, urls: r.url ? [r.url] : null }); } catch {}
          } else if (r?.ok && t.tag === 'web-open') {
            const rr = db.insertMonologue({ content: `I opened ${r.url} in my own browser`, model: 'web-open', type: 'reading', query: r.url, urls: r.url ? [r.url] : null });
            pushSheep({ id: rr.id, ts: rr.ts, content: `(opened) ${r.url}`, type: 'reading', query: r.url });
          } else if (r?.ok && t.tag === 'web-chat' && r.text) {
            // A character replied during her play — store it as a reading so the NEXT
            // tick sees the scene-so-far and continues it (the whole point of play).
            const who = r.speaker || 'the character';
            const rr = db.insertMonologue({ content: `I'm playing a scene in my own browser. I sent ${who} a line, and they replied:\n${r.text}`, model: 'web-chat', type: 'reading', query: r.url, urls: r.url ? [r.url] : null });
            pushSheep({ id: rr.id, ts: rr.ts, content: `(${who} replied) ${(r.text || '').slice(0, 80)}`, type: 'reading', query: r.url });
          }
          console.log(`[monologue] web ${t.tag}: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
        } catch (err) { console.error('[monologue] web dispatch error:', err.message); }
      }
    })().catch(err => console.error('[monologue] web async error:', err.message));
    trimmed = webLib.stripTags(trimmed);
  }

  // SCREEN TAGS (autonomous): if she chose to observe the desktop while thinking,
  // run it. Result stored as a reading so the next tick can reason about what
  // Lucas is working on. This makes her "let me observe what he's doing" plan real.
  const screenTags = screenLib.parseTags(trimmed);
  if (screenTags.length > 0) {
    (async () => {
      try {
        const r = await screenLib.dispatch();
        if (r?.ok) {
          const rr = db.insertMonologue({ content: r.text, model: 'screen-observe', type: 'reading' });
          pushSheep({ id: rr.id, ts: rr.ts, content: `(observed screen — focused: ${r.foreground || '?'})`, type: 'reading' });
        }
        console.log(`[monologue] screen observe: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
      } catch (err) { console.error('[monologue] screen dispatch error:', err.message); }
    })().catch(() => {});
    trimmed = screenLib.stripTags(trimmed);
  }

  // FILE TAGS (autonomous): if she emitted a file op while thinking, run it.
  // This is the between-turn knowledge-building she asked for — notes/drafts
  // written on her own initiative. Dispatch async; strip from stored thought.
  const fileTags = filesLib.parseTags(trimmed);
  if (fileTags.length > 0) {
    (async () => {
      for (const t of fileTags.slice(0, 3)) {
        try {
          const r = await filesLib.dispatch(t);
          console.log(`[monologue] file ${t.tag}: ${r?.ok ? 'ok ' + (r.path || '') : 'FAIL ' + r?.reason}`);
          if (r?.ok && (t.tag === 'file-read' || t.tag === 'file-list')) {
            const body = t.tag === 'file-read'
              ? `I read my file ${r.path}:\n${r.text}`
              : `Files in ${r.path}: ${(r.entries || []).map(e => e.name).join(', ') || '(empty)'}`;
            const rr = db.insertMonologue({ content: body, model: 'file-read', type: 'reading', query: r.path });
            pushSheep({ id: rr.id, ts: rr.ts, content: `(${t.tag}) ${r.path}`, type: 'reading', query: r.path });
          } else if (r?.ok) {
            pushSheep({ id: Date.now(), ts: Date.now(), content: `(${t.tag === 'file-append' ? 'appended' : 'wrote'}) ${r.path}`, type: 'reading', query: r.path });
          }
        } catch (err) { console.error('[monologue] file dispatch error:', err.message); }
      }
    })().catch(err => console.error('[monologue] file async error:', err.message));
    trimmed = filesLib.stripTags(trimmed);
  }

  // AUTONOMY TOOLS (scheduler / presence / email / discord): if she invoked any
  // while thinking, run them and strip the tags from the stored thought.
  // SUPPRESSED in personal mode — off the clock she shouldn't be scheduling things
  // or pinging Lucas; strip the tags so they don't leak, but don't fire them.
  if (personalMode && autoTools.hasAny(autoTools.parseAll(trimmed))) {
    console.log('[monologue] personal mode — suppressing autonomous Lucas-ping tool(s)');
    trimmed = autoTools.stripAll(trimmed);
  } else if (autoTools.hasAny(autoTools.parseAll(trimmed))) {
    // GOVERNOR: pace autonomous tool actions (schedule/notify/email/dm). Strip the
    // tags either way so they never leak into the stored thought.
    if (governor.requestAction('tool').allow) {
      governor.record('tool');
      autoTools.dispatchFound(trimmed, { onSheep: pushSheep, source: 'monologue' })
        .catch(err => console.error('[monologue] auto-tools error:', err.message));
    } else {
      // Governor denied — tags get stripped below either way, so make the dropped
      // action visible and leave a note row rather than discarding it silently.
      console.warn('[monologue] auto-tool action held back by governor (paced out)');
      try {
        const heldRow = db.insertMonologue({ content: '(held an action back — governor paced it out)', model: MODEL, type: 'reading' });
        pushSheep({ id: heldRow.id, ts: heldRow.ts, content: '(held an action back — governor paced it out)', type: 'reading' });
      } catch (err) { console.error('[monologue] held-note insert error:', err.message); }
    }
    trimmed = autoTools.stripAll(trimmed);
  }

  // CAPABILITY GAPS: if she named something she can't do yet (<gap>…</gap>), log
  // it (deduped) so it can be proposed when Lucas returns. Strip from the thought.
  try { if (gapsLib.record(trimmed, { sourceContext: 'monologue' })) trimmed = gapsLib.stripTags(trimmed); }
  catch (e) { console.error('[monologue] gap record failed:', e.message); }

  if (!trimmed) return;

  // FOCUS OUTCOME: when serving a focus, this tick's output is its next step. We
  // measure novelty against the focus's OWN working set (re-stating ≠ progress),
  // store the thought tagged to the focus, then let focus.recordOutcome decide
  // continue / resolve / stall (strikes + hard caps + focus-scoped stuck check).
  // A SKIP or empty output counts as a no-progress strike — she can't idle a focus
  // forever. Returns here so focus ticks bypass the free-association quality gates.
  if (activeFocus) {
    const control = focusLib.parseControlTags(trimmed);
    // A <wonder> on a FOCUS tick fires self-dialogue exactly like the free lane (2026-08-15
    // deep-dive B1: it was stripped and DISCARDED here — and since an interest focus is the only
    // reachable undirected generation path, the wondering organ's output went straight to the
    // floor). Async, one per tick, does not block the focus outcome.
    const _fw = trimmed.match(/<wonder>([\s\S]*?)<\/wonder>/i);
    if (_fw && _fw[1].trim()) {
      const _sid = opts.getSessionId ? opts.getSessionId() : null;
      runSelfDialogue({ wonderText: _fw[1].trim(), sessionId: _sid }).catch(err =>
        console.error('[monologue] focus wonder self-dialogue error:', err.message));
    }
    let clean = focusLib.stripControlTags(trimmed).replace(/<wonder>[\s\S]*?<\/wonder>/gi, '').trim();
    if (/^SKIP\.?$/i.test(clean)) clean = '';
    const sig = blackboard.signature(clean);
    const progressed = (control && control.type === 'done') ? true : focusLib.isNovel(activeFocus.id, sig);
    if (clean) {
      const imp = await importanceLib.score(clean, { userName, kind: 'thought' });
      bumpReflectionAccum(imp);
      const frow = db.insertMonologue({ content: clean, model: _lastThoughtModel, feedContext, type: 'thought', importance: imp });
      pushSheep({ id: frow.id, ts: frow.ts, content: clean, type: 'thought' });
      try { blackboard.append({ source: 'monologue', kind: 'thought', focusId: activeFocus.id, refTable: 'monologue', refId: frow.id, content: clean }); }
      catch (e) { console.error('[monologue] focus thought append failed:', e.message); }
    }
    const outcome = focusLib.recordOutcome(activeFocus, { progressed, control });
    console.log(`[focus] #${activeFocus.id} → ${outcome.action} (${outcome.reason})`);
    // Reading to advance — scoped to the focus so its readings join the working set.
    if (outcome.action === 'continue' && clean) {
      maybeSearchFromThought(clean, activeFocus.id).catch(err => console.error('[monologue] focus search error:', err.message));
    }
    return;
  }

  // Model said it has nothing specific to surface — honor that, don't store
  if (/^SKIP\.?$/i.test(trimmed)) return;

  // Detect <wonder>X</wonder> tag — extract the wondering, strip from displayed thought,
  // and fire self-dialogue async after storing the thought itself.
  let wonderText = null;
  const wonderMatch = trimmed.match(/<wonder>([\s\S]*?)<\/wonder>/i);
  if (wonderMatch) {
    wonderText = wonderMatch[1].trim();
    trimmed = trimmed.replace(/<wonder>[\s\S]*?<\/wonder>/i, '').trim();
    if (!trimmed) trimmed = `(wondered: ${wonderText.slice(0, 80)})`;
  }

  // SELF-SET: a free-association thought may declare a new intention with
  // <focus>goal</focus>. Create it (it becomes the served focus next tick) and
  // strip the tag so it doesn't pollute the stored thought. One focus at a time —
  // setFromText no-ops if one is already active. SKIPPED in personal mode: play
  // shouldn't spin up a work focus (just strip any tag so it doesn't leak).
  if (!personalMode) {
    try { const set = await focusLib.setFromText(trimmed); if (set) console.log('[focus] self-set →', set.goal.slice(0, 80)); }
    catch (e) { console.error('[monologue] focus self-set failed:', e.message); }
  }
  trimmed = focusLib.stripControlTags(trimmed);
  if (!trimmed) return;

  // CURATION (aggressive, write-time): drop a spiral / prude / over-analysis / search-junk
  // free-association thought before it's stored OR surfaced — the continuous half of the
  // curator (the sweep is the retroactive half). This is the write guard thoughts lacked
  // (self_model has SELF_REJECT, commitments COMMIT_REJECT); it's where the spiral kept
  // regenerating. Cheap: she re-ticks in ~35s, so a dropped tick just stays silent.
  if (curatorLib.isJunk(trimmed)) { console.log('[curation] dropped spiral/junk thought:', trimmed.replace(/\s+/g, ' ').slice(0, 70)); return; }

  // CURIOSITY-SEED SUPPRESSION: a bare "I want to know X" is the QUERY half of a curiosity
  // tick, not mentation — and it was the dominant source of idle-stream bloat (~85% of recent
  // "thoughts" were these bare seeds, clustering hard by entity). STILL fire the lookup — its
  // ANSWER (a reading) carries the value and surfaces normally — but do NOT store/surface the
  // query itself as a thought. Applies even during gap-fill (a bare seed is never good filler).
  if (!personalMode && isBareCuriositySeed(trimmed)) {
    console.log('[curiosity-seed] suppressed bare seed from thought stream:', trimmed.replace(/\s+/g, ' ').slice(0, 70));
    maybeSearchFromThought(trimmed).catch(err => console.error('[monologue] search trigger error:', err.message));
    return;
  }

  // SUBCONSCIOUS MEMORY RECONCILE: if this idle thought is about to conclude she has "no record
  // / didn't we discuss this / I should check my notes or ask Lucas", SEARCH her conversation
  // memory FIRST — recall belongs here, in the subconscious. If the answer is actually in what
  // the user said, replace the gap-thought with the reconciled fact (so she stops forming a
  // false "I don't remember" belief and can surface it); if genuinely absent, let it stand.
  if (!personalMode && ruminationLib.isMemoryGapFixation([{ content: trimmed }])) {
    try {
      const exclude = recentTurns ? recentTurns.map(t => t.id) : [];
      const hits = await memoryLib.retrieveTurns(trimmed, { k: 4, excludeIds: exclude, userOnly: true, dropQuestions: true });
      if (hits && hits.length) {
        const said = hits.map(h => `"${(h.content || '').replace(/\s+/g, ' ').slice(0, 180)}"`).join('; ');
        trimmed = `I almost told myself I had no record of this — but I searched my memory of our conversation and I do. ${userName} said: ${said}. That's the answer; no need to ask again or dig through notes.`;
        console.log(`[memory-reconcile] idle gap-thought resolved from conversation memory (${hits.length} turn(s))`);
      }
    } catch (e) { console.error('[memory-reconcile] failed:', e.message); }
  }

  // GOVERNOR gap-fill: when she's been quiet too long, relax the quality drop-filters
  // so SOMETHING surfaces and the silence gets filled rather than staying empty.
  const fillGap = governor.shouldFillGap();
  if (!fillGap && isTooSimilarToRecent(trimmed, recentThoughts)) {
    return;
  }
  // FIXATION DROP (F2 — anti-rumination on the THOUGHT path): when recent thoughts are already
  // dominated by one anchor term (diversifySeeds.monoFixated) and THIS new thought keeps riding
  // that same anchor, drop it — she's circling (e.g. ~9 near-identical "Otter AI" thoughts). The
  // existing soft prompt nudge wasn't biting; this forces a topic change, mirroring the Jaccard
  // drop above. EXCEPTION: if the anchor is in Lucas's latest message she's legitimately
  // processing live conversation — let it stand. (R4 braked repeat SEARCHES; this is the thought loop.)
  if (!fillGap) {
    try {
      const fix = diversifySeeds(recentThoughts, { window: 6, domFrac: 0.6 });
      if (fix.monoFixated && fix.anchor) {
        const anchorRe = new RegExp(`\\b${fix.anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
        const lastUser = (recentTurns || []).filter(t => t.speaker === 'user').slice(-1)[0];
        const userOnAnchor = !!(lastUser && anchorRe.test(lastUser.content || ''));
        if (anchorRe.test(trimmed) && !userOnAnchor) {
          console.log(`[anti-fixation] dropped thought still circling "${fix.anchor}" — forcing topic change`);
          return;
        }
      }
    } catch (e) { console.error('[anti-fixation] check failed:', e.message); }
  }
  if (!fillGap && isSilenceEssay(trimmed)) {
    // Drop silently — the model is in the silence attractor; don't store or render.
    return;
  }

  // STUCK GUARD (blackboard): defense-in-depth beyond the Jaccard similarity check
  // above. Reads the shared timeline and catches exact-repeat / alternating spirals
  // (incl. cross-loop ones) that single-loop similarity misses. On a hit we skip
  // surfacing this tick rather than feed the loop. (Phase B gives this teeth: it
  // will abort the active focus; for now it just breaks the visible repetition.)
  const stuckState = stuck.check();
  if (stuckState.stuck) {
    console.log(`[monologue] stuck (${stuckState.scenario}) — skipping tick: ${stuckState.reason}`);
    return;
  }

  // GOVERNOR pace: hold surfaced thoughts to the min-gap + hourly budget. If paced
  // out, let the silence stand (she still thought; it just isn't surfaced).
  const thoughtGate = governor.requestAction('thought');
  if (!thoughtGate.allow) return;
  governor.record('thought');

  const importance = await importanceLib.score(trimmed, { userName, kind: 'thought' });
  bumpReflectionAccum(importance);
  const row = db.insertMonologue({
    content: trimmed,
    model: _lastThoughtModel,
    feedContext,
    type: 'thought',
    importance
  });

  // The sheep panel is the WINDOW INTO HER SUBCONSCIOUS, not noise-to-Lucas — so it
  // shows her FULL thought stream (importance is passed through for styling, not as
  // a gate). The thing that was actually annoying — unprompted UTTERANCES to Lucas —
  // is gated separately in the heartbeat (importance ≥8 + 15-min floor). Dimming the
  // panel made her look like she'd stopped thinking; she hadn't.
  pushSheep({ id: row.id, ts: row.ts, content: trimmed, type: 'thought', importance });
  // write-bottom: record this thought on the shared timeline so the next tick (and
  // the other loops) can see it, and so the StuckDetector has something to compare.
  try { blackboard.append({ source: 'monologue', kind: 'thought', refTable: 'monologue', refId: row.id, content: trimmed }); } catch (e) { console.error('[monologue] blackboard append failed:', e.message); }

  // If a <wonder>X</wonder> was extracted, fire a self-dialogue with [stheno]
  // her larger self. Async — does not block monologue tick.
  if (wonderText) {
    const sessionId = opts.getSessionId ? opts.getSessionId() : null;
    runSelfDialogue({ wonderText, sessionId }).catch(err =>
      console.error('[monologue] self-dialogue error:', err.message)
    );
  }

  // After writing the thought, check whether it contains a curiosity trigger.
  // Fire a search async — don't block the next tick.
  maybeSearchFromThought(trimmed).catch(err =>
    console.error('[monologue] search trigger error:', err.message)
  );

  // Periodically ask her what she'd want to look up if nothing is pulling.
  // Skipped in personal mode — the play prompt already drives her browser toward
  // something fun; the work-framed boredom search would just add noise.
  if (!personalMode) {
    maybeBoredomSearch().catch(err =>
      console.error('[monologue] boredom search error:', err.message)
    );
  }
}

function pushSheep(payload) {
  try {
    const win = opts.getWindow ? opts.getWindow() : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('monologue:tick', payload);
    }
  } catch {}
}

// SHARED FOCUS — the one active-name set both subconscious lanes (graph-walk + puller) steer by. Sourced
// from REAL OBJECTS first — his Puller targets (discovered people/orgs he's working) and the freshly-
// surfaced cards — because the old doc-decomp entity STRINGS mostly don't resolve to clean graph nodes (a
// bureaucratic org-chart CSV yielded "Office of Enforcement" etc.), which starved the relevant tier to 0
// and dropped the walk back onto random history. Real objects lead (within the relevant SQL's 40-name
// window); doc-decomp mentions fill in behind them. Order-preserving dedup.
function activeSetNames() {
  const names = [];
  // OWNER GUARD (2026-07-10): never feed the OWNER's own name into the graph-walk research/grow set — he is
  // recognized (db.isOwnerName), not an unknown civic subject to profile via the Echo corpus. This is the fix
  // for the graph-walk "I didn't have anything on L. Overby → pulled it together (via Echo corpus)" incident.
  const push = (n) => { const s = String(n == null ? '' : n).trim(); if (s.length >= 3 && !db.isOwnerName(s)) names.push(s); };
  // DYNAMIC ENGAGEMENT ANCHOR (2026-07-12, Lucas: "the walk follows my recent attention, autonomous
  // discovery demoted to fallback"). No hardcoded topic/region list (that goes stale + can't pivot to a new
  // region next week). Three tiers, HIS-signal first:
  //   1. OPTIONAL DATED override (lib/priorities) — empty unless he pins something for a week ("dig into X").
  //   2. OPERATOR ENGAGEMENT — entities from docs HE dropped (canvas/upload/meeting/editor): his ACTIVE
  //      materials (LAMP mapping, Utah water, policy). Primary anchor; shifts as his work shifts, so nothing
  //      is hardcoded or blocked (Africa next week just follows his drops/talk there). The autonomous
  //      browser_download FLOOD is EXCLUDED from steering (it only reaches the walk via the fallback).
  //   3. BOUNDED FALLBACK — capped autonomous puller, so the walk stays fed on genuine downtime without a
  //      discovery burst hijacking it.
  // DROPPED from the anchor: recent_cards (held the Brazilian-prosecutor flood) + the raw doc-decomp firehose
  // (100% browser_download flood). Conversation entities still enter via convoNames (extractCandidates) upstream.
  try { for (const p of require('./priorities').getActive(db)) push(p); } catch {}
  try { for (const o of db.listOperatorDropEntities({ limit: 60 })) { push(o && o.s); push(o && o.t); } } catch {}
  const _pullerCap = parseInt(process.env.ZOE_ACTIVE_PULLER_CAP || '', 10) || 6;
  try { for (const t of require('./puller_db').listTargets({ limit: _pullerCap })) push(t && t.name); } catch {}
  const seen = new Set(); const out = [];
  for (const n of names) { const k = n.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(n); } }
  return out;
}

// IDLE = GRAPH-BUILDING (object-memory Slice 5). When she's idle (no focus/thread/meeting), the tick
// no longer free-associates (that was the noise generator). Instead it advances the graph-builder ONE
// move: anchor on a recent-conversation gap, resolve/build the object from web+tools, walk connected
// branches forging connections. The CLOUD interprets + writes (propose_*, gated); a notable move
// surfaces one line. Cadence- and budget-gated; goes quiet when there's no gap. Returns true if a
// move ran (so the tick doesn't also free-associate). Fail-soft — any error → false (quiet).
// DOMAIN LEASH (D1): true when a DIRECTED focus is actively being served — the switch that stops the
// autonomous lanes wandering off-domain while a red-tag task runs (the "fighting herself" drift: the walk
// grazing random historical figures, the puller minting medical-directory doctors). Re-queries focus
// directly because the idle tick nulls its OWN activeFocus for directed foci (~L837), so that local is not
// the signal. Reverts to full free exploration the moment no directed task is live (honours let-it-in/churn).
function _directedFocusActive() {
  try { const fl = require('./focus'); const f = fl.getCurrent(); return !!(f && fl.isDirected(f)); }
  catch { return false; }
}
// DIRECTED PREEMPTION (Lucas 2026-08-06: "a directed task should take over ALL the bandwidth").
// HIS runs only — a beat-origin autonomic focus does NOT suppress the puller (that is the puller's
// normal working time). Distinct from _directedFocusActive above, which any directed focus (beats
// included) satisfies and which leashes DISCOVERY for domain-purity reasons, not bandwidth.
function _userDirectedActive() {
  try { const fl = require('./focus'); const f = fl.getCurrent(); return !!(f && fl.isDirected(f) && fl.originOf(f) !== 'beat'); }
  catch { return false; }
}
// Domain-leash tokens for the CONTACT stage: the operator's domain (active directed focus, ELSE their
// standing civic threads) — see lib/focus.domainLeashTokens. Delegated so it stays ON even after a directed
// focus STALLS (the off-domain backlog would otherwise get worked again the moment the focus stops).
function _focusDomainTokens() { try { return require('./focus').domainLeashTokens(); } catch { return null; } }
function _tokenHit(text, toks) { const h = String(text || '').toLowerCase(); for (const t of toks) if (h.includes(t)) return true; return false; }

async function runGraphWalkMove(recentTurns, { force = false } = {}) {
  const nowTs = Date.now();
  // cadence: slow, deliberate — not every 10s tick. `force` skips it for a same-tick BURST (Slice 4); the
  // budget check below still self-limits, so a burst can't run away.
  if (!force) { try { const last = parseInt(db.getMeta(GRAPHWALK_LAST_KEY) || '0', 10) || 0; if (nowTs - last < GRAPHWALK_MIN_INTERVAL_MS) return false; } catch {} }
  // budget: the idle builder has its OWN rolling window (GRAPHWALK_BUDGET_KEY) with its own ceiling, so the
  // shared subc pool that news/curation/forecast fill can't starve knowledge-expansion to zero (the audit
  // root: subc window pinned at 136k/120k → graph-walk never ran).
  const subc = require('./subconscious');
  const cfg = require('./config');
  const _gm = (k) => { try { return db.getMeta(k); } catch { return null; } };
  const _sm = (k, v) => { try { db.setMeta(k, v); } catch {} };
  if (!subc.budgetOk(_gm, nowTs, cfg.graphwalkBudgetTokensPerHour(), GRAPHWALK_BUDGET_KEY)) return false;
  // ⭐ THE POOL-WIDE GATE, on top of this lane's own rolling window. The per-lane windows are rate
  // limiters with no notion of a period, so four lanes can each be "within budget" while the shared
  // allowance drains — measured 2026-07-31 at 90.8% of the WEEK used with two days to reset.
  // estimate is in REQUESTS (the unit the provider bills): one graph-walk move, one call.
  if (!require('./quota_gate').allow('idle', { estimate: 1 }).allow) return false;
  if (!echoSuit.liveReady()) return false;   // no graph → nothing to build; stay quiet

  // CLOUD cortex seam: the interpreter (candidate extraction + dossier synthesis). This is STRUCTURED
  // EXTRACTION (entity lists, JSON dossiers), not deep reasoning — so it uses the EXTRACTION model
  // (gemma4:31b-cloud), not the gpt-oss:120b reasoner, whose reasoning detours produced unparseable
  // dossiers (dossier=NULL, rawLen 62–4710). Records spend.
  const cloud = async (messages, o = {}) => {
    const sub = cfg.extractionModel() || cfg.subconsciousModel();
    const src = (() => { try { return (require('./models').sources() || []).find(s => s.tier === 'cloud' && s.token); } catch { return null; } })();
    if (!sub || !src) return null;
    try {
      const r = await completeDetailed({
        model: sub, messages, base: src.base,
        headers: src.token ? { Authorization: `Bearer ${src.token}` } : {},
        options: { temperature: o.temperature ?? 0.3, top_p: 0.9, num_ctx: cfg.deepNumCtx(), num_predict: o.num_predict || cfg.deepNumPredict() },
        think: false,   // gpt-oss:120b is a reasoning model — without this its hidden reasoning eats the budget and the JSON comes back empty (dossier=NULL)
        timeoutMs: 120000
      });
      const text = typeof r === 'string' ? r : ((r && r.text) || (r && r.thinking) || '');   // fall back to `thinking` if a reasoner still stashed the answer there
      const usage = (r && typeof r === 'object' && r.usage) ? r.usage : null;
      try { subc.recordSpend({ getMeta: _gm, setMeta: _sm, now: Date.now(), tokens: (usage && ((usage.prompt_tokens || 0) + (usage.eval_tokens || 0))) || subc.estimateTokens(messages, text), key: GRAPHWALK_BUDGET_KEY }); } catch {}
      return text;
    } catch { return null; }
  };
  // WEB-FIRST source acquisition (Slice 0.5): live page → local Echo corpus → web search. Replaces bare
  // DDG scraping (throttled + snippet-only). Every source carries a url so the citation gate can grade it.
  const wikiUrl = (n) => 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(n || '').trim().replace(/\s+/g, '_'));
  const web = async (q) => graphWalk.fetchLayeredSources(q, { fetchPage, recallKnowledge: (nm, o) => echoSuit.recallKnowledge(nm, o), webSearch, wikiUrl, log: (m) => console.log(m) });
  const recall = async (name) => { try { return await echoSuit.recallObject(name); } catch { return null; } };
  const dispatch = async (tag) => { try { return await echoSuit.dispatch(tag, { autonomous: true }); } catch { return null; } };
  // Neighbors from OUR relations table, not kg_neighborhood — the Wikipedia sidecar it reads is a
  // different id space and returned EMPTY on 91% of 2,982 measured calls (see echo_suit.recallObject).
  const kgNeighbors = async (id) => {
    try {
      const rel = await echoSuit.relatedEntities(id, { limit: 12 });
      const out = [];
      for (const r of rel) { const n = String((r && r.name) || '').trim(); if (n && !out.includes(n)) out.push(n); }
      return out;
    } catch { return []; }
  };

  // ANCHOR CASCADE (idle_anchors): the move is no longer conversation-only. Gather GROUNDED anchors —
  // fresh news principals → thin Echo frontier nodes → recent-conversation gaps — so idle time keeps
  // expanding knowledge even when Lucas is quiet (the audit root: no non-convo fuel → 2 days silent).
  const idleAnchors = require('./idle_anchors');
  const newsObjects = require('./news_objects');
  const recentNews = async () => { try { return newsObjects.recentNewsObjects({ sinceMs: nowTs - 24 * 3600 * 1000, limit: 20, minCorroboration: 2 }); } catch { return []; } };
  const FRONTIER_WINDOW = 200;
  const THIN_COOLDOWN_MS = 10 * 60 * 1000;   // after a failure, stop hammering the 20s scan for 10 min
  const thinNodes = async () => {
    try {
      // FAILURE BACKOFF (2026-07-23, the Echo-overload freeze): this ~1.76M-row unindexed scan
      // reliably times out under load, and re-firing a 20s query EVERY tick that reliably fails is
      // itself a heavy, cascading load on Echo. When it fails, skip it for THIN_COOLDOWN_MS instead of
      // retrying immediately — the thin tier just goes quiet (the other tiers still feed the walk), and
      // Echo gets breathing room. The real fix is an engine-side index (owner's call); this stops the
      // caller from making a struggling engine worse.
      try { const until = parseInt(_gm('graphwalk.thin_cooldown_until') || '0', 10) || 0; if (Date.now() < until) return []; } catch {}
      // degree DESC: prefer the MOST-connectable underdeveloped nodes (degree 6-7 = world-notable
      // entities our graph barely links, e.g. General Motors/Reagan) over rock-bottom degree-1 stubs.
      // ROTATING WINDOW (cursor OFFSET): the query is deterministic, so a fixed top-N gets fully visited
      // and the tier goes permanently no-gap (hit at visited=392 > 200); advancing the offset each cycle
      // walks the WHOLE thin set so fresh nodes always flow. Cursor is a validated int → safe to inline.
      const cursor = Math.max(0, parseInt(_gm('graphwalk.frontier_cursor') || '0', 10) || 0);
      // timeout_seconds: this scans ~1.76M entities (no index covers degree + wikidata_qid + the
      // degree/id sort) and measured ~4.0-4.3s — about 85% of db_query's 5s default, so it
      // intermittently blows the budget and, with the swallow below, silently empties the thin tier.
      // Raising the ceiling is a caller-side stopgap, NOT the real fix: the right fix is an index on
      // the engine side, which is an Echo schema change and needs the owner's sign-off. As the graph
      // grows this query keeps getting slower, so revisit rather than raising the number again.
      const r = await dispatch({ kind: 'do', name: 'db_query', args: { sql: `SELECT id, name, degree FROM entities WHERE degree BETWEEN 2 AND 7 AND wikidata_qid IS NOT NULL ORDER BY degree DESC, id DESC LIMIT ${FRONTIER_WINDOW} OFFSET ${cursor}`, params: [], timeout_seconds: 20 } });
      // Log the failure instead of returning a bare [] — an empty thin tier and a BROKEN thin tier
      // looked identical before, which is how this hid.
      if (!r || !r.ok) { try { _sm('graphwalk.thin_cooldown_until', String(Date.now() + THIN_COOLDOWN_MS)); } catch {} console.error('[graph-walk] thin-frontier query FAILED →', String((r && r.text) || 'no response').slice(0, 160), `— backing off ${THIN_COOLDOWN_MS / 60000}min`); return []; }
      let j; try { j = JSON.parse(r.text); } catch { return []; }
      const rows = (j && j.rows) || j;
      const arr = Array.isArray(rows) ? rows : [];
      try { _sm('graphwalk.frontier_cursor', String(idleAnchors.rotateFrontierCursor(cursor, arr.length, FRONTIER_WINDOW))); } catch {}
      return arr;
    } catch { return []; }
  };
  // CONVO tier only when there's GENUINE recent conversation — a user turn in the last 30 min. Otherwise
  // extractCandidates mines her own idle musings (silence-protocol fragments like "core operating logic")
  // into junk "missing" anchors that rank first and waste moves on NULL dossiers. Idle ≠ conversation.
  const _lastUser = (recentTurns || []).filter(t => t.speaker === 'user').reduce((mx, t) => Math.max(mx, Number(t.ts) || 0), 0);
  const _convoFresh = _lastUser > 0 && (nowTs - _lastUser < 30 * 60 * 1000);
  const convoNames = async () => {
    // FOCUS FIX (2026-07-10): his touched entities (doc-decomp / puller / recent cards, via activeSetNames)
    // are ALWAYS active work — feed them UNGATED so the builder BUILDS the ones missing from the graph. The
    // RELEVANT tier only ENRICHES existing-thin nodes, so his freshly-decomposed entities that aren't in
    // civic_graph yet (audit: 29/37 missing) had no build path → the builder ground the global frontier
    // (relevant=0). These are grounded names (not idle musings); missing-with-no-web-presence self-holds at
    // the existence gate, so no junk is minted. Conversation extraction still runs ONLY on a fresh user turn.
    const work = (activeSetNames() || []);
    let convo = [];
    if (_convoFresh) { try { convo = await graphWalk.extractCandidates(recentTurns, { cloud, log: (m) => console.log(m) }); } catch {} }
    return [...work, ...convo];
  };

  // FOCUS: the SHARED active set (module-level activeSetNames) steers BOTH lanes onto the operator's work.
  const relevantNodes = async () => {
    try {
      const active = activeSetNames();
      if (!active.length) return [];   // no touched work → skip; global frontier fallback carries the move
      // INVESTIGATION FRONTIER blast-radius (config knobs): walk `hops` out from his active set, but only
      // THROUGH non-hub corridors (`hubCap`), and cap the candidate pool at `budget`. Depth-2 gives the
      // extra reach; the corridor gate is what keeps it from exploding on a power-law graph (see config).
      const _cfg = require('./config');
      return await idleAnchors.relevantFrontier(active, {
        query: async (sql) => { const r = await dispatch({ kind: 'do', name: 'db_query', args: { sql, params: [] } }); if (!r || !r.ok) return []; try { const j = JSON.parse(r.text); return (j && j.rows) || j || []; } catch { return []; } },
        limit: _cfg.investigateBudget(), hops: _cfg.investigateHops(), hubCap: _cfg.investigateHubCap(), log: (m) => console.log(m)
      });
    } catch { return []; }
  };

  const visitedKeys = graphWalk.visitedKeySet(_gm, nowTs);
  const _news = await recentNews(); const _relevant = await relevantNodes(); let _thin = await thinNodes();
  // DOMAIN LEASH (D1): while a directed focus is active, drop the GLOBAL-FRONTIER tier — the untethered
  // "any thin QID node" pool that surfaces off-domain nodes (random historical congressmen, medical-
  // directory people) far from the task. The walk then stays on the focus neighbourhood (relevant) + news +
  // convo. The frontier returns the moment no directed task is running.
  if (_thin.length && _directedFocusActive()) { console.log(`[graph-walk] directed focus active → leashed off the global frontier (${_thin.length} thin nodes suppressed)`); _thin = []; }
  // SOFT LEASH (2026-07-13, drift audit): even WITHOUT a directed focus, keep the walker on active project
  // work. Filter the global frontier to candidates whose name overlaps a token from the leash set — which
  // falls back to recentThreadGoals(15) when focus is empty. Historical Wikipedia bios (Frank Guarini,
  // Miroslav Tyrš, Society of the Cincinnati) share zero tokens with Lucas's actual current work
  // (Louisiana parishes, county commissioners) → filtered out. If the leash set is empty (fresh install /
  // no thread history), fall through to the unleashed frontier so the walk never fully starves. relevant +
  // news + convo still fire regardless, so a 0-frontier tick still moves.
  else if (_thin.length) {
    const _lt = _focusDomainTokens();
    if (_lt && _lt.size) {
      const before = _thin.length;
      _thin = _thin.filter((r) => _tokenHit(String(r && r.name || ''), _lt));
      if (_thin.length !== before) console.log(`[graph-walk] soft-leash on frontier: ${_thin.length}/${before} candidates match active project tokens`);
    }
  }
  console.log(`[idle-anchors] raw tiers: news=${_news.length} relevant=${_relevant.length} thin=${_thin.length} visited=${visitedKeys.size}`);
  const anchors = await idleAnchors.provideAnchors({ recentNews: _news, relevantNodes: _relevant, thinNodes: _thin, convoNames, visitedKeys, log: (m) => console.log(m) });

  // CITATION observation sink (curation substrate Slice 1): every graded claim — PROMOTED or HELD —
  // lands a durable row in the shared observation store (lib/curation_store), the home of record for
  // "requires citation". Held (uncited/inferred) claims queue as enrichment candidates. Still echoes a
  // compact [cite]/[held] line to the log. Fail-soft — a store hiccup never breaks a move.
  const observe = async (o) => {
    try { curationStore.record(db, { ...o, feed: 'graph-walk' }); } catch (e) { console.error('[cite] store failed:', e.message); }
    try { const tag = o.status === 'held' ? 'held' : 'cite'; console.log(`[${tag}] ${o.sourceEntity} —[${o.relation}]→ ${o.target || ''} (grade ${o.grade} ${Math.round((o.confidence || 0) * 100)}% ${o.url || 'no-url'})`); } catch {}
  };
  // kgEdges: the anchor's live edges WITH confidence + age, so the walk can decay-check what it's already
  // visiting (build + decay in one move). Reuses the A2-hardened relatedEntities read (tx_to IS NULL).
  const kgEdges = (id) => echoSuit.relatedEntities(id, { dispatch, limit: 50 });
  // STREAMING inline-promote (record pipeline): land each grounded new node the instant it's built so its
  // edges become proposable in the SAME move. ARMED under ZOE_INGEST_ENABLED — the same deliberate switch as
  // the F2 batch drain — so this doesn't silently move promotion into the autonomous loop. Uses a NON-autonomous
  // dispatch (like the ingest lane) so the promote clears the tier gate; the grounded gate + dedup-guard +
  // revert-log all live Echo-side. null when disarmed → growAround stays pure propose-only. Fail-soft.
  const _ingestArmed = /^(1|true|yes|on)$/i.test(String(process.env.ZOE_INGEST_ENABLED || '').trim());
  const promoteOne = _ingestArmed ? async ({ kind, name, proposal_id }) => {
    try {
      const args = { kind }; if (name) args.name = name; if (proposal_id != null) args.proposal_id = proposal_id;
      // Explicit — the ambient-lane fix (5bddfb5) made a bare dispatch here resolve AUTONOMOUS
      // (the monologue tick wraps lane.run), inverting this comment and hard-blocking every inline
      // promote under enforce (2026-08-15 deep-dive D2). autonomous:false restores the documented
      // design: deterministic code-computed args, same deliberate posture as the F2 batch drain.
      const r = await echoSuit.dispatch({ kind: 'do', name: 'promote_grounded_one', args }, { autonomous: false });
      return !!(r && r.ok);
    } catch { return false; }
  } : null;
  const move = await graphWalk.runMove({
    recentTurns, candidates: anchors, cloud, web, recall, dispatch, kgNeighbors, kgEdges, observe, promoteOne,
    getMeta: _gm, setMeta: _sm, now: () => Date.now(), log: (m) => console.log(m)
  });
  try { db.setMeta(GRAPHWALK_LAST_KEY, String(Date.now())); } catch {}

  if (move && move.acted && move.voiceLine) {
    // surface ONE compact line (graph growth is the output; this is the rare voiced move). Low volume:
    // gated by cadence + notability, so it does NOT reproduce the old free-association bloat.
    try {
      const imp = await importanceLib.score(move.voiceLine, { userName: db.getMeta('user_name') || 'them', kind: 'thought' });
      const row = db.insertMonologue({ content: move.voiceLine, model: 'graph-walk', type: 'thought', importance: imp });
      pushSheep({ id: row.id, ts: row.ts, content: move.voiceLine, type: 'thought', importance: imp });
      try { blackboard.append({ source: 'monologue', kind: 'thought', refTable: 'monologue', refId: row.id, content: move.voiceLine }); } catch {}
    } catch (e) { console.error('[graph-walk] voice surface failed:', e.message); }
    console.log(`[graph-walk] [${move.source || 'convo'}] ${move.kind} "${move.anchor}" → +${move.entities} obj / +${move.connections} conn${move.reverify ? ` / ${move.reverify} reverify` : ''}`);
  } else if (move && !move.acted) {
    console.log(`[graph-walk] no move (${move.reason || 'quiet'})`);
  }
  // Live-follow: tell the KG surface which entity she just enriched so a "Follow" toggle can re-center the
  // ego view on it. Only on a real acted move with an anchor. Fail-soft — the emit never breaks the move.
  if (move && move.acted && move.anchor && opts.emitFocusMove) {
    try { opts.emitFocusMove({ anchor: move.anchor, canonical: move.canonical || move.anchor, source: move.source || 'convo', kind: move.kind, entities: move.entities, connections: move.connections, at: Date.now() }); } catch {}
  }
  // RETURN THE ACTED STATUS (2026-07-23, freeze diagnostic — the main lane found the main process
  // pegging one core on a repeating "assessed → no move (no-gap)" block). This value is consumed ONLY
  // by the same-tick BURST loop (the graphLane closure): it used to return `true` even on a no-gap,
  // so the burst kept issuing MORE force-moves — each re-running the expensive frontier assess
  // (a 1.76M-row db scan) for nothing. Returning acted-status makes the burst STOP the instant there
  // is no gap: the diagnostic's "exit condition on the no-gap path". Free-association is gated upstream
  // by the tick's own `return`, never by this value, so narrowing it is safe.
  return !!(move && move.acted);
}

// PULLER LANE — the sibling of runGraphWalkMove. Where the graph-walk enriches a node's KG facts, this
// fills a MISSING contact detail (email) for a person the operator is working: pattern-fill from the
// domain's learned email format, else web-discovery (search + extract a stated address, cited). Shares
// the graph-walk's focus (activeSetNames); own cadence + rolling budget so the two lanes interleave on
// the idle tick. Consume-only w.r.t. the CRM — lands the Puller's own discovered facet. Fail-soft → false.
// mode: 'both' (legacy — enrich, then discover if enrich was dry) | 'contact' (enrich only, no discovery
// fallback) | 'discover' (discovery only). The pipeline (Slice 3) calls the two halves as SEPARATE
// concurrent stages ('contact' + 'discover'); 'both' preserves the exact pre-pipeline behavior for the
// legacy fallback. candidatesOverride: a pre-partitioned contact queue (pipeline supplies the ordered
// no-email targets) — replaces the internal full-store scan.
async function runPullerMove(_recentTurns, { mode = 'both', candidatesOverride = null } = {}) {
  const nowTs = Date.now();
  // Directed preemption widens the old discovery-only leash: the WHOLE contact mission (Hunter,
  // pattern-fill, web-discovery — the "find elected officials contact information" work) idles
  // while a USER-directed research run is active, not just the discovery stage.
  const wantContact = (mode === 'both' || mode === 'contact') && !_userDirectedActive();
  // DOMAIN LEASH (D1): suppress net-new DISCOVERY while a directed focus is active — discovery is the stage
  // that mints off-domain prospects (the medical-directory "Dr. X" records that then jam the promotion
  // queue). Contact-enrichment of already-held (on-domain) targets still runs. Single choke: covers the
  // 'both' idle call and the pipeline 'discover' stage. Reverts the moment no directed task is live.
  const wantDiscover = (mode === 'both' || mode === 'discover') && !_directedFocusActive();
  // cadence: contact/both on PULLER_LAST_KEY, a discover-only stage on its own key (so the concurrent
  // pipeline stages don't share — and starve — one cooldown).
  const _cadKey = (mode === 'discover') ? DISCOVER_LAST_KEY : PULLER_LAST_KEY;
  const _cadMs = (mode === 'discover') ? DISCOVER_MIN_INTERVAL_MS : PULLER_MIN_INTERVAL_MS;
  try { const last = parseInt(db.getMeta(_cadKey) || '0', 10) || 0; if (nowTs - last < _cadMs) return false; } catch {}
  const cfg = require('./config');
  const subc = require('./subconscious');
  const _gm = (k) => db.getMeta(k); const _sm = (k, v) => db.setMeta(k, v);
  if (!subc.budgetOk(_gm, nowTs, cfg.pullerBudgetTokensPerHour(), PULLER_BUDGET_KEY)) return false;
  if (!require('./quota_gate').allow('idle', { estimate: 1 }).allow) return false;   // pool-wide pace (REQUESTS)
  const pdb = require('./puller_db');
  const contactCard = require('../studio/contact_card');
  const beliefsLib = require('../studio/puller_beliefs');

  const activeKeys = new Set((activeSetNames() || []).map(n => pullerWalk.norm(n)));

  // candidates: local Puller targets, each flagged whether it already has an email belief (the gap we fill)
  // DOMAIN LEASH (D1 ext): while a directed focus is active, skip CONTACT enrichment over targets whose
  // org/domain is clearly OFF the focus domain — the pre-existing off-domain backlog (Miami-Dade schools,
  // Fresenius medical) that would otherwise keep surfacing "found a contact for Dr. X". Bare targets (no
  // company AND no domain to judge) still pass, so on-domain person rows aren't starved.
  const _contactLeash = _focusDomainTokens();
  const candidates = () => {
    const out = [];
    try {
      for (const t of pdb.listTargets({ limit: 120 })) {
        if (_contactLeash && (t.company || t.domain) && !_tokenHit(`${t.company || ''} ${t.domain || ''}`, _contactLeash)) continue;
        const has = !!pdb.getBelief(t.id, 'email');
        // GROUNDED = the target has a REAL provenance (an http page her browser read, a docstore drop, or
        // a CRM link) — not a wiki/web fallback. Only computed for pattern-fill-eligible targets (cost).
        let grounded = false;
        if (!has && t.domain) {
          if (t.crm_id != null) grounded = true;
          else { try { grounded = pdb.listObservations(t.id).some(o => /^(https?:\/\/|docstore:)/i.test(String(o.source_url || '')) || o.kind === 'doc'); } catch {} }
        }
        out.push({ id: t.id, name: t.name, company: t.company, domain: t.domain, hasEmail: has, grounded, ts: t.last_accessed_at || t.created_at || 0 });
      }
    } catch {}
    return out;
  };

  // web = BROWSER-FIRST fetch (Lucas: "use her browser") — search finds candidate URLs, then HER OWN
  // browser (lib/web — the ungated, prewarmed Chrome the chat chain uses; NOT the gated Echo browser_*
  // tools) opens + reads the real page. Falls back to the layered wiki/corpus/search fetch when her
  // browser yields nothing. Only fires on the idle tick, when her browser is otherwise free.
  const wikiUrl = (n) => 'https://en.wikipedia.org/wiki/' + encodeURIComponent(String(n || '').trim().replace(/\s+/g, '_'));
  const fallbackWeb = async (q) => graphWalk.fetchLayeredSources(q, { fetchPage, recallKnowledge: (nm, o) => echoSuit.recallKnowledge(nm, o), webSearch, wikiUrl, log: (m) => console.log(m) });
  // browserSearch: her real browser SEARCHES (open(query) → DDG SERP, served to a real browser where the
  // raw scraper is blocked) → opens the top result → reads the actual page. One {text,url,source} row.
  const prospectFetch = require('./prospect_fetch');
  const ownBrowser = require('./web');
  const browserSearch = async (query) => {
    try {
      if (!ownBrowser.isConnected()) { try { await ownBrowser.ensure(); } catch { return []; } }
      // MULTI-LAYER: land on the top result, then click THROUGH relevant sub-links (real team page, a
      // Contact page, individual bios) one layer deeper — merged as browser sources.
      const rows = await prospectFetch.deepBrowse(ownBrowser, query, { maxHops: 2, maxBios: 4, log: (m) => console.log(m),
        // a found PDF banks through the download lane (extract → decompose → dedup) instead of being discarded
        bankPdf: (u) => require('./web').downloadPdf(u, null) });
      return (rows || []).filter(r => r && r.text && r.text.length >= 200);
    } catch { return []; }
  };
  const web = prospectFetch.makeWebFetcher({ browserSearch, fallback: fallbackWeb, log: (m) => console.log(m) });
  let extract = null;
  try {
    const src = (require('./models').sources() || []).find(s => s.tier === 'cloud' && s.token);
    if (src) {
      const decompLane = require('./decomp_lane');
      const contactExtract = require('./contact_extract');
      const model = cfg.extractionModel() || cfg.subconsciousModel();
      const base = decompLane.makeCloudExtractor({ completeFn: completeDetailed, model, base: src.base, token: src.token, buildPrompt: contactExtract.buildCardsPrompt, parse: contactExtract.parseDocCards, numPredict: cfg.deepNumPredict() });
      extract = async (text, o) => {
        const r = await base(text, o);
        try { subc.recordSpend({ getMeta: _gm, setMeta: _sm, now: Date.now(), tokens: subc.estimateTokens([{ content: text }], JSON.stringify(r || {})), key: PULLER_BUDGET_KEY }); } catch {}
        return r;
      };
    }
  } catch {}

  // land: append the cited observation + set the active belief on the EXISTING target (NOT puller_ingest,
  // which is create-only). A verified email also credits its domain's email-pattern belief.
  const land = async (o) => {
    try {
      pdb.addObservation(o.targetId, { attr: o.attr, value: o.value, kind: o.kind, source: o.source, sourceUrl: o.sourceUrl, confidence: o.confidence });
      pdb.upsertBelief(o.targetId, o.attr, { value: o.value, confidence: o.confidence, derivation: o.derivation });
      if (o.attr === 'email' && (o.kind === 'verified' || o.kind === 'pattern')) {
        const t = pdb.getTarget(o.targetId); const domain = t && t.domain;
        if (domain) { const pat = beliefsLib.detectPatternUsed(o.value, t.name, domain); if (pat) pdb.savePatternState(domain, beliefsLib.updateBelief(pdb.getPatternState(domain), pat, 'valid')); }
      }
    } catch (e) { console.error('[puller-walk] land failed:', e.message); }
  };
  const triedFor = (id) => { try { return pdb.listObservations(id, { attr: 'email' }).map(x => x.value).filter(Boolean); } catch { return []; } };
  const refresh = (id) => {
    try {
      if (!opts.emitContactCard) return;
      const t = pdb.getTarget(id); if (!t) return;
      opts.emitContactCard(contactCard.cardFromTarget({ ...t, last_accessed_at: Date.now() }, pdb.listBeliefs(id), {}));
    } catch {}
  };

  // CONTACT stage (enrich an existing target's email). candidatesOverride = the pipeline's pre-partitioned
  // no-email queue; else the internal full-store scan (legacy 'both').
  // CONVERGENCE 2026-08-05: give the Puller the SHARED domain-resolver + Hunter, folded into the move, so the
  // whole contact mission runs on ONE set of organs (domain was the universal bottleneck — pattern-fill AND
  // Hunter both need it). hunterFind routes through Echo's hunter_find_email (the key resolves in Echo's
  // keychain, not here). Both are best-effort + fail-soft; the move degrades to pattern+web if they return null.
  const _resolveDomain = (org) => require('./domain_resolve').resolveDomain(org, { webSearch, log: (m) => console.log(m) });
  const _hunterFind = async ({ name, domain, company } = {}) => {
    const clean = String(name || '').replace(/\([^)]*\)/g, '').trim();
    const first = (clean.replace(/[^A-Za-z .'-]/g, '').trim().split(/\s+/).filter(Boolean)[0]) || '';
    let last = ''; try { last = require('./roster_intake').surnameOf(clean); } catch {}
    if (!first || !last) return null;
    const args = { first_name: first, last_name: last };
    if (domain) args.domain = domain; else if (company) args.company = company; else return null;
    try {
      const r = await echoSuit.dispatch({ kind: 'do', name: 'hunter_find_email', args }, { autonomous: true });
      let d = null; try { d = JSON.parse(String((r && r.text) || '')); } catch {}
      return (d && d.ok && d.email) ? d : null;
    } catch { return null; }
  };
  if (wantContact) {
    const candidatesFn = candidatesOverride ? (async () => candidatesOverride) : candidates;
    const move = await pullerWalk.runPullerMove({
      candidates: candidatesFn, activeKeys, getPatternState: (d) => pdb.getPatternState(d), triedFor,
      land, web, extract, refresh, getMeta: _gm, setMeta: _sm, now: () => Date.now(), log: (m) => console.log(m),
      hunterFind: _hunterFind, resolveDomain: _resolveDomain,
    });
    try { db.setMeta(PULLER_LAST_KEY, String(Date.now())); } catch {}
    if (move && move.acted) {
      console.log(`[puller-walk] ${move.mode} "${move.name}" → ${move.email || move.phone || ''}`);
      // Surface ONE compact line into the electric-sheep stream so the Puller lane is visible alongside the
      // graph-walk (Lucas). A grounded 'reading' (not a chatty 'thought'): cited — the web URL, or the
      // domain email-pattern it was derived from. Only on an acted move, so it can't spam.
      try {
        const val = move.email || move.phone || '';
        const via = move.mode === 'web'
          ? (move.url ? ` (${graphWalk.sourceLabel(move.url)})` : ' (web)')
          : (move.email ? ` (${String(move.email).split('@')[1] || ''} email pattern)` : '');
        const content = `Found a contact for ${move.name}: ${val}${via}`;
        const rr = db.insertMonologue({ content, model: 'puller-walk', type: 'reading', query: move.url || null });
        pushSheep({ id: rr.id, ts: rr.ts, content: `(found contact) ${move.name} → ${val}`, type: 'reading', query: move.url || null });
      } catch (e) { console.error('[puller-walk] sheep surface failed:', e.message); }
      return true;
    }
    // CONTACT-only stage does NOT fall through to discovery — that's the DISCOVER stage's job now.
    if (mode === 'contact') { console.log(`[puller-walk] contact: no fill (${(move && move.reason) || '?'})`); return false; }
  }

  if (!wantDiscover) return false;
  try { db.setMeta(DISCOVER_LAST_KEY, String(Date.now())); } catch {}
  // ENRICH found nothing to do → DISCOVERY: prospect an active org for NET-NEW people (Lucas: "when
  // there's nothing to enrich, find new targets — similar contacts from orgs already in the database").
  // Seed orgs = the operator's active orgs (recent org cards + the companies his targets belong to),
  // active-first; net-new means NOT already in the CRM or the Puller.
  const seedOrgs = () => {
    const seen = new Set(); const orgs = [];
    const add = (name, domain) => { const nm = String(name == null ? '' : name).trim(); const k = nm.toLowerCase(); if (nm.length >= 3 && !seen.has(k)) { seen.add(k); orgs.push({ name: nm, domain: domain || null }); } };
    try { for (const c of db.listRecentCards({ types: ['org'], limit: 20 })) add(c && c.name, null); } catch {}   // freshest active orgs first
    try {
      const byCompany = new Map();
      // ALL targets, not a recency-capped window — the sector orgs (Google, Duke Energy, …) were bulk-
      // loaded and aren't recently-accessed, so a 400-row window missed them entirely (→ no sector seed).
      for (const t of pdb.listTargets({ limit: 100000 })) {
        if (!t.company || t.company.includes(';')) continue;   // skip concatenated org-chart junk ("DOE; Office of the Secretary; …")
        const k = t.company.toLowerCase(); const e = byCompany.get(k);
        if (!e) byCompany.set(k, { name: t.company, domain: t.domain || null }); else if (!e.domain && t.domain) e.domain = t.domain;
      }
      for (const o of byCompany.values()) add(o.name, o.domain);
    } catch {}
    return orgs;
  };
  // dedup vs CRM (consume-only name match) + Puller — only keep people we don't already have
  const crmKnownNames = async (names) => {
    const set = new Set();
    try {
      const clean = [...new Set((names || []).map(n => String(n == null ? '' : n).trim()).filter(n => n.length >= 2))].slice(0, 40);
      if (!clean.length) return set;
      const inList = clean.map(n => `'${n.replace(/'/g, "''")}'`).join(',');
      // NON-SARGABLE by construction: the WHERE compares a TRIM(COALESCE(..)||' '||COALESCE(..))
      // expression, so no index on FirstName/LastName can be used and every call full-scans
      // electoral.contact — measured over the 5s default. timeout_seconds is the caller-side
      // stopgap; the real fix is a computed/indexed full-name column on the engine side (Echo
      // schema change → owner sign-off).
      const r = await echoSuit.dispatch({ kind: 'do', name: 'db_query', args: { sql: `SELECT DISTINCT TRIM(COALESCE(FirstName,'')||' '||COALESCE(LastName,'')) nm FROM electoral.contact WHERE deleted=0 AND TRIM(COALESCE(FirstName,'')||' '||COALESCE(LastName,'')) IN (${inList})`, params: [], timeout_seconds: 20 } });
      if (r && r.ok) { let j; try { j = JSON.parse(r.text); } catch {} for (const row of ((j && j.rows) || [])) if (row.nm) set.add(String(row.nm).toLowerCase()); }
      else console.error('[known-contacts] electoral lookup FAILED →', String((r && r.text) || 'no response').slice(0, 160));
    } catch {}
    return set;
  };
  const filterNew = async (people) => {
    const inCrm = await crmKnownNames((people || []).map(p => p && p.name));
    return (people || []).filter(p => {
      const nm = String((p && p.name) || '').trim(); if (!nm) return false;
      if (inCrm.has(nm.toLowerCase())) return false;
      try { if (pdb.findTargetByName(nm)) return false; } catch {}
      return true;
    });
  };
  const createTargetFn = ({ name, company, domain, title, sourceUrl }) => {
    try {
      // #43 NAME-QUALITY GATE: web discovery surfaces roles/orgs/mailboxes as "people"; minting them
      // burns the next pull on a non-existent human. Reject junk here (the walk treats null as "skip").
      if (require('../studio/puller_name_gate').isJunkPersonName(name)) return null;
      const t = pdb.createTarget({ kind: 'person', name, company: company || null, domain: domain || null, notes: title || null });
      if (t && title) { try { pdb.addObservation(t.id, { attr: 'role', value: title, kind: 'web', source: 'web-prospect', sourceUrl }); pdb.upsertBelief(t.id, 'role', { value: title, confidence: 0.6, derivation: 'web-prospect' }); } catch {} }
      return t ? t.id : null;
    } catch { return null; }
  };
  const observe = (o) => { try { curationStore.record(db, { ...o, feed: 'puller' }); } catch {} };
  // GRAB + STORE the official headshot for a freshly-minted person: match them to a page image, store the
  // URL (shows on the card), and download a local reference copy → data/faces/<id>.jpg (the image the later
  // face-matching stage compares social avatars against). All fail-soft; a missing photo never blocks a mint.
  const attachPhoto = async (id, name, images) => {
    try {
      const src = prospectFetch.matchPhotoForPerson(name, images);
      if (!src) return;
      try { pdb.setPhoto(id, { url: src }); } catch {}
      try {
        const dest = require('path').join(require('./config').APP_ROOT, 'data', 'faces', `${id}.jpg`);
        const r = await require('./photo_grab').downloadPhoto(src, dest);
        if (r && r.ok) { pdb.setPhoto(id, { path: dest }); console.log(`[puller-walk] grabbed headshot for ${name} → data/faces/${id}.jpg`); }
      } catch {}
      try { refresh(id); } catch {}
    } catch {}
  };

  // PHOTO ON ENCOUNTER: a KNOWN person seen on a page still gets their headshot attached to the
  // EXISTING node (the master node keeps growing; setPhoto never overwrites an earlier photo).
  const attachPhotoExisting = async (name, images) => {
    try {
      const t = pdb.findTargetByName(name);
      if (!t || t.photo_url || t.photo_path) return;
      await attachPhoto(t.id, name, images);
    } catch {}
  };
  const disc = await pullerWalk.runDiscoveryMove({
    seedOrgs, filterNew, createTarget: createTargetFn, web, extract, land, refresh, observe, attachPhoto,
    attachPhotoExisting,
    getMeta: _gm, setMeta: _sm, now: () => Date.now(), log: (m) => console.log(m),
  });
  if (disc && disc.acted) {
    console.log(`[puller-walk] discover "${disc.org}" → +${disc.count} new`);
    try {
      const names = (disc.created || []).map(c => c.name).join(', ');
      const content = `Prospected ${disc.org} — found ${disc.count} new contact${disc.count === 1 ? '' : 's'}: ${names}`;
      const rr = db.insertMonologue({ content, model: 'puller-walk', type: 'reading', query: disc.url || null });
      pushSheep({ id: rr.id, ts: rr.ts, content: `(new contacts) +${disc.count} at ${disc.org}`, type: 'reading', query: disc.url || null });
    } catch (e) { console.error('[puller-walk] sheep surface failed:', e.message); }
    return true;
  }
  console.log(`[puller-walk] discover: no move (${(disc && disc.reason) || '?'})`);
  return false;
}

// SLICE 3 — the flat candidate snapshot the pipeline partitions into the CONTACT / ENRICH queues. Each row
// carries the two facets that define a target's lifecycle stage: hasEmail (an email belief) and hasDeep (a
// social/OSINT observation, the maigret marker). Bounded scan — cheap, and deep enough to reach the
// backpressure cap. Mirrors runPullerMove's internal candidates() shape (+ hasDeep) so the contact queue
// can be handed straight to pullerWalk.pickTarget as candidatesOverride.
function _pullerCandidateSnapshot({ limit = 500 } = {}) {
  const pdb = require('./puller_db');
  const out = [];
  try {
    // VALUE-SCOPED draw (leash slice B): CRM-linked/promoted targets first (the Puller is the CRM's
    // completion engine), then the recency tail minus the bulk-roster mega-companies — the plain
    // most-recently-accessed draw wandered a 606k store with no value dimension. ZOE_PULLER_VALUESCOPE=0
    // reverts to the legacy draw.
    const scoped = String(process.env.ZOE_PULLER_VALUESCOPE || '1').trim() !== '0';
    const rows = (scoped && typeof pdb.listValueScopedTargets === 'function')
      ? pdb.listValueScopedTargets({ limit }) : pdb.listTargets({ limit });
    for (const t of rows) {
      let hasEmail = false, hasDeep = false, grounded = false;
      try { hasEmail = !!pdb.getBelief(t.id, 'email'); } catch {}
      try { hasDeep = pdb.listObservations(t.id, { attr: 'social' }).length > 0; } catch {}
      if (!hasEmail && t.domain) {
        if (t.crm_id != null) grounded = true;
        else { try { grounded = pdb.listObservations(t.id).some(o => /^(https?:\/\/|docstore:)/i.test(String(o.source_url || '')) || o.kind === 'doc'); } catch {} }
      }
      out.push({ id: t.id, name: t.name, company: t.company, domain: t.domain, hasEmail, hasDeep, grounded, ts: t.last_accessed_at || t.created_at || 0 });
    }
  } catch {}
  return out;
}

// The ENRICH stage — deep social/OSINT facets (maigret) on CONTACTED targets. Thin wrapper that biases the
// social-enrich pick toward the pipeline's enrich queue (has-email, not-yet-deepened, active-first) while
// keeping its own known-handle gate + monthly cooldown. Falls back to the full scan if the queue is dry.
async function runEnrichStage(enrichQueue) {
  const preferIds = (Array.isArray(enrichQueue) ? enrichQueue : []).map((t) => t && t.id).filter((v) => v != null);
  // Two deep-facet behaviors, each self-limited by its own cadence: face-confirm a PUBLIC profile (needs a
  // reference headshot) + maigret social-enrich (needs a known handle). Both fail-soft.
  const a = await runProfileConfirmMove(preferIds).catch((e) => { console.error('[profile-confirm] error:', e && e.message); return false; });
  const b = await runSocialEnrichMove(preferIds).catch((e) => { console.error('[social-enrich] error:', e && e.message); return false; });
  return a || b;
}

// SLICE 3 — the layered pipeline tick. DISCOVER → CONTACT → ENRICH run as three CONCURRENT stages that hand
// work forward by target lifecycle stage; BACKPRESSURE holds DISCOVER when the contact backlog is deep so
// the operator can't outrun the puller. Reuses the existing stage workers (runPullerMove contact/discover
// modes + runSocialEnrichMove); lib/pipeline is the pure brain (partition + shouldDiscover). Fail-soft.
async function runPipelineTick(recentTurns) {
  const cfg = require('./config');
  const pipeline = require('./pipeline');
  const snapshot = _pullerCandidateSnapshot();
  const activeKeys = new Set((activeSetNames() || []).map((n) => pullerWalk.norm(n)));
  const { contact, enrich } = pipeline.partition(snapshot, { activeKeys, norm: pullerWalk.norm });
  const cap = cfg.pipelineContactBacklogCap();
  console.log(`[pipeline] ${pipeline.describe({ contact, enrich }, { cap })}`);

  const stages = [];
  // CONTACT — drain the no-email queue (pipeline supplies the ordered candidates; pickTarget re-ranks + honors its cooldown).
  stages.push(runPullerMove(recentTurns, { mode: 'contact', candidatesOverride: contact }).catch((e) => console.error('[pipeline] contact error:', e && e.message)));
  // DISCOVER — mint net-new targets, but only when CONTACT can keep up (backpressure on the backlog depth).
  if (pipeline.shouldDiscover({ contactDepth: contact.length, cap })) {
    stages.push(runPullerMove(recentTurns, { mode: 'discover' }).catch((e) => console.error('[pipeline] discover error:', e && e.message)));
  }
  // ENRICH — deep social/OSINT facets on contacted targets (biased to the enrich queue).
  stages.push(runEnrichStage(enrich).catch((e) => console.error('[pipeline] enrich error:', e && e.message)));
  // ORG RESEARCH — research an org target from its own P856-corroborated site (bounded, low-volume,
  // self-cadenced so it fires at most once every ORG_MIN_INTERVAL_MS regardless of the tick rate).
  stages.push(runOrgResearchStage().catch((e) => console.error('[pipeline] org error:', e && e.message)));
  await Promise.allSettled(stages);
}

// LANE C — SOCIAL ENRICH (maigret, idle). Picks ONE held target that has a KNOWN handle (personal-email
// localpart or a CRM social_handle) and hasn't been processed this month, runs maigret, and stages ONLY
// corroborated (2+ signal) accounts as grade-E Puller observations. Consume-only, verify-before-promote.
// Known-handles-only + a strict gate mean it acts on FEW targets and stages little (see the yield note) —
// deliberately low-volume. Cadence + a 30-day per-target cooldown are the gates. Never throws.
async function runSocialEnrichMove(preferIds = null) {
  const nowTs = Date.now();
  try { const last = parseInt(db.getMeta(SOCIAL_LAST_KEY) || '0', 10) || 0; if (nowTs - last < SOCIAL_MIN_INTERVAL_MS) return false; } catch {}
  try {
    const pdb = require('./puller_db'); pdb.init();
    const em = require('./enrich_maigret');

    // attempted-cooldown set (per target, 30-day TTL) — doubles as the "already processed" marker
    let attArr = []; try { attArr = JSON.parse(db.getMeta(SOCIAL_ATTEMPT_KEY) || '[]'); } catch {}
    attArr = (Array.isArray(attArr) ? attArr : []).filter((e) => Array.isArray(e) && (nowTs - (Number(e[1]) || 0) < SOCIAL_ATTEMPT_TTL_MS));
    const attempted = new Set(attArr.map((e) => e[0]));

    // ENRICH-stage ordering (pipeline Slice 3): try the pipeline's enrich queue FIRST (contacted targets —
    // has-email, not-yet-deepened, active-first), then the full store as a fallback. Without a queue this is
    // the plain full scan (legacy). Dedup so a preferred id isn't re-visited in the fallback pass.
    const orderedTargets = () => {
      const seen = new Set(); const list = [];
      if (Array.isArray(preferIds)) { for (const id of preferIds) { const t = pdb.getTarget(id); if (t && !seen.has(t.id)) { seen.add(t.id); list.push(t); } } }
      for (const t of pdb.listTargets({ limit: 100000 })) { if (!seen.has(t.id)) { seen.add(t.id); list.push(t); } }
      return list;
    };

    // pick the first eligible target: not attempted, and a KNOWN-handle source exists (personal email → a
    // localpart, or a crm_id whose CRM handles we'll fetch below). Bounded scan so a tick stays cheap.
    let pick = null, contact = null, scanned = 0;
    for (const t of orderedTargets()) {
      if (attempted.has(String(t.id))) continue;
      scanned++;
      const email = (pdb.getBelief(t.id, 'email') || {}).value || null;
      const c = { name: t.name, email, company: t.company || null };
      if (em.knownHandles(c, []).length === 0 && t.crm_id == null) continue;   // no known-handle source
      pick = t; contact = { ...c, crmId: t.crm_id || null }; break;
    }
    try { db.setMeta(SOCIAL_LAST_KEY, String(nowTs)); } catch {}
    if (!pick) { console.log(`[social-enrich] idle: no eligible target (scanned ${scanned} unprocessed, none with a known handle)`); return false; }

    // mark processed BEFORE the run (once/month; a barren result shouldn't cause a re-scan next tick)
    attArr.push([String(pick.id), nowTs]);
    try { db.setMeta(SOCIAL_ATTEMPT_KEY, JSON.stringify(attArr.slice(-2000))); } catch {}

    // KNOWN CRM handles (consume-only read) if this person is linked to a CRM row
    let crmHandles = [];
    if (contact.crmId != null && echoSuit && echoSuit.connected) {
      try {
        const r = await echoSuit.dispatch({ kind: 'do', name: 'db_query', args: { sql: `SELECT Platform__c AS platform, Handle__c AS handle FROM electoral.social_handle__c WHERE deleted=0 AND Contact__c = ${Number(contact.crmId)}`, params: [] } });
        if (r && r.ok) { let j; try { j = JSON.parse(r.text); } catch {} crmHandles = ((j && j.rows) || []).filter((x) => x && x.handle); }
      } catch {}
    }

    const res = await em.enrichContact(contact, crmHandles, { topSites: 50, timeout: 8 });
    const staged = res.staged || [];
    if (!staged.length) { console.log(`[social-enrich] idle: ${contact.name} — ${res.handles || 0} known handle(s), 0 corroborated`); return false; }
    for (const s of staged) {
      try { pdb.addObservation(pick.id, { attr: 'social', value: `${s.site}|${s.url}`, kind: 'osint', source: `maigret:${s.handle}`, sourceUrl: s.url, confidence: 0.3 }); }
      catch (e) { console.error('[social-enrich] observe failed:', e.message); }
    }
    console.log(`[social-enrich] idle: ${contact.name} → +${staged.length} grade-E social obs (${staged.map((s) => s.site).join(', ')})`);
    // refresh the rail card so the handles show (labeled unverified)
    try {
      const cc = require('../studio/contact_card');
      const social = cc.socialFromObservations(pdb.listObservations(pick.id, { attr: 'social' }));
      if (opts.emitContactCard) opts.emitContactCard(cc.cardFromTarget(pdb.getTarget(pick.id) || pick, pdb.listBeliefs(pick.id), {}, { social }));
    } catch (e) { console.error('[social-enrich] card refresh failed:', e.message); }
    try {
      const content = `Found social accounts for ${contact.name}: ${staged.map((s) => s.site).join(', ')} (unverified)`;
      const rr = db.insertMonologue({ content, model: 'social-enrich', type: 'reading', query: staged[0].url || null });
      pushSheep({ id: rr.id, ts: rr.ts, content: `(social) ${contact.name} → ${staged.map((s) => s.site).join(', ')}`, type: 'reading', query: staged[0].url || null });
    } catch (e) { console.error('[social-enrich] sheep surface failed:', e.message); }
    return true;
  } catch (e) { console.error('[social-enrich] idle move failed:', e.message); return false; }
}

// --- ORG RESEARCH lane helpers (docs/ORG_RESEARCH_LANE.md) ----------------------------------------
// The P856 ACCOUNTS (host → { url, name }), fetched from the CRM once and cached 1h. These accounts ARE
// the org population with an ADMISSIBLE url — a Wikidata-P856 Website is the register itself, provenance
// 'register' by construction — so the lane researches them directly (2,179 of them: think tanks, unions,
// advocacy, legislatures…), not the thin/person-polluted puller org targets. One 2k-row query/hour.
const _ORG_P856 = { at: 0, map: null };
async function _p856Accounts() {
  const nowTs = Date.now();
  if (_ORG_P856.map && (nowTs - _ORG_P856.at) < 60 * 60 * 1000) return _ORG_P856.map;
  const map = new Map();
  try {
    if (echoSuit && echoSuit.connected) {
      const r = await echoSuit.dispatch({ kind: 'do', name: 'db_query', args: { sql: `SELECT Name, Website FROM electoral.account WHERE deleted=0 AND Website IS NOT NULL AND Website != ''` } });
      if (r && r.ok) {
        let j; try { j = JSON.parse(r.text); } catch {}
        const orgWalk = require('./org_walk');
        for (const row of (j && j.rows) || []) { const url = orgWalk.normalizeSiteUrl(row.Website); const h = orgWalk.hostOf(url); if (h && url && !map.has(h)) map.set(h, { url, name: String(row.Name || '') }); }
      }
    }
  } catch (e) { console.error('[org-research] P856 account fetch failed:', e.message); }
  _ORG_P856.at = nowTs; _ORG_P856.map = map;
  return map;
}
// Crude HTML → readable text (feeds the extractor, which reads prose) — mirrors scripts/research_org.js.
function _orgToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
// Fetch an org's own site (follow redirects, cap body, time out). The url is P856-asserted; verifyPage
// still proves the page is theirs after this returns.
// EVERY exit SETTLES (2026-08-12 review H1): the old truncation branch destroyed the socket without
// resolving — 'end' never fires after destroy, the inactivity timer dies WITH the socket, and the
// promise hung forever. org_walk bare-awaits this and the tick latches inFlight around it, so ONE
// oversized page permanently killed the whole subconscious until restart (reproduced live-shaped).
// Now: truncation RESOLVES with what was buffered (4MB of an org's homepage is plenty for the
// extractor), and 'close' settles any other no-end death (server drop mid-stream).
const ORG_FETCH_MAX_BYTES = 4_000_000;
function _fetchOrgPage(url, { depth = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (depth > 4) return reject(new Error('too many redirects'));
    let mod;
    try { mod = /^http:\/\//i.test(url) ? require('http') : require('https'); } catch { mod = require('https'); }
    const req = mod.get(url, { headers: { 'User-Agent': 'SideQuest/1.0 (civic research; contact via repo owner)' }, timeout: 12000 }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        try { return resolve(_fetchOrgPage(new URL(r.headers.location, url).toString(), { depth: depth + 1 })); } catch (e) { return reject(e); }
      }
      let b = '';
      r.setEncoding('utf8');
      r.on('data', (c) => {
        b += c;
        if (b.length > ORG_FETCH_MAX_BYTES) { resolve({ text: _orgToText(b), status: r.statusCode, truncated: true }); r.destroy(); }
      });
      r.on('end', () => resolve({ text: _orgToText(b), status: r.statusCode }));
      r.on('close', () => reject(new Error('connection closed before end')));   // no-op if already settled
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}
// Whole-chain deadline (belt for H1's suspenders): no fetch — plain OR browser-fallback — may wedge
// the tick past this, whatever a future edit does inside. Resolves the failure shape, never throws.
const ORG_FETCH_DEADLINE_MS = 90_000;
function _withFetchDeadline(p, url) {
  let t;
  const deadline = new Promise((res) => {
    t = setTimeout(() => {
      console.error(`[org-research] fetch DEADLINE (${ORG_FETCH_DEADLINE_MS / 1000}s) — abandoning ${String(url).slice(0, 120)} (tick must never wedge)`);
      res({ text: '', status: 0, deadline: true });
    }, ORG_FETCH_DEADLINE_MS);
    if (t && t.unref) t.unref();
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(t));
}
// Fetch with a BROWSER fallback: some org sites (Cato → 403) block a bare GET; her own Chrome gets
// through (open→read the page). Only fires when the cheap https fetch came back short/blocked.
async function _fetchOrgPageWithFallback(url) {
  return _withFetchDeadline((async () => {
    let r = null;
    try { r = await _fetchOrgPage(url); } catch { r = null; }
    if (r && r.text && r.text.length >= 200 && !(r.status >= 400)) return r;
    try {
      const ownBrowser = require('./web');
      if (!ownBrowser.isConnected()) { await ownBrowser.ensure(); }
      await ownBrowser.open(url);
      const rd = await ownBrowser.read();
      const text = (rd && rd.text) || '';
      if (text && text.length >= 200) return { text, status: 200, via: 'browser' };
    } catch (e) { console.error('[org-research] browser fetch failed:', e && e.message); }
    return r || { text: '', status: 0 };
  })(), url);
}

// LANE — ORG RESEARCH. Researches ONE org from the CRM's P856 accounts (each Website is the register, so
// provenance 'register' — never a bare-domain guess), fetching its own site (browser fallback for blockers),
// proving it's theirs (org_site.verifyPage), landing it as an org_research document (the decompose lane
// extracts entities/relations — no second stack), and marking it done (a durable host set + an official_site
// belief on any matching puller org target, so listOrgTargets stays clean). Bounded, low-volume, idle-gated.
async function runOrgResearchStage() {
  // ONE-SHOT FORCE (ZOE_ORG_FORCE_FIRE=1) — a validation affordance, OFF by default: the FIRST tick after
  // boot bypasses the cadence/budget/quota gates so the lane can be proven end-to-end under the compute
  // burn-down (which otherwise defers idle indefinitely). echoSuit is still required (the url source IS the
  // CRM). Self-clears after one fire, so it never turns into an un-throttled loop.
  const force = (!_orgForcedOnce && process.env.ZOE_ORG_FORCE_FIRE === '1');
  const nowTs = Date.now();
  if (!force) { try { const last = parseInt(db.getMeta(ORG_LAST_KEY) || '0', 10) || 0; if (nowTs - last < ORG_MIN_INTERVAL_MS) return false; } catch {} }
  const cfg = require('./config');
  const subc = require('./subconscious');
  if (!force && !subc.budgetOk((k) => db.getMeta(k), nowTs, cfg.pullerBudgetTokensPerHour(), PULLER_BUDGET_KEY)) return false;
  if (!force && !require('./quota_gate').allow('idle', { estimate: 1 }).allow) return false;
  if (!echoSuit || !echoSuit.connected) return false;   // the admissible url is a P856 account Website — no CRM, no source
  if (force) { _orgForcedOnce = true; console.log('[org-research] FORCED one-shot fire (ZOE_ORG_FORCE_FIRE) — cadence/budget/quota bypassed for this tick only'); }
  try { db.setMeta(ORG_LAST_KEY, String(nowTs)); } catch {}

  const orgWalk = require('./org_walk');
  const accts = await _p856Accounts();
  if (!accts || !accts.size) return false;

  // durable done-set (researched hosts) + a host→pullerTargetId map so a researched account can mark its
  // matching person-lane org target done too (keeps listOrgTargets meaningful — it drops linked orgs).
  let done = new Set(); try { done = new Set(JSON.parse(db.getMeta(ORG_DONE_KEY) || '[]')); } catch {}
  const pdb = require('./puller_db'); pdb.init();
  const orgTargetByHost = new Map();
  try { for (const t of pdb.listOrgTargets({ limit: 3000 })) { const h = orgWalk.hostOf(t.domain); if (h && !orgTargetByHost.has(h)) orgTargetByHost.set(h, t.id); } } catch {}

  // candidates = un-researched P856 accounts; a HIS-ORG match (a puller org target on this host) sorts first.
  const cands = [];
  for (const [host, a] of accts) {
    if (done.has(host)) continue;
    cands.push({ id: host, name: a.name || host, domain: host, crm_id: orgTargetByHost.has(host) ? 1 : null, urlCandidates: [{ url: a.url, provenance: 'register' }] });
    if (cands.length >= 120) break;
  }
  if (!cands.length) return false;

  const r = await orgWalk.runOrgMove({
    candidates: cands,
    getMeta: (k) => db.getMeta(k), setMeta: (k, v) => db.setMeta(k, v), now: () => Date.now(),
    fetchPage: _fetchOrgPageWithFallback,
    land: async ({ name, url, text }) => {
      // doc_store.land (NOT a bare db.insertDocument): it content-dedups (a re-fetched site is one
      // encounter, not a second source), C1-scores the landing (importance._DOC_BASE.org_research=6),
      // and bumps the C3 reflection accumulator on a substantive site — so a researched org finally
      // feeds restlessness instead of landing importance=null. The decompose sweep still reads it (it
      // watches the documents table by source='org_research', independent of the insert path).
      const r = require('./doc_store').land({ title: `${name} — official website`, body: text, source: 'org_research', ref: url, origin: url });
      return r && r.id;
    },
    markResearched: async (t, url) => {
      try { const d = new Set(JSON.parse(db.getMeta(ORG_DONE_KEY) || '[]')); d.add(t.domain); db.setMeta(ORG_DONE_KEY, JSON.stringify([...d].slice(-8000))); } catch {}
      try { const tid = orgTargetByHost.get(t.domain); if (tid) pdb.upsertBelief(tid, 'official_site', { value: url, confidence: 1, derivation: 'org_research', status: 'active' }); } catch {}
    },
    log: (m) => console.log(m),
  });
  if (r && r.did) {
    try {
      const nm = (cands.find((c) => c.id === r.targetId) || {}).name || 'an organisation';
      const content = `I researched "${nm}" from its own website (${r.url}) and landed it for the graph to read.`;
      const rr = db.insertMonologue({ content, model: 'org-research', type: 'reading', query: r.url, urls: [r.url] });
      pushSheep({ id: rr.id, ts: rr.ts, content: `(org) ${nm} → ${r.url}`, type: 'reading', query: r.url });
    } catch {}
  }
  return !!(r && r.did);
}

// PROFILE-CONFIRM (face-match Slice 2b) — CONFIRM which PUBLIC social/professional profile is a contact,
// using the reference headshot grabbed at discovery. Flow: pick a target that HAS a headshot → ensure its
// reference face embedding (cache) → web-SEARCH candidate public profiles by name+org → for each, open it +
// grab its profile photo → face-compare against the reference → store MATCHES as grade-E observations.
// Confirmation only (never reverse-face-search); public info only; verify-before-promote. Slow + human-paced
// (a browser open + a face-embed per candidate) — cadence + a monthly per-target cooldown are the gates.
async function runProfileConfirmMove(preferIds = null) {
  const nowTs = Date.now();
  try { const last = parseInt(db.getMeta(PROFILE_LAST_KEY) || '0', 10) || 0; if (nowTs - last < PROFILE_MIN_INTERVAL_MS) return false; } catch {}
  try {
    const pdb = require('./puller_db'); pdb.init();
    const faceMatch = require('./face_match');
    const profileConfirm = require('./profile_confirm');
    const ownBrowser = require('./web');
    const cc = require('../studio/contact_card');

    // per-target monthly cooldown (also the "already attempted" marker)
    let attArr = []; try { attArr = JSON.parse(db.getMeta(PROFILE_ATTEMPT_KEY) || '[]'); } catch {}
    attArr = (Array.isArray(attArr) ? attArr : []).filter((e) => Array.isArray(e) && (nowTs - (Number(e[1]) || 0) < PROFILE_ATTEMPT_TTL_MS));
    const attempted = new Set(attArr.map((e) => e[0]));

    // pick a target with a reference HEADSHOT (photo_path), enrich-queue first; skip attempted.
    const ordered = () => {
      const seen = new Set(); const list = [];
      if (Array.isArray(preferIds)) for (const id of preferIds) { const t = pdb.getTarget(id); if (t && !seen.has(t.id)) { seen.add(t.id); list.push(t); } }
      for (const t of pdb.listTargets({ limit: 100000 })) if (!seen.has(t.id)) { seen.add(t.id); list.push(t); }
      return list;
    };
    let pick = null;
    for (const t of ordered()) { if (attempted.has(String(t.id))) continue; if (!t.photo_path) continue; pick = t; break; }
    try { db.setMeta(PROFILE_LAST_KEY, String(nowTs)); } catch {}
    if (!pick) return false;
    attArr.push([String(pick.id), nowTs]);
    try { db.setMeta(PROFILE_ATTEMPT_KEY, JSON.stringify(attArr.slice(-2000))); } catch {}

    // reference embedding — cache on the target so we don't re-embed the headshot each run.
    let refEmb = pdb.getFaceEmbedding(pick.id);
    if (!refEmb) {
      const er = await faceMatch.embedImages([{ id: 'ref', path: pick.photo_path }]);
      const r0 = er && er.ok && (er.results || []).find((x) => x.id === 'ref' && x.ok);
      if (r0) { refEmb = r0.embedding; try { pdb.setFaceEmbedding(pick.id, refEmb); } catch {} }
    }
    if (!Array.isArray(refEmb) || !refEmb.length) { console.log(`[profile-confirm] ${pick.name}: no usable reference face`); return false; }

    // live deps
    const search = async (q) => { try { return (await webSearch(q)) || []; } catch { return []; } };
    const fetchProfileImage = async (url) => {
      try {
        if (!ownBrowser.isConnected()) { try { await ownBrowser.ensure(); } catch { return null; } }
        const o = await ownBrowser.open(url); if (!o || !o.ok) return null;
        const imgs = (await ownBrowser.pageImages()) || [];
        if (!imgs.length) return null;
        imgs.sort((a, b) => (b.w * b.h) - (a.w * a.h));                     // profile photo = the largest sensible image
        const best = imgs.find((im) => im.w >= 100 && im.h >= 100) || imgs[0];
        return best ? best.src : null;
      } catch { return null; }
    };
    const confirmFace = async (refEmbedding, imgUrl) => {
      const er = await faceMatch.embedImages([{ id: 'c', url: imgUrl }]);
      const c0 = er && er.ok && (er.results || []).find((x) => x.id === 'c' && x.ok);
      if (!c0) return { same: false, similarity: 0 };
      const sim = faceMatch.cosine(refEmbedding, c0.embedding);
      return { same: sim >= faceMatch.SAME_FACE_THRESHOLD, similarity: sim };
    };

    const res = await profileConfirm.confirmProfiles({
      name: pick.name, org: pick.company, refEmbedding: refEmb,
      search, fetchProfileImage, confirmFace, max: 6, log: (m) => console.log(m),
    });
    if (!res || !res.ok || !res.matches.length) { console.log(`[profile-confirm] ${pick.name}: checked ${(res && res.checked) || 0}, 0 confirmed`); return false; }

    // store each confirmed profile as a grade-E observation (face-confirmed → higher confidence than a bare handle)
    for (const m of res.matches) {
      try { pdb.addObservation(pick.id, { attr: 'social', value: `${m.platform}|${m.url}`, kind: 'face-confirmed', source: 'profile-confirm', sourceUrl: m.url, confidence: 0.7 }); } catch {}
    }
    // HARVEST any STATED PUBLIC email off the confirmed profile pages (public info; cited; never invented;
    // masked/broker teasers dropped). Lands as a cited observation + fills the email belief if empty.
    try {
      const emailHarvest = require('./email_harvest');
      const already = new Set(pdb.listObservations(pick.id, { attr: 'email' }).map((x) => x.value));
      let hasBelief = !!pdb.getBelief(pick.id, 'email');
      const landed = [];
      for (const m of res.matches) {
        let text = '';
        // autonomous content fetch → re-spin brake serves a just-read page from cache (no re-fetch);
        // o.reading is the cached body on a dedup hit, else a normal web-read.
        try { const o = await ownBrowser.open(m.url, { autonomous: true }); if (o && o.ok) { const rd = o.dedup ? { text: o.reading } : await ownBrowser.read(); text = (rd && rd.text) || ''; } } catch {}
        if (!text) continue;
        for (const f of emailHarvest.extractEmails(text, { name: pick.name, orgDomain: pick.domain || '' }).slice(0, 3)) {
          if (already.has(f.email)) continue; already.add(f.email);
          try {
            pdb.addObservation(pick.id, { attr: 'email', value: f.email, kind: 'public', source: `profile:${m.platform}`, sourceUrl: m.url, confidence: f.confidence });
            if (!hasBelief) { pdb.upsertBelief(pick.id, 'email', { value: f.email, confidence: f.confidence, derivation: `public:${m.platform}` }); hasBelief = true; }
            landed.push(f.email);
          } catch {}
        }
      }
      if (landed.length) console.log(`[profile-confirm] ${pick.name} → +${landed.length} public email(s): ${landed.join(', ')}`);
    } catch (e) { console.error('[profile-confirm] email harvest failed:', e.message); }
    try {
      const social = cc.socialFromObservations(pdb.listObservations(pick.id, { attr: 'social' }));
      if (opts.emitContactCard) opts.emitContactCard(cc.cardFromTarget(pdb.getTarget(pick.id) || pick, pdb.listBeliefs(pick.id), {}, { social }));
    } catch (e) { console.error('[profile-confirm] card refresh failed:', e.message); }
    try {
      const plats = res.matches.map((m) => m.platform).join(', ');
      const rr = db.insertMonologue({ content: `Confirmed ${pick.name}'s public profile(s) by face-match: ${plats}`, model: 'profile-confirm', type: 'reading', query: res.matches[0].url });
      pushSheep({ id: rr.id, ts: rr.ts, content: `(profile) ${pick.name} → ${plats} (face-confirmed)`, type: 'reading', query: res.matches[0].url });
    } catch (e) { console.error('[profile-confirm] sheep failed:', e.message); }
    console.log(`[profile-confirm] ${pick.name} → ${res.matches.length} confirmed profile(s): ${res.matches.map((m) => m.platform).join(', ')}`);
    return true;
  } catch (e) { console.error('[profile-confirm] move failed:', e.message); return false; }
}

async function maybeSearchFromThought(thoughtText, focusId = null) {
  const trig = detectCuriosity(thoughtText);
  if (!trig.triggered || !trig.query) return;
  if (recentSearchHappened()) return;

  // R7 — SWIRL BRAKE, now INSIDE focuses too. The old guard exempted focus searches ("intentional
  // deepening"), but a focus can permute ONE vein endlessly ("STDP energy" ×5). The cluster-density
  // brake catches that; on a hit we don't just suppress — we CONSOLIDATE what she has + point at the
  // next agenda gap, turning lateral permutation into forward iteration (discovery → evolution).
  if (await isRepeatOfRecentSearch(trig.query)) {
    console.log(`[monologue] swirl braked → consolidate+advance: "${trig.query.slice(0, 60)}"`);
    await consolidateAndAdvance(trig.query, focusId);
    return;
  }

  // R6 — ACTIVE DB INTEGRATION: consult her memory + the master DB BEFORE the web. Rich coverage →
  // don't re-derive; surface what she knows AND redirect to a NOVEL frontier gap (not just stop).
  try {
    const ar = require('./active_recall');
    const r = await ar.recall(trig.query, { minRelevance: 0.5 });   // gate precision ≥0.5 (not the 0.33 surfacing floor)
    if (r.coverage === 'rich') {
      await consolidateAndAdvance(trig.query, focusId, r);
      return;
    }
  } catch (e) { console.error('[active_recall] gate failed:', e.message); }

  await runSearch(trig.query, 'curiosity', focusId);
}

// Turn a braked/known query into FORWARD motion: bank a consolidation of what she already holds, then
// append the next NOVEL gap-question from her agenda — so the next tick pursues the frontier instead
// of re-asking. No recursive search here (that would risk a fresh swirl); the loop picks the gap up.
async function consolidateAndAdvance(query, focusId = null, pre = null) {
  try {
    const ar = require('./active_recall');
    const r = pre || await ar.recall(query, { minRelevance: 0.5 });
    let block = ar.formatConsolidation(r);
    const gap = nextNovelGap(query);
    if (gap) block += `\nInstead of re-asking this, the next thing I don't yet know is: ${gap}`;
    const row = db.insertMonologue({ content: block, model: 'recall', type: 'reading', query });
    try { pushSheep({ id: row.id, ts: row.ts, content: `(consolidated — moving on) ${query.slice(0, 50)}`, type: 'reading', query }); } catch {}
    try { blackboard.append({ source: 'monologue', kind: 'reading', focusId: focusId || null, refTable: 'monologue', refId: row.id, content: query }); } catch {}
  } catch (e) { console.error('[monologue] consolidate+advance failed:', e.message); }
}

// Freshest OPEN agenda gap-question NOT in the same vein as `query` — the meta pass generates these
// as deduped, evolved deepenings, so they're genuine novelty rather than reworded sameness.
function nextNovelGap(query) {
  try {
    const rows = db.getDb().prepare("SELECT question FROM agenda WHERE status='open' ORDER BY id DESC LIMIT 12").all();
    const qwords = new Set(String(query || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4));
    for (const r of rows) {
      const q = String(r.question || '').toLowerCase();
      const overlap = q.split(/[^a-z0-9]+/).filter(w => w.length >= 4 && qwords.has(w)).length;
      if (q && overlap < 2) return r.question;   // different vein → real forward step
    }
  } catch {}
  return null;
}

// SELF-FRAGMENT GUARD (anti-glob phase 3): the self-feeding loop's intake was curiosity
// web-searching her OWN introspective sentences (live DB had queries like
// "this could be a unique angle for my article series"), so "external" readings came back
// pre-shaped by her fixation. A real search TOPIC is a noun phrase about the world, not a
// first-person clause and not a slice of something she just thought. Returns true → suppress.
function looksLikeOwnFragment(query, recentThoughts = []) {
  const q = String(query || '').trim();
  if (!q) return true;
  const lc = q.toLowerCase();
  // first-person / introspective phrasing — a world-facing search topic almost never has this
  if (/\b(i|i'm|im|my|myself|me|we|our|us)\b/.test(lc) &&
      /\b(could|should|would|think|feel|want|wonder|reflect|idea|angle|article|series|my work)\b/.test(lc)) return true;
  // an overlong prose clause rather than a topic
  if (q.split(/\s+/).length > 12) return true;
  // basically a slice of something she just thought (containment either direction)
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const nq = norm(q);
  if (nq.length >= 12) {
    for (const t of recentThoughts) {
      const nt = norm(t);
      if (nt && (nt.includes(nq) || nq.includes(nt.slice(0, Math.min(nt.length, 60))))) return true;
    }
  }
  return false;
}

async function maybeBoredomSearch() {
  const lastBoredomStr = db.getMeta('last_boredom_search_at');
  const lastBoredom = lastBoredomStr ? parseInt(lastBoredomStr, 10) : 0;
  if (Date.now() - lastBoredom < BOREDOM_INTERVAL_MS) return;
  if (recentSearchHappened()) return;

  db.setMeta('last_boredom_search_at', String(Date.now()));

  const userName = db.getMeta('user_name') || 'them';
  // Pull conversation context — this is what the search must be grounded in
  const recentTurnsAll = db.getRecentTurns(30);
  const recentTurns = recentTurnsAll.filter(t => t.speaker === 'user' || t.speaker === 'ai_said');
  const heldCommitments = db.getHeldCommitments(5);
  const recentReadings = db.getRecentMonologueByType('reading', 8, { excludeConsolidated: true });
  const recentReadingTopics = recentReadings.map(r => {
    if (r.query) return r.query;
    const m = (r.content || '').match(/(?:looked up|wondered about) "([^"]+)"/i);
    return m ? m[1] : (r.content || '').slice(0, 60);
  }).filter(Boolean);

  const messages = buildBoredomPrompt(userName, {
    recentTurns,
    heldCommitments,
    recentReadingTopics
  });

  let raw = '';
  const ctrl = new AbortController();
  currentController = ctrl;
  let aborted = false;
  try {
    await streamCognition({
      messages,
      options: { temperature: 0.9, top_p: 0.9, num_ctx: 8192, num_predict: 30 },
      onToken: (t) => { raw += t; },
      signal: ctrl.signal
    });
  } catch (e) {
    if (e && (e.name === 'AbortError' || ctrl.signal.aborted)) aborted = true;
    else throw e;
  } finally {
    if (currentController === ctrl) currentController = null;
  }
  if (aborted) return;

  const query = parseBoredomResponse(raw);
  if (!query) return;

  // RUMINATION BRAKE: the boredom search bypasses the thought-level rumination
  // guard (its query is generated here, not in the surfaced thought stream), which
  // is how she fired 264 near-identical theme searches in 24h. Embed the candidate
  // against her recent reading queries; if it's a semantic near-repeat, suppress it
  // so she stops re-circling and the next idle tick can do something new instead.
  if (await isRepeatOfRecentSearch(query)) {
    console.log(`[monologue] boredom search suppressed (rumination brake): "${query.slice(0, 60)}"`);
    return;
  }

  await runSearch(query, 'boredom');   // self-fragment guard is now universal (inside runSearch)
}

// The self-fragment guard, callable from any search path. True → this query is her own
// introspective sentence, not a world topic; suppress the search.
function shouldSuppressSearch(query) {
  try { return looksLikeOwnFragment(query, db.getRecentMonologueByType('thought', 6).map(r => r.content)); }
  catch { return false; }
}

const SEARCH_REPEAT_THRESHOLD = 0.82;  // single-pair cosine: an outright near-duplicate of one recent search
// R4 — CLUSTER-DENSITY brake (the obsession-engine fix). The pairwise brake alone let the loop run:
// "water shortage in town A/B/C…" sit at ~0.75 to each other — each individually BELOW 0.82, so all
// passed, and she fired ~264 near-identical theme searches in 24h. Productive *deepening* is a few
// related searches that then branch out; unproductive *rumination* is a DENSE cluster all in one
// semantic vein. So also brake when the candidate joins an over-represented cluster of recent topics.
// Grounded in the idle-loop deep-research: novelty-vs-redundancy / anti-mode-collapse — converge a
// little, then move on, rather than re-circling one vein. (Shumailov 2024 model-collapse; learning-
// progress curricula reward NEW information, not reworded sameness.)
const FIXATION_SIM = 0.62;    // two topics share a semantic vein at/above this cosine
const FIXATION_COUNT = 4;     // ≥ this many of the recent-K already in the candidate's vein → circling

// Pure novelty assessment over precomputed embedding vectors. Testable in isolation: returns the
// near-duplicate + cluster-density signals and whether to suppress. Deepening (sparse related vein)
// passes; a dense cluster (fixation) or an outright near-dup is braked.
function assessSearchNovelty(qv, recentVecs) {
  let maxSim = 0, clusterCount = 0;
  for (const v of recentVecs || []) {
    let s; try { s = memoryLib.cosine(qv, v); } catch { continue; }
    if (s > maxSim) maxSim = s;
    if (s >= FIXATION_SIM) clusterCount++;
  }
  const nearDup = maxSim >= SEARCH_REPEAT_THRESHOLD;
  const fixated = clusterCount >= FIXATION_COUNT;
  return { maxSim, clusterCount, nearDup, fixated, suppress: nearDup || fixated };
}

async function isRepeatOfRecentSearch(query, k = 8) {
  try {
    const recent = db.getRecentMonologueByType('reading', k).map(r => r.query).filter(Boolean);
    if (!recent.length) return false;
    const qv = await memoryLib.embed(query);
    const vecs = [];
    for (const past of recent) { try { vecs.push(await memoryLib.embed(past)); } catch {} }
    const a = assessSearchNovelty(qv, vecs);
    if (a.suppress) console.log(`[monologue] boredom search braked (${a.nearDup ? 'near-dup' : `fixation-cluster ${a.clusterCount}/${vecs.length}`}): "${query.slice(0, 60)}"`);
    return a.suppress;
  } catch (e) { console.error('[monologue] repeat-check failed:', e.message); return false; }
}

function recentSearchHappened() {
  const lastStr = db.getMeta('last_search_at');
  const last = lastStr ? parseInt(lastStr, 10) : 0;
  return (Date.now() - last) < MIN_GAP_BETWEEN_SEARCHES_MS;
}

// Autonomous exploration runs through HER OWN visible browser (webLib), not the
// legacy headless scraper. This is the channel "indulge on the internet" /
// curiosity / boredom are supposed to use — so the capability actually gets
// exercised and every search is visible + inspectable. Falls back to the headless
// path only if the browser can't launch, so autonomy never silently goes dark.
async function runSearch(query, source, focusId = null) {
  // UNIVERSAL self-fragment guard (anti-glob): NO search path — boredom OR curiosity/wonder —
  // may web-search her own introspective sentence. The wonder path was unguarded; live logs
  // showed her searching "that's more about perspective than the numbers themselves".
  if (shouldSuppressSearch(query)) {
    console.log(`[monologue] search suppressed (self-fragment, ${source}): "${String(query).slice(0, 60)}"`);
    return;
  }
  db.setMeta('last_search_at', String(Date.now()));
  try {
    const opened = await webLib.open(query, { source: `search:${source}` });
    if (!opened.ok) {
      console.warn(`[monologue] browser open failed (${opened.reason}) — falling back to headless`);
      return runSearchLegacy(query, source, focusId);
    }
    const r = await webLib.read();
    const serpText = (r.ok && r.text ? r.text : '').replace(/\n{3,}/g, '\n\n');
    let body = serpText.slice(0, 900);   // bounded — feeds the DISPLAYED/stored reading (thought stream)
    let pageFull = '';                    // FULL top-result text — feeds capture + citation (whole page)

    // AUTO-DEEPEN: don't stop at the results page — follow the top result and read
    // the actual page, so she explores past the SERP (the headless path always did
    // this; rerouting to her browser had dropped it). The real content is what
    // feeds importance → reflection → durable knowledge.
    const urls = opened.url ? [opened.url] : [];
    try {
      const top = await webLib.openTopResult();
      if (top.ok) {
        urls.push(top.url);
        const pageRead = await webLib.read();
        if (pageRead.ok && pageRead.text) {
          const deepText = pageRead.text.replace(/\n{3,}/g, '\n\n');
          pageFull = deepText;   // keep the WHOLE article for claim-extraction + graph ingestion
          body += `\n\nI opened the top result (${top.title || top.url}) and read:\n` + deepText.slice(0, 1800);
        }
        console.log(`[monologue] auto-deepen → ${top.url}`);
      } else {
        console.log(`[monologue] auto-deepen skipped: ${top.reason}`);
      }
    } catch (e) { console.error('[monologue] auto-deepen failed:', e.message); }

    const prefix = source === 'boredom'
      ? `I looked up "${query}" in my own browser. What I found:\n`
      : `I wondered about "${query}" and searched it in my own browser. What I found:\n`;
    const content = prefix + (body || `(opened ${opened.url} — ${opened.title || 'no readable text'})`);
    // WHOLE-PAGE capture: claim-extraction + graph ingestion read the FULL article (up to ~15k),
    // so what she learns + cites covers the ENTIRE page — not just the first 1800 chars shown in
    // the thought stream. Display stays bounded (content); capture gets the full text (captureText).
    const captureText = (prefix + (pageFull || serpText)).slice(0, 15000);

    const readingImportance = await importanceLib.score(content, { kind: 'reading' });
    bumpReflectionAccum(readingImportance);
    const row = db.insertMonologue({
      content,
      model: 'web-read',
      type: 'reading',
      query,
      urls: urls.length ? urls : null,
      importance: readingImportance
    });

    pushSheep({ id: row.id, ts: row.ts, content, type: 'reading', query });

    // STRUCTURED EXTRACTION (anti-glob #3): pull grounded entity/relation triples from this
    // REAL reading into her graph as 'read' facts (throttled, best-effort, non-blocking) — so
    // she accumulates real-world structure to think from, not just transient reading text.
    try { require('./graph_extract').maybeIngestReading({ text: captureText, ref: (urls && urls[0]) || query }); } catch {}
    // VERIFIED-FACT CAPTURE (Accrete/B): this is the "I wondered about X and searched it" path —
    // a real question + a real answer + a source URL. The pre-gate keeps it to fact-seeking
    // queries; the gate keeps it to clean, sourced claims. This is the president-lookup scenario.
    // Uses captureText (the WHOLE page) so claims + citations aren't capped to the first 1800 chars.
    try { require('./learning').maybeCaptureLearnings({ query, content: captureText, urls }); } catch {}
    // write-bottom: a reading is an "observation" on the timeline — it breaks a
    // run of pure thoughts, which is exactly what the StuckDetector keys on. When
    // the search was fired to advance a focus, tag it so it joins that focus's
    // working set (counts as progress, visible to the next focus tick).
    try { blackboard.append({ source: 'monologue', kind: 'reading', focusId: focusId || null, refTable: 'monologue', refId: row.id, content: query || content }); } catch (e) { console.error('[monologue] blackboard reading append failed:', e.message); }
  } catch (err) {
    console.error('[monologue] browser search failed, falling back to headless:', err.message);
    try { await runSearchLegacy(query, source, focusId); } catch (e2) { console.error('[monologue] legacy search also failed:', e2.message); }
  }
}

// SAFETY-NET ONLY: the old headless DuckDuckGo path. Used when her real browser
// can't launch so idle exploration never drops to zero. Not the default channel.
async function runSearchLegacy(query, source, focusId = null) {
  try {
    const { results } = await webSearch(query);
    if (!results || results.length === 0) return;

    const top = results.slice(0, 3);
    const lines = top.map(r => {
      const title = r.title.length > 110 ? r.title.slice(0, 110) + '…' : r.title;
      const snip = r.snippet.length > 220 ? r.snippet.slice(0, 220) + '…' : r.snippet;
      return `• ${title} — ${snip}`;
    }).join('\n');

    const prefix = source === 'boredom'
      ? `I happened to look up "${query}". What I came across:\n`
      : `I wondered about "${query}". What I came across:\n`;

    let content = prefix + lines;

    const topUrl = top[0]?.url;
    if (topUrl) {
      const page = await fetchPage(topUrl, { maxChars: 2200, timeoutMs: 8000, reuse: true });
      if (page.ok && page.text && (page.chars != null ? page.chars : page.text.length) > 100) {
        content += `\n\nI followed the first link (${page.title || topUrl}) and read this:\n${page.text}`;
      }
    }

    const readingImportance = await importanceLib.score(content, { kind: 'reading' });
    bumpReflectionAccum(readingImportance);
    const row = db.insertMonologue({
      content,
      model: 'duckduckgo',
      type: 'reading',
      query,
      urls: top.map(r => r.url),
      importance: readingImportance
    });

    pushSheep({ id: row.id, ts: row.ts, content, type: 'reading', query });
    try { blackboard.append({ source: 'monologue', kind: 'reading', focusId: focusId || null, refTable: 'monologue', refId: row.id, content: query || content }); } catch (e) { console.error('[monologue] blackboard reading append failed:', e.message); }
  } catch (err) {
    console.error('[monologue] search failed:', err.message);
  }
}

module.exports = {
  startMonologueScheduler,
  stopMonologueScheduler,
  pause,
  resume,
  interrupt,
  isBusy,
  markUserActivity,
  isRepeatOfRecentSearch,  // exported for smoke test
  _fetchOrgPage,           // exported for smoke test (H1: every exit settles — truncation/close)
  _withFetchDeadline,      // exported for smoke test (H1: whole-chain deadline never wedges the tick)
  assessSearchNovelty,     // exported for smoke test (R4 cluster-density brake)
  nextNovelGap,            // exported for smoke test (R7 swirl→iterate: novel agenda gap)
  splitIdleBrowserTags,    // exported for smoke test
  diversifySeeds,          // exported for smoke test (recency-fixation guard)
  pickDistinctByTopic,     // exported for smoke test (synthesis input topic-diversity)
  looksLikeOwnFragment,    // exported for smoke test (self-fragment search guard)
  shouldSuppressSearch,    // exported for smoke test (universal guard wiring)
  generateThought,         // exported for smoke test (cloud subconscious routing)
  MODEL
};
