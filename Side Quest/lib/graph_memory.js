/**
 * lib/graph_memory.js — Zoe's OWN relational memory with epistemic typing + a
 * propose→promote gate. The anti-glob layer (see docs/MEMORY_GROUNDING.md).
 *
 * WHY: her flat `knowledge` store can't tell witnessed/told/read/speculated/
 * anticipated apart, so the idle loop launders her own speculation into 0.75
 * "facts" and free-associates them into incoherent globs. This gives every fact
 * an EPISTEMIC status and refuses to let speculation enter the canonical graph
 * without a real source — and lets an anticipated-but-absent item ("Madeline was
 * expected at the meeting") be reconciled instead of mashed.
 *
 * Modeled on echo/store.py (entities/relations/sources/citations + proposal gate)
 * and written in the same shape, so it maps ~1:1 onto Echo's KG for federation —
 * but it is fully self-contained and never depends on Echo to function.
 *
 * THE GATE (the core rule):
 *   grounded (witnessed | told | read | anticipated) → CANONICAL graph
 *   speculated                                       → PROPOSAL queue only
 * Speculation is never retrieved as fact and only enters the graph via promote*()
 * once a real source arrives.
 */
const db = require('./db');
const kga = require('./kg_activity');   // kg:activity push bus — the active core sparks as she writes (Slice 2)

// Epistemic trust order. anticipated is "grounded as an expectation" (someone
// actually said it would happen) so it's canonical-but-unconfirmed; speculated
// is her own ungrounded guess and stays out of the canonical graph.
const TRUST = { witnessed: 4, told: 3, read: 2, anticipated: 1, speculated: 0 };
const GROUNDED = new Set(['witnessed', 'told', 'read', 'anticipated']);
const DEFAULT_CONF = { witnessed: 0.95, told: 0.9, read: 0.75, anticipated: 0.6, speculated: 0.4 };

const isEpistemic = (e) => Object.prototype.hasOwnProperty.call(TRUST, e);
const trust = (e) => TRUST[e] ?? 0;
const defaultConf = (e) => DEFAULT_CONF[e] ?? 0.5;

// Normalize a surface name to a dedup key: lowercase, drop punctuation, collapse ws.
function normalizeName(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  // Fold civic abbreviations so surface-form variants share ONE dedup key ("u s senate" ≡ "united states
  // senate") — universal-normalization S3: the short-term store now normalizes like the gate. Jurisdiction /
  // disambiguator tokens are KEPT (this is a KEY, not a block key), so "Howell va" never merges with "Howell ca".
  if (!base) return base;
  const toks = base.split(' ');
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'u' && toks[i + 1] === 's' && toks[i + 2] === 'a') { out.push('united', 'states'); i += 2; continue; }
    if (t === 'u' && toks[i + 1] === 's') { out.push('united', 'states'); i += 1; continue; }
    if (t === 'usa' || t === 'us') { out.push('united', 'states'); continue; }
    out.push(t);
  }
  return out.join(' ');
}

const SUB = require('./substantiation');
let _isJunkSrc; try { ({ isJunkSource: _isJunkSrc } = require('./curation_gate')); } catch { _isJunkSrc = () => false; }

// graph_entities substantiation STATE (measured rule 2026-08-04, see memory substantiation-grading-vision).
// The entity store has no feed/url column, so classifySubstantiation can't be called directly; this is its
// entity-store twin over the signals graph_entities actually carries: confirmed → identity-confirmed;
// witnessed (a live-observed node self-vouches, like news) OR a non-junk citation (graph_citations ref)
// → source-vouched; else unsubstantiated (prove-or-fade). The junk-host veto reuses the ONE shared list.
function entitySubstState({ epistemic = null, confirmed = null, hasNonJunkCitation = false } = {}) {
  if (confirmed) return SUB.IDENTITY_CONFIRMED;
  if (String(epistemic || '').toLowerCase() === 'witnessed' || hasNonJunkCitation) return SUB.SOURCE_VOUCHED;
  return SUB.UNSUBSTANTIATED;
}
const _SUB_RANK = { [SUB.IDENTITY_CONFIRMED]: 3, [SUB.SOURCE_VOUCHED]: 2, [SUB.UNSUBSTANTIATED]: 1 };
function _subRank(s) { return _SUB_RANK[String(s || '').toLowerCase()] || 0; }   // null/unstated = 0
function _srcHasNonJunkCite(source) {
  const ref = source && source.ref;
  return !!(ref && String(ref).trim() && !_isJunkSrc(ref));
}

