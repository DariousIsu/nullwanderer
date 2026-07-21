'use strict';
/**
 * lib/birth_context.js — WHERE AN OBJECT WAS BORN, and what that constrains. PURE + one log read.
 *
 * Lucas, 2026-07-21: *"What if we included rough edges in the new object creation from the context of
 * where the object was born. We have an issue with meetings being processed without context and leading
 * to false identifications, sounds like something similar here."*
 *
 * He is describing one disease with two faces:
 *
 *   THE MEETING FACE   a transcript names "Chris" and the quick-ID binds it to whichever Chris the graph
 *                      already knows, because the meeting is processed as free-floating text.
 *   THE LOOKUP FACE    "Osceola" resolves to Q335165 — the Seminole leader — because Wikipedia's bare
 *                      title binds to the globally famous referent. In a corpus of Georgia and Florida
 *                      civic documents it is the COUNTY.
 *
 * Both are the same error: an object is resolved against a GLOBAL prior when a LOCAL one was available
 * and simply not carried. The document knew. Nobody wrote it down.
 *
 * ── THE ROUGH EDGE ──────────────────────────────────────────────────────────────────────────────
 *
 * An object's own identity is what the encounter log holds. Its rough edge is everything TRUE OF WHERE
 * IT CAME FROM that is not a property of the object itself: the publisher, the jurisdiction that
 * publisher speaks for, the lane it arrived through. That is not evidence about the object, and it must
 * never be recorded as a claim — a county website publishing a name does not make the name a county
 * thing. It is a PRIOR: it says which readings are plausible, and more usefully, which are absurd.
 *
 * So the rough edge is used to REFUSE, never to assert. A candidate reading that contradicts the birth
 * jurisdiction is thrown out; a candidate that agrees with it earns nothing. That asymmetry is the whole
 * safety property — a wrong prior can then cost us a resolution, but it can never manufacture one.
 *
 * Nothing here is a new store. The log already carries origin_host on every row and is append-only, so
 * the earliest row for an object IS its birth, and 100% of live objects have one.
 */

// US state/territory codes, for reading a jurisdiction out of a hostname.
const STATES = new Set(['al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia',
  'ks', 'ky', 'la', 'me', 'md', 'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd',
  'oh', 'ok', 'or', 'pa', 'ri', 'sc', 'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc', 'pr', 'gu', 'vi']);

// Local news mastheads whose domain names its state — measured as the top birth hosts in the live log
// (cleveland.com 1,919 · mlive.com 1,724 · nj.com 1,697 · al.com 1,578 · masslive.com 1,398). These are
// the single largest source of births, so leaving them jurisdiction-less would blind the gate to most of
// the corpus. Enumerated rather than pattern-matched: `mlive` does not spell Michigan.
const NEWS_JURISDICTION = {
  'nj.com': 'nj', 'al.com': 'al', 'mlive.com': 'mi', 'masslive.com': 'ma', 'cleveland.com': 'oh',
  'oregonlive.com': 'or', 'pennlive.com': 'pa', 'silive.com': 'ny', 'syracuse.com': 'ny',
  'lehighvalleylive.com': 'pa', 'seattletimes.com': 'wa', 'chron.com': 'tx', 'dallasnews.com': 'tx',
  'miamiherald.com': 'fl', 'tampabay.com': 'fl', 'orlandosentinel.com': 'fl', 'ajc.com': 'ga',
  'star-telegram.com': 'tx', 'sacbee.com': 'ca', 'latimes.com': 'ca', 'sfchronicle.com': 'ca',
  'denverpost.com': 'co', 'startribune.com': 'mn', 'jsonline.com': 'wi', 'freep.com': 'mi',
  'detroitnews.com': 'mi', 'inquirer.com': 'pa', 'baltimoresun.com': 'md', 'courant.com': 'ct',
  'nola.com': 'la', 'theadvocate.com': 'la', 'arkansasonline.com': 'ar', 'tennessean.com': 'tn',
  'courier-journal.com': 'ky', 'dispatch.com': 'oh', 'indystar.com': 'in', 'desmoinesregister.com': 'ia',
  'kansascity.com': 'mo', 'stltoday.com': 'mo', 'omaha.com': 'ne', 'azcentral.com': 'az',
  'sltrib.com': 'ut', 'rgj.com': 'nv', 'statesman.com': 'tx', 'newsobserver.com': 'nc',
  'postandcourier.com': 'sc', 'richmond.com': 'va', 'wvgazettemail.com': 'wv', 'bostonglobe.com': 'ma',
};

