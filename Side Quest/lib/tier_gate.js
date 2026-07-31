/*
 * lib/tier_gate.js — what is allowed to cross into a DELIVERABLE (methodology parity, S2).
 *
 * From the Rainey Center's op-ed process record, §5:
 *   Tier 1 (strongly supported)      may lead and carry weight
 *   Tier 2 (supportable with framing) usable ONLY with its condition attached
 *   Tier 3 (does not survive)         kept out of every draft, INCLUDING THE FLATTERING ONES
 *
 * ⚠ THIS GATES DRAFTS, NOT MEMORY, AND THE DISTINCTION IS THE WHOLE DESIGN. Her substantiation model
 * is deliberately "grade is priority, not a gate" — an unsubstantiated claim is kept and left to
 * prove-or-fade, because throwing away weak evidence is how you lose the thread that later turns out
 * to matter. The tier rule is the opposite instinct, and it is right about a different thing: what
 * gets PRINTED. So nothing here touches the store. It reads a draft on its way out and reports what
 * may not go with it.
 *
 * TWO RULES, both straight from the methodology, both checkable without a model:
 *
 *   A. A load-bearing sentence with NO citation is Tier 3. "Claims that could not be confirmed to a
 *      primary source must not be published until they are." Needs no subject — always runs.
 *   B. A load-bearing sentence cited to an INTERESTED source, where the sentence does not name that
 *      party, is Tier 2 with its condition unmet. "Usable, but must be attributed to that company in
 *      print." Runs when the caller knows whose claim it is.
 *
 * Deliberately NOT a rule: "the source's independence is unestablished". S1 leaves a major outlet at
 * stake=unknown on purpose, and treating unknown as Tier 3 would reject nearly every real citation
 * and make the gate noise. Tier 3 here means UNCITED, which is what the methodology actually says.
 *
 * Pure: no db, no network, no model. Every function returns a value and never throws.
 */
'use strict';

const stakeLib = require('./stake');

const TIER = { LEAD: 1, CONDITIONAL: 2, EXCLUDED: 3 };

// A claim is LOAD-BEARING when it carries a figure or a quotation — the things a fact-checker checks
// and a hostile reader attacks. Prose without either ("the grid is aging") is an argument, not a
// citable fact, and demanding a source for every clause is how a gate becomes noise people switch off.
const _FIGURE = /(?:\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:%|percent|million|billion|trillion|thousand|GW|MW|kWh|mi|miles)\b|\b\d{2,}[\d,]*(?:\.\d+)?\b)/i;
const _QUOTE = /["“][^"”]{25,}["”]/;
// The inline citation her synthesis is instructed to emit: "(source: <url>)" / "(source: gathered
// notes)" / "(source: held doc:N)".
const _SOURCE = /\(source:\s*([^)]{1,300})\)/i;
const _URL_IN = /(https?:\/\/[^\s)]+)/i;

/** Sentence-ish split that keeps list items and headings apart. Pure. */
function sentences(markdown) {
  const out = [];
  let inFence = false;
  for (const line of String(markdown || '').split(/\r?\n/)) {
    const l = line.trim();
    // A fence must be TRACKED, not just skipped at its delimiter — the claims-looking text is the
    // content BETWEEN the fences, and skipping only the ``` lines let a SQL literal through as a
    // load-bearing figure.
    if (/^```/.test(l)) { inFence = !inFence; continue; }
    if (inFence) continue;
    if (!l || /^#{1,6}\s/.test(l)) continue;   // headings are labels, not claims
    for (const s of l.split(/(?<=[.!?])\s+(?=[A-Z"“(])/)) {
      const t = s.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function isLoadBearing(sentence) {
  const s = String(sentence || '');
  return _FIGURE.test(s) || _QUOTE.test(s);
}

/**
 * Does this sentence name the party whose claim it is? The methodology's "attributed in print".
 *
 * ⚠ THE CITATION IS STRIPPED FIRST, and the smoke caught why. "…grants totalled $58 million
 * (source: https://about.meta.com/news/grants)" appears to name Meta — because the URL contains
 * "meta". Attribution means the PROSE says whose figure it is; a reader does not read the host out
 * of a link. Without this the rule silently passed exactly the sentences it exists to catch.
 */
function namesParty(sentence, party) {
  const toks = stakeLib.nameTokens(party).filter((t) => t.length >= 4);
  if (!toks.length) return true;      // nothing distinctive to look for → cannot fault the sentence
  const prose = String(sentence || '').replace(_SOURCE, ' ').toLowerCase();
  return toks.some((t) => prose.includes(t));
}

/**
 * Read a draft on its way out.
 *
 * @param {string} opts.markdown  the draft
 * @param {string} opts.subject   the party a claim would benefit (enables rule B). Optional.
 * @returns {{ok, violations, counts, summary}}  REPORTS; never mutates the draft.
 */
function checkDraft({ markdown = '', subject = '' } = {}) {
  const violations = [];
  const counts = { loadBearing: 0, uncited: 0, unattributed: 0 };
  for (const s of sentences(markdown)) {
    if (!isLoadBearing(s)) continue;
    counts.loadBearing++;
    const m = s.match(_SOURCE);
    if (!m) {
      counts.uncited++;
      violations.push({
        tier: TIER.EXCLUDED, rule: 'uncited',
        why: 'a figure or quotation with no source — do not publish until it is confirmed to one',
        sentence: s.slice(0, 200),
      });
      continue;
    }
    if (!subject) continue;                       // rule B needs to know who would benefit
    const url = (m[1].match(_URL_IN) || [])[1] || '';
    if (!url) continue;                           // "gathered notes" / "held doc:N" — not a stake question
    const { stake } = stakeLib.classifyStake({ url, subject });
    const interested = stake === stakeLib.STAKE.SUBJECT_REPORTED || stake === stakeLib.STAKE.INTERESTED_ACCEPTED;
    if (interested && !namesParty(s, subject)) {
      counts.unattributed++;
      violations.push({
        tier: TIER.CONDITIONAL, rule: 'unattributed',
        why: `sourced to ${subject}'s own material but the sentence does not say so — attribute it in print`,
        sentence: s.slice(0, 200),
      });
    }
  }
  const excluded = violations.filter((v) => v.tier === TIER.EXCLUDED).length;
  return {
    ok: violations.length === 0,
    violations,
    counts,
    summary: violations.length
      ? `${excluded} uncited (Tier 3, must not print), ${counts.unattributed} interested-but-unattributed (Tier 2) of ${counts.loadBearing} load-bearing`
      : `${counts.loadBearing} load-bearing claim(s), all cited${subject ? ' and attributed where interested' : ''}`,
  };
}

module.exports = { TIER, checkDraft, sentences, isLoadBearing, namesParty };
