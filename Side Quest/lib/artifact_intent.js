/*
 * lib/artifact_intent.js — ONE judgment for every artifact-shaped message. PURE parts.
 *
 * The flip, generalized (Lucas 2026-08-07: "why is there a regex?"): the three artifact doors
 * (canvas create/edit, report compose, product pull-up) each had their own detector deciding
 * routing before any model read the message — which is how "pullet the parish list" fell to a
 * handless replier. Here the MODEL reads the message once and routes it; the regexes hold only
 * two demoted duties: NOMINATE (a cheap vocabulary prefilter so ordinary chat never pays a
 * classifier call) and the cloud-down fallback (the legacy detectors keep the doors alive offline).
 *
 * A confident intent — including "none" — is FINAL. Only an infra failure (no classifier answer)
 * falls back to the legacy regex nets. That asymmetry is the whole point: judgment over matching.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// The union of the three doors' vocabularies + canvas itself. Deliberately BROAD — a false nominate
// costs one small classifier call; a false skip costs a missed artifact order. Word-bounded so
// ordinary verbs ("listen", "reportedly") don't nominate.
const NOMINATE = /\b(?:canvas|report|brief(?:ing)?|dossier|write-?ups?|summary|memo|profiles?|one-?pagers?|lists?|docs?|documents?|files?|notes?|tables?|spreadsheets?|rosters?|papers?|deliverables?|bullets?|bulleted)\b/i;

/** prefilter(text, {workingFresh}) — should this message pay for a judgment call? While a canvas
 * session is live, every message is a candidate (step-at-a-time edits rarely name nouns).
 * NO length gate (Lucas 2026-08-07: "what 400 char window?" — the artificial-caps disease, caught
 * same-day): a long, detailed order is when comprehension matters MOST; the vocabulary prefilter
 * bounds the classifier's cost, and the caller sizes the input slice to the model's window. */
function prefilter(text, { workingFresh = false } = {}) {
  const t = str(text).trim();
  if (!t) return false;
  if (workingFresh) return true;
  return NOMINATE.test(t);
}

/** wantText({workingFresh, workingTitle}) — the classifier contract. */
function wantText({ workingFresh = false, workingTitle = '' } = {}) {
  const editLine = workingFresh
    ? `- "canvas_edit": an instruction to modify/extend/reformat/continue the working canvas doc ("${str(workingTitle).slice(0, 60)}") — including anaphoric references ("the list", "it", "same document") and bare step orders.\n`
    : '';
  return `Lucas runs a research assistant whose artifacts land on a shared canvas and in files. Read his MESSAGE and route it. Typos are common — read intent, not spelling ("pullet the list" = "bullet the list"). Intents:\n`
    + editLine
    + `- "canvas_create": an order to put NEW content onto the canvas (a fresh doc/list/table).\n`
    + `- "report": an EXPLICIT ORDER to COMPOSE/WRITE a report-shaped DOCUMENT about a subject from held research ("write me a report on X", "put together a brief/dossier on Y"). A bare QUESTION asking for facts or a lookup ("what are X's recent bills?", "give me X's numbers", "who represents Y") is NOT a report — it is answered live; route it "none".\n`
    + `- "roster": an order to BUILD/COMPILE the roster of a US state's LOCAL governing bodies — its counties or (in Louisiana) PARISHES and their officials ("build the Louisiana parish roster", "compile a spreadsheet of Texas county commissioners"). The subject is the STATE.\n`
    + `- "pullup": a request to RETRIEVE/hand over a product that was ALREADY MADE ("that list we made", "pull up the …", "where's the … you built").\n`
    + `- "none": conversation, QUESTIONS / lookups asking for information or facts, research asks, anything else. When unsure, "none" — a wrong route is worse than the ordinary reply path.\n`
    + `Reply ONLY strict JSON: {"intent":"${(workingFresh ? ['canvas_edit'] : []).concat(['canvas_create', 'report', 'roster', 'pullup', 'none']).join('|')}","subject":"<for report/pullup/roster: the subject phrase (for roster: the state)>","instruction":"<for canvas_*: his instruction, normalized, typos corrected>"}.`;
}

const INTENTS = new Set(['canvas_edit', 'canvas_create', 'report', 'roster', 'pullup', 'none']);

