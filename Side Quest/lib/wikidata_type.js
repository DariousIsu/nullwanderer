'use strict';
/**
 * lib/wikidata_type.js — a QID's P31 ("instance of") → our type vocabulary. PURE.
 *
 * docs/OBJECT_TYPE_AND_IDENTITY_DESIGN.md §2a-ii step 1, the last rung that needs no model call. A
 * Wikidata QID is a strong identifier that says NOTHING about kind on its own — Q1264404 is a utility,
 * Q34296 is a president — which is why lib/id_scheme_type.js refuses it and hands it here instead.
 *
 * ── THE MAP IS GROUNDED, NOT INVENTED ───────────────────────────────────────────────────────────
 *
 * Wikidata has hundreds of thousands of classes and this maps a few dozen. The list was built by
 * fetching P31 for the 370 QIDs actually sitting on placeholder rows and tallying what came back, rather
 * than by imagining an ontology. The live distribution is overwhelmingly educational institutions
 * (48 public US institutions, 41 universities, 14 public universities…), then people (46), then
 * businesses. Mapping what is there beats mapping what might be.
 *
 * ── UNMAPPED IS A HOLD, NOT A GUESS ─────────────────────────────────────────────────────────────
 *
 * An unrecognised class returns null and the row keeps its placeholder. That is the same trade every
 * other slice makes: a missing type is recoverable and visible, a wrong one is sticky and invisible.
 * Adding a class here is a deliberate act with a real referent behind it.
 *
 * ── DISAGREEMENT IS REFUSED ─────────────────────────────────────────────────────────────────────
 *
 * Entities carry several P31 values (Duke Energy is a business AND an enterprise AND a public company —
 * all `organization`, no conflict). Where mapped classes disagree on the TYPE, the answer is refused
 * rather than voted on: a row that is both a person and an organisation is a fused row or a bad id, and
 * both are worse than an unresolved type.
 */

// P31 class → our type. Grouped by what it is, with the live counts that justified each entry.
const P31_TYPE = {
  // people
  Q5: 'person',                       // human (46 live)

  // education — the bulk of this corpus
  Q23002039: 'organization',          // public educational institution of the US (48)
  Q3918: 'organization',              // university (41)
  Q875538: 'organization',            // public university (14)
  Q615150: 'organization',            // land-grant university (9)
  Q1620945: 'organization',           // historically black college or university (7)
  Q23002054: 'organization',          // private not-for-profit educational institution (6)
  Q1075106: 'organization',           // state university system (5)
  Q62078547: 'organization',          // public research university (3)
  Q5772674: 'organization',           // Hispanic-serving institution (2)
  Q3914: 'organization',              // school (2)
  Q902104: 'organization',            // private university
  Q15936437: 'organization',          // research university
  Q1743327: 'organization',           // church college
  Q627006: 'organization',            // normal school
  Q2385804: 'organization',           // educational institution
  Q2467461: 'organization',           // academic department
  Q122940278: 'organization',         // school of international relations
  Q189004: 'organization',            // college

  // commercial
  Q4830453: 'organization',           // business (5)
  Q891723: 'organization',            // public company (4)
  Q6881511: 'organization',           // enterprise (3)
  Q1058914: 'organization',           // software company
  Q45400320: 'organization',          // open-access publisher (5)
  Q96888669: 'organization',          // academic publisher (2)
  Q2085381: 'organization',           // publisher
  Q43229: 'organization',             // organization (2)
  Q163740: 'organization',            // nonprofit organization
  Q7278: 'organization',              // political party
  Q31855: 'organization',             // research institute
  Q4022: 'location',                  // river

  // government — kept DISTINCT from organization, which is the whole point of T1
  Q20857065: 'government_body',       // United States federal agency (2)
  Q2659904: 'government_body',        // government organization
  Q1006644: 'government_body',        // federal government
  Q573607: 'government_body',         // revenue service
  Q7603694: 'government_body',        // state government of the United States
  Q35798: 'government_body',          // executive branch
  Q189445: 'government_body',         // bicameral legislature
  Q2943071: 'government_body',        // congressional caucus
  Q327333: 'government_body',         // government agency
  Q61883: 'government_body',          // air force (a branch of government)

  // places
  Q498162: 'location',                // census-designated place in the US
  Q17343829: 'location',              // unincorporated community
  Q209465: 'location',                // campus
  Q515: 'location',                   // city
  Q3957: 'location',                  // town
  Q532: 'location',                   // village
  Q35657: 'location',                 // U.S. state
  Q6256: 'location',                  // country
  Q3624078: 'location',               // sovereign state
  Q28575: 'location',                 // county
};

/**
 * p31 → { type, why } or null when nothing is known.
 *
 * Returns { type: null, why } on a genuine disagreement so the caller can report WHY it was refused,
 * rather than silently getting the same shape as "no information".
 */
function typeFromP31(p31 = []) {
  const ids = (Array.isArray(p31) ? p31 : [p31]).map((x) => String(x || '').trim().toUpperCase()).filter(Boolean);
  if (!ids.length) return null;
  const hits = [];
  for (const q of ids) if (P31_TYPE[q]) hits.push({ q, type: P31_TYPE[q] });
  if (!hits.length) return null;                                   // unmapped → hold, never guess
  const distinct = new Set(hits.map((h) => h.type));
  if (distinct.size > 1) {
    return { type: null, why: `P31 classes disagree (${[...distinct].join(' vs ')}) — refused`, classes: hits.map((h) => h.q) };
  }
  return { type: hits[0].type, why: `P31 ${hits.map((h) => h.q).join(',')} → ${hits[0].type}`, classes: hits.map((h) => h.q) };
}

module.exports = { typeFromP31, P31_TYPE };
