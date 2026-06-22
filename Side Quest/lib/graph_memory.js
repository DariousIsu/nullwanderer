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
  return String(name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
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
function recordEntity({ name, type = 'concept', subtype = null, summary = null, epistemic = 'told', confidence = null, proposedBy = null, source = null } = {}) {
  name = String(name || '').trim();
  if (!name) return { ok: false, reason: 'empty name' };
  if (!isEpistemic(epistemic)) epistemic = 'speculated';
  const nameKey = normalizeName(name);
  if (!nameKey) return { ok: false, reason: 'empty name_key' };

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
  if (existing) {
    const fields = {};
    if (trust(epistemic) > trust(existing.epistemic)) fields.epistemic = epistemic;   // upgrade only
    if (summary && !existing.summary) fields.summary = summary;
    if (type && type !== 'concept' && existing.entity_type === 'concept') fields.entity_type = type;
    if (conf > (existing.confidence || 0)) fields.confidence = conf;
    if (Object.keys(fields).length) db.graphUpdateEntity(existing.id, fields);
    entityId = existing.id;
  } else {
    const r = db.graphInsertEntity({
      name, nameKey, entityType: type, entitySubtype: subtype, summary, confidence: conf,
      epistemic, confirmed: null, proposedBy
    });
    entityId = r.id;
  }
  if (source) attachSource('entity', entityId, source);
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

  const se = recordEntity({ name: sName, epistemic, proposedBy });
  const te = recordEntity({ name: tName, epistemic, proposedBy });
  if (!se.entityId || !te.entityId) return { ok: false, reason: 'could not resolve endpoints' };
  const conf = confidence == null ? defaultConf(epistemic) : confidence;
  const rel = db.graphInsertRelation({
    sourceId: se.entityId, targetId: te.entityId, relationType: relType,
    confidence: conf, epistemic, confirmed: null, proposedBy, validFrom
  });
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
  recordEntity, recordRelation,
  promoteEntityProposal, promoteRelationProposal, rejectEntityProposal, rejectRelationProposal,
  reconcileRelation, reconcileEntity,
  getEntity, neighbors, counts, topFacts, attachSource, factsForPrompt,
};
