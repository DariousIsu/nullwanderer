# Spine 3 — Delivery Binding — spec (2026-08-10)

**Origin.** The census's "one work-contract spine," now isolated. A task or promise must bind to ACTUAL
delivery: try every path, never settle on a bare promise, and hand over something SCOPED, coverage-honest,
and CONSUMABLE. The parish-roster deliverable is the canonical acceptance test.

## 1. The disease (one, several faces)

**THE CROSS-CUTTING PATTERN (census, reproduced in 4 lanes):**
> pick a primary reader → the primary fails → **no fall-through** to the working path → end on an **unkept
> promise-say** (sometimes an unsettled session that leaks into later turns).

- G6 (search/excavator → never tries `web_fetch`), C4 (same), G3 (DOM-captions → never tries
  `av_transcribe`; session never terminates), G2 (Teams captions), F4 (narrates writing a tool file →
  no file ever written).

Two structural failures underneath:
1. **No fall-through.** One tool is chosen; when it fails there is no descent to the working alternative,
   so a reachable answer is reported as unreachable. (The web-read *floor* landed — `excavate → web_fetch`,
   9cbdf83 — but the pattern is generic and video/meeting/tool lanes have no floor.)
2. **No delivery binding.** A reply can PROMISE work ("I'll pull that together", "let me get that for
   you", "creating the file now") and the turn simply ends. Nothing checks the promise was kept, and
   nothing carries an unkept one forward. `commitments.js` deliberately *drops* these (they're task-
   acceptance, not held positions), and the anti-fab gate only catches a COMPLETED-artifact claim that's
   false — not a bare FUTURE promise that quietly dies.

## 2. The principle

> A promise is a debt. Either the turn pays it (deliver, falling through every working path first), or it
> is booked as a tracked commitment and said honestly ("queued — I'll surface it when it's done"). A reply
> may never end on a delivery-promise that is neither kept nor tracked.

Delivery-honesty is the third spine beside discourse-honesty (Spine 1) and truth-honesty (Spine 2). Same
shape: detect the falsifiable thing at the reply seam, check it against reality, correct/route what fails.

## 3. The design — two generic organs + the deliverable doors

### Part A — the generic delivery-honesty spine

**A1. Fall-through, generalized.** The floor pattern (`primary fails → try the working alternative → only
then report`) lifted out of `excavate` into a small reusable shape and applied to the lanes that still lack
it: video (DOM-captions → `av_transcribe`), and any future reader with a known working fallback. Each lane
keeps its own instruments; the *pattern* is shared.

**A2. Promise→delivery binding (the spine proper).** A gate at the reply seam (beside `_antifabCorrect`):
- **Detect** a delivery-PROMISE the reply makes — future-tense "I'll/let me/I'm going to [pull/compile/
  gather/find/get/send/build/put together] …" that names a deliverable, excluding a genuine offer ("want
  me to?") which is fine to leave open.
- **Check** whether it was kept THIS turn (an artifact/file/canvas write, a delivered answer) — reuse the
  gather/write stamps + the artifact probes already built for Spine 2.
- **Route the unkept:** book it as a tracked commitment on the **recheck queue** (the metabolism-floor
  organ) so it is actually carried, and make the say honest — "I've queued that; I'll surface it when it's
  done," not a hollow "on it." An unkept, untracked promise is the violation.

This is the delivery analog of `groundFacts`: regex FINDS the promise; a STRUCTURAL check (kept? tracked?)
decides; the recheck queue is where an unpayable-this-turn promise goes so it is never silently dropped.

### Part B — the parish-roster deliverable doors (acceptance-test instruments)

| Door | What | Kind |
|------|------|------|
| **R6** | native styled-spreadsheet **OUT** (xlsx writer) + an **openable check** (delivered ≠ openable; default CSV on failure) | new output door — self-contained, deterministic to test |
| **R1** | parish/local governing-body **source tier** for `roster_refresh` (federal + state exist; local doesn't) | new data organ |
| **R3** | governance-type **scoping** (Police Jury / President+Council / Commission / Metro Council; exclude sheriff/clerk/DA) | new scoping organ |
| **R2** | completeness+trust gate — an INDEPENDENT denominator, serve-vs-rebuild decision | Spine 2+3 |
| **R4** | swarm roster-mode production-grade + un-throttled for a directed completion (C5) | scale |

R5 (per-row source-grounded browser-render + de-obfuscation) and R7 (lead with the honest ceiling) are
Spine 2 instruments and are wired there / done.

## 4. Landing order (proposed)

Two coherent entry points; the first is the principled "build the generic organ first" (as Spine 2 was),
the second is the most concrete and directly unblocks the beta bar's OPENABLE requirement:

- **A2 promise→delivery binding** — the generic spine; cross-cutting; reuses the Spine-2 seam + recheck
  queue; smoke-testable pure (promise detector + kept/tracked decision).
- **R6 spreadsheet-OUT + openable check** — the most tangible door; the beta bar explicitly needs an
  openable spreadsheet; deterministically testable (write xlsx → reopen → assert rows/sheets).

Then A1 (fall-through generalization), then the data/scoping organs R1/R3, then R2/R4.

## 5. Discipline (inherited)

Fail-open / never a false scold (a genuine open offer is not a broken promise); regex finds candidates,
structure decides; each step its own commit + smoke, gate stays green; build the generic organ before the
specific instrument.

## 6. The beta bar (acceptance test)

Zoe *natively* pulls a complete, governance-scoped, source-verified, coverage-honest Louisiana parish
roster and hands over an OPENABLE spreadsheet — every blank a VERIFIED "not published," not an un-attempted
lookup. When she does that in one commissioned turn, all three spines are proven and beta is real.