// A bare QUESTION / lookup ask is NOT a report order (2026-08-18, the Cassidy false-non-delivery). Live:
// "What are Bill Cassidy's three most recent bills?" was judged "report" → buildReportFromHeld composed a
// hollow "the provided documents do not contain his legislative activity" from unrelated held docs, WHILE
// the operator had just web-excavated congress.gov and found S.5285 — she found it, then said she didn't
// have it. Per Lucas: ONLY an explicit compose-a-report order routes to the held-report door; a question is
// a lookup the operator answers LIVE (compose-from-held preempting live research is the same LPSC disease).
// The wantText prompt is sharpened to say this; demoteReport is the deterministic backstop. The lookup-vs-
// report-order line is partly SEMANTIC ("give me a summary of X" can be either), so the MODEL owns the
// residual; the backstop keys on the one thing a regex CAN read — does the message name a report DOCUMENT.
// Demoting to "none" is SAFE by design: "none" is the live operator/lookup path (researches + grounds),
// strictly better than a hollow held-report for anything that isn't a clear report-document order.
// Two adversarially-hardened rules (an earlier verb→noun-proximity cut both under-demoted "give me a
// summary of X" AND over-demoted verb-last "put together … into a report"):
//   1. an explicit COMPOSE VERB + a report noun (hard OR soft) = an order — keep, even if question-phrased
//      ("can you write me a report on X?");
//   2. else an interrogative lead with NO compose order = a lookup → "none"; a HARD report-document noun on
//      its own ("… into a report", "a Hartfield dossier — build it") = keep; anything else (bare facts,
//      "give me a summary/rundown of X" with a soft noun and no compose verb) = a lookup → "none".
const _Q_LEAD = /^\s*(?:what|what'?s|who|whom|whose|which|when|where|why|how|does|do|did|is|are|was|were|can|could|would|will|should|has|have|had)\b/i;
const _HARD_REPORT_NOUN = /\b(?:report|dossier|brief(?:ing)?|write-?up|memo|one-?pager|backgrounder|white\s?paper)\b/i;
const _SOFT_REPORT_NOUN = /\b(?:summary|rundown|overview|analysis|profile|breakdown|work-?up)\b/i;
// NB: "writ\w+" matches write/writing/writes but NOT "wrote" — deliberately, so "who WROTE the brief?" stays
// a lookup (Q_LEAD) rather than reading as a compose order. The list must be reasonably COMPLETE for common
// report verbs, since a question-phrased compose order whose verb is absent falls through to the Q_LEAD demote
// and loses its document (adversarial re-review: "can you summarize … into a report?").
const _REPORT_COMPOSE_VERB = /\b(?:writ\w+|compos\w+|build\w*|draft\w*|assembl\w+|generat\w+|prepar\w+|produc\w+|creat\w+|summariz\w+|recap\w*|compil\w+|put\s+together|pull\s+together|throw\s+together|knock\s+together|cobble\s+together|whip\s+up|flesh\s+out)\b/i;

/** demoteReport(intent, message) → the intent, with a spurious "report" on a lookup demoted to "none".
 * Only "report" is touched; every other intent passes through unchanged. Pure. */
function demoteReport(intent, message) {
  if (intent !== 'report') return intent;
  const s = str(message).trim();
  if (_REPORT_COMPOSE_VERB.test(s) && (_HARD_REPORT_NOUN.test(s) || _SOFT_REPORT_NOUN.test(s))) return 'report';  // explicit compose-a-report order (even if politely question-phrased)
  if (_Q_LEAD.test(s)) return 'none';                    // an interrogative with no compose order = a lookup
  if (_HARD_REPORT_NOUN.test(s)) return 'report';        // a verb-less report-document reference
  return 'none';                                          // bare facts / "give me a summary of X" = a lookup
}

/** validate(raw) → { valid, value:{intent, subject, instruction} } — strict-JSON gate for ask(). */
function validate(raw) {
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return { valid: false, error: 'no JSON object' };
    const o = JSON.parse(m[0]);
    if (!INTENTS.has(o.intent)) return { valid: false, error: `bad intent "${o.intent}"` };
    return { valid: true, value: { intent: o.intent, subject: str(o.subject).slice(0, 160), instruction: str(o.instruction).slice(0, 300) } };
  } catch (e) { return { valid: false, error: e.message }; }
}

module.exports = { prefilter, wantText, validate, demoteReport, NOMINATE, INTENTS };
