# DOCUMENT PRODUCTION — THE COMPREHENSIVE PLAN (2026-08-21)

Lucas: *"I would like to see a comprehensive plan to finally get to a solution on this. If the
program is incapable of producing documents its uses being fairly limited."*

This plan treats document production as ONE system and proposes the structural cure, not the
next patch. It is grounded in today's complete failure catalog — one deliverable (the anti-China
+ surveillance report) exercised the whole pipeline end to end and broke it in eight distinct
places, every one of which is a face of the same two roots.

---

## 1. The evidence — one order, eight failures (2026-08-21)

| # | Failure | Where it lived | Status |
|---|---------|----------------|--------|
| 1 | Her own narration booked as a NEW deliverable; the pursuit "delivered" an off-topic 11KB artifact under a garbage slug and closed the real debt | promise booking (topic = say-fragment; "on your canvas" read as an about-clause) | ✅ cured `656d689` (destination≠topic, topicViable, in-flight attach) |
| 2 | The seven-state debt orphaned when the fake booking closed | same | ✅ cured (attach + re-book) |
| 3 | The report composed EMPTY — the bill store had no foundation for 6 of 7 states | fuel acquisition routed to the background corpus drain (FL-only, 50 bills/12h) | ✅ cured for legislation (`3797f31` legis_acquire — inline, bounded, interactive-lane) |
| 4 | "Couldn't reach the legislative database" — a scope hole wearing an outage explanation | same | ✅ cured (7-state backfill posture + the limb) |
| 5 | She read the STALE artifact (-ar shell), declared the count zero, called her earlier claim fabricated — while the real report sat unnoticed under a sibling slug | **no canonical artifact identity** — every pursuit mints a new topic-slugged file; nothing resolves "the report" | ⛔ OPEN — Phase 0/1 |
| 6 | "How many bills total?" — she cannot answer reliably; compose is a one-shot LLM pass over ≤8 prose docs; counts/tables/trend graphs are not derivable | **no structured data under the document** — the prose pipeline | ⛔ OPEN — Phase 2 (the core) |
| 7 | A garbled message — two reply streams interleaved character-by-character — landed in his chat | reply transport | ⛔ OPEN — Phase 0 |
| 8 | "the number" booked with topic "give you as soon as" (filler passed the narration net; honest-missed, no artifact) | topic floor incomplete | ⛔ OPEN — Phase 0 (one-line: topics must carry noun substance) |

**What today proved WORKS** (keep, don't rebuild): the honesty gates (her self-correction fired;
the starved compose said "zero bills" instead of inventing them); glm-5.2 as the voice
(grounded seven-state recall, honest misses, clean recovery); the API acquisition path (102
bills + full sponsor rosters across 7 states in ~20 minutes, zero misses); pursue-deliverable
(debts survive and complete); the regression-gate suites (567 green).

## 2. The diagnosis — two roots, not eight bugs

**Root A — documents have no identity.** Every pursuit mints a fresh file keyed on a topic slug.
There is no durable object that IS "the anti-China report" — so versions pile up as sibling
files, she anchors to stale ones, follow-up scope (surveillance) has nothing to attach to, and
"where are we on it" has no row to read.

**Root B — documents have no data.** Composition is topic-string → doc-soup gather (LIKE/token,
cap 8) → one-shot LLM prose. Anything quantitative — counts, per-state × per-status tables, a
trend graph, "sponsors for each bill" — must survive a generative pass, which is exactly where
fabrication and starvation live. The campaign already proved the cure pattern elsewhere: the
compute-ground door (numbers never from the model) and the list-completion lane
(cite-or-leave-blank). Documents need the same constitution: **a report is a RENDERED VIEW over
a verified, structured dataset; the model writes the narrative around deterministic numbers,
never the numbers themselves.**

Everything else today (bookings, slugs, acquisition pace) was these two roots leaking through
whichever seam the order touched. The model is not the constraint — the plumbing is.

## 3. The plan — five phases, each with a live acceptance gate

