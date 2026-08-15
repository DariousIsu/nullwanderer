/**
 * Open Threads layer — goal persistence across autonomous ticks.
 *
 * Three responsibilities:
 *   1) Extract goals/tasks from user messages (gemma JSON call, atomic decomposition).
 *   2) Format two-position injection (top-of-system primacy + depth-2 recency)
 *      for both Stheno's chat prompt and gemma's monologue prompt.
 *   3) Parse status-update tags ([thread-done:N], [thread-stalled:N], [thread-progress:N])
 *      emitted by gemma/Stheno; expose mention+action metrics.
 *
 * Built per the research synthesis: see notes in conversation log 2026-06-18.
 * Honest limit: at 4B subconscious, this helps but won't fully solve goal-pursuit.
 * Metrics (mention_count + action_count) are baked in so we can tell when it doesn't.
 */

const db = require('./db');
const { streamChat } = require('./ollama');
const consolidate = require('./consolidate');

const EXTRACTION_MODEL = require('./config').extractionModel();
const EXTRACTION_NUM_PREDICT = 220;

const EXTRACTION_PROMPT = (userMessage, userName) => [
  {
    role: 'system',
    content: `You read user messages and extract GOALS — but ONLY when the user is assigning DURABLE WORK that should persist across many exchanges. Be VERY conservative. The default is { "goals": [] }.

A goal IS:
• Something the user wants the AI to work on across MULTIPLE sessions or HOURS
• A standing project the AI should return to
• Examples: "decide on a name you actually want", "develop a backstory across the next few days", "form a view on the Maastricht treaty over time"

A goal is NOT (output empty for ALL of these):
• ANY immediate request that the AI handles in the current reply ("explore the page", "look at this", "tell me about X", "take a look at the open tab", "interact with the page")
• Browser interactions, page reads, link follows — those execute in this turn, not as long-term work
• Questions the AI answers right now
• Casual commands or one-shot directives
• A DATED or ONE-SHOT reminder ("remind me to call my father later today", "ping me at 2pm") — that is SCHEDULING, never a standing thread
• Mid-conversation steering ("let's switch topics", "try that again")
• Emotional sharing or small talk
• Short imperatives under 5 words ("explore the page", "look at it", "go check")

HARD RULE: if the user's intent can be completed in ONE chat response (even if it takes a tool call), it is NOT a goal. Only multi-session standing work is a goal.

DECOMPOSITION: only decompose compound DURABLE directives. Don't decompose immediate requests.

PERSPECTIVE (critical) — the message is from ${userName || 'the user'}. Resolve first person to them: "I/me/my/mine" = ${userName || 'the user'} (his/her), "you/your" = YOU (the companion). Phrase every goal as work YOU would do, referring to ${userName || 'the user'} in the THIRD PERSON. NEVER store ${userName || 'the user'}'s personal items as your own. e.g. "remind me to call my father" → "remind ${userName || 'the user'} to call his father" (and per the rule above, a dated reminder isn't a goal at all → []).

OUTPUT FORMAT — strict JSON, no preamble:
{ "goals": ["goal one", "goal two"] }
If no goal (the default — most messages): { "goals": [] }
Each goal: imperative form, 4–14 words. No quotes inside. No nesting.

When in doubt: output { "goals": [] }.`
  },
  {
    role: 'user',
    content: `User (${userName || 'them'}) just said:
"""
${userMessage}
"""

Is the user assigning DURABLE STANDING WORK that should persist across sessions? If yes, extract. If the user is making an immediate request or simply talking, output { "goals": [] }. Output ONLY the JSON.`
  }
];

