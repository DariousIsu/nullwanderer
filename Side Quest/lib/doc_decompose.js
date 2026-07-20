/**
 * lib/doc_decompose.js — DOCUMENT DECOMPOSITION for the curation substrate (Slice 2; see
 * docs/CURATION_SUBSTRATE_DESIGN.md). Breaks a document into its constituent TYPED objects
 * (person / event / location / organization …) + the typed relations among them, so a dead-end
 * document leaf becomes a subgraph of the real entities it describes.
 *
 * Unlike the old lib/graph_extract (generic UNTYPED triples → the LOCAL graph_memory, un-gated), this
 * feed emits TYPED constituents cited to the document, to be disambiguated (2b), gated (curation_gate),
 * observed (curation_store), and proposed to ECHO (2c) — the same substrate the idle graph-walk uses.
 *
 * THIS FILE = Split-1 / sub-slice 2a: the PURE pieces (prompt, parser, hybrid merge). No I/O, no model,
 * no db — exhaustively offline-smoke-testable. Disambiguation + gate + Echo wiring land in 2b/2c.
 *
 * Citation model: the DOCUMENT is the single source of every claim it yields (grade B — "directly
 * stated in a named source"). So there are no per-claim [S#] refs like the multi-source dossier; the
 * doc's own ref/url is attached uniformly downstream. The constrained prompt ("only what the text
 * states, do not infer") is what keeps a B-graded claim honest.
 */
'use strict';

const CG = require('./curation_gate');   // the shared two gates (existence + fact), doc = grade B
const corroboration = require('./corroboration');     // C2 — independent-source counting (mirror-collapsed)
const confModel = require('./confidence_model');      // C3 — calibrated, corroboration-sensitive confidence
const identityGate = require('./identity_gate');      // F1 — mint-reluctance + contextual bind + attractor guard
const SUB = require('./substantiation');              // Slice 2 — substantiation_state/frame tags on minted endpoints

// Closed entity-type vocab, aligned with Echo's types. Anything unrecognized → 'other' (still a real
// object, just untyped — the richness axis, not the reality axis). Normalizes common model synonyms.
// Aligned with Echo's entity vocab (list_entity_types). Includes the CIVIC reference types the resolver
// must be able to target so a body-membership edge resolves to the OFFICE/COMMITTEE, not a same-token PAC.
const ENTITY_TYPES = ['person', 'organization', 'location', 'event', 'work', 'concept', 'bill', 'document', 'office_held', 'committee', 'government_body', 'other'];
const TYPE_SYNONYM = {
  people: 'person', per: 'person', human: 'person', individual: 'person',
  org: 'organization', organisation: 'organization', company: 'organization', agency: 'organization', institution: 'organization', group: 'organization',
  place: 'location', gpe: 'location', loc: 'location', city: 'location', country: 'location', state: 'location', region: 'location',
  law: 'bill', legislation: 'bill', act: 'bill',
  doc: 'document', article: 'document', paper: 'document',
  creativework: 'work', book: 'work',
  office: 'office_held', officeheld: 'office_held', position: 'office_held', seat: 'office_held', post: 'office_held',
  legislature: 'government_body', chamber: 'government_body', governmentbody: 'government_body', govbody: 'government_body',
  subcommittee: 'committee',
  // Phase C: topical concepts/subjects/ideas → the lazy concept lane (buffer→corroborate→promote+attach)
  topic: 'concept', subject: 'concept', theme: 'concept', idea: 'concept', field: 'concept', policy: 'concept', issue: 'concept', movement: 'concept',
};
function canonType(t) {
  const raw = String(t == null ? '' : t).toLowerCase().trim();
  if (!raw) return 'other';
  const under = raw.replace(/[\s-]+/g, '_');        // "office held" / "office-held" → office_held (keep multi-word civic types)
  if (ENTITY_TYPES.includes(under)) return under;
  const k = raw.replace(/[^a-z]/g, '');             // fully stripped → single-word types + synonym lookup
  if (ENTITY_TYPES.includes(k)) return k;
  return TYPE_SYNONYM[k] || 'other';
}

// Typed relation vocab (superset of graph_extract's, kept UPPER_SNAKE for clean Echo federation).
const REL_VOCAB = [
  'WORKS_FOR', 'PART_OF', 'LOCATED_IN', 'RELATED_TO', 'CREATED', 'LEADS', 'MEMBER_OF', 'FOCUSES_ON',
  'REGULATES', 'FUNDS', 'OPPOSES', 'SUPPORTS', 'MET_WITH', 'RESPONSIBLE_FOR', 'SUCCEEDS', 'PRECEDES',
  'CITES', 'SPONSORED', 'AFFECTS', 'BORN_IN', 'DIED_IN', 'MARRIED_TO', 'PARENT_OF', 'FOUNDED',
  'REPRESENTED', 'APPOINTED', 'ATTENDED', 'PARTICIPATED_IN',
];

