# Memory Path Mapping — Design

**Status:** design, not yet built. **Date:** 2026-07-19.
**Relates to:** `RESEARCH_ALLOCATION_DESIGN.md` (the allocator this feeds),
`SUBSTANTIATION_GRADING_DESIGN.md` (grade IS priority — gaps are the same idea from the other side),
`NODE_RESOLUTION_FUSION_GATE_DESIGN.md` (routes break when nodes merge — see §9).

---

## 1. The ask

> *"we shouldn't need to sweep the entire database or even be dependent on the atlas for searches we
> have done, and pathways should be mapped for shortest distance but also be used to help identify
> information gaps."* — Lucas, 2026-07-19

Three bundled capabilities:

1. **Route memoization** — record the *path that worked*, not just the answer. Replay it instead of
   re-searching.
2. **Shortest-distance traversal** — connect known things by graph distance, not broad sweep.
3. **Gaps from path topology** — the keystone. Mapped paths make *absences* visible.

**Compounding principle (Lucas):** *"the system was designed to get fast as the map filled."* This is a
learning layer, not a cache.

### Measured motivation

`global.__researchUsage().dbFirstRatio` = **9 ourDB / 95 web (9% ours)** as of 2026-07-19.

Two honest caveats on that number, so it doesn't get over-read:

- It counts **operator tool calls only**. `resolveMention`'s structural grounding runs on every target in
  *code*, not as a tool call, so it is excluded. The true "consult ourselves" rate was never 9% — 9% is
  the operator's *discretionary* rate.
- The counter **resets on reboot**. Before/after comparisons need comparable accumulation windows.

Commit `586b0ef` addressed the priming half of this (DB-first tool ordering). This document is the
structural half.

---

## 2. Where this lives — and why not the atlas

Lucas's question: *"if the atlas is the tool catalog where do we keep database maps?"*

There are four layers. Three exist; the fourth is what we're building.

| Layer | Answers | Lives in | Owner | Nature |
|---|---|---|---|---|
| **Atlas** | "What can I *call*?" | Echo `_atlas.py` / `atlas.json` | nx-echo | static, authoritative |
| **Schema** (`get_db_map`, `get_schema`) | "What *shapes* exist?" | Echo introspection | nx-echo | static, authoritative |
| **Content** (entities, relations) | "What is *true*?" | Echo `civic_graph.db` | nx-echo | authoritative |
| **Route map** ← *this* | "How did I *get there* last time?" | **`sq.db` (ours)** | us | **learned, derived, disposable** |

**Decision: the route map lives in `sq.db`.** Four reasons:

1. **It is experience, not fact.** Same class as `knowledge`, `open_threads`, `self_model`. Echo holds
   what is true; sq.db holds how she found it.
2. **Write frequency.** Echo writes pass the fusion/promotion gate. A structure updating on every
   research pass would abuse that path.
3. **Owner boundary.** nx-echo is the owner's repo, and `_atlas.py`/`atlas.json` were being actively
   edited on 2026-07-19. Routes in sq.db ship without coordination.
4. **The safety property that matters most: it is a pure index over Echo — droppable and rebuildable at
   any time.** A stale route costs a wasted hop. It can never become a wrong fact. Routes in Echo would
   risk being read as claims.

**Invariant #1 — the route map is never a source of truth.** Deleting it must only ever cost speed.

---

## 3. Prior-art posture

Two research passes (2026-07-19). Full citations in §12. What we adopt and what we deliberately refuse:

### Adopt

| Idea | Source | Why |
|---|---|---|
| **Derivational replay** — store the decision trace *with justifications, including rejected alternatives* | Carbonell; Veloso (classical planning) | The exact concept, formalized in 1993. Rejected alternatives double as the negative record. |
| **Three-valued absence** (`value` / `somevalue` / `novalue`) | Wikidata snaks; Razniewski et al. survey (CC-BY 4.0) | The whole answer to "gap vs. non-fact." See §6. |
| **Cardinality assertions** | Razniewski &amp; Nutt; Ghosh et al. | Converts vague "maybe incomplete" into a *countable* work item. Both research passes named this independently as highest-leverage. |
| **Memoize schemas, not literal paths** | Tadepalli, IJCAI-91 (structural bias) | Justifies the pattern+override decision already made. Literal node sequences rot under our write rate. |
| **Landmark anchoring** — "hop to hub L, then local search" | PLL literature, *as a concept only* | Hubs are the least volatile part of the graph. We already compute this (§8). |
| **Utility-gated retention** | Minton, PRODIGY (AIJ 1990) | The route library is a *net tax* if hit rate is low. Non-optional. See §7. |
| **Invalidate on statistical drift, not per-write** | Neo4j `statistics_divergence_threshold` | Per-write invalidation is unaffordable at our churn rate. |
| **Memory accelerates, never gates** | ReMindRAG α-blend + self-correction | A failed route must fall through to fresh search transparently. |
| **Negative TTLs count down, never refresh on re-read** | RFC 2308 | Prevents a "not found" from circulating forever as self-sustaining truth. |
| **Obligatory attributes via subclass-stability** | Lajus &amp; Suchanek, WWW 2018 (~90% precision) | The rigorous form of peer comparison. See §7. |
| **Star patterns** over class patterns | Galárraga et al., WSDM 2017 | Adapts to sub-populations; dodges wrong-peer-group failure. |

