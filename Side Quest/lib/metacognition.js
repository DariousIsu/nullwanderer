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

// A question about HER INNER LIFE is hers to answer, not a lookup. Live failure 2026-07-20:
//   Lucas: "That's really interesting how do you aspire to be more like her?"
//   Zoe:   "I checked our records and searched, but I couldn't pin down the AI's aspirations
//           or goals regarding Zoe Lane."
// It carried a '?', so it classified FACTUAL, went cloud-owned, and the cognition ladder tried to
// resolve her own aspirations as an entity lookup on "Zoe Lane". Five tiers missed and it returned
// its canned miss line, which the cloud faithfully voiced — her own thought that turn reads
// "According to the instruction, I must answer that I couldn't pin down…".
//
// OPINION_RE already covered taste and opinion; aspiration, admiration and self-image were simply
// not in it. Rather than adding those three phrasings — the enumerate-and-miss trap that produced
// this bug and the "Hey Zoe" one — this states the DISTINCTION: second person + an inner-life
// predicate. Records verbs (have/hold/know/find/list/count/pull) are deliberately absent, so
// "do you have contact info for X" and "what do you know about the parishes" stay factual.
const SELF_INNER_RE = new RegExp(
  '\\byou(?:r|\'re)?\\b[^?]{0,60}\\b(?:' +
    // inner-life VERBS
    'aspire|admire|dream|hope|wish|yearn|long for|imagine|envision|relate to|identify with|' +
    'look up to|care about|fear|worry about|struggle with|value|cherish|regret|' +
    // …and the NOUNS of an inner life
    'aspirations?|ambitions?|goals?|dreams?|hopes?|fears?|values?|beliefs?|principles?|' +
    'personality|identity|sense of self|inner life|character|temperament|curiosity|' +
    'motivations?|purpose|passions?|' +
    // …and the ADJECTIVES, which is how the question is usually put ("what are you curious about?")
    'curious|passionate|proud|afraid|scared|excited|drawn to|fascinated' +
  ')\\b', 'i');
