/**
 * lib/turn_router.js — SINGLE-DISPATCH turn router (turn→object-graph rebuild, Phase A).
 *
 * The bug this fixes (proven via data/prompt_debug.log): runChatTurn had ~6 independent classifiers,
 * each stapling its own bracketed directive onto ONE `composedUserMessage`, and the tooless local voice
 * model rendered the UNION — e.g. "who is Donald Trump?" got BOTH a cloud answer AND a "list your 19
 * research orgs" status directive. This is the documented kitchen-sink / prompt-stuffing anti-pattern
 * (arXiv Arbiter, ConInstruct): conflicting instructions in one buffer with no precedence → a small
 * model with no arbitration signal renders everything.
 *
 * The fix is the routing pattern (Anthropic "Building Effective Agents" separation-of-concerns;
 * LangGraph Command single-dispatch; LlamaIndex LLMSingleSelector typed decision; Aurelio semantic-router
 * per-route threshold + explicit fallback): classify ONCE into a single route via a PRIORITY CASCADE —
 * first confident match wins, so routes are mutually exclusive by construction. Only the chosen route's
 * handler then runs; nothing else can staple a directive.
 *
 * PURE + dependency-injected (takes a pre-computed signals object, returns a decision) so it's fully
 * offline unit-testable and carries no I/O. main.js gathers the cheap signals it already computes and
 * passes them in; each work-machinery block then gates on the returned route.
 *
 * Routes (priority high→low):
 *   control    — an already-handled control turn (stop / wrap-up / expand a standing task)
 *   correction — the user is correcting the prior turn
 *   docqa      — a question about a held document
 *   status     — "how's the research going / what are you working on" (about ACTIVE/known work)
 *   task       — a work assignment (start/extend a research deliverable)
 *   lookup     — a live/external fact ("latest X", "look up Y")
 *   answer     — a factual / shared-history / self question answered from memory (the object pull)
 *   explore    — the brainstorm middle-gear: a topic being DISCUSSED (not commanded) — answer + pull a
 *                grounded bit in + optionally float a project offer, but create NO run (set in main.js)
 *   converse   — chit-chat, opinion, brainstorm, greeting — the default; pure local voice
 *   clarify    — genuine ambiguity → ask one question (bias-toward-clarifying) [reserved; emitted only
 *                when a caller passes an explicit ambiguous flag; Phase A doesn't force it]
 */
'use strict';

// Which routes are "conversational/answering" (NOT work-machinery). On these, the deliverable-poll,
// operator, intake and directed-focus blocks must NOT fire — they're what caused the directive pile-up.
// `explore` = the brainstorm middle-gear: she ANSWERS + pulls a grounded bit + may FLOAT a project offer,
// but creates no run (it's conversational; a full run only auto-fires on the `task` route). Set by the
// intake-gate arbitration in main.js when a topic is being DISCUSSED but not explicitly commanded.
const CONVERSATIONAL = new Set(['converse', 'answer', 'lookup', 'correction', 'docqa', 'clarify', 'explore']);
// Which routes may reach the cloud operator / external tools.
const OPERATOR_OK = new Set(['lookup', 'task', 'operator']);

function _r(route, confidence, reason) { return { route, confidence, reason }; }

/**
 * Decide the single route for a turn from pre-computed signals. First match wins.
 * sig fields (all optional booleans unless noted):
 *   directedStopHandled, expandHandled  → a control turn already ran
 *   correctionHandled                   → correction already captured
 *   docQaHandled                        → doc-QA already answered
 *   socialTurn                          → greeting / chit-chat
 *   isStatusReq                         → real "how's it going" about the active focus
 *   activityQ                           → "what are you working on / been up to"
 *   hasDirectedFocus                    → a directed focus is currently active
 *   deliverableAggQ                     → Track classifier said count/list/facet/status/rank (WEAK — misfires)
 *   isAssignment                        → intake/regex says this is a work assignment
 *   isLiveInfo                          → live/external info question (curiosity.isLiveInfoQuestion)
 *   factual, personalFactQ, devQ, stateQ→ factual / self / dev / state questions (answered from memory)
 */
