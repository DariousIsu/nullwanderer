/**
 * lib/echo_tier.js — the Echo capability TIER + the curated READ menu (the "read wide / gate write /
 * heavy off-auto" horizon, made concrete).
 *
 * Two jobs, both pure (no Echo connection, fully offline-testable):
 *   1) classifyTool(name) → 'read' | 'write' | 'heavy' | 'locked'  — what KIND of Echo tool this is.
 *      The autonomous research loop may use READ tools freely; WRITE (mutates Echo's system-of-record),
 *      HEAVY (spawns background agents/workflows), and LOCKED (email-send / image-gen) are blocked on
 *      the auto loop. Interactive turns (Lucas present) allow read+write+heavy; LOCKED is never allowed.
 *      SAFE DEFAULT: an UNKNOWN tool is treated as 'write' (blocked on auto) — the auto loop is an
 *      allowlist, not a denylist, so a new/renamed Echo tool can't silently mutate state unattended.
 *   2) READ_TOOLS — a curated set of high-value Echo READ tools promoted to FIRST-CLASS operator tools,
 *      so the cloud operator reaches for the right structured source deliberately (a nonprofit's 990s,
 *      federal funding, our own knowledge graph) instead of defaulting to a web scrape. The generic
 *      `echo` need-router still covers the long tail of the 500+ surface.
 *
 * This is the single source of truth: lib/operator.js builds the tool MENU from READ_TOOLS, main.js
 * builds the EXECUTORS from the same list, and lib/echo_suit.js enforces the tier on dispatch/routeNeed.
 */
'use strict';

// --- tier classification -----------------------------------------------------

// LOCKED — never allowed anywhere on the model's initiative (Lucas's two standing kill-switches).
const LOCKED_RE = /(?:^|_)(send_email|email_send|send_mail|generate_image|image_gen|create_image|gen_image)\b/i;
// HEAVY — spawns background agents / workflows / heavy delegation. Off the AUTONOMOUS loop (usable
// interactively when Lucas is present), because one tag can fan out into a fleet of cloud agents.
const HEAVY_RE = /^(spawn_agent|spawn_agent_async|spawn_workflow|team_spawn|agent_fire|hire_card|propose_hire|run_pass|run_engagement_auto_promotion|delegate_to_)/i;
// PROPOSE — a NON-COMMITTING, verification-gated write: propose_entity / propose_relation /
// propose_link / propose_question_concept only enqueue a PENDING proposal that Echo (and Lucas)
// gate before it enters the system-of-record. Because it can never directly mutate, it is safe on
// the AUTONOMOUS loop — this is what lets the subconscious graph-builder grow the KG unattended
// while promotion stays gated. (propose_hire is HEAVY, caught above — it spawns an agent.)
const PROPOSE_RE = /^propose_(entity|relation|link|question_concept)$/i;
// WRITE — mutates Echo's system-of-record (the KG, the vault, CRM, hubs, QR, the desktop/browser, a
// live capture/session). Blocked on auto; allowed interactively (Echo applies its own verification +
// Lucas gate on proposals). Also: os_* desktop control and browser_* session writes live here.
// NB: run_recipe is intentionally NOT here — recipes are curated, pre-validated read/compile procedures
// (the routeNeed path prefers them), so the `recipe` dispatch path is allowed on the auto loop.
const WRITE_RE = /^(propose_|ingest_|save_|update_|merge_|delete_|set_|add_|link_|unlabel_|label_|import_|certify_|archive_|decide_|approve_|resolve_|reindex|repair_|rename_|move_|materiali[sz]e|record_|convert_|split_|revoke_|os_|gui_do|browser_(click|fill|navigate|open_session|save_auth|close_session)|attend_session_(start|stop)|transcription_(capture_start|capture_stop|start|session_delete|delete_|save_voiceprint|rename_|propose_|confirm_|rediarize)|hub_(create|update|delete|link|set|social|asset)|qr_(save|generate|archive|clone|bulk|apply|import|export)|calendar_add|create_|spawn_)/i;
// READ — clearly non-mutating lookups/retrievals. The allowlist that the auto loop is permitted to use.
// db_query is Echo's SELECT-ONLY database query (parse-time rejects INSERT/UPDATE/DELETE/DDL/PRAGMA/
// multi-statement) — a first-class READ surface over the whole Echo DB, safe on the auto loop.
const READ_RE = /^(search|get_|list_|find_|describe_|quick_lookup|lookup|kg_|query_|db_query|graph_overview|stats\b|summarize_|audit_|cite_|score_|verify_|wayback|web_search|web_fetch|web_extract|web_resolve|academic_search|arxiv_search|recent_|fetch_feed|sql_cache_recall|knowledge_neighborhood|bill_lookup|bill_facets|contact_facets|represent_|civic_coverage|get_sources_for|propublica_nonprofit_(search|get)|fec_|usaspending_|edgar_|courtlistener_|legiscan_|fr_(search|get|agency)|ecfr_|gdelt_|openfda_|clinicaltrials_|ncbi_|mediawiki_|loc_(gov|names|subjects|authority)|gov_(search|get|list|recent|portals)|socrata_|ckan_|odata_|sdmx_|wb_|un_population|census_|geonames_|nws_|noaa_|usgs_|opensanctions_|ofac_|nvd_|cert_)/i;

