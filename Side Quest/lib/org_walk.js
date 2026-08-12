'use strict';
/**
 * lib/org_walk.js — the ORGANISATION research MOVE (the back half of the org lane).
 *
 * The Puller classifies org-shaped names as kind='org' (puller_db.js door + backfill) but never
 * RESEARCHES them — no worklist selects them, and the person research move is an email-fill cascade,
 * which is the wrong move for an org. This is the move that finally researches one: it takes an org
 * target with an ADMISSIBLE url (operator or Wikidata P856 — never a guess), fetches the site, proves
 * the page is theirs (org_site.verifyPage), and hands it to the EXISTING document pipeline as an
 * org_research document. Nothing here extracts facts; decompose already does that, under the V1 veto
 * and V2 surface-form retention. See docs/ORG_RESEARCH_LANE.md.
 *
 * Pure + dep-injected (mirrors lib/puller_walk.js runPullerMove) so the whole move is offline-testable:
 * every I/O — the candidate list, fetch, land, done-marker, the clock, the meta store — is a dep.
 *
 * ── NO DOMAIN GUESSING (the whole design). ──────────────────────────────────────────────────────
 * A url is admissible only from a source that ASSERTS it. org_site.acceptUrl enforces provenance
 * ('operator' | 'register'); resolveUrl re-validates every candidate through it, so a guessed hostname
 * cannot become an origin even if a caller mistakenly offers one.
 */

const orgSite = require('./org_site');

// Attempt cooldown TTLs (ms). A SUCCESSFUL research parks the org for a day; a BARREN attempt
// (no admissible url / verify refused / fetch failed) retries in 3h — a fruitless pass must never
// bench a viable org for a full day (the person lane learned this the hard way, puller_walk.js:33).
const ATTEMPT_TTL_MS = { ok: 24 * 60 * 60 * 1000, barren: 3 * 60 * 60 * 1000 };
const ATTEMPT_KEY = 'orgwalk.attempted';   // getMeta/setMeta JSON [[key, ts, ttl], …], TTL-pruned

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function attemptKeyOf(t) { return norm(`${t && t.name}|${t && (t.domain || t.crm_id || t.id || '')}`); }

// --- attempt cooldown (per-entry TTL) — mirrors puller_walk's visited set so a lane doesn't spin ---
function loadAttempted(getMeta, now) {
  let arr = [];
  try { arr = JSON.parse((getMeta && getMeta(ATTEMPT_KEY)) || '[]'); } catch {}
  const fresh = (Array.isArray(arr) ? arr : []).filter(
    (e) => Array.isArray(e) && (now - (Number(e[1]) || 0) < (Number(e[2]) || ATTEMPT_TTL_MS.barren))
  );
  return { set: new Set(fresh.map((e) => e[0])), arr: fresh };
}
function recordAttempt({ getMeta, setMeta, now, key, ttl }) {
  const { arr } = loadAttempted(getMeta, now);
  const entry = [key, now, ttl || ATTEMPT_TTL_MS.barren];
  const i = arr.findIndex((e) => e[0] === key);
  if (i >= 0) arr[i] = entry; else arr.push(entry);
  try { setMeta && setMeta(ATTEMPT_KEY, JSON.stringify(arr.slice(-500))); } catch {}
}

