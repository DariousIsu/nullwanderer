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

// Closed entity-type vocab, aligned with Echo's types. Anything unrecognized → 'other' (still a real
// object, just untyped — the richness axis, not the reality axis). Normalizes common model synonyms.
const ENTITY_TYPES = ['person', 'organization', 'location', 'event', 'work', 'bill', 'document', 'other'];
const TYPE_SYNONYM = {
  people: 'person', per: 'person', human: 'person', individual: 'person',
  org: 'organization', organisation: 'organization', company: 'organization', agency: 'organization', institution: 'organization', group: 'organization',
  place: 'location', gpe: 'location', loc: 'location', city: 'location', country: 'location', state: 'location', region: 'location',
  law: 'bill', legislation: 'bill', act: 'bill',
  doc: 'document', article: 'document', paper: 'document',
  creativework: 'work', book: 'work',
};
function canonType(t) {
  const k = String(t == null ? '' : t).toLowerCase().trim().replace(/[^a-z]/g, '');
  if (!k) return 'other';
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
REL: <source> | <RELATION> | <target>

<type> is one of: ${ENTITY_TYPES.join(', ')} (use "other" if unsure).
<RELATION> is UPPER_SNAKE from: ${REL_VOCAB.join(', ')} (use RELATED_TO if none fit).
Names must be CONCRETE NAMED ENTITIES (a person, org, place, event, bill) — never a pronoun, never a whole sentence.
Only what the text STATES — do NOT infer, generalize, or invent. Every REL's source and target should also appear as an ENTITY line.
Max 20 ENTITY lines and 20 REL lines. If there are none, output exactly: NONE

${head}DOCUMENT:
${String(text || '').slice(0, 6000)}`
  }];
}

// Parse the model output into { entities:[{name,type}], relations:[{source,relation,target}] }. Rejects
// slop (pronouns, sentences, malformed relations). Dedups entities by lowercased name. Caps volume.
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
    } else if ((m = /^REL\s*:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+)$/i.exec(L))) {
      if (relations.length >= maxRelations) continue;
      const source = stripLead(m[1]);
      const relation = String(m[2]).trim().toUpperCase().replace(/\s+/g, '_');
      const target = stripLead(m[3]);
      if (badField(source) || badField(target)) continue;
      if (!/^[A-Z][A-Z_]+$/.test(relation)) continue;
      const rk = `${source.toLowerCase()}|${relation}|${target.toLowerCase()}`;
      if (seenR.has(rk)) continue;
      seenR.add(rk);
      relations.push({ source, relation, target });
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
  if (status === 'nil') return { action: 'mint', name, type };
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

async function _proposeEntity(dispatch, name, entity_type, summary) {
  try { const r = await dispatch({ kind: 'do', name: 'propose_entity', args: { name, entity_type: entity_type || 'other', summary: summary || '' } }); return !!(r && r.ok); } catch { return false; }
}
async function _proposeRelation(dispatch, source, target, relation_type) {
  try { const r = await dispatch({ kind: 'do', name: 'propose_relation', args: { source_name: source, target_name: target, relation_type: relation_type || 'related_to' } }); return !!(r && r.ok); } catch { return false; }
}
async function _observe(observe, o) { if (typeof observe === 'function') { try { await observe(o); } catch {} } }

async function decomposeDoc(doc = {}, deps = {}) {
  const { extract, echoExtract, resolve, dispatch, observe, cap = {}, log } = deps;
  const text = String(doc.text || '');
  const url = doc.url || null;
  const maxEnt = cap.entities || 20, maxRel = cap.relations || 20;
  const out = { minted: 0, reused: 0, connections: 0, held: 0, ambiguous: 0, skipped: 0, related: [] };
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
  // every edge to it. The TARGET of an org-membership relation is inferred to be an ORGANIZATION — without
  // that type, resolution runs untyped and a summary-FTS match on the wrong type leaks in (the live bug:
  // "…WORKS_FOR Rainy Center" resolved to a CT bill whose summary contained "Rainy Day Fund" + "Center").
  const ORG_TARGET_REL = /^(WORKS_FOR|EMPLOYED_BY|MEMBER_OF|MEMBER_OF_ORG|PART_OF|SUBSIDIARY_OF|AFFILIATE_OF|FOUNDED|LEADS|DIRECTED_BY)$/;
  const haveKey = new Set(merged.map(e => coreKey(e.name) || String(e.name).toLowerCase()));
  for (const r of relations) {
    const relType = String((r && r.relation) || '').toUpperCase();
    const endpoints = [
      { name: r && r.source, type: 'other' },
      { name: r && r.target, type: ORG_TARGET_REL.test(relType) ? 'organization' : 'other' },
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

  // 2) disambiguate every entity — the doc's full entity set is the CONTEXT that resolves an ambiguous
  // candidate (e.g. "Rainey Center" among a roster of policy people → the policy org, not the lobbying twin).
  const context = merged.map(e => e.name);
  const plan = await planEntities(merged, { resolve, context });

  // 3) entities: mint (existence-gated by the doc) / reuse / hold (fall-through) / skip
  const usable = new Map();   // coreKey → the canonical name to use in an edge
  for (const d of plan.decisions) {
    const key = coreKey(d.name) || d.name.toLowerCase();
    if (d.action === 'reuse') { usable.set(key, d.canonical || d.name); out.reused++; continue; }
    if (d.action === 'mint') {
      if (out.minted >= maxEnt) continue;                    // volume cap on NEW objects
      const eg = CG.gateExistence('S1', docSources);         // doc-cited → grade B ≥ C floor → mint
      if (eg.mint && await _proposeEntity(dispatch, d.name, d.type, '')) {
        usable.set(key, d.name); out.minted++;
        await _observe(observe, { sourceEntity: d.name, relation: 'exists', target: null, url, grade: eg.grade, confidence: eg.confidence, status: 'promoted' });
      }
      continue;
    }
    if (d.action === 'hold') {                               // ambiguous → fall-through
      out.ambiguous++; out.held++;
      await _observe(observe, { sourceEntity: d.name, relation: 'exists', target: null, url, grade: 'D', confidence: 0, status: 'held' });
      continue;
    }
    out.skipped++;                                           // bad-name / resolver error
  }

  // 4) relations: propose only when BOTH endpoints resolved (reuse/mint); else a HELD fall-through
  for (const r of relations) {
    if (out.connections >= maxRel) break;
    const sName = usable.get(coreKey(r.source) || r.source.toLowerCase());
    const tName = usable.get(coreKey(r.target) || r.target.toLowerCase());
    if (sName && tName && sName.toLowerCase() !== tName.toLowerCase()) {
      const fg = CG.gateFact('S1', docSources);              // doc-cited → B → promote
      if (fg.promote && await _proposeRelation(dispatch, sName, tName, r.relation)) {
        out.connections++; out.related.push(tName);
        await _observe(observe, { sourceEntity: sName, relation: r.relation, target: tName, url, grade: fg.grade, confidence: fg.confidence, status: 'promoted' });
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
  buildTypedPrompt, parseTypedExtraction, mergeCandidates,
  resolveExtracted, planEntities, decomposeDoc, stateFull, normalizeStateAliases, US_STATES,
};
