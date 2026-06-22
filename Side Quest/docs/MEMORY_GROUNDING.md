# Zoe Memory Grounding — graph memory, epistemic typing, anti-glob

_Authored 2026-06-22. Design + build doc for fixing the "roving obsession / incoherent-slop" failure._

## The failure ("the glob")

In idle monologue Zoe blends disparate pieces — an anticipated-but-unconfirmed item ("Madeline was expected at the meeting"), a meeting fact, an unrelated reading (Coast Guard AI procurement) — into one incoherent paragraph asserting false connections, and loses track of what *happened* vs. what was *anticipated* vs. what she *read* vs. what she *thinks*.

## Root cause (confirmed against live DB + code)

A closed, self-feeding loop with no epistemic grounding:

```
thought ──► curiosity web-searches her OWN sentence fragment ──► "reading"
   ▲                                                              │
   └──── retrieved as "fact" ◄── reflection.js distills it ◄──────┘
                                  (stored kind:note, importance 0.75)
```

- **Defect 1 — no external anchor.** Curiosity searches her own speculations (live DB shows DuckDuckGo URLs that are her own sentences). Nothing that could contradict her enters.
- **Defect 2 — no epistemic typing.** Every `knowledge` row is `kind:note / level:fact`. No witnessed / told / read / speculated / anticipated distinction; no episodic event to reconcile against. She *can't* represent "Madeline didn't show."
- **Defect 3 — speculation laundering.** `reflection.js` mints her own associations into facts at importance 0.75, which dominate retrieval and become the only stable attractor — the obsession.

## Research backing

- **Model collapse** on recursive self-generated data — errors compound, distribution tails vanish (Shumailov, *Nature* 2024, s41586-024-07566-y).
- **Self-Consuming Generative Models Go MAD** — without fresh real data each generation, quality/diversity collapse toward one mode; "sampling bias" narrows diversity (arxiv 2307.01850).
- **Context poisoning / compounded hallucination loops** — a hallucination becomes context, retrieval spuriously corroborates it, confidence rises; "a reflection module under the same biases as the generator approves its own errors → divergence."
- **CoALA** (arxiv 2309.02427) — separate episodic / semantic / procedural memory; reflection turns episodic → semantic. Notes provenance is an unsolved gap.
- **Generative Agents** (Park 2023) — timestamped observation stream; reflections derive from observations.
- **KG grounding reduces hallucination** — explicit entity-relation edges constrain free-association (GraphRAG, arxiv 2502.13247).
- **Zep / Graphiti** (arxiv 2501.13956) — temporal KG for agent memory: facts as entity-relations with valid-time + ingestion-time, every fact traces to its source episode. This is the productized target.

## Architecture (CoALA, Zoe-owned)

Zoe's memory is **her own, self-contained** — Echo can be retired or upgraded without breaking her. She copies Echo's KG *pattern* (proven against small-model benchmarks; she runs a local 24B) and writes it in the **same structure** so her graph maps ~1:1 onto Echo's databases for clean federation when she wears the suit — by construction, with zero coupling.

- **Semantic** = her own Echo-shaped entity/relation graph (this doc).
- **Episodic** = meetings/experiences (the G-Meet recap is brick one); expected-vs-present reconciliation via valid-time/supersede.
- **Self/speculative + procedural** = typed; speculation NEVER promoted to fact without grounding.

### Echo's pattern being mirrored (`echo/store.py`)

`entities` (typed, confidence, proposed_by) · `relations` (typed, soft-delete) · `sources` (url/content/fetched_at) · `source_citations` (cite chain w/ quoted_text) · `entity_proposals`/`relation_proposals` (propose→approve gate) · `kg_node_history` (temporal). Types are open TEXT with a whitelist enforced in code, not a schema CHECK.

### Zoe's schema (Phase 1)

```
graph_entities    id, name, name_key(unique-normalized), entity_type, entity_subtype,
                  summary, confidence, epistemic, confirmed, proposed_by, created_at, updated_at
graph_relations   id, source_id→, target_id→, relation_type, confidence, epistemic, confirmed,
                  proposed_by, created_at, valid_from, valid_to, deleted   UNIQUE(src,tgt,type)
graph_sources     id, kind(user|meeting|reading|web|conversation|own_thought), ref, excerpt, fetched_at
graph_citations   source_id→, fact_kind('entity'|'relation'), fact_id, quoted_text
graph_entity_proposals / graph_relation_proposals  (propose→promote gate; status pending|promoted|rejected)
```

`epistemic ∈ witnessed | told | read | speculated | anticipated`. `confirmed` (NULL|0|1) reconciles `anticipated`.

### The four defects, killed

1. **Laundering** → reflection *proposes*; only source-grounded (told/witnessed/read) entries promote to canonical. `speculated` never promotes and is never retrieved as fact.
2. **Self-feeding loop** → curiosity/reflection query the graph (real edges), search target entities not her own sentences.
3. **No typing** → `epistemic` field; retrieval ranks told/witnessed ≫ speculated.
4. **Madeline** → `Madeline —[expected_attendee]→ MeetingX`, epistemic `anticipated`, `confirmed=NULL`; the episodic meeting record flips `confirmed=0` + sets `valid_to`. She can now know "expected but absent."

**Federation bonus:** shared `entity_type`/`relation_type` vocab + column shape → her graph unions with Echo's (same names resolve, same relations merge) with no coupling.

## Phased build (status 2026-06-22 — each gated on a passing hard smoke)

- **Phase 1 ✅** schema + propose/promote gate + epistemic typing (`lib/db.js`, `lib/graph_memory.js`). `smoke_graph_memory.js` 21/21. Flat `knowledge` store runs in parallel.
- **Phase 2 ✅** de-laundered `reflection.js`: ungrounded (own-thought) takeaways → gated graph proposals, never 0.75 facts; grounded (reading/URL) → real facts. `smoke_reflection_delaunder.js` 11/11.
- **Phase 3 ✅** `graph_memory.factsForPrompt()` (grounded-only, trust-ranked, refuted/speculation excluded) + `monologue.looksLikeOwnFragment()` (boredom search no longer fires on her own introspective sentences). `smoke_graph_phase3.js` 14/14.
- **Phase 4 ✅** `graph_memory.reconcileAttendance()` + gmeet present-speaker capture → end-of-meeting reconciliation; expected-but-absent (Madeline) → refuted + superseded. `smoke_graph_phase4.js` 10/10. (Expected-attendee capture rides on the calendar source — parked; present alone already grounds attendance.)
- **Phase 5 ⏳ (blocked on Echo)** federation — union her graph with Echo's KG. Needs the live Echo MCP connection (the larger integration). Not started.

**Not yet done (follow-ups):** (a) one-time cleanup migration of the existing laundered facts (knowledge #580-702); (b) wiring `factsForPrompt()` into the live chat/idle prompts (currently a primitive, not yet injected); (c) structured entity/relation extraction from grounded readings into the graph (today only reflection-speculation + meeting attendance populate it).
