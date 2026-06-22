/**
 * Hard smoke — follow-up #3: structured extraction of grounded readings into the graph.
 * parseTriples rejects pronouns/sentences; ingestReading records clean triples as epistemic
 * 'read' facts with the reading as provenance. Offline, injected extractor (no model).
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_gext_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const ge = require('../lib/graph_extract');
const gm = require('../lib/graph_memory');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  console.log('Hard smoke — #3 reading → graph extraction\n');

  console.log('parseTriples — keeps clean triples, rejects junk:');
  const parsed = ge.parseTriples([
    'Joshua Fredrickson | WORKS_FOR | Rainey Center',
    'FAST-41 Act | REGULATES | federal permitting',
    'it | RELATED_TO | that',                                                  // pronoun → reject
    'The whole rambling sentence that is obviously not an entity at all here | LEADS | X', // sentence → reject
    'Madeline Keeter | member of | LAMP'                                       // lowercase rel → normalized
  ].join('\n'));
  ok('kept exactly 3 clean triples', parsed.length === 3);
  ok('pronoun triple rejected', !parsed.some(t => t.source === 'it' || t.target === 'that'));
  ok('sentence-entity rejected', !parsed.some(t => t.source.length > 60 || t.source.split(/\s+/).length > 6));
  ok('relation normalized to UPPER_SNAKE', parsed.some(t => t.type === 'MEMBER_OF'));

  console.log('\ningestReading — triples become grounded (read) graph facts w/ provenance:');
  const deps = { extract: async () => 'Joshua Fredrickson | WORKS_FOR | Rainey Center\nFAST-41 Act | REGULATES | federal permitting' };
  const res = await ge.ingestReading({ text: 'A long enough reading about Joshua at the Rainey Center and the FAST-41 permitting law …', ref: 'https://example.com/article', deps });
  ok('recorded 2 relations', res.recorded === 2);
  ok('endpoint entity created as epistemic=read', (gm.getEntity('Joshua Fredrickson') || {}).epistemic === 'read');
  const nb = gm.neighbors('Joshua Fredrickson');
  const worksFor = nb.find(r => r.relation_type === 'WORKS_FOR');
  ok('WORKS_FOR edge exists + epistemic read', !!worksFor && worksFor.epistemic === 'read');
  const cites = worksFor ? db.graphCitationsFor('relation', worksFor.id) : [];
  ok('edge carries reading provenance', cites.length === 1 && cites[0].kind === 'reading' && cites[0].ref === 'https://example.com/article');
  ok('extracted facts surface in factsForPrompt', /Joshua Fredrickson|FAST-41/.test(gm.factsForPrompt({ limit: 10 }) || ''));

  console.log('\nthrottle: maybeIngestReading skips a thin / too-soon reading:');
  const thin = await ge.maybeIngestReading({ text: 'short', ref: 'x' });
  ok('thin reading skipped', thin && thin.skipped === 'thin');

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
