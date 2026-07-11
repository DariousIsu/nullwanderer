/* Smoke: lib/graph_walk — the subconscious graph-builder. Fully offline: cloud / web / recall /
 * dispatch are all injected fakes. Asserts the ANCHOR→RESOLVE→WALK→GUARD→VOICE move: it picks a
 * recent-conversation GAP (missing/thin, not rich), fills from web+cloud, PROPOSES the missing
 * object + related objects + connecting edges under budget, records visited (no re-anchor), and
 * returns a voice line only for a notable move.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_graph_walk.js
 */
const G = require('../lib/graph_walk');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- pure helpers ---
ok(Array.isArray(G.parseJsonLoose('junk ["A","B"] tail')) , 'parseJsonLoose digs a JSON array out of prose');
ok(G.parseJsonLoose('not json') === null, 'parseJsonLoose → null on garbage');
ok(G.classifyObject(null) === 'missing', 'classifyObject: null → missing');
ok(G.classifyObject({ degree: 2, facts: [] }) === 'thin', 'classifyObject: low degree + no facts → thin');
ok(G.classifyObject({ degree: 320, facts: ['a', 'b', 'c', 'd'] }) === 'rich', 'classifyObject: rich object → rich');
ok(G.classifyObject({ degree: 1, committees: ['Energy'] }) === 'rich', 'classifyObject: a committee makes it non-thin');
const pn = G.extractProperNouns('We met Sen. John Curtis about the Nuclear Innovation Alliance today.');
ok(pn.some(n => /John Curtis/.test(n)) && !pn.some(n => /^Sen/.test(n)), 'extractProperNouns: gets "John Curtis", drops the honorific');
ok(pn.some(n => /Nuclear Innovation Alliance/.test(n)), 'extractProperNouns: multi-word org captured');

// --- rankGaps: missing first, then thin (thinnest first); rich + visited dropped ---
const assessed = [
  { mention: 'Rich Corp', kind: 'rich', object: { degree: 99 } },
  { mention: 'Thin B', kind: 'thin', object: { degree: 5 } },
  { mention: 'Missing A', kind: 'missing', object: null },
  { mention: 'Thin C', kind: 'thin', object: { degree: 1 } }
];
const ranked = G.rankGaps(assessed, new Set());
ok(ranked[0].mention === 'Missing A', 'rankGaps: missing anchor first');
ok(ranked[1].mention === 'Thin C' && ranked[2].mention === 'Thin B', 'rankGaps: thin ordered thinnest-first');
ok(!ranked.some(r => r.mention === 'Rich Corp'), 'rankGaps: rich dropped');
const rankedV = G.rankGaps(assessed, new Set([G.visitKey('Missing A')]));
ok(rankedV[0].mention === 'Thin C', 'rankGaps: a visited anchor is skipped');

