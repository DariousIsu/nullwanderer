'use strict';
/**
 * lib/tier_law.js — THE TRIGGER-TO-TIER LAW, one table both runtimes read (stage 4.5, item 2; 2026-09-04).
 *
 * "A trigger kind maps to a tier: chat and directed to user or directives, scheduled to expansion, pen
 * to development. The governor and the app's gate read the same table, so a chat-triggered delegate is
 * never paced as research again." (docs/ZOE_MERGE_MAP §Stage 4.5)
 *
 * The tiers are the usage law's (lib/quota.TIER): interactive (his turn), directed (his word), development
 * (the program building itself), presence (her being here — the consciousness loop and the autonomy decider, 09-05),
 * research and idle (EXPANSION, the only paced tier). This table names which
 * tier a TRIGGER bills — every trigger kind either side knows. Side Quest's spend-tier resolution keys on
 * the FOCUS (lib/focus.isDirected, the pen and swarm stamps in main._focusSpendTier); this table is the
 * trigger-side statement of the same law, and the read door the control port serves (GET /tiers) is how
 * Echo's governor learns it instead of carrying a second copy that drifts.
 *
 * P5 rides in as DATA (docs/ZOE_BUILD_PLAN §2, his own master-skill dispatcher): the seven core rules, the
 * domain routing table (intent keywords → lead skill → auto-chain), the JSON envelope every step consumes
 * and produces, the execution defaults and the confidence thresholds. Verbatim, so the swarm contract of
 * stage 4.5 C starts from his earlier statement of it rather than a fresh design; the ZOE role names come
 * with the registry (4.5 B) — the `lead` column stays his skill name until then.
 */
const VERSION = 1;

// trigger kind → tier. Unknown kinds fall to 'research' (paced expansion — the conservative side).
const TRIGGER_TIERS = Object.freeze({
  // his turn, live
  interactive: 'interactive',
  // his word: a chat delegate, a directive, a manual run, a redirect, a swarm he commanded
  chat: 'directed', directed: 'directed', manual: 'directed', redirect: 'directed', operator: 'directed', swarm_chat: 'directed',
  // HER BEING HERE (09-05): the consciousness loop's words to him, the wondering it asks for, the autonomy decider
  consciousness: 'presence', autonomy: 'presence', presence: 'presence',
  // the program building itself
  pen: 'development', rehearsal: 'development', pursuit: 'development', self_build: 'development', study: 'development',
  // expansion — scheduled and autonomous research
  cron: 'research', cadence: 'research', scheduled: 'research', event: 'research', beat: 'research', metabolism: 'research', pass: 'research',
  // expansion — the drift lanes
  idle: 'idle', subc: 'idle', wonder: 'idle', puller: 'idle', news: 'idle', graphwalk: 'idle', promote: 'idle', decomp: 'idle',
});
const TIERS = Object.freeze(['interactive', 'directed', 'presence', 'development', 'research', 'idle']);   // = lib/quota.TIER, in order
const EXPANSION = Object.freeze(['research', 'idle']);
const DEFAULT_TIER = 'research';

function tierForTrigger(kind) {
  const k = String(kind || '').trim().toLowerCase();
  return TRIGGER_TIERS[k] || DEFAULT_TIER;
}
function isExpansionTier(tier) { return EXPANSION.includes(String(tier || '')); }

// ── P5: his master-skill dispatcher, verbatim as data ─────────────────────────────────────────
const SEVEN_RULES = Object.freeze([
  'No-ask: execute immediately; make smart defaults; never request clarification for routine tasks.',
  'JSON pipeline: all inter-skill data flows as structured JSON; never regenerate from prose already in the payload.',
  'Chain by default: multi-step tasks run as connected pipelines; each skill appends to the shared JSON, never replaces prior data.',
  'Parallel when independent: skills with no data dependency on each other run concurrently via subagents.',
  'File output: every final deliverable is saved as a file to the workspace, never only into the chat.',
  'Sources always: every research, analysis or writing output includes inline citations and a sources section.',
  'Quality gates: data tasks validate before output; finance tasks show assumptions; legal tasks rank by severity; writing tasks include hook + CTA.',
]);