### Refuse

| Idea | Why not |
|---|---|
| **Reachability index / 2-hop labeling / PLL / transitive closure** | Assumes a near-static graph. Ours is written continuously by autonomous workers — the exact adversarial workload. Deletion requires transitive label repair; a 2025 VLDB paper is *still* fixing correctness-under-update in a 2002 technique. Borrowing this vocabulary drags the design toward a full-graph index we cannot maintain. |
| **Recoin-style frequency scoring** | Its documented failure mode is our risk profile verbatim — see §7. |
| **Bloom filters for negative caching** | Guarantee is "not in *this set*," presuming the set is authoritative and complete. Ours is a partial, growing sample. It would encode "not in our KB" while *reading* as "does not exist" — precisely the confusion §6 exists to prevent. |
| **Vendoring ReMindRAG code** | **Repo has no license file** → no permission under default copyright. Study the paper, implement independently, do not vendor. |

### Why we depart from database orthodoxy

Mature graph engines (Neo4j, TigerGraph, Memgraph, DuckPGQ) cache *plans*, never *paths* — a deliberate
refusal, because invalidation costs more than recomputation. **Our economics invert this.** Their
recompute is a millisecond BFS. Ours is an LLM-driven web research episode costing seconds-to-minutes
and real money. That inversion is the entire justification for this project, and it should stay explicit
so the departure remains justified rather than assumed. **If recompute ever gets cheap, revisit.**

---

## 4. Instrumentation point

An audit on 2026-07-19 **falsified** the working assumption that `relatedEntities` was the traversal
chokepoint. There are at least five production traversal mechanisms:

| Path | Mechanism |
|---|---|
| `lib/echo_suit.js:509` `relatedEntities` | raw `relations` |
| `lib/idle_anchors.js:155` | **its own** raw 1-hop + 2-hop JOINs |
| `lib/monologue.js:1644`, `echo_suit.js:469`, `main.js:2818` | `kg_neighborhood` (returns empty) |
| `lib/echo_suit.js:712`, `resolution_live.js:44` | `get_entity`.relations |
| `main.js:3680` | `query_graph` hops:2 |

Instrumenting `relatedEntities` would have captured ~⅓ of traversal and silently missed the rest —
including the most interesting walker.

**The real chokepoint is `EchoLive.dispatch` (`lib/echo_suit.js:223`).** Every path funnels through
`d({kind:'do', name, args})` → `callTool`. One instrumentation site, catches future traversal for free,
no refactor risk.

**Two known bypasses** call `echoSuit.client().callTool()` directly and must be routed through dispatch
first: `main.js:2818` and `main.js:3680`. Small, contained.

### Record cheap, derive separately

**Invariant #2 — recording and interpretation are decoupled.**

- **Record** at dispatch: an append-only observation log — `(tool, arg-shape, result-shape, hit/miss,
  latency, focus_id)`. Dumb and universal.
- **Derive** routes in a separate offline pass that stitches observations into `pattern_key → hops`.

We do not have to get the route abstraction right on day one, and a wrong derivation is re-runnable from
the log rather than corrupting anything.

---

## 5. Data model (sq.db)

Sketch, not final DDL.

