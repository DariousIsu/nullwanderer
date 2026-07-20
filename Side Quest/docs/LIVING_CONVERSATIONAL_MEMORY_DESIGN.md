# Living Conversational Memory — Design

**Status:** design. **Date:** 2026-07-20.
**Builds on:** `ENCOUNTER_OBJECT_MODEL_DESIGN.md` (the substrate), `MEMORY_PATH_MAPPING_DESIGN.md` §6 (absence),
`DATA_INVENTORY_AND_AWARENESS.md` (what she can reach), `OBJECT_MEMORY_ARCHITECTURE.md`.

> **The ask (Lucas, 2026-07-20):** *"live and active conversation memory and how we keep it extremely
> rich and deep without blowing out context. How can we use the database concepts we have been
> building to create a vibrant living conversational memory?"*

---

## 1. What conversational memory is today — measured

| Layer | Mechanism | Reality |
|---|---|---|
| Verbatim window | `RECENT_TURN_LIMIT = 28` | ~20–30 rounds, full fidelity |
| Running summary | `conversation_state` (recursive summarization, one row/session) | **184 rows for 660 sessions — 72% of sessions have none** |
| Older turns | `relevantPastTurns` — semantic similarity over raw turn text | unstructured; no notion of *what* the turn was about |
| Bulk context | `lib/distill.js` — cloud compresses the firehose to a brief | a compression valve, not memory |
| Archive | `turns` — 8,738 rows | reachable only by (2)–(3) |

**The summariser is barely running.** 115 sessions have 20+ real turns; exactly **one**
`conversation_state` row has `turn_count > 20`. Summaries run 225–726 chars.

So: **8,738 turns of real conversation compress to 184 short paragraphs, and most sessions leave
nothing at all.** Past the 28-turn window, the only route back is fuzzy text similarity.

## 2. The actual asymmetry

Every other input stream **decomposes into objects**. Conversation does not.

| Stream | Decomposes to | Where |
|---|---|---|
| News | events + entities | `news_lane.runDailyPass` → Echo |
| Documents | contacts, entities, **encounters** | `doc_decompose`, `doc_contacts` → `encounters` |
| Research / beats | entities + relations | `propose_entity` / `propose_relation` |
| **Conversation** | **a ~600-char summary, then nothing** | — |

Verified: `doc_contacts.js` is the **only** writer to `encounters`. The chat turn path calls
`resolveMention` and the `cognition` enrich loop — both **read**-side. **Conversation reads from the
object graph and never writes to it.**

That is backwards. Conversation is the highest-signal stream in the program: it is where Lucas states
intent, corrects her, sets preferences, and names the people and projects that actually matter. It is
the one stream where a claim arrives with a known, trusted source attached — and it is the one stream
we throw away.

## 3. The proposal — conversation IS an encounter stream

The encounter model already says so. Its own first line:

> An object is real because it has been **encountered** in some fashion — news, research,
> **conversation**, doc drops.

Conversation is named in the philosophy and has no writer. This design is mostly *wiring*, not new
machinery.

**Per turn:** extract the objects the turn is about (mention extraction is already live — tiered
NER → cloud → regex) and record each as an encounter with `source_ref = 'turn:<id>'` and a
`claim_class` per the encounter spec §5. Nothing else changes about the turn.

### Why this answers "rich and deep without blowing out context"

Richness stops being a function of **how much transcript you carry** and becomes a function of **how
well the objects are connected**. Concretely:

- **Retrieval by object, not by similarity.** *"What did Lucas say about the Rainey Center?"* becomes
  a query on one object's encounter history — exact, ordered, sourced — instead of a fuzzy scan of
  8,738 turns hoping the phrasing matches.
- **Context cost is O(objects in this turn), not O(history).** You inject the two or three objects
  this turn is actually about, each with a compact encounter profile. That is *smaller* than today's
  distilled brief and far better grounded. **The window does not grow.**
- **Grading at read time, already built.** Said once = one encounter. Said in five sessions across
  three months = a corroborated claim. `encounters.gradeClaim()` already does this; it just has never
  seen a conversational claim.
- **Cross-stream corroboration — this is the "living" part.** The same object accumulates encounters
  from conversation *and* news *and* docs *and* research. Something Lucas mentioned in passing in May
  gets independently corroborated by a news item in July, and the two are the same object. That is
  the encounter doc's *"everything is connected to everything"* — conversation is currently the one
  thing excluded from it.
- **Absence falls out for free.** A person Lucas names that she has encountered nowhere else is a
  `somevalue` gap (never `novalue`), which feeds the research priority queue. *Her curiosity would
  finally be driven by what she actually doesn't know* — see §5 of the awareness audit.

### What this does NOT replace

- **The 28-turn verbatim window stays.** Recency needs verbatim; tone, phrasing and the immediate
  thread are not objects. This is about what survives *past* the window.
- **`conversation_state` stays** — it holds the narrative arc ("we are mid-way through the parish
  work"), which is not an object claim. But it needs fixing (§4).
- **`distill` stays** as the compression valve for the remaining bulky blocks.

## 4. The bug this surfaced

`conversation_state` covers 28% of sessions and effectively stops tracking past ~20 turns. Whatever
the cause (not yet diagnosed — it needs the same treatment the mood bug got), the "compact anchor
that survives turns scrolling out of the window" is absent for most sessions. Worth fixing on its own
merits, independent of everything above.

## 5. Slices

| # | Slice | Why this order |
|---|---|---|
| **C0** | Diagnose + fix `conversation_state` coverage (72% missing). | Cheapest, standalone, and it is the layer that already exists for exactly this job. |
| **C1** | Route the turn path's existing mention extraction into `encounters.record()` with `source_ref='turn:<id>'`. Record only; change no retrieval. | Mirrors P0 of the path-mapping work: *record first, derive later*. Wrong extraction is then re-runnable, not corrupting. Flag-gated, default off. |
| **C2** | Measure. How many encounters per turn, what fraction resolve to an existing object, what fraction are new. | The utility gate. If conversational extraction is mostly noise, stop here — same discipline as the P2 go/no-go. |
| **C3** | Retrieval: inject *the objects this turn is about + their encounter profile* in place of some of the distilled brief. Measure context size before/after. | The payoff, and the claim that context does not grow has to be proven, not asserted. |
| **C4** | Conversational gaps → `absence` (`somevalue`) → the research allocator. | Closes the loop to curiosity. |

**C2 is the go/no-go.** The encounter philosophy says volume is the strategy and cheap calls are the
point — but that argument was made for *research* sweeps, where a stray CPA in a 2021 audit is still
a real object. Conversation contains far more chatter, and a mis-extracted object is a *false* claim
carrying Lucas's own authority as its source. That is worse than a missing one, so the bar for
promoting a conversational encounter to a claim should be higher than for a document, and C2 is where
that threshold gets set from data rather than guessed.

## 6. Open questions

1. **What counts as an object in conversation?** A named person/place/org is clear. Is "the parish
   work" an object, or a thread? Probably a thread — `open_threads` already holds those, and thread
   adoption (`9702d02`) now links them to real work.
2. **Claim class for a conversational statement.** Lucas saying *"disregard the White House as a
   source"* is a **preference/protocol**, not a fact about the world. The encounter spec's claim
   classes may need one for *stated-by-principal*, which is high-trust but is not external evidence.
3. **Her own utterances.** Does Zoe saying something record an encounter? Leaning **no** — that
   would let her corroborate herself, which is precisely the self-sustaining-truth failure RFC 2308
   guards against in the absence model.
