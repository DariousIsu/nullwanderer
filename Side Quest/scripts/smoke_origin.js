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

// ── ORIGIN IS THE FIRST HIGH-QUALITY SOURCE ────────────────────────────────────────────────────
// Measured live: three Apache County official records recorded their origin as an S3 bucket. That host
// is where the BYTES were, not who published them — and storing it breaks grading in both directions.
ok(og.isCommodityHost('ecs-cluster-bucket-wsos-prod-two.s3.us-west-2.amazonaws.com'),
  'CRITICAL: the real measured bucket is recognised as infrastructure');
ok(og.isCommodityHost('d1234.cloudfront.net') && og.isCommodityHost('x.blob.core.windows.net')
  && og.isCommodityHost('static.wixstatic.com') && og.isCommodityHost('storage.googleapis.com'),
  'CDNs, object stores and site-builder asset hosts are all infrastructure');
ok(!og.isCommodityHost('apachecountyaz.gov') && !og.isCommodityHost('legis.la.gov')
  && !og.isCommodityHost('nytimes.com'), 'real publishers are NOT infrastructure');
ok(og.isCommodityHost('') === false && og.isCommodityHost(null) === false, 'empty → false, never throws');
{
  // The live case, end to end: bytes on S3, linked from the county's own site.
  const p = og.pickOrigin([
    'https://ecs-cluster-bucket-wsos-prod-two.s3.us-west-2.amazonaws.com/uploads/sites/107/Notary-List.pdf',
    'https://www.apachecountyaz.gov/district-iii',
  ]);
  ok(p.host === 'apachecountyaz.gov',
    `CRITICAL: the PUBLISHER is the origin, not the bucket (got ${p.host})`);
  ok(p.commodity === false, 'a publisher was found, so the origin can carry authority');

  // Why it matters twice over: two DIFFERENT counties on one hosting vendor must not read as one source.
  const a = og.pickOrigin(['https://x.s3.amazonaws.com/sites/107/a.pdf', 'https://apachecountyaz.gov/a']);
  const b = og.pickOrigin(['https://x.s3.amazonaws.com/sites/108/b.pdf', 'https://coconino.az.gov/b']);
  ok(a.host !== b.host && og.independence([
    { origin_host: a.host, content_hash: og.contentHash('one') },
    { origin_host: b.host, content_hash: og.contentHash('two') },
  ]).count === 2, 'CRITICAL: two publishers sharing a hosting vendor still count as TWO sources');

  // No publisher anywhere in the chain: keep the fetch URL, but say so rather than implying authority.
  const only = og.pickOrigin(['https://x.s3.amazonaws.com/a.pdf']);
  ok(only.host === 'x.s3.amazonaws.com' && only.commodity === true,
    'a bare CDN url is retained AND flagged commodity — a weak origin honestly labelled beats none');
  ok(og.pickOrigin([]).origin === null && og.pickOrigin(null).origin === null, 'empty chain → null');
  ok(og.pickOrigin(['not a url', 'https://apachecountyaz.gov/x']).host === 'apachecountyaz.gov',
    'garbage links are skipped, not fatal');
}

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

