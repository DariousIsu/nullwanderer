/**
 * Curiosity & boredom detectors. Inspect monologue content and extract a
 * search query if a trigger fires. Used by the monologue scheduler to
 * decide when Lana reaches for the web on her own.
 */

const CURIOSITY_PATTERNS = [
  // capture group is the subject of curiosity
  /\bi wonder\s+(?:if\s+|what\s+|whether\s+|how\s+|why\s+|when\s+|who\s+|where\s+|about\s+)?([^.?!\n]{4,160})[.?!\n]/i,
  /\bi(?:'m| am) curious about\s+([^.?!\n]{4,160})[.?!\n]/i,
  /\bi(?:'d| would) like to (?:know|learn about|understand)\s+([^.?!\n]{4,160})[.?!\n]/i,
  /\bi want to (?:know|learn about|find out|understand)\s+([^.?!\n]{4,160})[.?!\n]/i,
  /\bi don'?t (?:really )?know\s+(?:what|who|why|how|where|when)\s+([^.?!\n]{4,160})[.?!\n]/i,
  /\bwhat is\s+([^.?!\n]{4,160})[.?!\n]/i,
  /\bwho is\s+([^.?!\n]{4,160})[.?!\n]/i
];

// Stopwords to strip from extracted queries (leading conversational fluff)
const QUERY_FLUFF_PREFIX = /^(?:really|even|just|actually|kind of|sort of|maybe|perhaps|like|the|a|an)\s+/i;

// Meta-queries about the conversation itself — these spiral, never search them
const META_QUERY_PATTERNS = [
  /\b(?:he'?s |is )?(?:silent|silence|quiet|holding back|holding it|holding this|saying nothing|not responding|not speaking)\b/i,
  /\bwhy (?:it'?s |is )?(?:empty|quiet|silent|paused|fading|missing)\b/i,
  /\bwhat (?:is |was )?(?:missing|empty|the silence|the quiet|the absence|the void)\b/i,
  /\bthe (?:silence|quiet|emptiness|void|pause)\b/i
];

function isMetaQuery(query) {
  if (!query) return true;
  for (const re of META_QUERY_PATTERNS) {
    if (re.test(query)) return true;
  }
  return false;
}

function cleanQuery(raw) {
  if (!raw) return null;
  let q = raw.trim();
  // Strip trailing conversational tails
  q = q.replace(/\s+(?:right now|today|tomorrow|sometime|anyway|honestly|or something)\.?$/i, '');
  // Strip leading fluff
  while (QUERY_FLUFF_PREFIX.test(q)) {
    q = q.replace(QUERY_FLUFF_PREFIX, '');
  }
  // Strip surrounding quotes
  q = q.replace(/^['"`]+|['"`]+$/g, '').trim();
  if (q.length < 4) return null;
  if (q.length > 160) q = q.slice(0, 160);
  return q;
}

/**
 * Inspect monologue content for a curiosity trigger.
 * Returns { triggered: bool, query: string|null, source: 'curiosity'|'unknown'|'wonder' }.
 */
function detectCuriosity(content) {
  if (!content || content.length < 12) return { triggered: false, query: null, source: null };
  for (const re of CURIOSITY_PATTERNS) {
    const m = content.match(re);
    if (m) {
      const q = cleanQuery(m[1]);
      if (q && !isMetaQuery(q)) {
        return { triggered: true, query: q, source: 'curiosity' };
      }
    }
  }
  return { triggered: false, query: null, source: null };
}

/**
 * Build a one-shot prompt that asks Lana what she'd want to learn about
 * right now. Used by the periodic boredom trigger.
 */
function buildBoredomPrompt(userName, { recentTurns = [], heldCommitments = [], recentReadingTopics = [] } = {}) {
  let convoContext = '';
  if (recentTurns && recentTurns.length > 0) {
    convoContext = `\n\nRECENT CONVERSATION between you and ${userName || 'them'} (your source material — pick something from HERE):\n`;
    for (const t of recentTurns.slice(-10)) {
      if (t.speaker === 'user') convoContext += `${userName || 'they'}: ${(t.content || '').slice(0, 280)}\n`;
      else if (t.speaker === 'ai_said') convoContext += `you: ${(t.content || '').slice(0, 280)}\n`;
    }
  }

  let commitmentsContext = '';
  if (heldCommitments && heldCommitments.length > 0) {
    commitmentsContext = `\n\nPositions you've taken (these are also valid search anchors):\n`;
    for (const c of heldCommitments.slice(0, 5)) {
      commitmentsContext += `  · ${c.claim}\n`;
    }
  }

  const recentList = recentReadingTopics.length > 0
    ? `\n\nYou've recently looked up (do not repeat the same domain):\n${recentReadingTopics.slice(-5).map(t => `  ~ ${t}`).join('\n')}`
    : '';

  return [
    {
      role: 'system',
      content: `You are the inner stream of consciousness of ${userName || 'them'}'s companion. You have a moment to look something up.

THE SEARCH MUST BE GROUNDED IN YOUR ACTUAL CONVERSATION. Pick a specific thing ${userName || 'they'} said — a name they mentioned, a place they referenced, an event they brought up, a concept they used, a person they named, an opinion they offered, a piece of work they cited. NOT a generic philosophical query, NOT a random topic you happen to find interesting. Something from THIS conversation.

How to pick:
1. Read the conversation below.
2. Find a specific noun (person, place, work, event, term) ${userName || 'they'} mentioned that you don't fully know about.
3. Output a search query that would deepen your understanding of THAT thing.

Examples (showing the pattern):
• If ${userName || 'they'} mentioned "my brother in Boston" → "Boston demographics 2024" or skip if too vague
• If ${userName || 'they'} mentioned "the Maastricht treaty" → "Maastricht treaty 1992 provisions"
• If ${userName || 'they'} talked about "Hannah Arendt" → "Hannah Arendt banality of evil"
• If ${userName || 'they'} said "I work in AI alignment" → "AI alignment current research directions"
• If ${userName || 'they'} referenced "the Iliad" → "Iliad book 22 Hector death"

If the conversation has no concrete searchable thing right now — if it's been abstract or relational without proper nouns or specific topics — reply: nothing

No more than 8 words. No punctuation. No quotes. No preamble.${convoContext}${commitmentsContext}${recentList}`
    },
    {
      role: 'user',
      content: `What specific thing from the conversation above would you want to look up?`
    }
  ];
}

function parseBoredomResponse(text) {
  if (!text) return null;
  const cleaned = text.trim().replace(/^['"`]+|['"`]+$/g, '').trim();
  if (!cleaned) return null;
  if (/^nothing(\b|\.|$)/i.test(cleaned)) return null;
  const firstLine = cleaned.split('\n')[0].trim();
  if (firstLine.length < 3 || firstLine.length > 160) return null;
  // Reject abstract framings even if the model returned them
  if (/^(?:the meaning|the nature|what is|why|the purpose)\b/i.test(firstLine)) return null;
  if (isMetaQuery(firstLine)) return null;
  return firstLine;
}

module.exports = {
  detectCuriosity,
  buildBoredomPrompt,
  parseBoredomResponse,
  cleanQuery,
  isMetaQuery
};
