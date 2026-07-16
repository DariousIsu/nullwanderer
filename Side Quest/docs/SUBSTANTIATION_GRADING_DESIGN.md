# Substantiation & Grading — Design Direction (2026-07-15)

> NORTH-STAR captured from Lucas. This is a DESIGN DIRECTION, not a spec — the six clarifications
> in §4 are open and must be resolved before build/research. Grounded in the 2026-07-15 memory-substrate
> audit (see the linked memory files).

## 1. The vision (Lucas, verbatim intent)

Every unidentified thing — a word, title, concept, location, event, *anything* — becomes a **node**.
The system then tries to **substantiate** it:

1. **Internal validation** first — the attached knowledge corpora (wikipedia / general_knowledge) confirm
   *what it is*.
2. If internal has nothing → an **external web search**.
3. If still nothing → an **unsubstantiated** node.

Then the load-bearing reframe:

- **Grade = PRIORITY, not a gate.** Everything that *can* be substantiated flows **short-term → long-term**,
  graded on the way. **A low score is NOT a rejection — it is a higher priority to explore further.**
- **Only the unsubstantiated stay short-term** — to be *proven or to fade*.
- **Self-substantiating sources:** *news makes a thing real* (the story is the substantiation). **Fiction is
  real to its fiction** — a substantiated, growable node *within its frame*.

Foundational alignment: this is [[let-it-in-mark-and-churn]] sharpened — maximize intake, mark provenance
honestly, let churn refine; the valve is the short-term buffer + fade, NOT rejection at the door.

## 2. What exists today (from the 2026-07-15 traces)

| Piece | Today | Vision wants |
|---|---|---|
| Grade | a GATE — grade D held; single-source parked <0.90 ([[promotion-gate-official-weight]]) | a PRIORITY tag; substantiated promotes at any confidence |
| Unresolved edge endpoint | edge HELD (72.8k held; SHERIFF/councils never mint) | mint endpoint as unsubstantiated node, land the edge |
| News entities | land ISOLATED (86% of events, DB review) | self-substantiated + wired + growable |
| Internal-wiki validation on mint | NOT wired (corpora attached, `search_knowledge`/`kg_neighborhood` exist but unused for substantiation) | the first validation tier |
| Fiction | no frame concept | substantiated within `fiction:<work>` frame |
| Intake boundary | domain-leash VETO (post-medical-flood) | leash as PRIORITY/fade signal, not a veto (§4.5) |

Relevant components: `lib/curation_gate.js` (grade), `lib/promote_gate.js` (0.90 floor), `lib/confidence_model.js`
(grade priors + corroboration), `lib/doc_decompose.js` (resolution holds), the news lane (isolated events),
`lib/focus.domainLeashTokens` (flood control), Echo `search_knowledge`/`kg_neighborhood` (unused validation tier),
`lib/confidence_decay.js` + supersession (the fade primitives).

## 3. Already shipped toward this (2026-07-15)

- **Official-document weight** ([[promotion-gate-official-weight]], commit 9cf57dd) — authoritative single
  source (.gov/.mil) grades A → auto-promotes. This is the FIRST step of "grade is priority": it lets a lone
  authoritative source promote without corroboration. Reboot-gated. NOTE: it does NOT touch the resolution-holds
  (§4.3) — those are hardcoded D, a separate gate.

## 4. OPEN CLARIFICATIONS (resolve before build/research)

1. **Core inversion:** promote *everything substantiated* to long-term at any confidence (grade = priority/quality
   tag); only *unsubstantiated* stays short-term. Replaces the 0.90-floor-as-gate. — CONFIRM.
2. **Define "substantiated":** source-vouched (news/doc/fiction self-vouch) OR identity-confirmed (wiki/web);
   a bare mention we can neither source-vouch nor identify = unsubstantiated. — CONFIRM.
3. **Endpoints — mint, don't hold:** an unresolved edge target becomes an unsubstantiated node (prove/fade) so the
   edge always lands. Directly kills the 72.8k held pile. — CONFIRM.
4. **Cascade = async, priority-ordered lane:** mint cheap→unsubstantiated instantly; a background lane runs
   wiki→web and upgrades (promotes) or fades; low grade explored first. — CONFIRM (sync per-node won't scale).
5. **Contamination boundary (the hard one):** "let everything in" collided with the medical flood, and fiction
   must not pollute a civic query. Proposal: everything intakes with a FRAME tag (`real`/`fiction:<work>`/domain)
   + a relevance/leash PRIORITY setting fade-rate + exploration order — off-domain & fiction fade fast or stay
   quarantined-to-frame, never *vetoed* but never *bleeding* into a civic answer. — CONFIRM, or want a harder wall?
6. **Fade policy:** what makes an unsubstantiated node fade — TTL, decay when never re-referenced, N failed
   substantiation attempts? And fade = deleted or archived? — CONFIRM.

## 5. Downstream fits (once §4 settled)
- News auto-substantiation + wiring (fixes the 86% isolated events).
- Endpoint-minting (fixes the 72.8k resolution-holds).
- A validation lane consuming the attached corpora (the unused first tier).
- Re-grade backfill for existing `docstore:`-cited held facts.
- The short→long promotion bridge / F2 auto-promote as the "substantiated → long-term" carrier.
