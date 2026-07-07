/**
 * lib/pipeline.js — the Puller PIPELINE coordinator (cloud-leverage Slice 3).
 *
 * The three idle "Puller" lanes used to be independent SCANNERS: each re-scanned the whole target store
 * every tick and guessed its own work, and DISCOVER was even SUBORDINATE to CONTACT (it only fired when
 * the enrich half came up dry). That's not a pipeline — the "operator finds targets" layer was throttled
 * by the "puller works contacts" layer instead of FEEDING it.
 *
 * This module is the pure brain that turns them into a genuine producer→consumer PIPELINE of three
 * CONCURRENT layers that hand work forward by target LIFECYCLE STAGE (derived from the facets already in
 * puller_db — no schema change):
 *
 *   DISCOVER  (operator) — prospect an active org → mint net-new targets        → targets with NO email
 *   CONTACT   (puller)   — fill a target's email (pattern/web)                   → targets WITH an email
 *   ENRICH    (facets)   — social/OSINT deep facets (maigret) on contacted ones  → enriched targets
 *
 * The property that makes it a PIPELINE and not three blind lanes is BACKPRESSURE: DISCOVER only mints
 * when the CONTACT stage can keep up (contact backlog below a cap), so the operator can't flood the store
 * with un-worked targets faster than they get contacted. Every input is injected/plain-data → this whole
 * module is offline-smoke-testable; the live I/O (puller_db, web, maigret) stays in the caller.
 */
'use strict';

const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// A target's pipeline STAGE from its current facets (t = {hasEmail, hasDeep, ...}):
//   'contact' — no email yet             → CONTACT stage's queue (fill an address)
//   'enrich'  — has an email, not deep   → ENRICH stage's queue (social/OSINT facets)
//   'done'    — has email AND deepened   → terminal (nothing queued)
function stageOf(t) {
  if (!t) return 'done';
  if (!t.hasEmail) return 'contact';
  if (!t.hasDeep) return 'enrich';
  return 'done';
}

// Rank so the operator's ACTIVE neighborhood flows first, then the FRESHEST arrivals — a target just
// minted by DISCOVER should reach CONTACT promptly, not sit behind a stale backlog. Pure sort key.
function _rank(t, activeKeys, norm) {
  let s = 0;
  if (activeKeys && activeKeys.has(norm(t && t.name))) s += 1e12;   // active focus dominates
  s += Number((t && t.ts) || 0);                                    // then recency (ms timestamp)
  return s;
}

// Partition a flat candidate list into the two CONSUMER queues, each ordered active-first then freshest.
// cands: [{id,name,company,domain,hasEmail,hasDeep,grounded,ts}]. DISCOVER has no queue here (it prospects
// orgs, not targets) — its gate is shouldDiscover() on the contact-queue depth. Pure.
function partition(cands, { activeKeys = new Set(), norm = _norm } = {}) {
  const contact = [], enrich = [];
  for (const t of (Array.isArray(cands) ? cands : [])) {
    if (!t || !t.name) continue;
    const st = stageOf(t);
    if (st === 'contact') contact.push(t);
    else if (st === 'enrich') enrich.push(t);
  }
  const byRank = (a, b) => _rank(b, activeKeys, norm) - _rank(a, activeKeys, norm);
  contact.sort(byRank); enrich.sort(byRank);
  return { contact, enrich };
}

// BACKPRESSURE — DISCOVER should mint net-new targets only when CONTACT can keep up. A deep contact
// backlog means the store is already full of un-worked people; minting more just buries them. Hold
// discovery this tick and let CONTACT drain. cap from config (pipelineContactBacklogCap). Pure.
function shouldDiscover({ contactDepth = 0, cap = 40 } = {}) {
  return Number(contactDepth) < Number(cap);
}

// A compact one-line description of the pipeline's current pressure — for the tick log so the staged
// flow is visible (Lucas). Pure.
function describe({ contact = [], enrich = [] } = {}, { cap = 40 } = {}) {
  const cd = contact.length, ed = enrich.length;
  const disc = shouldDiscover({ contactDepth: cd, cap }) ? 'open' : 'held(backpressure)';
  return `contact:${cd} enrich:${ed} discover:${disc}`;
}

module.exports = { stageOf, partition, shouldDiscover, describe, _rank, _norm };
