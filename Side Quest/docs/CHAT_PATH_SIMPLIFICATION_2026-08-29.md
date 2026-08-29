# CHAT-PATH SIMPLIFICATION — one intent pass, one owner, one durable graph (design, 2026-08-29)

**The order** (Lucas): *"I fear that we have layered so many patches that we'll always leak. I would
like to review and simplify the brittle paths… the only truly special thing we are trying to
accomplish is persistent memory… actual program execution is still extremely faulty."* → *"draft it."*

**The thesis**: the brittleness is concentrated in ONE layer — order recognition — where six
parallel regex recognizers each hold a partial hand-grown theory of what Lucas means, and every
novel phrasing finds the gap between them. Five one-word-wide net widenings landed in a single
24h span ('present'/'finalize' · 'deliverable' · polite modals · split phrasals · adverb wants),
each found only by failing live. Enumeration cannot cover language; comprehension can. The
detectors-vs-comprehension doctrine already names the cure: **regex fast-path, bounded model
classifier behind it** — built once, at one seam.

## The evidence (the leak ledger, all live specimens)

| Leg | Phrasing | Which net missed | The one-word cure it took |
|---|---|---|---|
| p179 | "present your final, full and complete report" | order-verb + the question gate | 'present', 'finalize' |
| p180 | "get that completed and pulled up on the canvas" | no deliverable noun | the anaphor net |
| p18x | "I still need a list of everyone that sponsored…" | `i\s+(want\|need)` broke on the adverb | adverb crossing |
| leg 5 | "Can you make the final deliverable…" | the question gate ate every polite modal | the modal carve-out |
| leg 5 | "pull it all together into a document" | the literal phrase "pull together" | split phrasals |

Six deciders today: the paper door (PAPER_VERB_RE) · the user-work redirect (REDIRECT_TRIGGER_RE)
· the canvas-cmd classifier · the intake typer (intake_type) · detectDeliverableOrder's nets ·
the anaphor nets. Each decides ALONE; the road meter counts EIGHT owner doors booking work.

## D1 — THE ONE INTENT PASS (the merge)

One decision point per user turn, replacing six.

- **Fast path first**: the existing nets stay, as instant-approve pre-filters — when a net fires,
  its verdict stands and no model is consulted (they are precise when they match; their disease
  is only what they miss).
- **The comprehension pass**: when no net fires (or nets disagree), ONE bounded cloud ask
  (`cloud_logic.ask`, the same door triage/redirect already use) classifies the turn into a
  CLOSED vocabulary and returns structured output:

```
intent: deliver | edit | redirect | status | question | chatter | control
deliverable: <noun or null>      referent: <resolved "that/it" target or null>
project_hint: <kin phrase>       size: brief | report | dossier | null
confidence: 0..1
```

- **Doors become executors.** The paper door, canvas-cmd, redirect, and the road CLAIM read the
  ONE verdict; none re-decides. `intent: deliver` → the road claims (via the existing projects
  kin bind). `edit` → canvas-cmd. `redirect` → user-work. Low confidence → ask ONE clarifying
  question (the bias-toward-clarifying doctrine) instead of silently dropping.