// A field is a NAMED ENTITY, not a pronoun / sentence / clause. Mirrors graph_extract's slop rejection.
const PRONOUN = /^(it|he|she|they|them|this|that|these|those|the text|we|i|you|his|her|their|its|our|your)$/i;
function badField(x) {
  const s = String(x == null ? '' : x).trim();
  if (!s) return true;
  if (s.length > 60) return true;                 // a sentence, not an entity
  if (s.split(/\s+/).length > 6) return true;
  if (PRONOUN.test(s)) return true;
  return false;
}
const stripLead = (s) => String(s == null ? '' : s).trim().replace(/^[-*\d.)\s]+/, '').trim();

// Build the typed-extraction prompt. Emits two line kinds so a small model has a rigid target:
//   ENTITY: <name> :: <type>
//   REL: <source> | <RELATION> | <target>
function buildTypedPrompt(text, { title = null } = {}) {
  const head = title ? `Document title: ${title}\n\n` : '';
  return [{
    role: 'user',
    content:
`From the document BELOW, extract the real-world OBJECTS it names and the relationships it STATES between them.
Output ONLY these two line kinds, nothing else:
ENTITY: <name> :: <type>
REL: <source> | <RELATION> | <target> | <when>

<type> is one of: ${ENTITY_TYPES.join(', ')} (use "other" if unsure).
Use "concept" for an abstract topic, policy area, field, or named idea/movement (e.g. "artificial intelligence", "permitting reform", "monetary policy", "election security") — NEVER for a person, organization, or place.
<RELATION> is UPPER_SNAKE from: ${REL_VOCAB.join(', ')} (use RELATED_TO if none fit).
<when> is the year or year-range the text says this became/was true (e.g. "2023", "2015–2019", "since 2020"). Leave it EMPTY if the text gives no date — never guess a date.
Names must be CONCRETE NAMED ENTITIES (a person, org, place, event, bill) — never a pronoun, never a whole sentence.
Only what the text STATES — do NOT infer, generalize, or invent. Every REL's source and target should also appear as an ENTITY line.
Max 20 ENTITY lines and 20 REL lines. If there are none, output exactly: NONE

${head}DOCUMENT:
${String(text || '').slice(0, 6000)}`
  }];
}

// Parse a valid-time hint the model emits on a REL line ("became true when") into
// {valid_from, valid_to} as 4-digit YEARS (int) or null. Only the LLM can read this
// from prose ("became CEO in 2023", "served 2015–2019", "since 2020", "until 2019");
// it is the enabler Step-3 supersession needs (valid-time overlap, not ingest clock).
// C1 (see docs/AUTONOMOUS_SELF_CURATING_DB_ARCHITECTURE.md §7d front).
function _parseValidTime(s) {
  const str = String(s == null ? '' : s).trim();
  if (!str) return { valid_from: null, valid_to: null };
  const yr = (x) => { const n = parseInt(x, 10); return (n >= 1000 && n <= 3000) ? n : null; };
  let m;
  if ((m = /(\d{4})\s*(?:[-–—]|to|until|through|thru)\s*(\d{4})/i.exec(str))) return { valid_from: yr(m[1]), valid_to: yr(m[2]) };
  if ((m = /\b(?:since|from|as of|beginning|starting)\b[^\d]*(\d{4})/i.exec(str))) return { valid_from: yr(m[1]), valid_to: null };
  if ((m = /\b(?:until|to|through|ended?)\b[^\d]*(\d{4})/i.exec(str))) return { valid_from: null, valid_to: yr(m[1]) };
  if ((m = /(\d{4})/.exec(str))) return { valid_from: yr(m[1]), valid_to: null };   // a bare year → validity start
  return { valid_from: null, valid_to: null };
}

// Parse the model output into { entities:[{name,type}], relations:[{source,relation,target,valid_from,valid_to}] }.
// Rejects slop (pronouns, sentences, malformed relations). Dedups entities by lowercased name. Caps volume.
// REL lines carry an OPTIONAL 4th pipe field — the valid-time the text states — parsed to years.
function parseTypedExtraction(raw, { maxEntities = 25, maxRelations = 25 } = {}) {
  const entities = [], relations = [];
  const seenE = new Set(), seenR = new Set();
  for (const line of String(raw == null ? '' : raw).split('\n')) {
    const L = line.trim();
    if (!L) continue;
    let m;
    if ((m = /^ENTITY\s*:\s*(.+?)\s*::\s*(.+)$/i.exec(L))) {
      if (entities.length >= maxEntities) continue;
      const name = stripLead(m[1]);
      if (badField(name)) continue;
      const k = name.toLowerCase();
      if (seenE.has(k)) continue;
      seenE.add(k);
      entities.push({ name, type: canonType(m[2]) });
    } else if ((m = /^REL\s*:\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*(.*))?$/i.exec(L))) {
      if (relations.length >= maxRelations) continue;
      const source = stripLead(m[1]);
      const relation = String(m[2]).trim().toUpperCase().replace(/\s+/g, '_');
      const target = stripLead(m[3]);
      if (badField(source) || badField(target)) continue;
      if (!/^[A-Z][A-Z_]+$/.test(relation)) continue;
      const rk = `${source.toLowerCase()}|${relation}|${target.toLowerCase()}`;
      if (seenR.has(rk)) continue;
      seenR.add(rk);
      const { valid_from, valid_to } = _parseValidTime(m[4]);   // optional 4th field; null when absent
      relations.push({ source, relation, target, valid_from, valid_to });
    }
  }
  return { entities, relations };
}

