# Why a new node does not exchange enrichment with its neighbors — investigation

_2026-07-16. Investigation only (no code changed). Traced the full write path across both memory tiers
(short-term `data/sq.db` and long-term "Echo"), the edge/link subsystem, every neighbor-touching pass, and the
background cadence. Four independent sweeps + direct reads converge on the same answer._

## The question
When a node is added, it should immediately interact with its neighbors so that a **rich** node **enriches**
its scarcer neighbors and a **scarce** node is **enriched by** its richer neighbors (bidirectional diffusion
along edges).

## Verdict
**This behavior does not exist anywhere in the system, and nothing on the insert path could produce it.** Not
because it was built and broke — because the architecture never had an intra-graph, neighbor-to-neighbor
information-transfer step. Every enrichment path in the system pulls facts **from the outside world** (live
Wikipedia → web search → the Echo/Wikidata corpus + a cloud LLM). Graph topology (a node's neighbors) is used
only to **(a) pick which node to work on** and **(b) avoid re-proposing an edge that already exists** — never as
the **source** of enrichment content, and never as a **channel** that carries facts between two adjacent nodes.

So a rich neighbor never donates what it knows to a thin node, and a new thin node never absorbs from the rich
nodes it just linked to. Enrichment is **node-local + external**, not **relational**.

---

## Why it doesn't happen — the five structural reasons

### 1. Node insert is a bare write with zero post-insert hooks
Short-term mint `recordEntity()` (`lib/graph_memory.js:55-95`) runs, in order: trim/validate name → coerce
epistemic status → normalize to a dedup key → **speculation gate** (speculated ⇒ goes to a proposal queue, not
the graph) → **exact-name-key dedup** (`db.graphGetEntityByKey`, `lib/db.js:1676-1678` — plain `WHERE name_key = ?`,
no embedding/ANN/fuzzy) → field-upgrade-if-exists **or** a single `INSERT` (`lib/db.js:1668-1675`) → attach source.
That is the entire synchronous path: **no embed step, no link-candidate search, no importance scoring, and no
neighbor traversal.** The `INSERT` has no DB trigger. The only side effects are UI activity events
(`kga.emit('node.born' / 'node.enrich')` → `lib/kg_activity.js:10-16`), which are explicitly side-effect-free —
**no subscriber acts on `node.born`.** The long-term path is just an MCP `propose_entity` dispatch
(`lib/graph_walk.js:194-211`); disambiguation (Levenshtein 0.85) happens inside the external Echo server and is
**dedup, not enrichment**. A codebase-wide search for `onInsert / afterInsert / postInsert / afterMint` finds
nothing.

### 2. Edges land after the node, in a deferred pass — so at insert time there are no neighbors yet
For most ingested content, a new node is **isolated at birth**. Edges arrive later:
- Local grounded edges are synchronous only in narrow cases (e.g. meeting reconciliation writing `ATTENDED` /
  `EXPECTED_ATTENDEE`, `lib/graph_memory.js:194-208`).
- The general **link subsystem** (`run_link_candidates` → `run_link_grounding`) is co-source/co-occurrence based,
  then citation-verified, and runs **only inside the nightly sweep** `maybeRunNightlyDedupSweep`
  (`main.js:1105-1120`): polled every 30 min but **gated to at most once per calendar day**, idle-gated, requires
  a live Echo connection, and is **`ZOE_KG_NIGHTLY_ENABLED` = OFF by default** with a bounded batch of 20 (a
  noted ~4k backlog "drains over many nights").

Consequence: even if an enrichment-on-link step existed, it would fire a day-plus after the node arrived, in
tiny batches, usually off. The design docs confirm this is intended for news/entities — "news entities land
ISOLATED (86% of events)" and unresolved edge endpoints are **held, never minted** ("72.8k held")
(`docs/SUBSTANTIATION_GRADING_DESIGN.md:33-37`).

### 3. Edges are inert rows — nothing flows along them
A relation is stored as `(source_id, target_id, relation_type, confidence, epistemic, confirmed, valid_from/to,
deleted)` and nothing more (`lib/db.js:1696-1707`). Neighbor reads (`graphNeighbors`, `lib/db.js:1711-1716`) are
plain adjacency `SELECT`s. There is **no inheritance, no attribute copying, no belief/embedding propagation**
along an edge. The only things that "traverse" edges act on the **edge itself**, not the endpoints' contents:
confidence **decay** (`decayVisitedEdges`, `lib/graph_walk.js:426-444`), **supersession/termination** flipping
`confirmed`/`valid_to` on the one edge (`lib/graph_memory.js:157-160`), and **promote-up** carrying an edge (with
its own citation) to Echo. Grep of the graph libs for `propagat|inherit|spread activation|diffuse|flow.*edge`
finds nothing.

### 4. The one thing that looks like neighbor enrichment (the idle graph-walk) sources from the web, not neighbors
`lib/graph_walk.js` is the closest match to the intent — its header literally says
`WALK — flow to connected branches: enrich thin neighbours, FORGE missing connections` (`lib/graph_walk.js:9`).
But reading `growAround` (`lib/graph_walk.js:236-359`):
- It classifies a node **missing / thin / rich** (`classifyObject`, `:74-81`) — this is the richness metric (see
  below) — and prioritizes thin-first.
- It then fetches sources with `web(mention, 5)` and builds an LLM "dossier" (`fetchLayeredSources`, `:376-417`:
  live Wikipedia → web search → Echo corpus). **The enrichment content comes from the internet, about the anchor.**
- The anchor's existing **neighbors** are fetched (`:245-251`) and passed into the prompt **only** as
  *"Already-linked neighbours (do not re-propose these edges)"* (`buildDossierPrompt`, `:145`) — a **negative
  dedup filter**. Neighbor attributes are never read as content and never pushed onto the anchor.
- The node's own existing facts are passed as *"build PAST this, do not repeat"* (`:144`) — again avoid-dup, not
  a source.

So the walk grows a **star** of new web-sourced edges out of one anchor; it does **not** move state between two
already-adjacent nodes. And it is **triggered by conversation/idle anchoring, not by node insertion** — a new
node only gets touched if the idle loop later happens to anchor on it (via a conversation mention or the
degree-band "thin frontier" sampler in `lib/idle_anchors.js:129-174`), within a 6h visited-TTL and tight budgets
(`WALK_MAX_NODES=5`, `WALK_MAX_CONNECTIONS=8` per move, ≥30s between moves, 300k tok/hr). An in-code audit note
records **"96.5% of effort on pre-existing/saturated nodes"** (`lib/graph_walk.js:40`), and its link proposals
"pool in tenant_rainey and rarely land" (`:520-522`).

### 5. There IS neighbor "spreading-activation" — but only at read time, and it writes nothing back
`_enrichGraph()` (`lib/cognition.js:83-130`, explicitly labeled "spreading-activation" at `:105`) walks a node's
relations and pulls a neighbor's role/title into the **answer** (e.g. Rubio → "Secretary of State"). Same with
`kg_neighborhood` dossier-building (`lib/echo_suit.js:466-470, 631-676`) and the read-time research pull
(`main.js:2766-2800`). All of this is **retrieval to answer a query** — it reads neighbors and mutates **nothing**
in the graph. The machinery to *read a neighbor's facts* exists; it is simply never wired to *write them onto an
adjacent node*.

Reinforcing this: the unified-graph spec makes non-mutation a **deliberate rule** —
*"Consumers **read** the shared backbone… and **emit only their own derived nodes** back (with `DERIVED_FROM`
edges), never mutating sources"* (`docs/UNIFIED_OBJECT_GRAPH_PLAN.md:13`). Neighbor→neighbor enrichment is not a
missing wire on a planned feature; it is currently **excluded by design**.

