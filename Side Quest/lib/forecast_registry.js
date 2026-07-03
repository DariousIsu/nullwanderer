/**
 * lib/forecast_registry.js — the RACE REGISTRY: forecasting's LOCAL working slate (read-only re: Echo).
 *
 * Per the memory-flow law (Lucas 2026-07-03): the slate is forecasting-LOCAL, built from forecasting's OWN
 * connectors (VoteHub /subjects = races, poll_type = office), then ENRICHED by READING matching Echo objects
 * (never writing them). A race here is the sim/reactor-ready skeleton { id, chamber, office, geo, entities }
 * — margins/sigmas come later from poll_average; candidates/context come from Echo enrichment. PURE builders
 * + an injected read-only `resolve` for enrichment. Fail-soft. No Echo writes, ever.
 */
'use strict';

// poll_type → office + chamber (null = not a race, e.g. approval/favorability/generic-ballot)
const OFFICE = {
  'us-senator': { office: 'U.S. Senate', chamber: 'senate' },
  'us-representative': { office: 'U.S. House', chamber: 'house' },
  'governor': { office: 'Governor', chamber: 'governor' },
  'president': { office: 'President', chamber: 'president' },
  'presidential-primary': { office: 'President (primary)', chamber: 'president' },
  'attorney-general': { office: 'Attorney General', chamber: 'attorney-general' },
  'mayor': { office: 'Mayor', chamber: 'mayor' },
  'proposition-50': { office: 'Ballot Measure', chamber: 'measure' },
  favorability: null, approval: null, 'generic-ballot': null,
};

const STATE_ABBR = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'district of columbia': 'DC' };
const ABBR_SET = new Set(Object.values(STATE_ABBR));

// parse a VoteHub subject → { year?, state?, stateAbbr?, district?, place? }
function parseSubject(subject) {
  const s = String(subject || '').trim();
  const ym = s.match(/^(\d{4})\s+(.+)$/);
  const year = ym ? Number(ym[1]) : null;
  const rest = (ym ? ym[2] : s).trim();
  const dm = rest.match(/^([A-Za-z]{2})[-\s](\d{1,2})$/);              // "NH-02" / "AZ 06"
  if (dm && ABBR_SET.has(dm[1].toUpperCase())) return { year, stateAbbr: dm[1].toUpperCase(), district: Number(dm[2]) };
  const low = rest.toLowerCase();
  if (STATE_ABBR[low]) return { year, state: rest, stateAbbr: STATE_ABBR[low] };
  if (ABBR_SET.has(rest.toUpperCase()) && rest.length === 2) return { year, stateAbbr: rest.toUpperCase() };
  return { year, place: rest };
}

// one race skeleton from (subject, pollType). null if pollType isn't a race.
function raceFromSubject(subject, pollType) {
  const off = OFFICE[pollType];
  if (!off) return null;
  const p = parseSubject(subject);
  const isDistrict = p.district != null;
  const chamber = isDistrict ? 'house' : off.chamber;
  const geo = isDistrict ? `${p.stateAbbr}-${String(p.district).padStart(2, '0')}` : (p.state || p.stateAbbr || p.place || '');
  const entities = [...new Set([geo, p.state, off.office, String(subject).replace(/^\d{4}\s+/, '')].filter(Boolean))];
  return {
    id: `${geo || subject}:${pollType}`.replace(/\s+/g, '-'),
    subject: String(subject), poll_type: pollType,
    office: off.office, chamber,
    state: p.state || p.stateAbbr || null, district: p.district != null ? p.district : null, geo,
    entities,
    echo_ref: null,      // filled read-only by enrich()
  };
}

// A party-PRIMARY subject (same-party contest), not a D-vs-R general — VoteHub encodes these as a trailing
// party word, e.g. "2026 Texas Democratic" / "2026 Texas Republican". These must NOT feed the general-election
// balance (both candidates are the same party); they belong to the future primary→general cascade instead.
function isPrimarySubject(subject) {
  return /\b(democratic|republican|gop|libertarian|green|independent)\b\s*(primary)?\s*$/i.test(String(subject == null ? '' : subject).trim());
}

// build the slate from VoteHub /subjects rows [{subject, poll_types:[…]}]. opts.pollTypes filters offices.
function buildSlate(subjects, { pollTypes = null } = {}) {
  const out = [];
  for (const s of (Array.isArray(subjects) ? subjects : [])) {
    const pts = ((s && s.poll_types) || []).filter((pt) => OFFICE[pt] && (!pollTypes || pollTypes.includes(pt)));
    for (const pt of pts) { const r = raceFromSubject(s.subject, pt); if (r) out.push(r); }
  }
  return out;
}

// READ-ONLY enrichment: resolve a matching Echo object (candidate/state) and attach a POINTER. Never writes.
// `resolve(name)` = injected echo_suit.resolveMention/recallObject-style reader → { id, name, type } | null.
async function enrich(race, { resolve } = {}) {
  if (typeof resolve !== 'function' || !race) return race;
  try {
    const obj = (await resolve(race.subject)) || (race.state ? await resolve(race.state) : null);
    if (obj && obj.id != null) return { ...race, echo_ref: obj.id, echo: { name: obj.name || null, type: obj.type || null } };
  } catch { /* read-only, fail-soft */ }
  return race;
}

// live: VoteHub /subjects → slate. `fetchSubjects` injected (poll_votehub.fetchSubjects). Fail-soft → [].
async function fetchSlate({ fetchSubjects, pollTypes = null } = {}) {
  if (typeof fetchSubjects !== 'function') return [];
  try { const r = await fetchSubjects(); return buildSlate((r && r.subjects) || [], { pollTypes }); }
  catch { return []; }
}

module.exports = { OFFICE, STATE_ABBR, parseSubject, raceFromSubject, isPrimarySubject, buildSlate, enrich, fetchSlate };
