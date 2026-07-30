# Honest Shortcomings Inventory — 2026-07-30

Lucas's ask: *"produce an honest inventory of the shortcomings of the program you're writing and
propose solutions that you have existing stable and tested code to solve."*

Rules of this document: every shortcoming carries its **evidence** (measured, not felt), and every
proposed solution names **code that already exists, passes the gate, and was proven** — the fix is
wiring, scheduling, or extending a proven pattern, not a new invention. Where no existing code
solves it, that is said plainly. Ordered by blast radius.

---

## 1. ~38 model call sites still bypass the window discipline

**Shortcoming:** The Round-3 census (AUDIT 2026-07-22) found ~38 cloud call sites carrying
hardcoded `num_ctx` (8192/16384/32768) against models with 131k–524k windows, vs ~8 sites routed
through `lib/cloud_window`. Today's inverse case: the LOCAL lane overflowed its honest 8192 —
every chat reply from 10:48 stored `truncated=1` (one say was 29 chars), a dozen daemon slots
pinned at `n_tokens=8191`, and one caller shipped a **72,048-token prompt** (94% silently
discarded).

**Existing stable code:** `lib/cloud_window` (gated), `lib/package.inputBudgetChars` (gated),
`lib/context.fitToWindow` (built today, 18 pins), and the new `streamChat` `[window]` warn that
logs size + a 3-frame caller stack for every oversized prompt.

**The fix that remains:** retrofit the census's biggest doors (operator loop `num_ctx 16384`,
`condenseComplete` callers with sub-reasoning-floor `numPredict`, the ~25 extraction sites at
8192) through `cloud_window`, exactly as streamCloud already is. The `[window]` warn now makes
every offender name itself in one grep — the hunt is no longer forensic.

## 2. Identity gates exist but are not consulted at every write door

**Shortcoming:** The recurring disease: *the capability exists, the hot path doesn't call it.*
`entity_match` correctly REFUSES Brummund→Bourdeaux and Brege→Frisch, yet the meeting resolver
substituted them anyway (fixed V1–V3 at that door). Today the GROW lane repeated the shape: the
actor's family grafted onto a politician's node at grade B (fixed — `personIdentityGuard`,
127 pins). The fast-ingest ANN resolver is **built and not wired** into the news/meeting lanes.

**Existing stable code:** `entity_match` (veto semantics proven), `lib/resolution_gate`,
`personIdentityGuard`/`disambiguationClaim` (today, pinned), fast-ingest ANN resolver (built,
gated, unwired).

**The fix that remains:** wire the ANN resolver into news/meeting ingest; audit remaining write
doors (`propose_relation` callers) for gate consultation. The guard pattern is a template now —
port, don't invent.

## 3. The doc→graph extraction chain strangles at the promotion gate

**Shortcoming:** Measured on the Rainey tenant: **8,508 documents → 146k entity proposals → 14
entities / 5 facts promoted**. `entity_facts` — the surface built for fact+citation enrichment —
has 5 rows. The single-source .gov cap (B=0.88 < 0.90 floor) holds official records forever;
document AUTHORITY is weighted nowhere.

**Existing stable code:** the corroboration admission door (`_independent_sources`, Echo-side,
6 tests) built this arc admits ≥2-independent-host entities past the floor; provenance now
survives promotion (`source_set` rides `entity_log` on promote AND merge, 4 tests);
`promote_tenant_proposals` / `auto_promote_grounded` exist as callable drains.

**The fix that remains:** schedule the drain over the tenant backlog with the corroboration door
on — the door was built and proven this week but has only processed live trickle, never the
146k backlog. Authority weighting (.gov/.us official-record classes) is a scoring change inside
the existing grader, not a new lane.

## 4. Research citations bind only what a pass freshly opened

**Shortcoming:** The claim→page chain is proven end-to-end (Data Center Coalition bound 4 real
URLs) — but markers stamp only pages opened THIS pass. An echo-first pass (answering from what
she already holds) marks 0 pages, so its section honestly falls back to "(source: gathered
notes)". Marker survival in big-body passes was luck until today's tail-cap fix (97ca8eb).

**Existing stable code:** Echo's `get_sources_for` / `record_web_source` / `cite_pack` already
map held knowledge to its ORIGINAL documents; `sources.renderRunSources` (gated) builds the
dossier trail; held-source homecoming (extract-and-inject) is proven in the inquiry lane.

**The fix that remains:** when a pass answers from Echo instead of the web, stamp the recalled
facts' original doc/source refs into the notes the same way `[pages read this pass]` stamps
URLs. Same marker grammar, different source column — the synthesis prompt already knows how to
bind whatever the markers carry.

## 5. Short-term memory is invisible to half the read surfaces

