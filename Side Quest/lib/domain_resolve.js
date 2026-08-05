'use strict';
/**
 * lib/domain_resolve.js — the SHARED org→domain resolver. Domain resolution is the universal bottleneck of
 * the whole contact-finding mission: pattern-fill needs a domain, Hunter needs a domain, and web-discovery
 * rarely finds an individual's address without landing on the org's own site first. Every engine (the Puller
 * move, the roster/list fill, Hunter) should draw on ONE resolver instead of each guessing — that's the
 * convergence (Lucas 2026-08-05: "does the puller already do this? stop reinventing"). [[whackamole-to-merge]]
 *
 * resolveDomain(org, {webSearch, log}) → a registrable domain string, or null. Order:
 *   1) SEED map — the operator's recurring orgs (energy / Louisiana politics), verified to resolve. Cheap,
 *      exact, extend as the beat grows. Same idea as Echo's KNOWN_CORP_DOMAINS.
 *   2) WEB-RESOLVE — search "<org> official website" via her working browser lane, take the registrable
 *      domain of the first NON-aggregator result (skips wikipedia/linkedin/ballotpedia/… so we get the org's
 *      own site, not a profile page). General; handles anything the seed map doesn't.
 * Pure except the injected webSearch → offline-smoke-testable. Never throws.
 */

// Directory / profile / aggregator hosts that are NOT an org's own domain — skip them in web-resolve so we
// don't hand Hunter "linkedin.com" as the company domain.
const AGGREGATOR_RE = /(?:^|\.)(?:wikipedia|wikimedia|wikidata|linkedin|facebook|twitter|instagram|threads|tiktok|youtube|ballotpedia|bloomberg|crunchbase|zoominfo|rocketreach|apollo|dnb|opencorporates|indeed|glassdoor|yellowpages|mapquest|yelp|google|bing|duckduckgo|amazon|pinterest|reddit|medium|substack|govtribe|usaspending|opensecrets|followthemoney|guidestar|propublica|sec|census|archive)\.[a-z.]+$|x\.com$/i;

// Seed map: normalized-needle → domain. Verified against Hunter this session where noted. Extend freely.
const SEED = [
  ['swepco', 'swepco.com'],
  ['southwestern electric power', 'swepco.com'],
  ['lsu', 'lsu.edu'],                              // verified: tyler.gray@lsu.edu
  ['louisiana state university', 'lsu.edu'],
  ['public service commission', 'lpsc.louisiana.gov'],
  ['lpsc', 'lpsc.louisiana.gov'],
  ['shreveport', 'shreveportla.gov'],             // verified: tom.arceneaux@shreveportla.gov
  ['mid-continent oil', 'lmoga.com'],
  ['lmoga', 'lmoga.com'],
  ['gulf states renewable', 'gsreia.org'],        // verified: mgerhart@gsreia.org
  ['gsreia', 'gsreia.org'],
  ['southern renewable energy alliance', 'srenewables.org'],
  ['cleco', 'cleco.com'],
  ['entergy', 'entergy.com'],
];

function _norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

// Host of a URL → its registrable domain (strip scheme, path, www; keep the last 2 labels, or 3 for a
// known 2-level public suffix like .gov.uk / .co.uk / .louisiana.gov-style state hosts we keep whole).
function registrableDomain(url) {
  let host = '';
  try { host = new URL(/^https?:\/\//i.test(url) ? url : `http://${url}`).hostname.toLowerCase(); }
  catch { return null; }
  if (!host) return null;
  host = host.replace(/^www\./, '');
  // Keep multi-label government/edu hosts intact (lpsc.louisiana.gov, cityofx.oh.us) — truncating them to
  // "louisiana.gov" would be wrong for Hunter. Heuristic: if it ends in a 2-letter cctld-style .us or a
  // .gov/.edu with 3+ labels, keep the whole host; otherwise take the last two labels.
  const labels = host.split('.');
  if (labels.length >= 3 && /\.(gov|edu|us|mil)$/.test(host)) return host;
  return labels.slice(-2).join('.');
}

function isAggregator(host) { return AGGREGATOR_RE.test(String(host || '')); }

// Seed-only lookup (pure, sync) — exposed for tests + a cheap first pass.
function seedDomain(org) {
  const k = _norm(org);
  if (!k) return null;
  for (const [needle, dom] of SEED) if (k.includes(_norm(needle))) return dom;   // normalize the needle too (hyphens/&)
  return null;
}

async function resolveDomain(org, { webSearch, log } = {}) {
  if (!org || !String(org).trim()) return null;
  const seed = seedDomain(org);
  if (seed) { log && log(`[domain] seed "${org}" → ${seed}`); return seed; }
  if (typeof webSearch === 'function') {
    try {
      const sr = await webSearch(`${org} official website`);
      for (const r of (sr && sr.results) || []) {
        const host = registrableDomain(r && r.url);
        if (host && !isAggregator(host)) { log && log(`[domain] web "${org}" → ${host} (${r.url})`); return host; }
      }
    } catch (e) { log && log(`[domain] web-resolve failed for "${org}": ${(e && e.message) || e}`); }
  }
  return null;
}

module.exports = { resolveDomain, seedDomain, registrableDomain, isAggregator, _norm };
