# Tracks + Priority — Design (no code yet)

Consolidated design from the 2026-06-29 behavior-design sessions. The thesis: a research deliverable,
a note-to-self, a stray lookup, and an interest Zoe is chasing are **the same object** — a **Track**
that accretes content, carries a priority, and has a lifecycle. Unifying them fixes a cluster of live
bugs (confabulated counts, lossy consolidation, run-centric Q&A, "circling not growing") and gives a
cheap, principled resource-allocation channel. This is an **expansion of the existing memory grid, not
a rewrite** — and it must stay that way (the substrate is the most protected thing: "Zoe IS the memory").

Status: DESIGN ONLY. Nothing built. Sequenced slices in §8.

---

## 1. Why (the problems this collapses into one)
- **Run-centric Q&A** — "how many / what's the list" confabulates the moment a run completes, because the
  grounded path is gated on an *active* focus. (Live: "around 15", "still being compiled" — while 21 sat
  exactly in `focus.2027.covered`.)
- **Lossy assembly** — the final consolidation re-summarized the whole document through a model pass and
  **dropped 15 of 21 orgs** (dossier said "6"). No complete document ever existed to query.
- **Circling, not growing** — without a first-class accreting object, she re-researches the same ground.
- **No resource channel** — everything competes equally; "I need this now" can't actually commandeer
  resources, and stray thoughts can't be cheaply parked.

All four are symptoms of not having a **Track** object + a **priority scheduler**.

---

## 2. The unifying object: a Track
```
Track = {
  id, topic,
  source:   command | utterance | self        // authority class (sets the priority band)
  priority: 1..10                              // the importance value, banded by source (§3)
  state:    active | parked | complete | stalled
  content:  accreting parts                    // grows; never re-derives what it already holds
  index:    the exact set of parts             // SOURCE OF TRUTH for count / full list
  document: lossless stitch(parts)             // the deliverable — N-parts-in = N-parts-out
  standard: the "done" bar
  corrections: supersede history               // user contradicts a part -> tombstone-not-delete
  iterations:  deepen passes
  links:    edges to other tracks              // the graph / mapping
}
```
A directed research run is a Track. A stray lookup is a Track. A note-to-self is a Track. They differ
only in `source`, `priority`, and how much `content` they accrete.

---

## 3. The Priority Model (locked)
**Bands (authority ceiling — the source caps the level):**
- **Zoe-self: 1–6** — she may self-prioritize her own novelty, but can NEVER self-assign a command level.
- **User utterance: 3–7** — conversational mentions; inferred strength.
- **Direct command: 8–10** — **Yellow 8 / Orange 9 / Red 10** (kills urgency ambiguity).

Bands **overlap on purpose** (a serious self-track @6 can outrank a throwaway utterance @3).

**Assignment:**
- A **deterministic gate** scores the item. The danger zone is the **7/8 boundary** (high utterance vs
  real command). Rule: **when it might be a command but the gate isn't confident → ask for the color
  outright**, rather than silently under-rating it. (Missing real urgency is expensive; asking is cheap.)
- `isDirectedTask` already separates command from conversation → the gate's command/utterance split is
  largely solved; the colour refines the command level. Plain command defaults **8**; alert words → 9/10.

**Alerts (commands) are two-way + user-owned:**
- Zoe **echoes the level she registered** ("Red — dropping everything, on it"), so the user knows it landed.
- **Only the user lowers or cancels** an alert. Zoe may *complete* it or report it *blocked* — never demote.
- **Same-level commands are recency-ordered:** a fresh Red preempts an older Red; the older one **parks and
  resumes after**, it is not cancelled.

**Tie-break (equal priority):** **user-source wins, then recency.**

**The self-budget ("within reason"):**
- **Level 1 = unbounded** — infinite parking for stray thoughts. She NEVER has to forget something to note
  something new.
- **Levels 2–6 = fixed slots, zero-sum** — promoting a thought 1→≥2 forces something at ≥2 **down to 1**.
  *Capacity to remember is infinite; capacity to actively pursue is bounded.*
- Commands and utterances (user authority) are **not charged to her budget**.

**Decay:** none for commands (hold until complete/stall). Stray thoughts **park, never decay**.

---

## 4. The Scheduler (priority-governed attention)
Replaces today's "one directed focus at a time, fixed cadence." The driver becomes a scheduler:
- Work the **highest-priority active track**; lower-priority tracks wait.
- **Stray/low tracks run only on spare capacity** — never at the expense of higher-priority work.
- **No starvation of high by low**; within level 10, **preempt-newest** (old Red parks, resumes after).
- A directed research run is just a **priority-10/8 Track**; interest-driven research is **low-priority
  Tracks**; musings are **priority-1–2 Tracks** worked on spare cycles. Most of today's special-casing
  (directed driver vs interests vs musings) collapses into "it's a Track with a priority."

