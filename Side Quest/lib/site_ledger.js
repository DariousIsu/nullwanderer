/**
 * lib/site_ledger.js — THE VISITED LEDGER + PER-SITE DIGEST PLAN (2026-07-23).
 *
 * Lucas: "doesn't she capture the page on first land anyway? shouldn't everything be ingested and
 * then a deep dive on that site plan made so that the whole site can be swept correctly, each page
 * only once? … I would rather get explained that a site is taking longer to digest than realize we
 * took 500 calls to interact with the landing page."
 *
 * Page TEXT was captured on first read (learnings/encounters/docs) but NOTHING remembered visits at
 * the NAVIGATION layer — every idle lane re-navigated independently, forever. Two halves:
 *   LEDGER — every successful capture records (url, host, kind, chars, doc ref). Autonomous
 *            navigation consults `shouldSkip` before re-fetching: fresh-enough → reuse, don't go.
 *            Chat-driven opens NEVER consult it — a human ask always navigates.
 *   PLAN   — on first landing, same-host links become a bounded digest checklist (site_plans).
 *            Lanes work it page-by-page; `planLine` narrates coverage ("host: 12/30 digested") so
 *            slowness is EXPLAINED, never silent.
 *
 * Pure-ish (sq.db via lib/db); TTL injectable; fail-soft everywhere — a ledger error must never
 * block a navigation, only permit one.
 */
'use strict';

const db = require('./db');

const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000;   // a page re-earns a fetch after ~3 days
const SERP_TTL_MS = 30 * 60 * 1000;                // a search-results page changes — only the DUPLICATE
                                                   // search within minutes is waste (live: the same 4-H
                                                   // contact query fired twice in one minute)
const PLAN_MAX_URLS = 30;                          // a digest plan is bounded, never a full mirror

// A search-engine results page is not content — it gets its own kind and a short TTL.
const _SERP_RE = /^https?:\/\/(?:www\.)?(?:google\.[a-z.]+\/search|bing\.com\/search|duckduckgo\.com\/)/i;
function isSerp(u) { return _SERP_RE.test(String(u || '')); }

// #fragment never changes content; trailing slash is cosmetic; tracking params are noise.
function normalizeUrl(u) {
  const s = String(u || '').trim();
  if (!s) return '';
  try {
    const url = new URL(s);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_cid|mc_eid)/i.test(k)) url.searchParams.delete(k);
    let out = url.toString();
    if (out.endsWith('/') && url.pathname === '/') out = out.slice(0, -1);
    return out;
  } catch { return s.split('#')[0]; }
}
function hostOf(u) { try { return new URL(String(u)).hostname.toLowerCase(); } catch { return ''; } }

function seen(u) {
  const url = normalizeUrl(u);
  if (!url) return null;
  try { return db.getDb().prepare('SELECT * FROM site_visits WHERE url = ?').get(url) || null; } catch { return null; }
}

// Record a successful capture. Upsert: repeat visits bump visits+last_ts (the WASTE COUNTER —
// a high visits count on one url is the 500-calls smell, now measurable).
function record(u, { kind = 'page', chars = null, docId = null, now = Date.now() } = {}) {
  const url = normalizeUrl(u);
  if (!url) return false;
  const host = hostOf(url);
  if (!host) return false;
  if (isSerp(url)) kind = 'serp';
  try {
    db.getDb().prepare(`INSERT INTO site_visits (url, host, kind, first_ts, last_ts, visits, chars, doc_id)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(url) DO UPDATE SET last_ts = excluded.last_ts, visits = visits + 1,
        chars = COALESCE(excluded.chars, chars), doc_id = COALESCE(excluded.doc_id, doc_id)`)
      .run(url, host, kind, now, now, chars, docId);
    return true;
  } catch { return false; }
}

// Should an AUTONOMOUS lane skip re-fetching? Fresh-enough capture → yes, with the reuse pointer.
// Never consulted for chat-driven opens (a human ask always navigates).
function shouldSkip(u, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const row = seen(u);
  if (!row) return { skip: false };
  const ttl = row.kind === 'serp' ? Math.min(ttlMs, SERP_TTL_MS) : ttlMs;
  if (now - row.last_ts >= ttl) return { skip: false, stale: row };
  return { skip: true, row, why: `read ${row.visits}× (last ${Math.round((now - row.last_ts) / 60000)}m ago${row.doc_id ? `, doc #${row.doc_id}` : ''})` };
}

// ── the digest plan ─────────────────────────────────────────────────────────────────────
// Build/extend a host's checklist from same-host links seen on a landing. Bounded; dedup vs the
// ledger (already-read urls enter as done) and vs the existing plan.
function buildPlan(landingUrl, links, { now = Date.now(), max = PLAN_MAX_URLS } = {}) {
  const host = hostOf(landingUrl);
  if (!host) return null;
  let plan = getPlan(host) || { host, urls: [], created_ts: now };
  const have = new Set(plan.urls.map((e) => e.url));
  for (const l of (links || [])) {
    const url = normalizeUrl(typeof l === 'string' ? l : l && l.url);
    if (!url || have.has(url) || hostOf(url) !== host) continue;
    if (plan.urls.length >= max) break;
    have.add(url);
    plan.urls.push({ url, status: seen(url) ? 'done' : 'pending' });
  }
  try {
    db.getDb().prepare(`INSERT INTO site_plans (host, plan, created_ts, updated_ts) VALUES (?, ?, ?, ?)
      ON CONFLICT(host) DO UPDATE SET plan = excluded.plan, updated_ts = excluded.updated_ts`)
      .run(host, JSON.stringify(plan.urls), plan.created_ts, now);
  } catch {}
  return plan;
}
function getPlan(host) {
  try {
    const r = db.getDb().prepare('SELECT * FROM site_plans WHERE host = ?').get(String(host || '').toLowerCase());
    if (!r) return null;
    return { host: r.host, urls: JSON.parse(r.plan || '[]'), created_ts: r.created_ts };
  } catch { return null; }
}
function markDone(host, u, { now = Date.now() } = {}) {
  const plan = getPlan(host);
  if (!plan) return false;
  const url = normalizeUrl(u);
  let hit = false;
  for (const e of plan.urls) if (e.url === url && e.status !== 'done') { e.status = 'done'; hit = true; }
  if (hit) {
    try { db.getDb().prepare('UPDATE site_plans SET plan = ?, updated_ts = ? WHERE host = ?').run(JSON.stringify(plan.urls), now, plan.host); } catch {}
  }
  return hit;
}
function nextPending(host) {
  const plan = getPlan(host);
  if (!plan) return null;
  const e = plan.urls.find((x) => x.status === 'pending');
  return e ? e.url : null;
}
// The narration Lucas asked for: slowness EXPLAINED ("this site is taking longer to digest").
function planLine(host) {
  const plan = getPlan(host);
  if (!plan || !plan.urls.length) return null;
  const done = plan.urls.filter((e) => e.status === 'done').length;
  return `[site-digest] ${plan.host}: ${done}/${plan.urls.length} pages digested${done < plan.urls.length ? ' — still working through it' : ' — complete'}`;
}

module.exports = { normalizeUrl, hostOf, isSerp, seen, record, shouldSkip, buildPlan, getPlan, markDone, nextPending, planLine, DEFAULT_TTL_MS, SERP_TTL_MS, PLAN_MAX_URLS };
