# Zoe + Echo — System Data-Flow Map

_Generated 2026-07-11 from a code-grounded audit of both repos (Zoe = `Side Quest`, Node/Electron; Echo = `NX ECHO/nx-echo`, Python). All cadences are **code defaults** — the live `.env` overrides several (noted in §11). file:line references are current as of this date; verify before relying._

---

## 0. The shape (three processes, two databases-of-record)

- **Zoe (Electron/Node)** — the front, the perception surface, the orchestrator. Owns local working state: `sq.db` (short-term memory buffer), `puller.db`, `canvas_layout.db`, `news_bucket.db`, `api_store`. Entry `main.js`.
- **Echo (Python MCP server)** — the long-term knowledge base of record: `civic_graph.db` (entities/relations), documents/vault, `canvas_blocks`, contacts. Serves MCP over `127.0.0.1:8765`. **Schedules nothing itself.**
- **Echo Huey consumer(s)** — a *separate* process (`echo.queue.huey` on `skuld.db`, + a `jobs.db` worker) spawned by the Electron saga-server sidecar. **This is where all of Echo's autonomous timers actually live.** Kill-switch `NX_ECHO_DISABLE_HUEY=1`.

Ownership rule (consistent throughout): **Echo owns knowledge CONTENT; Zoe owns UI/working state + the ORCHESTRATION of Echo's tools.** Zoe never writes Echo's civic_graph foundation directly — it proposes and lets Echo's gates land it.

---

## 1. Data entry points (external → Zoe)

| # | Entry point | Source | Hook / pickup | Lands in | Gate | file:line | State |
|---|---|---|---|---|---|---|---|
| 1 | User chat turns | Lucas typing (+attachments) | IPC `chat:send` → `runChatTurn` | `turns` (speaker=user) | none | main.js:6480 | LIVE |
| 2 | Discord DMs | Owner phone/Discord | `client.on('messageCreate')` → owner-only | chat pipeline | triple-gate: no bots, no guilds, owner id only | lib/discord.js:56,33 | LIVE if token set |
| 3 | Voice/audio transcription | mic / loopback | `listen.start()` → Echo `transcription_capture_*` | next-turn context | phrase-trigger + Echo connected | lib/listen.js:34; main.js:3908 | on-demand |
| 4 | Inbox poll (person mail) | Gmail IMAP unread | `inbox.pollUnread` (4min) | chat `<incoming>`; UIDs in meta | `emailConfig().configured`; junk-sender filter | lib/inbox.js:89; main.js:1340 | LIVE if configured |
| 5 | Email INTAKE lane | same inbox, **EXAMINE read-only** | `pollForIntake` → `email_intake.runIntakeTick` → classify | newsletters→`news_store`; meeting-notes→`doc_store` | bulk/promo heuristics, UID cursor | lib/email_intake.js:108; main.js:1539 | LIVE if configured |
| 6 | RSS/aggregator feeds | ~20–244 feeds (`data/feeds.json`) | `FEED_POLL` (3min) → Echo `fetch_feeds_batch` → `news_poll.insertItems` | `news_items` (rss) | model-free; UNIQUE(source,url) dedup | main.js:1422; lib/news_poll.js:40 | LIVE |
| 7 | Broadcast video captions | 4 live YouTube news streams | `video_capture.CaptureLane` polls caption DOM | `news_items` (video); shots→`news_captures` | `NEWS_VIDEO_CAPTURE` (ON); ad-heuristic; vision OFF | lib/video_capture.js:297; main.js:1725 | LIVE (kill-switch) |
| 8 | Truth Social | tracked public accounts | `truth_poll.runPoll` (15min) | `news_items` (social) | public API, URL dedup | lib/truth_poll.js:88; main.js:1520 | LIVE |
| 9 | Screen observation | Windows desktop titles + screenshot | `<observe-screen/>`/`<screen-see/>` | next-turn context | read-only; title injection-sanitize | lib/screen.js:31,109,55 | on-demand |
| 10 | Shared Chrome reads | Lucas's open tabs (CDP :9222) | Playwright `connectOverCDP`; `<browse-read/>` | next-turn context | read-only; refuses closing active/Meet | lib/browser.js:495,639 | on-demand |
| 11 | Zoe's own browser | any public web | `patchright` persistent Chromium; `<web-open/read/see>` | readings / context | blocker detect; SERP filter | lib/web.js:279,335 | on-demand |
| 12 | Chat-bot replies | character-bot sites | `chat_watcher.sendAndWait` | `insertInbound` OR quiet reading | quiet flag; per-tab dedup | lib/chat_watcher.js:173,278 | on-demand |
| 13 | Google Meet | live meeting | `gmeet` stage machine (captions/attendees) | `transcript` lines; recap→memory | mandatory AI-disclosure intro | lib/gmeet.js:313; main.js:2142 | on-demand |
| 14 | Media watch | YouTube/any video | `media_cc` caption cascade | `transcript` (`media:<id>`); recap→doc_store | 3-day re-watch dedup; ad-strip | lib/media_cc.js:290,426 | on-demand/idle |
| 15 | Full-ingest video pane | video w/ audio | IPC `video:ingest` → transcription | transcription path | valid URL | main.js:2044 | on-demand |
| 16 | Canvas document drop | drag-dropped file | IPC `canvas:drop-doc`; `canvas_ingest` poller (45s) | memory reading; image OCR→cards | `drop-` prefix; seenKeys dedup | main.js:3070; lib/canvas_ingest.js:29 | LIVE |
| 17 | API snapshot stream | FRED/Census | `apiStreamTimer` (6h) → `api_manager.managedCall` | `api_store`→memory on change | cadence; change-detect | lib/api_stream.js:24; main.js:1490 | LIVE |
| 18 | On-demand API pulls | catalog APIs | IPC `api:pull` | renderer/forecast | rate-limit+cache | main.js:1959 | on-demand |
| 19 | API bulk (legislation) | legiscan etc. | `apiBulkTimer` (12h) | memory objects | cadence | main.js:1513 | LIVE |
| 20 | Poll connectors | VoteHub/538/Wikipedia | `forecastLoopTimer` (30min) | in-memory only | fail-soft | main.js:1619 | LIVE (not persisted) |
| 21 | Puller web-discovery | public web staff pages | idle `puller_walk.runDiscoveryMove` | `puller.db` targets/observations | mints ONLY from real browser pages; org-verify | lib/puller_walk.js:294,311 | LIVE on idle |
| 22 | Google Calendar | operator OAuth | IPC `calendar:events` | renderer; Meet-join trigger | OAuth status | main.js:2931 | on-demand |

