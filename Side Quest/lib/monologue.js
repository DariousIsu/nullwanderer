const db = require('./db');
const { streamChat, complete, completeDetailed } = require('./ollama');
const { search: webSearch, fetchPage } = require('./web_search');
const { detectCuriosity, buildBoredomPrompt, parseBoredomResponse } = require('./curiosity');
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
const { buildAwarenessBlock, BASE_PERSONA } = require('./context');

const MODEL = require('./config').frontModel();   // her VOICE model (front)
const TICK_INTERVAL_MS = 10 * 1000;     // 10s between ticks while idle
const CAPTION_INTERVAL_MS = Math.max(2000, Math.round(TICK_INTERVAL_MS / 2));  // half-tick caption heartbeat
const AUTO_WATCH_PROB = 0.06;          // chance per idle tick she picks something of her own to WATCH
const TICK_INTERVAL_BUSY_MS = 30 * 1000; // back off when conversation is active
const RECENT_MONOLOGUE_WINDOW = 6;
const ANTI_LOOP_RECENT = 10;            // last N monologue lines checked for repetition
const ANTI_LOOP_THRESHOLD = 0.30;       // Jaccard similarity above this = skip
const BOREDOM_INTERVAL_MS = 5 * 60 * 1000;  // every 5 min, ask her what she'd want to look up
const MIN_GAP_BETWEEN_SEARCHES_MS = 60 * 1000;  // at most one search per minute