// UNBOUNDED-GOAL GUARD — a goal needs an implicit completion condition. Open-ended goals
// ("learn EVERYTHING about X", "keep tracking Y", "stay updated on Z") can never resolve, so the
// idle loop pursues them forever and fixates (live: thread #66, "learn everything about federal
// permitting reform", reached 389 actions and bled permitting into every conversation). She can
// hold a BOUNDED version ("summarize X", "draft a brief on Y") — just not an infinite one. Rejected
// at the source. (Goal-management: a goal must be falsifiable/terminable; cf. Generative Agents
// plan horizons, 2304.03442.)
// No trailing \b — the verb stems (research, track…) must match their inflected forms
// ("keep researching"), which a trailing word-boundary would block mid-word. Leading \b anchors.
const UNBOUNDED_RE = /\b(everything|all there is|as much as (?:i|you) can|keep (?:research|learn|explor|track|monitor|study|read)|stay (?:updated|current|on top|abreast|informed)|continuous|ongoing|never stop|deepen (?:my|your) understanding|fully (?:understand|grasp|master)|become an expert|master the (?:topic|subject|field)|all about)/i;
function isUnboundedGoal(text) {
  return UNBOUNDED_RE.test(String(text || ''));
}

// AUTONOMOUS MAPPING SWEEP (2026-08-03): the per-state / per-place government-mapping backlog seeds one
// open_thread PER state ("Compile … municipal government … for … Wyoming", "VALIDATE the elected officials
// of … Colorado", per-county/parish/township). These are LEGITIMATE distinct work — never collapse them —
// but they are BACKGROUND mapping, not conversational commitments Lucas made. Left undifferentiated they
// flood the thread list (59 of 72) and bury his ~13 real focuses, so he/she "loses track". This flags them
// so the conversational surfaces (the autonomy manifest, status) can show HIS threads apart from the sweep.
const MAPPING_RE = /^\s*(?:Compile and keep current the (?:municipal|town\/township|county|parish|borough|village)\b|VALIDATE the elected officials of\b)/i;
function isAutonomousMapping(content) { return MAPPING_RE.test(String(content || '')); }

