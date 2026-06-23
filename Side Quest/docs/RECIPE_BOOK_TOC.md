# Zoe Recipe Book — Table of Contents (for review)

> **Status: APPROVED — building. Storage = server-side in Echo (chosen). Order = all of Category A first.**
> Grounded in Echo's live introspection surface (get_db_map / get_atlas / get_tool_map, read 2026-06-22).
> Every "Echo data" recipe below maps to a CONFIRMED table or tool — no guesses.

## ✅ BUILD STATUS (2026-06-22)
**Server-side executor is BUILT (additive; inert until Echo restarts):**
- `echo/mcp/external/recipes.json` — the registry (10 recipes seeded, all live-validated).
- `echo/mcp/external/recipes.py` — `list_recipes()` (cheap menu) · `describe_recipe(name)` · `run_recipe(name, arg, limit)`.
  Reuses db_query's hardened path verbatim (validate_select + readonly conn + tenant scope). Recipes fold
  name→id resolution INSIDE the SQL (entity_search.rowid = entities.id), so callers pass only a human arg.
- Registered in `echo/mcp/external/__init__.py`. Offline contract smoke: `scripts/smoke_recipe_book.py` → 81/81.

**run_recipe PROVEN LIVE end-to-end on 8765 (2026-06-23):** 521 tools; list_recipes + all seeded recipes
smoke-passed (lamp-count=434, committee-roster, poll-toplines, officials, find-person) + graceful bad-name/missing-arg.

**22 recipes validated (each carries a live `proof`).** Offline contract smoke 174/174.
- *Batch 1 (LIVE via run_recipe):* find-person · officials-in-state · committee-roster · find-bill · member-votes ·
  donations-to-person · poll-recent · poll-toplines · lamp-count · lamp-roster.
- *Batch 2 (SQL validated via db_query; need one Echo restart to go live in run_recipe — lru_cache):*
  entity-facts-search · industry-sector · member-committees · bill-detail · bill-rollcall · donations-from-donor ·
  donation-totals-by-cycle · company-pac-candidates · contact-bio-timeline · contact-socials · contact-aliases · **search-vault**.
- *search-vault* = FTS over the Rainey vault → answers "find OUR papers on X" instead of a web search (the exact thing she failed at).

**`kind:"tool"` SHIPPED (run_recipe is now async; dispatches SQL recipes OR named Echo tools via `external.get_tool(name)` + `await tool.run(mapped_args)`).** This lets the book wrap tool-backed data recipes AND Category-B delegation under the same `<echo-recipe>` interface. tool_args template substitutes `$arg`/`$limit`.

**26 recipes total (22 sql + 4 tool); offline contract smoke 200/200.** Batch-3 tool recipes (validated via direct tool call on 8765):
- `entity-dossier` (get_entity, name-in — card + relations + KG dossier; folds the A8 wikipedia/kg need).
- `search-knowledge` (search_knowledge — wikipedia/caselaw/CFR/etc.).
- `semantic-doc-search` (search_documents_semantic — vault vectors; tenant-scoped).
- `delegate-legislative-analysis` (delegate_to_legislative_analyst) — **first Category-B (agent-assign) recipe**; tool confirmed present, not fired.

**PENDING:** (1) **restart Echo** to activate all 26 in run_recipe (recipes.py + recipes.json are lru_cached at boot — server still runs the 10-recipe sync version). Then live-smoke the full set incl tool recipes. (2) widen remaining Cat-A/B tool recipes. (3) Zoe-side `<echo-recipe name arg/>` tag + list_recipes menu in suit ctx. Then C/D/E.

## Why this exists (the contract for every recipe)
A 24B @ num_ctx 8192 can't hand-pilot 518 tools. A recipe pre-bakes the two things she fails at
— **which tool/SQL** + **what args** — so her job collapses to: *match intent → fill ONE param → run.*

**Recipe shape** (the atlas `fast_paths` template, extended):
```
{ id, intent (NL triggers), params:[...], kind, target, sql|tool|delegate, not (anti-pattern), cite }
```
- `kind` ∈ `sql` (db_query parameterized SELECT) | `tool` (single MCP tool call) | `delegate` (hand to Echo agent) | `render` (deliverable) | `zoe` (her own macro)
- `cite`: does it feed a deliverable that needs cite_floor≥1? (drives whether she must capture sources)

**Wiring (her side, already designed):** recipe MENU in suit ctx (cheap) + `<echo-recipe name="X" arg="Y"/>`
tag the bridge expands → runs the validated procedure. Highest-frequency asks also get a deterministic
intent→recipe match (zero model emission). Recipes for the 80%; `delegate` for the long tail.