// Attach a grounding source + citation to a fact. source: {kind, ref?, excerpt?}
// kind ∈ user | meeting | reading | web | conversation | own_thought
function attachSource(factKind, factId, source) {
  if (!source || !source.kind) return null;
  const s = db.graphInsertSource({ kind: source.kind, ref: source.ref || null, excerpt: source.excerpt || null });
  db.graphInsertCitation({ sourceId: s.id, factKind, factId, quotedText: source.excerpt || null });
  return s.id;
}

/**
 * Record an entity. Grounded → canonical (upsert by normalized name, trust only
 * ever upgrades, never downgrades a known fact). Speculated → proposal queue.
 * Returns { ok, entityId } | { ok, proposed:true, proposalId } | { ok:false, reason }.
 */
// T5 — `type` no longer DEFAULTS to 'concept'. It defaulted here, recordRelation below never passed one,
// and that is the entire reason 13,033 entities are typed `concept`: nobody decided, a default fired.
// The distinction between "the caller said concept" and "the caller said nothing" has to survive to
// mint_type.decideType, so the parameter defaults to null and the decision is made explicitly.
function recordEntity({ name, type = null, subtype = null, summary = null, epistemic = 'told', confidence = null, proposedBy = null, source = null, sourceOnCreate = false } = {}) {
  name = String(name || '').trim();
  if (!name) return { ok: false, reason: 'empty name' };
  if (!isEpistemic(epistemic)) epistemic = 'speculated';
  const nameKey = normalizeName(name);
  if (!nameKey) return { ok: false, reason: 'empty name_key' };

  // Ask the evidence before inventing anything. A settled type claim (T3) wins; a strong id at least
  // proves this is not a concept; otherwise it is honestly `unknown`, which is visible and correctable.
  const _mt = require('./mint_type');
  type = _mt.decideType(name, type, { lookup: (n) => require('./object_type').typeOf(n) }).type;

  if (epistemic === 'speculated') {
    const p = db.graphInsertEntityProposal({
      name, entityType: type, entitySubtype: subtype, summary,
      confidence: confidence == null ? 0.6 : confidence, epistemic, proposedBy,
      sourceRef: source && source.ref
    });
    return { ok: true, proposed: true, proposalId: p.id };
  }

  const conf = confidence == null ? defaultConf(epistemic) : confidence;
  const existing = db.graphGetEntityByKey(nameKey);
  let entityId;
  let created = false;
  if (existing) {
    const fields = {};
    if (trust(epistemic) > trust(existing.epistemic)) fields.epistemic = epistemic;   // upgrade only
    if (summary && !existing.summary) fields.summary = summary;
    // A real type UPGRADES a placeholder, and a placeholder never overwrites a real type. `unknown` is
    // now a placeholder alongside `concept` — otherwise T5's honest default would be stickier than the
    // dishonest one it replaced, which would be a strictly worse outcome.
    if (type && !_mt.isPlaceholder(type) && _mt.isPlaceholder(existing.entity_type)) fields.entity_type = type;
    if (conf > (existing.confidence || 0)) fields.confidence = conf;
    // Substantiation upgrades only (strongest-across-encounters, like epistemic above): a new witnessing
    // or citation can raise unsubstantiated → source-vouched, but a later bare sighting never downgrades a
    // vouched node. Backfills a NULL state on any re-encounter of a pre-substrate node.
    const _newSub = entitySubstState({ epistemic, confirmed: existing.confirmed, hasNonJunkCitation: _srcHasNonJunkCite(source) });
    if (_subRank(_newSub) > _subRank(existing.substantiation_state)) fields.substantiation_state = _newSub;
    if (!existing.frame) fields.frame = SUB.FRAME_REAL;
    if (Object.keys(fields).length) {
      db.graphUpdateEntity(existing.id, fields);
      kga.emit({ db: 'sidequest', kind: 'node.enrich', anchor: name, epistemic, count: 1 });   // learned more about a known node
    }
    entityId = existing.id;
  } else {
    const r = db.graphInsertEntity({
      name, nameKey, entityType: type, entitySubtype: subtype, summary, confidence: conf,
      epistemic, confirmed: null, proposedBy,
      substantiationState: entitySubstState({ epistemic, confirmed: null, hasNonJunkCitation: _srcHasNonJunkCite(source) }),
      frame: SUB.FRAME_REAL
    });
    entityId = r.id;
    created = true;
    kga.emit({ db: 'sidequest', kind: 'node.born', anchor: name, epistemic, count: 1 });   // a new node lands in the active core
  }
  // `sourceOnCreate` records the BIRTH and only the birth. graphInsertSource inserts unconditionally
  // (28,436 rows for 4,646 distinct refs already), so attaching on every re-encounter of a known entity
  // would compound that for no gain — where an object was FIRST found does not change when it is found
  // again, and later sightings are what the encounter log is for.
  if (source && (!sourceOnCreate || created)) attachSource('entity', entityId, source);
  return { ok: true, entityId, proposed: false };
}