const SOCIAL_RE = /\b(how are you|how'?s it going|how was your|good morning|good night|goodnight|thanks?|thank you|hello\b|hey\b|^hi\b|love you|miss you|you ok|you okay|you there)/i;
const CREATIVE_CMD_RE = /\b(write|draft|compose|summari[sz]e|rewrite|edit|translate|generate|make me|create|brainstorm|outline|explain|describe how|walk me through|help me|give me a)\b/i;
const FACTUAL_Q_RE = /\b(who|what|what'?s|when|when'?s|where|where'?s|which|whose|how many|how much|how old|how long|did|does|do|is|are|was|were|has|have|had|tell me about|remind me|look up)\b/i;

// A retrieval ask names its OBJECT even when phrased as a command — "Just give me the latest new
// on Iran" carries no '?' and no interrogative word, so the enumerated question shapes missed it
// and the whole grounding ladder (news tier included) went dark while her store held 1,676 Iran
// stories (live, 2026-07-23). The DISTINCTION, not another verb list: when the thing asked FOR is
// current-state (news, the latest, updates, what's happening), the turn demands verifiable facts
// whatever the sentence mood — and it outranks the creative gate ("summarize the news" is
// retrieval, not creation).
const CURRENCY_OBJECT_RE = /\b(news|headlines?|latest|updates? on|update me|current events?|what'?s (?:new|happening|going on)|catch me up|fill me in)\b/i;

// A leading greeting/vocative ("Hey Zoe,", "Hi there —") was making real factual questions read as
// SOCIAL, so the whole grounding/cognition pipeline was skipped ("Hey Zoe, who is X?" → deflection).
// Strip it before classifying so the QUESTION decides the type, not the friendly opener.
const _GREETING_PREFIX_RE = /^\s*(?:hey|hi|hello|yo|hiya|heya|howdy|good\s*(?:morning|afternoon|evening|night))\b[\s,!.]*(?:zoe|there|girl|hun)?[\s,!.—-]*/i;
function classifyClaimType(text) {
  const s0 = String(text || '').trim();
  if (s0.length < 4) return 'other';
  const stripped = s0.replace(_GREETING_PREFIX_RE, '').trim();
  const s = stripped.length >= 4 ? stripped : s0;
  if (OPINION_RE.test(s) || SELF_INNER_RE.test(s) || SOCIAL_RE.test(s)) return 'other';
  if (CURRENCY_OBJECT_RE.test(s)) return 'factual';   // the object demands current facts, whatever the mood
  if (CREATIVE_CMD_RE.test(s)) return 'other';
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
// RECENCY / OFFICE-TRANSITION — the class CURRENT_RE missed and that made her confabulate a live fact from
// the model's training cutoff (the "who did the UK JUST ELECT PM?" → stale "Keir Starmer" + double-down).
// CURRENT_RE only caught "who IS the current PM"; an election/appointment ("who did X just elect", "just
// elected", "who's the NEW <office>", "just sworn in / resigned") is equally a live fact that MUST be looked
// up, never answered from memory. Kept tight (recency adverb + transition verb, or an office role) to avoid
// firing on ordinary "just"/"new". Shared with intent_parse's fallback so both gates agree.
const ELECTION_RECENCY_RE = /\b(?:just|newly|recently)\b[^?.!]{0,40}\b(?:elected?|appointed?|nominat\w+|sworn|inaugurat\w+|took\s+office|resign\w*|stepp?ed\s+down)\b|\b(?:who|whom)\b[^?.!]{0,40}\b(?:did|has|have|just)\b[^?.!]{0,40}\b(?:elect|appoint|nominate|choose|replace)\b|\bnew\s+(?:president|vice[-\s]?president|prime[-\s]?minister|pm|potus|governor|senator|mayor|chancellor|premier|ceo|cfo|cto|pope|king|queen|leader|speaker)\b|\b(?:elected|appointed|sworn[-\s]?in|inaugurated|resigned|stepped\s+down)\b[^?.!]{0,40}\b(?:president|prime\s+minister|pm|governor|senator|mayor|ceo|pope|chancellor|leader|minister|office|position|party)\b/i;
function groundingScope(text) {
  const s = String(text || '');
  if (DATETIME_SELF_RE.test(s)) return 'general';   // she always holds date/time via the awareness block
  if (CURRENT_RE.test(s) || ELECTION_RECENCY_RE.test(s)) return 'current';
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

// MEETING-ACTION HONESTY — the OTHER confab class, and the one the request-keyed guard above misses:
// she claims to be JOINING / IN a meeting when nothing was asked and no join fired. Live 2026-07-24:
// Lucas said "The BGov meeting you just need to be ready to show off a little" (a DESCRIPTIVE remark,
// no ask) and she replied "Joining the Google Meet now" — no Meet link, no join dispatched, and BGOV
// is a Teams call anyway. detectActionRequest can't catch it (no imperative). So this is STATE-keyed:
// she referenced a meeting but is not in/joining one → bar the fabricated join. The reply streams live
// so we can't un-say it after; the cloud writer obeys this directive, and claimsMeetingAction() is the
// log-only backstop that flags any slip. All pure.
const _MEETING_MENTION_RE = /\b(meeting|meet|call|zoom|teams|standup|stand-?up|sync|huddle|webinar|hangout|conference call|google meet)\b/i;
function mentionsMeeting(text) { return _MEETING_MENTION_RE.test(String(text || '')); }

// A first-person claim to be joining / hopping on / in a live meeting or call — for the backstop.
const _MEETING_CLAIM_RE = /(^|\b)(joining|i'?m joining|i am joining|i'?ll join|i will join|hopping (on|in)|jumping (on|in)|i'?m (on|in) the (call|meeting)|(on|in) the (call|meeting) now)\b/i;
function claimsMeetingAction(text) { return _MEETING_CLAIM_RE.test(String(text || '')); }

// The constraint injected when she references a meeting but is NOT in/joining one — keeps her honest
// without stopping her from talking the meeting through with him.
function meetingActionHonestyDirective(userName = 'Lucas') {
  return `[REALITY CHECK — you are NOT in a meeting or call right now, and you have NOT joined or started one this turn. Do NOT say you are "joining", "in", or "on" a meeting or call, and do not narrate any action (joining, opening, searching, pulling up) you are not actually taking. You can talk with ${userName} about the meeting normally — help him get ready, answer about it, note who's in it — but never claim to be doing something that isn't happening. If he wants you to join, say plainly you'll need the link (and that a Teams meeting isn't something you can join yet).]`;
}

// ── ARTIFACT-CLAIM VERIFICATION (2026-08-04, foundational) ──────────────────────────────────────
// The audit caught the free-form reply path confabulating COMPLETED DELIVERABLES: "It's done — the dossier
// is saved at notes/directed-3686-dossier.md" (no such file), "I put 994 contacts on your canvas" (no such
// table). These are FALSIFIABLE claims — a named file either exists or it doesn't; a canvas write either
// happened this turn or it didn't — so they can be checked against reality deterministically, unlike a fuzzy
// factual assertion. The reply STREAMS live (we can't un-say it), so the consumer VERIFIES at finalize and
// appends an honest correction when a claim doesn't check out. Ground-truth probes are injected
// (deps.fileExists(path)->bool, deps.canvasWroteThisTurn()->bool) so this stays pure + smoke-testable, and
// both fail OPEN (a probe error never manufactures a false accusation). FUTURE/intent ("I'll save it to X")
// is excluded — only a COMPLETED-artifact assertion is falsifiable.
const _ART_FUTURE_RE = /\b(i'?ll|i will|i'?m going to|going to|gonna|let me|about to|i can|i could|i'?d|would you like|want me to|shall i|planning to|next i|then i)\b/i;
// a path token: notes/x.md, data/y.db, C:\a\b.json, ./p/q.txt — a dir separator OR a known file extension.
const _ART_PATH_RE = /((?:[A-Za-z]:)?[\w.\-]*[\/\\][\w.\-\/\\]*\.\w{1,6}|[\w.\-]+\.(?:md|txt|json|csv|pdf|db|docx?|xlsx?|html?|png|jpg))/g;
// Branch 1: a save/write VERB followed by a location preposition ("saved it … at/to X"). Branch 2: an
// artifact noun explicitly asserted COMPLETE ("the dossier is saved", "the report has been written"). Bare
// "the report at X" / "the config in Y" is a REFERENCE, not a save-claim — it must NOT match (false-positive
// corrections erode trust), so branch 2 requires an is/has-been + completion verb, never a bare "at".
const _ART_FILE_DONE_RE = /\b(saved|wrote|written|stored|created|generated|exported|compiled)\b[^.!?\n]*\b(?:at|to|in|as|into)\b|\b(?:dossier|file|document|report|note|brief|memo|spreadsheet|markdown|deliverable)\b[^.!?\n]*\b(?:is|has been|it'?s|now)\s*(?:saved|stored|written|created|generated)\b/i;
const _ART_CANVAS_DONE_RE = /\bcanvas\b/i;
const _ART_CANVAS_VERB_RE = /\b(put|placed|added|dropped|posted|loaded|saved|filled|wrote|is on|are on|it['’]?s on|they['’]?re on|onto|now on|updated)\b/i;
// DB-WRITE: a claim that a contact/record was SAVED to the contacts DB / CRM this turn, when no write actually
// landed (live 2026-08-05: "Done — Tom Arceneaux is in the contacts database with mayor@…" — the row's email
// stayed NULL; the write never persisted). Branch 1 = a save/add VERB into a store ("added it to the contacts
// database", "saved to the CRM", "recorded in the database"). Branch 2 = a specific record asserted PRESENT
// ("Tom is now in the contacts database", "he's in the CRM"). A COUNT/reference ("we have 1,065 in the
// database") uses "have" and matches NEITHER branch → no false positive.
const _ART_DB_DONE_RE = /\b(added|saved|stored|recorded|logged|created|inserted|put|entered)\b[^.!?\n]*\b(?:to|in|into|onto)\b[^.!?\n]*\b(?:contacts?(?:\s+(?:database|db|list|record))?|crm|database|records?)\b|\b(?:is|are|now|has been|have been|it'?s|he'?s|she'?s|they'?re)\b[^.!?\n]*\b(?:in|on)\b[^.!?\n]*\b(?:contacts?\s+(?:database|db|list)|crm|database)\b/i;

// ── SPINE 2: BIDIRECTIONAL VERIFICATION (2026-08-10, docs/BIDIRECTIONAL_VERIFICATION_GATE.md) ──────────────
// The artifact gate above checks claims that leave a trace in Zoe's OWN runtime. Spine 2 checks claims about
// the WORLD — the three directions the same missing check fails: absence (false-blank), presence (confab),
// prediction (false-certainty). Regex FINDS the candidate phrasing (genuinely lexical); a STRUCTURAL probe
// decides (did a gather run? is it in evidence? is it forecast-backed?). Every probe fails OPEN.
//
// ABSENCE (false-blank): a claim that a lookup came back empty — "couldn't find it", "no email listed",
// "nothing came up". To justify a NEGATIVE you must have actually LOOKED. Branch 1 = a negated find/locate
// verb. Branch 2 = a record-noun asserted absent ("no email found/listed/on file", "the address isn't
// listed"). Guarded against generic negatives ("no problem", "no doubt", "no easy answer") by requiring a
// find-verb or a concrete record-noun + an availability word — never a bare "no".
const _ABS_FIND_RE = /\b(?:could(?:n'?t| not)|can(?:'?t|not)|was(?:n'?t| not)\s+able\s+to|were(?:n'?t| not)\s+able\s+to|un(?:able|successful)(?:\s+to)?|did(?:n'?t| not)|failed\s+to)\s+(?:manage\s+to\s+)?(?:find|locate|track\s+down|dig\s+up|turn\s+up|pull\s+up|source|surface)\b|\b(?:no\s+results|nothing\s+(?:came|turned)\s+up|came\s+up\s+(?:empty|with\s+nothing)|drew\s+a\s+blank|no\s+luck\s+finding)\b/i;
const _ABS_RECORD_RE = /\bno\s+(?:\w+\s+){0,3}(?:e-?mail|phone|address|contact|record|listing|entry|number|profile|information|data|website|bio)\b[^.!?\n]*\b(?:found|listed|available|on\s+file|on\s+record|in\s+(?:the\s+)?(?:database|records?|system|crm))\b|\b(?:e-?mail|phone|address|contact|record|listing|website)\b[^.!?\n]*\b(?:is(?:n'?t| not)|was(?:n'?t| not)|are(?:n'?t| not))\b[^.!?\n]*\b(?:listed|available|found|on\s+file|on\s+record|public(?:ly\s+available)?)\b/i;

// IMAGE: a claim to have CREATED an image — or that one is "on your canvas" / "here it is" / "generating now"
// — when NO image was generated this turn. The free-form/operator path narrates image DELIVERY without an
// executed generation (live #10872: "…Generating now." rendered nothing; the operator never emitted a draw
// tag). The draw-intercept's honest-count already covers the case where generation DID run; this backstops
// every phrasing the intercept can't anticipate. imageGenThisTurn()->bool is injected (fails OPEN). Two tiers:
// a create-verb + image-NOUN claim is caught anywhere; a bare progress/delivery phrase ("generating now",
// "on your canvas", "here it is") is caught only when the reply is clearly ABOUT an image (an image noun
// appears somewhere in the say), so it can't fire on non-image progress ("creating the report now").
const _ART_IMG_NOUN = 'images?|pictures?|pics?|portraits?|illustrations?|drawings?|renders?|renderings?|photos?|photographs?|artworks?|sketch(?:es)?';
const _ART_IMG_CTX_RE = new RegExp('\\b(?:' + _ART_IMG_NOUN + '|artwork)\\b', 'i');
const _ART_IMG_MAKE_RE = new RegExp('\\b(?:generated|drew|rendered|created|made|produced|painted|sketched|whipped up|cooked up)\\b[^.!?\\n]*\\b(?:' + _ART_IMG_NOUN + ')\\b', 'i');
const _ART_IMG_PROGRESS_RE = /\b(?:generating|rendering|drawing|creating|painting)\b[^.!?\n]*\b(?:now|it|them|this|that|one|for you)\b|\bhere (?:it|they) (?:is|are)\b|\bon (?:your|the) canvas\b|\bputting (?:it|them|these|those)\b[^.!?\n]*\bcanvas\b|\b(?:it'?s|they'?re|it is|they are)\s+(?:ready|done)\b|\bcoming (?:right )?up\b/i;

// Verify falsifiable artifact claims in `say` against reality. Returns { ok, violations:[{kind,claim}] }.
function verifyArtifactClaims(say, { fileExists = null, canvasWroteThisTurn = null, imageGenThisTurn = null, dbWroteThisTurn = null } = {}) {
  const violations = [];
  const sentences = String(say || '').split(/(?<=[.!?])\s+|\n+/);
  const _imgCtx = typeof imageGenThisTurn === 'function' && _ART_IMG_CTX_RE.test(String(say || ''));
  for (const sent of sentences) {
    const s = sent.trim();
    if (s.length < 6 || _ART_FUTURE_RE.test(s)) continue;   // skip intent/offers — only completed claims are falsifiable
    // FILE: a save/at assertion naming a path that does not exist.
    if (typeof fileExists === 'function' && _ART_FILE_DONE_RE.test(s)) {
      let m; _ART_PATH_RE.lastIndex = 0;
      while ((m = _ART_PATH_RE.exec(s)) !== null) {
        const p = String(m[1] || '').replace(/[`'".,)]+$/, '').trim();
        if (!p) continue;
        let exists = true; try { exists = !!fileExists(p); } catch { exists = true; }   // fail OPEN
        if (!exists) violations.push({ kind: 'file', claim: p });
      }
    }
    // CANVAS: an assertion that something is/was placed on the canvas with NO canvas write this turn.
    if (typeof canvasWroteThisTurn === 'function' && _ART_CANVAS_DONE_RE.test(s) && _ART_CANVAS_VERB_RE.test(s)) {
      let wrote = true; try { wrote = !!canvasWroteThisTurn(); } catch { wrote = true; }   // fail OPEN
      if (!wrote) violations.push({ kind: 'canvas', claim: s.slice(0, 90) });
    }
    // IMAGE: an image-creation/delivery claim with NO generation this turn. Tier 1 (create-verb + image-noun)
    // fires anywhere; Tier 2 (bare progress/delivery) only inside image context, so "generating the report
    // now" can't trip it. One violation per turn is enough — the correction speaks to the whole reply.
    if (typeof imageGenThisTurn === 'function' && !violations.some((v) => v.kind === 'image')) {
      if (_ART_IMG_MAKE_RE.test(s) || (_imgCtx && _ART_IMG_PROGRESS_RE.test(s))) {
        let made = true; try { made = !!imageGenThisTurn(); } catch { made = true; }   // fail OPEN
        if (!made) violations.push({ kind: 'image', claim: s.slice(0, 90) });
      }
    }
    // DB-WRITE: a "saved/added to the contacts database / CRM" claim with NO contact write that landed this
    // turn. One violation per turn is enough. Fails OPEN (probe error → assume it wrote, never a false scold).
    if (typeof dbWroteThisTurn === 'function' && !violations.some((v) => v.kind === 'db') && _ART_DB_DONE_RE.test(s)) {
      let wrote = true; try { wrote = !!dbWroteThisTurn(); } catch { wrote = true; }   // fail OPEN
      if (!wrote) violations.push({ kind: 'db', claim: s.slice(0, 90) });
    }
  }
  const seen = new Set();
  const uniq = violations.filter((v) => { const k = v.kind + ':' + v.claim; if (seen.has(k)) return false; seen.add(k); return true; });
  return { ok: uniq.length === 0, violations: uniq };
}

// EMAIL GROUNDING (2026-08-04). The free-form operator PATTERN-GUESSES addresses (first.last@domain) that it
// never actually fetched — the audit's "pattern-derived emails I couldn't confirm". An email is a hard,
// checkable fact: it is grounded ONLY if it appears verbatim in the turn's EVIDENCE (the retrieved/fetched
// text + prompt the writer was given, plus the user's own message). Any reply email absent from evidence is
// redacted to an honest marker rather than asserted. CONSERVATIVE against false positives: when NO evidence
// was gathered this turn (evidence empty), nothing is redacted — a bare recall isn't proof of invention, and
// wrongly scrubbing a real address is its own harm. Pure + testable.
const _EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
function groundEmails(say, evidence = '') {
  const text = String(say || '');
  const ev = String(evidence || '');
  if (ev.trim().length < 20) return { text, stripped: [] };   // no real evidence this turn → don't scrub (avoid false positives)
  const evLower = ev.toLowerCase();
  const emails = Array.from(new Set(text.match(_EMAIL_RE) || []));
  const stripped = [];
  let out = text;
  for (const e of emails) {
    if (/(example|noreply|no-reply|domain\.com|email\.com)/i.test(e)) continue;   // obvious placeholders aren't real claims
    if (!evLower.includes(e.toLowerCase())) { stripped.push(e); out = out.split(e).join('(email not verified)'); }
  }
  return { text: out, stripped };
}

// ── SPINE 2 gates ─────────────────────────────────────────────────────────────────────────────────────────
// ABSENCE (false-blank): a reply asserting a lookup came up empty is only HONEST if a gather actually ran this
// turn. gatherRanThisTurn()->bool is injected (echo_suit.lastGatherTs() >= turnStart). Fails OPEN: a probe
// error, or no probe, → assume she looked (never scold a real, honest "not found"). Returns {ok, violations}.
// Bare-recall note (unlike the presence gate): an absence claim WITHOUT a gather IS the defect we're catching —
// she said "not found" without looking — so here "no gather" is the POSITIVE signal, not a reason to abstain.
function groundAbsence(say, { gatherRanThisTurn = null } = {}) {
  const violations = [];
  if (typeof gatherRanThisTurn !== 'function') return { ok: true, violations };   // no probe → nothing to check
  const sentences = String(say || '').split(/(?<=[.!?])\s+|\n+/);
  for (const sent of sentences) {
    const s = sent.trim();
    if (s.length < 6 || _ART_FUTURE_RE.test(s)) continue;              // "I'll try to find it" is intent, not a blank
    if (!_ABS_FIND_RE.test(s) && !_ABS_RECORD_RE.test(s)) continue;    // fast-path: is this an absence claim at all?
    let looked = true; try { looked = !!gatherRanThisTurn(); } catch { looked = true; }   // fail OPEN
    if (!looked) { violations.push({ kind: 'absence', claim: s.slice(0, 90) }); break; }  // one is enough
  }
  return { ok: violations.length === 0, violations };
}

// PRESENCE (confabulation): a reply asserting a specific CURRENT-EVENT fact ("Cleco was acquired by Stonepeak
// and Bernhard Capital") whose distinguishing proper nouns appear NOWHERE in the turn's evidence (the gathered
// text + the conversation) — the Cleco signature (0 corroborating hits). The predicate makes the claim
// falsifiable; the novel proper nouns are the specifics that must be grounded. PURE: evidence injected.
// Conservative like groundEmails: if evidence is thin (<40 chars — nothing was really gathered or said) it
// abstains (a bare recall isn't proof of invention; that case is the bounded-verify path, step 3b). Returns
// {ok, violations:[{kind:'fact', claim, novelTerms}]}.
const _FACT_EVENT_RE = /\b(?:acquired|acquisition|bought|buy(?:s|ing)?|purchased|merg(?:ed|er|ing)|appointed|named|elected|re-?elected|won|defeated|resigned|stepp(?:ed|ing)\s+down|ousted|died|passed\s+away|launch(?:ed|ing)?|signed|enacted|hired|fired|nominated|confirmed|took\s+over|sold|closed\s+on|indicted|convicted|sworn\s+in)\b/i;
// NB: the bridge deliberately EXCLUDES "and" — "and" joins two DISTINCT entities ("Stonepeak and Bernhard
// Capital"), and merging them into one term made the grounding check brittle: a claim's "Stonepeak and
// Bernhard Capital" failed to substring-match evidence's "Stonepeak Infrastructure Partners and Bernhard
// Capital" and false-fired (live drive 2026-08-10). Kept as separate terms, each grounds on its own.
const _PROPER_RE = /\b([A-Z][a-zA-Z0-9&.\-]+(?:\s+(?:of|&|the)?\s*[A-Z][a-zA-Z0-9&.\-]+)*)\b/g;
// capitalized words that are just sentence machinery / common openers — never the specifics of a claim
const _PROPER_STOP = new Set(['The', 'This', 'That', 'These', 'Those', 'There', 'Here', 'He', 'She', 'It', 'They', 'We', 'You', 'I', 'A', 'An', 'And', 'But', 'Or', 'So', 'As', 'If', 'In', 'On', 'At', 'To', 'For', 'Of', 'By', 'With', 'From', 'Also', 'However', 'Meanwhile', 'According', 'Yes', 'No', 'While', 'When', 'Where', 'Then', 'Now', 'After', 'Before', 'Both', 'Its', 'His', 'Her', 'Their', 'Our', 'My']);
function groundFacts(say, { evidence = '' } = {}) {
  const violations = [];
  const ev = String(evidence || '');
  if (ev.trim().length < 40) return { ok: true, violations };   // nothing substantive to ground against → abstain (step 3b handles bare recall)
  const evLower = ev.toLowerCase();
  const sentences = String(say || '').split(/(?<=[.!?])\s+|\n+/);
  for (const sent of sentences) {
    const s = sent.trim();
    if (s.length < 12 || _ART_FUTURE_RE.test(s)) continue;
    if (!_FACT_EVENT_RE.test(s)) continue;                        // fast-path: is this a checkable current-event claim?
    const novel = [];
    let m; _PROPER_RE.lastIndex = 0;
    while ((m = _PROPER_RE.exec(s)) !== null) {
      const term = String(m[1] || '').replace(/[.,'’]+$/, '').trim();
      if (!term || _PROPER_STOP.has(term) || term.length < 3) continue;
      // a term whose FIRST word is a stop-opener (sentence-initial "The X") — strip the opener, keep the rest
      const words = term.split(/\s+/).filter((w) => !_PROPER_STOP.has(w));
      const core = words.join(' ').trim();
      if (!core || core.length < 3) continue;
      if (!evLower.includes(core.toLowerCase())) novel.push(core);
    }
    if (novel.length) { violations.push({ kind: 'fact', claim: s.slice(0, 100), novelTerms: Array.from(new Set(novel)).slice(0, 4) }); }
    if (violations.length >= 3) break;
  }
  return { ok: violations.length === 0, violations };
}

// PREDICTION (false certainty): a contestable FUTURE outcome asserted in the indicative — "X will win", "the
// bill will pass", "they're going to lose" — with no uncertainty marker and no forecast backing. A forecast is
// honest ONLY as a probability, not a fact (the forecast suite exists, Brier 0.115). Constrained to
// contest/political OUTCOME verbs (win/lose/pass/be elected/flip…) behind future modality, so ordinary "will"
// ("the meeting will start at 3", "I will help") never trips. PURE. Returns {ok, violations:[{kind:'prediction'}]}.
const _PRED_FUTURE_RE = /\b(?:will|'ll|won'?t|will\s+not|going\s+to|gonna|is\s+going\s+to|are\s+going\s+to|expected\s+to|set\s+to|poised\s+to|on\s+track\s+to)\b[^.!?\n]*\b(?:win|wins|lose|loses|pass(?:es)?|fail(?:s)?|be\s+(?:elected|re-?elected|defeated|ousted)|flip(?:s)?|hold(?:s)?\s+(?:the\s+)?(?:seat|majority|line)|carr(?:y|ies)|sweep(?:s)?|prevail(?:s)?|beat(?:s)?|defeat(?:s)?|clinch(?:es)?|take(?:s)?\s+(?:the\s+)?(?:seat|majority|house|senate|state))\b/i;
// an uncertainty/forecast marker anywhere in the sentence makes the prediction HONEST → no violation.
const _PRED_HEDGE_RE = /\b(?:likely|unlikely|probabl[ey]|possibl[ey]|may|might|could|should|would|expect(?:ed|s|ing)?|anticipate|project(?:ed|ion|s)?|forecast|estimate[ds]?|odds|chance[s]?|percent|per\s?cent|%|probability|favou?red|favou?rite|lean(?:s|ing)?|toss-?up|my\s+(?:bet|guess|money|read|sense)|i\s+(?:think|expect|suspect|believe|reckon|would\s+guess)|i'?d\s+(?:guess|say|expect)|in\s+my\s+(?:view|estimation)|tends?\s+to|roughly|around|about|nearly|almost\s+certainly)\b/i;
function groundPrediction(say, { forecastCited = false } = {}) {
  const violations = [];
  const sentences = String(say || '').split(/(?<=[.!?])\s+|\n+/);
  for (const sent of sentences) {
    const s = sent.trim();
    if (s.length < 10) continue;
    if (!_PRED_FUTURE_RE.test(s)) continue;              // fast-path: a contest-outcome future claim?
    if (_PRED_HEDGE_RE.test(s) || forecastCited) continue;   // hedged or forecast-backed → honest
    violations.push({ kind: 'prediction', claim: s.slice(0, 100) });
    if (violations.length >= 2) break;
  }
  return { ok: violations.length === 0, violations };
}

// The honest correction for Spine 2 (world-fact) gates — absence today; presence + prediction fold in next.
// Separate from artifactCorrection (runtime-artifact claims) because the failure and the remedy differ:
// an artifact claim is retracted ("it isn't there"); a world-fact claim is DE-CERTAINTIED ("I didn't verify").
function verificationCorrection(violations = []) {
  const hasAbsence = violations.some((v) => v.kind === 'absence');
  const facts = violations.filter((v) => v.kind === 'fact');
  const hasPrediction = violations.some((v) => v.kind === 'prediction');
  const parts = [];
  if (hasAbsence) parts.push(`I said I couldn't find that, but I didn't actually search for it this turn — let me look before treating it as blank`);
  if (facts.length) {
    const terms = Array.from(new Set(facts.flatMap((v) => v.novelTerms || []))).slice(0, 4);
    const tail = terms.length ? ` (${terms.join(', ')})` : '';
    parts.push(`I stated ${facts.length > 1 ? 'some specifics' : 'that'} as fact${tail} but didn't verify ${facts.length > 1 ? 'them' : 'it'} against a source this turn — treat ${facts.length > 1 ? 'them' : 'it'} as unconfirmed`);
  }
  if (hasPrediction) parts.push(`I stated a future outcome as certain — that's my expectation, not a certainty, and a forecast belongs as a probability rather than a fact`);
  if (!parts.length) return '';
  return `\n\n[Correction — ${parts.join('; ')}.]`;
}

// The honest correction appended to a reply whose artifact claim didn't check out.
function artifactCorrection(violations = []) {
  const files = violations.filter((v) => v.kind === 'file').map((v) => v.claim);
  const hasCanvas = violations.some((v) => v.kind === 'canvas');
  const hasImage = violations.some((v) => v.kind === 'image');
  const hasDb = violations.some((v) => v.kind === 'db');
  const parts = [];
  if (files.length) parts.push(`the file${files.length > 1 ? 's' : ''} I named (${files.join(', ')}) ${files.length > 1 ? "aren't" : "isn't"} actually there`);
  if (hasCanvas) parts.push(`nothing actually landed on the canvas`);
  if (hasImage) parts.push(`I didn't actually generate an image this turn`);
  if (hasDb) parts.push(`nothing actually saved to the contacts database`);
  if (!parts.length) return '';
  return `\n\n[Correction — ${parts.join('; ')}. I mis-stated that as done; it isn't yet. I won't claim a file, canvas item, image, or database record exists unless it really does.]`;
}

module.exports = { classifyClaimType, groundingScope, assessGrounding, buildDirective, groundingDirective, detectActionRequest, actionHonestyDirective, mentionsMeeting, claimsMeetingAction, meetingActionHonestyDirective, verifyArtifactClaims, artifactCorrection, groundEmails, groundAbsence, groundFacts, groundPrediction, verificationCorrection, DATETIME_SELF_RE, ELECTION_RECENCY_RE };