**Storage:** A-category (Echo data) → server-side in Echo atlas `fast_paths` (shared w/ Echo UI = the
"modify Echo" part). B/C/D/E (orchestration + Zoe macros) → Zoe-side. Confirm during build.

---

## CATEGORY A — Echo DATA recipes (the big set)
*Grounded in the civic_graph(main) + electoral + knowledge_graph + foundations union.*

### A1 · People & entity lookup  *(entity_search FTS, 1.62M entities)*
- [ ] **A1.1 find-person-or-org** — "who is X" → `SELECT name,entity_type FROM entity_search WHERE entity_search MATCH ? AND entity_type!='document' ORDER BY rank LIMIT ?` · param: name · *not:* `entities LIKE` (scans 1.7M). `tool` alt: `search_entities`/`quick_lookup`.
- [ ] **A1.2 resolve-entity-exact** — exact-name disambiguation → `entities WHERE name_ascii=lower(fold(?))` then LIKE fallback.
- [ ] **A1.3 entity-dossier** — full picture of one entity → `get_entity` (facts + relations + degree). param: entity_id.
- [ ] **A1.4 entity-facts-search** — find by attribute/bio text → `entity_facts_fts MATCH ?` JOIN entity_facts. param: phrase.
- [ ] **A1.5 industry-sector** — lobbyists/cos in a sector → `entity_industry WHERE sector=?` (indexed). sectors: energy, tech, finance, healthcare, ag, labor, advocacy, lobbying_services…
- [ ] **A1.6 entity-history** — what changed about X → `get_entity_history`. param: entity_id.

### A2 · CRM / contacts  *(electoral.contact, 40k rows, 92 cols — select narrow)*
- [ ] **A2.1 officials-in-state** — "officials/delegation for <state>" → `contact WHERE deleted=0 AND (MailingState=? OR State_Represented=?)` · *not:* MailingState alone (federal members ='US'). `tool` alt: `search_contacts`.
- [ ] **A2.2 contact-card** — one official's CRM record → `get_contact`. param: contact_id.
- [ ] **A2.3 contacts-by-facet** — filter by party/chamber/jurisdiction → `contact_facets` then `list_contacts_page`. params: Party__c, Chamber__c, Jurisdiction__c.
- [ ] **A2.4 contact-aliases** — known names/spellings → `alias__c WHERE Contact__c=?`.
- [ ] **A2.5 contact-bio-timeline** — career events → `bio_event__c WHERE Contact__c=? ORDER BY Event_Date__c`. (41k rows)
- [ ] **A2.6 contact-socials** — official handles → `social_handle__c WHERE Contact__c=? AND Is_Official__c=1`.
- [ ] **A2.7 search-contacts-text** — fuzzy name search → `contact_search MATCH ?` (FTS).

### A3 · Committees & memberships  *(incl. LAMP — the recipe we were missing)*
- [ ] **A3.1 committee-roster** — "members of committee X" → `committee_membership__c WHERE Account__c=?` (⚠ Account__c is MIS-DECLARED; true referent = committee ENTITY in cg.entities). JOIN contact for names.
- [ ] **A3.2 member-committees** — "what committees is X on" → `committee_membership__c WHERE Contact__c=?`. `tool` alt: `committee_memberships`.
- [ ] **A3.3 lamp-network-count / roster** — "how many LAMP members" (the original failure) → resolve LAMP via `import_lamp_network` domain / `lamp_prospect_archive`; count + roster. **Needs a schema spike on lamp_prospect_archive before authoring.**
- [ ] **A3.4 committee-hierarchy** — parent/sub committees → `committee_hierarchy_nodes`.

### A4 · Legislation / bills  *(bill_meta 1.46M, bill_search FTS)*
- [ ] **A4.1 find-bill** — "bill about X" / by number → `bill_search MATCH ?` or `bill_lookup`. params: query | state+session+number.
- [ ] **A4.2 bill-detail** — one bill's meta → `get_bill` / `bill_meta WHERE bill_id=?` (sponsor/yea/nay counts).
- [ ] **A4.3 bills-in-session** — "bills in <state> <session>" → `list_bills` / `bill_facets`. params: state, session.
- [ ] **A4.4 bill-as-entity** — bill's graph neighborhood → bill_id IS an entity id → `kg_neighborhood`/`get_entity`.

### A5 · Votes  *(vote_record__c, 16k)*
- [ ] **A5.1 member-votes** — "how did X vote" → `vote_record__c WHERE Contact__c=? ORDER BY Vote_Date__c DESC`.
- [ ] **A5.2 bill-rollcall** — "who voted on <bill>" → `vote_record__c WHERE Bill_Name__c=?` GROUP BY Vote_Value__c.

