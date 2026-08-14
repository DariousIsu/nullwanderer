/* Smoke: lib/active_recall — active DB integration. Deterministic (injected retrieve/graph fns).
 * Proves: coverage rich/thin (incl. verified_fact → rich, graph facts → rich); knowledgeBlock emits
 * the ACTIVE "build past it / don't re-research" directive on a rich hit (vs "build on it" when thin);
 * formatConsolidation produces the read-your-own-memory note; _relStr handles graph shapes.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_active_recall.js
 */
const ar = require('C:/Users/azrae/Desktop/Side Quest/lib/active_recall');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
const note = (source, content, prov) => ({ source, content, kind: 'note', provenance: prov ? JSON.stringify(prov) : null });
const noGraph = () => [];

(async () => {
  try {
    // coverage: 3 notes → rich
    const r3 = await ar.recall('epistemology', { retrieveFn: async () => [note('reflection_knowledge', 'Descartes was a rationalist'), note('reflection_knowledge', 'Locke was an empiricist'), note('learning', 'Kant synthesized both')], graphFn: noGraph });
    ok(r3.coverage === 'rich', '3 on-topic notes → rich');
    // 1 note → thin
    const r1 = await ar.recall('obscure', { retrieveFn: async () => [note('reflection_knowledge', 'one thing')], graphFn: noGraph });
    ok(r1.coverage === 'thin', '1 note → thin');
    // 0 notes → thin
    const r0 = await ar.recall('nothing', { retrieveFn: async () => [], graphFn: noGraph });
    ok(r0.coverage === 'thin', '0 notes → thin');
    // a single verified_fact → rich (a known fact is enough to answer)
    const rv = await ar.recall('president', { retrieveFn: async () => [note('verified_fact', 'X is president', { as_of: '2026' })], graphFn: noGraph });
    ok(rv.coverage === 'rich', 'a verified_fact alone → rich');
    // graph facts alone → rich
    const rg = await ar.recall('kant', { retrieveFn: async () => [], graphFn: () => ['Kant influenced epistemology', 'Kant wrote Critique', 'Kant relates to ethics'] });
    ok(rg.coverage === 'rich', '3 graph facts → rich');

    // DISAMBIGUATION (Stage 2): resolveMention finds 2+ genuinely-different same-name entities → recall
    // surfaces `ambiguous` (main.js ASKs) and pulls NO object; a single resolved entity → object, no ambiguity.
    const rAmb = await ar.recall('John Kennedy', { retrieveFn: async () => [], graphFn: noGraph, resolveFn: async () => ({ status: 'ambiguous', candidates: ['John F. Kennedy', 'John F. Kennedy (GA)'] }) });
    ok(rAmb.ambiguous && rAmb.ambiguous.candidates.length === 2 && !rAmb.object, 'recall: 2+ same-name entities → ambiguous (ASK), no object');
    const rRes = await ar.recall('John Curtis', { retrieveFn: async () => [], graphFn: noGraph, prominenceFn: async () => ({ status: 'ok' }), resolveFn: async () => ({ status: 'resolved', object: { id: 1, name: 'John Curtis', entity_type: 'person', degree: 320, facts: ['a', 'b', 'c', 'd'], committees: [] } }) });
    ok(!rRes.ambiguous && rRes.object && rRes.object.degree === 320, 'recall: single resolved entity → object, no ambiguity');

    // knowledgeBlock: rich → ACTIVE directive
    const blk = await ar.knowledgeBlock('epistemology', { retrieveFn: async () => [note('verified_fact', 'X is fact', { as_of: '2026' }), note('learning', 'Y learned'), note('reflection_knowledge', 'Z noted')], graphFn: noGraph });
    ok(/WHAT YOU ALREADY KNOW about "epistemology"/.test(blk), 'block headers the topic');
    ok(/\[VERIFIED as of 2026\]/.test(blk) && /\[learned\]/.test(blk) && /\[note\]/.test(blk), 'tags rendered across sources');
    ok(/do NOT restate it or look it up again/.test(blk) && /Extend the frontier/.test(blk), 'rich hit → ACTIVE "do not re-research" directive');

    // thin → softer directive
    const blkThin = await ar.knowledgeBlock('obscure', { retrieveFn: async () => [note('reflection_knowledge', 'one bit')], graphFn: noGraph });
    ok(/build on it/.test(blkThin) && !/do NOT restate it or look it up again/.test(blkThin), 'thin hit → "build on it", no hard stop');

    // empty → null
    ok((await ar.knowledgeBlock('x', { retrieveFn: async () => [], graphFn: noGraph })) === null, 'no recall → null block');

    // formatConsolidation
    const cons = ar.formatConsolidation({ topic: 'epistemology', notes: [note('reflection_knowledge', 'Descartes was a rationalist')], facts: ['Kant influenced epistemology'] });
    ok(/I checked my own memory on "epistemology"/.test(cons) && /Descartes was a rationalist/.test(cons) && /what specifically don't I know/.test(cons), 'consolidation reads her own memory + asks the gap');

    // _relStr shapes
    ok(ar._relStr({ source: 'Kant', type: 'INFLUENCED', target: 'epistemology' }) === 'Kant influenced epistemology', '_relStr triple');
    ok(ar._relStr({ name: 'Descartes', summary: 'rationalist' }) === 'Descartes: rationalist', '_relStr name+summary');
    ok(ar._relStr(null) === null, '_relStr null-safe');

    // ECHO master-DB integration: hits merge into recall + drive coverage; rendered as [echo:*]
    const echoFn = async () => [{ source: 'echo:wikipedia', content: 'Epistemology examines the nature of knowledge' }, { source: 'echo:wikipedia', content: 'Empiricism vs rationalism' }];
    const re = await ar.recall('epistemology', { retrieveFn: async () => [], graphFn: noGraph, echoFn });
    ok(re.echo === 2 && re.coverage === 'rich', '2 echo (master-DB) hits → rich even with 0 local notes');
    const blkE = await ar.knowledgeBlock('epistemology', { retrieveFn: async () => [], graphFn: noGraph, echoFn });
    ok(/\[echo:wikipedia\] Epistemology examines/.test(blkE), 'echo hits surface tagged [echo:wikipedia]');

    // echo_suit.recallKnowledge — parses a search_knowledge dispatch result, fail-safe when down
    const es = require('C:/Users/azrae/Desktop/Side Quest/lib/echo_suit');
    es._setLiveForTest({ connected: true, dispatch: async () => ({ ok: true, text: JSON.stringify({ result: [{ source: 'wikipedia', snippet: '<mark>QCD</mark> is a theory of the strong force' }] }) }) });
    const hits = await es.recallKnowledge('quantum chromodynamics');
    ok(hits.length === 1 && hits[0].source === 'echo:wikipedia' && /QCD is a theory/.test(hits[0].content), 'recallKnowledge normalizes a master-DB hit (mark tags stripped)');
    es._setLiveForTest(null);
    ok((await es.recallKnowledge('anything')).length === 0, 'recallKnowledge fail-safe [] when suit not connected');

    // ── OBJECT PULL (Slice 1 — Echo-search-first) — the real Curtis quick_lookup shape ──
    const curtisResult = { entity: { id: 1519559, name: 'John Curtis (US)', entity_type: 'person', entity_subtype: 'legislator_legacy', degree: 320 }, role: 'US_Senate R (US-US)', citation: 'John Curtis (US) [ocd-person/7cc5139d]', facts: [{ text: 'John Curtis (US) — title: U.S. Senator', family: 'role' }, { text: 'John Curtis (US) — party: R', family: 'affiliation' }, { text: 'John Curtis (US) — bioguide_id: C001114', family: 'identity' }, { text: 'John Curtis (US) — state_represented: UT', family: 'role' }], bio: { Bioguide_Id__c: 'C001114', Chamber__c: 'US_Senate' }, committees: [{ name: '(unnamed)', role: 'Chair' }, { name: '(unnamed)', role: 'Chair' }, { name: '(unnamed)', role: 'Member' }] };
    // normalizeObject: flattens + dedups committees (roles, names all "(unnamed)")
    const nObj = es.normalizeObject(curtisResult);
    ok(nObj && nObj.id === 1519559 && nObj.degree === 320 && nObj.facts.length === 4, 'normalizeObject: id + degree 320 + facts');
    ok(nObj.committees.length === 2 && nObj.committees.includes('Chair') && nObj.committees.includes('Member'), 'normalizeObject: committee roles deduped (Chair×2→Chair, Member)');
    ok(es.normalizeObject({}) === null && es.normalizeObject(null) === null, 'normalizeObject: empty/null → null');
    ok(es.normalizeNeighbors({ neighbors: ['Utah', { name: 'Congress' }] }).join(',') === 'Utah,Congress', 'normalizeNeighbors: strings + {name} shapes');

    // recallObject: quick_lookup resolves the RICH record, then bounded kg_neighborhood (fail-soft empty)
    const objDispatch = async (tag) => {
      if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify({ result: curtisResult }) };
      if (tag.name === 'kg_neighborhood') return { ok: true, text: JSON.stringify({ anchors: [], neighbors: [] }) };
      return { ok: false, text: '{}' };
    };
    const ro = await es.recallObject('John Curtis', { dispatch: objDispatch });
    ok(ro && ro.degree === 320 && ro.role === 'US_Senate R (US-US)' && ro.neighbors.length === 0, 'recallObject: pulls the degree-320 dossier (neighborhood empty, fail-soft)');
    ok((await es.recallObject('', { dispatch: objDispatch })) === null, 'recallObject: empty name → null');
    ok((await es.recallObject('X', { dispatch: async () => ({ ok: false, text: 'err' }) })) === null, 'recallObject: quick_lookup miss → null');
    ok((await es.recallObject('X', { dispatch: null })) === null, 'recallObject: no dispatch (suit down) → null');

    // DEGREE-AWARE RESOLUTION — the live Curtis bug: bare name resolves to a degree-1 bill; the
    // type sweep recovers the degree-320 person. base(no type)=thin bill → sweep person → keep it.
    const thinBill = { entity: { id: 1337649, name: 'HJ 12 (VA, 2020)', entity_type: 'bill', degree: 1 }, facts: [{ text: 'Title: Celebrating the life of John Curtis Marion.' }] };
    let sweepCalls = [];
    const sweepDispatch = async (tag) => {
      if (tag.name === 'quick_lookup') { sweepCalls.push(tag.args.prefer_type || '(none)'); return { ok: true, text: JSON.stringify({ result: tag.args.prefer_type === 'person' ? curtisResult : thinBill }) }; }
      if (tag.name === 'kg_neighborhood') return { ok: true, text: JSON.stringify({ neighbors: [] }) };
      return { ok: false, text: '{}' };
    };
    const swept = await es.recallObject('John Curtis', { dispatch: sweepDispatch });
    ok(swept && swept.degree === 320 && swept.type === 'person', 'recallObject: thin base → type sweep recovers the degree-320 person');
    ok(sweepCalls.includes('(none)') && sweepCalls.includes('person'), 'recallObject: sweep tried base + prefer_type=person');
    // when the caller KNOWS the type, one call, no sweep
    sweepCalls = [];
    await es.recallObject('John Curtis', { preferType: 'person', dispatch: sweepDispatch });
    ok(sweepCalls.length === 1 && sweepCalls[0] === 'person', 'recallObject: explicit preferType → single lookup, no sweep');

    // ── resolveMention (Slice 2b) — candidate scan → resolved | ambiguous | nil ──
    // pure name-key: duplicate records collapse; different names stay distinct
    ok(es._coreNameKey('John Curtis (US)') === es._coreNameKey('CURTIS, JOHN [S4UT00282]'), '_coreNameKey: dup records (paren/bracket IDs stripped) → same key');
    ok(es._coreNameKey('John Curtis Marion') !== es._coreNameKey('John Curtis (US)'), '_coreNameKey: genuinely different name → different key');
    ok(es._coreNameKey('John R. Curtis (US)') === es._coreNameKey('John Curtis (US)'), '_coreNameKey: middle initial ignored (John R. Curtis == John Curtis)');
    ok(es._coreNameKey('Sen. Curtis') === es._coreNameKey('Curtis'), '_coreNameKey: honorific stripped (Sen. Curtis == Curtis)');
    ok(es._distinctNames([{ name: 'John Curtis (US)' }, { name: 'John Curtis (US-US)' }, { name: 'CURTIS, JOHN [S4UT00282]' }, { name: 'John R. Curtis (US)' }]).length === 1, '_distinctNames: 4 records incl. an initial variant → 1 distinct entity');
    // name-gate drops summary-only FTS noise (a staffer whose bio names the target)
    ok(es._nameGate([{ name: 'John Curtis (US)' }, { name: 'Lorie Fowlke (UT)' }], es._coreNameKey('John Curtis')).length === 1, '_nameGate: drops the summary-match staffer, keeps the real name');
    ok(es._cleanMention('Sen. John Curtis') === 'John Curtis' && es._cleanMention('Sen. Curtis') === 'Curtis', '_cleanMention: strips honorifics so the FTS search runs on real name tokens');
    // resolved: many dup records of ONE person → collapse to 1 → pull the degree-320 object
    const resDispatch = async (tag) => {
      if (tag.name === 'search_entities') return { ok: true, text: JSON.stringify({ result: [{ id: 1519559, name: 'John Curtis (US)', entity_type: 'person' }, { id: 1524282, name: 'John Curtis (US-US)', entity_type: 'person' }, { id: 1681322, name: 'CURTIS, JOHN [S4UT00282]', entity_type: 'person' }] }) };
      if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify({ result: curtisResult }) };
      if (tag.name === 'kg_neighborhood') return { ok: true, text: JSON.stringify({ neighbors: [] }) };
      return { ok: false, text: '{}' };
    };
    const rmRes = await es.resolveMention('John Curtis', { preferType: 'person', dispatch: resDispatch });
    ok(rmRes.status === 'resolved' && rmRes.object && rmRes.object.degree === 320, 'resolveMention: dup records collapse → resolved to the degree-320 object');
    // ambiguous: two DISTINCT same-type entities → trip NIL (bias-to-clarify), do NOT pick by degree
    const ambDispatch = async (tag) => tag.name === 'search_entities' ? { ok: true, text: JSON.stringify({ result: [{ id: 1519559, name: 'John Curtis (US)', entity_type: 'person' }, { id: 999, name: 'John Curtis Marion', entity_type: 'person' }] }) } : { ok: false, text: '{}' };
    const rmAmb = await es.resolveMention('John Curtis', { preferType: 'person', dispatch: ambDispatch });
    ok(rmAmb.status === 'ambiguous' && rmAmb.candidates.length === 2, 'resolveMention: two distinct same-type entities → ambiguous (never popularity-pick)');
    // nil + error
    const nilDispatch = async (tag) => tag.name === 'search_entities' ? { ok: true, text: JSON.stringify({ result: [] }) } : { ok: false, text: '{}' };
    ok((await es.resolveMention('Nobody McNobody', { dispatch: nilDispatch })).status === 'nil', 'resolveMention: no candidates → nil');
    ok((await es.resolveMention('X', { dispatch: null })).status === 'error', 'resolveMention: no dispatch (suit down) → error');
    // summary-noise staffer gated out + initial variant collapsed → resolves (the live Curtis fix)
    const noiseDispatch = async (tag) => {
      if (tag.name === 'search_entities') return { ok: true, text: JSON.stringify({ result: [{ id: 1519559, name: 'John Curtis (US)', entity_type: 'person' }, { id: 1524282, name: 'John R. Curtis (US)', entity_type: 'person' }, { id: 1519714, name: 'Lorie Fowlke (UT)', entity_type: 'person' }] }) };
      if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify({ result: curtisResult }) };
      if (tag.name === 'kg_neighborhood') return { ok: true, text: JSON.stringify({ neighbors: [] }) };
      return { ok: false, text: '{}' };
    };
    const rmNoise = await es.resolveMention('John Curtis', { preferType: 'person', dispatch: noiseDispatch });
    ok(rmNoise.status === 'resolved' && rmNoise.object.degree === 320, 'resolveMention: summary-noise gated + initial variant collapsed → resolved (not falsely ambiguous)');
    // one distinct name but only THIN records (no dominant winner) → ambiguous low-confidence, ASK
    const thinResult = { entity: { id: 5, name: 'Jane Roe', entity_type: 'person', degree: 1 }, facts: [], committees: [] };
    const thinDispatch = async (tag) => {
      if (tag.name === 'search_entities') return { ok: true, text: JSON.stringify({ result: [{ id: 5, name: 'Jane Roe', entity_type: 'person' }, { id: 6, name: 'Jane Roe', entity_type: 'person' }] }) };
      if (tag.name === 'quick_lookup') return { ok: true, text: JSON.stringify({ result: thinResult }) };
      if (tag.name === 'kg_neighborhood') return { ok: true, text: JSON.stringify({ neighbors: [] }) };
      return { ok: false, text: '{}' };
    };
    const rmThin = await es.resolveMention('Jane Roe', { preferType: 'person', dispatch: thinDispatch });
    ok(rmThin.status === 'ambiguous' && rmThin.reason === 'low-confidence', 'resolveMention: no dominant record (all thin) → ambiguous low-confidence (ask, no popularity-guess)');

    // recall() folds the object in → RICH even with 0 notes/facts/echo (the #2915 fix: one object = rich)
    const objFn = async () => nObj;
    const rObj = await ar.recall('John Curtis', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: objFn });
    ok(rObj.coverage === 'rich' && rObj.object && rObj.object.degree === 320, 'recall: resolved degree-320 object alone → rich (0 notes)');
    // a degree-1 stub with no facts does NOT flip coverage
    const stub = { id: 9, name: 'Nobody', type: 'person', degree: 1, facts: [], committees: [], neighbors: [] };
    const rStub = await ar.recall('nobody here', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: async () => stub });
    ok(rStub.coverage === 'thin', 'recall: degree-1 empty stub → still thin (no false rich)');
    ok(ar._objectRich(nObj) === true && ar._objectRich(stub) === false, '_objectRich: rich object vs stub');

    // entity-shape guard: object pull SKIPPED for a long prose topic (never quick_lookup a paragraph)
    ok(ar._looksLikeEntity('John Curtis') === true && ar._looksLikeEntity('what is the historical background of epistemology and its rivals') === false, '_looksLikeEntity: name yes, sentence no');
    let objCalled = false;
    await ar.recall('what is the historical background of epistemology and its rivals', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: async () => { objCalled = true; return nObj; } });
    ok(objCalled === false, 'recall: long prose (no proper noun) → object pull skipped');

    // extractEntity — pull the entity out of an elaborated idle-loop phrase (the web-first fix)
    ok(ar.extractEntity('Senator John Curtis personal background') === 'John Curtis', 'extractEntity: "Senator John Curtis personal background" → "John Curtis" (title dropped)');
    ok(ar.extractEntity('Fifth Element soundtrack chart performance') === 'Fifth Element', 'extractEntity: "Fifth Element soundtrack chart" → "Fifth Element"');
    ok(ar.extractEntity('Conservative Climate Caucus overview mission') === 'Conservative Climate Caucus', 'extractEntity: keeps a multi-word org name');
    ok(ar.extractEntity('what is the optimal spacing interval') === null, 'extractEntity: no proper noun → null (generic musing skips object pull)');
    // recall on a PHRASE now pulls the extracted entity's object → rich → idle loop consolidates, no web
    let capName = null;
    const rPhrase = await ar.recall('Senator John Curtis personal background', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: async (name) => { capName = name; return nObj; } });
    ok(capName === 'John Curtis' && rPhrase.coverage === 'rich', 'recall: 5-token phrase w/ title → extracts "John Curtis" → object pull → RICH (extractEntity tried FIRST, not just >6 tokens)');

    // knowledgeBlock leads with the object dossier (header + facts + committees)
    const blkObj = await ar.knowledgeBlock('John Curtis', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: objFn });
    ok(/\[object\] John Curtis \(US\) — person\/legislator_legacy, degree 320 — US_Senate R/.test(blkObj), 'knowledgeBlock: object header (type/subtype/degree/role)');
    ok(/• John Curtis \(US\) — title: U\.S\. Senator/.test(blkObj) && /committees: Chair; Member/.test(blkObj), 'knowledgeBlock: renders facts + deduped committees');
    ok(/do NOT restate it or look it up again/.test(blkObj), 'knowledgeBlock: object-rich → the "do not re-research" directive');

    // ── PROMINENCE GATE (R1) wiring — a bare famous name that resolves (in our civic KG) to a QID-less
    // same-name state legislator is DECLINED, and recall() surfaces an IDENTITY note for the answer. ──
    const jfkGa = { id: 1461086, name: 'John F. Kennedy (GA)', type: 'person', subtype: 'state_senator', degree: 1533, wikidata_qid: null, facts: [], committees: [], neighbors: [] };
    const mismatchFn = async (mention, obj) => ({ status: 'mismatch', note: `IDENTITY: "${mention}" most prominently refers to the 35th US President. Our records also hold ${obj.name} (state senator).` });
    const rMismatch = await ar.recall('John F. Kennedy', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: async () => jfkGa, prominenceFn: mismatchFn });
    ok(rMismatch.object === null, 'recall: prominence mismatch → the civic namesake object is DECLINED (→ enrich/wiki answers the prominent one)');
    ok(/35th US President/.test(rMismatch.identityNote || '') && /state senator/.test(rMismatch.identityNote || ''), 'recall: mismatch surfaces the IDENTITY note (answer-famous + footnote-namesake)');
    ok(rMismatch.coverage === 'thin', 'recall: declined object + 0 notes → thin (no false rich off the wrong record)');
    // pass-through: an "ok" verdict keeps the resolved object untouched (the legislative-research case)
    const rOk = await ar.recall('John F. Kennedy', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: async () => jfkGa, prominenceFn: async () => ({ status: 'ok' }) });
    ok(rOk.object && rOk.object.degree === 1533 && !rOk.identityNote, 'recall: prominence "ok" → the KG record is kept (legislative-research path unbroken)');

    // ── PRECEDENCE GATE (reconciliation §5) — a fresh, cited role correction LEADS over the stale KG dossier
    // (the Pam Bondi fix). The dossier claims she IS the AG; a researched correction says she served UNTIL Apr. ──
    const bondiObj = { id: 1, name: 'Pam Bondi (US)', type: 'person', subtype: 'us_executive', degree: 20, facts: ['Pam Bondi (US) — title: Attorney General'], committees: [], neighbors: [] };
    const bondiFix = note('verified_fact', 'Pam Bondi served as US Attorney General until 2026-04-02', { subject: 'Pam Bondi', subject_key: 'pam-bondi', as_of: '2026-04-02', capturedBy: 'directed-research', url: 'https://justice.gov/x' });
    const rBondi = await ar.recall('Pam Bondi', { retrieveFn: async () => [bondiFix], graphFn: noGraph, echoFn: async () => [], objectFn: async () => bondiObj });
    ok(rBondi.precedenceFact && /until 2026-04-02/.test(rBondi.precedenceFact.content) && rBondi.precedenceFact.asOf === '2026-04-02', 'recall: fresh role correction about the object → precedenceFact set (the Pam Bondi fix)');
    const blkBondi = await ar.knowledgeBlock('Pam Bondi', { retrieveFn: async () => [bondiFix], graphFn: noGraph, echoFn: async () => [], objectFn: async () => bondiObj });
    ok(/MOST CURRENT/.test(blkBondi) && blkBondi.indexOf('MOST CURRENT') < blkBondi.indexOf('[object]'), 'knowledgeBlock: the correction LEADS above the stale dossier (recall stops serving the stale record)');

    // subject match is subset-containment — a shared SURNAME alone must not trigger a false supersession
    const janeNote = note('verified_fact', 'Jane Smith served as mayor until 2025', { subject: 'Jane Smith', as_of: '2025-01-01', capturedBy: 'directed' });
    const rMis = await ar.recall('John Smith', { retrieveFn: async () => [janeNote], graphFn: noGraph, echoFn: async () => [], objectFn: async () => ({ id: 2, name: 'John Smith (US)', type: 'person', degree: 10, facts: ['x'], committees: [], neighbors: [] }) });
    ok(!rMis.precedenceFact, 'recall: verified_fact about a different same-surname subject → no precedence (subset match, not shared surname)');

    // a minor (non-role) fact must NOT override the whole dossier
    const voteNote = note('verified_fact', 'Pam Bondi voted yes on HR 123 on 2026-01-15', { subject: 'Pam Bondi', as_of: '2026-01-15', capturedBy: 'directed' });
    const rVote = await ar.recall('Pam Bondi', { retrieveFn: async () => [voteNote], graphFn: noGraph, echoFn: async () => [], objectFn: async () => bondiObj });
    ok(!rVote.precedenceFact, 'recall: a minor non-role verified_fact → no precedence (does not override the dossier)');

    // a PASSIVE single-source VOLATILE role claim is below the bar; a DELIBERATE one clears it
    const passiveVol = note('verified_fact', 'Pam Bondi is currently the Attorney General', { subject: 'Pam Bondi', as_of: '2026-01-01', capturedBy: 'realtime' });
    const rPassive = await ar.recall('Pam Bondi', { retrieveFn: async () => [passiveVol], graphFn: noGraph, echoFn: async () => [], objectFn: async () => bondiObj });
    ok(!rPassive.precedenceFact, 'recall: passive single-source volatile role claim (authority 2) → below the bar → no precedence');
    // REGRESSION GUARD (audit): the commonest live recovery is the WIKI tier — capturedBy 'wiki'/'wiki-verify'.
    // The old authority whitelist missed it (→ authority 2 → this would NOT have led). Must clear the bar now.
    const deliberateVol = note('verified_fact', 'Pam Bondi is currently the Attorney General', { subject: 'Pam Bondi', as_of: '2026-01-01', capturedBy: 'wiki-verify' });
    const rDelib = await ar.recall('Pam Bondi', { retrieveFn: async () => [deliberateVol], graphFn: noGraph, echoFn: async () => [], objectFn: async () => bondiObj });
    ok(!!rDelib.precedenceFact, 'recall: wiki-recovered volatile role fact (deliberate recovery → authority 3) → clears the bar → precedence (guards the audit fix)');
    // sanity: an unknown/blank provenance is conservatively de-rated (below the volatile bar)
    const unknownVol = note('verified_fact', 'Pam Bondi is currently the Attorney General', { subject: 'Pam Bondi', as_of: '2026-01-01' });
    const rUnknown = await ar.recall('Pam Bondi', { retrieveFn: async () => [unknownVol], graphFn: noGraph, echoFn: async () => [], objectFn: async () => bondiObj });
    ok(!rUnknown.precedenceFact, 'recall: unknown-provenance volatile claim → conservative authority 2 → below the bar');

    // ── DATA-STREAM RECALL — landed DOCUMENTS + tracked NEWS folded into recall (the silo fix: chat/research
    // were blind to news_bucket + the documents table). docFn/newsFn injected; live path uses doc_store/news_lane. ──
    const rStream = await ar.recall('Heritage Foundation', {
      retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: async () => null,
      docFn: async () => [{ title: 'Meeting notes', markdown: 'We discussed Heritage Foundation leadership with Kevin Roberts.', source: 'meeting_notes' }],
      newsFn: async () => [{ content: 'Heritage Foundation names new president (as of 2026-07-01, 4-source)', source: 'news' }],
    });
    ok(rStream.streamHits.length === 2 && rStream.streamHits.some(h => h.source === 'doc:meeting_notes') && rStream.streamHits.some(h => h.source === 'news'), 'recall: streamHits fold in landed docs + tracked news (the silo fix)');
    ok(/Kevin Roberts/.test(rStream.streamHits.find(h => h.source === 'doc:meeting_notes').content), 'recall: doc hit carries the doc body + is artifact-tagged doc:<source>');
    const blkStream = await ar.knowledgeBlock('Heritage Foundation', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: async () => null, docFn: async () => [{ title: 'Notes', markdown: 'Kevin Roberts leads Heritage.', source: 'meeting_notes' }], newsFn: async () => [{ content: 'Heritage news headline', source: 'news' }] });
    ok(/\[doc:meeting_notes\]/.test(blkStream) && /\[news\]/.test(blkStream), 'knowledgeBlock: renders the data-stream hits tagged [doc:*] and [news]');
    ok((await ar.knowledgeBlock('nothing', { retrieveFn: async () => [], graphFn: noGraph, echoFn: async () => [], objectFn: async () => null, docFn: async () => [], newsFn: async () => [] })) === null, 'knowledgeBlock: no streams + nothing else → null (no empty section)');
    // existing tests (no docFn/newsFn, objectFn provided) get empty streamHits → unchanged behavior
    ok(Array.isArray(rBondi.streamHits) && rBondi.streamHits.length === 0, 'recall: no injected stream fns + objectFn present → streamHits empty (offline-safe, no regression)');

    // ── recall EMITTER (Slice 2b): resolving an Echo object pushes a kg:activity recall (corpus → active core) ──
    const rActs = []; global.__emitKgActivity = (p) => rActs.push(p);
    const rObjHit = await ar.recall('John Curtis', { retrieveFn: async () => [], graphFn: noGraph, prominenceFn: async () => ({ status: 'ok' }), resolveFn: async () => ({ status: 'resolved', object: { id: 1, name: 'John Curtis (US)', entity_type: 'person', degree: 320, facts: ['a', 'b', 'c', 'd'], committees: [] } }) });
    ok(!!rObjHit.object && rActs.some(a => a.kind === 'recall' && a.db === 'echo' && a.anchor === 'John Curtis (US)'), 'recall resolving an Echo object → kg:activity recall (anchor=canonical, db=echo)');
    rActs.length = 0;
    const rMiss = await ar.recall('Zzz Nothing', { retrieveFn: async () => [], graphFn: noGraph, objectFn: async () => null });
    ok(!rMiss.object && !rActs.some(a => a.kind === 'recall'), 'a thin/nil recall (no object resolved) emits NO recall');
    global.__emitKgActivity = undefined;   // don't leak the capture into later assertions

    // ── the civic arm (2026-08-14, the D14 chat test): a held vacancy grounds the lookup ──
    const civicHit = [{ bodyKey: 'louisiana state senate', line: 'louisiana state senate — 38 seat(s) held, 1 VACANT; District 14 — VACANT (since 2026; incumbent died in office)' }];
    const rc = await ar.recall('who represents Louisiana Senate District 14?', { retrieveFn: async () => [], graphFn: () => [], civicFn: async () => civicHit });
    ok(rc.civicHits.length === 1 && rc.coverage === 'rich', 'a civic hit rides recall and flips coverage RICH (the store holds the answer)');
    const kb = await ar.knowledgeBlock('who represents Louisiana Senate District 14?', { retrieveFn: async () => [], graphFn: () => [], civicFn: async () => civicHit });
    ok(kb && /\[civic\].*District 14 — VACANT/.test(kb), 'knowledgeBlock speaks the vacancy as a [civic] line');
    const rcNone = await ar.recall('epistemology basics', { retrieveFn: async () => [], graphFn: () => [], civicFn: async () => [] });
    ok(rcNone.civicHits.length === 0 && rcNone.coverage === 'thin', 'no civic match → nothing injected, coverage unchanged');
  } catch (e) {
    fail++; console.error('  ✗ threw:', e.stack || e.message);
  }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
