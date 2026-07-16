'use strict';
/**
 * lib/civic_canon.js — CANONICAL REGISTRY for the closed set of top-level civic "hub" bodies
 * (docs/NODE_RESOLUTION_FUSION_GATE_DESIGN.md §4 canonicalization, follow-on #2 retrieval fix).
 *
 * WHY: the resolver resolves a mention through search_entities (BM25+ANN). For a hub body like the U.S.
 * Senate this fails on SURFACE FORM — "United States Senate" (as a doc extracts it) buries/misses the
 * canonical node "U.S. Senate", so every re-ingest RE-MINTS a duplicate instead of reusing. The general
 * gate is precision-first and (correctly) will not fuzzy-merge two same-name orgs, so the fix for this
 * narrow-but-high-value class is a CURATED authority file: a small, explicit alias→canonical map for the
 * hub bodies only. Everything NOT in the registry keeps the conservative default behavior — so this can
 * only ADD deterministic resolution for a hand-verified closed set; it never loosens precision elsewhere.
 *
 * SHAPE: resolveCanon(name, type?) → { canonical, type, wikidata, aliases } | null. The gate wiring
 * (Slice 2) attaches the entry's `wikidata` id to the incoming record so the gate's Tier-1 strong-id path
 * merges into the seeded QID-tagged canonical node (Slice 3 seeds those). PURE (no I/O) → offline-testable.
 *
 * PRECISION RULES baked in:
 *   • ONLY unambiguous US-federal surface forms are aliases — never bare "senate"/"house"/"congress"
 *     (a state senate / the Indian National Congress must NOT collide with the federal body).
 *   • a `person`-typed mention never canon-routes (a person is never a government body).
 */

// Abbreviation-tolerant normalizer: lowercase, strip [tags] + (parentheticals) + punctuation, and expand the
// high-confidence civic abbreviations that actually cause the misses. Deliberately SMALL — only expansions
// that are unambiguous in civic naming (US↔United States, &↔and, a few dept/govt forms). Nothing that could
// silently rewrite a distinct real name.
function normalizeCivic(name) {
  let s = String(name == null ? '' : name).toLowerCase();
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');   // drop id tags + jurisdiction parentheticals
  s = s.replace(/&/g, ' and ');
  s = s.replace(/[^a-z0-9]+/g, ' ');                              // punctuation → space (also splits "u.s." → "u s")
  const toks = s.split(/\s+/).filter(Boolean);
  const WORD = { dept: 'department', govt: 'government', natl: 'national' };
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === 'u' && toks[i + 1] === 's' && toks[i + 2] === 'a') { out.push('united', 'states'); i += 2; continue; }
    if (t === 'u' && toks[i + 1] === 's') { out.push('united', 'states'); i += 1; continue; }   // "u s" ← "U.S."
    if (t === 'usa' || t === 'us') { out.push('united', 'states'); continue; }
    out.push(WORD[t] || t);
  }
  return out.join(' ').trim();
}

// The registry. Each entry: canonical display name, core type, Wikidata QID (VERIFY before the Slice-3 seed
// writes it), and the explicit alias surface forms (stored pre-normalization; matched via normalizeCivic).
// FEDERAL TRIO first (the demonstrated misses); state legislatures + chambers are a follow-on slice.
const REGISTRY = [
  {
    canonical: 'United States Senate', type: 'government_body', wikidata: 'Q66096',
    aliases: ['United States Senate', 'U.S. Senate', 'US Senate', 'Senate of the United States'],
  },
  {
    canonical: 'United States House of Representatives', type: 'government_body', wikidata: 'Q11701',
    aliases: ['United States House of Representatives', 'U.S. House of Representatives', 'US House of Representatives',
      'House of Representatives of the United States'],
  },
  {
    canonical: 'United States Congress', type: 'government_body', wikidata: 'Q11268',
    aliases: ['United States Congress', 'U.S. Congress', 'US Congress', 'Congress of the United States'],
  },
];

// alias-key (normalized) → entry. Built once. A collision across two entries is a registry authoring bug and
// throws at load (fail-loud) so we never silently canon-route one body to another.
const _INDEX = (() => {
  const idx = new Map();
  for (const e of REGISTRY) {
    const keys = new Set([normalizeCivic(e.canonical), ...e.aliases.map(normalizeCivic)]);
    for (const k of keys) {
      if (!k) continue;
      if (idx.has(k) && idx.get(k) !== e) throw new Error(`civic_canon: alias collision on "${k}" between ${idx.get(k).canonical} and ${e.canonical}`);
      idx.set(k, e);
    }
  }
  return idx;
})();

// Compatible object types for canon-routing. A hub body may be extracted as government_body / organization /
// committee (these blur in extractors); never as a person (hard guard).
const _COMPAT_TYPE = new Set(['government_body', 'organization', 'committee', '']);

// resolveCanon(name, type?) → the canonical entry, or null. Name-driven; `type` only used as a NEGATIVE guard
// (a person-typed mention never routes). Returns the SAME frozen entry object for identical inputs.
function resolveCanon(name, type) {
  const t = String(type || '').toLowerCase();
  if (t === 'person') return null;
  if (t && !_COMPAT_TYPE.has(t)) return null;
  const key = normalizeCivic(name);
  if (!key) return null;
  return _INDEX.get(key) || null;
}

module.exports = { normalizeCivic, resolveCanon, REGISTRY };
