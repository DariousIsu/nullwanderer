# Substantiation & Grading — Implementation Plan (per-file, 6 slices)

> Companion to `docs/SUBSTANTIATION_GRADING_DESIGN.md` (the north-star + the 6 LOCKED decisions in §4).
> This is the concrete build map, grounded in a full code trace of the live paths (2026-07-15).
> Read the "Reframes" first — the trace changed what several fixes actually mean.
>
> **STATUS 2026-07-16: ALL 6 SLICES BUILT + COMMITTED, gate 186/186 green.** Slice 1 `f9d7ae6`,
> Slice 2 `9c355ed`, Slice 3 `143538f`, Slice 4 `66d8dec`, Slice 5 `8200d28`, Slice 6 `a609cea`.
> Slice 3 was implemented SURGICAL/ADDITIVE (see its section). Everything is REBOOT-GATED and
> auto-ingest is still OFF (`fc1c773`) — one reboot lights all six + `fa8e8a6` + `9cf57dd`. Slices
> 2/4/5/6 have live `main.js` wiring verified only post-reboot. The existing 72.8k held rows need a
> separate backfill (Slice 2 is forward-facing).

## 0. Reframes from the code trace (READ FIRST)

- **R1 — the held pile is a write-only ledger.** `kg_observations` is written by `curation_store.record`
  (from `doc_decompose`, `graph_walk`, `puller_walk`) but **nothing live reads `status='held'`**. The
  "hourly upgrade-pass / the lake" is comment-only; the reader plumbing (`curation_store.heldFor`,
  `db.listKgObservations({status:'held'})`) is called ONLY by smoke tests. `doc_decompose` proposes RESOLVED
  facts straight to Echo via `dispatch(propose_entity/propose_relation)`; UNRESOLVED endpoints are only
  logged `held` and dropped. **So "un-hold the 72.8k" = mint the unresolved endpoint at decompose time so
  the `propose_relation` fires** — not drain a queue. (`doc_decompose.js:450`, `:519-522`.)
- **R2 — `graph_entities` has NO lifecycle column** (no status/deleted/valid_to; only created_at/updated_at).
  `substantiation_state` + `frame` + archive are NEW columns. `kg_observations.status` is free TEXT (no CHECK,
  add values freely) BUT the table is INSERT-ONLY (`INSERT OR IGNORE`, no update fn) — a status flip needs a
  new writer. `graph_relations` retires via `valid_to` (row kept), never `deleted=1` locally.
- **R3 — news bypasses `doc_decompose` entirely.** `news_lane.promoteStory` mints only the event hub
  (`propose_entity type=event`) then attempts `LINKED_TO` edges to bare proper-noun principals that don't
  exist as nodes yet (their creation is deferred to a later `extract_entities_from_doc` rail that never
  promotes them public). Every edge → `rejected` → 86% isolation. Fix = route the news story doc through
  `decomposeLanding` (mints entities+relations+resolution together), framed `real`/`source-vouched`.
