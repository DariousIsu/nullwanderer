'use strict';
// lib/relevance.js — domain-relevance gate for autonomous ingest (auto-PDF harvest + doc decompose).
//
// WHY: the auto-harvest (lib/web.js) grabs every PDF on every page she reads; the downloads watcher
// (main.js) decomposes anything that lands. With no relevance check, landing on a foreign parliamentary
// archive index makes her vacuum the whole series (SA, Namibia, …) and flood the graph with off-domain
// entities. This gate stops the INDISCRIMINATE vacuum while letting through anything tied to Lucas's
// actual domain (US civic/legislative + energy/environment policy) or his active research foci.
//
// DESIGN: LENIENT (let-it-in bias). The POSITIVE signal is US/Lucas-SPECIFIC on purpose — generic
// government words (committee, member, democratic party, election) appear in foreign parliaments too, so
// they are NOT positive signals. Relevant if a US-strong term, a subject term, a live focus term, OR a
// US host matches. Block ONLY a clear foreign-government source with zero domain overlap. Everything with
// no signal at all is allowed (weak) — the per-host flood-breaker (in web.js) catches bulk-vacuum abuse.
// Deterministic, no network/model call, fail-soft.

let _interests = null;
try { _interests = require('./interests'); } catch { /* optional */ }

// US/Lucas-SPECIFIC positive markers — things that essentially never appear in a foreign parliament roster.
const US_STRONG = [
  'united states', 'u.s.', 'u. s.', 'american', 'washington, d.c', 'washington dc', ' d.c.',
  'federal election commission', ' fec ', 'securities and exchange commission', 'internal revenue service',
  'environmental protection agency', ' epa ', 'department of energy', 'department of justice',
  'department of the interior', 'fast-41', 'permitting reform', 'end epa abuse', 'inflation reduction act',
  'united states senate', 'u.s. senate', 'u.s. house', 'united states congress', 'u.s. congress',
  'house of representatives of the united states', 'supreme court of the united states', 'scotus',
  'bioguide', 'ocd-person', 'ocd-division', 'legiscan', 'congress.gov',
];
// Lucas's SUBJECT domain — relevant regardless of country, but absent from parliamentary interest registers.
const DOMAIN_SUBJECT = [
  'energy', 'permitting', 'nuclear power', 'pipeline', 'renewable', 'solar power', 'wind power',
  'fossil fuel', 'power grid', 'emissions', 'carbon', 'clean energy', 'oil and gas', 'electric utility',
  'campaign finance', 'super pac', 'redistricting', 'gerrymander', 'lobbying disclosure',
  'ai arms race', 'artificial intelligence', 'forecast', 'midterm', 'environmental law institute', 'rainey',
];

// US-relevant hosts (positive). Last-label gov/mil/us → US government; plus known US civic sources.
const US_HOST_RE = /(?:^|\.)(?:gov|mil|us)$|congress\.gov|senate\.gov|house\.gov|fec\.gov|whitehouse\.gov|govinfo|federalregister|regulations\.gov|courtlistener|propublica|opensecrets|ballotpedia|legiscan|govtrack/i;
// Foreign-government / non-US parliament markers (host OR content).
const FOREIGN_GOV_RE = /parliament|national\s*assembly|provincial\s*legislature|assembl[eé]e\s*nationale|bundestag|riksdag|lok\s*sabha|knesset|\.gov\.(?:za|na|ng|ke|uk|au|in|pk|gh|zm|zw|bw|ug|tz|rw|mw|ca|nz)\b|\.(?:za|na|ng|ke|gh|zm|zw|bw|ug|tz|rw|mw)(?:[\/:?#]|$)/i;

function normHost(u) { try { return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } }

function _dynamicTerms(db) {
  const out = [];
  try {
    const keys = (db && db.getMetaKeysLike) ? db.getMetaKeysLike('focus.%intended_targets') : [];
    for (const k of keys) {
      try { const v = JSON.parse(db.getMeta(k) || '[]'); if (Array.isArray(v)) for (const s of v) if (s) out.push(String(s)); } catch { /* skip */ }
    }
  } catch { /* skip */ }
  try {
    const rows = (_interests && _interests.getActive) ? _interests.getActive() : [];
    for (const r of rows) { const t = r && (r.topic || r.name || r.label || r.term || r.title); if (t) out.push(String(t)); }
  } catch { /* skip */ }
  return out;
}

let _cache = null;   // { allow:[], at, dynamic }
function getProfile(db, { maxAgeMs = 30 * 60 * 1000 } = {}) {
  const now = Date.now();
  if (_cache && (now - _cache.at) < maxAgeMs) return _cache;
  const dyn = _dynamicTerms(db).map(s => s.toLowerCase().trim()).filter(s => s.length >= 4 && s.length <= 60);
  const allow = Array.from(new Set([...US_STRONG, ...DOMAIN_SUBJECT, ...dyn].map(t => t.toLowerCase())));
  _cache = { allow, at: now, dynamic: dyn.length };
  return _cache;
}
function resetCache() { _cache = null; }

function _hits(text, terms) {
  const s = ' ' + String(text || '').toLowerCase().replace(/\s+/g, ' ') + ' ';
  const hit = [];
  for (const t of terms) {
    if (!t) continue;
    const needle = (t.includes(' ') || t.length >= 6) ? t : (' ' + t + ' ');
    if (s.includes(needle)) { hit.push(t.trim()); if (hit.length >= 8) break; }
  }
  return hit;
}

// assess a candidate {url?, pageUrl?, text?, filename?} → { relevant, score, hits, reason }
function assess(cand, profile) {
  const { url, pageUrl, text, filename } = cand || {};
  const p = profile || getProfile(null);
  const host = normHost(url) || normHost(pageUrl);
  const blob = `${filename || ''} ${text || ''} ${url || ''}`;
  const hits = _hits(blob, p.allow);
  const usHost = US_HOST_RE.test(host);
  const foreign = FOREIGN_GOV_RE.test(host) || FOREIGN_GOV_RE.test(String(pageUrl || '')) || FOREIGN_GOV_RE.test(blob);
  if (hits.length > 0) return { relevant: true, score: hits.length + (usHost ? 2 : 0), hits };
  if (usHost) return { relevant: true, score: 2, hits: [], usHost: true };
  if (foreign) return { relevant: false, score: 0, reason: `foreign-gov signal${host ? ' (' + host + ')' : ''}, no domain match` };
  return { relevant: true, score: 0, weak: true, reason: 'no domain signal (allowed, weak)' };
}

module.exports = { getProfile, resetCache, assess, US_STRONG, DOMAIN_SUBJECT, US_HOST_RE, FOREIGN_GOV_RE, normHost };