// ── THE REFINEMENT ROUTE (2026-08-14, the grove audit) ───────────────────────────────────────────
// Lucas, 11:26: "something you might want to add to the Ohio legislators [thread] is look at…" —
// an explicit ADDITION to an active thread — and the extractor minted TWO new threads (#3883/#3884)
// beside it. The dedup can't catch this (related-but-distinct wording, not a duplicate), and the
// redirect lane never saw it (no pivot verb). The missing question: does this turn REFINE a thread
// that already exists? A refinement-shaped turn whose subject token-matches an ACTIVE thread routes
// as a CLARIFICATION on that thread — touched, folded into its pass guidance, ZERO mints. The added
// work still happens, under the original's umbrella. No match → null → the extractor path as ever.
const REFINE_RE = /\b(?:add(?:ing)?\s+(?:to|onto|on\s+to)|might\s+want\s+to\s+add|you\s+might\s+add|also\s+(?:look|check|include|pull|grab|research|find|get)|in\s+addition\s+to|on\s+top\s+of\s+(?:that|the)|expand\s+(?:that|it|the)|while\s+you'?re\s+(?:at\s+it|in\s+there)|to\s+(?:that|the\s+same)\s+(?:list|project|thread|work)|same\s+(?:list|project|thread)\b)/i;
function routeRefinement(userMessage, pool) {
  const t = String(userMessage || '');
  if (!REFINE_RE.test(t)) return null;
  const hit = consolidate.tokenIntentMatch(t, pool || []);
  return hit ? { targetId: hit.id, targetContent: hit.content } : null;
}

/**
 * Extract any goals from a user message and insert into open_threads.
 * Returns array of inserted thread objects.
 *
 * SERIALIZED (B4, 2026-08-15 deep-dive): callers fire-and-forget, and each run snapshots the
 * dedup pool once at entry — two work-shaped turns seconds apart raced (the second's pool
 * predated the first's insert → double mint; HEAD's newestFirst fix closed the within-window
 * variant, not this cross-turn race). One module-level chain closes it at the root: each
 * extraction starts only after the prior one's inserts have landed. The chain swallows its own
 * errors so one failed extraction never wedges the lane.
 */
let _extractChain = Promise.resolve();
function extractFromUserTurn(args) {
  // opts._worker overrides the extraction body (smoke-only seam — verifies serialization without
  // a live model). Production always runs _extractFromUserTurn.
  const worker = (args && args._worker) || _extractFromUserTurn;
  const p = _extractChain.then(() => worker(args));
  _extractChain = p.catch(() => {});
  return p;
}
async function _extractFromUserTurn({ userMessage, sourceTurnId, userName }) {
  if (!userMessage || userMessage.trim().length < 4) return [];

  let raw = '';
  try {
    await streamChat({
      model: EXTRACTION_MODEL,
      messages: EXTRACTION_PROMPT(userMessage, userName),
      options: { temperature: 0.3, top_p: 0.9, num_ctx: 8192, num_predict: EXTRACTION_NUM_PREDICT },
      onToken: (t) => { raw += t; }
    });
  } catch (err) {
    console.error('[open_threads] extraction call failed:', err.message);
    return [];
  }

  const goals = parseGoalsJson(raw);
  if (!goals || goals.length === 0) return [];

  // EXTRACT-THEN-UPDATE (Mem0 best-practice): exact-string dedup is a cheap first
  // pass, but it misses intent-duplicates worded differently (the cause of the
  // goal sprawl). So for each surviving candidate we ask the consolidator for an
  // ADD/NOOP decision against the semantically-nearest active threads — only
  // genuinely-new objectives get inserted. Fail-open (ADD) if the decision errors,
  // so a hiccup never silently drops a real goal.
  const active = db.getActiveOpenThreads(50, { newestFirst: true });   // dedup pool = NEWEST (2026-08-13)
  const activeNorms = new Set(active.map(t => normalize(t.content)));

  const inserted = [];
  for (const g of goals.slice(0, 4)) {
    const cleaned = (g || '').trim();
    if (cleaned.length < 4 || cleaned.length > 200) continue;
    if (isUnboundedGoal(cleaned)) { console.log(`[open_threads] rejected unbounded goal (no completion condition): ${cleaned.slice(0, 60)}`); continue; }
    if (activeNorms.has(normalize(cleaned))) continue; // exact-dup fast path
    let decision = { action: 'ADD' };
    try { decision = await consolidate.decideForCandidate(cleaned); }
    catch (e) { console.error('[open_threads] dedup decision failed:', e.message); }
    if (decision.action === 'NOOP') {
      // Same intent as an existing goal — touch that thread instead of duplicating.
      if (decision.targetId) { try { db.touchOpenThread(decision.targetId, `re-surfaced (deduped: "${cleaned.slice(0, 60)}")`); } catch {} }
      console.log(`[open_threads] candidate deduped (NOOP → #${decision.targetId || '?'}): ${cleaned.slice(0, 60)}`);
      continue;
    }
    const row = db.insertOpenThread({ content: cleaned, sourceTurnId });
    inserted.push({ id: row.id, content: cleaned, ts: row.ts });
    activeNorms.add(normalize(cleaned));
  }
  return inserted;
}

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseGoalsJson(raw) {
  if (!raw) return [];
  // Find the first {...} block (model may emit extra text despite instructions)
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]);
    if (!obj || !Array.isArray(obj.goals)) return [];
    return obj.goals.filter(g => typeof g === 'string');
  } catch (err) {
    return [];
  }
}

// --- Injection formatters ---

/**
 * Format the TOP-of-system block — primacy weighting per research.
 * Goes immediately after the literal first lines of the system prompt.
 * Short and authoritative — this is the "what you're trying to do" anchor.
 */