(async () => {
  // --- extractCandidates: cloud first, regex fallback ---
  const turns = [
    { speaker: 'user', content: 'Can you prep for our meeting with the Nuclear Innovation Alliance?' },
    { speaker: 'ai_said', content: 'Sure.' }
  ];
  const cloudList = async () => '["Nuclear Innovation Alliance","R Street Institute"]';
  const c1 = await G.extractCandidates(turns, { cloud: cloudList });
  ok(c1[0] === 'Nuclear Innovation Alliance' && c1.includes('R Street Institute'), 'extractCandidates: uses the cloud list');
  const c2 = await G.extractCandidates(turns, { cloud: async () => 'garbage' });
  ok(c2.some(n => /Nuclear Innovation Alliance/.test(n)), 'extractCandidates: falls back to regex when cloud gives garbage');

  // --- assessGaps: Echo-first classify ---
  const recall = async (name) => name === 'Rich Person' ? { degree: 300, facts: ['a', 'b', 'c'] } : (name === 'Thin Org' ? { id: 42, degree: 2, facts: [], neighbors: ['Existing Ally'] } : null);
  const gaps = await G.assessGaps(['Missing Thing', 'Thin Org', 'Rich Person'], { recall });
  ok(gaps[0].kind === 'missing' && gaps[1].kind === 'thin' && gaps[2].kind === 'rich', 'assessGaps: classifies missing/thin/rich via recall');

  // --- growAround a MISSING anchor: proposes the entity + related + edges, under budget ---
  const calls = [];
  const dispatch = async (tag) => { calls.push([tag.name, tag.args]); return { ok: true, text: JSON.stringify({ action: tag.name === 'propose_relation' ? 'proposed' : 'created' }) }; };
  const web = async () => [{ text: 'The Nuclear Innovation Alliance is a nuclear policy nonprofit that works with Congress.', url: 'https://ex.com/nia' }];
  const dossierCloud = async () => JSON.stringify({
    entity_type: 'organization',
    summary: 'A nuclear-energy policy nonprofit that advances advanced reactor deployment and works with Congress.',
    related: [
      { name: 'Advanced Reactor Demonstration Program', type: 'concept', relation: 'advocates_for', source: 'S1' },
      { name: 'John Curtis', type: 'person', relation: 'engages_with', source: 'S1' }
    ]
  });
  const grown = await G.growAround(
    { mention: 'Nuclear Innovation Alliance', kind: 'missing', object: null },
    { web, cloud: dossierCloud, dispatch }
  );
  ok(grown.built === true, 'growAround: a missing anchor is BUILT (propose_entity)');
  ok(calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Nuclear Innovation Alliance'), 'growAround: proposes the anchor entity itself');
  ok(calls.some(c => c[0] === 'propose_relation'), 'growAround: proposes connecting edges');
  ok(grown.connections >= 1 && grown.connections <= G.WALK_MAX_CONNECTIONS, 'growAround: connections within budget');
  ok(grown.summary.length > 10, 'growAround: carries the grounded summary');

  // --- STREAMING inline-promote (record pipeline): when promoteOne is armed, the new node + neighbours are
  //     promoted INLINE so the edge below has live endpoints in the same move; disarmed → pure propose-only ---
  calls.length = 0;
  const promoted = [];
  const promoteOne = async ({ kind, name }) => { promoted.push([kind, name]); return true; };
  const grownInline = await G.growAround(
    { mention: 'Nuclear Innovation Alliance', kind: 'missing', object: null },
    { web, cloud: dossierCloud, dispatch, promoteOne }
  );
  ok(grownInline.built === true, 'growAround(inline): still builds the anchor');
  ok(promoted.some(p => p[0] === 'entity' && p[1] === 'Nuclear Innovation Alliance'), 'growAround(inline): promotes the NEW anchor node inline (record pipeline)');
  ok(promoted.some(p => p[0] === 'entity' && (p[1] === 'John Curtis' || p[1] === 'Advanced Reactor Demonstration Program')), 'growAround(inline): promotes a NEW neighbour inline so the edge has live endpoints');
  // disarmed (no promoteOne) → NEVER promotes (stays propose-only on the autonomous loop)
  calls.length = 0;
  const grownNoArm = await G.growAround({ mention: 'Nuclear Innovation Alliance', kind: 'missing', object: null }, { web, cloud: dossierCloud, dispatch });
  ok(grownNoArm.built === true && !calls.some(c => c[0] === 'promote_grounded_one'), 'growAround(disarmed): no promoteOne → pure propose-only, never promotes');

  // --- MULTI-CITE grounding quality: an edge cited to TWO INDEPENDENT sources calibrates ABOVE the 0.90
  //     floor (0.94, lands); a one-source edge stays at 0.88 (parked for corroboration). This is the C2 lift. ---
  calls.length = 0;
  const twoSources = [
    { text: 'The Nuclear Innovation Alliance works with Congress on advanced reactors.', url: 'https://en.wikipedia.org/wiki/NIA' },
    { text: 'NIA advocates for the Advanced Reactor Demonstration Program.', url: 'https://ballotpedia.org/NIA' }
  ];
  const multiCiteCloud = async () => JSON.stringify({ entity_type: 'organization', summary: 'A nuclear policy nonprofit working with Congress.', related: [
    { name: 'Advanced Reactor Demonstration Program', type: 'concept', relation: 'advocates_for', sources: ['S1', 'S2'] },   // 2 independent families → 0.94
    { name: 'Lone Cite Co', type: 'organization', relation: 'linked_to', sources: ['S1'] }                                    // 1 source → 0.88
  ] });
  await G.growAround({ mention: 'Nuclear Innovation Alliance', kind: 'missing', object: null }, { web: async () => twoSources, cloud: multiCiteCloud, dispatch });
  const relCalls = calls.filter(c => c[0] === 'propose_relation');
  const twoCite = relCalls.find(c => c[1].target_name === 'Advanced Reactor Demonstration Program');
  const oneCite = relCalls.find(c => c[1].target_name === 'Lone Cite Co');
  ok(twoCite && twoCite[1].confidence >= 0.90, 'growAround(multi-cite): a TWO-independent-source edge calibrates >= 0.90 floor (0.94, lands)');
  ok(oneCite && oneCite[1].confidence > 0.80 && oneCite[1].confidence < 0.90, 'growAround(single-cite): a one-source edge stays below floor (0.88, parked for corroboration)');
  ok(twoCite && JSON.parse(twoCite[1].relation_metadata).source_set.length === 2, 'growAround(multi-cite): the edge carries BOTH independent urls in source_set');

  // --- TRUTHFUL accounting: parse the tool ACTION, not the always-true transport ok (the bug that made
  //     +conn a fiction). A 'rejected' edge (endpoint not found) is NOT a connection; it's surfaced instead. ---
  const prP = await G.proposeRelation({ dispatch: async () => ({ ok: true, text: '{"action":"proposed"}' }), source: 'A', target: 'B', relation_type: 'x' });
  ok(prP.ok === true && prP.action === 'proposed', 'proposeRelation: action=proposed → ok');
  const prR = await G.proposeRelation({ dispatch: async () => ({ ok: true, text: '{"action":"rejected","error":"target not in public corpus"}' }), source: 'A', target: 'B', relation_type: 'x' });
  ok(prR.ok === false && prR.action === 'rejected', 'proposeRelation: action=rejected → NOT ok (was a false +conn under the old r.ok count)');
  const peN = await G.proposeEntity({ dispatch: async () => ({ ok: true, text: '{"action":"proposed"}' }), name: 'N' });
  ok(peN.isNew === true && peN.ok === true, 'proposeEntity: action=proposed → isNew');
  const peX = await G.proposeEntity({ dispatch: async () => ({ ok: true, text: '{"action":"already_exists"}' }), name: 'N' });
  ok(peX.ok === true && peX.isNew === false, 'proposeEntity: already_exists → present but NOT new (no overcount)');
  const logs = [];
  const rejDispatch = async (tag) => { const a = tag.name === 'propose_relation' ? 'rejected' : 'created'; return { ok: true, text: JSON.stringify({ action: a, error: 'target entity not found in public corpus' }) }; };
  const grownRej = await G.growAround({ mention: 'Nuclear Innovation Alliance', kind: 'missing', object: null }, { web, cloud: dossierCloud, dispatch: rejDispatch, log: (m) => logs.push(m) });
  ok(grownRej.connections === 0 && grownRej.rejected >= 1, 'growAround(truthful): rejected edges → 0 connections, counted as rejected (surfaced, not silently over-counted)');
  ok(logs.some(m => /rejected|not found/i.test(m)), 'growAround(truthful): the rejection REASON is logged (so we can see WHY the endpoint failed)');
  ok((grownRej.landedLocal || 0) === 0, 'growAround(no landLocalEdge): a rejected edge is simply lost (landedLocal=0) — the pre-Slice-1 behaviour when the catch is disarmed');

  // --- CROSS-DB short-term catch (option 2, Slice 1): a CITED edge Echo REJECTS (young endpoint not yet in
  //     the public corpus) is NOT dropped — it lands in the LOCAL short-term graph via landLocalEdge at
  //     epistemic 'read' (which mints the missing endpoint), counts as landedLocal, and stays truthful (it
  //     did NOT enter Echo). This is the wall the whole option-2 design targets. ---
  const landed = [];
  const landLocalEdge = (a) => { landed.push(a); return { ok: true, relationId: landed.length }; };
  const grownCatch = await G.growAround(
    { mention: 'Nuclear Innovation Alliance', kind: 'missing', object: null },
    { web, cloud: dossierCloud, dispatch: rejDispatch, landLocalEdge, log: () => {} }
  );
  ok(grownCatch.landedLocal >= 1, 'growAround(catch): a rejected CITED edge lands in the short-term graph (landedLocal>=1) instead of evaporating');
  ok(grownCatch.rejected >= 1, 'growAround(catch): STILL counted as Echo-rejected (truthful — it did not enter Echo; it went short-term)');
  ok(landed.length >= 1 && landed.every(e => e.epistemic === 'read'), 'growAround(catch): the local landing uses epistemic "read" (mints the young endpoint on the grounded rung)');
  ok(landed.some(e => e.source === 'Nuclear Innovation Alliance' && e.type && e.target), 'growAround(catch): the local edge carries the anchor as source + a real target + a type');
  ok(landed.every(e => e.sourceObj && e.sourceObj.kind === 'reading' && 'ref' in e.sourceObj), 'growAround(catch): the local edge carries its reading citation (sourceObj.kind=reading + ref)');
  ok(landed.every(e => e.proposedBy === 'graph-walk-shortterm'), 'growAround(catch): the local edge is provenance-tagged graph-walk-shortterm (this lane is separately auditable)');

  // --- OPEN-VOCABULARY relation types: keep the LLM's accurate label as the type (UPPER_SNAKE), preserve
  //     the exact phrase in meta.title, pass allow_open_type so the whitelist doesn't reject it ("let it in") ---
  ok(G.normalizeRelType('interim provost') === 'INTERIM_PROVOST', 'normalizeRelType: "interim provost" → INTERIM_PROVOST');
  ok(G.normalizeRelType('former name') === 'FORMER_NAME', 'normalizeRelType: "former name" → FORMER_NAME');
  ok(G.normalizeRelType('  accreditor!! ') === 'ACCREDITOR', 'normalizeRelType: trims + strips punctuation');
  ok(G.normalizeRelType('') === 'RELATED_TO', 'normalizeRelType: empty → RELATED_TO fallback');
  const ovCalls = [];
  const ovDispatch = async (tag) => { ovCalls.push([tag.name, tag.args]); return { ok: true, text: JSON.stringify({ action: tag.name === 'propose_relation' ? 'proposed' : 'created' }) }; };
  const ovCloud = async () => JSON.stringify({ entity_type: 'organization', summary: 'A college.', related: [{ name: 'Nancy Cantor', type: 'person', relation: 'interim provost', sources: ['S1'] }] });
  await G.growAround({ mention: 'Hunter College', kind: 'missing', object: null }, { web: async () => [{ text: 'Nancy Cantor is interim provost of Hunter College.', url: 'https://en.wikipedia.org/wiki/Hunter_College' }], cloud: ovCloud, dispatch: ovDispatch });
  const ovEdge = ovCalls.find(c => c[0] === 'propose_relation' && c[1].target_name === 'Nancy Cantor');
  ok(ovEdge && ovEdge[1].relation_type === 'INTERIM_PROVOST', 'growAround(open-vocab): edge carries the LLM label as an UPPER_SNAKE type (not flattened, not "related_to")');
  ok(ovEdge && ovEdge[1].allow_open_type === true, 'growAround(open-vocab): passes allow_open_type so the whitelist admits it');
  ok(ovEdge && JSON.parse(ovEdge[1].relation_metadata).title === 'interim provost', 'growAround(open-vocab): the EXACT LLM phrase is preserved verbatim in meta.title (nothing lost)');

  // --- growAround a THIN anchor: does NOT re-propose an existing neighbour edge ---
  calls.length = 0;
  const thinCloud = async () => JSON.stringify({ entity_type: 'organization', summary: 'x', related: [{ name: 'Existing Ally', type: 'organization', relation: 'allied_with', source: 'S1' }, { name: 'New Partner', type: 'organization', relation: 'partners_with', source: 'S1' }] });
  const grownThin = await G.growAround(
    { mention: 'Thin Org', kind: 'thin', object: { id: 42, degree: 2, neighbors: ['Existing Ally'] } },
    { web, cloud: thinCloud, dispatch }
  );
  ok(!calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Thin Org'), 'growAround: does NOT re-propose the existing thin anchor entity');
  ok(!calls.some(c => c[0] === 'propose_relation' && c[1].target_name === 'Existing Ally'), 'growAround: skips an edge that already exists in the graph');
  ok(calls.some(c => c[0] === 'propose_relation' && c[1].target_name === 'New Partner'), 'growAround: still forges the NEW connection');

  // --- runMove end-to-end + visited guard ---
  const meta = {};
  const getMeta = (k) => meta[k]; const setMeta = (k, v) => { meta[k] = v; };
  const recall2 = async () => null;  // everything missing → the top candidate anchors
  const move = await G.runMove({ recentTurns: turns, cloud: async (msgs) => (String(msgs[0].content).includes('extract') || String(msgs[1] && msgs[1].content).includes('array')) ? '["Nuclear Innovation Alliance"]' : dossierCloud(), web, recall: recall2, dispatch, getMeta, setMeta, now: () => 1000 });
  ok(move.acted === true && move.anchor === 'Nuclear Innovation Alliance', 'runMove: anchors on the conversation gap and acts');
  ok(typeof move.voiceLine === 'string' && move.voiceLine.length > 0, 'runMove: returns a voice line for a notable move');
  ok(G.visitedKeySet(getMeta, 1000).has(G.visitKey('Nuclear Innovation Alliance')), 'runMove: records the anchor as visited');
  const move2 = await G.runMove({ recentTurns: turns, cloud: async () => '["Nuclear Innovation Alliance"]', web, recall: recall2, dispatch, getMeta, setMeta, now: () => 2000 });
  ok(move2.acted === false && move2.reason === 'no-gap', 'runMove: a just-visited anchor is skipped → quiet (no re-anchor)');

  // --- no candidates → quiet ---
  const moveQuiet = await G.runMove({ recentTurns: [], cloud: async () => '[]', web, recall: recall2, dispatch, getMeta, setMeta, now: () => 3000 });
  ok(moveQuiet.acted === false, 'runMove: empty conversation → quiet (no forced noise)');

  // --- injected candidates (idle_anchors cascade) + iterate-until-grow (no-op-move fix) ---
  // Two MISSING anchors: the first yields no dossier (a dud → no growth); the move must iterate PAST it
  // to the second, which builds. This is the fix for the "anchor on one un-growable node, voice nothing"
  // stall. recentTurns is empty, so ONLY the injected list can be driving this.
  const meta2 = {}; const gM = (k) => meta2[k]; const sM = (k, v) => { meta2[k] = v; };
  const iterCloud = async (msgs) => {
    const u = String((msgs[1] && msgs[1].content) || (msgs[0] && msgs[0].content) || '');
    if (/Entity: "Buildable Co"/.test(u)) return JSON.stringify({ entity_type: 'organization', summary: 'A real org that partners with others on water technology and policy.', related: [{ name: 'Partner X', type: 'organization', relation: 'partners_with', source: 'S1' }] });
    if (/Entity: "Dud Co"/.test(u)) return 'not json — no dossier here';   // dud → dossier null → no growth
    return '[]';
  };
  const moveInj = await G.runMove({
    recentTurns: [],
    candidates: [{ mention: 'Dud Co', source: 'frontier' }, { mention: 'Buildable Co', source: 'news' }],
    cloud: iterCloud, web, recall: async () => null, dispatch, getMeta: gM, setMeta: sM, now: () => 5000
  });
  ok(moveInj.acted === true && moveInj.anchor === 'Buildable Co', 'runMove: injected candidates drive it; iterates PAST the dud to the buildable anchor');

  // --- runMove threads landLocalEdge (Slice 1): a THIN anchor whose only edge Echo rejects (young endpoint)
  //     still counts as a PRODUCTIVE move (acted), because the edge landed short-term — it is NOT mis-marked a
  //     dud. And it does so WITHOUT a false build. ---
  const landed2 = [];
  const rmLand = (a) => { landed2.push(a); return { ok: true }; };
  const metaRM = {};
  const thinRejCloud = async () => JSON.stringify({ entity_type: 'organization', summary: 'x', related: [{ name: 'Young Node', type: 'organization', relation: 'partners_with', sources: ['S1'] }] });
  const moveCatch = await G.runMove({
    recentTurns: [], candidates: [{ mention: 'Thin Org', source: 'frontier', kind: 'thin', object: { id: 7, degree: 2, neighbors: [] } }],
    cloud: thinRejCloud, web, recall: async () => null, dispatch: rejDispatch,
    landLocalEdge: rmLand, getMeta: (k) => metaRM[k], setMeta: (k, v) => { metaRM[k] = v; }, now: () => 7000
  });
  ok(moveCatch.landedLocal >= 1 && landed2.length >= 1, 'runMove: threads landLocalEdge → the young-endpoint edge lands short-term');
  ok(moveCatch.acted === true && !moveCatch.built, 'runMove: a move that ONLY landed short-term edges still counts as productive (acted), with no false build');
  ok(moveInj.source === 'news', 'runMove: carries the winning anchor source tag (news)');
  ok(G.visitedKeySet(gM, 5000).has(G.visitKey('Dud Co')), 'runMove: the tried-but-dud anchor is still recorded visited (no re-grind next tick)');

  // --- PRE-CLASSIFIED frontier candidate is NOT rich-flipped by recall ---
  // recall would call this a rich same-name twin, but a frontier candidate carries its own {kind,object}
  // (selected by graph degree), so runMove enriches it instead of dropping it.
  const meta3 = {}; const gM3 = (k) => meta3[k]; const sM3 = (k, v) => { meta3[k] = v; };
  const richRecall = async () => ({ degree: 999, facts: ['a', 'b', 'c', 'd'] });   // recall says RICH (a famous twin)
  const thinCloud2 = async () => JSON.stringify({ entity_type: 'organization', summary: 'A small local org.', related: [{ name: 'New Ally Org', type: 'organization', relation: 'allied_with', source: 'S1' }] });
  const kgNbr = async () => [];   // the real thin node has no existing neighbours
  const preCalls = [];
  const dispatchPre = async (tag) => { preCalls.push([tag.name, tag.args]); return { ok: true, text: JSON.stringify({ action: tag.name === 'propose_relation' ? 'proposed' : 'created' }) }; };
  const movePre = await G.runMove({
    recentTurns: [],
    candidates: [{ mention: 'Thin Local Org', source: 'frontier', kind: 'thin', object: { id: 555, degree: 2, canonical: 'Thin Local Org [Q999]' } }],
    cloud: thinCloud2, web, recall: richRecall, dispatch: dispatchPre, kgNeighbors: kgNbr, getMeta: gM3, setMeta: sM3, now: () => 7000
  });
  ok(movePre.acted === true && movePre.source === 'frontier', 'runMove: a pre-classified frontier node is enriched, NOT rich-flipped by recall');
  ok(movePre.connections >= 1, 'runMove: frontier enrichment forges a new connection');
  ok(preCalls.some(c => c[0] === 'propose_relation' && c[1].source_name === 'Thin Local Org [Q999]'), 'runMove: propose_relation targets the CANONICAL name (exact node), not the clean mention');

  // --- CITATION GATE (Slice 0): cited claim promotes + is observed; inferred claim is HELD ---
  const gcalls = []; const observed = [];
  const gdisp = async (tag) => { gcalls.push([tag.name, tag.args]); return { ok: true, text: JSON.stringify({ action: tag.name === 'propose_relation' ? 'proposed' : 'created' }) }; };
  const gweb = async () => [{ text: 'Acme Corp partners with Beta Inc.', url: 'https://ex.com/acme' }];
  const gcloud = async () => JSON.stringify({ entity_type: 'organization', summary: 'Acme Corp.', related: [
    { name: 'Beta Inc', type: 'organization', relation: 'partners_with', source: 'S1', when: '2019' }, // cited + dated → promote
    { name: 'Gamma Guess', type: 'organization', relation: 'rumored_tie', source: 'inferred' }    // inferred → HELD
  ] });
  const gGrown = await G.growAround(
    { mention: 'Acme Corp', kind: 'thin', object: { id: 1, degree: 2, neighbors: [] } },
    { web: gweb, cloud: gcloud, dispatch: gdisp, kgNeighbors: async () => [], observe: async (o) => observed.push(o) }
  );
  ok(gGrown.connections === 1 && gGrown.held === 1, 'growAround: cited claim promotes, inferred claim is HELD (requires-citation)');
  ok(gGrown.sourceUrl === 'https://ex.com/acme', 'growAround: returns the citation sourceUrl of the promoted fact');
  // sourceLabel: friendly tag for the voiced "via …"
  ok(G.sourceLabel('https://en.wikipedia.org/wiki/X') === 'Wikipedia', 'sourceLabel: wikipedia → "Wikipedia"');
  ok(G.sourceLabel('https://www.example.com/a') === 'example.com', 'sourceLabel: other host → its domain');
  ok(G.sourceLabel('') === '' && G.sourceLabel(null) === '', 'sourceLabel: empty → ""');
  ok(gcalls.some(c => c[0] === 'propose_relation' && c[1].target_name === 'Beta Inc'), 'growAround: the CITED edge is proposed');
  ok(!gcalls.some(c => c[0] === 'propose_relation' && c[1].target_name === 'Gamma Guess'), 'growAround: the INFERRED edge NEVER reaches Echo');
  // C1/C2/C3 wiring: the promoted edge carries valid-time + source_set provenance and a CALIBRATED
  // confidence from the independent-source count (1 here → grade-B prior), not the flat grade cap.
  const gRel = gcalls.find(c => c[0] === 'propose_relation' && c[1].target_name === 'Beta Inc');
  const gMd = gRel && JSON.parse(gRel[1].relation_metadata);
  ok(gMd && gMd.valid_from === 2019, 'growAround: proposed edge carries valid_from parsed from the dossier "when"');
  ok(gMd && Array.isArray(gMd.source_set) && gMd.source_set[0] === 'https://ex.com/acme', 'growAround: proposed edge carries a source_set (citation url)');
  const CM = require('../lib/confidence_model');
  ok(gRel && Math.abs(gRel[1].confidence - CM.calibratedConfidence({ grade: 'B', corroboration: 1 })) < 1e-9, 'growAround: edge confidence = calibrated(B, corr 1), not the flat cap');
  // Slice 1: BOTH the promoted fact AND the held (inferred) claim are observed — the held one queues
  // as an enrichment candidate (the durable trail records what we SAW, not just what promoted).
  const oProm = observed.find(o => o.target === 'Beta Inc');
  const oHeld = observed.find(o => o.target === 'Gamma Guess');
  ok(oProm && oProm.url === 'https://ex.com/acme' && oProm.grade === 'B' && oProm.status === 'promoted', 'growAround: observe() records the PROMOTED fact (url + grade B, status promoted)');
  ok(oHeld && oHeld.status === 'held' && oHeld.grade === 'D' && !oHeld.url, 'growAround: observe() records the HELD inferred claim (grade D, no url, status held) — the enrichment queue');

  // --- EXISTENCE gate: a MISSING anchor with no citable source is HELD, not minted ---
  const ecalls = [];
  const edisp = async (tag) => { ecalls.push([tag.name, tag.args]); return { ok: true, text: JSON.stringify({ action: tag.name === 'propose_relation' ? 'proposed' : 'created' }) }; };
  const eweb = async () => [{ text: 'a snippet with no url' }];   // no url → existence ungradeable
  const ecloud = async () => JSON.stringify({ entity_type: 'organization', summary: 'x', related: [{ name: 'Whatever', type: 'organization', relation: 'related_to', source: 'S1' }] });
  const eGrown = await G.growAround({ mention: 'Ghost Org', kind: 'missing', object: null }, { web: eweb, cloud: ecloud, dispatch: edisp });
  ok(eGrown.built === false && eGrown.held === 1, 'growAround: a missing anchor with no citable existence is HELD, not minted');
  ok(!ecalls.some(c => c[0] === 'propose_entity'), 'growAround: no propose_entity for an uncitable object (no hallucinated node)');

  // --- fetchLayeredSources: Wikipedia PRIMARY + INDEPENDENT web corroborators (dedupe mirrors); corpus last ---
  const okPage = async (url) => ({ ok: true, url, title: 'T', text: 'x'.repeat(500) });
  const badPage = async (url) => ({ ok: false, url, error: 'HTTP 429' });          // throttled/blocked live fetch
  const wiki = (n) => 'https://en.wikipedia.org/wiki/' + String(n).replace(/\s+/g, '_');
  const kb = async () => [{ source: 'echo:wikipedia', content: 'a corpus passage about the entity' }];
  const searchIndep = async () => ({ results: [{ title: 'r', snippet: 'an independent web snippet', url: 'https://ballotpedia.org/r' }] });
  const searchWikiMirror = async () => ({ results: [{ title: 'w', snippet: 'a wiki mirror', url: 'https://en.wikipedia.org/wiki/Mirror' }] });

  const s1 = await G.fetchLayeredSources('James Inhofe', { fetchPage: okPage, recallKnowledge: kb, webSearch: searchIndep, wikiUrl: wiki });
  ok(s1.length === 2 && s1[0].source === 'web:wikipedia' && s1.some(x => x.source === 'web:search' && /ballotpedia/.test(x.url)), 'fetchLayeredSources: wiki PRIMARY + an INDEPENDENT web corroborator (2 sources → corroboration possible)');
  const s1b = await G.fetchLayeredSources('James Inhofe', { fetchPage: okPage, recallKnowledge: kb, webSearch: searchWikiMirror, wikiUrl: wiki });
  ok(s1b.length === 1 && s1b[0].source === 'web:wikipedia', 'fetchLayeredSources: a Wikipedia-MIRROR web result is DEDUPED (not counted as independent — anti-echo-chamber)');
  const s2 = await G.fetchLayeredSources('X', { fetchPage: badPage, recallKnowledge: kb, webSearch: searchIndep, wikiUrl: wiki });
  ok(s2.length === 1 && s2[0].source === 'web:search', 'fetchLayeredSources: wiki miss → independent web source (layer 2, before corpus)');
  const s3 = await G.fetchLayeredSources('X', { fetchPage: badPage, recallKnowledge: kb, webSearch: async () => ({ results: [] }), wikiUrl: wiki });
  ok(s3.length === 1 && /echo/.test(s3[0].source) && !!s3[0].url, 'fetchLayeredSources: wiki + web dry → LOCAL corpus (last-resort text fallback, url synthesized)');
  const s4 = await G.fetchLayeredSources('X', { fetchPage: badPage, recallKnowledge: async () => [], webSearch: async () => ({ results: [] }), wikiUrl: wiki });
  ok(s4.length === 0, 'fetchLayeredSources: all sources dry → [] (nothing to cite)');
  ok((await G.fetchLayeredSources('', { fetchPage: okPage, wikiUrl: wiki })).length === 0, 'fetchLayeredSources: empty name → []');
  const manyIndep = async () => ({ results: [{ snippet: 'a', url: 'https://a.org/1' }, { snippet: 'b', url: 'https://b.org/2' }, { snippet: 'c', url: 'https://c.org/3' }] });
  const sCap = await G.fetchLayeredSources('Z', { fetchPage: okPage, webSearch: manyIndep, wikiUrl: wiki, maxSources: 3 });
  ok(sCap.length === 3, 'fetchLayeredSources: caps at maxSources (wiki + 2 independents, not all)');

  // ===== #3 SATURATION STEER: a 0-yield anchor lingers 4× longer (stop re-grinding covered nodes) =====
  {
    const store = {};
    const getMeta = (k) => store[k];
    const setMeta = (k, v) => { store[k] = v; };
    const t0 = 1000000000000;
    G.recordVisited({ getMeta, setMeta, now: t0, names: ['Productive Node'] });                 // normal window
    G.recordVisited({ getMeta, setMeta, now: t0, names: ['Saturated Node'], saturated: true });  // 4× window
    // just after normal TTL, before saturated TTL:
    const midT = t0 + G.VISITED_TTL_MS + 1000;
    const midSet = G.visitedKeySet(getMeta, midT);
    ok(!midSet.has(G.visitKey('Productive Node')), 'saturation: a normal anchor is re-eligible after the 6h window');
    ok(midSet.has(G.visitKey('Saturated Node')), 'saturation: a 0-yield anchor is STILL suppressed past the 6h window (lingers longer)');
    // past the saturated TTL, even it clears:
    const lateSet = G.visitedKeySet(getMeta, t0 + G.SATURATED_TTL_MS + 1000);
    ok(!lateSet.has(G.visitKey('Saturated Node')), 'saturation: the saturated anchor eventually clears (not permanent)');
    ok(G.SATURATED_TTL_MS > G.VISITED_TTL_MS, 'saturation: SATURATED_TTL_MS > VISITED_TTL_MS');
  }

  // ===== C4 DECAY: the walk decay-checks the edges it's ALREADY visiting → 'reverify' obs (build + decay) =====
  {
    const NOWMS = 1_000_000_000_000;
    const nowSec = Math.floor(NOWMS / 1000);
    const DAYS = 86400;
    const edges = [
      { name: 'Old Employer', relation: 'WORKS_FOR', confidence: 0.9, createdAt: nowSec - 550 * DAYS },   // FAST 1 half-life → 0.45 (stale)
      { name: 'Fresh Employer', relation: 'WORKS_FOR', confidence: 0.9, createdAt: nowSec - 1 * DAYS },    // fresh → 0.9
      { name: 'Birthplace City', relation: 'BORN_IN', confidence: 0.6, createdAt: nowSec - 20000 * DAYS }, // IMMUTABLE → no decay
      { name: 'Ended Role', relation: 'HELD_OFFICE', confidence: 0.9, createdAt: nowSec - 900 * DAYS, validTo: nowSec - 10 * DAYS }, // TERMINATED → skipped
    ];
    const reobs = [];
    const n = await G.decayVisitedEdges(7, { kgEdges: async () => edges, observe: async (o) => reobs.push(o), now: NOWMS, anchorName: 'Jane Subject [Q1]' });
    ok(n === 1, 'decayVisitedEdges: exactly ONE edge is stale (the aged WORKS_FOR) — flagged for re-verify');
    ok(reobs.length === 1 && reobs[0].status === 'reverify' && reobs[0].target === 'Old Employer', 'decayVisitedEdges: stale edge → a reverify observation on the right target');
    ok(reobs[0].sourceEntity === 'Jane Subject [Q1]' && reobs[0].relation === 'WORKS_FOR', 'decayVisitedEdges: reverify obs carries the anchor as subject + the predicate');
    ok(reobs[0].confidence < 0.5, 'decayVisitedEdges: reverify obs carries the DECAYED (below-floor) confidence');
    ok(!reobs.some((o) => o.target === 'Birthplace City'), 'decayVisitedEdges: an IMMUTABLE edge (BORN_IN) never decays → never re-verified');
    ok(!reobs.some((o) => o.target === 'Ended Role'), 'decayVisitedEdges: a PREDETERMINED-TERMINATION edge (valid_to passed) is skipped — nightly termination, not decay');
    ok((await G.decayVisitedEdges(0, { kgEdges: async () => edges, observe: async () => {}, now: NOWMS })) === 0, 'decayVisitedEdges: no object id → 0 (fail-soft)');
    ok((await G.decayVisitedEdges(7, { observe: async () => {}, now: NOWMS })) === 0, 'decayVisitedEdges: no kgEdges reader → 0 (optional no-op)');

    // end-to-end: runMove decay-checks the anchor inline → move.reverify (the walk does BOTH)
    const store2 = {}; const gM2 = (k) => store2[k]; const sM2 = (k, v) => { store2[k] = v; };
    const rmObs = [];
    const mv = await G.runMove({
      candidates: [{ mention: 'Focus Node', source: 'frontier', kind: 'thin', object: { id: 7, degree: 2, canonical: 'Focus Node [Q7]' } }],
      cloud: async () => JSON.stringify({ entity_type: 'organization', summary: 'x', related: [] }),  // no new edges → decay still runs
      web: async () => [], recall: async () => null, dispatch: async () => ({ ok: true, text: '{}' }),
      kgEdges: async () => [{ name: 'Old Tie', relation: 'WORKS_FOR', confidence: 0.9, createdAt: nowSec - 550 * DAYS }],
      observe: async (o) => rmObs.push(o),
      getMeta: gM2, setMeta: sM2, now: () => NOWMS,
    });
    ok(mv.reverify === 1 && rmObs.some((o) => o.status === 'reverify' && o.sourceEntity === 'Focus Node [Q7]'), 'runMove: decay-checks the anchor edges inline (move.reverify) — build + decay in one move');
  }

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
