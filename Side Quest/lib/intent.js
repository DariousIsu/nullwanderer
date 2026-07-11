/**
 * Web-intent detection — does the user's message clearly ask to use the web /
 * open a browser? Returns { target } (a URL or search terms) for main.js's
 * web-intent interceptor, else null. Extracted from main.js so it's unit-testable.
 *
 * Conservative on bare conversation, but a pasted URL with a viewing verb ("take a
 * look at this <url>") is treated as "open it in her browser" — the clearest case.
 */
// Where a bare "open a browser" (no URL/query) lands. Google, matching her visible deep-browse
// lane's engine (DDG was dropped — it null-routed this IP; see docs/BROWSER_AND_RECIPES.md §1a).
const SEARCH_HOME = 'https://www.google.com';

function detectWebIntent(text) {
  if (!text) return null;
  const t = String(text).trim();

  const tag = t.match(/<web-open>\s*([\s\S]*?)\s*<\/web-open>/i);
  if (tag) return { target: (tag[1] || '').trim() || SEARCH_HOME };

  const url = t.match(/https?:\/\/\S+/i) || t.match(/\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?\b/i);
  const search = t.match(/\b(?:search(?:\s+for)?|look\s*up|google|find)\b\s+(?:the\s+|for\s+)?(.{2,90})/i);
  const verb = /(open|opening|launch|fire up|pull up|go to|browse|web-open|\buse\b)/i.test(t);
  // A TRUE "open a browser fresh" verb — distinct from the loose `verb` (which includes "use",
  // "browse", "go to"). ONLY an openVerb may reset to the blank search home; merely MENTIONING
  // the browser ("use your browser", "test your browser", "your browser is slow") must NOT
  // navigate it. This was the bug: any verb+"browser" wiped her open page to the DDG home.
  const openVerb = /\b(open|opening|launch|fire (?:up|it up)|pull up|boot up|bring up|start up)\b/i.test(t);
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
    // BARE (no URL, no search query): only a real OPEN verb resets to the blank search home,
    // and it's marked `bare` so the caller can refuse to wipe an ALREADY-OPEN browser. A loose
    // mention ("use/browse your browser") with no destination → null (just talk, don't navigate).
    if (openVerb) return { target: SEARCH_HOME, bare: true };
    return null;
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

// "Record a recipe by demonstration" — Lucas wants to walk her through a site once so
// she captures a reusable flow. Returns { action:'start', task, url, site } to begin, or
// { action:'stop' } to finish + save, else null. `recording` (is a demonstration live?)
// broadens the stop phrasing — once recording, a bare "done"/"that's it" means stop.
const REC_START_RE = /\b(?:record|capture)\b[^.?!]{0,24}\b(?:recipe|flow|steps?|how\s+(?:to|i))\b|\b(?:learn|memori[sz]e|remember)\s+how\s+to\b|\b(?:watch|let me show you)\b[^.?!]{0,12}\b(?:me|how)\b/i;
const REC_STOP_STRICT = /\b(?:stop|done|finish(?:ed)?|end)\s+(?:the\s+|this\s+)?recording\b|\bsave\s+(?:the\s+|this\s+)?recipe\b/i;
const REC_STOP_LOOSE = /\b(?:that'?s\s+(?:it|all|the\s+recipe)|i'?m\s+done|we'?re\s+done|finished|all\s+done|stop\s+recording|done\s+recording)\b/i;

function detectRecordCommand(text, recording = false) {
  if (!text) return null;
  const t = String(text).trim();
  // STOP first when a recording is live (so "done" ends it rather than starting a new one).
  if (recording && (REC_STOP_STRICT.test(t) || REC_STOP_LOOSE.test(t))) return { action: 'stop' };
  if (!recording && REC_STOP_STRICT.test(t)) return { action: 'stop' };

  if (!REC_START_RE.test(t)) return null;
  const urlM = t.match(/https?:\/\/\S+/i) || t.match(/\b[a-z0-9-]+\.[a-z]{2,}(?:\/\S*)?\b/i);
  const url = urlM ? urlM[0] : null;
  let site = '';
  if (url) { try { site = new URL(/^https?:/i.test(url) ? url : 'https://' + url).hostname.replace(/^www\./, ''); } catch { site = url; } }
  // task phrase: "how to <task>", "recipe for <task>", "record <task>" — stop at " on <site>".
  let task = '';
  const m = t.match(/\bhow\s+to\s+(.+?)(?:\s+(?:on|at|in|using|via|with)\b|[.?!]|$)/i)
    || t.match(/\brecipe\s+for\s+(.+?)(?:\s+(?:on|at|in)\b|[.?!]|$)/i)
    || t.match(/\b(?:record|capture)\s+(?:me\s+|a\s+|the\s+)?(?:recipe\s+for\s+)?(.+?)(?:\s+(?:on|at|in)\b|[.?!]|$)/i);
  if (m) task = m[1].replace(/\b(?:a|the|this|that)\s+(?:recipe|flow|steps)\b/i, '').replace(/[\s,]+$/, '').trim();
  // collapse a leftover bare "recipe/flow" task to a generic label
  if (!task || /^(?:recipe|flow|steps?|this|it)$/i.test(task)) task = 'flow';
  return { action: 'start', task: task.slice(0, 60), url, site };
}

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

// ACTIONABLE turn — the message hands her something concrete to act on: a URL, a file/path
// reference, or an imperative task verb aimed at a thing ("open this", "read the sheet",
// "try it"). On such turns the TASK owns the context, so off-topic between-turn musing must
// be relevance-gated out (it was bleeding in: a shared spreadsheet got read as being about
// whatever she'd been idly ruminating on). classifyQuery() defaults to 'broad' and misses
// these (no narrow signal in "try it from your own drive"), so this is a separate gate.
const _IMPERATIVE_RE = /\b(open|read|check|look at|pull(?: up| it)?|review|try|use|fix|do|send|write|make|show|get|find|fetch|load|view|see|summari[sz]e|analyz?e|go to|visit)\b[^.?!]{0,40}\b(this|that|it|the|here|link|file|sheet|spreadsheet|doc|document|page|tab|url|email|pdf|attachment|drive)\b/i;
function isActionable(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (/https?:\/\/\S+/i.test(t)) return true;                 // a URL to act on
  if (/\b[\w.\-]+\.(?:xlsx?|xlsm|csv|pdf|docx?|pptx?|txt|md|json|png|jpe?g)\b/i.test(t)) return true; // a file reference
  if (/[A-Za-z]:\\|\b\/[\w.\-]+\/[\w.\-]+/.test(t)) return true; // a filesystem path
  return _IMPERATIVE_RE.test(t);                              // imperative aimed at a thing
}

// SOCIAL / PERSONAL turn — Lucas is just talking WITH her (a greeting, a check-in, casual
// relating), not handing her work. On these turns the work-goal scaffolding + assistant
// register should RECEDE so she's present, instead of answering "how are you" with a status
// report on her threads + professionalism + "Best, Zoe". Conservative: never fires on a task
// (isActionable wins), and a work-progress check ("how are you doing on the op-ed") is
// excluded by the work-reference guard, so only genuine relational turns qualify.
const _GREETING_RE = /^\s*(?:hi|hey|hello|yo|sup|hiya|heya|howdy|morning|evening|good\s*(?:morning|afternoon|evening|night)|goodnight)\b/i;
const _CHECKIN_RE = /\bhow\s+(?:are|'?re|r)\s+(?:you|ya|u)\b|\bhow\s+(?:you|ya)\s+doin[g']?\b|\bhow'?s\s+(?:it\s+going|things|life|your\s+(?:day|night|weekend|morning|evening))\b|\bhow\s+have\s+you\s+been\b|\bhow\s+was\s+your\b|\byou\s+(?:there|around|awake|up)\b|\bwhat'?s\s+up\b|\bmiss(?:ed)?\s+you\b|\bgood\s+to\s+(?:see|hear\s+from)\s+you\b|\bjust\s+(?:checking\s+in|saying\s+(?:hi|hey|hello))\b/i;
const _ENDEARMENT_RE = /\b(?:kiddo|buddy|pal|sweetie|hon)\b/i;
const _WORK_REF_RE = /\b(?:on|with|about|for|re)\s+(?:the|your|our|that|this|my|a)\b|\b(?:op-?ed|article|draft|bill|research|project|report|piece|spreadsheet|sheet|deck|memo|deadline|task|assignment)\b/i;
function isSocialTurn(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (isActionable(t)) return false;                    // a task owns the turn, not chit-chat
  const checkin = _CHECKIN_RE.test(t), greeting = _GREETING_RE.test(t), endear = _ENDEARMENT_RE.test(t);
  if (!checkin && !greeting && !endear) return false;
  if (_WORK_REF_RE.test(t)) return false;               // "how are you doing on the op-ed" = work
  // A greeting FOLLOWED by a real question ("Hey Zoe, who is X?") is a QUESTION with a friendly opener,
  // not a social turn — it must NOT skip the grounding/cognition pipeline (the Trump-admin deflection).
  const afterGreeting = t.replace(/^\s*(?:hi|hey|hello|yo|sup|hiya|heya|howdy|morning|evening|good\s*(?:morning|afternoon|evening|night)|goodnight)\b[\s,!.]*(?:zoe|there|girl|hun)?[\s,!.—-]*/i, '').trim();
  const isRealQuestion = afterGreeting && afterGreeting !== t && /\?/.test(afterGreeting)
    && /\b(who|what|which|when|where|why|whose|is|are|was|were|do|does|did|can|could|list|name|find|pull|how many|how much|how old|how long)\b/i.test(afterGreeting)
    && !_CHECKIN_RE.test(afterGreeting);
  if (isRealQuestion) return false;
  const words = t.split(/\s+/).length;
  if (checkin) return true;                             // a state check-in is social at any length
  if (greeting && words <= 12) return true;            // a bare/opening greeting
  return endear && words <= 16;                        // an address term in a short personal line
}

module.exports = { detectWebIntent, detectActOnOpenPage, detectPickCharacter, detectRecordCommand, classifyQuery, isRecallQuery, isActionable, isSocialTurn, SEARCH_HOME };
