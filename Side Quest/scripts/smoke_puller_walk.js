/* Smoke: lib/puller_walk — the autonomous Puller lane of the subconscious. Fully offline: puller_beliefs
 * builds a real learned pattern state; every I/O dep to runPullerMove is mocked.
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_puller_walk.js
 */
'use strict';
const PW = require('../lib/puller_walk');
const B = require('../studio/puller_beliefs');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// A domain that has LEARNED the first.last pattern (belief pushed above the 0.45 floor).
let learned = B.emptyState();
for (let i = 0; i < 8; i++) learned = B.updateBelief(learned, 'first.last', 'valid');
const unlearned = B.emptyState();   // bare prior (0.15) → below the floor

// --- pickTarget: skips has-email + attempted; prefers active-set, then domain ---
const cands = [
  { id: 1, name: 'Has Email', company: 'X', domain: 'x.com', hasEmail: true },
  { id: 2, name: 'No Domain', company: 'Y', domain: null, hasEmail: false },
  { id: 3, name: 'Jane Smith', company: 'Rainey Center', domain: 'raineycenter.org', hasEmail: false },
];
ok(PW.pickTarget(cands, {}).id === 3, 'pickTarget: prefers a domain-bearing missing-email target over a domain-less one');
ok(PW.pickTarget(cands, { activeKeys: new Set([PW.norm('No Domain')]) }).id === 2, 'pickTarget: an active-set member outranks a non-member');
ok(PW.pickTarget([{ id: 1, name: 'Has Email', hasEmail: true }], {}) === null, 'pickTarget: nothing to fill → null');
ok(PW.pickTarget(cands, { attemptedKeys: new Set([PW.attemptKeyOf(cands[2])]) }).id === 2, 'pickTarget: a recently-attempted target is skipped');

// --- patternFillCandidate: learned domain → email; unlearned → null ---
const pc = PW.patternFillCandidate(learned, 'Jane Smith', 'raineycenter.org');
ok(pc && pc.email === 'jane.smith@raineycenter.org' && pc.pattern === 'first.last', 'patternFillCandidate: derives the learned first.last address');
ok(pc && pc.confidence >= 0.45, `patternFillCandidate: confidence rides the domain belief (${pc && pc.confidence.toFixed(2)})`);
ok(PW.patternFillCandidate(unlearned, 'Jane Smith', 'raineycenter.org') === null, 'patternFillCandidate: bare-prior domain (no learned lean) → null (no guess)');
ok(PW.patternFillCandidate(learned, 'Jane Smith', 'raineycenter.org', { tried: ['jane.smith@raineycenter.org'] }) === null || PW.patternFillCandidate(learned, 'Jane Smith', 'raineycenter.org', { tried: ['jane.smith@raineycenter.org'] }).email !== 'jane.smith@raineycenter.org', 'patternFillCandidate: excludes an already-tried address');

// --- buildContactSearchQuery / pickPersonRow ---
ok(PW.buildContactSearchQuery('Jane Smith', 'Rainey Center') === 'Jane Smith Rainey Center email contact', 'buildContactSearchQuery: name + company + intent');
ok(PW.buildContactSearchQuery('Jane Smith', '') === 'Jane Smith email contact', 'buildContactSearchQuery: no company');
const rowHit = PW.pickPersonRow([{ name: 'Some Other', email: 'x@y.com' }, { name: 'Jane A. Smith', email: 'jane@rc.org', phone: '555' }], 'Jane Smith');
ok(rowHit && rowHit.email === 'jane@rc.org' && rowHit.phone === '555', 'pickPersonRow: matches by name-token overlap, returns email+phone');
ok(PW.pickPersonRow([{ name: 'Jane Smith' }], 'Jane Smith') === null, 'pickPersonRow: a name match with NO contact field → null');
ok(PW.pickPersonRow([{ name: 'Bob Jones', email: 'b@j.com' }], 'Jane Smith') === null, 'pickPersonRow: a non-matching name is not taken');

