/* smoke_type_adjudicator.js — a relation endpoint is an entity, and one cheap call types it.
 *
 * The failure this closes, measured on the live corpus: raineyfreedom.org extracted 26 relations —
 * "Mia Heck WORKS_FOR Rainey Center Freedom Project", "Rainey Center RELATED_TO Joseph Rainey Center
 * for Public Policy" — declared ZERO entity lines, and every single relation landed HELD. The page was
 * read perfectly and produced nothing, because 2c only proposes a relation when BOTH endpoints resolve.
 *
 * Two halves, deliberately separated:
 *   DETERMINISTIC  an endpoint named in a REL line IS an entity. No model needed.
 *   JUDGEMENT      what KIND of thing it is. A REL line cannot say, and guessing from the relation is
 *                  the "role became the type" bug. That is the cloud call.
 *
 * Offline — the model is stubbed.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_type_adjudicator.js
 */
'use strict';
const D = require('../lib/doc_decompose');
const lane = require('../lib/decomp_lane');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const REL = [
  { source: 'Mia Heck', relation: 'WORKS_FOR', target: 'Rainey Center Freedom Project' },
  { source: 'Rainey Center', relation: 'RELATED_TO', target: 'Joseph Rainey Center for Public Policy' },
];

// ── DETERMINISTIC: the endpoints are entities ────────────────────────────────────────────────────
{
  const out = D.backfillEndpointEntities([], REL);
  ok(out.length === 4, 'CRITICAL: every relation endpoint becomes an entity — otherwise the relation can never land');
  ok(out.every((e) => e.via === 'endpoint'), 'backfilled entities are tagged as recovered, not as declared');
  ok(out.every((e) => e.type === 'other'),
    'CRITICAL: a REL line says NOTHING about kind — typing from the relation would be the "role became the type" bug');
}
{
  const out = D.backfillEndpointEntities([{ name: 'Mia Heck', type: 'person' }], REL);
  ok(out.filter((e) => /mia heck/i.test(e.name)).length === 1, 'an already-declared entity is not duplicated');
  ok(out.find((e) => /mia heck/i.test(e.name)).type === 'person', '…and keeps its declared type');
}
ok(D.backfillEndpointEntities([], []).length === 0 && D.backfillEndpointEntities(null, null).length === 0,
  'no relations → nothing invented; garbage in → empty, never throws');
{
  // Slop must not become an entity just because it appeared in a relation slot.
  const junk = [{ source: 'it', relation: 'RELATED_TO', target: 'The quick brown fox jumped over the lazy dog and kept running' }];
  ok(D.backfillEndpointEntities([], junk).length === 0, 'CRITICAL: a pronoun and a sentence are still refused');
}

// ── JUDGEMENT: the adjudicator PROPOSES ──────────────────────────────────────────────────────────
const stub = (reply) => async () => ({ text: reply });

(async () => {
  {
    const adj = lane.makeTypeAdjudicator({ completeFn: stub(
      'Mia Heck :: person\nRainey Center Freedom Project :: organization\n'), model: 'test' });
    const t = await adj(['Mia Heck', 'Rainey Center Freedom Project'], { title: 'x', relations: REL });
    ok(t['Mia Heck'] === 'person' && t['Rainey Center Freedom Project'] === 'organization', 'it types the endpoints');
  }
  {
    // "other" is a refusal, and must not be recorded as a type.
    const adj = lane.makeTypeAdjudicator({ completeFn: stub('Mia Heck :: other\n'), model: 'test' });
    ok(Object.keys(await adj(['Mia Heck'], {})).length === 0,
      'CRITICAL: "other" means the model would not commit — it is dropped, not filed as a type');
  }
  {
    // It must never introduce a name we did not ask about.
    const adj = lane.makeTypeAdjudicator({ completeFn: stub('Mia Heck :: person\nVladimir Putin :: person\n'), model: 'test' });
    const t = await adj(['Mia Heck'], {});
    ok(t['Mia Heck'] === 'person' && !('Vladimir Putin' in t),
      'CRITICAL: a name the model invented is REFUSED — the adjudicator types, it does not extract');
  }
  {
    const adj = lane.makeTypeAdjudicator({ completeFn: async () => { throw new Error('cloud down'); }, model: 'test' });
    ok(Object.keys(await adj(['Mia Heck'], {})).length === 0, 'a failed call leaves everything untyped — advisory, never fatal');
    const none = lane.makeTypeAdjudicator({ completeFn: stub('x'), model: null });
    ok(Object.keys(await none(['A'], {})).length === 0, 'no model → no types, no throw');
  }

  // ── END TO END: the exact live shape — relations, no entity lines ───────────────────────────────
  {
    const raw = 'REL: Mia Heck | WORKS_FOR | Rainey Center Freedom Project\nREL: Rainey Center | RELATED_TO | Joseph Rainey Center for Public Policy';
    const extract = lane.makeCloudExtractor({
      completeFn: stub(raw), model: 'test',
      adjudicateTypes: async (names) => Object.fromEntries(names.map((n) => [n, /heck/i.test(n) ? 'person' : 'organization'])),
    });
    const r = await extract('page text', { title: 'Rainey Freedom Project' });
    ok(r.relations.length === 2, 'the relations survive');
    ok(r.entities.length === 4, 'CRITICAL: 26 relations with zero ENTITY lines no longer yields zero entities');
    ok(r.entities.find((e) => e.name === 'Mia Heck').type === 'person'
      && r.entities.find((e) => e.name === 'Rainey Center Freedom Project').type === 'organization',
      'CRITICAL: the recovered endpoints come back TYPED, so they can mint and their relation can land');
  }
  {
    // With the adjudicator switched off, the endpoints still come back — untyped, which is honest.
    const raw = 'REL: A Person | WORKS_FOR | Some Org';
    const extract = lane.makeCloudExtractor({ completeFn: stub(raw), model: 'test', adjudicateTypes: null });
    const r = await extract('t', {});
    ok(r.entities.length === 2 && r.entities.every((e) => e.type === 'other'),
      'no adjudicator → endpoints recovered but untyped; the deterministic half does not depend on the cloud');
  }
  {
    // A well-behaved model that DOES declare its entities must be unaffected.
    const raw = 'ENTITY: Jane Roe :: person\nREL: Jane Roe | WORKS_FOR | Apache County';
    let called = 0;
    const extract = lane.makeCloudExtractor({ completeFn: stub(raw), model: 'test', adjudicateTypes: async (n) => { called += 1; return {}; } });
    const r = await extract('t', {});
    ok(r.entities.find((e) => e.name === 'Jane Roe').type === 'person', 'a declared entity keeps its declared type');
    ok(called === 1 && r.entities.length === 2, 'only the UNDECLARED endpoint (Apache County) is sent for adjudication');
  }

  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
