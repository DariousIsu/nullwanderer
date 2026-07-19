# Research Allocation Design

**Status:** design (2026-07-18) · **Author intent:** Lucas · **Substrate:** the autonomic beat system (see `AUTONOMIC_ARCHITECTURE_DESIGN.md`)

---

## 1. The problem

Parallelism now works: Zoe runs a primary research stream plus N fungible background
workers, each holding a distinct beat, all writing safely (the Echo `transaction()`
write-lock closed the last SQLite contention). `research.workers=2` is live and proven.

The open question is **allocation**: *how do we turn on more workers, and how do we decide
what each one works on?* The current answer is deliberately simple and is what we're
replacing:

- **`chooseNext`** (`lib/beat_scheduler.js`) picks the **least-recently-run** not-done beat
  in a lane pool. Pure round-robin over 223 elected beats + 3 topic beats.
- **`pickLane`** draws every 3rd slice from the topic lane, the rest from elected.
- **`_fillBackgroundWorkers`** (`main.js`) gives each worker slot the next least-recently-run
  beat distinct from the primary and the other workers.

Round-robin is **fair but blind**. It cannot express that:
- an under-substantiated (low-grade) target deserves priority — the [[substantiation-grading-vision]]
  north-star is literally *"grade IS priority"*;
- a beat the user flagged (e.g. "the Louisiana parishes") should jump the queue;
- a news spike ("something changed in Maricopa County") should surge attention there;
- the *mix* of object types (people / places / events / concepts) shouldn't starve —
  today's tier-by-tier march covers all of a state's counties before touching a concept.

Lucas's framing (2026-07-18): don't hard-code subject lanes (AI / power / datacenters) —
that's "too tight." Think broader: **people/places/events/concepts, priority gating, swarms
on command.**

## 2. The reframe

These are **not three competing ideas — they're three layers of one allocation model.**

| Layer | Role | Nature |
|-------|------|--------|
| **Priority queue** | THE CORE — replaces round-robin | Each researchable item scored from signals we already compute; workers pull highest-priority. Allocation is *emergent*, not hard-coded. |
| **Object-type balancing** | a FAIRNESS term inside the score | people / places / events / concepts kept in a healthy mix so no type/tier starves. NOT rigid lanes. |
| **Swarm-on-command** | a SURGE mode on top | `swarm on <target>` temporarily reallocates N workers to fan out on ONE target (multi-angle + cross-verify), then releases. A floor of workers stays on always-on breadth. |

Everything is already a **typed object** in the graph, so object-type is a dimension we read,
not one we impose. Workers are **fungible pullers**; there are no dedicated subject-workers.
The allocation *emerges* from the scores.

## 3. The priority function

Each candidate item (a beat, or later a finer-grained target/refresh) gets a scalar priority
`P`. Workers (primary + background) always pull the highest-`P` item not already held.

```
P(item) = w_grade    · gradeGap(item)        // under-substantiated ⇒ explore
        + w_stale    · staleness(item)       // news-anchored freshness clock
        + w_userflag · userFlag(item)        // operator-assigned jumps the queue
        + w_news     · newsTrigger(item)     // matchNewsToTargets "something changed"
        + w_fair     · fairness(item)        // breadth: recency + object-type balance
        + w_yield    · yieldEstimate(item)   // recent new-chars/pass — productive beats float up (borrowed from AuctionSwarm's bid, minus the LLM)
        − w_cost     · inFlightPenalty(item) // don't pile workers on one beat (unless swarming)
```

All terms normalized to `[0,1]`; weights `w_*` are runtime-tunable meta keys
(`research.weight.grade`, …) so we can retune live without a reboot, exactly like
`research.workers`.

### 3.1 What each signal maps to TODAY

Grounding the abstract terms in what the code already has vs. what needs wiring:

