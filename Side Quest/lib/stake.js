/*
 * lib/stake.js — WHOSE INTEREST does a source serve? (methodology parity, S1)
 *
 * `authority_tier` already answers a different question: how OFFICIAL a source is (1 = primary/
 * official record, 2 = major outlet, 3 = told). That is not the question an editor has to answer
 * before printing a number. A company press release is highly authoritative ABOUT THAT COMPANY and
 * completely interested; a utility's benefit projection accepted by a regulator is official-ish and
 * still unaudited. Officialness and interest are orthogonal axes, and her provenance only had the
 * first one — the second (`creator_sources.provenance`) records the CHANNEL a fact arrived through
 * (library / academic / web), not whose interest it serves.
 *
 * From the Rainey Center's op-ed methodology (docs/METHODOLOGY_PARITY_SCOPE.md), the labels that
 * travel with a claim all the way to the page:
 *   CONFIRMED             independently reported → safe to state as fact
 *   COMPANY-REPORTED      sourced only to the party that benefits → must be attributed in print
 *   ATTRIBUTE-TO-UTILITY  produced by an interested party, accepted by a regulator, not audited
 *   COUNTER-EVIDENCE      cuts against the thesis → carried at full strength, never omitted
 *   NOT VERIFIED          no primary source → must not be published until it is
 * Those five are DERIVED here (see `label`), not stored as a fifth enum. Two axes plus the claim's
 * relation to the thesis reproduce all of them, and keep each axis independently checkable.
 *
 * ⚠ THE DIRECTION OF CAUTION MATTERS AND IT IS NOT SYMMETRIC. Marking a company's own number
 * `independent` would launder it into print as fact — the exact failure this exists to prevent.
 * Marking a genuinely independent source `unknown` costs a verification step. So: UNKNOWN unless
 * there is positive evidence, and `independent` is only ever claimed on positive evidence of
 * independence, never inferred from the absence of a match. Same conservative direction as
 * user_work.facetAppliesTo — only conclude on strong evidence.
 *
 * Pure: no db, no network, no model. Every function returns a value and never throws.
 */
'use strict';

const { hostOf } = require('./content_firewall');   // ONE host parser, not a second with its own opinions

const STAKE = {
  INDEPENDENT: 'independent',              // positively established as not the subject and not its mouthpiece
  SUBJECT_REPORTED: 'subject_reported',    // the subject of the claim is the source of it
  INTERESTED_ACCEPTED: 'interested_accepted', // interested party, accepted by a body, not independently audited
  UNKNOWN: 'unknown',                      // no positive evidence either way — the honest default
};
const STAKES = new Set(Object.values(STAKE));

// Words org names are MADE of. A host containing "national" or "center" tells us nothing about whose
// site it is. Deliberately narrow: this list only has to stop the obvious false matches, because an
// unmatched token yields UNKNOWN rather than a wrong label.
const _GENERIC = new Set([
  'the', 'and', 'for', 'of', 'inc', 'llc', 'ltd', 'corp', 'corporation', 'company', 'group', 'holdings',
  'institute', 'institutes', 'foundation', 'association', 'council', 'committee', 'commission', 'center',
  'centre', 'national', 'international', 'american', 'america', 'united', 'states', 'federal', 'state',
  'university', 'college', 'school', 'department', 'agency', 'office', 'bureau', 'authority', 'alliance',
  'coalition', 'network', 'society', 'partners', 'partnership', 'services', 'systems', 'solutions',
  'technologies', 'technology', 'energy', 'power', 'electric', 'utilities', 'utility', 'policy',
  'research', 'science', 'sciences', 'data', 'digital', 'global', 'world', 'news', 'media', 'press',
]);

// Wire services: a press release is the SUBJECT talking, whatever host it sits on. Without this the
// same company statement reads as third-party simply because it was distributed.
const _WIRE = /(?:^|\.)(?:prnewswire|businesswire|globenewswire|newswire|prweb|accesswire|einpresswire|issuewire)\.[a-z.]+$/i;

// Positive evidence of INDEPENDENCE. US government and military domains are not owned by the private
// parties they report on. Kept deliberately short — every addition is a claim that this host has no
// stake, and a wrong entry here launders an interested source into print.
const _INDEPENDENT_HOST = /(?:^|\.)(?:gov|mil)$|(?:^|\.)(?:gov|mil)\.[a-z]{2}$/i;