// What kind of tool is this? Pure. Order: LOCKED → HEAVY → WRITE → READ → (unknown ⇒ write).
function classifyTool(name) {
  const n = String(name || '').trim();
  if (!n) return 'locked';
  if (LOCKED_RE.test(n)) return 'locked';
  if (HEAVY_RE.test(n)) return 'heavy';
  if (PROPOSE_RE.test(n)) return 'propose';   // before WRITE: propose_* also matches WRITE_RE
  if (WRITE_RE.test(n)) return 'write';
  if (READ_RE.test(n)) return 'read';
  return 'write';   // SAFE DEFAULT: unknown ⇒ treat as mutating ⇒ blocked on the auto loop
}

// May the autonomous loop use this tool? READ (lookups) and PROPOSE (gated, non-committing) are
// allowed unattended; direct WRITE / HEAVY / LOCKED are not.
function allowedOnAuto(name) { const t = classifyTool(name); return t === 'read' || t === 'propose'; }

// The policy for one tool call. autonomous=true → the unattended research loop (read only).
// autonomous=false → an interactive turn with Lucas present (read+write+heavy; locked still never).
function policyFor(name, { autonomous = false } = {}) {
  const tier = classifyTool(name);
  if (tier === 'locked') return { allow: false, tier, reason: 'hard-locked (email-send / image-gen are off by design)' };
  if (autonomous) {
    if (tier === 'read') return { allow: true, tier, reason: 'read tool — allowed on the autonomous loop' };
    if (tier === 'propose') return { allow: true, tier, reason: 'propose tool — allowed on the autonomous loop (non-committing; Echo gates promotion)' };
    return { allow: false, tier, reason: `${tier} tool — blocked on the autonomous loop (needs Lucas present)` };
  }
  return { allow: true, tier, reason: 'interactive turn' };   // Lucas present: read+write+heavy ok
}

// --- the curated READ menu (first-class operator tools) ----------------------
// Each entry: op = the operator-facing tool name, tool = the real Echo tool, desc = one-line menu
// text, args = an example arg hint, map(a) = turn the operator's simple args into the Echo schema.
const READ_TOOLS = [
  {
    op: 'nonprofit_lookup', tool: 'propublica_nonprofit_search', lane: 'deep',
    desc: 'find a 501(c)/nonprofit org by name + its IRS 990 financials, revenue, and exec-comp (great for think tanks, advocacy orgs, foundations)',
    args: '{"query":"Heritage Foundation","state":"DC"}',
    map: (a = {}) => ({ query: String(a.query || a.name || a.q || ''), state: a.state || null, c_code: a.c_code || null, page: a.page || 0 })
  },
  {
    op: 'kg_search', tool: 'search_entities',
    desc: 'search OUR OWN knowledge graph for a person/org/committee/bill we already track (returns entity ids)',
    args: '{"query":"Roger Severino"}',
    map: (a = {}) => ({ query: String(a.query || a.name || a.q || ''), entity_type: a.entity_type || null, top_k: a.top_k || 10 })
  },
  {
    op: 'kg_neighborhood', tool: 'kg_neighborhood',
    desc: 'given an entity_id from kg_search, get its related entities + background (who/what it connects to)',
    args: '{"entity_id":12345}',
    map: (a = {}) => ({ entity_id: Number(a.entity_id), top_k: a.top_k || 10, edge_types: a.edge_types || null })
  },
  {
    op: 'knowledge_search', tool: 'search_knowledge',
    desc: 'full-text search OUR corpora/vault (reference, papers, records) — our data, not the open web',
    args: '{"query":"weather modification policy"}',
    map: (a = {}) => ({ query: String(a.query || a.q || ''), source: a.source || null, top_k: a.top_k || 10 })
  },
  {
    op: 'gov_funding', tool: 'usaspending_search',
    desc: 'federal grants/contracts awarded to an organization (its public-money funding footprint)',
    args: '{"recipient_name":"RAND Corporation"}',
    map: (a = {}) => ({ query: a.query || null, recipient_name: a.recipient_name || a.recipient || a.org || null, award_types: a.award_types || null, limit: a.limit || 20 })
  },
  {
    op: 'fec_lookup', tool: 'fec_committee_search',
    desc: 'find FEC-registered committees/PACs by name (campaign-finance ties of an org or its leaders)',
    args: '{"query":"Club for Growth"}',
    map: (a = {}) => ({ query: String(a.query || a.name || ''), state: a.state || null, committee_type: a.committee_type || null })
  },
  {
    op: 'bill_lookup', tool: 'search_bills',
    desc: 'search legislation by keyword (bills relevant to an org\'s issues / its legislative footprint)',
    args: '{"query":"carbon capture tax credit"}',
    map: (a = {}) => ({ query: String(a.query || a.q || ''), state: a.state || null, bill_type: a.bill_type || null, top_k: a.top_k || 30 })
  }
];

