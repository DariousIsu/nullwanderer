/**
 * lib/brainstorm.js — the MIDDLE GEAR between chit-chat and a full 3-hour research project.
 *
 * The disease this cures (diagnosed live, focus #3385): the pipeline was BINARY. A turn either stayed
 * conversational (she talks, but pulls NOTHING grounded into the room — no substance to brainstorm
 * against) or it tripped the intake gate and a bounded org-profile RUN fired mid-conversation. There was
 * no lane where she brings little grounded bits into the riff that could BECOME the foundation of a
 * project IF invited. So a good brainstorming groove ("the AI arms race") went off the rails the moment a
 * topic brushed a named org: intake stamped it "assignment", the override flipped a confident `answer`
 * turn to `task`, and a research run spun up unasked.
 *
 * The fix is an EXPLICIT-only commit rule + a brainstorm lane:
 *   • A full run AUTO-FIRES only on an explicit imperative ("research X", "go deep on that", "spin it up").
 *   • A merely-DISCUSSED topic (a question, musing, "what about X") stays conversational — she answers,
 *     pulls ONE grounded bit into the reply as fuel, and floats a low-key OFFER to dig deeper. The run
 *     commits only when he says yes.
 *
 * PURE: regex + tiny helpers, no I/O, fully offline-testable. main.js owns the actual pulls + run creation.
 */
'use strict';