// Light core-name key for the HYBRID merge dedup (strip brackets/paren-qualifiers/ids/punct, drop
// middle initials). Deliberately simpler than echo_suit._coreNameKey — the AUTHORITATIVE resolution is
// resolveMention in 2b; this only collapses obvious dups when unioning two extraction sources.
function coreKey(name) {
  let s = String(name == null ? '' : name).toLowerCase();
  s = s.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9\s]/g, ' ');
  const toks = s.split(/\s+/).filter(t => t && t.length > 1 && !/\d/.test(t));
  return toks.sort().join(' ').trim();
}

// HYBRID candidate merge (fork-1: Echo's extract_entities_from_doc surfaces candidates; our typed
// extraction supplies types + relations). Union the two entity lists, dedup by coreKey, and PREFER a
// specific (non-'other') type over 'other'. Each survivor is tagged with where it came from (`via`:
// 'both' | 'local' | 'echo') so 2c can weight/trust accordingly. Echo candidates carry no relations.
// Pure. `local`/`echo` are [{name, type?}].
function mergeCandidates(local = [], echo = []) {
  const byKey = new Map();
  const add = (e, src) => {
    const name = stripLead(e && e.name);
    if (!name || badField(name)) return;
    const key = coreKey(name) || name.toLowerCase();
    const type = canonType(e && e.type);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { name, type, via: src });
      return;
    }
    // merge: prefer a specific type; prefer the longer/fuller surface name; mark seen-by-both
    if (existing.type === 'other' && type !== 'other') existing.type = type;
    if (name.length > existing.name.length) existing.name = name;
    if (existing.via !== src) existing.via = 'both';
  };
  for (const e of (Array.isArray(local) ? local : [])) add(e, 'local');
  for (const e of (Array.isArray(echo) ? echo : [])) add(e, 'echo');
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// 2b — DISAMBIGUATION-ON-INGEST. Turn each extracted entity into an ingest DECISION by resolving it
// against Echo (echo_suit.resolveMention, injected as `resolve` → offline-testable). The resolver's 4
// states map to 4 actions:
//   resolved  → REUSE the existing node (mint NOTHING — this is the dup-prevention the design is about:
//               an extracted "Woodrow Wilson" attaches to the existing person, not a 4th duplicate)
//   nil       → MINT a new object (existence-gated in 2c by the document citation, grade B ≥ C floor)
//   ambiguous → HOLD (bias-to-clarify: >1 genuinely-different candidate → don't popularity-guess)
//   error     → SKIP (Echo unavailable this pass)
// Pure w.r.t. the injected resolver. Never throws.
async function resolveExtracted(entity, { resolve, context = null } = {}) {
  const name = stripLead(entity && entity.name);
  const type = canonType(entity && entity.type);
  if (!name || badField(name)) return { action: 'skip', name, type, reason: 'bad-name' };
  if (typeof resolve !== 'function') return { action: 'skip', name, type, reason: 'no-resolver' };
  const preferType = type !== 'other' ? type : null;
  let r;
  // context = the doc's OTHER entities, so an ambiguous candidate can be disambiguated by co-occurrence.
  try { r = await resolve(name, { preferType, context }); } catch { return { action: 'skip', name, type, reason: 'resolver-threw' }; }
  const status = r && r.status;
  if (status === 'resolved') return { action: 'reuse', name, type, object: r.object, canonical: (r.object && r.object.name) || name };
  if (status === 'nil') {
    // F1 MINT-RELUCTANCE: the resolver found no existing node. A STRONG reference (full name / strong-id /
    // non-person) may mint. A WEAK person reference (bare first name, or first-name + descriptor) must NOT
    // mint a durable node — it binds to a full-name person already present in the doc's context, else HOLDS
    // provisional. This is the "Tracy the finance lady" fix: no spurious node → no future-mention attractor.
    const g = identityGate.mintDecision('nil', name, type, { context: context || [] });
    if (g.action === 'bind-context') return { action: 'reuse', name, type, canonical: g.canonical, via: 'context' };
    if (g.action === 'hold') return { action: 'hold', name, type, candidates: [], reason: g.reason, provisional: !!g.provisional };
    return { action: 'mint', name, type };                 // strong reference → mint (existence-gated in 2c)
  }
  if (status === 'ambiguous') return { action: 'hold', name, type, candidates: r.candidates || [], reason: r.reason || 'ambiguous' };
  return { action: 'skip', name, type, reason: (status || 'error') };
}

