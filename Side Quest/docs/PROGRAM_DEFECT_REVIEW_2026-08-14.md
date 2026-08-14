# Whole-Program Defect Review — Side Quest + Echo

**Status:** REVIEW (no code changed). 2026-08-14. Read-only sweep.
**Scope:** both repos — Side Quest (Node/Electron; `main.js` ~17.7k lines, `lib/` 390 modules) and NX ECHO (Python; ~550-tool MCP server + KG core). Seven parallel review lanes: SQ memory, SQ turn pipeline, SQ background lanes, SQ individuality+voice (incl. the 7 newest commits), SQ tool surfaces, Echo memory/KG core, Echo tool surface.
**Standard:** every finding carries file:line evidence and a concrete failure scenario; each was grep-verified for wiring before being called dead; confidence marked. Style/naming excluded by instruction. ~79 findings triaged down to the load-bearing ones below.
**Companion to:** `COMPARATIVE_REVIEW_2026-08-14.md` (what the program still needs to *become*). This document is what's *broken in what already exists*.

---

## 0. The five cross-cutting diseases (read this first)

Individual findings cluster into five root patterns. Fixing the pattern beats fixing the instances.

1. **The tier gate is decorative.** SQ's write/heavy/locked gate binds only when a caller passes `opts.autonomous` — almost none do — and it *fails open* on exception; Echo's HTTP gate restricts only the 82 tools that carry a `write`/`admin` tag, leaving 441 untagged mutators callable at read tier, and `os_run_powershell` tagged `"shell"` which no middleware enforces. **The two layers of defense have aligned holes.** The autonomous loop has been writing ~5,900 proposals/day through a gate that believes each is an interactive turn. This is the single most important cluster. `[SQ-T1, SQ-T2, SQ-T3, ECHO-T1, ECHO-T2]`

2. **Advertised ≠ executed (the fabrication surface).** The plan tells the model to place tags after `</say>` — where the stream parser *discards* them; near-miss tag spellings are stripped from view but never run and never error; `<draw>` isn't scanned in the reasoning channel; the 240-char "committed bar" drops legitimate canvas blocks. In each, she is told an action happened when nothing did — the exact confabulation the done-contract exists to kill, reintroduced at the parser layer. `[SQ-P1, SQ-P4, SQ-T5, SQ-T6]`

3. **Built-and-dark: the wondering organs and the bitemporal tier.** The entire free-association tail of the idle tick (boredom, `<wonder>`, curiosity, self-set focus) is unreachable, and under the default autonomic flag nothing sources a non-directed focus at all — her "thoughts" are only synthesis lines and rumination notes. On Echo, the P4 bitemporal memory tier and relation supersession are built, migrated, and have zero live callers. **This cluster is the one that most directly blocks the "feel alive" goal** — see §5. `[SQ-B2, ECHO-M1, ECHO-M2]`

4. **Fusion by weak signal.** Echo's promotion gate merges by bare name with no type check (a *person* named Jackson into a *place* Jackson); the adjudicator's "second independent signal" is the jurisdiction that was already in the blocking key, counted twice; surname-only entities still cluster. Auto-apply now rides on these. The classic body-key trap is *clean*, but a subtler class replaced it. `[ECHO-M4, ECHO-M5, ECHO-M6]`

5. **Silent degradation on dependency failure.** A knowledge row stored during an embedder outage is invisible to recall forever (no backfill); self_model merges destructively when the local LLM is down (catch → "same"); mood refresh has no retry floor so a stuck compose burns a cloud call every turn; graph facts never render because of a column-name mismatch. Each fails quietly in a way that reads as "working." `[SQ-M4, SQ-I4, SQ-I5, SQ-M1]`

---

## 1. CRITICAL / HIGH — fix before the next autonomous night

### The tier-gate cluster (disease 1)

