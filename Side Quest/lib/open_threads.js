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

const EXTRACTION_MODEL = require('./config').model();
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
• Mid-conversation steering ("let's switch topics", "try that again")
• Emotional sharing or small talk
• Short imperatives under 5 words ("explore the page", "look at it", "go check")

HARD RULE: if the user's intent can be completed in ONE chat response (even if it takes a tool call), it is NOT a goal. Only multi-session standing work is a goal.

DECOMPOSITION: only decompose compound DURABLE directives. Don't decompose immediate requests.

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

/**
 * Extract any goals from a user message and insert into open_threads.
 * Returns array of inserted thread objects.
 */
async function extractFromUserTurn({ userMessage, sourceTurnId, userName }) {
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

  // Dedup against existing active threads — don't re-insert near-duplicates
  const active = db.getActiveOpenThreads(50);
  const activeNorms = new Set(active.map(t => normalize(t.content)));

  const inserted = [];
  for (const g of goals.slice(0, 4)) {
    const cleaned = (g || '').trim();
    if (cleaned.length < 4 || cleaned.length > 200) continue;
    if (activeNorms.has(normalize(cleaned))) continue;
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
function formatTopBlock(activeThreads) {
  if (!activeThreads || activeThreads.length === 0) return '';
  const lines = activeThreads.slice(0, 5).map(t => {
    const tag = t.status === 'stalled' ? ' [STALLED]' : '';
    return `  [thread:${t.id}] ${t.content}${tag}`;
  });
  return `\n\nWHAT YOU ARE WORKING ON (active threads from earlier requests, persist across turns until resolved):\n${lines.join('\n')}\n`;
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
    content: `(Reminder of standing work: ${top.length} active thread${top.length === 1 ? '' : 's'} — pursue if relevant to what Lucas says next, otherwise just answer him.)\n${top.join('\n')}`
  };
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
        db.touchOpenThread(threadId, reason || 'progress');
        db.incrementThreadAction(threadId);
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
  formatTopBlock,
  formatDepth2Block,
  parseAndApplyStatusUpdates,
  stripStatusTags,
  detectAndCountMentions,
  STATUS_TAG_RE
};
