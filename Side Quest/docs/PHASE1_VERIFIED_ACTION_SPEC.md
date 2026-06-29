# Phase 1 Spec — Verified Action Loop (her own browser sandbox)

**STATUS: BUILT + smoked 2026-06-28 (39-suite gate green). NEEDS REBOOT to run live.** Impl: `lib/web_verify.js` (pure gate/verdict/followup — `smoke_web_verify.js`, 15 ok) + main.js web-dispatch branch for `web-click/type/scroll/back` → auto fresh-read → gated vision verify → recovery directive → `web-act` telemetry. Config db meta `web.verify` (default `always` during study) / `web.verify.maxVisionPerTurn` (3) / `web.verify.minReadChars` (120). Her OWN browser only.

*Spec'd 2026-06-28. Implements the recommendation in `docs/VISION_AGENT_RESEARCH.md` §5 P1. Scope is HER OWN browser only (full-access sandbox). Shared browser + desktop `os_*` are out (gated, later phases).*

## 1. Problem this fixes
Today she can act (`<web-click>L3</web-click>`, `<web-type selector="I0">…</web-type>`) but **those tags surface nothing back** — main.js has dispatch branches for `web-read/web-see/web-open/web-chat` but **none for `web-click`/`web-type`**. So she clicks/types blind and must remember to `web-read` to discover what happened. That's brittle and un-studyable.

Phase 1 makes every state-changing action **self-perceiving and self-verifying**: act → fresh page state comes back automatically → she confirms it worked or recovers. This is the research-consensus pattern ("fresh a11y snapshot after every action" + vision verification), and it's the foundation every later phase reuses.

## 2. Goal & success criteria
- After any state-changing web action in her browser, she automatically receives: the action outcome + the **fresh page state (new handles + text)** + a **verification verdict** (did the expected thing happen?) + a **recovery directive** if it didn't.
- She no longer has to manually `web-read` after acting.
- Everything is logged so we can **study her behavior** (what she reaches for, where grounding/verify fails, how she recovers).
- Latency stays bounded (≤1 vision call per action; viewport capture).

## 3. Scope
**In:** `web-click`, `web-type`, `web-scroll`, `web-back` (state-changing) in her own browser → auto re-read + gated vision verify + recovery directive + telemetry. Optional `expect="…"` attribute.
**Out (unchanged / later phases):** shared browser (`browse-*`), desktop `os_*` (both gated). No NEW acting primitives — reuses existing `click()`/`type()`. Image generation untouched. `web-open`/`web-read`/`web-see` keep current behavior (already perceive).

## 4. Design

### 4.1 Action → auto-perceive (the loop)
For a successful state-changing web action, the dispatch now runs a **perceive step** and fires ONE tool-followup:
1. **Fresh a11y read** — `web.read()` → new handle list + text (always; cheap, DOM-only). Keeps her synced with the post-action page (research: "fresh snapshot after each action").
2. **Gated visual verify** — when the gate (§4.3) trips: `web.screenshot()` → `vision.describe()` with a verify-focused prompt → a short verdict + note.
3. **One followup** carrying: `[action X done] + [fresh page state] + [verify verdict + note] + [recovery directive if not CONFIRMED]`.

### 4.2 Stated expectation (optional)
She may declare the expected outcome on the action:
`<web-click expect="the login form opens">B2</web-click>` · `<web-type selector="I0" expect="search box shows my query">running shoes</web-type>`
The verify step checks the new state against `expect`. If omitted, verify is generic ("what changed; any error/dialog/no-op").

