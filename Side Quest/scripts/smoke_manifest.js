/* Smoke: lib/manifest — the turn-manifest builder (KEYSTONE Slice 1). Proves the coordinate scheme,
 * namespace/status classification (self / owner / held-graph / held-echo / minted-new / ambiguous), the
 * pure assembly, and the I/O orchestration with fully MOCKED deps (no Echo, no cloud). Fixture is the
 * Disney/LAMP summit turn used throughout the 2026-07-25 design.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_manifest.js
 */
'use strict';
const M = require('../lib/manifest');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── PURE: coordinate + type + slug ──────────────────────────────────────────────────────────────
ok(M.toCoordinate({ type: 'organization', namespace: 'graph', id: 387 }) === 'org:graph/387', 'toCoordinate: resolved id → type:ns/id');
ok(M.toCoordinate({ type: 'place', namespace: 'short', name: 'Walt Disney World' }) === 'place:short/walt-disney-world', 'toCoordinate: no id → slug of the name');
ok(M.canonType('organization') === 'org' && M.canonType('location') === 'place' && M.canonType('government_body') === 'gov', 'canonType: synonyms fold to canonical');
ok(M.canonType('') === 'thing' && M.canonType('sasquatch') === 'thing', 'canonType: unknown/empty → thing (untyped but real)');
ok(M.slugify('The LAMP Summit 2026!') === 'the-lamp-summit-2026', 'slugify: ascii-words joined, bounded');

// ── PURE: classify namespace + status ───────────────────────────────────────────────────────────
ok(M.classify(null, null, { isSelf: true }).status === M.STATUS.SELF, 'classify: self flag → status self');
ok(M.classify(null, null, { isOwner: true }).namespace === 'owner', 'classify: owner flag → owner namespace');
ok(M.classify({ id: 387 }, { status: 'resolved', object: { id: 387 } }).status === M.STATUS.HELD, 'classify: resolved → held');
ok(M.classify({ id: 1519651 }, { status: 'resolved', object: { id: 1519651 } }).namespace === 'echo', 'classify: big/echo id → echo namespace');
ok(M.classify(null, { status: 'ambiguous', candidates: ['Lamp (band)', 'LAMP Alliance'] }).status === M.STATUS.AMBIGUOUS, 'classify: 2+ candidates → ambiguous');
ok(M.classify(null, { status: 'no-match' }).status === M.STATUS.MINTED_NEW, 'classify: unresolved → minted-new');

// ── PURE: assembleManifest on the Disney/LAMP fixture ────────────────────────────────────────────
// The plan intake.decompose WOULD emit for: "Zoe, we are going to Disney for the Rainey LAMP summit this
// year, are you excited?" — 5 objects across every namespace, a temporal constraint, and an edge.
const plan = {
  intent: 'social',
  objects: [
    { mention: 'Zoe', type: 'person', op: 'resolve', salient: false },
    { mention: 'Rainey Center', type: 'organization', op: 'resolve', salient: true },
    { mention: 'LAMP', type: 'organization', op: 'resolve', salient: true },
    { mention: 'LAMP summit', type: 'event', op: 'create', salient: true },
    { mention: 'Disney', type: 'place', op: 'create', salient: true },
  ],
  relations: [{ source: 'Lucas', type: 'ATTENDING', target: 'LAMP summit' }],
  constraints: [{ kind: 'temporal', value: 'this year (2026)', binds: 'LAMP summit' }],
  clarify: [],
};
const resolutions = [
  { status: 'skip' },                                                                       // Zoe (self)
  { status: 'resolved', object: { id: 387, entity_type: 'organization', summary: 'Rainey Center — think tank' } },
  { status: 'resolved', object: { id: 1519651, entity_type: 'organization', summary: 'Leadership Alliance for a More Perfect Union' } },
  { status: 'skip' },                                                                       // LAMP summit (op=create)
  { status: 'skip' },                                                                       // Disney (op=create)
];
const man = M.assembleManifest(plan, resolutions, {
  userName: 'Lucas',
  selfFlags: [true, false, false, false, false],
  ownerFlags: [false, false, false, false, false],
});

