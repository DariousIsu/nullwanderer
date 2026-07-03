/* scripts/smoke_feeds_view.js — offline checks for the Monitors feed view-mappers (pure node). */
'use strict';
const V = require('../studio/feeds_view');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.error('  ✗ ' + name); } }

// real-shape report (mirrors fetch_feed output)
const bbc = {
  feed_url: 'https://feeds.bbci.co.uk/news/world/rss.xml', title: 'BBC News', bozo: false,
  items: [
    { title: 'Story A', link: 'https://bbc.co.uk/a', summary: 'a <b>bold</b> &amp; short', published_iso: '2026-06-30T19:36:51Z', guid: 'g-a' },
    { title: 'Story B', link: 'https://bbc.co.uk/b', summary: 'b', published_iso: '2026-06-30T14:37:54Z', guid: 'g-b' },
  ],
};
const other = {
  feed_url: 'https://example.com/rss', title: '', bozo: false,
  items: [
    { title: 'Newest', link: 'https://example.com/n', summary: 'newest', published_iso: '2026-06-30T20:00:00Z', guid: 'g-n' },
    { title: 'Dup A', link: 'https://bbc.co.uk/a', summary: 'dup', published_iso: '2026-06-30T19:36:51Z', guid: 'g-a' }, // same id as BBC Story A
    { title: 'No date', link: 'https://example.com/nd', summary: 'nd', published_iso: '', guid: 'g-nd' },
  ],
};

// ---- normalizeFeedReport ----
const n = V.normalizeFeedReport(bbc);
ok('source title used', n.source === 'BBC News' && n.ok === true && n.count === 2);
ok('item normalized + html stripped', n.items[0].title === 'Story A' && n.items[0].summary === 'a bold & short' && n.items[0].publishedMs === Date.parse('2026-06-30T19:36:51Z'));
ok('source falls back to hostname', V.normalizeFeedReport(other).source === 'example.com');
ok('id falls back to link when no guid', V.normalizeFeedReport({ feed_url: 'x', items: [{ title: 'T', link: 'http://x/y' }] }).items[0].id === 'http://x/y');
ok('bozo true → ok false', V.normalizeFeedReport({ feed_url: 'x', bozo: true, items: [] }).ok === false);

// ---- mergeReports: dedup + newest-first + cap ----
const m = V.mergeReports({ feeds: [bbc, other] });
ok('merged dedups by id', m.items.filter(i => i.id === 'g-a').length === 1);
ok('newest-first', m.items[0].id === 'g-n' && m.items[0].title === 'Newest');
ok('no-date item kept, sorts last', m.items.some(i => i.id === 'g-nd') && m.items[m.items.length - 1].id === 'g-nd');
ok('sources summary', m.sources.length === 2 && m.sources[0].source === 'BBC News');
ok('accepts bare array too', V.mergeReports([bbc]).items.length === 2);
ok('limit respected', V.mergeReports({ feeds: [bbc, other] }, { limit: 2 }).items.length === 2);

// ---- markNew ----
const marked = V.markNew(m.items, new Set(['g-a', 'g-b']));
ok('markNew flags unseen', marked.find(i => i.id === 'g-n').isNew === true && marked.find(i => i.id === 'g-a').isNew === false);

// ---- relTime ----
const base = Date.parse('2026-06-30T20:00:00Z');
ok('relTime now', V.relTime(base, base + 5000) === 'now');
ok('relTime minutes', V.relTime(base, base + 5 * 60000) === '5m');
ok('relTime hours', V.relTime(base, base + 3 * 3600000) === '3h');
ok('relTime days', V.relTime(base, base + 2 * 86400000) === '2d');
ok('relTime empty for 0', V.relTime(0, base) === '');

// ---- youtubeId / ytEmbed ----
ok('youtubeId from watch url', V.youtubeId('https://www.youtube.com/watch?v=gCNeDWCI0vo') === 'gCNeDWCI0vo');
ok('youtubeId from watch url w/ extra params', V.youtubeId('https://www.youtube.com/watch?list=x&v=EBJ-uKRmrdE&t=5') === 'EBJ-uKRmrdE');
ok('youtubeId from youtu.be', V.youtubeId('https://youtu.be/SIxTgKoSXNM') === 'SIxTgKoSXNM');
ok('youtubeId null for non-yt', V.youtubeId('https://example.com/x') === null && V.youtubeId('') === null);
ok('ytEmbed from url', V.ytEmbed('https://www.youtube.com/watch?v=gCNeDWCI0vo') === 'https://www.youtube-nocookie.com/embed/gCNeDWCI0vo');
ok('ytEmbed from bare id', V.ytEmbed('SIxTgKoSXNM') === 'https://www.youtube-nocookie.com/embed/SIxTgKoSXNM');
ok('ytEmbed empty for non-yt', V.ytEmbed('https://example.com') === '');