---

## What "rich" vs "scarce" is measured by today
There is already a richness classifier, so the concept exists — it just drives *target selection*, not transfer:
- **`classifyObject`** (`lib/graph_walk.js:74-81`): `thin` = `degree < 8` AND `facts < 3` AND `committees == 0`;
  otherwise `rich`; `null` = `missing`. Knobs `THIN_DEGREE`/`THIN_FACTS` at `:33-34`.
- **`idle_anchors.js`** selects a "frontier" of thin nodes by a **degree band** (`buildRelevantFrontierSql`,
  `:129-174`), excluding hubs as targets but using them as radiating seeds.
- Per-**fact** strength (not node richness) is `grade + independent-corroboration count → calibrated confidence`
  (`lib/corroboration.js`, consumed `lib/graph_walk.js:327-329`).
- Node surfacing significance is a separate 1–10 LLM "poignancy" score (`lib/importance.js:65-103`).

So "rich node / scarce node" already has a working definition (**degree + fact count**). What's missing is any
step that uses it as a **gradient to move information across an edge**.

---

## Map of every neighbor-touching pass (and what it actually does)
| Pass | Neighbors used for | Moves info across an edge? | Where |
|---|---|---|---|
| Node insert (`recordEntity`) | nothing | No | `lib/graph_memory.js:55` |
| Idle graph-walk (`growAround`) | dedup filter + target pick | No (web-sourced star) | `lib/graph_walk.js:236` |
| Anchor sourcing (`idle_anchors`) | 1–2 hop BFS to pick thin targets | No | `lib/idle_anchors.js:129` |
| Decay sweep (`decayVisitedEdges`) | decays the anchor's own edges | No | `lib/graph_walk.js:426` |
| Nightly link lane (`run_link_*`) | co-source pairing + web-cite verify | No (creates edges, no transfer) | `main.js:1105` |
| Dedup/merge (`run_dedup_adjudication`) | folds duplicate nodes onto a survivor | No (identity consolidation) | `main.js:975-1014` |
| Query enrich (`_enrichGraph`) | reads neighbor role/title into the **answer** | No (read-only, no write-back) | `lib/cognition.js:83` |
| Promote-up / promote-docs | carries a node/edge (with its own citation) to Echo | No | `lib/cloud_curator.js:291`, `main.js:7626` |