- **SQ-T1 — the tier gate is not in force for ~98% of dispatches.** `lib/echo_suit.js:551-566` (gate at :676). `_dispatchRaw` reads `opts.autonomous`, which nearly no caller passes; the file's own comment admits background research "has in fact been writing freely (~5,900 proposals/day)" and defers the fix as "a policy decision for Lucas." Failure: an autonomous loop authoring `<echo-do name="merge_entities">` executes a write the gate believes is interactive. HIGH.
- **SQ-T2 — the gate fails OPEN on exception.** `lib/echo_suit.js:682, :857`: `catch(e){ console.error('tier-gate check failed (allowing)') }`. Inverts the fail-to-blocked doctrine used everywhere else. A syntax error in `echo_tier.js` silently removes the gate. HIGH.
- **SQ-T3 — the shell tier is synthesizable.** `lib/echo_tier.js:99-111` vs `:29-36`. `os_run_powershell` is operator-present-only, but `DESKTOP_CONTROL_RE` admits `os_launch_app`/`os_send_keys` autonomously — an unattended run can open PowerShell and type a command + Enter, reconstructing the withheld authority. HIGH (Echo-side confirm backstop unverified).
- **ECHO-T1 — 441 of 523 external tools are untagged; read-tier token can mutate.** The HTTP gate (`mcp_server.py:1283-1288`) restricts only `write`/`admin` tags; 441 tools register plain, including `hub_delete`, `decide_resolution_proposal`, `set_engagement_stage`, `spawn_agent`, `team_spawn`. The reconciliation test that catches this is knowingly `xfail`'d (`tests/test_phase_d0.py:163`). CRM core writes *are* correctly admin-tagged — the gap is the peripheral families. HIGH.
- **ECHO-T2 — `os_run_powershell` carries a `"shell"` tag no middleware enforces.** `os_actions.py:217`. Arbitrary PowerShell sits at read tier while the tools governing it (`os_set_policy`, `os_approval_resolve`) are admin-gated. In-process `permissions.decide()` confirm gate is the only barrier, and relaxing policy to `auto` removes it. HIGH.

> **The joint picture:** SQ was relying on Echo's tier gate as the backstop for its own ungated dispatches; Echo was relying on the caller being tiered. Neither holds. **Highest-value single fix in the whole review:** tag Echo's 441 tools + un-xfail the test (structural, permanent), and make SQ's gate bind by default + fail closed. These are independent fixes on the two sides of one hole; do both.

### The fabrication surface (disease 2)

- **SQ-P1 — tags placed where the plan tells the model to put them are discarded.** `lib/package.js:256-259` commands "tags AFTER `</say>`"; `TagStreamParser` (`lib/ollama.js:374`) enters mode `post` at `</say>` and `finalize()` (`:389-421`) has no `post` salvage branch — `this.buf=''` drops the tail; tag execution (`main.js:10361-10405`) never scans raw stream. A model obeying the plan exactly gets every tag silently dropped. The smoke (`scripts/smoke_package.js:129`) "passes" by parsing the raw string — a path production never takes. Tags work today only because models *disobey* and emit inside `<say>`. HIGH.
- **SQ-T5 — strip grammar broader than parse grammar.** `lib/echo_suit.js:158-165` vs `:334-347`. Parse requires exactly `name="…"` double-quoted; strip removes any `<echo-do…>`. Single quotes, extra attribute, or reordered attrs → stripped from display, never executed, no error returned. The model believes it acted. HIGH.
- **SQ-P4 / SQ-T6 — reasoning-channel drops.** `<draw>` is the only tag family not scanned in `cloudThinking` (`main.js:10402-10405`), and the 240-char `_isCommittedTag` bar (`echo_suit.js:126-134`) drops legitimate `saga_canvas_add_block` payloads authored in `message.thinking` — where the code's own data says 450/633 tokens live. Reintroduces the empty-canvas confab. MEDIUM-HIGH.

### The wondering organs are dark (disease 3, the aliveness-critical one)

- **SQ-B2 — the free-thought lane is unreachable.** `lib/monologue.js` `_runOneTick`: both live paths (focus branch → return :1619; idle branch → return :1204/1220) exit before lines 1623-1772, where `maybeBoredomSearch`, `<wonder>`→`runSelfDialogue`, free-association storage, and self-set focus live. Under default `ZOE_AUTONOMIC=1` nothing sources a non-directed focus (`focus.js:160` demotes `setFromText`; `interests.js:244` `maybeSpawnFocus` has zero callers). Her thought stream in practice = synthesis + graph-walk lines + rumination resolutions. The cut was intentional (07-01 audit) but the subsystems read as live and are maintained as if they run. MEDIUM-HIGH — **and see §5.**

### Echo KG core — HIGH

