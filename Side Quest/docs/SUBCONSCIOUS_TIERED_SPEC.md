# Tiered Subconscious — local volume + cloud depth (cost-bounded)

**Status:** BUILT + smoked + live-verified 2026-06-28 (35-suite gate green). NEEDS REBOOT to run live in the tick. Reversible + fail-safe to local at every step.

**Implementation:** [lib/subconscious.js](../lib/subconscious.js) (pure brain: merit/tier/budget/grounding/synthesis — `smoke_subconscious_tier.js`, 27 ok) · [lib/ollama.js](../lib/ollama.js) `completeDetailed` returns `{text, usage}` (token capture, live-proven) · [lib/monologue.js](../lib/monologue.js) tick wires the tier decision + memory grounding + spend recording + the periodic synthesis pass; `generateThought` fires `deps.onUsage` (`smoke_subconscious.js`, 12 ok) · config knobs `subc*` + `.env` `ZOE_SUBC_*`. Live tokens/hour = the rolling `subc.budget.window` meta. Also shipped this session: the chat-reply abort-leak fix ("This operation was aborted" → retry-once + 180s watchdog, [main.js](../main.js)).

## Problem
Routing **every** between-turn thought to the cloud reasoner (`gpt-oss:120b`, `num_predict≥700`) is the one path that doesn't pencil out: measured ~140 thoughts/active-hour × ~3k tok ≈ **~400k tokens/active-hour** (~85% of projected cloud spend). Extraction + curation are fine; the subconscious is the cost. Goal: keep the depth, cut the spend ~70–80%, and make it *provably bounded*.

## Principle
**Local does the volume (Dans, already resident → free); the cloud reasoner is summoned for depth on merit, plus a periodic cross-thought synthesis.** Most idle mentation is shallow by nature — only a fraction warrants a 120B pass. This maps to cost *and* to how thinking works.

## The signals already exist (no new ML)
At `lib/monologue.js` `tick()` the decision point already has:
- `focusLib.getCurrent()` — directed, high-value thinking in progress
- `<wonder>…</wonder>` — the model's own flag for "a real question I want my larger self on" (already triggers `self_dialogue`)
- `ruminationLib` cosine / fixation detection — novelty vs. circling
- `importanceLib` — scored salience
- tick `mode` — free-association vs focus vs thread-review

We route on these; we don't invent a merit signal.

## Architecture — three components

### A. Merit-triage (in-the-moment depth)
Default tier per tick = **LOCAL**. Escalate to **cloud** only when merit clears a bar.
- **Pre-gen triage** (decide before generating): `mode === focus` or `thread-review` on a salient stale thread → generate directly on the cloud reasoner.
- **Post-gen escalation** (decide after a cheap local draft): local generates as today; if the draft emits `<wonder>` **or** scores high novelty/importance → a second cloud pass deepens it / answers the wonder. This *is* the existing `<wonder>→self_dialogue` seam — make the "articulate self" run on cloud (the subconscious *prompt* stays local/cheap).
- `meritScore(ctx)` = weighted: focus(+strong), wonder(+strong), novelty(+), importance(+), thread-review(+). Escalate if `≥ subc.merit.threshold` **and** budget remains.
- Mundane free-association → stays local, same cadence, $0.

### B. Periodic synthesis (cross-thought depth)
A scheduler fires **one** cloud call every `subc.synth.intervalMin` (default 20) of active time:
- **Input:** last N local thoughts since the prior synthesis + open threads + active focus.
- **Task:** "Across these, find the real thread/tension/insight worth pursuing; produce one deep reflection, optionally a `<wonder>` or a focus seed."
- **Output:** stored as `monologue` row `type='synthesis'`, surfaced in her stream, and may **seed a focus** (drives directed thinking next). This is where cross-thought insight lives — the thing per-tick deepening misses.

### C. Budget ceiling (hard backstop)
A rolling **tokens/hour** cap for the subconscious cloud path (`subc.budget.tokensPerHour`, default ~120k). When exceeded → triage + synthesis **fail-safe to local** until the window rolls. This is the single knob that makes spend provably bounded regardless of gate behavior.

## Token accounting (prerequisite — also fixes the measurement gap)
The subconscious path currently bypasses `cloud_traces` and the local Ollama log → invisible/unmeasurable. We:
- Capture `prompt_eval_count` + `eval_count` from each cloud response (Ollama returns them on the non-stream `complete`).
- Add to the rolling budget window **and** log a `cloud_traces` row (`task='subconscious'` / `'synthesis'`) → measurable live tokens/hour **and** captured as training data (cloud-think→local-voice pairs), consistent with the broker philosophy.

## Config (env/meta, reversible, fail-safe to local)
- `subc.tier.mode` = `hybrid` (default) | `triage` | `synthesis` | `local` (all-local, cheapest) | `all` (legacy every-tick-cloud)
- `subc.merit.threshold` (default tuned so ~15–25% of ticks escalate)
- `subc.synth.intervalMin` (default 20)
- `subc.budget.tokensPerHour` (default 120000)
- models: cloud = `config.subconsciousModel()` (gpt-oss:120b); local = `config.frontModel()` (Dans)

## Cost projection (hybrid)
| Path | Rate/hr | tok/call | tok/hr |
|---|---|---|---|
| Triage escalations | ~20–30 | ~3k | ~60–90k |
| Synthesis | ~3 | ~4–6k | ~15–30k |
| **Total** | | | **~80–120k** (capped) |

vs ~400k/hr naive → **~70–80% cut, hard-bounded.** Local cadence unchanged (her stream never goes quiet).

## Build slices (each smoked offline before the next; deps-injected like `smoke_subconscious.js`)
1. **Token accounting + `cloud_traces` logging** for the subconscious path → live tokens/hr. *(prereq + measurement fix)*
2. **Budget ceiling** — rolling window + fail-safe-to-local gate.
3. **Merit-triage** — `meritScore` from existing signals; pre-gen + post-gen `<wonder>` escalation.
4. **Periodic synthesis** — scheduler + synth prompt + seed-focus + store as `type='synthesis'`.
5. **Config knobs + smokes** added to the gate.

## Invariants / safety
- Every component fail-safes to **local** (cloud down / budget out / error → local thought, never silence, never crash).
- `AbortError` still propagates (snap-back on user message) — unchanged.
- Default `hybrid`; set `subc.tier.mode=local` to spend $0 on cloud thinking, `all` to restore legacy.
- No change to her voice path (Dans) or the extraction/curation offload.

Relates to [[front-cortex-architecture]] and the extraction offload (P1.5).
