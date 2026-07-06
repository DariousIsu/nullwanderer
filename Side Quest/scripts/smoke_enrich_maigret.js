/* Smoke: lib/enrich_maigret — the PURE safety core of the maigret enrichment leaf.
 * knownHandles (known-handles-only sourcing) + corroborate (require 2+ signals). Fully offline.
 * ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_enrich_maigret.js
 */
'use strict';
const EM = require('../lib/enrich_maigret');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

// --- knownHandles: CRM handle + PERSONAL email localpart; NOT a work-email localpart ---
const kh1 = EM.knownHandles({ name: 'Jane Doe', email: 'jane.doe@ferc.gov' }, [{ platform: 'twitter', handle: 'JaneDoeVA' }]);
ok(kh1.some((h) => h.username === 'janedoeva' && h.source === 'crm'), 'knownHandles: includes the CRM handle (high provenance)');
ok(!kh1.some((h) => h.username === 'jane.doe'), 'knownHandles: does NOT use a WORK-email localpart (ferc.gov)');
const kh2 = EM.knownHandles({ name: 'Jane Doe', email: 'janedoe99@gmail.com' }, []);
ok(kh2.some((h) => h.username === 'janedoe99' && h.source === 'personal-email'), 'knownHandles: uses a PERSONAL-email localpart');
ok(EM.knownHandles({ name: 'X', email: 'press@gmail.com' }, []).length === 0, 'knownHandles: drops role localparts (press@)');
ok(EM.knownHandles({ name: 'No Email' }, []).length === 0, 'knownHandles: no handle sources → empty');

// --- corroborate: require 2+ signals ---
const contact = { name: 'Vince Ille', company: 'North Carolina Athletics' };
// the spike's real false positive: @ille SoundCloud → "Ilirjana Alushaj" (wrong person, no org match) → REJECT
const falsePos = { site: 'SoundCloud', url: 'https://soundcloud.com/ille', ids: { name: 'Ilirjana Alushaj', username: 'Ille' } };
ok(!EM.corroborate(falsePos, contact, { source: 'personal-email' }).corroborated, 'corroborate: REJECTS the @ille false positive (name mismatch, 0 signals)');

// a name match ALONE (1 signal) is NOT enough
const nameOnly = { site: 'Twitter', ids: { name: 'Vince Ille' } };
const c1 = EM.corroborate(nameOnly, contact, { source: 'personal-email' });
ok(!c1.corroborated && c1.signals.includes('name') && c1.score === 1, 'corroborate: name-only (1 signal) is NOT enough');

// name + org (2 signals) → accept
const nameOrg = { site: 'LinkedIn', ids: { name: 'Vince Ille', bio: 'Administrator at North Carolina Athletics' } };
const c2 = EM.corroborate(nameOrg, contact, { source: 'personal-email' });
ok(c2.corroborated && c2.signals.includes('name') && c2.signals.includes('org'), 'corroborate: name + org (2 signals) → ACCEPT');

// name + CRM provenance (2 signals) → accept even without an org mention
const c3 = EM.corroborate({ site: 'Instagram', ids: { name: 'Vince Ille' } }, contact, { source: 'crm' });
ok(c3.corroborated && c3.signals.includes('prov'), 'corroborate: name + CRM provenance → ACCEPT');

// CRM provenance ALONE (no name/org confirmation) is only 1 signal → not enough
ok(!EM.corroborate({ site: 'Instagram', ids: {} }, contact, { source: 'crm' }).corroborated, 'corroborate: CRM provenance alone (1 signal) is NOT enough');

// --- detectSocialEnrich: on-demand trigger ---
ok(EM.detectSocialEnrich('find social handles for Vince Ille').isEnrich === true && EM.detectSocialEnrich('find social handles for Vince Ille').target === 'Vince Ille', 'detectSocialEnrich: "find social handles for Vince Ille" → target');
ok(EM.detectSocialEnrich("look up Brad Overcash's online accounts").target === 'Brad Overcash', 'detectSocialEnrich: possessive form');
ok(!EM.detectSocialEnrich('list our energy contacts').isEnrich, 'detectSocialEnrich: a contacts-list ask is NOT a social-enrich');
ok(!EM.detectSocialEnrich('what is the weather').isEnrich, 'detectSocialEnrich: unrelated → false');

// --- enrichContact: end-to-end with a STUBBED search (offline) ---
(async () => {
  const target = { name: 'Vince Ille', email: 'vinceille@gmail.com', company: 'North Carolina Athletics' };
  // stub returns: one corroborating hit (name+org) + one false positive (wrong name, no org)
  const stub = async (usernames) => ({
    ok: true, results: usernames.map((u) => ({ username: u, accounts: [
      { site: 'LinkedIn', url: `https://linkedin.com/in/${u}`, ids: { name: 'Vince Ille', bio: 'North Carolina Athletics' } },
      { site: 'SoundCloud', url: `https://soundcloud.com/${u}`, ids: { name: 'Ilirjana Alushaj' } },
    ] })),
  });
  const out = await EM.enrichContact(target, [], { search: stub });
  ok(out.handles === 1, 'enrichContact: derived the personal-email handle');
  ok(out.staged.length === 1 && out.staged[0].site === 'LinkedIn' && out.staged[0].grade === 'E', 'enrichContact: stages ONLY the corroborated hit (LinkedIn), drops the false positive, grade E');

  const none = await EM.enrichContact({ name: 'No Handle', email: 'x@ferc.gov' }, [], { search: stub });
  ok(none.staged.length === 0 && none.reason === 'no-known-handles', 'enrichContact: no known handle → nothing searched/staged');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
