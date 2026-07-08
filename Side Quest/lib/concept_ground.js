/**
 * lib/concept_ground.js — RESOLVE-OR-GROUND for entity mentions (Lucas's spec, 2026-07-07).
 *
 * The disease: when a mention didn't cleanly resolve, the resolver ASKED Lucas "which one?" — even for a
 * CONCEPT like "the AI arms race" (which had a junk namesake). That dumps disambiguation on the user and
 * stalls the run. The intended behavior: for a concept (or a mention we hold NO node for), she should say
 * "I don't have that grounded — standby", LOOK IT UP, and CREATE the node herself — VERIFIED if she finds a
 * citation, else an UNVERIFIED CONCEPT — then proceed with that node. She only ASKS when it's a genuine
 * collision of 2+ distinct PEOPLE (where a lookup can't tell which one he means).
 *
 * Split the usual way: a PURE decision (ask vs. ground vs. use) + a fail-soft IO grounder (deps injected).
 */
'use strict';

// Types where a 2+-candidate collision is a genuine "which one?" (a lookup can't disambiguate two real
// people who share a name) → keep the ASK. Everything else (concept/event/claim/topic/unknown) grounds.
const ASK_TYPES = ['person'];

// PURE: given a resolution outcome + its candidates, decide what to do.
//   { status: 'resolved'|'ambiguous'|'nil'|'error', candidates?: [{name,type}] } → 'use' | 'ask' | 'ground'
// resolved → use it. nil → ground (create it). ambiguous → ASK only when 2+ candidates are ASK_TYPES
// (distinct people); otherwise it's a concept/mixed collision → ground. error → 'use' (fail-safe: don't
// invent on a transport error; leave prior behavior).
function disambiguationAction({ status, candidates = [] } = {}) {
  if (status === 'resolved') return 'use';
  if (status === 'error') return 'use';
  if (status === 'nil') return 'ground';
  if (status === 'ambiguous') {
    const askable = (Array.isArray(candidates) ? candidates : [])
      .filter((c) => c && ASK_TYPES.includes(String(c.type || '').toLowerCase())).length;
    return askable >= 2 ? 'ask' : 'ground';
  }
  return 'use';
}

// Normalize a web-search result set → the best citation ({ title, url, snippet }) or null. PURE.
function pickCitation(results) {
  const rows = Array.isArray(results) ? results : (results && Array.isArray(results.results) ? results.results : []);
  for (const r of rows) {
    const url = r && (r.url || r.link || r.href);
    if (url && /^https?:\/\//i.test(String(url))) {
      return { title: String((r.title || r.name || '') || url).slice(0, 200), url: String(url), snippet: String(r.snippet || r.summary || r.text || '').slice(0, 600) };
    }
  }
  return null;
}

// Fail-soft IO: ground a mention by looking it up, and return a usable node — VERIFIED (with citation) if a
// source is found, else an UNVERIFIED CONCEPT. ALWAYS returns a usable node object so the caller can proceed
// (never throws, never blocks). Persisting to Echo (propose_entity) is fire-and-forget; a failed persist
// still yields the in-hand node. deps: { search(mention)→results, create(node)→any } injected for tests.
async function groundAndCreate(mention, { preferType = null, deps = {} } = {}) {
  const name = String(mention || '').trim();
  if (!name) return { ok: false, grounded: false, reason: 'empty' };
  const type = preferType || 'concept';

  let citation = null;
  try {
    if (typeof deps.search === 'function') citation = pickCitation(await deps.search(name));
  } catch { citation = null; }

  const verified = !!(citation && citation.url);
  const node = {
    name,
    type,
    verified,
    unverified: !verified,
    summary: (citation && citation.snippet) || '',
    source: (citation && citation.url) || null,
  };

  // Persist as a proposed entity (verified carries the source; unverified is a bare concept node). Best-
  // effort — never let a write failure block the run. The caller uses `node` regardless.
  try {
    if (typeof deps.create === 'function') {
      await deps.create({ name, entity_type: type, summary: node.summary, source: node.source, verified });
    }
  } catch { /* fire-and-forget */ }

  return { ok: true, grounded: true, verified, node, citation };
}

module.exports = { disambiguationAction, pickCitation, groundAndCreate, ASK_TYPES };
