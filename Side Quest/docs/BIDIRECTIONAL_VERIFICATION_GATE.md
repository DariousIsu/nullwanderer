# Bidirectional Verification Gate — spec (2026-08-10) · Spine 2

**Origin.** Three live failures that looked unrelated turned out to be one disease:
- **Confabulation (false-positive presence).** C4 audit: "Cleco was acquired by Stonepeak/Bernhard"
  — asserted as fact, 0 hits across web_search + NewsAPI + GDELT-18m. A claim about the world that
  never met a source.
- **False-blank (false-negative absence).** Parish roster §7.1: an email left blank / "none listed"
  when the address was in fact findable — a claim of *absence* that no real search ever justified.
- **False prediction (false-certainty future).** Parish roster §7.6: an outcome stated in the
  indicative ("X will win") rather than as a forecast with uncertainty.

All three are the same shape: **an assertion reached Lucas without ever being checked against
reality.** Presence, absence, and prediction are the three directions the same missing check fails in.

## 1. The disease (one, not three)

The anti-fabrication gate (`metacognition.verifyArtifactClaims` + `groundEmails`, wired at
`main.js _antifabCorrect`) already proves the cure SHAPE works — but only for **artifact** claims:
a file at a path, a canvas write, an image render, a contact-DB write. Those share one property:
they leave a **trace inside Zoe's own runtime** (`fs.existsSync`, `canvas_docs.lastWriteTs()`,
`lastImageGenTs`, `echo_suit.lastContactWriteTs()`). Cheap, synchronous, deterministic.

World-facts have no such internal trace. "Was Cleco acquired?" is not answerable from Zoe's runtime
state — only against a **rendered source**. So the artifact gate, by construction, cannot see any of
the three failures above. They are exactly the claims that leave no local footprint.

The structural root, one level down: **a reply's factual assertions are never treated as objects with
a truth-status.** They stream out as prose. The artifact gate reaches *inside* the prose for a
narrow, locally-checkable subset (files, canvas, images, db). Everything else — every claim about the
world, every claim of absence, every claim about the future — passes ungated.

`groundEmails` is the one exception that points the way: it already treats a reply-email as a
**checkable fact** and redacts any address not present verbatim in the turn's evidence. Spine 2 is
`groundEmails` generalized from emails to **all falsifiable factual assertions**, in all three
directions.

## 2. The principle

> A reply's factual assertions are **objects with a truth-status coordinate**, just as entities are
> objects with a salience coordinate. Before a reply reaches Lucas, each load-bearing assertion is
> checked against reality — the turn's gathered evidence and the ledger of what actually ran. An
> assertion the turn did not ground is **hedged or verified, never asserted flat.**

Presence, absence, prediction — three checks, one substrate: *did this claim meet reality this turn?*

Regex is the cheap **fast-path to FIND candidate assertions**; the grounding decision is
**structural** (present-in-evidence? / gather-dispatched? / forecast-backed?), never a phrasing
whitelist. Same doctrine as the salience manifest: nets locate, structure decides.

## 3. Fail-open, always. Never a false scold.

The load-bearing discipline, inherited verbatim from the artifact gate and `groundEmails`: **every
probe fails OPEN.** Wrongly retracting a TRUE fact Zoe correctly recalled is its own harm — exactly
like wrongly scrubbing a real email. A probe error, a missing dep, an ambiguous parse → assume the
claim is fine. The gate only ever fires on a POSITIVE signal of ungroundedness. It is a backstop, not
a censor.

