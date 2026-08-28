# THE DOCUMENT ROAD — one owner from ask to artifact (design, 2026-08-28)

**The order** (Lucas): *"I don't understand why there's so much wakamole with document creation —
the model we are using for this should be producing multi page cogent documents with its eyes
closed."* → *"draft it."*

**The thesis**: the model was never the bottleneck — it is barely ever allowed to write. A
deliverable ask today crosses ~7 hops (intake → route → project bind → promise book → absence
queue → directed seed → operator run → contract mint → canvas/file), each hop a separate organ
grown as a backstop after some earlier drop, and **five ownership systems compete for one ask**.
The whack-a-mole is the hop count. The cure is the merge (the whackamole-to-merge doctrine: N
point-fixes were ONE disease; the conversation lane already went through this exact arc).

## The evidence (all from 08-27/28, boot_p178/p179)

- **The Frontier failure**: she held the FULL bill text (doc-decomp'd) + Obernolte's final-text
  PDF + the 309KB section-by-section PDF, and the analysis never ran. No model ever received
  "here is the material — write it." The chat model's actual budget that turn: 63 tokens, spent
  on "The pivot is registered."
- **Five owners, one ask** (the post-boot turn): projects bound `report-analysis-frontier-act`
  (kin 1.00, RIGHT) · promise#2663 booked · absence organ queued the gap · the user-work
  redirect MISBOUND to week-old thread #3962 ("polish notes/anti_china_followups.md" — matched
  on the words "finish…summary") · the contract backstop minted nothing ("beat-gated or engine
  down", failing boot-wide on cadence).
- **Proof the writing capability exists**: the registry holds gate-passed reports at v3
  (report-louisiana-parish-leadership-contact et al.) from the doc-production plan — when the
  pipeline lets a model write with the material in hand, the documents are fine.

## The road (design)

### D1 — ONE DOOR: the deliverable classifier
The existing intake deliverable-order detector (the thing that booked promise#2663) becomes the
road's mouth. An ask classed DELIVERABLE enters the road **in the same turn**. Everything
non-deliverable is untouched by this design.

### D2 — ONE OWNER: the project-registry row
The registry is the proven binder (kin 1.00 on the live specimen) and documents already have
IDENTITY there (re-orders update IN PLACE; asks open the canonical — the doc-production roots).
The road makes the registry row the **sole owner**: it carries the verbatim ask (scope attach —
exists), the spine/version, `resume_state`, and `delivered_at`. No other organ books a
deliverable-classed ask (see D5).

### D3 — THE RUN, IN-TURN: the say waits for the do
The turn immediately starts the **document run** — `_runCloudOperator` task mode (main.js:14622;
the taskNote at :14645 already mandates deliver-in-turn, file writes, honest partials, and bans
content-free acks) — loaded with:
- the registry doc's current spine + version,
- held sources by coordinate (work_coords + held-data pre-injection — both exist),
- the data doctrine rails (numbers come from dataset rows / SELECTs, never authored — unchanged).

**The chat reply IS the run's final**: the document pointer (canvas doc / file path), or an
HONEST PARTIAL naming what was gathered, what is missing, and the resume plan. Never
"registered", never "on it" — say-do coupling enforced at the road's mouth by a say-gate
(a deliverable turn's reply must contain a doc pointer or the partial shape).

Lanes: **his order runs on the interactive lane** — a direct order is never quota-starved
(the famine class that killed the Frontier run). Directed RESUMES ride research as today.

Multi-page is the default, not the exception: the run writes to file/canvas (not the chat
window), sized by a small size-class table (brief ≤2pg / report ≤10pg / dossier unbounded,
budgetMult accordingly).

### D4 — ONE RESUME LOOP
If the run delivers a partial, the registry row's open-items + `resume_state` are the ONLY
resume record. The directed picker reads registry-open-docs FIRST (the priority-8 precedent:
report-born gaps already outrank background lanes). Completion = the render lands + the row
versions in place. The dangling-promise chaser watches exactly one fact: `delivered_at` on the
row — not its own copy.

### D5 — THE SUBTRACTIONS (the merge's teeth; deliverable-classed asks only)
1. user-work redirect stands down (misbind specimen: thread #3962).
2. absence organ stands down (the road owns the gap).
3. contract-backstop mint retires **for road-owned docs only** (its "beat-gated or engine down"
   failure keeps its own diagnosis ticket for non-road uses until proven redundant).
4. promise rows for deliverable orders become POINTERS to the registry row (one fact, one
   place); all other promise behavior unchanged.
Nothing changes for non-deliverable work. Subtractions land LAST (S3), after the road is proven.

### D6 — GATES AND PROOF
Smokes: classifier in/out set · **owner-uniqueness** (a deliverable ask claims exactly one
owner — the double-booking count is the road's own regression meter) · the say-gate shapes ·
resume-state round-trip. Live legs: **the acceptance test is the Frontier ask re-run
end-to-end** (material already held → the analysis document lands in-turn or partials honestly);
the Louisiana/Utah registry reports as regression (re-orders still update in place).

## Build order (slices, each gated + live-proven before the next)
- **S0** — classifier + registry claim + the double-booking meter (road exists; old organs still
  book; we MEASURE the overlap before subtracting).
- **S1** — the in-turn document run + say-gate (the road delivers).
- **S2** — resume loop + directed priority (long docs finish).
- **S3** — the subtractions (turn off the four, one at a time, meter watched).
- **S4** — the acceptance leg (Frontier end-to-end) + the campaign record.

## Decision points for Lucas
1. **Meeting-spoken orders**: v1 keeps the meeting lane unchanged (the road takes typed/chat
   orders); spoken deliverable orders join in v2. OK?
2. **Contract backstop**: retire for road-owned docs only (recommended), or fully once S3 proves
   out?
3. **Size classes**: the brief/report/dossier table above, or your own cut?
4. **Lane rule**: direct orders always interactive (recommended — a direct order never starves);
   resumes ride research.