// AGE IS PART OF THE TRUTH. The supplying query (db.getActiveOpenThreads) orders by
// last_touched_ts ASC — deliberately, so the most-neglected thread cannot be forgotten. But
// combined with a header that asserts "WHAT YOU ARE WORKING ON", that ordering guarantees this
// block shows the threads she is LEAST working on, stated as current work.
//
// Measured 2026-07-19: all five threads in this block were 8 days untouched with action_count 0,
// and one of them was "monitor the Norway vs England world cup match for Lucas" — a match long
// finished, asserted at the top of every prompt as live work. Nothing was wrong with the data;
// the block was simply describing it dishonestly.
//
// So: label the age, and stop calling a long-untouched thread "active". Keeping the row (rather
// than hiding it) preserves the anti-forgetting property the ordering exists for — she can still
// pick it up, she just isn't told she's already on it. Threads DO age out on their own via
// curator.curateThreads (active/pending → stalled at 10d → abandoned at 24d); this is about what
// the prompt claims in the meantime.
const STALE_ASSERT_DAYS = 3;   // untouched longer than this → shown as carried, not as in-progress

function formatTopBlock(activeThreads, { now = Date.now() } = {}) {
  if (!activeThreads || activeThreads.length === 0) return '';
  const ageMs = (t) => {
    const v = Number(t && t.last_touched_ts);
    if (!Number.isFinite(v) || v <= 0) return 0;
    return Math.max(0, now - (v > 1e12 ? v : v * 1000));   // table stores seconds in places, ms in others
  };
  const lines = activeThreads.slice(0, 5).map(t => {
    const ms = ageMs(t);
    const stale = ms >= STALE_ASSERT_DAYS * 86400000;
    const tag = t.status === 'stalled' ? ' [STALLED]'
      : stale ? ` [NOT TOUCHED IN ${humanAge(ms)} — carried, not in progress]` : '';
    return `  [thread:${t.id}] ${t.content}${tag}`;
  });
  return `\n\nTHREADS YOU ARE CARRYING (standing requests, persist across turns until resolved — a thread marked "not touched" is one you have NOT been working on, so do not claim progress on it):\n${lines.join('\n')}\n`;
}

/**
 * Format the DEPTH-2 block — recency steerage per research.
 * Inserted in the user-message position immediately above the latest real user input.
 * Concrete, action-oriented, includes the status-tag syntax instructions.
 */
function formatDepth2Block(activeThreads) {
  if (!activeThreads || activeThreads.length === 0) return null;
  // Terse — Stheno-8B was echoing the long-format block verbatim into her own
  // thought. Keep this short and parenthetical so it's read as instruction, not
  // as content to mirror. Status-tag syntax already lives in the primacy block.
  const top = activeThreads.slice(0, 3).map(t => `  · ${t.content}`);
  return {
    role: 'user',
    content: `(Reminder of standing work: ${top.length} thread${top.length === 1 ? '' : 's'} you are CARRYING — not necessarily worked recently. Pursue if relevant to what Lucas says next, otherwise just answer him.)\n${top.join('\n')}`
  };
}

// The MOST RECENTLY TOUCHED open thread — the one most plausibly her live work.
//
// Needed because the supplying query sorts least-touched FIRST, so `threads[0]` is the STALEST.
// Anywhere that wants "her actual current goal" (e.g. the anti-fixation redirect, which tells her
// to set a circled topic down and go work her real objective) was therefore pointing at the most
// neglected thread in the list — at one point "monitor the Norway vs England world cup match",
// eight days after the match. Redirecting a fixation onto a dead thread just relocates the loop.
function freshest(threads) {
  if (!Array.isArray(threads) || !threads.length) return null;
  let best = null, bestTs = -1;
  for (const t of threads) {
    if (!t || !t.content) continue;
    const v = Number(t.last_touched_ts);
    const ts = Number.isFinite(v) ? (v > 1e12 ? v : v * 1000) : 0;
    if (ts > bestTs) { bestTs = ts; best = t; }
  }
  return best;
}

