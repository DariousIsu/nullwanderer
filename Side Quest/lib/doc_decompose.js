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
async function resolveExtracted(entity, { resolve } = {}) {
  const name = stripLead(entity && entity.name);
  const type = canonType(entity && entity.type);
  if (!name || badField(name)) return { action: 'skip', name, type, reason: 'bad-name' };
  if (typeof resolve !== 'function') return { action: 'skip', name, type, reason: 'no-resolver' };
  const preferType = type !== 'other' ? type : null;
  let r;
  try { r = await resolve(name, { preferType }); } catch { return { action: 'skip', name, type, reason: 'resolver-threw' }; }
  const status = r && r.status;
  if (status === 'resolved') return { action: 'reuse', name, type, object: r.object, canonical: (r.object && r.object.name) || name };
  if (status === 'nil') return { action: 'mint', name, type };
  if (status === 'ambiguous') return { action: 'hold', name, type, candidates: r.candidates || [], reason: r.reason || 'ambiguous' };
  return { action: 'skip', name, type, reason: (status || 'error') };
}

// Batch-resolve extracted entities → { decisions, byKey, tally }. `byKey` is keyed by coreKey so a
// relation endpoint can look up its entity's decision (2c only proposes a relation when BOTH endpoints
// reuse-or-mint; a hold/skip endpoint means we don't know which node, so the edge waits). Never throws.
async function planEntities(entities, { resolve } = {}) {
  const decisions = [], byKey = new Map();
  const tally = { reuse: 0, mint: 0, hold: 0, skip: 0 };
  for (const e of (Array.isArray(entities) ? entities : [])) {
    const d = await resolveExtracted(e, { resolve });
    decisions.push(d);
    byKey.set(coreKey(d.name) || d.name.toLowerCase(), d);
    tally[d.action] = (tally[d.action] || 0) + 1;
  }
  return { decisions, byKey, tally };
}

module.exports = {
  ENTITY_TYPES, REL_VOCAB, canonType, badField, coreKey,
  buildTypedPrompt, parseTypedExtraction, mergeCandidates,
  resolveExtracted, planEntities,
};
