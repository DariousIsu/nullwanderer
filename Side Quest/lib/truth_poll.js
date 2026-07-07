/*
 * lib/truth_poll.js — the TRUTH SOCIAL social-feed collector (Data-Stream Lane, social source).
 *
 * Truth Social is a Mastodon fork, so it exposes the Mastodon public API. Tracked accounts' public posts are
 * read WITHOUT auth (a browser User-Agent passes Cloudflare — verified live) and landed into the SAME isolated
 * news reservoir as RSS/video, tagged source_kind='social', so they ride the hourly compression → stories →
 * briefing rail. No API key. (RSS is disabled on Truth Social; the API is the path.)
 *
 * Flow per account: /accounts/lookup?acct=<user> → account id (cached) → /accounts/<id>/statuses → posts →
 * news_store.insertItem. Dedup is the reservoir's UNIQUE(source, url_or_guid) on the post URL, so re-fetching
 * the latest N each poll only lands genuinely new posts (no cursor needed for a first slice).
 *
 * Pure cores (statusToItem / htmlToText) + injected deps (fetch / store) → offline-testable with no network.
 */
'use strict';

// A real browser UA — Truth Social is Cloudflare-fronted and hard-blocks non-browser agents (like the .gov
// cabinet); with this header the public API returns 200 (verified).
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const API = 'https://truthsocial.com/api/v1';
// Hard-coded default tracked accounts (Lucas: start hard-coded); override via TRUTH_ACCOUNTS=comma,list.
const DEFAULT_ACCOUNTS = String(process.env.TRUTH_ACCOUNTS || 'realDonaldTrump').split(',').map((s) => s.trim().replace(/^@/, '')).filter(Boolean);

// --- pure text ---
function htmlToText(html) {
  return String(html == null ? '' : html)
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/ +([.,!?;:])/g, '$1').replace(/\n{3,}/g, '\n\n').trim();
}
function firstLine(text, cap = 120) {
  const t = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return t.length <= cap ? t : `${t.slice(0, cap - 1).trimEnd()}…`;
}

// PURE — a Mastodon status → a news_store.insertItem() row (source_kind='social'). A repost (reblog) points to
// the ORIGINAL post's content + url. Social posts have no title, so it's derived from the first line of text.
function statusToItem(status, username) {
  if (!status) return null;
  const rb = status.reblog;
  const src = rb || status;
  const text = htmlToText(src.content);
  const who = rb ? `@${username} ⟳ @${(rb.account && rb.account.username) || '?'}` : `@${username}`;
  const title = firstLine(text, 120) || ((src.media_attachments && src.media_attachments.length) ? '(media post)' : '(truth)');
  const urlOrGuid = src.url || src.uri || `ts:${src.id}`;
  if (!urlOrGuid) return null;
  return {
    source: `Truth Social · ${who}`,
    sourceKind: 'social',
    sourceUrl: `https://truthsocial.com/@${username}`,
    title,
    urlOrGuid,
    ts: Date.parse(src.created_at) || Date.parse(status.created_at) || 0,   // ms; 0 → news_store stamps collection time
    summary: text.slice(0, 2000),
  };
}

// --- network (injected fetch; fail-soft → null/[]) ---
async function apiGet(path, { fetch: f } = {}) {
  const fn = f || (typeof fetch === 'function' ? fetch : null);
  if (!fn) return null;
  try {
    const res = await fn(`${API}${path}`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch { return null; }
}
async function lookupAccount(username, deps = {}) {
  const o = await apiGet(`/accounts/lookup?acct=${encodeURIComponent(username)}`, deps);
  return o && o.id ? String(o.id) : null;
}
async function fetchStatuses(accountId, { limit = 20, fetch: f } = {}) {
  const o = await apiGet(`/accounts/${accountId}/statuses?exclude_replies=true&limit=${limit}`, { fetch: f });
  return Array.isArray(o) ? o : [];
}

// account-id cache (a username's id is stable) so we lookup once, then only fetch statuses.
const _ids = {};

// Poll ONE account → land its recent public posts into the reservoir. Returns { username, fetched, inserted }.
async function pollAccount(username, { fetch: f, store, limit = 20, log } = {}) {
  const S = store || require('./news_store');
  let id = _ids[username];
  if (!id) { id = await lookupAccount(username, { fetch: f }); if (id) _ids[username] = id; }
  if (!id) { log && log(`[truth] lookup failed: @${username}`); return { username, fetched: 0, inserted: 0 }; }
  const statuses = await fetchStatuses(id, { limit, fetch: f });
  const items = statuses.map((s) => statusToItem(s, username)).filter(Boolean);
  const r = items.length ? S.insertItems(items) : { inserted: 0 };
  if (log && r.inserted) log(`[truth] @${username}: ${r.inserted} new / ${statuses.length} fetched`);
  return { username, fetched: statuses.length, inserted: r.inserted || 0 };
}

// Poll every tracked account. Conservative — social posts land in the reservoir + ride the hourly compression.
async function runPoll({ fetch: f, store, accounts, limit = 20, log } = {}) {
  const list = (accounts && accounts.length) ? accounts : DEFAULT_ACCOUNTS;
  let inserted = 0, fetched = 0;
  for (const u of list) { const r = await pollAccount(u, { fetch: f, store, limit, log }); inserted += r.inserted; fetched += r.fetched; }
  if (log) log(`[truth] poll: ${inserted} new posts across ${list.length} account(s)`);
  return { accounts: list.length, fetched, inserted };
}

module.exports = {
  BROWSER_UA, API, DEFAULT_ACCOUNTS,
  htmlToText, firstLine, statusToItem, lookupAccount, fetchStatuses, pollAccount, runPoll, _ids,
};
