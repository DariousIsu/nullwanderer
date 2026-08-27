/* lib/referent.js — WHAT IS "THAT"? Resolving elliptical follow-ups to the thing actually under discussion.
 *
 * The failure this exists to stop (live, 2026-07-20). Lucas asked her to look for news about China's
 * "World AI" open-sourcing announcement. She acknowledged. He then said, in full:
 *
 *     "Full research brief please"
 *
 * She replied with a research brief on WHITE HOUSE CLAIMS REGARDING ELECTION INTEGRITY — an unrelated
 * topic — and her own reasoning shows exactly how: "The user is asking for the 'Full research brief'
 * regarding White House Election Integrity Claims. I need to provide the exact content provided in the
 * prompt as requested." She treated injected prompt content as the user's request.
 *
 * ── WHY THE EXISTING SUPPRESSIONS DID NOT CATCH IT ─────────────────────────────────────────────
 *
 * main.js already blanks the retrieval block for activity questions and deliverable-aggregate questions,
 * because those turns have an authoritative answer that ambient retrieval would only compete with. But
 * "Full research brief please" is neither. It sails through as an ordinary question, and then semantic
 * retrieval does the damage precisely BECAUSE the message is contentless: it names a FORMAT ("research
 * brief"), not a SUBJECT. Retrieval matches those format words against every stored research brief and
 * returns the most salient one, which had nothing to do with the conversation.
 *
 * That is the general shape: the emptier the follow-up, the more freely ambient context fills it in. A
 * bare "yes", "do that", "go ahead", "the full version" carries no defence at all.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────────────────────────
 *
 * A message whose content words are ALL meta — format, quantity, assent, politeness — has no subject of
 * its own, so its subject must come from the conversation, never from retrieval. For those turns we
 * suppress ambient retrieval (it can only mislead) and state the referent explicitly, taken from the
 * most recent user turn that actually had one.
 *
 * DELIBERATELY CONSERVATIVE: one surviving distinctive word makes a message non-elliptical. "Full
 * research brief on China's World AI" resolves itself and is left alone. False negatives here cost
 * nothing — the turn just behaves as it does today. A false POSITIVE would suppress retrieval on a real
 * question, so the bar to call something contentless is deliberately high.
 *
 * Pure functions; the caller owns the turn history and the prompt.
 */
'use strict';

// Words that describe the SHAPE of a reply rather than its subject. A request built only from these is
// asking "more of what we were already discussing", not introducing a topic.
const META_WORDS = new Set([
  // format / deliverable shape
  'brief', 'briefing', 'report', 'summary', 'summarise', 'summarize', 'writeup', 'write', 'up', 'draft',
  'version', 'copy', 'doc', 'document', 'note', 'notes', 'list', 'breakdown', 'rundown', 'overview',
  'analysis', 'research', 'details', 'detail', 'info', 'information', 'background', 'context',
  // quantity / degree
  'full', 'complete', 'whole', 'entire', 'all', 'more', 'less', 'short', 'shorter', 'long', 'longer',
  'deep', 'deeper', 'detailed', 'quick', 'brief', 'extra', 'further', 'additional', 'rest', 'everything',
  // assent / direction without a subject ('yea'/'yah' added 2026-08-19: without them "yea more details"
  // read "yea" as a SUBJECT word → non-elliptical → the referent anchor never fired and the reply
  // tangented on "yea, the parliamentary yes" instead of elaborating on the topic in hand. brainstorm.js
  // isAffirmation already knew 'yea'/'yah'; this list had simply drifted from that vocabulary.)
  'yes', 'yea', 'yeah', 'yah', 'yep', 'yup', 'sure', 'ok', 'okay', 'fine', 'good', 'great', 'perfect', 'nice', 'cool',
  'please', 'thanks', 'thank', 'you', 'go', 'ahead', 'do', 'it', 'that', 'this', 'those', 'these', 'one',
  'them', 'they', 'same', 'again', 'also', 'too', 'as', 'well', 'now', 'next', 'then', 'still', 'keep',
  'going', 'continue', 'proceed', 'carry', 'on', 'sounds', 'lets', 'let', 'us', 'we', 'i', 'me', 'my',
  'need', 'want', 'like', 'would', 'could', 'can', 'will', 'get', 'give', 'make', 'have', 'send', 'show',
  // grammar
  'a', 'an', 'the', 'of', 'for', 'to', 'with', 'and', 'or', 'but', 'in', 'at', 'by', 'from', 'is', 'are',
  'be', 'please', 'about', 'into', 'out', 'if', 'so', 'just', 'some', 'any', 'other', 'another',
]);

