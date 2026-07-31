# Methodology parity — scope

**Source:** `Methodology_How_This_Work_Was_Built.docx` (Rainey Center, 2026-07-29) — the process record
behind the data-center/grid op-ed project.
**Question:** can Zoe follow the same path and logic?
**Scoped:** 2026-07-31, against the live tree at `2756491`.

---

## The finding that reorganises this scope

I first read the gaps as three separate things (stake labels, a tier gate, a hostile reader). Reading
the code, they are **one missing primitive with three consequences.**

Her research is organised around **subjects** — a plan is `{objective, approach, targets, databases,
facets}` (`lib/research_plan.js:130`). The methodology is organised around **an argument to be
defended and an adversary who will attack it.**

Every gap follows from that one absence:

| methodology element | why it needs the argument |
|---|---|
| "Define the hostile reader first" (§8) | the adversary IS the organising object |
| dossiers answering "a specific vulnerability" (§4) | a vulnerability is a weak point *in an argument* |
| COUNTER-EVIDENCE, "carried at full strength" (§3) | "cuts against" is undefined without a thesis |
| Tier 3 excluded "including the flattering ones" (§5) | flattering *to what?* |
| honest concession of the opponent's best number (§5) | requires knowing who the opponent is |

So this is **one new object, one new field, one new gate** — not five features.

---

## What already exists (verified, not assumed)

Substantially more than I expected.

- **§2 primary-source preference** — better than the doc describes. The doc used live web search; she
  has structured primary surfaces (USAspending, ProPublica 990, FEC, EDGAR, eCFR, Federal Register,
  CourtListener, Legistar). "Prefer primary over commentary" is enforceable by *routing*.
- **§2 retrieval discipline** — the "too big to load, read in sections" pattern is already law
  (full-document ingest, chunk to the window). Matches the QER/NERC handling exactly.
- **§6 per-claim citation** — already enforced at generation. `buildUnderstandTargetPrompt`
  (`lib/research.js:418`) requires `(source: <url>)` on every load-bearing fact, chosen ONLY from
  pages the run actually visited, with `[pages read this pass: …]` markers binding a claim to the
  page it came from, `(source: held doc:N)` for her own store, and an explicit ban on invented URLs.
- **§7 known limitations** — her strongest suit. First-class `absence` table, `capability_needs`, and
  every synthesis emits `OPEN:` lines naming what it could not answer.
- **counter-evidence has a slot** — `**Tensions & unknowns:**` in the synthesis;
  `lib/editor_checks.js:262` already reports "corroboration/counter-evidence for the author to weigh."
- **§5 fact-check → corrected framing** — the two-lane editor: citation verifier (cited source ONLY)
  then fact check (advisory).
- **`authority_tier` already exists** — 1 = primary/official, 2 = major outlet, 3 = told
  (`lib/event_lane.js:129`, `lib/belief_correction.js:36`), max-reduced in `lib/reconcile.js:55`.
- **the refuter already exists** — `lib/rehearsal_driver.js:318` (O6): a separate call whose only job
  is to BREAK a claim, "default to refuted when uncertain", advisory and never a gate. It is pointed
  at her *code* work, not at research claims.
- **`packaging.selfCheck()`** (`lib/packaging.js:213`) is exactly where house constraints belong, and
  `doc_shapes.js:82` already carries `lengthRule: 'Typically 700–800 words.'` as prose.

---

## The slices

### S0 — the argument record  ⭐ keystone
**What:** a research run can carry a THESIS, a HOSTILE READER, and a list of VULNERABILITIES.
**Where:** `lib/research_plan.js` (`planWant` / `normalizePlan` / `renderPlanPage`), plan generation
in `main.js:12311`, and the facet generator so dossiers are *derived from vulnerabilities* rather
than from topic coverage.
**Why first:** S2's tier rule and the COUNTER-EVIDENCE label are both undefined without it.
**Note:** likely a 4th `kind` (`argument`) rather than a change to `entity`/`topical`/`forecast` —
the planner is already kind-shaped, so this composes instead of disturbing existing runs.
**Size:** ~120 LOC + smoke.

### S1 — `stake`, beside `authority_tier`
**What:** the orthogonal axis her provenance is missing. `authority_tier` says *how official*;
`stake` says *whose interest the claim serves*: `independent` | `subject_reported` |
`interested_accepted` | `unknown`.
**Key design point:** the doc's five labels are **derived, not stored** —
- CONFIRMED = authority 1-2 AND stake independent
- COMPANY-REPORTED = stake `subject_reported`
- ATTRIBUTE-TO-UTILITY = stake `interested_accepted` (produced by an interested party, accepted by a
  regulator, not independently audited)
- COUNTER-EVIDENCE = relation to the thesis (needs S0)
- NOT VERIFIED = no primary source resolved

**Where NOT to put it:** `studio/creator_sources.js`. Its header states an explicit HONESTY LINE —
that module answers "does citable material exist", never "is this true" — and stake is a judgment.
It belongs on the citation record, next to `authority_tier`.
**⚠ The risk in this whole build:** deriving stake automatically. A *wrong* stake label is worse than
none, because it would mark a company's own number as independent. Mitigation: default `unknown`,
require positive evidence (source host matches the org named in the claim → `subject_reported`), and
follow the same conservative direction as the facet filter — only label on strong evidence.
**Size:** ~100 LOC + smoke. Independently valuable even if nothing else is built.

### S2 — the tier gate, at DRAFT time only
**What:** Tier 1 may lead; Tier 2 only with its conditions attached; Tier 3 never reaches a draft.
**Why "draft time only" matters:** her memory model is deliberately *grade is priority, not a gate*
(unsubstantiated = prove-or-fade). This slice must NOT change that. It gates what crosses into a
**deliverable**, leaving the store's churn intact.
**Where:** the packaging / papers path, beside `packaging.selfCheck`.
**Size:** ~60 LOC + smoke.

### S3 — point the refuter at research claims
**What:** reuse O6's exact shape — swap `{goal, diff}` for `{thesis, claim, sources}`, new task name,
same "default to refuted when uncertain", same advisory-never-a-gate posture.
**Why it's cheap:** the hard part (an adversarial posture that doesn't defend its own output) is
already built and proven in the code lane.
**Size:** ~40 LOC + smoke. Needs S0 for the thesis.

### S4 — house constraints, programmatic
**What:** zero em/en dashes and the word ceiling checked in the build, not requested in prose.
**Where:** extend `packaging.selfCheck()`; promote `doc_shapes.lengthRule` from guidance to a check.
**Size:** ~40 LOC + smoke. Independent of everything else; can land any time.

**Total: ~360 LOC + smokes.** A bounded build, not a rewrite.

---

## The honest limit on all of this

The methodology was executed by a **human-directed** workspace with a person making the judgment
calls: which claims are Tier 3, who the hostile reader is, which of the opponent's numbers to
concede. Automating the *pipeline* is what's scoped here. Automating the *judgment* is a different
and much larger claim, and I would not make it.

The realistic target is: **Zoe proposes the argument record and the stake labels; Lucas confirms.**
That still delivers the method's core value — facts before prose, provenance that travels to the
page, and claims that fail the tier rule kept out of the draft — without pretending the model can
decide what a hostile reader believes.

## Recommended order

**S0 → S1 → S2 → S3**, with **S4 any time** (it's a quick, self-contained win).

S1 is the natural stopping point if the appetite is smaller: stake labels are independently useful
across every deliverable she already produces, argument record or not.
