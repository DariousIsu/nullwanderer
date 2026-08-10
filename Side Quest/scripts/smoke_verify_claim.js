'use strict';
/* smoke_verify_claim.js — Spine 2 step 5 bounded verify (lib/verify_claim.js).
 * The load-bearing case: the Cleco confab "Cleco was acquired by Stonepeak" — a quick search returns
 * nothing corroborating (0 hits) → verdict 'uncorroborated' → Zoe posts an honest correction beat.
 * Pure judgment + injected search; no browser, no network. Run: node scripts/smoke_verify_claim.js */
const v = require('../lib/verify_claim');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ── buildFactQuery ──────────────────────────────────────────────────────────────────────────────────────
ok(v.buildFactQuery('Cleco was acquired by Stonepeak.', ['Stonepeak']).includes('Stonepeak'), 'query carries the claim + the specifics');
ok(v.buildFactQuery('And so it was acquired by X.', []).startsWith('it') || !/^and so/i.test(v.buildFactQuery('And so it was acquired by X.', [])), 'query strips a leading filler conjunction');
{
  const q = v.buildFactQuery('Cleco merged with a firm.', ['Bernhard Capital']);
  ok(q.toLowerCase().includes('bernhard capital'), 'a novel term missing from the claim text is appended to the query');
}

// ── judgeFact: the Cleco confab (no corroboration) vs a real, corroborated event ────────────────────────
{
  const empty = v.judgeFact(['Stonepeak', 'Bernhard Capital'], []);
  ok(empty.verdict === 'uncorroborated', 'no SERP results → uncorroborated (the Cleco 0-hits signature)');
}
{
  const unrelated = v.judgeFact(['Stonepeak', 'Bernhard Capital'], [
    { title: 'Cleco Power rate case 2025', snippet: 'Louisiana regulators reviewed Cleco outage reports.' },
    { title: 'Cleco storm response', snippet: 'Crews restored power across the parish.' },
  ]);
  ok(unrelated.verdict === 'uncorroborated', 'results that never mention the acquirers → uncorroborated (the confab is not confirmed)');
}
{
  const real = v.judgeFact(['Stonepeak', 'Bernhard Capital'], [
    { title: 'Stonepeak and Bernhard Capital to acquire Cleco', snippet: 'The deal values Cleco...' },
  ]);
  ok(real.verdict === 'corroborated', 'results naming both specifics → corroborated');
}
ok(v.judgeFact([], [{ title: 'x', snippet: 'y' }]).verdict === 'uncorroborated', 'no distinguishing terms → uncorroborated (nothing specific to confirm)');

