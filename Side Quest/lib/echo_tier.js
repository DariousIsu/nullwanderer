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
// SHELL — the write→run→read→fix actuator (os_run_powershell captures stdout/stderr/returncode
// from a real PowerShell run). Its OWN tier, deliberately distinct from desktop control: a shell
// that runs arbitrary code is a strictly LARGER authority than clicking a known pixel, so it is
// OPERATOR-PRESENT ONLY and is NEVER admitted on the autonomous loop — unlike the os_*/gui_do
// carve (DESKTOP_CONTROL_RE), which WAS authorized for unattended desktop work. Excluded from that
// carve below by an explicit negative lookahead. The Echo-side gate still runs underneath
// (permissions.decide confirm + SENSITIVE_TARGETS backstop force an operator confirmation).
const SHELL_RE = /^(?:os_)?run_powershell$/i;
// PROPOSE — an ADDITIVE, auto-disambiguated, reversible write: propose_entity / propose_relation /
// propose_link / propose_question_concept only ADD nodes/edges, and Echo auto-disambiguates against
// existing entities (Levenshtein 0.85 → created / already_exists / merge_suggested, never a blind
// dup). They never delete, merge, or overwrite the system-of-record — and merge/delete stay 'write'
// (blocked on auto). So propose_* is the SAFE subset that lets the subconscious graph-builder grow
// the KG unattended. (propose_hire is HEAVY, caught above — it spawns an agent.)
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
const READ_RE = /^(search|get_|list_|find_|describe_|quick_lookup|lookup|kg_|query_|db_query|graph_overview|stats\b|summarize_|audit_|cite_|score_|verify_|wayback|web_search|web_fetch|web_extract|web_resolve|academic_search|arxiv_search|recent_|fetch_feed|sql_cache_recall|knowledge_neighborhood|bill_lookup|bill_facets|contact_facets|represent_|civic_coverage|get_sources_for|propublica_nonprofit_(search|get)|fec_|usaspending_|edgar_|courtlistener_|legiscan_|fr_(search|get|agency)|ecfr_|gdelt_|openfda_|clinicaltrials_|ncbi_|mediawiki_|loc_(gov|names|subjects|authority)|gov_(search|get|list|recent|portals)|socrata_|ckan_|odata_|sdmx_|wb_|un_population|census_|geonames_|nws_|noaa_|usgs_|opensanctions_|ofac_|nvd_|cert_|hunter_find_email)/i;

// READ, part 2 — EXTERNAL PUBLIC-DATA APIs, by family.
//
// READ_RE above is prefix-anchored on generic verbs (search/get_/list_/…) plus a hand-picked set of
// source families. Whole families were never added, so they fell to the safe default and were treated
// as mutating. Measured on a representative 119-tool slice: 116 classified 'write', 1 'read'. Live
// 2026-07-20: `routeNeed tier-gate BLOCKED legistar_list_persons (write, autonomous=true)` — a
// list-only call against a public legislative portal, blocked from the research lane.
//
// Every family here is an external READ-ONLY source: Echo exposes lookups against someone else's
// public API and has no write endpoint for any of them, so there is no system-of-record to mutate.
// That is why widening here does NOT weaken the gate — the safe default still catches anything
// unknown, and every Echo-internal mutation (propose_/merge_/delete_/save_/ingest_/spawn_) is
// matched earlier by WRITE_RE and HEAVY_RE, which run first.
//
// Deliberately a family ALLOWLIST rather than a "looks read-only" heuristic: a name-shape guess is
// exactly how an unknown mutating tool would slip through.
//
// …and the family match alone is NOT sufficient, which the first version of this got wrong. WRITE_RE
// is prefix-anchored, so a hypothetical `uk_delete_thing` or `epa_save_record` matches the family,
// misses WRITE_RE, and would have been admitted as a read. A family prefix says "this source is
// external", not "this call cannot mutate". So a family hit must ALSO carry no mutating verb
// anywhere in the name — Echo gains tools over time and a future `uk_submit_*` must not walk in.
// A mutating verb ANYWHERE in the name (not just as a prefix) disqualifies a family match.
const MUTATING_VERB_RE = /(?:^|_)(?:create|update|delete|remove|save|set|add|merge|import|export|upload|submit|post|put|patch|write|send|apply|approve|reject|archive|restore|purge|revoke|start|stop|spawn|run|execute|register|enroll|subscribe|unsubscribe|edit|modify|rename|move|assign|certify|sign)(?:_|$)/i;

