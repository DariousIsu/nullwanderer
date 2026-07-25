/**
 * lib/graph_integrity.js — GRAPH-INTEGRITY BEATS: make the graph itself a coverage universe.
 *
 * WHY THIS EXISTS (Lucas, 2026-07-25): "the program needs to be able to do the entire process you've
 * done and what you're about to do on its own."
 *
 * The process being referred to is a loop I had been running BY HAND against Echo's civic_graph:
 *
 *      census the graph  →  find a STRUCTURAL gap  →  read rows, not counts  →  diff against an
 *      authoritative enumeration  →  emit a bounded worklist  →  repair behind guards, idempotent
 *      and tagged  →  HOLD whatever can't be grounded, and say so
 *
 * Every organ for that already existed except one. `lib/beats.js` enumerates a finite universe
 * (3,152 counties from the Census gazetteer, 19,558 incorporated places) and the directed-research
 * driver exhausts it. But that universe is a RESEARCH worklist — "go read about this county board".
 * Nothing ever asked the cheaper, prior question: *does this county exist in the graph at all, and is
 * it attached to its state?*
 *
 * The proof that this was the missing rung: on 2026-07-25 the graph held 308 county/parish places
 * against ~3,143 real ones, so `city → county → state` had no middle rung and Wikidata P131 could
 * only place 86 of 2,457 orphaned places. It was repaired by minting counties FROM WIKIDATA — while
 * `lib/us_counties.json`, the authoritative Census list, was sitting on disk the whole time. The
 * enumeration was never wired to the graph.
 *
 * So: a beat whose universe is the GRAPH. Same contract as every other beat (`enumerate()` /
 * `universeSize()`), so the existing scheduler and coverage accounting work unchanged — what differs
 * is that a target here is a REPAIR ("Bienville Parish, Louisiana is missing"), not a research topic.
 *
 * PURE by design, exactly like beats.js: this module takes graph rows IN and returns a plan OUT. It
 * opens no database and performs no writes, so the whole diff is offline-testable. The impure half —
 * querying civic_graph (read-only, analysis_lane whitelist) and asserting through Echo's MCP write
 * tools — belongs to the caller.
 */
'use strict';

const US_COUNTIES = require('./us_counties.json');

// ---------------------------------------------------------------------------------------------
// Normalisation. Graph place names arrive in several shapes for the same thing:
//   "Henry County, Kentucky"      (derived from a name that stated its parent)
//   "Los Angeles County"          (minted from Wikidata, bare)
//   "Sonoma County [wd:Q108067]"  (QID-suffixed because the bare name was taken)
// Compare on a key that survives all three, and NEVER write a normalised form back as a name.
// ---------------------------------------------------------------------------------------------
const QID_SUFFIX = /\s*\[(?:wd:)?Q\d+\]\s*$/i;

function stripQid(s) { return String(s == null ? '' : s).replace(QID_SUFFIX, '').trim(); }

