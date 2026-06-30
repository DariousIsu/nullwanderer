/**
 * lib/records_interp.js — the INWARD fallback: when a question is about our OWN held research but
 * matches none of the fixed deliverable intents (count/list/sample/facet/status/find/rank), a cloud
 * model READS the actual records and answers from them — instead of falling through to the operator,
 * whose default is to go search the WEB (the live miss: "which do we have the most complete record on"
 * → "let me search relevant directories"). The brittle regex menu stays the fast path for clean shapes;
 * this is the smart fallback so a novel phrasing gets read-and-answered, not pattern-missed.
 *
 * PURE: a detector + a prompt builder. The cloud call + the records live in main.js. Records are
 * annotated with their measured completeness (lib/record_completeness) so evaluative questions
 * ("most complete", "best coverage", "where are the gaps") are answered from a real measure.
 */
'use strict';

// References to US / our data.
const OURS_RE = /\b(we|our|ours|us|you|your)\b/i;
// Nouns that denote STORED research (inherently about our held data).
const HELD_RE = /\b(research|dossier|records?|coverage|profiles?|on file|gathered|collected|compiled|database|deliverable|our (?:data|notes|files|list)|the dossier|what (?:we|you) (?:have|know|found|got))\b/i;
// Evaluative framing that a fixed count/list intent can't capture.
const EVAL_RE = /\b(most|best|top|deepest|richest|complete(?:ness)?|thorough(?:ly)?|strongest|weakest|thin(?:nest)?|spars(?:e|est)|gaps?|missing|incomplete|compare|comparison|versus|\bvs\b|rank|ranked|which (?:one|org|of|is|has|have)|how (?:complete|thorough|much|good|well))\b/i;

// Is this plausibly a question about our OWN held research that the fixed intents miss? Conservative:
// a stored-research noun, OR (a reference to us/our + an evaluative framing). Caller still gates on a
// resolved Track with records — so a general question with no matching research can't hijack the turn.
function isRecordsQuestion(text) {
  const s = String(text || '');
  if (s.trim().length < 8) return false;
  if (HELD_RE.test(s)) return true;
  if (OURS_RE.test(s) && EVAL_RE.test(s)) return true;
  return false;
}

const _clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) : t; };

// Build the cloud prompt: the records (annotated with their measured completeness) + the question, with
// a hard grounding contract — answer ONLY from these records, say plainly when they don't contain it,
// never invent, never suggest a web search.
function buildRecordsPrompt({ question = '', goal = '', sections = [], maxChars = 12000 } = {}) {
  const rc = require('./record_completeness');
  const list = Array.isArray(sections) ? sections : [];
  let body = '';
  for (const s of list) {
    const sc = rc.scoreSection(s);
    const seg = `## ${sc.heading}  [${sc.dataPoints} data points, ${sc.notFound} not-found]\n${String((s && s.body) || '').trim()}\n\n`;
    if (body.length + seg.length > maxChars) { body += '…(remaining records omitted for length)\n'; break; }
    body += seg;
  }
  return [
    {
      role: 'system',
      content: `You answer ONLY from the research records below — records WE already hold. Rules:\n• Ground every word in these records. If they do not contain the answer, say plainly "our records don't cover that" — do NOT invent, and do NOT suggest searching the web or "looking it up".\n• Each record is annotated [data points, not-found] — a real measure of how COMPLETE it is. Use it directly for "most complete / best coverage / where are the gaps / compare" questions; more data points + fewer not-found = more complete.\n• Be concise and specific — name the actual records. No preamble.`
    },
    {
      role: 'user',
      content: `OUR RESEARCH${goal ? ` (task: ${_clip(goal, 140)})` : ''} — ${list.length} record${list.length === 1 ? '' : 's'}:\n\n${body}\nQUESTION: ${_clip(question, 400)}\n\nAnswer from the records above.`
    }
  ];
}

module.exports = { isRecordsQuestion, buildRecordsPrompt, OURS_RE, HELD_RE, EVAL_RE };