// --- pure: pick the org to research this move -----------------------------------------------------
// candidates: [{ id, name, domain, crm_id, status, researched, urlCandidates: [{url, provenance}] }].
// Drop already-researched, recently-attempted, or url-less orgs (no admissible url = not workable).
// Prefer CRM-linked (his actual orgs), then promoted. Pure.
function pickOrg(candidates, { attemptedKeys = new Set(), now = 0 } = {}) {
  const usable = (Array.isArray(candidates) ? candidates : []).filter((t) => {
    if (!t || !t.name || t.researched) return false;
    if (attemptedKeys.has(attemptKeyOf(t))) return false;
    if (!resolveUrl(t)) return false;                 // no admissible url → nothing to fetch
    return true;
  });
  if (!usable.length) return null;
  const score = (t) => (t.crm_id != null ? 10 : 0) + (t.status === 'promoted' ? 5 : 0);
  return usable.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

// --- pure: the FIRST admissible url from a target's candidate sources (no guessing) ---------------
// urlCandidates carry provenance; acceptUrl re-validates each. Returns { url, provenance } or null.
function resolveUrl(target) {
  for (const c of (target && target.urlCandidates) || []) {
    const acc = orgSite.acceptUrl(c && c.url, c && c.provenance);
    if (acc) return acc;
  }
  return null;
}

// --- the MOVE — one org, dep-injected I/O (mirrors runPullerMove) ---------------------------------
// deps: {
//   candidates:  () => [candidate] | [candidate]     — the worklist rows, url-enriched by the caller
//   getMeta, setMeta:  the meta store (cooldown)
//   now:         () => ms                              — injectable clock
//   fetchPage:   async (url) => { text, status }       — fetch + strip-to-text (caller owns network)
//   land:        async ({name,url,text,provenance}) => docId   — db.insertDocument(source:'org_research')
//   markResearched: async (target, url, docId) => void — upsertBelief(id,'official_site',…) done-marker
//   log:         (msg) => void
// }
async function runOrgMove(deps = {}) {
  const {
    candidates, getMeta, setMeta, now = () => Date.now(),
    fetchPage, land, markResearched, log = () => {},
  } = deps;
  const tNow = now();
  const cands = (typeof candidates === 'function' ? await candidates() : candidates) || [];
  const { set: attemptedKeys } = loadAttempted(getMeta, tNow);
  const pick = pickOrg(cands, { attemptedKeys, now: tNow });
  if (!pick) return { ok: true, did: false, note: 'no workable org target' };

  const key = attemptKeyOf(pick);
  const bench = (ttl) => recordAttempt({ getMeta, setMeta, now: tNow, key, ttl });

  const accepted = resolveUrl(pick);
  if (!accepted) { bench(ATTEMPT_TTL_MS.barren); return { ok: true, did: false, targetId: pick.id, note: 'no admissible url' }; }

  let page;
  try { page = await fetchPage(accepted.url); }
  catch (e) { bench(ATTEMPT_TTL_MS.barren); return { ok: false, did: false, targetId: pick.id, url: accepted.url, note: `fetch failed: ${e && e.message}` }; }

  const text = (page && page.text) || '';
  const v = orgSite.verifyPage(pick.name, text, { url: accepted.url });
  if (!v.ok) {
    bench(ATTEMPT_TTL_MS.barren);
    log(`[org-walk] verify REFUSED "${pick.name}" @ ${accepted.url} — ${v.why}`);
    return { ok: true, did: false, targetId: pick.id, url: accepted.url, note: `verify failed: ${v.why}` };
  }

  let docId = null;
  try { docId = await land({ name: pick.name, url: accepted.url, text, provenance: accepted.provenance }); }
  catch (e) { bench(ATTEMPT_TTL_MS.barren); return { ok: false, did: false, targetId: pick.id, url: accepted.url, note: `land failed: ${e && e.message}` }; }
  if (!docId) { bench(ATTEMPT_TTL_MS.barren); return { ok: false, did: false, targetId: pick.id, url: accepted.url, note: 'land returned no doc (empty body?)' }; }

  try { markResearched && (await markResearched(pick, accepted.url, docId)); } catch (e) { log(`[org-walk] markResearched failed: ${e && e.message}`); }
  bench(ATTEMPT_TTL_MS.ok);
  log(`[org-walk] RESEARCHED "${pick.name}" @ ${accepted.url} → doc:${docId} (${v.why})`);
  return { ok: true, did: true, targetId: pick.id, url: accepted.url, docId, provenance: accepted.provenance };
}

module.exports = {
  runOrgMove, pickOrg, resolveUrl, loadAttempted, recordAttempt, attemptKeyOf,
  ATTEMPT_TTL_MS, ATTEMPT_KEY,
};
