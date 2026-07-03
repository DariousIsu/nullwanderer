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

  // ── SEARCH FALLBACK (the "what does Lee do?" null → object fix) ────────────────────────────────────
  // quick_lookup dead-ends on the caller's name form ("Lee Zeldin"), but search_entities finds the
  // (duplicate) records; recover the richest by its exact stored name.
  function fallbackDispatch({ people = 'same' } = {}) {
    const SAME = [
      { id: 1, name: 'Lee M Zeldin', entity_type: 'person' },
      { id: 2, name: 'ZELDIN, LEE MICHAEL [H8NY01148]', entity_type: 'person' },
      { id: 3, name: 'Lee M. Zeldin (US-US)', entity_type: 'person' },
    ];
    const DIFF = [
      { id: 4, name: 'John Adam Smith', entity_type: 'person' },
      { id: 5, name: 'John Robert Smith', entity_type: 'person' },
    ];
    const RICH = { result: { entity: { id: 3, name: 'Lee M. Zeldin (US-US)', entity_type: 'person', entity_subtype: 'us_representative', degree: 1600 }, role: 'U.S. Representative', facts: ['Zeldin — title: U.S. Representative'], committees: [], bio: null } };
    return async (tag) => {
      const nm = tag && tag.args && tag.args.name;
      if (tag.name === 'quick_lookup') return { ok: true, text: nm === 'Lee M. Zeldin (US-US)' ? JSON.stringify(RICH) : '' }; // '' → JSON parse fails → null (mirrors the live "Unexpected end of JSON input")
      if (tag.name === 'search_entities') return { ok: true, text: JSON.stringify({ result: people === 'same' ? SAME : DIFF }) };
      if (tag.name === 'db_query') return { ok: true, text: '{"rows":[]}' };
      if (tag.name === 'kg_neighborhood') return { ok: true, text: '{"neighbors":[]}' };
      return { ok: false };
    };
  }
  const oF = await echo.recallObject('Lee Zeldin', { dispatch: fallbackDispatch(), maxNeighbors: 0 });
  ok(oF && oF.degree === 1600, 'quick_lookup dead-end → search fallback recovers the rich record');
  ok(oF && /Representative/i.test(oF.role || ''), 'fallback returns the right person\'s grounding (not null → confab)');

  const oD = await echo.recallObject('John Smith', { dispatch: fallbackDispatch({ people: 'diff' }), maxNeighbors: 0 });
  ok(oD === null, 'different same-named people → fallback declines (bias-to-clarify, no popularity guess)');

  // _sameEntity — subset-containment same-person test (pure).
  ok(echo._sameEntity([{ name: 'Lee Zeldin' }, { name: 'ZELDIN, LEE MICHAEL [H8]' }]) === true, '_sameEntity: middle-name variant is the same person');
  ok(echo._sameEntity([{ name: 'John Adam Smith' }, { name: 'John Robert Smith' }]) === false, '_sameEntity: incompatible extras → different people');
  ok(echo._sameEntity([{ name: 'Lee Zeldin' }]) === true, '_sameEntity: single candidate → same');

  // ── wikiLookup — search → web_extract top page (full body) + lead extracts (the recovery-tier wiring) ──
  const wikiDispatch = async (tag) => {
    if (tag.name === 'mediawiki_search') return { ok: true, text: JSON.stringify({ results: [{ title: 'Administrator of the EPA' }, { title: 'Lisa P. Jackson' }] }) };
    if (tag.name === 'web_extract') return { ok: true, text: JSON.stringify({ url: 'x', text: 'The administrator is the head of the EPA. Lee Zeldin is the current administrator of the EPA.' }) };
    if (tag.name === 'mediawiki_get_extract') return { ok: true, text: JSON.stringify({ title: tag.args.title, extract: 'Lead extract for ' + tag.args.title + ', long enough to pass the forty-character floor easily.' }) };
    return { ok: false };
  };
  const wl = await echo.wikiLookup('current EPA administrator', { dispatch: wikiDispatch });
  ok(wl.length >= 2 && /Zeldin/.test(wl[0].extract) && !/^\s*\{/.test(wl[0].extract), 'wikiLookup: top page body via web_extract carries the incumbent (unwrapped, not raw JSON)');
  ok(wl.some(p => /Lead extract/.test(p.extract)), 'wikiLookup: remaining pages get lead extracts');
  ok((await echo.wikiLookup('x', { dispatch: async () => ({ ok: true, text: '{"results":[]}' }) })).length === 0, 'wikiLookup: no search hits → []');

  // ── _relevanceGate — reject junk FTS resolves, keep legitimate ones (the battery-proven root) ──
  const G = echo._relevanceGate;
  // REJECT: org/place with a qualifier the query didn't ask for (name superset ≠ same entity)
  ok(G('Heritage Foundation', { name: 'HISPANIC HERITAGE FOUNDATION', type: 'organization', subtype: 'lobby_client' }) === false, 'gate: "Hispanic Heritage Foundation" ⊃ "Heritage Foundation" → reject');
  ok(G('Defense', { name: 'AH DEFENSE LLC DBA JVIS DEFENSE', type: 'organization', subtype: 'lobby_client' }) === false, 'gate: "AH DEFENSE LLC" for "Defense" → reject');
  ok(G('Senate', { name: 'CALIFORNIA STATE SENATE', type: 'organization', subtype: 'lobby_client' }) === false, 'gate: "California State Senate" for "Senate" → reject');
  // KEEP: same core name (exact org), and person middle-name variance
  ok(G('Nvidia', { name: 'NVIDIA', type: 'organization', subtype: 'lobby_client' }) === true, 'gate: exact core name "Nvidia" → keep (even a lobby record — currency/wiki uses it correctly)');
  ok(G('NATO', { name: 'NATO', type: 'organization', subtype: 'wikidata_target' }) === true, 'gate: "NATO" == "NATO" → keep');
  ok(G('Lee Zeldin', { name: 'ZELDIN, LEE MICHAEL [H8]', type: 'person', subtype: 'us_representative' }) === true, 'gate: person middle-name variant → keep');
  ok(G('Donald Trump', { name: 'Donald J. Trump [FEC:P80001571]', type: 'person', subtype: 'us_executive' }) === true, 'gate: "Donald Trump" vs "Donald J. Trump" → keep');
  // KEEP: the bill carve-out — canonical name is a number, matches on title → must NOT be name-gated away
  ok(G('Inflation Reduction Act', { name: 'HR 5376 (US, 117)', type: 'bill', subtype: 'bill' }) === true, 'gate: bill carve-out keeps "Inflation Reduction Act" → HR 5376');
  ok(G('anything', null) === false, 'gate: null object → reject');
  // ── office-title gate — a bare office/role title is a CURRENT-HOLDER question, never a same-named junk person ──
  const OT = echo._isBareOfficeTitle;
  ok(OT('president') === true && OT('the president') === true && OT('the CEO') === true, 'office-title: bare "president"/"the president"/"the CEO" → true');
  ok(OT('governor') === true && OT('attorney general') === true && OT('the current chair') === true, 'office-title: "governor"/"attorney general"/"the current chair" → true');
  ok(OT('Marco Rubio') === false && OT('Nvidia') === false && OT('') === false, 'office-title: a real name / org / empty → false');
  ok(OT('president of Microsoft') === false && OT('governor of Texas') === false, 'office-title: a QUALIFIED office (keeps a non-title token) → false (only the bare generic is caught)');
  // the live bug: "who\'s the president?" → "THE PRESIDENT" (a Wisconsin city councilmember) must be REJECTED
  ok(G('president', { name: 'THE PRESIDENT', type: 'person', subtype: 'city_councilmember' }) === false, 'gate: bare "president" → "THE PRESIDENT" councilmember → REJECT (→ ∅ → recovery ladder)');
  ok(G('the CEO', { name: 'THE CEO INC', type: 'person', subtype: 'unclassified' }) === false, 'gate: bare "the CEO" → junk person → REJECT');

  // ── relatedEntities — GRAPH TRAVERSAL via the relations table (kg_neighborhood returns 0; the real edges
  // live here). Extracts role + current (tenure_end=null) from relation_metadata. ──
  const relDispatch = async (tag) => tag.name === 'db_query' ? { ok: true, text: JSON.stringify({ ok: true, rows: [
    { rt: 'HELD_OFFICE', md: '{"tenure_start":"2025-01-20","tenure_end":null,"role_type":"Secretary of State"}', id: 1, nm: 'United States Secretary of State [wd:Q14213]', et: 'position', est: '' },
    { rt: 'HELD_OFFICE', md: '{"tenure_start":"2011-01-03","tenure_end":"2025-01-20"}', id: 2, nm: 'United States senator', et: 'position', est: '' } ] }) } : { ok: false };
  const rel = await echo.relatedEntities(1484834, { dispatch: relDispatch });
  ok(rel.length === 2 && rel[0].relation === 'HELD_OFFICE', 'relatedEntities: walks the relations table (not the dead kg_neighborhood)');
  const current = rel.filter(r => r.current);
  ok(current.length === 1 && /Secretary of State/.test(current[0].name), 'relatedEntities: tenure_end=null → CURRENT office (the live title)');
  ok(rel[1].current === false && rel[1].until === '2025-01-20', 'relatedEntities: tenure_end set → past office');
  ok((await echo.relatedEntities(0, { dispatch: relDispatch })).length === 0, 'relatedEntities: bad id → [] (fail-safe)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
