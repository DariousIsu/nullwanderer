# The Subconscious Slice — the cloud DECIDES, not just narrates

**Lucas, 2026-07-20:** *"On the heartbeat tick the cloud model should be getting enough to start
making independent decisions, making more logical graph fill choices and use the probability tools
and the deep dive tools and so much more autonomously in the pursuit of growing and cleaning the
database or building projects."*

Status: **PLAN ONLY — nothing built.** Written while waiting on another context; to be built after a
cleanup + compact.

---

## 1. The diagnosis, measured

Seven days of idle work (`agent_events`):

| kind | count |
|---|---|
| thought | 3,121 |
| reading | 3,001 |
| insight | 180 |
| **artifact / deliverable** | **0** |

She reads and thinks continuously and **builds nothing**. That is the headline, and it is not a
capacity problem — it is a control problem.

**The cloud is never asked to choose.** Verified in the code:

- `beat_scheduler.js:22` — *"Choose the next beat to run: the not-done beat that was run LEAST
  RECENTLY"*. A deterministic round-robin over 223 beats. No judgement.
- `graph_walk.runMove` → `extractCandidates(recentTurns)` → `assessGaps` → `rankGaps`. The work queue
  is **proper nouns scraped from recent conversation**, ranked by code. This is why the log is full of
  `assessed 4: convo:rich, convo:rich → no move (no-gap)`: it keeps re-assessing things we already
  know because conversation is what it looks at.
- `subconscious.js` header, verbatim: *"this module only DECIDES and BUILDS PROMPTS; it never calls a
  model."* Its "decision" is triage — whether a tick is worth cloud tokens — not what work to do.

So today: **code picks the work, the cloud narrates about it.** Lucas wants the inverse.

This is exactly the inversion we shipped on the front end tonight (local packages → cloud writes).
The subconscious needs the same move, and can reuse the same machinery.

## 2. What changed today that makes this newly possible

- **Context: 8,192 → 131,072.** The subconscious model (`gpt-oss:120b-cloud`) was reasoning in 6% of
  its window. Every idle prompt was written to fit that.
- **~100 public data sources unblocked** (`echo_tier` family allowlist) — legistar, uk_, epa_, fema_,
  nhtsa_, treasury_, uspto_, rxnorm_… The research lane had ~1% of its surface.
- **A real fan**: per-model concurrency, 3 distinct models × 4 in flight.
- **`lib/package.js`** — manifest + plan + budgets + report, already built and proven on chat turns.
- **Five encounter lanes** — every input decomposes into objects through one structure.

## 3. What she could be working on right now

Live counts, i.e. the raw material a decision layer would choose among:

| signal | count | what it means |
|---|---|---|
| `absence` | 196 | known, named gaps — things we established we do NOT have |
| `cardinality` | 21 | countable universes with a denominator |
| `encounters` | 51,410 | claims awaiting corroboration/grading |
| `graph_entities` | 13,030 | of which **0** carry a `substantiation_state` |
| `open_threads` active | 23 | her own commitments |
| `documents` | 7,181 | decomposable material |

None of this reaches the tick's decision. The tick looks at recent conversation.

## 4. The slice plan

### S1 — THE TICK MANIFEST (build first)
Reuse `lib/package.js`. A heartbeat tick gets the same shape as a chat turn:

- **state**: counts above, plus the top-N *specific* open items (named gaps from `absence`, a
  cardinality with a denominator, the stalest beat, the largest ungraded cluster)
- **capabilities**: what it can reach (read tools, ~100 sources) and what it can *produce* (canvas
  doc, briefing, delegate)
- **budget**: hops, tokens, wall-clock for this tick
- **history**: what the last N ticks chose and what came of it — so it can stop repeating

Manifest = counts and keys, never rows. Same lever as the chat package: it makes choice possible at
tens of tokens.

### S2 — THE CLOUD CHOOSES (the actual inversion)
One structured call per tick: *given this state and these capabilities, what is the single highest-value
move right now, and why?* Returns a typed plan, not prose:

```
{ move: 'fill-gap' | 'corroborate' | 'clean' | 'forecast' | 'build' | 'nothing',
  target: <key from the manifest>, why: <one line>, steps: [<tool calls>], expect: <what success looks like> }
```

**`nothing` must be a first-class answer.** A decision layer that can never decline becomes a
make-work generator — and "no move (no-gap)" is already the honest outcome much of the time.

### S3 — BOUNDED EXECUTION + VERIFY
Execute the steps under the tick budget, then check `expect` against what actually happened. Record
**what was done**, not what was planned — tonight's action-honesty lesson applies double here, since
nobody is watching an idle tick.

### S4 — ARTIFACTS (the missing 0)
"Building projects" needs a producer. On a `build` move she drafts a real document — a county-board
brief, a gap report, a forecast note — through the existing render/canvas path, cited. This is the
lane that turns 3,001 readings into something you can read back.

### S5 — THE FAN
Once S2 chooses, fan the retrieval across the pool (3 models × 4). Depth-first with a small pool, not
wide parallel — and **origin-per-source enforced first**, or N agents on one site manufacture
corroboration ([[whole-site-capture-to-objects]]).

## 5. Non-negotiables, learned the hard way today

1. **Every tick emits a report.** `[tick] chose=fill-gap target=… steps=3 ok=2 artifacts=1`. Both
   failure modes are silent: doing nothing looks identical to doing nothing useful.
2. **Never claim work that did not happen.** She told Lucas she had put contacts on the canvas three
   times today; no canvas write existed. An idle tick has no one to catch it.
3. **Read tools wide, writes gated.** The tier gate stays; `propose_*` remains the write path.
4. **A wrong choice must be cheap.** Bounded hops, bounded tokens, and `nothing` always available.
5. **Do not let the beat's subject leak.** It just answered Lucas's Turing-test question with Kauai
   County research passes.

## 6. Open questions for Lucas

- **Cadence and spend.** A cloud decision per tick is a real cost. Every tick, or only when triage
  says the state has changed enough to be worth deciding on?
- **Autonomy ceiling.** Should a `build` move be able to produce a document unprompted, or should it
  stage a draft and wait?
- **Ordering.** S1+S2 alone would already change behaviour (better choices, same actions). S4 is what
  produces the visible output. Which matters more first?

---

Relates to: `docs/AUTONOMIC_ARCHITECTURE_DESIGN.md` (the beats this steers),
`docs/RESEARCH_ALLOCATION_DESIGN.md` (the priority queue — S2 replaces its *chooser*, not its
fairness rules), `lib/package.js`, `lib/subconscious.js`, `lib/graph_walk.js`.
