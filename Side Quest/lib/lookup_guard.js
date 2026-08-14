/**
 * lib/lookup_guard.js — the LAST DOOR before an auto-derived query reaches a real search engine.
 *
 * Two defects, one live class (2026-08-14, the post-compact queue's #4 — "search history is a
 * conviction record"): every query Bing receives is a permanent external record of what she was
 * "thinking", and two junk families were getting through the auto-nets in main.js:
 *
 *  (1) LOCAL-ACTION promises. Her say announces work on HER OWN surfaces — "I'm pulling the
 *      Hartfield report from our store", "checking the roster we built", "pulling doc #15817
 *      back up" — and the promised-lookup net (keyed on the PROMISE shape, blind to the OBJECT)
 *      ran it as a LIVE WEB search. Wrong surface: the material is already held. The report-cmd
 *      net (main.js ~11028) already caught explicit report ORDERS for this reason; this veto
 *      covers her spontaneous promises. localAction() reads the RETRIEVAL CLAUSE — the verb and
 *      what follows it within the same breath — so "pulling current Treasury yields ... and
 *      adding them to your canvas" still searches (the retrieval object is the web's).
 *
 *  (2) INCOHERENT queries. Garbled STT (always-on mic) and self-echo fragments (her own contract
 *      brackets, stutter repetition) reached the engine verbatim. queryFloor() is a cheap
 *      deterministic floor: word-shaped tokens, vowels, uniqueness, no [contract] markup. It
 *      sits at the ONE funnel every auto-net passes through (liveLookupAndAnswer), never on
 *      deliberate tool use (operator web_search, directed research keep their own judgment).
 *
 * Pure + dependency-free; both functions never throw.
 */
'use strict';

// Surfaces that are HERS: bare product nouns (canvas, roster, CRM, a doc coordinate) plus
// possessive-anchored generics ("our store", "my notes" — but never a bare "files"/"notes",
// which would swallow legitimate web objects like "court files").
const LOCAL_NOUN = '(?:canvas|roster|crm|vault|archive|desktop|doc\\s*#?\\d+' +
  '|(?:y?our|my|the)\\s+(?:contact\\s+list|store|vault|archive|notes?|files?|database|db|memory|records?|docs?|documents?|spreadsheets?)' +
  '|held\\s+(?:research|docs?|documents?)' +
  '|what\\s+(?:we|i)\\s+(?:have|hold|collected|gathered))';
const RETRIEVE_VERB = '(?:pull(?:ing)?|fetch(?:ing)?|grab(?:bing)?|retriev(?:e|ing)' +
  '|check(?:ing)?|look(?:ing)?\\s+(?:up|into|at|through)|go(?:ing)?\\s+through' +
  '|review(?:ing)?|open(?:ing)?|re-?read(?:ing)?|dig(?:ging)?\\s+(?:up|into|through))';
// verb → local noun inside one clause (no sentence break, bounded gap = the same breath)
const LOCAL_ACTION_RE = new RegExp('\\b' + RETRIEVE_VERB + '\\b[^.?!\\n]{0,48}?\\b' + LOCAL_NOUN + '\\b', 'i');
// "…from our store / from the vault / from the canvas" — the source names a held surface
const FROM_LOCAL_RE = new RegExp('\\bfrom\\s+(?:the\\s+|y?our\\s+|my\\s+)?' + LOCAL_NOUN + '\\b', 'i');

/** Is the announced action LOCAL (her own stores/surfaces), i.e. NOT a web retrieval?
 *  Returns { local:true, via } or null. */
function localAction(say) {
  const s = String(say || '');
  if (!s) return null;
  if (FROM_LOCAL_RE.test(s)) return { local: true, via: 'from-local-surface' };
  if (LOCAL_ACTION_RE.test(s)) return { local: true, via: 'retrieve-local-surface' };
  return null;
}

// Coherence floor. Deliberately loose — it exists to stop GARBLE and MARKUP, not to grade
// query quality; a false REJECT silences a legit lookup, so every check errs permissive.
const MIN_LEN = 8;
function queryFloor(q) {
  const s = String(q || '').trim();
  if (!s) return { ok: false, why: 'empty' };
  // Contract/markup fragments — her own instruction brackets or HTML/template debris must
  // never be searched (the self-echo family: "[You just looked up…]").
  if (/[\[\]{}<>]/.test(s)) return { ok: false, why: 'contract/markup fragment' };
  const compact = s.replace(/\s+/g, '');
  const letters = (compact.match(/[a-z]/gi) || []).length;
  if (letters / compact.length < 0.5) return { ok: false, why: 'mostly non-letters' };
  const toks = s.toLowerCase().split(/\s+/).filter((t) => /[a-z]/i.test(t));
  if (toks.length === 0) return { ok: false, why: 'no word tokens' };
  if (toks.length === 1) {
    // A single real word ("Bessent") is a legit lookup — the length floor below doesn't apply,
    // a name can be short. A single vowel-less blurt is not.
    return (toks[0].length >= 4 && /[aeiouy]/i.test(toks[0]))
      ? { ok: true } : { ok: false, why: 'single non-word token' };
  }
  if (s.length < MIN_LEN) return { ok: false, why: 'too short' };
  // Vowel-less tokens are STT garble ("krz bff mmm"); tolerate up to 40% for acronyms (GDP, NYPD).
  const wordish = toks.filter((t) => /[aeiouy]/i.test(t) || /\d/.test(t));
  if (wordish.length / toks.length < 0.6) return { ok: false, why: 'vowel-less garble' };
  // Stutter repetition ("the the the the") — mostly the same token over and over.
  if (toks.length >= 4 && new Set(toks).size / toks.length < 0.5) return { ok: false, why: 'stutter repetition' };
  return { ok: true };
}

module.exports = { localAction, queryFloor, LOCAL_ACTION_RE, FROM_LOCAL_RE };