---

## 5. The Deliverable lifecycle (the pipeline, confirmed)
1. **Interface (Dans) takes the request** — intake/conversation only.
2. **Cloud runs the task** — generation at the **caged leaves** (per-part, professional register).
3. **Program assembles the FULL + COMPLETE document** — **deterministic stitch of all parts** (N-in=N-out),
   model used only for the *wrapper* (Summary, Gaps, true-dedup). **This is the fix for the 6/21 drop.**
4. **Signal complete** — a real *done* (goal met / exhausted), distinct from *stalled*.
5. **Interface gets summary samples** — Dans queries the Track for count/list/sample/status and relays them.
6. **Canvas pulls the full document** — the Track's `document` renders on the canvas, bypassing Dans.

The grounded-answer path is **deliverable-centric, not run-centric**: count/list/sample/status come from the
Track's `index`/`document`, **whether the run is active or complete** (fixes the post-completion confabulation).

---

## 6. Determinism-law alignment (the spine)
- **Orchestrator = the program** (deterministic): scheduling, the priority math, assembly, the query path.
- **Cloud models = caged at the leaves** (professional register): generate each part + the Summary/Gaps wrapper.
- **Voice model (Dans) = intake + relay** of summaries/pointers — **never generates or voices the full
  deliverable**, never assembles, never sets a command priority.

---

## 7. Mapping onto existing primitives (expansion, not rewrite)
| Track field / behavior | Already exists as |
|---|---|
| Track skeleton + lifecycle | `lib/focus.js` + `open_threads` (status: pending/active/stalled/resolved) |
| content accretion | the `knowledge` store + `lib/learning.js` (Accrete) |
| grow-not-circle | `learning.Iterate` (anti-retread) + the directed covered-set anti-loop |
| priority value | the `importance` field (banded by source) |
| index / source-of-truth | the covered-set (`focus.<id>.covered`) generalized |
| document / deliverable | the per-target file (`notes/directed-<id>.md`) + `research.last_dossier` |
| corrections | verified-fact reconcile / tombstone supersede (+ the pending correction-purge guard) |
| iterations | the directed deepen passes / `Iterate` |
| mapping / links | `graph_memory` entities + relations (the literal grid) |
| command vs utterance | `lib/operator.isDirectedTask` |
| the scheduler | generalizes the `directedFocusTick` driver from 1 focus → N priority-ordered tracks |

So most of it is **collecting fragments onto one object**, not new plumbing.

---

## 8. Slice plan (incremental, gate-green at each step, substrate protected)
0. **Track as a thin view/extension** over existing focus/open_threads + knowledge + meta (lean: a *view*,
   not a new substrate table, unless a minimal `tracks` index proves necessary). Pure mappers + smoke.
1. **Deliverable fix (highest value, concrete) — ✅ BUILT 2026-06-29:** lossless **deterministic assembly**
   (condense = stitch per-part leaves + a small Summary/Gaps model pass) **+ the deliverable-query path**
   (count/list/sample/facet/status off the Track, active OR complete). Fixes the live confabulation + the
   6/21 drop. Pure-logic smokes (assembly is deterministic → fully testable offline).
   - `lib/assemble.js` (pure): `parseSections` (split the accreted run file into "## <org>" sections),
     `reconcileIndex` (covered ↔ document drift → indexed-but-missing surfaced in Gaps), `buildWrapperPrompt`/
     `parseWrapper`/`WRAPPER_SYS` (the model writes ONLY Summary/Gaps, never the sections), `stitchDocument`
     (deterministic N-in=N-out; count derived from the artifact). The model never sees the assembled output.
   - `lib/track.js` (pure): `classifyQuery` (count/list/sample/facet/status), `buildAnswer` over a plain
     track object (the index + sections + in-flight target) — grounded facts only, no invention; the
     "facet sweep" answers "head of policy for each" across every section; the in-flight target serves a
     live "what about MIRI" question.
   - `main.js`: `condenseRun` rewritten to the lossless stitch (drops the old whole-doc map-reduce);
     `buildQueryTrack()` resolves the CURRENT-or-last Track (active focus → `research.last_dossier` →
     `research.last_focus_id`); the chat status block replaced by the deliverable-query block (fires active
     OR complete; status-kind suppressed on a bare social greeting for a finished run). `research.last_focus_id`
     pointer set at directed-run start so a stall-without-dossier is still queryable.
   - Smokes `smoke_assemble.js` (45 ok) + `smoke_track.js` (22 ok); gate now **47/47 green**.
   - Still routing-deferred (Slice 3): a dual-intent turn ("keep researching **but** your opinion on MIRI")
     answers the deliverable query but drops the continue-ack; the live "opinion/why" conversational
     question (vs a count/list/sample) is not yet auto-routed to the live Track content.
