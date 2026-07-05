/**
 * lib/puller_walk.js — the PULLER LANE of the subconscious: an autonomous move that fills MISSING
 * contact info for a person the operator is working. It's the sibling of graph_walk (which enriches a
 * node's KG facts) — both run on the idle tick, sharing ONE focus (the active-name set), so the
 * subconscious curates the graph AND the contacts together (Lucas: "graph walk and autonomously run
 * puller at the same time … together would be killer").
 *
 * One MOVE: pick a target missing an email → try to fill it, two ways —
 *   1. PATTERN-FILL — its company domain has a LEARNED email pattern (a landed roster taught it, e.g.
 *      @raineycenter.org) → derive the likely address (studio/puller_variants) → a pattern-tier belief.
 *      Cheap, no network. Only fires when the domain's belief clears a floor (a real learned lean).
 *   2. WEB-DISCOVERY — no usable pattern (or as the fallback) → web-search the person + org and extract a
 *      STATED email/phone from the results. Never invents — the value is cited to the source URL.
 * Whatever lands goes through addObservation + upsertBelief on the EXISTING target (NOT puller_ingest,
 * which is create-only and would skip an already-tracked person) with a certainty grade + citation, then
 * refreshes the person's card on the rail. Consume-only w.r.t. the CRM — this writes the Puller's own
 * discovered-facet, never electoral.contact.
 *
 * Pure orchestration with every I/O dep injected → offline-smoke-testable. Fail-soft: never throws; a
 * dead dependency just yields { acted:false }.
 */
'use strict';

const variants = require('../studio/puller_variants');
const beliefs = require('../studio/puller_beliefs');

// A target is a fill candidate when it has NO email yet. (Phone-only fills come later; email is the lever
// the mission and the pattern machinery are built around.)
const ATTEMPT_TTL_MS = 6 * 60 * 60 * 1000;   // don't re-attempt the same target for 6h (avoid burning moves on a stubborn one)
const ATTEMPT_KEY = 'pullerwalk.attempted';   // getMeta/setMeta JSON [[key, ts], …], TTL-pruned
const PATTERN_FLOOR = 0.45;                    // only pattern-fill when the domain has a real learned lean (not a bare prior)
const PROSPECT_TTL_MS = 24 * 60 * 60 * 1000;  // don't re-prospect the same org more than once a day
const PROSPECT_KEY = 'pullerwalk.prospected';
const MAX_NEW_PER_ORG = 5;                     // cap net-new targets minted per discovery move (quality > volume)

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function attemptKeyOf(t) { return norm(`${t && t.name}|${t && (t.company || t.domain || '')}`); }

// --- attempt cooldown (TTL) — mirrors graph_walk's visited set so a lane doesn't spin on one target ---
function loadAttempted(getMeta, now) {
  let arr = []; try { arr = JSON.parse((getMeta && getMeta(ATTEMPT_KEY)) || '[]'); } catch {}
  const fresh = (Array.isArray(arr) ? arr : []).filter(e => Array.isArray(e) && (now - (Number(e[1]) || 0) < ATTEMPT_TTL_MS));
  return { set: new Set(fresh.map(e => e[0])), arr: fresh };
}
function recordAttempt({ getMeta, setMeta, now, key }) {
  const { arr } = loadAttempted(getMeta, now);
  if (!arr.some(e => e[0] === key)) arr.push([key, now]);
  try { setMeta && setMeta(ATTEMPT_KEY, JSON.stringify(arr.slice(-500))); } catch {}
}

// --- pure: pick the target to work this move -------------------------------------------------------
// candidates: [{ id, name, company, domain, hasEmail, ts }]. Rank: skip has-email + recently-attempted;
// prefer ACTIVE-set members (the operator's focus), then domain-bearing (pattern-fillable), then most
// recently touched. Pure.
function pickTarget(candidates, { attemptedKeys = new Set(), activeKeys = new Set(), now = 0 } = {}) {
  const usable = (Array.isArray(candidates) ? candidates : []).filter((t) => {
    if (!t || !t.name || t.hasEmail) return false;
    if (attemptedKeys.has(attemptKeyOf(t))) return false;
    return true;
  });
  if (!usable.length) return null;
  const score = (t) => {
    let s = 0;
    if (activeKeys.has(norm(t.name))) s += 100;     // the operator's active neighborhood first
    if (t.domain) s += 10;                          // pattern-fillable → cheap win
    if (t.company) s += 3;
    s += Math.min(2, (Number(t.ts) || 0) / (now || 1) * 2);   // gentle recency nudge
    return s;
  };
  return usable.slice().sort((a, b) => score(b) - score(a))[0] || null;
}