// --- runPullerMove: PATTERN path ---
(async () => {
  const meta = new Map();
  const gm = (k) => meta.get(k) || null, sm = (k, v) => meta.set(k, v);
  const landed = [];
  let refreshed = null;
  const patternMove = await PW.runPullerMove({
    candidates: [{ id: 3, name: 'Jane Smith', company: 'Rainey Center', domain: 'raineycenter.org', hasEmail: false }],
    getPatternState: () => learned,
    triedFor: () => [],
    land: (o) => landed.push(o),
    refresh: (id) => { refreshed = id; },
    getMeta: gm, setMeta: sm, now: () => 1000,
  });
  ok(patternMove.acted && patternMove.mode === 'pattern' && patternMove.email === 'jane.smith@raineycenter.org', 'runPullerMove: PATTERN path fills the learned address');
  ok(landed.length === 1 && landed[0].attr === 'email' && landed[0].sourceUrl === 'puller-pattern:raineycenter.org', 'runPullerMove: lands a CITED email observation (pattern derivation)');
  ok(refreshed === 3, 'runPullerMove: refreshes the target card');
  ok(gm(PW.ATTEMPT_KEY) && /Jane Smith/i.test(gm(PW.ATTEMPT_KEY)) || gm(PW.ATTEMPT_KEY).includes('jane smith'), 'runPullerMove: records the attempt (cooldown)');

  // re-running the same move is now a cooldown no-op (same target, within TTL)
  const again = await PW.runPullerMove({
    candidates: [{ id: 3, name: 'Jane Smith', company: 'Rainey Center', domain: 'raineycenter.org', hasEmail: false }],
    getPatternState: () => learned, land: (o) => landed.push(o), refresh: () => {}, getMeta: gm, setMeta: sm, now: () => 2000,
  });
  ok(!again.acted && again.reason === 'no-target', 'runPullerMove: a just-attempted target is on cooldown → no-target');

  // --- runPullerMove: WEB path (no domain → skips pattern, searches + extracts) ---
  const meta2 = new Map();
  const landed2 = [];
  let webQuery = null;
  const webMove = await PW.runPullerMove({
    candidates: [{ id: 4, name: 'John Doe', company: 'Acme', domain: null, hasEmail: false }],
    web: async (q) => { webQuery = q; return [{ text: 'John Doe — Acme Corp. Reach him at john.doe@acme.com or 704-555-1212.', url: 'https://acme.com/team' }]; },
    extract: async () => ({ people: [{ name: 'John Doe', email: 'john.doe@acme.com', phone: '704-555-1212' }], places: [], events: [] }),
    land: (o) => landed2.push(o),
    refresh: () => {},
    getMeta: (k) => meta2.get(k) || null, setMeta: (k, v) => meta2.set(k, v), now: () => 5000,
  });
  ok(webMove.acted && webMove.mode === 'web' && webMove.email === 'john.doe@acme.com', 'runPullerMove: WEB path extracts a stated email from search results');
  ok(webQuery === 'John Doe Acme email contact', 'runPullerMove: web query built from the target');
  ok(landed2.some(o => o.attr === 'email' && o.sourceUrl === 'https://acme.com/team') && landed2.some(o => o.attr === 'phone'), 'runPullerMove: web fills are CITED to the source URL (email + phone)');

  // --- runPullerMove: NO-FILL (domain but unlearned pattern, no web dep) ---
  const noFill = await PW.runPullerMove({
    candidates: [{ id: 5, name: 'Nobody Known', company: 'Z', domain: 'z-unlearned.com', hasEmail: false }],
    getPatternState: () => unlearned, land: () => {}, refresh: () => {}, getMeta: (k) => null, setMeta: () => {}, now: () => 9000,
  });
  ok(!noFill.acted && noFill.reason === 'no-fill', 'runPullerMove: unlearned domain + no web → no-fill (never guesses)');

  // --- runPullerMove: nothing to work ---
  const empty = await PW.runPullerMove({ candidates: [], getMeta: (k) => null, setMeta: () => {}, now: () => 1 });
  ok(!empty.acted && empty.reason === 'no-target', 'runPullerMove: empty candidate set → no-target');

  // === DISCOVERY MODE ===
  // pickSeedOrg: skips junk + prospected; prefers a domain-bearing org
  ok(PW.pickSeedOrg([{ name: 'Not Reported' }, { name: 'Rainey Center', domain: 'raineycenter.org' }]).name === 'Rainey Center', 'pickSeedOrg: skips junk ("Not Reported"), takes the real org');
  ok(PW.pickSeedOrg([{ name: 'Acme' }, { name: 'Beta Org', domain: 'beta.com' }]).name === 'Beta Org', 'pickSeedOrg: prefers a domain-bearing org');
  ok(PW.pickSeedOrg([{ name: 'Rainey Center' }], { prospectedKeys: new Set([PW.orgKeyOf({ name: 'Rainey Center' })]) }) === null, 'pickSeedOrg: a recently-prospected org is skipped');
  ok(PW.pickSeedOrg([{ name: 'Office of' }, { name: 'na' }]) === null, 'pickSeedOrg: all junk/too-short → null');
  ok(PW.buildOrgProspectQuery({ name: 'Rainey Center' }) === 'Rainey Center staff directory team leadership', 'buildOrgProspectQuery: org staff/roster query');

  // runDiscoveryMove: search org → extract people → filterNew dedup → mint net-new targets
  const meta3 = new Map();
  const createdIds = []; const landed3 = [];
  let filteredInput = null;
  const disc = await PW.runDiscoveryMove({
    seedOrgs: [{ name: 'Rainey Center', domain: 'raineycenter.org' }],
    web: async () => [{ text: 'Team: Jane Roe (Director), Bob Known (Fellow, bob@raineycenter.org)', url: 'https://raineycenter.org/team' }],
    extract: async () => ({ people: [{ name: 'Jane Roe', title: 'Director' }, { name: 'Bob Known', email: 'bob@raineycenter.org' }], places: [], events: [] }),
    filterNew: async (people) => { filteredInput = people; return people.filter(p => p.name !== 'Bob Known'); },   // Bob already in CRM → dropped
    createTarget: async ({ name, company, domain }) => { createdIds.push({ name, company, domain }); return 900 + createdIds.length; },
    land: (o) => landed3.push(o),
    getMeta: (k) => meta3.get(k) || null, setMeta: (k, v) => meta3.set(k, v), now: () => 10000,
  });
  ok(disc.acted && disc.mode === 'discover' && disc.count === 1, 'runDiscoveryMove: mints the ONE net-new person (dedup dropped the known one)');
  ok(createdIds.length === 1 && createdIds[0].name === 'Jane Roe' && createdIds[0].company === 'Rainey Center' && createdIds[0].domain === 'raineycenter.org', 'runDiscoveryMove: new target carries the seed org + domain');
  ok(filteredInput && filteredInput.length === 2, 'runDiscoveryMove: passes all extracted people through the CRM/Puller dedup');
  ok(meta3.get(PW.PROSPECT_KEY) && /rainey/.test(meta3.get(PW.PROSPECT_KEY)), 'runDiscoveryMove: records the org cooldown');

  // all extracted people already known → no-new (mints nothing)
  const discKnown = await PW.runDiscoveryMove({
    seedOrgs: [{ name: 'Rainey Center' }],
    web: async () => [{ text: 'x', url: 'u' }],
    extract: async () => ({ people: [{ name: 'Bob Known' }], places: [], events: [] }),
    filterNew: async () => [],
    createTarget: async () => 1,
    getMeta: (k) => null, setMeta: () => {}, now: () => 20000,
  });
  ok(!discKnown.acted && discKnown.reason === 'no-new', 'runDiscoveryMove: every extracted person already known → no-new (mints nothing)');

  // no seed org available → no-seed
  const discNoSeed = await PW.runDiscoveryMove({ seedOrgs: [], web: async () => [], extract: async () => ({}), createTarget: async () => 1, getMeta: (k) => null, setMeta: () => {}, now: () => 1 });
  ok(!discNoSeed.acted && discNoSeed.reason === 'no-seed', 'runDiscoveryMove: no seed org → no-seed');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