// ── THREAD ADOPTION ──────────────────────────────────────────────────────────────────────────
//
// A focus IS an open_threads row (lib/focus.js), so when a research beat seeds a run it creates a
// thread. It was creating a BRAND NEW one every time, with no sourceTurnId and no reference to the
// request that actually asked for the work. Measured 2026-07-19:
//
//   Lucas   #3390 "compile leadership and historical data for all Louisiana parishes"
//                 -> 8 days untouched, action_count 0, pinned at the top of every prompt
//   machine       "Compile and keep current the county-level governing board for every parish in
//                 Louisiana — all 64 parishes …"  -> worked today
//
// One commitment, two rows, and the row Lucas can see is the one nothing touches. That is the
// structural cause of "silent research completion" — she does the work he asked for and her
// commitment memory never records it, so she never reports it. It is also why one request became
// 7+ near-duplicate threads: nothing recognised the commitment as already held.
//
// MATCHING IS STRUCTURAL, NOT FUZZY. A wrong adoption attaches a beat's work to an unrelated
// promise, which is worse than a duplicate — so this matches on the beat's OWN declared scope
// (stateCode -> state name, jurisdiction noun) rather than on string similarity. The state name is
// the hard anchor: no state mention, no adoption. contentKeywords' >=2-overlap rule is deliberately
// NOT reused here; it is tuned for mention COUNTING, where a false positive costs a metric, not a
// commitment.
//
// Returns { adopt, duplicates }. `adopt` is the thread the beat should run as (null = mint a new
// one, the old behaviour). `duplicates` are the other threads describing the same commitment, which
// the caller links under it so they stop occupying the prompt independently.
// STRONG terms only — each names a governing BODY. Weak words that merely co-occur with civic work
// ('contact', 'contacts', 'roster', 'leadership', 'official', 'officials', 'government') are
// deliberately EXCLUDED: a dry run over the live table showed 'contacts' pulling
// "conservative think tanks or activist groups in Louisiana — gather: organizations and contacts"
// into the parish-leadership commitment. State anchor + a weak word is not evidence of the same
// commitment, and a wrong merge is the one outcome worse than a duplicate.
const GOVERNANCE_TERMS = ['commission', 'commissioner', 'commissioners', 'board', 'boards', 'council',
  'jury', 'governing', 'legislature', 'legislator', 'legislators', 'supervisor', 'supervisors'];

