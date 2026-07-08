/* Smoke: lib/concept_ground — resolve-or-ground (Lucas's spec). PURE decision + fail-soft grounder.
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_concept_ground.js
 */
'use strict';
const cg = require('../lib/concept_ground');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- disambiguationAction: person collisions ASK, concept/nil GROUND ---
ok(cg.disambiguationAction({ status: 'resolved' }) === 'use', 'resolved → use');
ok(cg.disambiguationAction({ status: 'error' }) === 'use', 'error → use (fail-safe, no invention)');
ok(cg.disambiguationAction({ status: 'nil' }) === 'ground', 'nil (no node) → ground+create');
ok(cg.disambiguationAction({ status: 'ambiguous', candidates: [{ name: 'John Kennedy', type: 'person' }, { name: 'John Kennedy', type: 'person' }] }) === 'ask', '2+ distinct PEOPLE → ASK (keep the wrong-answer fix)');
ok(cg.disambiguationAction({ status: 'ambiguous', candidates: [{ name: 'AI arms race', type: 'concept' }, { name: 'driver safety arms race', type: 'concept' }] }) === 'ground', '2 concept candidates → GROUND (the AI Arms Race case)');
ok(cg.disambiguationAction({ status: 'ambiguous', candidates: [{ name: 'X', type: 'person' }, { name: 'X', type: 'concept' }] }) === 'ground', 'mixed (only 1 person) → ground, not ask');
ok(cg.disambiguationAction({ status: 'ambiguous', candidates: [{ name: 'X', type: 'organization' }, { name: 'X', type: 'event' }] }) === 'ground', 'org/event collision → ground (not person)');
ok(cg.disambiguationAction({ status: 'weird' }) === 'use', 'unknown status → use (safe default)');

// --- pickCitation: first http result → citation, else null ---
ok(cg.pickCitation([{ title: 'T', url: 'https://x.com/a', snippet: 's' }]).url === 'https://x.com/a', 'picks the first http result');
ok(cg.pickCitation({ results: [{ url: 'http://y.org' }] }).url === 'http://y.org', 'unwraps {results:[...]}');
ok(cg.pickCitation([{ title: 'no url' }, { url: 'ftp://z' }, { url: 'https://ok.com' }]).url === 'https://ok.com', 'skips non-http, takes the http one');
ok(cg.pickCitation([]) === null && cg.pickCitation(null) === null, 'no results → null');

// --- groundAndCreate: verified w/ citation, unverified w/o, fail-soft always returns a usable node ---
(async () => {
  const withCite = await cg.groundAndCreate('the AI arms race', { deps: { search: async () => [{ title: 'AI arms race', url: 'https://en.wikipedia.org/wiki/AI_arms_race', snippet: 'a competition...' }], create: async () => ({ ok: true }) } });
  ok(withCite.ok && withCite.grounded && withCite.verified === true && withCite.node.source === 'https://en.wikipedia.org/wiki/AI_arms_race', 'citation found → VERIFIED node with source');
  ok(withCite.node.summary && withCite.node.unverified === false, 'verified node carries the summary + not-unverified');

  const noCite = await cg.groundAndCreate('some obscure made-up term', { deps: { search: async () => [] } });
  ok(noCite.ok && noCite.grounded && noCite.verified === false && noCite.node.unverified === true && noCite.node.type === 'concept', 'no citation → UNVERIFIED CONCEPT node');

  const searchThrew = await cg.groundAndCreate('x', { deps: { search: async () => { throw new Error('echo down'); } } });
  ok(searchThrew.ok && searchThrew.node && searchThrew.verified === false, 'search throws → fail-soft unverified node (no throw)');

  const createThrew = await cg.groundAndCreate('y', { deps: { search: async () => [{ url: 'https://a.com' }], create: async () => { throw new Error('propose failed'); } } });
  ok(createThrew.ok && createThrew.verified === true, 'persist throws → still returns the usable (verified) node');

  ok((await cg.groundAndCreate('', {})).ok === false, 'empty mention → {ok:false}, no work');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