- **R4 — the real 0.90 promote-floor lives in `promote_gate.classify`**, used LIVE by `ingest_lane.js:34`
  (F2 auto-promote) + `research_lane.js:42/58` + `main.js:774` (research restamp). It is ABSENT from the
  `doc_decompose→kg_observations` sink (uses `curation_gate`) and from `promoteLocalEdgesUp` (Echo adjudicates,
  no local floor — `db.graphListPromotableUp` has no confidence threshold). So the inversion (decision #1)
  reshapes `promote_gate.classify` + the `curation_gate` FACT_FLOOR hold behavior — not `promoteLocalEdgesUp`.

## 1. The keystone: substantiation_state + frame

Every node/observation gains two fields:
- `substantiation_state` ∈ `{source-vouched, identity-confirmed, unsubstantiated}` (design §4.2)
- `frame` ∈ `real` / `fiction:<work>` / `domain:<x>` (design §4.5)

All five behavioral slices are rules that READ these two fields. Build them first (Slice 1), then the rest
are small.

## Slice 1 — Substrate + classifier (NO behavior change; migration + record-only)

**New file `lib/substantiation.js`** (pure, no I/O, exhaustively smoke-testable):
- `SUBSTANTIATION_STATES`, `FRAMES`, `NAMED_FLOOD_FRAMES = ['domain:medical','domain:legal-directory', …]`.
- `classifySubstantiation({resolved, sources, feed, selfVouching}) → state`:
  - `resolved === true` (entity matched an existing Echo/wiki node) → `identity-confirmed`.
  - else a non-junk citing source present, OR `selfVouching` feed (news/doc/fiction) → `source-vouched`.
  - else → `unsubstantiated`.
- `classifyFrame({url, feed, text, activeDomain}) → frame` (Slice-1 default `real`; fiction/domain detection
  is a hook Slice 5 makes load-bearing). Reuses `curation_gate.isJunkSource` for host checks.
- `isNamedFloodFrame(frame)`.

**Schema — append to the `MIGRATIONS` array in `lib/db.js`** (end, after :543; idempotent ALTER pattern that
:542-543 already use for `promoted_up`):
- `ALTER TABLE kg_observations ADD COLUMN substantiation_state TEXT`
- `ALTER TABLE kg_observations ADD COLUMN frame TEXT`
- `ALTER TABLE graph_entities  ADD COLUMN substantiation_state TEXT`
- `ALTER TABLE graph_entities  ADD COLUMN frame TEXT`

**Record-only wiring (NO gating):**
- `db.recordKgObservation` (`db.js:1776`) + `curation_store.normalizeObservation`/`record`
  (`curation_store.js:36-65`): accept + persist `substantiation_state` + `frame` (new INSERT columns).
- `doc_decompose._observe` call sites (`:450,456,462,496,517,521`): compute state+frame via
  `lib/substantiation` and attach to the `o` object. Pure pass-through — nothing reads them yet.

**Proof:** new `scripts/smoke_substantiation.js` (classifier truth table + db round-trip) + `npm test` green.
No reboot required to be safe; columns populate on subsequent ingests after the next restart.

## Slice 2 — Endpoint-minting (decision #3) — drains the held pile, un-isolates

**File `lib/doc_decompose.js`:**
- `:519-522` (relation, endpoint unresolved → held): MINT the unresolved endpoint as an `unsubstantiated`
  node (`_proposeEntity` tagged state=unsubstantiated), record it, then fall through to `_proposeRelation`
  so the edge LANDS. New helper `_mintUnsubstantiated(dispatch, name, type, url)`.
- `:450` (REFERENCE_TYPES office/committee/body → held): mint as `unsubstantiated` (preserves the anti-QID-dup
  intent — it's marked unsubstantiated, stays short-term, and Slice 4/6 resolve-or-fade it, so it can't
  pollute the canonical office space) instead of a bare hold.
- `:494-497` (FEC mis-resolution guard): keep HOLD (genuine wrong-resolution ≠ unresolved) — but mint the
  ORIGINAL-named endpoint unsubstantiated rather than the mis-resolved FEC one.

**Proof:** extend `scripts/smoke_doc_decompose*` — unresolved endpoint → mint + edge lands (not held).
Behavioral → reboot-gated.

## Slice 3 — Promotion inversion + bottom floor (decision #1)

**File `lib/promote_gate.js` `classify(p)`:** replace the confidence-band decision with state-based:
- derive/read `substantiation_state` from `p` (or via `lib/substantiation` on `p` metadata).
- `unsubstantiated` → `hold` (stays short-term).
- substantiated + junk source (`curation_gate.isJunkSource`) → `hold` (the thin BOTTOM FLOOR, decision #1).
- else → `promote`; keep `confidence`/grade in the output as an EXPLORE-PRIORITY tag (low grade = higher
  priority, never rejection). `domain` stays a tag, never a veto (unchanged).
- `PROMOTE_FLOOR`/`REVIEW_FLOOR` become priority thresholds, not gates.

Affects `ingest_lane` (F2) + `research_lane` (F3) live. **Do AFTER Slice 1** so state is on proposals.
Keeps official-doc-weight (9cf57dd) consistent (.gov=A → top priority). **Proof:** rewrite
`scripts/smoke_promote_gate.js` for state decisions. Reboot-gated. Biggest behavioral change.

## Slice 4 — Async substantiation lane (decision #4)

**New file `lib/substantiate_lane.js`** (deps injected → offline-smoke-testable):
- Select `unsubstantiated` nodes (`graph_entities WHERE substantiation_state='unsubstantiated'`), lowest-grade
  / oldest first (explore-priority).
- Per node: INTERNAL validation FIRST — Echo `search_knowledge` / `kg_neighborhood` / `mediawiki_search`
  (the currently-UNUSED first tier). Identified → flip `identity-confirmed` + promote. Else WEB `web_search`
  → found → `source-vouched` + promote. Else leave for fade.
- Bounded per tick. Wire into `maybeRunCuration` (`main.js:489`, the 20h nightly pass) beside the other
  passes, OR the monologue idle lane. **Proof:** smoke with mocked resolver/web deps. Reboot-gated.

## Slice 5 — Frame-tag + named-flood hard wall (decision #5)

**Files `lib/substantiation.js` (frame) + intake sites `main.js:2301-2319` (dl-ingest) & `:7141-7157`
(`_docLeashOk`):**
- Assign `frame` at intake (substrate from Slice 1); Slice 5 makes it DRIVE behavior.
- HARD wall: if `isNamedFloodFrame(frame)` AND frame ∉ operator's active domain → HARD veto (don't even land
  searchable) — stronger than today's soft quarantine (which lands searchable, skips decompose).
- SOFT frame: `fiction:<work>` + generic off-domain → quarantine-to-frame + fast fade (Slice 6), never civic
  bleed. The existing leash (`focus.domainLeashTokens`, `focus.js:338`) already does soft quarantine; Slice 5
  adds the frame dimension + the named hard-veto tier. **Proof:** smoke — medical doc + no medical focus →
  hard veto; fiction → framed+quarantined; on-domain → passes. Reboot-gated.

## Slice 6 — TTL → archive fade (decision #6)

**Files `lib/db.js` + new `lib/fade.js` + `main.js`:**
- Migration: `ALTER TABLE graph_entities ADD COLUMN archived_at INTEGER`. Reuse `kg_observations.status='archived'`.
- New writers: `db.setKgObservationStatus(id, status)` (table is insert-only today) + `db.archiveGraphEntity(id, ts)`.
- Exclude archived from live reads: add `AND archived_at IS NULL` to `graphNeighbors`/`graphRelationsAmong`/
  entity lookups.
- `lib/fade.js`: pure `plan(nodes, {ttlMs, now})` → archive candidates = `unsubstantiated` AND
  `age(created_at) > TTL` AND never proven. Mirror `lib/retention.js` shape (list → pure plan → apply).
- Wire `fadePass()` into `maybeRunCuration` beside `retentionPass` (`main.js:614`); ARCHIVE, never DELETE.
  Age source: `graph_entities.created_at` / `kg_observations.captured_at`. **Proof:** smoke — unsubstantiated
  past TTL → archived; substantiated → kept; archived excluded from recall. Reboot-gated.

## Sequencing & reboot bundling

1. **Slice 1** now — safe, no behavior change; build+test+commit. (Ships the migration + classifier.)
2. **Slices 2→6** are behavioral + reboot-gated. Natural bundle: after Slice 1 (+ maybe Slice 2) land, do ONE
   reboot that also lights the already-committed `fa8e8a6` (leash) + `9cf57dd` (official-doc-weight).
3. Per [[request-reboots]]: build+test+commit each slice, then ASK before the reboot (it interrupts the live
   companion). Per [[let-it-in-mark-and-churn]] + "GO SLOW": one slice at a time, prove each.

Order rationale: Slice 1 unblocks all others (state must exist first). Slice 2 is highest immediate payoff
(drains held + un-isolates). Slice 3 is the biggest behavioral flip (needs state from 1). Slice 4 gives the
lane that proves/upgrades. Slices 5-6 close the contamination + fade loop. Slice 2's news-decompose routing
(R3) can fold in with Slice 2 or stand alone.
