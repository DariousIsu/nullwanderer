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

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