// ── PLATFORM HOSTS: THE PUBLISHER IS THE CHANNEL ───────────────────────────────────────────────
// Measured after W3: 1,703 news encounters carried origin_host `youtube.com` — closed captions off
// live news channels plus channel RSS. Every channel is an independent publisher and all of them
// collapsed into one origin, so eight channels reporting a story counted as ONE source.
{
  ok(og.isPlatformHost('https://www.youtube.com/watch?v=x') && og.isPlatformHost('substack.com')
    && og.isPlatformHost('rumble.com'), 'platforms are recognised');
  ok(!og.isPlatformHost('nytimes.com') && !og.isPlatformHost('legis.la.gov'), 'ordinary publishers are not platforms');

  // On an ordinary host the publisher name is IGNORED — nytimes.com is nytimes.com whoever wrote it.
  ok(og.platformOrigin('https://www.nytimes.com/2026/x', 'Some Byline') === 'nytimes.com',
    'CRITICAL: a normal host is not split by author — that would fragment one publisher into many');

  // On a platform it is what keeps channels apart.
  const a = og.platformOrigin('https://www.youtube.com/watch?v=1', 'MeidasTouch');
  const b = og.platformOrigin('https://www.youtube.com/watch?v=2', 'David Pakman Show');
  ok(a === 'youtube.com/meidastouch' && b === 'youtube.com/david-pakman-show', 'channel becomes part of the origin');
  ok(a !== b, 'CRITICAL: two channels are two origins');

  // The payoff, with the real measured channels: three channels reporting = three sources, not one.
  const h = og.contentHash;
  const chans = ['ABC News', 'CNN', 'Yahoo Finance'].map((c, i) => ({
    origin_host: og.platformOrigin('https://www.youtube.com/watch?v=' + i, c), content_hash: h(`report ${i}`),
  }));
  ok(og.independence(chans).count === 3,
    `THE PAYOFF: 3 channels = 3 independent sources (was 1 when all read youtube.com) — got ${og.independence(chans).count}`);

  // A URL is not a publisher name. The live feed list carries { url: '…watch?v=gCNeDWCI0vo', title: '' },
  // and that empty title fell through to the URL for 14,422 caption items.
  ok(og.publisherSlug('https://www.youtube.com/watch?v=gCNeDWCI0vo') === null,
    'CRITICAL: a URL is refused as a publisher name, never slugified into nonsense');
  ok(og.platformOrigin('https://www.youtube.com/watch?v=g', 'https://www.youtube.com/watch?v=g') === 'youtube.com',
    '…and falls back to the bare platform, which under-counts rather than inventing an identity');
  ok(og.platformOrigin('https://www.youtube.com/watch?v=g', '') === 'youtube.com', 'an unnamed channel stays at the platform host');
  ok(og.publisherSlug('ABC News') === 'abc-news' && og.publisherSlug('  ') === null, 'slugs normalise; blanks refuse');
  ok(og.platformOrigin('not a url', 'X') === null, 'garbage url → null, never throws');
}

// ── SYNCHRONY IS A FLAG, NOT CORROBORATION (§6.1) ──────────────────────────────────────────────
// independence() catches identical text; it cannot catch ten outlets re-wording one press release
// within the hour. Measured live: of 599 news events reaching 3+ independent sources, 78 published
// inside ONE hour — wire pickups and network republication, not independent confirmation.
{
  const H = 3600 * 1000;
  const burst = [0, 10 * 60 * 1000, 25 * 60 * 1000].map((d) => ({ observed_at: 1700000000000 + d }));
  const s1 = og.synchrony(burst);
  ok(s1.simultaneous === true, 'CRITICAL: 3 sources inside an hour is flagged simultaneous');
  ok(s1.spanMs === 25 * 60 * 1000 && s1.dated === 3, 'it reports the actual span, not just a verdict');

  const spread = [0, 5 * H, 30 * H].map((d) => ({ observed_at: 1700000000000 + d }));
  ok(og.synchrony(spread).simultaneous === false, 'sources spread over days are NOT flagged');

  // Two things landing together is ordinary; a burst needs three.
  ok(og.synchrony([{ observed_at: 1 }, { observed_at: 2 }]).simultaneous === false, 'two is not a burst');

  // It must REPORT, never reduce — a scheduled announcement really is reported by everyone at once,
  // so the independence count stays honest and the caller decides what the flag is worth.
  const h = og.contentHash;
  const real = [['a.com', 't1'], ['b.org', 't2'], ['c.net', 't3']]
    .map(([o, t], i) => ({ origin_host: o, content_hash: h(t), observed_at: 1700000000000 + i * 60000 }));
  ok(og.independence(real).count === 3 && og.synchrony(real).simultaneous === true,
    'CRITICAL: the count stays 3 AND the flag is raised — synchrony informs, it does not silently deduct');

  ok(og.synchrony([]).simultaneous === false && og.synchrony(null).dated === 0, 'empty/null → no flag, never throws');
  ok(og.synchrony([{ origin_host: 'x' }, { origin_host: 'y' }, { origin_host: 'z' }]).dated === 0,
    'undated items are ignored, never treated as simultaneous');
}

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
