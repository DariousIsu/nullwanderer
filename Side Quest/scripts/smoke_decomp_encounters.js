/* smoke_decomp_encounters.js — decompose observations become encounters (W2).
 *
 * The load-bearing tests are the REFUSALS and the interpretive split. This translation runs over every
 * landed document, so a wrong class here is wrong 280,000 times: an interpretive edge graded as fact
 * launders a summariser's judgement into a Grade-A claim about the world, and a leaked entity-name
 * relation becomes a structural edge that nothing will ever contradict.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_decomp_encounters.js
 */
'use strict';
const de = require('../lib/decomp_encounters');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const DOC = { id: 42, origin: 'https://apachecountyaz.gov/x', origin_host: 'apachecountyaz.gov', content_hash: 'h1', observed_at: 1600000000000 };
const obs = (o) => ({ status: 'promoted', ...o });

// ── claim classes ────────────────────────────────────────────────────────────────────────────────
ok(de.claimClassFor('exists') === 'existence' && de.claimClassFor('EXISTS') === 'existence', 'exists → existence, case-insensitive');
ok(de.claimClassFor('WORKS_FOR') === 'structural' && de.claimClassFor('LOCATED_IN') === 'structural', 'checkable edges → structural');
ok(de.claimClassFor('HELD_OFFICE') === 'biographical' && de.claimClassFor('BORN_IN') === 'biographical',
  'a past office is BIOGRAPHICAL — it accumulates as history, it does not overwrite');

// THE INTERPRETIVE SPLIT — 30,442 of 280,169 live observations (11%).
ok(de.claimClassFor('RELATED_TO') === 'interpretive' && de.claimClassFor('FOCUSES_ON') === 'interpretive',
  'CRITICAL: RELATED_TO / FOCUSES_ON are a summariser judgement, not an observation');
ok(de.claimClassFor('SUPPORTS') === 'interpretive' && de.claimClassFor('OPPOSES') === 'interpretive',
  'stance is interpretation too — "X supports Y" is read off prose, not observed');
{
  // The payoff, end to end: an interpretive claim must reach the log as interpretive so gradeValue
  // refuses to grade it. Anything else launders consensus-of-summarisers into fact.
  const e = de.toEncounter(obs({ sourceEntity: 'HB 1', relation: 'FOCUSES_ON', target: 'election integrity', type: 'bill' }), DOC);
  ok(e && e.claim_class === 'interpretive', 'CRITICAL: it lands as interpretive, so it can never be graded as truth');
}

// ── THE UNKNOWN-RELATION REFUSAL ─────────────────────────────────────────────────────────────────
// The corpus holds 91 distinct relations; the tail is entity names in the relation slot.
for (const junk of ['MIKADO', 'KAMALA_HARRIS', 'FRESNO', 'SCOTLAND', 'ARTIFICIAL_INTELLIGENCE']) {
  ok(de.claimClassFor(junk) === null, `CRITICAL: leaked entity-name relation "${junk}" is refused, not stored as an edge`);
}
ok(de.toEncounter(obs({ sourceEntity: 'Jane Roe', relation: 'MIKADO', target: 'x', type: 'person' }), DOC) === null,
  'a junk relation produces NO encounter at all');
ok(de.claimClassFor('') === null && de.claimClassFor(null) === null, 'empty relation → refused');

// ── status: a held observation is a candidate, not evidence ──────────────────────────────────────
ok(de.toEncounter({ sourceEntity: 'Jane Roe', relation: 'exists', type: 'person', status: 'held' }, DOC) === null,
  'CRITICAL: material the pipeline itself declined to promote must not vote on a claim');
ok(de.toEncounter(obs({ sourceEntity: 'Jane Roe', relation: 'exists', type: 'person' }), DOC) !== null, 'a promoted one does');

// ── object typing — the type is part of IDENTITY, so a guess is a wrong merge ─────────────────────
ok(de.objectTypeFor('organization') === 'org' && de.objectTypeFor('location') === 'place'
  && de.objectTypeFor('government_body') === 'org' && de.objectTypeFor('committee') === 'org',
  'extractor types map onto the log’s object types');
ok(de.objectTypeFor('other') === null && de.objectTypeFor('nonsense') === null && de.objectTypeFor(null) === null,
  'an untyped entity stays untyped — never guessed');
ok(de.toEncounter(obs({ sourceEntity: 'Tracy the finance lady', relation: 'exists', type: 'other' }), DOC) === null,
  'CRITICAL: an untyped EXISTENCE claim is refused — minting an object we cannot type is the attractor risk');
{
  // SPLIT IDENTITY — caught on a live decompose of doc 6776. "Apache County" arrived as
  // `place:apache county` from its existence claim and `thing:apache county` from its LOCATED_IN edge:
  // two objects, one real thing, every grade computed over half the evidence.
  const e = de.toEncounter(obs({ sourceEntity: 'X', relation: 'WORKS_FOR', target: 'Y', type: 'other' }), DOC);
  ok(e === null,
    'CRITICAL: an untyped EDGE subject is refused — a fallback type forks the object’s identity forever');
  const typed = de.toEncounter(obs({ sourceEntity: 'Apache County', relation: 'LOCATED_IN', target: 'Arizona', type: 'location' }), DOC);
  ok(typed && typed.object_type === 'place',
    'a typed edge keys on the SAME type as that object’s existence claim');
  ok(de.toEncounter(obs({ sourceEntity: 'Apache County', relation: 'exists', type: 'location' }), DOC).object_type === typed.object_type,
    'CRITICAL: existence and edge claims for one object must produce one identity');
}

// ── provenance must travel with the claim ────────────────────────────────────────────────────────
{
  const e = de.toEncounter(obs({ sourceEntity: 'Jane Roe', relation: 'WORKS_FOR', target: 'Apache County', type: 'person' }), DOC);
  ok(e.origin_host === 'apachecountyaz.gov' && e.content_hash === 'h1',
    'CRITICAL: publisher + content hash travel with the claim, or it is permanently ungradeable');
  ok(e.observed_at === 1600000000000, 'the source’s own date travels too');
  ok(e.authority === 'official', 'a .gov publisher is authoritative (§6.3)');
  ok(e.source_ref === 'doc:42', 'it cites the document it came from');
  ok(e.claim_key === 'works_for' && e.claim_value === 'Apache County', 'the edge is keyed by relation, valued by target');
}
{
  // The legacy corpus: no origin. Authority must NOT be invented from nothing.
  const e = de.toEncounter(obs({ sourceEntity: 'Jane Roe', relation: 'exists', type: 'person' }), { id: 9 });
  ok(e.authority === 'unknown' && e.origin_host === null && e.observed_at === null,
    'CRITICAL: no origin → unknown authority, never assumed official');
}

// ── shape ────────────────────────────────────────────────────────────────────────────────────────
{
  const e = de.toEncounter(obs({ sourceEntity: 'Jane Roe', relation: 'exists', type: 'person' }), DOC);
  ok(e.claim_key === null && e.claim_value === null, 'an existence claim has no key or value — it asserts only that the object is real');
}
ok(de.toEncounter(null, DOC) === null && de.toEncounter({}, DOC) === null, 'garbage in → null, never throws');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
