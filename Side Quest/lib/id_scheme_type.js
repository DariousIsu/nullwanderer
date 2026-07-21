'use strict';
/**
 * lib/id_scheme_type.js — what an IDENTIFIER SCHEME itself proves about kind. PURE.
 *
 * docs/OBJECT_TYPE_AND_IDENTITY_DESIGN.md §2a-ii step 1. The cheapest rung of the validation ladder:
 * some identifiers say what kind of thing they are attached to BY CONSTRUCTION, with no lookup, no
 * network and no model call.
 *
 * Measured against the live placeholder rows (12,977 of them, 2,522 carrying a strong id):
 *
 *     bioguide   1,943   a Congressional Biographical Directory code is a PERSON
 *     wikidata     371   says nothing on its own — needs a P31 lookup (the next rung)
 *     fec          176   H/S/P = a candidate (person); C = a committee (organisation)
 *     lda           31   REFUSED — see below
 *     openstates     1   an ocd-person id is a person
 *
 * ── WHY `lda` IS REFUSED, AND WHY THAT IS THE WHOLE POINT ───────────────────────────────────────
 *
 * An LDA client id looks like it means "organisation". It does not. It means "this entity appeared as a
 * client in a lobbying-disclosure filing" — and Fulton County, a county GOVERNMENT, has one. Typing on
 * that id is precisely the original bug: the ROLE an entity appeared in became its TYPE.
 *
 * So the rule is narrower than it first looks: a scheme may type an entity only where the scheme's
 * REGISTER is defined by kind. A biographical directory contains people and nothing else. A lobbying
 * register contains whoever hired a lobbyist.
 */

const { parseEntity } = require('./entity_match');

// scheme → the type it proves, or null where the scheme proves nothing about kind.
const SCHEME_TYPE = {
  bioguide: 'person',        // Biographical Directory of the United States Congress — people only
  ocd: 'person',             // only ocd-person ids are parsed into `ids.ocd` upstream
  openstates: 'person',      // openstates person uuid
  wikidata: null,            // Q1264404 is a utility, Q34296 is a president — the id alone says nothing
  lda: null,                 // REFUSED: a lobbying CLIENT may be a company or a county government
  contact: null,             // an internal row id proves nothing about kind
  fec: 'special',            // depends on the id's own prefix — see below
};

// FEC ids are self-describing: H/S/P = House/Senate/Presidential CANDIDATE (a person), C = a committee.
function fecType(id) {
  const s = String(id || '').toUpperCase();
  if (/^[HSP]\d/.test(s)) return 'person';
  if (/^C\d/.test(s)) return 'organization';
  return null;
}

/**
 * What does this name's identifier prove about its kind? → { type, scheme, why } or null.
 *
 * Where two schemes disagree the answer is REFUSED rather than picked. Disagreement means one of the ids
 * is wrong or the row is two entities fused, and both are worse than an unresolved type.
 */
function typeFromIds(name) {
  let ids = {};
  try { ids = parseEntity({ name }).ids || {}; } catch { return null; }
  const found = [];
  for (const [scheme, id] of Object.entries(ids)) {
    const rule = SCHEME_TYPE[scheme];
    if (rule === undefined || rule === null) continue;
    const t = rule === 'special' ? (scheme === 'fec' ? fecType(id) : null) : rule;
    if (t) found.push({ type: t, scheme, id });
  }
  if (!found.length) return null;
  const distinct = new Set(found.map((f) => f.type));
  if (distinct.size > 1) {
    return { type: null, scheme: found.map((f) => f.scheme).join('+'), why: `schemes disagree (${[...distinct].join(' vs ')}) — refused` };
  }
  const f = found[0];
  return { type: f.type, scheme: f.scheme, why: `${f.scheme}:${f.id} identifies a ${f.type} by construction` };
}

module.exports = { typeFromIds, fecType, SCHEME_TYPE };
