'use strict';
/*
 * lib/intake_contract.js — C1 + C2 (live-test run 2, 2026-08-19: the booking lottery).
 *
 * C1 (the booking contract): a user IMPERATIVE with a deliverable target — a file path, the canvas,
 * a sheet/report — must produce a booking or an explicit refusal, never a bare ack. Run-2's two
 * "finish the report at notes/…" orders produced NO intake extraction, no focus, no promise; the
 * chain died at a failed file-read behind a confident "let me pull that up". detectDeliverableOrder
 * is the deterministic net main.js's backstop books from (recheck_queue kind='promise', the same
 * ledger SPINE 3 pursues) when the turn itself delivered nothing.
 *
 * C2 (the facet gate): the mid-run correction net classified ANY user turn against the ACTIVE
 * directed focus — so "more details on the Senate District 14 vacancy" became the INDIANA
 * legislature run's enrich_facet, and a 7-state sponsors order attached to the ILLINOIS run.
 * foreignSubject is the deterministic pre-gate: a turn carrying its own DISTINCT subject (a state
 * the run doesn't cover, or proper-noun anchors none of which appear in the run's scope) is NOT a
 * correction to that run — the correction net stands down and the turn routes as its own ask.
 * Pure scope-talk ("just the top 5", "make it deep") carries no such anchors and passes through.
 *
 * Pure + injectable, no db. Run: scripts/smoke_intake_contract.js
 */

const str = (v) => (v == null ? '' : String(v));

// ── C1: the deliverable-order net ────────────────────────────────────────────────────────────────────────
// Interrogatives are asks, not orders (the lookup/status lanes own them).
// "when(ever)" opens QUESTIONS ("when did the vote happen") but also DEFERRAL leads ("when you get
// a chance, pull together…") — the run-6 catch. The lookahead carves the deferral shapes out.
const _QUESTION_RE = /\?\s*$|^(?:who|what|where|why|how|hows|how's|is|are|was|were|do|does|did|can|could|would|should|any)\b|^when(?:ever)?\b(?!\s+(?:you\s+(?:get|have|find)|there'?s\s+a|things\s+(?:quiet|slow))\b)/i;
// The order lead: an imperative deliver-verb opening a sentence, or an explicit commitment ask.
// F27b (boot_p54 retest): "clean up the wording in notes/x.md — smooth the phrasing in place" booked
// NOTHING — the edit verbs were missing from this vocabulary, so an edit-shaped order only booked when
// it happened to open with a compose verb ("finish …"). The phrasing lottery, one vocabulary short.
// F28 (saturation run 3, 2026-08-20): TWO more lottery tickets, both live-missed on the same night —
// "Put a short two-point primer … on the canvas." (placement verbs weren't order verbs; deliverable
// evidence downstream keeps them precise) and "Go into notes/x.md and smooth the rough sentences
// right in the file" (an approach-verb lead — go into/open/take — with the order verb after "and";
// the file went untouched behind "Got it — smoothing now"). The bridge is bounded to one sentence.
const _ORDER_VERB = /(?:finish|complete|update|build|make|compile|compose|create|assemble|land|write|draft|produce|generate|deliver|put together|pull together|knock out|redo|polish|tighten|revise|rework|reword|edit|refine|smooth|trim|clean\s*up|copy-?edit|proofread|put|drop|place|post|package)/i;
// The bridge span stays inside one sentence but must cross FILENAME dots ("notes/x.md and smooth…"):
// a dot followed by non-space is an extension dot, a dot followed by space/EOL ends the sentence.
const _APPROACH_BRIDGE = `(?:(?:go\\s+(?:into|to|through|over)|open(?:\\s+up)?|take|grab|pull\\s+up)\\s+(?:[^.!?;\\n]|\\.(?=\\S)){0,80}?\\b(?:and|then)\\s+)?`;
// Run-6 re-drive catch (2026-08-20): "Sometime today, put together a short digest … — no hurry"
// died behind the ack UNBOOKED — a temporal DEFERRAL prefix pushed the order verb off the
// recognized lead. A deferred order is STILL an order: it books now and pursues later; the
// deferral is scheduling advice, never a decline of the commitment.
const _DEFERRAL = `(?:sometime\\s+(?:today|tonight|soon|this\\s+\\w+)|at\\s+some\\s+point(?:\\s+(?:today|tonight))?|later\\s+(?:today|tonight|on)|when(?:ever)?\\s+you\\s+(?:get|have|find)\\s+(?:a\\s+)?(?:chance|moment|minute|sec(?:ond)?|gap|window|breather)|whenever\\s+there'?s\\s+a\\s+(?:gap|lull|window)|when\\s+things\\s+(?:quiet|slow)\\s+down|if\\s+you\\s+get\\s+a\\s+(?:chance|minute|moment)|no\\s+(?:rush|hurry)(?:\\s+on\\s+(?:it|this))?)`;
const _ORDER_LEAD_RE = new RegExp(`(?:^|[.!;\\n]\\s*)(?:(?:ok(?:ay)?|alright|good|great|nice|perfect|yes|yeah|now|next|also|then|please|zoe)[,\\s—–:;-]+)*(?:${_DEFERRAL}[,\\s—–-]+(?:but\\s+)?)?(?:let'?s\\s+|go ahead and\\s+)?${_APPROACH_BRIDGE}${_ORDER_VERB.source}\\b`, 'i');
const _ORDER_WANT_RE = new RegExp(`\\bi\\s+(?:want|need)\\s+(?:you\\s+to\\s+)?(?:(?:a|an|the|this|that)\\s+)?(?:\\w+\\s+){0,3}?${_ORDER_VERB.source}?`, 'i');
// Deliverable evidence: an explicit workspace path, the canvas, or an artifact noun.
const _TARGET_PATH_RE = /((?:notes|docs|data)\/[\w./-]+\.[a-z]{2,4})/i;
const _CANVAS_RE = /\bcanvas\b/i;
const _ARTIFACT_NOUN_RE = /\b(?:report|briefing|brief|dossier|roster|spreadsheet|sheet|list|summary|memo|write-?up|table|deck|doc(?:ument)?|note|csv|xlsx?|docx?|pdf|outline|digest|rundown|primer|recap|paper)\b/i;

