/* Smoke: lib/doc_decompose — Slice 2a, the PURE typed extractor + hybrid merge (fully offline).
 * Covers: type canonicalization, field/slop rejection, typed parse (ENTITY/REL lines, dedup, caps),
 * the doc-as-uniform-citation assumption, and the HYBRID candidate merge (local ∪ echo, type-prefer).
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_doc_decompose.js
 */
'use strict';
const D = require('../lib/doc_decompose');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- canonType: closed vocab + synonyms + fallback ---
ok(D.canonType('person') === 'person' && D.canonType('Person') === 'person', 'canonType: person (case-insensitive)');
ok(D.canonType('org') === 'organization' && D.canonType('Company') === 'organization' && D.canonType('agency') === 'organization', 'canonType: org synonyms → organization');
ok(D.canonType('GPE') === 'location' && D.canonType('city') === 'location' && D.canonType('country') === 'location', 'canonType: place synonyms → location');
ok(D.canonType('law') === 'bill' && D.canonType('legislation') === 'bill', 'canonType: law/legislation → bill');
ok(D.canonType('sports team') === 'other' && D.canonType('') === 'other' && D.canonType(null) === 'other', 'canonType: unknown/empty → other');

// --- badField: entity vs slop ---
ok(D.badField('he') && D.badField('They') && D.badField('the text'), 'badField: pronouns rejected');
ok(D.badField('a very long clause that clearly is a whole sentence not an entity name at all here') , 'badField: over-length rejected');
ok(D.badField('one two three four five six seven'), 'badField: too many tokens rejected');
ok(!D.badField('Woodrow Wilson') && !D.badField('University of Tulsa'), 'badField: real names accepted');

// --- parseTypedExtraction: ENTITY + REL lines, typing, dedup, slop rejection ---
const raw = [
  'ENTITY: Woodrow Wilson :: person',
  'ENTITY: Princeton University :: org',          // synonym → organization
  'ENTITY: New Jersey :: place',                  // synonym → location
  'ENTITY: he :: person',                         // pronoun → rejected
  'ENTITY: Woodrow Wilson :: person',             // dup → collapsed
  'REL: Woodrow Wilson | LED | Princeton University',
  'REL: Woodrow Wilson | born in | New Jersey',   // lowercase relation → normalized to BORN_IN
  'REL: it | RELATED_TO | New Jersey',            // pronoun source → rejected
  'REL: Woodrow Wilson | LED | Princeton University', // dup → collapsed
  'garbage line with no structure',
].join('\n');
const parsed = D.parseTypedExtraction(raw);
ok(parsed.entities.length === 3, 'parse: 3 entities (pronoun dropped, dup collapsed)');
ok(parsed.entities.find(e => e.name === 'Princeton University').type === 'organization', 'parse: "org" typed → organization');
ok(parsed.entities.find(e => e.name === 'New Jersey').type === 'location', 'parse: "place" typed → location');
ok(parsed.relations.length === 2, 'parse: 2 relations (pronoun-source + dup dropped)');
ok(parsed.relations.some(r => r.relation === 'BORN_IN' && r.source === 'Woodrow Wilson' && r.target === 'New Jersey'), 'parse: "born in" normalized to BORN_IN upper-snake');
ok(parsed.relations.every(r => /^[A-Z][A-Z_]+$/.test(r.relation)), 'parse: every relation is UPPER_SNAKE');

// --- caps ---
const manyE = Array.from({ length: 40 }, (_, i) => `ENTITY: Person Number ${i} :: person`).join('\n');
ok(D.parseTypedExtraction(manyE, { maxEntities: 25 }).entities.length === 25, 'parse: entity cap enforced (25)');
ok(D.parseTypedExtraction('NONE').entities.length === 0 && D.parseTypedExtraction('NONE').relations.length === 0, 'parse: NONE → empty');
ok(D.parseTypedExtraction('').entities.length === 0, 'parse: empty input → empty');