let timer = null;
let captionTimer = null;  // separate, faster heartbeat for caption-following (perception ≠ thinking)
let opts = { getWindow: () => null };
let paused = false;
let inFlight = false;
let currentController = null;  // AbortController for the in-flight generation (snap-back)
let lastUserActivityTs = Date.now();
let tickCounter = 0;  // for alternating observation / thread-review modes
let mediaFollowInFlight = false;  // guards the CONCURRENT caption-follow so ticks can't race its stage state

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
      const goal = (openThreads && openThreads[0] && openThreads[0].content) ? openThreads[0].content.replace(/\s+/g, ' ').slice(0, 100) : null;
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
  if (!timer) schedule(TICK_INTERVAL_MS);
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
          options: { temperature: options.temperature ?? 0.9, top_p: options.top_p ?? 0.95, num_ctx: 8192, num_predict: Math.max(options.num_predict || 200, 700) },
          signal, timeoutMs: 120000
        });
        // completeDetailed → { text, usage }; an injected string-returning complete (smokes) → string.
        const text = typeof r === 'string' ? r : (r && r.text) || '';
        const usage = (r && typeof r === 'object' && r.usage) ? r.usage : null;
        if (text && String(text).trim()) {
          if (deps.onUsage) { try { deps.onUsage(usage, { model: subModel }); } catch {} }
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
    if (!paused) schedule(TICK_INTERVAL_MS);
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

async function runOneTick() {
  tickCounter++;
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
  const recentReadings = db.getRecentMonologueByType('reading', 2, { excludeConsolidated: true });
  const recentReflections = db.getRecentReflections(2);
  const recentTurns = db.getRecentTurns(20);
  const heldCommitments = db.getHeldCommitments(5);
  const openThreads = db.getActiveOpenThreads(5, { includeStalled: false });  // stalled = parked, don't re-grind (anti-fixation)
  const protocols = db.getActiveProtocols();

  const now = new Date();
  const feedContext = {
    time: now.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    idleSeconds: Math.floor((Date.now() - lastUserActivityTs) / 1000),
    sessionAgeMin: opts.getSessionStartedAt ?
      Math.floor((Date.now() - opts.getSessionStartedAt()) / 60000) : null
  };

  // Build awareness block — passed into both observation and thread-review paths
  const awareness = buildAwarenessBlock({
    chosenName: db.getMeta('chosen_name'),
    sessionStartedAt: opts.getSessionStartedAt ? opts.getSessionStartedAt() : null,
    cumulativeMs: db.getCumulativeSessionTime()
  });

  // Browser block — only when connected, so the between-turn loop can continue
  // an active investigation (click/scroll/read) on its own initiative.
  let browserBlock = null;
  try { if (browserLib.isConnected()) browserBlock = browserLib.buildPromptBlock(); } catch {}

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
      const res = await gmeetLib.runTick({
        userName,
        onReading: (content, label) => {
          try { const rr = db.insertMonologue({ content, model: 'gmeet', type: 'reading' }); pushSheep({ id: rr.id, ts: rr.ts, content: label || content, type: 'reading' }); } catch (e) { console.error('[gmeet] reading insert failed:', e.message); }
        },
        onSurface: (text) => {
          try { require('./presence').notify('Zoe — Google Meet', text); } catch {}
          try { const rr = db.insertMonologue({ content: text, model: 'gmeet', type: 'reading' }); pushSheep({ id: rr.id, ts: rr.ts, content: `(gmeet) ${text.slice(0, 80)}`, type: 'reading' }); } catch {}
        }
      });
      console.log(`[gmeet] ${res.stage}: ${res.note}`);
    } catch (e) { console.error('[monologue] gmeet tick failed:', e.message); }
    return;
  }

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
        console.log(`[rumination] detected (avg cosine ${rum.avg.toFixed(3)}) — escalating to a focus`);
        const set = await ruminationLib.escalate(rum.thoughts, userName);
        if (set) activeFocus = set.focus;
        else { console.log('[rumination] escalation suppressed (tombstoned) — skipping tick'); return; }
      }
    } catch (e) { console.error('[monologue] rumination guard failed:', e.message); }
  }

  // SELF-DIRECTED AGENDA (autonomy roadmap, Slice 1): with no active focus and nothing escalated,
  // pursue HER OWN interests instead of echoing the last conversation — sample the weighted agenda
  // (lib/interests) and make the pick the current focus, so the focus lifecycle + the frontier push
  // drive it. prob-gated so she still free-associates sometimes; no-op if the agenda is empty or in
  // personal mode (play wanders freely).
  if (!activeFocus && !personalMode) {
    try {
      const spawned = await require('./interests').maybeSpawnFocus({ focusLib });
      if (spawned && spawned.focus) {
        activeFocus = spawned.focus;
        console.log(`[interests] pursuing agenda → "${(spawned.interest.topic || '').slice(0, 60)}"`);
      }
    } catch (e) { console.error('[monologue] interest spawn failed:', e.message); }
  }

  // AUTONOMOUS WATCHING — sometimes she picks something to WATCH on her own (not only when asked):
  // sample one of HER interests, search YouTube, and start following it. Low prob so she isn't
  // constantly opening videos; only when nothing's already playing and she isn't on a focus. The
  // caption heartbeat then follows it; a thought surfaces what + why. Toggle via meta media.autoWatch.
  if (!activeFocus && !mediaCcLib.active() && Math.random() < AUTO_WATCH_PROB) {
    let on = true; try { on = (db.getMeta('media.autoWatch') || 'on') !== 'off'; } catch {}
    if (on) {
      try {
        const t = require('./interests').sampleTopic();
        const topic = t && t.topic;
        if (topic) {
          const r = await mediaCcLib.findAndStart({ query: topic, deps: { search: webSearch } });
          if (r && r.ok) {
            const note = `I got curious about ${topic}, so I pulled up a video on it to watch and follow along.`;
            const row = db.insertMonologue({ content: note, model: MODEL, type: 'thought' });
            pushSheep({ id: row.id, ts: row.ts, content: note, type: 'thought' });
            try { blackboard.append({ source: 'monologue', kind: 'thought', refTable: 'monologue', refId: row.id, content: note }); } catch {}
            console.log(`[auto-watch] she chose to watch "${topic}" → ${r.url}`);
            return;   // tick spent starting the watch; the caption heartbeat takes it from here
          }
        }
      } catch (e) { console.error('[monologue] auto-watch failed:', e.message); }
    }
  }

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
  } else if (openThreads.length > 0 && (tickCounter % 3 === 0)) {
    focusedThread = openThreads[0];  // stalest (oldest last_touched)
    // ITERATE: surface prior knowledge on this thread's topic (anti-retread).
    let priorKnowledge = null;
    try { priorKnowledge = await require('./learning').buildPriorKnowledgeBlock(focusedThread.content); } catch {}
    messages = buildThreadReviewPrompt({
      userName,
      thread: focusedThread,
      recentTurns,
      recentMonologue: recentThoughts,
      awareness,
      protocols,
      priorKnowledge
    });
    modeIsThreadReview = true;
  } else {
    // INTAKE-FIRST (lever 1): if a reading arrived that she hasn't digested yet, make this
    // tick digest it rather than free-associate — flip the think-heavy ratio toward intake.
    const freshReadingId = recentReadings.length ? recentReadings[recentReadings.length - 1].id : 0;
    const lastDigested = parseInt(db.getMeta('monologue_last_digested_reading_id') || '0', 10);
    const intakeFirst = freshReadingId > lastDigested;
    if (intakeFirst) db.setMeta('monologue_last_digested_reading_id', String(freshReadingId));
    messages = buildPrompt({
      userName,
      recentMonologue: recentThoughts,
      recentReadings,
      recentReflections,
      recentTurns,
      heldCommitments,
      openThreads,
      randomOlderPairs: null,  // turned off — was introducing more drift than association
      feedContext,
      awareness,
      intakeFirst,
      protocols,
      browserBlock
    });
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
  const _budgetOk = subc.budgetOk(_getMeta, Date.now(), cfg.subcBudgetTokensPerHour());
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
  if (!activeFocus && !modeIsThreadReview && !personalMode) {
    try {
      const subc2 = require('./subconscious');
      const cfg2 = require('./config');
      const _gm = (k) => { try { return db.getMeta(k); } catch { return null; } };
      const _sm = (k, v) => { try { db.setMeta(k, v); } catch {} };
      const synthMode = cfg2.subcTierMode();
      if (synthMode !== 'local' && synthMode !== 'off'
        && subc2.shouldSynthesize({ getMeta: _gm, now: Date.now(), intervalMin: cfg2.subcSynthIntervalMin() })
        && subc2.budgetOk(_gm, Date.now(), cfg2.subcBudgetTokensPerHour())) {
        const seed = (recentThoughts.map(t => (t && t.content) || '').join(' ').slice(0, 300)) || userName;
        const sources = await subc2.retrieveSources(seed, { search: (q, k) => memoryLib.retrieve(q, { k }), k: 4 });
        const synthMessages = [
          { role: 'system', content: BASE_PERSONA },
          { role: 'user', content: subc2.buildSynthesisPrompt({ recentThoughts, threads: openThreads, focus: null, sources }) }
        ];
        const synth = await generateThought({
          messages: synthMessages,
          options: { temperature: 0.85, top_p: 0.95, num_ctx: 8192, num_predict: 360 },
          deps: {
            subModel: cfg2.subconsciousModel(),
            onUsage: (usage) => { try { const tok = (usage && ((usage.prompt_tokens || 0) + (usage.eval_tokens || 0))) || subc2.estimateTokens(synthMessages, ''); subc2.recordSpend({ getMeta: _gm, setMeta: _sm, now: Date.now(), tokens: tok }); } catch {} }
          }
        });
        subc2.markSynthesized({ setMeta: _sm, now: Date.now() });
        const st = (synth || '').trim();
        if (st) {
          let imp = 0.6; try { imp = await importanceLib.score(st, { userName, kind: 'thought' }); } catch {}
          const row = db.insertMonologue({ content: st, model: cfg2.subconsciousModel(), type: 'synthesis', importance: imp });
          pushSheep({ id: row.id, ts: row.ts, content: st, type: 'thought', importance: imp });
          try { blackboard.append({ source: 'monologue', kind: 'thought', refTable: 'monologue', refId: row.id, content: st }); } catch {}
          console.log('[subc] synthesis pass stored (cross-thought depth)');
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
    let clean = focusLib.stripControlTags(trimmed).replace(/<wonder>[\s\S]*?<\/wonder>/gi, '').trim();
    if (/^SKIP\.?$/i.test(clean)) clean = '';
    const sig = blackboard.signature(clean);
    const progressed = (control && control.type === 'done') ? true : focusLib.isNovel(activeFocus.id, sig);
    if (clean) {
      const imp = await importanceLib.score(clean, { userName, kind: 'thought' });
      bumpReflectionAccum(imp);
      const frow = db.insertMonologue({ content: clean, model: MODEL, feedContext, type: 'thought', importance: imp });
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
    model: MODEL,
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
    await streamChat({
      model: MODEL,
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
    const opened = await webLib.open(query);
    if (!opened.ok) {
      console.warn(`[monologue] browser open failed (${opened.reason}) — falling back to headless`);
      return runSearchLegacy(query, source, focusId);
    }
    const r = await webLib.read();
    let body = (r.ok && r.text ? r.text : '').replace(/\n{3,}/g, '\n\n').slice(0, 900);

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
          body += `\n\nI opened the top result (${top.title || top.url}) and read:\n` + pageRead.text.replace(/\n{3,}/g, '\n\n').slice(0, 1800);
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
    try { require('./graph_extract').maybeIngestReading({ text: content, ref: (urls && urls[0]) || query }); } catch {}
    // VERIFIED-FACT CAPTURE (Accrete/B): this is the "I wondered about X and searched it" path —
    // a real question + a real answer + a source URL. The pre-gate keeps it to fact-seeking
    // queries; the gate keeps it to clean, sourced claims. This is the president-lookup scenario.
    try { require('./learning').maybeCaptureLearnings({ query, content, urls }); } catch {}
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
      const page = await fetchPage(topUrl, { maxChars: 2200, timeoutMs: 8000 });
      if (page.ok && page.text && page.text.length > 100) {
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
  assessSearchNovelty,     // exported for smoke test (R4 cluster-density brake)
  nextNovelGap,            // exported for smoke test (R7 swirl→iterate: novel agenda gap)
  splitIdleBrowserTags,    // exported for smoke test
  diversifySeeds,          // exported for smoke test (recency-fixation guard)
  looksLikeOwnFragment,    // exported for smoke test (self-fragment search guard)
  shouldSuppressSearch,    // exported for smoke test (universal guard wiring)
  generateThought,         // exported for smoke test (cloud subconscious routing)
  MODEL
};