| Term | Source signal | Status |
|------|---------------|--------|
| `staleness` | `state.beats[id].doneAt` vs `now`, against `beat.maintenanceMs` (30d completeness / 3d topic). Already drives `dueForMaintenance`. | **have it** |
| `fairness (recency)` | `state.beats[id].lastRun` — the current `chooseNext` sort key. Becomes one term instead of the whole decision. | **have it** |
| `fairness (object-type)` | `beat.kind` (`entity` vs topic) + `beat.parentBeat` tier as a proxy for people/places/events/concepts. See §4. | **partial** — needs a `objectType(beat)` classifier |
| `gradeGap` | coverage `covered/universeSize` is a proxy now; the real signal is **citation grade** of the beat's targets (low grade = explore). | **needs wiring** — pull avg grade from Echo per beat/target |
| `newsTrigger` | `matchNewsToTargets(stateCode, headlines)` already exists (county-token + noun + change-cue). | **have it (county-only)** — extend to topic/target |
| `userFlag` | none yet — an operator "pin this beat/target" meta. | **needs building** — `research.pin.<id>` meta + a chat verb |
| `yieldEstimate` | recent `newChars` per pass (already recorded per pass by the directed research state machine) — cache as `state.beats[id].yieldAvg`. Borrowed from Swarms `AuctionSwarm` (the signal, not the LLM bid). | **have it (raw)** — needs a rolling cache |
| `inFlightPenalty` | `state.workers[*].beatId` + primary beat id — already tracked to keep workers distinct. | **have it** |

**Build order falls straight out of this table:** the queue can ship using only *have-it*
signals (staleness + recency-fairness + news + in-flight), then `gradeGap`, `userFlag`, and
object-type balancing layer in as separate slices without reworking the core.

### 3.2 Why a score, not sorted lanes

`pickLane` (elected-vs-topic every-3rd-slice) is a hard-coded 2-lane split. Folding it into
`P` as the object-type fairness term means the elected/topic balance becomes *emergent from
the mix*, and the same machinery generalizes to people/places/events/concepts without adding
a lane per type. `pickLane` becomes a special case we delete once object-type balancing lands.

## 4. Object-type balancing

Everything researchable is a typed object. Map each beat to a coarse type:

- **people** — rosters of officials (the elected tiers' *members*)
- **places** — jurisdictions themselves (counties, municipalities, districts as entities)
- **events** — meetings/minutes/votes/elections (the temporal facets)
- **concepts** — topic beats (ai / power-infrastructure / datacenters) + minted concepts

Balancing = a **fairness term that rewards the starved type.** Track a rolling count of
recently-run slices per type; `fairness_objtype(item) = 1 − share(type(item))` so the
under-served type's items float up. This is soft pressure, not a quota — a genuine news surge
or a user pin still outranks it. It replaces the rigid every-3rd-slice topic rule with
continuous pressure toward a balanced mix.

`objectType(beat)` is a small pure classifier (beat `kind` + `parentBeat` tier → type),
unit-testable in `smoke_beats.js`.

## 5. Swarm-on-command

A surge primitive on top of the steady allocator.

```
swarm on <target>  → reallocate up to K workers onto ONE target/beat, each on a DISTINCT
                     angle (facet / source-class / sub-question), for a bounded burst;
                     then cross-verify the returns and release the workers back to the queue.
```

Mechanics:
- **Reserve a breadth floor.** Never let a swarm consume every worker — keep ≥1 (config
  `research.swarm.floor`) on the normal queue so always-on coverage continues.
- **Distinct angles.** The K swarm workers each take a different facet of the target's plan
  (the beat's `facets` array already enumerates angles) or a different source-class, so they
  don't duplicate each other — this is the fan-out → verify → synthesize pattern (the bundled
  deep-research skill primitive is the reference for the verify/synthesize half).
- **Bounded + self-releasing.** A swarm is a temporary priority override (`P = ∞` for the
  target, capped worker count), with a stop condition (target converges / dry-streak / budget)
  after which the workers rejoin the queue.
- **Trigger.** Operator verb ("swarm on <X>") is the manual trigger; a strong-enough
  `newsTrigger` could later auto-swarm, but manual-first.

Swarm is the *only* place `inFlightPenalty` is intentionally overridden — normally the penalty
spreads workers out; a swarm deliberately concentrates them.

## 6. Borrow vs. build (OSS survey, 2026-07-18)

Two camps surveyed:

- **Orchestration frameworks** — LangGraph (stateful graphs + supervisor/worker + checkpoints),
  CrewAI (role crews), AutoGen/AG2 (dialogue/research), Google ADK, OpenAI Agents SDK,
  Haystack (RAG pipelines).
- **Swarm-specific** — Swarms AI (hierarchical / concurrent / sequential / graph modes);
  **Agent-Swarm.dev** ("lead agent breaks goals into tasks → routes to specialized workers in
  isolated containers → shared memory + review gates") — **strikingly close to this vision;
  read closely as a reference, not a dependency.**

**Decision: STUDY the patterns, TAP specific primitives, do NOT swap frameworks.** Adopting one
wholesale = rip-and-replace the focus/beat/worker substrate we just built and validated (big
regression risk, and these are heavyweight layers). The close read (source + docs, 2026-07-18)
sharpened this into three concrete takeaways:

**(a) The core differentiator — deterministic scorer, NOT an LLM in the allocation loop.**
Swarms' `HierarchicalSwarm` assigns work *entirely by LLM*: a director model emits a `SwarmSpec`
of `orders` (agent_name → task) every round, parsed from LLM output — **no priority scoring,
queue, or load-balancing exists** (confirmed in `hiearchical_swarm.py`). `MultiAgentRouter` is
the same (LLM "boss" routes by capability). That's a per-round LLM call, non-deterministic, and
costly at our cadence (a tick every few seconds across 226 beats). **Our priority function is a
deterministic scalar over signals we already compute — cheaper, predictable, offline-testable.
Keeping the LLM out of the *allocation* decision is a deliberate design choice, and the survey
confirms it's the road less taken.** (LLMs stay in the *research* itself and in swarm verify.)

**(b) Two Swarms patterns are near-exact matches — validation + one borrowable term:**
- **`PlannerWorkerSwarm`** — *"planner emits a task queue; a worker pool claims and executes
  tasks concurrently."* This is **our exact model** (scheduler = planner, fungible workers claim
  distinct beats). Independent arrival at the same architecture = strong validation. Their
  "claim" semantics = our `held` Set / distinct-beat exclusion in `_fillBackgroundWorkers`.
- **`AuctionSwarm`** — agents bid `(confidence, estimated_cost)`, auctioneer awards best bid.
  We reject the *mechanism* (forced per-item LLM tool-calls to bid = the LLM-in-loop cost we're
  avoiding), but **borrow the signal**: fold an **estimated yield/cost term** into `P` for free —
  a beat's recent **new-chars-per-pass** (we already track `newChars`) is a deterministic yield
  proxy. Rising-yield beats float up; exhausted ones sink. Add as an optional `w_yield` term.
- **`CouncilAsAJudge` / `MajorityVoting` / `LLMCouncil`** — multi-dimensional scoring +
  peer-review + majority-vote tie-break. This is **the swarm verify/synthesize half** (§5),
  and it's exactly what the bundled deep-research skill's 3-vote adversarial refute already does.

**(c) LangGraph cautions worth heeding as we ramp workers:**
- *"Postgres checkpointing prevents the SQLite lock contention you WILL hit under concurrency."*
  We're on SQLite (Echo). We mitigated with the `transaction()` RLock — but this names SQLite
  write-contention as the known ceiling; ramp workers deliberately and watch for it returning.
- *"Max revision limits on every loop prevent infinite budget burn."* We already have this
  (`MAX_PASSES_REFUSAL` soft cap + 2-dry-pass stop) — good validation, keep it.
- *"Literal-typed, validated routing state catches 90% of routing bugs at dev time."* Analog:
  keep the scheduler-state shape tight and smoke-covered as the score replaces the sort.

| Borrow (pattern) | From | Where it lands here |
|------------------|------|---------------------|
| planner emits queue → worker pool claims | Swarms `PlannerWorkerSwarm` | **validates** our scheduler + fungible-worker model 1:1 |
| bid `(confidence, cost)` → **yield/cost term** | Swarms `AuctionSwarm` | optional `w_yield` in `P` from tracked `newChars` (no LLM bid) |
| council / majority-vote scoring | Swarms `CouncilAsAJudge` / deep-research skill | the swarm verify/synthesize half (§5) |
| supervisor/worker + checkpoint | LangGraph | already have it: scheduler = supervisor, `state.beats`/`state.workers` = checkpoint |
| shared searchable memory + review gates | Agent-Swarm (Agent-fs + DAG approval gates) | Echo KG + our two-gate promotion (already run) |
| fan-out → verify → synthesize | bundled deep-research skill | the swarm verify/synthesize half |

**Build (ours):** the priority-queue allocator itself (evolve `chooseNext`), object-type
fairness, the `userFlag`/pin verb, the swarm reserve-floor + release. The scheduler already
tracks beats / coverage / staleness / news / `newChars` — the scoring inputs exist; we're adding
a deterministic score where a sort used to be, and deliberately **not** putting an LLM in the
allocation loop.

**Explicitly NOT adopting:** Docker-per-worker isolation (Agent-Swarm) — we're one process with
async workers, containers are overkill; LLM-director assignment (Swarms Hierarchical /
MultiAgentRouter) — the whole point is a cheap deterministic scorer; embedding-similarity routing
(`AgentRouter`) — our beats are already typed, no need to embed-match capability.

## 7. Migration — slices

Each slice is independently shippable, gated by smokes, revertible via meta (keep the
round-robin path behind a flag until the queue proves out).

- **S1 — Priority core (have-it signals only).** Add `scoreBeat({beat, state, now})` to
  `lib/beat_scheduler.js` returning `P` from staleness + recency-fairness + news +
  in-flight-penalty. New `chooseNextByPriority` selects `argmax P`; keep `chooseNext`
  (round-robin) behind `research.alloc=priority|roundrobin` meta (default roundrobin until
  proven). Wire `_fillBackgroundWorkers` + the tick to the selected allocator. Extend
  `smoke_beat_scheduler.js` with scoring assertions (monotonicity per term, tie-breaks,
  starvation-free). **No behavior change until the flag flips.**
- **S2 — Object-type fairness.** `objectType(beat)` classifier + rolling per-type share +
  the fairness term. Delete `pickLane` once the mix is emergent. Smokes: each type gets
  floor share over a long run.
- **S3 — Grade gap.** Pull avg citation grade per beat/target from Echo (read-only), wire
  `gradeGap`. This is the "grade IS priority" realization. Watch: low-grade shouldn't thrash
  (add hysteresis).
- **S4 — User pin.** `research.pin.<id>` meta + a chat verb ("focus on / pin <X>"); `userFlag`
  term. The Louisiana-parishes case is the acceptance test.
- **S5 — Swarm-on-command.** `swarm on <target>` verb → K-worker burst with reserve floor +
  distinct-angle assignment + release. Reuses the deep-research fan-out/verify primitive.

Ship S1 alone first, flip the flag, observe against round-robin (does it converge stale +
news-hot beats faster without starving breadth?), then layer S2–S5.

## 8. Guardrails (unchanged constraints)

- Workers never touch `CURRENT_KEY` — chat/leash/surfacing only ever see the primary.
- Browser semaphore (`ZOE_BROWSER_CONCURRENCY`, default 3) caps concurrent tabs — watch stealth
  + cloud 429s as worker count ramps.
- SQLite write-contention is fixed (Echo `transaction()` RLock), so ramping workers is safe to
  try; still ramp deliberately (2 → 3 → 4) and observe.
- Government sources are leads, not facts — corroboration discipline is per-target, orthogonal
  to allocation.
- All weights/flags are runtime meta (no reboot to retune or revert).

## 9. Open questions

- **Granularity of the queue item.** Beat-level (223 items) first; do we later score at the
  *target* level (52k items) for true priority research, or keep the beat as the unit and let
  the directed pass handle within-beat order? Beat-level is the S1 unit; target-level is a
  possible S6.
- **Grade source.** Per-target grade lives in Echo; the cheapest read that gives a beat-level
  avg without hammering the engine (cache in `state.beats[id].gradeAvg`, refreshed on
  condense?).
- **Auto-swarm.** Should a strong `newsTrigger` auto-trigger a bounded swarm, or stay
  manual-only? Manual-first; revisit after S5.

---

### Cross-refs
[[autonomic-architecture-design]] · [[substantiation-grading-vision]] ·
[[object-memory-architecture]] · [[tool-surface-horizon]] (agent spawning)