// --- the WEB lane (open-internet Echo tools, folded into the web-browsing track) -------------------
// These do the SAME kind of work as her own browser (fetch + read a page on the open web), so they
// belong in the WEB lane next to web_search/open_page/browser_read — NOT in the deep/structured lane.
const WEB_TOOLS = [
  {
    op: 'web_fetch', tool: 'web_fetch', lane: 'web',
    desc: 'fetch a URL reliably (4-tier fallback — beats the browser on plain pages, PDFs, and bot-walls)',
    args: '{"url":"https://example.org/team"}',
    map: (a = {}) => ({ url: String(a.url || ''), depth: a.depth || 'auto' })
  },
  {
    op: 'web_extract', tool: 'web_extract', lane: 'web',
    desc: 'fetch a URL and pull just its readable article/body text (strips nav/boilerplate)',
    args: '{"url":"https://example.org/about"}',
    map: (a = {}) => ({ url: String(a.url || ''), min_text_chars: a.min_text_chars || 200 })
  },
  {
    op: 'news_search', tool: 'gdelt_article_search', lane: 'web',
    desc: 'search global news coverage for an org/person/topic (recent activity, controversies, statements)',
    args: '{"query":"Heritage Foundation"}',
    map: (a = {}) => ({ query: String(a.query || ''), timespan: a.timespan || null, max_records: a.max_records || 25 })
  }
];

// Every curated first-class tool (read + web), so main.js can wire all executors in one loop.
const ALL_CURATED = READ_TOOLS.concat(WEB_TOOLS);

// --- lanes: which RESEARCH lane a tool belongs to (the two-track split) ----------------------------
// 'web'  = open-internet fetch/read/news (her browser + the web_* / gdelt / wiki / feed tools)
// 'deep' = structured/authoritative databases + our own knowledge graph (the rest of the read surface)
const WEB_LANE_RE = /^(web_|gdelt_|wayback|verify_url|mediawiki_|fetch_feed|hackernews|spaceflight_news|rag.?web|chronicling_america)/i;
function laneOf(name) {
  if (classifyTool(name) !== 'read') return null;       // only read tools have a research lane
  return WEB_LANE_RE.test(String(name || '')) ? 'web' : 'deep';
}

// The operator-facing tool NAMES for one lane (used by runCloudOperator to filter executors). The web
// lane carries her browser tools; the deep lane carries the structured tools. Both keep recall + the
// generic `echo` escape hatch (read-gated). Neither writes files — the driver merges + writes.
function laneToolNames(lane) {
  if (lane === 'web') return ['web_search', 'open_page', 'browser_read'].concat(WEB_TOOLS.map(t => t.op)).concat(['recall', 'echo']);
  return READ_TOOLS.map(t => t.op).concat(['recall', 'echo']);
}

// The curated-tool spec lines for one lane (the Echo tools only; main.js prepends the browser lines
// for the web lane). Compact, lane-scoped.
function laneSpec(lane) {
  const set = lane === 'web' ? WEB_TOOLS : READ_TOOLS;
  return set.map(t => `- ${t.op} ${t.args}\n    ${t.desc}`).join('\n');
}

// The TOOL_SPEC block for the curated read tools — appended to the operator's (single-lane) menu. Kept
// compact so the menu stays learnable; the generic `echo` tool covers everything not listed here.
function operatorReadSpec() {
  const lines = ALL_CURATED.map(t => `- ${t.op} ${t.args}\n    ${t.desc}`);
  return `ECHO DATA TOOLS (OUR structured data + public records + reliable web fetch — prefer these over a raw scrape when one fits; say so honestly if a result is empty):\n${lines.join('\n')}`;
}

// Look up a curated tool by its operator-facing op name (read or web).
function readToolByOp(op) { return ALL_CURATED.find(t => t.op === String(op || '')) || null; }

module.exports = {
  classifyTool, allowedOnAuto, policyFor, operatorReadSpec, readToolByOp,
  READ_TOOLS, WEB_TOOLS, ALL_CURATED, laneOf, laneToolNames, laneSpec,
  LOCKED_RE, HEAVY_RE, WRITE_RE, READ_RE, WEB_LANE_RE
};