// --- buildTypedPrompt: constrained, includes vocab + the text + optional title ---
const prompt = D.buildTypedPrompt('Some document body about Wilson.', { title: 'Wilson bio' });
const pc = prompt[0].content;
ok(prompt.length === 1 && prompt[0].role === 'user', 'prompt: single user message');
ok(pc.includes('ENTITY:') && pc.includes('REL:') && pc.includes('do NOT infer'), 'prompt: rigid line format + no-infer instruction');
ok(pc.includes('person, organization, location') && pc.includes('RELATED_TO'), 'prompt: entity-type + relation vocab surfaced');
ok(pc.includes('Wilson bio') && pc.includes('Some document body'), 'prompt: title + body embedded');

// --- coreKey: dedup backbone for the hybrid merge ---
ok(D.coreKey('Woodrow Wilson') === D.coreKey('  wilson,  woodrow ') , 'coreKey: order/case/punct-insensitive');
ok(D.coreKey('John R. Curtis') === D.coreKey('John Curtis'), 'coreKey: drops middle initial');
ok(D.coreKey('Curtis [S4UT00282]') === D.coreKey('Curtis'), 'coreKey: strips bracket ids');

// --- mergeCandidates: the HYBRID (local typed ∪ echo candidates) ---
const local = [{ name: 'Woodrow Wilson', type: 'person' }, { name: 'Princeton University', type: 'organization' }];
const echo = [{ name: 'Woodrow Wilson', type: 'other' }, { name: 'Edith Wilson', type: 'person' }];
const merged = D.mergeCandidates(local, echo);
ok(merged.length === 3, 'merge: union deduped to 3 (Wilson collapsed across both)');
const w = merged.find(e => e.name === 'Woodrow Wilson');
ok(w.type === 'person', 'merge: prefers the SPECIFIC type (person) over echo\'s "other"');
ok(w.via === 'both', 'merge: marks an entity seen by both sources as via=both');
ok(merged.find(e => e.name === 'Edith Wilson').via === 'echo', 'merge: an echo-only candidate is kept (via=echo)');
ok(merged.find(e => e.name === 'Princeton University').via === 'local', 'merge: a local-only entity is kept (via=local)');
ok(D.mergeCandidates([], []).length === 0 && D.mergeCandidates(null, null).length === 0, 'merge: empty/null → []');
// echo can surface an entity our local pass missed entirely (the point of the hybrid)
ok(D.mergeCandidates([], [{ name: 'Colonel House', type: 'person' }]).length === 1, 'merge: echo-only entity surfaces even with no local extraction');

// ---------------------------------------------------------------------------
// 2b — disambiguation-on-ingest: resolveExtracted + planEntities (mock resolver = echo_suit.resolveMention).
// ---------------------------------------------------------------------------
// A mock resolver keyed by name → the 4 resolveMention states. Records preferType it was called with.
function mockResolver(map) {
  const seen = [];
  const fn = async (name, { preferType = null } = {}) => { seen.push({ name, preferType }); return map[name] || { status: 'nil', mention: name }; };
  fn.seen = seen;
  return fn;
}