/** detectDeliverableOrder(text) → { deliverable, target, topic } | null. Precision over recall:
 *  questions, status checks, and chatter never match; an order needs a lead AND evidence. */
function detectDeliverableOrder(text) {
  const s = str(text).trim();
  if (s.length < 12 || _QUESTION_RE.test(s)) return null;
  const hasLead = _ORDER_LEAD_RE.test(s) || _ORDER_WANT_RE.test(s);
  if (!hasLead) return null;
  const pathM = s.match(_TARGET_PATH_RE);
  const nounM = s.match(_ARTIFACT_NOUN_RE);
  const canvas = _CANVAS_RE.test(s);
  if (!pathM && !nounM && !canvas) return null;   // an imperative with no deliverable is not this net's business
  const deliverable = (nounM && nounM[0].toLowerCase()) || (pathM ? 'file' : 'canvas doc');
  const target = pathM ? pathM[1] : (canvas ? 'canvas' : null);
  // topic: the first order-bearing sentence, stripped of pleasantries — enough for the pursuit builder.
  const sent = (s.split(/(?<=[.!?])\s+|\n+/).find((x) => _ORDER_LEAD_RE.test(x) || _ORDER_WANT_RE.test(x)) || s);
  const topic = sent.replace(/^(?:ok(?:ay)?|alright|good|great|nice|perfect|yes|yeah|now|next|also|then|please|zoe)[,\s—–:;-]+/i, '')
    .replace(new RegExp(`^${_DEFERRAL}[,\\s—–-]+(?:but\\s+)?`, 'i'), '').trim().slice(0, 140);
  return { deliverable, target, topic };
}