// --- pure: pattern-fill candidate from a domain's learned belief ----------------------------------
// Returns { email, pattern, confidence } (confidence = the domain pattern's belief) or null if the
// domain has no learned lean above the floor. `tried` excludes emails already observed/bounced.
function patternFillCandidate(state, name, domain, { tried = [], floor = PATTERN_FLOOR } = {}) {
  if (!name || !domain) return null;
  const cands = variants.variantCandidates(state, name, domain, tried);
  const top = (cands || []).find(c => c && c.email && !c.isVariant) || (cands || [])[0];
  if (!top) return null;
  const belief = Number(top.belief) || 0;
  if (belief < floor) return null;                 // no real learned pattern → don't guess
  return { email: top.email, pattern: top.pattern, confidence: Math.max(0, Math.min(1, belief)) };
}

// --- pure: the web-discovery search query ----------------------------------------------------------
function buildContactSearchQuery(name, company) {
  const n = String(name || '').trim();
  const c = String(company || '').trim();
  return c ? `${n} ${c} email contact` : `${n} email contact`;
}

// --- pure: from extracted people, the row that matches our target (token overlap on the name) -------
function pickPersonRow(people, name) {
  const want = norm(name).split(' ').filter(Boolean);
  if (!want.length) return null;
  for (const p of (Array.isArray(people) ? people : [])) {
    const got = norm(p && p.name);
    if (!got) continue;
    const gotToks = new Set(got.split(' ').filter(Boolean));
    const overlap = want.filter(w => gotToks.has(w)).length;
    if (overlap >= Math.min(2, want.length) && (p.email || p.phone)) return { email: p.email || null, phone: p.phone || null };
  }
  return null;
}

// --- the MOVE — orchestrates pick → fill → land → refresh. Every I/O is an injected dep. Never throws.
// deps:
//   candidates()            → [{id,name,company,domain,hasEmail,ts}]   (live: puller_db targets + email-belief check)
//   activeKeys              → Set of normalized active-set names (the shared focus)
//   getPatternState(domain) → belief state
//   triedFor(targetId)      → [emails already observed] (so a re-fill doesn't re-offer a bounced address)
//   land(o)                 → void   {targetId,attr,value,kind,confidence,source,sourceUrl,derivation}
//   web(query)              → [{text,url,source}]   (graph_walk.fetchLayeredSources)
//   extract(text,{title})   → {people,places,events} (cloud contact extractor)
//   refresh(targetId)       → void   (rebuild + push the person's card)
//   observe(o)              → void   (curation store, optional)
//   getMeta/setMeta, now, log
async function runPullerMove(deps = {}) {
  const { candidates, activeKeys = new Set(), getPatternState, triedFor, land, web, extract,
          refresh, observe, getMeta, setMeta, now = () => Date.now(), log } = deps;
  const nowTs = now();
  try {
    const cands = (typeof candidates === 'function' ? await candidates() : candidates) || [];
    const { set: attemptedKeys } = loadAttempted(getMeta, nowTs);
    const pick = pickTarget(cands, { attemptedKeys, activeKeys, now: nowTs });
    if (!pick) return { acted: false, reason: 'no-target' };
    recordAttempt({ getMeta, setMeta, now: nowTs, key: attemptKeyOf(pick) });

    const doLand = async (o) => { if (typeof land === 'function') await land(o); };
    const doRefresh = async () => { if (typeof refresh === 'function') { try { await refresh(pick.id); } catch {} } };
    const doObserve = async (o) => { if (typeof observe === 'function') { try { await observe(o); } catch {} } };

    // 1) PATTERN-FILL — the domain's own learned email format
    if (pick.domain && typeof getPatternState === 'function') {
      let tried = []; try { tried = (typeof triedFor === 'function' ? await triedFor(pick.id) : []) || []; } catch {}
      const state = await getPatternState(pick.domain);
      const cand = patternFillCandidate(state, pick.name, pick.domain, { tried });
      if (cand) {
        const kind = cand.confidence >= 0.8 ? 'pattern' : 'guess';
        await doLand({ targetId: pick.id, attr: 'email', value: cand.email, kind, confidence: cand.confidence,
                       source: `pattern:${pick.domain}`, sourceUrl: `puller-pattern:${pick.domain}`, derivation: `pattern:${cand.pattern}` });
        await doObserve({ sourceEntity: pick.name, relation: 'email', target: cand.email, url: `puller-pattern:${pick.domain}`, grade: kind === 'pattern' ? 'C' : 'D', confidence: cand.confidence, status: 'promoted' });
        await doRefresh();
        log && log(`[puller-walk] pattern-fill ${pick.name} → ${cand.email} (${pick.pattern || cand.pattern}, ${Math.round(cand.confidence * 100)}%)`);
        return { acted: true, mode: 'pattern', targetId: pick.id, name: pick.name, email: cand.email, confidence: cand.confidence };
      }
    }

    // 2) WEB-DISCOVERY — search + extract a STATED contact (cited; never invented)
    if (typeof web === 'function' && typeof extract === 'function') {
      const q = buildContactSearchQuery(pick.name, pick.company);
      let sources = []; try { sources = (await web(q)) || []; } catch {}
      if (sources.length) {
        const text = sources.map(s => s && s.text).filter(Boolean).join('\n\n').slice(0, 6000);
        const url = (sources[0] && sources[0].url) || null;
        let cards = null; try { cards = await extract(text, { title: pick.name }); } catch {}
        const found = pickPersonRow((cards && cards.people) || [], pick.name);
        if (found && (found.email || found.phone)) {
          if (found.email) { await doLand({ targetId: pick.id, attr: 'email', value: found.email, kind: 'guess', confidence: 0.6, source: 'web', sourceUrl: url, derivation: 'web' });
                             await doObserve({ sourceEntity: pick.name, relation: 'email', target: found.email, url, grade: 'C', confidence: 0.6, status: 'promoted' }); }
          if (found.phone) { await doLand({ targetId: pick.id, attr: 'phone', value: found.phone, kind: 'guess', confidence: 0.6, source: 'web', sourceUrl: url, derivation: 'web' }); }
          await doRefresh();
          log && log(`[puller-walk] web-fill ${pick.name} → ${found.email || found.phone} (${url || 'no-url'})`);
          return { acted: true, mode: 'web', targetId: pick.id, name: pick.name, email: found.email || null, phone: found.phone || null, url };
        }
      }
    }

    return { acted: false, reason: 'no-fill', targetId: pick.id, name: pick.name };
  } catch (e) { log && log('[puller-walk] move failed: ' + (e && e.message)); return { acted: false, reason: 'error' }; }
}

