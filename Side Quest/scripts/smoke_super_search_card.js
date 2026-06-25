/**
 * Offline smoke for Super Search SLICE 1 (studio/super_search_card.js):
 * the standardized ResultCard contract + the recipe registry skeleton (one recipe: knowledge).
 * Pure deterministic — no cloud, no live engine; the search_knowledge tool is injected as a stub
 * returning the REAL shape captured live (2026-06-24) so the mapper is proven against reality.
 *
 * Run: node scripts/smoke_super_search_card.js
 */
const SC = require('../studio/super_search_card');
const {
  djb2, cleanText, leadTitle, scoreFromRank,
  normalizeCard, validateCard, knowledgeRecipe, runRecipe, recipes, PLANES,
} = SC;

let pass = 0, fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

// ---- deterministic atoms ---------------------------------------------------------------------
ok('djb2 is deterministic', djb2('snowpack') === djb2('snowpack'));
ok('djb2 differs by input', djb2('snowpack') !== djb2('cloud seeding'));
ok('djb2 handles null without throw', typeof djb2(null) === 'string');
ok('cleanText strips <mark> tags', cleanText('a <mark>Cloud</mark> <mark>Seeding</mark> b') === 'a Cloud Seeding b');
ok('cleanText collapses whitespace', cleanText('  a   b\n c ') === 'a b c');
ok('leadTitle drops leading ellipsis', !/^[.…]/.test(leadTitle('...Programs Cloud Seeding Program DRI')));
ok('leadTitle bounded + word-boundary', (() => { const t = leadTitle('a'.repeat(40) + ' ' + 'b'.repeat(60), 80); return t.length <= 81 && t.endsWith('…'); })());
ok('leadTitle short snippet returned whole', leadTitle('Short title here', 80) === 'Short title here');
ok('scoreFromRank flips sign (bm25 more-neg = better)', scoreFromRank(-30.66) > scoreFromRank(-26.54));
ok('scoreFromRank non-finite → 0', scoreFromRank(undefined) === 0);

// ---- card contract ---------------------------------------------------------------------------
const full = normalizeCard({ id: 'x', plane: 'internal', source: 'knowledge', title: 't', snippet: 's', score: 5 });
ok('normalizeCard fills all frozen fields', SC.CARD_FIELDS.every(f => f in full));
ok('normalizeCard defaults url=null rank=null enrich={} cite="" raw_ref=null',
  full.url === null && full.rank === null && JSON.stringify(full.enrich) === '{}' && full.cite === '' && full.raw_ref === null);
ok('valid card validates', validateCard(full).valid);
ok('missing required flagged not guessed', (() => { const v = validateCard(normalizeCard({ plane: 'internal', source: 'k', score: 1 })); return !v.valid && v.missing.includes('id') && v.missing.includes('title'); })());
ok('bad plane flagged', !validateCard(normalizeCard({ id: 'a', plane: 'sideways', source: 'k', title: 't', snippet: 's', score: 1 })).valid);
ok('normalizeCard floors a bad score to 0 (defined default, not a guess)', normalizeCard({ id: 'a', plane: 'internal', source: 'k', title: 't', snippet: 's', score: 'NaNish' }).score === 0);
ok('validator guards a raw non-numeric score', validateCard({ id: 'a', plane: 'internal', source: 'k', title: 't', snippet: 's', score: 'NaNish' }).missing.includes('score'));
ok('PLANES frozen to internal/external', JSON.stringify(PLANES) === JSON.stringify(['internal', 'external']));

// ---- knowledge recipe over the REAL search_knowledge shape -----------------------------------
// Captured live from search_knowledge(query='snowpack augmentation cloud seeding', source='wikipedia').
const KNOWLEDGE_RESULT = {
  result: [
    { source: 'wikipedia', snippet: '...Programs <mark>Cloud</mark> <mark>Seeding</mark> Program DRI weather modification research produced the Nevada State <mark>Cloud</mark> <mark>Seeding</mark> Program in the 1960s.', rank: -30.65948591807206, civic_links: [{ entity_id: 42, name: 'Bureau of Reclamation' }] },
    { source: 'wikipedia', snippet: '...the WWMPP study concluded that "<mark>seeding</mark> could <mark>augment</mark> the <mark>snowpack</mark> by a maximum of 3% over an entire season." [ 12 ]', rank: -26.537054845068198 },
  ],
};
const stubDeps = { callTool: async (tool, args) => { stubDeps._last = { tool, args }; return KNOWLEDGE_RESULT; } };

