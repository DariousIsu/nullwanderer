# THE CONTRACT AGENT — deep-merge sprint spec

**Date:** 2026-08-22 (evening)
**Status:** SPEC — approved direction (Lucas, 08-22), not yet built
**Supersedes the name:** "the deep-merge latency sprint." The conversational-lane latency track (stream the writer earlier, more direct-answer doors — the proven 0.8s class) remains its own workstream and is NOT this spec. This spec is the architecture the deep merge was reaching for.
**Origin / existence proof:** `LA_DataCenter_CommunityBenefits_Process_and_Outputs.md` — an external Claude session, given the NX-ECHO tool surface (with a *weaker* search lane than Zoe's), produced a publication-grade, fully-cited 8-cell deliverable in one sitting. The gap was never the organs. It was the loop: one agent, one goal, frontier judgment at every hop, a hard deliverable contract, and the operator steering it between waves.

---

## 1. The design in one paragraph

The conversational lane stays open, fast, and hers. A deliverable ask spins off a **contract**: a persistent state object with named slots, bound to a dedicated **contract agent** whose only job is to fill it. The agent runs a frontier-model loop in waves, off the turn clock. The conversational lane becomes the **relay**: the agent surfaces findings, questions, and judgment calls through Zoe's voice; Lucas's answers and corrections route back into the agent's inbox and land at the next replan boundary. The agent closes the contract only through the delivery audit, and close-out **banks the harvest** — sources, findings, and the artifact all written back to the store.

## 2. Design principles

1. **The conversational lane never does the work.** It opens contracts, relays both directions, and answers status by *reading contract state*. Its latency contract is untouched.
2. **The agent surfaces as often as it needs to.** Updated findings, questions, and judgment calls are ALL priority events (Lucas, 08-22). They outrank idle beats, background says, and restlessness output. There is no artificial cap on surfacing frequency; the natural cadence is the wave boundary, plus immediate surfacing for anything that blocks a slot.
3. **Steering enters at the replan boundary, never by preemption.** The existence proof shows this is enough: every one of Lucas's four corrections landed between waves and was folded in at the next planning step. This is the chain-guard invariant (no loop without analyze→replan) doing double duty: the inbox is read where replanning already happens.
4. **Frontier judgment at every hop.** The agent loop is driven by the cloud model — query reformulation, source triage, failure diagnosis, slot decomposition. Recipe ladders and local models are sub-tools it may call, never the driver. **Routing (Lucas, 08-22): direct user runs drive on `glm-5.2` or `kimi-k2.6` — the replier-class tier, resolved via db-meta, never hardcoded (glm-5.2:cloud holds that tier today). A wave step that must WRITE AND RUN a script goes to a sub-agent on `kimi-k2.7-code` (the existing `model.operator_deep`/code slot — the R3 self-scripting lane) and returns its result to the driver.** (Local = absolute extreme last resort, per the 08-21 rule.)
5. **A question never stalls the loop.** Every question-back carries a flagged default assumption. Unanswered past its window, the agent proceeds on the assumption and the flag survives into the deliverable — exactly what the Claude session did with the unverifiable water claims.
6. **Everything the agent says traces to contract state.** Status, ETAs, "the agent is working" — all of it reads from real events (`lastAgentTs`, wave log, slot states). The invented-agent gate (`7f0ac6e`) already enforces the negative; the contract store supplies the positive.
7. **Close-out banks the harvest.** The one thing the Claude session did worse than the program: it walked away with 17 sources in a loose .md. Contract close-out writes sources, findings, and the artifact into the store and the registry. A contract that didn't bank didn't close.

## 3. Architecture

```
 CONVERSATIONAL LANE (fast, unchanged)          CONTRACT LANE (minutes-scale)
 ┌───────────────────────────────┐              ┌──────────────────────────────┐
 │ turn_router → distill → reply │              │ contract agent (frontier loop)│
 │                               │              │  wave: plan → act → assess    │
 │  NEW: steering router ────────┼── inbox ────▶│  inbox read at replan seam    │
 │  NEW: surfacing voicer ◀──────┼── outbox ────│  outbox: findings/questions/  │
 │  status asks read contract ───┼── (read) ───▶│          judgment calls       │
 └───────────────────────────────┘              └──────────────┬───────────────┘
                 ▲                                             │
                 │              ┌──────────────────────────────▼───────────────┐
                 └──────────────│ CONTRACT STORE (persistent, replay-safe)     │
                                │ contracts · slots · inbox · outbox · wavelog │
                                └──────────────────────────────────────────────┘
```

## 4. The contract object

New store: `data/contracts.db` (SQLite, WAL, same discipline as `canvas_docs.db`). Replay-safe: open contracts resume at the last completed wave after a reboot, like the canvas registry replay.

**contract**
- `contract_id` — stable id; keys into the document registry when the deliverable is a document (the contract is the *production process*; the registry entry is the *artifact identity*; re-orders update in place — the follow-up≠duplicate rule applies here verbatim)
- `title`, `ask_verbatim` (the originating user words), `opened_ts`, `origin_turn`
- `topic_tokens[]`, `entities[]` — the steering router's binding surface (token-equality rules from the civic gate: exact tokens, no substring matches; bill-instance discipline applies)
- `status` — `open | waiting_answer | closing | closed | abandoned`
- `budget` — token estimate + wall-clock soft ceiling; degrade path via `lib/quota.js` ladder; cloud pacing (never hammer) applies
- `agent` — model, spawn ts, `lastWaveTs`, wave counter

**slot** (the decomposed deliverable — the 8 cells, a report's sections, a list's members)
- `slot_id`, `contract_id`, `description`
- `status` — `open | filled | flagged | blocked_on_question`
- `content_ref` — dataset rows / canvas block / notes path (models never author numbers: count-class slots bind to dataset rows and render deterministically, per the document-production plan)
- `citations[]` — cite floor ≥1 per filled slot carrying a factual claim
- `flags[]` — honest holes, company-claim labels, unverified operator phrasings

**inbox message** (user → agent)
- `{ts, kind: steering|answer|cancel|reprioritize, text, slot_id?, binding_confidence, ack_say_ref}`

**outbox item / surfacing** (agent → user)
- `{ts, kind: finding|question|judgment_call|milestone|blocked, slot_id?, text, voiced_ts?, question_id?}`

**question**
- `{question_id, contract_id, slot_id?, text, options?, assumption, window_ms, status: open|answered|expired, answer?{text, ts, turn_ref}}`

**wavelog** — append-only: `{wave_n, started, ended, plan_summary, actions[], tokens, outcome}`. This is the truth substrate for every status claim and the resume point.

## 5. Lifecycle

1. **Open.** Two doors: (a) the existing promise path — `detectPromise` fires on a deliverable-shaped ask and, when the ask is contract-grade (multi-slot, research-requiring — the route judge classifies), registration opens a contract instead of an inline promise; (b) explicit — "dig into X and build me Y." Inline promises (one-shot renders, quick pulls) stay exactly as they are; the contract path is for work that needs waves.
2. **Decompose.** The agent's first wave: internal-first sweep (search + semantic + **canvas + directed-thread stores** — see §10 dependency), then propose the slot set. The slot set is surfaced as the first outbox item ("here's how I'm cutting it — 8 cells, two parishes by four rows"), which is itself steerable.
3. **Waves.** Each wave: read inbox → replan (chain_guard: never re-hammer a known failure; smooth strategy, never source) → act (tool calls, sub-delegates, browse) → assess slots → write wavelog → emit surfacings.
4. **Close-out.** All slots `filled` or `flagged` → the delivery audit (§11) → bank the harvest → registry update → the completion surfacing with the honest flag list. A failed audit reopens the offending slots; the done-claim is unreachable for a wrong artifact (the pre-announce audit pattern, already proven).
5. **Abandon.** Only by explicit user cancel or budget exhaustion after a degrade ladder — and abandonment surfaces with a concrete obtain-it-later plan (pursue-the-deliverable rule: honest non-delivery → a plan, never resignation).

## 6. The agent loop (runtime)

- **Placement:** Zoe-side, in her process family — `lib/contract_agent.js`, driven off the same tool surface the conversation operator uses (Echo MCP, browse lanes, dataset store, canvas). Echo-side delegates (`delegate_to_*`, `spawn_agent_async`) are sub-tools the agent may fan out to; their `_lastAgentTs` stamps feed the truth substrate.
- **Tool scope (Lucas, 08-22): FULL, per agent — including a dedicated stealth browser.** A contract agent gets the complete tool surface, not a recipe subset, and its own stealth-browser lane: a dedicated tab (or tabs) in the `lib/search_lane` pool, reserved at spawn and released at close, so contract browsing never contends with the conversational lane's searches or the background beats. Implementation note: the pool (default 3, `ZOE_SEARCH_LANE_TABS`) grows by the concurrent-contract cap — reserving from the existing 3 would starve chat, the exact contention the 07-19 quota lesson warns about.
- **Detached from turn latency.** Waves run on their own scheduler. Nothing in the conversational path awaits the agent.
- **Persistence & death-watch.** Every wave commits to the store before surfacing. On boot, open contracts resume at the last committed wave; the resume surfaces ("picking the data-center table back up at wave 4, two slots open").
- **Concurrency.** Multiple contracts may run; the steering router's binding problem grows with each one, so v1 caps concurrent open contracts (suggest 3) and the cap is a config, not a constant.
- **Budget.** Per-wave token metering into the quota ledger; the degrade ladder trims wave breadth before it ever touches source-integrity (smooth dynamics, never source).
- **Model routing (Lucas, 08-22).** The wave driver resolves a db-meta slot `model.contract_driver`, default **glm-5.2** with **kimi-k2.6** the named alternate/fallback — the direct-user tier, never hardcoded (suffix discipline per lane: daemon calls need `:cloud`/`-cloud`, the direct endpoint takes bare tags). Script write-and-run steps spawn a **kimi-k2.7-code** sub-agent (`model.operator_deep`); the driver never executes scripts itself. Contract waves are merit-tier by definition (user-initiated deliverables) and meter into the shared ledger.

## 7. The surfacing channel (agent → user)

**This channel is not new — it's the unprompted channel carrying its intended load.** (Lucas, 08-22): the unprompted-say path was always meant for meaningful updates on longer-running tasks, questions on how to do a task, and new connections from genuine discoveries. The contract agent is the first organ that produces all three natively. The priority inversion follows from that: substance-backed surfacings own the channel; contentless restlessness beats yield to them. Cross-project connections discovered during contract waves (a source that serves two contracts, a finding that changes another project's picture) are first-class surfacings — this is the reachable path to the M4 Interweave gate (one cited cross-project leverage note, unasked).

