'use strict';
/**
 * lib/org_site.js — an organisation's OWN website: find it without guessing, and verify it is theirs.
 *
 * Lucas, 2026-07-21, on his own employer: *"why wouldn't these be researched by the program and then
 * properly linked?"* Measured answer: nothing in the system can research an organisation. The Puller
 * holds 271,334 targets and every one is `kind='person'` — so `The Joseph Rainey Center for Public
 * Policy` was enrolled as a PERSON and researched for an email address. 96% of Echo's organisations
 * have never been enrichment-attempted, and neither raineycenter.org nor raineyfreedom.org had ever
 * been fetched.
 *
 * This is the front half of the missing lane: get an organisation's real website, prove it is theirs,
 * and hand the page to the EXISTING document pipeline. Nothing here extracts facts — decompose already
 * does that, and it now carries the V1 veto and the V2 surface-form retention, so reusing it is
 * strictly better than growing a second extraction stack beside it.
 *
 * ── NO DOMAIN GUESSING. THIS IS THE WHOLE DESIGN. ───────────────────────────────────────────────
 *
 * "Rainey Center" → raineycenter.org looks irresistible and is exactly how this goes wrong. Guessing a
 * domain manufactures an ORIGIN, and origin is what the entire grading model rests on — a wrong one
 * would let some squatter's page corroborate claims about a real organisation. Compare the sites the
 * corpus already holds: `alconacountyfair.com` is not Alcona County, and `countynewscenter.com` is not
 * a county. A plausible-looking hostname is not evidence.
 *
 * So a URL may only come from somewhere that ASSERTS it:
 *   OPERATOR   Lucas hands it over — provenance is known even though there is no register behind it.
 *   REGISTER   Wikidata P856 "official website", for an entity we already resolved to a QID.
 * Anything else is refused, and refusing costs a fetch we can retry, while a wrong origin poisons the
 * grade of everything downstream of it.
 *
 * ── AND THE PAGE MUST STILL PROVE IT IS THEIRS ──────────────────────────────────────────────────
 *
 * Even an asserted URL gets checked: the fetched page must actually NAME the organisation. Domains
 * lapse, get parked, and get resold. `verifyPage` is the difference between "we were told this is
 * their site" and "this is their site".
 */

const STOP = new Set(['the', 'of', 'for', 'and', 'a', 'an', 'inc', 'llc', 'ltd', 'corp', 'co', 'company',
  'incorporated', 'foundation', 'project', 'center', 'centre', 'institute', 'association', 'group']);

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// The tokens that actually identify this organisation — the distinctive ones. "The Joseph Rainey Center
// for Public Policy" reduces to [joseph, rainey, public, policy]: dropping the generic nouns is what
// stops "Center" alone from matching every nonprofit page on the web.
function distinctiveTokens(name) {
  return norm(name).split(' ').filter((t) => t.length > 2 && !STOP.has(t));
}

/**
 * Where may a URL come from? Only a source that asserts it.
 *
 * `operator` — handed over by Lucas. `register` — Wikidata P856 on a resolved QID.
 * Returns { url, provenance } or null. A bare guess has no provenance and is refused here rather than
 * deeper in, where it would already have become an origin.
 */
function acceptUrl(url, provenance) {
  const u = String(url == null ? '' : url).trim();
  if (!u || !/^https?:\/\/[^\s]+$/i.test(u)) return null;
  if (provenance !== 'operator' && provenance !== 'register') return null;
  return { url: u, provenance };
}

/**
 * Does this page actually belong to this organisation?
 *
 * Requires the distinctive tokens to be present — ALL of them for a short name, and a clear majority
 * for a long one, since an org's own site will not omit its own name but a long formal name may be
 * rendered as a shorter mark ("Rainey Center" for "The Joseph Rainey Center for Public Policy").
 *
 * Returns { ok, matched, missing, why }. Never throws.
 */
function verifyPage(orgName, pageText, { minRatio = 0.6, url = null } = {}) {
  const toks = distinctiveTokens(orgName);
  const hay = norm(pageText);
  if (!toks.length) return { ok: false, matched: [], missing: [], why: 'no distinctive tokens in the org name' };
  if (!hay) return { ok: false, matched: [], missing: toks, why: 'empty page' };
  const matched = toks.filter((t) => new RegExp(`\\b${t}\\b`).test(hay));
  const missing = toks.filter((t) => !matched.includes(t));
  const ratio = matched.length / toks.length;

  // ── THE DOMAIN AND THE TEXT MUST AGREE ──────────────────────────────────────────────────────
  //
  // A token ratio over the FULL formal name is the wrong shape, and the real site proved it: the live
  // raineycenter.org homepage reads "Rainey Center Policy Polling News…" and contains neither "Joseph"
  // nor "public", so the formal name scored 2/4 and a correct page was refused.
  //
  // What actually identifies the organisation is its distinguishing token — "rainey" — and there is a
  // second, independent place that token appears: the HOSTNAME. Requiring the domain and the page text
  // to agree on one separates all three cases that matter, with no word-frequency table and no guessing:
  //
  //   parked raineycenter.org  → domain has "rainey", page does not      → refused
  //   brennancenter.org        → domain lacks "rainey"                   → refused
  //   real raineycenter.org    → both have "rainey"                      → verified
  //
  // Two sufficient conditions, either of which is honest evidence. The ratio still stands on its own
  // for an org whose domain is an acronym (tjrcpp.org), where the hostname can say nothing.
  const host = (() => { try { return url ? norm(new URL(url).hostname.replace(/^www\./, '').replace(/\.[a-z]+$/, '')) : ''; } catch { return ''; } })();
  const hostAgrees = host ? matched.filter((t) => host.includes(t)) : [];

  const need = toks.length <= 2 ? 1 : minRatio;
  const ok = hostAgrees.length > 0 || ratio >= need;
  return {
    ok,
    matched,
    missing,
    ratio: Math.round(ratio * 100) / 100,
    hostAgrees,
    why: hostAgrees.length
      ? `the domain and the page agree on "${hostAgrees.join('", "')}"`
      : (ok ? `page names the organisation (${matched.length}/${toks.length} distinctive tokens)`
        : `page does not name the organisation (${matched.length}/${toks.length}; missing ${missing.join(', ')})`),
  };
}

/**
 * The authority an organisation's own website carries about ITSELF.
 *
 * `ordinary`, deliberately — NOT `official`. A self-published page is a primary source about its own
 * identity, but it is one interested party talking about itself, and `official` in this model
 * "substitutes for roughly one ordinary source" (§6.3), which would let a single About page settle a
 * claim on its own. A `.gov` is a register; an advocacy org's site is a publisher.
 *
 * The one thing it IS authoritative for is that the organisation exists and calls itself this.
 */
const selfSiteAuthority = () => 'ordinary';

module.exports = { distinctiveTokens, acceptUrl, verifyPage, selfSiteAuthority, STOP };
