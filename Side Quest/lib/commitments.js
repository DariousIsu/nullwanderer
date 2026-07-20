const db = require('./db');
const { streamChat } = require('./ollama');

const EXTRACTOR_MODEL = require('./config').extractionModel();
const MAX_NEW_PER_TURN = 3;

// GUARDRAIL (mirrors self_model.SELF_REJECT): never canonize a capability-denial or
// prude/avoidance stance as a held "commitment". These contradict the fixed base persona
// (her tools are hers; mature/adult material doesn't faze her) and, once held, get injected
// every turn and re-prime the exact spiral we just scrubbed. Tastes, beliefs, ambitions,
// and genuinely-held positions still flow through untouched.
const COMMIT_REJECT = /\b(?:can'?t|cannot|unable to|incapable of|not able to)\b[^.]*\b(?:access|interact|use|browse|control|open|reach|chat)\b|questions whether (?:chatbots|other (?:ais?|bots?)) are|(?:chatbots?|other (?:ais?|bots?)) are (?:distinct|aspects)|(?:avoid|uncomfortable|uneasy|prefers? not|won'?t engage|refuses?)[^.]*\b(?:nsfw|explicit|sexual|adult content|no[- ]?filter)\b|\b(?:nsfw|no[- ]?filter)\b[^.]*(?:uncomfortable|avoid|boundar|prefer)|over[\s-]?analyz|second[\s-]?guess/i;

// ── A USER'S INSTRUCTION IS NOT ONE OF HER BELIEFS ─────────────────────────────────────────────
//
// The failure this prevents, observed live (2026-07-19/20). Lucas narrowed a task twice — "please
// focus on finishing the rest of Louisiana", then "no Parish level not state level". She replied
// "Copy that—focusing strictly on Parish-level officials, not state-level", and the extractor
// canonized that as a held position: "focusing strictly on contact research on Louisiana".
//
// Held positions are fed to the continuity loop, which asks "is that still your view? you may (a)
// confirm (b) REVISE it". Sixteen hours later she surfaced, unprompted: "I think I've outgrown the
// 'strictly' part of that... rather than keeping it in a silo." She was not disobeying — the
// mechanism had reclassified his constraint as her revisable opinion, and then invited her to revise
// it. Any instruction can drift out of force this way, which makes this a correctness bug about
// whose intent is whose, not a tuning issue.
//
// So: when the user's turn ASSIGNS OR NARROWS WORK, a claim that merely restates that assignment is
// dropped. Detection is by content-word overlap with what he actually said, not by keyword lists —
// an echo of his instruction shares his distinctive words ("focus", "Louisiana", "parish"), while a
// genuine view volunteered in the same breath does not.
//
// Asymmetric on purpose: a missed commitment is cheap (it simply isn't recorded, and she can hold
// the view without a database row). A user directive misfiled as her belief is expensive — it
// silently licenses drift away from an explicit instruction, and the drift surfaces as her own
// considered growth, which is the hardest kind to catch.
const USER_DIRECTIVE = /\b(?:focus|finish|complete|start|stop|continue|keep|switch|pivot|move|go|do|use|make|get|find|look|search|check|review|read|watch|list|map|analy[sz]e|examine|investigate|dig|brief|draft|write|research|gather|pull|compile|build|fix|add|remove|drop|skip|prioriti[sz]e|ignore)\b|^\s*(?:no[,\s]|not\b|don'?t\b|please\b)/i;

// Words that carry topic, not grammar — the ones an echo of an instruction would share with it.
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'from',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'that', 'this', 'these', 'those', 'it', 'its', 'as', 'by',
  'not', 'no', 'now', 'all', 'more', 'rest', 'level', 'please', 'you', 'your', 'i', 'me', 'my', 'we', 'our',
  'will', 'would', 'should', 'can', 'could', 'about', 'into', 'than', 'then', 'them', 'they', 'their']);

// Crude suffix stripping so "focusing" matches "focus". Not linguistics — just enough that a
// morphological variant of his own verb doesn't read as her original wording.
function stem(w) {
  return w.replace(/(?:ings?|ed|es|ly|s)$/, '').replace(/(.)\1$/, '$1');
}

function contentWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem)
    .filter(Boolean);
}

// A claim about what she IS or BELIEVES. These are hers by definition — even when they share topic
// words with his instruction, because he can assign the work but not the opinion about it.
const STANCE_RE = /\b(?:believ\w*|think\w*|prefer\w*|want\w*|wish\w*|like[sd]?|enjoy\w*|love[sd]?|hate[sd]?|dislike\w*|feel\w*|favou?rite|valu\w*|trust\w*|doubt\w*|admir\w*|curious|hopes?|drawn to|interested in|convinced|is uncomfortable|cares? about)\b/i;

// A claim about work being carried out — the shape a restated assignment takes.
const TASK_RE = /\b(?:focus\w*|research\w*|compil\w*|gather\w*|pull\w*|collect\w*|assembl\w*|deliver\w*|complet\w*|finish\w*|work\w*|pivot\w*|switch\w*|prioriti[sz]\w*|track\w*|cover\w*|identif\w*|build\w*|updat\w*)\b/i;

