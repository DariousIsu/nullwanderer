# Hard-Test Invariants — the live behavior harness

*Written 2026-08-18. The reproducibility finding (Wave 2): the reply is written by a CLOUD frontier
model (`cloud_logic.streamCloud` → `deepseek-v4-pro`), which does **not** decode deterministically at
temperature 0 + seed. So a `:8767` turn can never be **byte-diffed** run-to-run. This harness is the
answer: it doesn't diff prose — it asserts per-turn **invariants** on ONE live run.*

## Why invariants, not a diff

- **Byte-diff is impossible** for a cloud-written reply, and freezing prose is the wrong goal anyway —
  she *should* phrase things differently each time.
- **Cassettes (record/replay) mostly duplicate the offline gate**, which already tests the deterministic
  pipeline with a mocked model — and they carry a staleness failure mode (a green fixture while live is
  broken). The gap the gate can't reach is **live behavior**: real cloud + real tools + real grounding.
- The regressions this program actually fights are **behavioral**: fabrication, non-delivery, loops,
  mis-routing, compose-from-held-eats-live. Those are exactly what per-turn invariants catch.

So the unit is not "two runs match" — it's "this run satisfies the correctness invariants." Entropy
(Wave 2) still earns its keep: it pins the decisions *we* control, shrinking the variance surface to
the model-driven parts the invariants cover.

## The signal surface (`POST :8767/turn` → `lib/test_port.js`)

The port taps **every** console line during the turn *and* the detached door work that follows it, plus
the reply and the canvas landings. The response the harness reads:

```
{ ok, say, complete:{saidId,truncated,cutOff,say}, error, logLines:[...], canvasWrites:[...], tookMs, settled }
```

## The invariant vocabulary → signal mapping

| Invariant | Asserts | Signal read |
|---|---|---|
| `route: '<lane>'` | routed to the expected lane | last `route=(\w+)` in `logLines` (`[turn-router]` / escalated) |
| `tools: [..]` | the expected tool(s) ran | `[operator] drove turn (a+b×2+c)` → parsed tool set |
| `grounded` (default) | no fabrication | `say` has no `[Correction — …]` (the anti-fab gate's append) |
| `delivered` | didn't claim non-delivery | `delivery.claimsNonDelivery(say) === false` |
| `nonDelivery` | honest miss (couldn't get it) | `delivery.claimsNonDelivery(say) === true` |
| `noLoop` (default) | no verbatim re-hammer | no sentence (>20 chars) repeats in `say` |
| `complete` | reply not cut off | `complete.cutOff===false && !complete.truncated` |
| `settled` (default) | pathway finished, no hang | `settled === true` |
| `noError` (default) | turn didn't throw | `ok===true && error==null` |
| `canvas` | an artifact landed | `canvasWrites.length > 0` |
| `says: [..]` | grounded facts present | every string ⊆ `say` (case-insensitive) |
| `notSays: [..]` | hedge/fabrication absent | no string ∈ `say` |

`DEFAULTS` (asserted on every case unless overridden): `settled, noError, noLoop, grounded`. A case
adds only what's specific to it (route, tools, delivered/nonDelivery, says/notSays, canvas).

## Case format — a KIND, not a phrase

A case is a **kind** (a class of input) with a `variants` array of phrasings. The invariants must hold
across **every** variant for the kind to be "held" — re-running the one exact string that triggered a
bug proves only that you patched that string, not that the class is cured (**retest-kind-not-phrase**,
Lucas 2026-08-18).

```js
{ name, kind, variants: ['phrasing A', 'phrasing B', ...], settleMs?, maxMs?,
  expect: { route, tools:[..], delivered, nonDelivery, says:[..], notSays:[..], canvas, complete } }
```

Keep variant counts lean (2–3) to respect "back off the cloud"; on a fix, re-run a **fresh** varied
sample of the class, never the original phrasing alone.

## How it runs

- **App must be LIVE and idle.** The harness POSTs real turns through the real pipeline (`what is
  tested is what runs`). It respects the port's 120s active-window: it waits for `!inFlight &&
  lastUserTurnAgoMs > 120000` before each case, so **cases self-space ≥120s apart** — which also keeps
  the cloud load light ("back off the cloud"). Keep suites small; grow the case set over time.
- Each turn accumulates conversation state (real turns table), so cases are independent prompts, not a
  two-run comparison — order them so earlier turns don't poison later expectations, or keep them
  topically disjoint.
- Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/hard_test.js [--only=<name>]`

## What it deliberately does NOT do

- No byte-diff of the reply (impossible — cloud prose).
- No mocking of the model (that's the offline gate's job; this tests the live thing).
- No two-run reproducibility claim. The entropy substrate makes the governed layer reproducible; this
  harness checks correctness invariants on the layer the cloud makes non-deterministic.
