'use strict';
/**
 * lib/roster_intake.js — recognize a chat ask to "find contact info / emails for THESE people" (a NAMED
 * list, not a CRM category) and parse the prose into per-person rows for a canvas roster table. PURE (no
 * I/O, no clock, no db) so it is offline-smoke-testable; the dispatch in main.js does the canvas write +
 * seeds the background list-completion focus.
 *
 * WHY (2026-08-04 audit — the "no canvas reaction" hallucination): a plain-chat
 *   "Can you find me contact information for the following people please. Just email is great
 *    Melissa Gage, SWEPCO's Vice President… / LPSC Executive Secretary Brandon Frey / …"
 * was mishandled two ways. (1) The cloud operator's FIRST move was a verbatim web_search of the WHOLE
 * prose, which lost the names ("me contact information for the following people please"). (2) It then
 * PROMISED a canvas fill ("I'll put them on your Canvas as I verify each one") that never ran — a placebo
 * net turned the promise text into a hollow "promise-*" tab. No per-person lookup ever executed.
 *
 * This parser is the front half of the REAL lane: prose people → {name, org, surname} rows → a canvas
 * TABLE that lib/list_complete (runListCompletionPass) fills grounded, cite-or-leave-blank, one row per
 * pass, in the background. See [[list-completion-lane]], [[detectors-vs-comprehension]].
 */

// Title/role/acronym tokens that can LEAD a "TITLE… Name" entry (e.g. "LPSC Executive Secretary Brandon
// Frey"). Used ONLY to strip a leading run before the person's name — we stop at the first non-title token,
// so a given name is never stripped. Lowercased, punctuation removed, before lookup.
const _TITLE_LEAD = new Set([
  'executive', 'secretary', 'commissioner', 'director', 'deputy', 'assistant', 'vice', 'president',
  'chair', 'chairman', 'chairwoman', 'chairperson', 'mayor', 'manager', 'officer', 'chief', 'senior',
  'junior', 'board', 'council', 'councilmember', 'councilman', 'councilwoman', 'member', 'commission',
  'representative', 'rep', 'senator', 'sen', 'governor', 'gov', 'judge', 'clerk', 'treasurer', 'sheriff',
  'superintendent', 'coordinator', 'administrator', 'head', 'lead', 'principal', 'associate', 'regional',
  'state', 'county', 'parish', 'city', 'the', 'of', 'for', 'and', 'dr', 'mr', 'ms', 'mrs', 'hon',
]);

const _NAME_SUFFIX = /^(jr|sr|ii|iii|iv|v|phd|md|esq)\.?$/i;

// Verb/phrase cues that mark a line as the INSTRUCTION ("Can you find me contact info for the following…")
// rather than a person entry. Kept broad on purpose — a false positive only drops one person line, and the
// real people lines below carry none of these.
const _INSTRUCTION_RE = /\b(find|get|look\s?up|pull|need|give\s+me|send\s+me|put\s+(it|them|these|that)|fill\s+(in|out)|can\s+you|could\s+you|would\s+you|i\s+want|i\s+need|please\s+provide|here\s+(are|is)|the\s+following|following\s+(people|list|names|contacts|individuals)|contact\s+info(?:rmation)?\s+for|just\s+(the\s+)?email|emails?\s+(are|is)\s+(great|fine|enough|ok|okay|good)|audit\s+it|as\s+you\s+go)\b/i;

function _clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

