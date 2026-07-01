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

// Opener stems that mark a bare SEARCH SEED ("I want to know the title of…") as opposed to a
// real thought that merely contains a curiosity phrase. Anchored at string start.
const SEED_OPENER = /^\s*(?:i\s+(?:want|'?d\s+like|would\s+like)\s+to\s+(?:know|find\s+out|learn(?:\s+about)?|understand)|i\s+wonder\s+(?:what|whether|if|how|why|when|who|where)|i\s+want\s+to\s+find)\b/i;

/**
 * Is this monologue content a BARE curiosity seed — the QUERY half of a curiosity tick
 * ("I want to know the publication date of the most recent R Street brief") rather than
 * genuine mentation? These are internal search queries; storing/surfacing them as thoughts
 * is the dominant source of idle-stream bloat. The tick still FIRES the lookup (its answer,
 * a reading, carries the value) — it just doesn't store the query as a thought.
 *
 * Conservative: fires only when the content BOTH opens as a seed AND is query-dominated
 * (single sentence, or the extracted query spans most of the text). A multi-clause thought
 * that happens to open "I want to know why he said that — which made me think about …" is
 * kept, because real reasoning surrounds the query.
 */
function isBareCuriositySeed(content) {
  const t = String(content || '').trim();
  if (!t) return false;
  if (!SEED_OPENER.test(t)) return false;
  const trig = detectCuriosity(t);
  if (!trig.triggered || !trig.query) return false;   // no searchable query → not a seed
  const sentences = t.split(/[.?!]+(?:\s|$)/).filter(s => s.trim().length > 3);
  const ratio = trig.query.length / Math.max(1, t.length);
  return sentences.length <= 1 || ratio >= 0.5;
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

/**
 * Is the user asking for up-to-the-minute info only a live source can answer
 * (weather, prices, markets, today's news)? High-precision: needs a "now"-ish
 * marker AND a live domain, OR an explicit live phrase. Used by the chat turn to
 * auto-run a live lookup when she reached for no retrieval tool herself.
 */
function isLiveInfoQuestion(msg) {
  const s = (msg || '').toLowerCase();
  if (s.length < 6) return false;
  const askish = /\?|\b(what'?s?|what is|what are|how(?:'s| much| is| are)?|tell me|give me|can you|could you|do you know|look up|check|find|get me|pull up|price of|how'?s the)\b/.test(s);
  if (!askish) return false;
  const temporal = /\b(right now|currently|today|tonight|this (?:morning|afternoon|evening|week)|at the moment|as of|these days|latest|current|real[- ]?time|up[- ]?to[- ]?date|up-to-the-minute)\b/.test(s);
  const domain = /\b(weather|temperature|forecast|rain|snow|price|prices|stock|stocks|share|shares|ticker|market|markets|commodity|commodities|oil|crude|gold|silver|gas|gasoline|fuel|exchange rate|currency|bitcoin|crypto|news|headlines|happening|score|election|inflation|interest rate|yield)\b/.test(s);
  const livePhrase = /\b(price of|stock price|share price|spot price|what'?s the weather|today'?s (?:weather|news|headlines)|latest news|current events|exchange rate)\b/.test(s);
  return livePhrase || (temporal && domain);
}

/**
 * Turn a raw live-info question into a clean search query (used when she gave no
 * stated intent of her own to mine via detectCuriosity).
 */
function deriveLiveQuery(msg) {
  let q = (msg || '').trim();
  q = q.replace(/^(?:ok(?:ay)?|hey|so|and|well|um|zoe)[,\s]+/i, '');
  q = q.replace(/\b(?:can|could|would) you (?:please )?(?:tell me|let me know|find out|look up|check|get me|pull up)\b/gi, '');
  q = q.replace(/\b(?:do you know|please tell me|tell me|give me|i want to know|i'?d like to know)\b/gi, '');
  q = q.replace(/^\s*(?:what(?:'?s| is| are| the)?|how much (?:is|are)|how'?s)\s+/i, '');
  q = q.replace(/\b(?:right now|currently|today|at the moment|please)\b/gi, '');
  q = q.replace(/\s+is\s*$/i, '');
  q = q.replace(/[?.!]+\s*$/, '').replace(/\s{2,}/g, ' ').trim();
  if (q.length < 3) q = (msg || '').replace(/[?]/g, '').trim();
  return (q.slice(0, 160) || '').trim() || null;
}

// RESEARCH COMMAND — an explicit order to GO FIND OUT ("do some research", "look into it", "dig
// into that", "find out more", "read up on her"). Unlike isLiveInfoQuestion (current facts), the
// SUBJECT lives in the prior conversation, not this message. She tends to NARRATE the intent
// ("[I'll research…]") without emitting a tag, so nothing happens — this lets the harness run a real
// lookup with a subject derived from recent turns.
function isResearchCommand(msg) {
  const s = (msg || '').toLowerCase().trim();
  if (s.length < 4) return false;
  return /\b(do (?:some |a little |more |further )?research|research (?:that|it|this|her|him|them)|look (?:in)?to (?:it|that|this|him|her|them)|dig (?:in)?to (?:it|that|this)|find out more|do your research|go (?:and )?(?:research|look it up|find out)|look it up|read up on (?:it|that|this|him|her|them))\b/i.test(s)
    || /^\s*research\b/i.test(s);
}

// Build the research SUBJECT from recent USER turns (chronological, oldest→newest), since the command
// itself carries none. Drops the command turns and tiny turns; keeps the last ~2 substantive asks so
// pronouns ("her") still have their antecedent. Pure (turns passed in) → smoke-testable.
function deriveResearchSubject(currentMsg, recentUserContents = []) {
  const cur = String(currentMsg || '').trim();
  const subs = (recentUserContents || [])
    .map(c => String(c || '').trim())
    .filter(c => c && c !== cur && c.length > 8 && !isResearchCommand(c));
  const pick = subs.slice(-2);
  let q = pick.join(' ').replace(/[?!.]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return q ? q.slice(0, 180) : null;
}

module.exports = {
  detectCuriosity,
  isBareCuriositySeed,
  buildBoredomPrompt,
  parseBoredomResponse,
  cleanQuery,
  isMetaQuery,
  isLiveInfoQuestion,
  deriveLiveQuery,
  isResearchCommand,
  deriveResearchSubject
};
