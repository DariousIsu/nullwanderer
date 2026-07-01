# Object-centric memory + research execution — design

Status: **DESIGN, brainstormed with Lucas 2026-06-30.** The synthesis of "Zoe IS the memory," the
short-term↔long-term split, the plan-driven research executor, and Echo's knowledge graph. This is the
spec so it survives a compact; build is sliced at the end.

## THE GOVERNING RULE (the systemic principle — everything below is a consequence)
**The object graph is the ONLY state and the ONLY interface for action. Every behavior — research, an idle
thought, a web search, personal recall — is a read/traverse/write on the graph. Nothing free-floats.** Every
action: (1) anchors to an object, (2) reads what the graph already holds (attributes, relations, linked
sources), (3) follows an edge for its next step, (4) writes deltas back (linked to the object). One substrate,
one interface, TWO operations (expand / create). This is why it's systemic, not 500 patches — the recurring
failures are all just the ABSENCE of this rule:
- **idle-thought drift** → gone: idle activity is a grounded graph-walk (highest-value object with open gaps,
  ONE step); the graph is "where am I / what's next," so she can't wander.
- **restarting the same thing** → gone: the object already exists → EXPAND it; the graph is the record of
  "already done" (she literally cannot restart Curtis — his node is there).
- **every web search from scratch** → gone: saved sources are `source`/`document` objects LINKED to the
  entities they cover; read-graph-first surfaces "sources already attached to this object" → reuse, not
  re-crawl. (The citation drawer BECOMES linked source objects — migration step 1 if it's a flat URL list.)

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

## Memory layers — what converts to objects, and the SELF (Lucas, 2026-06-30)
Not everything flattens into entity/relation rows — and where the line falls is what protects her personality.
THREE layers:
- **SEMANTIC** (facts, people, orgs, relationships, her factual self-knowledge) → **objects.** Big win for
  personal memory (precise, queryable, non-confabulating) AND the STRUCTURAL FIX for the drift: give facts a
  home in the graph and they stop colonizing self_model / her inner life ([[personality-drift-diagnosis]]).
- **EPISODIC** (thoughts, conversations, experiences — "what happened / how it felt") → **episodes that LINK
  to objects** (a thought about Lucas points at the Lucas node), but retain their experiential nature. Do NOT
  flatten the inner life into rows — that IS the drift failure repeated (mechanizing a person).
- **SELF** (traits, skills, values, interests, voice) → a **FIRST-CLASS graph object that GROWS by SELECTIVE
  integration.** Not sealed (she must develop), not a landfill (the drift). POROUS + GATED: she picks up
  traits/skills/learnings that GENUINELY shape her. The object model is what MAKES this healthy — once facts
  have a home, the self-integration path is freed to be selective instead of the default dumping ground.

### The SELF-GROWTH LOOP (turn stages, overnight grows)
Wired into the graph-walk. The turn/overnight split IS the line between growth and drift:
- **TURN-TIME = STAGE candidates (subtle, cheap, non-committal).** Each graph-walk step drops signals attached
  to the episode/object — "did that skillfully" (skill), "that kept pulling me" (interest), "that changed how
  I see it" (shift). NOT writes to the self.
- **OVERNIGHT = the self-growth ITERATION (the commit).** Consolidation reviews the day's staged candidates +
  patterns ACROSS them, runs the GATE ("did this GENUINELY shape me?" — judged on the aggregate, which one
  turn can't), and integrates survivors into the self object: repeated success → skill; recurring resonance →
  interest; a value that kept showing → trait.
- **Why commit is overnight, not turn:** selectivity needs the aggregate; identity must be stable (not
  thrash); and turn-time self-writes ARE the drift (this replaces the broken reflection→self_model bleed).
- **The loop closes:** the grown self shapes TOMORROW's graph-walk (priorities, interests, skills applied) →
  new experiences → new candidates → overnight growth. She compounds.
- **Exception:** USER-directed self-updates ("you're good at X") commit at TURN-time (external authority, no
  aggregate needed); AUTONOMOUS experience-growth goes through the overnight gate.
Maps onto short-term staging → overnight consolidation (Accrete→Consolidate→Iterate); supersedes the drift-
causing reflection→self_model path; connects to [[self-awareness-roadmap]] (the 5-layer self-model becomes
this growing self object).

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

## EXISTING-MACHINERY IMPACT MAP (Lucas 2026-06-30 — "account for the tools we already have")
This architecture is ~70% EVOLVING existing modules, ~30% new. Built without this map we'd have spawned a
SECOND overnight pass competing with `runDailyPass`, a SECOND self-writer fighting `reflection.js` (undoing
its drift guards), and an idle compaction that silently strips the new object links. Three landmines. For
each existing system: role → object-model impact.

**Idle-tick (the graph-walk reshapes, doesn't replace):**
- `active_recall.js` — "what do I already know about X across all stores, BEFORE researching." ⭐ THIS IS
  ALREADY THE known→unknown pull. → Slice 1 EXTENDS it to a full OBJECT pull (get_entity + kg_neighborhood);
  do NOT build a new module.
- `subconscious.js` — tiered local/cloud triage + hourly budget. → PRESERVE the tiering; the graph-walk
  becomes the tick's CONTENT.
- `monologue.js` — the idle tick. → RESHAPE its SEEDING (walk graph objects with open gaps, not last-said).
- `interests.js` — the self-directed agenda the loop samples (the anti-drift store). → INTEGRATE: interests
  become the self-object's interest edges; the walk samples them to pick which object to work.
- `rumination.js` — semantic-loop guard. → PRESERVE as a backstop (the walk inherently reduces rumination).
- `curiosity.js` — boredom/curiosity → INTEGRATE (a curiosity edge to follow).

**Overnight / consolidation / IDLE COMPACTION:**
- `curateMonologue()` (every 20 min — the IDLE COMPACTION Lucas flagged) — compacts the thought stream. →
  EXTEND to PRESERVE the episode→entity links (the durable part) while compressing prose. ⚠️ the specific
  thing that would've silently broken.
- `cloud_curator.runDailyPass()` — THE overnight pass (near-dup merge, fact reconcile, graph adjudication) +
  the already-hooked promotion/retention. → "Overnight object reconciliation" is a STAGE INSIDE this, never
  a competing pass.
- `consolidate.js` (Mem0 extract-then-update) — → INTEGRATE (short-term object merge before promotion; Echo
  merge_entities does the long-term side).
- `meta.js` — runs inside the daily pass, bounded to top interests → INTEGRATE (operates on interest objects).
- `distill.js` — context tightening → PRESERVE (changes what's distilled, not that it is).

**Self / identity (the self-growth loop reworks, doesn't add):**
- `reflection.js` — ALREADY routes thoughts → self_model / knowledge / interests, WITH the drift guard
  ("a research-derived draw is curiosity, not identity → interests.reweight, not a self_model dump"). → The
  self-growth loop is a REWORK of reflection's TIMING (turn=stage, overnight=gate+commit); do NOT build a
  parallel self-writer or we double-write the self + undo its guards.
- `self_model.js` — the curated identity store (consolidated in place, always injected). → EVOLVE into the
  growing self OBJECT (skills/traits/interests as edges); consolidation logic already there.
- `self_dev.js` / `self_state.js` / `self_narrative.js` / `metacognition.js` — the 5-layer self-awareness
  stack. → PRESERVE; wire the self-object into them.

## Build slices (proposed order — each NAMES the module it touches)
1. **Object-level known→unknown pull** — EXTEND `active_recall.js` (not a new module): resolve target → Echo
   object → `get_entity` + bounded `kg_neighborhood` → structured facts + relations into short-term, the
   cheap first pass, for EVERY target. Fixes Curtis directly; highest value.
2. **Plan-driven executor** — refactor `lib/research.js` + `main.runDirectedResearchPass`: targets × facets
   loop (resolve → pull → diff → fill gaps → assemble), RETIRING the `discover`/`enrich` mode branches.
3. **Documents-as-objects** — EXTEND the Slice-2 promotion pass (`main.promoteDocumentsPass`): create the
   `document` object + `mentions` edges to its entities.
4. **Overnight object reconciliation** — a STAGE INSIDE `cloud_curator.runDailyPass` (not a new pass):
   promote short-term object DELTAS via propose→promote + merge.
5. **Idle loop as a grounded graph-walk** — RESHAPE `monologue.js`/`subconscious.js` seeding (sample
   `interests.js`, walk the highest-value object with open gaps, ONE step); keep `rumination.js` as backstop.
   Replaces free-association drift + restart-loops.
6. **Sources-as-objects** — the citation drawer / saved sites → `source`/`document` objects linked to their
   entities (ties [[verifiable-research-track]] Slice B); research reads attached sources BEFORE the web.
7. **Self-growth loop** — REWORK `reflection.js` timing (turn stages candidates; `runDailyPass` gates on the
   aggregate + integrates into the evolved `self_model` object). Supersedes reflection→self_model bleed;
   user-directed self-updates are the turn-time exception.
8. **Memory migration** — convert existing memory SELECTIVELY: SEMANTIC (knowledge/personal facts) → objects;
   EPISODIC (monologue) → linked episodes; SELF (self_model) → the growing self object. Not "objectify all."
9. **Reports as rendered views** of objects (deliverable pipeline sourced from the graph).

## Ties
[[zoe-is-the-memory]] (the graph IS her memory) · [[short-term-long-term-memory]] (the tiered pipeline, built)
· [[verifiable-research-track]] (plan + provenance + the executor) · [[research-execution-and-enrich]]
(the enrich/facet-fill work this generalizes). The drift finding (she wandered off Curtis into a video
mid-run) is a separate lane/focus-holding issue ([[interface-and-lanes-design]]), tracked apart from this.
