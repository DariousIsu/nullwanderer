# Total Program Review — 2026-08-03

Full-system review of the Zoe companion (Side Quest) + Echo backend (NX ECHO): memory systems, autonomous functions, chat surfaces, model usage, tool systems, and operations. Produced from six parallel code-reading sweeps plus live probes of the running Echo server and today's boot logs. Every claim below is cited to file:line or a live measurement taken 2026-08-03.

---

## 0. Verdict in one paragraph

The architecture is sound and most of the recent root-fixes are real and holding (reply root-fix proven live, tier-gate mutating-verb fix landed, session-latch handling correct, flaky-gate stale-temp-DB fix correct, pollCallTool retry revert held). The program's diseases are no longer point-bugs — they are **eight cross-cutting patterns**, each of which explains multiple symptoms in the defect ledger. Separately, there is a **same-day operational emergency**: the disk is at 97% (32 GB free) while the two apps are writing ~43 GB/day of unmanaged snapshots, and 407 Echo commits exist in exactly one place on that disk.

---

## 1. EMERGENCY — do today (~45 minutes total)

| # | Item | Evidence | Action |
|---|---|---|---|
| E1 | **Disk exhaustion imminent.** C: at 97%, 32 GB free. Today alone: 5×2.24 GB `sq.db.precuration_20260803_*` + 4×8 GB Echo `civic_graph` snapshots ≈ 43 GB in one day. The 08-03 16:08 crash (`data/crash.log`: NetworkService + 3 renderers killed in 13 ms, exit style flipped from "crashed" to "killed" on 07-30) has resource-starvation signature. | live `df`, `data/` listing | Run `nx-echo/scripts/prune_backups.py` (dry-run → `--apply`; it already carries the .db-only ranking + sidecar-companion logic). Delete 4 of 5 same-day precuration snapshots + `sq.premerge/precollapse` + `pre-t2` (~14 GB). Reclaims ~70-80 GB. |
| E2 | **407 unpushed commits, no remote, no off-machine copy.** `git rev-list --left-right --count main...HEAD` → `0 407` in NX ECHO. `main` is a strict ancestor; the gap grew from 331 to 407. The `run_integrity_audit` fix is among the 407. Disk failure (E1) is the delivery mechanism for this loss. | git probe | Create any remote — even a bare repo on an external drive — and push `chore/worktree-recovery-2026-07-27`. |
| E3 | **`.env.bak_kimisubc_123314` (62 keys, 11.7 KB) is untracked AND unignored.** `.gitignore:10` matches only the literal `.env`. The Desktop-as-repo has 722 dirty entries — the exact condition under which someone reaches for `git add -A`. | `git check-ignore` exits 1 | Move the file out of the tree; change the ignore pattern to `.env*`. |
| E4 | **Desktop is the repo.** `git rev-parse --show-toplevel` from Side Quest → `C:/Users/azrae/Desktop`. The stray `Side Quest\.git\` (empty `info/` only) is invalid, so discovery walks up. 648 of the 722 dirty entries are deletions of *unrelated* projects (NX-ALPHA 614, economic_dashboard 28). NX ECHO sits inside as an untracked directory. | git probe | Short-term: never `commit -a`/`add -A`; add a Desktop-root `.gitignore`. Structural fix in Phase 3. |

---

## 2. The eight cross-cutting diseases

The merge lesson applies again: the ledger's individual defects cluster into eight mechanisms. Fix the mechanism, and 3–8 symptoms each fall together.

### Disease A — Spend is ungoverned at every layer that matters
- `lib/quota_gate.js` has **three** call sites in the whole tree — all in `monologue.js` (idle lane), all passing `estimate: 1`. The `interactive`/`directed`/`research` lanes defined in `quota.js:72-80` are never passed by any caller; the 0.80/0.45 pace shares are dead code.
- Nothing in code writes `quota.reset_at` — when unset, `quota.js:144` computes `pacePerHour = Infinity` ("sustainable ∞/h" appears 8× in today's logs). The burn-down mechanism from b67b043 fires only when the operator hand-sets meta.
- `usage_meter` is in-memory and resets every reboot (`usage_meter.js:19`) — with 120+ boots, `spentSince` is systematically near-zero.
- The reply path can fire **six** ungated cloud calls per turn (stream `main.js:7887` → retry `:7895` → fallback `:7908` → non-stream loop over 4 models `:7929`), each carrying the full ~55-65 k package.
- 36 modules `require('./ollama')` directly with no gate: 5 extraction lanes, meeting scribes, media CC, news classify (50 items/3 min).
- Result visible live: **109 Ollama HTTP 429s today, 84 in the current boot and accelerating**; Echo's own `qwen3:14b` keep-alive has been 404-ing every 240 s since 08-01, logged at INFO — the model was never warm, worsening the concurrency storm.
- Echo's governor mirrors the old mis-unit in reverse: wall-clock only, `class_weights={}` (`governor.py:176`), `from_config` called only in tests.

**Cure:** move admission into the choke points — `ollama.completeDetailed`/`streamChat` and `cloud_logic._complete`/`streamCloud` — so bypass is structurally impossible; pass `quota.costOf({model, tokens})` instead of `1`; persist the meter (db meta or `cloud_traces`); write a default `reset_at` at boot; add a concurrency semaphore on the Ollama caller; bound the reply fallback chain; delete the three legacy rolling windows the quota header says it replaced (`subconscious.js:64` + graphwalk + puller windows are still live alongside it).

### Disease B — Two sources of truth, everywhere
Same failure shape in nine places: a hand-maintained mirror drifts from the live registry.
1. `entitlements.yaml` write/admin lists vs actual decorator tags — **~430 of 532 Echo tools untagged**, so the reader token can call `gui_do`, `browser_click/fill/navigate`, `spawn_agent`, `team_spawn`, `hub_delete`, every `delegate_to_*`.
2. Side Quest authenticates 100% of traffic with the **admin token** (`main.js:104-108`, `:1291`); the 3-tier token design in `echo/auth.py` is unexercised.
3. `config.toml [llm.models]` vs `model_slots.py` defaults — documented as having "silently drifted" once; still two sources.
4. `_INTENT_PREFIXES` (`introspection.py:109-155`) vs the tool registry — recipes/delegates/`gui_do` land in `other`; the LAMP-count failure was patched client-side instead.
5. Echo's own instructions advertise `grouping="intent"|"flat"`; the real enum is `"alphabetical"` (`introspection.py:389`) — a guaranteed validation error on the first discovery call; `echo_suit.js:311` propagates it.
6. `run_smokes.js` gate array (343) vs smokes on disk (464) — scenario engine 0/5 gated, puller 0/11.
7. `turn_router.js:106-109` gate helpers exported and dead; `main.js:6306-6307` re-implements them inline with a different set.
8. `catalog.toml` claims 23 foundations; 6 of the DBs no longer exist post-consolidation.
9. `model.replier` lives only in db meta — no code writes it, `.env` doesn't know it.

**Cure:** invert the default (tag-at-registration wrapper: everything is `write` unless in an explicit read allowlist — the exact posture `echo_tier.js:116` already uses client-side), then **generate** entitlements/intent-buckets/catalog from the live registry, and add `discover --check`-style verification to the test gate for each mirror.

### Disease C — Shadow tables still mis-answer reads, and one writer writes the wrong half
- Live today: `main.contact_search` 292 rows vs `electoral.contact_search` 216,030 (plus `_content`, `_docsize`, `_data`, `_idx`, `field_metadata`, `enrichment_job/finding`, `sqlite_sequence` — 11 tables warned at every Echo boot).
- `crm_migration.py:220` does an **unqualified `DELETE FROM contact_search`** — deletes from the 292-row shell, leaves the real index untouched.
- Direct upstream cause of today's Zoe-side `no such column` / `no more rows available` / wrong-count errors — nondeterministic resolution by attach order is silent corruption, not an error.
- `Store.real_table()` (`store.py:38`) exists and is the organ; `search_contacts` was fixed by hand instead of calling it.

**Cure:** sweep ~25 unqualified `FROM contact*` sites through `real_table()`; fix the migration DELETE first (it's a write); drop or rename the non-empty main-side shells; surface `Store.shadowed_tables` in `stats()` so the hazard shows in health checks, not just boot logs.

### Disease D — Synchronous work on the Electron main thread
- **Curation backup:** `main.js:526-537` `wal_checkpoint(TRUNCATE)` + `fs.copyFileSync` of a **2.25 GB** file, on the main thread. `.env` overrides collapsed the documented ~20 h gap to ~2.5 h (`ZOE_CURATION_MIN_GAP_HRS=2`) → ~10 copies/day, ~21 GB/day of writes, seconds-long stalls each. This is the strongest candidate for the "lag, no CPU spike" family and it feeds E1 directly.
- **decomposeDoc IPC storm:** `boot168.err.log` has 239 × `Render frame was disposed` with one identical stack: `curation_store.js:77 → recordKgObservation → doc_decompose → _kgTap → emitKgActivity → WebContents.send` — a sync KG write firing an IPC emit **per observation**, 226-240×, no frame-liveness check. Freeze + renderer-gone in one path.
- **Canvas snapshot:** 8 s deadline, 18 s elapsed (`main.js:4003-4053`) — elapsed ≫ timeout is the main-thread-stall signature, self-diagnosed in comments, unfixed.
- **`_heldForTarget`** (`main.js:11125-11139`): synchronous full scan of every person `encounters` row (~329 k claims) on a 5-min TTL.

**Cure:** `VACUUM INTO` / SQLite online backup off-thread (Echo's queue already does exactly this LIVE-safe — `echo/queue/__init__.py:252-265`); restore the 20 h gap; batch the KG-activity emit per document + `frame.isDestroyed()` check; indexed lookup for `_heldForTarget`; give curation the `_conversationActive()` governor the autonomy tick already has.

### Disease E — Producers without consumers
- **Semantic dedup:** 31,868 pending proposals; `run_semantic_dedup`/`run_ann_dedup` scheduled nightly, `run_dedup_adjudication` — the only consumer — scheduled **never** (operator-only). `semantic` tier: 709 pending, 0 ever applied.
- **Held observations:** 97,371 rows with `substantiation_state = NULL` are invisible to *both* the prove lane and the fade lane (`db.js:2452`, `:2471` filter `= 'unsubstantiated'`); 303,800 rows also have `frame = NULL`, blinding the flood wall; 2,108 rows are substantiated-but-held — nothing re-reads a row after its state flips.
- **Entity promotion door vs substantiation classifier:** `graph.py:1162-1176` demands ≥2 independent URL hosts while `substantiation.js:87` says a decomposed doc is its own citation. **5,288 proposals permanently unpromotable** (3,337 empty source_set @0.80 + 1,962 docstore-single @0.50). The relation lane got the inversion; the entity lane didn't.
- **Doc-contact sweep:** 142 of 13,208 docs scanned (1.1%) at 2 docs/5 min, newest-first — the parish targets are at the tail.
- **Unresolved inbox:** 11,064 (live probe).
- **`echo/memory/` (P4 bi-temporal):** 6 modules, 5 test files, one production caller — a QR-scan side effect. No MCP tool exposes it; `write_hook` has no caller.
- **Browser downloads:** 3,557 of 3,609 unpromoted docs are `browser_download` — the one lane the round-robin fairness can't drain fast enough.

**Cure:** schedule the adjudication consumer nightly (anti-collapse anchor + batch reversal already built; start on `name-exact`/`strong-id` where 2,636 auto-applied cleanly); one-time backfill of NULL states/frames + widen the two lane queries to `IS NULL OR`; port `classifySubstantiation` to Python once and let both entity and relation doors call it; invert the doc-sweep to oldest-first/.gov-first and raise the budget while backlog > 1,000; wire-or-delete `echo/memory/`.

### Disease F — Built, tested, and switched off (or dark)
- **Priority allocator:** `_allocMode()` defaults `'roundrobin'` (`main.js:11182`) — the `scoreBeat` pin/staleness/news terms (the direct answer to "alphabetical counties") never execute. Flip is live-revertible meta, no reboot.
- **Background workers + swarm:** `research.workers` default 1 → `_bgSlots()` = 0 → ~350 lines of dead-by-config code (`main.js:11491-11712`).
- **Research caps:** `research.session_cap`/`weekly_cap` default 0 = uncapped — the documented 5 h/7 d brake has no numbers in it.
- **`<dig>`:** self-documented DARK at `main.js:7733` — zero emissions ever, across every boot.
- **Teams leave:** gmeet just got 4 leave triggers; Teams has 1 of 4 (`teams.js:341-420`), no `teams_leave_requested`, no max-duration, no alone-timer; selectors marked provisional; **zero `[teams]` lines in any boot log** — the whole lane is unproven against a live DOM.
- **Scenario engine "91/91":** the string exists nowhere in the repo; the 5 scenario smokes are all outside the gate. Whatever produced 91/91 is not `npm test` and is not reproducible.

**Cure:** an explicit flip-or-delete pass. Flip: `research.alloc=priority` (watch one boot), set real research caps, workers=2 trial. Fix-then-prove: Teams (one live meeting + `dumpDom()` capture, same as the gmeet recipe healing). Instrument-then-decide: `<dig>` (count should-have-dug vs did; if surfacing is fine, move the entry from manifest to plan — plan is untrimmable and read first). Gate: scenario + puller smokes into `run_smokes.js`.

### Disease G — Detectors match phrasing, not behavior — now on an irreversible action
- `main.js:5181`: "**is** the meeting over?" (interrogative) matches the leave pattern; "**don't** leave the call yet" matches the leave-verb arm (no negation guard). The action is leaving a live meeting.
- The chat leave-trigger guards on `gmeet.active()` only — saying "the meeting's over" in a Teams call does nothing (`main.js:5180`).
- Same class as the documented imperative/interrogative defect; contacts got the LLM-primary fix, meeting-leave didn't.

**Cure:** a shared polarity/mood helper (`isInterrogative`, `isNegated`) used by the gmeet trigger, `canvas_route` REs, and `operator.TASK_RE`; or route meeting-leave through the same LLM-primary classification contacts got, regex demoted to cloud-down fallback. Widen the guard to `gmeet.active() || teams.active()`.

### Disease H — Trust boundaries declared but not enforced
- The **autonomous tier gate has never been in force**: `echo_suit.js:504-508` documents that `opts.autonomous` was unset on ~98% of calls; background research has been writing freely (~5,900 proposals/day). The gate reads `!!opts.autonomous` (`:601`) while labelling uses the ambient lane (`:512`).
- `pollCallTool` (`main.js:3715`) bypasses tier gate, dispatch timeout, memo/coalesce, firewall, and arg-prep; two call sites also skip `ensureEngine` — including `saga_canvas_open_tab`/`add_block` (`main.js:6390`), **two write tools escaping the gate**, and `fetch_feeds_batch` in a chunk loop (`main.js:2522`).
- The HTTP transport has **no request timeout** (`echo.js:43-74`; the stdio sibling has 30 s). The 90 s suit race is the only budget and doesn't cover pollCallTool. On timeout, the orphaned call keeps burning server-side.
- `ensureEngine()` has no in-flight dedupe/backoff — N concurrent timers each start a handshake against a down engine (the shape of the reverted crash).
- `content_firewall.frame`'s closing marker can be cut by the `capChars` slice at `operator.js:373` in `_forceFinalFromWork` — the frame's security property is that it's unconditional.
- Short-term read-through (`staging_read`) reaches only 2 of ~7 surfaces: `search_entities`/`get_entity` see staged; `search_knowledge`, `kg_query_local/global`, `kg_neighborhood`, `search_facts`, `knowledge_neighborhood` are blind — the same question answered two ways.

**Cure:** AbortController + timeout at the transport (`echo.js:49`); route `pollCallTool` through `EchoSuit.dispatch`; in-flight dedupe + cooldown in `ensureEngine` (defer to the correct 60 s loop at `main.js:1337`); decide the autonomous-gate question (make it ambient, or delete the parameter and declare background writes policy); make the firewall frame slice-safe (cap inside the frame, never across it); copy the `graph.py:60-76` staged-append to the five blind surfaces.

---

## 3. Subsystem scorecards (detail in the six sweep reports)

### Memory (short-term ↔ long-term)
**Healthy:** document rail alive (9,588 promoted; round-robin fairness works; only `browser_download` backlogged). Proposal rail armed with 37,513 logged reversible promotions. Integrity auditor running (fresh fingerprint). Corpus consolidation real (corpus.db 2.26 M wikipedia + 21 sources).
**Verdicts on the ledger:** "bridge dormant" — REFUTED. ".gov held at B=0.88" — REFUTED as stated (`.gov`→A=0.97 clears the floor); the real blocker is the entity-door corroboration rule (Disease E). "Quarantine invisible to kg surfaces" — CONFIRMED (2 of 7). "Semantic dedup open" — CONFIRMED (write-only lane). "10,361 no birth context" — CONFIRMED and worse: 13,388 of 15,979 graph_entities (83.8%) lack entity-level provenance. "Union reads shadows" — class CONFIRMED (11 tables live).
**Also:** temporal substrate unfed — `occurred_at` on 1,396 of 1.83 M entities (0.08%), zero `scheduled` rows, so hourly `run_event_aging` is a permanent no-op. `get_master_index` has silently returned the generated fallback since inception (`Vault/_INDEX/` doesn't exist). 103,802 entities at degree 0.

### Autonomy
30+ loops inventoried; well-gated on paper, three `.env` overrides silently defeat documented safety defaults (`ZOE_KG_APPLY_BATCH=500` vs 25, `ZOE_KG_APPLY_MIN_GAP_MIN=30` vs 240, `ZOE_KG_DEDUP_FULL_DAYS=1` — two full sweeps now compete for one 4-min leash; plus `ZOE_CURATION_MIN_GAP_HRS=2`). `ZOE_SUBC_MERIT_THRESHOLD=1` makes merit triage a no-op — the token budget rations by arrival order, not merit. `_researchGateOk` consumes usage credits and resets pacing stamps on ticks that then die at the slot check (`main.js:10232` vs `:10236`). `mapping.paused` only blocks virgin seeds — resume (`:11471`), worker-fill (`:11534`) and maintenance un-covering (`:11304`) all march through it. Beat carry-forward truncates coverage to 300 and only fires on virgin threads (`main.js:10973-10982`); scheduler accounting still reads one thread (`:11057`). Puller has no org lane — org asks silently degrade into the person walk. Self-repair can wedge: 2 open watch-needs stop all minting; nothing advances a parked rehearsal on a clock.

### Chat surfaces
Reply root-fix **proven live** (`CLOUD wrote the reply — kimi-k2.6` ×9/×4 in earlier boots) but **intermittent**: newest boot shows kimi returning no content ×2 and zero cloud replies. Three renderer-facing bugs: (1) history double-sent — `_identityWithoutSuit` flattens ALL turns into a 32-44 k identity blob and then the same turns are appended as roles (`main.js:7854` + `:7862`), likely source of the leaked-directive echoes; (2) a rewritten reply never reaches the screen — `sendComplete` carries `say: finalSaid` only when `wasDisclaimer` (`main.js:8409`); user reads the recital, DB stores the recovery; (3) TTS speaks the raw stream — truncated original + retry, twice out loud (`main.js:9309` passes `sayBuf` not `finalSaid`). Package `request` section declared UNTRIMMABLE and never supplied (`package.js:49` vs `main.js:7854`). Package fit 12-14% — identity dominates; grounding (weight 0.36, ~150 k available) delivers 2,886 chars: starvation is enumeration, not budget.

### Models / cost
Fleet resolution split across `.env`, db meta, and hardcoded defaults (replier exists only in db meta). Warm-keeper pays ~1,150 pings/day at a **131 k num_ctx allocation per 1-token ping** (`warm_keeper.js:74` → `cloud_window` resolve) for a model that delivered 0 replies in the newest boot — and since replier == subconscious now, the 10 s subc tick keeps kimi warm for free whenever budget allows. Curator + all 5 extraction lanes hardcode `num_ctx: 8192` on 131 k-window cloud models (the exact defect `cloud_window.js` was written to fix). `gemma4:31b-cloud` scores 4-token importance ratings — highest-frequency, lowest-value cloud lane. Curator model cache has no TTL (`cloud_curator.js:132`) — the 10-min TTL fix landed in `cloud_logic.js:50` and never here. Heartbeat `[fit]` budget overruns on every beat, evicting 4-10 conversational turns each time (28× in one session) — she is losing memory every heartbeat by design accident. Recommendation standing out: reconsider kimi as replier (cold-load-only, paid heartbeat, intermittent) vs gemma-31b (199/200 on the non-stream path per `main.js:7924`) — making gemma primary deletes the warm-keeper's reason to exist.

### Tools / MCP
Registration architecture solid (parent + mounted external/internal, live-proxy mounts); late registrations depend on FastMCP mount-proxy semantics — one upgrade that snapshots on mount silently deletes the curate + delegate families (`mcp_server.py:1218,1230` after mount at `__init__.py:76`). `db_query` returns unbounded rows by policy (`db_query.py:104,229`) while the client injects `timeout_seconds: 20` — converting timeout failures into serialize-1.76 M-rows failures; needs `max_rows` + `truncated` marker. `EchoClient._toolCache` never refreshes on reconnect (`echo.js:150`, `echo_suit.js:409`) — after an Echo restart the arg-signature feedback loop feeds back dead schemas. Recipes are genuinely safe (read-only clamped) and genuinely undiscoverable (Disease B #4). Root sprawl: 73 root `pass*.py` are organ-ized via `passes/registry.yaml` (misfiled, not dead); 24 one-offs have zero references (delete); `bulk_knowledge_*` family is a pipeline wearing a script's clothes (promote to one pass).

### Ops / tests
464 smokes, 343 gated, 121 ungated (scenario 0/5, puller 0/11, super-search 0/7). No CI anywhere; all gates manual. Echo: 280 test files but **zero** for `extraction`, `reconcile`, `audit` — precisely the three organs failing in production today (`propose_entity` FK failures, both 90 s timeouts). `prune_backups.py` is the best operational script in either repo and is not being run — the estate regrew 42.9 → 89.8 GB in three days; `echo/backup.py`'s rotation glob still can't see pre-op stamps. Side Quest has no prune equivalent at all. Log redaction is holding (0 key-shaped hits across 250 logs). Keystore 3-tier delegation correct.

---

## 4. The improvement plan

### Phase 0 — Today (~45 min): E1–E4 above. Nothing else matters if the disk fills or the 407 commits vanish.

### Phase 1 — This week (safety + correctness, ~2-3 days of work)
1. **Spend governance at the choke point** (Disease A): gate in `ollama.js`/`cloud_logic`, real estimates, persistent meter, boot-time `reset_at`, Ollama concurrency semaphore, bound the 6-call reply chain, fix the Echo keep-alive 404 (loud + right model name).
2. **Shadow-table sweep** (Disease C): `crm_migration.py:220` first, then `real_table()` everywhere, drop non-empty shells. Only silent-corruption bug on the list.
3. **Main-thread stalls** (Disease D): backup via `VACUUM INTO` off-thread + 20 h gap; batch `emitKgActivity` + liveness check; both directly attack the crash/freeze history.
4. **Meeting-leave detector** (Disease G): polarity/mood guard or LLM-primary; Teams parity (shared `meeting_leave` module + `teams_leave_requested` + widened chat guard).
5. **Reply-path triple** (chat surfaces): stop double-sending history (system-only identity + real `request` section), always carry `say: finalSaid`, speak `finalSaid` not `sayBuf`. Three small diffs, all user-facing every day.
6. **Restore the three safety defaults** the `.env` overrides defeated (KG apply batch/floor, dedup full-sweep cadence, curation gap) — or re-justify each deliberately.

### Phase 2 — Next two weeks (memory graduation + routing)
1. Port `classifySubstantiation` to Python; entity door accepts docstore self-vouching (unblocks 5,288).
2. NULL-state/frame backfill + `IS NULL OR` lane queries + substantiated-but-held re-read pass (97 k + 2.1 k rows).
3. Schedule `run_dedup_adjudication` nightly, bounded, `name-exact`/`strong-id` first.
4. Staged read-through to the five blind surfaces (copy of `graph.py:60-76`).
5. Routing economics: importance/extraction → local models; combined multi-field extraction call (5 calls → 1); `cloud_window.resolve` for curator + extraction lanes; warm pings at `num_ctx: 512`; decide gemma-vs-kimi as primary replier; curator cache TTL.
6. Feed the temporal substrate at extraction time (bills, legistar, calendar, news `occurred_at`).
7. Doc-contact sweep re-key (oldest/.gov-first, bigger budget); `db_query` row cap; `_toolCache` refresh on reconnect; HTTP transport timeout; `pollCallTool` through dispatch.

### Phase 3 — This month (structural)
1. **Auth inversion** (Disease B/H): tag-by-default wrapper, generated entitlements, Side Quest on read token except dispatch, autonomous-gate decision.
2. **Flip-or-delete pass** (Disease F): priority alloc ON, research caps set, workers=2 trial, Teams live-proof, `<dig>` instrument-then-move, scenario+puller smokes gated, wire-or-delete `echo/memory/`.
3. **Tests where production fails**: pin `propose_entity` FK, both 90 s timeout regressions (follow the `692425d` pattern) — first tests for `extraction`/`reconcile`/`audit`.
4. **Repo topology**: real repos for Side Quest and NX ECHO (or an owned monorepo with root ignore), delete stray `.git`, reconcile the 648 phantom deletions, rehome the 99 root one-offs, archive the 250 root logs with keep-N, port `prune_backups.py` to Side Quest, fix `echo/backup.py`'s rotation glob.
5. Generated mirrors + `--check` gates for every Disease-B pair.

---

## 5. Corrections to the standing ledger (memory updates)
- Promotion bridge is NOT dormant (both rails live, 37.5 k promotions logged).
- `.gov` single-source hold: refuted as described; real blocker is the entity corroboration door.
- Birth-context gap grew: 10,361 → 13,388 (83.8% of graph_entities).
- `main.contact` shadow specifically fixed, but the class persists on 11 tables including all `contact_search` FTS internals.
- Scenario engine "91/91" is unverifiable from the repo — no such gate exists; treat as unproven until the smokes are gated.
- pollCallTool connect-retry revert HELD; the residual hazard is the bypass pattern, not the retry.
- route_obs drain is running constantly (761 drains logged) — the confirmed main-thread stall is the decomposeDoc IPC storm + curation backup copy, not the route pool.

*Six detailed sweep reports (memory, autonomy, chat, models, tools, ops) were produced alongside this document; every finding above traces to one of them.*
