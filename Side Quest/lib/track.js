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
// Find/locate a deliverable: "can you find / pull up / where's / do you have the X research/dossier/notes".
const FIND_RE = /\b(?:find|pull up|bring up|locate|retrieve|open up|get me|show me|where(?:'?s| is| are)|do (?:you|we) have|have you got|got)\b[^?.!]{0,45}\b(?:research|dossier|notes?|write[\s-]?up|report|study|findings|deliverable|the\s+[\w-]+(?:\s+[\w-]+)?\s+(?:think tanks?|orgs?|organi[sz]ations?))\b/i;

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
  if (FIND_RE.test(s)) return { is: true, kind: 'find', scope: null };   // "find/pull up the X research" → locate the deliverable
  if (LIST_RE.test(s)) return { is: true, kind: 'list', scope: null };
  if (STATUS_RE.test(s)) return { is: true, kind: 'status', scope: null };
  return { is: false, kind: null, scope: null };
}

// --- helpers over the document ----------------------------------------------

function _norm(s) { return String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim(); }

// Generic org words that must NOT, alone, match a question to a section ("Institute", "Center"…).
const _GENERIC = new Set(['institute', 'center', 'centre', 'foundation', 'council', 'association', 'project', 'network', 'institution', 'org', 'organization', 'the', 'for', 'of', 'and', 'on', 'research', 'policy', 'american', 'america', 'national', 'global', 'group', 'fund', 'action', 'enterprise', 'alliance']);

// Acronyms for an org name: parenthetical "(MIRI)" + bare ALL-CAPS tokens, lowercased.
function _acronyms(name) {
  const out = [];
  const paren = String(name).match(/\(([A-Za-z]{2,6})\)/g);
  if (paren) for (const p of paren) out.push(p.replace(/[()]/g, '').toLowerCase());
  const caps = String(name).match(/\b[A-Z]{2,6}\b/g);
  if (caps) for (const c of caps) out.push(c.toLowerCase());
  return out;
}
// Distinctive (non-generic, >=4-char) name tokens — e.g. "machine", "intelligence", "cato", "heritage".
function _tokens(name) { return _norm(name).split(' ').filter(w => w.length >= 4 && !_GENERIC.has(w)); }

// Does `text` plausibly refer to org `name`? Full-name containment, OR a parenthetical / ALL-CAPS
// acronym appears as a standalone word (so "MIRI" matches "Machine Intelligence Research Institute
// (MIRI)" — the live bug), OR a distinctive (non-generic, >=4-char) token of the name appears.
function mentions(text, name) {
  const nt = _norm(text), nn = _norm(name);
  if (!nt || !nn) return false;
  if (nt.includes(nn) || nn.includes(nt)) return true;
  const words = new Set(nt.split(' '));
  for (const a of _acronyms(name)) if (words.has(a)) return true;
  for (const tok of _tokens(name)) if (words.has(tok)) return true;
  return false;
}

// Find the section the text refers to — by full name, acronym, or a distinctive token. Also matches an
// in-flight active target. `textOrTopic` may be the raw question or an extracted topic. Returns
// { heading, body, inFlight } or null.
function findSection(track, textOrTopic) {
  if (!textOrTopic) return null;
  for (const sec of (track.sections || [])) {
    if (mentions(textOrTopic, sec.heading)) return { heading: sec.heading, body: sec.body, inFlight: false };
  }
  if (track.target && track.target.name && mentions(textOrTopic, track.target.name)) {
    return { heading: track.target.name, body: track.target.rawExcerpt || '', inFlight: true };
  }
  return null;
}

// Pull a labelled facet line ("**Key people:**" / "**Contact:**") out of a section body.
function _facetLine(body, label) {
  const re = new RegExp(`^[-*\\s]*\\*\\*${label}[^:]*:\\*\\*\\s*([\\s\\S]*?)(?:\\n[-*]\\s*\\*\\*|\\n##|$)`, 'im');
  const m = re.exec(String(body || ''));
  return m ? m[1].trim().replace(/\s+/g, ' ') : '';
}

// Extract the named topic from an "about X" question, if any covered org / target is named in the text
// (by full name, acronym, or distinctive token). Grounded: only returns an org we actually hold.
function extractTopic(track, text) {
  const candidates = (track.sections || []).map(x => x.heading);
  if (track.target && track.target.name) candidates.push(track.target.name);
  let best = '';
  for (const c of candidates) if (mentions(text, c) && c.length > best.length) best = c;
  return best;
}

// --- the grounded answer block ----------------------------------------------

// The org list for count/list answers. Per design §2 the INDEX (covered) is the source of truth for
// the count — it can't be truncated and never lags the run; the parsed document sections are the
// fallback. (Using sections alone gave the live "5 vs 13" miss when the file read was capped.)
function _orgList(track) {
  const cov = Array.isArray(track.covered) ? track.covered.filter(Boolean) : [];
  const secs = (track.sections || []).map(s => s.heading);
  return cov.length >= secs.length ? cov : secs;
}

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
  if (q.kind === 'find') {
    // locate/confirm the deliverable: yes, it exists, here's the count + where to see it.
    const block = count
      ? `Yes — you DO have that research on file: ${count} organization${count === 1 ? '' : 's'} from ${where} (${orgs.join(', ')}).${liveTail}`
      : `You don't have that research on file yet — nothing's been gathered for it.${liveTail}`;
    return { handled: true, kind: 'find', block, note: `find=${count}` };
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
    // Match against the RAW question so an acronym / short name ("MIRI") finds its full-name section.
    const sec = findSection(track, text);
    if (sec && sec.body) {
      const tail = sec.inFlight ? `\n\n(This one is still in progress — that's what you have on it so far.)` : '';
      return { handled: true, kind: 'sample', block: `Here is exactly what you have on ${sec.heading} from ${where}:\n\n${sec.body}${tail}`, note: `sample:${sec.heading}` };
    }
    // "about X" where X isn't on file → honest, grounded in the index (don't invent).
    const topic = extractTopic(track, text);
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
  classifyQuery, findSection, extractTopic, mentions, buildAnswer,
  COUNT_RE, LIST_RE, STATUS_RE, ABOUT_RE
};
