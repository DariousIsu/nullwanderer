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
    + `- "report": an order to COMPOSE/BUILD a report-shaped artifact about a subject from held research.\n`
    + `- "roster": an order to BUILD/COMPILE the roster of a US state's LOCAL governing bodies — its counties or (in Louisiana) PARISHES and their officials ("build the Louisiana parish roster", "compile a spreadsheet of Texas county commissioners"). The subject is the STATE.\n`
    + `- "pullup": a request to RETRIEVE/hand over a product that was ALREADY MADE ("that list we made", "pull up the …", "where's the … you built").\n`
    + `- "none": conversation, questions about content, research asks, anything else. When unsure, "none" — a wrong route is worse than the ordinary reply path.\n`
    + `Reply ONLY strict JSON: {"intent":"${(workingFresh ? ['canvas_edit'] : []).concat(['canvas_create', 'report', 'roster', 'pullup', 'none']).join('|')}","subject":"<for report/pullup/roster: the subject phrase (for roster: the state)>","instruction":"<for canvas_*: his instruction, normalized, typos corrected>"}.`;
}

const INTENTS = new Set(['canvas_edit', 'canvas_create', 'report', 'roster', 'pullup', 'none']);

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

module.exports = { prefilter, wantText, validate, NOMINATE, INTENTS };