(async () => {
  const cards = knowledgeRecipe.toCards(KNOWLEDGE_RESULT.result);
  ok('toCards yields one card per hit', cards.length === 2);
  ok('every card is contract-valid', cards.every(c => validateCard(c).valid), JSON.stringify(cards.map(c => validateCard(c).missing)));
  ok('plane=internal, source=knowledge', cards.every(c => c.plane === 'internal' && c.source === 'knowledge'));
  ok('snippet stripped of <mark>', cards.every(c => !/<mark>/.test(c.snippet)));
  ok('title derived (non-empty, no leading ellipsis)', cards.every(c => c.title && !/^[.…]/.test(c.title)));
  ok('url null (knowledge FTS has none)', cards.every(c => c.url === null));
  ok('score ordering matches bm25 (hit1 > hit2)', cards[0].score > cards[1].score);
  ok('id stable + deterministic', cards[0].id === knowledgeRecipe.toCards(KNOWLEDGE_RESULT.result)[0].id && cards[0].id.startsWith('knowledge:wikipedia:'));
  ok('corpus carried in enrich', cards.every(c => c.enrich.corpus === 'wikipedia'));
  ok('civic_links spine surfaced when present', cards[0].enrich.civic_links && cards[0].enrich.civic_links.length === 1);
  ok('civic_links absent when hit lacks them', !('civic_links' in cards[1].enrich));
  ok('cite non-empty (feeds cite_floor)', cards.every(c => c.cite.length > 0));
  ok('raw_ref points back to source hit', cards[0].raw_ref === KNOWLEDGE_RESULT.result[0]);

  // ---- runRecipe orchestration: enabled gate · injected deps · fail-safe ----------------------
  const enabled = await runRecipe(knowledgeRecipe, { query: 'snowpack', plan: null, deps: stubDeps });
  ok('runRecipe returns {source,cards,error}', enabled.source === 'knowledge' && Array.isArray(enabled.cards) && enabled.error === null);
  ok('runRecipe passed include_civic_links + query to tool', stubDeps._last.tool === 'search_knowledge' && stubDeps._last.args.query === 'snowpack' && stubDeps._last.args.include_civic_links === true);
  ok('runRecipe maps to 2 cards', enabled.cards.length === 2);

  const planTargetsOther = await runRecipe(knowledgeRecipe, { query: 'x', plan: { internal_targets: ['bills'] }, deps: stubDeps });
  ok('disabled by plan targets → skipped, no cards', planTargetsOther.skipped === true && planTargetsOther.cards.length === 0);

  const planTargetsKnowledge = await runRecipe(knowledgeRecipe, { query: 'x', plan: { internal_targets: ['knowledge', 'bills'] }, deps: stubDeps });
  ok('enabled when plan includes knowledge', !planTargetsKnowledge.skipped && planTargetsKnowledge.cards.length === 2);

  const throwingDeps = { callTool: async () => { throw new Error('engine down'); } };
  const failed = await runRecipe(knowledgeRecipe, { query: 'x', plan: null, deps: throwingDeps });
  ok('tool error captured, never thrown', failed.cards.length === 0 && /engine down/.test(failed.error));

  // ---- registry skeleton ----------------------------------------------------------------------
  ok('registry exposes the knowledge recipe', recipes().some(r => r.id === 'knowledge'));
  ok('every registered recipe has the recipe shape', recipes().every(r => r.id && PLANES.includes(r.plane) && typeof r.enabled === 'function' && typeof r.run === 'function' && typeof r.toCards === 'function'));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
