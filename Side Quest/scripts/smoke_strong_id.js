/* smoke_strong_id.js — T2: a strong id pulls a bare name IN (docs/OBJECT_TYPE_AND_IDENTITY_DESIGN.md §6).
 *
 * The load-bearing tests here are the REFUSALS. This planner proposes merges against a live graph, and a
 * false merge is the one failure this system treats as unrecoverable — "Andrew Johnson" the bare mention
 * is not the president just because a row tagged [J000116] shares the string.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_strong_id.js
 */
'use strict';
const si = require('../lib/strong_id');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const row = (id, name, type = 'concept', degree = 0) => ({ id, name, entity_type: type, degree });

// ── parsing: the bare key is what makes the two rows comparable at all ───────────────────────────
{
  const d = si.describe(row(1, 'Duke Energy [Q1264404]'));
  ok(d.bareKey === 'duke energy', 'the bracket tag is stripped to reach the bare name');
  ok(d.hasId && d.ids.wikidata === 'Q1264404', 'the strong id is parsed off the label');
  ok(si.describe(row(2, 'Duke Energy')).bareKey === d.bareKey, 'CRITICAL: tagged and untagged rows share one bare key, or nothing can ever bind them');
}

// ── the payoff: an org binds to its id-bearing twin ──────────────────────────────────────────────
{
  const p = si.planMerges([row(1, 'Duke Energy'), row(2, 'Duke Energy [Q1264404]')]);
  ok(p.merges.length === 1 && p.review.length === 0, 'the live Duke Energy pair produces exactly one merge');
  ok(p.merges[0].from === 1 && p.merges[0].into === 2,
    'CRITICAL: the BARE row is absorbed INTO the id-bearing one — the id is what can be checked against a register');
}

// ── Tier-1: the same id under two rows is deterministic ──────────────────────────────────────────
{
  const p = si.planMerges([row(1, 'Microsoft [Q2283]', 'concept', 3), row(2, 'Microsoft Corp [Q2283]', 'concept', 9)]);
  ok(p.merges.length === 1 && p.merges[0].tier === 'strong-id', 'a shared strong id merges even when the names differ');
  ok(p.merges[0].into === 2, 'the higher-degree row survives, so the plan does not depend on input order');
  const rev = si.planMerges([row(2, 'Microsoft Corp [Q2283]', 'concept', 9), row(1, 'Microsoft [Q2283]', 'concept', 3)]);
  ok(rev.merges[0].into === 2 && rev.merges[0].from === 1, 'CRITICAL: order-independent — reversing the population gives the same plan');
}

// ── THE REFUSALS ─────────────────────────────────────────────────────────────────────────────────
{
  // A person id. "Andrew Johnson" bare is a name millions of people have; [J000116] is one president.
  const p = si.planMerges([row(1, 'Andrew Johnson'), row(2, 'Andrew Johnson [J000116]')]);
  ok(p.merges.length === 0 && p.review.length === 1,
    'CRITICAL: a bare PERSONAL name is never auto-merged into a person id — this is the Howell/Tracy failure');
  ok(/person id/.test(p.review[0].reason), 'and it says why, so a human can adjudicate it');
}
ok(si.isPersonId({ bioguide: 'N000116' }) && si.isPersonId({ ocd: 'ocd-person/abc' }) && si.isPersonId({ fec: 'H4CA22120' }),
  'bioguide / ocd-person / FEC candidate ids identify a person BY CONSTRUCTION, not by name shape');