const READ_FAMILY_RE = new RegExp('^(?:' + [
  // legislative / government portals
  'legistar_', 'openparliament_', 'abgeordnetenwatch_', 'br_camara_', 'uk_', 'represent_ca_',
  'ks_legislature_', 'ma_legislature_', 'md_legislature_', 'mi_legislature_', 'sd_legislature_',
  'ut_legislature_', 'doj_news_', 'chronicling_america_',
  // regulators / agencies
  'epa_', 'fema_', 'nhtsa_', 'uspto_', 'usda_', 'treasury_', 'college_scorecard_', 'nppes_',
  // science / health / environment
  'rxnorm_', 'pubchem_', 'gbif_', 'openaq_', 'erddap_', 'disease_sh_', 'cov_spectrum_',
  'medlineplus_', 'awc_', 'opencharge_', 'openmeteo_', 'sunrise_sunset',
  // reference / open data
  'openlibrary_', 'openfigi_', 'datamuse_', 'free_dictionary_', 'nager_date_', 'hebcal_',
  'country_is', 'geojs_', 'bdapis_', 'brasilapi_', 'geodata_gr_', 'nhs_scotland_', 'arcgis_',
  'pxwebapi_', 'econdb_', 'spaceflight_news_', 'hackernews_',
  // threat intel (lookup-only)
  'shodan_', 'greynoise_', 'abuseipdb_', 'phishstats_', 'urlhaus_', 'interpol_', 'fbi_wanted',
  'mozilla_observatory',
].join('|') + ')', 'i');

// DESKTOP CONTROL — os_* (perception + actuation via UIA/SendInput) and gui_do (vision-grounded
// control). These stay classified 'write' (so nothing changes on interactive turns), but are
// EXPLICITLY admitted on the autonomous loop per operator authorization (2026-07-27, "Zoe should
// see and touch everything — this machine is a dev scape").
//
// Two tools are deliberately EXCLUDED from the carve so the autonomous loop cannot escalate its own
// authority: os_set_policy (would let her widen/relax capability grants) and os_approval_resolve
// (would let her self-approve a sensitive-target confirmation). Both remain 'write' → blocked on
// auto. The Echo-side gate still runs underneath everything here: os_* permission checks +
// permissions.decide()'s SENSITIVE_TARGETS backstop (bank/login/credentials/regedit/…) still force
// an operator confirmation even on the autonomous loop, so a sensitive action pauses rather than
// firing unattended.
const DESKTOP_CONTROL_RE = /^(?:os_(?!set_policy\b|approval_resolve\b|run_powershell\b)|gui_do)/i;

// What kind of tool is this? Pure. Order: LOCKED → HEAVY → WRITE → READ → (unknown ⇒ write).
function classifyTool(name) {
  const n = String(name || '').trim();
  if (!n) return 'locked';
  if (LOCKED_RE.test(n)) return 'locked';
  if (SHELL_RE.test(n)) return 'shell';   // before WRITE: os_run_powershell matches the os_ prefix
  if (HEAVY_RE.test(n)) return 'heavy';
  if (PROPOSE_RE.test(n)) return 'propose';   // before WRITE: propose_* also matches WRITE_RE
  if (WRITE_RE.test(n)) return 'write';   // stays FIRST — an Echo-internal mutation always wins
  if (READ_RE.test(n)) return 'read';
  // external public-data source AND no mutating verb anywhere in the name
  if (READ_FAMILY_RE.test(n) && !MUTATING_VERB_RE.test(n)) return 'read';
  return 'write';   // SAFE DEFAULT: unknown ⇒ treat as mutating ⇒ blocked on the auto loop
}

// May the autonomous loop use this tool? READ (lookups) and PROPOSE (gated, non-committing) are
// allowed unattended; direct WRITE / HEAVY / LOCKED are not.
function allowedOnAuto(name) { const t = classifyTool(name); return t === 'read' || t === 'propose' || DESKTOP_CONTROL_RE.test(name) || AUTO_ALLOW_RE.test(name); }

