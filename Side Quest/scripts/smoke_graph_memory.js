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

(function () {
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

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
