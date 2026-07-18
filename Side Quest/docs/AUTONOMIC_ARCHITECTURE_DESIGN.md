# Autonomic Architecture — design

**Status:** design (2026-07-18). Greenlit by Lucas. Supersedes the ad-hoc idle-loop model.

## The problem (from the overnight audit)

Two symptoms, one root cause:

- **Fixation.** Overnight she hard-looped on one cluster (Compass Datacenters / Brookfield / "land and
  fiber") — ~4–7 near-duplicate surfacings. She never *finished* it; she re-processed it. The volume
  guards (streak cap) fired ~87% of the time, so the FLOOD is fixed, but the **monotony** isn't.
- **Slowness.** "Why does it take a week to find all the county commissioners in a state? Why forever to
  know all the city governments?" Structured, finite work dribbles instead of completing.

**Root cause:** the heartbeat/idle loop is the wrong engine for deep work, and there is no *worklist*.
The idle graph-walk does ONE shallow move per ~30s tick, picks targets by a "thin frontier" heuristic
with no universe to enumerate, and has no completion criterion. So it loops (can't converge — nothing
says "Compass is done") and dribbles (one item per tick — 67 counties take a week).

Fixation = **depth without a worklist.** Slowness = **the wrong engine.** They are the same bug.

## The frame — three layers, cleanly separated

| Layer | What it is | Who drives it |
|---|---|---|
| **Autonomic** | The baseline she is ALWAYS doing, at a steady balanced rate | **Hardwired schedule** — not the model |
| **Voluntary** | Tasks Lucas assigns ("research X", "enrich these orgs") | Lucas, on command |
| **Surfacing** | Occasionally speaking to Lucas | A gated *reflex* — never the driver |

Today all three are conflated into the "should she muse?" loop, and surfacing rides on top of whatever
the idle work fixated on. That is the bug. Separate them.

## Research principles (Lucas 2026-07-18 — hard constraints)

These shape every beat's per-item action and the maintenance cycle:

1. **Browser-first.** Research runs through the BROWSER lane (Side Quest's stealth/visible browser), not
   keyed search APIs — the machine has no web-search provider keys, and sub-state work has no large DBs to
   pull from anyway ("web searched as normal"). The QID/Wikidata worker-job (a structured API hit, no search
   key) is the EXCEPTION for structured-source tiers, not the template. So the roster/officials engine lives
   in Side Quest, driving the directed-research machinery, NOT an nx-echo web job.
2. **News is the freshness anchor.** Official websites LAG (slow to update); news is INSTANT. So maintenance
   is NOT "re-scrape the .gov roster on a timer" — it is: watch the news feed (the existing 189-feed data
   lane) for a development on a beat → that is the "something changed" trigger → then verify it. News detects
   change; targeted research confirms it against sources.
3. **Distrust official sources.** Government statements, releases, and databases CANNOT be trusted at face
   value — they are LEADS, not facts. Every item needs heavy outside corroboration, fact-checking, and
   scrutiny (independent sources, cross-reference) before it is graded trustworthy. This is the
   substantiation/grading discipline ([[substantiation-grading-vision]]) applied to the whole beat: a
   .gov roster entry is a starting claim to verify, not an answer to ingest.

## The autonomic engine

A **beat** is a broad, hardwired, user-set mandate. It is decomposed by the system into an enumerable
**worklist**, which a **worker job** exhausts to coverage and then **maintains**. Diversity comes from a
**scheduler** interleaving multiple beats' jobs at the JOB level (never tick-bouncing) — so she is deep on
several fronts at once. The proof that every mechanic works: **the QID resolution job (2026-07-18)** already
does this in miniature — enumerate all bare orgs → exhaust in batches on the worker → self-chain → and
*maintain* (misses retry monthly, new orgs auto-picked-up). It drained ~3,100 orgs in one night.

```
BEAT (broad, hardwired)              e.g. "elected officials (complete)", "AI", "datacenters"
  │
  ▼  DECOMPOSE   (the new hard part — tiered; see below)
WORKLIST (enumerable universe)       e.g. the 67 FL counties → each county's commission
  │
  ▼  EXHAUST     (worker job, the QID pattern: batch → self-chain → converge)
COVERAGE (X / N, + freshness)        deep + convergent; can't loop (the checklist says what's done)
  │
  ▼  MAINTAIN    (never "done": re-verify stale entries on cadence, ingest new developments)
CYCLE
```

Scheduling: several beats' jobs run interleaved (worker capacity allocated by priority × staleness,
least-recently-served first), so she keeps every beat moving without any one monopolizing. The heartbeat
is demoted to **surfacing only** — a reflex that speaks when something notable crosses a bar on a beat.

### Beats — broad, not granular

Lucas sets the **mandate**, the system derives the **checklist**. Starting set:

- **Elected officials (complete)** — "dogcatcher on up, if we can find them." A COMPLETENESS beat: coverage %
  of the known universe (offices × jurisdictions) + freshness. Never done — elections change it.
- **AI** — development, on-the-horizon, companies, countries, people, ideas, debates. A TOPIC beat: continuous
  gathering, measured by recency/volume of new grounded material.
- **Power infrastructure** — topic beat.
- **Datacenters** — topic beat (a massive, fast-moving subject).

Two beat kinds: **completeness** (a roster to fully cover + keep fresh — measurable %) and **topic**
(continuous gathering on a subject — measured by freshness/volume).

### Decompose — the hard part, and it's tiered

Turning a broad beat into an enumerable worklist. The tier determines the enumeration source, and that
tier difference is EXACTLY why some things are instant and others take a week:

- **Authoritative-API tier (fast, complete):** federal officials (Congress/bioguide), state legislators
  (OpenStates/LegiScan — keys already set). Enumerate = one API call returns the whole roster.
- **Discovery-heavy tier (slow today):** county + municipal governments. No single national roster →
  enumerate the *jurisdictions* from an authoritative list (Census places/counties), then research each one
  (its .gov roster) to find the officials. This is the "takes a week" tier — the engine handles it the same
  way, just with a discovery step per item.

The engine is method-agnostic: a beat declares (universe source, per-item action, coverage key). The
per-item action reuses existing machinery — the directed-research pass for web-discovery items, a roster
ingest for API items.

### Maintain — coverage is a cycle, NEWS-anchored

Once a worklist hits coverage, the beat shifts to homeostasis. Two triggers re-open an item:

- **News-anchored (primary).** The news lane is the "something changed" detector — official sites lag, news
  is instant. A news item mentioning a beat entity (a new official elected, a company move, a datacenter
  announced) re-opens that item for targeted verification. This is how a beat stays CURRENT without
  brute-force re-scraping — you only re-research what the world says changed.
- **Staleness fallback (secondary).** Every covered item carries a freshness stamp; a slow background pass
  re-opens the stalest slice on a long cadence, to catch changes news missed (the QID job's
  "retry monthly" generalized). Bounded, low-rate — the safety net, not the main loop.

Both feed the same verify step, which — per principle 3 — corroborates against independent sources before
re-grading, never trusting the official source alone.

## Reuse (this is mostly wiring proven parts)

- **Worker + self-chaining + reversibility** — `echo/jobs.py` huey jobs + `refresh.log_entity_update`/
  `reverse_run` (the QID job, a62e895).
- **Coverage state** — the `enrichment_status` + `enrichment_attempted_at` pattern, generalized to a
  per-beat worklist/coverage table.
- **Per-item deep research** — the directed-research pass + condense (`main.js` runDirectedResearchPass /
  condenseRun), driven by a worklist instead of a single assigned focus.
- **Enumeration sources** — Census (counties/places), OpenStates/LegiScan (state), Congress/bioguide
  (federal) — all reachable now.

## Slice plan

- **S1 — the convergent worklist, proven on ONE enumerable sub-universe (browser-based, Side Quest).** A
  state's county commissioners (under "elected officials", no granular config): enumerate the counties (static
  FIPS roster → Census later) → seed the EXISTING directed-research machinery with that BOUNDED, enumerated
  target list instead of model-picked targets → its per-target deepen/`covered` loop exhausts them → track
  beat coverage 0→N, resumable across reboots. This directly fixes the loop-and-wander: a bounded checklist
  can't loop (it knows what's done) and can't wander (targets are enumerated, not model-invented). Corroborate
  per principle 3. The fast-vs-slow is the browser lane's throughput — the WIN here is *convergence*, not raw
  speed. Foundation everything else reuses.
- **S2 — beats registry + scheduler.** Generalize S1: a `beats` table (broad, user-editable) + the
  decompose adapters (authoritative-API + discovery tiers) + the interleaving scheduler.
- **S3 — demote the heartbeat to surfacing-only.** The idle loop stops doing research; it becomes a gated
  reflex that surfaces beat-notable events. (Directly retires the fixation.)
- **S4 — directed-task completion hardening.** User-assigned long research (Louisiana parishes) uses the
  SAME worklist-exhaustion engine, priority-boosted, resumable to completion across reboots.

## Non-goals / guards

- No granular hardwired beats — the user sets broad mandates; the system enumerates.
- No tick-level bouncing — rotation is at the job/beat level so depth is preserved.
- Reversibility on every write (refresh_log), same as QID — the north-star holds.
- Coverage/skip decisions are LOGGED (no silent truncation) so "elected officials 62%" is honest.
