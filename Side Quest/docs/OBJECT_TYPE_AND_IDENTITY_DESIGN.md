# Object Type and Identity — Design

**Status:** DESIGN. Nothing here is built. Authored 2026-07-20 from a working session with Lucas.
**Extends** `docs/ENCOUNTER_OBJECT_MODEL_DESIGN.md` (§3 objects, §4 objects describe themselves, §5 claim
classes, §7 conflicts). **Adjacent to** `docs/NODE_RESOLUTION_FUSION_GATE_DESIGN.md`, which already
diagnosed isolated nodes and resolver ambiguity as one disease — this is another face of it.

---

## 1. What started this

Lucas, looking at a card in the UI:

> **FULTON COUNTY** — Organization
> `FULTON COUNTY [lda_client:206504]  source: refresh:lda_lobbyists:refresh`
>
> "I just want to make sure we don't run into any issues with mislabeling."

Fulton County is a county **government**. It is typed `Organization` because it arrived through the LDA
lobbying-disclosure feed, where every *client* is an organization by that schema's own convention. The
**role it appeared in became its type.**

That single card is the whole problem in miniature, and the measurement behind it is worse.

---

## 2. What is actually in the database

### 2a. `graph_entities` is effectively single-typed

```
13,058 entities
13,033 typed "concept"          99.8%
   511 of those carry a STRONG ID (lda_client / FEC / Wikidata)
    97 named like companies      (INC, LLC, PBC, CORPORATION)
   318 named like governments    (COUNTY, CITY OF, PARISH, DEPARTMENT)
```

Typed `concept`, in the live data:

```
GARMIN INTERNATIONAL, INC. [lda_client:59154]
GENERAL MOTORS COMPANY [lda_client:208777]
ANTHROPIC, PBC [lda_client:66450]
Manatee County
Commissioners of Boundary County
```

**A concept does not have a lobbying-client ID.** 511 of them do.

Source of the flood: `proposed_by = graph-walk-shortterm` (11,732) and `reading-extract` (1,277). The
graph-walk mints whatever it encounters into the concept store regardless of what it is.

### 2a-i. Nobody decided these were concepts

Lucas asked the right question: *did a model decide what they should be labelled, or a blind
programmatic run — and why weren't they compared to existing nodes or to wiki data?*

The answer is a third thing, and it is worse than either. `lib/graph_memory.js:69`:

```js
function recordEntity({ name, type = 'concept', … })
```

and the relation writer, line 132-133, which is what the graph-walk actually calls:

```js
const se = recordEntity({ name: sName, epistemic, proposedBy });   // no type argument
const te = recordEntity({ name: tName, epistemic, proposedBy });   // no type argument
```

**No classification ran.** `concept` is a JavaScript default parameter that this call site never
overrides. `GENERAL MOTORS COMPANY` was not judged to be a concept — it was never judged at all.

Existing nodes *are* consulted (`db.graphGetEntityByKey(nameKey)`, line 86), and the merge rule is
already defensive in the right direction:

```js
if (type && type !== 'concept' && existing.entity_type === 'concept') fields.entity_type = type;
```

A real type **upgrades** a stored `concept`; a `concept` never overwrites a real type. So the damage is
inertia, not corruption — nothing correctly typed has been clobbered, and T4 is correspondingly safer.
But because this path always passes `type === undefined`, the guard can never fire to upgrade anything
either. **No Wikidata or wiki-text validation occurs on this path at all.**

### 2a-ii. Validation order for the backfill

When something is finally asked to decide, ask in this order — cheapest and most authoritative first:

1. **The strong ID already in the name.** 511 of these carry `wd:Q…`, `lda_client:…`, `FEC:C…`. A QID
   resolves to an authoritative type with **no model call** — the same machinery as the existing
   reversible `wikidata_org_resolve` background job, pointed at type.
2. **A typed sibling.** `graphGetEntityByKey` already runs on every write; it simply has nothing to
   inherit from yet. Once any copy of a name is correctly typed, the rest follow.
3. **A cloud call for the remainder** — no strong ID, no typed sibling. Batch to the extraction model
   that already emits `ENTITY: <name> :: <type>` and gets it right (`government_body` 37,
   `organization` 149 in the O1 sample).

