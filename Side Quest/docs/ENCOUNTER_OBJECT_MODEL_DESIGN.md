# Encounter → Object Model

**Status:** DESIGN. Nothing here is built. Authored 2026-07-20 from a working session with Lucas.
**Supersedes nothing.** Absorbs and unifies several things already built (see §12).

---

## 1. The philosophy

Lucas, verbatim:

> An object (person, place, thing, idea, event, concept) is real because it has been **encountered** in
> some fashion — news, research, conversation, doc drops. The program merges like objects, adding
> together all data gathered, and using any additional sources of validation of the object which
> increases its certainty. An object could have any number of validating sources connecting to it. The
> calls we use in this process are cheap **specifically because** we make so many.

And the purpose, which reframes everything downstream:

> Everything is connected to everything, and knowing those connections and being able to easily map and
> navigate them is the whole body of this work.

Two consequences that are easy to miss:

- **Volume is the strategy, not a cost to be minimised.** Many cheap calls is the design. Judging a
  sweep by "did it produce the thing I was looking for" is the wrong metric; the CPA extracted from a
  2021 audit PDF is not waste, it is an object with one validating source. If she runs for office in
  2029, her history is already mapped. *You cannot retroactively encounter the past.*
- **Rosters, contacts and coverage are entry points, not deliverables.** Coverage counts doors opened,
  not knowledge held. This demotes the coverage metrics built earlier this month from "the answer" to
  "one useful readout".

---

## 2. The primitive is the ENCOUNTER, not the object

Every lane — news, research, doc drop, conversation, meeting, API — writes encounters. Objects and
edges are *derived* from the encounter log; the log is the ground truth and is **append-only**.

```
encounter {
  object_type    person | place | org | event | concept | thing | document
  object_ref     resolved id, or provisional
  claim          what was asserted (attribute, edge, or bare existence)
  source_ref     document id / url / news item / turn id / meeting id
  source_origin  the INDEPENDENCE key — publisher, domain, content hash
  observed_at    the SOURCE's own date  ← not when we read it
  ingested_at    when we encountered it
}
```

`observed_at` vs `ingested_at` is load-bearing. Ingesting a 2021 PDF today must not let it outrank
genuinely current data. This is not currently captured anywhere (§11).

**Why append-only:** a wrong merge is the one unrecoverable failure. If encounters keep their own
identity, un-merging is possible. If they are folded into a single record at write time, it is not.

---

## 3. Objects, and Puller as a LAYER

```
ENCOUNTER LOG          universal, append-only
      ↓
OBJECTS (all types)    person · place · org · event · concept · thing · document
      ↓                edges carry their OWN certainty, independent of their endpoints
[PULLER LAYER]         people only: contact attributes, its own grading ladder
```

Lucas's correction, which resolved a design confusion: **Puller is not the housing, it is a layer that
adds contact information to person objects.** The universal substrate sits beneath it.

**Addresses are edges to Place objects, not string fields.** Fifty officials at one courthouse become
fifty edges to one Place. Correct it once, everyone is fixed; the Place accrues its own corroboration
independently; and geography becomes queryable without string-matching. The cost is honest — this needs
place resolution ("1234 Main St" vs "…Street, Suite 2" vs "PO Box 100").

**A document is both an object and a source.** Permitted, with one rule: a document may never
corroborate a claim it is itself the origin of, or every doc-derived fact gets a free +1.

---

## 4. Objects describe themselves — structure is a graded fact

> All of this work should help refine objects using their individual variables instead of trying to
> hard-code every possible one. — Lucas

A gap may only be asserted **where the object declares a slot.** "Eight parishes with no president on
file" is only a gap if those parishes *have* a president — many are run by a police jury whose
president is a juror, some by a parish manager, some by charter government.

So **expected structure is itself a researched, graded fact about the object**: seat count, which
offices exist, what the governing body is called. `lib/cardinality.js` is the first instance of this
(seat counts, refused without a source); it generalises to the whole shape of an object.