/**
 * Record a relation between two named entities. Grounded → ensure both endpoints
 * exist (created at the same epistemic level) then upsert the edge. Speculated →
 * relation-proposal queue (stored by name, no endpoints created).
 */
function recordRelation({ source, target, type, epistemic = 'told', confidence = null, proposedBy = null, sourceObj = null, validFrom = null } = {}) {
  const sName = String(source || '').trim();
  const tName = String(target || '').trim();
  const relType = String(type || '').trim().toUpperCase().replace(/\s+/g, '_');
  if (!sName || !tName || !relType) return { ok: false, reason: 'need source, target, type' };
  if (!isEpistemic(epistemic)) epistemic = 'speculated';

  if (epistemic === 'speculated') {
    const p = db.graphInsertRelationProposal({
      sourceName: sName, targetName: tName, relationType: relType,
      confidence: confidence == null ? 0.6 : confidence, epistemic, proposedBy,
      sourceRef: sourceObj && sourceObj.ref
    });
    return { ok: true, proposed: true, proposalId: p.id };
  }

  // BIRTH CONTEXT (Lucas, 2026-07-21: "include rough edges in the new object creation from the context
  // of where the object was born"). These two calls MINT the endpoints, and until now they passed no
  // source — so 10,361 entities exist with no record of where they came from: 0 of them carry an entity
  // citation, and only ~1% appear in the encounter log. Nothing can constrain what they are, because
  // nothing knows where they were found.
  //
  // Same shape as the `type = 'concept'` default: an optional parameter that the hot path omits. The
  // relation already knows its source; the endpoints it creates inherit it.
  const se = recordEntity({ name: sName, epistemic, proposedBy, source: sourceObj, sourceOnCreate: true });
  const te = recordEntity({ name: tName, epistemic, proposedBy, source: sourceObj, sourceOnCreate: true });
  if (!se.entityId || !te.entityId) return { ok: false, reason: 'could not resolve endpoints' };
  const conf = confidence == null ? defaultConf(epistemic) : confidence;
  const rel = db.graphInsertRelation({
    sourceId: se.entityId, targetId: te.entityId, relationType: relType,
    confidence: conf, epistemic, confirmed: null, proposedBy, validFrom
  });
  kga.emit({ db: 'sidequest', kind: 'edge.born', anchor: sName, anchor2: tName, epistemic, count: 1 });   // a synapse forms between two core nodes
  if (sourceObj) attachSource('relation', rel.id, sourceObj);
  return { ok: true, relationId: rel.id, sourceId: se.entityId, targetId: te.entityId, proposed: false };
}

// Promote a pending entity proposal into the canonical graph once it's grounded.
function promoteEntityProposal(id, { epistemic = 'read', source = null } = {}) {
  const p = db.graphGetEntityProposal(id);
  if (!p || p.status !== 'pending') return { ok: false, reason: 'no pending entity proposal' };
  if (!GROUNDED.has(epistemic)) return { ok: false, reason: 'promotion requires a grounded epistemic status' };
  const r = recordEntity({ name: p.name, type: p.entity_type, subtype: p.entity_subtype, summary: p.summary, epistemic, confidence: p.confidence, proposedBy: p.proposed_by, source });
  db.graphSetEntityProposalStatus(id, 'promoted');
  return { ok: true, entityId: r.entityId };
}

// Promote a pending relation proposal once it's grounded.
function promoteRelationProposal(id, { epistemic = 'read', source = null } = {}) {
  const p = db.graphGetRelationProposal(id);
  if (!p || p.status !== 'pending') return { ok: false, reason: 'no pending relation proposal' };
  if (!GROUNDED.has(epistemic)) return { ok: false, reason: 'promotion requires a grounded epistemic status' };
  const r = recordRelation({ source: p.source_name, target: p.target_name, type: p.relation_type, epistemic, confidence: p.confidence, proposedBy: p.proposed_by, sourceObj: source });
  db.graphSetRelationProposalStatus(id, 'promoted');
  return { ok: true, relationId: r.relationId };
}

function rejectEntityProposal(id) { db.graphSetEntityProposalStatus(id, 'rejected'); }
function rejectRelationProposal(id) { db.graphSetRelationProposalStatus(id, 'rejected'); }

