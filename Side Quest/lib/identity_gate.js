'use strict';
/**
 * lib/identity_gate.js — F1 "identity trust": the mint-reluctance + contextual-identity + attractor-guard
 * gate that sits between mention-resolution and entity-MINTING.
 *
 * THE FIX for the "Tracy the finance lady" class: a WEAK person reference (a bare first name, or a first
 * name + a descriptor, carrying no strong id) must NEVER mint a durable entity — because that spurious node
 * then becomes the ATTRACTOR that every future bare "Tracy" binds to. Instead a weak reference either binds
 * to an existing person via CONTEXT (meeting attendees / co-present roles) or is HELD provisional until it
 * earns enough identity (a full name, an email, repeated grounded context) to mint.
 *
 * Three mechanisms:
 *   1. referenceStrength() — how much IDENTITY a mention carries. Only a STRONG ref may mint a person.
 *   2. contextualMatch()   — bind a weak ref to a context person sharing the first name (+ role hint).
 *   3. mintDecision()      — the combined gate: reuse / mint / bind-context / hold(+provisional).
 *   + filterAttractors()   — defensive: a provisional/unconfirmed node is never a bind target.
 *
 * PURE + dependency-free (no DB, no Echo). The caller injects the resolver STATUS + the context set, so the
 * whole gate is exhaustively unit-testable — the Tracy scenario is the acid test.
 */

// --- tokenizing -------------------------------------------------------------------------------------
function _tokens(s) { return String(s || '').trim().split(/\s+/).filter(Boolean); }
// A capitalized personal-name token: "Tracy", "O'Neil", "McDonald", "Bromley-Smith" — starts uppercase,
// only letters/apostrophe/hyphen, and carries at least one lowercase (so "J." initials, "USA" acronyms,
// and "III" suffixes are excluded).
function _isNameToken(t) {
  const s = String(t || '');
  return /^[A-Z][A-Za-z'’-]*$/.test(s) && /[a-z]/.test(s);
}
function _nameTokens(name) { return _tokens(name).filter(_isNameToken); }

// Descriptor / role cues that mark a mention as a DESCRIPTION rather than a name ("the finance lady",
// "our new hire", "the intern"). Whole-word, case-insensitive.
const _DESCRIPTOR_RE = /\b(the|our|their|that|this|a|an|new|lady|guy|woman|man|gal|dude|person|people|folks?|team|rep|assistant|intern|hire|boss|colleague|coworker|co-worker|someone|somebody)\b/i;
// Role / department words that a descriptor may carry — also used to match a weak ref to a titled contact.
const _ROLE_HINT_RE = /\b(finance|financial|legal|counsel|hr|human resources|sales|marketing|ops|operations|it|tech|engineering|engineer|policy|comms?|communications|accounting|accountant|admin|administrative|exec|executive|treasur\w*|comptroller|clerk|analyst|advisor|adviser|coordinator|scheduler|press|director|manager|officer|lead|head|vp|ceo|cfo|coo|cto)\b/i;
// Strong-id markers that make a mention self-identifying regardless of shape.
const _STRONG_ID_RE = /\[(wd:Q\d+|Q\d+|FEC:[A-Z0-9]+|C\d{5,}|id:[^\]]+)\]/i;

function firstNameOf(name) {
  const t = _nameTokens(name);
  return t.length ? t[0].toLowerCase() : null;
}
function roleHintOf(name) {
  const m = _ROLE_HINT_RE.exec(String(name || ''));
  return m ? m[0].toLowerCase() : null;
}
// 2+ capitalized name tokens = looks like a full personal name ("Tracy Bromley").
function looksLikeFullName(name) { return _nameTokens(name).length >= 2; }

// --- 1. reference strength --------------------------------------------------------------------------
// referenceStrength(name, type) →
//   'strong'          a full personal name (2+ name tokens, no descriptor), OR any strong-id marker
//   'strong-nonperson' a non-person type (org/office/…) — not subject to PERSON mint-reluctance here
//   'weak-descriptor' a first name + a descriptor/role ("Tracy the finance lady")
//   'weak-first'      a single bare first name ("Tracy")
//   'weak-generic'    a pure descriptor, no name ("the finance lady", "our intern")
function referenceStrength(name, type = null) {
  const n = String(name || '').trim();
  if (!n) return 'weak-generic';
  if (_STRONG_ID_RE.test(n)) return 'strong';
  const t = String(type || '').toLowerCase();
  // Person mint-reluctance applies ONLY to people (typed person/contact) and untyped mentions. An EXPLICIT
  // non-person type — including the catch-all 'other' (COBOL, products, concepts, orgs, offices) — mints on
  // its own path; running person name-shape heuristics on it would wrongly hold acronyms/things.
  const isPersonSubject = t === '' || t === 'person' || t === 'contact';
  if (!isPersonSubject) return 'strong-nonperson';         // orgs/offices/other have their own mint guards
  const hasDescriptor = _DESCRIPTOR_RE.test(n) || _ROLE_HINT_RE.test(n);
  const nameToks = _nameTokens(n);
  if (looksLikeFullName(n) && !hasDescriptor) return 'strong';
  if (nameToks.length >= 1 && hasDescriptor) return 'weak-descriptor';
  if (nameToks.length === 1) return 'weak-first';
  if (!nameToks.length) return 'weak-generic';
  // a multi-token thing with no clear personal-name shape and no descriptor → treat as weak-first
  return 'weak-first';
}