This also retro-justifies dropping the synthesised `bodyLabel` (commit `0ce3945`): rather than assuming
every parish has a "Parish Council", the object learns what it actually has.

---

## 5. Claim classes — grading is per class, not universal

Lucas was explicit that contact information and biographical facts are different, and they differ in
**update mechanics**, not just thresholds.

### 5a. Contact claims (email, phone) — DECAY

| Grade | Condition |
|---|---|
| A+ | verified (bounce-tested, reply, connect) |
| A  | 3+ independent sources |
| A− | official document + 1 independent |

Newer supersedes older. A phone stops being true when someone leaves.

### 5b. Biographical claims — ACCUMULATE

| Grade | Condition |
|---|---|
| A+ | official record + any 1 additional source |
| A− | official record alone |

**Never overwritten.** "CPA at Firm X, 2021" does not stop being true when she is elected in 2026 — it
becomes history. Contact overwrites; biography appends. Same object, opposite rules.

### 5c. Existence claims

Encountered → real. Corroboration raises certainty. Existence **never decays**: a 2021 document is
permanent evidence the person existed then, however stale their phone number is.

### 5d. Structural edges (`member_of`, `located_in`, `held_at`)

Observable and checkable. Ordinary corroboration applies.

### 5e. Interpretive edges (`about`, `relates_to`, `influenced_by`) — DIFFERENT

> N sources characterize is a better concept to follow — everything can be true until proven otherwise.
> — Lucas

"This speech was about election integrity" is a *judgment*, not an observation. Stored as **"N sources
characterized it this way"** — a fact about discourse — never as "it is this way". Otherwise three
summarisers reaching for the same word gets laundered into a Grade-A fact about the world.

### Open

Attribute **volatility classes** need pinning: immutable (birth, historical roles) · slow (name,
jurisdiction) · volatile (title, employer, committee) · volatile+verifiable (email, phone). Recency
weighting should scale with volatility.

---

## 6. Independence — reuse what the news lane already does

The formula is already in `lib/news_brief.js:33` and is correct:

```js
corroboration = Math.min(distinct outlets, distinct reports)
```

Bounded by **both**, so neither syndication (10 outlets / 1 wire story) nor one outlet publishing ten
articles inflates it. Generalised: `min(distinct origins, distinct texts)`.

Three rules on top:

1. **Synchrony is a flag, not corroboration.** Lucas: *"if all outlets say the same thing at the same
   time that should be a major flag."* The existing formula catches identical *text*; it does not catch
   ten outlets each re-wording one press release within an hour, which scores `min(10,10)=10`. Time
   dispersion is a separate signal and is **not currently computed anywhere.**
2. **Independence is scoped PER CLAIM.** One association directory is a single source, but it attests
   to 64 different parish facts — counting once for each. Repeat sources are *normal* when sweeping a
   state's local governments, not an anomaly.
3. **Source authority substitutes for roughly one source** (§5a): official + 1 = A−, three ordinary = A.

---

## 7. Conflicts are a WORK TRIGGER, not a state to display

Lucas's model, which is the part this design would not have reached on its own:

```
conflict detected
  → both values retained, side by side, with their sources
  → NOT surfaced to the user as "sources disagree"   ← internal thought process, not an answer
  → triggers a CLEANING RESEARCH PHASE to verify the dispute
  → resolved
  → the loser is written back as KNOWN-INCORRECT, permanently
```

Three properties:

- **Grade gates replacement.** An A+ well-sourced fact cannot be displaced by a partially-sourced B, or
  even by an A. Volume alone does not dethrone.
- **Nothing is deleted, ever.** A refuted claim stays, marked. In civic research *"X was reported to
  have done Y, later retracted"* is itself valuable — often more so than the claim would have been if
  true.
- **The known-incorrect record is inoculation.** Storing the disproven value means the same bad datum
  cannot silently re-enter and re-open a settled question. `studio/puller_negatives.js` already does
  this for bounced email; this generalises it to any claim.