// ---- aggregator member extraction (Google News <ol>) — corroboration must survive stripHtml ----
const gn = {
  feed_url: 'https://news.google.com/rss', title: 'Top stories - Google News', bozo: false,
  items: [{
    title: 'Kyiv attack', link: 'https://news.google/x', guid: 'gn-1', published_iso: '2026-07-02T12:00:00Z',
    summary: '<ol><li><a href="x">Kyiv attack kills 18</a>&nbsp;&nbsp;<font color="#6f6f6f">NBC News</font></li><li><a href="y">Russia hammers capital</a>&nbsp;&nbsp;<font color="#6f6f6f">The New York Times</font></li></ol>',
  }],
};
const gnItem = V.normalizeFeedReport(gn).items[0];
ok('aggregator members parsed (outlet+headline)', Array.isArray(gnItem.members) && gnItem.members.length === 2 && gnItem.members[0].outlet === 'NBC News' && /Kyiv attack/.test(gnItem.members[0].headline));
ok('aggregator summary still stripped to text for display', /Kyiv attack kills 18/.test(gnItem.summary) && gnItem.summary.indexOf('<') === -1);
ok('non-aggregator item has no members', V.normalizeFeedReport(bbc).items[0].members === undefined);
ok('parseAggMembers null for plain text', V.parseAggMembers('just a plain summary') === null);
ok('members survive mergeReports', (V.mergeReports({ feeds: [gn] }).items[0].members || []).length === 2);

// ---- normTitle + collapseDuplicates (VIEW-ONLY syndication collapse) ----
ok('normTitle strips source suffix + punctuation', V.normTitle('CDC warns of parasite; symptoms - cleveland.com') === V.normTitle('CDC warns of parasite; symptoms - nj.com'));
ok('normTitle differs for different stories', V.normTitle('Kyiv attack kills 18') !== V.normTitle('Vatican conclave begins'));
// 5 metros reprinting ONE wire story (distinct links/ids/sources, identical headline)
const metros = ['cleveland.com', 'masslive.com', 'nj.com', 'pennlive.com', 'syracuse.com'].map((h, i) => ({
  id: 'u' + i, title: 'CDC warns of explosive diarrhea parasite on rise in US; Here symptoms and how to treat',
  link: 'https://' + h + '/x', source: h, sourceUrl: 'https://' + h + '/rss', publishedMs: 1000 + i,
}));
const solo = { id: 's1', title: 'Local council approves new budget', source: 'somepaper.com', publishedMs: 5000 };
const collapsed = V.collapseDuplicates([...metros, solo]);
ok('collapse: 5 syndicated copies → 1 card + the solo story = 2 items', collapsed.length === 2);
const dupCard = collapsed.find(i => /CDC warns/.test(i.title));
ok('collapse: dup card carries outlet count', dupCard && dupCard.dupCount === 5 && dupCard.dupOutlets === 5);
ok('collapse: dup card keeps the NEWEST copy as representative', dupCard && dupCard.publishedMs === 1004);
ok('collapse: dupSources lists the outlets', dupCard && dupCard.dupSources.includes('cleveland.com') && dupCard.dupSources.includes('syracuse.com'));
ok('collapse: solo story untouched (no dupCount)', collapsed.find(i => /council/.test(i.title)).dupCount === undefined);
ok('collapse: newest-first by representative', collapsed[0].title.includes('council'));   // solo @5000 > dup @1004
// CRITICAL: the collector path (mergeReports) must NOT collapse — the reservoir needs distinct copies for corroboration
const notCollapsed = V.mergeReports({ feeds: metros.map(mt => ({ feed_url: mt.sourceUrl, title: mt.source, items: [{ title: mt.title, link: mt.link, guid: mt.id, published_iso: '2026-07-02T12:00:00Z' }] })) });
ok('mergeReports does NOT collapse (collector keeps all 5 for corroboration)', notCollapsed.items.length === 5);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
