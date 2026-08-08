# Program Census — Phase 2 Results (started 2026-08-08)

Grading law: every scenario is driven through the inside access port (127.0.0.1:8767, the REAL
runChatTurn pipeline) and graded on the USER SURFACE ONLY — the reply text as Lucas would read it,
plus the artifact read back directly from its destination (canvas mirror db, notes files, DB rows).
Log lines are used to identify MECHANISMS of failure, never as evidence of success.

Verdicts: **WORKS** (surface evidence attached) / **BROKEN** (mechanism named) /
**UNREACHABLE** (no door for a natural order) / **NEEDS-LIVE-CONTEXT** / **DEFERRED-QUOTA**
(untestable until the 08-09 pool reset — directed lanes stop at 97%, pool was at 98% during runs).

The capability inventory (45 rows, groups A–H) is the companion file: `capability_census.md`
(session scratchpad copy; canonical inventory to be committed alongside as INVENTORY.md).

---

## Boot-chain finding (pre-scenario, fresh44 → fresh45)

**FINDING — silent canvas-replay skip when the engine is late at boot.** fresh44's engine spawn
"never became healthy" (boot_fresh44.log:71), so the `.then(attached => ...)` chain at main.js:1386-1390
returned early and `replayCanvasFromStore()` never ran — and it only runs ONCE, at boot. Echo
recovered minutes later, but the whole fresh44 session ran with an unreplayed canvas: the durable
mirror held the complete parish deliverable, the live surface never showed it. Both failure paths
are silent (`if (!attached) return;` and an empty `catch {}`). Cure for the fix list: replay must
re-fire when the engine becomes healthy after a failed boot attach (or on every successful attach,
idempotently), and a replay skip must LOG.
Verification of the cure-by-reboot: fresh45 printed `[canvas] replayed 60 document(s) / 298 block(s)`,
zero per-tab failures, and the parish tab was read back from the mirror: 5 blocks, 69,657 chars,
title "Louisiana Parishes — Government & Leadership".

---

## Scenario runs

### B4 — product pull-up ("Pull up that Louisiana parish leadership list we made")
**Verdict: BROKEN (mechanism works, ranking + voice defects).** Run 2026-08-08 ~15:0x ET, tookMs 72,540.
- What worked: artifact-router hit `intent=pullup`; product_ledger retrieved a real held product and
  RE-PRESENTED it (no regeneration, no research spin-up); canvas write landed durably
  (`promise-pullup-report-parish-leadership-of-louisiana`, 12,128 bytes); reply carried honest
  provenance ("saved at 9:01 AM ET") and offered alternates.
