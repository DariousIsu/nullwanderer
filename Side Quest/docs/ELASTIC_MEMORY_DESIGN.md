# Elastic Memory — Design

**Status:** design. **Date:** 2026-08-18.
**Builds on:** `LIVING_CONVERSATIONAL_MEMORY_DESIGN.md` (conversation-as-encounter-stream, slices C0–C4),
`OBJECT_MEMORY_ARCHITECTURE.md`, `MEMORY_PATH_MAPPING_DESIGN.md`, `TEMPORAL_SUBSTRATE` notes.
**Governing principle:** recall ≠ fact-viability (see §2).

> **The ask (Lucas, 2026-08-18):** *"Stress-test the program keeping track of several conversational
> threads including pulling memories that relate to the new threads, and really cross the boundary to a
> real elastic memory."* Plus: *"Probe her awareness of herself — things she's done, meetings she's
> been in, conversations she's had. Something she did this morning and something she did months ago
> should both be equally accessible."* And the target behavior: *"Remember when we talked about X? Yes I
> do, we said this about it, but that was a few months ago — would you like me to update that record
> before we continue?"*

---

## 1. What the program does today — measured

Two substrate maps and one live 9-turn drill on the running program (`:8767`, session 1177, all turns in
one session). The drill interleaved topics, returned to an earlier one, then probed self-history.

### 1.1 Live failures (mechanism-verified)

| ID | Probe | Behavior | Mechanism |
|---|---|---|---|
| **D1** | "Now something different — the 2026 Senate map, tightest race?" (bare pivot, no pivot verb) | Shipped a full "Louisiana Energy Policy" answer — the *previous* topic | `route=lookup`, but recall + the energy-saturated `conversation_state` bled in. The pivot never registered. `threadsMinted=0`. |
| **D2** | "Circle back — the weakest part of that *first thing* we talked about?" | "The weakest part was my sycophancy…" — an old salient memory, not the conversationally-first topic (energy) | `[recall] surfaced 4 user-statement turns`; the referent resolved by cosine similarity, not by conversational structure. No topic stack to anchor "first thing". |
| **D3** | "What did *you* work on earlier today?" | "I hold four people named 'You': Jessica Fay, Joseph Underwood…" | `[main] ambiguous entity` — the self-reference "you" was captured by the entity-mention resolver. The autobiographical question never reached an activity retriever. |
| **D4** | "When did Louisiana *first* come up vs most recent — is the older one hazier?" | Latched a stray recent sub-query and web-searched | `route=lookup`. No first-vs-recent contrast, no date-stamp, no refresh offer. |

**Works today (do not disturb):** named-entity object recall (Cassidy), meeting recall (honest, specific —
the *proof pattern*), thematic cross-session recall (partial), within-window episodic reach.

### 1.2 Substrate facts (code + DB)

- **No conversational-thread object exists.** "Thread" (`open_threads`, 3,942 rows) is a durable *work*
  backlog, dominated by autonomous research tasks; it has no `session_id` and no conversational
  foreground/suspended state. Conversation continuity is one 120-word `conversation_state` summary per
  session (`lib/convo_state.js`). `lib/focus.js:184` enforces "one focus at a time". Thread re-entry only
  fires through the redirect lane (`main.js:8941-9072`), which needs an explicit pivot verb
  (`REDIRECT_TRIGGER_RE`) or a ≥2-token overlap (`matchThreadToTopic`). A bare pivot/return falls through.
- **Episodic recall is window-capped, not age-neutral.** The two live recall sites — the recall
  interceptor (`main.js:7599`) and passive episodic recall (`main.js:8723`) — call
  `memory.retrieveTurns` with the **`scan=400` default** (`lib/memory.js:290` → `lib/db.js:1216`,
  `... ORDER BY id DESC LIMIT ?`). Older turns are never scanned. *Within* the window `retrieveTurns` is
  pure cosine — already age-neutral. The cliff is the window, not a recency score. The code documents the
  exact live failure (`memory.js:286`): a June answer "was ~2,000 turns outside the scan." A deeper path
  already exists but is off the live route: `cognition._enrichConvo` uses `scan:4000` (`lib/cognition.js:188`).
- **Turn-embedding coverage is uneven by age:** Aug 89% / Jul 37% / Jun 50%. Older episodes are less
  indexed.
- **Autobiographical stores are large but mostly unreachable by recall:** `agent_events` 80,722 (her
  actions) and `monologue` 79,785 (her thoughts) have **no embeddings** and only recent-window readers
  (`db.js:2258`, LIMIT 40). Her own thoughts are additionally excluded from turn recall (`db.js:1216`
  filters `speaker IN ('user','ai_said')`). **Meetings are the exception** — promoted into the age-neutral
  `knowledge` store as `meeting_episode` (`lib/gmeet.js:759`) and retrieved by `retrieveScored` over a
  non-age-capped pool. That is the pattern to copy.