function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9'\s-]/g, ' ').split(/\s+/).filter(Boolean);
}

// The words that could carry a subject — anything not purely meta. Numbers count (a year or a count can
// be the subject), hyphenated and possessive forms are kept whole.
function subjectWords(text) {
  return words(text)
    .map((w) => w.replace(/'s$/, ''))          // normalise possessives so "China's" reads as "china"
    .filter((w) => w.length >= 2 && !META_WORDS.has(w));
}

// Does this message carry no subject of its own? Long messages are never treated as elliptical however
// generic they look — length itself is evidence that something is being said.
const MAX_ELLIPTICAL_WORDS = 12;
function isElliptical(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const all = words(t);
  if (!all.length || all.length > MAX_ELLIPTICAL_WORDS) return false;
  return subjectWords(t).length === 0;
}

// The subject to inherit: the most recent user turn that HAD one. Walks back through the elliptical
// turns ("yes" → "the full version" → the real request) so a chain of follow-ups still lands on the
// actual topic rather than on the previous shrug.
//
// `turns` is oldest-first, each { speaker, content } — the same shape db.getRecentTurns returns.
function resolveReferent(turns, { maxBack = 12 } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  let scanned = 0;
  for (let i = list.length - 1; i >= 0 && scanned < maxBack; i--) {
    const t = list[i];
    if (!t || t.speaker !== 'user') continue;
    scanned++;
    if (!isElliptical(t.content)) return { text: String(t.content || '').trim(), index: i };
  }
  return null;
}

// ── DEMONSTRATIVE ANAPHORA ("that Trump story", "this video", "the deal you mentioned") ──────────
//
// A second, distinct failure (live, 2026-07-26). Lucas: "What is that Trump story about?" — the prior
// turn had established the story (a video tying Trump to a Colorado election). She answered with a
// grab-bag of THREE UNRELATED Trump items, and her own reasoning showed why: "multiple recent
// Trump-related stories exist … list the three known ones." The demonstrative "THAT" points to one
// specific thing already in the conversation, but the message is NOT elliptical (it carries the subject
// words "trump", "story"), so the ellipsis guard above never fires — and broad retrieval then resolves
// the bare noun to whatever the ambient news beat is loudest about, not to the one just discussed.
//
// The tell is a demonstrative determiner (that/this/those/these) binding a REFERENCE NOUN — a word that
// names a piece of discourse rather than a fresh subject (story, video, article, deal, bill, point…).
// "that story" means "the specific story we were on", and its content lives in a recent turn, not in a
// fresh retrieval. So we resolve it to that turn and anchor there, exactly like the elliptical case.
// DELIBERATELY CONSERVATIVE: only fires on demonstrative + reference-noun AND only when a recent turn
// actually mentions the distinctive modifier — otherwise it falls through and behaves as today.
const DEMONSTRATIVES = new Set(['that', 'this', 'those', 'these']);
const REF_NOUNS = new Set([
  'story', 'stories', 'video', 'videos', 'clip', 'clips', 'article', 'articles', 'report', 'reports',
  'piece', 'pieces', 'paper', 'papers', 'brief', 'deal', 'bill', 'thing', 'point', 'points', 'issue',
  'issues', 'topic', 'news', 'item', 'items', 'quote', 'quotes', 'stat', 'stats', 'number', 'numbers',
  'figure', 'figures', 'chart', 'doc', 'document', 'meeting', 'email', 'project', 'announcement',
  'headline', 'headlines', 'claim', 'claims', 'situation', 'thread',
]);

// Detect a demonstrative reference and return { refNoun, keys } — `keys` are the distinctive modifier
// words between the demonstrative and the reference noun ("that TRUMP story" → keys ['trump']), or the
// reference noun itself when there is no modifier ("what's that about" is caught by ellipsis, not here).
function demonstrativeReference(text) {
  const toks = words(text);
  for (let i = 0; i < toks.length; i++) {
    if (!DEMONSTRATIVES.has(toks[i])) continue;
    for (let j = i + 1; j <= Math.min(i + 3, toks.length - 1); j++) {
      if (!REF_NOUNS.has(toks[j])) continue;
      const mods = toks.slice(i + 1, j).map((w) => w.replace(/'s$/, '')).filter((w) => w.length >= 3 && !META_WORDS.has(w));
      return { refNoun: toks[j], keys: mods.length ? mods : [toks[j]] };
    }
  }
  return null;
}

// Resolve a demonstrative reference to the most recent prior turn (user OR assistant — she usually TOLD
// him the thing) that mentions one of the distinctive keys. Returns { text, index, speaker, refNoun } or
// null. `turns` is oldest-first { speaker, content }.
function resolveDemonstrative(text, turns, { maxBack = 12 } = {}) {
  const ref = demonstrativeReference(text);
  if (!ref) return null;
  const list = Array.isArray(turns) ? turns : [];
  const self = String(text || '').trim();
  let scanned = 0;
  for (let i = list.length - 1; i >= 0 && scanned < maxBack; i--) {
    const t = list[i];
    if (!t || !t.content) continue;
    // FALSE-NON-DELIVERY guard (T10, 2026-08-16): only USER turns and DURABLE assistant replies (ai_said)
    // may be a referent — never the ai_thought / monologue rail. Else "those numbers you just pulled"
    // anchors to an interstitial musing instead of the delivered answer.
    if (t.speaker !== 'user' && t.speaker !== 'ai_said') continue;
    // Skip the current message itself — recent-turn history usually includes the just-asked question,
    // whose "that Trump story" would otherwise match its own key and resolve to itself.
    if (String(t.content).trim() === self) continue;
    scanned++;
    const c = String(t.content).toLowerCase();
    if (ref.keys.some((k) => c.includes(k))) return { text: String(t.content).trim(), index: i, speaker: t.speaker, refNoun: ref.refNoun };
  }
  return null;
}

// The prompt block for a demonstrative reference. Names the specific thing and forbids substituting a
// different instance from the ambient news/notes — the exact failure (three other Trump stories).
function buildDemonstrativeBlock(referentText, refNoun, userName = 'Lucas') {
  const r = String(referentText || '').trim();
  if (!r) return null;
  return `WHAT "THAT ${String(refNoun || '').toUpperCase()}" REFERS TO — ${userName} is asking about the specific ${refNoun || 'thing'} you were both just discussing, NOT a new one. It is this, from a moment ago:

  "${r.slice(0, 500)}"

Answer about THAT specific ${refNoun || 'thing'} and nothing else. Do NOT substitute a different ${refNoun || 'one'} from your recent research, the news beat, or anything else in this prompt — if several similar items exist, the one they mean is the one above. If you truly cannot tell which they mean, ASK.`;
}

// The prompt block. States the referent and, just as importantly, forbids substituting a different one —
// the observed failure was not a vague answer, it was a confident answer about the wrong subject.
function buildBlock(referentText, userName = 'Lucas') {
  const r = String(referentText || '').trim();
  if (!r) return null;
  return `WHAT THIS MESSAGE REFERS TO — ${userName}'s message is a follow-up with no subject of its own ("more", "the full version", "yes", "please do"). It refers to what you were both just discussing:

  "${r.slice(0, 400)}"

Answer about THAT and nothing else. Do NOT substitute a different topic from your notes, your recent research, or anything else in this prompt — if material here is about some other subject, it is not what ${userName} asked for. If you genuinely cannot tell what is being referred to, ASK rather than picking one.`;
}

module.exports = {
  META_WORDS, isElliptical, subjectWords, resolveReferent, buildBlock, MAX_ELLIPTICAL_WORDS,
  DEMONSTRATIVES, REF_NOUNS, demonstrativeReference, resolveDemonstrative, buildDemonstrativeBlock,
};