Corollary (the bare-recall rule, from `groundEmails`'s <20-char guard): when **no evidence was
gathered this turn**, a plain recalled fact is left alone — a bare recall is not proof of invention.
The gate acts when the turn DID gather and the claim isn't in what was gathered, or when the claim is
a specific current-event assertion that *should* have been checked and wasn't.

## 4. The design — three sub-gates, one seam

All three land in `metacognition.js` as pure, dep-injected functions, wired at `_antifabCorrect`
(main.js:14693) as stages **(3)** and **(4)**, after email-grounding **(1)** and artifact **(2)**.
The `evidence` string (cloudMessages + userMessage) is already threaded in.

### 4a. Presence gate — confabulation (`groundFacts`)

The generalization of `groundEmails` from emails to factual assertions.

- **Find (fast-path):** extract candidate falsifiable assertions — a subject + a current-event
  predicate (acquired / appointed / elected / died / merged / resigned / launched / signed), heavy
  on proper nouns and dates. These are the checkable, load-bearing claims; opinion, hedged, and
  first-person process sentences are skipped.
- **Ground (structural):** is the assertion's core supported by the turn's evidence?
  - Evidence gathered AND the claim's key tokens (the proper nouns + the predicate) are **absent**
    from it → **ungrounded**. This is the Cleco signature: an acquisition asserted with specificity
    while nothing in the gathered material mentions it.
  - No evidence gathered (bare recall) → **leave alone** (bare-recall rule) — UNLESS the assertion is
    a specific current-event claim, in which case → **flag for verify** (4a-bounded, below).
- **Act:** an ungrounded assertion is not silently deleted (a fact mid-sentence can't be cleanly
  excised like an email token). Instead the correction append names it: *"I stated X as fact but
  didn't verify it this turn — treat it as unconfirmed."* The reply keeps its shape; the claim loses
  its false certainty.
- **Bounded verify (the actual "verification" in the gate):** for a small, high-value class — a
  single specific current-event assertion with no supporting evidence — fire ONE bounded search
  (the existing keyless search substrate / excavate floor) and re-decide: corroborated → keep;
  contradicted → retract; still-nothing → hedge to "I believe X but couldn't confirm it just now."
  This is opt-in and rate-capped (one verify per reply, hard timeout) so it never turns the reply
  path into a research loop. Ship the flag+hedge first; wire the bounded verify second.

### 4b. Absence gate — false-blank (`groundAbsence`)

The novel one — the artifact gate has no analog, because a NEGATIVE claim ("I couldn't find it",
"no email is listed", "there's no record of X") is unverifiable from inside the reply. To justify an
absence you must confirm the **search that would have found it actually ran**.

- **Find (fast-path):** absence/failure assertions — "couldn't find", "no X (found/listed/available)",
  "there's no record", "nothing came up", "I don't have".
- **Ground (structural):** did a **gather tool actually dispatch this turn**? This is the
  `lastContactWriteTs` pattern applied to search: a new `_lastGatherTs` + `_GATHER_TOOLS` set
  (search / web_search / web_fetch / web_extract / excavate / news_search / quick_lookup / db_query …)
  stamped in `echo_suit.dispatch` exactly like `_CONTACT_WRITE_TOOLS`, exposed as
  `echo_suit.lastGatherTs()`.
  - Absence asserted AND `lastGatherTs() < turnStart` → **she never actually looked.** The blank is
    a confabulated absence.
  - A gather DID run → the absence is honest (she looked and it wasn't there) → leave alone.
- **Act:** the honest correction — *"I said I couldn't find that, but I didn't actually search this
  turn — let me look before calling it blank."* Optionally (parallel to 4a's bounded verify) trigger
  the search rather than just confessing. Confession first; auto-search second.

### 4c. Prediction gate — false-certainty (`groundPrediction`)

- **Find (fast-path):** a future-outcome assertion in the **indicative** — "X will win", "the bill
  passes", "they're going to lose" — i.e. an outcome about a contestable future stated as fact.
- **Ground (structural / modality):** does the sentence carry an uncertainty marker (likely / probably
  / I'd expect / roughly / ~X%) or cite the forecast model (the forecast suite — Brier 0.115)?
  - Neither → **false certainty.** A contestable future asserted flat.
  - Has a hedge or a forecast cite → honest → leave alone.
- **Act:** reframe, don't retract — append/soften to the forecast framing: *"— that's my expectation,
  not a certainty."* Where the forecast suite actually holds a number for that race, prefer surfacing
  it. This is the least regex-avoidable of the three (modality is genuinely lexical), but the decision
  is still structural: *is this claim backed by the forecast organ or a stated uncertainty, or not?*

## 5. Landing order (small, gated steps — mirrors the salience build)

Each step is its own commit, its own smoke, gate stays green (`npm test`).

1. **`echo_suit` gather-stamp** — `_lastGatherTs` + `_GATHER_TOOLS` + `lastGatherTs()`, stamped in
   `dispatch` beside the contact-write stamp. Smoke: a search tool stamps, a non-gather tool doesn't,
   a rejected result doesn't. (The probe every other step leans on — land it first.)
2. **`groundAbsence`** (pure, in metacognition) + wire as `_antifabCorrect` stage (3). Smoke: the
   §7.1 false-blank verbatim, plus fail-open + honest-absence (a real gather ran) guards.
3. **`groundFacts`** presence gate (flag+hedge only, no bounded verify yet) + wire as stage (4).
   Smoke: the Cleco confab verbatim, plus bare-recall-left-alone + grounded-fact-passes guards.
4. **`groundPrediction`** + wire. Smoke: the §7.6 wrong-prediction verbatim, plus hedged-passes +
   forecast-cited-passes guards.
5. **Bounded verify** for 4a/4b (opt-in, one search per reply, hard timeout) — the gate stops merely
   confessing and actually checks. Wire R5's browser-render + de-obfuscation as its instrument.

Steps 1–4 are the honest-hedge backbone (cheap, synchronous, ships the whole disease-surface). Step 5
is the active-verification upgrade and can trail.

6. **Absence active-search** (BUILT 2026-08-10) — the 4b upgrade from confess to CHECK. When she declares
   an EMAIL absent without an external search this turn, `verify_claim.verifyAbsence` fires one bounded
   search for the subject's email and posts a follow-up: FOUND → surface what she wrongly called blank
   (the §7.1 cure); NOT-FOUND → confirm the blank is honest. Scoped to EMAIL (the cleanly-extractable,
   highest-value case; phone/address stay confession-only). `main.js _verifyAbsenceFollowup`,
   fire-and-forget, same external-gather gate as step 5, fully fail-soft.

**Live-verification note (2026-08-10).** The 4 synchronous gates are proven live via the test-port
`/antifab` route (all 7 cases). The async verify beats (steps 5, 6) are logic-proven by smoke and their
wiring executes live, but a live POSTED beat is rare in practice: for well-known facts the reply operator
auto-enriches (a real external gather), grounds the claim, and the beat correctly skips — the system being
healthy. The live drives also hardened the gather signal into TWO tiers (external vs any) and TURN-SCOPED
it (`!lane.isAutonomous()`), so background metabolism no longer masks "did SHE look this turn."

## 6. What this is NOT

- Not a fact-checker for every sentence — only load-bearing, falsifiable, checkable assertions.
- Not a censor — it hedges and confesses; it retracts only on a positive ungroundedness signal, and
  fails open on every probe.
- Not a phrasing whitelist — regex finds candidates; evidence-membership / dispatch-ledger /
  forecast-backing decides.
- Not synchronous world-verification in the hot path (except the bounded, capped step-5 verify) —
  the backbone grounds against what the turn ALREADY gathered.

## 7. Why this is the right next build

The parish roster justifies it sharply: the same deliverable carried a false-blank (§7.1) and a
false-prediction (§7.6), and the same session surfaced the Cleco confab (§C4). One gate closes all
three. And it composes with Spine 1: the salience manifest makes sure the reply is *about the right
entity*; the verification gate makes sure what it *says* about that entity met reality. Discourse
correctness and truth correctness are the two spines a reply rides.