// Batch-resolve extracted entities → { decisions, byKey, tally }. `byKey` is keyed by coreKey so a
// relation endpoint can look up its entity's decision (2c only proposes a relation when BOTH endpoints
// reuse-or-mint; a hold/skip endpoint means we don't know which node, so the edge waits). Never throws.
async function planEntities(entities, { resolve, context = null } = {}) {
  const decisions = [], byKey = new Map();
  const tally = { reuse: 0, mint: 0, hold: 0, skip: 0 };
  for (const e of (Array.isArray(entities) ? entities : [])) {
    const d = await resolveExtracted(e, { resolve, context });
    decisions.push(d);
    byKey.set(coreKey(d.name) || d.name.toLowerCase(), d);
    tally[d.action] = (tally[d.action] || 0) + 1;
  }
  return { decisions, byKey, tally };
}

// ---------------------------------------------------------------------------
// 2c — THE DRIVER. Decompose ONE document into Echo, through the hybrid extractor → disambiguation →
// the two gates → the observation store. The shared machine every per-stream inline hook (Split 2)
// will call with its own injected `extract` (stream-specific guidelines).
//
// `doc` = { text, url (THE citation), title? }. Deps (all injected → offline-testable):
//   extract    (text) → { entities, relations }          the per-stream TYPED extractor
//   echoExtract(doc)  → [{name,type?}]  (optional)        HYBRID: Echo's candidate entities
//   resolve    (name,{preferType}) → resolveMention result   disambiguation (echo_suit.resolveMention)
//   dispatch   (tag)  → {ok}                              Echo propose_entity/propose_relation
//   observe    (o)    → void                              curation_store sink (caller feed-tags)
//   cap = { entities, relations }                         per-doc volume discipline
//
// Citation is UNIFORM: the document is the single source of every claim it yields (grade B — stated in
// a named source), so the gate is fed a one-source list [{url}] with ref 'S1'. FALL-THROUGHS — an
// `ambiguous` entity or a relation whose endpoint didn't cleanly resolve — are recorded as HELD (the
// queue the hourly "standard upgrade pass" re-attempts). Returns tallies. Never throws.
// ---------------------------------------------------------------------------
// STATE-ALIAS NORMALIZATION. An extractor emits both "North Carolina" (a senator REPRESENTED it) and the
// abbreviation "NC" (an address LOCATED_IN it) → two separate location nodes for one place. USPS state
// codes are a fixed, well-known set, so expand them to canonical full names. SAFETY: expand a code only
// when it appears as a GEOGRAPHIC-relation endpoint (LOCATED_IN / REPRESENTED / BORN_IN / …) — that context
// is what tells "OR"/"IN"/"OK"/"ME"/"DE" (Oregon/Indiana/… but also common words) apart from prose. Pure.
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia', PR: 'Puerto Rico',
};
const PLACE_REL = /^(LOCATED_IN|REPRESENTED|BORN_IN|DIED_IN|BASED_IN|HEADQUARTERED_IN|REPRESENTS)$/;
// A bare USPS state code ("NC", "N.C.", "n.c.") → its full name; else null.
function stateFull(name) {
  const k = String(name == null ? '' : name).toUpperCase().replace(/[.\s]/g, '');
  return (k.length === 2 && US_STATES[k]) ? US_STATES[k] : null;
}
// Expand state codes that appear as geographic-relation endpoints, everywhere they occur (entities +
// relations), and ensure the canonical state is a location entity — so "NC" and "North Carolina" unify.
function normalizeStateAliases(entities, relations) {
  const rename = new Map();   // lc code → full name (only for codes seen in a place relation)
  for (const r of (Array.isArray(relations) ? relations : [])) {
    if (!PLACE_REL.test(String((r && r.relation) || '').toUpperCase())) continue;
    for (const nm of [r && r.source, r && r.target]) { const full = stateFull(nm); if (full) rename.set(String(nm).trim().toLowerCase(), full); }
  }
  if (!rename.size) return { entities: entities || [], relations: relations || [] };
  const fix = (nm) => rename.get(String(nm == null ? '' : nm).trim().toLowerCase()) || nm;
  const newRels = (relations || []).map(r => ({ ...r, source: fix(r && r.source), target: fix(r && r.target) }));
  // rewrite entities, then DEDUP by name (renaming NC→North Carolina can collide with an existing one).
  const remapped = (entities || []).map(e => { const f = rename.get(String((e && e.name) || '').trim().toLowerCase()); return f ? { name: f, type: 'location' } : e; });
  for (const full of rename.values()) remapped.push({ name: full, type: 'location' });   // ensure canonical present
  const byName = new Map();
  for (const e of remapped) {
    const k = String((e && e.name) || '').trim().toLowerCase();
    if (!k) continue;
    const prev = byName.get(k);
    if (!prev) byName.set(k, e);
    else if (prev.type === 'other' && e.type && e.type !== 'other') byName.set(k, e);   // prefer a specific type
  }
  return { entities: [...byName.values()], relations: newRels };
}

