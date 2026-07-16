# Node Resolution & Fusion Gate — Design (grounded)

> **North-star (Lucas 2026-07-16):** the backlog / LAMP 18× over-link / dedup false-positives / 86%-isolated
> events / promote-up rejections / resolver ambiguity are ONE disease — nodes enter the graph without a
> write-time step that resolves-against-existing → canonicalizes → precision-dedups → fuses sources →
> connects relationally into **one extremely-well-sourced node.** Build that gate ONCE: it PREVENTS new
> symptoms on write AND clears the backlog when run as a sweep. **Prevention and cure are the same method.**
>
> This memo grounds the design in the ER/canonicalization/fusion literature (research-first, per Lucas).
> **Sourcing note:** the automated deep-research pass fetched 27 primary sources across 6 angles and
> extracted 125 claims, but a usage limit (2026-07-16) starved the adversarial-verification + auto-synthesis
> steps. 6 claims are fully cross-verified (3-vote); the rest are quoted from primary sources but not
> machine-verified. Cross-check the ⚠ items against the papers before relying on exact numbers.

## 0. Where it sits — extends the substantiation pipeline, doesn't replace it

Slices 1-6 (substantiation) already do **resolve-or-mint + prove/fade**, but they MINT on a resolver miss with
no **canonicalize / precision-dedup / fuse** step — which is why duplicates (`CITY OF SACRAMENTO` ×3) and
ambiguity persist. The gate slots **between "resolve" and "mint"**:

```
incoming node/edge
   │
   ▼  ── the GATE ───────────────────────────────────────────────────────────────
   1 BLOCK      candidate generation (recall)         ← embedding-ANN + name + strong-id blockers
   2 MATCH      precision decision (deterministic → probabilistic → collective)
   3a  match  → CANONICALIZE + FUSE into the existing node (no dup)
   3b  no match→ MINT (unsubstantiated — Slice 2 path) + queue for prove/fade
   3c  borderline → HUMAN-REVIEW queue (never auto-merge the risky tier)
   4 CONNECT    relational/collective wiring + neighbor enrichment (DERIVED_FROM)
   ── same gate runs as a BATCH SWEEP over the backlog ──────────────────────────
```

## 1. BLOCK — candidate generation (optimize RECALL; precision comes later)

**Grounded:** Blocking maximizes recall at near-zero precision — measured **Pairs-Completeness 0.944–0.999 but
Pairs-Quality ~10⁻⁵–10⁻⁶** (Papadakis meta-blocking, arXiv:1609.06265 / RG:281857003) ⚠. So a **downstream
pruning/matching step is mandatory** — never merge on a block. **No single blocker suffices** on heterogeneous
data; combining complementary blockers (name-first + attribute-clustering catch-all) reaches PC=1 where each
alone loses pairs (arXiv:1609.06265) ⚠. For the **incremental/streaming** case (our one-node-at-a-time write),
tree-based sorted-neighborhood / LSH indexing gives near-constant insert/query (**~1 ms insert / 15 ms query on
8M records**, DySNI forest, RG:267024654; noise-tolerant LSH+sorting-trees, Liang centaur.reading 237) ⚠.

**For us (we already have the substrate):**
- **Blocker A — embedding-ANN** (we have the entity vector index): top-k nearest by name+summary embedding.
- **Blocker B — normalized-name / token** (`name_key` already exists): exact + q-gram/token key.
- **Blocker C — strong-id**: exact match on any embedded id (`[wd:Q…]`, OCD `ocd-person/…`, FEC `[C0…]`,
  `contact_id`, LDA `lda_client`). This block is also the deterministic-match fast-path (Stage 2 Tier 1).
- **Union** A∪B∪C for recall (multi-blocker, per the "no single blocker" finding); dedup candidates; cap the
  candidate set. This is a *superset* of today's exact-name-only dedup, which is why dups slip through now.

## 2. MATCH — the PRECISION core (three tiers, hard-negative rules)

The whole disease is a **precision** failure (Howell merge, LAMP fan-out). The literature's answer is a
tiered, precision-first matcher — **not** a learned DL matcher here: Ditto (LM-based) is SOTA (**+29–31% F1 over
DeepMatcher**, arXiv:2004.00584, ✓verified) **but has "steep training-data requirements"** (Barlaug/Gulla survey,
ACM 3431816, ✓verified) — wrong fit for a single-operator low-label system. **Rules + probabilistic linkage win
here.**

**Tier 1 — DETERMINISTIC (auto-merge, safe):** shared **strong identifier** (same QID / OCD-id / FEC-id /
contact_id). This is the Swoosh-safe, order-independent merge. Everything with a strong id resolves here with
zero false-merge risk — and most of our civic entities carry one (`[wd:Q…]`, OpenStates OCD, FEC).

