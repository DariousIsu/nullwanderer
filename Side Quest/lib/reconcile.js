/**
 * lib/reconcile.js — the RECONCILIATION CORE (belief revision). Spec: docs/RECONCILIATION_CORE_SPEC.md.
 *
 * The law ("Zoe IS the memory"): new information about an object/edge must ACCRETE back into the substrate,
 * reconciled — not appended sideways as a dead-end doc. The Pam Bondi failure: a fresh, cited correction
 * ("Bondi served as AG until 2026-04-02") never superseded the stale Echo record ("Bondi is the AG"),
 * because the correction landed as loose unranked notes and the held belief was never revised.
 *
 * This module is the DETERMINISTIC decision layer both ingest lanes (news, research) consume:
 *   • score(citations)          → corroboration, REUSING the news-lane primitives (independent-report count,
 *                                 syndication-collapsed) — "the internet echoed it" must not inflate the count.
 *   • reconcile(claim, incumbent) → new | merge | supersede | append | reject | ask (the §4 table).
 *   • precedence(shortTermFact, echoLine) → which one recall leads with (the §5 Pam-Bondi gate).
 *
 * Pure + dependency-injected (news_lane / staleness passed or lazy-required) → fully unit-testable; `now`
 * injected (never Date.now inside). No cloud model in the decision.
 */
'use strict';

function _newsLane(deps) { if (deps && deps.newsLane) return deps.newsLane; try { return require('./news_lane'); } catch { return null; } }
function _staleness(deps) { if (deps && deps.staleness) return deps.staleness; try { return require('./staleness'); } catch { return null; } }

// Tier vocabulary — extends the news-lane corroborationTier ('single-source'|'corroborated'|'widely
// reported') with 'none' for zero independent reports. Ranked so the §4 bar ("tier >= corroborated") is a
// numeric compare.
const TIER_RANK = { none: 0, 'single-source': 1, corroborated: 2, 'widely reported': 3 };
const _tierRank = (t) => TIER_RANK[t] != null ? TIER_RANK[t] : 0;

const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
function _coreEq(a, b) { const x = _norm(a), y = _norm(b); if (!x || !y) return false; const xs = x.split(' '), ys = y.split(' '); return xs.every(t => ys.includes(t)) || ys.every(t => xs.includes(t)); }
// A citation's outlet identity — explicit outlet, else the URL host, else the source id.
function _outletOf(c) {
  if (!c) return '';
  if (c.outlet) return _norm(c.outlet);
  const u = String(c.url || '');
  const m = u.match(/^[a-z]+:\/\/([^/]+)/i);
  if (m) return _norm(m[1].replace(/^www\./i, ''));
  return _norm(c.source_id || '');
}

// ── §2 CORROBORATION — reuse the news-lane report identity (syndication-collapsed) ──────────────────────
// reports = distinct INDEPENDENT reports (30 wire copies = 1); outlets = distinct outlets; authority = max
// citation tier (3 primary/gov · 2 major outlet · 1 blog · 0 unknown); tier = corroborationTier(reports).
function score(citations, deps = {}) {
  const nl = _newsLane(deps);
  const reportIdent = (nl && nl.reportIdent) || _norm;
  const tierFn = (nl && nl.corroborationTier) || ((n) => (n >= 5 ? 'widely reported' : n >= 2 ? 'corroborated' : 'single-source'));
  const cites = Array.isArray(citations) ? citations.filter(Boolean) : [];
  const reps = new Set(), outs = new Set();
  let authority = 0;
  for (const c of cites) {
    const rk = reportIdent(c.report_key || c.title || c.url || c.source_id || '');
    if (rk) reps.add(rk);
    const o = _outletOf(c); if (o) outs.add(o);
    authority = Math.max(authority, Number(c.authority_tier) || 0);
  }
  const reports = reps.size, outlets = outs.size;
  return { reports, outlets, authority, tier: reports === 0 ? 'none' : tierFn(reports) };
}

