/* smoke_news_encounters.js — news items become encounters (W3).
 *
 * This is the first lane that can honestly reach grade A, so it is also the first place an inflated
 * grade would look fully rigorous. The load-bearing tests are the two ways this lane manufactures
 * sources that do not exist: an aggregator's outlet list, and syndication across sibling mastheads.
 *
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_news_encounters.js
 */
'use strict';
const ne = require('../lib/news_encounters');
const og = require('../lib/origin');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

const STORY = { id: 7, cluster_key: 'graham lindsey replace senate term', title: 'Sen. Graham will run for a full term' };
const item = (o) => ({ id: 1, source_kind: 'rss', ts: Date.UTC(2026, 6, 19), ...o });

// ── identity ─────────────────────────────────────────────────────────────────────────────────────
ok(ne.eventKey(STORY) === 'event:story:7', 'the STORY ROW is the event identity');
{
  // THE FALSE MERGE, measured live. cluster_key 'trump' spans 18 unrelated stories on different days;
  // keying on it reported independence 22 for an event that never happened. 131 further stories carry
  // an EMPTY cluster key and would all have become one object.
  const a = ne.eventKey({ id: 97, cluster_key: 'trump', title: "Trump says 'everybody's profiting' from market rallies" });
  const b = ne.eventKey({ id: 3673, cluster_key: 'trump', title: "Trump grants pardons to 'persecuted' mechanics" });
  ok(a !== b, 'CRITICAL: two unrelated stories sharing a cluster key must NOT become one event');
  const e1 = ne.eventKey({ id: 1, cluster_key: '' });
  const e2 = ne.eventKey({ id: 2, cluster_key: '' });
  ok(e1 !== e2, 'CRITICAL: an empty cluster key does not collapse every story into one object');
  // A re-headlined story stays one event because the row is the same row.
  ok(ne.eventKey({ id: 5, title: 'First headline' }) === ne.eventKey({ id: 5, title: 'Rewritten later' }),
    'a re-headlined story stays ONE event');
}
ok(ne.eventKey({}) === null && ne.eventKey(null) === null, 'no story id → null, never throws');

// ── VIDEO CAPTIONS ARE NOT EVENTS ────────────────────────────────────────────────────────────────
// 58,169 of 98,563 live items are YouTube caption fragments whose "title" is a mid-sentence transcript
// line. Writing them as events would put 58k fragments into the object graph.
ok(ne.toEncounter(item({ source_kind: 'video', title: 'there is this sort of like political aspect to this because' }), STORY) === null,
  'CRITICAL: a caption fragment is refused — it is speech, not a published report');
ok(ne.toEncounter(item({ source_kind: 'rss' }), STORY) !== null, 'a real feed item is accepted');
ok(ne.toEncounter(item({ source_kind: 'newsletter' }), STORY) !== null, 'so is a newsletter');

// ── THE AGGREGATOR TRAP ──────────────────────────────────────────────────────────────────────────
//
// The live case. ONE item fetched from news.google.com carries
// outlet_set: ["Politico","Axios","PBS","The Washington Post","MS NOW"], outlet_count: 5.
// We never fetched Politico. Recording five encounters would manufacture five independent sources.
{
  const agg = { ...STORY, outlet_set: '["Politico","Axios","PBS","The Washington Post","MS NOW"]', outlet_count: 5 };
  const e = ne.toEncounter(item({ source: 'Top stories - Google News', source_url: 'https://news.google.com/rss/articles/xyz', source_kind: 'aggregator' }), agg);
  ok(e !== null, 'an aggregator item IS an encounter — it is a real source that made an assertion');
  ok(e.origin_host === 'news.google.com',
    'CRITICAL: attributed to the host we actually fetched, never to the outlets it merely lists');
  // The proof: one item can only ever be one source, whatever outlet_count says.
  ok(og.independence([e]).count === 1,
    'CRITICAL: outlet_count 5 yields independence 1 — an aggregator cannot launder one source into five');
}
ok(ne.isAggregator('https://news.google.com/rss/x') && ne.isAggregator('news.yahoo.com') && ne.isAggregator('apple.news'),
  'known aggregators are recognised');
ok(!ne.isAggregator('https://www.politico.com/story') && !ne.isAggregator('legis.la.gov'), 'publishers are not aggregators');

// ── SYNDICATION ACROSS SIBLING MASTHEADS ─────────────────────────────────────────────────────────
//
// Live: nj.com, cleveland.com, mlive.com, al.com, masslive.com, pennlive.com, syracuse.com and
// oregonlive.com are eight hostnames and one company, ~18k items. Distinct hosts cannot be trusted
// alone — the text is what settles it.
{
  const hosts = ['nj.com', 'cleveland.com', 'mlive.com', 'al.com', 'masslive.com', 'pennlive.com', 'syracuse.com', 'oregonlive.com'];
  const wire = hosts.map((h, i) => ne.toEncounter(item({
    id: 100 + i, source_url: `https://www.${h}/2026/07/story.html`,
    title: 'McDonald’s gives classic breakfast sandwich a sweet makeover', summary: 'One wire story.',
  }), STORY));
  ok(wire.every(Boolean) && wire.length === 8, 'all eight items become encounters');
  const ind = og.independence(wire);
  ok(ind.count === 1 && ind.syndicated === true,
    `CRITICAL: 8 sibling mastheads running ONE text = 1 independent source, flagged syndicated (got ${ind.count})`);

  // …and the payoff: eight outlets genuinely reporting it separately DO count.
  const real = hosts.slice(0, 3).map((h, i) => ne.toEncounter(item({
    id: 200 + i, source_url: `https://www.${h}/x`, title: `Distinct report ${i}`, summary: `Independently written ${i}`,
  }), STORY));
  ok(og.independence(real).count === 3, 'THE PAYOFF: 3 outlets with 3 distinct texts = 3 → this lane can reach grade A');
}

// ── the publisher's own date ─────────────────────────────────────────────────────────────────────
{
  const e = ne.toEncounter(item({ ts: Date.UTC(2019, 0, 15) }), STORY);
  ok(e.observed_at === Date.UTC(2019, 0, 15),
    'observed_at is the PUBLICATION time — not when we polled, and not parsed out of prose');
  const future = ne.toEncounter(item({ ts: Date.now() + 90 * 24 * 3600 * 1000 }), STORY);
  ok(future.observed_at === null,
    'CRITICAL: a future-dated item is refused a date — it would outrank everything real, permanently');
}

// ── shape ────────────────────────────────────────────────────────────────────────────────────────
{
  const e = ne.toEncounter(item({ source_url: 'https://www.politico.com/story/abc' }), STORY);
  ok(e.object_type === 'event' && e.claim_class === 'existence', 'a story is an EVENT that was encountered');
  ok(e.claim_key === null && e.claim_value === null, 'existence asserts only that the event is real');
  ok(e.authority === 'ordinary', 'news is ordinary evidence — a reputable outlet is still not an official record');
  ok(e.source_ref === 'news:1', 'it cites the item it came from');
  ok(e.origin_host === 'politico.com', 'www is stripped — one publisher, one origin');
}
ok(ne.toEncounter(null, STORY) === null && ne.toEncounter({}, null) === null, 'garbage in → null, never throws');

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