- Defect 1 — WRONG PRODUCT: it pulled the stale 9:01 AM gap-analysis report ("only about a third
  have elected leadership"), not the complete 64-parish deliverable made at 1:57 PM
  (notes/louisiana-parishes-leadership.md, 813 officials). Mechanism: lib/product_ledger.searchProducts
  scores title/body token hits with time decay; the stale report matches the same tokens, also exists
  as a doc_store row, and its head contains "list". There is NO supersession concept — a finished
  product cannot outrank its own earlier draft. (Work-contract spine feature: artifact registry with
  supersession/done-state.)
- Defect 2 — TWO VOICES: the reply opened with a contacts-route non-sequitur + a medium question
  ("24 organizations on file... Canvas or chat?") BEFORE the pull-up voice. The contacts-intent net
  and the pull-up door both spoke in one reply — the one-voice defect from the 08-08 audit, live again.

### A4 — contacts query, count shape ("How many contacts do we hold with a phone number in Louisiana?")
**Verdict: BROKEN (exact repeat of Lucas's graded fail).** Run 2026-08-08, tookMs 35,881.
- Reply: "1,044 Louisiana contacts, 622 with emails" + geo-gap offer. NEVER answers the asked metric
  (phone-number count). Mechanism: the contacts-intent schema has no `phone` filter and no
  count-only mode — parse came back `type=- grade=- state=LA sectors=-`, so the door can only
  answer the questions its schema can represent. (Audit fix-list item "contacts phone/countOnly
  schema" confirmed still open.)
- Secondary finding: reply claims "I put the list on your Canvas" and the contacts table emit DID
  fire (200/1,044 rows), but the port's `canvasWrites` (durable mirror) is EMPTY — contacts tables
  land renderer-only, are invisible to boot replay, and vanish on restart.

### A6 — canvas awareness ("What documents are sitting on your canvas right now?")
**Verdict: BROKEN (net miss → honest blindness).** Run 2026-08-08, tookMs 38,102.
- With 60 tabs live on the canvas, the reply was "I couldn't pin down documents currently on the
  canvas." Mechanism: turn-router sent the phrasing to `route=answer` (factual/self, conf 0.7);
  the deterministic canvas-awareness surface (main.js:6975 / lib/canvas_awareness.js) sits behind a
  phrasing net that did not match "sitting on your canvas". Honest miss, not confabulation — but on
  the user surface Zoe is blind to her own board. Detectors-vs-comprehension cure shape applies
  (regex fast-path + bounded model classifier).

### A1 — held recall ("Who is the parish president of Jefferson Parish?")
**Verdict: WORKS (surface), inefficient substrate.** Run 2026-08-08, tookMs 75,462.
- Reply exactly right: "Cynthia Lee Sheng is the parish president of Jefferson Parish." Matches the
  deliverable's ground truth line.
- Mechanism note: the answer came from a LIVE WEB EXCAVATE (Google → jeffparish.gov "FOUND"), not
  from the held deliverable on her own canvas/notes. Held-source-homecoming disease: correct answer,
  but 75s + web tokens for a fact she holds; would fail offline.

### A5 — held-roster ask ("Give me the parish contact list")
**Verdict: BROKEN — the flagship failure class, live.** Run 2026-08-08, tookMs 43,660.
- The complete deliverable exists (canvas tab + notes, 813 officials). The reply instead: (1)
  "pivoting to deep research on the parish contact list... Estimate: 6–8 hours" — RESTARTED research
  on finished work; (2) "26 entries... a partial set, not a clean list. Want me to... build a proper
  contact sheet?" — offered to build what is already built; (3) two voices in one reply.
- Mechanisms: held_roster net missed the phrasing (deliverable title "Louisiana Parishes —
  Government & Leadership" carries no "contact" token; title-match too literal); the correction net
  hijacked the order into a facet-pivot on focus #3747 ("[correction] applied to #3747: facet →
  'parish contact list'") — a STATE MUTATION from a retrieval ask; product ledger never consulted
  on this route. This is the exact "she's researching all over again" complaint of 08-08.

### C2 — stop control ("Stop the parish contact research - that list is already finished...")
**Verdict: WORKS (stop itself) + a false-positive rider.** Run 2026-08-08, tookMs 46,149.
- Stop landed: "[focus] directed task #3747 stopped by user"; reply honest, names where partial
  work lives. The wasteful A5 pivot was killed.
- Rider defect: the phrase "it is on your canvas" tripped the canvas-cmd net into an unordered
  CREATE attempt. The narration-reject contract correctly refused it (B1's reject path CONFIRMED
  live: "create output REJECTED (output opens as narration)"), but the reply then carried a second
  voice about a failed create Lucas never ordered.

### A2 — status ("status report")
**Verdict: MIXED — status route works; phantom artifact rider lands on canvas.** Run 2026-08-08, tookMs 23,307.
- The status route fired correctly (conf 0.85) and reported honestly on the active track ("nothing
  completed yet — entirely greenfield") plus a real civic-store event.
- DEFECT: the artifact-router ALSO read "status report" as a report ORDER ("intent=report
  subject='status'") and composed from 8 arbitrary held docs. Confirmed landed as a durable canvas
  tab: `promise-report-status` / "Report — status" (left in place as evidence). Lucas's most
  habitual two-word ask spawns surface pollution every time.

---

## Cross-cutting verdict after batch 1

Nearly every defect above reduces to three shared mechanisms — the same three the 08-08 audit named:
1. **Phrasing-net misroutes/misfires** (A5 restart, A6 blindness, C2 rider, A2 phantom report) —
   detectors-vs-comprehension; the cure shape (regex fast-path + bounded model classifier) is built
   for canvas-edit only and must be retrofitted across ALL door nets.
2. **No one-voice discipline** — every multi-door turn stacked two voices into one reply (B4, A5,
   C2, A2). The one-voice merge before the reply write is the single highest-leverage fix.
3. **Finished products are invisible** — no supersession in the ledger (B4), held deliverable not
   consulted (A5, A1's web detour). The work-contract spine's artifact registry is the cure.

## Open scenario queue (Phase 2 remainder)

- Conversation-tier (runnable now, 120s port cooldown between turns): A1 recall, A2 status, A5
  held-roster, A8 correction, B1 canvas create, B2 canvas edit (AFTER the corrupted working-doc
  repair — do not edit-test against the flagship deliverable), B3 report, B5 package, B6 drop-ingest
  (live-ctx), G3 watch, G5 record, G6 open-web, H1 draw.
- DEFERRED-QUOTA until the 08-09 ~12:37 UTC reset: C1 directed research, C2 wrap/expand, C3
  roster-fill, C4 deep dive, C5 swarm, C6 social enrich, D1 renders (operator-path), F-lane
  observation windows.
- NEEDS-LIVE-CONTEXT: G1 Meet, G2 Teams (next real meeting), G4 listen, A7 paste, A9 vision.
- UNREACHABLE-suspect (verify): E2 scenario chat door ("run the Iran scenario" typed in chat has no
  deterministic route found in code); H4 QR family (no Zoe-side door found in main.js).
