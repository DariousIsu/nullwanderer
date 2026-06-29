/**
 * track — the DELIVERABLE-QUERY path: answer count / list / sample / status off a research Track's
 * own index + document, whether the run is ACTIVE or COMPLETE.
 *
 * The bug this fixes (docs/TRACKS_PRIORITY_DESIGN.md §1, §5, §11): the grounded answer path was
 * gated on an *active* focus, so the moment a run finished, "how many / what's the list / who leads X"
 * confabulated ("around 15" while 21 sat in focus.<id>.covered). And a question about a topic being
 * researched RIGHT NOW (the live MIRI disconnect) never reached the conversation. The answer must come
 * from the Track's artifact — the covered index + the stitched sections + any in-flight target — for
 * BOTH a live and a finished run.
 *
 * PURE module: it operates on a plain `track` object the caller (main.js) builds from meta + the run
 * file. No db, no I/O, no models. Fully offline-testable. Fail-safe: returns a value, never throws.
 *
 *   track = {
 *     kind:      'active' | 'complete' | 'none',
 *     goal:      string,
 *     covered:   [orgName, …],              // the index (source of truth for the count)
 *     sections:  [{ heading, body }, …],    // the document (stitched parts)
 *     target:    { name, rawExcerpt } | null,  // in-flight org (active runs only), not yet a section
 *     completed: 'done' | 'stalled' | null
 *   }
 */
'use strict';

// --- query classification ----------------------------------------------------