- **Already fixed, drops from scope:** `conversation_state` coverage (the C0 concern) rose from 28% → 78%
  of meaningful (≥3 user-turn) sessions; `turn_count` now tracks past 20 (max 50). The summariser runs.

---

## 2. The governing principle — recall ≠ fact-viability

Two functions must not share one recency knob:

- **Fact viability** ("is this claim still true?") — recency *should* weigh; a newer source supersedes a
  stale one. `retrieveScored`'s recency weight (0.5, `memory.js:441`) is **correct here and stays**.
- **Episodic/conversational recall** ("do I remember discussing X?") — must be **age-neutral**. The memory
  *that we talked, and what we said*, is equally reachable this-morning or months-ago.

So elastic memory = recall the **episode** age-neutrally, then **separately** judge the **content's**
freshness and surface staleness as an actionable offer. The build adds a distinct age-neutral episodic
path; it never rebalances fact ranking to chase equidistance.

---

## 2a. Revision log

- **Rev 2 (2026-08-18), post-hardening.** A 3-critic adversarial pass (against the real code) + a follow-up
  DB probe corrected §3–§6 below. Key corrections: (a) episodic recall must fire on a NEW episodic-reference
  detector inside the interceptor — not the existing `isRecallQuery`, whose regex misses "remember when we
  talked about X" and which early-returns before the L3 site (R1); (b) the promoted conversation store is
  **not** a viable reach path — probed: promoted conversations live in `documents.source='conversation'`
  (which `retrieveScored` does not read) and only reach back to 2026-07-22, and `knowledge` has no
  `conversation` kind — so v1 reach is a **scan-all-embedded raw-turn** path + a one-time turn-embedding
  backfill, with promotion-into-`knowledge` as a later scaling slice (R2); (c) reuse `lib/salience.js`
  (the per-session object frame) for E3 rather than a parallel topic-stack, fold it EARLY, and **suppress**
  the tainted running-summary/salience recall rather than adding a competing profile (R3); (d) reuse
  `memory.logAction` / `kind:'trajectory'` for E2b — probed dead (11 rows, stopped 2026-06-25) — by widening
  call-site coverage, not a new writer (R4); (e) thread `ts` into recalled turns (R5); (f) merge E2a+E2b
  into one slice (R6); (g) pass a recency-neutral weight profile on the episodic path so §2 holds literally
  (R7); (h) dedup the refresh offer per topic per session (R9); (i) budget the injected profile structurally
  (R10). Full findings: scratchpad `elastic-memory-phase.md` + workflow `wf_bfa87d21-a0b`.

---

## 3. The design — three coordinated capabilities

One organ seen from three sides: a session-scoped, object-anchored view of conversation that is consulted
every turn and reaches all the way back. The reach primitive across E1/E2 is one call —
`retrieveScored(query, { kinds, weights:{ recency:0, relevance:3, importance:2 }, qv })` — over the
non-age-capped `knowledge` pool (`getAllKnowledgeEmbeddings`, `memory.js:442`), with `recency:0` making it
literally age-neutral (§2). `retrieveScored` already accepts both overrides (`memory.js:441`).

### E1 — Age-neutral episodic recall + staleness-flag-and-offer  *(defects D2 reach, D4)*

**E1a — Reach (measured, corrected).** The target queries must fire the deep path, and the path must reach
June today.
- **Detector, not `isRecallQuery`.** Add an episodic-reference detector (regex fast-path + bounded-model
  tie-break): "remember when", "when did X first / first come up", "that was a while ago", "earlier / a
  few months ago", "what did we land on about X". `isRecallQuery`'s `RECALL_RE` (`intent.js:169`) misses
  these, and the interceptor early-returns at `main.js:7607` before the L3 site — so E1 fires from the
  detector, inside the interceptor.
- **Reach path v1 = scan-all-embedded raw turns.** `retrieveTurns` scores pure cosine with a min-sim gate
  (`memory.js:305`) and is age-neutral *within its candidate set*; the defect is only the `scan=400`
  recency truncation (`db.js:1216` `ORDER BY id DESC LIMIT ?`). On an episodic-reference turn, scan **all
  embedded eligible turns** (≈6,200 today, capped at a ceiling e.g. 12,000), not a fixed 4,000 — so June is
  reached. Cost is ~0.8s at 6,200 (dominated by per-row `JSON.parse` of the embedding, `memory.js:303`),
  acceptable on an occasional recall-gated turn; note it grows O(eligible turns).
- **Prerequisite: turn-embedding backfill.** Old months are under-embedded (Jun 50% / Jul 37%); an
  unembedded turn is invisible at any scan depth. Run `backfillTurnEmbeddings` (`memory.js:313`) to
  completion offline and verify coverage before claiming reach.
