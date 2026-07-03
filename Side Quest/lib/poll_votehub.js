/**
 * lib/poll_votehub.js — VoteHub API POLL adapter (Suite-A adapter #2; the clean real-time REST feed).
 *
 * The programmatic 538-successor: free, no-auth REST at api.votehub.com (verified 2026-07-03). Covers the
 * whole 538 gap — /poll-types = approval, favorability, generic-ballot, presidential-primary, us-senator,
 * us-representative, governor, mayor, attorney-general. See docs/POLLING_SOURCE_MAP.md §3.
 *
 * PURE + injected I/O (mirrors lib/news_poll.js): all HTTP goes through an injected `fetchJson(url)` so
 * the adapter is offline-testable with zero network; `defaultFetchJson` (global fetch) is the real one the
 * app wiring passes. Normalization emits the SHARED adapter shape (docs/POLLING_SOURCE_MAP.md §4a) — the
 * SAME shape lib/poll_wikipedia produces + Echo poll_fielding/poll_topline expect — so every source lands
 * identically. Fail-soft everywhere: a bad payload / HTTP error → {ok:false,…}, never a throw.
 *
 * VoteHub /polls item → { id, poll_type, subject, seat_name, pollster, sponsors[], partisan, internal,
 *   population('rv'|'lv'|'a'), sample_size, start_date, end_date, created_at, url, answers:[{choice,pct}] }.
 * `population` is carried straight through — it FILLS the LV/RV/A frame gap the 538 ingest lacked.
 */
'use strict';

const BASE = 'https://api.votehub.com';

const slug = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// VoteHub population code → shared frame code ('a'|'rv'|'lv'|'v'|null)
function normPop(p) {
  if (!p) return null;
  const s = String(p).toLowerCase().trim();
  return ({ a: 'a', rv: 'rv', lv: 'lv', v: 'v', adults: 'a', registered: 'rv', likely: 'lv', voters: 'v' })[s] || null;
}

// one VoteHub API poll → shared adapter shape. Returns null for unusable rows (fail-soft).
function normalizePoll(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const answers = (Array.isArray(raw.answers) ? raw.answers : [])
    .map((a) => ({ choice: String((a && a.choice) || '').trim(), pct: Number(a && a.pct) }))
    .filter((a) => a.choice && Number.isFinite(a.pct));
  const pollster = String(raw.pollster || '').trim();
  if (!pollster && !answers.length) return null;
  const sponsors = (Array.isArray(raw.sponsors) ? raw.sponsors : []).filter(Boolean).map((s) => String(s).trim());
  const n = Number(raw.sample_size);
  return {
    source_kind: 'votehub',
    tier: 'free',
    poll_type: raw.poll_type || '',
    subject: raw.subject || '',
    seat_name: raw.seat_name || null,
    pollster,
    sponsor: sponsors.join('/'),
    population: normPop(raw.population),
    sample_size: Number.isFinite(n) ? n : null,
    moe_pct: null,                         // VoteHub /polls does not expose MoE
    start_date: raw.start_date || null,
    end_date: raw.end_date || null,
    url: raw.url || null,
    answers,
    partisan: raw.partisan || null,        // extra (useful for house-effect weighting later)
    internal: !!raw.internal,              // extra (campaign-internal flag)
    is_aggregate: false,                   // VoteHub serves individual polls, not averages
    source_id: raw.id ? 'votehub-' + String(raw.id)
      : 'votehub-' + slug([raw.poll_type, raw.subject, pollster, raw.end_date].join('|')),
  };
}

function normalizeMany(list) {
  return (Array.isArray(list) ? list : []).map(normalizePoll).filter(Boolean);
}

// VoteHub returns a bare array; tolerate {data:[…]} / {polls:[…]} wrappers too.
function unwrapList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  if (raw && Array.isArray(raw.polls)) return raw.polls;
  return [];
}

function pollsUrl({ poll_type, subject, limit } = {}) {
  const q = [];
  if (poll_type) q.push('poll_type=' + encodeURIComponent(poll_type));
  if (subject) q.push('subject=' + encodeURIComponent(subject));
  if (limit) q.push('limit=' + encodeURIComponent(limit));
  return BASE + '/polls' + (q.length ? '?' + q.join('&') : '');
}

// fetch + normalize polls. fetchJson injected (offline-testable). → { ok, polls, error? }. Never throws.
async function fetchPolls({ fetchJson, poll_type, subject, limit } = {}) {
  if (typeof fetchJson !== 'function') return { ok: false, polls: [], error: 'missing fetchJson' };
  let raw;
  try { raw = await fetchJson(pollsUrl({ poll_type, subject, limit })); }
  catch (e) { return { ok: false, polls: [], error: e.message }; }
  return { ok: true, polls: normalizeMany(unwrapList(raw)) };
}

// thin metadata endpoints (arrays of strings / {subject,poll_types}); fail-soft
async function fetchPollTypes({ fetchJson } = {}) {
  if (typeof fetchJson !== 'function') return { ok: false, types: [] };
  try { const r = await fetchJson(BASE + '/poll-types'); return { ok: true, types: Array.isArray(r) ? r : [] }; }
  catch (e) { return { ok: false, types: [], error: e.message }; }
}
async function fetchSubjects({ fetchJson } = {}) {
  if (typeof fetchJson !== 'function') return { ok: false, subjects: [] };
  try { const r = await fetchJson(BASE + '/subjects'); return { ok: true, subjects: Array.isArray(r) ? r : [] }; }
  catch (e) { return { ok: false, subjects: [], error: e.message }; }
}
async function fetchPollsters({ fetchJson } = {}) {
  if (typeof fetchJson !== 'function') return { ok: false, pollsters: [] };
  try { const r = await fetchJson(BASE + '/pollsters'); return { ok: true, pollsters: Array.isArray(r) ? r : [] }; }
  catch (e) { return { ok: false, pollsters: [], error: e.message }; }
}

// real HTTP fetcher (Node 18+/Electron global fetch). The app wiring may pass its own instead.
async function defaultFetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'SideQuest-forecast/0.1' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

module.exports = {
  BASE, normPop, normalizePoll, normalizeMany, unwrapList, pollsUrl,
  fetchPolls, fetchPollTypes, fetchSubjects, fetchPollsters, defaultFetchJson,
};