// ─── EXPLICIT ASSIGNMENT ─────────────────────────────────────────────────────
// An imperative to DO sustained work — the only thing that auto-fires a run. A research/produce verb in
// command position. Distinguished from DISCUSSING a topic (which stays in the brainstorm lane).
const _IMPERATIVE_RE = /\b(research|investigate|compile|gather|assemble|put together|pull together|draw up|build (?:me|out|a|an)\b|create (?:a|an|me)\b|generate (?:a|an|me)\b|find me\b|get me\b|dig into|go deep(?:er)? (?:on|into)|deep[- ]dive|spin (?:up|it up)|start (?:a |the )?(?:project|run|research|dossier|deep dive)|kick off|profile\b|monitor\b|track\b|map out|work up|prepare (?:a|an|me)\b|produce (?:a|an|me)\b|make me (?:a|an)\b|do a (?:deep dive|writeup|profile|dossier))\b/i;
// Musing / hypothetical framing turns an imperative-looking phrase into a floated idea, NOT a command:
// "what if we researched X", "we could dig into Y", "it'd be interesting to look at Z". Kept conservative
// so a genuine command is never softened away.
const _MUSE_RE = /\b(what if|maybe we (?:should|could)|we could|we should probably|i wonder|imagine if|it'?d be (?:cool|interesting|neat|fun)|would it be (?:worth|interesting|possible)|thinking (?:about|of)|kind of want to|might be worth)\b/i;
// A leading imperative ("Research the …", "Go deep on …") is a command even if a muse word appears later.
const _LEADS_IMPERATIVE_RE = /^\s*(please\s+|hey[, ]+|can you\s+|could you\s+|go ahead and\s+|zoe[, ]+)?(research|investigate|compile|gather|assemble|build|create|generate|find|dig into|go deep|deep[- ]dive|spin up|start|profile|monitor|track|map out|produce|prepare|put together|draw up)\b/i;

// Does this turn EXPLICITLY command sustained work (→ auto-fire a run), vs merely discuss a topic?
function isImperativeAssignment(message) {
  const s = String(message || '').trim();
  if (s.length < 3) return false;
  if (_LEADS_IMPERATIVE_RE.test(s)) return true;          // starts with a command → always explicit
  if (_MUSE_RE.test(s)) return false;                     // musing frame → floated idea, not a command
  return _IMPERATIVE_RE.test(s);
}

// ─── SOFT AFFIRMATION ────────────────────────────────────────────────────────
// A short "yes, do it" that COMMITS a freshly-floated offer (the seed → offer → commit arc). Carries no
// target of its own — it only makes sense against an open offer, which main.js supplies. Matches only when
// the WHOLE short reply is made of affirmation/connector tokens, so "yes the arms race is wild" (which
// carries new topic) does NOT count as a bare commit.
const _AFFIRM_RE = /^\s*(?:(?:yes|yep|yeah|yup|ya|yus|sure|ok|okay|absolutely|definitely|totally|perfect|great|cool|nice|awesome|please|do|it|go|for|ahead|deep|let'?s|spin|up|make|so|happen|dig|dive|in|run|with|sounds|good|of|course|for sure|works|that)\b[\s,.!]*)+$/i;
function isAffirmation(message) {
  const s = String(message || '').trim();
  return s.length > 0 && s.length <= 40 && _AFFIRM_RE.test(s);
}
// ─── START COMMAND ───────────────────────────────────────────────────────────
// A bare "begin / go ahead / do it / proceed" that greenlights something ALREADY on the table (a
// project she offered in chat, or a research thread Lucas red-tagged) but that carries no subject of
// its own. Distinct from isAffirmation (which the offer arc uses) because "begin"/"proceed"/"kick it
// off" aren't affirmation tokens — the live gap where "Begin." fired NOTHING and the heartbeat answered
// it. Like isAffirmation it only makes sense against an on-the-table task, which main.js supplies.
const _START_RE = /^\s*(?:(?:ok(?:ay)?|yes|yep|yeah|sure|please|alright|right|cool|now|then)[\s,.!]+)*(?:go ahead(?: and (?:do it|start|begin))?|get (?:going|started)|kick (?:it |things )?off|begin(?: (?:it|now|please))?|start(?: (?:it|now|on (?:it|that)|please))?|proceed|do it|make it (?:so|happen)|let'?s (?:go|do (?:it|this)|begin|start|get (?:going|started))|run with it|spin (?:it|that) up|fire (?:it|away)|go for it)[\s.!]*$/i;
function isStartCommand(message) {
  const s = String(message || '').trim();
  return s.length > 0 && s.length <= 48 && _START_RE.test(s);
}

// A floated offer is only committable while fresh — a bare "yes" three turns later isn't about the offer.
const OFFER_TTL_MS = 8 * 60 * 1000;   // 8 minutes
function offerFresh(ts, now) {
  const t = Number(ts) || 0, n = Number(now) || 0;
  return t > 0 && n >= t && (n - t) <= OFFER_TTL_MS;
}

// ─── KIND BACKSTOP ───────────────────────────────────────────────────────────
// Deterministic research-KIND detection, so a topical/forecast request never silently collapses to an
// entity org-walk when the fast model is lazy or the cloud is down. classifyKind returns a strong signal
// or null; reconcileKind fuses it with the cloud's kind (deterministic forecast/topical override a lazy
// 'entity'). Mirrors lib/intake.js kinds: entity | topical | forecast.
const _FORECAST_RE = /\b(predict|forecast|estimat(?:e|ing)|odds|likelihood|probabilit|chances? (?:of|that|are)|how likely|who (?:will|'ll|is going to|would) win|will (?:it|he|she|they|the|there|we|[A-Z]\w+)\b.*\b(win|lose|happen|pass|fail|drop|rise|fall|hold|flip|survive)|what (?:will|'ll|do you think will) happen|project(?:ed)? (?:outcome|result|to win)|model the outcome|what are the odds|call the (?:race|election|outcome))\b/i;
const _TOPICAL_RE = /\b(brief me|briefing|give me (?:a|the) (?:rundown|background|overview|lay of the land)|what'?s (?:going on|happening|the (?:story|deal|latest|situation)) (?:with|on|around|in|behind)|explain|break down|background on|state of|overview of|help me understand|walk me through|tell me about|the situation (?:with|in|around)|analysis of|how does .* work|why (?:is|are|did|does)|what is (?:happening|going on)|catch me up)\b/i;
const _ENTITY_RE = /\b(find (?:me )?[\w\s]{0,40}?\b(?:companies|orgs|organizations|organisations|people|contacts|firms|players|leads|list|prospects)|list (?:of |out )?[\w\s]{0,30}?\b(?:companies|orgs|people|contacts|firms)|contacts (?:for|at|in|of)|who are the (?:players|people|companies|orgs|key)|roster|dossier on|profile (?:of |on |sen|rep|senator|congress|mr|ms|dr|the )|competitors of|companies (?:like|similar to)|orgs? (?:like|similar to))\b/i;

function classifyKind(message) {
  const s = String(message || '');
  if (_FORECAST_RE.test(s)) return 'forecast';
  if (_ENTITY_RE.test(s)) return 'entity';
  if (_TOPICAL_RE.test(s)) return 'topical';
  return null;   // no strong deterministic signal
}
// Fuse the cloud's kind with the deterministic signal. A strong forecast signal always wins (it routes a
// whole different machine). A strong topical signal overrides a lazy/absent 'entity' (the live bug). Else
// trust the cloud kind; else the deterministic signal; else default entity.
function reconcileKind(cloudKind, message) {
  const c = ['entity', 'topical', 'forecast'].includes(cloudKind) ? cloudKind : null;
  const det = classifyKind(message);
  if (det === 'forecast') return 'forecast';
  if (det === 'topical' && (c === null || c === 'entity')) return 'topical';
  if (c) return c;
  return det || 'entity';
}

// ─── LIGHT-PULL GATING ───────────────────────────────────────────────────────
// "Active collaborator": on a substantive TOPICAL turn, pull ONE grounded bit into the reply as fuel.
// NOT on greetings, and NOT on self/status/activity turns (those have their own grounded answers). explore
// always pulls; a plain converse/answer pulls only when the turn looks topical enough to be worth it.
// A proper-noun PAIR (case-SENSITIVE — no /i, else it degrades to "any two words") OR a topic keyword.
const _PROPER_RE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/;
const _TOPIC_KW_RE = /\b(policy|market|industry|economy|technology|situation|conflict|war|race|trend|regulation|bill|election|crisis|deal|sector|debate|strategy|geopolitic|energy|climate|\bai\b|arms|security|treaty|sanctions?|tariffs?|supply chain|inflation|recession|semiconductor|nuclear|defense|trade)\b/i;
function looksTopical(message) {
  const s = String(message || '').trim();
  if (s.length < 16) return false;
  return _PROPER_RE.test(s) || _TOPIC_KW_RE.test(s);
}
function shouldLightPull(sig = {}) {
  if (sig.socialTurn) return false;
  if (sig.personalFactQ || sig.devQ || sig.stateQ || sig.activityQ || sig.isStatusReq) return false;
  const route = sig.route;
  const len = Number(sig.msgLen) || 0;
  if (len < 12) return false;
  if (route === 'explore') return true;                                  // a floated topic — always fuel it
  if ((route === 'answer' || route === 'converse' || route === 'lookup') && looksTopical(sig.message)) return true;
  return false;
}

// A short topic phrase to look up when there's no intake target (strip the question scaffolding).
function pullTopic(message) {
  let s = String(message || '').trim();
  s = s.replace(/^\s*(?:(?:hey|hi|hello|zoe|so|ok(?:ay)?|well|um|uh|yeah)[,! ]+)+/i, '');
  s = s.replace(/^\s*(what'?s|what is|what are|who'?s|who is|who are|tell me about|how'?s|how is|how are|why (?:is|are|did|does)|what do you (?:think|know) about|whats)\b/i, '');
  s = s.replace(/^\s*(the deal|the story|going on|happening)\s+(with|on|around|in)\s+/i, '');
  s = s.replace(/[?!.]+\s*$/g, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, 120);
}

module.exports = {
  isImperativeAssignment,
  isAffirmation, isStartCommand, offerFresh, OFFER_TTL_MS,
  classifyKind, reconcileKind,
  looksTopical, shouldLightPull, pullTopic,
  _IMPERATIVE_RE, _MUSE_RE, _AFFIRM_RE, _START_RE, _FORECAST_RE, _TOPICAL_RE, _ENTITY_RE,
};