2. **Priority model:** banding + the deterministic gate (+ ask-for-color) + two-way alert + the self-budget.
   Pure logic + smokes.
3. **The scheduler:** replace the single-focus driver with the priority-ordered multi-track scheduler.
   **Riskiest — touches the autonomous loop** → behind a flag, careful, gate-green, easy rollback.
4. **Canvas pull:** the Track's `document` → canvas via the `canvasEmit` seams (coordinate with the canvas
   context; see `docs/ZOE_CANVAS_INTEGRATION.md`).

Each slice stands alone and earns its keep; 1 alone fixes the current visible bugs.

---

## 9. Open decisions
- **Track storage:** view over existing tables vs a minimal `tracks` index. (Lean view, to protect the substrate.)
- **Deterministic gate:** exact scoring + the ask-for-color UX (when/how she asks).
- **Scheduler interleave:** preempt vs time-slice within a level; how **parked** tracks resurface on spare capacity.
- **Completion signal:** the precise *done* vs *stalled* distinction (goal-met heuristic).

---

## 10. Invariants (do-not-break)
- **Protect the memory pipeline above all** — incremental, gate-green, behind the existing knowledge store; no big-bang rewrite.
- **Determinism-law** — cloud at leaves (professional), program assembles, Dans relays only.
- **Lossless assembly** — N-parts-in = N-parts-out; never a model summarization of the whole document.
- **Authority ceilings** — Zoe ≤ 6; only the user sets 8–10; only the user lowers/cancels an alert.
- **Never forget** — Level 1 is unbounded.
- **Heavy non-public tools stay OFF the automatic track.**

---

## 11. Live validation + refinements (2026-06-29)
A live session where Lucas pushed on the running research validated the design and surfaced two
genuinely-new requirements. Observed failures, each a named slice:

- **Research ↔ conversation disconnect (sharpest):** the operator had just deepened MIRI (~5k chars of
  fresh research) while, in the same minutes, the chat **confabulated** her "opinion on MIRI" and then
  **deflected** the "they want to destroy you" challenge. The live research never reached the
  conversation. → **Slice 1's deliverable-query must serve the ACTIVE track's fresh content, not only
  completed deliverables.** A question about a topic the program is researching *now* must query that
  live Track.
- **"Who's the head of policy for each?" → admitted ignorance** despite 21 orgs' leadership existing.
  → Slice 1 (query the Track, not whatever scraps reached Dans).
- **Enrich-existing-entries (NEW requirement):** "dig into the leadership of *these 21*" → the engine
  could only DISCOVER new orgs (it drifted to FLI/MIRI); the covered-set anti-loop *blocks* re-entering
  covered items. → **Track `iterations` must support re-entering the covered set to fill a missing
  FACET (leadership / contacts) across existing entries — distinct from the discovery anti-loop.**
  Needs per-entry facet-completeness + a "fill facet X across all covered entries" operation.
- **Priority did not suppress musings:** mid-way through a "highest priority for the next hour" command,
  an unprompted philosophy musing fired. → **Scheduler rule: while a ≥8 track is active, suppress
  unprompted low-priority utterances (heartbeat / continuity / idle musings).**
- **Dual-intent turns (NEW):** "keep researching, *but give me your opinion on MIRI*" = continue +
  converse; the clarification path swallowed the whole thing and the "still gathering names" status-pad
  crowded out the actual answer. → **a turn may carry multiple intents; a continue/clarification ack must
  not crowd out the conversational answer (and vice-versa).**

- **Autonomous video-watching is the same pattern (validates the model on a 2nd domain):** she re-picks
  the SAME video repeatedly (no **watched-set** → anti-circle violation) and **abandons mid-video** (no
  completion lifecycle — another autonomous action navigates her browser away). And the guardrail Lucas
  wants ("finish what you start, but don't sink hours into non-project video") is exactly the **priority
  budget**. → a video-watch is a **low-priority (≈2) self-Track**: (a) watched-set so she doesn't re-pick;
  (b) a **completion lock** — a started watch runs to `complete` before another autonomous action grabs
  the browser; (c) a **bounded watch budget** on spare capacity (a project-serving video earns more; a
  higher-priority track still preempts). No separate patch — it's the Track lifecycle + anti-circle + budget.

**Net adjustments to the plan:**
- **Slice 1** widens to *"query the CURRENT-or-last Track, active OR complete"* — explicitly including a
  live, in-progress Track so the conversation reflects what's being researched *right now*.
- **The Track** gains an explicit **facet-fill / enrich-existing** iteration mode (re-enter covered
  entries to complete a facet), separate from discovery.
- **The Scheduler** gains **musing-suppression under a high-priority (≥8) track.**
- **Routing** gains **dual-intent** handling (continue + converse in one turn).
