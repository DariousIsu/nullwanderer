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

## 4. RESOLVED DECISIONS (Lucas, 2026-07-15 — locked before build)

1. **Core inversion — CONFIRMED, with a bottom floor.** Grade becomes a PRIORITY tag; anything *substantiated*
   promotes short→long at any confidence, replacing the 0.90 promote-floor gate. **BUT a thin junk-tier veto
   stays at the very bottom** — spoofed/blocklisted/junk sources still cannot cross (spam insurance). So: not
   "no gate," but "gate shrinks to a narrow anti-junk floor; everything above it is priority-driven, not
   confidence-gated." Low grade = higher explore-priority, never a rejection.
2. **Define "substantiated" — CONFIRMED as written.** Source-vouched (news / doc / fiction self-vouch) OR
   identity-confirmed (wiki / web). A bare mention we can neither source-vouch nor identify = unsubstantiated
   (short-term, prove-or-fade).
3. **Endpoints — mint, don't hold — CONFIRMED.** An unresolved edge target mints as an unsubstantiated node so
   the edge always lands. Directly drains the 72.8k held pile.
4. **Cascade = async, priority-ordered lane — CONFIRMED.** Mint cheap→unsubstantiated instantly; a background
   lane runs wiki→web and upgrades (promotes) or fades; low grade explored first.
5. **Contamination boundary — HYBRID (soft frame + hard wall for named flood domains).** Everything intakes with
   a FRAME tag (`real` / `fiction:<work>` / domain) + a leash that sets fade-rate & explore-order (priority, not
   a veto) — off-domain & fiction never bleed into a civic answer because they stay quarantined-to-frame and fade
   fast. **PLUS a hard veto retained for a small NAMED set of flood domains** (medical/legal directory dumps) so a
   repeat of the 07-13 flood can't happen even transiently. Everything else is soft-framed, never door-rejected.
6. **Fade policy — TTL → ARCHIVE.** Unsubstantiated nodes archive after a fixed TTL window unless proven.
   Fade = **archive** (retained, hidden from active recall, restorable), NOT hard-delete. Audit-safe and reversible.

## 5. Downstream fits (once §4 settled)
- News auto-substantiation + wiring (fixes the 86% isolated events).
- Endpoint-minting (fixes the 72.8k resolution-holds).
- A validation lane consuming the attached corpora (the unused first tier).
- Re-grade backfill for existing `docstore:`-cited held facts.
- The short→long promotion bridge / F2 auto-promote as the "substantiated → long-term" carrier.