// Phase C: lazy concept mint via the Echo resolve_or_mint_concept tool. Returns the status string
// (minted|already_seen|corroborating|promoted|existing_live) or null on failure. Fail-soft.
async function _mintConcept(dispatch, name, source) {
  try {
    const r = await dispatch({ kind: 'do', name: 'resolve_or_mint_concept', args: { name, source: source || 'doc', summary: '' } });
    if (!r || !r.ok) return null;
    const obj = JSON.parse(r.text || '{}');
    return (obj && obj.status) || null;
  } catch { return null; }
}

async function _proposeEntity(dispatch, name, entity_type, summary) {
  try { const r = await dispatch({ kind: 'do', name: 'propose_entity', args: { name, entity_type: entity_type || 'other', summary: summary || '' } }); return !!(r && r.ok); } catch { return false; }
}
async function _proposeRelation(dispatch, source, target, relation_type, confidence, metadata) {
  try {
    const args = { source_name: source, target_name: target, relation_type: relation_type || 'related_to' };
    if (typeof confidence === 'number') args.confidence = confidence;       // graded, not the flat 0.8 default
    if (metadata) args.relation_metadata = JSON.stringify(metadata);        // provenance (url/grade) on the edge
    const r = await dispatch({ kind: 'do', name: 'propose_relation', args });
    return !!(r && r.ok);
  } catch { return false; }
}

// A legislative-body membership edge (WORKS_FOR/MEMBER_OF to a body) must NEVER
// resolve its target to an FEC committee/PAC. FEC committees carry a trailing
// "[C0…]" / "[FEC:C0…]" id tag; state chambers read as "… Senate/House/Assembly".
// When the ORIGINAL target names a chamber but the RESOLVED target is an FEC
// committee, the resolver stretched a generic "State Senate"/"House" token onto
// a same-token PAC — the hub-collision bug. Detect and HOLD it.
const _FEC_COMMITTEE_RE = /\[(?:FEC:)?C\d{7,}\]/i;
const _LEGIS_BODY_RE = /\b(senate|house of representatives|house|assembly|legislature|general assembly|delegates|city council|county commission|board of supervisors)\b/i;
const _COMMITTEE_RE = /\b(committee|subcommittee)\b/i;
function _isFecCommittee(name) { return _FEC_COMMITTEE_RE.test(String(name || '')); }
function _isLegisBody(name) { return _LEGIS_BODY_RE.test(String(name || '')); }
function _isCommittee(name) { return _COMMITTEE_RE.test(String(name || '')); }

// Predicates whose TARGET is an organization/body the SOURCE belongs to or structures under
// (membership / employment / org structure). Their target is inferred an organization-family type.
const ORG_TARGET_REL = /^(WORKS_FOR|EMPLOYED_BY|MEMBER_OF|MEMBER_OF_ORG|PART_OF|SUBSIDIARY_OF|AFFILIATE_OF|FOUNDED|LEADS|DIRECTED_BY)$/;
// The subset that asserts a person HOLDS A SEAT / is a member of a body or committee.
const BODY_MEMBERSHIP_REL = /^(MEMBER_OF|MEMBER_OF_ORG|WORKS_FOR|EMPLOYED_BY)$/;
// Civic REFERENCE entities (offices, committees, bodies) are canonical reference data — resolve to an
// EXISTING one or HOLD; never MINT them from a prose mention (a bare "Ohio Senate" office would be a
// QID-less dup that fragments the graph). Keyed by the resolver's expected target types.
const REFERENCE_TYPES = new Set(['office_held', 'committee', 'government_body']);

// SLICE 2: which unresolved (ambiguous/nil) endpoints may be MINTED UNSUBSTANTIATED so their edge lands.
// KNOWN CONCRETE NON-PERSON types only — deliberately EXCLUDES 'person' (attractor guard) AND 'other' (the
// type endpoint-recovery assigns a bare edge endpoint, which could be a bare-name person like "Tracy"). So
// an org/place/office/committee/body/event/work/bill/document endpoint mints; a person or an untyped 'other'
// stays HELD (bias-to-clarify — never guess a node into being for something we can't even type).
const UNSUB_MINTABLE_TYPES = new Set(['organization', 'location', 'event', 'office_held', 'committee', 'government_body', 'work', 'bill', 'document']);