// Full state NAMES, and they must be checked BEFORE any two-letter suffix rule. `team.georgia.gov` read
// as Iowa on the first cut, because "georg-IA" ends in a state code — and so do califirn-IA,
// pennsylvan-IA, virgin-IA, louisia-NA, monta-NA, india-NA. The same mid-word matching that made the
// institution regex fire on Ro-NA-ld. A suffix rule over a namespace containing the full words is a trap.
const STATE_NAMES = {
  alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co',
  connecticut: 'ct', delaware: 'de', florida: 'fl', myflorida: 'fl', georgia: 'ga', hawaii: 'hi',
  idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la',
  maine: 'me', maryland: 'md', massachusetts: 'ma', mass: 'ma', michigan: 'mi', minnesota: 'mn',
  mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', newhampshire: 'nh',
  newjersey: 'nj', newmexico: 'nm', newyork: 'ny', northcarolina: 'nc', northdakota: 'nd', ohio: 'oh',
  oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', rhodeisland: 'ri', southcarolina: 'sc',
  southdakota: 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va',
  washington: 'wa', westvirginia: 'wv', wisconsin: 'wi', wyoming: 'wy',
};

// Federal hosts whose label collides with a state code. `va.gov` is the Department of Veterans Affairs,
// not Virginia — and reading it as Virginia would put a false jurisdiction on every veteran-affairs
// object. Enumerated because the collision is a fact about these specific domains, not a pattern.
const FEDERAL_COLLISIONS = new Set(['va.gov', 'de.gov', 'or.gov', 'in.gov.uk']);

const host = (h) => String(h || '').trim().toLowerCase().replace(/^www\./, '');

/**
 * hostJurisdiction('apachecountyaz.gov') → { state:'az', why:'gov domain suffix' }
 *
 * Reads a US state out of a hostname where the host commits to one. Returns null rather than guessing —
 * a national publisher (foxnews.com) genuinely has no jurisdiction, and inventing one would create a
 * prior that refuses correct readings.
 */
// SPEAKS FOR vs WRITES ABOUT — the distinction that decides whether a prior may refuse anything.
//
// A county website is authoritative about its own county: a name on applingcountyga.gov is Georgia
// business. A newspaper is not confined to its state — the Star Tribune covers the South Pacific, and
// the live data has exactly that: "South Pacific" born on startribune.com, which would make a Minnesota
// prior refuse every correct reading of it. Under a refuse-only rule a wrong prior costs resolutions,
// so only `authoritative` jurisdictions are allowed to contradict. `topical` is retained because it is
// still useful for ranking and for explaining where something came from — it just may not veto.
function hostJurisdiction(h) {
  const s = host(h);
  if (!s) return null;
  if (NEWS_JURISDICTION[s]) return { state: NEWS_JURISDICTION[s], why: 'local masthead', strength: 'topical' };

  if (FEDERAL_COLLISIONS.has(s)) return null;

  const parts = s.split('.');
  const tld = parts[parts.length - 1];

  // `co.travis.tx.us`, `ci.austin.tx.us` — the state is its own label.
  if (tld === 'us' && parts.length >= 3) {
    const st = parts[parts.length - 2];
    if (STATES.has(st)) return { state: st, why: 'us domain label', strength: 'authoritative' };
  }
  if (tld !== 'gov') return null;

  // ANY label may carry the state, not just the second-to-last: legis.IOWA.gov, lrb.HAWAII.gov,
  // archive.sos.IDAHO.gov, team.GEORGIA.gov. Whole-word state names first, and they win outright.
  for (const p of parts) {
    if (STATE_NAMES[p]) return { state: STATE_NAMES[p], why: 'gov state name', strength: 'authoritative' };
    if (STATES.has(p)) return { state: p, why: 'gov state code label', strength: 'authoritative' };
  }

  // Only now the concatenated form — `apachecountyAZ`, `kentcountyDE`, `bondcountyIL`, `highlandsFL`.
  // Guarded three ways: the label must not BE a state name (that is what produced Iowa from Georgia),
  // it must be long enough to be a place+code compound, and it must not merely end in those letters by
  // accident of English — so a `county`/`city`/`parish` stem, or a label ending in a code after one.
  const name = parts[parts.length - 2] || '';
  if (STATE_NAMES[name]) return { state: STATE_NAMES[name], why: 'gov state name', strength: 'authoritative' };
  const m = /^(.*?)([a-z]{2})$/.exec(name);
  if (m && STATES.has(m[2]) && m[1].length >= 4 && !STATE_NAMES[name]) {
    // `-county-`, `-city-`, `-parish-`, `-borough-` before the code is strong evidence of a compound.
    if (/(county|city|parish|borough|township|town|village|co)$/.test(m[1])) return { state: m[2], why: 'gov place+state compound', strength: 'authoritative' };
    // Otherwise require that the stem is not itself an English word ending in those two letters. We
    // cannot know that here, so this stays conservative: refuse rather than risk another Georgia→Iowa.
    return null;
  }
  return null;
}

