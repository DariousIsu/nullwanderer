/**
 * leakguard — keep injected control DIRECTIVES from reaching Lucas, in BOTH the final text and the
 * LIVE token stream.
 *
 * The injected instruction blocks ([ANSWER TO GIVE…], [DELIVER THIS…], [Lucas asked for the list…],
 * [YOU HAVE ACCEPTED…]) are meant FOR her, not him — but the 24B sometimes echoes them verbatim. The
 * final-text strip caught them, yet they still showed because the reply STREAMS token-by-token to the
 * UI before the final strip runs (confirmed live 2026-06-29). So we need two things from one source of
 * truth: a final-text strip AND a stateful stream filter that holds a "[" open until it closes and
 * drops it if it reads as a directive.
 *
 * PURE: regex + a tiny state machine. No I/O. Fully offline-testable.
 */
'use strict';

// A bracket block is a leaked directive if it carries a directive SIGNATURE, or (for model-hallucinated
// meta brackets with no fixed signature) it's a long block talking about the task/Lucas in directive terms.
const _DIRSIG = /(ANSWER TO GIVE|THAT'?S YOUR TASK|DELIVER THIS|Calibration:|ACTION HONESTY|REMEMBER IT ACROSS|Say THIS in your own voice|STATUS UPDATE|ADDITIONAL GUIDANCE|standing (?:task|focus)|ACCEPTED this as|do NOT (?:invent|fabricate|summarize|contract|drift|recite)|in your own voice|grounded answer|present the FULL|REAL FACTS|ACCESSIBLE VIA|asked (?:for the|what you|about)|on your Canvas|put (?:it|this) on the Canvas|complete result of the task|YOUR (?:REPLY|ANSWER|RESPONSE))/i;
const _METASIG = /\b(Lucas|going forward|i will|do not|deliver|present|dossier|clarif|criteria|scope|the task|my research|remember|REMEMBER|going to (?:expand|include|focus)|search criteria|Canvas)\b/i;

function isLeakyDirective(bracket) {
  const m = String(bracket || '');
  return _DIRSIG.test(m) || (m.length > 60 && _METASIG.test(m));
}

// FINAL-TEXT strip: remove leaked directive brackets — closed, trailing-unterminated, or stacked/
// unterminated mid-text (each '[' + signature run up to its ']' OR the next '[' OR end-of-string).
function stripLeakedDirectives(text) {
  let s = String(text || '');
  // LEADING REPLY-SCAFFOLD: the 24B sometimes prefixes its answer with an echoed instruction + a fake
  // marker ("explore how music trends … [YOUR REPLY] Got it Lucas …"). Strip everything up to and
  // including a leading [YOUR REPLY] / [REPLY] / [ANSWER] / [RESPONSE] scaffold (bounded so it can't eat
  // a real reply that mentions one deep in).
  s = s.replace(/^[\s\S]{0,250}?\[\/?\s*(?:YOUR\s+)?(?:REPLY|ANSWER|RESPONSE)\s*\]\s*/i, '');
  s = s.replace(/\[[^\]]*\]/g, (m) => (isLeakyDirective(m) ? '' : m));   // closed blocks (incl. multi-line)
  s = s.replace(/\[[^\]]*$/g, (m) => (isLeakyDirective(m) ? '' : m));     // trailing unterminated
  s = s.replace(/\[[^\[]*?(?:DELIVER THIS|ANSWER TO GIVE|THAT'?S YOUR TASK|ACCEPTED (?:this|THIS) as|standing (?:task|focus)|Calibration:|do NOT (?:invent|fabricate|summarize|recite)|present the FULL|keep EVERY item|REAL FACTS|complete result of the task|asked (?:for the|what you)|on your Canvas)[^\[]*?(?:\]|(?=\[)|$)/gi, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ── PLANNING LEAK: the model's own scaffolding, with no bracket and no tag ──────────────────────
//
// Everything above catches leaked '[directives]' and '<tags>'. Neither fires on BARE PROSE, so this
// reached Lucas verbatim, as her entire reply, three times on 2026-07-21:
//
//   "We need to emit a web search."
//   "We need to fetch Iowa state flower. Use echo-find."
//   "We need to emit an Echo tag to get db map."
//
// That is the model narrating its next move instead of making it. The signature is narrow on
// purpose: a planning imperative ("we need to", "let me", "I should") whose OBJECT is internal
// machinery (emit, a tag, a tool name, echo-*). "I need to check the calendar" is not a leak — it is
// a person talking — so the mechanics vocabulary is required, not just the planning verb.
const _PLAN_LEAD = /^\s*(?:we|i)\s+(?:need to|should|must|will|have to|can)\s+|^\s*(?:let(?:'|’)?s|let me)\s+|^\s*(?:next|first|now),?\s+(?:we|i)\s+/i;
// `web search` / `page content` joined the vocabulary from live leak #9335 (2026-07-23): "We need
// to use web search.We need to see the page content." reached the screen — retrieval narration is
// mechanics too. "the output" stays OUT deliberately: Lucas and Zoe genuinely discuss outputs.
const _MECHANICS = /\b(?:emit|emitting)\b|<[a-z-]+>|\becho-\w+|\becho tag\b|\btool tag\b|\bdb[ _-]?map\b|\bweb\s+search\b|\bpage content\b|\b(?:call|invoke|run)\s+(?:the\s+)?(?:tool|recipe|echo)\b/i;

/**
 * Remove leading planning sentences that describe emitting/calling machinery.
 *
 * Sentence-scoped and front-anchored: it strips the scaffolding she opens with and keeps whatever
 * real reply follows. A message that is ONLY scaffolding returns '' — the caller then treats it as
 * an empty say, which is the honest outcome, and the tool follow-up speaks instead.
 */
const _MAX_SCAFFOLD = 100;   // the three real leaks were 29, 34 and 42 chars; real prose runs longer
function stripPlanningLeak(text) {
  const s = String(text || '');
  if (!s.trim()) return s;
  // Streamed reasoning fragments concatenate WITHOUT spaces ("web search.We need" — live leak
  // #9335), so the whole leak plus the real reply parsed as one giant "sentence" and sailed past
  // the length guard. Also split where a sentence-ender sits jammed against a capital, but only
  // after a lowercase letter — "U.S." and "3.5" stay whole.
  const parts = s.split(/(?<=[.!?])\s+|(?<=[a-z][.!?])(?=[A-Z])/);
  // The leading RUN of short, plan-shaped sentences. Mechanics may appear in ANY of them — live, the
  // plan and the tool name were split across two ("We need to fetch Iowa state flower. Use
  // echo-find."), so requiring them in the same sentence missed a real leak.
  let run = 0;
  for (const p of parts) {
    const t = p.trim();
    // ⚠️ LENGTH IS THE FALSE-POSITIVE GUARD, and it earned its place: "I should emit a note here
    // about how the county boards are structured, because…" is a person thinking out loud and an
    // earlier draft of this function deleted it whole. Scaffolding is terse; prose is not.
    if (!t || t.length > _MAX_SCAFFOLD) break;
    const planShaped = _PLAN_LEAD.test(t) || (run > 0 && /^(?:use|then|and then|also)\b/i.test(t));
    if (!planShaped) break;
    run++;
  }
  if (!run) return s;
  const lead = parts.slice(0, run);
  // Only a run that actually names internal machinery is scaffolding. "Let's go through the parishes
  // one at a time." is plan-shaped and terse and is perfectly good speech.
  if (!lead.some((p) => _MECHANICS.test(p))) return s;
  return parts.slice(run).join(' ').trim();
}

// An angle-bracket run is an INTERNAL tag (her private cognition or a tool tag) if its name is in this set.
// The TagStreamParser keeps well-formed <think> out of the stream already, but a stray/truncated think
// fragment or a tool tag emitted INSIDE <say> used to flash in the live bubble and only vanish on reload
// (the stored copy strips them). This lets the stream match the stored copy for those tags. A NON-internal
// tag (<div>, a real "<") is emitted verbatim so genuine content and code are never eaten.
// ⚠️ THIS LIST DRIFTED FROM THE REAL TAG VOCABULARY. The patterns match a tag's FIRST word, so any
// tag whose first word isn't listed streams straight to the screen. Live 2026-07-20, Lucas saw
// "<read-inbox/> Got it—I'll keep the Hawaii county board update in mind…" rendered in his chat:
// `inbox[\w-]*` never matches `read-inbox`, because the tag begins with "read".
//
// Six of the thirty-four tags main.js actually parses were leaking: observe-screen, read-inbox,
// notify, clipboard-read, clipboard-write, chat-send. Each is a compound whose first word is the
// verb, so the noun-based patterns above miss all of them. Verb forms are now listed explicitly, and
// smoke_leakguard asserts the filter against main.js's own tag vocabulary so the two cannot drift
// apart again silently.
const _INTERNAL_TAG_RE = /^<\/?(?:think|thinking|thought|thoughts|say|navigate|wonder|web[\w-]*|echo[\w-]*|browser[\w-]*|browse[\w-]*|files?[\w-]*|screen[\w-]*|inbox[\w-]*|sched[\w-]*|scheduler[\w-]*|presence[\w-]*|email[\w-]*|discord[\w-]*|recall[\w-]*|image-gen|draw|imagine|dig|skill|open-?thread[\w-]*|status[\w-]*|tool[\w-]*|act[\w-]*|wait|read-[\w-]*|observe-[\w-]*|clipboard[\w-]*|notify|chat-[\w-]*|remember[\w-]*|forget[\w-]*)\b/i;

// STREAM filter: wrap an emit(chunk) sink so leaked control DIRECTIVES ('[…]') and internal/tool TAGS
// ('<think>…', '<web-open>…') never reach the UI live. Holds an open '[' or a tag-shaped '<' (buffering,
// not emitting) until it resolves or grows past MAXBUF; drops it if it's a directive/internal tag, else
// emits verbatim. A '<' that isn't tag-shaped ("a < b", "3<5") streams through unchanged. Call flush() at end.
function makeStreamFilter(emit) {
  const MAXBUF = 800;
  let buf = '';
  let inBracket = false;
  let inTag = false;
  const send = (s) => { if (s) { try { emit(s); } catch {} } };
  return {
    feed(token) {
      let out = '';
      const flushOut = () => { if (out) { send(out); out = ''; } };
      for (const ch of String(token || '')) {
        if (inBracket) {
          buf += ch;
          if (ch === ']') { if (!isLeakyDirective(buf)) out += buf; inBracket = false; buf = ''; }
          else if (buf.length >= MAXBUF) { if (!isLeakyDirective(buf)) out += buf; inBracket = false; buf = ''; }
          continue;
        }
        if (inTag) {
          buf += ch;
          // Disambiguate as soon as we have the char after '<': only '/' or a letter starts a tag; anything
          // else ("< ", "<=", "<3") is a literal '<' → flush it and the char through.
          if (buf.length === 2 && !/[a-zA-Z/]/.test(buf[1])) { out += buf; inTag = false; buf = ''; continue; }
          if (ch === '>') { if (!_INTERNAL_TAG_RE.test(buf)) out += buf; inTag = false; buf = ''; }
          else if (buf.length >= MAXBUF) { if (!_INTERNAL_TAG_RE.test(buf)) out += buf; inTag = false; buf = ''; }
          continue;
        }
        if (ch === '[') { flushOut(); inBracket = true; buf = '['; continue; }
        if (ch === '<') { flushOut(); inTag = true; buf = '<'; continue; }
        out += ch;
      }
      if (out) send(out);
    },
    flush() {
      if (inBracket && buf && !isLeakyDirective(buf)) send(buf);       // unterminated non-directive → emit
      else if (inTag && buf && !_INTERNAL_TAG_RE.test(buf)) send(buf); // unterminated non-internal tag → emit
      inBracket = false; inTag = false; buf = '';
    }
  };
}

module.exports = { isLeakyDirective, stripLeakedDirectives, stripPlanningLeak, makeStreamFilter, _DIRSIG, _METASIG, _INTERNAL_TAG_RE, _PLAN_LEAD, _MECHANICS };