// ── followupText: honest in both directions, names the claim ────────────────────────────────────────────
{
  const corr = v.followupText('Cleco was acquired by Stonepeak', 'corroborated', { userName: 'Lucas' });
  ok(/corroborate|confirm/i.test(corr) && /Lucas/.test(corr), 'corroborated follow-up confirms, addressed to the user');
  const unc = v.followupText('Cleco was acquired by Stonepeak', 'uncorroborated', { userName: 'Lucas' });
  ok(/couldn'?t corroborate|unverified/i.test(unc) && /Cleco/.test(unc), 'uncorroborated follow-up owns it + names the claim + marks it unverified');
  ok(!/false|wrong|incorrect/i.test(unc), 'uncorroborated follow-up never asserts the claim is FALSE (absence of evidence ≠ contradiction)');
}

// ── verifyFact orchestrator: injected search, timeout + error are fail-SOFT (skip, no follow-up) ─────────
(async () => {
  const okSearch = async (q) => ({ results: [{ title: 'Stonepeak and Bernhard Capital acquire Cleco', snippet: 'deal' }] });
  const nullSearch = async (q) => ({ results: [] });
  const r1 = await v.verifyFact('Cleco was acquired by Stonepeak', ['Stonepeak', 'Bernhard Capital'], { search: okSearch });
  ok(r1.verdict === 'corroborated', 'verifyFact: a corroborating search → corroborated');
  const r2 = await v.verifyFact('Cleco was acquired by Stonepeak', ['Stonepeak', 'Bernhard Capital'], { search: nullSearch });
  ok(r2.verdict === 'uncorroborated', 'verifyFact: an empty search → uncorroborated (the Cleco case end-to-end)');
  const r3 = await v.verifyFact('X was acquired by Y', ['Y'], { search: () => new Promise((res) => setTimeout(() => res({ results: [] }), 200)), timeoutMs: 20 });
  ok(r3.verdict === 'skip' && r3.reason === 'timeout', 'verifyFact: a slow search is abandoned at the timeout → skip (never harms the reply)');
  const r4 = await v.verifyFact('X was acquired by Y', ['Y'], { search: () => { throw new Error('browser dead'); } });
  ok(r4.verdict === 'skip', 'verifyFact: a search that throws → skip (fail-soft, no follow-up on a hiccup)');
  const r5 = await v.verifyFact('X was acquired by Y', ['Y'], {});
  ok(r5.verdict === 'skip', 'verifyFact: no search instrument injected → skip');

  // ── ABSENCE ACTIVE-SEARCH (step 6): the §7.1 cure — actually find the email she called blank ──────────────
  ok(v.buildAbsenceQuery('I couldn\'t find an email for Mayor Arceneaux.').toLowerCase().includes('arceneaux'), 'absence query: subject pulled from the claim (Arceneaux), title dropped');
  ok(v.buildAbsenceQuery('No email is listed for him.', 'We were discussing Tom Arceneaux, the Shreveport mayor.').toLowerCase().includes('tom arceneaux'), 'absence query: no subject in claim → pulled from context (Tom Arceneaux)');
  ok(/email/i.test(v.buildAbsenceQuery('I couldn\'t find an email for Mayor Arceneaux.')), 'absence query: includes the email record-noun');
  ok(v.extractEmails([{ title: 'Contact', snippet: 'Reach the mayor at mayor@shreveportla.gov today.' }])[0] === 'mayor@shreveportla.gov', 'extractEmails: pulls a real address from a snippet');
  ok(v.extractEmails([{ snippet: 'e.g. name@example.com or noreply@wixpress.com' }]).length === 0, 'extractEmails: discards placeholders (example/noreply/wixpress)');
  {
    const foundSearch = async () => ({ results: [{ title: 'Shreveport Mayor', snippet: 'Office of the Mayor — mayor@shreveportla.gov' }] });
    const emptySearch = async () => ({ results: [{ title: 'Shreveport', snippet: 'City news and events.' }] });
    const rf = await v.verifyAbsence("I couldn't find an email for Mayor Arceneaux.", { search: foundSearch });
    ok(rf.verdict === 'found' && rf.value === 'mayor@shreveportla.gov', 'verifyAbsence: FOUND surfaces the email she wrongly called blank (§7.1 cure)');
    const rn = await v.verifyAbsence("I couldn't find an email for Mayor Arceneaux.", { search: emptySearch });
    ok(rn.verdict === 'not-found', 'verifyAbsence: NOT-FOUND when the search surfaces no address (honest blank)');
    const rs = await v.verifyAbsence('I couldn\'t find his phone number.', { search: foundSearch });
    ok(rs.verdict === 'skip' && rs.reason === 'not-email', 'verifyAbsence: a non-email absence → skip (confession stands)');
    const rt = await v.verifyAbsence("I couldn't find an email for Mayor Arceneaux.", { search: () => new Promise((res) => setTimeout(() => res({ results: [] }), 200)), timeoutMs: 20 });
    ok(rt.verdict === 'skip' && rt.reason === 'timeout', 'verifyAbsence: slow search abandoned at timeout → skip (fail-soft)');
    const re = await v.verifyAbsence("I couldn't find an email for Mayor Arceneaux.", { search: () => { throw new Error('dead'); } });
    ok(re.verdict === 'skip', 'verifyAbsence: search throws → skip (no follow-up on a hiccup)');
  }
  ok(/mayor@shreveportla\.gov/.test(v.absenceFollowupText('found', 'mayor@shreveportla.gov', { userName: 'Lucas' })), 'absenceFollowupText: FOUND surfaces the address');
  ok(/honest|couldn'?t/i.test(v.absenceFollowupText('not-found', null, { userName: 'Lucas' })), 'absenceFollowupText: NOT-FOUND confirms the blank is honest');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