**Read-only hard guarantees:** email intake opens IMAP with EXAMINE (`inbox.js:140`); screen/browser observation-only; injection-hardening on screen titles + Meet/browser tag parsing.

---

## 2. Data generation points (internal → Zoe)

| Generation point | Produces | Stored | file:line |
|---|---|---|---|
| Graph-walk anchor mint | new entity (existence-gated) | Echo `propose_entity` | graph_walk.js:269-286 |
| Graph-walk related + edges | ≤6 entities + edges w/ calibrated conf + source_set | Echo `propose_relation/entity` | graph_walk.js:290-335 |
| Graph-walk short-term catch | young-endpoint edge minted locally (epistemic `read`, `proposed_by='graph-walk-shortterm'`) | `sq.db graph_relations/entities` | graph_walk.js:344-354 → graph_memory.js:97-123 |
| Graph-walk observations | graded citation trail (promoted/held/reverify) | `sq.db kg_observations` | graph_walk.js:272-440 → db.js:1740 |
| Short-term local graph | entities/relations by epistemic tier + sources/citations | `sq.db graph_*` | graph_memory.js:54-123; schema db.js:341-414 |
| Attendance reconciliation | ATTENDED/EXPECTED_ATTENDEE edges | `sq.db graph_relations` | graph_memory.js:181-204 |
| Puller observations/beliefs/patterns | facts, best-guess answers, per-domain email Beta | `puller.db` | puller_db.js:281-364 |
| Puller-walk fill/discovery | new email/phone belief; net-new person targets | `puller.db` + `kg_observations` | puller_walk.js:168-337 |
| Reflection notes | durable [KNOWLEDGE]/[SKILL]/[SELF]/[INTEREST]; speculation→proposal | `sq.db knowledge/self_model/graph_entity_proposals/reflections` | reflection.js:69-293 |
| Monologue thoughts/readings | idle thoughts + perception/tool-result beats | `sq.db monologue` | db.js:50-60; main.js:485.. |
| Curation beats | first-person pass summaries | `sq.db monologue` | main.js:474-600 |
| News objects | hourly-compressed story clusters (`event` view) | `news_bucket.db news_stories` | news_objects.js:26-46 |
| Forecasts | balance-of-power + margins | **in-memory only (not persisted)** | forecast_loop.js:11-12 |
| kg_observations sink | the shared graded/cited store all feeds write | `sq.db kg_observations` | db.js:511-525; curation_store.js:60 |
| Inline doc decomposition | landed doc → typed entities/edges | Echo + `kg_observations` | main.js:6844-6873 |