**A cloud call PROPOSES a type; it never sets one.** Under §5 the type is a claim, so the model's answer
competes with Wikidata's and with a `.gov` roster's, and the better-sourced one wins. A wrong model
answer is then recoverable rather than baked in — which is the entire reason type stops being a column.

### 2b. The encounter log collapses three types into one

`lib/decomp_encounters.js` TYPE_MAP, written in W2:

```js
organization: 'org',  committee: 'org',  government_body: 'org',
```

The extractor **already distinguishes them** — measured in `kg_observations.entity_type` after O1 made
the type persist: `organization` 149 · `government_body` 37 · `committee` 6. The encounter log throws
that away. Result: 137 distinct `org` objects where a county board and a restaurant are the same kind
of thing.

```
government                    commercial                  civic / other
Kent County Sheriff's office  Anheuser–Busch, Inc.        California Walnut Commission
Appling County Commissioners  SPEEDWAY #6528              Citrus County Fair Association
City of Pearson               TWO GUYS FROM ITALY         Kent Youth Volleyball League
Borough of Brooklyn           CDM SMITH INC. NATIONAL PAC Resident Advisory Committee
```

### 2c. Identity is fragmenting on strong IDs

```
291 entities whose name differs ONLY by a strong-id suffix → 299 redundant rows
    duke energy               (bare) · [Q1264404]
    microsoft                 (bare) · [Q2283]
    richard nixon             (bare) · [N000116]
    george mason university   (bare) · [Q1411222]
```

Only **438 of 13,082** carry a strong ID at all. `ANTHROPIC, PBC` appears three times under three
different `lda_client` ids.

---

## 3. Why mislabeling is not cosmetic

**The type is part of the identity key.** `org:fulton county`, `gov:fulton county` and
`concept:fulton county` are three different objects. So a wrong type is a wrong object, with three
consequences already visible in the data:

1. **The same real thing exists under several types and nothing can merge them.** Merging across types
   is exactly what O2 forbids to prevent false merges — correctly, in general, and it means a
   mistyped object is stranded permanently.
2. **Authority cannot be derived (§6.3).** A county government is authoritative for its own roster; a
   lobbying client is not a category that says anything about authority. Authority is currently read
   off the publisher's domain, which only works when a document was fetched from a `.gov`.
3. **Declares-a-slot breaks (§4).** A governing body declares seats — that is what `cardinality.js`
   and coverage-gap detection key on. A "concept" declares nothing, so those 318 governments are
   invisible to gap detection.

---

## 4. The decision: ONE graph, typed correctly

Lucas asked it directly: *can concepts, places and events live in the same graph if they are labelled
correctly, or should they be separated and linked by properly-labelled edges?*

**One graph.** Separated stores would be the wrong trade here, on this system's own evidence.

The purpose statement settles the first half — *"everything is connected to everything, and knowing
those connections and being able to navigate them is the whole body of this work."* Separate stores
turn every cross-type traversal into a federated join somebody has to remember to write.

And the measured failure history here is overwhelmingly about **separation, not mislabeling**:

| failure | cause |
|---|---|
| 1,468 parish contacts invisible | `gatherHeldContacts` read Puller + CRM, never `documents` |
| `localdb` reached 1 database of 6 | the other five were never attached |
| coverage saw 63% of its own work | it read one thread per beat |
| `doc_contacts` duplicates Puller | a second people store the design says should collapse in |

Every one was a store nobody thought to query. **A mislabel is visible** — Lucas found Fulton County by
looking at it. **A wrong store is invisible**: nothing shows you the record you did not join to.

### 4a. Where separation IS right

Per-type **enrichment layers** — contact testing and bounce ledgers, face embeddings, geocoding,
concept salience. Those are pipelines with their own working state and are per-type by nature. That is
precisely what the Puller already is, and §3 already calls it *"a layer, not the housing"*.

**One graph of objects and edges; specialised layers hanging off it.**

---

## 5. Type is a CLAIM, not a column

This is the part that actually fixes Fulton County.

Today type is a column, so **the first writer wins forever**. `graph-walk-shortterm` stamped `concept`
on 11,732 objects and nothing can dispute it. LDA stamped `organization` on Fulton County and nothing
can dispute that either.