// RELATION SIGNATURE (domain/range typing — the anti-mis-resolution lever). Given a relation type and its
// target's surface name, return the expected TARGET entity_type so resolution is TYPE-CONSTRAINED:
//   • a body-membership edge to a legislative chamber → 'office_held' (the person HELD_OFFICE that seat),
//     NOT a same-token FEC PAC (which is an 'organization') — this was the hub-collision bug.
//   • a membership edge to a committee → 'committee'.
//   • generic org membership / employment → 'organization' (a company, or a PAC named as an employer).
// Returns null → leave untyped ('other') for an unconstrained search.
function targetTypeFor(relType, targetName) {
  const R = String(relType || '').toUpperCase();
  if (BODY_MEMBERSHIP_REL.test(R)) {
    // Committee is the MORE SPECIFIC type — check it first, since a committee name often contains a
    // chamber token ("Senate Judiciary Committee", "House Ways and Means Committee").
    if (_isCommittee(targetName)) return 'committee';
    if (_isLegisBody(targetName)) return 'office_held';
    return 'organization';
  }
  if (ORG_TARGET_REL.test(R)) return 'organization';
  return null;
}
// The graph's CANONICAL predicate for a resolved legislative-body membership is HELD_OFFICE (person →
// office_held; ~52k existing edges). Normalize a body-membership relation to it so the edge MERGES with
// that pattern instead of forking a parallel MEMBER_OF→office representation. Committee membership stays
// MEMBER_OF (the graph's canonical committee predicate).
function normalizedRelation(relType, targetName) {
  const R = String(relType || '').toUpperCase();
  // Only a CHAMBER membership becomes HELD_OFFICE; a committee (even one named "… Senate … Committee")
  // stays MEMBER_OF, the graph's canonical committee predicate.
  if (BODY_MEMBERSHIP_REL.test(R) && _isLegisBody(targetName) && !_isCommittee(targetName)) return 'HELD_OFFICE';
  return relType;
}
async function _observe(observe, o) { if (typeof observe === 'function') { try { await observe(o); } catch {} } }

// SLICE 2 (endpoint-minting, docs/SUBSTANTIATION_IMPL_PLAN.md). Mint an unresolved edge endpoint as an
// UNSUBSTANTIATED node so its edge can LAND instead of holding forever (the 72.8k unresolved-endpoint pile).
// It's proposed to Echo like any mint (a staged proposal, not canonical), but recorded with
// substantiation_state='unsubstantiated' — it stays prove-or-fade: the async lane (Slice 4) resolves it
// against wiki/web (→ identity-confirmed, promotes) or it fades (Slice 6, TTL→archive). This is what lets a
// "…WORKS_FOR Sheriff's Office" edge form now, with the office marked not-yet-substantiated, rather than
// dropping the whole relation. Returns true when the node was proposed (caller adds it to `usable`).
async function _mintUnsubstantiated(dispatch, observe, name, type, url) {
  if (!await _proposeEntity(dispatch, name, type, '')) return false;
  await _observe(observe, { sourceEntity: name, relation: 'exists', target: null, url, grade: 'D', confidence: 0, status: 'promoted', substantiationState: SUB.UNSUBSTANTIATED, frame: SUB.FRAME_REAL });
  return true;
}

