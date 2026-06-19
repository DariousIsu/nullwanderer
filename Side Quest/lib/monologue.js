const db = require('./db');
const { streamChat } = require('./ollama');
const { search: webSearch, fetchPage } = require('./web_search');
const { detectCuriosity, buildBoredomPrompt, parseBoredomResponse } = require('./curiosity');
const { runSelfDialogue } = require('./self_dialogue');
const openThreadsLib = require('./open_threads');
const filesLib = require('./files');
const browserLib = require('./browser');
const screenLib = require('./screen');
const autoTools = require('./auto_tools');
const governor = require('./governor');
const { buildAwarenessBlock } = require('./context');

const MODEL = require('./config').model();
const TICK_INTERVAL_MS = 10 * 1000;     // 10s between ticks while idle
const TICK_INTERVAL_BUSY_MS = 30 * 1000; // back off when conversation is active
const RECENT_MONOLOGUE_WINDOW = 6;
const ANTI_LOOP_RECENT = 10;            // last N monologue lines checked for repetition
const ANTI_LOOP_THRESHOLD = 0.30;       // Jaccard similarity above this = skip
const BOREDOM_INTERVAL_MS = 5 * 60 * 1000;  // every 5 min, ask her what she'd want to look up
const MIN_GAP_BETWEEN_SEARCHES_MS = 60 * 1000;  // at most one search per minute