**Nowhere do two adjacent, distinct nodes update each other's facts, confidence, or embeddings.**

---

## Recommendations (design options — none implemented here)

The behavior you want is a **neighbor-aware enrichment step**. The good news: the two hard prerequisites already
exist — a **richness metric** (`classifyObject`) and a **neighbor reader** (`kgNeighbors` / `graphNeighbors` /
`kg_neighborhood`). What's missing is the transfer step and a trigger. Three routes, cheapest first:

1. **Smallest change — make the graph-walk neighbor-aware (recommended first step).**
   In `growAround` (`lib/graph_walk.js:236`), the anchor's `neighbors` are already fetched but used only as a
   negative filter. Add them to the dossier prompt as a **positive source**: "here is what the graph already
   knows about this node's neighbors — infer and propose any attributes/edges of the anchor that its neighbors
   imply." This gives *scarce-node-pulls-from-rich-neighbors* with almost no new plumbing. Keep it proposal-gated
   (writes stay `propose_*`, Echo-promotion-gated) so it's safe on the auto loop. Caveat: still gated behind the
   idle walk's cadence/budget, and still LLM-mediated rather than a direct copy.

2. **The real feature — an insert-triggered "neighbor reconcile" hook.**
   Add a post-insert/post-link step (the natural home is where edges land: `recordRelation`
   `lib/graph_memory.js:102`, and the promote-up / auto-promote lanes). On a new edge `A—B`, compare
   `classifyObject(A)` vs `classifyObject(B)`; from the richer endpoint, **offer** structured attributes to the
   thinner one as *proposals* (never in-place mutation of the source — respect the
   `docs/UNIFIED_OBJECT_GRAPH_PLAN.md:13` "never mutate sources" rule by writing only to the receiving node, with
   a `DERIVED_FROM`/provenance edge back to the donor). This is true bidirectional diffusion, priority-ordered by
   the existing thin/rich gradient.

3. **Fullest version — a bounded diffusion pass (belief-propagation lite).**
   A nightly pass that, for each edge, runs one round of message-passing: propagate high-confidence,
   type-compatible attributes from high-degree to low-degree endpoints (e.g. an org's location/jurisdiction to a
   thinly-recorded member), capped per node, gated by relation-type compatibility, fully reversible + provenance-
   stamped. This is the largest surface and needs guards against over-connected hubs (the memory index already
   flags **"LAMP over-linked ~18×"** — a hub would otherwise flood the graph).

### Cross-cutting cautions to build in from the start
- **Provenance / honesty valve.** The system's core contract is "let it in, mark provenance, let churn refine."
  Any donated attribute must carry a `DERIVED_FROM <neighbor>` marker and its own grade, or it will look like an
  independent corroboration when it is really the same fact echoed across an edge — poisoning the
  corroboration-count confidence model (`lib/corroboration.js`).
- **Hub blast radius.** Cap donation from/through high-degree nodes; the DB review already documents an
  over-linked hub (LAMP). Unbounded diffusion from a hub is exactly the "cluster-collapse / flood" failure mode
  flagged elsewhere.
- **Don't fake corroboration.** Two nodes sharing a fact because one donated it to the other are **not**
  independent sources; keep donated facts out of the independent-family count.
- **Prerequisite reality-check.** Even structural linking is largely dormant today (nightly link lane OFF by
  default; ANN entity index has no refresh cadence and is already ~0.8% stale per
  `docs/UNIFIED_OBJECT_GRAPH_PLAN.md:55`). Neighbor enrichment is only as good as the edges that exist — the
  linking cadence should be revived alongside, or the diffusion pass will have few edges to flow through.

## Files worth reading first (for whoever builds this)
`lib/graph_walk.js` (the intent + the negative-filter miss) · `lib/graph_memory.js:55-129` (insert + edge write) ·
`lib/cognition.js:83-130` (the read-time spreading-activation that could be inverted into a writer) ·
`lib/idle_anchors.js:129-174` (degree-band richness selection) · `main.js:1035-1145` (nightly link/dedup sweep) ·
`docs/UNIFIED_OBJECT_GRAPH_PLAN.md:13` (the "never mutate sources" rule to design around) ·
`docs/SUBSTANTIATION_GRADING_DESIGN.md` (the external prove-or-fade cascade, for contrast).
