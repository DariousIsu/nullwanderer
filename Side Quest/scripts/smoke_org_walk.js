/* Smoke: the ORG research MOVE (lib/org_walk) + the org WORKLIST (puller_db.listOrgTargets).
 * The move is pure + dep-injected (no network, no model); listOrgTargets uses an in-memory puller.db.
 * See docs/ORG_RESEARCH_LANE.md.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/smoke_org_walk.js
 */
'use strict';
const ow = require('../lib/org_walk');
const pdb = require('../lib/puller_db');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

function makeEnv() {
  const meta = new Map();
  return { getMeta: (k) => (meta.has(k) ? meta.get(k) : null), setMeta: (k, v) => meta.set(k, String(v)), meta };
}
let CLOCK = 1_000_000_000;
const now = () => CLOCK;

// A page that NAMES the org (verifyPage passes on the "rainey" token, agreeing with the host) vs one
// that does not name it at all.
const RAINEY_PAGE = 'Rainey Center — policy, polling, and public affairs. The Rainey Center advances pragmatic reform.';
const WRONG_PAGE = 'Welcome to Acme Widgets, the leading supplier of industrial widgets since 1971.';

(async () => {
  console.log('Offline — ORG research move + worklist\n');

  // ---- 1. HAPPY PATH: register url → verify → land → mark researched → 24h cooldown ----
  {
    const env = makeEnv();
    const landed = [], researched = [], fetched = [];
    const target = { id: 7, name: 'Rainey Center', domain: 'raineycenter.org', crm_id: 55, status: 'promoted',
      urlCandidates: [{ url: 'https://raineycenter.org', provenance: 'register' }] };
    const r = await ow.runOrgMove({
      candidates: [target], getMeta: env.getMeta, setMeta: env.setMeta, now,
      fetchPage: async (u) => { fetched.push(u); return { text: RAINEY_PAGE, status: 200 }; },
      land: async (o) => { landed.push(o); return 4242; },
      markResearched: async (t, url, docId) => { researched.push({ id: t.id, url, docId }); },
    });
    ok(r.ok && r.did && r.docId === 4242, 'happy: researched → did=true, docId returned');
    ok(fetched.length === 1 && fetched[0] === 'https://raineycenter.org', 'happy: fetched the register url');
    ok(landed.length === 1 && landed[0].url === 'https://raineycenter.org' && landed[0].provenance === 'register',
      'happy: landed with the url + provenance (decompose lane does the extraction)');
    ok(researched.length === 1 && researched[0].docId === 4242, 'happy: markResearched called with the doc');

    // cooldown: the SAME candidate is skipped for 24h (ok TTL), outlasting the 3h barren TTL
    const cooled = async () => ow.runOrgMove({ candidates: [target], getMeta: env.getMeta, setMeta: env.setMeta, now,
      fetchPage: async () => { throw new Error('should not fetch a cooled org'); }, land: async () => 1, markResearched: async () => {} });
    ok((await cooled()).did === false, 'happy: same org on cooldown → not re-attempted');
    CLOCK += ow.ATTEMPT_TTL_MS.barren + 1000;                        // barren would have expired; ok (24h) has not
    ok((await cooled()).did === false, 'happy: still cooled after the 3h barren TTL elapses (24h ok-TTL holds)');
    CLOCK = 1_000_000_000;
  }

  // ---- 2. NO PROVENANCE / GUESSED url → inadmissible, never fetched ----
  {
    const env = makeEnv();
    let fetchedAny = false;
    const target = { id: 8, name: 'Cato Institute', urlCandidates: [{ url: 'https://cato.org', provenance: 'guess' }] };
    const r = await ow.runOrgMove({ candidates: [target], getMeta: env.getMeta, setMeta: env.setMeta, now,
      fetchPage: async () => { fetchedAny = true; return { text: 'x' }; }, land: async () => 1, markResearched: async () => {} });
    ok(r.did === false, 'no-prov: a guessed-provenance url is inadmissible → not researched (NO DOMAIN GUESSING)');
    ok(fetchedAny === false, 'no-prov: never fetched a guessed url');
  }

  // ---- 3. asserted url but page does NOT name the org → verify refused, no land, 3h barren cooldown ----
  {
    const env = makeEnv();
    const landed = [];
    const target = { id: 9, name: 'Rainey Center', domain: 'raineycenter.org',
      urlCandidates: [{ url: 'https://raineycenter.org', provenance: 'operator' }] };
    const r = await ow.runOrgMove({ candidates: [target], getMeta: env.getMeta, setMeta: env.setMeta, now,
      fetchPage: async () => ({ text: WRONG_PAGE, status: 200 }), land: async (o) => { landed.push(o); return 1; }, markResearched: async () => {} });
    ok(r.did === false && /verify failed/.test(r.note || ''), 'verify: a page that does not name the org is refused');
    ok(landed.length === 0, 'verify: nothing landed on a verify refusal');
    CLOCK += ow.ATTEMPT_TTL_MS.barren + 1000;
    ok(ow.loadAttempted(env.getMeta, now()).set.size === 0, 'verify: the 3h barren cooldown expired → org retryable (not benched for a day)');
    CLOCK = 1_000_000_000;
  }

  // ---- 4. already-researched candidate (researched:true) → not picked ----
  {
    const env = makeEnv();
    const target = { id: 10, name: 'Cato Institute', researched: true, urlCandidates: [{ url: 'https://cato.org', provenance: 'operator' }] };
    const r = await ow.runOrgMove({ candidates: [target], getMeta: env.getMeta, setMeta: env.setMeta, now,
      fetchPage: async () => { throw new Error('should not fetch a researched org'); }, land: async () => 1, markResearched: async () => {} });
    ok(r.did === false && r.note === 'no workable org target', 'researched: an already-researched org is not picked');
  }

  // ---- 5. pickOrg prefers the CRM-linked org over an adhoc one ----
  {
    const adhoc = { id: 11, name: 'Some Foundation', urlCandidates: [{ url: 'https://a.org', provenance: 'operator' }] };
    const crm = { id: 12, name: 'His Employer Inc', crm_id: 99, urlCandidates: [{ url: 'https://b.org', provenance: 'operator' }] };
    const picked = ow.pickOrg([adhoc, crm], { now: now() });
    ok(picked && picked.id === 12, 'pick: the CRM-linked org outranks the adhoc one');
    // a url-less org is never picked (no admissible source = not workable)
    ok(ow.pickOrg([{ id: 13, name: 'No Url Org', urlCandidates: [] }], { now: now() }) === null, 'pick: a url-less org is not workable');
  }

  // ---- 6. listOrgTargets — org rows needing research, excludes person rows + already-researched orgs ----
  {
    pdb.init({ path: ':memory:' });
    const o1 = pdb.createTarget({ kind: 'org', name: 'Cato Institute' });
    const o2 = pdb.createTarget({ kind: 'org', name: 'Brookings Institution' });
    const person = pdb.createTarget({ kind: 'person', name: 'Jane Doe', company: 'Cleco' });
    let list = pdb.listOrgTargets({ limit: 50 });
    ok(list.length === 2 && list.every((t) => t.kind === 'org'), `worklist: returns only org rows (${list.length})`);
    ok(!list.some((t) => t.id === person.id), 'worklist: the person row is excluded');

    // mark o1 researched via the done-marker belief → it drops out of the worklist
    pdb.upsertBelief(o1.id, 'official_site', { value: 'https://cato.org', confidence: 1, derivation: 'org_research' });
    list = pdb.listOrgTargets({ limit: 50 });
    ok(list.length === 1 && list[0].id === o2.id, 'worklist: an org with an active official_site belief is excluded (done-marker)');

    // CRM-linked orgs sort first
    pdb.createTarget({ kind: 'org', name: 'Heritage Foundation' });
    pdb.promoteTarget(o2.id, 'CRM-ORG-1');
    list = pdb.listOrgTargets({ limit: 50 });
    ok(list[0].id === o2.id, 'worklist: the CRM-linked org sorts first');
    pdb.close();
  }

  // ---- 7. P856 corroboration — a target's person-lane domain becomes admissible iff a register host agrees ----
  {
    const hostMap = new Map([
      ['legislature.maine.gov', 'http://legislature.maine.gov/'],
      ['cato.org', 'cato.org'],
    ]);
    // a domain a P856 account confirms → admissible, provenance 'register', origin = the P856 url
    const c1 = ow.corroborateDomain('legislature.maine.gov', hostMap);
    ok(c1 && c1.provenance === 'register' && /legislature\.maine\.gov/.test(c1.url), 'corrob: a P856-confirmed domain is admissible as register');
    // a bare-domain P856 site is normalised to https:// (scheme added, host given — not a guess)
    const c2 = ow.corroborateDomain('cato.org', hostMap);
    ok(c2 && c2.url === 'https://cato.org', 'corrob: a bare P856 domain is normalised to https://');
    // a domain NO register confirms → refused (never trust a bare person-lane domain)
    ok(ow.corroborateDomain('raineycenter.org', hostMap) === null, 'corrob: an un-confirmed domain is refused (no guessing)');
    ok(ow.corroborateDomain('', hostMap) === null, 'corrob: an empty domain is refused');
    // hostOf normalises www + scheme
    ok(ow.hostOf('https://www.Cato.org/about') === 'cato.org', 'hostOf: strips scheme/www/path, lowercased');
    // end-to-end: a corroborated domain drives runOrgMove to research
    const env = makeEnv();
    let landedUrl = null;
    const target = { id: 20, name: 'Maine Legislature', domain: 'legislature.maine.gov',
      urlCandidates: [ow.corroborateDomain('legislature.maine.gov', hostMap)] };
    const r = await ow.runOrgMove({ candidates: [target], getMeta: env.getMeta, setMeta: env.setMeta, now,
      fetchPage: async () => ({ text: 'The Maine Legislature — the State Legislature of Maine. Bills, sessions, and members.', status: 200 }),
      land: async (o) => { landedUrl = o.url; return 5150; }, markResearched: async () => {} });
    ok(r.did && /legislature\.maine\.gov/.test(landedUrl || ''), 'corrob: a corroborated org is researched end-to-end');
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