### 4.3 Verify gate (latency control)
Run the vision verify when ANY of:
- verify mode is `always` (default during the **study phase** — richest data), OR
- verify mode is `auto` AND (the fresh a11y read is **thin** — `< MIN_READ_CHARS` or `< 2` new handles → likely canvas/visual), OR `expect` was set, OR the action triggered navigation/url-change/an error.
- verify mode `off` → never (a11y re-read only).
Config: db meta `web.verify` ∈ {`always`,`auto`,`off`} (default **`always`** in sandbox study; flip to `auto` once we've learned her behavior). Cap: db meta `web.verify.maxVisionPerTurn` (default 3) — excess actions get a11y-only.

### 4.4 Verify prompt + verdict
Prompt to `vision.describe`:
> "This screenshot is the page AFTER this action: «{action}» (expected: «{expect||none stated}»). In 1–2 sentences: did the expected result happen? Call out any error message, popup/dialog, or that nothing changed. Begin with one word: CONFIRMED, UNCLEAR, or FAILED."
Parse the leading keyword → `verdict ∈ {confirmed, unclear, failed}` (default `unclear` if unpar-seable).

### 4.5 Recovery (bounded)
- `confirmed` → followup directive: continue / report to Lucas.
- `unclear`/`failed` → directive: recover — re-read, pick a different handle, scroll, or ask Lucas. **Bounded:** the same (action,handle) is auto-perceived at most once; we never auto-re-click. She decides the next move (this is what we want to *study*, not automate away).

### 4.6 Telemetry (the study)
Every verified action logged as a `monologue` reading `model:'web-act'` with: `{action, handle, expect, verdict, urlBefore, urlAfter, visionRan}` + a console line `[web-act] click L3 → CONFIRMED (vision)`. So we can review her behavior + grounding/verify failure modes without new tables.

## 5. Config (db meta, no migration)
- `web.verify` = `always` (default, study) | `auto` | `off`
- `web.verify.maxVisionPerTurn` = `3`
- `web.verify.minReadChars` = `120` (thin-read threshold for `auto`)

## 6. Code changes (files · functions)
- **lib/web.js**
  - `WEB_TAG_RE` / `parseAttrs`: already capture attrs → `expect` comes free.
  - Add `actAndPerceive({ tag, handle, text, expect })`? → **No** — keep orchestration in main (it already owns dispatch + followup + vision). web.js stays primitive (`click`/`type`/`scroll`/`back`/`read`/`screenshot` already exist).
  - `buildPromptBlock`: document that actions are auto-verified ("After you `<web-click>`/`<web-type>`, the page's new state comes back automatically — you don't need to `<web-read>` again. Add `expect="…"` to say what you think will happen; if it didn't, you'll be told so you can recover."). Add `expect` to the examples.
- **lib/vision.js**: reuse `describe()` (no change) — main passes the verify prompt. (Optional thin `verifyVerdict(text)` parser lives in main or a tiny exported helper.)
- **main.js** (webTagsToRun dispatch loop): add the state-changing branch — after `web-click`/`web-type`/`web-scroll`/`web-back` success → `web.read()` → gate → optional `web.screenshot()`+`vision.describe()` → parse verdict → ONE `fireToolFollowup` with state+verdict+recovery → telemetry. Track `_visionThisTurn` against `maxVisionPerTurn`. Parse `t.attrs.expect`.
- **lib/context.js**: VISION/capabilities note — "In your own browser your actions are self-verifying: click/type, and you'll automatically see the new page + whether it worked."
- **No new tables.** No new tags (reuses `web-click`/`web-type` + the new `expect` attr).

## 7. Safety (sandbox = full access, still bounded)
- Her own browser only (separate Playwright profile; cannot touch Lucas's tabs or the desktop).
- Keep existing blocker handling: CAPTCHA / sign-in / paywall → `r.blocker.needsHuman` → ask Lucas (never defeat).
- Bounded: ≤1 auto-perceive per action; no auto-re-click; ≤`maxVisionPerTurn` vision calls/turn.
- Every action + verdict logged.
- Shared browser + `os_*` remain gated and explicitly out of scope.

## 8. Tests / proof
**Offline smokes (deterministic, deps injected):**
- `verifyVerdict()` parses CONFIRMED / UNCLEAR / FAILED (and defaults to unclear).
- verify-gate logic: `always`→verify; `off`→never; `auto`+thin read→verify; `auto`+rich read+no expect→skip; cap respected.
- `expect` attr parsed from `<web-click expect="…">`.
- orchestrator with injected `read`/`screenshot`/`describe` (no live browser): click → re-read → verify → followup payload contains fresh state + verdict + (failed→recovery directive).
**Live (in-app, sandbox):**
- real click on a test page → followup shows the new handles + CONFIRMED.
- deliberate bad handle / wrong click → FAILED + recovery directive; she recovers.
- `web.verify=off` → a11y-only, no vision.
**Gate:** add `smoke_verified_action.js`; full 29→30 suites green; 0 new lint errors.

## 9. Build slices (ship incrementally)
- **S1** — auto a11y re-read + followup after click/type/scroll/back (the biggest reliability win, zero vision cost). Replaces "clicks blind."
- **S2** — gate + vision verify + verdict parse + `expect` attr.
- **S3** — recovery directive + bounded perceive + telemetry (`web-act` readings).
- **S4** — smokes + capability prompt + gate green.

## 10. Decisions to confirm (recommendations in **bold**)
1. **Verify mode default during study:** `always` (verify every action — richest behavioral data, slower) vs `auto` (smart-gated — practical). → **`always` for the study phase**, flip to `auto` once we've characterized her. *(config flip, no rebuild)*
2. **On FAILED:** hand back to her to decide the next move (study her recovery) vs auto-retry once. → **hand back** — we want to observe her recovery, not mask it.
3. **Verify model:** reuse `gemma4:31b` (current vision model) — **yes**, it's proven + fast; revisit a dedicated grounding model only at the desktop phase.

## 11. Latency expectation
Per verified action ≈ DOM re-read (<0.5s) + (gated) one viewport vision call (~few s) + one followup generation. Comparable to a single `web-read` plus an optional `web-see`. Bounded by `maxVisionPerTurn`. Deliberate-pace, not real-time — consistent with the research.
