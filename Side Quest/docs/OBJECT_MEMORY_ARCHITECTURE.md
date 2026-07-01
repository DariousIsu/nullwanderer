# Object-centric memory + research execution — design

Status: **DESIGN, brainstormed with Lucas 2026-06-30.** The synthesis of "Zoe IS the memory," the
short-term↔long-term split, the plan-driven research executor, and Echo's knowledge graph. This is the
spec so it survives a compact; build is sliced at the end.

## The core idea (Lucas)
Everything Zoe touches is an **OBJECT** (entity) and its **CONNECTIONS** (relations) — in the SAME schema
as Echo's memory graph. There are then only **two operations**, for any instruction however phrased:
- **EXPAND / EXTRACT an object we already have** — it lives in long-term (Echo); pull it (and the
  connections the task needs) into short-term, deepen it or render a report from it.
- **CREATE a new object** — it doesn't exist; create it + populate its attributes/connections.

This is the definitive answer to "must we hand-code every instruction shape into the program": **no.** The
cloud identifies which objects an instruction touches; there are only ever two things you do to an object.
`discover` / `enrich` / `profile` were symptoms of missing this — they're all just *"which objects, and do
we have them yet."*

## Why it's the right substrate — Echo is already built for it
Echo is a **propose→promote knowledge graph**: `search_entities` / `get_entity` / `quick_lookup` /
`kg_neighborhood` / `propose_entity` / `propose_relation` / `merge_entities` / `resolve_entity_conflict` /
`extract_entities_from_doc`. Entity types include person, organization, committee, government_body, bill,
**document**, decision, legal_instrument, office_held, concept, poll, event. It maps 1:1 onto the
short/long-term model already built ([[short-term-long-term-memory]]):

| Layer | In object terms |
|---|---|
| LONG-TERM (Echo) | the committed entity/relation graph |
| SHORT-TERM (SQ `documents`/working set) | the **working subgraph** — objects pulled from Echo + new proposals being populated |
| known→unknown grounding | **resolve the target to its Echo object and pull it (+ neighborhood) FIRST** |
| Overnight promote (Slice 2 built) | reconcile short-term object deltas into Echo via propose→promote + `merge_entities` |

## THE MOTIVATING PROOF — the Curtis failure (2026-06-30)
Live run #2915 "profile Senator John Curtis" produced NOTHING (empty notes, 4/4 no-progress strikes): it ran
the `discover` loop (walk NEW orgs), couldn't find a "new target," and drifted (web-searched DuckDuckGo,
watched an R Street video, bled old Cato research in). Meanwhile **Curtis is already a richly-connected object
in Echo**: one cheap `quick_lookup` returns `degree: 320` (320 linked entities — bills, committees), full
bio (U.S. Senator R-UT, district, phone 202-224-5251, bioguide C001114, FEC id, birth date, Wikipedia),
committees with **Chair** roles, sponsored bills. **That one call was his whole biography, for cents.** She
never looked. Lucas: **"searching the Echo DBs is paramount — none of this will work properly without it."**

Root breaks this exposed:
1. The `discover` path NEVER grounds in Echo (gatherKnown is only wired into enrich/deep-target).
2. Even where it runs, gatherKnown is a SHALLOW text-snippet grep (search_entities/search_knowledge, ~500
   chars) — NOT a full **object pull** (quick_lookup/get_entity + kg_neighborhood → structured facts + the
   320 connections). It grabs a paragraph when the whole graph node is right there.

## The plan-driven, object-first EXECUTOR (retires all modes)
The cloud PLAN (Slice A) already yields the general representation: `targets[]` = objects, `facets[]` =
attributes/relations to populate. ONE loop, parameterized by the plan — no modes:

1. **Resolve** each target to its canonical Echo object (`search_entities`/`quick_lookup` → resolve/merge
   the duplicate records, e.g. Curtis's FEC + legacy + canonical us_senator records, via `merge_entities` /
   `resolve_entity_conflict`). Not found → CREATE a new object.
2. **Pull** the object + its neighborhood (`get_entity` + `kg_neighborhood`, bounded) into short-term. THIS
   IS THE CHEAP, COMPLETE FIRST PASS — the biography/committees/bills come free from the graph.