// ── F27: the EDIT-shaped order (boot_p53 retest, promise#1753) ──────────────────────────────────────────
// "finish polishing the summary in notes/x.md — tighten the wording in place" was pursued as
// report-COMPOSE: a fresh report ABOUT the order text landed at a slug-named path, the target file
// went untouched, and the promise closed kept. An edit verb + an in-place/wording cue marks the
// order as MODIFY-THE-TARGET — the pursuit must take the read→edit→write-target path, never compose.
const _EDIT_VERB_RE = /\b(?:polish(?:ing)?|tighten(?:ing)?|revis(?:e|ing)|rework(?:ing)?|reword(?:ing)?|edit(?:ing)?|refin(?:e|ing)|smooth(?:ing)?|trim(?:ming)?|clean(?:ing)?\s*up|copy-?edit(?:ing)?|proofread(?:ing)?|update|updating)\b/i;
// F28: "…smooth the rough sentences right in the file" carried the in-place intent in a shape this
// net didn't know — "(right) in the/that file" and the sentence-noun family both mark MODIFY-THE-TARGET.
const _IN_PLACE_RE = /\bin\s+place\b|\bthe\s+(?:wording|phrasing|prose|language|copy|sentences?|paragraphs?)\b|\bexisting\s+(?:file|draft|doc(?:ument)?)\b|\bcurrent\s+draft\b|\bsame\s+file\b|\b(?:right\s+)?in\s+(?:the|that|this)\s+(?:file|doc(?:ument)?|draft|note)\b|\bdon'?t\s+(?:make|create|start)\s+a\s+new\b/i;
function detectEditIntent(text) {
  const t = str(text);
  if (!t.trim()) return false;
  return _EDIT_VERB_RE.test(t) && _IN_PLACE_RE.test(t);
}

// ── C2: the foreign-subject gate ─────────────────────────────────────────────────────────────────────────
const STATE_NAMES = ['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming'];
function statesIn(text) {
  // normalize punctuation to spaces and demand BOTH boundaries — "Indianapolis" must not match "indiana"
  const low = ' ' + str(text).toLowerCase().replace(/[^a-z]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
  return STATE_NAMES.filter((n) => low.includes(' ' + n + ' '));
}
// Proper-noun phrases: 2+ capitalized/numeric tokens in sequence ("Senate District 14",
// "Green South Foundation"). Sentence-initial single words never qualify on their own.
function _properPhrases(text) {
  const out = [];
  for (const m of str(text).matchAll(/\b[A-Z][\w'&.-]*(?:\s+(?:[A-Z][\w'&.-]*|\d+[\w-]*)){1,5}\b/g)) {
    const p = m[0].trim();
    if (p.split(/\s+/).length >= 2 && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 8);
}
const _PHRASE_TOKEN_STOP = new Set(['the', 'a', 'an', 'of', 'for', 'and']);

/** foreignSubject(userText, {goal, facet, orgs}) → { foreign, why } . Foreign when the turn names a
 *  STATE outside the run's scope, or when EVERY proper-noun anchor in the turn is absent from the
 *  run (phrase substring OR all-tokens fallback, so "Indiana Senate" matches a run on the "Indiana
 *  State Senate"). No anchors at all → not foreign (scope-talk like "just the top 5" passes). */
function foreignSubject(userText, { goal = '', facet = '', orgs = [] } = {}) {
  const runText = `${str(goal)} ${str(facet)} ${(Array.isArray(orgs) ? orgs : []).map(str).join(' ')}`.toLowerCase();
  if (!runText.trim()) return { foreign: false, why: 'no run scope to compare' };
  const ts = statesIn(userText);
  const missingStates = ts.filter((n) => !runText.includes(n));
  if (missingStates.length) return { foreign: true, why: `names ${missingStates.length > 1 ? 'states' : 'a state'} outside the run's scope (${missingStates.slice(0, 3).join(', ')})` };
  const phrases = _properPhrases(userText);
  if (!phrases.length) return { foreign: false, why: 'no distinct subject anchors (scope-talk)' };
  const matches = (p) => {
    const low = p.toLowerCase();
    if (runText.includes(low)) return true;
    const toks = low.split(/\s+/).filter((t) => !_PHRASE_TOKEN_STOP.has(t));
    return toks.length > 0 && toks.every((t) => runText.includes(t));
  };
  const foreignPhrases = phrases.filter((p) => !matches(p));
  if (foreignPhrases.length === phrases.length) {
    return { foreign: true, why: `its subject (${foreignPhrases.slice(0, 2).map((p) => `"${p}"`).join(', ')}) appears nowhere in the run's scope` };
  }
  return { foreign: false, why: 'shares subject anchors with the run' };
}

module.exports = { detectDeliverableOrder, detectEditIntent, foreignSubject, statesIn, _properPhrases, _ORDER_LEAD_RE, _TARGET_PATH_RE };