// TTL class from the assertion text (spec Claim.ttl_class) — derived from the staleness classifier so news
// + research + recall all agree on what "volatile" means. volatile leans recency; stable/permanent lean
// corroboration.
function classifyTtl(text, deps = {}) {
  const st = _staleness(deps);
  if (!st) return 'stable';
  const ttl = st.ttlDays(text);
  return ttl === st.TTL_DAYS.volatile ? 'volatile' : (ttl == null ? 'permanent' : 'stable');
}

// Merge an agreeing claim into the incumbent: UNION citations, re-score (boosts corroboration). Pure.
function mergeCitations(incumbent, claim, deps = {}) {
  const a = (incumbent && incumbent.citations) || [];
  const b = (claim && claim.citations) || [];
  return score(a.concat(b), deps);
}

// Is claim.as_of strictly newer than incumbent.as_of? A fresh DATED claim beats an UNDATED incumbent (the
// stale Echo record often carries no effective date). An undated CLAIM can never assert freshness → false.
function _isNewer(claimAsOf, incumbentAsOf) {
  if (!claimAsOf) return false;
  const cs = Date.parse(claimAsOf);
  if (!Number.isFinite(cs)) return false;
  if (!incumbentAsOf) return true;
  const is = Date.parse(incumbentAsOf);
  if (!Number.isFinite(is)) return true;
  return cs > is;
}

// Corroboration comparison a >= b, lexicographic on (tier, authority, reports). Used for the stable/
// permanent bar ("claim.corroboration >= incumbent.corroboration").
function _corrobAtLeast(a, b) {
  a = a || {}; b = b || {};
  if (_tierRank(a.tier) !== _tierRank(b.tier)) return _tierRank(a.tier) > _tierRank(b.tier);
  if ((a.authority || 0) !== (b.authority || 0)) return (a.authority || 0) > (b.authority || 0);
  return (a.reports || 0) >= (b.reports || 0);
}