const bySurface = Object.fromEntries(man.objects.map(o => [o.surface, o]));
ok(man.objects.length === 5, 'assemble: every named object gets a row (coverage, not just the salient one)');
ok(bySurface['Zoe'].coord === 'self:zoe/core' && bySurface['Zoe'].status === 'self', 'assemble: Zoe → the canonical self coordinate, not a civic lookup');
ok(bySurface['Rainey Center'].coord === 'org:graph/387' && bySurface['Rainey Center'].status === 'held', 'assemble: Rainey → held graph coordinate');
ok(bySurface['LAMP'].coord === 'org:echo/1519651' && bySurface['LAMP'].gloss.includes('Perfect Union'), 'assemble: LAMP → held echo coordinate + gloss (disambiguated to the Alliance)');
ok(bySurface['LAMP summit'].status === 'minted-new' && bySurface['LAMP summit'].coord.startsWith('event:short/'), 'assemble: LAMP summit → minted short-term event coordinate');
ok(bySurface['Disney'].status === 'minted-new' && bySurface['Disney'].coord.startsWith('place:short/'), 'assemble: Disney → minted short-term place coordinate');
ok(man.gaps.length === 2 && man.gaps.every(g => /:short\//.test(g.coord)), 'assemble: the two unresolved objects surface as explicit GAPS (honest "I hold nothing yet")');
ok(man.temporal && /2026/.test(man.temporal), 'assemble: temporal constraint rides through');
ok(man.relations.length === 1 && man.relations[0].type === 'ATTENDING', 'assemble: the turn edge rides through');

// ── render is deterministic + carries the contract ──────────────────────────────────────────────
const txt = M.render(man);
ok(/state as fact ONLY what has a coordinate/i.test(txt), 'render: carries the anti-confab contract');
ok(/GAPS \(you hold nothing yet/.test(txt) && /place:short\/disney/.test(txt), 'render: names the gaps explicitly so the cloud admits them');

// ── AMBIGUOUS path: bare "LAMP" with no work-context collides ────────────────────────────────────
const ambMan = M.assembleManifest(
  { intent: 'chat', objects: [{ mention: 'LAMP', type: 'organization', op: 'resolve', salient: true }], relations: [], constraints: [] },
  [{ status: 'ambiguous', candidates: ['Lamp (band)', 'LAMP Stack', 'LAMP Alliance'] }],
  { selfFlags: [false], ownerFlags: [false] }
);
ok(ambMan.objects[0].status === 'ambiguous' && ambMan.objects[0].candidates.length === 3, 'ambiguous: candidates surfaced for the cloud to disambiguate/ask');

// ── I/O ORCHESTRATION: buildManifest with fully mocked deps (no Echo, no cloud) ──────────────────
(async () => {
  const mockDecompose = async () => ({
    intent: 'social',
    objects: [
      { mention: 'Zoe', type: 'person', op: 'resolve', salient: false },
      { mention: 'Rainey Center', type: 'organization', op: 'resolve', salient: true },
      { mention: 'Disney', type: 'place', op: 'create', salient: true },
    ],
    relations: [], constraints: [{ kind: 'temporal', value: '2026' }], clarify: [],
  });
  const mockResolve = async (mention) => {
    if (/rainey/i.test(mention)) return { status: 'resolved', object: { id: 387, entity_type: 'organization', summary: 'Rainey Center' } };
    return { status: 'no-match', mention };
  };
  const built = await M.buildManifest('Zoe, we are going to Disney for the Rainey summit', {
    userName: 'Lucas',
    deps: {
      decompose: mockDecompose,
      resolve: mockResolve,
      isSelfName: (n) => /^zoe$/i.test(n),
      isOwnerName: () => false,
    },
  });
  const bs = Object.fromEntries(built.objects.map(o => [o.surface, o]));
  ok(built.objects.length === 3, 'buildManifest: orchestrates decompose → resolve → assemble (Zoe folds into the mounted self, no dup)');
  ok(bs['Zoe'].coord === 'self:zoe/core' && bs['Zoe'].status === 'self', 'buildManifest: self mention → canonical self coordinate');
  ok(bs['Rainey Center'].status === 'held' && bs['Rainey Center'].coord === 'org:graph/387', 'buildManifest: resolved via mock resolve → held coordinate');
  ok(bs['Disney'].status === 'minted-new', 'buildManifest: op=create skips resolve → minted short-term');
  ok(built.gaps.length === 1 && built.gaps[0].surface === 'Disney', 'buildManifest: Disney is the honest gap');

  // ── ALWAYS-MOUNT SELF: a turn with NO self mention still carries self:zoe/core ──────────────────
  const noSelf = await M.buildManifest('what are the Louisiana parishes', {
    deps: {
      decompose: async () => ({ intent: 'answer', objects: [{ mention: 'Louisiana', type: 'place', op: 'resolve', salient: true }], relations: [], constraints: [] }),
      resolve: async () => ({ status: 'no-match' }),
      ownerResolve: (n) => (/^zoe$/i.test(n) ? { status: 'resolved', object: { id: 'self:zoe/core', entity_type: 'self', summary: 'You — the companion', namespace: 'zoe', ownerWorld: true } } : null),
      isSelfName: () => false, isOwnerName: () => false,
    },
  });
  ok(noSelf.objects.some(o => o.coord === 'self:zoe/core' && o.status === 'self'), 'always-mount: self:zoe/core is present even when the turn never named her');

  // ── OWNER-WORLD PRIOR: "Alice" in a turn binds to the daughter, not a civic namesake ───────────
  const ownerBuilt = await M.buildManifest('is Alice excited for cheer', {
    userName: 'Lucas',
    deps: {
      decompose: async () => ({ intent: 'chat', objects: [{ mention: 'Alice', type: 'person', op: 'resolve', salient: true }], relations: [], constraints: [] }),
      // civic resolve would return a legislator — owner-world must WIN before this is ever consulted
      resolve: async () => ({ status: 'resolved', object: { id: 1366690, entity_type: 'person', summary: 'Alice Miller (VT) — legislator' } }),
      ownerResolve: (n) => (/^alice$/i.test(n) ? { status: 'resolved', object: { id: 'person:owner/alice', entity_type: 'person', summary: "Lucas's youngest daughter, 12, competitive cheer", namespace: 'owner', ownerWorld: true } } : null),
      isSelfName: () => false, isOwnerName: () => false,
    },
  });
  const aliceRow = ownerBuilt.objects.find(o => o.surface === 'Alice');
  ok(aliceRow && aliceRow.coord === 'person:owner/alice', 'owner-world prior: "Alice" → the daughter coordinate, NOT the civic legislator resolve');
  ok(aliceRow.status === 'held' && /cheer/i.test(aliceRow.gloss), 'owner-world prior: carries the daughter gloss, civic resolve never consulted');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
