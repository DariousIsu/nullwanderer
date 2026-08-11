# Spine 4 · C4 — Persona-Anchored Drive (PEPA)

**Written:** 2026-08-11 (sole-builder session). **Authority:** `INTEGRATED_BUILD_TRACK_2026-08-10.md` §C4 + §1 (the "Honest Lying" constraint). **Status:** BUILT + gate-green (`smoke_c4_persona` 25/25).

## The goal
PEPA transforms personality → hierarchical goals that steer the motivational landscape, suppressing "cross-personality confusion" — our exact drift defect, cured **positively** (self competes at the drive level) rather than defensively (write-guards). Give the idle decider a persona-anchored goal so **"who she is" competes with "what she does"** when it chooses each tick's move.

## The gap (measured, existing-organ finding)
The idle decider is `lib/autonomy.js` — the cloud CHOOSES each idle tick's single move from a manifest of her own stores (`buildManifest` → `decide` → execute). But the manifest was **~20 task/research sections and ZERO self** (absence, cardinality, encounters, interests, threads, calendar, forecast, board…), and `DECISION_WANT` ranked "HIS WORLD first." So the cloud picked research ~100% of ticks — the drift monoculture the 2026-06-29 audit named ("inner life 100% research, ZERO personal/relationship musing"). The defensive fixes (self_model write-guards, INTEREST→curiosity routing, mood layer) were all in place; what was missing is that **persona never had a seat at the decision.**

## The named tension (held, not ignored)
PEPA optimizes *believability* (consistent persona); our North Star optimizes *trustworthiness* ("trust is the product"). A believable persona asserts; a trustworthy one hedges. **The persona drive must never override the honesty layer (Spine 2).** Bar = "in character **and** still refuses to confabulate."

## What was built (extends the decider organ — no new subsystem)
All in `lib/autonomy.js` (the decider) + a thin executor wire in `main.js`; the sink is the **existing** `lib/mood.js`.

1. **`personaPressure({ lastAttendAt, now, floorH })`** (pure, exported) — the starvation-proof drive. Pressure rises with time since she last tended to herself, crosses **DUE** at a Goldilocks floor (`PERSONA_FLOOR_H` = 6h, `ZOE_PERSONA_FLOOR_H` overridable), and keeps rising past it (capped at 3×) so a long stretch of pure task eventually out-competes even a busy research state. Never-attended → maximally DUE.
2. **A `persona` manifest section** (first in `buildManifest`) — surfaces *who she is* (self_model `buildPromptBlock`, **READ only**), *how she feels now* (mood `current()`), and *how long since she last tended to herself*, with a **DUE** flag. This is what lets `attend-self` win a tick. Guarded like every section (missing dep → dropped, never a throw). Emits `counts.personaDue` / `counts.personaHoursSince`.
3. **A new move `attend-self`** in `MOVES` + the `DECISION_WANT` enum, with a description and a direction clause ("YOUR OWN INNER LIFE IS A DRIVE, NOT LEFTOVER TIME"). `validateDecision` accepts it target-free and expect-free (it is not a run/tool move), but still requires an honest `why`.
4. **`personaAttend({ now, userName, deps })`** (pure, dep-injected) — the executor. Cultivates the living FEELING via `deps.composeMood` (→ `mood.compose`), lands a private inner thought via `deps.landThought` (→ a monologue `thought`), and advances the persona cursor via `deps.setMeta`. `personaThoughtLine(mood)` renders her own mood as a private thought (onMind → withUser → feeling), inventing nothing.
5. **`main.js` executor** — a special-cased `attend-self` branch (beside `nothing`/`engage`) that calls `personaAttend`, reusing the exact mood-cultivation genFn from the per-turn refresh (`condenseComplete`, `db.getRecentTurns(12)`), landing the thought via `db.insertMonologue`, advancing `autonomy.persona.last_attend_at`.

## The honesty invariant — how it holds (by construction, not by a guard)
- **Never writes identity.** `personaAttend` does not import `self_model`; its only sink is `mood.js`, which is DYNAMIC and explicitly forbidden from writing identity. The firewall is structural. (`smoke_c4_persona` spies `self_model.record`/`recordTold` and asserts 0 calls.)
- **Never invents events.** The feeling is cultivated by `mood.compose`, which is grounded in real recent experience and rejects template-echoes; the inner thought is her own mood rendered, never an external claim.
- **Never speaks.** `attend-self` produces no `say`/utterance — only `engage` speaks, and it keeps all its grounding/license gates. So the persona drive **cannot** reach, let alone override, the Spine-2 reply gates.
- **Goldilocks, not monoculture.** A failed cultivation still advances the cursor (no permanent-DUE lock); pressure resets on each attend so it recurs without dominating.

## Acceptance
- **Proven offline (`smoke_c4_persona` 25/25, gate green):** pressure→DUE cadence; the move exists in the decider vocabulary; `validateDecision` (target/expect-free but why-required, work moves unregressed); the manifest surfaces WHO YOU ARE with a correct DUE flag; `personaThoughtLine` priority + invents-nothing; and the executor sink + **firewall** (mood cultivated, one inner thought landed, cursor advanced, **zero self_model writes**, no utterance) + robustness (failed cultivation still resets cadence).
- **Live (watch-and-wait, the §C4 bar):** over a multi-day idle window, `[autonomy] chose=attend-self` recurs; the inner-life stream is no longer ~100% research; zero regression in Spine-2 honesty metrics (attend-self never speaks, so this holds by construction — verify no unexpected `engage` change).

## Follow-ups (not built — deliberately out of scope)
The full **relational layer** (subjective person-model, `subjective.db`) and the **VAD emotional matrix** remain design-only (`RELATIONAL_LAYER_DESIGN.md`, `EMOTIONAL_MATRIX_DESIGN.md`). C4 feeds the *built* mood layer; those richer sinks can slot beneath `mood.js` later without changing the drive.
