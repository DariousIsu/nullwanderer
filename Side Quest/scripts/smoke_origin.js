/* smoke_origin.js — origin capture + the independence formula.
 *
 * Blockers #1 and #2 from docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md. The load-bearing tests are the ones
 * where independence is CORRECTLY LOWERED: over-counting independence inflates grades, and an inflated
 * grade is worse than a missing one because it looks rigorous.
 */
'use strict';
const og = require('../lib/origin');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ── host: the independence key ─────────────────────────────────────────────────────────────────
ok(og.hostOf('https://www.legis.la.gov/roster') === 'legis.la.gov', 'www is not a different publisher');
ok(og.hostOf('https://LEGIS.LA.GOV/x') === 'legis.la.gov', 'host is case-insensitive');
ok(og.hostOf('ftp://legis.la.gov') === null, 'non-http scheme → null');
ok(og.hostOf('not a url') === null && og.hostOf('') === null && og.hostOf(null) === null,
  'garbage/empty/null → null, never throws');

// ── url normalisation: one page must not read as several origins ───────────────────────────────
ok(og.normalizeUrl('https://x.gov/a?utm_source=twitter&id=7') === 'https://x.gov/a?id=7',
  'CRITICAL: tracking params stripped, meaningful ones kept');
ok(og.normalizeUrl('https://x.gov/a#section') === 'https://x.gov/a', 'fragment dropped');
ok(og.normalizeUrl('https://x.gov/a/') === 'https://x.gov/a', 'trailing slash normalised');
ok(og.normalizeUrl('https://x.gov/a?b=2&a=1') === og.normalizeUrl('https://x.gov/a?a=1&b=2'),
  'CRITICAL: query order does not create a second origin');
ok(og.normalizeUrl('https://x.gov/') === 'https://x.gov/', 'root path keeps its slash');
ok(og.normalizeUrl('') === null && og.normalizeUrl(null) === null, 'empty/null → null');

// ── content hash: text identity ────────────────────────────────────────────────────────────────
ok(og.contentHash('Hello  World') === og.contentHash('hello world'),
  'whitespace + case normalised — a re-save must not read as a second independent text');
ok(og.contentHash('a') !== og.contentHash('b'), 'different text → different hash');
ok(og.contentHash('') === null && og.contentHash(null) === null, 'empty → null (not a hash of nothing)');

// ── THE FORMULA — min(distinct origins, distinct texts) ────────────────────────────────────────
{
  const h = og.contentHash;
  // The measured corpus case: one document stored 18 times = ONE source, not eighteen.
  const dup = Array.from({ length: 18 }, () => ({ origin_host: 'x.gov', content_hash: h('same body') }));
  const r1 = og.independence(dup);
  ok(r1.count === 1, `CRITICAL: 18 copies of one document = 1 (got ${r1.count})`);

  // Syndication: ten outlets carrying one wire story.
  const wire = ['a.com', 'b.com', 'c.com', 'd.com', 'e.com'].map((o) => ({ origin_host: o, content_hash: h('one wire story') }));
  const r2 = og.independence(wire);
  ok(r2.count === 1 && r2.syndicated === true,
    `CRITICAL: 5 outlets, 1 text = 1 and flagged syndicated (got ${r2.count})`);

  // Repetition: one site publishing five different pages saying it.
  const spam = ['t1', 't2', 't3', 't4', 't5'].map((t) => ({ origin_host: 'x.gov', content_hash: h(t) }));
  const r3 = og.independence(spam);
  ok(r3.count === 1 && r3.repeated === true,
    `CRITICAL: 1 site, 5 texts = 1 and flagged repeated (got ${r3.count})`);

  // The genuine article: three different publishers, three different texts.
  const real = [['a.gov', 't1'], ['b.org', 't2'], ['c.com', 't3']].map(([o, t]) => ({ origin_host: o, content_hash: h(t) }));
  ok(og.independence(real).count === 3, 'THE PAYOFF: 3 distinct origins with 3 distinct texts = 3 → grade A');

  // Mixed: the real three plus 18 duplicate copies must still be 3-ish, not 21.
  const mixed = real.concat(dup);
  ok(og.independence(mixed).count === 4, `duplicates cannot inflate a genuine count (got ${og.independence(mixed).count}, expected 4)`);

  // UNKNOWN PROVENANCE — the case that broke this on real data. Most of the legacy corpus has a
  // content hash but NO origin. Reporting 0 would grade three genuinely distinct documents as no
  // evidence at all; reporting 3 would invent independence they might not have.
  const legacy = ['t1', 't2', 't3'].map((t) => ({ origin_host: null, content_hash: h(t) }));
  const rl = og.independence(legacy);
  ok(rl.count === 1, `CRITICAL: 3 distinct texts, unknown origins = 1 (floor, not zero) — got ${rl.count}`);
  ok(rl.unproven === true, 'flagged unproven: held down by missing provenance, not by real duplication');
  ok(og.independence([{}, {}, {}]).count === 1,
    'CRITICAL: items with neither origin nor hash collapse to ONE — they could all be the same source');
  // Capturing real origins can only RAISE the count from that floor.
  const upgraded = [['a.gov', 't1'], ['b.org', 't2'], ['c.com', 't3']].map(([o, t]) => ({ origin_host: o, content_hash: h(t) }));
  ok(og.independence(upgraded).count === 3 && og.independence(upgraded).unproven === false,
    'the same three documents WITH origins captured = 3, no longer unproven');
  ok(og.independence([]).count === 0 && og.independence(null).count === 0, 'empty/null → 0, never throws');
  ok(og.independence([{ origin: 'https://www.x.gov/a' }]).origins === 1, 'raw origin URL is resolved to a host');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