// ===================================================================================================
// DISCOVERY MODE — when there's nothing left to enrich, PROSPECT: seed on an org already in the operator's
// focus, web-search its people, keep only the ones NOT already in the CRM/Puller, and mint them as new
// targets (the enrichment modes then fill their contact info). This is the "find new targets" engine —
// net-new people, seeded from orgs we already have (Lucas). Cooldown per org so it doesn't re-prospect.
// ===================================================================================================
function orgKeyOf(o) { return norm(o && (o.name || o)); }

// TTL cooldown for prospected orgs — same shape as the attempt set, separate key/TTL.
function loadProspected(getMeta, now) {
  let arr = []; try { arr = JSON.parse((getMeta && getMeta(PROSPECT_KEY)) || '[]'); } catch {}
  const fresh = (Array.isArray(arr) ? arr : []).filter(e => Array.isArray(e) && (now - (Number(e[1]) || 0) < PROSPECT_TTL_MS));
  return { set: new Set(fresh.map(e => e[0])), arr: fresh };
}
function recordProspected({ getMeta, setMeta, now, key }) {
  const { arr } = loadProspected(getMeta, now);
  if (!arr.some(e => e[0] === key)) arr.push([key, now]);
  try { setMeta && setMeta(PROSPECT_KEY, JSON.stringify(arr.slice(-500))); } catch {}
}

// pure: pick the org to prospect. orgs: [{name, domain?}] (the caller supplies them ACTIVE-first). Skip
// recently-prospected + junk names; prefer a domain-bearing org (its finds get a domain → pattern-fill later).
const _JUNK_ORG = /^(not reported|unknown|n\/?a|none|office of|the office)$/i;
function pickSeedOrg(orgs, { prospectedKeys = new Set() } = {}) {
  const usable = (Array.isArray(orgs) ? orgs : []).filter((o) => {
    const nm = String((o && o.name) || '').trim();
    if (nm.length < 3 || _JUNK_ORG.test(nm)) return false;
    if (prospectedKeys.has(orgKeyOf(o))) return false;
    return true;
  });
  if (!usable.length) return null;
  return usable.slice().sort((a, b) => (b.domain ? 1 : 0) - (a.domain ? 1 : 0))[0] || null;   // stable: domain-bearing first, else active order
}

