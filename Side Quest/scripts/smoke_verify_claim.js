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

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