- **ECHO-M4 — promotion gate merges by bare name, no type check.** `graph.py:696-722`: `SELECT id FROM entities WHERE name=?`, no type filter, no canonical-follow — a staged *person* "Jackson" merges into a *place* "Jackson" (name is UNIQUE, so cross-kind collisions are guaranteed over time), crediting the person's sources onto the place. Amplified by `resolve_or_mint_concept` attaching concept wells onto the wrong kind. HIGH.
- **ECHO-M3 — adjudication queue head-starvation.** `adjudicate.py:257` + `store.py:137-143`: 33,577 pending; `list_proposals` always returns the same 200 oldest (all fuzzy tiers that park), re-judges them with the reasoning model (+ web fetch) every run, parks them again, never reaches the other ~33k. No park-stamp/offset/aging. Drain wedges forever at full LLM cost. HIGH.
- **SQ-M1 — graph facts never render (recall under-reports).** `lib/active_recall.js:238-255`: `_graphFacts` reads `n.source/n.type/n.target` off rows that carry `source_id/target_id/relation_type` (`db.js:2463`) → every row maps to null → `[graph]` lines never render and the `facts>=3` coverage signal can't fire → she re-researches what her own graph holds. HIGH.
- **SQ-M2 — relation re-record downgrades and wipes confirmation.** `db.js:2448-2458`: unconditional `DO UPDATE SET epistemic/confidence/confirmed = excluded.*` — a later `read`-level re-record demotes a `witnessed` edge and nulls a reconciled `confirmed`, and never clears `valid_to`. Violates the upgrade-only rule the entity path documents. HIGH.
- **SQ-M4 — knowledge rows stored during an embedder outage are invisible forever.** `memory.js:137-138` inserts `embedding=NULL` on embed failure; `getAllKnowledgeEmbeddings` filters `IS NOT NULL`; no knowledge-embedding backfill exists (only turns have one). Stored, counted, FTS-searchable, never semantically recalled — silently. HIGH.
- **SQ-I1/SQ-I2 — the voice guard's headline promise fails when exercised.** `main.js:688-694` + `voice_guard.js:101-105`: one Ctrl+Alt+M pause/resume cycle leaves `mode='manual'`; the only IPC back to `'auto'` has zero callers — meeting auto-detection is silently off until restart. And `main.js:594-604`: the guard is checked only at `enqueue`; a pause transition doesn't `flush()` — a meeting starting mid-reply keeps every queued sentence playing aloud. Together: the manual backstop can't actually silence her, and using it once disables the automatic one. HIGH.
- **SQ-P3 — extractor discards 70% of every reading.** `graph_extract.js:51` asks for "Max 20 lines" (num_predict 900) but `parseTriples` still `break`s at `>=6` (`:62-64`). Every reading ingest throws away up to 14 of 20 triples it paid to generate. HIGH.

---

## 2. MEDIUM — real defects, schedule deliberately

