# Slice 2 — the Decomposition Front Door (utterance → {objects, relations, intent})

Spec for the object-memory architecture, Slice 2. Supersedes the old "plan-driven executor" one-liner.
Companion: [OBJECT_MEMORY_ARCHITECTURE.md](OBJECT_MEMORY_ARCHITECTURE.md) (the synthesis),
[OBJECT_FLOW_REFERENCE.md](OBJECT_FLOW_REFERENCE.md) (base code + Echo ground truth). Status: SPEC — not built.

## 1. Goal

ONE decomposition pass turns ANY utterance into a structured `{objects, relations, intent, constraints}`
plan, replacing the pile of per-scenario recognizers. Externally validated (frame semantics / AMR /
Dialogue-MR / joint-vs-modular scaling — see the research this session). The plan's `objects` feed the
Slice-1 object pull (now with a KNOWN type → one clean `recallObject` call, no sweep); the `intent` routes
the turn; `constraints` filter; `relations` drive neighborhood expansion.

**The reference utterance** (Lucas): *"Hey Zoe, we have a meeting with Sen. Curtis' team tomorrow about the
upcoming webinar, can you get a prep sheet together on what we're talking about and the people in the meeting?"*
decomposes to:
- **objects** (resolve-or-create): `Sen. Curtis`(person) → + his `team` via staff edges; `the meeting`
  (calendar event, resolved by "tomorrow"); `the webinar`(event); `the people in the meeting`(attendee edges).
- **constraints/binders** (filter objects, NOT lookups): `tomorrow` (temporal filter on the event);
  `we`/`Hey Zoe` (speaker = the operator object; addressee = self).
- **intent/action**: render a **prep-sheet deliverable** (a VIEW over the assembled subgraph).

## 2. What it replaces (the recognizer cascade)

Today `main.js` (~L3182–3416) runs a cascade of brittle recognizers, each a separate gate:
`intake.classify`/`route` (project?) · `operator.isDirectedTask` (regex fallback) · doc-QA (`docQaHandled`) ·
directed-stop · expand · followup · clarification · status · correction. `lib/intake.js` is ALREADY the
"one cloud pass → deterministic router" shape — but it only decides *isProject + mode(discover/enrich) +
priority/budget*; it extracts NO entities and resolves NO objects. **Slice 2 generalizes `intake` into the
full parse and folds the cascade into ONE front door.** The individual recognizers become `intent` values,
not separate code paths.

## 3. The parse contract

