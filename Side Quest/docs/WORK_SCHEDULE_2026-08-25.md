# WORK SCHEDULE — 2026-08-25

**Status:** ACTIVE — drawn up on Lucas's order with the planned verification tests inline.
**Standing method:** every build lands with a smoke + full gate (`$?` captured) → commit (named files) → push → reboot to arm → LIVE verification before the item is called done. Catches cure same-hour when small; deep ones get logged with a cure shape and join this schedule.
**State at writing:** boot_p138 live · gate 581 · pushed `0982790` · 5 budget-blocked fleet contracts (A/B/D/H/E) parked as the test bed · campaign file §26-§28 = the full trail.

---

## Phase 1 — TODAY: arm + live-prove the fuel-access wave

The bulk battery's verdict: cite-closure works on held fuel; the wall is fuel access. Today's cures attack exactly that wall. Each gets its live proof on the parked fleet — the contracts that FAILED for these reasons are the acceptance tests for their cures.

| # | Item | Verification test (pass = the item is done) |
|---|------|---------------------------------------------|
| 1.1 | Reboot p139 (arms: B1 answer-leg cross-competition · B2 find-reads · store-as-we-go · done-nudge · lane-primary junk-as-miss) | Boot resume lists the 5 parked contracts; gate stays 581. |
| 1.2 | **B2 live proof** — "keep going" steer on **A-held** (UT sponsor spotlight) | The driver uses `read_held … find:"HB0291"`-class reads, reaches the v13 report's roster PAST the head, and fills ≥2 of 3 slots WITH citations. The B2 class (12 blind reads beside a full pantry) does not reproduce. |
| 1.3 | **Junk-as-miss live proof** — "keep going" steer on **H-ext** (teacher-bonus sourcing) | boot log shows `stealth lane PRIMARY returned brand-nav JUNK … federation fallback` on at least one query, and NO brand-junk row ever reaches a wave observation as an "answer". |
| 1.4 | **Store-as-we-go live proof** — any wave that `web_read`s a page | `[contract-agent] store-as-we-go: banked <url>` in the log AND the source is `search`-findable in Echo the same session. |
| 1.5 | **Done-nudge live proof** — **D-ext** (all-flagged, idled to budget death in the battery) | On its extension, D's next wave acts `done` instead of idling; close-out runs; the artifact lands with honest flags. |
| 1.6 | Final fleet census → §29 verdict | Cite-closure rate re-measured per fuel class; compare against §28's table (held 5/9 → target ≥7/9; external 0/4 → any cited fill = the fuel wave proven). |

## Phase 2 — THIS WEEK: the remaining loop polish (small, sequenced behind Phase 1's evidence)

| # | Item | Verification test |
|---|------|-------------------|
| 2.1 | Flag near-dupe (truncation defeats exact-dedupe — rapides-jobs stacked 3×) | Smoke: two near-identical flags (same kind, prefix-equal text) merge; a genuinely different flag still stacks. |
| 2.2 | Good-neighbor class: a steered scope-add that names a NEW section nudges the driver to `define_slots` | Smoke: an inbox item with "new section called X" → the next prompt carries a define-slots nudge; live: the rematch T4 re-steer produces a good-neighbor slot. |
| 2.3 | R5 ban scope: "let me get that going" banned on the steering-ack directive path | Grep-pin + a steering drive whose say carries no deflection phrase. |
| 2.4 | R11 registration-claim gate: a say claiming "registered/booked/added" verifies against a real inbox/booking row this turn (work-state gate scope) | Smoke: the verbatim T4 say-shape with verdict=none → the gate rewrites/flags; live: a deliberately unbindable steer draws an honest "that didn't attach" say. |
| 2.5 | GDELT pacing: space news_search calls (per-wave cap 2 + a 60s per-query-class cooldown) | The fleet's next battery shows a hit-rate ≥ the 08-24 evening run's 3/44; zero REFUSED-throttle storms. |
| 2.6 | R1/F23 SQL-say leak (D-batch): tool-call JSON never rides a say | Smoke on the say-cleaner with the live leaked shape; live re-drive of the T2-class turn shows a clean say. |

## Phase 3 — THE SECOND BULK ROUND (the fuel wave's acceptance at scale)

Re-run the 8-contract battery fresh (new phrasings, same class mix — retest the KIND, never the phrase) with all Phase 1+2 cures armed.

**Pass bar:** ≥6/8 contracts closed · held-rich classes sweep (9/9 cited) · ≥1 external-fuel contract lands ≥1 cited fill from a stored-as-we-go page · every close banked + `search`-findable · zero steering/answer misbinds across ≥6 mid-run steers · the continuity suite's 3 legs (A landed 08-24; B/C ride THIS round's session boundaries) all green — the latency contract holds.

## Phase 4 — NEXT: the standing queue (order = Lucas's call where marked)

| Track | Item | Verification test |
|-------|------|-------------------|
| Report | **National LegiScan census** — states never acquired vs the anti-China corpus | The census lands as dataset rows; v14 renders a "states not yet acquired" line; the substantive count's national denominator is honest. |
| Report | Registry topic string names 5 states (cosmetic) | Registry row updated; kin-matching still resolves the canonical (smoke). |
| Test | **Blind week** (the yield law's discovery mode) | No driven tests; catches only from his live use + meeting legs; each catch → same-day cure → the week's tally writes §30. |
| Test | E1-v2 / C3-adjacent live retests (owed from the sprint) | The two-instance directive + rebind-leader fire on live phrasings. |
| Design (his call) | Test-residue-in-recall: durable marking vs post-battery purges vs accept | Decided → implemented → a recall probe on a battery subject cites it as test residue (or the purge leaves no trace). |
| Design (his call) | Registry kin-dilution w/ the alpha-beta counterexample · retrieve-vs-compose boundary · bare-'status'-noun FP polish | Each: a named smoke on the counterexample + one live probe. |
| Design (his call) | Driver tier for contract waves (glm-5.2 held; §28 says fuel was the wall — revisit AFTER Phase 3's data) | Phase 3's cite-closure table decides; a tier change re-runs Phase 3's bar. |
| Infra | LegiScan backfill env revert (API_BULK_LIMIT→50, API_BULK_MS→43200000) when all 7 jobs hold session hashes | `.env` reverted; the next bulk tick logs the slow cadence. |
| Infra | Echo trio #1 (mirror `e525668`) arms on the next echo serve restart — NEVER kill the serve | After any natural serve restart: the trio's tests pass against the live serve. |
| Surface | Empty china canvas tabs (engine surface — his call) · canvas sibling-tab identity (rich-canvas track) | A re-emit on an existing topic updates ONE tab; no empty siblings. |
| Voice/latency | The latency streaming track (stream the writer earlier) · rolling-context 75% compact as a latency item | The continuity suite's first-emit numbers beat the 27.9s floor; compacts never block a turn (already proven — re-pin under load). |
| Data | b3 residuals · F9/F10 · F30b · slow-scan pair · D-batch remainder | Each carries its named smoke from the campaign doc §14 queue. |

---

**The standing verification battery (every phase's exit):** full gate green (`npm test`, `$?` captured) · boot resume clean · the parked fleet's census read · no crown-canonical mtime change · banner + campaign section updated · pushed.