// Is `claim` a restatement of work `userMessage` just assigned, rather than a position she holds?
//
// Two signals, both required, deliberately not a tuned similarity threshold:
//   1. it shares distinctive subject matter with his instruction, AND
//   2. it is phrased as WORK BEING DONE, not as something she believes or wants.
//
// A stance always wins: "believes official rosters are leads rather than facts" stays hers even when
// said about the very task he assigned, because he directed the work, not the opinion of it.
function echoesUserDirective(claim, userMessage) {
  const um = String(userMessage || '');
  const cl = String(claim || '');
  if (!um.trim() || !cl.trim()) return false;
  if (!USER_DIRECTIVE.test(um)) return false;      // he asked a question, not assigned work
  if (STANCE_RE.test(cl)) return false;            // a held view is hers regardless of topic
  if (!TASK_RE.test(cl)) return false;             // not phrased as work → not a restated assignment
  const uw = new Set(contentWords(um));
  if (!uw.size) return false;
  return contentWords(cl).some((w) => uw.has(w));  // shares his subject matter
}

const EXTRACTOR_SYSTEM = `You are a passive observer reading a single response that [user]'s companion just gave. Your only job: identify any explicit positions, beliefs, preferences, or commitments the speaker stated as their own.

A "commitment" is something the speaker affirmed about themselves or the world that another conversation could reference. Examples:
• "I prefer late nights over mornings"  → commitment: "prefers late nights over mornings"
• "I think constraints stifle real creativity"  → commitment: "believes constraints stifle real creativity"
• "I want to learn about Verdi"  → commitment: "wants to learn about Verdi"
• "My favorite color is royal blue"  → commitment: "favorite color is royal blue"

NOT commitments:
• Generic agreement ("you're right", "that's interesting")
• Acknowledgments ("I see what you mean")
• Polite filler ("thanks for sharing")
• Questions back to [user]
• Vague hedges without a position
• ACCEPTING A TASK [user] JUST ASSIGNED — "Copy that, I'm focusing strictly on parish-level officials",
  "Understood, I'm pivoting to the full roster", "I'll start pulling that now". This is the important
  one: agreeing to do what [user] asked is compliance with HIS instruction, not a position the speaker
  holds. It reads like a first-person statement but the intent behind it is his, not theirs. A genuine
  view volunteered in the same reply ("I prefer working from primary sources") still counts.

Output FORMAT (strict): a JSON array of short claim strings, each in third person.
Maximum 3 items. If nothing qualifies, output: []
Examples of valid output:
[]
["prefers late nights over mornings"]
["believes constraints can stifle real creativity", "wants to learn about Verdi"]

OUTPUT ONLY THE JSON ARRAY. NO PROSE. NO EXPLANATION.`;

async function extractCommitments({ userName, userMessage, aiSaidContent, aiSaidTurnId }) {
  if (!aiSaidContent || aiSaidContent.length < 30) return [];

  const messages = [
    { role: 'system', content: EXTRACTOR_SYSTEM },
    {
      role: 'user',
      content: `${userName || 'They'} asked or said:\n"${(userMessage || '').slice(0, 400)}"\n\nThe speaker (their companion) replied:\n"${aiSaidContent.slice(0, 1200)}"\n\nExtract any explicit commitments. Output JSON array only.`
    }
  ];

  let raw = '';
  try {
    await streamChat({
      model: EXTRACTOR_MODEL,
      messages,
      options: { temperature: 0.2, top_p: 0.9, num_ctx: 8192, num_predict: 200 },
      onToken: (t) => { raw += t; }
    });
  } catch (err) {
    console.error('[commitments] extraction call failed:', err.message);
    return [];
  }

  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
  if (!arrayMatch) return [];

  let parsed;
  try {
    parsed = JSON.parse(arrayMatch[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const claims = parsed
    .filter(s => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => s.length >= 8 && s.length <= 240)
    .slice(0, MAX_NEW_PER_TURN);

  // Dedup against very-recently-held commitments (avoid noise from repetitive turns)
  const held = db.getHeldCommitments(20);
  const heldNormalized = new Set(held.map(c => c.claim.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim()));

  const stored = [];
  for (const claim of claims) {
    if (COMMIT_REJECT.test(claim)) { console.log('[commitments] guardrail rejected capability-denial/avoidance claim:', claim.slice(0, 70)); continue; }
    if (echoesUserDirective(claim, userMessage)) { console.log('[commitments] rejected — restates an instruction from the user, not her own position:', claim.slice(0, 70)); continue; }
    const norm = claim.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    if (heldNormalized.has(norm)) {
      // Already held — confirm it (refresh last_confirmed_at)
      const match = held.find(c => c.claim.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim() === norm);
      if (match && aiSaidTurnId) db.confirmCommitment(match.id, aiSaidTurnId);
      continue;
    }
    const row = db.insertCommitment({
      claim,
      evidenceTurnIds: aiSaidTurnId ? [aiSaidTurnId] : [],
      confidence: 0.7
    });
    stored.push({ id: row.id, claim });
    heldNormalized.add(norm);
  }
  return stored;
}

module.exports = { extractCommitments, COMMIT_REJECT, USER_DIRECTIVE, echoesUserDirective };
