/**
 * Offline test — graph memory + epistemic typing + propose→promote gate
 * (the anti-glob foundation; see docs/MEMORY_GROUNDING.md). No model, no network.
 *
 * Proves the core rule: speculation NEVER enters the canonical graph (it queues as
 * a proposal); grounded facts do; trust only upgrades; provenance is attached; and
 * an anticipated-but-absent edge (the "Madeline was expected" glob) reconciles to
 * superseded instead of lingering as a live fact.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_graphmem_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const gm = require('../lib/graph_memory');
const kgActs = []; global.__emitKgActivity = (p) => kgActs.push(p);   // capture the kg:activity push bus (Slice 2)

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async function () {
  console.log('Offline — graph memory (epistemic typing + gate)\n');

  console.log('GATE — grounded enters canonical, speculation does NOT:');
  const told = gm.recordEntity({ name: 'Joshua Fredrickson', type: 'person', epistemic: 'told', proposedBy: 'user', source: { kind: 'conversation', ref: 'turn:1', excerpt: 'Joshua will confirm the file source.' } });
  ok('grounded(told) entity → canonical (entityId returned, not proposed)', told.ok && told.entityId && !told.proposed);
  ok('canonical retrievable by name, epistemic=told', (gm.getEntity('Joshua Fredrickson') || {}).epistemic === 'told');

  const spec = gm.recordEntity({ name: 'Immersive Salesforce Storytelling', type: 'concept', epistemic: 'speculated' });
  ok('speculated entity → proposal, NOT canonical', spec.ok && spec.proposed && !spec.entityId);
  ok('speculated NOT retrievable as a canonical fact', gm.getEntity('Immersive Salesforce Storytelling') === null);
  let c = gm.counts();
  ok('counts: 1 canonical entity, 1 pending entity proposal', c.entities === 1 && c.entityProposals === 1);

  console.log('\nPROMOTE — a proposal only enters the graph once grounded:');
  const proms = db.graphListPendingEntityProposals();
  const pr = gm.promoteEntityProposal(proms[0].id, { epistemic: 'read', source: { kind: 'reading', ref: 'https://example.com' } });
  ok('promote with grounding → canonical entity', pr.ok && !!pr.entityId);
  ok('now retrievable, epistemic=read', (gm.getEntity('Immersive Salesforce Storytelling') || {}).epistemic === 'read');

  console.log('\nTRUST — upgrades only, never downgrades a known fact:');
  gm.recordEntity({ name: 'Madeline Keeter', type: 'person', epistemic: 'read' });
  gm.recordEntity({ name: 'Madeline Keeter', type: 'person', epistemic: 'witnessed' });   // upgrade
  ok('read → witnessed upgrades', (gm.getEntity('Madeline Keeter') || {}).epistemic === 'witnessed');
  gm.recordEntity({ name: 'Madeline Keeter', type: 'person', epistemic: 'read' });          // must NOT downgrade
  ok('later read does NOT downgrade witnessed', (gm.getEntity('Madeline Keeter') || {}).epistemic === 'witnessed');

  console.log('\nS3 NORMALIZATION — abbreviation variants dedup to ONE short-term entity; jurisdiction preserved:');
  const _usa = gm.recordEntity({ name: 'U.S. Senate', type: 'organization', epistemic: 'read' });
  const _usb = gm.recordEntity({ name: 'United States Senate', type: 'organization', epistemic: 'read' });
  ok('"U.S. Senate" ≡ "United States Senate" → SAME short-term entity (abbrev fold)', !!_usa.entityId && _usa.entityId === _usb.entityId);
  const _hv = gm.recordEntity({ name: 'Pat Howell (VA)', type: 'person', epistemic: 'read' });
  const _hc = gm.recordEntity({ name: 'Pat Howell (CA)', type: 'person', epistemic: 'read' });
  ok('"Pat Howell (VA)" ≠ "Pat Howell (CA)" → DISTINCT (jurisdiction token preserved, no over-merge)', !!_hv.entityId && !!_hc.entityId && _hv.entityId !== _hc.entityId);
  ok('normalizeName folds "U.S."→"united states" yet keeps the juris token', gm.normalizeName('U.S. Senate') === 'united states senate' && gm.normalizeName('Pat Howell (VA)') === 'pat howell va');

  console.log('\nRELATIONS — grounded edge auto-creates endpoints + carries provenance:');
  const rel = gm.recordRelation({ source: 'Joshua Fredrickson', target: 'LAMP contact list', type: 'will email', epistemic: 'told', sourceObj: { kind: 'meeting', ref: 'meeting:pcv-sren-zzu', excerpt: 'I can probably make that happen.' } });
  ok('grounded relation created (relationId)', rel.ok && !!rel.relationId && !rel.proposed);
  const nb = gm.neighbors('Joshua Fredrickson');
  ok('relation shows up in live neighbors', nb.some(r => r.id === rel.relationId));
  const cites = db.graphCitationsFor('relation', rel.relationId);
  ok('provenance attached (source citation on the edge)', cites.length === 1 && cites[0].kind === 'meeting');

  const specRel = gm.recordRelation({ source: 'Coast Guard AI', target: 'Salesforce integration', type: 'streamlines', epistemic: 'speculated' });
  ok('speculated relation → proposal, no canonical edge', specRel.ok && specRel.proposed && !specRel.relationId);
  c = gm.counts();
  ok('speculated relation did NOT create endpoints/edge', c.relationProposals === 1 && !gm.getEntity('Coast Guard AI'));

  console.log('\nMADELINE — anticipated-but-absent reconciles to superseded, not glob:');
  const exp = gm.recordRelation({ source: 'Madeline Keeter', target: 'Meeting with Joshua', type: 'expected attendee', epistemic: 'anticipated', sourceObj: { kind: 'conversation', ref: 'turn:pre', excerpt: 'Madeline should be on this call.' } });
  ok('anticipated edge canonical, confirmed=null (open)', exp.ok && db.graphGetRelation(exp.relationId).confirmed === null);
  ok('shows as a live edge before reconciliation', gm.neighbors('Madeline Keeter').some(r => r.id === exp.relationId));
  gm.reconcileRelation(exp.relationId, false);   // she didn't show
  const after = db.graphGetRelation(exp.relationId);
  ok('reconciled refuted: confirmed=0 + valid_to set', after.confirmed === 0 && after.valid_to !== null);
  ok('no longer a LIVE edge (won\'t be free-associated as current)', !gm.neighbors('Madeline Keeter').some(r => r.id === exp.relationId));
  ok('still present in history (includeSuperseded)', gm.neighbors('Madeline Keeter', { includeSuperseded: true }).some(r => r.id === exp.relationId));

  console.log('\nRANKING — topFacts surfaces grounded, never speculated:');
  const top = gm.topFacts({ limit: 10 });
  ok('topFacts returns only canonical entities', top.length > 0 && top.every(e => gm.trust(e.epistemic) >= 0));
  ok('no speculated entity leaked into facts', !top.some(e => e.epistemic === 'speculated'));

  console.log('\nKG:ACTIVITY BUS — real writes push node.born/enrich/edge.born into the active core (Slice 2):');
  kgActs.length = 0;
  const born = gm.recordEntity({ name: 'Zephyr Testnode', type: 'concept', epistemic: 'read' });   // brand-new canonical
  ok('new canonical entity → node.born (db=sidequest, anchor=name, epistemic)', !!born.entityId && kgActs.some(a => a.kind === 'node.born' && a.db === 'sidequest' && a.anchor === 'Zephyr Testnode' && a.epistemic === 'read'));
  kgActs.length = 0;
  gm.recordEntity({ name: 'Zephyr Testnode', type: 'concept', epistemic: 'witnessed' });   // trust upgrade read→witnessed
  ok('trust upgrade on a KNOWN node → node.enrich (not a second born)', kgActs.some(a => a.kind === 'node.enrich' && a.anchor === 'Zephyr Testnode') && !kgActs.some(a => a.kind === 'node.born'));
  kgActs.length = 0;
  const e2 = gm.recordRelation({ source: 'Zephyr Testnode', target: 'Nimbus Concept', type: 'relates to', epistemic: 'read' });
  ok('grounded relation → edge.born (both endpoints as anchors)', !!e2.relationId && kgActs.some(a => a.kind === 'edge.born' && a.anchor === 'Zephyr Testnode' && a.anchor2 === 'Nimbus Concept'));
  ok('a NEW endpoint born alongside the edge (Nimbus Concept)', kgActs.some(a => a.kind === 'node.born' && a.anchor === 'Nimbus Concept'));
  kgActs.length = 0;
  gm.recordEntity({ name: 'Ghost Idea', type: 'concept', epistemic: 'speculated' });   // proposal — never enters the graph
  ok('speculated proposal emits NO node activity (stays out of the canonical graph)', !kgActs.some(a => a.kind === 'node.born' || a.kind === 'node.enrich'));

  console.log('\nKG:ACTIVITY — monologue writes drive a THROTTLED ambient think heartbeat (Slice 2b):');
  kgActs.length = 0;
  db.insertMonologue({ content: 'thinking about the graph', type: 'thought' });
  ok('first monologue write → exactly one think (db=sidequest)', kgActs.filter(a => a.kind === 'think' && a.db === 'sidequest').length === 1);
  kgActs.length = 0;
  db.insertMonologue({ content: 'another immediate thought', type: 'thought' });
  ok('immediate second write → throttled (no think within 3.5s)', !kgActs.some(a => a.kind === 'think'));

  console.log('\nDEEP-DIVE M2 — relation re-observation is UPGRADE-ONLY (the entity rule, transplanted):');
  {
    const r1 = gm.recordRelation({ source: 'Anchor Person', target: 'Test Meeting', type: 'ATTENDED', epistemic: 'witnessed', confidence: 0.95 });
    const rel1 = db.graphGetRelation(r1.relationId);
    db.getDb().prepare('UPDATE graph_relations SET confirmed = 1 WHERE id = ?').run(rel1.id);
    // a prose re-extraction of the same edge at lower trust must not downgrade anything
    gm.recordRelation({ source: 'Anchor Person', target: 'Test Meeting', type: 'ATTENDED', epistemic: 'read', confidence: 0.75 });
    const rel2 = db.graphGetRelation(rel1.id);
    ok('M2: epistemic never downgrades (witnessed stays witnessed)', rel2.epistemic === 'witnessed');
    ok('M2: confidence never downgrades (0.95 stays)', Number(rel2.confidence) === 0.95);
    ok('M2: confirmed never resets to null on re-observation', rel2.confirmed === 1);
    // and a better sighting still upgrades
    gm.recordRelation({ source: 'Anchor Person', target: 'Test Meeting', type: 'ATTENDED', epistemic: 'witnessed', confidence: 0.99 });
    ok('M2: a stronger sighting RAISES confidence', Number(db.graphGetRelation(rel1.id).confidence) === 0.99);
  }

  console.log('\nDEEP-DIVE M1 — graph facts RENDER in recall (ids resolve to names):');
  {
    gm.recordRelation({ source: 'Zephyrium', target: 'Nimbusia', type: 'ALLIED_WITH', epistemic: 'told', confidence: 0.9 });
    const ar = require('../lib/active_recall');
    const r = await ar.recall('zephyrium standing', {
      retrieveFn: async () => [], prominenceFn: async () => ({ status: 'ok' }),
      resolveFn: async () => ({ status: 'none' }), civicFn: async () => [],
    });
    ok('M1: the [graph] facts line is ALIVE — names, not dead column probes',
      (r.facts || []).some((f) => /zephyrium/i.test(f) && /nimbusia/i.test(f)));
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