One cloud-LLM structured parse (base: GraphRAG `GRAPH_EXTRACTION_PROMPT` + LangChain.js `createSchema`
scaffold; see reference doc), parameterized on **Echo's `config.toml [graph]` schema** so output is
Echo-native:
- `entity_types` = person, organization, place, bill, committee, event, claim, concept, … (Echo's set)
- `relation_types` = Echo's closed legislative vocab (AMENDS, CITES, AUTHORED_BY, …) **EXTENDED with
  conversational predicates** (attends, employs/works_for, scheduled_for, about, member_of, precedes) — see §7.

Output schema (ONE round-trip):
```jsonc
{
  "intent": "research" | "extract_from_doc" | "schedule" | "answer" | "status" | "stop" | "expand" | "chat" | ...,
  "objects": [
    { "mention": "Sen. Curtis", "type": "person", "op": "resolve"|"create", "salient": true }
  ],
  "relations": [
    { "source": "the meeting", "type": "attends", "target": "the people in the meeting" }
  ],
  "constraints": [ { "kind": "temporal", "value": "tomorrow", "binds": "the meeting" } ],
  "deliverable": "prep sheet",              // when intent implies a rendered view
  "clarify": [ ... ]                          // ONLY when genuinely ambiguous (carried over from intake)
}
```
`intent` subsumes intake's `isProject` (research/monitor = project) and the doc-QA / status / stop / expand
recognizers. `mode`(discover/enrich) is NOT an intent — it becomes a property of the objects (do we hold
them? → deepen; new? → discover). See §5.

## 4. Token bucketing (the three buckets)

The parse sorts every content token into exactly one bucket — this sorting IS the thing that replaces the
recognizer pile:
1. **object** → `objects[]` (resolve-or-create). 2. **constraint/binder** → `constraints[]` (filters an
object; never a lookup). 3. **intent/action** → `intent` + `deliverable`. A token that's a speaker/addressee
("we", "Hey Zoe") sets the operator/self context, not a lookup.

## 5. Resolve-before-decompose + collective resolution + NIL (the accuracy core)

The research's two documented failure modes — **dangling pronouns** ("his team", "the meeting") and
**entity overshadowing** (popular same-name entity wins) — are handled HERE:
- **Resolve during the parse**: each `objects[].mention` is resolved to a canonical Echo object BEFORE it
  becomes a sub-task, so downstream carries IDs, not pronouns. Uses Slice-1 `recallObject(mention, {preferType: type})`
  — the type from the parse means ONE clean call (no degree sweep).
- **Collective/coherence resolution**: resolve co-occurring mentions JOINTLY — the whole utterance is one
  cluster, so "Curtis" + "Senate" + "the webinar" mutually constrain each other. This is the validated fix
  that beats popularity/degree ranking. Mechanism: pull each candidate's type + description, let the cloud
  pick on CONTEXT coherence (ReFinED philosophy, expressed as a prompt).
- **NIL branch — BIAS TOWARD CLARIFYING (Lucas, locked):** she should ALWAYS hazard toward a clarifying
  question over a wrong answer — "I'd rather an extra question or two than a wrong answer." So the NIL /
  ambiguity threshold is deliberately LOW: any real doubt about which object a mention resolves to → ask
  "which X?" (Graphiti `duplicate_candidate_id = -1` schema) rather than silently pick top-confidence. Only
  a clearly-dominant, coherence-backed candidate resolves silently. For a read-only meeting co-pilot, NIL can
  instead mean "hold for more context" (a question mid-meeting is disruptive) — but for an interactive turn,
  ASK. This is a trust-over-throughput default; over-asking is the acceptable failure mode, wrong-linking is not.

## 6. The executor (retire discover/enrich MODES)

`main.runDirectedResearchPass` + `lib/research.js` today branch on `mode` = discover
(`buildNewTargetPrompt`/`buildDeepenPrompt`) vs enrich/facet-fill (`pickEnrichTarget`/`buildEnrichPrompt`
/web+deep lanes). Slice 2 reframes: **plan.objects are the targets; facets are attributes/relations to fill.**
ONE loop per object: resolve → `recallObject` (the cheap complete first pass) → DIFF the object against the
requested facets → fill ONLY the gaps (web/deep) → reconcile deltas overnight. "Discover" = the step when
`objects[].op = create` or targets are "to be identified"; "enrich/facet-fill" = `op = resolve` + a facet
diff. The MODE flag disappears; the behavior falls out of "do we hold this object, and which facets are
missing." **Keep** the enrich web/deep dual-lane machinery (it's good) — just key it on objects, not a mode.

## 7. Relation-vocab extension (open build item)

Echo's `relation_types` is closed + legislative. A general assistant needs conversational predicates.
Decision to lock: **extend `config.toml [graph].relation_types`** (Echo-side, so proposals validate) with a
small general set — attends, works_for/employs, scheduled_for, about/discusses, member_of, precedes/follows,
located_in. Alternative (weaker): parse free-form relations and map them onto the closed set via
`lightrag_adapter.classify_relation`. Prefer extending the vocab — free-form relations without a home become
`RELATED_TO` noise (the exact thing Echo's cleanup pass is fighting).

## 8. Integration seams (real, grounded)

- `lib/intake.js` — GENERALIZE `classify()` from `work_intake v3` → a `decompose vN` parse emitting the §3
  schema; `route()` stays pure but returns `{intent, objects, relations, constraints, ...}`. Keep the
  cloud-down → regex fallback (never remove the safety net).
- `main.js` router (~L3182–3416) — collapse the cascade: call the decomposition parse ONCE, switch on
  `intent`. Existing handlers (doc-QA, directed-stop, expand, status, correction) become `intent` branches,
  not independent gates. Do this INCREMENTALLY (see sub-slices) — don't rip out all recognizers at once.
- `lib/active_recall.recallObject` (Slice 1, built) — called with `{preferType}` from the parse.
- `main.runDirectedResearchPass` + `lib/research.js` — refactor per §6.

## 9. Existing-machinery guardrails (don't break)

- Keep intake's **regex fallback** (`operator.isDirectedTask`) for cloud-down/over-budget.
- Keep doc-QA's negative-guard logic (it correctly excludes "pulled notes INTO canvas") — fold it into the
  `extract_from_doc` intent, don't lose it.
- The parse runs the FAST model with token headroom (intake already does this — a reasoning model burns the
  budget on hidden thinking and returns empty JSON). Preserve that.
- `clarify` (≤2 questions) carries over — the NIL/ambiguous branch reuses it.

## 10. Sub-slices (each shippable + offline-tested)

- **2a — Parse contract.** New `decompose` cloud task + PURE `route()` returning the §3 schema. Offline
  smoke over fixture utterances (the meeting example + a research command + a doc-QA + a status check) →
  correct bucketing. No wiring yet. (extends `smoke_intake`.)
- **2b — Resolve-before-decompose + NIL.** Wire `recallObject({preferType})` into the parse; collective
  resolution; NIL/"which X?" branch. Smoke with the Curtis cluster (coherence picks the Senator) + an
  ambiguous mention (→ NIL). Live-verify vs Echo.
- **2c — Executor refactor.** `runDirectedResearchPass`/`research.js` keyed on objects+facets, modes retired.
  Reuse the enrich dual-lane. Regression: existing research smokes stay green.
- **2d — Relation-vocab extension.** Extend Echo `[graph].relation_types`; the parse emits conversational
  relations; proposals validate. (Echo-side config + a smoke.)
- **2e — Router collapse.** Switch main.js on `intent`; migrate recognizers to intent branches one at a time,
  gate green between each.

## 11. Decisions — LOCKED (2026-07-01)

1. **Parse home** — ✅ generalize `lib/intake.js` (it's already the one-cloud-pass→router pattern).
2. **Relation vocab** — ✅ extend Echo's `[graph].relation_types` with conversational predicates (avoids
   `RELATED_TO` noise). Echo-side config change (Slice 2d).
3. **Router migration** — ✅ incremental: migrate recognizers to `intent` branches one at a time, gate green
   between each (§10 sub-slice 2e). No big-bang rip-out.
4. **NIL / ambiguity UX** — ✅ BIAS TOWARD CLARIFYING. Low NIL threshold; any real doubt → ask "which X?"
   rather than pick. Trust over throughput; over-asking is acceptable, wrong-linking is not (§5).