function computeTurnRoute(sig = {}) {
  // 1) Control turns already handled deterministically upstream — record and stop.
  if (sig.directedStopHandled || sig.expandHandled) return _r('control', 1, 'control-handled');
  if (sig.correctionHandled) return _r('correction', 1, 'correction-handled');
  if (sig.docQaHandled) return _r('docqa', 1, 'docqa-handled');

  // 2) Social/chit-chat → pure local voice. High priority so "good morning" never triggers machinery.
  if (sig.socialTurn) return _r('converse', 0.9, 'social');

  // 3) STATUS — only for a REAL status intent about active/known work. A bare deliverableAggQ is a WEAK
  //    signal that misfires on factual entity questions (the "who is Trump → list 19 orgs" bug), so it
  //    only routes to status when it's NOT a factual entity question AND there's actual work to report.
  if (sig.isStatusReq) return _r('status', 0.85, 'status-request');
  if (sig.activityQ) return _r('status', 0.75, 'activity-question');
  if (sig.deliverableAggQ && sig.hasDirectedFocus && !sig.factual && !sig.personalFactQ) {
    return _r('status', 0.6, 'deliverable-agg+active-focus');
  }

  // 3.7) CONTACTS — "list / give me / who do we have — the contacts we HOLD" → query the Puller/CRM and
  //      drop a canvas list. Sits ABOVE `task` so a contact-list ask isn't mistaken for a research
  //      assignment (the "cleanest energy industry contacts → deep-research run" bug).
  if (sig.isContactsQuery) return _r('contacts', 0.85, 'contacts-query');

  // 4) TASK — a genuine work assignment (start / extend a deliverable).
  if (sig.isAssignment) return _r('task', 0.8, 'assignment');

  // 5) LOOKUP — a live/external fact that needs the web/echo now.
  if (sig.isLiveInfo) return _r('lookup', 0.75, 'live-info');

  // 5.5) FACTUAL (EXTERNAL) → LOOKUP, never answer-from-memory. The DB is the FOUNDATION, not the
  //      terminal answer: a question about the external world (people, orgs, data) routes to the
  //      search/operator lane, which GROUNDS from the verified store THEN searches the gaps. Answer-from-
  //      training is the hallucination this program exists to kill — a factual turn must NEVER terminate
  //      at memory/training (Lucas 2026-08-12, [[db-is-foundation-no-recall-only]]). Grounding is also the
  //      speed+cost WIN (verified read + short confirm beats a big model reasoning from training). If the
  //      store already holds it complete+recent, the operator confirms-from-DB and stops — no web hit.
  if (sig.factual) return _r('lookup', 0.7, 'factual-external → ground+search');

  // 6) ANSWER — INTERNAL/self facts ONLY: shared history, self-code, program state. These live in the
  //    verified self/personal store (NOT training), so memory IS their source of truth. OUTRANKS a bare
  //    deliverableAggQ so a self-fact question is an answer turn, never a status/deliverable dump.
  if (sig.personalFactQ || sig.devQ || sig.stateQ) return _r('answer', 0.7, 'self/internal-fact');

  // 7) A leftover deliverableAggQ with no active focus + not factual: treat as a weak status only if
  //    nothing above matched (rare); otherwise fall through.
  if (sig.deliverableAggQ && sig.hasDirectedFocus) return _r('status', 0.5, 'deliverable-agg-weak');

  // 8) Default — converse. Chit-chat, opinion, brainstorm; pure local voice.
  return _r('converse', 0.5, 'default');
}

// Convenience predicates for the wiring in main.js (keep the gate checks readable + centralized).
function isConversational(route) { return CONVERSATIONAL.has(route); }
function allowsOperator(route) { return OPERATOR_OK.has(route); }

// Should a `lookup`-routed turn actually FIRE the ground+search operator?
//
// The router decides route=lookup for a factual EXTERNAL question (classifyClaimType='factual', nothing
// higher-priority matched). That decision is authoritative and IS the license to ground+search — a second,
// NARROWER keyword classifier at the operator gate (main's `needsExternal` regex) must not be required to
// independently re-agree. It was: "who painted the Mona Lisa" / "what is the boiling point of water" routed
// to lookup but `needsExternal` missed the phrasing, so the operator never fired and the turn fell through
// to a local answer FROM TRAINING — the exact hallucination this program exists to kill ([[db-is-foundation-
// no-recall-only]]). This is the multi-classifier-disagreement bug the single-dispatch router was built to
// end, resurfacing at the operator seam. Make the route sufficient.
//
// TWO carve-outs never want the operator, and both are passed in (pure, no I/O here):
//   • isDateTimeSelf — the date/time/day itself lives in her awareness block every turn; searching it is a
//     pointless stall (metacognition.DATETIME_SELF_RE). It routes lookup but must answer from awareness.
//   • scope==='personal' — shared-history / "what did we decide" lives in the verified self/personal store;
//     memory IS its source of truth, NOT the web. A factual+personal turn still routes lookup (factual wins
//     the cascade) but must be answered from memory, never web-searched.
function lookupWantsOperator({ route, scope, isDateTimeSelf } = {}) {
  if (route !== 'lookup') return false;
  if (isDateTimeSelf) return false;
  if (scope === 'personal') return false;
  return true;
}

module.exports = { computeTurnRoute, isConversational, allowsOperator, lookupWantsOperator, CONVERSATIONAL, OPERATOR_OK };
