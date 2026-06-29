/* studio/puller_variants.js — Puller negative-signal v2: name + domain variant expansion (PURE).
 *
 * When pattern permutations on the obvious (name, domain) are exhausted, the next lever is VARIANTS:
 *  - nickname ↔ formal first names (Robert↔Bob, Elizabeth↔Liz/Beth) — the email may use the other form
 *  - subsidiary / alternate domains (amazon.com→aws.amazon.com, ibm.com→redhat.com)
 * `variantCandidates` crosses {domain variant × name variant × pattern} into a ranked, de-duped,
 * tried-excluded candidate list. Pure: reuses the deterministic derive + belief math in puller_beliefs.
 */
'use strict';
const B = require('./puller_beliefs');

// Bidirectional nickname groups — any member maps to all the others (formal + sibling nicknames).
const GROUPS = [
  ['robert', 'rob', 'bob', 'bobby'],
  ['william', 'will', 'bill', 'billy', 'liam'],
  ['richard', 'rick', 'rich', 'dick'],
  ['james', 'jim', 'jamie', 'jimmy'],
  ['john', 'jack', 'johnny'],
  ['michael', 'mike', 'mick'],
  ['charles', 'charlie', 'chuck'],
  ['thomas', 'tom', 'tommy'],
  ['joseph', 'joe', 'joey'],
  ['daniel', 'dan', 'danny'],
  ['matthew', 'matt'],
  ['christopher', 'chris'],
  ['anthony', 'tony'],
  ['edward', 'ed', 'eddie', 'ted'],
  ['david', 'dave'],
  ['stephen', 'steven', 'steve'],
  ['kenneth', 'ken', 'kenny'],
  ['benjamin', 'ben'],
  ['nicholas', 'nick'],
  ['alexander', 'alex'],
  ['andrew', 'andy', 'drew'],
  ['joshua', 'josh'],
  ['elizabeth', 'liz', 'beth', 'betty', 'eliza', 'lisa'],
  ['margaret', 'maggie', 'meg', 'peggy'],
  ['katherine', 'catherine', 'kate', 'katie', 'kathy', 'cathy'],
  ['jennifer', 'jen', 'jenny'],
  ['patricia', 'pat', 'patty', 'trish'],
  ['susan', 'sue', 'susie'],
  ['deborah', 'deb', 'debbie'],
  ['barbara', 'barb'],
  ['victoria', 'vicky', 'tori'],
  ['samantha', 'sam'],
];
const _index = new Map();
for (const g of GROUPS) for (const n of g) _index.set(n, g);

// Alternate first names for a given first name (excluding itself). [] if not a known nickname.
function nicknamesOf(first) {
  const f = String(first || '').toLowerCase();
  const g = _index.get(f);
  return g ? g.filter(n => n !== f) : [];
}

// Full-name variants with the FIRST token swapped to each known nickname/formal. Original first.
function nameVariants(name) {
  const toks = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return [String(name || '')];
  const out = [toks.join(' ')];
  for (const alt of nicknamesOf(toks[0])) {
    const t = toks.slice(); t[0] = alt; out.push(t.join(' '));
  }
  return out;
}

// Known parent → subsidiary / alternate domains (where corporate mail sometimes lives).
const SUBDOMAINS = {
  'amazon.com': ['aws.amazon.com'],
  'ibm.com': ['us.ibm.com', 'redhat.com'],
  'meta.com': ['fb.com', 'facebook.com'],
  'google.com': ['googlemail.com'],
  'alphabet.com': ['google.com'],
};
// The domain plus any known variants (base first).
function domainVariants(domain) {
  const d = String(domain || '').toLowerCase();
  if (!d) return [];
  return [d, ...((SUBDOMAINS[d] || []).filter(x => x !== d))];
}

// Cross {domain variant × name variant × pattern} into ranked candidates, de-duped by email and with
// `tried` emails excluded. `isVariant` marks rows that used a non-base name or domain. Ranked by the
// pattern belief (on the base domain's state), variants after equal-belief base rows.
function variantCandidates(state, name, domain, triedEmails = []) {
  const tried = new Set((triedEmails || []).map(e => String(e).toLowerCase()));
  const baseDomain = String(domain || '').toLowerCase();
  const baseName = String(name || '').trim();
  const seen = new Set();
  const out = [];
  for (const dv of domainVariants(domain)) {
    for (const nv of nameVariants(name)) {
      const variant = (nv !== baseName) || (dv !== baseDomain);
      for (const p of B.PATTERN_PRIORITY) {
        const email = B.deriveEmail(nv, dv, p);
        if (!email) continue;
        const key = email.toLowerCase();
        if (tried.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({ email, pattern: p, name: nv, domain: dv, isVariant: variant, belief: B.currentBelief(state, p) });
      }
    }
  }
  out.sort((a, b) => (b.belief - a.belief) || (a.isVariant === b.isVariant ? 0 : a.isVariant ? 1 : -1));
  return out;
}

module.exports = { nicknamesOf, nameVariants, domainVariants, variantCandidates, GROUPS, SUBDOMAINS };