**Most apparent conflicts are not conflicts.** A biographical fact is a *time-scoped assertion*:
`employed_at Firm X [2018→2023]` and `council member [2026→]` never collide. Bi-temporal validity makes
the common case vanish, leaving genuine conflicts rare enough to research properly.

**Boundary to confirm:** "never give that as an answer" is read here as *the dispute is never a dodge* —
she does not answer "some say X, some say Y" instead of answering. If asked directly whether something
is settled, saying it is under verification is still permitted, since the alternative is asserting a
contested fact with false confidence.

---

## 8. Concepts: edges, not buckets

A fixed concept hierarchy was proposed and **rejected**, for two reasons Lucas identified:

- **Newly minted concepts have nowhere to land.** A spine requires the bucket set to be complete at
  mint time. It never is.
- **"There's always a bigger fish."** AI is a huge bucket that still sits under computation, labour
  economics, geopolitics, energy — depending which way you face. Any hardwired top is an arbitrary cut
  we would then defend forever.

**Instead: concepts are objects; concept↔concept relations are typed edges.** A new concept does not
need a home, it needs links.

- Concepts get **salience, not certainty.** More sources do not make a concept truer; they make it
  weightier in the discourse. Salience **propagates upward** through `broader` edges.
- Hierarchy is **rendered, not stored.** "Show me AI" traverses `narrower` edges from that node ranked
  by salience, producing a tree-shaped *view* computed on demand from whichever root you chose. Face a
  different way, get a different tree, all of them true.
- **The LLM edge gate has two jobs, and the second matters more:** *type* the edge, and *refuse* most
  candidate edges. Relatedness is continuous — everything is somewhat related to everything — so
  without refusal pressure the graph saturates. It also needs to be **stable**: the same pair typed the
  same way next month, or navigation shifts underfoot.

---

## 9. The facet / lattice layer — how to navigate a hairball without pruning it

> I want the hairball, but I want the right way to navigate the hairball that also grows our map of the
> data. — Lucas

**Saturation is a read problem, not a write problem.** Pruning edges at write time destroys information
to compensate for a weak read path, irreversibly. Instead:

**Edges are self-weighting.** Under the encounter model every edge already carries a corroboration
count, so an edge asserted 40 times and one asserted once are distinguishable for free. Never prune —
**threshold at read time.**

**Facets turn quantity into structure.** 500 undifferentiated edges is a hairball; the same 500
decomposed is a menu:

```
Person A — 500 edges
  by type:  12 people · 3 places · 40 events · 5 concepts · 440 documents
  by time:  2019(8) 2020(31) … 2026(94)
  by grade: A+ 6 · A 40 · B 120 · C 334
```

Nothing removed; the neighbourhood became legible.

**And the index grows the map — three mechanisms:**

1. **Empty cells are gaps.** Decompose *(parish × office-type)* and the holes are visible — subject to
   §4: only where the object declares that slot. **`lib/coverage_gaps.js`, `lib/absence.js` and
   `lib/cardinality.js` are all hand-built special cases of "an empty cell in a lattice."** A general
   facet layer subsumes all three.
2. **Thin nodes are research triggers.** A node with few edges or low certainty sitting where traffic
   flows is underdeveloped — navigation becomes an allocation signal.
3. **Dense co-occurrence proposes edges.** Two concepts repeatedly landing in the same cells without a
   direct edge is the index suggesting one exists. The index reads the graph *and* proposes additions.

**Costs, honestly:** write amplification on every encounter; dimension choice is a real modelling
decision; and a full cube over N dimensions is exponential, so index *selected* combinations. That is
what "variable by neighbourhood" means — index densely where traffic and density justify it, leave
sparse civic regions as plain graph.

---

## 10. Prior art worth integrating (spot-checked, not deep-researched)