// Reconcile an ANTICIPATED relation against what actually happened (the Madeline fix):
// confirmed=false → mark refuted AND supersede (valid_to=now) so it stops being a live
// fact; confirmed=true → keep it live, just stamp the flag.
function reconcileRelation(id, confirmed) {
  if (confirmed) db.graphSetRelationConfirmed(id, 1);
  else db.graphSupersedeRelation(id, { confirmed: 0 });
}
function reconcileEntity(id, confirmed) { db.graphSetEntityConfirmed(id, confirmed ? 1 : 0); }

// --- queries ---
function getEntity(name) { return db.graphGetEntityByKey(normalizeName(name)); }
function neighbors(name, opts = {}) {
  const e = getEntity(name);
  return e ? db.graphNeighbors(e.id, opts) : [];
}
function counts() { return db.graphCounts(); }

// Canonical facts ranked by epistemic trust × confidence (speculated never appears —
// it lives in the proposal queue, not the graph). For later prompt injection.
function topFacts({ limit = 12, includeUnconfirmed = true } = {}) {
  const ents = db.graphListEntities({ limit: 500 })
    .filter((e) => includeUnconfirmed || e.confirmed !== 0)
    .sort((a, b) => (trust(b.epistemic) * (b.confidence || 0)) - (trust(a.epistemic) * (a.confidence || 0)))
    .slice(0, limit);
  return ents;
}

// EPISODIC RECONCILIATION (phase 4) — close the Madeline loop. A meeting is a witnessed
// event; people who actually spoke ATTENDED it (witnessed). For anyone who was EXPECTED
// (an anticipated edge, because someone said they'd be there), reconcile against who was
// actually present: present → confirmed; absent → refuted + superseded, so "Madeline was
// expected" stops being a live fact she can free-associate once she didn't show.
// `present` = caption speakers; `expected` = names from pre-meeting context (when available).
function reconcileAttendance({ meeting, expected = [], present = [], proposedBy = 'gmeet' } = {}) {
  const mName = String(meeting || '').trim();
  if (!mName) return { ok: false, reason: 'need a meeting name' };
  recordEntity({ name: mName, type: 'meeting', epistemic: 'witnessed', proposedBy });
  const presentKeys = new Set(present.map((p) => normalizeName(p)).filter(Boolean));
  const out = { ok: true, meeting: mName, attended: [], confirmed: [], absent: [] };

  for (const p of present) {
    const pn = String(p || '').trim();
    if (!pn) continue;
    recordEntity({ name: pn, type: 'person', epistemic: 'witnessed', proposedBy });
    recordRelation({ source: pn, target: mName, type: 'ATTENDED', epistemic: 'witnessed', proposedBy });
    out.attended.push(pn);
  }
  for (const e of expected) {
    const en = String(e || '').trim();
    if (!en) continue;
    const rel = recordRelation({ source: en, target: mName, type: 'EXPECTED_ATTENDEE', epistemic: 'anticipated', proposedBy });
    const here = presentKeys.has(normalizeName(en));
    if (rel.relationId) reconcileRelation(rel.relationId, here);
    (here ? out.confirmed : out.absent).push(en);
  }
  return out;
}

// Epistemic-ranked facts block for prompt injection (phase 3). ONLY grounded canonical
// facts — speculated never reaches here (it's in the proposal queue, not the graph) and
// refuted items (confirmed=0, e.g. Madeline-didn't-show) are dropped — so the idle loop
// gets ground truth to think from, not its own laundered speculation. Each line states HOW
// she knows it, so the model can weight witnessed/told over read. Returns null when empty.
function factsForPrompt({ limit = 10 } = {}) {
  const ents = topFacts({ limit, includeUnconfirmed: true }).filter((e) => e.confirmed !== 0);
  if (!ents.length) return null;
  const lines = ['Grounded facts you actually know (and how you know each — trust witnessed/told over read; these are real, not your own speculation):'];
  for (const e of ents) {
    lines.push(`  · (${e.epistemic}) ${e.name}${e.summary ? ' — ' + String(e.summary).slice(0, 160) : ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  TRUST, GROUNDED, normalizeName, isEpistemic, trust,
  normalizeName, recordEntity, recordRelation,
  promoteEntityProposal, promoteRelationProposal, rejectEntityProposal, rejectRelationProposal,
  reconcileRelation, reconcileEntity, reconcileAttendance,
  getEntity, neighbors, counts, topFacts, attachSource, factsForPrompt,
  entitySubstState,
};
