/**
 * Hard smoke — Phase 2: reflection de-laundering (anti-glob).
 * A KNOWLEDGE/SKILL takeaway distilled from her OWN thoughts (no external reading/URL) is
 * SPECULATION → it must queue as a gated graph proposal, NOT become a retrievable 0.75 fact.
 * A takeaway grounded in a reading IS a real fact. Offline (real embedder for the grounded
 * path); no model — routeReflection takes pre-extracted tagged text.
 */
const os = require('os'); const path = require('path');
process.env.SQ_DB_PATH = path.join(os.tmpdir(), `sq_delaunder_${Date.now()}`, 'sq.db');
const db = require('../lib/db'); db.init();
const memory = require('../lib/memory');
const gm = require('../lib/graph_memory');
const reflection = require('../lib/reflection');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.log(`  ✗ ${n}`); } };

(async () => {
  console.log('Hard smoke — Phase 2 reflection de-laundering\n');
  await memory.warm();

  console.log('UNGROUNDED (her own thoughts) → speculation, NOT a fact:');
  const ungroundedRaw = [
    "[KNOWLEDGE] The Coast Guard's AI acquisition superhighway could be applied to streamline Salesforce integration.",
    '[KNOWLEDGE] Immersive storytelling makes Salesforce deduplication more engaging.'
  ].join('\n');
  const thoughtRows = [
    { id: 101, type: 'thought', content: 'I keep thinking about the Coast Guard AI thing and Salesforce.' },
    { id: 102, type: 'thought', content: 'Immersive storytelling could connect to the dedup work.' }
  ];
  const r1 = await reflection.routeReflection(ungroundedRaw, thoughtRows);
  ok('no KNOWLEDGE facts written (nKnow === 0)', r1.nKnow === 0);
  ok('both takeaways routed to speculation (nSpec === 2)', r1.nSpec === 2);
  ok('NOTHING in knowledge as reflection_knowledge', db.getKnowledgeBySourceSince('reflection_knowledge', 0).length === 0);
  const props = db.graphListPendingEntityProposals();
  ok('2 gated proposals queued', props.length === 2);
  ok('proposals are speculated + by reflection', props.every(p => p.epistemic === 'speculated' && p.proposed_by === 'reflection'));
  ok('the Coast Guard→Salesforce mash is NOT a canonical fact', gm.counts().entities === 0);

  console.log('\nGROUNDED (distilled from a reading) → a real fact:');
  const groundedRaw = "[KNOWLEDGE] DuckDuckGo's HTML results list each result title under a.result__a.";
  const readingRows = [
    { id: 201, type: 'reading', content: 'I looked up DuckDuckGo HTML structure. Results titles are in a.result__a …', urls: JSON.stringify(['https://html.duckduckgo.com/html/']) }
  ];
  const r2 = await reflection.routeReflection(groundedRaw, readingRows, { decideFn: () => 'distinct' });
  ok('grounded takeaway stored as a fact (nKnow === 1)', r2.nKnow === 1);
  ok('not routed to speculation (nSpec === 0)', r2.nSpec === 0);
  const facts = db.getKnowledgeBySourceSince('reflection_knowledge', 0);
  ok('a reflection_knowledge fact now exists', facts.length === 1);
  ok('stored at fact-grade importance (0.75)', facts.length === 1 && Math.abs((facts[0].importance || 0) - 0.75) < 0.001);
  ok('grounded path did NOT add a speculation proposal', db.graphListPendingEntityProposals().length === 2);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  try { require('fs').rmSync(path.dirname(process.env.SQ_DB_PATH), { recursive: true, force: true }); } catch {}
  process.exit(fail === 0 ? 0 : 1);
})();