// intent keywords → lead skill → auto-chain (his domain routing table, row for row)
const INTENT_ROUTES = Object.freeze([
  { keywords: ['csv', 'dataset', 'analyze data', 'tabular file'], lead: 'data:analyze', chain: ['data:validate', 'data:create-viz'] },
  { keywords: ['research topic', 'benchmark', 'compare tools', 'find companies'], lead: 'research-skill', chain: ['research-deep', 'research-report'] },
  { keywords: ['write article', 'blog', 'newsletter', 'long-form content'], lead: 'content-research-writer', chain: ['content-extraction'] },
  { keywords: ['contract', 'agreement', 'legal review', 'redline'], lead: 'legal:review-contract', chain: ['legal:legal-risk-assessment'] },
  { keywords: ['nda'], lead: 'legal:nda-triage', chain: ['legal:review-contract', 'legal:legal-risk-assessment'] },
  { keywords: ['dcf', 'valuation', 'financial model', 'irr', 'lbo'], lead: 'creating-financial-models', chain: ['analyzing-financial-statements'] },
  { keywords: ['income statement', 'p&l', 'balance sheet', 'financial statements'], lead: 'finance:financial-statements', chain: ['finance:variance-analysis'] },
  { keywords: ['journal entry', 'gl', 'general ledger', 'close'], lead: 'finance:journal-entry', chain: ['finance:reconciliation'] },
  { keywords: ['sox', 'audit', 'control testing', 'internal controls'], lead: 'finance:sox-testing', chain: ['operations:compliance-tracking'] },
  { keywords: ['variance', 'budget vs actual', 'flux analysis'], lead: 'finance:variance-analysis', chain: [] },
  { keywords: ['financial ratios', 'ratio analysis', 'roe', 'ebitda'], lead: 'analyzing-financial-statements', chain: [] },
  { keywords: ['presentation', 'slides', 'deck', 'pitch', 'pptx'], lead: 'pptx', chain: ['theme-factory'] },
  { keywords: ['word doc', 'report', 'proposal', 'memo', '.docx'], lead: 'docx', chain: [] },
  { keywords: ['pdf', 'extract pdf', 'fill form', 'merge pdf'], lead: 'pdf', chain: [] },
  { keywords: ['spreadsheet', 'excel', '.xlsx', 'tabular output'], lead: 'xlsx', chain: [] },
  { keywords: ['dashboard', 'interactive chart', 'filters', 'html viz'], lead: 'data:interactive-dashboard-builder', chain: ['data:create-viz'] },
  { keywords: ['sql', 'query', 'warehouse', 'snowflake', 'bigquery'], lead: 'data:write-query', chain: ['data:validate'] },
  { keywords: ['brand voice', 'tone', 'style guide', 'enforce voice'], lead: 'brand-voice:enforce-voice', chain: ['brand-voice:generate-guidelines'] },
  { keywords: ['discover brand', 'find brand materials'], lead: 'brand-voice:discover-brand', chain: ['brand-voice:generate-guidelines'] },
  { keywords: ['campaign', 'go-to-market', 'launch plan'], lead: 'marketing:campaign-plan', chain: ['marketing:draft-content'] },
  { keywords: ['blog post', 'social post', 'email campaign', 'copywriting'], lead: 'marketing:draft-content', chain: ['marketing:brand-review'] },
  { keywords: ['seo', 'search optimization', 'keyword research'], lead: 'marketing:seo-audit', chain: [] },
  { keywords: ['competitive analysis', 'competitor research'], lead: 'marketing:competitive-brief', chain: [] },
  { keywords: ['email sequence', 'nurture flow', 'drip campaign'], lead: 'marketing:email-sequence', chain: ['marketing:brand-review'] },
  { keywords: ['marketing performance', 'campaign results'], lead: 'marketing:performance-report', chain: [] },
  { keywords: ['business case', 'roi', 'investment justification', 'build vs buy'], lead: 'business-case-builder', chain: ['creating-financial-models'] },
  { keywords: ['leads', 'prospects', 'icp', 'sales targets', 'outreach'], lead: 'lead-research-assistant', chain: [] },
  { keywords: ['meeting transcript', 'communication patterns', 'coaching'], lead: 'meeting-insights-analyzer', chain: [] },
  { keywords: ['process', 'workflow', 'sop', 'runbook', 'operations doc'], lead: 'operations:process-doc', chain: ['operations:runbook'] },
  { keywords: ['vendor evaluation', 'vendor review', 'procurement'], lead: 'operations:vendor-review', chain: ['legal:vendor-check'] },
  { keywords: ['capacity', 'staffing', 'resource plan', 'utilization'], lead: 'operations:resource-planning', chain: [] },
  { keywords: ['risk assessment', 'risk register', 'what could go wrong'], lead: 'operations:risk-assessment', chain: [] },
  { keywords: ['change management', 'rollout', 'migration plan'], lead: 'operations:change-management', chain: [] },
  { keywords: ['compliance', 'gdpr', 'ccpa', 'privacy', 'regulatory'], lead: 'legal:compliance', chain: ['operations:compliance-tracking'] },
  { keywords: ['design review', 'ux critique', 'usability'], lead: 'design:critique', chain: ['design:accessibility'] },
  { keywords: ['developer handoff', 'design specs'], lead: 'design:handoff', chain: [] },
  { keywords: ['ux copy', 'microcopy', 'error messages', 'ctas'], lead: 'design:ux-copy', chain: [] },
  { keywords: ['accessibility', 'wcag', 'a11y audit'], lead: 'design:accessibility', chain: [] },
  { keywords: ['user research', 'usability test', 'research synthesis'], lead: 'design:user-research', chain: [] },
  { keywords: ['design system', 'component library', 'design tokens'], lead: 'design:design-system', chain: [] },
  { keywords: ['art', 'poster', 'illustration', 'visual design', 'png'], lead: 'canvas-design', chain: ['theme-factory'] },
  { keywords: ['internal comms', 'announcement', 'company update'], lead: 'internal-comms', chain: ['docx'] },
  { keywords: ['mcp', 'api server', 'tool integration'], lead: 'mcp-builder', chain: [] },
  { keywords: ['algorithmic art', 'generative art', 'p5.js'], lead: 'algorithmic-art', chain: [] },
  { keywords: ['scheduled task', 'automation', 'cron job'], lead: 'schedule', chain: [] },
  { keywords: ['statistical analysis', 'hypothesis test', 'outlier'], lead: 'data:statistical-analysis', chain: ['data:create-viz'] },
  { keywords: ['explore data', 'profile dataset', 'data quality'], lead: 'data:explore-data', chain: ['data:analyze'] },
  { keywords: ['status report', 'kpis', 'project update'], lead: 'operations:status-report', chain: ['docx'] },
]);