### A6 · Campaign finance / donations  *(donation__c, 828k)*
- [ ] **A6.1 donations-to-person** — "who funds X" → `donation__c WHERE Recipient_Contact__c=? ORDER BY Donation_Date__c DESC` (atlas recipe).
- [ ] **A6.2 donations-from-donor** — "what did X give" → `donation__c WHERE Donor_Contact__c=? OR Donor_Account__c=?`.
- [ ] **A6.3 company→PAC→candidate** — trace corporate money → `relations r1(AFFILIATED_WITH) JOIN r2(CONTRIBUTED_TO) ON r1.target_id=r2.source_id` (bridge pre-built for ~4,400 cos).
- [ ] **A6.4 donation-totals-by-cycle** — sums per cycle → `SELECT Cycle__c,SUM(Amount__c) … GROUP BY Cycle__c`.

### A7 · Polling  *(poll_fielding 272 / question / option / topline)*
- [ ] **A7.1 poll-toplines** — "results of poll X" → `poll_question q JOIN poll_topline t ON t.question_id=q.question_id JOIN poll_response_option o ON o.option_id=t.option_id WHERE q.fielding_id=?` (atlas recipe). `tool` alt: `get_poll`.
- [ ] **A7.2 find-poll** — by subject/pollster → `poll_fielding WHERE entity_id=?` / `search_poll_questions`.
- [ ] **A7.3 poll-crosstab** — subgroup breaks → `compare_subgroups`/`chart_subgroup`. params: question_id, subgroup.
- [ ] **A7.4 poll-trend** — topic over time → `trend_over_time`/`chart_trend`.

### A8 · Knowledge graph / Wikipedia / reference corpora
- [ ] **A8.1 entity-wikipedia** — "Wikipedia for X" → `kg_node n JOIN kg_anchor a ON a.node_id=n.node_id WHERE a.entity_id=?` (anchored article).
- [ ] **A8.2 article-neighbors** — related topics → `kg_edge WHERE src_node_id=? AND edge_type='wikilinks_to'`.
- [ ] **A8.3 search-wikipedia** — general fact lookup → `search_knowledge(source='wikipedia', ?)`.
- [ ] **A8.4 search-law** — caselaw/CFR/US-code → `search_knowledge(source='cfr'|'us_code'|'caselaw'|'courtlistener', ?)`.
- [ ] **A8.5 kg-neighborhood** — entity's local graph → `kg_neighborhood`/`knowledge_neighborhood`. param: entity_id.

### A9 · Vault / Rainey documents & grounded search
- [ ] **A9.1 search-vault** — "find in our docs" → `search`/`search_knowledge` over vault_index (curated Rainey docs). cite=yes.
- [ ] **A9.2 doc-by-path / recent** — open a known doc → `get_document_by_path` / `recent_documents`.
- [ ] **A9.3 semantic-doc-search** — meaning not keyword → `search_documents_semantic`. cite=yes.
- [ ] **A9.4 sources-for-claim** — citation chain for a fact → `get_sources_for` / `kg_cite_chain`. cite=yes.
- [ ] **A9.5 rainey-crm** — Rainey contact lookup → `rainey_crm_search`/`rainey_crm_get`.

### A10 · Cross-DB / network traces  *(the spine the schema can't reveal)*
- [ ] **A10.1 graph→CRM** — entity to its CRM bio (party/gender) → `entities.contact_id → electoral.contact.id`.
- [ ] **A10.2 known-associates** — who's connected to X → `known_associate__c` / `query_graph`. (relation tables)
- [ ] **A10.3 endorsements** — who endorsed whom → `endorsement__c` (endorser/endorsee contacts).
- [ ] **A10.4 mentions-in-docs** — entity referenced in which docs → `content_document_link WHERE LinkedEntityId=?` (polymorphic) / `find_mentions`.

---

