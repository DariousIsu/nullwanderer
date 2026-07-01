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

console.log(`\nsmoke_feeds_view: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
