# Curation Substrate — cited, qualified knowledge ingestion

**Status:** SPEC + **Slices 0, 0.5 & 1 BUILT + LIVE-PROVEN** (gate-129 green; Slice 1's observe→store path verified writing to the live `sq.db`) — 2026-07-04, branch `feature/idle-passive-intelligence`.
Author: this session, with Lucas.
**One line:** every data stream that introduces entities/facts flows through ONE cited path —
`observation → qualify() → two-gate promotion → Echo`. Nothing reaches the graph uncited.

> **What's live (feed #1, the idle graph-walk):** `lib/curation_gate.js` grades every claim on the Puller
> A/B/C/D ladder and gates it — cited (≥B) promotes, inferred (D) is HELD, a missing anchor with no
> citable source is never minted. Source acquisition is WEB-FIRST (`graph_walk.fetchLayeredSources`): live
> Wikipedia fetch → local Echo corpus → web search; DDG scraping retired. Live proof: `Francis Lindquist`
> enriched with 4 grade-B facts each cited to `en.wikipedia.org/wiki/Francis_Lindquist`. Gate: 129 suites.
> **Slice 1 (durable store) BUILT + LIVE-PROVEN:** every graded claim — promoted or held — now lands a
> row in `kg_observations` via `lib/curation_store`, so the trail is provable and held claims queue for
> enrichment. `observe()` no longer just logs; verified writing to the live `sq.db` post-reboot.

---

## 1. First principle (non-negotiable)

**Never mint an object the system can't cite as real.** "Requires citation" is enforced
*structurally*, at the substrate, not by prompt convention. A fact — an entity's existence, or a
relation between two — enters Echo only carrying a source, and its confidence *is* the quality of
that source.

This is the strongest possible answer to the confabulation risk: the failure mode is a model
inventing a non-existent entity or an unsupported edge; the existence/fact gates make that
impossible to promote.

---

## 2. Two orthogonal axes (Lucas's clarification)

The mistake to avoid is conflating "how real" with "how much we know."

- **Reality (existence)** — *is this a real entity?* Binary-ish, citation-gated. Confirming
  "James Inhofe is in fact a real senator" makes the OBJECT real.
- **Richness (thin ↔ rich)** — *how developed is it?* A completely separate axis
  (`graph_walk.classifyObject`: degree/facts/committees). A confirmed-real object can be
  **extremely thin**. **Thin ≠ unreal.**

So "real but extremely thin" is a first-class state: a legitimate node with almost no edges.
The `thin/rich` classifier decides *what to enrich* — never *whether it's real*.

### Two gates, not one
1. **Existence gate** — fires when an object is *created* (`classifyObject → 'missing'`, or a new
   entity extracted from a document). Create only with an existence citation → enters as
   **real-but-thin**. No citable source → hold as a candidate, do not mint.
2. **Fact gate** — fires on every proposed relation/fact. Attach only with its own citation.

Existence-confirmed nodes are the enrichment targets (e.g. Inhofe's Wikipedia anchor `Q723134`
*is* his existence citation — don't re-confirm, just add cited facts).

---

## 3. The isomorphism — why Puller is the substrate

The graph object model and Puller's contact model are the **same shape**:

| Graph | Puller |
|---|---|
| object exists → **real** | `target` `adhoc → promoted` |
| a fact / relation | a `belief` (one active per (target, type), qualified per value) |
| the citation backing it | an `observation` (`source`, `source_url`, `source_date`, `confidence`) |
| the approval gate | `revisions` (propose → approve; destructive flips await decision) |

So folding streams "through Puller" isn't a bolt-on — it's routing isomorphic data through the
engine already built for it.

### The shared qualifier: `studio/puller_confidence.qualify()` (PURE, smoke-tested)
A deterministic **capped ratchet over an evidence-grade ladder**. `confidence = the cap of the
highest-grade SOURCE present`. Corroborating sources are listed but never push past the cap. A
negative caps down + flags conflict.

```
A  100%  official dedicated source     (business card / official directory / owner-confirmed)
B   95%  independently verified        (mail-server deliverable OR named in a PRIMARY SOURCE)
C   80%  pattern-confirmed
D   50%  best-guess / derived          (inferred, no source)
E   30%  generic / unconfirmed
neg ≤20% bounce / invalid / contradicted
```

**"Confidence is a SEND-SAFETY statement, not a probability"** — because whatever promotes gets
*used* (thought from, forecast on, acted on). Conservative by mandate.

**Grade mapping for knowledge (translation of the contact ladder):**
- **A** — an authoritative structured record (official registry, Wikidata/Wikipedia anchor, a
  primary/official document).
- **B** — the fact is *directly stated* in a named source (a document passage, an official page).
- **C** — corroborated by multiple secondary web sources but no single authoritative one.
- **D** — a model *inference* not directly stated in any source. (Enrichment fuel, but gated.)
- **E** — bare mention, no supporting content.
- **neg** — a source contradicts it → cap down, flag, force re-derivation.

---

## 4. The pipeline (every feed shares this)

```
 raw stream item
   │
   ▼  extract typed entities + relations, EACH tagged with its source
 observation(s)     source=<stream>, source_url=<citation>, kind=<grade signal>, confidence
   │
   ▼  puller_confidence.qualify(observations, value)   → grade + send-confidence
 EXISTENCE gate:  object real? (existence obs ≥ floor)   → mint real-but-thin | hold candidate
 FACT gate:       edge cited?  (fact obs ≥ floor)         → attach | hold in revisions
   │
   ▼  promote (propose_entity / propose_relation WITH the citation attached)
 Echo graph  (markdown `## Related` + entities txn; relations reindex on curation pass)
```

Key change vs. today: `propose_entity`/`propose_relation` carry **no source field**
(`additionalProperties:false`). Citation must be recorded alongside — via Puller observations
(the home of record) and Echo's `record_web_source` / `cite_knowledge_source` / `get_sources_for`
linking the source to the promoted node.

---

## 5. The feeds and how each maps

All produce entities/facts → all fold in. Forecasting is a **consumer** (own sub-DB, still being
built) — it reads the curated result, it does not feed the substrate.

| # | Feed | Source citation | Notes |
|---|---|---|---|
| 1 | **Idle graph-walk** (web-enrichment) — **CITATION-GATED + WEB-FIRST, LIVE; durable trail BUILT** | live Wikipedia / local corpus URL (grade B) | Slice 0 + 0.5 + 1 done; `curation_gate` + `fetchLayeredSources` + `curation_store` (`kg_observations`); DDG retired |
| 2 | **Document decomposition** | the document itself (grade A/B) | citation-native, highest-yield; `graph_extract` seed + Echo `extract_entities_from_doc` |
| 3 | **Directed research / contract** | the research source | contacts already Puller-bridged (`puller_add`) |
| 4 | **News / data-stream lane** | outlet(s); corroboration=min(outlets,reports) | events + principals; email intake included |
| 5 | **Meetings / transcription** | the transcript + speaker id | attend-sessions → speakers/entities/facts |
| 6 | **Reconciliation** | the correcting source | already citation-mandatory; fits `neg`/supersede natively |
| 7 | **Calendar** | the calendar event | events as a data surface |

**Exempt:** Forecasting (consumer). **Flagged:** the **API management stream** produces *numeric
datasets* (FRED/Census), not people/events — it carries provenance (source = the API) but does not
fit the existence/thinness entity gates; treat as cited-provenance-only, forecast-coupled, unless
later pulled fully in.

**Document decomposition detail** — the new design work vs. reuse:
- Point extraction at **document-type objects already in the graph** (the wikiquote "Woodrow
  Wilson", news-headline entities), not just fresh external reads. Turns dead-end doc leaves into
  subgraphs of the real people/events/places they describe.
- Emit **typed** objects (person/event/location/org) — `graph_extract` is generic-triple today.
- **Disambiguate on ingest** — extracted "Woodrow Wilson" must resolve to the existing person, not
  a fourth dup (the resolution problem already hit; reuse `echo_suit.recallObject`).
- **Volume discipline** — one doc yields many entities; same budget/gating as the graph-walk.

---

## 6. Open decisions (Lucas's call)

1. **Promotion threshold.** Auto-promote at grade ≥ B (cited/verified) and hold grade-D
   inferences in `revisions` for approval? Or route *everything* through `revisions` initially
   while the grades calibrate? *(Recommend: auto ≥ B, hold ≤ D.)*
2. **Corroboration.** Do N independent grade-C/D web sources on the same fact bump it toward a
   higher grade, or keep Puller's strict "cap = best single source" (corroboration listed, never
   exceeds cap)? *(Recommend: keep strict cap; corroboration raises confidence WITHIN a grade, not
   across — matches the existing ratchet.)*
3. **Existence floor.** Minimum grade to mint a NEW object (vs. hold as candidate). *(Recommend:
   ≥ C — named in ≥1 real source; a pure D inference never mints an entity.)*

---

## 7. Slicing plan (build order)

- **Slice 0 — retrofit citations on the live graph-walk. ✅ DONE + LIVE-PROVEN.** `lib/curation_gate.js`
  (pure): `gradeForClaim` ([S#]→B / inferred→D), `gateFact` (≥B promote), `gateExistence`/`gateAnchorExistence`
  (≥C mint). Dossier cites each claim; `growAround` gates every claim (uncited→held) + emits `observe()`
  (grade + url) per promoted fact (logs `[cite]`). The three locked decisions above are implemented as
  `FACT_FLOOR='B'`, `EXISTENCE_FLOOR='C'`, strict single-source cap.
- **Slice 0.5 — web-first source acquisition. ✅ DONE + LIVE-PROVEN.** `graph_walk.fetchLayeredSources`
  (pure): live Wikipedia fetch → local Echo corpus (`recallKnowledge`) → web search last-resort; every
  source carries a url. Retired DDG scraping (was throttling to `sources=0`).
- **Slice 1 — the durable observation STORE. ✅ BUILT + LIVE-PROVEN (gate 129 green; observe→store path verified writing to the live `sq.db` post-reboot).**
  `kg_observations` table + `lib/curation_store` (pure, db-injected): `record`/`recordMany`/`list`/
  `stats`/`heldFor`, idempotent on `obs_key`. `observe()` now persists (feed-tagged) instead of only
  logging, recording BOTH promoted and HELD claims (the held set is the enrichment queue). The shared
  qualifier (`puller_confidence`) and the two gates (`curation_gate`) were already the reusable grading
  step; `curation_store.fromContact()` generalizes the Puller contact bridge into the same trail. *(NEXT:
  live-verify post-reboot, then Slice 2.)*
- **Slice 2 — document decomposition.** Extend `graph_extract` to typed objects + doc-object
  input + disambiguation; route through the gate. (Highest-yield feed.)
- **Slice 3+ — fold the remaining streams** one at a time (news → meetings → reconciliation →
  calendar), each converted to emit graded/cited observations into the shared gate.

Each slice: pure + deps-injected where possible, offline smoke, gate green, reboot-gated verify.

---

## 8. Related memory
[[subconscious-graph-builder]] (the live graph-walk) · [[reconciliation-core]] (citation-mandatory
corroboration) · [[research-contract-canvas]] (Puller contacts bridge) ·
[[verifiable-research-track]] (trust not speed) · [[cloud-curation-roadmap]] ·
[[mention-extraction-tiered]] (extraction infra) · [[data-stream-lane]] (news feeds).