function _isTitleLead(tok) {
  const w = tok.replace(/[.,]/g, '').toLowerCase();
  if (!w) return true;
  if (_TITLE_LEAD.has(w)) return true;
  if (/^[A-Z]{2,}('?s)?$/.test(tok.replace(/[.,]/g, ''))) return true; // acronym: LPSC, SWEPCO, LSU, NRECA
  return false;
}

// Last alphabetic token of a name, skipping honorific suffixes (Jr., III). '' when none found.
function surnameOf(name) {
  const toks = _clean(name).split(/\s+/).filter(Boolean);
  for (let i = toks.length - 1; i >= 0; i--) {
    if (_NAME_SUFFIX.test(toks[i])) continue;
    const t = toks[i].replace(/[^A-Za-z'-]/g, '');
    if (t) return t;
  }
  return '';
}

// A head string that plausibly IS a person name (≤5 tokens, first token capitalized and not a title word).
function _looksLikeName(str) {
  const toks = _clean(str).split(/\s+/).filter(Boolean);
  if (!toks.length || toks.length > 5) return false;
  if (_isTitleLead(toks[0])) return false;
  return /^[A-Z]/.test(toks[0]);
}

// One roster line → {name, org, surname} or null. Two shapes: "Name, Title/Org…" (comma/dash split, name
// first) and "TITLE… Name" (leading title run stripped). Never throws.
function parsePerson(line) {
  let s = _clean(line);
  if (!s) return null;
  s = s.replace(/^[-*••\d.)\]\s]+/, '').trim(); // strip list bullets / numbering

  let name = '', org = '';
  // Separator forms: ", "  |  " – "/" — " (en/em dash w/ spaces)  |  "name- title" / " - " (hyphen + space).
  const m = s.match(/^(.*?)(?:\s*,\s*|\s+[–—]\s+|\s*-\s+)(.*)$/);
  if (m && _looksLikeName(m[1])) {
    name = _clean(m[1]);
    org = _clean(m[2]);
  } else {
    // Title-first: strip a leading run of title/acronym tokens; stop at the first real name token. Keep at
    // least the last token as the name so a line of pure titles still yields something.
    const toks = s.split(/\s+/);
    let i = 0;
    while (i < toks.length - 1 && _isTitleLead(toks[i])) i++;
    name = _clean(toks.slice(i).join(' '));
    org = _clean(toks.slice(0, i).join(' '));
  }
  if (!name) return null;
  const surname = surnameOf(name);
  return { name, org, surname };
}

function _isInstructionLine(line) {
  const l = _clean(line);
  if (!l) return true;
  return _INSTRUCTION_RE.test(l);
}

/**
 * parseRosterAsk(text) → { ok, people:[{name,org,surname}], title } | { ok:false }.
 * Conservative: requires a contacts/email intent AND ≥2 parseable people (≥3 when there is no explicit
 * "following/these/list" cue, so an ordinary two-name sentence doesn't get hijacked).
 */
function parseRosterAsk(text) {
  const raw = String(text == null ? '' : text);
  const lower = raw.toLowerCase();

  const wantsContacts = /\b(e-?mails?|contact\s+info(?:rmation)?|contact\s+details?|contact\s+information|reach\s+(?:them|these)|their\s+contacts?)\b/.test(lower);
  if (!wantsContacts) return { ok: false };

  const listCue = /\b(following|these|below|this\s+list|the\s+list|each\s+of|list\s+of|people\s+please)\b/.test(lower)
    || (raw.split(/\r?\n/).filter((l) => l.trim()).length >= 3); // a multiline paste is itself a list cue

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const people = [];
  for (const ln of lines) {
    if (_isInstructionLine(ln)) continue;
    const p = parsePerson(ln);
    if (p && p.name && surnameOf(p.name).length >= 2) people.push(p);
  }

  // Dedupe by lowercased name.
  const seen = new Set();
  const uniq = [];
  for (const p of people) {
    const k = p.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
  }

  if (uniq.length < 2) return { ok: false };
  if (!listCue && uniq.length < 3) return { ok: false };

  return { ok: true, people: uniq, title: `Requested contact emails (${uniq.length} people)` };
}

function isRosterAsk(text) { return parseRosterAsk(text).ok; }

module.exports = { parseRosterAsk, isRosterAsk, parsePerson, surnameOf, _isInstructionLine, _looksLikeName };