| ID | File:line | Defect | Failure scenario |
|---|---|---|---|
| SQ-I4 | `self_model.js:70,74,148-157` | LLM-down → `classify3` defaults `'same'` → destructive trait merge; legit merges write new embedding under old content | Ollama outage silently fuses distinct traits; identity store corrupts |
| SQ-I5 | `mood.js:193-197` @ `main.js:11589` | No retry floor; null compose never advances the stamp | Stuck mood fires a cloud call **every** chat turn (self_narrative already cured this exact disease) |
| SQ-B1 | `main.js:1315,1328` | ANN dedup `changed_since` reads the cursor *after* it advanced to now | Alias dedup ("Bob"~"Robert") scans an empty window every healthy tick — inert |
| SQ-B3 | `rumination.js:115` → `user_work.js:32` | Escalated theme drains only if it matches `research\|investigate\|…` | "Decide how to raise X with Lucas" is silenced, never worked (the D1 disease one filter later); matches seed at *user* priority |
| SQ-B4 | `main.js:12734,12851` | Idle-depth measured from any turn incl. her own `ai_said` | Her overnight announcement resets the ladder to tier 0 — deep-prep suppressed on active nights |
| SQ-P5 | `main.js:10972` | `<recall coord=…>` derefs dropped if any earlier intercept set `followupFired` | Manifest's "comes back THIS turn" promise is a silent no-op on those turns |
| SQ-P2 | `turn_router.js:42-44,115-116` | Gate helpers (`isConversational`/`allowsOperator`) dead; main re-implements inline; routes `operator`+`clarify` unreachable | Centralized route policy drifts from enforced policy (already visible at `main.js:9279`) |
| SQ-T7 | `main.js:12341` (20s) vs `echo_suit.js:417-429` (90s) | Wrapper resolves timeout while dispatch keeps running; retry re-issues | Slow `create_contact`/`saga_canvas_add_block`/`propose_*` lands *and* re-runs → duplicates |
| SQ-T8 | `operator.js:32`, `main.js:2551…`, `warm_keeper.js:21` | Fleet split: operator falls back to *editor* pref; bg passes hardcode `gemma4:31b-cloud`; warm-keeper heats `kimi-k2.6` not `-k2.7-code` | Changing one lane's model silently re-models another; warm spend heats a dead model |
| SQ-B6 | `main.js:923,1365,1436…` | 3 uncoordinated drivers of `run_dedup_adjudication`, each guarded only by its own flag | Double-spends the slow judge on the same pairs; corruption depends on Echo locking |
| ECHO-M5 | `adjudicate.py:106-123` | "Second signal" = jurisdiction already in the blocking key, double-counted | Same-state namesakes (Sr./Jr.) fuse on one signal, only a gemma veto between |
| ECHO-M6 | `engine.py:64-73` | Surname-only entities cluster (score=1) despite "never merges" mandate | A `Smith (AL)` not in contacts fuses onto the wrong person under auto-apply |
| ECHO-M8 | `ann/tombstones.py`, `overlay.py`, `recall_gate.py` | Entire ANN drift-control kit unwired | New entities invisible between rebuilds → entry-point resolver misses → mints a dup |
| ECHO-M9 | (measured) 105,214 live entities at degree 0 | No scheduled reducer; `cultivator_cycle_tick` includes neither link nor prune lane | Orphan mass only grows |
| ECHO-M7 | `graph.py:1394` | `revert_auto_promotion` soft-deletes relations by unstable rowid | A revert after a live-file VACUUM flips `deleted=1` on wrong edges (the 15,508-false-citation class) |
| ECHO-M10 | `backup.py:46-52` | Rotation omits `knowledge_graph.db` (corpus registry + node history), `bench.db`, `sq.db` | Operational-only, unrecoverable stores unbacked |
| SQ-I9 | `rehearsal.js:203-231` | `test()` runs sandbox-edited smoke code with full live-tree fs/env | An edited `smoke_*.js` is arbitrary code that can write into the live tree — sandbox escape (threat-model call for Lucas) |

---

## 3. LOW / latent — log and batch

SQ: `graph_extract` triple cap aside, `topFacts` confirmed-flag inverted (`graph_memory.js:241`, one live consumer re-filters, safe); research-band SQL keyed on JSON whitespace (`main.js:1163`, cross-writer format coupling); `kg_provenance` place-key normalization miss (`:34`); document-ingest retry can double-ingest (`main.js:15365`); `retrieve` kinds-filter half-applied (`memory.js:307`, no live caller passes kinds); idle-depth tier multipliers clamped so tier-0 "spend nothing" is a no-op (`main.js:12371`); recall `[rN]/[mN]/[kN]` markers resolvable but no producer renders them (`recall.js:5`); chat-turn echo tags past the hop cap dropped silently (`main.js:10899`); api_manager quota guard doesn't cover the model-facing tool path (`api_manager.js:20`); module-load env reads precede `loadEnv()` (trap, not live); speaker gate disarms if `ZOE_SPEAKER_THRESHOLD=` is set empty (`speaker.js:39`, `Number('')===0`); PTT send path ignores `res.speaker.match` (`chat.js:663`, mitigated); rehearsal slot-reclaim can discard a parked run's edits (`rehearsal_driver.js:86`). Echo: internal children mount flat but docstring claims a namespace (`internal/__init__.py:9`); `bill_lookup` returns `[]` on unset CONGRESS_GOV key (indistinguishable from "no such bill"); tenant apps mount full external surface with only a name whitelist, no tier gate (`chamber.py:195`); prune guard ignores tenant relation-proposal endpoints (`prune_empty.py:34`); `parse_juris` US-VA→VA normalization missing in `engine.py` (recall gap).

---

## 4. Verified clean (checked, not defects — so they're not re-reviewed next time)