function normName(s) {
  return stripQid(s)
    .normalize('NFKC')
    .replace(/ /g, ' ')
    .replace(/[.'']/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** "Acadia Parish, Louisiana" and "Acadia Parish" both key to `acadia parish|LA`. */
function countyKey(countyName, stateCode) {
  const bare = normName(countyName).replace(/,\s*[a-z .]+$/, '');
  return `${bare}|${String(stateCode || '').toUpperCase()}`;
}

// ---------------------------------------------------------------------------------------------
// What SHOULD exist
// ---------------------------------------------------------------------------------------------

/**
 * Every county-equivalent the Census says exists, as an expected place object.
 * `noun` matters for display: Louisiana has parishes, Alaska boroughs, Puerto Rico municipios.
 */
function expectedCounties() {
  const out = [];
  for (const [code, st] of Object.entries(US_COUNTIES)) {
    for (const name of (st.counties || [])) {
      out.push({
        key: countyKey(name, code),
        name,                                   // the official Census name, verbatim
        stateCode: code.toUpperCase(),
        stateName: st.name,
        noun: st.noun || 'county',
        // The name we would MINT. Qualified, because "Washington County" exists in 30 states and a
        // bare name would collide — entities.name is UNIQUE across every entity_type.
        mintName: `${name}, ${st.name}`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What DOES exist → the gap
// ---------------------------------------------------------------------------------------------

/**
 * Diff the Census county universe against the graph.
 *
 * @param graphPlaces  [{ id, name, stateCode? }]  every entity_type='place' row
 * @param parentedIds  Set<id>  place ids that already have a LOCATED_IN out-edge
 * @param stateOf      Map<id, USPS>  a place's state taken from its own LOCATED_IN parent edge
 * @returns { missing, unparented, present, coverage, byState, unplaceable }
 *
 * A county is matched by (bare county name + state), and the state is resolved in three ways, in
 * order of how much we trust it:
 *   1. `stateCode` supplied by the caller
 *   2. `stateOf` — the LOCATED_IN parent the graph already asserts
 *   3. a trailing ", <State>" in the name
 *
 * Step 2 exists because of a real miss. The 1,035 counties minted from Wikidata on 2026-07-25 are
 * named BARE — "Kern County", "Los Angeles County" — and "Washington County" exists in 30 states, so
 * name alone could not identify them and county coverage read 4.1% when it was really far higher.
 * The graph already knew the answer: each of those counties has a LOCATED_IN edge to its state.
 * ⚠️ A county we cannot place by any of the three is reported as `unplaceable`, NOT as missing —
 * "I can't tell" and "it isn't there" are different findings and must never be merged.
 *
 * TWO DISTINCT GAPS, deliberately kept apart, because they need different repairs and conflating
 * them is how "we have counties" hid the fact that none of them were attached:
 *   missing     — no object at all            → mint it
 *   unparented  — exists but has no LOCATED_IN → edge it to its state
 */
function diffCounties({ graphPlaces = [], parentedIds = new Set(), stateOf = new Map() } = {}) {
  const stateByName = new Map();               // "louisiana" -> "LA"
  for (const [code, st] of Object.entries(US_COUNTIES)) {
    stateByName.set(normName(st.name), code.toUpperCase());
  }

  const have = new Map();                      // countyKey -> graph row
  const unplaceable = [];
  for (const row of graphPlaces) {
    const raw = stripQid(row.name);
    if (!/\b(county|parish|borough|municipio|census area|city and borough)\b/i.test(raw)) continue;
    let code = row.stateCode ? String(row.stateCode).toUpperCase() : '';
    if (!code && stateOf.has(row.id)) code = String(stateOf.get(row.id)).toUpperCase();
    if (!code) {
      const m = raw.match(/,\s*([^,]+)$/);
      if (m) code = stateByName.get(normName(m[1])) || '';
    }
    if (!code) { unplaceable.push(row); continue; }   // "I can't tell" — NOT evidence of absence
    const k = countyKey(raw, code);
    if (!have.has(k)) have.set(k, row);
  }

  // Bare names of the county-shaped rows we could NOT place. A missing county whose name collides
  // with one of these must never be minted: the object may already be there, just unidentifiable.
  // Minting anyway is how a retype produced two `United States` rows on 2026-07-25. Suspicion is
  // enough to hold — the cost of holding is a report line, the cost of minting is a duplicate.
  const unplaceableNames = new Set(
    unplaceable.map((r) => normName(stripQid(r.name)).replace(/,\s*[a-z .]+$/, '')));

  const expected = expectedCounties();
  const missing = [], unparented = [], present = [];
  for (const exp of expected) {
    const row = have.get(exp.key);
    if (!row) {
      const bare = normName(exp.name);
      missing.push(unplaceableNames.has(bare)
        ? { ...exp, blocked: 'an unplaceable object shares this name — verify before minting' }
        : exp);
      continue;
    }
    present.push({ ...exp, id: row.id, graphName: row.name });
    if (!parentedIds.has(row.id)) unparented.push({ ...exp, id: row.id, graphName: row.name });
  }

  const byState = {};
  for (const exp of expected) {
    const s = (byState[exp.stateCode] ||= { expected: 0, missing: 0, unparented: 0 });
    s.expected++;
  }
  for (const m of missing) byState[m.stateCode].missing++;
  for (const u of unparented) byState[u.stateCode].unparented++;

  return {
    missing,
    unparented,
    present,
    unplaceable,
    coverage: expected.length ? present.length / expected.length : 1,
    byState,
  };
}

// ---------------------------------------------------------------------------------------------
// Census — the same read I had been doing by hand every time
// ---------------------------------------------------------------------------------------------

/**
 * @param typeCounts    [{ entity_type, n }]
 * @param isolatedCounts [{ entity_type, n }]  entities with NO live edge
 * @returns rows sorted by how BROKEN they are, not by how big — the ranking that actually surfaced
 *          events (77% isolated at only 1,641 objects) above bill (2% at 1.49M).
 */
function rankTypeHealth(typeCounts = [], isolatedCounts = []) {
  const iso = new Map(isolatedCounts.map((r) => [r.entity_type, r.n]));
  return typeCounts
    .map((r) => {
      const isolated = iso.get(r.entity_type) || 0;
      return {
        entityType: r.entity_type,
        total: r.n,
        isolated,
        isolatedPct: r.n ? isolated / r.n : 0,
      };
    })
    .sort((a, b) => b.isolatedPct - a.isolatedPct || b.isolated - a.isolated);
}

// ---------------------------------------------------------------------------------------------
// The beat
// ---------------------------------------------------------------------------------------------

/**
 * A graph-integrity beat for one state's county tier. Same descriptor shape beats.js produces, so
 * the scheduler and coverage maths need no special case.
 *
 * `enumerate()` takes the live graph snapshot and returns REPAIR targets — it is a closure over the
 * diff rather than a static roster, because the universe is "what is still wrong", which shrinks as
 * the repairs land. Coverage therefore reads as actual graph health, not as work performed.
 */
function countyIntegrityBeat(stateCode, snapshotFn) {
  const code = String(stateCode || '').toUpperCase();
  const st = US_COUNTIES[code];
  const stateName = (st && st.name) || code;
  const noun = (st && st.noun) || 'county';
  const total = ((st && st.counties) || []).length;
  return {
    id: `graph-integrity-counties-${code.toLowerCase()}`,
    parentBeat: 'graph-integrity',
    kind: 'integrity',
    stateCode: code,
    depth: 'assert',                 // no research — assert from bundled authoritative data
    goal: `Every one of the ${total} ${noun === 'parish' ? 'parishes' : `${noun}s`} in ${stateName} `
      + `exists as a place object and is attached to ${stateName}. Census gazetteer is the authority; `
      + `nothing here is researched or guessed.`,
    enumerate: () => {
      const snap = typeof snapshotFn === 'function' ? snapshotFn() : snapshotFn;
      if (!snap) return [];
      const d = diffCounties(snap);
      return [
        ...d.missing.filter((m) => m.stateCode === code)
          .map((m) => (m.blocked
            ? { action: 'verify', name: m.mintName, county: m.name, stateCode: code, why: m.blocked }
            : { action: 'mint', name: m.mintName, county: m.name, stateCode: code })),
        ...d.unparented.filter((m) => m.stateCode === code)
          .map((m) => ({ action: 'parent', id: m.id, name: m.graphName, stateCode: code })),
      ];
    },
    universeSize: () => total,
  };
}

function countyIntegritySubBeats(snapshotFn) {
  return Object.keys(US_COUNTIES).sort().map((c) => countyIntegrityBeat(c, snapshotFn));
}

module.exports = {
  stripQid,
  normName,
  countyKey,
  expectedCounties,
  diffCounties,
  rankTypeHealth,
  countyIntegrityBeat,
  countyIntegritySubBeats,
};
