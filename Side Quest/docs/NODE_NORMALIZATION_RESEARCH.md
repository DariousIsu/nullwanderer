# Node Normalization / Canonicalization / Type-Reconciliation — Research Digest

**STATUS (2026-07-16): SEARCH + FETCH + CLAIM-EXTRACTION complete; VERIFY phase STARVED by the Anthropic
session usage limit (resets 10am ET) — all 75 verifier agents errored. The claims below are quoted from
PRIMARY sources but were NOT adversarially cross-checked.** Re-verify by resuming the workflow after the
reset: `Workflow({scriptPath: ".../workflows/scripts/deep-research-wf_306c0869-932.js", resumeFromRunId:
"wf_306c0869-932"})` — search/fetch replay from cache; only the verify+synthesize agents re-run.

Run: `wf_306c0869-932`. 6 angles, 26 sources, 117 claims → top 25 extracted (below). Do NOT build a design
off this until verified — this is grounding material, honestly marked.

---

## Angle 1 — Universal placement: write-time == batch (Swoosh ICAR)
- **ICAR** (idempotence/commutativity/associativity/representativity) ⇒ ER of any instance is finite AND
  **order-independent**; any processing order yields the identical canonical set. This is the formal guarantee
  that **synchronous write-time resolution and a batch backlog sweep produce the same result.** [Swoosh VLDBJ]
- **R-Swoosh** is incremental with **no internal state** to save/restore → the *same* function runs online at
  insert time and as periodic batch reconciliation. [Swoosh VLDBJ]
- Incremental ER can be made order-independent AND quality-equivalent to batch via a **repair step (n-depth
  reclustering)**. [PMC7250616]
- A write-time gate **links new entities against the existing clustered graph** rather than re-linking the
  whole corpus → avoids the bottleneck; at 10M entities batch runtime was **5× the incremental** cost. [PMC7250616]

## Angle 2 — Surface-form canonicalization (CESI / CMVC) — precision caveats
- Open-KB canonicalization is settled as **CLUSTER-then-select-representative — two distinct sequential steps.**
  **Our "thin canonical-form selector" is only the SECOND half; the load-bearing FIRST half is the
  synonym-clustering (resolution) step** we don't yet do. [text2kg survey, CEUR Vol-3747]
- **Two symmetric error modes, both must be guarded:** (1) same entity, different surface forms → duplication
  (missed merge); (2) same surface form, different entities → **false merge**. Precision-first = guard #2 while
  still collapsing #1 — exactly our "never false-merge" + "U.S. Senate/United States Senate" pair. [text2kg]
- **CESI** clusters LEARNED embeddings of KB triples + side info; canonicalizes BOTH noun phrases AND relation
  predicates jointly. Side info is principled components (NOT allow-lists): entity-linking (~30% coverage),
  PPDB paraphrase, WordNet WSD, IDF token overlap, morphological normalization. [CESI, arXiv 1902.00172]
- **Surface-form-only canonicalization fails in BOTH directions** — misses same-entity variants AND wrongly
  groups distinct entities — which is why CMVC adds structural (fact) + contextual evidence, not string sim
  alone. [CMVC, arXiv 2206.11130]
- **BUT learned clustering is NOT precision-safe on its own:** SOTA embedding canonicalization reaches only
  **macro-P ~0.63 / micro-P ~0.51** on standard benchmarks. [ESWC Lomaeva 2022]
- **Catastrophic over-merge is the failure mode:** on Base, CUVA produced ~10 clusters, one holding **>90% of
  all relation phrases.** [ESWC Lomaeva] → a precision-first system CANNOT swap in learned clustering wholesale.
- Learned *does* beat manual-feature clustering where recall matters (CESI 81.9 vs manual ~0.5 pairwise-F1 on
  ReVerb45K) — so embeddings belong as a **signal/blocker**, not as the deciding merge. [CESI]

## Angle 3 — Type / ontology reconciliation (the load-bearing gap) — YAGO 4.5
- **Type-disjointness as a precision guard:** YAGO 4.5 rejects a subclass link if it would make a class a
  transitive subclass of two **declared-disjoint** upper classes (removed 9k links). This is the concrete
  **type-compatible-vs-conflicting merge rule** we need. [YAGO 4.5, arXiv 2308.11884]
- **Domain/range constraints as an INGESTION GATE:** YAGO validates each fact against the predicate's declared
  domain/range at acceptance time, discarding ~6% of facts — ontology types gate ingestion, not post-hoc
  cleanup. [YAGO 4.5]
- **Hybrid reconciliation = authority-anchor-for-hubs + auto-for-tail:** a compact hand-curated upper ontology
  (schema.org reduced to 8 top / 41 upper classes) is **manually mapped** to Wikidata, under which the 133k-class
  Wikidata taxonomy is grafted **automatically.** [YAGO 4.5] → this is the principled version of what `civic_canon`
  gropes at.
- **Fine-grained type = an ER pre-filter:** typing partitions instances into type-consistent clusters, cutting
  candidate coreference pairs → attacks the O(n²) cost. [ebiquity 713]
- **When source types are untrustworthy/unknown**, reconcile type by mapping an instance's attributes/relations
  onto a background authority KB (DBpedia) and predicting type — reconcile by attribute-matching to an authority,
  NOT by trusting source-supplied types. [ebiquity 713]
