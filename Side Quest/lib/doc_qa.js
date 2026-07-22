/**
 * doc_qa — answer a question / extraction request AGAINST a document Lucas already handed Zoe (a file he
 * dropped on the canvas, just ingested via lib/canvas_ingest). The completion of canvas-ingest: not just
 * "know a doc exists" but "pull my responsibilities out of the meeting notes" → READ that doc and extract.
 *
 * The live miss this fixes: "Can you pull my responsibilities out of the meeting notes?" went to the
 * INTAKE GATE, which classified it as a sustained research PROJECT and spun a database-search run —
 * instead of just reading the notes she'd ingested. Two faults: intake over-classified a doc-extraction
 * as a project, AND nothing routed the question to the document she holds.
 *
 * PURE module: the detector (carefully separating "extract FROM the notes" from "I pulled the notes INTO
 * the canvas"), the relevant-doc picker, and the grounded extraction prompt. The canvas read + cloud call
 * live in main.js. Fail-safe: never throws on bad input.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// A reference to a document she HOLDS (the notes / this doc / the meeting / what I dropped / the canvas).
const DOC_REF_RE = /\b(meeting notes|the notes|these notes|those notes|the transcript|this (?:document|doc|file|transcript|page|memo|note)|the (?:document|doc|transcript|memo|minutes|huddle|meeting)|what i (?:just )?(?:dropped|gave|sent|shared|handed|pulled in|added)|on the canvas|the canvas|the (?:file|doc) i)\b/i;

// An extraction / question intent (pull, list, summarize, what/who, find, my action items…).
const EXTRACT_VERB_RE = /\b(pull|extract|list|summari[sz]e|give me|show me|tell me|find|get|grab|identify|highlight|recap|what(?:'s| are| were| is|'re)?|who(?:'s| are| is)?|which|how many|my (?:responsibilities|tasks|action items|to-?dos|assignments|takeaways))\b/i;

// The user PROVIDING the doc ("I pulled the notes INTO the canvas", "here are the notes", "I dropped the
// file") — the inverse direction. Must NOT be read as an extraction request.
const PROVIDE_NEG_RE = /\b(?:pulled|put|dropped|added|loaded|uploaded|attached|placed|moved|brought|threw)\b[^.?!]{0,30}\b(?:into|onto|in|on|to|up (?:on|in))\b[^.?!]{0,20}\b(?:the )?(?:canvas|workspace|screen)\b|\b(?:here(?:'s| are| is)|i (?:gave|sent|shared|added|dropped|uploaded|attached|pulled in))\b[^.?!]{0,25}\b(?:notes|doc|document|file|transcript)\b/i;

// Is this a request to EXTRACT FROM / ASK ABOUT a document she already holds?
function isDocQuery(message) {
  const s = str(message).trim();
  if (s.length < 6) return false;
  if (PROVIDE_NEG_RE.test(s)) return false;          // user is GIVING the doc, not asking about it
  if (!DOC_REF_RE.test(s)) return false;             // must reference a document she holds
  return EXTRACT_VERB_RE.test(s) || /\?\s*$/.test(s);  // an extraction verb, or a question
}

// Her READINGS referenced DECLARATIVELY — "you read something about X", "that paper you read",
// "what have you been reading" (memory slice 1 #6). These point at what SHE read (a stored doc from
// any lane: canvas drops, research dossiers, autonomy artifacts, API landings), not a doc Lucas
// handed her — DOC_REF_RE never matches them, so the detector-matches-the-imperative miss class
// applied here too. Bare "you read X" is NOT enough ("you read my mind"): the forms require an
// about-phrase, a reading-noun, or the interrogative.
const READING_REF_RE = /\b(?:you read (?:something|about)|you (?:were|just) reading|what (?:did|have) you (?:been )?read(?:ing)?|(?:that|the) (?:article|paper|piece|story|report|study|memo|doc(?:ument)?) you (?:read|found|mentioned|were reading|looked at|came across)|something you (?:read|were reading))\b/i;

function isReadingQuery(message) {
  const s = str(message).trim();
  if (s.length < 6) return false;
  if (PROVIDE_NEG_RE.test(s)) return false;
  return READING_REF_RE.test(s);
}

// Content terms worth searching the stored docs for on a reading query — the message minus the
// reading-reference scaffolding, longest (most specific) first.
function readingSearchTerms(message, { max = 3 } = {}) {
  return _terms(message)
    .filter((w) => !/^(?:read|reading|article|paper|piece|story|report|study|memo)$/.test(w))
    .sort((a, b) => b.length - a.length).slice(0, max);
}

// --- pick which held document the question is about -------------------------------------------------

const STOP = new Set('the a an of for from out my your his her our their about in on to and or with this that these those what who which how many me you give show tell list pull extract summarize summarise find get grab notes note document doc file meeting transcript canvas responsibilities tasks please can could'.split(/\s+/));
function _terms(s) {
  return str(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}

// Choose the most relevant held doc for the message. docs = [{title, markdown, openedAt}]. Scores title
// overlap with the message's content words; ties (or no hint) → the most recently opened. Returns the doc
// or null.
function pickRelevantDoc(message, docs = []) {
  const list = (Array.isArray(docs) ? docs : []).filter(d => d && str(d.markdown).trim());
  if (!list.length) return null;
  const want = new Set(_terms(message));
  let best = null, bestScore = -1, bestOpened = -1;
  for (const d of list) {
    const hay = new Set(_terms(`${str(d.title)} ${str(d.markdown).slice(0, 400)}`));
    let score = 0;
    for (const w of want) if (hay.has(w)) score++;
    const opened = Number(d.openedAt) || 0;
    if (score > bestScore || (score === bestScore && opened > bestOpened)) { best = d; bestScore = score; bestOpened = opened; }
  }
  return best;
}

// --- grounded extraction prompt --------------------------------------------------------------------

// Answer the user's question using ONLY the document — never invent, say so if it isn't there.
function buildExtractPrompt({ question = '', docTitle = '', docText = '' } = {}) {
  return [
    { role: 'system', content: `You answer Lucas's question using ONLY the document provided below — a document HE gave you. Rules:\n• Ground EVERY item strictly in the document — never invent, infer beyond it, or pull from outside knowledge.\n• If the document does not contain the answer, say so plainly (don't pad or guess).\n• When the question asks for items assigned to a person (their responsibilities / action items / tasks), include EXACTLY those attributed to that person — not everyone's.\n• Be concise and cleanly formatted (a short list or a few sentences). No preamble, no "here is".` },
    { role: 'user', content: `QUESTION: ${str(question)}\n\nDOCUMENT${docTitle ? ` — "${str(docTitle)}"` : ''}:\n"""\n${str(docText).slice(0, 60000)}\n"""\n\nAnswer the question now, grounded only in the document.` }
  ];
}

module.exports = {
  DOC_REF_RE, EXTRACT_VERB_RE, PROVIDE_NEG_RE, READING_REF_RE,
  isDocQuery, isReadingQuery, readingSearchTerms, pickRelevantDoc, buildExtractPrompt,
};
