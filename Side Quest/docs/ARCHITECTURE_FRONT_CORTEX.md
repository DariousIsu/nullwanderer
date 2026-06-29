# Architecture: Front (local voice) / Cortex (cloud cognition)

*Spec'd 2026-06-28. Pivot driven by: the local 24B is overloaded ("too much information"), and we now have ample cloud bandwidth + **3 concurrent Ollama-cloud model slots**. Goal: stop the front model from carrying everything, by splitting **Voice (local) from Cognition (cloud)**.*

## 1. The principle
**Voice stays local. Cognition moves to the cloud.**
- The local model **is her voice** — her identity, persona, and persistent self live there. The cloud must never write her words.
- The cloud does the heavy thinking — critical reasoning, planning, tool decisions, synthesis — and hands back **structured thinking** the local model **voices in her own words.**
- Bonus: every "cloud-thinks → local-voices" exchange is a clean `(hard-reasoning input, distilled output)` pair — exactly the **training flywheel** for the eventual custom model. `cloud_traces` already logs these.

## 2. Target layout
- **FRONT (local, conversational, uncensored):** her spoken reply + the between-turn monologue voice + fast local recall + *expressing intent*. Fed a **distilled brief**, not the firehose.
- **CORTEX (cloud, 3 role-slots, run in parallel):**
  - **Reasoner** (gpt-oss:120b / a deepseek) — critical thinking, planning, the monologue's deep "what's worth pursuing."
  - **Multimodal** (gemma4:31b) — vision (already in use).
  - **Utility** (gemma4:31b / a flash) — context distillation, extraction, curation, classification.
- **BRIDGE:** pre-turn **context distillation** + (later) **tool planning**. Built on the existing `cloud_logic.ask` broker.

Today everything (voice + recall + reasoning + tool-tags + monologue + a huge injected context) runs on ONE local 24B (`config.model()` → `ZOE_MODEL` → mistral-small3.2:24b). That's the overload.

---

## Part 1 — Context Distillation  *(Phase 1 — build first; detailed spec)*

### Problem
Every chat turn injects a firehose: awareness, base persona, self-model, self-narrative, dev ledger, open threads, protocols, retrieved knowledge, relevant past turns, recent monologue/readings, convo-state, variety nudge, echo block… A 24B chokes; a smaller front would drown. Result: flat, generic, off-voice replies.

### Flow
1. Gather full context (as today).
2. **Cloud Utility distills** `(full context + user message)` → a **tight brief**: the handful of facts/memories that actually bear on THIS reply, the user's real ask, the one active thread that matters (if any), and a short tone/voice cue.
3. The **front model replies from the brief** (small, focused) instead of the firehose.

### Adaptive gate (latency control)
- `distill = auto` (default): distill only **heavy/complex** turns (context over a size threshold, or a factual/multi-thread turn). Simple chit-chat skips → stays fast and local-only.
- `always` / `off` for study/debug.
- Config (db meta): `cloud.distiller` (model, default `gemma4:31b`), `distill.mode`, `distill.minContextChars`.

### Voice integrity (non-negotiable)
The distiller emits a **brief (bullet facts + guidance)** — never prose in her voice. The front writes every spoken word. So her identity stays local even as her *thinking* is cloud-assisted.

### Code
- New `lib/distill.js`: `distill({ context, userMessage, deps })` → `{ brief, used }`, deps-injectable (cloud call mockable), **fail-safe** (cloud down / error → return null → caller uses the full local context unchanged).
- `main.js`: in `runChatTurn`, when the gate trips, replace the heavy context blocks passed to `buildChatPrompt` with the brief (keep awareness/persona/self-narrative anchors; distill the *variable* knowledge/threads/turns). One cloud call via `cloud_logic.ask`.
- Telemetry: log `(context_digest, brief)` to `cloud_traces` — flywheel data.

### Tests
- gate logic (heavy→distill, light→skip, off→never); brief shape; **fallback** (cloud null → full context, reply still happens); smoke `smoke_distill.js` with injected cloud fn. Gate stays green.

---

## Part 2 — Front model swap  *(Phase 2 — config + voice)*