(async () => {
  // resolved → REUSE the existing node (the dup-prevention case).
  const rResolve = mockResolver({ 'Woodrow Wilson': { status: 'resolved', object: { id: 42, name: 'Woodrow Wilson [Q34296]', degree: 40 } } });
  const dReuse = await D.resolveExtracted({ name: 'Woodrow Wilson', type: 'person' }, { resolve: rResolve });
  ok(dReuse.action === 'reuse' && dReuse.object.id === 42, '2b: resolved → REUSE the existing node');
  ok(dReuse.canonical === 'Woodrow Wilson [Q34296]', '2b: reuse carries the canonical stored name (exact node)');
  ok(rResolve.seen[0].preferType === 'person', '2b: passes the extracted type as preferType to the resolver');

  // nil → MINT.
  ok((await D.resolveExtracted({ name: 'Obscure Staffer', type: 'person' }, { resolve: mockResolver({}) })).action === 'mint', '2b: nil → MINT a new object');

  // ambiguous → HOLD (bias-to-clarify), candidates carried.
  const dHold = await D.resolveExtracted({ name: 'John Curtis', type: 'person' }, { resolve: mockResolver({ 'John Curtis': { status: 'ambiguous', candidates: ['John Curtis (UT)', 'John Curtis Marion'] } }) });
  ok(dHold.action === 'hold' && dHold.candidates.length === 2, '2b: ambiguous → HOLD with candidates (never popularity-guess)');

  // error → SKIP.
  ok((await D.resolveExtracted({ name: 'X', type: 'person' }, { resolve: mockResolver({ 'X': { status: 'error' } }) })).action === 'skip', '2b: resolver error → SKIP');
  // resolver throws → SKIP (fail-soft).
  ok((await D.resolveExtracted({ name: 'Y', type: 'person' }, { resolve: async () => { throw new Error('boom'); } })).action === 'skip', '2b: resolver throw → SKIP (never propagates)');
  // bad name / no resolver → SKIP.
  ok((await D.resolveExtracted({ name: 'they', type: 'person' }, { resolve: rResolve })).action === 'skip', '2b: pronoun name → SKIP (bad-name)');
  ok((await D.resolveExtracted({ name: 'Z', type: 'person' }, {})).action === 'skip', '2b: no resolver → SKIP');
  // 'other'-typed entity → no preferType constraint.
  const rOther = mockResolver({});
  await D.resolveExtracted({ name: 'Some Thing', type: 'other' }, { resolve: rOther });
  ok(rOther.seen[0].preferType === null, '2b: an "other"-typed entity passes preferType=null (unconstrained search)');

  // planEntities: decision map + tallies; the "resolves to existing, not a 4th dup" outcome at batch scale.
  const plan = await D.planEntities(
    [{ name: 'Woodrow Wilson', type: 'person' }, { name: 'Edith Wilson', type: 'person' }, { name: 'John Curtis', type: 'person' }],
    { resolve: mockResolver({
      'Woodrow Wilson': { status: 'resolved', object: { id: 42, name: 'Woodrow Wilson [Q34296]' } },
      'Edith Wilson': { status: 'nil' },
      'John Curtis': { status: 'ambiguous', candidates: ['a', 'b'] },
    }) }
  );
  ok(plan.tally.reuse === 1 && plan.tally.mint === 1 && plan.tally.hold === 1, '2b: planEntities tallies reuse/mint/hold');
  ok(plan.byKey.get(D.coreKey('Woodrow Wilson')).action === 'reuse', '2b: decision map lets a relation endpoint look up its entity decision');
  ok(plan.decisions.length === 3, '2b: planEntities returns a decision per entity');

  // -------------------------------------------------------------------------
  // 2c — the DRIVER (decomposeDoc): extract → hybrid → disambiguate → gate → propose → observe.
  // -------------------------------------------------------------------------
  const DOC = { title: 'Woodrow Wilson', url: 'https://en.wikipedia.org/wiki/Woodrow_Wilson', text: 'x'.repeat(50) };
  // per-stream extractor (mock): 3 entities + 3 relations (one endpoint 'Ghost' not in the entity set).
  const extract = async () => ({
    entities: [{ name: 'Woodrow Wilson', type: 'person' }, { name: 'Princeton University', type: 'organization' }, { name: 'Edith Wilson', type: 'person' }],
    relations: [
      { source: 'Woodrow Wilson', relation: 'LEADS', target: 'Princeton University' },   // both resolve → promote
      { source: 'Woodrow Wilson', relation: 'MARRIED_TO', target: 'Edith Wilson' },       // Edith held → fall-through
      { source: 'Woodrow Wilson', relation: 'RELATED_TO', target: 'Ghost Entity' },       // endpoint not extracted → fall-through
    ],
  });
  const echoExtract = async () => [{ name: 'Colonel House', type: 'person' }];            // hybrid adds one
  const resolve = mockResolver({
    'Woodrow Wilson': { status: 'resolved', object: { id: 1, name: 'Woodrow Wilson [Q34296]' } },  // reuse
    'Princeton University': { status: 'nil' },                                            // mint
    'Edith Wilson': { status: 'ambiguous', candidates: ['Edith Wilson', 'Edith B. Wilson'] },      // hold
    'Colonel House': { status: 'nil' },                                                   // mint (echo-surfaced)
  });
  const calls = []; const obs = [];
  const dispatch = async (tag) => { calls.push([tag.name, tag.args]); return { ok: true, text: '{"action":"created"}' }; };
  const observe = async (o) => obs.push(o);

  const res = await D.decomposeDoc(DOC, { extract, echoExtract, resolve, dispatch, observe });
  ok(res.reused === 1 && res.minted === 2, '2c: 1 reuse (Wilson) + 2 mints (Princeton, echo-surfaced House)');
  ok(res.ambiguous === 1, '2c: Edith Wilson (ambiguous) counted as ambiguous');
  ok(res.connections === 1, '2c: only the fully-resolved relation (Wilson→Princeton) is proposed');
  ok(res.held === 3, '2c: 3 fall-throughs held (Edith existence + 2 unresolved-endpoint relations)');
  // canonical-name edge: the proposed relation uses Wilson\'s EXACT stored node name, not the surface form
  const relCall = calls.find(c => c[0] === 'propose_relation');
  ok(relCall && relCall[1].source_name === 'Woodrow Wilson [Q34296]' && relCall[1].target_name === 'Princeton University', '2c: edge targets the CANONICAL reused node name (not a twin)');
  ok(!calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Woodrow Wilson'), '2c: the REUSED entity is NOT re-minted (no dup)');
  ok(calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Princeton University' && c[1].entity_type === 'organization'), '2c: a minted entity carries its TYPE');
  // observations: promoted for mints + the cited edge; held for the fall-throughs
  ok(obs.filter(o => o.status === 'promoted').length === 3, '2c: 3 promoted observations (2 mints + 1 edge)');
  ok(obs.filter(o => o.status === 'held').length === 3, '2c: 3 held observations (the fall-through queue)');
  ok(obs.filter(o => o.status === 'promoted').every(o => o.grade === 'B' && o.url === DOC.url), '2c: every promoted claim is grade B, cited to the doc url');
  const heldEdith = obs.find(o => o.sourceEntity === 'Edith Wilson' && o.status === 'held');
  ok(heldEdith && heldEdith.relation === 'exists', '2c: the ambiguous entity is held as an existence fall-through');

  // requires-citation: a doc with no url yields nothing.
  ok((await D.decomposeDoc({ text: 'body', url: null }, { extract, resolve, dispatch, observe })).reason === 'no-citation', '2c: no doc url → nothing lands (requires citation)');
  ok((await D.decomposeDoc({ text: '', url: 'u' }, { extract, resolve, dispatch, observe })).reason === 'empty-text', '2c: empty text → nothing');

  // volume cap on mints.
  const NAMES = ['Alpha Grady', 'Bravo Hensley', 'Charlie Ipswich', 'Delta Jung', 'Echo Kramer', 'Foxtrot Lorne', 'Golf Mendez', 'Hotel Novak', 'India Osei', 'Juliet Pratt'];
  const bigExtract = async () => ({ entities: NAMES.map(name => ({ name, type: 'person' })), relations: [] });
  const capRes = await D.decomposeDoc({ text: 'x'.repeat(50), url: 'https://ex.com/big' }, { extract: bigExtract, resolve: mockResolver({}), dispatch, observe, cap: { entities: 3 } });
  ok(capRes.minted === 3, '2c: per-doc mint cap enforced (3 of 10)');

  // extractor throws → fail-soft.
  ok((await D.decomposeDoc({ text: 'x'.repeat(50), url: 'u' }, { extract: async () => { throw new Error('boom'); }, resolve, dispatch, observe })).reason === 'extract-failed', '2c: extractor throw → fail-soft (extract-failed)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