ok(!si.isPersonId({ fec: 'C0001234' }) && !si.isPersonId({ wikidata: 'Q2283' }),
  'an FEC COMMITTEE id and a bare QID do not — a QID can be anything, which is why it needs the other gates');
{
  // The anti-fan rule: two tagged twins means the bare mentions are ambiguous by construction.
  const p = si.planMerges([row(1, 'Jefferson'), row(2, 'Jefferson [Q1]'), row(3, 'Jefferson [Q2]')]);
  ok(p.merges.length === 0 && /2 id-bearing twins/.test(p.review[0].reason),
    'CRITICAL: a bare name with TWO id-bearing twins is held, never fanned onto both');
}
{
  // The attractor tell — degree. A bare node with many edges has probably eaten several referents.
  const p = si.planMerges([row(1, 'Tracy Institute', 'concept', 40), row(2, 'Tracy Institute [Q9]')]);
  ok(p.merges.length === 0 && /degree 40/.test(p.review[0].reason),
    'CRITICAL: a high-degree bare node needs a SPLIT, not a merge — merging it fuses strangers');
  ok(si.planMerges([row(1, 'Tracy Institute', 'concept', 2), row(2, 'Tracy Institute [Q9]')]).merges.length === 1,
    'the same pair at low degree is a fragment, and does merge');
  ok(/degree/.test(si.planMerges([row(1, 'Tracy', 'concept', 40), row(2, 'Tracy [Q9]')]).review[0].reason),
    'degree is reported ahead of the kind gate — an attractor needing a SPLIT is the more serious finding');
}
{
  // THE QID GATE. A bioguide code says "person"; a QID says nothing. The first cut of this module held
  // bioguide people and merged `Ron DeSantis` → `Ron DeSantis [wd:Q3105215]` — the same risk, different
  // id scheme. A QID pair now needs positive evidence that it is an institution.
  const person = si.planMerges([row(1, 'Woodrow Wilson'), row(2, 'Woodrow Wilson [wd:Q34296]')]);
  ok(person.merges.length === 0 && /does not say what kind of thing/.test(person.review[0].reason),
    'CRITICAL: a bare QID on a personal name is HELD — the id cannot tell a president from a utility');
  const org = si.planMerges([row(1, 'Duke Energy'), row(2, 'Duke Energy [Q1264404]')]);
  ok(org.merges.length === 1, 'an institutional marker in the name permits the merge');
  ok(si.looksInstitutional('George Mason University') && si.looksInstitutional('State of California')
    && si.looksInstitutional('Johnson & Johnson Inc') && !si.looksInstitutional('Robert Bacon'),
    'the marker recognises institutions and does not fire on a plain personal name');
  // The live plan caught this and the suite had not: `n\.?a` matched Bren-NA, A-NNA, Ro-NA-ld, so four
  // people were queued to merge by a gate built to hold them. Short markers need word boundaries.
  for (const n of ['Tonje Brenna', 'Anna Morton', 'Ronald Reagan', 'Janna Lou Little Boren', 'Vincent Price', 'Princeton Reeves']) {
    ok(!si.looksInstitutional(n), `CRITICAL: the marker does not fire mid-word on "${n}"`);
  }
  ok(si.planMerges([row(1, 'Ronald Reagan'), row(2, 'Ronald Reagan [Q9960]')]).merges.length === 0,
    'CRITICAL: Ronald Reagan is held, not merged — the bare name is not provably the president');
  // The gate PERMITS; it never asserts. An lda id already says "organisation", so no marker is needed.
  ok(si.planMerges([row(1, 'Anthropic'), row(2, 'Anthropic [lda_client:66450]')]).merges.length === 1,
    'an id scheme that already identifies the KIND does not need the name marker at all');
}
{
  // A type disagreement is evidence about what the thing IS, which is T3's job, not a merge decision.
  const p = si.planMerges([row(1, 'Fulton County', 'place'), row(2, 'Fulton County [Q486398]', 'gov')]);
  ok(p.merges.length === 0 && /type differs/.test(p.review[0].reason),
    'CRITICAL: rows disagreeing on type are held for T3 — merging across types is what O2 forbids');
}

// ── nothing to do, and garbage ───────────────────────────────────────────────────────────────────
ok(si.planMerges([row(1, 'Duke Energy'), row(2, 'Microsoft [Q2283]')]).merges.length === 0, 'unrelated rows produce no merge');
ok(si.planMerges([row(1, 'Duke Energy'), row(2, 'Duke Energy')]).merges.length === 0,
  'two BARE rows are not merged here — with no id there is no evidence, and that is identity_dedup’s lane');
{
  const p = si.planMerges([]);
  ok(p.merges.length === 0 && p.review.length === 0 && p.stats.population === 0, 'an empty population is not an error');
}
ok(si.planMerges(null).merges.length === 0 && si.planMerges([{}, { id: 1 }]).merges.length === 0, 'garbage in → no plan, never throws');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