### Why now
Once critical-thinking + tool-calling move to the Cortex, the front only needs to **converse warmly in character from a brief** + do fast recall. That's the sweet spot for a **conversational, uncensored** model — and it kills the "as an AI I can't…" refusal class at the *root* (we currently patch it reactively with `voice.deDisclaim` / the self-disclaimer guard).

### Candidates (all already installed locally)
| Model | Size | Notes |
|---|---|---|
| **Stheno-v3.2** (`devopsnextgenx/Stheno-v3.2-Q6`) | 8B | **Recommended front.** Uncensored, warm, conversational; FAST (low latency for the live voice); frees ~10GB VRAM vs the 24B. Weaker at structure/recall — but the brief + Cortex compensate. (It was the *original* front — comments throughout still say "Stheno".) |
| **Dans-PersonalityEngine-24b** (`hf.co/bartowski/PocketDoc_…-24b`) | 24B | Premium alt: richer, more coherent, personality-tuned, less censored. Same VRAM/latency as now — no GPU headroom won. |
| **gemma3-abliterated:4b** | 4B | Tiny/fast/uncensored; likely too weak for coherent voice+recall — fallback only. |

**Recommendation: Stheno-v3.2 (8B) as the front.** Fast, uncensored, in-character; the ~10GB VRAM it frees could later host a local vision/grounding model (ties into the computer-use roadmap), and with the Cortex doing cognition there's no GPU contention.

### Code
- Introduce a model **role**: `models.front()` (local voice) distinct from the cloud roles. Replace the single `MODEL = config.model()` in the **voice/chat/monologue/followup** path with `front()`. Default `ZOE_MODEL` stays mistral until we flip; `model.front` (db meta) overrides.
- Re-tune the persona/system prompt for the new model (Stheno responds to persona differently than an instruct model).
- Keep mistral-24b available as a **fallback** and/or a *local* reasoner if cloud is down.

### Risks / mitigations
- Smaller front = weaker recall/coherence → **distilled brief + Cortex** carry the load; fast local recall stays local.
- Uncensored ≠ unguarded: the real safety controls are **harness-level** and unchanged — email-send OFF, never defeat CAPTCHA/sign-in, desktop `os_*` gated, confirm destructive/outward actions. Uncensored just removes reflexive moralizing/refusals, not the guardrails.

---

## Part 3 — Tool-calling to the Cortex  *(Phase 3 — sketch)*

A smaller conversational front shouldn't be burdened with emitting perfect tool tags. Move tool *decisions* to the Cortex:
- The front expresses **natural intent** ("I'd like to look that up / see your screen").
- A cloud **planner** (generalizing the deterministic interceptors we already have — `detectWebIntent`, `detectScreenSightRequest`, the live-info net) decides the concrete tool calls; the harness dispatches; results are **distilled**; the front **voices** them.
- This also makes the agentic/computer-use roadmap (verify loop, etc.) lean on cloud planning rather than the front.

---

## 4. Migration (each phase reversible via config; fail-safe to current behavior)
1. **P1 — Context distillation.** Biggest overload cure; no model change; pure win. *Build first.*
2. **P2 — Front swap to Stheno-8B** (config + persona tune + `models.front()` role). A/B against mistral.
3. **P3 — Tool-calling to the Cortex** (cloud planner over the existing interceptors).
Infra throughout: a small **role-based cloud fleet** wrapper over the 3 slots, parallel calls, graceful local-only fallback.

## 5. Decisions (locked 2026-06-28)
1. **Front model: Dans-PersonalityEngine-24b** (`hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M`) — DECIDED. Premium voice over the Stheno-8B VRAM/latency win; richer + personality-tuned + uncensored. Note: no VRAM freed (still 24B), so local vision/grounding stays out-of-scope for now; the front's win is *voice + no refusals + freed from cognition (gets a brief)*. mistral-24b retained as fallback.
2. **Distill mode:** `auto` (adaptive, latency-safe). *(recommended default — confirm)*
3. **Distiller model:** `gemma4:31b`. *(recommended default — confirm)*
4. **mistral-24b after the swap:** keep as local reasoner / cloud-down fallback. *(recommended default — confirm)*

## 6. References
- Cloud model assignments + probe findings: `[[cloud-model-assignments]]` / `docs` notes.
- Vision-agent roadmap (where the freed VRAM + tool-routing connect): `docs/VISION_AGENT_RESEARCH.md`.
