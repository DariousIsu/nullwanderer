/**
 * lib/staleness.js — freshness / TTL for banked facts (the self-heal completion).
 *
 * The write-back banks facts with an `as_of` date, but a banked fact ("the current Secretary of Defense is
 * Pete Hegseth") would otherwise be served from our DB FOREVER — confidently stale after the role turns
 * over. This assigns each fact a freshness window by TYPE (a current office-holder ages fast; a founding
 * date never ages) so the answer path can prefer RE-VERIFICATION over a stale value, and a background pass
 * can refresh aging facts. Pure + deterministic → fully unit-testable; `now` is injected (never Date.now
 * inside, so tests are stable).
 */
'use strict';

// Freshness windows in DAYS by fact type. null = permanent (never stale).
const TTL_DAYS = { volatile: 45, stable: 1460, permanent: null };

// A CURRENT role / office / rank / market fact — turns over, ages fast.
const _VOLATILE_RE = /\b(current(ly)?|incumbent|as of|president|ceo|c\.e\.o|chair(man|woman|person)?|director|secretary|administrator|minister|chancellor|governor|mayor|premier|leader|head of|price|ranking|rank(ed)?|standings?|champion|holder|serving as|in office|now)\b/i;
// A HISTORICAL / identity fact — fixed once it happened, never stale.
const _PERMANENT_RE = /\b(founded|founder|co-?founder|established|formed|incorporated|born|birth|died|death|inaugurated|created|discovered|invented|launched|first held|established in|since \d{4}|in \d{4}|on \d{1,2} [A-Z][a-z]+ \d{4}|\b\d{4}\b)\b/i;

// Classify a fact's freshness window from its text. volatile is checked FIRST — a "current president since
// 2025" fact is volatile (the role can change) even though it names a year. Returns days, or null (permanent).
function ttlDays(text) {
  const s = String(text || '');
  if (_VOLATILE_RE.test(s)) return TTL_DAYS.volatile;
  if (_PERMANENT_RE.test(s)) return TTL_DAYS.permanent;   // has a date/founding cue and no current-role cue
  return TTL_DAYS.stable;
}

// Age of an ISO/parseable date in days relative to `now` (ms). Unparseable → Infinity (treat as very old).
function ageDays(asOf, now) {
  const t = Date.parse(asOf);
  if (!Number.isFinite(t)) return Infinity;
  return (now - t) / 86400000;
}

// Is this banked fact past its freshness window? fact = { content|text, provenance:{as_of} }. Permanent
// facts are never stale; an UNDATED fact isn't flagged (we can't tell) → false. now = ms epoch (injected).
function isStale(fact, now) {
  if (!fact) return false;
  const ttl = ttlDays(fact.content || fact.text || '');
  if (ttl == null) return false;                          // permanent
  const asOf = fact.provenance && fact.provenance.as_of;
  if (!asOf) return false;                                // undated → can't judge
  return ageDays(asOf, now) > ttl;
}

// Partition banked facts into { fresh, stale } (volatile ones past TTL). Pure; for the background pass.
function partition(facts, now) {
  const fresh = [], stale = [];
  for (const f of (facts || [])) (isStale(f, now) ? stale : fresh).push(f);
  return { fresh, stale };
}

// --- CONTINUOUS FRESHNESS (Phase A4) -----------------------------------------
// Unlike isStale (a BINARY re-verify trigger), freshness is a RANKING WEIGHT in (0,1]: 1 = brand-new,
// decaying by half-life toward a FLOOR — "stale becomes HISTORICAL", never deleted, never 0. It's a
// READ-TIME function (compute when surfacing/ranking; no sweep, always current). Volatile things
// (news/events) decay fast; permanent facts never. `at` accepts an epoch (SECONDS or ms — heuristic) or
// an ISO/parseable date string; `now` = ms epoch (injected, so tests are stable).
const HALF_LIFE_DAYS = { volatile: 10, stable: 365, permanent: null };   // null → no decay (always ~1)

function _toMs(at) {
  if (at == null) return NaN;
  if (typeof at === 'number') return at < 1e12 ? at * 1000 : at;   // <1e12 → epoch seconds; else ms
  const p = Date.parse(at);
  return Number.isFinite(p) ? p : NaN;
}

function freshness(at, now, { halfLifeDays = HALF_LIFE_DAYS.volatile, floor = 0.05 } = {}) {
  if (halfLifeDays == null) return 1;                 // permanent → always fresh
  const ms = _toMs(at);
  if (!Number.isFinite(ms)) return floor;             // undatable → historical floor (not dropped)
  const ageD = (now - ms) / 86400000;
  if (ageD <= 0) return 1;                            // future / just-now → fully fresh
  const f = Math.pow(0.5, ageD / Math.max(0.01, Number(halfLifeDays)));
  return Math.max(floor, Math.min(1, f));
}

// Half-life (days) for a fact/event from its text class — reuses ttlDays' classifier so freshness and the
// binary TTL agree on what's volatile vs permanent. Returns null (no decay) for permanent facts.
function halfLifeFor(text) {
  const ttl = ttlDays(text);
  if (ttl == null) return HALF_LIFE_DAYS.permanent;
  return ttl === TTL_DAYS.volatile ? HALF_LIFE_DAYS.volatile : HALF_LIFE_DAYS.stable;
}

module.exports = { ttlDays, ageDays, isStale, partition, freshness, halfLifeFor, TTL_DAYS, HALF_LIFE_DAYS, _VOLATILE_RE, _PERMANENT_RE };