---

## 3. Short-term (sq.db) → long-term (Echo civic_graph) gates

Pipeline shape: feeds write graded/cited rows → **citation gate** (mint/hold at write time) → **calibrated confidence + corroboration** decide land-vs-park → **young-endpoint catch** keeps cited-but-unlandable edges local → nightly **runDailyPass** cleans/reconciles/adjudicates + **crosses matured local edges up** → **F2 drain** continuously moves the grounded ≥0.90 band into Echo.

| Gate | Condition | Pass vs hold | file:line |
|---|---|---|---|
| Existence floor | mint only if existence cited ≥ C | cited→mint; else held | curation_gate.js:23,77 |
| Fact floor | edge auto-promotes only if stated ≥ B | cited→propose; inferred→held | curation_gate.js:24,70 |
| Calibrated confidence | grade prior (A.97/B.88/C.72/D.52/E.33), κ=0.5 noisy-OR per source | writes P(true) onto proposal | confidence_model.js:23-50 |
| Corroboration | mirror/domain family collapse | 2 indep→0.94 lands; 1→0.88 parked | corroboration.js:69-92 |
| Doc promotion worthiness | not promoted AND body ≥40 chars | real→promote; thin→skip | promote.js:16-21 |
| Doc promotion landing | `ingest_file` (+`extract_entities_from_doc`) | doc_id→promoted; else retried | main.js:7262 |
| Curator: quarantine | tombstone >48h / speculation / overflow>600 | never-recalled hard-deleted | cloud_curator.js:43-125 |
| Curator: verified reconcile | same key or cosine ≥0.9; newest as_of wins | loser→superseded | cloud_curator.js:399-516 |
| Curator: near-dup merge | cosine ≥0.88 + cloud confirms | dup collapsed | cloud_curator.js:319-385 |
| Curator: self-evolution | cosine ≥0.92 + cloud confirms | collapse to newest | cloud_curator.js:193-216 |
| Curator: proposal adjudication | superseded OR stale >7d (entity **and** relation arms) | rejected; else pending | cloud_curator.js:225-281 |
| graph_memory promotion | requires GROUNDED epistemic | grounded→canonical; speculated→refused | graph_memory.js:126-143 |
| Promote-up candidate select | live+grounded+`promoted_up=0`, ≤50/pass | matured local edges | db.js:1679-1693 |
| Promote-up Echo adjudication | attempt propose; **Echo is the gate** | proposed→`promoted_up=1`; rejected→retry | cloud_curator.js:291-310 |
| F2 auto_promote_grounded | `ZOE_INGEST_ENABLED`; conf ≥0.90; 200/chunk; reversible | grounded band→civic_graph | main.js:658-691 |

---

## 4. Zoe schedulers / heartbeat triggers (the clock)