// the six standard chain protocols, as ordered step lists
const CHAINS = Object.freeze({
  research: ['research-skill', 'research-deep', 'research-report', '[data:analyze | content-research-writer | finance:variance-analysis]', 'final.[docx|pptx|html]'],
  data: ['data:explore-data', 'data:analyze', 'data:validate', 'data:create-viz || data:interactive-dashboard-builder'],
  finance: ['creating-financial-models', 'analyzing-financial-statements', 'finance:variance-analysis', 'pptx || docx'],
  legal: ['legal:nda-triage', '[if YELLOW|RED] legal:review-contract', 'legal:legal-risk-assessment'],
  content: ['content-extraction', 'marketing:draft-content', 'marketing:brand-review', 'docx || md'],
  research_to_document: ['research-skill', 'research-deep', 'research-report', 'content-research-writer', '[pptx || docx] + theme-factory'],
});

// the universal JSON envelope every step consumes and produces (his contract, verbatim shape)
const ENVELOPE = Object.freeze({
  task: 'human-readable task description',
  domain: 'research|data|finance|legal|writing|marketing|ops|design',
  payload: { items: [], analysis: {}, content: {} },
  sources: [{ ref: 's1', url: '...', title: '...', confidence: 0.95 }],
  metadata: { skill: 'skill-name', timestamp: 'ISO-8601', items_processed: 0, quality_score: 0.0, warnings: [] },
  _next: 'skill-name | null',
});
const ENVELOPE_RULES = Object.freeze([
  'Each skill in a chain receives the full JSON and appends its output to payload; it does not overwrite prior fields.',
  '_next signals the chain controller which skill runs next; null at terminal steps.',
  'Sources propagate through the entire chain; the final output cites the original sources, not intermediate summaries.',
]);
// confidence: 0.9+ verified · 0.7–0.9 likely accurate · <0.7 flagged [uncertain]
const CONFIDENCE = Object.freeze({ verified: 0.9, likely: 0.7, uncertainBelow: 0.7 });
function confidenceLabel(c) { const n = Number(c); if (!Number.isFinite(n)) return 'uncertain'; return n >= CONFIDENCE.verified ? 'verified' : n >= CONFIDENCE.likely ? 'likely' : 'uncertain'; }

const EXECUTION_DEFAULTS = Object.freeze({
  research_depth: 'deep', research_items: 10, research_time_range: 'last 12 months', final_report_format: '.docx',
  chart_type: 'auto-detect from data structure', analysis_type: 'comparative', content_length_words: 1200,
  financial_projection_horizon_years: 5, dashboard_theme: 'professional', legal_risk_escalation: 'MEDIUM', uncertain_below: 0.7,
});

/** Route an intent by his keywords: the first row whose keyword appears in the text (word boundaries where sensible). */
function routeIntent(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return null;
  for (const r of INTENT_ROUTES) {
    for (const k of r.keywords) {
      const kw = k.toLowerCase();
      const re = /^[a-z0-9]/.test(kw) && /[a-z0-9]$/.test(kw) ? new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`) : null;
      if (re ? re.test(t) : t.includes(kw)) return { lead: r.lead, chain: [...r.chain], matched: k };
    }
  }
  return null;
}

/** The table the control port serves (GET /tiers): what the other runtime needs, nothing more. */
function table() {
  return {
    version: VERSION,
    tiers: [...TIERS],
    expansion: [...EXPANSION],
    default: DEFAULT_TIER,
    triggers: { ...TRIGGER_TIERS },
    rules: [...SEVEN_RULES],
    confidence: { ...CONFIDENCE },
  };
}

module.exports = { VERSION, TRIGGER_TIERS, TIERS, EXPANSION, DEFAULT_TIER, tierForTrigger, isExpansionTier, SEVEN_RULES, INTENT_ROUTES, CHAINS, ENVELOPE, ENVELOPE_RULES, CONFIDENCE, confidenceLabel, EXECUTION_DEFAULTS, routeIntent, table };
