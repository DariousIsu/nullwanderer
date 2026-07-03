/**
 * sources — the PURE provenance spine for the research deliverable's citations (Pillar 1).
 *
 * DECISION (Lucas): route provenance through ECHO's source tools (save_source → source_citations →
 * get_sources_for), so Echo owns the source store and it's reusable across the app. Echo doesn't solve
 * CAPTURE, though — the cloud operator only returns tool NAMES, not the URLs it read — so we capture by
 * EXTRACTING the real URLs from each pass's raw output plus the deep lane's structured-record references
 * (990 / FEC / our knowledge graph). This module is the pure half: extract → normalize → dedupe →
 * frontmatter (for save_source) → render the Sources section + inline [n] markers. The live Echo calls
 * (save_document, save_source, get_sources_for) live in main.js. Fail-safe: never throws on bad input.
 */
'use strict';

const str = (v) => (v == null ? '' : String(v));

// --- web URL extraction -----------------------------------------------------------------------------

// Match http(s) URLs in free text; trailing punctuation is trimmed by _cleanUrl.
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;

function domainOf(url) {
  const m = str(url).match(/^https?:\/\/([^/:?#]+)/i);
  return m ? m[1].replace(/^www\./i, '').toLowerCase() : '';
}

function _cleanUrl(u) {
  let s = str(u).trim().replace(/[.,;:!?]+$/, '').replace(/[)\]}>'"`]+$/, '');
  return s;
}
function _normKey(u) {
  // dedupe key: lowercase host + path, no www., no trailing slash, no fragment noise (so
  // "www.heritage.org/staff" and "heritage.org/staff/" collapse to one)
  const s = _cleanUrl(u).replace(/#.*$/, '');
  const m = s.match(/^https?:\/\/(.+)$/i);
  return (m ? m[1] : s).replace(/^www\./i, '').replace(/\/+$/, '').toLowerCase();
}

// Junk we never want as a citation (the org's own tool-control noise, localhost, search engines as a
// "source", bare image/asset links). Keep it conservative — better a slightly-noisy cite than a dropped one.
const JUNK_DOMAIN_RE = /^(localhost|127\.0\.0\.1|example\.(com|org)|google\.com|bing\.com|duckduckgo\.com)$/i;
const JUNK_PATH_RE = /\.(png|jpe?g|gif|svg|webp|ico|css|js)(\?|$)/i;

// Pull deduped, cleaned web sources from raw text. Returns [{ kind:'web', url, domain }].
function extractUrls(rawText) {
  const out = [];
  const seen = new Set();
  for (const raw of (str(rawText).match(URL_RE) || [])) {
    const url = _cleanUrl(raw);
    const domain = domainOf(url);
    if (!domain || JUNK_DOMAIN_RE.test(domain) || JUNK_PATH_RE.test(url)) continue;
    const key = _normKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: 'web', url, domain });
  }
  return out;
}

// --- structured-record references (the deep lane's authoritative pulls) ------------------------------

// The deep/structured lane pulls records the open web won't surface. We can't always get a URL for them,
// but we CAN cite the record class as provenance. Detect the named authoritative sources in deep raw.
const STRUCTURED_SOURCES = [
  { re: /\b(form\s*990|irs\s*990|990[- ]?(?:pf|ez)?)\b/i, label: 'IRS Form 990 filing' },
  { re: /\b(propublica)\b/i, label: 'ProPublica Nonprofit Explorer' },
  { re: /\b(fec|federal election commission)\b/i, label: 'FEC filings' },
  { re: /\b(usaspending|federal (?:grant|contract|funding))\b/i, label: 'USAspending federal funding' },
  { re: /\b(knowledge graph|our graph|kg_search|kg_neighborhood)\b/i, label: 'Our knowledge graph' },
  { re: /\b(edgar|sec filing)\b/i, label: 'SEC EDGAR filing' },
];

function structuredRefs(deepRaw) {
  const s = str(deepRaw);
  const out = [];
  const seen = new Set();
  for (const def of STRUCTURED_SOURCES) {
    if (def.re.test(s) && !seen.has(def.label)) { seen.add(def.label); out.push({ kind: 'structured', label: def.label }); }
  }
  return out;
}

// --- collect (one org's unified, deduped source list) -----------------------------------------------

// Merge web + structured sources for ONE entity into a single tagged, deduped list. `raw`/`webRaw` are
// scanned for URLs; `deepRaw` additionally for structured record classes.
function collectSources({ entity = '', raw = '', webRaw = '', deepRaw = '' } = {}) {
  const web = extractUrls(`${str(raw)}\n${str(webRaw)}\n${str(deepRaw)}`);
  const structured = structuredRefs(`${str(deepRaw)}\n${str(raw)}`);
  return [...web, ...structured].map(s => ({ ...s, entity: str(entity) }));
}

// --- frontmatter for save_source --------------------------------------------------------------------

// Build the Echo save_source frontmatter for one source. `collection_date` is REQUIRED by save_source;
// the caller passes capturedAt (no clock in this pure module). title falls back to the domain/label.
function frontmatterFor(source = {}, { capturedAt = '' } = {}) {
  const s = source || {};
  const isWeb = s.kind === 'web';
  return {
    source: isWeb ? str(s.url) : str(s.label),
    collection_date: str(capturedAt),
    title: isWeb ? (str(s.domain) || str(s.url)) : str(s.label),
    domain: isWeb ? str(s.domain) : 'structured',
    kind: str(s.kind || 'web'),
    entity: str(s.entity),
  };
}

// --- render -----------------------------------------------------------------------------------------

// A short label for a source line: "domain — entity" / "IRS Form 990 filing — entity".
function _label(s) {
  const who = str(s.entity) ? ` — ${str(s.entity)}` : '';
  return s.kind === 'web' ? `[${str(s.domain) || 'link'}](${str(s.url)})${who}` : `${str(s.label)} (structured)${who}`;
}

// Render the numbered "## Sources" section from a normalized source list (deduped across the whole run).
// Pure: the caller normalizes Echo's get_sources_for rows into {kind,url,domain,label,entity} first.
function renderSourcesSection(sources = []) {
  const list = dedupe(Array.isArray(sources) ? sources : []);
  if (!list.length) return '';
  const lines = list.map((s, i) => `${i + 1}. ${_label(s)}`);
  return `## Sources\n${lines.join('\n')}`;
}

// Run-wide dedupe across orgs (a URL cited for two orgs collapses to one numbered entry, entities merged).
function dedupe(sources = []) {
  const byKey = new Map();
  for (const s of (Array.isArray(sources) ? sources : [])) {
    if (!s) continue;
    const key = s.kind === 'web' ? _normKey(s.url) : `struct:${str(s.label).toLowerCase()}`;
    if (!key || key === 'struct:') continue;
    if (!byKey.has(key)) byKey.set(key, { ...s, entities: new Set([str(s.entity)].filter(Boolean)) });
    else { const e = byKey.get(key); if (str(s.entity)) e.entities.add(str(s.entity)); }
  }
  // collapse entities back to a single label
  return [...byKey.values()].map(s => {
    const entity = [...s.entities].join(', ');
    const { entities, ...rest } = s;
    return { ...rest, entity };
  });
}

// --- run-level (the deliverable finalize seam) ------------------------------------------------------

// Collect + run-wide dedupe the sources across ALL org sections of a run. sections = [{heading, body}]
// (lib/assemble.parseSections shape). Each section's URLs/structured-refs are attributed to its heading;
// a URL cited under two orgs collapses to one entry with both entities. Pure.
function collectRunSources(sections = []) {
  const all = [];
  for (const s of (Array.isArray(sections) ? sections : [])) {
    if (!s) continue;
    for (const src of collectSources({ entity: s.heading || s.title || '', raw: s.body || s.content || '' })) all.push(src);
  }
  return dedupe(all);
}
// Render the run-wide "## Sources" section (deduped across orgs) — the deliverable's citation trail. '' when none.
function renderRunSources(sections = []) {
  return renderSourcesSection(collectRunSources(sections));
}

module.exports = {
  URL_RE, domainOf, extractUrls, structuredRefs, collectSources,
  frontmatterFor, renderSourcesSection, dedupe, collectRunSources, renderRunSources,
};
