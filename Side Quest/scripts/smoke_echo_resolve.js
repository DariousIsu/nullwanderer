/* Smoke: duplicate-QID resolution (echo_suit.recallObject). A thin FTS match must canonicalize to the
 * RICHEST record sharing its wikidata QID — the live Donald Trump bug: the degree-3 "mayor" twin over
 * his degree-13 "President" record (same QID Q22686, never merged; the type-sweep is blind to it since
 * both are 'person'). Pure/dep-injected dispatch, no DB/model.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_echo_resolve.js
 */
'use strict';
const echo = require('../lib/echo_suit');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

const MAYOR = { result: { entity: { id: 1655518, name: 'Donald Trump [wd:Q22686]', entity_type: 'person', entity_subtype: 'mayor', degree: 3, wikidata_qid: 'Q22686' }, role: 'Mayor', facts: [], committees: [], bio: null } };
const PRES = { result: { entity: { id: 1528616, name: 'Donald Trump (US)', entity_type: 'person', entity_subtype: 'us_executive', degree: 13, wikidata_qid: 'Q22686' }, role: 'President of the United States', facts: ['chamber: US_President', 'party: R'], committees: [], bio: null } };

// quick_lookup by name → the thin mayor twin, UNLESS the President's exact name is requested.
// db_query → the richer same-QID sibling row (or none). kg_neighborhood → empty.
function dispatch({ sibling = true } = {}) {
  return async (tag) => {
    const nm = tag && tag.args && tag.args.name;
    if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify(nm === 'Donald Trump (US)' ? PRES : MAYOR) };
    if (tag.name === 'db_query') return { ok: true, text: JSON.stringify({ ok: true, rows: sibling ? [{ id: 1528616, name: 'Donald Trump (US)', degree: 13 }] : [] }) };
    if (tag.name === 'kg_neighborhood') return { ok: true, text: JSON.stringify({ neighbors: [] }) };
    return { ok: false };
  };
}

(async () => {
  // THE FIX: thin mayor twin → canonicalizes to the degree-13 President record.
  const o = await echo.recallObject('Donald Trump', { dispatch: dispatch(), maxNeighbors: 0 });
  ok(o && o.degree === 13, 'thin "mayor" twin canonicalizes to the degree-13 record');
  ok(o && o.subtype === 'us_executive', 'returns the us_executive record, not "mayor"');
  ok(o && /President/i.test(o.role || ''), 'role is President, not Mayor (correct grounding)');

  // No richer same-QID sibling → keep the base (never a false upgrade / downgrade).
  const o2 = await echo.recallObject('Donald Trump', { dispatch: dispatch({ sibling: false }), maxNeighbors: 0 });
  ok(o2 && o2.degree === 3, 'no richer same-QID sibling → keep the base record');

  // db_query throws → fail-soft, keep the base (never crashes the turn).
  const failD = async (tag) => {
    if (tag.name === 'db_query') throw new Error('db_query unavailable');
    if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify({ result: { entity: { id: 1, name: 'X', entity_type: 'person', degree: 3, wikidata_qid: 'Q1' }, facts: [], committees: [] } }) };
    return { ok: false };
  };
  const o3 = await echo.recallObject('X', { dispatch: failD, maxNeighbors: 0 });
  ok(o3 && o3.degree === 3, 'db_query error → fail-soft, keep the base record');

  // A RICH base (degree >= 8) skips canonicalization entirely — no db_query cost on clean hits.
  let dbCalled = false;
  const richD = async (tag) => {
    if (tag.name === 'db_query') { dbCalled = true; return { ok: true, text: '{"rows":[]}' }; }
    if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify({ result: { entity: { id: 9, name: 'Rich', entity_type: 'person', degree: 20, wikidata_qid: 'Q9' }, facts: [], committees: [] } }) };
    return { ok: false };
  };
  const o4 = await echo.recallObject('Rich', { dispatch: richD, maxNeighbors: 0, preferType: 'person' });
  ok(o4 && o4.degree === 20 && !dbCalled, 'a rich base skips canonicalization (no db_query on clean hits)');

  // No QID on the base → canonicalization skipped (nothing to key on).
  let dbCalled2 = false;
  const noQidD = async (tag) => {
    if (tag.name === 'db_query') { dbCalled2 = true; return { ok: true, text: '{"rows":[]}' }; }
    if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify({ result: { entity: { id: 7, name: 'NoQid', entity_type: 'person', degree: 2 }, facts: [], committees: [] } }) };
    return { ok: false };
  };
  const o5 = await echo.recallObject('NoQid', { dispatch: noQidD, maxNeighbors: 0, preferType: 'person' });
  ok(o5 && o5.degree === 2 && !dbCalled2, 'no QID on the base → canonicalization skipped (no db_query)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