- **The body-key fusion trap is gone** — all block keys fold the `(JURIS)` tag; zero duplicate untagged names among live canonical entities; `entities.name` UNIQUE structurally prevents the classic form. (ECHO)
- **Quarantine read-through is correct** — staged rows stamped `can_vouch=False`, hard-appended after live, marks preserved by all consumers; adjudicator can never delete a surviving row (alias-only merge). (ECHO)
- **`db_query` raw-SQL is well-guarded** — AST SELECT-only validation + engine-level read-only connection + SQLite authorizer + progress-handler timeout + tenant DB scoping. No injection path. (ECHO)
- **Speaker gate polarity is correctly fail-open** at every branch; env precedence `opts>env>snapshot>default` is fixed. (SQ)
- **No third audio door** bypasses the voice guard; all playback funnels through `_speech.enqueue`. (SQ)
- **"explore fires with steps=0" is FIXED** — deferrals now named, not counted as empty answers; `validateDecision` refuses run-moves without an `expect`. (SQ, closes a standing suspect)
- **History fit can't drop the current user turn; empty-cloud-reply fix holds at zero history.** (SQ)
- **All 7 recent commits' references resolve** — no dangling halves in b65571b/07071e0/3468aab/etc.; the foreground yield valve resumes correctly. (SQ)
- **The advertised-tag → executor diff is clean** — every tag she's told she can emit has a live executor; recipes smoke runs the real parser; skill promotion (met≥3) is wired. (SQ)
- **route_obs stall mystery = single-slot instrumentation ceiling**, not a lane bug — "widen markActivity first" confirmed correct; needs per-lane span records. (SQ, closes a standing suspect)

---

## 5. What this means for the "feel alive" goal

Lucas's stated end-state (comparative review §5b): *a real independent person working with me.* Three findings sit directly on that path and should be read together with the internal-state-vector proposal:

1. **The wondering organs are dark (SQ-B2).** Boredom, `<wonder>`, curiosity, self-set focus — the machinery that would make her *bring something of her own* — is unreachable, and nothing sources undirected focus under the default flag. The internal-state vector's whole point (drives deciding *what to pursue when*) has no live substrate to steer until this lane is re-wired. **The drive vector without the wondering organs is a dashboard with no engine.**
2. **Escalated pursuits die unless they sound like research (SQ-B3).** The one path from "something is circling in her mind" to "she works on it" filters on research verbs — so a *personal* preoccupation (the most person-like kind) is silenced, never pursued. Continuity of her own agenda, one of the five felt-aliveness qualities, is broken here.
3. **Consequence doesn't accumulate (SQ-M2, SQ-M4, SQ-I4, SQ-I5).** Graph facts don't render, witnessed facts get downgraded, knowledge silently drops out of recall, self_model corrupts on an LLM blip. "Yesterday visibly shapes today" — the core felt quality the vector is meant to deliver — is undermined by memory that quietly loses or degrades what happened.

**Order of operations this implies:** the internal-state vector (the comparative-review proposal) should not start until disease 3 (the dark organs) and the SQ-M consequence-accumulation bugs are fixed — otherwise the vector measures drives that can't act and carries a history that leaks. The aliveness build depends on this defect pass landing first.

---

## 6. Recommended fix order

1. **The tier-gate cluster** (SQ-T1/T2/T3 + ECHO-T1/T2) — security-load-bearing, and the autonomous loop runs tonight. One Echo sweep (tag 441 + un-xfail) + SQ gate-binds-by-default-and-fails-closed.
2. **The fabrication surface** (SQ-P1 first — add a `post` salvage branch and fix the misleading smoke; then SQ-T5/P4/T6) — every instance trains a confabulation the done-contract fought.
3. **Consequence-accumulation memory bugs** (SQ-M1/M2/M4/P3) — cheap, high-leverage, and prerequisite to the aliveness build.
4. **Voice-guard promise** (SQ-I1/I2) — one wired control + one flush call; the guard must silence her when a meeting starts.
5. **Echo fusion + queue** (ECHO-M4/M3/M5/M6) — auto-apply is riding on weak signals into a wedged queue.
6. **Re-wire the wondering organs** (SQ-B2/B3) — the gate to the aliveness build; decide first whether the 07-01 cut was meant to be permanent.
7. Everything in §2/§3 as scheduled maintenance.

**Companions:** `COMPARATIVE_REVIEW_2026-08-14.md` · `PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md` · `PROGRAM_REVIEW_2026-08-03.md`