3. **Diff** the pulled object against the plan's facets → the GAPS (e.g. Curtis's positions on permitting /
   data centers / AI aren't in the graph).
4. **Fill only the gaps** with the expensive web/deep work (the two-lane researcher) — refine + extend the
   existing object; never re-derive what the graph holds.
5. **Reconcile** the deltas back to Echo overnight (new attributes, new relations, new entities) through the
   propose→promote gate.
6. Discovery is just step 1 when `targets = "to be identified"` — find them, then each runs steps 1-5.

So: **Curtis** = 1 known object → pull + fill gaps. **21 think tanks** = 21 known objects → pull + fill each.
**"find right-wing energy orgs"** = discover → create → populate. **"contacts for those 5"** = 5 known
objects, one facet. Same loop.

## Documents are objects too (Lucas, 2026-06-30)
Every document we create (research report, meeting notes, dropped file) becomes a **`document` object**,
**LINKED via `mentions` edges to every entity it references.** The Curtis report → links to Curtis, his
committees, R Street, cited bills. Meeting notes → link to every attendee + org. Effects:
- **Tagging dissolves** — the document's links ARE its index/classification. "What meetings mentioned data
  centers?" / "what do we have on Curtis?" become graph queries, not tag searches.
- Retrieval is bidirectional: an entity's neighborhood surfaces the documents about it; a document's edges
  list its entities.
- Echo support: `extract_entities_from_doc(doc_id)` already pulls entities from a doc's markdown; we ADD the
  explicit `document → mentions → entity` edges (propose_relation) + the `cites`/source edges (save_source).
- **Reports/deliverables become RENDERED VIEWS of objects** — a "Curtis profile" is generated from his
  entity + neighborhood; the `documents` store holds the deliverable + companion transcript, but sourced
  FROM the graph, not as the source of truth.

## Decisions locked / open
- **LOCKED: Echo-search-is-the-first-move.** Every target begins with resolve-and-pull from the object graph
  (the Curtis proof settles this). known→unknown becomes an OBJECT pull, not a snippet grep.
- **LOCKED: documents are objects linked to their mentioned entities.**
- **LOCKED: entity resolution/dedup is Echo's job** (`merge_entities`/`resolve_entity_conflict`); we don't
  reinvent it.
- **OPEN #1 — schema: reference vs mirror.** Does short-term REFERENCE Echo objects by id (thin, always
  fresh, more round-trips) or MIRROR a working copy in SQ (fast/offline, needs reconcile)? Lean **mirror the
  working subgraph** (fits the short-term store + the overnight reconcile already built).
- **OPEN #2 — working-subgraph scope.** Pull the object + how much neighborhood? (1 hop / only the
  plan-named connections / degree-capped for a degree-320 node like Curtis — we clearly can't pull all 320.)
- **OPEN #3 — new-object provenance.** A created object's source trail ([[verifiable-research-track]] Slice B)
  — every attribute/relation carries where it came from.

## Build slices (proposed order)
1. **Object-level known→unknown pull** (fixes Curtis directly, highest value): resolve target → Echo object
   → `get_entity` + bounded `kg_neighborhood` → structured facts + relations into short-term, as the first
   pass, for EVERY target regardless of current mode.
2. **Plan-driven executor**: targets × facets loop (resolve → pull → diff → fill gaps → assemble), retiring
   the `discover`/`enrich` mode branches in `lib/research.js` + `main.runDirectedResearchPass`.
3. **Documents-as-objects**: on promotion, create the `document` object + `mentions` edges to its entities
   (extends the Slice-2 promotion pass, [[short-term-long-term-memory]]).
4. **Overnight object reconciliation**: promote short-term object DELTAS (attributes/relations/new entities)
   into Echo via propose→promote + merge (generalizes the built document-promotion pass).
5. **Reports as rendered views** of objects (the deliverable pipeline sourced from the graph).

## Ties
[[zoe-is-the-memory]] (the graph IS her memory) · [[short-term-long-term-memory]] (the tiered pipeline, built)
· [[verifiable-research-track]] (plan + provenance + the executor) · [[research-execution-and-enrich]]
(the enrich/facet-fill work this generalizes). The drift finding (she wandered off Curtis into a video
mid-run) is a separate lane/focus-holding issue ([[interface-and-lanes-design]]), tracked apart from this.
