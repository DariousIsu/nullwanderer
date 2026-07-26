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

  // ── THE TYPE MUST TRAVEL ON AN UNSUBSTANTIATED MINT ────────────────────────────────────────────
  // _mintUnsubstantiated took `type`, proposed the entity WITH it, and observed WITHOUT it. Since
  // decomp_encounters refuses an untyped observation by design (the type is part of the identity key),
  // every unsubstantiated mint produced a promoted observation that could never become an encounter.
  // Measured live on a justice.gov injunction: 81 promoted observations, 0 encounters.
  {
    const seen = [];
    await D.decomposeDoc(
      { title: 'Order', url: 'https://justice.gov/x', text: 'The United States District Court entered judgment.' },
      {
        extract: async () => ({ entities: [{ name: 'United States District Court', type: 'government_body' }], relations: [] }),
        resolve: mockResolver({}),                     // nil → REFERENCE_TYPE → unsubstantiated mint
        dispatch: async () => ({ ok: true, text: '{"action":"proposed","entity_id":1}' }),
        observe: (o) => { seen.push(o); },
      });
    const exists = seen.find((o) => o.relation === 'exists' && /District Court/.test(o.sourceEntity));
    ok(exists && exists.status === 'promoted', 'a reference-type entity mints unsubstantiated so its edge can land');
    ok(exists && exists.type === 'government_body',
      'CRITICAL: the observation carries its TYPE — without it decomp_encounters refuses the row and the mint yields no encounter');
  }

  // ── V1: A RESOLVER ANSWER IS A PROPOSAL, NOT A VERDICT ─────────────────────────────────────────
  //
  // The live case, 2026-07-21. Alcona County MI minutes name "Carolyn Brummund" and "Adam Brege";
  // the resolver answered with a GEORGIA congressional candidate and a COLORADO one. Neither
  // surname occurs anywhere in the document — matched on FIRST NAME. 104 people ended up carrying
  // 122 false structural claims. entity_match already refused both; nobody asked it.
  {
    const rGA = mockResolver({ 'Carolyn Brummund': { status: 'resolved', object: { id: 9, name: 'BOURDEAUX, CAROLYN [H8GA07201]' } } });
    const d = await D.resolveExtracted({ name: 'Carolyn Brummund', type: 'person' }, { resolve: rGA });
    ok(d.action !== 'reuse', 'V1 CRITICAL: a resolver answer the precision matcher REFUSES is not adopted');
    ok(d.action === 'mint' && /resolver-rejected:given-name-conflict/.test(d.reason || ''),
      'V1: Carolyn Brummund is NOT Carolyn Bourdeaux — she mints as herself, and the record says why');
    const rCO = mockResolver({ 'Adam Brege': { status: 'resolved', object: { id: 8, name: 'Adam Frisch [FEC:H2CO03351]' } } });
    const d2 = await D.resolveExtracted({ name: 'Adam Brege', type: 'person' }, { resolve: rCO });
    ok(d2.action === 'mint' && /surname-differs/.test(d2.reason || ''), 'V1: Adam Brege is NOT Adam Frisch');
  }
  {
    // The veto must not break a GENUINE match, or it trades a false merge for a duplicate flood.
    const rOk = mockResolver({ 'Carolyn Brummund': { status: 'resolved', object: { id: 7, name: 'Carolyn Brummund' } } });
    ok((await D.resolveExtracted({ name: 'Carolyn Brummund', type: 'person' }, { resolve: rOk })).action === 'reuse',
      'V1: an honest match still REUSES');
    // …including the abbreviation-folded form the canonical registry depends on.
    const rSen = mockResolver({ 'U.S. Senate': { status: 'resolved', object: { id: 3, name: 'United States Senate' } } });
    const dSen = await D.resolveExtracted({ name: 'U.S. Senate', type: 'organization' }, { resolve: rSen });
    ok(dSen.action === 'reuse' && dSen.canonical === 'United States Senate',
      'V1 CRITICAL: "U.S. Senate" still folds into "United States Senate" — the veto must not undo normKey');
    // THE VETO IS PERSONS-ONLY, and the first cut proved why. For a non-person, entity_match's
    // `name-differs` means only that the strings differ — which is precisely what a resolver exists
    // to reconcile. Vetoing on it broke the office canonicalisation this suite already asserts.
    const rOffice = mockResolver({ 'Arkansas Senate': { status: 'resolved', object: { id: 9, name: 'member of the Arkansas Senate [wd:Q21361754]' } } });
    const dOffice = await D.resolveExtracted({ name: 'Arkansas Senate', type: 'office_held' }, { resolve: rOffice });
    ok(dOffice.action === 'reuse' && /Arkansas Senate \[wd:Q21361754\]/.test(dOffice.canonical),
      'V1 CRITICAL: a BODY still canonicalises to its office — the name is SUPPOSED to change there');
  }
  {
    // THE COUNTER-RISK. Rejecting a binding must not mint an attractor: a bare first name whose
    // resolver answer is refused has to fall through the SAME F1 reluctance gate as `nil`, or the
    // fix trades a false merge for the Tracy bug.
    const rChris = mockResolver({ Chris: { status: 'resolved', object: { id: 5, name: 'Christopher Nolan' } } });
    const d = await D.resolveExtracted({ name: 'Chris', type: 'person' }, { resolve: rChris, context: [] });
    ok(d.action === 'hold' && d.provisional === true,
      'V1 CRITICAL: a REJECTED bare first name HOLDS provisional — it must not mint a fresh attractor');
    const dBind = await D.resolveExtracted({ name: 'Tracy', type: 'person' }, { resolve: mockResolver({ Tracy: { status: 'resolved', object: { name: 'Tracy Delaney' } } }), context: ['Tracy Bromley'] });
    ok(dBind.action === 'reuse' && dBind.via === 'context',
      'V1: a rejected weak reference still binds to a full name present in the document');
  }

  // F1 MINT-RELUCTANCE (the Tracy fix): nil + a WEAK person reference must NOT mint a durable node.
  const nilR = mockResolver({});
  ok((await D.resolveExtracted({ name: 'Tracy Bromley', type: 'person' }, { resolve: nilR })).action === 'mint', '2b/F1: nil + full name → MINT (strong reference)');
  const dWeakHold = await D.resolveExtracted({ name: 'Tracy', type: 'person' }, { resolve: nilR, context: [] });
  ok(dWeakHold.action === 'hold' && dWeakHold.provisional === true, '2b/F1: nil + bare first name + no context → HOLD provisional (never mint the attractor)');
  const dWeakBind = await D.resolveExtracted({ name: 'Tracy the finance lady', type: 'person' }, { resolve: nilR, context: ['Tracy Bromley', 'Mark Chen'] });
  ok(dWeakBind.action === 'reuse' && dWeakBind.canonical === 'Tracy Bromley' && dWeakBind.via === 'context', '2b/F1: nil + weak descriptor + full name in context → BIND to Tracy Bromley (reuse, not mint)');
  ok((await D.resolveExtracted({ name: 'the finance lady', type: 'person' }, { resolve: nilR, context: ['Tracy Bromley'] })).action === 'hold', '2b/F1: nil + pure descriptor (no name) → HOLD (no first name to bind on)');

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

  // context threading (R2): resolveExtracted + decomposeDoc forward the doc's co-occurring entities so the
  // resolver can disambiguate an ambiguous candidate by context.
  let seenCtx = null;
  await D.resolveExtracted({ name: 'X', type: 'person' }, { resolve: async (name, opts) => { seenCtx = opts && opts.context; return { status: 'nil' }; }, context: ['A', 'B'] });
  ok(Array.isArray(seenCtx) && seenCtx.length === 2, '2b: resolveExtracted forwards context to the resolver');
  const ctxSeen = [];
  await D.decomposeDoc({ title: 't', url: 'u', text: 'x'.repeat(50) }, { extract: async () => ({ entities: [{ name: 'Alpha One', type: 'person' }, { name: 'Beta Two', type: 'organization' }], relations: [] }), resolve: async (name, opts) => { ctxSeen.push((opts && opts.context) || []); return { status: 'nil' }; }, dispatch: async () => ({ ok: true, text: '{}' }), observe: () => {} });
  ok(ctxSeen.length >= 2 && ctxSeen[0].includes('Alpha One') && ctxSeen[0].includes('Beta Two'), '2c: decomposeDoc passes the doc entity set as context to resolve');
  // endpoint TYPE INFERENCE: a WORKS_FOR target (recovered endpoint) is an organization → resolved typed,
  // so an untyped summary-FTS match on the wrong type can't leak in (the "Rainy Center → CT bill" live bug).
  const seenT = [];
  await D.decomposeDoc({ title: 't', url: 'u', text: 'x'.repeat(50) }, { extract: async () => ({ entities: [{ name: 'Jane Doe', type: 'person' }], relations: [{ source: 'Jane Doe', relation: 'WORKS_FOR', target: 'Acme Org' }] }), resolve: async (name, opts) => { seenT.push({ name, preferType: opts && opts.preferType }); return { status: 'nil' }; }, dispatch: async () => ({ ok: true, text: '{"action":"created"}' }), observe: () => {} });
  const acme = seenT.find(s => s.name === 'Acme Org'), jane = seenT.find(s => s.name === 'Jane Doe');
  ok(acme && acme.preferType === 'organization', '2c: a WORKS_FOR target is inferred organization (resolved with preferType=organization)');
  ok(jane && jane.preferType === 'person', '2c: the person source keeps its own type (preferType=person)');

  // --- RELATION SIGNATURE (official → body fix): type-constrained resolution + canonical predicate ---
  ok(D.canonType('office_held') === 'office_held' && D.canonType('committee') === 'committee' && D.canonType('government_body') === 'government_body', 'sig: civic reference types survive canonType (underscores preserved, not stripped to other)');
  ok(D.canonType('office held') === 'office_held' && D.canonType('position') === 'office_held', 'sig: canonType maps office/position synonyms → office_held');
  ok(D.targetTypeFor('MEMBER_OF', 'Arkansas Senate') === 'office_held', 'sig: MEMBER_OF a legislative body → office_held (fences out same-token FEC PACs)');
  ok(D.targetTypeFor('WORKS_FOR', 'Ohio House of Representatives') === 'office_held', 'sig: WORKS_FOR a chamber → office_held');
  ok(D.targetTypeFor('MEMBER_OF', 'Senate Judiciary Committee') === 'committee', 'sig: MEMBER_OF a committee → committee');
  ok(D.targetTypeFor('WORKS_FOR', 'Acme Corp') === 'organization', 'sig: WORKS_FOR a generic org → organization (unchanged)');
  ok(D.targetTypeFor('CONTRIBUTED_TO', 'House Swing State Fund') === null, 'sig: a donation predicate is NOT membership → untyped, so a PAC still resolves normally as organization (PACs keep working)');
  ok(D.normalizedRelation('MEMBER_OF', 'Ohio State Senate') === 'HELD_OFFICE', 'sig: body membership normalizes to the canonical HELD_OFFICE predicate');

  // ── ANCHORED-ENTITY MINT (Lucas: ingest the WHOLE document — the roster dropped ~5,500 officials) ──
  // A held (ambiguous) FULL-NAME person wired by an edge to a concrete non-person mints unsubstantiated
  // (the edge is the identity anchor); an UNANCHORED one still holds; a BARE name stays held even anchored.
  const _mintOK = async () => ({ ok: true, text: '{"action":"proposed","entity_id":1}' });
  {
    const r = await D.decomposeDoc({ title: 'roster', url: 'https://sos.la.gov/x', text: 'x'.repeat(80) }, {
      extract: async () => ({ entities: [{ name: 'Henry Whitehorn', type: 'person' }, { name: 'Caddo Parish Sheriff', type: 'government_body' }],
        relations: [{ source: 'Henry Whitehorn', relation: 'HELD_OFFICE', target: 'Caddo Parish Sheriff' }] }),
      resolve: mockResolver({ 'Henry Whitehorn': { status: 'ambiguous', candidates: ['a', 'b'] } }),   // → hold; the office nil → unsub
      dispatch: _mintOK, observe: () => {} });
    ok((r.minted_anchored || 0) >= 1 && r.minted_unsub >= 1,
      'ANCHORED MINT: an ambiguous FULL-NAME person wired to an office mints unsubstantiated (was held at confidence 0)');
  }
  {
    const r = await D.decomposeDoc({ title: 'roster', url: 'https://sos.la.gov/x', text: 'x'.repeat(80) }, {
      extract: async () => ({ entities: [{ name: 'Henry Whitehorn', type: 'person' }], relations: [] }),   // NO anchoring edge
      resolve: mockResolver({ 'Henry Whitehorn': { status: 'ambiguous', candidates: ['a', 'b'] } }),
      dispatch: _mintOK, observe: () => {} });
    ok(!r.minted_anchored && r.held >= 1, 'UNANCHORED: the same person with no edge still HOLDS (the anchor is required, not the name)');
  }
  {
    const r = await D.decomposeDoc({ title: 'roster', url: 'https://sos.la.gov/x', text: 'x'.repeat(80) }, {
      extract: async () => ({ entities: [{ name: 'Tracy', type: 'person' }, { name: 'Caddo Parish Sheriff', type: 'government_body' }],
        relations: [{ source: 'Tracy', relation: 'HELD_OFFICE', target: 'Caddo Parish Sheriff' }] }),
      resolve: mockResolver({ 'Tracy': { status: 'ambiguous', candidates: ['a', 'b'] } }),
      dispatch: _mintOK, observe: () => {} });
    ok(!r.minted_anchored, 'BARE NAME: a single-token "Tracy" stays held even WITH an office edge — the attractor guard is intact');
  }
  ok(D.normalizedRelation('MEMBER_OF', 'Senate Judiciary Committee') === 'MEMBER_OF', 'sig: committee membership stays MEMBER_OF');

  // e2e: an official → chamber edge resolves TYPED to office_held and proposes HELD_OFFICE → the real office
  const seenSig = []; const sigCalls = [];
  await D.decomposeDoc({ title: 't', url: 'u', text: 'x'.repeat(50) }, {
    extract: async () => ({ entities: [{ name: 'Jane Legislator', type: 'person' }], relations: [{ source: 'Jane Legislator', relation: 'MEMBER_OF', target: 'Arkansas Senate' }] }),
    resolve: async (name, opts) => { seenSig.push({ name, preferType: opts && opts.preferType }); return name === 'Arkansas Senate' ? { status: 'resolved', object: { id: 9, name: 'member of the Arkansas Senate [wd:Q21361754]' } } : { status: 'resolved', object: { id: 1, name } }; },
    dispatch: async (tag) => { sigCalls.push([tag.name, tag.args]); return { ok: true, text: '{"action":"created"}' }; }, observe: () => {},
  });
  ok(seenSig.find((s) => s.name === 'Arkansas Senate')?.preferType === 'office_held', 'sig e2e: the body target is resolved with preferType=office_held (PAC family excluded at the source)');
  const heldEdge = sigCalls.find((c) => c[0] === 'propose_relation');
  ok(heldEdge && heldEdge[1].relation_type === 'HELD_OFFICE' && heldEdge[1].target_name === 'member of the Arkansas Senate [wd:Q21361754]', 'sig e2e: proposes HELD_OFFICE → the canonical office entity (official connected to the body they serve)');

  // e2e (Slice 2): an UNRESOLVED office is now MINTED UNSUBSTANTIATED so the membership edge LANDS, instead
  // of holding forever (the dominant slice of the 72.8k unresolved-endpoint pile). The office node is tagged
  // unsubstantiated — prove-or-fade: the async lane resolves it to the canonical office or it fades. The
  // anti-QID-dup intent is preserved by the state tag + churn, not by a permanent hold.
  const refCalls = []; const refObs = [];
  const refRes = await D.decomposeDoc({ title: 't', url: 'u', text: 'x'.repeat(50) }, {
    extract: async () => ({ entities: [{ name: 'Obscure Rep', type: 'person' }], relations: [{ source: 'Obscure Rep', relation: 'MEMBER_OF', target: 'Nowhere Senate' }] }),
    resolve: async (name) => (name === 'Nowhere Senate' ? { status: 'nil' } : { status: 'resolved', object: { id: 2, name } }),
    dispatch: async (tag) => { refCalls.push([tag.name, tag.args]); return { ok: true, text: '{"action":"created"}' }; }, observe: (o) => refObs.push(o),
  });
  ok(refCalls.some((c) => c[0] === 'propose_entity' && c[1].name === 'Nowhere Senate'), 'Slice2: an unresolved office is now MINTED (unsubstantiated) so its edge can land');
  ok(refCalls.some((c) => c[0] === 'propose_relation' && c[1].target_name === 'Nowhere Senate'), 'Slice2: the membership edge to the now-minted office LANDS (was held forever)');
  ok(refRes.minted_unsub === 1 && refRes.held === 0, 'Slice2: the office is one unsubstantiated mint; nothing is stranded');
  const refOfficeObs = refObs.find((o) => o.sourceEntity === 'Nowhere Senate' && o.relation === 'exists');
  ok(refOfficeObs && refOfficeObs.substantiationState === 'unsubstantiated' && refOfficeObs.frame === 'real', 'Slice2: the minted office observation is tagged unsubstantiated / frame real');

  // Slice 2 — a KNOWN non-person unresolved endpoint mints unsub + lands; a PERSON and an untyped 'other'
  // endpoint stay HELD (never attractor-mint a bare person — the identity-gate contract; endpoint-recovery
  // types a bare edge endpoint as 'other', so 'other' is treated conservatively as possibly-a-person).
  {
    const s2Calls = []; const s2Obs = [];
    const s2Res = await D.decomposeDoc({ title: 'roster', url: 'https://ex.com/roster', text: 'x'.repeat(50) }, {
      extract: async () => ({
        entities: [{ name: 'Deputy Jane', type: 'person' }, { name: 'Chief Bob', type: 'person' }],
        relations: [
          { source: 'Deputy Jane', relation: 'WORKS_FOR', target: "Pinellas Sheriff's Office" }, // WORKS_FOR target → typed organization → mint unsub + land
          { source: 'Chief Bob', relation: 'MET_WITH', target: 'Tracy' },                         // MET_WITH target → typed 'other' (bare person) → stays held
        ],
      }),
      resolve: mockResolver({
        'Deputy Jane': { status: 'resolved', object: { id: 1, name: 'Deputy Jane' } },
        'Chief Bob': { status: 'resolved', object: { id: 2, name: 'Chief Bob' } },
        "Pinellas Sheriff's Office": { status: 'ambiguous', candidates: ['a', 'b'] },
        'Tracy': { status: 'ambiguous', candidates: ['Tracy A', 'Tracy B'] },
      }),
      dispatch: async (tag) => { s2Calls.push([tag.name, tag.args]); return { ok: true, text: '{"action":"created"}' }; },
      observe: (o) => s2Obs.push(o),
    });
    ok(s2Calls.some((c) => c[0] === 'propose_entity' && c[1].name === "Pinellas Sheriff's Office"), 'Slice2: an ambiguous ORG endpoint is minted unsubstantiated');
    ok(s2Calls.some((c) => c[0] === 'propose_relation' && c[1].target_name === "Pinellas Sheriff's Office"), 'Slice2: the edge to the minted org endpoint lands');
    ok(!s2Calls.some((c) => c[0] === 'propose_entity' && c[1].name === 'Tracy'), 'Slice2: a bare-name person endpoint (typed other) is NOT minted (attractor guard preserved)');
    ok(!s2Calls.some((c) => c[0] === 'propose_relation' && c[1].target_name === 'Tracy'), 'Slice2: the edge to the bare person stays held (not forged)');
    const orgObs = s2Obs.find((o) => o.sourceEntity === "Pinellas Sheriff's Office" && o.relation === 'exists');
    ok(orgObs && orgObs.substantiationState === 'unsubstantiated', 'Slice2: the minted org endpoint observation is unsubstantiated');
    ok(s2Res.minted_unsub === 1 && s2Res.held >= 1, 'Slice2: exactly one unsub mint; the bare-person edge remains held');
  }

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
  // ENDPOINT RECOVERY: "Ghost Entity" was named only as an edge target (never an ENTITY line) → it is now
  // folded in as an 'other' candidate, resolves (nil→mint), and its edge promotes instead of auto-holding.
  ok(res.reused === 1 && res.minted === 3, '2c: 1 reuse (Wilson) + 3 mints (Princeton, echo House, recovered endpoint Ghost)');
  ok(res.ambiguous === 1, '2c: Edith Wilson (ambiguous) counted as ambiguous');
  ok(res.connections === 2, '2c: Wilson→Princeton AND Wilson→Ghost (recovered endpoint) both promote');
  ok(res.held === 2, '2c: 2 fall-throughs held (Edith existence + the Wilson→Edith edge to her)');
  ok(calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Ghost Entity'), '2c: a relation-only endpoint is recovered + minted (not lost to the held queue)');
  ok(calls.some(c => c[0] === 'propose_relation' && c[1].target_name === 'Ghost Entity'), '2c: the edge to the recovered endpoint promotes');
  // canonical-name edge: the proposed relation uses Wilson\'s EXACT stored node name, not the surface form
  const relCall = calls.find(c => c[0] === 'propose_relation' && c[1].target_name === 'Princeton University');
  ok(relCall && relCall[1].source_name === 'Woodrow Wilson [Q34296]', '2c: edge targets the CANONICAL reused node name (not a twin)');
  ok(!calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Woodrow Wilson'), '2c: the REUSED entity is NOT re-minted (no dup)');
  ok(calls.some(c => c[0] === 'propose_entity' && c[1].name === 'Princeton University' && c[1].entity_type === 'organization'), '2c: a minted entity carries its TYPE');
  // confidence + metadata forwarding: a promoted edge carries the graded fact-gate
  // confidence (NOT the flat 0.8 propose_relation default) + provenance metadata.
  ok(relCall && typeof relCall[1].confidence === 'number', '2c: edge forwards a numeric graded confidence (not the 0.8 default)');
  ok(relCall && typeof relCall[1].relation_metadata === 'string' && JSON.parse(relCall[1].relation_metadata).url === DOC.url, '2c: edge carries relation_metadata provenance (source url)');
  // observations: promoted for mints + the cited edges; held for the genuine fall-throughs
  ok(obs.filter(o => o.status === 'promoted').length === 5, '2c: 5 promoted observations (3 mints + 2 edges)');
  ok(obs.filter(o => o.status === 'held').length === 2, '2c: 2 held observations (the fall-through queue)');
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

  // -------------------------------------------------------------------------
  // MIS-RESOLUTION GUARD — a chamber-membership edge must never resolve its
  // target to an FEC committee/PAC (the "N legislators WORKS_FOR one PAC" hub-
  // collision). Original target reads as a body; resolver stretched it to a
  // same-token PAC → HOLD, never forge the spurious hub.
  // -------------------------------------------------------------------------
  {
    const MRDOC = { title: 'AR legislators', url: 'https://ex.com/ar', text: 'x'.repeat(50) };
    const mrExtract = async () => ({
      entities: [{ name: 'Ben Gilmore (AR)', type: 'person' }],
      relations: [
        { source: 'Ben Gilmore (AR)', relation: 'MEMBER_OF', target: 'Arkansas Senate' },   // body → mis-resolves to a PAC
        { source: 'Ben Gilmore (AR)', relation: 'WORKS_FOR', target: 'Acme Corp' },          // genuine employer → allowed
      ],
    });
    const mrResolve = mockResolver({
      'Ben Gilmore (AR)': { status: 'resolved', object: { id: 10, name: 'Ben Gilmore (AR)' } },
      'Arkansas Senate': { status: 'resolved', object: { id: 20, name: 'MR FOR OHIO STATE SENATE [FEC:C00890582]' } }, // the bug
      'Acme Corp': { status: 'resolved', object: { id: 30, name: 'Acme Corp' } },
    });
    const mrCalls = []; const mrObs = [];
    const mrDispatch = async (tag) => { mrCalls.push([tag.name, tag.args]); return { ok: true, text: '{"action":"created"}' }; };
    const mrRes = await D.decomposeDoc(MRDOC, { extract: mrExtract, resolve: mrResolve, dispatch: mrDispatch, observe: async (o) => mrObs.push(o) });
    ok(mrRes.misresolved === 1, 'guard: the body→PAC edge is flagged mis-resolved');
    ok(!mrCalls.some(c => c[0] === 'propose_relation' && c[1].target_name.includes('[FEC:')), 'guard: NO edge is proposed to the FEC committee (hub-collision blocked)');
    ok(mrCalls.some(c => c[0] === 'propose_relation' && c[1].target_name === 'Acme Corp'), 'guard: a GENUINE WORKS_FOR edge (target is not a body) is still proposed');
  }

  // -------------------------------------------------------------------------
  // C1 — VALID-TIME + SOURCE-SET extraction (the Step-3 supersession enabler)
  // -------------------------------------------------------------------------
  {
    const p = D.parseTypedExtraction([
      'REL: Jane Roe | LEADS | Acme Corp | 2023',
      'REL: John Doe | MEMBER_OF | Senate | 2015–2019',
      'REL: Ann Lee | WORKS_FOR | Beta LLC | since 2020',
      'REL: Sam Poe | LEADS | Gamma | until 2018',
      'REL: No Date | RELATED_TO | Thing',
    ].join('\n'));
    const byS = Object.fromEntries(p.relations.map(r => [r.source, r]));
    ok(byS['Jane Roe'].valid_from === 2023 && byS['Jane Roe'].valid_to === null, 'C1: bare year → valid_from');
    ok(byS['John Doe'].valid_from === 2015 && byS['John Doe'].valid_to === 2019, 'C1: year-range → valid_from..valid_to');
    ok(byS['Ann Lee'].valid_from === 2020 && byS['Ann Lee'].valid_to === null, 'C1: "since Y" → valid_from');
    ok(byS['Sam Poe'].valid_to === 2018 && byS['Sam Poe'].valid_from === null, 'C1: "until Y" → valid_to');
    ok(byS['No Date'].valid_from === null && byS['No Date'].valid_to === null, 'C1: no 4th field → null valid-time (3-field REL still parses)');
    ok(/<when>/.test(D.buildTypedPrompt('x')[0].content), 'C1: prompt requests the <when> valid-time field');

    const C1DOC = { title: 'Bio', url: 'https://ex.com/bio', text: 'x'.repeat(50) };
    const c1Extract = async () => ({ entities: [{ name: 'Jane Roe', type: 'person' }, { name: 'Acme Corp', type: 'organization' }], relations: [{ source: 'Jane Roe', relation: 'LEADS', target: 'Acme Corp', valid_from: 2023, valid_to: null }] });
    const c1Resolve = mockResolver({ 'Jane Roe': { status: 'resolved', object: { id: 1, name: 'Jane Roe' } }, 'Acme Corp': { status: 'resolved', object: { id: 2, name: 'Acme Corp' } } });
    const c1Calls = [];
    const c1Dispatch = async (tag) => { c1Calls.push([tag.name, tag.args]); return { ok: true, text: '{"action":"created"}' }; };
    await D.decomposeDoc(C1DOC, { extract: c1Extract, resolve: c1Resolve, dispatch: c1Dispatch, observe: async () => {} });
    const c1Rel = c1Calls.find(c => c[0] === 'propose_relation' && c[1].target_name === 'Acme Corp');
    const md = c1Rel && JSON.parse(c1Rel[1].relation_metadata);
    ok(md && md.valid_from === 2023, 'C1: proposed edge carries valid_from in relation_metadata');
    ok(md && Array.isArray(md.source_set) && md.source_set[0] === C1DOC.url, 'C1: proposed edge carries a source_set (the doc url)');
    // C2+C3 integration: confidence is the CALIBRATED value from the independent-source
    // count (1 here → the grade-B prior), not the flat grade cap; corroboration recorded.
    const CM = require('../lib/confidence_model');
    ok(md && md.corroboration === 1, 'C3: edge records corroboration count (1 = single source)');
    ok(c1Rel && Math.abs(c1Rel[1].confidence - CM.calibratedConfidence({ grade: 'B', corroboration: 1 })) < 1e-9, 'C3: edge confidence = calibrated(B, corr 1), not the flat cap');
  }

  // -------------------------------------------------------------------------
  // STATE-ALIAS NORMALIZATION — matrix: every USPS code maps; the geographic-relation gate keeps
  // ambiguous codes (IN/OR/OK) from expanding in prose; abbreviation + full name unify to one node.
  // -------------------------------------------------------------------------
  ok(Object.keys(D.US_STATES).length >= 51, 'state-alias: full USPS map present (50 states + DC + PR)');
  let sp = 0, sf = 0;
  for (const [code, full] of Object.entries(D.US_STATES)) { if (D.stateFull(code) === full && D.stateFull(code.toLowerCase()) === full) sp++; else sf++; }
  ok(sf === 0, `state-alias: all ${sp} codes map to their full name (case-insensitive)`);
  ok(D.stateFull('N.C.') === 'North Carolina' && D.stateFull('n.c.') === 'North Carolina', 'state-alias: dotted form "N.C." → North Carolina');
  ok(D.stateFull('North Carolina') === null && D.stateFull('XY') === null && D.stateFull('Raleigh') === null, 'state-alias: full names / non-codes → null (no false expansion)');

  // normalizeStateAliases: expands ONLY codes seen in a geographic relation; unifies NC & North Carolina.
  const nz = D.normalizeStateAliases(
    [{ name: 'Ted Alexander', type: 'person' }, { name: 'North Carolina', type: 'location' }, { name: 'Raleigh', type: 'location' }, { name: 'NC', type: 'other' }],
    [{ source: 'Ted Alexander', relation: 'REPRESENTED', target: 'North Carolina' }, { source: 'Raleigh', relation: 'LOCATED_IN', target: 'NC' }]
  );
  ok(nz.relations.every(r => r.target !== 'NC') && nz.relations.some(r => r.source === 'Raleigh' && r.target === 'North Carolina'), 'normalizeStateAliases: "Raleigh LOCATED_IN NC" → LOCATED_IN North Carolina (unified)');
  ok(!nz.entities.some(e => String(e.name).toLowerCase() === 'nc') && nz.entities.filter(e => e.name === 'North Carolina').length === 1, 'normalizeStateAliases: the bare "NC" entity folds into the single North Carolina node');
  // the GATE: an ambiguous code NOT in a place relation is left alone (no "IN"→Indiana in prose).
  const gz = D.normalizeStateAliases([{ name: 'IN', type: 'other' }], [{ source: 'X', relation: 'RELATED_TO', target: 'IN' }]);
  ok(gz.relations[0].target === 'IN' && !gz.entities.some(e => e.name === 'Indiana'), 'normalizeStateAliases: an ambiguous code in a NON-place relation is NOT expanded (the gate)');
  // but the SAME code IS expanded when it IS a place endpoint
  const gz2 = D.normalizeStateAliases([], [{ source: 'Indianapolis', relation: 'LOCATED_IN', target: 'IN' }]);
  ok(gz2.relations[0].target === 'Indiana', 'normalizeStateAliases: "…LOCATED_IN IN" → Indiana (place context makes it safe)');

  // --- Slice 3 (full-spectrum): the intellectual layer maps to concept + the optional gloss field ---
  ok(D.canonType('technology') === 'concept' && D.canonType('material') === 'concept' && D.canonType('method') === 'concept', 'canonType: tech/material/method → concept (Echo-accepted, not dropped)');
  ok(D.canonType('phenomenon') === 'concept' && D.canonType('framework') === 'concept', 'canonType: more intellectual-layer synonyms → concept');
  const s3 = D.parseTypedExtraction([
    'ENTITY: Glass Interposer :: technology :: a glass layer between logic and memory chiplets',
    'ENTITY: Borosilicate :: material :: low-CTE glass used for substrates',
    'ENTITY: Woodrow Wilson :: person',                                   // legacy 2-field still parses
    'REL: Glass Interposer | ENABLES | Chiplet Integration',
  ].join('\n'));
  const gi = s3.entities.find(e => e.name === 'Glass Interposer');
  ok(gi && gi.type === 'concept', 'parse: a "technology" entity lands as concept (the ideas are no longer dropped)');
  ok(gi && /chiplets/.test(gi.gloss || ''), 'parse: the one-line gloss is captured (objects are filled, not bare names)');
  ok(s3.entities.find(e => e.name === 'Borosilicate').type === 'concept', 'parse: a "material" entity lands as concept');
  ok(s3.entities.find(e => e.name === 'Woodrow Wilson') && s3.entities.find(e => e.name === 'Woodrow Wilson').gloss === null, 'parse: legacy 2-field line still parses (gloss null)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