// Default deterministic agreement test (override via opts.relation). Edge: same predicate + same target
// identity. Value: normalized equality or mutual key-phrase containment. Anything else → contradicts.
function _agrees(claim, incumbent) {
  if (!claim || !incumbent) return false;
  if (claim.predicate != null || incumbent.predicate != null) {
    const samePred = _norm(claim.predicate) === _norm(incumbent.predicate);
    const co = claim.object || {}, io = incumbent.object || {};
    const sameObj = (co.ref != null && io.ref != null) ? String(co.ref) === String(io.ref) : _coreEq(co.name, io.name);
    return samePred && sameObj;
  }
  const a = _norm(claim.value), b = _norm(incumbent.value);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function _incumbentRetracted(incumbent, deps) {
  const nl = _newsLane(deps);
  const det = (nl && nl.detectRedactionSignal) || (() => null);
  const cites = (incumbent && incumbent.citations) || [];
  for (const c of cites) { if (c && det(c.title || c.snippet || '')) return true; }
  return !!(incumbent && incumbent.retracted);
}

// ── §4 reconcile(claim, incumbent) — the deterministic decision ─────────────────────────────────────────
// opts: { relation:'agree'|'contradict'|auto, resolution:'resolved'|'ambiguous'|'nil', now, deps }.
// Recency = as_of (effective date), WEIGHTED by ttl_class — volatile leans recency, stable/permanent lean
// corroboration. That closes the "internet said it once" hole.
function reconcile(claim, incumbent, opts = {}) {
  const deps = opts.deps || {};
  claim = claim || {};
  const cites = Array.isArray(claim.citations) ? claim.citations.filter(Boolean) : [];

  // (a) nothing enters long-term without a citation
  if (!cites.length) return { action: 'reject', reason: 'no-citation' };
  // (b) resolver said the entity is ambiguous → never write, ASK (bias-to-clarify)
  const resolution = opts.resolution || (claim.subject && claim.subject.resolution) || null;
  if (resolution === 'ambiguous') return { action: 'ask', reason: 'ambiguous-entity' };

  const sc = score(cites, deps);
  const ttl = claim.ttl_class || classifyTtl(claim.value, deps);

  // (c) events never supersede — they cluster/append (continuation handled by the news lane)
  if (claim.kind === 'event') return { action: 'append', reason: 'event', corroboration: sc };
  // (d) no incumbent → create new
  if (!incumbent || (opts.resolution === 'nil')) return { action: 'new', reason: 'no-incumbent', corroboration: sc };

  // agree vs contradict — caller may assert it (adapters often KNOW); else derive deterministically
  const agrees = opts.relation === 'agree' ? true : opts.relation === 'contradict' ? false : _agrees(claim, incumbent);
  if (agrees) return { action: 'merge', reason: 'agrees', corroboration: mergeCitations(incumbent, claim, deps) };

  // contradiction — TTL-weighted supersession
  const newer = _isNewer(claim.as_of, incumbent.as_of);
  const retracted = _incumbentRetracted(incumbent, deps);
  const incScore = incumbent.corroboration || { reports: incumbent.reports || 0, outlets: incumbent.outlets || 0, authority: incumbent.authority || 0, tier: incumbent.tier || 'none' };
  const supersedeRef = incumbent.ref != null ? incumbent.ref : (incumbent.id != null ? incumbent.id : null);

  if (ttl === 'volatile') {
    const bar = _tierRank(sc.tier) >= TIER_RANK.corroborated || sc.authority >= 3 || retracted;
    if (newer && bar) return { action: 'supersede', reason: retracted ? 'volatile-newer+retracted' : 'volatile-newer+corroborated', supersedes_ref: supersedeRef, corroboration: sc };
    return { action: 'ask', reason: 'volatile-contradiction-below-bar' };
  }
  // stable / permanent — supersede iff newer AND corroboration >= incumbent's (or the incumbent was retracted)
  if (newer && (_corrobAtLeast(sc, incScore) || retracted)) {
    // AMBIENT-LANE GUARD (opts.ambient): a fire-and-forget single read must NOT unilaterally RETIRE a stable
    // belief on recency alone — it must clear the same corroboration bar volatile uses (tier>=corroborated OR
    // authority>=3, or the incumbent retracted), else ASK (write nothing, keep the incumbent). Keeps a lone
    // autonomous page from dropping a held fact — incl. weakly/un-cited canonical facts whose surfaced
    // corroboration is 'none'. Deliberate lanes (recovery, chat-correction, news) leave opts.ambient unset.
    if (opts.ambient && !(_tierRank(sc.tier) >= TIER_RANK.corroborated || sc.authority >= 3 || retracted)) {
      return { action: 'ask', reason: 'ambient-stable-contradiction-below-bar' };
    }
    return { action: 'supersede', reason: 'stable-newer+corroborated', supersedes_ref: supersedeRef, corroboration: sc };
  }
  return { action: 'reject', reason: 'stable-contradiction-insufficient' };
}

// ── §5 precedence — which record does recall LEAD with? (the Pam-Bondi grounding gate) ──────────────────
// shortTermFact = a verified_facts row {value, as_of, ttl_class, tier, authority, status}. Returns
// 'short-term-wins' | 'long-term-wins' | 'merge'. Short-term WINS when it exists for this object AND cleared
// the §4 bar for its ttl_class; then recall leads with it and tags the conflicting Echo line superseded.
function precedence(shortTermFact, echoLine, opts = {}) {
  if (!shortTermFact) return 'long-term-wins';
  if (shortTermFact.status === 'superseded') return 'long-term-wins';   // this short-term fact was itself overturned
  const ttl = shortTermFact.ttl_class || classifyTtl(shortTermFact.value, opts.deps ? { staleness: opts.deps.staleness } : {});
  const cleared = ttl === 'volatile'
    ? (_tierRank(shortTermFact.tier) >= TIER_RANK.corroborated || (shortTermFact.authority || 0) >= 3)
    : true;   // a cited stable/permanent verified fact stands on its own
  if (!cleared) return 'long-term-wins';
  if (opts.agrees) return 'merge';
  return 'short-term-wins';
}

module.exports = { score, reconcile, precedence, classifyTtl, mergeCitations, TIER_RANK, _agrees, _isNewer, _corrobAtLeast, _outletOf };
