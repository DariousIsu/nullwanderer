/* smoke_org_site.js — an organisation's own website: no guessing, and prove it is theirs.
 *
 * The load-bearing tests are the REFUSALS. A guessed domain manufactures an ORIGIN, and origin is what
 * the whole grading model rests on — the corpus already contains `alconacountyfair.com` (not the county)
 * and `countynewscenter.com` (not a county), so a plausible hostname is provably not evidence.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_org_site.js
 */
'use strict';
const os = require('../lib/org_site');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── the distinctive name, not the generic nouns ──────────────────────────────────────────────────
{
  const t = os.distinctiveTokens('The Joseph Rainey Center for Public Policy');
  ok(t.includes('joseph') && t.includes('rainey') && t.includes('policy'), 'keeps the identifying tokens');
  ok(!t.includes('the') && !t.includes('center') && !t.includes('for'),
    'CRITICAL: drops generic nouns — "Center" alone would match every nonprofit page on the web');
  ok(os.distinctiveTokens('RAINEY CENTER FREEDOM PROJECT, INC.').join(',') === 'rainey,freedom',
    'punctuation, case and corporate form fall away');
}

// ── NO DOMAIN GUESSING ───────────────────────────────────────────────────────────────────────────
ok(os.acceptUrl('https://www.raineycenter.org/', 'operator') !== null, 'a URL Lucas hands over is accepted');
ok(os.acceptUrl('https://www.raineycenter.org/', 'register') !== null, 'a URL from Wikidata P856 is accepted');
for (const p of ['guess', 'inferred', 'search', null, undefined, '']) {
  ok(os.acceptUrl('https://raineycenter.org/', p) === null,
    `CRITICAL: provenance "${p}" is REFUSED — a guessed domain manufactures an origin`);
}
ok(os.acceptUrl('raineycenter.org', 'operator') === null, 'a bare hostname is not a URL');
ok(os.acceptUrl('', 'operator') === null && os.acceptUrl(null, 'operator') === null, 'garbage in → null');

// ── the page must still prove it is theirs ───────────────────────────────────────────────────────
{
  const real = 'The Rainey Center is a policy organization founded by Sarah Hunt. Joseph Rainey was the first Black congressman. Our public policy work…';
  const v = os.verifyPage('The Joseph Rainey Center for Public Policy', real);
  ok(v.ok === true, `a real page naming the org verifies (${v.why})`);
}
{
  // A parked or resold domain. This is why an asserted URL is still checked.
  const parked = 'This domain is for sale. Buy now. Premium domains at great prices.';
  const v = os.verifyPage('The Joseph Rainey Center for Public Policy', parked);
  ok(v.ok === false, 'CRITICAL: a parked domain does NOT verify, even though the URL was asserted');
  ok(/does not name/.test(v.why), 'and it says why');
}
{
  // The wrong organisation entirely — the failure that would attach a real org's facts to a stranger.
  const other = 'The Brennan Center for Justice is a nonpartisan law and policy institute.';
  ok(os.verifyPage('The Joseph Rainey Center for Public Policy', other).ok === false,
    'CRITICAL: a DIFFERENT think tank does not verify — "Center" and "policy" alone must not carry it');
}
{
  // A short name has nothing to spare, so it must match fully.
  ok(os.verifyPage('Electrify America', 'Electrify America operates EV charging stations.').ok === true, 'a short name matching fully verifies');
  ok(os.verifyPage('Electrify America', 'Electrify Everything is a climate campaign.').ok === false,
    'CRITICAL: a two-token name must match BOTH — a partial hit on a short name is a coincidence');
}
{
  // A REAL homepage — which is not one line. It carries the short mark in the masthead and the legal
  // name in the about/footer, which is how a long formal name clears the majority rule.
  const homepage = `Rainey Center — our policy team works on energy, technology and criminal justice.
    About: The Joseph Rainey Center for Public Policy is a 501(c)(3) named for Joseph Hayne Rainey.
    Our public policy programs convene stakeholders across the aisle.`;
  ok(os.verifyPage('The Joseph Rainey Center for Public Policy', homepage).ok === true,
    'a real homepage carrying both the short mark and the legal name verifies');

  // …and the THIN version is refused, which is the trade-off stated plainly. A masthead alone gives
  // 2 of 4 distinctive tokens, and that is genuinely weak: loosening the ratio far enough to accept it
  // is the same loosening that would let "The Brennan Center for Justice" through. A refused page
  // costs a fetch we can retry; a false accept poisons the origin of everything downstream.
  const v = os.verifyPage('The Joseph Rainey Center for Public Policy',
    'Rainey Center — our policy team works on energy, technology and criminal justice.');
  ok(v.ok === false && v.ratio === 0.5,
    'CRITICAL: a bare masthead line is REFUSED (2/4 tokens) — we retry a fetch rather than risk a wrong origin');
}
ok(os.verifyPage('X Org', '').ok === false && os.verifyPage('', 'anything').ok === false, 'empty page or empty name → not verified');

// ── THE DOMAIN AND THE TEXT MUST AGREE — the rule the REAL site forced ───────────────────────────
// A token ratio over the full formal name refused the live raineycenter.org homepage: it reads
// "Rainey Center Policy Polling News…" and contains neither "Joseph" nor "public", scoring 2/4. The
// identifying token is "rainey", and it appears in a second independent place — the hostname.
{
  const realHome = 'Rainey Center Policy Polling News National Summit LAMP About Us Team Contact Careers Donate Building a more perfect union';
  const v = os.verifyPage('The Joseph Rainey Center for Public Policy', realHome, { url: 'https://www.raineycenter.org/' });
  ok(v.ok === true && v.hostAgrees.includes('rainey'),
    'CRITICAL: the live homepage verifies because the DOMAIN and the PAGE agree on "rainey"');
  ok(v.ratio === 0.5, '…even though the formal-name ratio alone would have refused it');
}
{
  // Parked domain on the RIGHT hostname — the domain agrees with itself, but the page says nothing.
  const v = os.verifyPage('The Joseph Rainey Center for Public Policy', 'This domain is for sale. Premium domains.', { url: 'https://www.raineycenter.org/' });
  ok(v.ok === false,
    'CRITICAL: a PARKED raineycenter.org still fails — agreement requires the token in the PAGE, not just the URL');
}
{
  // The wrong organisation at its own legitimate domain.
  const v = os.verifyPage('The Joseph Rainey Center for Public Policy',
    'The Brennan Center for Justice is a nonpartisan law and policy institute.', { url: 'https://www.brennancenter.org/' });
  ok(v.ok === false, 'CRITICAL: brennancenter.org does not verify as the Rainey Center — no shared identifying token');
}
{
  // An acronym domain says nothing, so the ratio rule still has to carry it on its own.
  const full = 'The Joseph Rainey Center for Public Policy is a 501(c)(3). Our public policy programs…';
  ok(os.verifyPage('The Joseph Rainey Center for Public Policy', full, { url: 'https://tjrcpp.org/' }).ok === true,
    'an acronym domain falls back to the token ratio — the hostname cannot always speak');
}
ok(os.verifyPage('X Org', 'text', { url: 'not a url' }).ok === false, 'a malformed url degrades to the ratio rule, never throws');

// ── authority: a self-published page is a primary source, not a register ─────────────────────────
ok(os.selfSiteAuthority() === 'ordinary',
  'CRITICAL: an org’s own site is `ordinary`, not `official` — one interested party talking about itself must not settle a claim alone');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