| Need | Prior art | Fit |
|---|---|---|
| Concept edges, no fixed tree | **SKOS** (W3C) | `broader` / `narrower` / `related` + explicit **polyhierarchy** — this is literally §8, standardised. Also gives cross-scheme mapping (`exactMatch`, `closeMatch`, `broadMatch`) for reconciling our concepts with external vocabularies. |
| The encounter log | **PROV-O** (W3C) | Entity / Activity / Agent + `wasDerivedFrom`, `wasAttributedTo`, `wasAssociatedWith`. An encounter is an Activity; a document an Entity; a publisher an Agent. Adopting its vocabulary makes provenance interoperable rather than bespoke. |
| Merge safety at scale | **Splink** (UK MoJ, open source) | Fellegi-Sunter probabilistic record linkage, **DuckDB backend**, proven past 100M records. DuckDB is already in this stack. Directly applicable to the person/place resolution problem. |
| Conflict resolution | **Truth-discovery literature** | Established finding: **majority voting is wrong on up to ~30% of items**; you must weight by *source reliability*, not count. Validates §5–§7 — "3 sources" alone is not enough. Also distinguishes single-truth from multi-truth items (a person has one birth date but may hold several roles). Copy-detection between sources is a known sub-problem in this literature and maps to §6's synchrony flag. |

**Read:** SKOS and PROV-O should be adopted as *vocabularies* even if we do not adopt RDF wholesale —
they are free, thought-through answers to two problems we would otherwise invent badly. Splink is a
candidate implementation, not a design commitment. The truth-discovery literature is worth a real read
before finalising §7's resolution rule.

---

## 11. Measured blockers (real, in the current data)

1. **The corpus is 11.6% duplicate.** 461 groups of byte-identical bodies, 771 redundant copies, one
   PDF stored ×18. This *already* inflates corroboration: `Melissa Bosch` shows `doc_count = 5` from
   only **3 distinct texts**. → **Content-hash origin is mandatory, not a refinement.** It is also the
   cheapest tier and would fix this outright. Separately, the duplication itself is an ingestion bug.
2. **Documents do not record their origin.** Columns are `id, title, body, source, ref, …` where
   `source` is the *lane* (`browser_download` / `news` / `research`), and **0 of 77 research documents
   carry a URL**. Origin-independence is therefore *uncomputable* for document-derived facts —
   `min(origins, texts)` can only evaluate half of itself. **Likely prerequisite to everything else:**
   every fact ingested before this is fixed is permanently ungradeable.
3. **Image-only PDF content never decodes** (PDF.js cannot initialise OpenJPEG). A silent class of
   never-encountered objects — a scanned roster is indistinguishable from a body with no roster.

---

## 12. Relationship to what already exists

**Absorbed / generalised by this design:** `lib/coverage_gaps.js`, `lib/absence.js`,
`lib/cardinality.js` (all → empty cells in the facet layer, §9); `lib/body_key.js` (→ object identity);
`lib/news_brief.js` corroboration (→ the independence formula, §6, promoted from news-only to
universal); `studio/puller_negatives.js` (→ known-incorrect records, §7).

**Re-scoped:** `lib/doc_contacts.js` (commit `08fcc21`) built a *people-contact* store, which is the
Puller's job. Its scan-ledger and extraction lane remain correct; the store should collapse into the
Puller layer once the universal substrate exists.

**Unchanged and still needed:** the entity-resolution / fusion gate work, the concept focal-wells
(as a starting seed for §8's edges), the temporal substrate (events already carry it).

---

## 13. Open questions

1. **Volatility classes** for attributes (§5) — the exact set, and how recency weighting scales.
2. **Refutation bar** (§7) — should demoting a claim require an A-grade source, so a weak claim can
   never dethrone a well-sourced one?
3. **New substrate vs. absorption into Echo's KG.** Lucas: *"It might need to be both."* Some of this is
   ordinary graph object creation and linking; the facet layer may want a different structure per
   concept or neighbourhood. This is the migration-vs-addition decision and it sets the timeline.
4. **Which facet dimensions**, and the density threshold at which a neighbourhood earns an index.
5. **Concept edge-gate stability** — how to keep the same pair typed the same way over time.
