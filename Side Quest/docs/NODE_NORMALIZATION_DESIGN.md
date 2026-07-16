# Universal Node Normalization / Canonicalization / Type-Reconciliation — DESIGN

**Status:** DESIGN (2026-07-16). Grounded in `NODE_NORMALIZATION_RESEARCH.md` (26 primary sources, unverified
but foundational) + the live baseline (`scripts/measure_baseline_dups.js`). Precision-first. No code until each
slice is smoke-tested; **no Echo writes / no leash change without operator sign-off.** Supersedes the `civic_canon`
patch approach — `civic_canon` becomes one authority input under this (see §D).

## The problem (measured, not assumed)
On the live 1.755M-node graph: exact dedup already works (707 dups). The dups that HURT are **invisible to
exact/`nameKey` matching** — variant surface forms ("U.S. Senate" vs "United States Senate") land in DIFFERENT
blocks and are never compared → re-minted on every ingest. Plus **type inconsistency** (same entity typed
`government_body`/`organization`/`office_held`) and **dropped local officials** (leash + promotion + recall).
Baseline v2: the matcher is precision-SAFE (472 real matches, 9.07M ambiguous correctly HELD, 0 false), but
same-`nameKey` blocking never surfaces the variant-form dups. **The blocker is the gap, not the matcher.**

## Grounding → design decisions
- **Swoosh ICAR** (write-time == batch, order-independent) → build ONE resolver; run it on every lane AND as the
  batch sweep. Same function. [§1]
- **Canonicalization = cluster-synonyms THEN select-form** — we only built select-form (`entity_fuse.canonicalForm`).
  The missing half is **synonym-clustering**, which for us = **normalization-aware blocking + the existing matcher**. [§2]
- **Do NOT go full learned-embedding clustering** (≤0.63 precision, catastrophic over-merge). Keep the deterministic
  matcher + strong-id + guards; embeddings stay a recall SIGNAL (the ANN blocker), never the decider. [§2]
- **Type reconciliation = a small compatibility lattice + disjointness guard** (YAGO 4.5 model), NOT trusting
  source types. [§3]
- **Authority file = a principled reconciliation component** (W3C Reconciliation API: score-ranked + threshold),
  anchoring the ~0.21% hub entities; the long tail resolves via the general matcher. [§4]
- **Validation = cluster metrics + measured dup-reduction + false-merge sampling** on the real graph. [§6]

## Design

### A. Normalization-aware blocking (the load-bearing fix)
Add a **normalized-name block key** to `entity_block.blockingKeys` using a shared normalizer (`civic_canon.normalizeCivic`
extended): lowercase, strip `[id]`/`(juris)` tags, fold `U.S.↔United States`, `&↔and`, punctuation, case. Variant
forms then share a block key → co-blocked → the matcher adjudicates. **Additive** (extra recall); the matcher still
owns precision, so it cannot cause a false merge — it only makes an invisible dup *visible for adjudication*.
CRITICAL: the normalizer must NOT strip disambiguators the matcher needs (jurisdiction, bill session) — those stay
as separate parsed fields (v1 proved stripping them over-merges 337 bills).

### B. Type-compatibility lattice (into `entity_match`)
A tiny declared lattice: COMPATIBLE = {government_body, organization, committee, office_held} may co-refer;
DISJOINT: person ⊥ {any org/body/bill/place}, bill ⊥ everything non-bill, place ⊥ person, etc. `matchPair`:
a type conflict across a disjoint boundary → hard no-match; a compatible-but-different type → allowed to match on
other evidence (strong-id / full name+juris), and the fused node takes the most-specific compatible type. Grounded
in YAGO disjointness. Guards the 2-of-3 strong-id dups we found (org↔person was a type ERROR, not a real merge —
disjointness would have flagged it).

### C. Universal placement (one resolver, every lane + store)
Route ALL write paths through the same `resolution_gate` (or a shared `resolve()` that calls it): doc-decompose
(done), promote-up bridge, `graph_memory.recordEntity` (short-term sq.db), `[grow]`/graph_walk, concept lane,
Puller, news. Same normalizer + blocker + matcher everywhere (Swoosh: write == batch). Short-term and long-term
share ONE normalization function. Insertion = synchronous before-insert for the cheap deterministic path; the ANN/
collective tier can be async-reconcile to avoid the write bottleneck at scale.

### D. Authority as a reconciliation component (reframe `civic_canon`)
`civic_canon` stops being a hardcoded merge list; it becomes an **authority resolver** returning score-ranked
candidates + a match threshold (W3C pattern) for the closed hub set, consulted inside the gate. Hubs anchor to a
QID; the tail resolves generally. It ADDS a confident strong-id merge, never overrides the matcher.

### E. Validation harness (active, on real data)
`measure_baseline_dups.js` is the baseline. For any change: (1) re-run with the new blocking → count newly-visible
matcher-confirmed dups (recall gain) and REVIEW/oversized (frontier); (2) sample N matcher-`match` pairs → confirm
0 false merges (precision); (3) if a sweep is applied, diff before/after. Metrics: dup-reduction + false-merge rate.

## Slice plan (each smoke-tested; writes/leash gated on sign-off)
- **S1 — normalization-aware block key** (pure, `entity_block` + `civic_canon.normalizeCivic`; smoke; re-measure
  variant-form dups now visible). NO writes.  ← FIRST
- **S2 — type-compatibility lattice** (pure, `entity_match`; smoke; re-validate Howell/LAMP/type-conflict).
- **S3 — universal placement** wiring (route short-term write + promote-up + other lanes through the gate;
  smokes; reboot-gated).
- **S4 — batch sweep + apply** (run the gate over the graph; measure dup-reduction + false-merge; **apply merges
  only on sign-off**).
- **civic_canon reframe** (D) folded into S3.

## OPEN DECISIONS (operator, not research)
1. **Leash policy** — should local-government docs bypass the domain-focus leash (fixes dropped local officials at
   the cost of the flood-control the leash provides)?
2. **Apply the ~456 matcher-confirmed safe merges + 3 strong-id dups** (Echo writes, irreversible)?
