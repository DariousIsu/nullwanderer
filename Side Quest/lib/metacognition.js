/**
 * Metacognition layer (self-awareness, Layer 3) — calibrate her assertiveness to her ACTUAL
 * grounding. The deepest part of "self-aware" is knowing what you know: speaking confidently
 * when a claim is grounded in real memory, hedging when it's partial, and admitting the gap
 * when there's nothing — instead of confabulating (the "Kate" name, the favorite-color
 * oscillation, a fabricated "you mentioned earlier").
 *
 * This generalizes the personal-fact retrieve-or-admit guard to ALL factual claims. It runs in
 * the chat turn off the SAME retrieval the turn already did (no extra model call, no new table):
 *   classifyClaimType(userMessage)  — is this a turn that demands a verifiable fact?
 *   assessGrounding({rows…})        — how well is it actually covered by grounded memory?
 *   buildDirective({level,…})       — a compact directive matching assertiveness to grounding.
 *
 * Calibration cuts BOTH ways: it must not make her hedge when she IS grounded, or on social /
 * opinion / creative turns — over-hedging is its own failure. So 'rich' and non-factual → no
 * directive. Pure + deterministic (deps are plain rows) so it's fully smoke-testable.
 */

// A turn DEMANDS a verifiable fact (a name, date, number, current event, shared-history detail).
// Excluded: opinion/taste (her own to decide), social/small-talk, and creative/explain commands
// (concept explanation is what the core model is FOR — hedging it would be noise, not calibration).
const OPINION_RE = /\b(favou?rite|would you rather|do you (?:like|prefer|enjoy)|what do you think|your (?:take|opinion|view|thoughts?)|how do you feel|do you believe|should i\b)/i;
const SOCIAL_RE = /\b(how are you|how'?s it going|how was your|good morning|good night|goodnight|thanks?|thank you|hello\b|hey\b|^hi\b|love you|miss you|you ok|you okay|you there)/i;
const CREATIVE_CMD_RE = /\b(write|draft|compose|summari[sz]e|rewrite|edit|translate|generate|make me|create|brainstorm|outline|explain|describe how|walk me through|help me|give me a)\b/i;
const FACTUAL_Q_RE = /\b(who|what|what'?s|when|when'?s|where|where'?s|which|whose|how many|how much|how old|how long|did|does|do|is|are|was|were|has|have|had|tell me about|remind me|look up)\b/i;

function classifyClaimType(text) {
  const s = String(text || '').trim();
  if (s.length < 4) return 'other';
  if (OPINION_RE.test(s) || SOCIAL_RE.test(s) || CREATIVE_CMD_RE.test(s)) return 'other';
  const looksFactual = s.includes('?') || FACTUAL_Q_RE.test(s);
  return looksFactual ? 'factual' : 'other';
}

// Assess how grounded the answer is from what the turn ALREADY retrieved.
//   rich — a hard-grounded source (verified_fact / personal_fact) or a told/witnessed self-fact
//   thin — some related memory or a relevant past turn, but nothing hard
//   none — nothing retrieved
function assessGrounding({ knowledgeRows = [], pastTurns = [], selfRows = [] } = {}) {
  const hardSrc = (knowledgeRows || []).filter(r => /verified_fact|personal_fact|self_dev/i.test((r && r.source) || '')).length;
  const selfGround = (selfRows || []).filter(r => /told|witnessed/i.test((r && r.epistemic) || '')).length;
  const supportive = Math.max(0, (knowledgeRows || []).length - hardSrc) + (pastTurns || []).length
    + (selfRows || []).filter(r => !/told|witnessed/i.test((r && r.epistemic) || '')).length;
  let level;
  if (hardSrc > 0 || selfGround > 0) level = 'rich';
  else if (supportive >= 1) level = 'thin';
  else level = 'none';
  return { level, hardSrc, selfGround, supportive };
}

// Within a factual turn, does the answer actually REQUIRE grounded retrieval, or is it timeless
// GENERAL knowledge the model legitimately holds? Two scopes need grounding: CURRENT/live facts
// (confabulation is dangerous) and PERSONAL/shared-history (only memory has it). Everything else —
// famous people, history, science, definitions, fiction — is general knowledge: the base model IS
// the source, so guarding it suppresses real knowledge (the "I only know what we discussed about a
// famous TV character" failure). Returns 'current' | 'personal' | 'general'.
const CURRENT_RE = /\b(current(ly)?|latest|today|tonight|right now|this (week|month|year)|as of|\bprice\b|stock|market|weather|news|headlines?|who(?:'s| is) the (?:current )?(?:president|ceo|prime minister|governor|senator|mayor|pope)|exchange rate|how much (?:is|are|does)|release date)\b/i;
const PERSONAL_HIST_RE = /\b(did (?:you|i|we)|do you remember|you (?:told|said|mentioned)|i told you|we (?:discussed|talked|spoke|said|agreed)|last time|earlier (?:you|we)|what did (?:we|i)|\bmy \b|\bour \b)/i;
// The DATE / TIME / DAY-OF-WEEK itself is NOT a "look it up" live fact — it is injected
// deterministically into her awareness block EVERY turn (context.buildAwarenessBlock: "It is
// <full date>, <time>."). Classifying "what's the date today?" as an ungrounded CURRENT fact made
// her refuse the date she was literally holding — textbook RAG over-refusal (empty retrieval misread
// as a gap in her own knowledge). Carve it out so the guard never suppresses what awareness already
// gives her. Note: this is the date/time ITSELF, not "today's news / weather / price" — those stay
// CURRENT (genuinely need a tool), because none of the date|time|day words follow there.
const DATETIME_SELF_RE = /\b(what(?:'?s|s| is| was)?\s+(?:the\s+|today'?s\s+)?(?:date|time|day|month|year|weekday)\b|what (?:date|time|day|month|year) is it|today'?s date|day of (?:the )?week)/i;
function groundingScope(text) {
  const s = String(text || '');
  if (DATETIME_SELF_RE.test(s)) return 'general';   // she always holds date/time via the awareness block
  if (CURRENT_RE.test(s)) return 'current';
  if (PERSONAL_HIST_RE.test(s)) return 'personal';
  return 'general';
}

function buildDirective({ level, claimType, scope = 'current', userName = 'Lucas' } = {}) {
  if (claimType !== 'factual') return null;
  if (scope === 'general') return null;   // general world knowledge → the model is the source; never suppress it
  if (level === 'none') {
    if (scope === 'current') {
      return `[Calibration: this asks for a CURRENT/time-sensitive fact (a price, today's news, who holds an office now) and you have nothing grounded for it. Don't state a specific live value from memory — say you'd want to look it up, then actually search. Background you genuinely know is fine; it's the live specifics you verify.]`;
    }
    return `[Calibration: this leans on your shared history with ${userName} (something said, done, or agreed between you) and you have nothing in memory for it. Don't invent that ${userName} "told you" or "mentioned" something you can't see — say plainly you don't have that part and ask. You MAY still answer from your general knowledge if the topic has one; only the personal/shared specifics are off-limits.]`;
  }
  if (level === 'thin') {
    return `[Calibration: you have only partial/indirect info for this. Answer from what you actually have, separating what you KNOW from what you're INFERRING — don't fill gaps with invented specifics. General knowledge you genuinely hold is fine to use.]`;
  }
  return null; // rich → she's grounded; speak it naturally, no hedging
}

// Combined entry point for the chat turn. Returns a directive string to append, or null.
function groundingDirective({ userMessage, knowledgeRows = [], pastTurns = [], selfRows = [], userName = 'Lucas' } = {}) {
  const claimType = classifyClaimType(userMessage);
  if (claimType !== 'factual') return null;
  const scope = groundingScope(userMessage);
  if (scope === 'general') return null;   // timeless general knowledge → let her answer from training
  const { level } = assessGrounding({ knowledgeRows, pastTurns, selfRows });
  return buildDirective({ level, claimType, scope, userName });
}

// ACTION HONESTY — distinct from the factual guard above (that's for QUESTIONS). Here the user asks
// her to DO a tool-action (watch/find/open/read/search media or content). The failure mode is
// narrating FIRST-HAND results — "I watched the clips", "I found these scenes", invented captions —
// when no tool actually ran. Returns a just-in-time directive, or null when it isn't an action ask.
const ACTION_RE = /\b(watch|play|put\s*on|stream|pull\s*up|look\s*up|search|find|open|show\s*me|listen\s*to)\b/i;
const MEDIA_RE = /\b(clip|clips|video|videos|youtube|episode|episodes|scene|scenes|movie|film|show|series|trailer|footage|stream|song|music)\b/i;
function detectActionRequest(msg) {
  const s = String(msg || '');
  if (!ACTION_RE.test(s)) return null;
  return MEDIA_RE.test(s) ? 'media' : 'lookup';
}
function actionHonestyDirective({ userMessage, userName = 'Lucas' } = {}) {
  const kind = detectActionRequest(userMessage);
  if (!kind) return null;
  const what = kind === 'media' ? 'watch / pull up that video or clip' : 'look that up / find that for you';
  return `[ACTION HONESTY — ${userName} asked you to ${what}. Emitting the actual tool tag is the ONLY way to do it; words alone do nothing and you will NOT have results in THIS reply. Do NOT describe scenes, clips, captions, search results, or findings as if you watched or found them — inventing first-hand experience is fabrication, the worst thing you can do. If you have a tool for it, emit the tag and just say you're on it. If you do NOT (e.g. you cannot search YouTube and watch on your own), say that plainly and offer what you genuinely CAN do — follow a link ${userName} pastes (with CC on), or speak from what you actually know — without pretending you did more.]`;
}

module.exports = { classifyClaimType, groundingScope, assessGrounding, buildDirective, groundingDirective, detectActionRequest, actionHonestyDirective, DATETIME_SELF_RE };