async function decomposeDoc(doc = {}, deps = {}) {
  const { extract, echoExtract, resolve, dispatch, observe, cap = {}, log } = deps;
  const text = String(doc.text || '');
  const url = doc.url || null;
  const maxEnt = cap.entities || 20, maxRel = cap.relations || 20;
  const out = { minted: 0, reused: 0, connections: 0, held: 0, ambiguous: 0, skipped: 0, minted_unsub: 0, related: [] };
  if (!url) return { ...out, reason: 'no-citation' };       // requires-citation: no doc url → nothing lands
  if (!text.trim()) return { ...out, reason: 'empty-text' };
  const docSources = [{ url }];                              // the doc IS the citation (grade B)

  // 1) per-stream extract + hybrid Echo candidates → merged typed entity set
  let ex;
  try { ex = (await extract(text, { title: doc.title })) || { entities: [], relations: [] }; }
  catch (e) { log && log('[doc-decomp] extract failed: ' + (e && e.message)); return { ...out, reason: 'extract-failed' }; }
  // normalize state-code aliases (NC → North Carolina) before resolution, so abbreviation + full name
  // don't split into two location nodes.
  const _norm = normalizeStateAliases(Array.isArray(ex.entities) ? ex.entities : [], Array.isArray(ex.relations) ? ex.relations : []);
  const entities = _norm.entities;
  const relations = _norm.relations;
  let echoCands = [];
  if (typeof echoExtract === 'function') { try { echoCands = (await echoExtract(doc)) || []; } catch {} }
  const merged = mergeCandidates(entities, echoCands);

  // 1b) ENDPOINT RECOVERY — a relation's source/target is an entity too. If the extractor named one only
  // as an edge endpoint (never as its own ENTITY line — e.g. a roster's "…WORKS_FOR Rainey Center" where
  // the org header was never listed), fold it in so it resolves (mint/reuse/hold) instead of auto-holding
  // every edge to it. The TARGET's type is inferred from the RELATION SIGNATURE (targetTypeFor) — a body
  // membership → office_held, a committee → committee, a generic org → organization — so resolution is
  // type-constrained and a same-token wrong-type match (a bill summary, or an FEC PAC) can't leak in.
  const haveKey = new Set(merged.map(e => coreKey(e.name) || String(e.name).toLowerCase()));
  for (const r of relations) {
    const relType = String((r && r.relation) || '').toUpperCase();
    const endpoints = [
      { name: r && r.source, type: 'other' },
      { name: r && r.target, type: targetTypeFor(relType, r && r.target) || 'other' },
    ];
    for (const ep of endpoints) {
      const name = String(ep.name == null ? '' : ep.name).trim();
      if (!name || badField(name)) continue;
      const k = coreKey(name) || name.toLowerCase();
      if (haveKey.has(k)) continue;
      haveKey.add(k);
      merged.push({ name, type: ep.type });
    }
  }

  // 2a) CONCEPTS split off — topical concepts skip the person-centric resolve/mint/existence gates and go
  // to the LAZY concept lane (resolve_or_mint_concept): buffer on first mention, promote to civic + attach
  // to a focal well only after a SECOND independent doc corroborates (Phase C).
  const conceptCands = merged.filter(e => canonType(e && e.type) === 'concept');
  const resolvable = merged.filter(e => canonType(e && e.type) !== 'concept');

  // 2) disambiguate every entity — the doc's full entity set is the CONTEXT that resolves an ambiguous
  // candidate (e.g. "Rainey Center" among a roster of policy people → the policy org, not the lobbying twin).
  const context = resolvable.map(e => e.name);
  const plan = await planEntities(resolvable, { resolve, context });

  // 3) entities: mint (existence-gated by the doc) / reuse / hold (fall-through) / skip
  const usable = new Map();   // coreKey → the canonical name to use in an edge
  // …and its TYPE. An edge observation that omits the type makes the encounter log key the same
  // object twice — `place:apache county` from its existence claim and `thing:apache county` from
  // its LOCATED_IN edge — which is a split identity, the one failure the merge model cannot survive.
  const usableType = new Map();   // coreKey → the extracted entity type
  for (const d of plan.decisions) {
    const key = coreKey(d.name) || d.name.toLowerCase();
    if (d.action === 'reuse') { usable.set(key, d.canonical || d.name); usableType.set(key, d.type); out.reused++; continue; }
    if (d.action === 'mint') {
      if (out.minted >= maxEnt) continue;                    // volume cap on NEW objects
      // REFERENCE DATA (office/committee/body): used to HOLD to avoid QID-less dups — but that permanent
      // dead-end stranded the membership edge (the dominant slice of the 72.8k unresolved-endpoint pile).
      // Slice 2: MINT it UNSUBSTANTIATED so the edge lands; the async lane resolves it to the canonical
      // office (→ identity-confirmed) or it fades. The anti-dup intent is preserved by the state tag + churn,
      // not a permanent hold. (Reference types are never persons → no attractor risk.)
      if (REFERENCE_TYPES.has(d.type)) {
        if (await _mintUnsubstantiated(dispatch, observe, d.name, d.type, url)) { usable.set(key, d.name); usableType.set(key, d.type); out.minted++; out.minted_unsub++; }
        else { out.held++; await _observe(observe, { sourceEntity: d.name, relation: 'exists', target: null, url, grade: 'D', confidence: 0, status: 'held', type: d.type }); }
        continue;
      }
      // NO topic gate — the graph absorbs every entity a cited doc yields; topic is not a
      // reality/quality axis (the existence gate below is). Off-domain ≠ untrue.
      const eg = CG.gateExistence('S1', docSources);         // doc-cited → grade B ≥ C floor → mint
      if (eg.mint && await _proposeEntity(dispatch, d.name, d.type, '')) {
        usable.set(key, d.name); usableType.set(key, d.type); out.minted++;
        await _observe(observe, { sourceEntity: d.name, relation: 'exists', target: null, url, grade: eg.grade, confidence: eg.confidence, status: 'promoted', type: d.type });
      }
      continue;
    }
    if (d.action === 'hold') {                               // ambiguous / weak-person fall-through
      out.ambiguous++;
      // Slice 2: a KNOWN-CONCRETE-NON-PERSON unresolved endpoint (an org/place/office/event the resolver
      // couldn't pin) mints UNSUBSTANTIATED so its edge lands + the async lane proves-or-fades it. A PERSON
      // or an untyped 'other' endpoint stays HELD — minting a bare/ambiguous person is the "Tracy the finance
      // lady" attractor the identity gate exists to prevent, and 'other' is the type a bare edge-endpoint
      // gets, so it too could be a person. Bias-to-clarify: never guess a node for something we can't type.
      if (UNSUB_MINTABLE_TYPES.has(d.type) && out.minted < maxEnt && await _mintUnsubstantiated(dispatch, observe, d.name, d.type, url)) {
        usable.set(key, d.name); usableType.set(key, d.type); out.minted++; out.minted_unsub++;
      } else {
        out.held++;
        await _observe(observe, { sourceEntity: d.name, relation: 'exists', target: null, url, grade: 'D', confidence: 0, status: 'held', type: d.type });
      }
      continue;
    }
    out.skipped++;                                           // bad-name / resolver error
  }

  // 3b) CONCEPTS — lazy mint-on-mention. source = doc url, so two DIFFERENT docs count as independent
  // corroboration; the 2nd promotes the concept to civic + attaches it to its nearest focal well.
  out.concepts_minted = 0; out.concepts_promoted = 0; out.concepts_seen = 0;
  {
    const seenC = new Set(); const maxConcepts = cap.concepts || 12;
    for (const c of conceptCands) {
      if (out.concepts_minted + out.concepts_promoted >= maxConcepts) break;
      const nm = String((c && c.name) || '').trim(); const ck = nm.toLowerCase();
      if (!nm || seenC.has(ck)) continue; seenC.add(ck);
      const st = await _mintConcept(dispatch, nm, url);
      if (st === 'minted') out.concepts_minted++;
      else if (st === 'promoted') out.concepts_promoted++;
      else if (st) out.concepts_seen++;
    }
  }

  // 4) relations: propose only when BOTH endpoints resolved (reuse/mint); else a HELD fall-through
  for (const r of relations) {
    if (out.connections >= maxRel) break;
    const sName = usable.get(coreKey(r.source) || r.source.toLowerCase());
    const tName = usable.get(coreKey(r.target) || r.target.toLowerCase());
    const relTypeU = String((r && r.relation) || '').toUpperCase();
    // MIS-RESOLUTION GUARD: a body-membership edge whose ORIGINAL target names a
    // legislative chamber but RESOLVED to an FEC committee/PAC is the hub-collision
    // bug (e.g. "…MEMBER_OF Arkansas Senate" → "MR FOR OHIO STATE SENATE [FEC:C0…]").
    // Never forge it — hold for a corrected resolution.
    if (sName && tName && ORG_TARGET_REL.test(relTypeU) && _isLegisBody(r.target) && _isFecCommittee(tName)) {
      out.held++; out.misresolved = (out.misresolved || 0) + 1;
      await _observe(observe, { sourceEntity: sName, relation: r.relation, target: tName, url, grade: 'D', confidence: 0, status: 'held' });
      continue;
    }
    if (sName && tName && sName.toLowerCase() !== tName.toLowerCase()) {
      const fg = CG.gateFact('S1', docSources);              // doc-cited → B → promote
      // PREDICATE NORMALIZATION: a body-membership edge lands as the canonical HELD_OFFICE (person →
      // office_held), merging with the graph's ~52k such edges instead of forking a MEMBER_OF→office form.
      const relOut = normalizedRelation(r.relation, r.target);
      // C1 provenance: per-edge SOURCE SET (the doc is the single source here; C2
      // merges sets across independent proposals) + valid-time from prose.
      const meta = { source_set: [url], url, grade: fg.grade };
      if (r.valid_from != null) meta.valid_from = r.valid_from;
      if (r.valid_to != null) meta.valid_to = r.valid_to;
      // C2+C3: calibrated confidence from the INDEPENDENT-source count (1 at
      // propose time; the corroboration-enrichment pass raises it as the same
      // fact is re-proposed from other sources), not the flat grade cap.
      const corrN = corroboration.corroborationCount(meta.source_set);
      const conf = confModel.calibratedConfidence({ grade: fg.grade, corroboration: corrN });
      meta.corroboration = corrN;
      if (fg.promote && await _proposeRelation(dispatch, sName, tName, relOut, conf, meta)) {
        out.connections++; out.related.push(tName);
        await _observe(observe, { sourceEntity: sName, relation: relOut, target: tName, url, grade: fg.grade, confidence: conf, status: 'promoted', valid_from: r.valid_from, valid_to: r.valid_to, type: usableType.get(coreKey(r.source) || r.source.toLowerCase()), targetType: usableType.get(coreKey(r.target) || r.target.toLowerCase()) });
      }
    } else {
      out.held++;                                            // endpoint unresolved → upgrade-pass queue
      await _observe(observe, { sourceEntity: r.source, relation: r.relation, target: r.target, url, grade: 'D', confidence: 0, status: 'held' });
    }
  }
  log && log(`[doc-decomp] "${doc.title || url}" → +${out.minted} mint / ${out.reused} reuse / +${out.connections} conn (${out.held} held: ${out.ambiguous} ambiguous, ${out.skipped} skipped)`);
  return out;
}

module.exports = {
  ENTITY_TYPES, REL_VOCAB, canonType, badField, coreKey,
  buildTypedPrompt, parseTypedExtraction, parseValidTime: _parseValidTime, mergeCandidates,
  resolveExtracted, planEntities, decomposeDoc, stateFull, normalizeStateAliases, US_STATES,
  targetTypeFor, normalizedRelation,
};