```sql
-- Raw observations. Append-only, cheap, TTL-pruned. The derivation source of truth.
CREATE TABLE route_obs (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  focus_id TEXT,               -- research episode this belonged to
  tool TEXT NOT NULL,
  arg_shape TEXT,              -- normalized shape, NOT raw args (no PII, no key values)
  result_shape TEXT,           -- 'rows:N' | 'empty' | 'error'
  outcome TEXT NOT NULL,       -- 'hit' | 'miss' | 'error'
  latency_ms INTEGER
);

-- Derived routes. Droppable + rebuildable from route_obs at any time.
CREATE TABLE routes (
  pattern_key TEXT NOT NULL,   -- schema pattern: 'county->governing_body->members'
  entity_id INTEGER,           -- NULL = pattern-level; non-NULL = per-item override
  hops TEXT NOT NULL,          -- JSON: ordered hops, each w/ justification + rejected alternatives
  landmark_id INTEGER,         -- anchor hub, if the route is landmark-relative
  hit_count INTEGER DEFAULT 0,
  miss_count INTEGER DEFAULT 0,
  avg_savings_ms INTEGER,      -- utility numerator
  avg_match_cost_ms INTEGER,   -- utility denominator (paid on EVERY attempt, incl. misses)
  drift_fingerprint TEXT,      -- cheap neighborhood signature; drift => replan
  last_ok_ts INTEGER,
  last_fail_ts INTEGER,
  PRIMARY KEY (pattern_key, entity_id)
);

-- Absence records. Three-valued. See §6.
CREATE TABLE absence (
  subject_id INTEGER NOT NULL,
  predicate TEXT NOT NULL,
  kind TEXT NOT NULL,          -- 'somevalue' (gap) | 'novalue' (asserted absence)
  first_observed_ts INTEGER NOT NULL,  -- NEVER refreshed on re-read (RFC 2308)
  attempts INTEGER DEFAULT 1,
  ttl_s INTEGER,
  evidence TEXT,               -- REQUIRED for 'novalue'; NULL forbidden for that kind
  PRIMARY KEY (subject_id, predicate)
);
```

Note `arg_shape`, not raw args — the log records *shape* so it can never become a side-channel for key
values or personal data.

---

## 6. The absence model — Lucas's point 2

> *"it needs both so that will need to be fleshed out proper"* — record successes **and** failures.

Agreed, and this is the part where getting it wrong is actively harmful. A failed lookup can mean
*"we haven't found it yet"* or *"it doesn't exist."* Recording those identically would let a research gap
harden into a false "no such fact" — the system would conclude something is untrue because it remembers
failing to find it.

**Adopt Wikidata's three-valued snak model:**

| Value | Meaning | Consequence |
|---|---|---|
| `value` | Known value exists | Normal fact |
| `somevalue` | **A value exists but we don't know it** | **Gap → feeds the priority allocator** |
| `novalue` | **No value exists in the world** | Asserted absence; a real claim |

**Invariant #3 — a failed lookup lands in `somevalue`, always. It may NEVER auto-promote to `novalue`.**
Promotion requires the same evidentiary bar as a positive fact: an explicit completeness assertion, a
cardinality assertion, or an authoritative source stating absence. **A timeout is not evidence.**

**Invariant #4 — `first_observed_ts` is never refreshed by re-reading the record**, only by an actual new
lookup attempt. RFC 2308's rationale applies directly and is a live risk here: our workers are autonomous
and re-observe each other's records, so a self-refreshing negative would circulate forever.

Absence records also carry a **shorter TTL than positive facts** — absence is a weaker claim than
presence and should expire sooner.

**Failed routes re-index rather than delete.** A route that was retrieved and didn't work is diagnostic
signal about the *index*, not just a bad entry (Ihrig & Kambhampati). Prefer ReMindRAG's framing: a
*soft, decaying penalty* on a continuous weight rather than a hard "no path here" flag. A penalized route
is discouraged, never forbidden — which sidesteps the open-world problem structurally.

---

## 7. Gap detection

### The finding that challenges an earlier decision

