# Build Plan — 2026-08-03

Target state (Lucas, 08-03): conversational system complete and memory-integrated — the cloud anchors on fed memory coordinates, never scrubs the database. Idle runs a deeper-thinking path (kimi-k2.6 heartbeat) that explores relationships and autonomously researches/prepares materials from conversations, meetings, and news — while gpt-oss:120b keeps curating and the gemma fleet keeps its roles. The delivered behavior: a research assistant always improving the information on active projects, who understands how research from one task intertwines with another. Voice-to-voice is deferred until text-to-text is fully functional.

Evidence base: [PROGRAM_REVIEW_2026-08-03.md](PROGRAM_REVIEW_2026-08-03.md) (full-system review, 8 diseases) + the self-awareness and shell audits (findings folded in below). Donor mechanisms: [ORGAN_DONOR_REGISTRY_2026-08-03.md](ORGAN_DONOR_REGISTRY_2026-08-03.md).

## Method rules (apply to every item)
- **Circuit-proving:** no item closes on "smoke passes + boots clean." It closes when its circuit fires live — all six links of the transplant checklist ([registry preamble](ORGAN_DONOR_REGISTRY_2026-08-03.md)).
- **No naked constants** on model-facing surfaces: every cap is window-derived at call time, a page size paired with a working cursor ([O2](ORGAN_DONOR_REGISTRY_2026-08-03.md#o2-cursors)), or a named resource guard — and if the resource is "the main thread," move the work.
- **Donor-grounded specs:** any harness-shaped organ is specced from the registry + a transcript trace, never from recollection.
- **Measure first** before building; validate connection-touching changes past ~2 minutes live (pollCallTool lesson).
- **Parallel-lane discipline:** `git add` named files only; never branch off Echo `main` (strict ancestor, 407 behind).

---

## M0 — Keep the lights on (TODAY, ~45 min)

| # | Item | Where | Proof |
|---|---|---|---|
| 0.1 | Prune Echo backups: dry-run then `--apply` (reclaims ~60-70 GB) | `nx-echo/scripts/prune_backups.py` | `backups/` ≤ ~25 GB; disk < 90% |
| 0.2 | Delete 4/5 same-day `sq.db.precuration_*`, `sq.premerge/precollapse/pre-t2` (~14 GB) | `data/` | listed files gone |
| 0.3 | Create ANY Echo remote (bare repo on external drive is fine); push `chore/worktree-recovery-2026-07-27` | NX ECHO | 407 commits exist in 2 places |
| 0.4 | Move `.env.bak_kimisubc_123314` out of tree; ignore pattern → `.env*`; add Desktop-root `.gitignore` | Side Quest root; `C:\Users\azrae\Desktop\` | `git check-ignore` passes; `git status` under 100 entries |

---

## M1 — Trustworthy substrate (~1 week)

**1.1 Spend governance at the choke point** → [O4 budgets](ORGAN_DONOR_REGISTRY_2026-08-03.md#o4-budgets)
Decide option (a) LiteLLM proxy in front of ollama.com/localhost (one key per lane, unbypassable, kills the 429 storm via its concurrency limits) or (b) port the mechanism into `lib/ollama.js` / `lib/cloud_logic.js` (admission with real `quota.costOf` estimate, durable ledger via db meta or `cloud_traces`, boot-time `reset_at`, typed refusal). Either way: bound the reply chain (`main.js:7887-7943`, max 2 cloud attempts then local/direct), delete the 3 legacy rolling windows (`subconscious.js:64` + graphwalk + puller), fix Echo's keep-alive 404 (right model name, log at WARN).
**Proof:** 1-unit idle budget hard-stops idle while chat flows; reboot preserves `spent()`; zero 429s across a full day.

**1.2 Shadow-table sweep** *(only silent-corruption bug)*
Fix `crm_migration.py:220` unqualified DELETE first; route ~25 `FROM contact*` sites through `Store.real_table()` (`store.py:38`); drop/rename the 11 non-empty main-side shells; surface `shadowed_tables` in `stats()`.
**Proof:** Echo boot with zero SHADOWS warnings; `contact_search` count identical qualified vs unqualified.

**1.3 Main-thread stalls** → [O1 compaction](ORGAN_DONOR_REGISTRY_2026-08-03.md#o1-compaction) *(for the fit-eviction half)*
Curation backup → `VACUUM INTO` off-thread (Echo's `queue/__init__.py:252-265` is the in-house donor), gap restored to 20h, `_conversationActive()` guard added. `decomposeDoc` → batch `emitKgActivity` per document + `frame.isDestroyed()` check (`lib/curation_store.js:77` stack). `_heldForTarget` → indexed lookup (`main.js:11125`).
**Proof:** no `Render frame was disposed` storm in a full session; no >1s event-loop stalls during backup.

**1.4 Restore the three defeated safety defaults**
`.env`: `ZOE_KG_APPLY_BATCH` 500→25-50, `ZOE_KG_APPLY_MIN_GAP_MIN` 30→240, `ZOE_KG_DEDUP_FULL_DAYS` 1→7 (nightly lane owns the full net — make the paced lane incremental-only, `main.js:1019` vs `:1140`), `ZOE_CURATION_MIN_GAP_HRS` 2→20 (with 1.3).
**Proof:** one full-sweep owner; config diff committed with rationale comments.

**1.5 Memory graduation**
Port `classifySubstantiation` to Python; entity door accepts docstore self-vouching (`graph.py:1162-1176` — unblocks 5,288). One-time NULL backfill of `substantiation_state`/`frame` (303,800 rows); lane queries → `IS NULL OR` (`db.js:2452,2471`); re-read pass for 2,108 substantiated-but-held. Schedule `run_dedup_adjudication` nightly bounded (`name-exact`/`strong-id` first, next to `main.js:671`). Staged read-through to the 5 blind surfaces (copy `graph.py:60-76` into `kg_query.py:288,342`, `documents.py:85,125`, `graph.py:553`).
**Proof:** pending proposals falling day-over-day; staged-only entity answered identically by `get_entity` and `kg_query_local`.

**1.6 Pulled-forward trivials (from the shell audit)**
Forward `workbench`/`timeoutMs` at `main.js:9797`; add `[analysis]` logging + obs emit in `lib/analysis_lane.js`; call `analysisLane.tidy()` from upkeep; **decide the phantom grant** — implement `os_run_powershell` (M2.5) or revoke the `actions.run_powershell` row in `saga.db os_permissions`.
**Proof:** `data/workbench/<slug>` exists after a workbench call; every analysis run leaves one log line.

---

## M2 — Conversation anchored (~1-2 weeks)

**2.1 Package rework** → [O1 compaction](ORGAN_DONOR_REGISTRY_2026-08-03.md#o1-compaction)
System-only identity (`_identityWithoutSuit` → `messages[0]` only, `main.js:5091`); wire the real `request` section (`package.js:49` contract); stop double-carrying history; make identity trimmable above a floor.
**Proof:** `[package]` log shows `request:` present and identity < 10k; no leaked-directive echoes needing the `8333-8343` strips.

**2.2 Retrieval-filled grounding** *(the item that makes coordinates an ANSWER, not a map)*
Fill `grounding`/`memory` slots by retrieving against the turn's extracted mentions/concepts (existing organs: `active_recall`, `kg_neighborhood`, coordinate deref via `lib/recall.js`) up to their weighted budgets (`package.js:42-66`).
**Proof:** grounding >30k chars on a real turn; measured drop in `<echo-find>` hops per answer.

**2.3 Stop the database scrubbing**
`db_query`: `max_rows` (default ~500) + byte ceiling + `{truncated, total_row_count}` marker (`external/db_query.py:104,229`); on unknown-table error, return the nearest `get_db_map` slice as the hint. Fix the discovery enum (`echo/mcp/__init__.py:38` + `echo_suit.js:311` — "flat"→"alphabetical"); add `recipe` + `operate` buckets to `_INTENT_PREFIXES` (`introspection.py:109`).
**Proof:** zero invented-table queries across a full boot (boot174 baseline: 10).

**2.4 Reply-path integrity trio**
`sendComplete` always carries `say: finalSaid` when rewritten (`main.js:8409`); TTS speaks `finalSaid` not `sayBuf` (`main.js:9309`); keep the honest-cut stamp semantics.
**Proof:** forced-rewrite test shows screen text == DB text == spoken text.

**2.5 Transport hardening** → [O6 permissions](ORGAN_DONOR_REGISTRY_2026-08-03.md#o6-permissions)
AbortController timeout in `httpTransport.send` (`echo.js:49`); route `pollCallTool` through `EchoSuit.dispatch` (kills the two unguarded write sites `main.js:6390`, `2522`); `listTools({refresh:true})` on reconnect (`echo_suit.js:409`); in-flight dedupe + cooldown in `ensureEngine` (defer to the 60s loop at `main.js:1337`).
**Proof:** Echo restart mid-session → suit recovers with fresh schemas, no orphan sessions.

---

## M2.5 — Self-operations (~1-2 weeks)

**2.5.1 Un-jail the reader** → [O2 cursors](ORGAN_DONOR_REGISTRY_2026-08-03.md#o2-cursors), [O3 repo-map](ORGAN_DONOR_REGISTRY_2026-08-03.md#o3-repomap)
`readSource(rel, {offset, maxChars})` + expose on `source_read` (`self_source.js:99`, `main.js:9755`), truncation note names the working continuation; `searchSource` root-first order, cap past 1,113 files, scan off main thread (the cap was a main-thread guard — move the work); `sourceMap` ranked-and-fit per aider's mechanism, defaults root+lib; new `source_outline {path}` (exports + line numbers).
**Proof:** `searchSource('runCloudOperator')` finds the `main.js` definition; offset page-2 smoke green; outline of main.js < 20k chars.

**2.5.2 The three data sources she reaches for and can't get**
`log_read {file, tail|grep}` jailed to `boot*.log`/`*.err.log`; `git_log`/`git_show` read-only; `obs_query {lane, kind, since}` over `obs_events` + un-blacklist from `localdb.js:171` with a purpose line.
**Proof:** inquiry-#147-shaped ask ("inspect the rehearsal logs") completes instead of "file ops failed to list it."

**2.5.3 Self-writing ledgers** → [O8 memory discipline](ORGAN_DONOR_REGISTRY_2026-08-03.md#o8-memory)
Boot-time `git log --since=last_seen` → `self_dev.record()` + `changelog.add()` (writers exist at `self_dev.js:31`, `changelog.js:28` — only the feeder is missing); fix `self_narrative` refresh (13 days stale vs 6h TTL — give it the c22f4e0 fallback tier).
**Proof:** "what have you been working on" cites a commit from this week.

**2.5.4 A review that survives** → [O1 compaction](ORGAN_DONOR_REGISTRY_2026-08-03.md#o1-compaction), [O5 fan-out](ORGAN_DONOR_REGISTRY_2026-08-03.md#o5-fanout)
Review-lane budget 24 steps/300s (`main.js:9886`); operator history compaction (rolling summary, `operator.js:156`); **direct-deliver by default** for reviews (`main.js:7986` path); `self_test` out-of-band; fix the stale "(8 steps / 90s)" line (`main.js:7293`). Then the fan-out shard: self-review splits `lib/` across ≥3 Echo delegates, parent compiles.
**Proof (milestone gate):** "review your reply pipeline" → an intact, cited review grounded in real reads of `main.js`, delivered to screen un-truncated.

**2.5.5 The shell lane, gated right** → [O6 permissions](ORGAN_DONOR_REGISTRY_2026-08-03.md#o6-permissions), [O7 loop](ORGAN_DONOR_REGISTRY_2026-08-03.md#o7-loop)
Implement `os_run_powershell(script, timeout)` in `echo/mcp/external/os_actions.py` (per the existing `_gate`/`_audit` shape; **stdout+stderr+returncode capture** — the PID-only return is why `os_launch_app` is useless); keep `SENSITIVE_TARGETS` confirm, no self-approval, kill-switch; new `shell` tier in `echo_tier.js` NOT admitted by `DESKTOP_CONTROL_RE` (operator-present only). Surface script capability to the replier (`lib/permissions.js` DEFAULTS + a `<run-script>` tag or doc_set-style routing to the operator); lane-entry raises step budget (write→run→read→fix needs the loop).
**Proof:** she runs a script, reads stderr, fixes, re-runs, succeeds — one operator run; autonomous-loop shell attempt refused naming the door.

**2.5.6 Close the self-repair loop**
Rehearse door biased to `born_from LIKE 'self-watch%'` (`main.js:10591` — #12/#13 first); 7-day stale-need reaper.
**Proof:** first R2 proposal card ever minted, or #12/#13 rehearsed to a definitive verdict.

---

## M3 — The deep idle mind (~2 weeks)

**3.1 The `explore` move** → [O7 loop](ORGAN_DONOR_REGISTRY_2026-08-03.md#o7-loop)
A real deep-exploration action in the decider's repertoire (`autonomy.js` move set): multi-hop `kg_neighborhood` traversal from a fresh touchpoint → contradiction/gap detection vs held docs → written synthesis note filed to the project. Model-agnostic (kimi when warm, gemma otherwise).
**3.2 Merit + lane economics** → [O4 budgets](ORGAN_DONOR_REGISTRY_2026-08-03.md#o4-budgets)
`ZOE_SUBC_MERIT_THRESHOLD` → 2-3; set real `research.session_cap`/`weekly_cap`; split `_researchGateOk`'s predicate from its side effects (`main.js:10007` vs `:10236`); idle-depth budget rides the M1 lane budgets.
**3.3 Kimi warm-or-gemma decision**
Either warm pings at `num_ctx: 512` folded into the subc tick (replier==subconscious) or gemma-31b primary replier + kimi as the explore-move thinker; curator cache TTL (`cloud_curator.js:132`); `cloud_window.resolve` for curator + 5 extraction lanes; importance scoring → local model; combined multi-field extraction call (5 calls → 1).
**3.4 Prove the anticipatory slices** *(circuit-proving — shipped 08-03, zero live proof)*
Meeting-prep and have-vs-need fire from a real calendar event and a real news event.
**3.5 Materials pipeline live proof**
"Prepare materials" ends in a branded file via the papers pipeline, autonomously.
**Proof (milestone gate):** unprompted, from real triggers: one meeting-prep brief + one exploration synthesis, both cited, both delivered intact.

---

## M4 — Interweave (~2-3 weeks)

**4.1 Touchpoint emission** — every completed product (meeting notes, focus pass, news event, promoted doc) stamps entities/concepts with project(s) touched.
**4.2 Intersection pass** — idle move joining fresh touchpoints against other active projects' concept sets (graph query over existing data; prerequisite: M1.5 dedup running so intersections aren't noise).
**4.3 Leverage notes** — surviving candidates become small cited products filed to the receiving project's track + surfaced in the morning package.
**4.4 Org research lane** — org-kind targets in `puller_db`/`puller_walk` (or explicit refusal at the door); unblocks org-mediated leverage.
**4.5 Fan-out enablement** → [O5 fan-out](ORGAN_DONOR_REGISTRY_2026-08-03.md#o5-fanout)
`research.workers=2` trial + swarm behind an explicit flag; `research.alloc=priority` flipped (live-revertible meta — the pin term is the alphabetical-counties fix); beat carry-forward fixes (drop `.slice(-300)`, remove virgin-only precondition, scheduler accounting on `coveredForBeat`, `main.js:10973-11479`); `mapping.paused` lifted to the scheduler tick + worker-fill.
**Proof (milestone gate):** one genuine, cited cross-project leverage note, unasked, that holds up.

---

## M5 — Voice-to-voice (deferred)
After M4 holds. (The M2.4 TTS fix is hygiene, not voice alignment.)

---

## Standing debt (schedule opportunistically)
Auth inversion full sweep (tag-by-default + generated entitlements + reader-token default → [O6](ORGAN_DONOR_REGISTRY_2026-08-03.md#o6-permissions)); tests for `echo/extraction`/`reconcile`/`audit` (pin the live failures, follow `692425d`); scenario + puller smokes into the gate (establish the real number — "91/91" is unverifiable); repo topology (real repos or owned monorepo, delete stray `.git`, reconcile 648 phantom deletions); rehome 99 root one-offs; root-log archive keep-N; port `prune_backups.py` to Side Quest + fix `echo/backup.py` rotation glob; meeting-leave detector → LLM-primary with polarity guard + Teams parity (shared `meeting_leave` module); Teams live-proof (one real meeting + `dumpDom()` healing); `<dig>` instrument-then-move; content-firewall slice-safe capping (`operator.js:373`); wire-or-delete `echo/memory/` P4.