- **Scaling slice (later, not v1):** promote conversation windows into the `knowledge` pool as an embedded
  `conversation_episode` kind (mirroring `meeting_episode`, `gmeet.js:761`) so recall moves off the O(N)
  turn scan onto `retrieveScored`. NB the existing `documents.source='conversation'` promotion is NOT
  reachable by `retrieveScored` and only spans 2026-07-22+ — it does not serve this today.

**E1b — Staleness-flag-and-offer.** Fire on a *successful* recall of an old item, inside the interceptor.
- **Thread the timestamp.** Add `ts` to `getEmbeddedTurns`' SELECT (`db.js:1216`) and to `retrieveTurns`'
  returned shape (`memory.js:308`) so age is computable. (Today they carry no `ts`.)
- **Dedicated branch, not the L3 hedge.** `metacognition.buildDirective` returns null on rich grounding and
  emits an admit-the-gap hedge on none (`metacognition.js:127`) — the inverse trigger. Add a separate
  staleness directive: on a recalled item with `ageDays ≥ threshold` (open Q1) *and* factual content, inject
  "you recalled this from <date, ~N months ago>; say what you remember, note it is from then, and offer to
  refresh before building on it." Fold it into the interceptor's `resultText` (~`main.js:7602`).
- **No nag.** Track refresh-offered item/topic ids per session; at most one offer per topic per session.
- Fail-open: any error never suppresses the answer.

**Acceptance:** "Remember when we talked about X?" (X months old) → recalls the content, dates it ~N months
ago, offers to refresh — proven on `:8767` with the literal probe strings.

### E2 — Autobiographical self-recall  *(defect D3)* — E2a+E2b land together

**E2a — Recognize self-reference.** "What did *you* do / work on / look at / think about (today / a while
back)…" is about Zoe, not an entity lookup. Add a pre-gate (regex fast-path + bounded-model tie-break) for
first-person-about-Zoe ("you/your/yourself" + an activity verb, no other named entity) that sets a flag in
the flags region (~`main.js:7949`) and pre-empts the ambiguous-entity ASK (`main.js:8177`) which currently
ships "four contacts named You". Note `isActivityQuestion` (`activity.js:23`) is present-tense only, so the
new gate must cover past tense.