/**
 * Does a candidate reading contradict where the object was born?
 *
 * REFUSE-ONLY. Agreement earns nothing; only a positive contradiction counts, and only when BOTH sides
 * are known. An unknown on either side is not a conflict — punishing absent metadata would quietly
 * refuse most of the corpus, which is how a safety check becomes an outage.
 */
function contradicts(birth, candidate) {
  const b = birth && birth.state;
  const c = candidate && candidate.state;
  if (!b || !c) return false;
  // Only a publisher that SPEAKS FOR a jurisdiction may veto. A masthead merely covers one.
  if (birth.strength !== 'authoritative') return false;
  return String(b).toLowerCase() !== String(c).toLowerCase();
}

/**
 * The birth context of an object, read from the log. The earliest encounter IS the birth, because the
 * log is append-only and never rewritten.
 *
 * `db` is injected so this stays testable without a database.
 */
function birthContext(objectKey, { db = null } = {}) {
  if (!objectKey) return null;
  let row = null;
  try {
    const d = (db || require('./db')).getDb();
    row = d.prepare(`SELECT object_label, origin_host, origin, source_kind, source_ref, ingested_at
                       FROM encounters WHERE object_key = ? ORDER BY id ASC LIMIT 1`).get(objectKey);
  } catch { return null; }
  if (!row) return null;
  return {
    label: row.object_label,
    host: row.origin_host || null,
    origin: row.origin || null,
    lane: row.source_kind || null,
    sourceRef: row.source_ref || null,
    bornAt: row.ingested_at || null,
    jurisdiction: hostJurisdiction(row.origin_host),
  };
}

/**
 * The same, keyed by LABEL rather than object key — for callers holding a name from another store
 * (graph_entities) with no encounter key in hand. Matches the log's own normalisation of the label so a
 * casing difference does not read as "never seen".
 */
function birthContextByLabel(label, { db = null } = {}) {
  const s = String(label == null ? '' : label).trim().toLowerCase();
  if (!s) return null;
  let row = null;
  try {
    const d = (db || require('./db')).getDb();
    row = d.prepare(`SELECT object_key FROM encounters WHERE lower(trim(object_label)) = ? ORDER BY id ASC LIMIT 1`).get(s);
  } catch { return null; }
  return row ? birthContext(row.object_key, { db }) : null;
}

/**
 * Birth context for a graph_entities row, read from its EARLIEST entity citation.
 *
 * The graph-walk population lives almost entirely outside the encounter log — measured: of 10,361
 * untyped entities, ~1% appear in the log and ZERO carried an entity citation, because recordRelation
 * minted its endpoints without passing a source. That is now fixed at the source, so newly born
 * entities have this; the pre-existing ones can only be reached by the relation-citation fallback,
 * which is deliberately second: a relation's source is where the EDGE was found, which is usually but
 * not always where the endpoint was first seen.
 */
function birthContextForEntity(entityId, { db = null } = {}) {
  if (entityId == null) return null;
  let row = null;
  try {
    const d = (db || require('./db')).getDb();
    row = d.prepare(`SELECT s.kind, s.ref, s.fetched_at FROM graph_citations c
                       JOIN graph_sources s ON s.id = c.source_id
                      WHERE c.fact_kind = 'entity' AND c.fact_id = ?
                      ORDER BY s.id ASC LIMIT 1`).get(entityId);
    if (!row) {
      row = d.prepare(`SELECT s.kind, s.ref, s.fetched_at FROM graph_relations r
                         JOIN graph_citations c ON c.fact_kind = 'relation' AND c.fact_id = r.id
                         JOIN graph_sources s ON s.id = c.source_id
                        WHERE r.source_id = ? OR r.target_id = ?
                        ORDER BY s.id ASC LIMIT 1`).get(entityId, entityId);
      if (row) row.viaRelation = true;
    }
  } catch { return null; }
  if (!row || !row.ref) return null;
  let h = null;
  try { h = require('./origin').hostOf(row.ref); } catch { h = null; }
  return {
    host: h,
    origin: row.ref,
    lane: row.kind || null,
    bornAt: row.fetched_at || null,
    viaRelation: !!row.viaRelation,
    jurisdiction: hostJurisdiction(h),
  };
}

module.exports = { birthContext, birthContextByLabel, birthContextForEntity, hostJurisdiction, contradicts, NEWS_JURISDICTION, STATES, STATE_NAMES };