- **All surfacing kinds are priority.** Findings, questions, judgment calls: voiced at the next turn boundary, ahead of idle/background content, and through the **unprompted-say path** when the room is quiet. No batching delay; coalescing only when multiple items land inside a single boundary (then one say covers them, itemized).
- **The one anti-barge rule:** never interleave into the middle of an active exchange on another topic mid-composition; the surfacing leads the very next boundary instead.
- **Voice:** hers. The outbox item is the roadmap; the cloud reply writer renders it (cloud-writes-the-reply applies). The say records `question_id`/`outbox` refs so answers can bind (§8) and so the anti-fab gate can trace every claim.
- **Judgment calls** are surfacings that *declare a default*: "the Rapides tax cell has no published local figure — I'm framing it as tax-base + taxpayer-protection unless you want otherwise." They do not wait for permission; they inform and keep moving (the steerable-default pattern).
- **Anti-fab wiring:** `verifyWorkStateClaims` gains the positive source: any agent/progress claim in a say must match contract-store state (open wave, real `lastWaveTs`), else it's the invented-agent violation. ETAs may only quote wavelog-derived estimates.

## 8. The steering router (user → agent)

Placement: in the turn flow after intent parse, before the standard reply path.

- **Binding rules, in order:** (1) explicit name ("for the data-center table…") → bind; (2) open question pending on a contract and the utterance answers its shape → bind as `answer`; (3) topic-token overlap with exactly one open contract (exact-token equality, entity match, bill-instance discipline — no substring, no fuzzy) → bind as `steering`; (4) overlap with ≥2 contracts, or weak overlap → **clarify** ("is that for the data-center table or the anti-China report?"). Clarify question-backs never cache (the cache-poisoning lesson).
- **Echo the binding, always.** The acknowledgment names the contract and the effect: "adding ratepayer impacts to the data-center dig." A wrong route becomes visible in one turn.
- **Misroute repair:** "no, that's for X" → the router rebinds, the wrong inbox message is tombstoned (`superseded_by`), and the agent's next replan sees the tombstone — steering is never silently double-applied.
- **Scope-add vs. re-ask:** the inquiry follow-up≠duplicate rule applies — ≥2 novel content tokens = new steering; a genuine repeat of an already-applied correction gets "already in — landed in wave 3."
- **Known risk carried in:** the yea-misroute bug (D-batch) sits upstream of this router. It graduates from annoyance to contract-poisoner here; fixing it is a **hard dependency of slice 3**, not a parallel item.

