/* studio/puller_priors.js — Puller negative-signal v2: seed per-domain pattern priors.
 *
 * Bakes in what we already know about how specific domains format email (rocketreach / Hunter /
 * confirmed observations), generalized from the prospecting engagement. Seeding gives the belief
 * tracker a confident starting point — and is what ACTIVATES the gateway-block detector: a domain
 * with a strong prior that then only bounces is flagged infra, not pattern (puller_beliefs.looksInfraBlocked).
 *
 * seedInto() MERGES priors onto existing state (preserves any observed hits/misses), so it's safe to
 * re-run as new intel arrives. Unknown domains keep the uniform DEFAULT_PRIOR (no entry here).
 */
'use strict';
const B = require('./puller_beliefs');
const pdb = require('../lib/puller_db');

// domain → { pattern: prior }. Tech skews first.last / concatenated; utilities skew flast / f.last.
const PRIORS = {
  // --- tech / hyperscalers (strong first.last — also what makes infra-block detectable) ---
  'microsoft.com': { 'first.last': 0.90 },
  'apple.com': { 'first.last': 0.90 },
  'openai.com': { 'first.last': 0.85 },
  'ibm.com': { 'first.last': 0.85 },
  'amazon.com': { 'flast': 0.85, 'first.last': 0.10 },
  'google.com': { 'firstlast': 0.50, 'first.last': 0.40 },
  'meta.com': { 'firstlast': 0.85 },
  'salesforce.com': { 'first.last': 0.80 },
  'nvidia.com': { 'first.last': 0.80 },
  'cloudflare.com': { 'first.last': 0.75 },
  'akamai.com': { 'first.last': 0.75 },
  // --- energy / utilities (flast / f.last common) ---
  'aep.com': { 'flast': 0.70, 'first.last': 0.15 },
  'entergy.com': { 'f.last': 0.66, 'first.last': 0.20 },
  'bechtel.com': { 'flast': 0.78, 'first.last': 0.15 },
  'aes.com': { 'first.last': 0.80 },
  'gm.com': { 'first.last': 0.99 },
  'dominionenergy.com': { 'first.last': 0.75 },
  'nexteraenergy.com': { 'flast': 0.65 },
  'exeloncorp.com': { 'first.last': 0.70 },
  'constellation.com': { 'first.last': 0.70 },
  'avangrid.com': { 'first.last': 0.78 },
  'xcelenergy.com': { 'first.last': 0.70 },
  'enbridge.com': { 'first.last': 0.78 },
  'tcenergy.com': { 'flast': 0.65 },
  'sempra.com': { 'flast': 0.65 },
  'firstenergycorp.com': { 'flast': 0.65 },
  'pplweb.com': { 'flast': 0.65 },
  'tva.gov': { 'flast': 0.65 },
  // --- associations / orgs ---
  'datacentercoalition.org': { 'first': 0.65, 'first.last': 0.20 },
  'eei.org': { 'flast': 0.70 },
};

// Merge priors into the store (preserving observed hits/misses). Returns counts. Idempotent.
function seedInto(db = pdb) {
  let domains = 0, patterns = 0;
  for (const [domain, pats] of Object.entries(PRIORS)) {
    let st = db.getPatternState(domain);
    for (const [pattern, prior] of Object.entries(pats)) { st = B.seedPrior(st, pattern, prior); patterns++; }
    db.savePatternState(domain, st);
    domains++;
  }
  return { domains, patterns };
}

module.exports = { PRIORS, seedInto };
