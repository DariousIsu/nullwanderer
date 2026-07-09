'use strict';
/**
 * lib/corroboration.js — C2 of the confidence engine (see
 * docs/AUTONOMOUS_SELF_CURATING_DB_ARCHITECTURE.md §Step-2).
 *
 * A fact's confidence should RISE with INDEPENDENT corroboration — but only
 * independent sources count. Wikipedia + three sites that mirror Wikipedia is
 * ONE source, not four; a wire story reprinted by 50 papers is one. Counting
 * raw URLs would manufacture a self-echo-chamber (the highest-risk failure the
 * audit flagged: ~80% of walk citations are a single Wikipedia URL).
 *
 * Pure + deterministic — the classical "middle" of the LLM×classical funnel.
 * No LLM, no DuckDB: this is the collapse+count logic a DuckDB analytical pass
 * would run at scale; here it runs per-fact in-process, exhaustively
 * offline-smoke-testable.
 */

// Host families that republish ONE upstream source. Every host matching a
// family collapses to that family id, so N mirrors count as 1 independent
// source. Deliberately conservative — only well-known mirror/aggregator sets.
const MIRROR_FAMILIES = [
  // Wikimedia + the encyclopedias that mirror it (Wikiwand, DBpedia, Wikidata,
  // Wikiquote/-source, localized + mobile Wikipedia).
  { family: 'wikimedia', re: /(?:^|\.)(?:wikipedia|wikimedia|wikiwand|dbpedia|wikidata|wikisource|wikiquote|everipedia)\.(?:org|com)$/i },
  // Congressional/official mirrors of the same upstream record.
  { family: 'congress-gov', re: /(?:^|\.)(?:congress\.gov|govinfo\.gov|gpo\.gov)$/i },
  // Ballotpedia + its scrape mirrors would go here as they surface.
];

// Strip a leading www./m./amp./mobile. subdomain so mirrors on the mobile host
// don't read as a distinct source.
function _stripCommonSub(host) {
  return String(host || '').toLowerCase().replace(/^(?:www|m|amp|mobile|en|de|fr|es)\./, '');
}

// Parse the host out of a URL/string. Fail-soft: returns '' for junk.
function hostOf(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : `http://${s}`);
    return u.hostname.toLowerCase();
  } catch {
    // last-ditch: pull a domain-looking token
    const m = /([a-z0-9-]+(?:\.[a-z0-9-]+)+)/i.exec(s);
    return m ? m[1].toLowerCase() : '';
  }
}

// Registrable domain (naive eTLD+1). Handles the common two-level public
// suffixes (co.uk, org.uk, gov.uk, com.au, co.jp, …) so bbc.co.uk is one
// domain, not "co.uk". Good enough for corroboration independence; a full PSL
// is overkill here.
const _TWO_LEVEL_TLD = /\.(?:co|com|org|net|gov|edu|ac|gov)\.(?:uk|au|jp|nz|in|za|br|kr)$/i;
function registrableDomain(url) {
  const host = _stripCommonSub(hostOf(url));
  if (!host) return '';
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastThree = labels.slice(-3).join('.');
  if (_TWO_LEVEL_TLD.test('.' + lastThree.split('.').slice(-2).join('.')) || _TWO_LEVEL_TLD.test('.' + labels.slice(-2).join('.'))) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

// The independence key for a single source: its mirror-family if known, else
// its registrable domain. Two sources with the SAME key are NOT independent.
function sourceFamily(url) {
  const host = hostOf(url);
  if (!host) return '';
  for (const fam of MIRROR_FAMILIES) if (fam.re.test(host)) return `fam:${fam.family}`;
  const dom = registrableDomain(url);
  return dom ? `dom:${dom}` : '';
}

// Count INDEPENDENT sources in a source set (list of urls / {url} objects).
// Collapses mirrors + same-domain copies. Empty/junk urls are ignored.
function independentSources(sourceSet) {
  const fams = new Set();
  for (const s of (Array.isArray(sourceSet) ? sourceSet : [])) {
    const url = (s && typeof s === 'object') ? (s.url || s.href || '') : s;
    const key = sourceFamily(url);
    if (key) fams.add(key);
  }
  return { count: fams.size, families: [...fams].sort() };
}

// Convenience: the corroboration count (independent-source count) for a fact.
function corroborationCount(sourceSet) {
  return independentSources(sourceSet).count;
}

module.exports = {
  MIRROR_FAMILIES, hostOf, registrableDomain, sourceFamily,
  independentSources, corroborationCount,
};
