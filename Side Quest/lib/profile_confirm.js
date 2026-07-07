/**
 * lib/profile_confirm.js — CONFIRM which PUBLIC social/professional profile belongs to a contact, using
 * the reference headshot as a disambiguation signal (face-match Slice 2b).
 *
 * The flow is strictly: find candidate PUBLIC profiles the normal way (a name+org web SEARCH) → for each,
 * grab its public profile photo → face-compare against the contact's reference headshot → keep only the
 * matches. This is CONFIRMATION, never reverse-face-search: we only ever compare images the caller already
 * has (the reference headshot + a candidate profile photo found by name). Public info only; results are
 * grade-E observations upstream (verify-before-promote). Every I/O is injected → offline-smoke-testable.
 */
'use strict';

// Public professional / general platforms whose PROFILE URLs we accept as candidates. Path-shaped so a bare
// homepage or a search/hashtag page doesn't count as a profile.
const PLATFORMS = [
  { name: 'LinkedIn', re: /linkedin\.com\/in\/[a-z0-9%._-]{2,}/i },
  { name: 'X', re: /(?:twitter|x)\.com\/(?!home|search|hashtag|explore|i\/|intent\/)[a-z0-9_]{2,}\/?($|\?)/i },
  { name: 'GitHub', re: /github\.com\/[a-z0-9-]{2,}\/?($|\?)/i },
  { name: 'Instagram', re: /instagram\.com\/(?!p\/|explore\/|accounts\/)[a-z0-9_.]{2,}/i },
  { name: 'Facebook', re: /facebook\.com\/(?!sharer|dialog|login|search)[a-z0-9.]{3,}/i },
];
function platformOf(url) { const u = String(url || ''); for (const p of PLATFORMS) if (p.re.test(u)) return p.name; return null; }

// pure: the search query to surface a person's public profiles.
function buildProfileQuery(name, org) {
  const n = String(name || '').trim();
  const o = String(org || '').trim();
  return o ? `${n} ${o} linkedin OR twitter OR profile` : `${n} linkedin OR twitter OR profile`;
}

// pure: from search RESULTS ([{url,title,...}]) keep the ones that look like a public PROFILE, deduped by
// normalized url, capped. Returns [{url, platform, title}].
function pickProfileCandidates(results, { max = 6 } = {}) {
  const out = []; const seen = new Set();
  for (const r of (Array.isArray(results) ? results : [])) {
    const url = String((r && r.url) || '').trim();
    const platform = platformOf(url);
    if (!platform) continue;
    const key = url.split('#')[0].replace(/\/+$/, '').toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    out.push({ url, platform, title: String((r && r.title) || '').slice(0, 120) });
    if (out.length >= max) break;
  }
  return out;
}

// orchestration: search → candidates → per-candidate (grab profile photo → face-confirm) → matches.
// deps (all injected, live wiring in monologue):
//   search(query)              → [{url,title,...}]           (webSearch)
//   fetchProfileImage(url)     → imageUrl | null             (open the profile, grab its main photo)
//   confirmFace(refEmb, imgUrl)→ { same, similarity } | null (face_match.confirmAgainst on the two images)
//   refEmbedding               → the contact's reference face embedding (from the grabbed headshot)
// Returns { ok, matches:[{url,platform,similarity}], checked }. Never throws.
async function confirmProfiles(deps = {}) {
  const { name, org = null, refEmbedding, search, fetchProfileImage, confirmFace,
          max = 6, log } = deps;
  try {
    if (!Array.isArray(refEmbedding) || !refEmbedding.length) return { ok: false, reason: 'no-reference-embedding', matches: [], checked: 0 };
    if (typeof search !== 'function' || typeof fetchProfileImage !== 'function' || typeof confirmFace !== 'function') return { ok: false, reason: 'no-deps', matches: [], checked: 0 };
    let results = []; try { results = (await search(buildProfileQuery(name, org))) || []; } catch { results = []; }
    const candidates = pickProfileCandidates(results, { max });
    if (!candidates.length) return { ok: true, matches: [], checked: 0, reason: 'no-candidates' };
    const matches = []; let checked = 0;
    for (const c of candidates) {
      let imgUrl = null; try { imgUrl = await fetchProfileImage(c.url); } catch {}
      if (!imgUrl) continue;
      checked++;
      let v = null; try { v = await confirmFace(refEmbedding, imgUrl); } catch {}
      if (v && v.same) { matches.push({ url: c.url, platform: c.platform, imageUrl: imgUrl, similarity: v.similarity }); log && log(`[profile-confirm] ${c.platform} ${c.url} → MATCH (${(v.similarity || 0).toFixed(2)})`); }
    }
    return { ok: true, matches, checked };
  } catch (e) { return { ok: false, reason: 'error:' + (e && e.message), matches: [], checked: 0 }; }
}

module.exports = { buildProfileQuery, pickProfileCandidates, confirmProfiles, platformOf, PLATFORMS };