**Shortcoming:** Quarantine is a TRUST boundary, not a visibility one — but the read-through
(f74f64b) landed on `search_entities`/`get_entity` ONLY; `knowledge`/`kg_*` surfaces are still
blind to short-term. Separately, 643 docs / 2,046 emails sit trapped in short-term because
`gatherHeldContacts` reads only Puller+CRM.

**Existing stable code:** the read-through pattern itself — proven at two surfaces, gate-green;
the short-term stores and their query functions all exist.

**The fix that remains:** extend the identical read-through to the knowledge/kg surfaces;
widen `gatherHeldContacts`' pool query. Both are ports of proven shapes onto proven stores.

## 6. Autonomy re-attempts structurally blocked work

**Shortcoming:** The rehearse lane picked the same need ("we need a systematic method to lo…")
4+ times today, each sitting refusing at the same missing-sandbox wall until "gave up honestly."
The refusal is honest; the CHOOSER has no memory of the wall. Same family: ~50 tombstone-dead
carve passes idle since 07-24 with no retire/rebuild decision surface.

**Existing stable code:** the leash state ladder (blocked/held rung semantics, gated);
`lib/approvals.js` (built this arc) — the one surface where things awaiting Lucas appear.

**The fix that remains:** a refusal that names a missing capability marks the need
`blocked-by-capability` (ladder semantics) and rides the approvals manifest so Lucas can
provision or kill it. Wiring between two existing organs.

## 7. Replies can be correct and still not reach Lucas

**Shortcoming:** The 150s chat watchdog stamps a message stalled; the real reply landed at
+3m57s into a message the UI had abandoned (the renderer-latch defect compounds this). Build 1
(fit + explicit reserve) attacks the biggest latency source — the cloud-flap → local-fallback →
window-straddle chain — but the UI race itself is unfixed.

**Existing stable code:** partial. The fit lands the latency fix; `presence.notify` can surface
a late reply as a toast. **No existing tested code closes the renderer latch itself — that is
new UI work**, and this line is the honest admission of it. First measurement after the next
reboot: do stall stamps stop once replies fit their window?

## 8. 3,211 backlog documents unread because the sweep keys on arrival path

**Shortcoming:** The decompose sweep selects by HOW a doc arrived, not what it is — 3,211 docs
(incl. research-landed ones) never enter extraction.

**Existing stable code:** the decompose sweep itself (caps removed Round 2, cheapest-first +
daily budget, gated) — the machinery is healthy; the POOL QUERY is wrong.

**The fix that remains:** re-key the sweep pool to "not yet decomposed" regardless of arrival
lane. A query change on a proven sweep.

## 9. The program cannot research an organization

**Shortcoming:** All 271,334 Puller targets are person-kind; an org ask burns tokens through a
person-shaped pipeline (Lucas flagged 07-29: it also BLOCKS real research).

**Existing stable code:** partial — the Rainey org_research lane proved org-shaped capture, and
today's user-run comprehension prompts are entity-agnostic in wording. But the Puller's target
model, dossier shapes, and CRM landing are person-typed throughout. **This is a real build, not
a wiring job** — the honest entry on this list that existing code does not solve.

## 10. Built-and-dark lanes waiting on one decision each

- **Event-ingest lane**: 1,810 events, lane BUILT + gated off — turns on via
  `ZOE_EVENT_LEGISTAR_CLIENTS` / `ZOE_EVENT_GCAL` (Lucas picked both; slugs pending).
- **Skuld / ~50 tombstone-dead passes**: stopped, not healed — retire vs rebuild is Lucas's
  call; recommendation on file is retire-and-rebuild-on-demand.
- **Today's three builds** (fit / identity gate / run closure): committed, gate-green, and
  **inactive until the next reboot** — boot128 runs pre-fix code. Their first live proof is the
  next session's watch: fit reports in the log, `IDENTITY UNCONFIRMED` holds, and a `[closure]`
  door firing on a real run.

## Known limits of what was built today (self-audit)

- `fitToWindow` estimates at ~4 chars/token (package math). Dense text can still ride close to
  the edge; the explicit `num_predict` reserve is the backstop. If `[fit]` reports appear on
  most turns, the right fix is portion-sizing the upstream blocks, not more trimming.
- `personIdentityGuard` protects only person-anchors with KNOWN attributes; an attribute-less
  node still enriches ungated (by design — refuse on contradiction, never ignorance — but it
  means thin-node contamination is reduced, not eliminated).
- Closure thresholds (streaks 2/3, budgets 12/24/40, Jaccard 0.6) are reasoned, smoked, and
  **unproven live** — the first concluded run should be read end-to-end before trusting them.
- Spawned `Investigate:` threads outrank older undated asks on recency (his chosen bias); if
  spawns crowd his real work, the driver's deadline weights are the tuning point, not the spawn
  cap.