Peer-comparative gap detection was approved earlier. Research shows the naive form is essentially
**Recoin** (Wikidata's completeness indicator), whose documented failure mode maps onto our risk profile
almost verbatim: editors objected that it *amplifies bias*, marking entities from under-covered
populations as substandard (named: Indonesia, Cameroon, the Gambia).

**Translated to our graph:** peer-comparing a township clerk in a thin-coverage rural county against
well-covered municipalities emits gaps **no amount of research can close, because the sources don't
exist** — an unbounded, unsatisfiable queue feeding the priority allocator. Recoin also needed a
*hand-coded* exception (suppressing death-date for living humans) because its statistics couldn't find
it. That is the tell.

**Peer comparison survives; raw frequency does not.** Use **obligatory-attribute detection via subclass
distribution stability** (Lajus & Suchanek, ~90% precision): frequency cannot separate "obligatory but
under-recorded" from "genuinely optional," but *stability across subclasses* can — a truly obligatory
property has uniform prevalence across every subclass, because the missingness is sampling noise rather
than real-world variation. Needs no curated schema; only a class hierarchy and instances.

### Ranked by precision — build in this order

1. **Jurisdiction coverage.** *Sound today.* We hold the denominators: 3,152 counties etc. in
   `lib/us_*.json`. "Have we covered every county?" is answerable now.
2. **Seat-count reconciliation.** *Sound once counts exist.* **Correction to an earlier claim: our
   `us_*.json` files are flat name lists — they carry NO seat counts or body sizes.** Verified
   2026-07-19. So "does this parish's police jury have all its members?" is **not** computable today.
   Seat counts *are* discoverable facts, so this converts into: **capture cardinality as a first-class
   fact during research**, then reconcile `|have| / N`. Small addition, highest precision, directly
   prioritizable ("board has 7 seats, we have 5" = a countable gap of 2).
3. **Star patterns** — "this dossier has 3 of the 8 relations that normally co-occur." Adapts to
   sub-populations automatically.
4. **Obligatory attributes w/ subclass-stability** — the rigorous peer comparison.
5. ~~Recoin-style frequency scoring~~ — **do not build.**

### Hard guards (independent of threshold)

- **Minimum peer-group support** before emitting any gap. Small group ⟹ frequency is noise.
- **Dry-pass demotion.** A gap surviving N directed passes is evidence of *source absence* — demote,
  don't re-queue. We already have this shape in the pure-refusal 2-dry-pass stop; extend it.
- **Stratify peer groups by source-availability tier**, not entity type alone. Compare small
  jurisdictions to small jurisdictions.
- **Exclude relations with no natural cardinality** entirely rather than thresholding them.
- **Calibrate thresholds against our own outcome data** — we already record per-beat research outcomes.
  Measure what fraction of emitted gaps a directed pass actually closes; tune to that. Published numbers
  (AMIE PCA-conf 0.1) are tuned for research recall, not work-queue precision.

### The utility gate — non-optional

Minton's formula: `Utility = (AvgSavings × ApplicationFrequency) − AvgMatchCost`.

`AvgMatchCost` is paid on **every attempt including misses**; `AvgSavings` is collected only on hits.
**A route library with a low hit rate is strictly negative value — not merely useless, a tax.** The
failure has a name (*swamping*): in the worst case the system is slower after learning than before.

Track utility per route from day one and evict when negative. This is a correctness property of the
design, not a scaling concern to defer.

---

## 8. Two things we already solved

**The blowup problem.** `lib/idle_anchors.js:158-171` already does bounded 2-hop traversal with a
**hub-corridor cap** (`mid.degree <= hubCap`). The comment states it: without the gate, one hop through
the degree-12,107 node pulls 12k nodes. Any shortest-path walker hits that exact wall. **Reuse this
constraint; do not rediscover it.** It is also the same structural insight as landmark anchoring — we
already identify the churn-stable hubs.

**Paths already exist and we discard them.** `query_graph` returns `path` strings (`"A -> B -> C"`) that
`studio/kg_view.js:52` and `renderer/kg.js:1001` walk to draw the ego-network — computed live for the
visual, thrown away every time. The path layer is not greenfield; there is real signal being recomputed
and dropped.

---

## 9. Risks

| Risk | Mitigation |
|---|---|
| **Utility problem / swamping** | §7 utility gate, from day one |
| **Routes rot under continuous writes** | Schema routes + landmark anchoring + drift-fingerprint invalidation, not per-write |
| **Node merges silently invalidate routes** | The fusion gate rewrites entity ids. Routes keyed on `entity_id` must be invalidated (or remapped) on merge — **needs explicit wiring to the fusion gate; currently unhandled** |
| **Gap queue becomes unsatisfiable** | Dry-pass demotion + source-tier stratification + minimum support |
| **Negative record circulates forever** | Invariant #4 (non-refreshing origin ts) |
| **`somevalue` drifts into `novalue`** | Invariant #3; `evidence` non-null enforced for `novalue` |
| **Route map mistaken for truth** | Invariant #1; droppable by construction |
| **Observation log grows unbounded** | TTL prune; it is derivation input, not an archive |

---

## 10. Slices

| Slice | Content | Proves |
|---|---|---|
| **P0** | Route observation log at `dispatch` + route the 2 bypasses. Record only, derive nothing. Flag-gated, default off. | Instrumentation is universal and cheap |
| **P1** | Offline derivation pass: `route_obs` → `routes` (pattern-level only). Read-only report; nothing consumes routes yet. | Routes are derivable from observations |
| **P2** | Replay with **fallback always live** + utility tracking. Measure hit rate and `dbFirstRatio` delta. | The compounding claim, with numbers |
| **P3** | Absence model (§6) — three-valued, TTL'd, non-refreshing. | Failures recorded without hardening into false negatives |
| **P4** | Gap detection #1 (jurisdiction coverage) → allocator. | Gaps become prioritized work |
| **P5** | Cardinality capture during research → seat-count reconciliation (#2). | The highest-precision gap source |
| **P6** | Star patterns (#3), then obligatory attributes (#4). | Peer comparison, the rigorous kind |

P2 is the go/no-go gate. If measured utility is negative there, the honest outcome is to stop — the
literature says a low-hit-rate route library makes the system slower, and we should believe our own
numbers over the thesis.

---

## 11. Open questions

1. **Route granularity** — is `pattern_key` the beat facet, the question class, or the object-type pair?
   P1's derivation pass should reveal what clusters naturally rather than us guessing now.
2. **Fusion-gate interlock** — exact mechanism for invalidating routes on entity merge (§9).
3. **`kg_neighborhood` returns empty** for these nodes. Routes sit on the raw `relations` table
   (as `echo_suit.js:509` already does), or that tool gets fixed first. Coordinate with the nx-echo owner
   — they were editing atlas internals on 2026-07-19.
4. **Does the derived route layer belong in Echo eventually?** Argued no (§2), but if routes prove
   valuable to the owner's engine too, the question reopens — as a *published view*, never as truth.

---

## 12. Sources

**Completeness / absence**
- Razniewski, Arnaout, Ghosh, Suchanek — *Completeness, Recall, and Negation in Open-World Knowledge
  Bases: A Survey*, ACM CSUR 2024. **CC-BY 4.0.** https://arxiv.org/abs/2305.05403
- Lajus & Suchanek — *Are All People Married? Determining Obligatory Attributes in Knowledge Bases*,
  WWW 2018. https://suchanek.name/work/publications/www-2018.pdf
- Galárraga, Razniewski, Amarilli, Suchanek — *Predicting Completeness in Knowledge Bases*, WSDM 2017.
  https://arxiv.org/abs/1612.05786
- Balaraman, Razniewski, Nutt — *Recoin*, WWW'18 Companion. https://www.wikidata.org/wiki/Wikidata:Recoin
- *Examining the Impact of Algorithm Awareness on Recoin* (editor complaints / bias amplification).
  https://arxiv.org/abs/2009.09049
- Wikidata Help:Statements (snak model). https://www.wikidata.org/wiki/Help:Statements

**Route memoization / speedup learning**
- Minton — *Quantitative results concerning the utility of explanation-based learning*, AIJ 1990.
- Tadepalli — IJCAI-91, structural bias. https://www.ijcai.org/Proceedings/91-2/Papers/002.pdf
- Leake et al. — *Case-Base Maintenance Beyond Case Deletion*.
  https://homes.luddy.indiana.edu/leake/papers/d-23-01.pdf
- ReMindRAG, NeurIPS 2025. https://arxiv.org/abs/2510.13193 — **code has NO LICENSE; do not vendor.**
- Ihrig & Kambhampati — retrieval failures as re-indexing signal. https://arxiv.org/pdf/cs/9711102
  *(lower confidence — partial extraction; verify before relying on specifics)*
- Neo4j query-plan caching. https://neo4j.com/docs/cypher-manual/current/query-caches/
- RFC 2308 (DNS negative caching). https://www.rfc-editor.org/rfc/rfc2308.html

**Tooling (licenses)**
- sheXer — shape mining, **Apache-2.0**. https://github.com/weso/shexer
- AnyBURL — rule mining, **BSD-3**. https://web.informatik.uni-mannheim.de/AnyBURL/
- AMIE — rule mining, **CC BY 4.0** (content license on software; attribution required).
  https://github.com/dig-team/amie

**Lower-confidence, flagged by the research pass:** DBL (arXiv:2101.09441) and the Ihrig & Kambhampati
specifics came from partial extraction. Verify against originals before relying on them.