### Phase 0 — Stop the bleeding (≈1 day)
- **Topic noun-floor**: a booked topic must carry noun substance (reuse the `researchable`
  family) — kills the "give you as soon as" class (#8).
- **Interleaved-stream root-cause + fix** (#7): find how two generations wrote one message
  (suspect: the ack-then-async overlap writing into a live stream) and serialize the say path.
- **Artifact registry v0** (#5, the acute half): one table — project slug → canonical file path
  + version + updated_ts. `buildReportFromHeld` UPDATES the canonical file (version++) instead of
  minting slug-siblings; her read-side ("the report", "how many…in the report") resolves through
  the registry, never by filename guess. Old siblings archived once.
- **Gate**: re-drive KINDs — follow-up narration never books; "read me the report" opens the
  canonical current version; a re-ordered report updates in place.

### Phase 1 — The project spine (≈1–2 days)
- A `deliverable_projects` row per ongoing deliverable: slug, title, HIS spec (verbatim asks,
  including sub-scopes like "and surveillance", "with a per-state status table", "trend graph"),
  canonical artifact, dataset ref, outstanding scope items, status.
- Orders bind to a project (new or existing — the instance-disambiguation cure lands here);
  follow-ups and new scope ATTACH (generalizes the in-flight attach); "where are we on X" reads
  the project row; the gap plan lists projects with open scope.
- **Gate**: the multi-day continuity KIND — order day 1, add scope day 2, status-check day 3 —
  nothing orphaned, one artifact, scope list accurate. (This is also the campaign's one unopened
  suite: multi-DAY continuity gets its first real substrate.)

### Phase 2 — Structured data under documents (THE CORE, ≈2–4 days)
- For data-shaped deliverables (bills, rosters, contacts — the actual workload): acquisition
  lands ROWS in a per-project dataset table (entity, attributes, source URL, fetch date, query
  provenance) — `legis_acquire` already fetches structured JSON; today it flattens to prose.
- Composition becomes two layers: (a) DETERMINISTIC renders from the dataset — counts, the
  per-state × per-status table, sponsor rosters, the trend series (the rich-canvas build already
  draws visuals); (b) the model writes narrative AROUND those renders and may never state a
  number the dataset doesn't. "How many bills total" = SELECT COUNT — exact, every time, from
  chat, without opening a file.
- **Gate**: the anti-China project re-run END TO END BY HER — one order, no hand-driving:
  acquire → dataset → rendered report with correct table, counts, sponsors, and the graph — and
  the chat question "how many bills total" answered from the dataset to the digit.

### Phase 3 — Acquisition generalization (≈1–2 days)
- `legis_acquire` becomes acquirer #1 in a small registry keyed by project domain: legislation →
  LegiScan; contacts/rosters → CRM + the existing finder cascade; generic web → the stealth
  deep-browse lane. All directed-lane (never quota-deferred), bounded, inline with the order;
  the gap plan's "needs your go" items link to a named acquirer run.
- **Gate**: a NON-legislative data deliverable (e.g., the parish contact table) completes inline
  through the same spine.

### Phase 4 — Verify before announce (≈1 day)
- A deterministic pre-announce audit on every delivered document: artifact exists · non-empty ·
  topic-relevant to the project spec · covers the spec's scope items (each named state/section
  present) · every number matches the dataset. Any miss → honest non-delivery + retry; the
  done-claim is structurally unreachable for a wrong artifact. (Extends the editor-verification
  checks from advisory to a delivery GATE.)
- **Gate**: adversarial re-drive — starve a dataset deliberately, order the report: she must
  report the gap, never announce done.

## 4. Sequence, effort, and what I need

Phases run in order; each lands committed + smoke-locked + live-proven before the next (the
campaign's standing method). Total: **roughly 6–10 working days of sessions at today's pace**,
with usable improvements landing daily — Phase 0 alone removes the failure classes you hit
tonight. Nothing here needs new keys, new services, or local models; it is all plumbing over
proven parts. The two decisions that are yours: **(a)** approve this plan shape (especially
Phase 2's rule that documents carry a dataset and models never author numbers), **(b)** the
Phase 1 project spine implies the multi-day continuity suite opens early — that was queued for
after the blind week; I recommend pulling it forward since it becomes the natural gate.

---
*Filed 2026-08-21 by the build session. Evidence trail: docs/LIVE_TEST_RUN2_2026-08-19.md
§20–§22 and this day's commits `656d689`, `3797f31`, `e97959c`, `cec5b15`.*
