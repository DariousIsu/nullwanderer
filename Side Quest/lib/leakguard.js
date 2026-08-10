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

// --- THE UNKEPT-PROMISE SAY (2026-07-23) --------------------------------------------------------
// Live turns 9341→9344→9346: "Gathering the most recent reports…" → "Fetching the latest news…" →
// "(Waiting for the latest reports…)" — three tool-followups, each PROMISING instead of answering,
// and the chain ended on the last promise. This detects a short, content-free status-say so the
// followup driver can force one final answer-or-honest-miss pass when no further work will run.
const _PROMISE_RE = /\b(fetch|gather|grab|pull|retriev|check|look)(?:ing)?\b.{0,60}$|\bwait(?:ing)?\b|\bone (?:moment|sec(?:ond)?)\b|\bhold on\b|\bworking on it\b|\bbe right back\b/i;
// A verify-INVITATION is the OPPOSITE of an unkept promise: "Take a look", "check it out", "have a
// look at the canvas" address LUCAS about work already delivered. The bare check|look stems above
// matched them (08-08 audit, the double-relay: a door relay ending in its own "Take a look"
// invitation read as a promise-say and re-fired the followup — two near-identical relays in chat).
const _INVITATION_RE = /\b(?:take|have|give)\s+(?:a\s+|another\s+)?look\b|\bcheck\s+(?:it|that|them|those|your)\b|\bgive\s+it\s+a\s+(?:read|scan|once-?over)\b|\bsee\s+for\s+yourself\b/i;
// A completed NEGATIVE OUTCOME is a REPORT, not a pending promise (08-09: a door's terminal reject
// relay — "The canvas create failed its output check — nothing landed" — contains "check" and tripped
// _PROMISE_RE, so fireToolFollowup's answer-now re-fire spawned a SECOND copy of the relay: two
// identical failure lines in one reply. A promise is forward-looking ("Fetching…"); a failure report
// is past-tense. When the text states a completed miss, it is the final word, never an unkept promise.
const _OUTCOME_RE = /\b(?:failed|did\s?n['’]?t|does\s?n['’]?t|could\s?n['’]?t|was\s?n['’]?t|were\s?n['’]?t|not\s+(?:applied|apply|land(?:ed)?|delivered|found)|nothing\s+(?:landed|happened|is\s+on)|unchanged|no\s+(?:such|matching)\b)/i;
function isUnkeptPromiseSay(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 160) return false;   // a real answer has substance; promises are short
  if (_INVITATION_RE.test(s)) return false; // delivered-work invitation, not a pending promise
  if (_OUTCOME_RE.test(s)) return false;    // a completed miss report, not a forward-looking promise
  return _PROMISE_RE.test(s);
}

// --- ENVELOPE ECHO in the THOUGHT rail (2026-07-23) ---------------------------------------------
// On cloud-written turns the reasoning channel is folded into her displayed interior — and frontier
// reasoning narrates its INSTRUCTIONS: "The prompt provides a precise answer that must be delivered
// verbatim… No tool calls needed." Lucas reads that as her thoughts and it reads deranged. Sentence-
// scoped drop of clear envelope narration; her actual reasoning about the QUESTION stays.
const _ENVELOPE_ECHO_RE = /\b(?:the (?:prompt|instruction|directive)s? (?:says?|provides?|specifi|state)|answer to give|must be delivered verbatim|paraphrased? but|do not (?:add|contradict) (?:any )?(?:facts|extra|it)|no tool calls? (?:are )?needed|reply only (?:with )?strict json|the required answer is)\b/i;
// DELIVERY PROMISE (2026-07-23, the parish-canvas fiction): a say that commits to producing or
// growing an ARTIFACT — "I'll keep adding the Louisiana parish contacts there as we collect them"
// with a canvas/document named earlier in the say. Distinct from isUnkeptPromiseSay (a retrieval
// in progress): delivery is future-tense, which the lookup net's I'll-guard excludes by design.
// Measured after that live promise: ZERO parish canvas tabs existed — the promise connected to
// nothing. Returns { topic } (the artifact's subject, good enough to title a tab) or null.
// Built via new RegExp from ASCII-escaped source (’ = curly apostrophe) — a regex literal
// carrying the raw curly quote tripped the file parser here while the identical pattern compiled
// fine standalone; the escape removes the ambiguity for good.
const _DELIVERY_RE = new RegExp(
  "\\b(?:i(?:['\\u2019]ll| will| am going to|['\\u2019]m going to)|let me)\\s+(?:keep\\s+)?" +
  '(?:add(?:ing)?|put(?:ting)?|compil(?:e|ing)|creat(?:e|ing)|assembl(?:e|ing)|collect(?:ing)?|track(?:ing)?|maintain(?:ing)?|build(?:ing)?|updat(?:e|ing))\\s+([^.!?\\n]{4,120})', 'i');
const _ARTIFACT_SURFACE_RE = /\b(canvas|document|docs?|file|tracker|brief|list|dossier|sheet|board|page)\b/i;
// A DEICTIC destination standing in for the artifact ("…adding them THERE / to it / onto it"). The
// artifact was named in an EARLIER turn, not this say — the measured live miss ("I'll keep adding the
// parish contacts THERE") referred to the canvas by pronoun, so the literal-word-only test never fired
// and the net was dead (0 firings ever). Counts as an artifact surface ONLY when recent context
// actually established one, so a plain "meet you there" can't manufacture a promise tab.
const _DEICTIC_DEST_RE = /\b(there|to it|onto it|to that|in that|on that)\b/i;
function deliveryPromise(text, opts = {}) {
  const s = String(text == null ? '' : text);
  const m = s.match(_DELIVERY_RE);
  if (!m) return null;
  if (/\?\s*$/.test(m[0])) return null;                                   // a question is not a commitment
  const ctx = String((opts && opts.context) || '');
  const hasArtifact = _ARTIFACT_SURFACE_RE.test(s)                        // named in the say, OR
    || (_DEICTIC_DEST_RE.test(s) && _ARTIFACT_SURFACE_RE.test(ctx));      // a deictic + an artifact named in recent context
  if (!hasArtifact) return null;
  let topic = String(m[1]).split(/\b(?:there|to the|in the|on the|into the|as we|as they|so that)\b/i)[0];
  topic = topic.replace(/^\s*(?:the|a|an|that|this)\s+/i, '').replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  return topic.length >= 6 ? { topic: topic.slice(0, 80) } : null;
}

function stripEnvelopeEcho(text) {
  const s = String(text || '');
  if (!s.trim()) return s;
  const parts = s.split(/(?<=[.!?])\s+|(?<=[a-z][.!?])(?=[A-Z])|\n+/);
  const kept = parts.filter((p) => !_ENVELOPE_ECHO_RE.test(p));
  return kept.join(' ').replace(/\s{2,}/g, ' ').trim();
}

// --- CONDUCT-ACKNOWLEDGMENT leak (2026-07-25) --------------------------------------------------
//
// Live fail: Lucas said "I need to take Alice to the gym for strength training day" and the reply
// was "Got it. I'll skip the 'I wasn't able…' line, keep things concise, and stop ending replies
// with a question. I'll stick to my own voice moving forward." — the model reciting the STYLE
// GUIDANCE in its prompt (the [Vary your voice…] nudge from lib/voice, plus the anti-disclaimer and
// conciseness rules) back as a first-person compliance statement, and ignoring the actual content.
// Lucas had held a correct conversation about his children days earlier, so the memory path works —
// the nudge DISPLACED it. This is the same shape as stripPlanningLeak (scaffolding-as-reply) one
// level up: instead of narrating machinery, she narrates her own conversational conduct.
//
// None of the strippers above fire: no bracket, no tag, no mechanics vocabulary. So this needs its
// own detector. It keys on SHAPE, not source strings, because the model CONFABULATES the
// acknowledgment (it drew "I wasn't able" and "concise" from prompt rules the nudge never mentioned)
// — matching the nudge text would miss it.
//
// FALSE POSITIVES are the real danger (suppressing a real reply), so the bar is deliberately high:
//   1. it must LEAD with an acknowledgment ("Got it"/"Understood") or a first-person commitment
//      ("I'll"/"from now on"), and
//   2. it must stack ≥2 DISTINCT conduct signals. The leak recites several rules at once; a genuine
//      reply that merely mentions style ("I'll keep it concise: Heritage, Cato, AEI") carries one,
//      and a normal reply carries none.
const _LEADS_ACK = /^\s*(?:got it|understood|noted|okay|ok|sure|alright|all right|will do|fair(?: enough)?|point taken|you'?re right|good (?:point|call)|makes sense|agreed|absolutely|of course)\b/i;
const _LEADS_COMMIT = /^\s*(?:i(?:'|’)?ll|i will|i(?:'|’)?m going to|i am going to|let me|from now on|going forward|moving forward)\b/i;
// Each entry is ONE dimension of "how she replies" — voice, question-habit, length, the disclaimer
// line, stock moves, variation. Distinct patterns so stacking is counted, not double-counted.
const _CONDUCT_SIGNALS = [
  /\b(?:my )?own voice\b|\bmy voice\b|\blike (?:myself|yourself)\b/i,
  /\bend(?:ing)?[^.?!]{0,14}(?:on|with)[^.?!]{0,6}a question\b|\basking[^.?!]{0,24}questions?\b|\b(?:fewer|too many|no more) questions?\b/i,
  /\bconcise\b|\bkeep it short\b|\bkeep things short\b|\bbe brief\b|\bless wordy\b|\bwordy\b|\btrim(?:ming)?\b/i,
  /\bi wasn'?t able\b|\bi couldn'?t\b|\bdisclaim(?:ers?|ing)?\b|\bcaveats?\b|\bhedg(?:es?|ing)\b/i,
  /\bstock (?:evaluative|phrase|template|line|expression)s?\b|\bpreamble\b|\bfiller\b|\breflect(?:ing)?[^.?!]{0,20}back\b|\breflect(?:ing)? (?:his|your) words\b/i,
  /\bvary my\b|\bvariety\b|\bmix it up\b|\bbreak the pattern\b|\brepetiti\w+\b|\brephras\w+\b|\breword\w*\b|\bmy phrasing\b|\bmy tone\b/i,
];

/**
 * True when a reply is a self-directed acknowledgment of conversational CONDUCT with nothing else —
 * the model reciting its style guidance instead of answering. SHAPE-based and conservative.
 *
 * Pure. Standalone it only DETECTS; the caller gates suppression/recovery on there having been a
 * style nudge this turn AND the user's own message NOT being a style request (see isStyleFeedback),
 * so an appropriate "Got it, I'll stop doing that" after Lucas asks for it is never eaten.
 */
function isConductAcknowledgment(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 400) return false;                 // a real answer carries substance
  if (!(_LEADS_ACK.test(s) || _LEADS_COMMIT.test(s))) return false;
  const hits = _CONDUCT_SIGNALS.reduce((n, re) => n + (re.test(s) ? 1 : 0), 0);
  return hits >= 2;
}

/**
 * True when LUCAS's own message is asking her to change how she talks — so a conduct-acknowledgment
 * in reply is appropriate, not a leak. Aimed-at-her + at least one conduct signal.
 */
function isStyleFeedback(userMessage) {
  const s = String(userMessage || '').trim();
  if (!s) return false;
  const aimed = /\byou(?:'|’)?re\b|\byou\b|\byour\b|\byourself\b/i.test(s)
    || /^\s*(?:stop|don'?t|please|try to|keep|be|quit|no more|less|more)\b/i.test(s);
  if (!aimed) return false;
  return _CONDUCT_SIGNALS.some((re) => re.test(s));
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

module.exports = { isLeakyDirective, stripLeakedDirectives, stripPlanningLeak, isUnkeptPromiseSay, deliveryPromise, stripEnvelopeEcho, isConductAcknowledgment, isStyleFeedback, makeStreamFilter, _DIRSIG, _METASIG, _INTERNAL_TAG_RE, _PLAN_LEAD, _MECHANICS, _CONDUCT_SIGNALS };
