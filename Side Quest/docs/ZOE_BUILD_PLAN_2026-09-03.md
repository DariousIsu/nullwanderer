# ZOE build plan, revision 2 (2026-09-03, after the compact)

Lucas, after the compact: "make sure you are looking at the claude cowork projects section and also all the plug ins, those should get ported as well. From there I want to see an updated build plan." And mid-turn: "a lot of the failed tool calls you have been reporting might be bad echo tool calls for accessing the long term database or missing hitting the short term memory holds, because I know for a fact there is information in that database."

This revision does three things. Section 1 inventories every Cowork and Claude Code surface on this machine, by path and count. Section 2 maps each item to its ZOE target. Section 3 answers the database question with a census and a named mechanism. Section 4 is the build order that results. The design of record stays [ZOE_DESIGN_2026-09-03.md](ZOE_DESIGN_2026-09-03.md); the row-level merge stays [ZOE_MERGE_MAP_2026-09-03.md](ZOE_MERGE_MAP_2026-09-03.md). This document extends both and supersedes their build-order sections.

Every count below was measured today with read-only probes. Nothing was written to any live store.

## 1. What the Cowork and Claude Code sides hold

The desktop app keeps everything under `%APPDATA%\Claude`. The Cowork account directory is `local-agent-mode-sessions\<account>\<org>\`. Paths below are relative to it unless stated.

| Surface | Where | Count | What it is |
|---|---|---|---|
| Cowork projects ("spaces") | `spaces.json` + `spaces\<id>\memory\` | 11 spaces, 5 memory files | Each space carries a name, linked folders, free-text instructions, and a per-space memory directory in the harness's `MEMORY.md` + typed-file shape. Created May 5 to June 12. |
| claude.ai Projects (synced) | `.project-cache\<uuid>\` | 3 projects, 14 attached files, 31 cached docs | Op-Ed Writing (prompt template), Policy Briefings (prompt template naming the LAMP roster file and the briefing style document), China and the 5-year plan (11 PDFs). |
| Project folders on disk | `Documents\Claude\Projects\` | 10 folders, 122 files | Citation Verification and Fact Check (50: certification HTML+PDF pairs), Op-Eds (42: dossiers, drafts, a writing guide, a methodology doc), Legislative Tracker (two AURA workspace TOMLs + two bill reports), Internal Data Verification (the approved certification template: `build_certification.py` + logo), Live Events (run-of-show, senator briefs), Proposal, Quick Hit Articles, North Dakota, Elected List Builder (one xlsx). |
| Scheduled task | `scheduled-tasks.json` + `Documents\Claude\Scheduled\weekly-news-brief\SKILL.md` | 1 | The weekly Saturday brief: dashboard cover (weather, markets via yfinance, Israel travel advisory), six news sections, work-connection callouts, PDF to the News Briefs folder. |
| Cowork skills plugin | `local-agent-mode-sessions\skills-plugin\<org>\<account>\skills\` | 27 skills; 5 user-authored | User-authored: master-skill (his universal dispatcher: routing table, chain protocols, one JSON envelope, "no-ask", "sources always", "file output"), deep-research-pdf (interactive PDF report: 2-page brief, TOC, sections, ReportLab template), build-deploy-verify, web-ui-ux-design, frontend-design. Anthropic-managed: docx, pptx, xlsx, pdf, doc-coauthoring, skill-creator, mcp-builder, theme-factory, canvas-design, web-artifacts-builder, internal-comms, brand-guidelines, algorithmic-art, slack-gif-creator, morning, schedule, consolidate-memory, import-memory, explain-usage, setup-cowork. |
| Knowledge-work plugins, enabled | `cowork_plugins\cache\knowledge-work-plugins\` (+ `rpm\` for design, data, engineering) | 11 plugins, 63 skills, 55 commands, 5 agents | legal (contract-review, compliance, legal-risk-assessment, nda-triage, meeting-briefing, canned-responses), finance (financial-statements, variance-analysis, reconciliation, journal-entry-prep, close-management, audit-support), marketing (brand-voice, campaign-planning, competitive-analysis, content-creation, performance-analytics), operations (process-optimization, risk-assessment, vendor-management, change-management, compliance-tracking, resource-planning), productivity (memory-management, task-management, dashboard), brand-voice (3 skills + 5 agents: content-generation, conversation-analysis, discover-brand, document-analysis, quality-assurance), bio-research, data (7: explore, analyze, validate, viz, sql, statistics, dashboard), design (6: critique, accessibility, handoff, design-system, user-research, ux-writing), engineering (10: architecture, code-review, debug, testing-strategy, system-design, tech-debt, incident-response, deploy-checklist, documentation, standup), cowork-plugin-management. Every plugin also declares external MCP connectors (Slack, Notion, Figma, Snowflake, and so on); none are authenticated here. |
| Marketplaces known to Cowork | `cowork_plugins\known_marketplaces.json` | 3 | anthropics/knowledge-work-plugins, quant-sentiment-ai/claude-equity-research (one command: trading-ideas), local-desktop-app-uploads (empty). |
| Desktop extensions (DXT) | `Claude Extensions\` | 2 | apify-mcp-server 0.14.3, pdf-toolkit 0.11.0 (43 tools: read, fill, merge, split, sign, compare, render). |
| Desktop MCP servers | `claude_desktop_config.json` | 2 | blender (uvx blender-mcp), nx-echo (the Echo stdio server). |
| Cowork session transcripts | `local_*.json` | 199, Feb 25 to Aug 19, 39 MB | Titles by month: Feb 17, Mar 115, Apr 5, May 39, Jun 13, Jul 5, Aug 5. March is the AURA build (38 titles); May onward is the Rainey production line: citation verification 20, op-eds 12, research 19, legislator lists, memos, briefs, events. |
| Claude Code session records | `%APPDATA%\Claude\claude-code-sessions\<account>\<org>\` | 677 files, Mar 9 to Sep 3 | The Claude Code side of the same account, this program's build history included. |
| Claude Code home | `~\.claude\` | | `CLAUDE.md` (1.1 KB: CARL + google-style), `settings.json` (one hook: UserPromptSubmit runs `hooks\carl-hook.py`; autoMode on; no plugins installed), `skills\` (carl-help, carl-manager, google-style), `commands\` (paul: 26 commands; carl: 5 tasks; collect.md: the DataCollector run), `paul-framework\` (13 references, 22 templates, 21 workflows), `plans\`, `fixes\` (12 fix specs from the NX-BETA era), 16 project dirs (Desktop, NX-BETA, NX-DELTA, NX-ECHO, Side Quest, 10 worktrees). |
| CARL rule domains | `~\.carl\` | 5 files + sessions | global (9 rules, always on), commands (star-commands: *dev, *review, *brief), context (rules by remaining-context bracket: FRESH, MODERATE, DEPLETED, CRITICAL), manifest, an example custom domain. No project-level `.carl` in Side Quest or Echo. |
| Official Claude Code marketplace | `~\.claude\plugins\marketplaces\claude-plugins-official\` | 32 plugins + 15 external, none installed | code-review, pr-review-toolkit, feature-dev, hookify, ralph-loop, security-guidance, skill-creator, plugin-dev, commit-commands, claude-md-management, and the language servers. |
| Desktop working folder | `Desktop\Claude\` | | `Work\` (the AURA Phase 4 package: a 20-agent swarm design with a Genesis Manager, a Dynamic Skills Manager (#20) that binds skills per agent, task type, and persona at runtime, a Validator, a Memory Curator, scrapers; `task_queue.db`, `genesis.db`; the deployment scripts; dossiers, MOUs, briefings), `Skills\` (the DataCollector: six intelligence domains, RSS + browser + search, `collector.db`, daily digest; six imported skill repos; a skills research set), `Agents\DataCollector\` (a Node project), `skill builder\` (the MASTER_SKILL work), `EVE\`, two packaged skills. |

Two things the inventory settles. First, the "Projects" section of Cowork is the 11 spaces, and each one already states a law in his words: never em dashes, op-eds 700 words or less, Rainey branding, internal-data verification never uses outside search, the certifying PDF is the output. Second, "all the plugins" is three surfaces, not one: the Cowork skills plugin (27), the knowledge-work plugins (11, with agents), and the desktop extensions (2), plus the uninstalled official marketplace whose patterns matter (hookify, ralph-loop, code-review).

## 2. The port table

Each row names the item, its ZOE target (the merged program, either runtime), the stage in the merge map, and the action. "Guide" and "shape" are kinds in the skill shelf ([lib/skills.js](../lib/skills.js)); Echo's registry is `echo/nl/skills` with `_manifest.yaml`; the merge map's row 17 (learning and correction) already names skills, procedures, directives and self_model as one target.

| # | Item | ZOE target | Stage | Action |
|---|---|---|---|---|
| P1 | The 11 spaces: folders + instructions + per-space memory | One project object per space: an Echo project (folder-linked, `convert_folder_to_project`) bound to a Side Quest focus; the instructions become directives on the focus; the per-space memory files load into the operator model store as dated laws and project facts (the Armstrong attribution rule, the no-em-dash rule, the ND canonical facts, the datacenter three framings) | 4.5 seed, row 17 | Import script, read-only on the Cowork side; idempotent by space id. The instructions are LAWS, written verbatim. |
| P2 | The 3 synced claude.ai Projects: prompt templates + 14 files + 31 cached briefings | The writer role's prompts (op-ed, policy briefing) seeded from the two templates; the attached files and cached briefings ingested as documents with the project as origin (birth context) | 4.5 B, row 1 | `ingest_file` per file after the read-path cure (section 3), never before. |
| P3 | The 10 project folders on disk (122 files) | Documents, ingested with origin = the space; the certification HTML+PDF pairs become the verification shape's reference set | row 1 | Same as P2. The 42 op-ed files are the writer's style corpus; the 50 certifications are the challenger's exemplars. |
| P4 | The approved certification template (`build_certification.py`, format 2026-05-08) | The verification deliverable shape. Echo already renders `rainey_render_citation_certification` and `saga_render_verification`; ZOE keeps ONE, the one that matches the approved format, cert ID, ruling box, four stat counters, claims table by level | rows 22 to 23 (document road) | Parity check first: render the same claims through both and diff against a certified PDF in P3. Keep the winner, retire the other. |
| P5 | master-skill (his dispatcher): routing table, six chain protocols, the JSON envelope, seven core rules | The swarm contract (design section C): the plan carries the chain, the brief carries the envelope, the seven rules are role-registry defaults (no-ask, chain by default, parallel when independent, file output, sources always, quality gates, JSON between steps) | 4.5 C | Fold the routing table into the trigger-to-tier law's intent table; fold the envelope into the run ledger's artifact record. This is Lucas's own earlier statement of the contract; it outranks a fresh design. |
| P6 | deep-research-pdf, the weekly-news-brief skill, the DataCollector six domains | Deliverable shapes on the document road: the interactive research PDF (2-page brief, TOC, sections, references), the weekly brief (dashboard cover + six sections), the six-domain digest | rows 22 to 23; the scheduler | Register as `shape` kind on the shelf with the body = the skill text; the weekly brief becomes a scheduled deliverable in Side Quest's scheduler (Echo's `schedule` table has 0 rows; Side Quest's scheduler owns it). |
| P7 | The 5 brand-voice agents (content-generation, conversation-analysis, discover-brand, document-analysis, quality-assurance) with model slots | Five role templates in the role registry, model slots mapped to the fleet classes (sonnet → mid class, haiku → cheap class), memory scope = the operator model's brand section | 4.5 B | Direct port of the agent frontmatter shape into Echo's manifest shape; the prompts are the seed, the Rainey voice from P1 and P3 is the content. |
| P8 | The 63 knowledge-work skills | `guide` kind on the shelf, one trigger line each, body on pull; grouped by the plugin as the skill's domain | row 17 | Import as data, not as code. Legal, finance, operations and design skills are latent until a task pulls them; data and engineering skills feed the pen (analysis lane, code-review, testing-strategy, debug). |
| P9 | productivity memory-management (two-tier: a hot cache of ~30 people and terms, a full glossary behind it) | The operator model store's decoder ring: people, acronyms (LAMP, KDB, Sec 401), projects, in the exact two-tier shape, on the hot path | design G, row 17 | This is the hot-path law applied to vocabulary. Seed the hot tier from the 199 titles and the space instructions; the CRM is the full tier. |
| P10 | The Anthropic document skills (docx, pptx, xlsx, pdf, theme-factory, canvas-design, web-artifacts-builder) | The renderer side of the document road: Echo's saga and vault renderers plus the report-graphics door already cover op-ed, briefing, verification and quick-hit; xlsx export exists for lists. Port the skill BODIES as guides for the writer and renderer roles; do not port the Cowork VM scripts | rows 22 to 23 | Gap check per shape: pptx has no ZOE renderer; docx round-trip exists only through the canvas. Both are acceptance-suite shapes (section 5). |
| P11 | PAUL (plan → apply → unify; work units at 50% of context; AC-N acceptance criteria; the research-quality-control reference with HIGH/MEDIUM/LOW/UNKNOWN confidence) | The pen's cadence and the citation gate's labels: every brief carries acceptance criteria, every finding carries a confidence level, a work unit never exceeds half a context, unify = the fold | 4.5 C and E; leg D | Verbatim port of the four confidence levels and the sizing rule into the swarm primitive; the 22 templates are the brief and handoff shapes. |
| P12 | CARL (rule domains with keyword recall, context brackets, star-commands, the UserPromptSubmit hook) and the carl-manager skill ("make this a rule") | The correction door: a chat correction becomes a rule in a domain, injected at every prompt build by keyword and by context bracket; "make this a rule" is the verb. Side Quest's `directives` table is the store; Echo's policies read the same rows | row 17; his ask "bake her ability to learn from chat corrections into the self-learning lanes" | Port the hook shape (rules injected per prompt, recall by keyword, always-on globals) and the manager's router. This is the mechanism he asked for on 09-03. |
| P13 | Official marketplace patterns: hookify, ralph-loop, code-review, security-guidance, commit-commands | The pen: hookify = rule-to-hook compilation for the correction door; ralph-loop = the pursuit lane's bounded retry; code-review = the pen's review stage; commit-commands = the landing step | leg D | Patterns only; nothing is installed and nothing needs to be. |
| P14 | The AURA Phase 4 package: the 20-agent swarm, the Dynamic Skills Manager (#20), the Validator, the Memory Curator, task_queue.db, genesis.db | Archaeology, alongside NX-BETA and Alpha: the Skills Manager IS the role registry's per-role tool allowlist and skill binding; the Validator IS the challenger; the Memory Curator IS the maturation organ | merge map archaeology | Read for design, never for code. Record the lineage row. |
| P15 | The two AURA workspace TOMLs in the Legislative Tracker folder (legislative_tracker, background_desk) with the mandatory tool order: local database first, then the API, then the web, and a pipeline output contract | The collector role's tool policy, in his own March words: the database is the foundation, the web is the last resort | 4.5 B | Port the order verbatim as the collector role's tool guidance. |
| P16 | pdf-toolkit (43 tools) and the apify extension | Echo already carries av, web and document tools; the PDF read, fill, merge, split and sign set is a real gap for the document road | rows 22 to 23 | Evaluate as an Echo MCP mount (it is an MCP server); no port of code. |
| P17 | The 199 Cowork transcripts and 677 Claude Code session records | The mining corpus for the operator model (design section 7) and the acceptance suite (section 5) | 4.5 seed | Read as data with the content firewall on. Title-level done; body-level is the mining job. |

Not ported: the plugins' external connectors (Slack, Notion, Figma, Snowflake, HubSpot), none authenticated and none in his workflow; the equity-research command; the Cowork VM paths inside skill bodies (rewritten to ZOE paths at import).

## 3. The database question, measured

### 3.1 The data is there

Read-only census of the Echo foundation stores, row counts by `max(rowid)` (marked ~) or `count(*)` (marked =):

| Store | Size | What it holds |
|---|---|---|
| civic_graph.db | 9.5 GB | ~1,872,750 entities · ~9,097,155 relations · ~6,490,673 entity facts · ~1,562,611 resolution proposals · ~344,179 link candidates · ~11,669,989 audit rows |
| electoral.db | 2.9 GB | ~280,910 contacts (the CRM) · ~1,519,503 bills with search index · ~828,222 donations · ~6,015,692 facts · ~185,321 enrichment jobs · ~604,684 enrichment findings · ~71,988 memberships · ~67,138 accounts |
| knowledge_graph.db | 12.9 GB | ~10,915,222 nodes · =186,282,999 edges · ~26,037 anchors (1,517 quarantined, 1,313 unresolved) |
| general_knowledge.db | 21.6 GB | ~22,440,223 CourtListener articles · ~1,690,031 caselaw · ~219,144 CFR sections · ~60,155 US Code sections · state codes (AR, CO) · Gutenberg (the books) · CDC · Wikiquote |
| corpus.db | 32.6 GB | =2,646,315 articles, full text with FTS |
| knowledge_legal_stage.db | 1.2 GB | =76,959,991 staged citations |
| embeddings_docs.db / embeddings.db | 467 MB / 357 MB | ~190,194 document chunks with vectors · ~1,776,155 entity vectors |
| saga.db | 11.5 GB | ~3,698,433 agent trajectory rows · ~1,663,048 security audit · ~26,709 pass runs · ~2,126 agent runs · 37 episodic memories · 6 memory facts |
| web_cache.db | 1.7 GB | ~6,487,307 cached fetches |

The elected officials, the LAMP ties, the wiki material, the legislation (1.5 million bills), the books and the compounding documents are all present. Lucas's premise holds.

### 3.2 The failures, from the app's own log

The engine's stderr for the current generation (boot_p269, from 09:03 Eastern), tallied over the last 90,000 log lines:

| Failure | Count | Where |
|---|---|---|
| "hybrid path failed, falling back to BM25" | 829 | `echo/mcp/external/graph.py:84` (search_entities) and `echo/research_assistant.py:742` (quick_lookup). Reasons: "bad parameter or other API misuse" 718, "tuple index out of range" 108, "another row available" 5, "no such column: FL/ULOMA/PAC/2018/1" 11, "not an error" 2, "FOREIGN KEY constraint failed" 1 |
| "Error calling tool" | 551 | create_contact 218, ingest_file 173, resolve_or_mint_concept 24, update_contact 19, get_entity 12, propose_entity 11, extract_entities_from_doc 6, promote_grounded_one 5, quick_lookup 3, search_entities 3, propose_relation 3, search_knowledge 2 |
| "audit log failed" | 511 | database is locked 329 · another row available 151 · no more rows available 19 · schema has changed 7 · not an error 5 |
| "security_audit mirror failed" | 101 | another row available 65 · database is locked 29 |
| "crm_schema ensure failed: database is locked" | 86 | the pass worker sidecar |
| "staged read failed, returning live-only" | 4 | the short-term hold, `staging_read.search_staged` |
| Google auth invalid_grant | 43 | the known open item (credentials) |
| usaspending 422 · exa 401 | 11 · 1 | external APIs |

The exceptions under the failing writers: create_contact fails on `INSERT INTO enrichment_finding` with FOREIGN KEY constraint failed (admin.py:854), and on "cannot commit, no transaction is active", "another row available", "not an error", "no more rows available"; ingest_file fails on "database is locked" and "another row available". The cumulative create_contact record is 30,913 errors in 63,718 calls (48%), measured yesterday.

Two corrections to his reading. The short-term holds are not the miss: the staged read failed 4 times against 829 hybrid fallbacks. And the hybrid fallback never returns nothing: it degrades to BM25 on names and summaries, so a search that should have used the vector lane answers from keywords only, and looks like an empty database whenever the words differ from the stored name.

### 3.3 The mechanism, one disease

- The Echo MCP server defines 857 tools as plain synchronous functions (5 are async). FastMCP 3.4.2 runs every synchronous tool on the anyio thread pool (`fastmcp/tools/function_tool.py:305` and `:331` call `call_sync_fn_in_threadpool`). Tool calls therefore run concurrently in worker threads.
- Every tool reads and writes through one connection: `Store.conn`, opened once at `echo/store.py:931` with `check_same_thread=False` and `isolation_level=None` (autocommit). The store's `_write_lock` (an RLock) guards `transaction()` and `log_audit`, and nothing else. Reads take no lock. The hybrid vector lane adds a second process-wide singleton, `_VEC_CON` in `echo/retrieval.py:57`, also unlocked.
- Two threads stepping statements on one SQLite connection produce exactly the errors in the ledger: "bad parameter or other API misuse", "another row available", "no more rows available", "not an error", "database schema has changed". "tuple index out of range" is `embed(query)[0]` on an empty result from a raced embedding call.
- create_contact (admin.py:766) takes `conn = _store().conn` directly, outside `transaction()`, and issues three autocommit INSERTs in a row (contact, enrichment_job, enrichment_finding). `cursor.lastrowid` reads SQLite's per-connection last-insert id; when another thread inserts between the second and third statement, `job_id` names a row in some other table and the foreign key fails. That is the 48%.
- "database is locked" (WAL, busy_timeout 5000) is the audit log and the CRM schema check waiting more than five seconds behind long write transactions from the same and other processes: the audit-log home item on the open list.
- "no such column: FL" is a smaller, separate defect: a query containing `FL:` reaches an FTS5 MATCH on a path that does not strip the colon (the hybrid lane sanitizes with `[^\w\s'-]`, which does strip it; the remaining site is downstream of it and needs one probe).

### 3.4 The cure, and where it lands

An Echo change, LOCAL commit only, in the campaign's cut shape (measure, build, gate with `-m "not live"`, cycle, read):

1. Per-thread read connections. `Store` hands each worker thread its own read-only connection (thread-local, opened on first use, `PRAGMA query_only`), attached to the same corpora. The write connection stays single and every write path goes through `transaction()` under the RLock. `_VEC_CON` becomes thread-local the same way.
2. create_contact, update_contact, ingest_file, resolve_or_mint_concept, propose_entity: inside `transaction()`, so the three INSERTs commit as one and `lastrowid` is read under the lock.
3. The audit and security-audit mirrors write through a queue drained by one writer (the audit-log home), so a tool never waits on the ledger.
4. The hybrid lane's empty-embedding case returns the BM25 lane instead of raising; the colon case gets the same sanitizer at every MATCH site.
5. Pins: a smoke that fires twenty concurrent search_entities and create_contact calls against a scratch store and asserts zero "API misuse" and zero foreign-key failures; the live read is the same tally over ten minutes, expected to go from 829 and 551 to zero.

This cut goes first on resume, ahead of cut 18, because it is the DB-is-foundation law with a count on it: the reply path asks the graph and gets keywords back 829 times a morning. His word decides the order.

## 4. The build order, revised

1. **Cut 18-E, the shared-connection cure** (Echo, local). Section 3.4. Read: the fallback and error tallies on the next generation.
2. **Cut 18, the Side Quest siblings**: searchDocuments IDS shape (measured 1.3 to 1.8 s → 2 to 8 ms), localdb inventory in a worker or precomputed, retentionSweep off the tick, the meter-ring persist and spend fold, getKnowledgeVectorRows cached by version.
3. **The usage law**: four tiers (user, directives, development, expansion), queue-aware pacing on expansion only, the cheap-model exemption, the swarm slot on gemma4:31b-cloud, burst margin 0.10 → 0.02, the reset re-anchor. With it the two lane fixes: chat-triggered Echo agents ask the directed lane; partitions inherit the parent's lane and log the swarm-live skip.
4. **Stage 4.5 with the ports folded in**: the trigger-to-tier law (P5's routing table feeds it) → the role registry seeded from Bravo's templates, P7's five agents, P15's collector policy, the Alpha challenger → the run ledger (P5's envelope as the artifact record) → the swarm primitive with markers, the citation gate carrying P11's confidence levels, the challenger → the fold.
5. **The correction door** (P12 + P13): a chat correction becomes a rule in a domain, injected at every prompt build; "make this a rule" is the verb; hookify's shape compiles a rule to a hook. This is where "learn from chat corrections" lands, and it must land before the acceptance test so the test's failures can be corrected in chat.
6. **The Cowork import** (P1, P2, P3, P9, P17 title tier): spaces → projects with laws; the two prompt templates → the writer's prompts; the 122 files and 14 attachments → documents with origin; the decoder ring's hot tier. Runs after step 1 because it is 136 `ingest_file` calls into a server that currently fails one in three.
7. **The shelf import** (P6, P8, P10): 27 + 63 skill bodies as guides and shapes; the weekly brief as a scheduled deliverable; the pptx gap named.
8. **The acceptance suite** (section 5), run: first the research paper, then the cited op-ed, then the certification.
9. **Stage 5 and the harness legs** A, D, B, C; P4's parity check and P16's mount ride with the document-road rows.
10. The search-path and memory hot-path legs; the remaining rows.

A step counts as done when a smoke pins its contract from both runtimes and the acceptance suite's score moves.

## 5. The acceptance suite, from his own record

The 199 titles and the 11 spaces give the task distribution. Each shape below has a real exemplar on disk, so grading is a diff, not an opinion.

| Shape | Exemplars | Laws it must satisfy | Count in the record |
|---|---|---|---|
| Cited op-ed, Rainey voice | 42 files in Op-Eds; the Louisiana writing guide; the methodology doc | 700 words or less; no em dashes; every claim sourced; Rainey branding | 12 sessions + the Op-Eds space |
| Citation and fact-check certification | 25 HTML+PDF pairs; the approved template | The 2026-05-08 format: cert ID, ruling, four counters, claims by level | 20 sessions + 2 spaces |
| Internal-data verification | 3 certified briefs against the Rainey KDB | Never an outside search; prime data first, then the whole KDB | the Internal Data Verification space |
| Legislator list and database export | NC and Utah Republican legislator builds; the LAMP roster | xlsx export; every row from the CRM; cite or leave blank | 4 sessions + the Elected List Builder space |
| Policy briefing and research dossier | 31 cached briefings (state briefings, US-Israel bible, water security); the ND overview; the interactive research PDF | The briefing structure named in the Policy Briefings template; the 2-page brief + TOC shape | 19 research sessions + 3 spaces |
| Weekly news brief | the scheduled skill; the News Briefs folder | Dashboard cover, six sections, work-connection callouts, Saturday | 1 scheduled task + 3 sessions |
| Polling lookup and cross-check | the Internal Polling space | Existing institutional polling first; Rainey polling references verified | 2 sessions |
| Event package | run-of-show, senator briefs, one-pager | Rainey style; audience-specific versions | 6 files in the Live Events space |
| Quick-hit article | 4 files | Short form for Substack; complex subject, digestible | 2 sessions + 1 space |
| The research paper (design section J) | none yet: the gap | Cited, challenged, verified, caveats section, by a swarm, under budget, no operator engaged | the acceptance test |

## 6. Laws carried into this revision

- All aspects of both sides merge or ZOE won't work. The Cowork side is a third side and merges under the same law.
- The database is the foundation; the model is the voice. Section 3 is that law with a count.
- Short-term memory is the hot path. P9's two-tier decoder ring and the staged read are the same shape.
- Merge for functionality: keep the best of each duplicate (P4's parity check is the method).
- Every law he states in a space's instructions is written verbatim into the operator model and the plan.
- Echo commits stay local. Side Quest pushes to the feature branch only.