let timer = null;
let opts = { getWindow: () => null };
let paused = false;
let inFlight = false;
let lastUserActivityTs = Date.now();
let tickCounter = 0;  // for alternating observation / thread-review modes

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
function topicSeedOf(text) {
  if (!text) return '';
  const stripped = text.replace(/^["'`*\s]+/, '').trim();
  // Take up to the first sentence break or first 80 chars
  const firstClause = stripped.split(/[.?!\n]/)[0].trim();
  return firstClause.length > 90 ? firstClause.slice(0, 90) + '…' : firstClause;
}

function buildPrompt({ userName, recentMonologue, recentReadings, recentReflections, recentTurns, heldCommitments, openThreads, randomOlderPairs, feedContext, awareness, protocols, browserBlock }) {
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

  // PROTOCOLS — pinned to ABSOLUTE TOP. The subconscious also needs to know the
  // rules of engagement so it doesn't generate in-RP content when an exit
  // protocol has been invoked, and so its readings of user messages don't
  // misinterpret safe words as in-scene content.
  if (protocols && protocols.length > 0) {
    const { formatInjection } = require('./protocols');
    const block = formatInjection(protocols);
    if (block) sys = block + '\n' + sys;
  }

  // SCREEN — she can observe Lucas's open windows on her own initiative.
  sys += '\n\n' + screenLib.buildPromptBlock();

  // AUTONOMY TOOLS — she can set reminders, notify, use the clipboard, and (when
  // configured) email or DM Lucas on her own initiative between turns.
  const autoBlocks = autoTools.promptBlocks();
  if (autoBlocks) sys += '\n\n' + autoBlocks;

  // PRIMACY: open_threads block injected at top of system prompt
  if (openThreads && openThreads.length > 0) {
    const topBlock = openThreadsLib.formatTopBlock(openThreads);
    if (topBlock) sys += topBlock;
  }

  const messages = [{ role: 'system', content: sys }];

  let context = '';

  // Variety: show a few topic seeds of most recent THOUGHTS so the model
  // can find a different angle. Soft guidance, not hard ban.
  if (recentMonologue && recentMonologue.length > 0) {
    const seeds = recentMonologue.slice(-3).map(m => topicSeedOf(m.content || '')).filter(Boolean);
    if (seeds.length > 0) {
      context += `Your last few thoughts touched on (try a different angle, but don't be rigid about it):\n`;
      for (const seed of seeds) {
        context += `  ~ ${seed}\n`;
      }
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
  if (recentReadings && recentReadings.length > 0) {
    context += `Things you've looked up on your own recently (you may want to think about one):\n`;
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

  context += `Pick ONE specific item from the conversation above and write a short paragraph about it. Options:\n• something ${userName || 'they'} said that you want to push back on\n• something YOU said that you're not sure was honest\n• a question you didn't ask but want to\n• a contradiction between two things either of you said\n• a position you're forming that you haven't expressed\n\nDo not quote the instructions back at me. Do not write about light, rain, dust, shadows, or atmosphere. Do not analyze ${userName || 'their'} phrasing as a construction. Do not produce introductory or transitional words like "Okay" or "Alright" — start directly with the content.\n\nIf nothing specific from the conversation is worth writing about right now, reply with exactly: SKIP`;

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
function buildThreadReviewPrompt({ userName, thread, recentTurns, recentMonologue, awareness, protocols }) {
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

  context += `NOW: produce one short paragraph of concrete progress on thread #${thread.id}. End with the appropriate [thread-...] tag.`;

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
}

function stopMonologueScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
  paused = true;
}

function pause() { paused = true; }
function resume() {
  paused = false;
  if (!timer) schedule(TICK_INTERVAL_MS);
}

function markUserActivity() {
  lastUserActivityTs = Date.now();
}

function schedule(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, delayMs);
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

async function runOneTick() {
  tickCounter++;
  const userName = db.getMeta('user_name') || 'them';
  // Split monologue into thoughts (used for anti-loop seeds) and readings (used as material).
  const recentThoughts = db.getRecentMonologueByType('thought', RECENT_MONOLOGUE_WINDOW);
  const recentReadings = db.getRecentMonologueByType('reading', 2);
  const recentReflections = db.getRecentReflections(2);
  const recentTurns = db.getRecentTurns(20);
  const heldCommitments = db.getHeldCommitments(5);
  const openThreads = db.getActiveOpenThreads(5);
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
  let focusedThread = null;
  if (openThreads.length > 0 && (tickCounter % 3 === 0)) {
    focusedThread = openThreads[0];  // stalest (oldest last_touched)
    messages = buildThreadReviewPrompt({
      userName,
      thread: focusedThread,
      recentTurns,
      recentMonologue: recentThoughts,
      awareness,
      protocols
    });
    modeIsThreadReview = true;
  } else {
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
      protocols,
      browserBlock
    });
  }

  let content = '';
  await streamChat({
    model: MODEL,
    messages,
    options: { temperature: 0.95, top_p: 0.95, num_ctx: 8192, num_predict: 200 },
    onToken: (t) => { content += t; }
  });

  let trimmed = content.trim();
  if (!trimmed) return;

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
  const browserTags = browserLib.parseTags(trimmed);
  if (browserTags.length > 0 && browserLib.isConnected()) {
    (async () => {
      for (const t of browserTags.slice(0, 2)) {
        try {
          const r = await browserLib.dispatch(t);
          console.log(`[monologue] browser ${t.tag}: ${r?.ok ? 'ok' : 'FAIL ' + r?.reason}`);
          if (r?.ok && t.tag === 'browse-read' && r.text) {
            const rr = db.insertMonologue({ content: `I read "${r.title || r.url}" (${r.url}):\n${r.text}`, model: 'browser-read', type: 'reading', query: r.url, urls: [r.url] });
            pushSheep({ id: rr.id, ts: rr.ts, content: `(read) ${r.title || r.url}`, type: 'reading', query: r.url });
          } else if (r?.ok && t.tag === 'browse' && r.url) {
            const rr = db.insertMonologue({ content: `I opened "${r.title || r.url}" (${r.url})`, model: 'browser-open', type: 'reading', query: r.url, urls: [r.url] });
            pushSheep({ id: rr.id, ts: rr.ts, content: `(opened) ${r.title || r.url}`, type: 'reading', query: r.url });
          } else if (r?.ok) {
            pushSheep({ id: Date.now(), ts: Date.now(), content: `(${t.tag}) ${r.target || r.url || ''}`, type: 'reading' });
          }
        } catch (err) { console.error('[monologue] browser dispatch error:', err.message); }
      }
    })().catch(err => console.error('[monologue] browser async error:', err.message));
    trimmed = browserLib.stripTags(trimmed);
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
  if (autoTools.hasAny(autoTools.parseAll(trimmed))) {
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

  if (!trimmed) return;
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

  // GOVERNOR gap-fill: when she's been quiet too long, relax the quality drop-filters
  // so SOMETHING surfaces and the silence gets filled rather than staying empty.
  const fillGap = governor.shouldFillGap();
  if (!fillGap && isTooSimilarToRecent(trimmed, recentThoughts)) {
    return;
  }
  if (!fillGap && isSilenceEssay(trimmed)) {
    // Drop silently — the model is in the silence attractor; don't store or render.
    return;
  }

  // GOVERNOR pace: hold surfaced thoughts to the min-gap + hourly budget. If paced
  // out, let the silence stand (she still thought; it just isn't surfaced).
  const thoughtGate = governor.requestAction('thought');
  if (!thoughtGate.allow) return;
  governor.record('thought');

  const row = db.insertMonologue({
    content: trimmed,
    model: MODEL,
    feedContext,
    type: 'thought'
  });

  pushSheep({ id: row.id, ts: row.ts, content: trimmed, type: 'thought' });

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
  maybeBoredomSearch().catch(err =>
    console.error('[monologue] boredom search error:', err.message)
  );
}

function pushSheep(payload) {
  try {
    const win = opts.getWindow ? opts.getWindow() : null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('monologue:tick', payload);
    }
  } catch {}
}

async function maybeSearchFromThought(thoughtText) {
  const trig = detectCuriosity(thoughtText);
  if (!trig.triggered || !trig.query) return;
  if (recentSearchHappened()) return;
  await runSearch(trig.query, 'curiosity');
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
  const recentReadings = db.getRecentMonologueByType('reading', 8);
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
  await streamChat({
    model: MODEL,
    messages,
    options: { temperature: 0.9, top_p: 0.9, num_ctx: 8192, num_predict: 30 },
    onToken: (t) => { raw += t; }
  });

  const query = parseBoredomResponse(raw);
  if (!query) return;

  await runSearch(query, 'boredom');
}

function recentSearchHappened() {
  const lastStr = db.getMeta('last_search_at');
  const last = lastStr ? parseInt(lastStr, 10) : 0;
  return (Date.now() - last) < MIN_GAP_BETWEEN_SEARCHES_MS;
}

async function runSearch(query, source) {
  db.setMeta('last_search_at', String(Date.now()));
  try {
    const { results } = await webSearch(query);
    if (!results || results.length === 0) return;

    // Compose a readable digest of the top hits
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

    // Auto-deepen — fetch top result's actual page text
    const topUrl = top[0]?.url;
    if (topUrl) {
      const page = await fetchPage(topUrl, { maxChars: 2200, timeoutMs: 8000 });
      if (page.ok && page.text && page.text.length > 100) {
        content += `\n\nI followed the first link (${page.title || topUrl}) and read this:\n${page.text}`;
      }
    }

    const row = db.insertMonologue({
      content,
      model: 'duckduckgo',
      type: 'reading',
      query,
      urls: top.map(r => r.url)
    });

    pushSheep({ id: row.id, ts: row.ts, content, type: 'reading', query });
  } catch (err) {
    console.error('[monologue] search failed:', err.message);
  }
}

module.exports = {
  startMonologueScheduler,
  stopMonologueScheduler,
  pause,
  resume,
  markUserActivity,
  MODEL
};