// pure: the staff/roster search query for an org.
function buildOrgProspectQuery(org) {
  const n = String((org && org.name) || org || '').trim();
  return `${n} staff directory team leadership`;
}

// The DISCOVERY move. deps:
//   seedOrgs()               → [{name, domain?}]  (active orgs first)
//   filterNew(people)        → subset NOT already in CRM/Puller (the caller batches the dedup)
//   createTarget({name,company,domain,title,sourceUrl}) → new target id | null
//   web(query) → sources; extract(text,{title}) → {people,…}; land(o); refresh(id); observe(o)
//   getMeta/setMeta, now, log, maxNew
async function runDiscoveryMove(deps = {}) {
  const { seedOrgs, filterNew, createTarget, web, extract, land, refresh, observe,
          getMeta, setMeta, now = () => Date.now(), log, maxNew = MAX_NEW_PER_ORG } = deps;
  const nowTs = now();
  try {
    if (typeof web !== 'function' || typeof extract !== 'function' || typeof createTarget !== 'function') return { acted: false, reason: 'no-deps' };
    const orgs = (typeof seedOrgs === 'function' ? await seedOrgs() : seedOrgs) || [];
    const { set: prospectedKeys } = loadProspected(getMeta, nowTs);
    const seed = pickSeedOrg(orgs, { prospectedKeys });
    if (!seed) return { acted: false, reason: 'no-seed' };
    recordProspected({ getMeta, setMeta, now: nowTs, key: orgKeyOf(seed) });

    let sources = []; try { sources = (await web(buildOrgProspectQuery(seed))) || []; } catch {}
    if (!sources.length) return { acted: false, reason: 'no-sources', org: seed.name };
    const text = sources.map(s => s && s.text).filter(Boolean).join('\n\n').slice(0, 6000);
    const url = (sources[0] && sources[0].url) || null;
    let cards = null; try { cards = await extract(text, { title: seed.name }); } catch {}
    const people = (cards && cards.people) || [];
    if (!people.length) return { acted: false, reason: 'no-people', org: seed.name };

    let fresh = people;
    try { if (typeof filterNew === 'function') fresh = (await filterNew(people)) || []; } catch { fresh = []; }
    if (!fresh.length) return { acted: false, reason: 'no-new', org: seed.name };   // all already in CRM/Puller

    const created = [];
    for (const p of fresh.slice(0, maxNew)) {
      if (!p || !p.name) continue;
      let id = null;
      try { id = await createTarget({ name: p.name, company: seed.name, domain: seed.domain || null, title: p.title || null, sourceUrl: url }); } catch {}
      if (id == null) continue;
      created.push({ id, name: p.name });
      if (p.email && typeof land === 'function') { try { await land({ targetId: id, attr: 'email', value: p.email, kind: 'guess', confidence: 0.6, source: 'web', sourceUrl: url, derivation: 'web-prospect' }); } catch {} }
      if (typeof observe === 'function') { try { await observe({ sourceEntity: p.name, relation: 'works_for', target: seed.name, url, grade: 'C', confidence: 0.6, status: 'promoted' }); } catch {} }
      if (typeof refresh === 'function') { try { await refresh(id); } catch {} }
    }
    if (!created.length) return { acted: false, reason: 'no-create', org: seed.name };
    log && log(`[puller-walk] discovered ${created.length} new @ "${seed.name}" (${url || 'no-url'})`);
    return { acted: true, mode: 'discover', org: seed.name, created, count: created.length, url };
  } catch (e) { log && log('[puller-walk] discovery failed: ' + (e && e.message)); return { acted: false, reason: 'error' }; }
}

module.exports = {
  runPullerMove, runDiscoveryMove, pickTarget, patternFillCandidate, buildContactSearchQuery, pickPersonRow,
  pickSeedOrg, buildOrgProspectQuery, orgKeyOf, loadProspected, recordProspected,
  attemptKeyOf, loadAttempted, recordAttempt, norm,
  ATTEMPT_TTL_MS, ATTEMPT_KEY, PATTERN_FLOOR, PROSPECT_TTL_MS, PROSPECT_KEY, MAX_NEW_PER_ORG,
};