/** The tokens of a name that could plausibly appear in its own domain. Pure. */
function nameTokens(name) {
  const out = [];
  for (const raw of String(name || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []) {
    if (_GENERIC.has(raw)) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/**
 * Does this host belong to this subject? True only on a DISTINCTIVE token match against the host's
 * own labels — "meta" matches about.meta.com, but a token appearing only inside a path does not, and
 * a generic word never does.
 */
function hostBelongsTo(host, subject) {
  const h = String(host || '').toLowerCase();
  if (!h) return false;
  const toks = nameTokens(subject);
  if (!toks.length) return false;
  // Compare against the host's LABELS, so "energy.example.com" cannot be claimed by an org merely
  // because the string appears somewhere in the domain.
  const labels = h.split('.').filter(Boolean);
  for (const t of toks) {
    if (t.length < 4) continue;                       // 3-char tokens collide far too easily
    for (const lab of labels) {
      if (lab === t) return true;
      // A concatenated brand ("meta" in "metaplatforms", "rainey" in "raineycenter") counts, but only
      // when the token is a real prefix/suffix of the label — never a mid-string coincidence.
      if (lab.length > t.length && (lab.startsWith(t) || lab.endsWith(t))) return true;
    }
  }
  return false;
}

/**
 * Classify a source's interest in the claim it supports.
 *
 * @param {string} opts.url        where the claim came from
 * @param {string} opts.subject    the org/person the claim is ABOUT (the one who would benefit)
 * @param {boolean} opts.accepted  an oversight body accepted the figure but did not audit it
 * @returns {{stake: string, why: string}}
 */
function classifyStake({ url = '', subject = '', accepted = false } = {}) {
  const host = hostOf(url) || String(url || '').trim().toLowerCase();
  if (!host) return { stake: STAKE.UNKNOWN, why: 'no source location' };

  // The subject speaking about itself — checked FIRST, because a .gov page published by the very body
  // a claim is about is subject-reported, not independent. Officialness does not cancel interest.
  if (subject && hostBelongsTo(host, subject)) {
    return accepted
      ? { stake: STAKE.INTERESTED_ACCEPTED, why: `${host} belongs to ${subject}; accepted by an oversight body but not independently audited` }
      : { stake: STAKE.SUBJECT_REPORTED, why: `${host} belongs to ${subject} — the subject of the claim is its source` };
  }
  if (_WIRE.test(host)) {
    return { stake: STAKE.SUBJECT_REPORTED, why: `${host} is a press-release wire — the subject's own statement, redistributed` };
  }
  // An interested figure that a body accepted, where we could not tie the host to the subject: still
  // not independent, and saying so is the point of the label.
  if (accepted) {
    return { stake: STAKE.INTERESTED_ACCEPTED, why: 'accepted by an oversight body, not independently audited' };
  }
  if (_INDEPENDENT_HOST.test(host)) {
    return { stake: STAKE.INDEPENDENT, why: `${host} is a government record and is not the subject` };
  }
  // Everything else. A major outlet is PROBABLY independent, but "probably" is what launders numbers,
  // so it stays unknown until something positive says otherwise.
  return { stake: STAKE.UNKNOWN, why: 'no positive evidence of independence or of interest' };
}

/**
 * The methodology's five print labels, DERIVED from the two axes plus the claim's relation to the
 * thesis. Nothing here is stored — change an axis and the label follows, which is why they cannot
 * drift apart.
 *
 * @param {number} opts.authority_tier  1 primary/official · 2 outlet · 3 told · 0/undefined unknown
 * @param {string} opts.stake           one of STAKE
 * @param {boolean} opts.cutsAgainst    this claim cuts AGAINST the thesis being defended
 */
function label({ authority_tier = 0, stake = STAKE.UNKNOWN, cutsAgainst = false } = {}) {
  const t = Number(authority_tier) || 0;
  const s = STAKES.has(stake) ? stake : STAKE.UNKNOWN;
  // Counter-evidence is a STANCE, not a source property, and it outranks the rest: the methodology's
  // rule is that it is carried at full strength and never omitted, whoever reported it.
  if (cutsAgainst) return { label: 'COUNTER-EVIDENCE', print: 'carry at full strength; never omit', attribute: s !== STAKE.INDEPENDENT };
  if (s === STAKE.SUBJECT_REPORTED) return { label: 'COMPANY-REPORTED', print: 'usable, but must be attributed to that party in print', attribute: true };
  if (s === STAKE.INTERESTED_ACCEPTED) return { label: 'ATTRIBUTE-TO-UTILITY', print: 'attribute to the party that produced it; note it is unaudited', attribute: true };
  if (s === STAKE.INDEPENDENT && (t === 1 || t === 2)) return { label: 'CONFIRMED', print: 'safe to state as fact', attribute: false };
  return { label: 'NOT VERIFIED', print: 'do NOT publish until confirmed to a primary source', attribute: true };
}

/** Stamp a citation with its stake, leaving everything already on it untouched. Pure. */
function stampCitation(citation = {}, { subject = '', accepted = false } = {}) {
  const c = citation && typeof citation === 'object' ? citation : {};
  if (c.stake && STAKES.has(c.stake)) return c;         // never overwrite a stake already established
  const r = classifyStake({ url: c.url || '', subject, accepted });
  return { ...c, stake: r.stake, stake_why: r.why };
}

module.exports = { STAKE, STAKES, classifyStake, label, stampCitation, nameTokens, hostBelongsTo };