function isWeak(strength) { return strength === 'weak-descriptor' || strength === 'weak-first' || strength === 'weak-generic'; }

// --- 2. contextual identity -------------------------------------------------------------------------
function _fitsRole(candidate, role) {
  if (!role) return false;
  const hay = `${candidate.title || ''} ${Array.isArray(candidate.roles) ? candidate.roles.join(' ') : (candidate.roles || '')} ${candidate.dept || candidate.department || ''} ${candidate.function || ''}`.toLowerCase();
  return hay.includes(role);
}
// contextualMatch(name, context) → { match, ambiguous, candidates?, via? }
// context = [{name, title?, roles?, dept?, type?}] — meeting attendees / co-present contacts. A weak person
// ref binds to a context person sharing the FIRST NAME (narrowed by a role hint when present). A UNIQUE
// survivor binds; 2+ survivors → ambiguous (bias-to-clarify — never popularity-guess an identity).
function contextualMatch(name, context = []) {
  const fn = firstNameOf(name);
  if (!fn) return { match: null, ambiguous: false };
  const self = String(name || '').trim().toLowerCase();
  const people = (Array.isArray(context) ? context : [])
    .map((c) => (typeof c === 'string' ? { name: c } : c))
    .filter((c) => c && c.name && String(c.name).trim().toLowerCase() !== self   // never bind a mention to itself
      && (c.type == null || /^(person|contact|other)$/i.test(String(c.type))));
  // ATTRACTOR GUARD applied to context: a weak/provisional context entry (a bare "Tracy") is never a bind
  // target — only a CONFIRMED full-name person can absorb a weak reference. This is what stops the mention
  // from binding to another spurious weak node instead of the real one.
  const byFirst = filterAttractors(people).filter((c) => firstNameOf(c.name) === fn);
  if (!byFirst.length) return { match: null, ambiguous: false };
  const role = roleHintOf(name);
  let pool = byFirst, via = 'first-name';
  if (role) {
    const roled = byFirst.filter((c) => _fitsRole(c, role));
    if (roled.length) { pool = roled; via = 'first-name+role'; }
  }
  // if a full name is present, prefer an exact full-name context hit (rare for weak refs, but safe)
  if (pool.length === 1) return { match: pool[0].name, ambiguous: false, via };
  return { match: null, ambiguous: true, candidates: pool.map((c) => c.name) };
}

// --- 3. the mint gate -------------------------------------------------------------------------------
// mintDecision(status, name, type, {context}) → { action, name, canonical?, reason, provisional? }
//   status 'resolved'  → reuse                              (unchanged: attach to the existing node)
//   status 'ambiguous' → hold                               (unchanged: >1 distinct candidate)
//   status 'nil' + STRONG ref            → mint             (a full name may create a new durable entity)
//   status 'nil' + WEAK ref + ctx match  → bind-context     (bind to the real person — the Tracy fix)
//   status 'nil' + WEAK ref + no match   → hold (provisional)  NEVER mint a durable node from a weak ref
function mintDecision(status, name, type, { context = [] } = {}) {
  if (status === 'resolved') return { action: 'reuse', name, reason: 'resolver-resolved' };
  if (status === 'ambiguous') return { action: 'hold', name, reason: 'resolver-ambiguous' };
  if (status !== 'nil') return { action: 'skip', name, reason: String(status || 'error') };

  const strength = referenceStrength(name, type);
  if (strength === 'strong' || strength === 'strong-nonperson') {
    return { action: 'mint', name, reason: `strong:${strength}` };
  }
  // WEAK person reference → contextual bind, else hold provisional. NEVER mint.
  const cm = contextualMatch(name, context);
  if (cm.match) return { action: 'bind-context', name, canonical: cm.match, reason: `weak-ref-bound:${cm.via}` };
  return {
    action: 'hold', name, provisional: true,
    reason: cm.ambiguous ? 'weak-ref-context-ambiguous' : `weak-ref-no-context:${strength}`,
  };
}

// --- attractor guard --------------------------------------------------------------------------------
// A provisional / unconfirmed node must never be a bind target for a future ambiguous mention (that is
// exactly how one bad "Tracy" ate every "Tracy"). Callers pass candidate objects; we drop the provisional
// ones. A node is provisional if flagged (provisional/unconfirmed truthy) OR its own name is a weak ref.
function isProvisional(candidate) {
  if (!candidate) return true;
  if (candidate.provisional || candidate.unconfirmed) return true;
  if (candidate.confirmed === false) return true;
  return isWeak(referenceStrength(candidate.name, candidate.type));
}
function filterAttractors(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).filter((c) => !isProvisional(c));
}

module.exports = {
  referenceStrength, isWeak,
  firstNameOf, roleHintOf, looksLikeFullName,
  contextualMatch, mintDecision,
  isProvisional, filterAttractors,
};