## CATEGORY B — AGENT-ASSIGNMENT recipes  *(when to DELEGATE vs pilot)*
*Intent → which Echo agent. This is the long-tail/heavy work she should hand off, keeping her voice.*
- [ ] **B1 track-legislation** → `delegate_to_bill_tracker` / `add_legislative_tracker`. trigger: "watch bill/topic X".
- [ ] **B2 write-briefing** → `delegate_to_briefing_writer`. trigger: multi-source briefing on a topic.
- [ ] **B3 verify-citations** → `delegate_to_citation_verifier` (or `rainey_citation_verifier`).
- [ ] **B4 draft-deliverable** → `delegate_to_deliverable_drafter`. trigger: op-ed/memo first draft.
- [ ] **B5 analyze-donor-flows** → `delegate_to_donor_flow_analyst`. trigger: "trace the money behind X".
- [ ] **B6 fact-check** → `delegate_to_fact_checker` (or `rainey_fact_checker`).
- [ ] **B7 historical-research** → `delegate_to_historical_researcher`.
- [ ] **B8 legislative-analysis** → `delegate_to_legislative_analyst`. trigger: "what does this bill do / its effects".
- [ ] **B9 opposition-research** → `delegate_to_opposition_researcher`.
- [ ] **B10 polling-strategy** → `delegate_to_polling_strategist`.
- [ ] **B11 press-monitor** → `delegate_to_press_monitor`. trigger: "watch coverage of X".
- [ ] **B12 spawn-custom-agent** → `spawn_agent_async` / `team_spawn` for anything not covered + check via `agent_status`/`agent_inbox`.
- [ ] **B13 delegate-decision rule** — the META recipe: cheap data ask → A-recipe inline; heavy/multi-step/synthesis → delegate. (the guardrail that stops her trying to pilot it herself)

## CATEGORY C — MODEL-PICKING recipes  *(intent → tier)*
*Echo's cloud swarm (gemma4:31b / kimi-k2.6 / deepseek-v4-pro) + local floor (hermes3:8b). Routes via `llm_overrides`, `governor_state`, `agent_competence_probe`, `get_quota_summary`.*
- [ ] **C1 tier-by-task** — quick lookup/extract → local floor; synthesis/long-form/reasoning → cloud frontier. (the default ladder)
- [ ] **C2 probe-then-pick** — uncertain difficulty → `agent_competence_probe` first, then route.
- [ ] **C3 budget-aware** — check `get_quota_summary` before spending a frontier call; downgrade if near cap.
- [ ] **C4 override-model** — explicit "use the big model" → `llm_overrides` for that task.
- [ ] **C5 hire-card** — recurring specialized need → `propose_hire`/`hire_card` (persistent agent w/ fixed model).

## CATEGORY D — ZOE ACTION recipes  *(her own macros — recorder.js / flow_runner, ZERO model calls)*
*Existing 5: gcal_create_event, gdrive_open_doc, gmeet_join, gmeet_post_chat, substack_publish. Extend:*
- [ ] **D1 open-and-read-tab** — navigate + extract page text (the "see the tab" path).
- [ ] **D2 gmeet-full-cycle** — join → observe → post (compose existing macros).
- [ ] **D3 file-read / file-write** — her local file tools as named recipes.
- [ ] **D4 substack-draft** — draft (not publish) variant of substack_publish.
- [ ] **D5 calendar-check** — read upcoming via gcal (read variant).
- [ ] **D6 record-new-macro** — meta: trigger recorder.js to learn a new browser flow on demand.

## CATEGORY E — DELIVERABLE RENDER recipes  *(bridge A+B → an artifact; cite_floor≥1)*
*Saga path = canvas DOC; Vault path = file artifact + cert workflow.*
- [ ] **E1 quick-hit** → `saga_render_quick_hit` / `vault_render_quick_hit`.
- [ ] **E2 executive-briefing** → `saga_render_executive_briefing` / `vault_render_executive_briefing`.
- [ ] **E3 op-ed** → `saga_render_op_ed` / `vault_render_op_ed`. (Rainey byline work)
- [ ] **E4 verification-report** → `saga_render_verification` / `vault_render_verification`.
- [ ] **E5 citation-pack** → `saga_render_citation_pack`.
- [ ] **E6 draft-review** → `saga_render_draft_review`.

---

## Open spikes before authoring (small, targeted reads)
1. **lamp_prospect_archive** schema (`get_schema`) — A3.3 is the flagship "we were missing this" recipe; confirm its shape + how LAMP membership is modeled.
2. **contact** narrow column set (`get_schema('contact', sample_rows=0)`) — pick the ~8 cols A2.* should SELECT (it's 92 wide).
3. **llm_overrides / governor_state** (`describe_tool`) — confirm C-category routing levers are real + how to set them.
4. **relations** relation_type vocabulary — confirm AFFILIATED_WITH / CONTRIBUTED_TO / endorsement edge names for A6.3 / A10.*.

## Build order (proposed)
**Phase 1 (highest ROI):** A1, A2, A3 (incl. LAMP), A4, A6.1, A7.1 + B13/C1 guardrails — covers her most common asks.
**Phase 2:** rest of A + E (deliverables) + B delegate set.
**Phase 3:** C model-picking + D Zoe-macro extensions + deterministic intent→recipe matcher for top-N.

---
*Counts: A≈37 · B≈13 · C≈5 · D≈6 · E≈6  →  ~67 recipes proposed. Prune/expand freely.*