**Tier 2 — PROBABILISTIC (Fellegi-Sunter), HIGH threshold:** F-S computes per-field match/non-match weights and
a combined score; the threshold is the precision knob (robinlinacre F-S accuracy; PMC9562057) ⚠. **Precision
rules that kill our two failure modes:**
- **Given-name compatibility is a HARD GATE.** "Janet D. Howell" vs "William J. Howell" — different given names
  → **non-match, full stop.** Never merge on surname + jurisdiction alone. (This one rule kills the dedup
  queue's whole false-positive class — proposals #486/#508.)
- **Require ≥1 corroborating field beyond name+jurisdiction** (birth year, office, chamber, committee, a shared
  strong-id-bearing neighbor). Name+state is *never* sufficient.
- **Never fan a membership/relation edge onto every same-key candidate.** If a target resolves to >1 candidate
  and none dominates deterministically → HOLD, don't fan. (Kills the LAMP 8,253-edge over-link at the source.)

**Tier 3 — COLLECTIVE / RELATIONAL (the ambiguity breaker):** when name alone is ambiguous, use the graph.
**Bhattacharya & Getoor 2007** (ACM 1217299) ⚠ — the foundational result:
- `sim(cᵢ,cⱼ) = (1−α)·simₐ(attributes) + α·simᵣ(neighbors)`, α∈[0,1] — a **dynamic** relational term that
  **re-scores a pair when its neighbors resolve.**
- **THE precision guard:** compare the **RESOLVED IDENTITIES** of neighbors, not their surface strings. This is
  what makes it safe (and is exactly the [[node-resolution-fusion-gate]] neighbor-diffusion lever).
- **Pays off most where ambiguity is highest** (BioBase F1 0.568→0.710→0.819; low-ambiguity CiteSeer barely
  moves) — i.e. precisely the cases a precision-first gate fears.
- **For us:** "City of Sacramento" is ambiguous by name (3 lobby dups) → resolve it via its edge context (it's
  the `MAYOR`-of target of `Kevin McCarty [wd:Q6396892]`, who IS resolved) → pick the candidate whose neighbors
  overlap. This is the fix for the resolver returning `ambiguous` on every real civic target.

**Below threshold, above a floor → the HUMAN-REVIEW queue** (our `resolution_proposals`). **Never auto-apply the
name-weak tier.**

## 3. CANONICALIZE — one surface form, and tame the relation vocab

**Grounded:** open-KB canonicalization = cluster synonymous **entity** noun-phrases AND **relation** phrases via
learned embeddings (CESI, Vashishth WWW 2018, arXiv:1902.00172; CMVC unsupervised, arXiv:2206.11130) ⚠. CESI's
key move: canonicalize entities and relation predicates **jointly**.

**For us:**
- **Entity canonical form:** prefer the strong-id-tagged form as canonical (`United States Department of the
  Treasury [wd:Q648666]` over the bare/uppercase variants); alias the rest via `SAME_AS`. This is what lets the
  promote-up edges land — resolve "City of Sacramento" → the canonical, propose the edge to *that*.
- **Relation-predicate canonicalization** (the 246 singleton freeform types, 296 edges): embedding-cluster or a
  one-shot LLM map of the long tail onto the ~24 core predicates (`SPOUSE`/`MARRIED_TO`, `CEO`/`HAS_CEO`,
  `BORN_IN`/`BIRTHPLACE`). Cheap, high-hygiene. Do it at the gate (on write) *and* as a backlog map.

## 4. FUSE — one extremely-well-sourced node (calibrated + provenanced)

**Grounded:** **Knowledge Vault** (Dong KDD 2014, cs.ubc kv-kdd14) ⚠ — fuse noisy multi-source facts with a KB
prior into **calibrated per-fact probabilities**; **Knowledge-Based Trust** (VLDB p938-dong) weights **source
reliability** ⚠. The critical rule (which the node-enrichment track independently flagged): **a donated/derived
fact must NOT be counted as an independent corroboration.**

**For us (extends `confidence_model` + the substantiation grade ladder):**
- Merge fuses **per-fact provenance** (source set) into the surviving node — not just a max.
- **Calibrated confidence** rises only with **independent** sources (we already mirror-collapse families in
  `corroboration.js`); **source-reliability weight** is the missing dimension — an authoritative `.gov`/wikidata
  source outweighs a blog (partially built: official-doc-weight `9cf57dd`).
- **DERIVED_FROM guard:** a fact a node received from a neighbor (collective enrichment) is stamped
  `DERIVED_FROM` and is **excluded from the independent-corroboration count** — so donation can't inflate
  confidence into a false "well-sourced."

## 5. CONNECT — relational wiring + neighbor enrichment

This is where the **node-enrichment investigation** (docs/NODE_ENRICHMENT_INVESTIGATION.md) plugs in: today
insert is a bare write and there is **no neighbor-to-neighbor transfer**. The gate adds it, safely:
- On landing an edge, compare `classifyObject(A)` vs `(B)` (richness metric already exists); the **richer**
  endpoint offers attributes to the **thinner** one as **proposals** stamped `DERIVED_FROM` (provenance edge).
- **Hub-cap the blast radius** (the LAMP 18× over-link is the cautionary tale — a hub must not diffuse to
  thousands). Bounded, reversible, proposal-gated.

## 6. MERGE SEMANTICS — Swoosh ICAR (so incremental == batch)

**Grounded:** **Swoosh** (Benjelloun & Garcia-Molina, Stanford SERF) ⚠ defines the four properties that make
match/merge **order-independent** — **I**dempotence, **C**ommutativity, **A**ssociativity, **R**epresentativity
(ICAR). If the gate's match+merge satisfy ICAR, then **running it per-node on write and running it as a batch
sweep produce the same graph** — which is exactly Lucas's "same method prevents and cures." Reversibility
(`SAME_AS` aliasing + un-merge) is a hard requirement; our Echo dedup already has `canonical_id` + reversible
`reversed` status — keep it.

## 7. ARCHITECTURE — write-path + backlog sweep + human tier

- **Write path (prevention):** every ingest lane (doc-decompose, news, graph-walk, puller) routes its
  proposed nodes/edges through the ONE gate before landing. Tier-1 auto-applies; Tier-2/3 borderline →
  review queue; genuine miss → mint unsubstantiated (Slice 2).
- **Backlog sweep (cure):** the identical gate runs over (a) the 12.7k promote-up edges — resolve each endpoint
  to canonical, land the resolvable, mint the genuinely-new, skip noise; (b) the news-isolated places/events;
  (c) the relation-vocab tail. Because of ICAR, it's the same code.
- **Human-in-the-loop:** the risky tier NEVER auto-applies (this is why the 24.6k dedup queue is *correctly*
  stalled — it's the review pile, and it contains real false merges). The gate's job is to keep that pile
  *small and correct*, and to auto-clear only Tier-1.

## 8. Failure-mode → fix map (the acceptance test)

| Symptom (observed) | Gate stage that fixes it |
|---|---|
| Janet↔William Howell false merge | §2 Tier-2 given-name hard gate + require corroborating field |
| LAMP `MEMBER_OF` 18× fan-out | §2 "never fan onto every same-key candidate" + strong-id requirement |
| "City of Sacramento" resolver ambiguous | §2 Tier-3 collective (resolve via the MAYOR-neighbor) + §3 canonical form |
| Promote-up 12.7k rejected (surface-form) | §1 blocking + §3 canonicalize → propose edge to the canonical node |
| 246 singleton relation types | §3 relation-predicate canonicalization |
| Places 95% / events 86% isolated | §5 connect (news-decompose wires them) |
| Dups persist despite dedup | §1 multi-blocker (not exact-name-only) + §2 precision match |
| "not one well-sourced node" | §4 fusion (calibrated, provenanced, source-weighted) |

## 9. Build order (each precision-verified before the next)

1. **The matcher core** (§2) as a pure, tested lib — Tier-1 strong-id + Tier-2 F-S rules (given-name gate,
   corroborating-field requirement, no-fan rule). This is the precision heart; smoke it against the known
   false-merge cases (Howell, LAMP) as fixtures.
2. **Blocking** (§1) — multi-blocker candidate gen over the existing ANN + name_key + strong-id indexes.
3. **Collective tie-break** (§2 Tier-3) — resolved-neighbor overlap for the ambiguous tier.
4. **Canonicalize + fuse** (§3/§4) — canonical-form selection + provenance-merge + DERIVED_FROM guard.
5. **Wire into the write path** (§7) at the substantiation gate (extends Slices 1-6).
6. **Backlog sweep** (§7) — run the same gate over the 12.7k + dedup queue, precision-gated, dry-run first.

## Sources (surfaced by the research pass)
ER/matching: Ditto arXiv:2004.00584 (✓); Barlaug/Gulla survey ACM:3431816 (✓); Fellegi-Sunter robinlinacre.com,
PMC9562057. Blocking: Papadakis meta-blocking arXiv:1609.06265 / RG:281857003; DySNI RG:267024654; Liang
noise-tolerant blocking centaur.reading 237 (✓ for incremental-vs-batch); JedAI toolkit. Collective ER:
Bhattacharya & Getoor ACM:1217299; arXiv:2002.09361; ABACO ScienceDirect S0950705120302860. Canonicalization:
CESI arXiv:1902.00172 + malllabiisc/cesi; CMVC arXiv:2206.11130. Fusion: Knowledge Vault cs.ubc kv-kdd14;
Knowledge-Based Trust VLDB p938-dong. Merge semantics: Swoosh infolab.stanford.edu/serf.
