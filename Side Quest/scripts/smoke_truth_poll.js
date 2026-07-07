/* Smoke: lib/truth_poll — the Truth Social social-feed collector (Mastodon public API → reservoir).
 * Mock fetch (real status shapes) + a mock store; pure, no network/DB. Run:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_truth_poll.js */
'use strict';
const tp = require('../lib/truth_poll');

let pass = 0, fail = 0;
const ok = (c, t) => { if (c) { pass++; console.log('  ✓', t); } else { fail++; console.log('  ✗', t); } };

// ===== pure text =====
ok(tp.htmlToText('<p>Hello <a href="x">world</a> &amp; more</p>') === 'Hello world & more', 'htmlToText strips tags + decodes entities');
ok(tp.firstLine('First line here\nSecond', 120) === 'First line here', 'firstLine takes the first non-empty line');
ok(tp.firstLine('x'.repeat(200), 20).length === 20 && /…$/.test(tp.firstLine('x'.repeat(200), 20)), 'firstLine caps + ellipsizes');

// ===== statusToItem mapping =====
const post = {
  id: '116879490053026634', created_at: '2026-07-07T15:51:24.451Z',
  url: 'https://truthsocial.com/@realDonaldTrump/116879490053026634',
  content: '<p>Thank you! NATO is <strong>stronger</strong>.</p>', reblog: null,
  media_attachments: [], reblogs_count: 2129, favourites_count: 8719,
};
const item = tp.statusToItem(post, 'realDonaldTrump');
ok(item.sourceKind === 'social', 'statusToItem → source_kind=social');
ok(item.source === 'Truth Social · @realDonaldTrump', 'source names the account');
ok(item.urlOrGuid === post.url, 'url_or_guid = the post URL (reservoir dedups on it)');
ok(item.title === 'Thank you! NATO is stronger.', 'title derived from the post text');
ok(/NATO is stronger/.test(item.summary), 'summary carries the clean post text');
ok(item.ts === Date.parse(post.created_at), 'ts = created_at in ms');

// reblog (repost) → points to the ORIGINAL content + url
const reblogWrap = { id: '999', created_at: '2026-07-07T16:00:00Z', reblog: { id: '888', url: 'https://truthsocial.com/@someGov/888', content: '<p>Original announcement.</p>', account: { username: 'someGov' }, media_attachments: [] } };
const rbItem = tp.statusToItem(reblogWrap, 'realDonaldTrump');
ok(/Original announcement/.test(rbItem.summary) && rbItem.urlOrGuid === 'https://truthsocial.com/@someGov/888', 'a reblog maps to the ORIGINAL post content + url');
ok(/⟳ @someGov/.test(rbItem.source), 'a reblog marks the reposted-from account');

// media-only post → a placeholder title, still landed
ok(tp.statusToItem({ id: '1', created_at: '2026-07-07T00:00:00Z', content: '', media_attachments: [{ type: 'image' }] }, 'x').title === '(media post)', 'a media-only post gets a placeholder title');

// ===== poll: mock fetch (lookup + statuses) + mock store (dedup by url_or_guid) =====
function mkStore() {
  const seen = new Set(); const rows = [];
  return {
    rows,
    insertItems(items) { let inserted = 0, dup = 0; for (const it of items) { const k = `${it.source}|${it.urlOrGuid}`; if (seen.has(k)) { dup++; continue; } seen.add(k); rows.push(it); inserted++; } return { inserted, duplicates: dup, total: items.length }; },
  };
}
function mkFetch(statuses) {
  return async (url) => {
    if (/\/accounts\/lookup/.test(url)) return { ok: true, json: async () => ({ id: '107780257626128497', username: 'realDonaldTrump' }) };
    if (/\/statuses/.test(url)) return { ok: true, json: async () => statuses };
    return { ok: false };
  };
}
const statuses = [post, { id: '2', created_at: '2026-07-07T14:00:00Z', url: 'https://truthsocial.com/@realDonaldTrump/2', content: '<p>Second post.</p>', reblog: null, media_attachments: [] }];

(async () => {
  tp._ids.realDonaldTrump = undefined;   // clear the module id cache for a clean run
  const store = mkStore(); const fetch = mkFetch(statuses);
  const r1 = await tp.runPoll({ fetch, store, accounts: ['realDonaldTrump'] });
  ok(r1.inserted === 2 && r1.fetched === 2 && store.rows.length === 2, 'runPoll: lands both posts into the reservoir');
  ok(store.rows.every((it) => it.sourceKind === 'social'), 'landed rows are source_kind=social');
  const r2 = await tp.runPoll({ fetch, store, accounts: ['realDonaldTrump'] });
  ok(r2.inserted === 0 && store.rows.length === 2, 'idempotent: a second poll re-fetches but the reservoir dedups (0 new)');

  // fail-soft: lookup fails → no crash, 0 landed
  tp._ids.ghost = undefined;
  const rz = await tp.runPoll({ fetch: async () => ({ ok: false }), store: mkStore(), accounts: ['ghost'] });
  ok(rz.inserted === 0, 'fail-soft: a failed lookup/fetch → 0 landed, no throw');

  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} ok, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
