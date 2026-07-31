/* Smoke: lib/tier_gate — what may cross into a DELIVERABLE (methodology parity, S2).
 *
 * Tier 1 leads, Tier 2 carries its condition, Tier 3 never reaches a draft "including the flattering
 * ones". This gates DRAFTS, not memory — her store deliberately keeps weak claims to prove-or-fade,
 * and nothing here touches it.
 *
 * Pure: no model/file/db/network. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_tier_gate.js
 */
'use strict';
const tg = require('../lib/tier_gate');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// --- load-bearing: a figure or a quotation, not every clause ------------------------------------
ok(tg.isLoadBearing('Transmission fell to 55 miles in 2023.'), 'a figure is load-bearing');
ok(tg.isLoadBearing('Costs rose 63% last year.'), 'a percentage is load-bearing');
ok(tg.isLoadBearing('Meta committed $58 million in grants.'), 'a dollar amount is load-bearing');
ok(tg.isLoadBearing('The report said "no additional transmission buildout was required through 2030".'), 'a quotation is load-bearing');
ok(!tg.isLoadBearing('The grid is aging and under strain.'), '⭐ prose with no figure or quote is an ARGUMENT, not a citable fact');
ok(!tg.isLoadBearing('There are 3 reasons this matters.'), 'a bare small integer is not a figure — the gate must not become noise');

// --- headings and code are not claims ----------------------------------------------------------
ok(tg.sentences('# 2023 numbers\n\ntext here.').length === 1, 'headings are skipped');
ok(tg.sentences('```\nSELECT 500 FROM x\n```').length === 0, 'code fences are skipped');

// --- RULE A: an uncited figure is Tier 3 -------------------------------------------------------
{
  const r = tg.checkDraft({ markdown: 'High-voltage transmission fell from nearly 4,000 miles in 2013 to 55 in 2023.' });
  ok(r.ok === false && r.violations.length === 1, 'an uncited figure is a violation');
  ok(r.violations[0].tier === tg.TIER.EXCLUDED && r.violations[0].rule === 'uncited', '⭐ it is TIER 3 — must not print until confirmed');
  ok(/do not publish/i.test(r.violations[0].why), 'and it says what to do about it');
}
{
  const r = tg.checkDraft({ markdown: 'Transmission fell to 55 miles in 2023 (source: https://gridstrategies.com/report).' });
  ok(r.ok === true && r.counts.loadBearing === 1, 'the same figure WITH a source passes');
}
{
  const r = tg.checkDraft({ markdown: 'The grid is aging badly and needs rebuilding.' });
  ok(r.ok === true && r.counts.loadBearing === 0, 'unsourced ARGUMENT is fine — only facts need sources');
}

// --- RULE B: an interested source must be named in the sentence --------------------------------
{
  const md = 'Community grants totalled $58 million last year (source: https://about.meta.com/news/grants).';
  const bare = tg.checkDraft({ markdown: md });
  ok(bare.ok === true, 'without a subject, rule B cannot run and does not guess');

  const r = tg.checkDraft({ markdown: md, subject: 'Meta Platforms' });
  ok(r.ok === false && r.violations[0].rule === 'unattributed', '⭐ a company figure from the company\'s own site must be attributed in print');
  ok(r.violations[0].tier === tg.TIER.CONDITIONAL, 'that is TIER 2 — usable, but only with its condition attached');

  const named = tg.checkDraft({ markdown: 'Meta reports community grants totalling $58 million (source: https://about.meta.com/news/grants).', subject: 'Meta Platforms' });
  ok(named.ok === true, '⭐ …and naming the party in the sentence satisfies it');
}
{
  // independent source → no attribution requirement
  const r = tg.checkDraft({ markdown: 'Generation capacity rose 12,000 MW (source: https://www.eia.gov/electricity).', subject: 'Meta Platforms' });
  ok(r.ok === true, 'an independent record needs no attribution caveat');
}
{
  // stake unknown must NOT be treated as Tier 3 — that would reject nearly every real citation
  const r = tg.checkDraft({ markdown: 'Prices rose 63% (source: https://www.nytimes.com/2024/grid.html).', subject: 'Meta Platforms' });
  ok(r.ok === true, '⭐ an outlet at stake=unknown is CITED, not excluded — Tier 3 means UNCITED');
}
{
  // her own non-URL citation forms are not stake questions
  const r = tg.checkDraft({ markdown: 'The lab holds 4,000 GPUs (source: held doc:118).', subject: 'Meta Platforms' });
  ok(r.ok === true, 'a held-document citation is a source, not an interest question');
}

// --- reporting shape ---------------------------------------------------------------------------
{
  const r = tg.checkDraft({
    markdown: [
      'Transmission fell to 55 miles in 2023.',
      'Grants reached $58 million (source: https://about.meta.com/news/grants).',
      'The system is under strain.',
    ].join('\n'),
    subject: 'Meta Platforms',
  });
  ok(r.counts.loadBearing === 2 && r.counts.uncited === 1 && r.counts.unattributed === 1, 'counts separate the two failure modes');
  ok(/Tier 3, must not print/.test(r.summary), 'the summary leads with what cannot be printed');
  ok(r.violations.every((v) => v.sentence && v.sentence.length), 'every violation quotes the offending sentence');
}
ok(tg.checkDraft({}).ok === true, 'an empty draft is vacuously clean, never a throw');
ok(tg.checkDraft({ markdown: null, subject: null }).ok === true, 'null input degrades quietly');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