But *"Fulton County is an organization"* **is a claim** — and by the LDA schema's lights it is even a
true one, because in that feed "client" is an organizational role. It is simply weaker evidence about
what Fulton County *is* than a county roster would be.

So type goes in the encounter log like any other claim, and §5/§7 already say what happens:

```
LDA feed          → type = organization      (ordinary, role-derived)
county .gov roster → type = government_body  (official)
                   → they COMPETE; the better-sourced wins; the loser is RETAINED
```

Nobody has to decide at write time who is right. The grading ladder already does it, and a later
official source can correct the record without a migration.

**Type is single-truth** (§5): an object is one kind of thing, so competing types genuinely conflict and
`contested` / `cleaning` apply — unlike roles, which accumulate. Fulton County *is* a government AND
*acts as* a lobbying client; the first is its type, the second is an edge.

---

## 6. The tension this creates, and how it resolves

**Type is currently part of the identity key** (W2). If type can change, the key cannot depend on it.
But the reason it is in the key is real: it stops "Apache County the place" false-merging with "Apache
County the org".

**Resolution: prefer a STRONG ID; fall back to type+name.**

`lib/entity_match.js` already parses `lda_client:`, `FEC:C…`, `wd:Q…`, `ocd-`, openstates UUIDs. A
strong ID *is* an identity — it survives a type correction, and it is what lets the 291 fragmenting
names (`duke energy` vs `duke energy [Q1264404]`) merge at last.

```
identity = strongId(name)                 when present   ← survives re-typing
         = `${type}:${normalisedName}`    otherwise      ← a bare name is not an identity
```

A bare name genuinely is not an identity, which is why the fallback keeps the type in it — and why
re-typing an object *without* a strong ID must be a migration, not a silent update.

---

## 7. Build order (proposed)

Each slice ships its own smoke, the full gate, **and a live-data probe** — every real defect in the
2026-07-20 run was caught by measuring live, never by a green suite.

**T1 — stop discarding what we already have.** `government_body → gov`, `committee → body`,
`organization → org` in TYPE_MAP. Zero inference, uses the extractor's own call. Affects material typed
after O1 only. *Probe: a county board and a restaurant no longer share a type.*

**T2 — strong-ID identity.** `objectKey` prefers a parsed strong ID over `type:name`. Reuses
`entity_match`. *Probe: the 291 name-only/strong-id pairs collapse; nothing else does.*

**T3 — type as a claim.** Record `type` as a single-truth claim in the encounter log, graded per §5.
`objectType(key)` reads the winner. *Probe: LDA's `organization` loses to a `.gov` `government_body` on
the same object, and the LDA claim is retained.*

**T4 — the 13,033 migration.** Re-type `graph_entities` from the winning type claim. Dry-run first,
print every change, keep the old value. Only where evidence supports it — an object with no type claim
stays as it is rather than being guessed. *Probe: the 318 government-named and 97 company-named
concepts are re-typed or explicitly listed as unresolved.*

**T5 — the minting gate.** Fix the source: `graph-walk-shortterm` should not mint a `concept` for
something carrying a lobbying-client ID. *Probe: no new strong-ID-bearing concepts appear after a
restart.*

### Open questions

- Does `gov` need sub-types (county / municipal / state / federal / special-district)? `NORTHERN
  CALIFORNIA POWER AGENCY` is a joint-powers agency; `NATIONAL TRUST FOR HISTORIC PRESERVATION` is
  congressionally chartered. Neither is cleanly public or private.
- Should a name-based classifier ever set type, or only ever *propose* one for the grader? The existing
  `isGovernmentCompany` gets 52 of 137 and misses `United States Postal Service` — evidence for
  propose-only. **Settled in §2a-ii: propose-only, for every classifier including the cloud.**
- What re-types the pre-O1 backlog, where no type was ever captured? Re-running extraction is a real
  model spend and is Lucas's call.

---

## 8. What this does NOT change

- **Puller stays a layer.** People keep their specific enrichment; it hangs off the person object.
- **O2's refusal list stands.** `Adams` ≠ `Adams County`; a wrong merge is still the unrecoverable
  failure, and a strong ID does not license loosening the name rules.
- **Nothing is deleted.** A superseded type is retained like any other losing claim (§7).