**E2b — Reach her actions (reuse, don't rebuild).** `memory.logAction` already writes `kind:'trajectory'`
knowledge, embedded at write, retrieved age-neutrally by `retrieveScored`, surfaced as the `[did]` tag
(`active_recall.js:283`). Probed dead: 11 trajectory rows, none after 2026-06-25 — `logAction` is wired at
only two email-send sites (`main.js:12061/18650`). The fix is **call-site coverage**, not a new organ:
- Widen `logAction` to the significant-action sites (deliverable shipped, research/report completed;
  meetings already covered by `gmeet` storeMeeting).
- Route the E2a self-reference turn to: recent-window readers (`getRecentAgentEvents`, `db.js:2258`) for
  "earlier today", and `retrieveScored({ kinds:['trajectory'], weights:{recency:0,…} })` for "a while back".
- Drop the net-new activity_episode writer and the daily consolidator from v1 (later optional enhancement).
- Bound: her own actions/thoughts answer "what did I do", never self-corroborate a world-fact (RFC-2308).

**Acceptance:** "What did you work on earlier today?" → a grounded walk-through from `agent_events`/
deliverables (no "four contacts named You"). "What did you do a few weeks back on Y?" → reaches the old
trajectory episode.

### E3 — Conversational topic tracking (extend `lib/salience.js`)  *(defects D1, D2)*

Do **not** build a parallel topic-stack. `lib/salience.js` already keeps a per-session, most-recent-first
frame of resolved object coordinates (`fold`/`dereference`/`peek`, CAP=8, 30-min idle-expiry). Extend it.

**E3a — Fold early + track foreground/suspended.** The current fold is late (from the gated cloud manifest,
`main.js:10342`, after package assembly at `10084`). Add an **always-on, in-process** fold sited BEFORE the
interceptor early-return and BEFORE package assembly, off the objects `active_recall.recall` already
resolves (~`main.js:8000`) plus the `userQv` embedding already computed (`main.js:8718`). Add to each entry:
`state: foreground|suspended` and `firstTurnId`. A turn whose objects match the foreground entry continues
it; a turn with no/weak overlap opens a new foreground and moves the prior to *suspended*. Match by object/
concept overlap + embedding cosine — NOT `matchThreadToTopic` (a 2-token `open_threads` string matcher,
guardrail-3-forbidden). This registers a bare pivot (D1).

**E3b — Resume + suppress the bleed.** On a return turn ("circle back to the first thing", "what we were
saying"), resolve against *suspended* entries, using a structural first/earlier/last resolver keyed on
`firstTurnId` order (not raw salience), and re-foreground the match. On a detected pivot or return, the
turn assembly must **suppress or rebuild** the tainted context — gate `relevantPastTurns` (`main.js:8723`)
to the re-foregrounded topic and rebuild `convoStateBlock` (`main.js:7706`) around it — not merely add a
competing profile. Without the suppression the energy/sycophancy context still wins (this is the actual
cause of D1/D2). State the suppression explicitly in code.

**E3c — Inject a budgeted profile.** Inject foreground + relevant suspended entries as a compact profile:
label + top-K anchor surface names + one-line summary, **capped at a fixed char budget, no anchor
dereference**, as an explicitly budgeted + trimmable package section. O(topics) is then enforced by
construction, not asserted.

**Acceptance:** the drill replayed — T2 pivots cleanly (no energy bleed), T4 "first thing" resolves to
energy, a return after several pivots resumes the right topic with its specifics intact; package size does
not regress.

---

## 4. Sequencing — the long run

Each slice: implement → adversarial self-review (an agent that tries to break it) → offline gate green →
reboot → live-verify the acceptance probe on `:8767`. One commit per slice. All new behavior flag-gated
(default off until its acceptance probe passes), reusing the `convo.encounters`-style meta-flag pattern.

| Order | Slice | Why here | Risk |
|---|---|---|---|
| 0 | **Turn-embedding backfill** (run `backfillTurnEmbeddings` to completion; verify per-month coverage) | Prerequisite for E1a reach; data-only, no code | Low |
| 1 | **E1a** episodic-reference detector + scan-all-embedded reach | Biggest single win; unblocks every "months ago" probe | Med (detector precision; scan cost) |
| 2 | **E1b** ts thread-through + staleness-offer (dedup) | Completes the exact "remember when… refresh?" behavior | Low-Med (schema touch on read path) |
| 3 | **E2** self-reference gate + `logAction` coverage (a+b together) | Stops "four contacts named You"; gives action reach | Med (gate ordering vs entity resolver) |
| 4 | **E3a** early salience fold + foreground/suspended | Registers bare pivots; structural core | Med (every-turn in-process cost) |
| 5 | **E3b/c** resume + suppression + budgeted profile | Anaphoric return; removes the bleed; bounded context | Med-High (suppression correctness; budget) |

E1 and E2 are independent and land first; E3 is heavier and gated on the earlier wins.

---

## 5. Guardrails (invariants the build must not violate)

1. **Fact-viability recency stays.** `retrieveScored`'s default weights (`memory.js:441`) are untouched;
   the episodic path passes an *explicit* `recency:0` override, so §2 holds literally — fact ranking is not
   rebalanced. (§2, R7)
2. **Context does not grow — enforced, not asserted.** E3c injects a fixed-char-budget profile (no anchor
   dereference) as a trimmable package section; measure `[package] …c (fit …%)` before/after — a regression
   fails the slice. (R10)
3. **No thread over-mint.** Topic tracking extends session-scoped `salience.js`; it never writes
   `open_threads`. Chat topics never mint research-worklist rows.
4. **Her own words never self-corroborate.** Activity/thought recall answers "what did I do", never vouches
   for a world-fact (RFC-2308 absence guard; blueprint §6.3).
5. **Anti-fab still governs.** If recall can't reach it, she says so (the T7 meeting answer is the model),
   never fabricates a remembered conversation. The existing anti-fab gate stays in the path.
6. **Detector-gated cost.** The deep scan (E1a) and the staleness branch (E1b) run only on
   episodic-reference turns; the early salience fold (E3a) is in-process (no cloud call). Ordinary-turn
   latency is unchanged.

---

## 6. Open questions

1. **Staleness threshold + content test (E1b).** What age = "old" (45 days? a per-domain half-life?), and
   what marks an item as carrying refreshable *fact* vs chatter? Set from data.
2. **Significance filter for `logAction` coverage (E2b).** Which action sites deserve a trajectory row?
   Start with deliverable-shipped + research/report-completed; measure noise before widening.
3. **Topic-stack depth + eviction (E3).** salience CAP=8 today; how many *suspended* topics to keep, and
   does a suspended topic expire with the 30-min idle rule or persist? Start session-scoped.
4. **Structural first/earlier/last resolver (E3b).** How much anaphora is structural (turn order) vs
   semantic, and where a bounded model tie-breaks.
5. **D4 first-vs-recent contrast.** E1b dates the top recalled item; a true "when did it first come up vs
   most recent" needs earliest+latest retrieval (min/max turn id over the topic's matched turns). Add to
   E1b if the single-item date-stamp proves insufficient at acceptance. (R8)