**Cognitive schedulers (lib/*):** heartbeat (check 30s; idle≥60s + ≥15min gap; away/personal/importance/self-repeat gates) `heartbeat.js:60`; reflection (30s; significance≥150 or idle≥3min+≥10min+≥6turns) `reflection.js:144`; **monologue idle tick** (10s idle / 30s busy) driving lanes `monologue.js:681` → graph-walk (≥30s, 300k tok/hr budget), puller/pipeline (CONTACT≥45s / DISCOVER≥60s, 150k budget), social-enrich (≥90s), face-confirm (≥120s), boredom search (≥5min), capability self-check (~6h), caption lane (~5s when video active); self-scheduler `scheduled_tasks` (30s + boot catch-up) `scheduler.js:20`; continuity (5min; idle≥3min+≥45min gap) `continuity.js:32`; downtime touch (60s) `downtime.js:24`.

**main.js housekeeping passes** (env-gated, most default OFF): curateMonologue (20min, always) `:439`; daily curation (check 30min/gap 20h, `ZOE_CURATION_ENABLED`, idle≥15min) `:489`; integrity auditor (10min/30min, same switch) `:625`; ingest drain (1min, `ZOE_INGEST_ENABLED`) `:658`; research-to-close (15min/20min, `ZOE_RESEARCH_ENABLED`) `:698`; identity-dedup (10min/30min, `ZOE_DEDUP_ENABLED`) `:767`; puller close-loop (30min/60min, `ZOE_PULLER_LOOP_ENABLED`) `:802`; KG blocking dedup (60min/180min, `ZOE_KG_DEDUP_ENABLED`) `:841`; KG adjudication apply (60min/240min, `ZOE_KG_APPLY_ENABLED`) `:901`; nightly full dedup (30min, once/day, `ZOE_KG_NIGHTLY_ENABLED`) `:950`; turn-embedding backfill (30s drain) `:1052`; Echo re-attach (60s) `:1115`.

**main.js polling lanes (LIVE):** inbox 4min, canvas-ingest 45s, RSS 3min, news compression 60min, API stream 6h, API bulk 12h, Truth Social 15min, email intake 5min, forecast 30min, video-caption poll 3s/sample 30s, scribe 20s (when active), directed-focus 45s (when active).

**Runtime modes:** `availability.isAway()` silences heartbeat+continuity; `personal.isOn()` silences heartbeat + skips all monologue work lanes. No cron library — all `setInterval`/`setTimeout` + DB `scheduled_tasks` + meta-timestamp min-gap gates. Only true calendar-day trigger: nightly KG sweep.

---

## 5. Echo autonomous runs (Python)

**The MCP-server process schedules nothing.** All self-scheduling = Huey `@periodic_task` in `echo/queue/__init__.py`, run by the `echo.queue.huey` consumer (ARMED unless `NX_ECHO_DISABLE_HUEY=1`):

| Run | Cadence | Does | State |
|---|---|---|---|
| purge_old_security_audit | daily 03:00 | delete audit rows >90d | ARMED |
| agent_heartbeat | 5min | drain event_log, snapshot integration_status, reap orphaned agent_runs, txtai backfill | ARMED |
| pass_runner_tick | 5min | select runnable passes → jobs.db | ARMED but **idle** (all passes `cadence:null`) |
| calendar_google_sync_tick | 5min | incremental Google calendar sync | ARMED (no-op unless connected) |
| refresh_due_tick | daily 03:47 | run due data-source refreshes by cadence | ARMED |
| integrity_check_rotation | daily 04:23 | `PRAGMA integrity_check` on one backup, rotating | ARMED |
| fleet_health_tick | hourly :13 | cross-tenant fleet-health rollup | ARMED |
| scheduled_backup_snapshot | 6h | `VACUUM INTO` snapshots (keep 4) | ARMED |
| cultivator_cycle_tick | hourly :07 | Cultivator 8-task cycle over live tenants | ARMED |
| user_jobs_dispatcher_tick | 1min | fire due `data/jobs/*.toml` | ARMED but **idle** (dir absent) |

**Zoe-driven MCP tools (NOT self-scheduled — Echo runs them only when Zoe calls):** `run_semantic_dedup`, `run_blocking_dedup`, `run_ann_dedup`, `run_dedup_adjudication`, `run_link_candidates`, `run_engagement_auto_promotion`, `auto_promote_grounded`/`revert_auto_promotion`, `run_pass`, and all agent/workflow spawns (`spawn_agent` inline; `spawn_agent_async`→jobs.db worker; `spawn_workflow`, `team_spawn`, `agent_fire`).

**The recursive integrity auditor** (`echo/audit/loop.py`) is **write-triggered by an internal fingerprint skip-gate**, but has **no autonomous caller** — its only invoker is the `run_integrity_audit` MCP tool (writes.py:49). Autopilot default ON, auto-disarms on regression; global `AUDIT_LOOP_ENABLED` default OFF → dry-run.

**Supersession** is inline on each fact write (`bitemporal.py:write_fact`), not scheduled. **Dormant/unwired:** agent CronTriggers (projected to calendar only), F.5 methodology reflection, the 4h calendar-subscription tick. **"Nightly catch-lane" does not exist in Echo code** (term maps to nothing).

---

## 6. Model assignments

**Zoe (`lib/config.js`, env-overridable):**
- `mistral-small3.2:24b` (LOCAL) = `frontModel()` — her spoken VOICE only: heartbeat, monologue voice-tier, self-dialogue/narrative, play, byline. Never used for cognition.
- `gemma4:31b-cloud` (CLOUD) = `extractionModel()` — ALL background COGNITION: commitments, consolidation, convo-state, continuity, experience, graph/entity extraction, gmeet, importance, learning, media-CC, memory dedup/merge, threads, personal-facts, preferences, protocols, reflection, rumination, self-model, monologue synthesis. Also `meetingModel()`.
- `gemini-3-flash-preview:cloud` = `scribeModel()` — meeting scribe (running minutes/recap/actions).
- `gpt-oss:120b` = `deepReasonerModel()` — low-volume high-value: research-plan authoring, scribe deep-pass escalation (reasoning output may arrive in `message.thinking`).
- `gemma4:31b` (cloud-first, local fallback) = vision "see" + forensic excavate.
- `gpt-image-1` (OpenAI, OFF unless `ZOE_IMAGE_GEN_ENABLED`) = image gen.
- `Xenova/bge-small-en-v1.5` (LOCAL CPU, transformers.js) = embeddings (semantic/episodic memory + the new self-repeat guard).
- curator/editor = resolved dynamically (db-meta→env→first reachable cloud) for `cloud_curator` + `cloud_logic.ask`.

**Echo (`config.toml` `[llm.roles.*]`, per-role circuit-breaker fallback chains):**
- persona/voice = `gemma4:31b-cloud`; orchestrator/learning = `kimi-k2.6:cloud`; long_context/hands = `deepseek-v4-pro:cloud`; local backstop = `qwen3:8b`/`hermes3:8b`.
- Saga brain = `gpt-oss:120b` (cloud) / `qwen3:14b` (local grounded voice).
- Embeddings = `Snowflake arctic-embed-s` (ONNX CPU) + `qwen3-embedding:0.6b` (LightRAG). NER = `gliner_medium-v2.5` (OFF by default). STT = `faster-whisper base`. TTS = Kokoro. VAD = Silero.

---

## 7. Curation & growth loops (how the DB self-improves)

**Growth arm:** idle graph-walk proposes (existence/fact gated) → observation store records every SEE (promoted/held/reverify) → held/uncited claims queue as enrichment → inline-promote lands well-cited nodes so edges get live endpoints.

**Landing arm:** F2 `auto_promote_grounded` drain (≥0.90, ~1min, reversible) → promote_gate ranks queue (promote≥0.90 / review≥0.72 / hold; domain=TAG never veto) → F3 research-to-close diagnoses citation/corroboration gaps, runs bounded external research, `restamp`s for next drain → nightly doc promotion files docs into Echo vault + KG → retention trims promoted docs to pointers.

**Cleanup/churn arm:** daily curation pass (quarantine + near-dup + self-evo + news + supersession + decay + semantic dedup + doc promotion + retention) → integrity auditor (fingerprint-gated) → identity-dedup (weak→canonical auto, attractor nodes flagged) → KG blocking+ANN dedup → adjudication auto-apply (anti-collapse gated, reversible) → confidence decay emits below-0.5 re-verify work-list → staleness TTL prefers re-verification → supersession (world-time, valid_from wins, never created_at) → belief reconciliation (`new|merge|supersede|append|reject|ask`) → monologue/thread hygiene (spiral prune, threads aged to abandoned).

The **same grade ladder** (`studio/puller_confidence`) underlies both the KG curation gate and the Puller/CRM confidence tiers — contact evidence and KG evidence graded identically.

---

## 8. Workspace-tool support

- **Zoe Canvas** — Echo owns `canvas_blocks` (written only by Saga via `saga_render_*`/`saga_canvas_add_block`, served over `GET /canvas`); Zoe fetches snapshot + overlays local spatial state from `canvas_layout.db`. Her research dossiers emit as `directed-*` tabs; drops arrive as `drop-*` tabs (ingested at 45s).
- **Editor / Verification Studio** — any-format doc → one light block model (`.docx/.pdf` extraction delegated to Echo). "Run checks" opens `rainey_open_verification_session` → `delegate_to_rainey_citation_verifier`/`_fact_checker` (background cloud agents) → poll status → findings on `editor_registry`.
- **Creator** — Tiptap authoring ⇄ light blocks; Research&Assist DETECT→`search_entities`→`kg_neighborhood`+corpus/web→cloud advise.
- **Forecast suite** — poll connectors are origin (read directly); slate from VoteHub enriched by read-only Echo resolve; recompute loop (30min) → sim → balance payload. Writes nothing durable.
- **Research/deliverables** — F3 dossiers → canvas emit AND `doc_store.land({source:'research'})` → nightly promote as Echo `deliverable`; saga/vault renderers produce schema-locked, voice-validated, cite-floor≥1 artifacts.
- **CRM cards** — read-only Echo contact tools (`contact_facets`/`list_contacts_*`/`get_contact`).
- **Prospecting/Puller cards** — isolated `puller.db`; references CRM/Echo by id only, never edits; verify→update→propose gate; autonomous idle fill (pattern or real-browser web-discovery, cited).

All renderers reach data uniformly through `preload.js` IPC → `main.js` handlers → `echoSuit.dispatch` or local sqlite.

---

## 9. Notable findings / corrections to prior mental model

1. **Echo's server process schedules nothing** — autonomy lives in a separate Huey consumer spawned by the Electron sidecar. If that consumer isn't running (or `NX_ECHO_DISABLE_HUEY=1`), Echo does zero background work.
2. **Most "autonomous Echo runs" are actually Zoe-driven MCP calls** (dedup, adjudication, integrity audit, promote-up). Echo's own periodics are the 10 Huey tasks — mostly maintenance (backups, health, calendar sync, refresh), not KG growth.
3. **The recursive auditor has no autonomous caller in Echo.** It only runs when Zoe's curation tick calls `run_integrity_audit`.
4. **"Nightly catch-lane" is not a real Echo job** — the term maps to nothing in code (closest: `refresh_due_tick` 03:47 + the auditor's 12h safety-net).
5. **Two Echo periodics are armed but idle:** `pass_runner_tick` (all passes `cadence:null`) and `user_jobs_dispatcher_tick` (`data/jobs/` absent). Cron agents, F.5 reflection, and the 4h calendar-subscription tick are **dormant/unwired**.
6. **Forecasts are not persisted** — computed in-memory each 30min, served on demand; durable rail is deferred.
7. **Most Zoe housekeeping passes default OFF** (`ZOE_*_ENABLED`); only the ones Lucas has enabled in `.env` run.

---

## 10. Open questions worth a look

- The armed-but-idle Echo periodics (`pass_runner_tick`, `user_jobs_dispatcher_tick`) burn a wake every 5min/1min for nothing — intended, or should they be given cadenced passes / manifests?
- Forecast non-persistence means no backtest trail survives a restart — deliberate (memory says deferred), but worth confirming it's still the plan.
- Dormant cron-agent wiring (`triggers.py` claims a schedule that doesn't exist) is a latent trap — anyone reading that file would assume agents self-fire.

---

## 11. Live `.env` overrides vs code defaults (as of this audit)

The tables above are **code defaults**. Known live overrides in `.env`: curation `MIN_GAP_HRS=2` (vs 20), `IDLE_MIN=3` (vs 15), `CHECK_MIN=3` (vs 30); ingest check/gap `=1`; `ZOE_CURATION_ENABLED=1`, `ZOE_INGEST_ENABLED=1`. The boot log has also shown a `gemma4:12b` front model warmed — i.e. `frontModel()` is env-overridden from its `mistral-small3.2:24b` default. **Always check `.env` for the running cadence/model, not just `config.js`.**
