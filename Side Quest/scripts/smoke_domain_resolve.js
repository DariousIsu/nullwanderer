/* Smoke: lib/domain_resolve — the shared org→domain resolver (seed → web-resolve, aggregator-filtered).
 * Pure except an injected webSearch fake. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_domain_resolve.js
 */
const dr = require('../lib/domain_resolve');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- seed map (the operator's recurring orgs, verified against Hunter this session) ---
ok(dr.seedDomain("SWEPCO's Vice President, Regulatory & Finance") === 'swepco.com', 'seed: SWEPCO → swepco.com');
ok(dr.seedDomain('Director of the LSU Center for Energy Studies') === 'lsu.edu', 'seed: LSU → lsu.edu');
ok(dr.seedDomain('Shreveport Mayor') === 'shreveportla.gov', 'seed: Shreveport → shreveportla.gov');
ok(dr.seedDomain('Louisiana Public Service Commission') === 'lpsc.louisiana.gov', 'seed: LPSC → lpsc.louisiana.gov');
ok(dr.seedDomain('Gulf States Renewable Energy Industries Assoc.') === 'gsreia.org', 'seed: Gulf States → gsreia.org');
ok(dr.seedDomain('Louisiana Mid-Continent Oil & Gas Association') === 'lmoga.com', 'seed: LMOGA → lmoga.com');
ok(dr.seedDomain('some random unseen company llc') === null, 'seed: unknown org → null (falls to web-resolve)');

// --- registrableDomain extraction ---
ok(dr.registrableDomain('https://www.swepco.com/about/') === 'swepco.com', 'registrable: strips www + path');
ok(dr.registrableDomain('http://lpsc.louisiana.gov/') === 'lpsc.louisiana.gov', 'registrable: keeps multi-label .gov host intact');
ok(dr.registrableDomain('https://sub.example.com') === 'example.com', 'registrable: commercial → last two labels');
ok(dr.registrableDomain('not a url') === null, 'registrable: junk → null');

// --- aggregator filter ---
ok(dr.isAggregator('linkedin.com') && dr.isAggregator('en.wikipedia.org') && dr.isAggregator('ballotpedia.org'), 'aggregator: profile/directory hosts flagged');
ok(!dr.isAggregator('swepco.com') && !dr.isAggregator('lsu.edu'), 'aggregator: real org domains NOT flagged');

(async () => {
  // --- web-resolve: skips the aggregator, takes the org's own site ---
  const fakeSearch = async (q) => ({ results: [
    { url: 'https://en.wikipedia.org/wiki/Some_Org' },      // aggregator → skip
    { url: 'https://www.linkedin.com/company/some-org' },   // aggregator → skip
    { url: 'https://www.some-org.org/about' },              // the real site → take it
  ] });
  const d = await dr.resolveDomain('Some Unseen Org', { webSearch: fakeSearch });
  ok(d === 'some-org.org', 'web-resolve: skips aggregators, returns the org\'s own registrable domain');

  // seed wins without even calling the web
  let called = false;
  const spy = async () => { called = true; return { results: [] }; };
  const s = await dr.resolveDomain('LSU Center for Energy Studies', { webSearch: spy });
  ok(s === 'lsu.edu' && called === false, 'seed short-circuits before any web call');

  // nothing resolvable → null (never a fabricated domain)
  const none = await dr.resolveDomain('Totally Unknown Xyz', { webSearch: async () => ({ results: [{ url: 'https://linkedin.com/x' }] }) });
  ok(none === null, 'only-aggregator results → null (no bad domain handed to Hunter)');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