function _mentions(hay, term) {
  if (!term) return false;
  return new RegExp(`\\b${String(term).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    .test(hay);
}

function matchCarriedThread(scope, threads) {
  const out = { adopt: null, duplicates: [] };
  const stateName = String((scope && scope.stateName) || '').trim().toLowerCase();
  if (!stateName || !Array.isArray(threads) || !threads.length) return out;   // no anchor → never adopt
  const nouns = ((scope && scope.nouns) || []).map(n => String(n || '').toLowerCase()).filter(Boolean);
  const terms = nouns.concat(GOVERNANCE_TERMS);

  const qualified = [];
  for (const t of threads) {
    if (!t || !t.content) continue;
    if (t.source_turn_id == null) continue;                       // machine-minted → not Lucas's commitment
    if (!['pending', 'active', 'stalled'].includes(t.status)) continue;
    if (t.parent_id != null) continue;                            // already merged under another thread
    const hay = String(t.content).toLowerCase();
    if (!_mentions(hay, stateName)) continue;                     // HARD ANCHOR
    if (!terms.some(term => _mentions(hay, term))) continue;      // and it must be about governing bodies
    qualified.push(t);
  }
  if (!qualified.length) return out;

  // Prefer the thread she has actually engaged with (mentions), then the most recently touched —
  // that is the one most likely to be the live phrasing of the request in Lucas's head.
  qualified.sort((a, b) =>
    (Number(b.mention_count) || 0) - (Number(a.mention_count) || 0) ||
    (Number(b.last_touched_ts) || 0) - (Number(a.last_touched_ts) || 0) ||
    (Number(a.id) || 0) - (Number(b.id) || 0));
  out.adopt = qualified[0];
  out.duplicates = qualified.slice(1);
  return out;
}

function humanAge(ms) {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

// --- Status tag parser ---

const STATUS_TAG_RE = /\[thread-(progress|done|stalled|abandon|abandoned)\s*:\s*(\d+)(?:\s+([^\]]+))?\]/gi;

/**
 * Parse status-update tags from a chunk of text (monologue thought or chat thought).
 * Returns array of { threadId, action, reason }.
 * Also applies the updates to the DB.
 */
function parseAndApplyStatusUpdates(text) {
  if (!text) return [];
  const updates = [];
  let m;
  STATUS_TAG_RE.lastIndex = 0;
  while ((m = STATUS_TAG_RE.exec(text)) !== null) {
    const action = (m[1] || '').toLowerCase();
    const threadId = parseInt(m[2], 10);
    const reason = (m[3] || '').trim() || null;
    if (!threadId || isNaN(threadId)) continue;
    const thread = db.getOpenThread(threadId);
    if (!thread) continue;
    try {
      if (action === 'progress') {
        // touchOpenThread WITH a note now increments action_count itself (B3, 2026-08-15). The
        // separate incrementThreadAction here would DOUBLE-count the tag path (+2 vs the +1 every
        // driver/worked-slice path gets), tripping the curator over-pursuit breaker at half budget
        // and making the two paths incomparable. touchOpenThread's note-increment is the single
        // source of truth now (backcheck fix).
        db.touchOpenThread(threadId, reason || 'progress');
      } else if (action === 'done') {
        db.markOpenThreadStatus(threadId, 'resolved', { reason });
        db.incrementThreadAction(threadId);
      } else if (action === 'stalled') {
        db.markOpenThreadStatus(threadId, 'stalled', { reason });
      } else if (action === 'abandon' || action === 'abandoned') {
        db.markOpenThreadStatus(threadId, 'abandoned', { reason });
      }
      updates.push({ threadId, action, reason });
    } catch (err) {
      console.error('[open_threads] status apply failed:', err.message);
    }
  }
  return updates;
}

/**
 * Strip status tags from text before display/storage. Tags are internal state
 * commands and shouldn't appear in user-visible content or persisted thoughts.
 */
function stripStatusTags(text) {
  return (text || '').replace(STATUS_TAG_RE, '').replace(/[ \t]+/g, ' ').trim();
}

// --- Mention detection (for metrics) ---

const STOPWORDS = new Set(['the','a','an','and','or','but','it','of','in','on','at','to','for','with','as','this','that','these','i','you','he','she','we','my','your','our','have','has','do','does','what','which','who','when','where','why','how','your','their']);

function contentKeywords(text) {
  if (!text) return new Set();
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w))
  );
}

/**
 * Count which active threads this output text MENTIONS (overlap heuristic).
 * Increments mention_count on each matched thread. Returns array of thread ids.
 */
function detectAndCountMentions(text, activeThreads) {
  if (!text || !activeThreads || activeThreads.length === 0) return [];
  const outKeys = contentKeywords(text);
  if (outKeys.size < 2) return [];
  const matched = [];
  for (const t of activeThreads) {
    const threadKeys = contentKeywords(t.content);
    if (threadKeys.size === 0) continue;
    let overlap = 0;
    for (const k of threadKeys) if (outKeys.has(k)) overlap++;
    // Require ≥2 overlapping content-words to count as mention
    if (overlap >= 2) {
      matched.push(t.id);
      try { db.incrementThreadMention(t.id); } catch {}
    }
  }
  return matched;
}

module.exports = {
  extractFromUserTurn,
  isUnboundedGoal,
  isAutonomousMapping,
  matchCarriedThread,
  freshest,
  humanAge,
  STALE_ASSERT_DAYS,
  formatTopBlock,
  formatDepth2Block,
  parseAndApplyStatusUpdates,
  stripStatusTags,
  detectAndCountMentions,
  STATUS_TAG_RE,
  routeRefinement,
  REFINE_RE
};