- **Granularity mismatch degrades reconciliation:** DBpedia mapping 100% within-source dropped to 60% (≥1 type)
  / <10% (all types) on Freebase, partly because ~70% of Freebase instances carry only `common.topic`. [ebiquity 713]

## Angles 4–6 — sources captured, claims not in the selected top-25 (recover on re-verify)
- **Authority files as a PRINCIPLED component (not a hardcoded list):** W3C **Reconciliation Service API** spec
  (score-ranked candidates + a `match=true` threshold), OpenRefine reconciliation, LCNAF named-entity
  reconciliation. [reconciliation-api.github.io; openrefine.org/docs; LCNAF README]
- **Long-tail coverage bias:** "structural bias emerges when connectivity patterns, degree distributions, or
  relation frequencies unevenly represent specific entities" — names our dropped-local-officials failure.
  [MDPI Appl. Sci. 16/7/3410]
- **Validation metrics:** cluster-level pairwise/B-cubed/CEAF/MUC P-R-F1; blocking pair-completeness /
  reduction-ratio. [VLDB R18; arXiv 1905.06167; ER-benchmarking survey]

## Sources (26; primary unless noted)
Swoosh VLDBJ · PMC7250616 (incremental ER) · CESI arXiv:1902.00172 · CMVC arXiv:2206.11130 · text2kg survey
(CEUR Vol-3747) · CUVA arXiv:2012.04780 · ESWC Lomaeva 2022 · YAGO 4.5 arXiv:2308.11884 · ebiquity 713
(type reconciliation) · W3C Reconciliation API · OpenRefine docs · LCNAF (blog) · MDPI 16/7/3410 (bias) ·
VLDB R18 · arXiv:1905.06167 · arXiv:2109.09140 · arXiv:2405.02463 · ACL matching-1.8 · arXiv:2005.14326 ·
D19-1024 · arXiv:2404.05622 · Springer 978-3-030-33220-4_7 · minimalistinnovation (ER benchmarking, blog) ·
arXiv:2507.18977 · 2 unreliable (skipped).

---

## BASELINE MEASUREMENT (2026-07-16, read-only, on the live 1.755M-node civic_graph.db)
Total entities 1,755,499 · QID-anchored 3,762 (0.21%) · exact-name dup floor 707 · exact-name type-conflict floor 161.

**v1 (naive normalizer — a CAUTIONARY result):** stripping the trailing `(jurisdiction, session)` parenthetical
falsely collapsed 337 distinct bills ("SB 2 (AL,2017rs)" ≠ "SB 2 (AK,30)") into one cluster → 1,392,629 bogus
"dup candidates." **Empirical proof that naive name-normalization catastrophically over-merges; the parenthetical
is SIGNAL.** (matches the research's #1 warning + the operator's precision-first constraint.)

**v2 (precision-grade — `entity_match.matchPair`-adjudicated, block = type+nameKey+jurisdiction):**
- (A) STRONG-ID collisions (same id on >1 node = definite dups, 0 false-pos): **only 3** — and 2 of 3 are
  CROSS-TYPE (AFL-CIO org/person; US-Attorney-SDNY org/office_held) = the type-mess at identity level.
- (B) matcher-confident MATCH pairs: **472 → 446 clusters / 456 surplus rows**, ALL real in the sample
  (punctuation/case/annotation variants of the same person in the same jurisdiction, e.g. "David L. Cook (AZ)"=="David L Cook (AZ)").
- REVIEW pairs: **9,072,154** — ambiguous collisions the matcher CORRECTLY holds (bills, homonyms) → NOT dups,
  NOT auto-merged. Oversized blocks: 4,133 (538,580 rows) flagged, not scanned.
- **VALIDATION RESULT: the precision matcher does NOT over-merge on the live graph** (472 real matches, 9.07M
  ambiguous held, 0 false merges sampled) = the "never false-merge" guarantee demonstrated at scale.
- **KEY CAVEAT that frames the design:** blocking on `parseEntity.nameKey` (no abbreviation folding) puts
  "U.S. Senate" and "United States Senate" in DIFFERENT blocks → never compared → the hub variant-form dups are
  INVISIBLE to same-nameKey blocking. **The normalization layer's job = pull variant surface forms into ONE block
  so the matcher can adjudicate.** (Harness: scratchpad/baseline_dups.js [v1], baseline_dups_v2.js [v2].)

## What converges (even unverified) — directional, for the design pass AFTER verification
1. **Universal placement is the right call** — Swoosh ICAR says write-time and batch are the *same function*;
   build ONE resolver, run it on every lane and as the sweep. (validates the pivot)
2. **We're missing the load-bearing half of canonicalization** — cluster-synonyms (resolution) *then* select
   form. Our `entity_fuse.canonicalForm` is only the second half.
3. **Do NOT go full-learned** — learned embedding clustering is modest-precision (~0.63) and over-merges
   catastrophically. Precision-first = keep the deterministic rule matcher + strong-id + type guards; use
   embeddings only as a recall *signal/blocker*. (confirms the precision-first instinct)
4. **Type reconciliation = a small type-compatibility lattice + disjointness guard + domain/range checks**
   (YAGO's model), NOT trusting source-supplied types. `government_body`/`organization`/`committee` compatible;
   `person` disjoint.
5. **`civic_canon` should become a reconciliation-service-style authority component** (score-ranked + threshold,
   per the W3C spec), the hub anchor under which the long tail resolves automatically — not a hardcoded list.
6. **Validation = cluster-level metrics on a labeled sample + measured dup-reduction + false-merge rate.**
