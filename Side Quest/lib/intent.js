/**
 * Web-intent detection — does the user's message clearly ask to use the web /
 * open a browser? Returns { target } (a URL or search terms) for main.js's
 * web-intent interceptor, else null. Extracted from main.js so it's unit-testable.
 *
 * Conservative on bare conversation, but a pasted URL with a viewing verb ("take a
 * look at this <url>") is treated as "open it in her browser" — the clearest case.
 */
const SEARCH_HOME = 'https://duckduckgo.com';

function detectWebIntent(text) {
  if (!text) return null;
  const t = String(text).trim();

  const tag = t.match(/<web-open>\s*([\s\S]*?)\s*<\/web-open>/i);
  if (tag) return { target: (tag[1] || '').trim() || SEARCH_HOME };

  const url = t.match(/https?:\/\/\S+/i) || t.match(/\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?\b/i);
  const search = t.match(/\b(?:search(?:\s+for)?|look\s*up|google|find)\b\s+(?:the\s+|for\s+)?(.{2,90})/i);
  const verb = /(open|opening|launch|fire up|pull up|go to|browse|web-open|\buse\b)/i.test(t);
  const webCue = /\b(browser|web|online|internet|web-open)\b/i.test(t);
  // viewing/visiting verbs that, with a URL, mean "open this for me"
  const viewVerb = /\b(look|check|see|read|view|visit|peek|here'?s|this is)\b/i.test(t);

  // A pasted URL with any open/view/web cue is the clearest "open this".
  if (url && (viewVerb || verb || webCue)) return { target: url[0] };

  // Explicit "open/use ... browser/web" with optional search terms.
  if (verb && webCue) {
    if (search) return { target: search[1].trim().replace(/[.?!,\s]+$/, '') };
    // "use web read" / "use the web to read this" is a READ of the current page, NOT
    // a request to open the search home. Don't fire the SEARCH_HOME fallback — let it
    // fall through to the act-on-open-page (read) handler.
    if (/\bread\b/i.test(t)) return null;
    return { target: SEARCH_HOME };
  }
  // A search COMMAND → web search. Fires when the message is an imperative search
  // ("search X", "can you look up X", "google X") OR references the web/browser
  // ("…from here", "in the browser", "online"). Stays quiet on conversational
  // "let's search for an approach" (doesn't start with the verb, no web ref).
  if (search) {
    const searchCmd = /^(?:can|could|would|will|please|hey)?[\s,]*(?:you[\s,]*)?(?:search|look\s*up|google|find)\b/i.test(t)
      || /\b(google|from here|in (?:the|your) browser|on the (?:web|internet)|online)\b/i.test(t);
    if (searchCmd) {
      const q = search[1].trim()
        .replace(/[.?!,\s]+$/, '')
        .replace(/\s+(?:from here|for me|online|on the web|on the internet|please)\s*$/i, '')
        .trim();
      return { target: q || SEARCH_HOME };
    }
  }
  return null;
}

// "Act on the page that's already open" — look at / read / use / surf the current
// page or chat (no URL, no search). Used ONLY when her browser is connected, and
// only after detectWebIntent returns null, to deterministically run a read so she
// stops refusing and actually sees what's open (e.g. a chat Lucas opened for her).
const ACT_VERB = /\b(look at|take a look|check|read|see|view|surf|use|interact with|what'?s on|whats on|scroll|explore|go through|browse|play with|talk to|respond to|reply to)\b/i;
const PAGE_NOUN = /\b(?:the|this|that|her|your)?\s*(page|chat|site|website|tab|conversation|browser|window|bot|character)\b/i;
// Explicit "read the current page" phrasings that carry no page-noun ("use web read",
// "web-read", "read it"). These must read the OPEN page, never open a search.
const EXPLICIT_READ = /\bweb[\s-]?read\b|<web-read\b|\bread (?:it|this|the (?:page|site|tab|chat))\b/i;
function detectActOnOpenPage(text) {
  if (!text) return false;
  const t = String(text);
  if (EXPLICIT_READ.test(t)) return true;
  return ACT_VERB.test(t) && PAGE_NOUN.test(t);
}

// "Pick a character / chat with one / start a scene" — the 24B fumbles this as
// free-form navigation, so we route it to the deterministic play stepper (which
// makes each step a trivial pick). Fires only when her browser is already open.
const PICK_CHAR_RE = /\b(?:pick|choose|select|find|start|explore|browse|open)\b[^.?!]{0,30}\b(?:characters?|someone|scene|bot|conversation|one to (?:chat|talk|play))\b|\bchat with (?:a |an |one\b|someone|somebody)\b|\bstart (?:a |the )?(?:scene|roleplay|rp)\b/i;
function detectPickCharacter(text) { return !!text && PICK_CHAR_RE.test(String(text)); }

// Classify a user message as 'narrow' (a specific factual ask — named bill/entity, a
// who/what/when question, a quoted phrase) vs 'broad' (open/exploratory/conversational).
// Drives SCOPED retrieval: narrow → tight, entity-exact, recency-gated (don't flood with
// the whole topic); broad → wider + keep the recency "continuous-mind" texture. DEFAULTS
// to 'broad' (safer — only tightens on clear narrow signals).
function classifyQuery(text) {
  const t = String(text || '').trim();
  if (!t) return 'broad';
  // explicit exploratory cues → broad
  if (/\b(tell me about|what do you think|thoughts on|how (?:are|'?s| is) (?:you|it going|things)|overview|in general|broadly|what'?s new|anything interesting|catch me up|how was your)\b/i.test(t)) return 'broad';
  // named-entity / factual cues → narrow
  const narrow =
    /\b(?:H\.?\s?R\.?|S\.?)\s?\d+\b/.test(t)                                                   // bill number (H.R. 1, S.123)
    || /\b[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,5}\s+(?:Act|Bill|Treaty|Agreement|Initiative|Center|Report|Rule)\b/.test(t) // proper-named thing
    || /"[^"]{3,}"|'[^']{3,}'/.test(t)                                                          // quoted exact phrase
    || /\b(?:who|what|which|when|where)\s+(?:is|was|are|were|did|does|do)\b/i.test(t);          // factual wh-question
  if (narrow) return 'narrow';
  // short message anchored on a multi-word proper noun → narrow
  if (t.split(/\s+/).length <= 12 && /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/.test(t)) return 'narrow';
  return 'broad';
}

// "What did I say / we discuss about X", "remind me what…", "what are my…" — a RECALL of
// something earlier in the conversation. Routes episodic recall to USER statements only
// (the ground truth for "what I said"), dropping her own deflections + other questions.
const RECALL_RE = /\bwhat did (?:i|we|you) (?:say|tell|mention|discuss|talk about|decide|agree)\b|\bremind me what\b|\bwhat (?:are|were) my\b|\bdo you remember (?:what|when|that|me)\b|\bwhat was (?:my|the|our)\b|\bwhat did we (?:cover|land on)\b/i;
function isRecallQuery(text) { return !!text && RECALL_RE.test(String(text)); }

module.exports = { detectWebIntent, detectActOnOpenPage, detectPickCharacter, classifyQuery, isRecallQuery, SEARCH_HOME };