// Count: "how many / what number of …".
const COUNT_RE = /\bhow many\b|\bwhat(?:'?s| is)?\s+the\s+(?:count|number|total)\b|\bnumber of\b/i;
// List: "what's the list / name them / which ones / list them / what have you covered".
const LIST_RE = /\b(?:the |a )?list\b|\bname (?:them|the|all|each|every)\b|\bwhich (?:ones|organi[sz]ations|think tanks)\b|\blist (?:them|all|the|out)\b|\bwhat (?:have you|did you|all)\b[^?.!]{0,30}\b(?:cover|done|found|research)/i;
// Status: "how's it going / progress / update / so far / where are you".
const STATUS_RE = /\bhow(?:'?s| is| are| has| have)?\b[^?.!]{0,45}\b(?:go(?:ing|ne)|coming|progress(?:ing)?|along|far)\b|\b(?:status|progress|update so far|fill me in|catch me up|where (?:are|r) (?:you|we|u))\b/i;
// Sample/about a named thing: "what do you have on X / who leads X / tell me about X / contacts for X".
const ABOUT_RE = /\b(?:what (?:do|did) you (?:have|find|get)\s+(?:on|about|for)|tell me about|who(?:'?s| is| are|'?re| leads| runs| heads)\b[^?.!]{0,30}|who(?:'?s| is)?\s+the\s+(?:head|director|president|ceo|chair|leadership)\b[^?.!]{0,30}(?:of|for|at)|leadership (?:of|for|at)|contacts? (?:for|at|of)|details (?:on|for|about))\b/i;
// "for each / for all / across all 21" → an all-entries facet sweep over the document.
const EACH_RE = /\b(?:for |of |across )?(?:each|every|all)\b|\ball (?:of )?(?:them|these|the\s+\d+)\b/i;
// Facet words used to narrow an all-entries sweep (leadership / contacts).
const PEOPLE_FACET_RE = /\b(?:head|heads|leader|leadership|director|president|ceo|chair|staff|people|policy|who(?:'?s| is| runs| leads| heads))\b/i;
const CONTACT_FACET_RE = /\b(?:contacts?|emails?|e-mail|phones?|address(?:es)?|reach|websites?)\b/i;

// Classify a turn as a deliverable query (and which kind). Order matters: a specific "about X" /
// "for each" beats a generic list/count. Returns { is, kind, scope }.
//   kind: 'count' | 'list' | 'sample' | 'facet' | 'status'
//   scope: for 'facet' — 'people' | 'contact' | 'any'
function classifyQuery(text) {
  const s = String(text || '');
  if (!s.trim()) return { is: false, kind: null, scope: null };
  const each = EACH_RE.test(s);
  const aboutish = ABOUT_RE.test(s) || PEOPLE_FACET_RE.test(s) || CONTACT_FACET_RE.test(s);
  // "head of policy for EACH / leadership of all the orgs" → sweep a facet across every section.
  if (each && aboutish) {
    const scope = CONTACT_FACET_RE.test(s) ? 'contact' : PEOPLE_FACET_RE.test(s) ? 'people' : 'any';
    return { is: true, kind: 'facet', scope };
  }
  if (ABOUT_RE.test(s)) return { is: true, kind: 'sample', scope: null };
  if (COUNT_RE.test(s)) return { is: true, kind: 'count', scope: null };
  if (LIST_RE.test(s)) return { is: true, kind: 'list', scope: null };
  if (STATUS_RE.test(s)) return { is: true, kind: 'status', scope: null };
  return { is: false, kind: null, scope: null };
}

// --- helpers over the document ----------------------------------------------

function _norm(s) { return String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

// Find the section whose heading best matches a named topic (tolerant containment). Also matches an
// in-flight active target. Returns { heading, body, inFlight } or null.
function findSection(track, topic) {
  const t = _norm(topic);
  if (!t) return null;
  for (const sec of (track.sections || [])) {
    const h = _norm(sec.heading);
    if (h && (h === t || h.includes(t) || t.includes(h))) return { heading: sec.heading, body: sec.body, inFlight: false };
  }
  if (track.target && track.target.name) {
    const tn = _norm(track.target.name);
    if (tn && (tn === t || tn.includes(t) || t.includes(tn))) {
      return { heading: track.target.name, body: track.target.rawExcerpt || '', inFlight: true };
    }
  }
  return null;
}

// Pull a labelled facet line ("**Key people:**" / "**Contact:**") out of a section body.
function _facetLine(body, label) {
  const re = new RegExp(`^[-*\\s]*\\*\\*${label}[^:]*:\\*\\*\\s*([\\s\\S]*?)(?:\\n[-*]\\s*\\*\\*|\\n##|$)`, 'im');
  const m = re.exec(String(body || ''));
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

// Extract the named topic from an "about X" question, if any covered org / target is named in the text.
// Grounded: only returns a topic we actually hold (so we never claim to "have" something we don't).
function extractTopic(track, text) {
  const s = String(text || '');
  const candidates = (track.sections || []).map(x => x.heading);
  if (track.target && track.target.name) candidates.push(track.target.name);
  let best = '';
  for (const c of candidates) {
    const n = _norm(c);
    if (n && _norm(s).includes(n) && c.length > best.length) best = c;
  }
  return best;
}

// --- the grounded answer block ----------------------------------------------

function _orgList(track) { return (track.sections || []).map(s => s.heading); }

// Build the deterministic grounded fact block the chat path injects (Dans then relays it in his
// voice). Returns { handled, kind, block, note } — `block` is null when nothing can be grounded.
function buildAnswer(track, text) {
  if (!track || track.kind === 'none') return { handled: false, kind: null, block: null, note: 'no track' };
  const q = classifyQuery(text);
  if (!q.is) return { handled: false, kind: null, block: null, note: 'not a deliverable query' };
  const orgs = _orgList(track);
  const count = orgs.length;
  const liveTail = track.kind === 'active'
    ? (track.target && track.target.name ? ` The run is still going — currently on ${track.target.name}.` : ' The run is still going.')
    : '';
  const where = track.kind === 'active' ? 'your in-progress research' : 'your completed research';

  if (q.kind === 'count') {
    const block = `You have ${count} organization${count === 1 ? '' : 's'} on file from ${where}: ${orgs.join(', ') || '(none yet)'}.${liveTail}`;
    return { handled: true, kind: 'count', block, note: `count=${count}` };
  }
  if (q.kind === 'list') {
    const block = count
      ? `The full list from ${where} is ${count} organization${count === 1 ? '' : 's'}: ${orgs.join(', ')}.${liveTail}`
      : `You haven't completed any organizations yet.${liveTail}`;
    return { handled: true, kind: 'list', block, note: `list=${count}` };
  }
  if (q.kind === 'facet') {
    const label = q.scope === 'contact' ? 'Contact' : 'Key people';
    const rows = (track.sections || []).map(s => {
      const v = _facetLine(s.body, label) || 'not found';
      return `- ${s.heading}: ${v}`;
    });
    const block = rows.length
      ? `${label} across all ${count} organization${count === 1 ? '' : 's'} from ${where}:\n${rows.join('\n')}${liveTail}`
      : `No organizations on file yet.${liveTail}`;
    return { handled: true, kind: 'facet', block, note: `facet:${q.scope}=${rows.length}` };
  }
  if (q.kind === 'sample') {
    const topic = extractTopic(track, text);
    if (topic) {
      const sec = findSection(track, topic);
      if (sec && sec.body) {
        const tail = sec.inFlight ? `\n\n(This one is still in progress — that's what you have on it so far.)` : '';
        return { handled: true, kind: 'sample', block: `Here is exactly what you have on ${sec.heading} from ${where}:\n\n${sec.body}${tail}`, note: `sample:${sec.heading}` };
      }
    }
    // "about X" where X isn't on file → honest, grounded in the index (don't invent).
    const block = `You don't have ${topic || 'that'} on file from ${where}. What you do have (${count}): ${orgs.join(', ') || 'nothing yet'}.${liveTail}`;
    return { handled: true, kind: 'sample', block, note: 'sample:not-found' };
  }
  // status → a deterministic list line; main.js enriches it with the frontier statusReport narrative.
  const block = count
    ? `So far you have ${count} organization${count === 1 ? '' : 's'}: ${orgs.join(', ')}.${liveTail}`
    : `Nothing completed yet — still getting going.${liveTail}`;
  return { handled: true, kind: 'status', block, note: `status=${count}` };
}

module.exports = {
  classifyQuery, findSection, extractTopic, buildAnswer,
  COUNT_RE, LIST_RE, STATUS_RE, ABOUT_RE
};
