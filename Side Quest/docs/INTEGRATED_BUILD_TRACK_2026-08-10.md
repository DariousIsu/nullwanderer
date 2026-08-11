# Integrated Build Track — Spine 3 remainder + Spine 4 (Cognition/Self)

**Written:** 2026-08-10 (late) · **Branch:** `feature/idle-passive-intelligence` · **HEAD:** `a671b8f` · **Gate:** `npm test` green (385/385 at handoff).
**Owner:** sole builder (this context and its successors). **Authority docs:** [`DELIVERY_BINDING_SPINE.md`](DELIVERY_BINDING_SPINE.md) (Spine 3 spec), [`BIDIRECTIONAL_VERIFICATION_GATE.md`](BIDIRECTIONAL_VERIFICATION_GATE.md) (Spine 2 spec), [`SPINE3_DELIVERY_HANDOFF.md`](SPINE3_DELIVERY_HANDOFF.md) (Spine 3 build detail — code anchors, playbook, git rules). **This doc integrates all remaining work into one ordered track and adds Spine 4.** It does not restate the spec docs — read them first for R/A definitions and the operational playbook.

---

## PROGRESS (updated 2026-08-10, sole builder) — gate 388/388 green, all local

- ✅ **B0 — main-loop stall** (measure→mechanism): `ingest-drain` now yields to live conversation (`dd10a13`); the reply-path `idle` blind spot is attributed (`reply-prompt`/`reply-fit`, `28689dd`); metabolism yield-checked + `metabolism-sweep` named (`b7f9bcf`). **Increment 3 (relocate whatever the new log names) is live-boot-gated** — read `data/stall_attrib.log` after driving turns.
- ✅ **A1 — fall-through generalized (COMPLETE, all lanes):** generic organ `lib/fallthrough.js` (`285fc26`) → media_cc video floor `enqueue_transcript` + G3 leak fix (`1b3c05a`) → gmeet drought→honest-surface+stay (`279366c`) → teams drought (`f77996a`). Live proofs (empty-caption video/meeting) are quota-gated. Finding flagged: teams lacks gmeet's `MAX_MEETING_MS` backstop (auto-leave change — Lucas's call).
- ✅ **R4 — roster-mode swarm** (`3bdc519`): `local_roster.openTasks(state)` + `drainSwarm` (bounded parallel pool, fail-soft, R3-scoped per task); the `swarm on <state>` verb runs a directed, un-throttled (`lane:'interactive'`) parallel completion → re-assembles the openable xlsx + honest coverage. `smoke_swarm_roster` 16/16, registered. Live drive ("swarm the LA roster") is the quota-gated path to the commissioned fill.
- ✅ **R2 — serve-vs-rebuild trust gate** (`e1656f6`): the roster build door now serves a held-and-fresh sheet instead of always rebuilding — `decideServeOrRebuild({held, currentFilled, ttlMs})` (pure; no-held/stale/coverage-grown → rebuild, fresh+unchanged → serve), wired via a `roster.product.<STATE>` meta; denominator always the frame count. `smoke_swarm_roster` 22/22.
- ⏸ **★ commissioned LA run** — the Phase-A beta acceptance test (live, quota-gated): a real "swarm the LA roster" (R4) → complete, governance-scoped, source-verified, coverage-honest openable sheet, every blank a verified "not published." **Phase A is otherwise CODE-COMPLETE**; this is the one live drive, on Lucas's quota call.
- ✅ **C1 (Spine 4) — importance-at-landing** (`3a0a7c9`): EXTENDED the existing `lib/importance.js` (Park poignancy for thoughts/readings) with `scoreDocument({source,body,title,origin})` — deterministic, no model call, bulk (news/browser_download) scores low by shape; `documents.importance` column + stamped at landing by `doc_store.land`. `smoke_importance` 28/28. The score now exists+stored at landing; consumers next.
- ▶ **NEXT: C2 — prospective triage over the governor** (the first consumer of C1's score: value-of-reflection estimate → fire the reflection beat when worth it, replacing the uniform idle-defer). Then C3 grounded reflection (built to the §1 Honest-Lying constraint) → C4 persona-anchored drive.

---

## 0. The situation, integrated

The census reduced the program to **three spines of honesty**: **1 Discourse** (salience manifest — built), **2 Verification** (bidirectional gate — built + live-verified), **3 Delivery** (partly built; remainder below). This session added a fourth, from cross-referencing the cognitive-memory literature against the program: **Spine 4 — Cognition/Self**, the reflective self-loop that our own North Star ("always-on restlessness") and drift audit both say is unbuilt.

**Landing sequence for the whole track:**

```
PHASE A — finish Spine 3 (offline-buildable first, one live drive at the end)
   A1  fall-through generalized            (headline; offline build + smoke, then 1 live drive)
   R4  swarm roster-mode, un-throttled     (headline; extend existing swarm)
   R2  serve-vs-rebuild trust gate         (small; verify what product_ledger already covers)
   ★   commissioned "fill LA" run          (beta acceptance test — trips the beta bar)

PHASE B — infra unblock (gates Spine 4's protected beat)
   B0  main-loop stall attribution + fix   (heavy metabolism blocks live turns → 150s watchdog)

PHASE C — Spine 4 (Cognition/Self)
   C1  importance score at landing         (unlocks promotion triage AND the reflection trigger)
   C2  prospective triage over the governor (economics of attention — "know when to spend")
   C3  grounded reflection beat            (belief synthesis that CANNOT drift — see §Spine-4 constraint)
   C4  persona-anchored drive              (PEPA: self competes with tasks at the drive level)
```

Phase A is **offline-buildable** except the two live drives (A1 caption drive, the commissioned run) — respect the app-down / quota-reserved mode: build with the app stopped, boot only for the batched live drives. Phase B is the prerequisite that keeps Spine 4's reflection beat from being eaten by the stall or the governor. Phase C is the new work.

**Non-negotiable discipline (inherited):** fail-open, never a false scold · regex finds candidates, structure decides · build the generic organ before the specific instrument · each step = one commit + one smoke, gate stays green · validate with a live drive + DB proof, never assume a non-firing gate passed · git: **named SQ files only, never `git add -A`** (repo root is Desktop; confirm `git diff --cached --name-only` before every commit); push only when Lucas asks.

---

## 1. The Spine-4 design constraint (from "Honest Lying", arXiv:2605.29463)

**Reflection is the plank the research unlocks — and the plank most likely to reintroduce the drift disease if built naively.** The paper names three simultaneous preconditions for *memory confabulation* (a confident-but-false belief written to memory and reused): **(1) binary feedback, (2) self-generated reflection, (3) persistent retrieval.** A reflection loop supplies (2) and (3) by construction.

**Spine 2 does NOT close this** — it is an *egress* gate (checks assertions on the way to Lucas), while confabulation forms at the *write + retrieval* seam. Its bare-recall rule deliberately passes a plain recalled fact, which is exactly the shape a confabulated memory takes. So Spine 2 is the **second** line of defense, not the cure.

**Therefore Spine 4 (C3) MUST import the paper's two proven mitigations at the WRITE seam:**

1. **Grounded reflection** — every belief a reflection mints **cites the specific episodes/evidence** it rests on. Reuse `verify_claim.judgeFact`'s evidence-membership test at write-time; a belief whose supporting tokens aren't present in its cited episodes is not written (or is written `unsubstantiated`, prove-or-fade). This is the program's existing substantiation doctrine applied to synthesized beliefs.
2. **Programmatic feedback extraction** — a reflection's *inputs* are **programmatic signals** (`obs_bus` events, `recheck_queue` verdicts, the `echo_suit` gather ledger, substantiation/decay rows), **never the model's free self-diagnosis.** This is the paper's largest measured win (correct-object 0%→86%, RRR 0.64→0.10) and it is identical to Spine 2's `lastGatherTs`-beats-self-report principle.

**Two instruments we already own, to point at the reflection store:**
- **RRR monitor (frozen-memory detector):** the paper's Reflection Repetition Rate (near-duplicate reflections ≥0.85) ≈ `capability_need._similar()` token-overlap dedup; retire via `curator.curateNeeds`'s dormant-park pattern. Wire these against reflection rows to detect a frozen/looping belief.
- **Egress backstop:** `metacognition.groundFacts` + `verify_claim` step 5 already catch a confabulated belief *if* it becomes a load-bearing reply assertion. Building C3 is what finally stress-tests step 5 live (a reflection can mint the pure-recall-shaped false belief that is rare today).

**Acceptance for C3 is therefore two-sided:** it must (a) synthesize a useful episode-cited belief, and (b) **fail the confabulation test** — given a cluster of episodes that don't support a tempting generalization, it must decline to write it (RRR stays low, no unsupported belief lands). A reflection that only does (a) is the disease.

---

## 2. PHASE A — finish Spine 3

Full code anchors, build shapes, and proof recipes are in [`SPINE3_DELIVERY_HANDOFF.md`](SPINE3_DELIVERY_HANDOFF.md) §2. Summary + integration notes only here.

### A1 — Fall-through, generalized *(headline, offline-buildable)*
Lift the `excavate → web_fetch` floor (commit `9cbdf83`) into a reusable shape and apply it to caption lanes that follow DOM captions with **no fallback to `av_transcribe`**.
- **Build:** `lib/fallthrough.js` — `withFallthrough(primary, fallback, {report})`: run primary; on empty/failed, run fallback before the lane may report "couldn't." Fail-open when both fail. Pure, dep-injected.
- **Wire:** `lib/media_cc.js` (caption cascade — verified this session), `lib/gmeet.js` (~570), `lib/teams.js` (~162). Reuse `news_lane.js:761 findSpeechVideo` → `av_transcribe` call shape (verified). Each lane keeps its own prompt/instruments; share only the descent. **Also fix the G3 leak:** the media_cc watch loop must terminate on fallthrough-exhaustion (bounded lifetime / stop-on-idle) — an unsettled session leaking into later turns is part of this disease.
- **Prove:** `scripts/smoke_fallthrough.js` (stub primary fails → fallback ran → no "couldn't" when fallback succeeds → fail-open when both fail). Then **1 live drive** of an empty-caption video, watching for the `av_transcribe` descent + a settled session.

### R4 — Swarm roster-mode, un-throttled for a directed completion *(headline)*
Extend the **existing** `swarm on <X>` verb (`main.js` ~6314 `startSwarm`), do **not** build a new swarm. Teach it a **roster mode** targeting a state's `local-roster` recheck tasks (the door already enqueues them, R3-scoped): fan `min(workers, remaining)` in parallel, each running `recheck_queue.buildPrompt({kind:'local-roster'})`, `applyOutcome` → `civic_store` as each converges, coverage re-assembling into the same xlsx.
- **Guardrail (do not regress `e45085b`):** every swarm worker MUST use the `local-roster` R3-scoped prompt (sheriff/DA/clerk excluded) — never a generic directed pass. Un-throttling (interactive/`directed` spend tier, ~`main.js:11529`) is **only** for an explicit Lucas-commissioned completion; background swarms stay pace-gated. Watch `get_quota_summary`.
- **Reference:** `lib/review_fanout.js` join-and-deliver shape; `spawn_agent_async`.
- **Prove:** `scripts/smoke_swarm_roster.js` (N tasks + mock worker → parallel dispatch, per-task R3 prompt, convergence writes, coverage re-count). Then a live drive: `"swarm on the Louisiana parish roster"`.

### R2 — serve-vs-rebuild trust gate *(small)*
Denominator half is done (`buildFrame(state).count`, independent of found count). Remaining: the **serve-vs-rebuild** decision as an explicit organ — held-and-fresh → serve; stale/absent → rebuild. **First verify** whether roster deliverables already route through `lib/product_ledger` / `presentHeldProduct` (they may already be covered); build only the thin missing decision.
- **Prove:** smoke — held+fresh → serve; stale/absent → rebuild; denominator is always the frame count.

### ★ Commissioned "fill LA" run — beta acceptance test
Once R4 makes the fill fast, run the real thing in one commissioned turn. **Beta bar:** a complete, governance-scoped, source-verified, coverage-honest LA parish roster handed over as an OPENABLE spreadsheet — **every blank a VERIFIED "not published," never an un-attempted lookup.** Capture logs + xlsx round-trip as the acceptance record; update `program-census-plan.md`.

---

## 3. PHASE B — infra unblock (prerequisite for Spine 4)

### B0 — main-loop stall attribution + fix
The census + the multi-turn audit repeatedly hit: heavy background metabolism (doc-decomp, directed operator passes, route-drain pruning) **blocks the main loop during live turns → 150s watchdog → "that turn stalled, I've reset."** This is the [[route-obs-lag-and-drain]] / [[video-capture-freeze]] disease class. **It gates Spine 4** — a reflection beat added to a loop that already stalls makes the stall worse, and the whole point of the beat is that it runs *without* stealing the reply path.
- **Build shape:** finish the stall attributor (widen `markActivity` coverage so `route_obs` stops showing ~88min/day UNATTRIBUTED), then move the heaviest synchronous metabolism off the reply-serving tick (yield / chunk-to-window / defer under `_conversationActive`). Measure first (attribute the stall) before mechanism — do not guess.
- **Prove:** a drive during active background metabolism completes without tripping the watchdog; `route_obs` UNATTRIBUTED share drops.

---

## 4. PHASE C — Spine 4 (Cognition/Self)

The research planks, ordered so each unlocks the next. **Each is spec-then-build** — write a short spec doc (like the Spine 2/3 specs) before the first commit, because this touches the protected identity substrate ([[personality-drift-diagnosis]] is the cautionary tale: reflection *already once* colonized her identity).

### C1 — importance score at landing *(the keystone — unlocks two things at once)*
Park's third retrieval axis (recency × **importance** × relevance) is the one we lack. Add an importance/poignancy score at the moment material lands (`doc_store.land` / conversation-pass / memory-event write). Two immediate consumers:
- **Promotion triage** — `shouldPromote` "skipped 0 ever"; the `browser_download` 460/day flood is an importance-scoring problem. Importance becomes the triage key over the round-robin capacity fix.
- **Reflection trigger** — Park fires reflection when accumulated importance crosses a threshold; this replaces the lottery decider (`explore` fired ~3× ever). **This is the principled trigger Thread-1 research (TRIAGE, arXiv:2605.13414) says beats a uniform rule.**
- **Prove:** importance correlates with a held-out "did Lucas act on it" signal where available; promotion backlog for high-importance classes drains ahead of bulk.

### C2 — prospective triage over the governor *(economics of attention)*
The restless loop keeps losing the budget lottery because the governor is **uniform** (sacrifice idle first). Research (TRIAGE; "Learning When to Plan", arXiv:2509.03581 — the "Goldilocks" cadence; "LLMs Know When They Know", arXiv:2605.14186) says the lever is **prospective per-task triage**: estimate value-of-reflection *before* spending, so the beat earns its slot rather than being handed one or starved.
- **Build shape:** a small `value_of_reflection(candidate) → score` using signals we already have (importance sum since last reflection, staleness/decay pressure, recheck-queue depth, substantiation debt). The metabolism tick spends when score clears a tuned threshold — a Goldilocks cadence, not always/never. Reuse the `recheck_queue` protected-lane pattern (`lane:'interactive'`, governor-proof) so the beat can't be zeroed out, but let triage decide *whether* it's worth firing this tick.
- **Prove:** under quota pressure, high-value reflections still fire while low-value ticks yield; the beat's spend tracks value, not a flat floor.

### C3 — grounded reflection beat *(belief synthesis that cannot drift)*
The Park/PEPA reflection pass — but built to the §1 constraint. Ask salient questions of recent high-importance episodes; synthesize episode-**cited** beliefs into the dormant relational layer ([`RELATIONAL_LAYER_DESIGN.md`](RELATIONAL_LAYER_DESIGN.md)) and mood layer (`lib/mood.js`), **never** into stable identity (`self_model` — the drift firewall stays).
- **Constraint (from §1):** grounded (cite episodes) + programmatic inputs (obs_bus / recheck / gather ledger, not free self-diagnosis). RRR monitor on the output. Egress backstop = `groundFacts`/step-5.
- **Prove (two-sided):** (a) synthesizes a real episode-cited belief; (b) **declines** to write an unsupported generalization from a tempting cluster (RRR low, no drift). Plus: `self_model` unchanged after a reflection run (the firewall holds).

### C4 — persona-anchored drive *(PEPA: self competes with tasks)*
PEPA transforms personality traits → hierarchical goals that steer the motivational landscape, suppressing "cross-personality confusion" — our exact drift defect, cured positively rather than defensively (write-guards). Give the idle/subconscious decider a **persona-anchored goal layer** so "who she is" competes with "what she does" at the *drive* level, not just the write-guard level.
- **Tension to hold (named, do not ignore):** PEPA optimizes *believability* (consistent persona); our North Star optimizes *trustworthiness* ("trust is the product"). These can conflict — a believable persona asserts; a trustworthy one hedges. The persona drive must never override the honesty layer (Spine 2). Bar = "in character **and** still refuses to confabulate."
- **Prove:** over a multi-day idle window, inner-life is no longer ~100% research (the drift-audit measure); persona/relationship musing recurs; zero regression in Spine-2 honesty metrics.

---

## 5. Why this order

Phase A finishes the delivery spine and trips the beta bar (the concrete, gradable win Lucas is waiting on). Phase B removes the stall that would otherwise sabotage any added beat. Phase C builds the reflective self-loop the research validates — and it's sequenced so C1 (importance) is the keystone both promotion and reflection need, C2 gives the beat a principled reason to fire, C3 makes the beat's output un-driftable (the Honest-Lying constraint), and C4 finally lets the self compete with the task for the inner life. The research doesn't hand us autonomy; it hands us the two missing halves (synthesis + triage) that bolt onto the two we already own (verification + cost-discipline) — and the bolt-on only holds if C3 is built to §1.

**Memory pin to update as each item lands:** `program-census-plan.md` (governing; absolute-date everything).