// --- the curated MAINTENANCE allowlist (conductor slice 2d) ------------------------------------
// The autonomous gate correctly blocks write/heavy — which also meant her own Python maintenance
// loops were unreachable from the decision layer (why they sat underused). This is the deliberate
// carve-out: NAMED tools only, each verified against its live schema, each entry stating WHY it is
// safe unattended — and `force` args are merged MECHANICALLY at dispatch (lib/echo_suit), so
// model-written args can never disarm the safety. Expansion is tool-by-tool with the same
// verification, never by pattern — a family/verb heuristic is exactly how a mutating call slips in.
const MAINTAIN_TOOLS = [
  {
    tool: 'run_integrity_audit',
    desc: 'structural integrity audit of the civic graph (self-loops, dangling edges, contradiction merges) — REPORT ONLY on the auto loop',
    why: 'dry_run=true forced: scans + reports, writes nothing (its live mode is reversible + backup-first, but unattended we take the report)',
    force: { dry_run: true },
  },
  {
    tool: 'run_blocking_dedup',
    desc: 'full-corpus semantic dedup sweep — lands merge PROPOSALS in the gated queue, never applies them',
    why: 'proposal-only by construction: apply stays a gated operator step (list/decide_resolution_proposal)',
    force: {},
  },
];
const MAINTAIN_NAMES = new Set(MAINTAIN_TOOLS.map((t) => t.tool));
function maintainForcedArgs(name) { const t = MAINTAIN_TOOLS.find((x) => x.tool === String(name || '')); return t ? { ...t.force } : null; }
function maintainSpec() { return MAINTAIN_TOOLS.map((t) => `- ${t.tool}: ${t.desc}`).join('\n'); }

// AUTONOMOUS-LANE ALLOWANCES (2026-08-14, the enforce flip — harvested from the shadow window
// plus the code-read inventory; tool-by-tool with a stated WHY, never by pattern):
//   agent_inbox — the delegation RETURN path: the autonomy tick collects finished delegate
//     results (cursor-advance on her OWN inbox, not a system-of-record mutation). The shadow
//     measurement window's WOULD-BLOCK log was 19/19 this one tool; blocked, delegated results
//     rot until the 24h expiry and unattended delegation is pointless.
//   set_entity_temporal — the temporal-stamping door the news/event lanes call with
//     DETERMINISTIC lane-computed args (never cloud-authored JSON); the known-legit autonomous
//     write that kept the gate in shadow. Worst case is a wrong temporal state, supersedable.
const AUTO_ALLOW_RE = /^(agent_inbox|set_entity_temporal)$/i;

