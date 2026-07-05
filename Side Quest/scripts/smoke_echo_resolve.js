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

  // ── PROMINENCE GATE (R1) — a bare famous name must NOT resolve to a high-degree, QID-less civic namesake
  // when a far-more-prominent same-name human exists (the JFK → GA-state-senator bug). External Wikidata
  // sitelinks are the oracle; the gate fires only on the suspect signature. ──
  const CIVIC = echo._isCivicLocalNamesake;
  ok(CIVIC({ type: 'person', subtype: 'state_senator', wikidata_qid: null }) === true, 'civic-namesake: person / state_senator / no QID → suspect');
  ok(CIVIC({ type: 'person', subtype: 'state_senator', wikidata_qid: 'Q9696' }) === false, 'civic-namesake: a QID (global identity) → trusted, not suspect');
  ok(CIVIC({ type: 'person', subtype: 'us_senator', wikidata_qid: null }) === false, 'civic-namesake: FEDERAL subtype (us_senator) → not suspect (legit answer)');
  ok(CIVIC({ type: 'person', subtype: 'legislator_legacy', wikidata_qid: null }) === true, 'civic-namesake: legislator_legacy / no QID → suspect');
  ok(CIVIC({ type: 'organization', subtype: 'lobby_client', wikidata_qid: null }) === false, 'civic-namesake: non-person → never suspect');

  const JFK_GA = { id: 1461086, name: 'John F. Kennedy (GA)', type: 'person', subtype: 'state_senator', degree: 1533, wikidata_qid: null, facts: [], committees: [] };
  const probePresident = async () => ({ found: true, qid: 'Q9696', sitelinks: 250, description: 'president of the United States from 1961 to 1963 (1917-1963)', label: 'John F. Kennedy' });

  const pc = await echo.prominenceCheck('John F. Kennedy', JFK_GA, { probeFn: probePresident });
  ok(pc && pc.status === 'mismatch', 'prominenceCheck: famous name + QID-less state senator + prominent Wikidata human → MISMATCH');
  ok(pc && pc.prominent && pc.prominent.qid === 'Q9696' && pc.prominent.sitelinks === 250, 'prominenceCheck: surfaces the prominent referent (Q9696, 250 sitelinks)');
  ok(pc && /president/i.test(pc.note) && /state senator/i.test(pc.note) && /John F\. Kennedy \(GA\)/.test(pc.note), 'prominenceCheck: IDENTITY note answers-famous + footnotes the namesake we hold');

  // Below the sitelinks floor → NOT a mismatch (don't decline a genuinely local record).
  const pcLow = await echo.prominenceCheck('John F. Kennedy', JFK_GA, { probeFn: async () => ({ found: true, qid: 'Qx', sitelinks: 2, description: 'a person' }) });
  ok(pcLow && pcLow.status === 'ok', 'prominenceCheck: same-name human below the sitelinks floor → ok (no false decline)');

  // Probe not called when the KG record already carries a QID (global identity → trusted, no external cost).
  let probedQid = false;
  const pcQid = await echo.prominenceCheck('John Kennedy', { type: 'person', subtype: 'us_senator', wikidata_qid: 'Q6250211', name: 'John Kennedy (US-US)' }, { probeFn: async () => { probedQid = true; return { found: true, sitelinks: 300 }; } });
  ok(pcQid.status === 'ok' && !probedQid, 'prominenceCheck: KG record has a QID → skip the probe entirely (no latency)');

  // Bare single-token surname → not a confident famous-name query → no probe.
  let probedBare = false;
  const pcBare = await echo.prominenceCheck('Kennedy', JFK_GA, { probeFn: async () => { probedBare = true; return { found: true, sitelinks: 250 }; } });
  ok(pcBare.status === 'ok' && !probedBare, 'prominenceCheck: bare surname (1 token) → no probe (avoids over-firing)');

  // Probe absent / not-found → fail-soft ok (keeps the resolved object).
  const pcMiss = await echo.prominenceCheck('John F. Kennedy', JFK_GA, { probeFn: async () => ({ found: false }) });
  ok(pcMiss.status === 'ok', 'prominenceCheck: probe finds nothing → ok (fail-soft, keeps the object)');

  // ── prominenceProbe — parse the Wikidata SPARQL response through both web_fetch shapes (wrapped preview /
  // direct body) and extract QID + sitelink count. ──
  const SPARQL_JFK = JSON.stringify({ results: { bindings: [{ item: { value: 'http://www.wikidata.org/entity/Q9696' }, sitelinks: { value: '250' }, desc: { value: 'president of the United States from 1961 to 1963' } }] } });
  const wrapped = async (tag) => tag.name === 'web_fetch' ? { ok: true, text: JSON.stringify({ status_code: 200, tier: 'curl_cffi', text_preview: SPARQL_JFK }) } : { ok: false };
  const direct = async (tag) => tag.name === 'web_fetch' ? { ok: true, text: SPARQL_JFK } : { ok: false };
  const empty = async (tag) => tag.name === 'web_fetch' ? { ok: true, text: JSON.stringify({ text_preview: JSON.stringify({ results: { bindings: [] } }) }) } : { ok: false };
  const pw = await echo.prominenceProbe('John F. Kennedy', { dispatch: wrapped });
  ok(pw.found && pw.qid === 'Q9696' && pw.sitelinks === 250 && /president/i.test(pw.description || ''), 'prominenceProbe: parses web_fetch-wrapped SPARQL (Q9696, 250 sitelinks, desc)');
  const pd = await echo.prominenceProbe('John F. Kennedy', { dispatch: direct });
  ok(pd.found && pd.qid === 'Q9696' && pd.sitelinks === 250, 'prominenceProbe: parses direct-body SPARQL shape too');
  ok((await echo.prominenceProbe('Nobody At All', { dispatch: empty })).found === false, 'prominenceProbe: no bindings → {found:false}');
  ok((await echo.prominenceProbe('X', { dispatch: async () => ({ ok: true, text: 'not json' }) })).found === false, 'prominenceProbe: unparseable response → fail-soft {found:false}');

  // ── CONTEXT-AWARE DISAMBIGUATION (R2) — an ambiguous mention resolved by its doc's co-occurring entities.
  // The Rainey Center case: two org records; the one whose signature overlaps the roster's people wins. ──
  const CS = echo._contextScore, PK = echo._pickByContext;
  // _contextScore: counts context entities (by core-name key) present in a candidate signature.
  ok(CS('board members: sean mcelwee, devan patel; lamp network', ['sean mcelwee', 'devan patel']) === 2, '_contextScore: 2 context entities present → 2');
  ok(CS('a lobbying registration, no people', ['sean mcelwee', 'devan patel']) === 0, '_contextScore: none present → 0');
  ok(CS('john robert smith gave a talk', ['john smith']) === 1, '_contextScore: all core tokens present (order-free) → match');
  ok(CS('', ['x']) === 0 && CS('sig', []) === 0, '_contextScore: empty signature or context → 0');
  // _pickByContext: strict dominance only (bias-to-clarify).
  ok(PK([{ name: 'A', score: 3 }, { name: 'B', score: 1 }]).name === 'A', '_pickByContext: strict winner → A');
  ok(PK([{ name: 'A', score: 2 }, { name: 'B', score: 2 }]) === null, '_pickByContext: a TIE stays ambiguous (null)');
  ok(PK([{ name: 'A', score: 0 }, { name: 'B', score: 0 }]) === null, '_pickByContext: all-zero → null (no signal)');
  ok(PK([{ name: 'A', score: 1 }]).name === 'A', '_pickByContext: single candidate with a hit → resolve');

  // _disambiguateByContext: pulls each candidate signature via get_entity, picks the overlap winner.
  const distinct = [{ name: 'Joseph Rainey Center for Public Policy' }, { name: 'RAINEY CENTER FREEDOM PROJECT, INC.' }];
  const sigDispatch = async (tag) => {
    if (tag.name !== 'get_entity') return { ok: false };
    const nm = tag.args.name;
    if (/Public Policy/.test(nm)) return { ok: true, text: JSON.stringify({ result: { summary: 'policy think tank', relations: [{ target_name: 'Sean McElwee' }, { target_name: 'Devan Patel' }] } }) };
    return { ok: true, text: JSON.stringify({ result: { summary: 'lobbying registration', relations: [] } }) };
  };
  const winner = await echo._disambiguateByContext(sigDispatch, distinct, ['Sean McElwee', 'Devan Patel', 'Rainey Center'], echo._coreNameKey('Rainey Center'));
  ok(winner && /Public Policy/.test(winner.name), '_disambiguateByContext: the org whose signature overlaps the roster wins');
  // no distinguishing context → null (both score 0)
  const noWin = await echo._disambiguateByContext(sigDispatch, distinct, ['Unrelated Person'], echo._coreNameKey('Rainey Center'));
  ok(noWin === null, '_disambiguateByContext: no overlap → null (stays ambiguous)');
  ok((await echo._disambiguateByContext(sigDispatch, distinct, [], 'k')) === null, '_disambiguateByContext: empty context → null');

  // resolveMention end-to-end: two candidates + context → resolves via context (status resolved, via:context).
  const rmDispatch = async (tag) => {
    if (tag.name === 'search_entities') return { ok: true, text: JSON.stringify({ result: [{ id: 1, name: 'Joseph Rainey Center for Public Policy', entity_type: 'organization' }, { id: 2, name: 'RAINEY CENTER FREEDOM PROJECT, INC.', entity_type: 'organization' }] }) };
    if (tag.name === 'get_entity') { const nm = tag.args.name; return { ok: true, text: JSON.stringify({ result: /Public Policy/.test(nm) ? { summary: 'x', relations: [{ target_name: 'Sean McElwee' }] } : { summary: 'y', relations: [] } }) }; }
    if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify({ result: { entity: { id: 1, name: 'Joseph Rainey Center for Public Policy', entity_type: 'organization', degree: 12 }, facts: [], committees: [] } }) };
    if (tag.name === 'db_query') return { ok: true, text: '{"rows":[]}' };
    if (tag.name === 'kg_neighborhood') return { ok: true, text: '{"neighbors":[]}' };
    return { ok: false };
  };
  const rmCtx = await echo.resolveMention('Rainey Center', { dispatch: rmDispatch, context: ['Sean McElwee', 'Rainey Center'] });
  ok(rmCtx.status === 'resolved' && rmCtx.via === 'context' && /Public Policy/.test(rmCtx.object.name), 'resolveMention: ambiguous + context → RESOLVED via context to the overlapping org');
  // WITHOUT context → still ambiguous (backward-compatible; no popularity guess)
  const rmNo = await echo.resolveMention('Rainey Center', { dispatch: rmDispatch });
  ok(rmNo.status === 'ambiguous' && rmNo.candidates.length === 2, 'resolveMention: NO context → ambiguous (unchanged behavior)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