- **The conversation context the classifier reads (Lucas, 08-29: "are we factoring the rolling
  compression into the gates concept?")**: the intent pass consumes THE SAME rolling assembly the
  reply reads — the live verbatim turns PLUS the compact-block summaries (`context.rolling`,
  live-proven in Sprint 2: cross-boundary recall + the [dN] verbatim dereference) — never a raw
  last-N-turns slice. Referent resolution ("that/it", the project hint) is only as good as the
  window behind it; a classifier with a different memory of the conversation than the reply's
  would re-create the misbind class at a new seam. The catch-#7 authority law rides the
  classifier prompt too: the LIVE window outranks retrieved memory when they conflict. The
  `context.rolling.budget` lever (parked at 20k, his) is therefore also D1's recall-quality
  knob — raising it improves referent resolution and the streamlined-chat goal in one move.
- **Failure posture**: the cloud unreachable → the fast-path nets alone (today's behavior) — the
  pass only ever ADDS recall, never subtracts precision.
- **Cost**: one bounded ask (~300-500 tok) per user turn that the nets don't already catch; user
  turns are tens per day against an autonomic budget of ~40k+/h. Negligible.
- **Proof**: every leak-ledger phrasing becomes a fixture the CLASSIFIER must catch with the nets
  DISABLED (the retest-the-KIND law — varied phrasings per class, not the pinned literals);
  the nets' own pins stay as the fast-path suite.

## D2 — THE S3 SUBTRACTION (eight owners → one)

The road meter has been counting since S0. Subtraction order, one per cycle, meter watched
between each (any drop in claimed-order delivery halts the sequence):

1. **canvas-cmd independent creates** — already stood down for road-shaped orders (§61b). DONE.
2. **The promise booking for road-claimed orders** → becomes a POINTER to the registry row
   (the row's `delivered_at` is the one fact; the chaser reads it there).
3. **The absence organ** for road-claimed topics (the road owns the gap).
4. **The user-work redirect** for deliverable intents (D1's verdict routes; the redirect keeps
   its true job — focus switching).
5. **The paper conductor's typed door** — already road-first with fallback (§58b); the fallback
   retires once D1 is live (the conductor keeps the contract auto-finalize).
6. **The assignment lane's discover runs for deliver-intents** — D1 routes these to the road;
   discover keeps genuine research assignments.

Never subtracted: the say-side honesty stack (absence/plan-shape/quote/cite gates, the
verify followups) — verifiers are not owners; they are what has been catching everything.

## D3 — THE DURABLE-GRAPH PILOT (one seam, framework-assisted)

The road's execution (claim → swarm → digest → harvest → write → deliver → resume) is already a
state machine — hand-checkpointed in meta keys and paced timers. The pilot moves EXACTLY this
one seam onto a real durable-workflow runtime and nothing else.

- **Candidate**: Mastra (TypeScript-first — Zoe is Node/Electron; workflows + retries +
  checkpoints + MCP support). Fallback candidate: implement the LangGraph PATTERN natively
  (a persisted step-graph over the existing sqlite) if the dependency footprint offends.
- **Scope**: the four phases + the resume loop become graph nodes with persisted state; a
  reboot resumes mid-graph instead of re-noting a debt; retries/timeouts become declarations
  instead of hand loops. The road's PUBLIC behavior (claim, meter, say-gate, deterministic
  delivery, registry) is unchanged — the smoke suite is the acceptance bar as-is.
- **Explicit boundaries**: the framework never touches the memory layer (Echo, the registry,
  identity — the moat), never owns the conversational spine, and no coding harness is adopted
  (wrong problem — Zoe is not a repo-editing agent).
- **Verdict gate**: the pilot is judged on ONE number — resume-loop incidents (stranded
  partials) before vs after — plus the unchanged smoke suite. Not vibes.

## Build order

- **W1** — D1 the one intent pass (classifier + door rewiring + the leak-ledger fixture suite).
- **W2** — D2 subtractions 2-4 (one per cycle, meter-watched).
- **W3** — D3 the pilot behind a flag (`ZOE_ROAD_GRAPH=1`), old path retained until the verdict
  gate passes; then subtractions 5-6.
- Every slice: gate green, live leg, campaign record — the standing rhythm.

## Decision points for Lucas

1. **The classifier model**: the bounded ask rides `cloud_logic.ask`'s existing routing
   (gemma-31b-cloud class). Good enough, or pin it to glm-5.2?
2. **Low-confidence behavior**: ask one clarifying question (recommended) or fall through
   silently as today?
3. **D3 candidate**: pilot Mastra as a dependency, or build the graph pattern natively over
   sqlite? (Recommendation: try Mastra in a worktree first; if its footprint fights Electron,
   go native — the pattern is the value, not the package.)
4. **Sequencing**: W1 before any further road legs? (Recommended — it seals the funnel the
   legs keep leaking through.)