// The policy for one tool call. autonomous=true → the unattended research loop (read only).
// autonomous=false → an interactive turn with Lucas present (read+write+heavy; locked still never).
// maintain=true (only meaningful with autonomous) → the curated maintenance allowlist above is
// additionally admitted — its members run with forced-safe args.
function policyFor(name, { autonomous = false, maintain = false } = {}) {
  const tier = classifyTool(name);
  if (tier === 'locked') return { allow: false, tier, reason: 'hard-locked (email-send / image-gen are off by design)' };
  if (autonomous) {
    if (tier === 'shell') return { allow: false, tier, reason: 'shell execution (os_run_powershell) is OPERATOR-PRESENT ONLY — it is not on the autonomous desktop-control carve; name what you need run and surface it to Lucas instead of running it unattended' };
    if (tier === 'read') return { allow: true, tier, reason: 'read tool — allowed on the autonomous loop' };
    if (tier === 'propose') return { allow: true, tier, reason: 'propose tool — allowed on the autonomous loop (non-committing; Echo gates promotion)' };
    if (AUTO_ALLOW_RE.test(name)) return { allow: true, tier, reason: 'named autonomous-lane allowance (AUTO_ALLOW_RE: the delegation return path / deterministic temporal stamping — see the why-comments)' };
    if (DESKTOP_CONTROL_RE.test(name)) {
      return { allow: true, tier, reason: 'desktop control — operator-authorized on the autonomous loop 2026-07-27 (Echo os_* permission gate + sensitive-target confirmation still apply)' };
    }
    if (maintain && MAINTAIN_NAMES.has(String(name || '').trim())) {
      return { allow: true, tier, reason: 'curated maintenance allowlist — forced-safe args (report/proposal only)' };
    }
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
    desc: 'find a 501(c)/nonprofit by name → each match\'s EIN + address + NTEE class ONLY (no dollar figures here). To rank or compare orgs by their money, take the EIN from here and call nonprofit_financials',
    args: '{"query":"Heritage Foundation","state":"DC"}',
    map: (a = {}) => ({ query: String(a.query || a.name || a.q || ''), state: a.state || null, c_code: a.c_code || null, page: a.page || 0 })
  },
  {
    op: 'nonprofit_financials', tool: 'propublica_nonprofit_get', lane: 'deep',
    desc: 'pull ONE nonprofit\'s IRS 990 history BY EIN — per-year total revenue, expenses, assets, exec comp (filings_with_data). THIS returns the NUMBERS; use it to rank/compare a known set of orgs, one call per EIN, then do the arithmetic yourself (no python for a handful of orgs). Get each EIN from nonprofit_lookup first. If only filings_without_data (PDF-only) comes back, say so — then a web fetch of that PDF is a fair fallback',
    args: '{"ein":"530115260"}',
    map: (a = {}) => ({ ein: String(a.ein || a.EIN || a.id || '').replace(/[^0-9]/g, '') })
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
    desc: 'find FEC-registered COMMITTEES/PACs by name (campaign-finance ties of an org or its leaders) — NOT a person\'s own campaign; for a CANDIDATE\'s own filings use fec_candidate',
    args: '{"query":"Club for Growth"}',
    map: (a = {}) => ({ query: String(a.query || a.name || ''), state: a.state || null, committee_type: a.committee_type || null })
  },
  {
    // T11b (2026-08-16): fec_lookup is COMMITTEE-only, so a candidate name ("Rick Scott") returned empty
    // and she fell to keyless urllib → 429. This finds the CANDIDATE → FEC id + principal committee id;
    // the money TOTALS (receipts/disbursements/cash-on-hand) then come from openFEC /candidate|committee
    // totals via analyze_data (FEC_API_KEY is in os.environ).
    op: 'fec_candidate', tool: 'fec_candidate_search',
    desc: 'find a federal CANDIDATE (House/Senate/President) by name → their FEC id + principal committee (a person\'s OWN campaign). Use this — not fec_lookup — for a candidate\'s own filings; their money totals then come from the openFEC totals endpoint via analyze_data',
    args: '{"query":"Rick Scott","office":"S","state":"FL","cycle":2024}',
    map: (a = {}) => ({ query: String(a.query || a.name || ''), office: a.office || null, state: a.state || null, cycle: a.cycle || null, party: a.party || null, per_page: a.per_page || 20 })
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

// --- the OS surface (D2, 2026-08-14 — Lucas: "she is supposed to have FULL ACCESS") ----------------
// Echo's os_* surface exists and the tier gate always allowed it interactively — but no operator menu
// ever OFFERED it, so "checking my own machine" was claimed and never executed (the sidecar "Running
// now" pre-claim). Same disease as the quant tools above: a menu failure, not a model failure. The
// shell is the one door that covers the whole machine (processes, disk, GPU, her own files); the rest
// of the os_* surface (window control, UIA perception) stays reachable through the generic `echo`
// need-router. Tier policy is UNCHANGED: os_run_powershell stays OPERATOR-PRESENT ONLY — research-lane
// menus never list it, and its executor passes the ambient lane so an autonomous call hits the tier
// block. Echo's own permission gate (DEFAULT_CONFIRM + SENSITIVE_TARGETS) runs underneath every call.
const OS_TOOLS = [
  {
    op: 'os_shell', tool: 'os_run_powershell',
    desc: 'run a PowerShell script on HER OWN machine and read stdout+stderr+returncode (self-diagnosis: processes, disk, GPU, her own files — the write→run→read→fix loop). It may return confirmation_required with an approval_id: tell Lucas exactly what needs approving and re-call with {"approval_id":"…"} only AFTER he approves — never claim it ran until you have its output',
    args: '{"script":"Get-Process | Sort-Object CPU -Descending | Select-Object -First 5"}',
    map: (a = {}) => {
      const o = { script: String(a.script || a.command || a.cmd || '') };
      if (Number.isFinite(a.timeout)) o.timeout = a.timeout;
      if (a.cwd) o.cwd = String(a.cwd);
      if (a.approval_id) o.approval_id = String(a.approval_id);
      return o;
    }
  },
];

// Every curated first-class tool (read + web), so main.js can wire all executors in one loop.
// OS_TOOLS is deliberately NOT in this list: it is the first non-read curated surface, and its
// executor must pass the ambient lane to the tier gate — main.js wires it in its own loop.
const ALL_CURATED = READ_TOOLS.concat(WEB_TOOLS);

// --- lanes: which RESEARCH lane a tool belongs to (the two-track split) ----------------------------
// 'web'  = open-internet fetch/read/news (her browser + the web_* / gdelt / wiki / feed tools)
// 'deep' = structured/authoritative databases + our own knowledge graph (the rest of the read surface)
const WEB_LANE_RE = /^(web_|gdelt_|wayback|verify_url|mediawiki_|fetch_feed|hackernews|spaceflight_news|rag.?web|chronicling_america)/i;
// CONTENT FIREWALL scoping (content-firewall doctrine): deep-lane READ tools that return STRANGER-AUTHORED
// PROSE — an arxiv/academic abstract, a court opinion, a PubMed/clinical study description, a StackExchange
// answer, a MedlinePlus article. Same threat as a web page: text somebody else wrote, read into the model.
// Kept SEPARATE from WEB_LANE_RE (these are 'deep' lane, not fetched by her browser) but co-located here so
// there is ONE authoritative scoping owner, never a second name-list drifting in echo_suit. DELIBERATELY
// NARROW — only prose readers; structured record tools (fec_/usaspending_/census_/edgar_/courtlistener_docket,
// db_query, get_*) are NOT prose and are never framed (that text is data, and framing it all makes the marker
// mean nothing through repetition). courtlistener_opinion_ only, not the whole courtlistener_ family.
const PROSE_LANE_RE = /^(arxiv_search|academic_search|courtlistener_opinion_|ncbi_pubmed|clinicaltrials_|stackexchange_|medlineplus_)/i;
function laneOf(name) {
  if (classifyTool(name) !== 'read') return null;       // only read tools have a research lane
  return WEB_LANE_RE.test(String(name || '')) ? 'web' : 'deep';
}

// The operator-facing tool NAMES for one lane (used by runCloudOperator to filter executors). The web
// lane carries her browser tools; the deep lane carries the structured tools. Both keep recall + the
// generic `echo` escape hatch (read-gated). Neither writes files — the driver merges + writes.
function laneToolNames(lane) {
  if (lane === 'web') return ['web_search', 'open_page', 'see_page', 'browser_read'].concat(WEB_TOOLS.map(t => t.op)).concat(['recall', 'echo']);
  // P3 (ADAPTIVE_RESEARCH_DESIGN §G1): the deep lane carries the QUANT tools — python over what
  // we've banked (analyze_data), SQL over her own stores (localdb), and her probability models
  // (forecast_query). Measured before this line: ZERO python/probability calls in any research run,
  // because no research menu ever offered them — a menu failure, not a model failure.
  return READ_TOOLS.map(t => t.op).concat(['analyze_data', 'localdb', 'forecast_query', 'recall', 'echo']);
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
  const osLines = OS_TOOLS.map(t => `- ${t.op} ${t.args}\n    ${t.desc}`);
  return `ECHO DATA TOOLS (OUR structured data + public records + reliable web fetch). When a source is STRUCTURED — a nonprofit's 990 (nonprofit_lookup → nonprofit_financials by EIN), campaign finance (fec_lookup), federal funding (gov_funding) — PREFER the dedicated tool: one call returns the numbers, whereas scraping the same facts page-by-page with web_fetch burns your whole step budget and usually delivers nothing. If no listed tool fits, say the need via echo before a raw scrape. If a dedicated tool comes back empty or PDF-only, say so honestly — then a web fetch is a fair fallback:\n${lines.join('\n')}` +
    `\nHER OWN MACHINE (full access per Lucas — interactive turns only, Echo's confirm gate applies):\n${osLines.join('\n')}`;
}

// Look up a curated tool by its operator-facing op name (read, web, or os).
function readToolByOp(op) { return ALL_CURATED.concat(OS_TOOLS).find(t => t.op === String(op || '')) || null; }

module.exports = {
  classifyTool, allowedOnAuto, policyFor, operatorReadSpec, readToolByOp,
  READ_TOOLS, WEB_TOOLS, OS_TOOLS, ALL_CURATED, laneOf, laneToolNames, laneSpec,
  MAINTAIN_TOOLS, maintainForcedArgs, maintainSpec,
  LOCKED_RE, HEAVY_RE, WRITE_RE, READ_RE, WEB_LANE_RE, PROSE_LANE_RE
};