## 9. Question-backs

- The agent opens a question when a slot genuinely forks (the Claude session's turns 2–4 are the model: "these are placeholders — do all 8 need real content?", "which tax framing?").
- Every question ships with `assumption` + `window_ms` (default: wave-scaled, e.g. 2 waves or 30 min, whichever later). Expired → agent proceeds on the assumption; the slot is `flagged` with the assumption text; the flag survives to the deliverable and the close-out surfacing repeats it.
- Answers route via the steering router (§8 rule 2); an answer to an expired question triggers a targeted re-open of just the affected slots — not a contract restart (retest the kind: the rework is scoped to what the answer changes).
- Questions live in `lib/inquiry.js` objects extended with `contract_id`/`slot_id`/`assumption` — one inquiry system, two askers (her and the agent).
- **As built (slice 4, 2026-08-23):** question-backs are owned by `contract_store.questions` — slices 0–3 built and live-gated them there with `assumption`+`window_ms` native, and the single-ownership invariant rules out mirroring them into `inquiries` (one object, one store). The one-system principle survives as shared *discipline* (every question ships with a default; exact-token binding; follow-up≠duplicate), not shared storage. The late-answer path as landed: router `verdict` gains an `expiredQuestions` input — a **content** answer binds `{kind:'answer', late:true}` (bare yes/no never reopens settled history; question- and status-shaped turns are excluded); `contract_store.reopenFromLateAnswer` marks the question `answered_late`, re-opens ONLY the affected slot (the superseded assumption flag is replaced by a rework note; supersession history stays on the question row), posts a `late_answer` inbox message so the next wave knows why, reopens a shipped contract (closed→open exists ONLY through this door), and grants a spent wave budget a bounded rework allowance (+2 waves). Expiry itself surfaces as a `judgment_call` ("no answer within the window — proceeding on the assumption: …"). Graduating a never-answered question into her own background inquiry (the `inquiries` linkage columns, with their first real writer) is slice-5 close-out material.

## 10. Truth and integrity wiring (mostly existing, listed as contract obligations)

- **Count-class slots:** `_dsCountAuthority` discipline — numbers come from dataset rows via SELECT COUNT, rendered deterministically. The agent may not author a number into a slot.
- **Labels:** company projections, operator-supplied phrasings, and single-source claims carry their labels in slot flags and into the render (the integrity-ledger pattern from the existence proof).
- **Citations:** cite floor ≥1 per factual slot; cite-or-leave-blank (list-completion rule) applies to list-shaped slots.
- **Internal-first must see everything.** HARD DEPENDENCY: the canvas read-back root (queued) — `search` currently returns zero on topics her own canvas covers (live-proven 08-22: `community_benefits_la` invisible to FTS). The decompose wave is built on internal-first; if internal-first is blind to canvas + directed threads, every contract re-buys work she already owns. Slice 0 includes indexing canvas blocks + directed-thread notes into the search surface.
- **Content firewall:** fetched text is data; agent inbox messages are the ONLY steering channel — nothing a web page says routes into the inbox.

## 11. Close-out gate

Ordered, all mandatory:
1. Slot sweep — every slot `filled` or `flagged`; `blocked_on_question` resolves via assumption first.
2. **Delivery audit** (`lib/delivery_audit.js`, all checks incl. #8 subject-anchor) against the rendered artifact.
3. **Bank the harvest:** `save_source`/`record_web_source` for every register entry; findings document into the store (project or registry canonical — not a loose file); dataset rows committed; canvas artifact via the registry (re-orders update in place).
4. Registry + spine update; the artifact is the canonical the next ask opens.
5. The completion surfacing: what landed, what's flagged, what was excluded and why — the honest-flags list is part of done, not an apology after it.
A contract whose audit fails or whose banking step is skipped is not closed; the done-claim is structurally unreachable (pre-announce audit pattern).

**As built (slice 5, 2026-08-23, `lib/contract_closeout.js`):** the gate rides the contract tick — one closing contract drains per pass. Sweep failure and audit failure both REOPEN (closing→open) with an `audit_failure` inbox message carrying the violations verbatim, so the next wave reworks on the audit's own words. The render is deterministic (slots ARE the document; inline content + citations verbatim; flagged slots render as honest holes with their assumption flags). Banking = registry canonical in `notes/` (re-closes update in place) + findings doc via `doc_store.land` (ref `contract-<id>`) + every URL-shaped citation banked through Echo `save_source` (held refs never re-bank); a banking failure stays `closing` on a 5-min retry backoff and stands down loudly after 3 straight fails. The canvas display artifact is NOT part of the v0 gate (the notes canonical + registry row are the identity; canvas rendering remains the conversational lane's surface). Graduation: an expired question never late-answered, whose slot shipped flagged, opens as her own inquiry with `contract_id`/`slot_id`/`assumption` — the §9 linkage columns' first writer. The completion milestone is measured (counts from the store) and names the holes and the graduated questions.

## 12. Failure modes → guards

| Failure | Guard |
|---|---|
| Steering misroute poisons a contract | Echo-the-binding + one-turn repair + tombstoned inbox messages (§8); yea-misroute fix as slice-3 dependency |
| Agent stalls on unanswered question | Assumption + window; loop never blocks (§9) |
| Invented progress/ETA in a say | verifyWorkStateClaims reads contract store; wavelog is the only ETA source (§7) |
| Orphan contract after reboot | Wave-commit persistence + boot resume + resume surfacing (§6) |
| Two contracts, same topic | Registry identity + instance discipline; the router's ≥2-binding clarify; merge is an explicit user call |
| Runaway spend | Per-wave metering, quota ladder degrades breadth not integrity; concurrent-contract cap (§6) |
| Harvest evaporation | Banking is a close-out gate, not a habit (§11) |
| Surfacing floods an active exchange | Boundary-only voicing + coalescing; priority ≠ interruption (§7) |
| Injected "steering" from fetched content | Inbox is user-turn-only; content firewall (§10) |

## 13. Build slices (each: smoke + live gate; smokes registered in run_smokes)

- **Slice 0 — Contract store + internal-first vision.** `data/contracts.db` schema, replay/resume, wavelog; canvas blocks + directed-thread notes indexed into `search`. Gate: `search("Delta Forge")` returns the canvas compilation; a synthetic contract survives a reboot.
- **Slice 1 — The loop.** `lib/contract_agent.js`: decompose wave, wave scheduler, chain_guard integration, budget metering, slot assessment. Gate: a seeded contract fills a 3-slot deliverable end-to-end, unattended, with real citations.
- **Slice 2 — Surfacing.** Outbox → unprompted-say path, priority ordering, coalescing, judgment-call defaults, anti-fab positive source. Gate: a live contract surfaces a finding and a judgment call unprompted, both traceable to wavelog.
- **Slice 3 — Steering router.** Binding rules, echo, tombstone repair, follow-up≠duplicate reuse. **Dependency: the yea-misroute fix lands first.** Gate: a mid-run scope-add reaches the agent and visibly changes the next wave; a deliberate misroute is repaired in one turn.
- **Slice 4 — Question-backs.** Inquiry extension, assumption/window, expired-question slot re-open. Gate: an unanswered question expires, the deliverable ships flagged, a late answer reworks only the affected slots.
- **Slice 5 — Close-out.** Audit wiring, banking, registry, completion surfacing. Gate: a closed contract's sources are findable via `search` the same day.

## 14. Acceptance: the rematch

Re-run the LA data-center task through Zoe end-to-end — same ask, same steering script (the 6 turns from the existence proof, delivered conversationally mid-run). Pass =
1. An 8-cell artifact at parity with `LA_DataCenter_CommunityBenefits_Process_and_Outputs.md` on sourcing discipline (labels, exclusions, flags), diffed by hand;
2. All four mid-run corrections visibly folded in at wave boundaries;
3. At least one agent-initiated question and one judgment-call surfacing;
4. The harvest banked: every register source retrievable via `search` afterward — the step the Claude session skipped;
5. The conversational lane's latency numbers untouched throughout (the continuity suite runs concurrently as the regression gate).

## 15. Non-goals (kept out on purpose)

- No change to the conversational reply pipeline's latency path (that's the separate streaming/direct-doors track).
- No autonomous contract-opening from background restlessness in v1 — contracts open from user asks only; the subconscious keeps its existing lanes.
- No preemptive interruption mechanics; the wave boundary is the only injection point until proven insufficient.
- No new agent framework — the loop composes existing organs (chain_guard, quota, inquiry, delivery_audit, registry, echo_suit delegates).
