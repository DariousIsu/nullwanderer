# THE FAN — Assessment & Un-parking Proposal

**Status:** ASSESSMENT (his order 09-01, during the hold — the sibling directive from the affect-substrate
grant). **Directive (Lucas, 08-31, compressed):** every action swarms from multiple vectors — a local-store
swarm, a web swarm, a python vector — run CONCURRENTLY on gemma-class single-task envelopes, replacing
cognition's sequential enrich ladder; the frontier voice judges and composes. "We have rookie numbers on the
gemma 31b model; those calls are very cheap."

## 1. Verdict up front

**Un-park it, as two gated slices (F0 measure → F1 one surface).** The evidence that was missing when W4
was parked now exists: the budget rework proved count-nets bound at ~1% of real compute (cheap calls are
abundant, not scarce); the breadth wave already runs 4× caps without strain; and the program has since
LIVE-PROVEN four fan-shaped organs — the grounding flare (1-2 concurrent specialists per model-answer),
the road's section swarm + fact-checker brief, the curation drain (sequential by choice, not necessity),
and tonight's affect tissues (parallelizable deterministic vectors). The fan is no longer a new
architecture; it is the generalization of things already firing.

## 2. What exists today (the thing being replaced, and the precedents)

- **The sequential enrich ladder** (lib/cognition.js): a turn's answer path walks enrichment steps one
  after another; each step waits on the last. Wall-clock = the SUM of the steps; a slow web fetch delays
  a local lookup that needed nothing from it.
- **Proven fan precedents in-repo:** flare (concurrent spawn_agent_async specialists + one harvest),
  road swarm (deposits gathered, writer composes), curation burst (roster drain), affect tissues
  (independent deterministic passes → manifests). Each already solves harvest-dedupe, consume-marking,
  and envelope discipline — the fan reuses those organs, not new ones.

## 3. The proposed shape

Per fannable action, N **single-task envelopes** run concurrently:

| Vector | Does ONE thing | Substrate |
|---|---|---|
| local-store | one SQL/FTS sweep over sq.db + the graph | gemma4:31b-cloud, direct ollama call |
| web | one search-lane pass on the same ask | gemma envelope over the existing lane |
| python | one deterministic pass (R3-shape; the tissues are the template) | no model at all |
| engine | one Echo read tool (search_entities / search_knowledge) | direct call |

The frontier voice then composes FROM the deposits — same division of labor as the affect substrate:
vectors produce material with provenance; the voice judges, reconciles, and speaks. **Constraints honored
by construction:** the engine team_spawn 2-slot cap is bypassed (direct model calls, not teams); every
vector's output passes the content firewall + the identifier gates before composition; and the standing
law holds — *small models are safe on single tool tasks, unsafe on chains* — an envelope is one task,
zero chains, one deposit.

## 4. Slices (each gated; stop anywhere and the system is no worse)

- **F0 — measure, dark (build first):** instrument the current ladder — per-step wall-clock + which steps
  actually contributed to the reply — journaled like internal_state Slice 0. Gate: 48h of honest ladder
  traces; know what the fan must beat. Near-zero cost.
- **F1 — one surface, kill-switched:** fan exactly ONE ladder (recommend the factual-question enrich —
  the flare already proves the harvest half there). N=3 vectors, `swarm.fan` kill switch, pace + quota
  rails (the ladder's existing tier gates stay upstream). Gate: latency ≤ the sequential ladder AND zero
  new firewall/identifier-gate violations over a week; A/B the answer quality on the retest-the-kind
  suite.
- **F2 — generalize + judge:** extend to the road gather and pull-up enrichment; add a cheap judge
  envelope that scores deposit agreement before composition (disagreement → the honest-uncertainty say,
  never a coin flip).

## 5. Risks and their standing cures

- **Manufactured corroboration** (N vectors echoing one source): origin rides every deposit
  (origin-per-vector, the whole-site-capture lesson); the composer counts SOURCES, not deposits.
- **Cache corpses:** every envelope salts its input (the retry-lane law).
- **Quota:** gemma-cloud is his ruled-cheap tier, and the count-net evidence says headroom is ~99%;
  the degrade ladder (lib/quota.js) sits upstream untouched — under real scarcity the fan collapses
  back to the sequential ladder (fail-absent to today's behavior, the B4 pattern).
- **Firewall coverage:** the run-2b snippet-framing gap says the WEB vector's deposits need the
  firewall at deposit time, not compose time — F1's gate pins that.

## 6. Cost estimate

F0 is arithmetic. F1 ≈ one new lib (fan driver ≈ the curation-burst shape) + envelope prompts + pins;
per-turn cost ≈ 2-3 gemma calls (his "very cheap") only on turns that already ran the ladder. No new
timers, no new stores — deposits ride the existing consume-mark machinery.

**Awaiting his word to build F0/F1.** Companions: docs/SWARM_SUBSTRATE_2026-08-30.md ·
docs/AFFECT_SUBSTRATE_RESEARCH_2026-08-31.md (the division-of-labor law) · memory/affect-substrate-theory.md
(the directive).
