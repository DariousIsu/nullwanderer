# THE SELF-DIAGNOSTIC CENSUS — 2026-08-27

Lucas's order (08-27, pre-compact): *"nail down why the corrections you are making are not being
picked up and corrected by the self diagnostics."* Hypothesis from the handoff: the DETECT half
exists; the CONSUME/REPAIR/ESCALATE half is missing. Method: trace need #99's full lifecycle, then
census every self-diagnostic emitter with four questions — what it detects and where it writes;
WHO CONSUMES it (a log line is not a consumer; a smoke is not a consumer); does anything escalate
to chat when it persists; and is there a STATUS DOOR the conversation agent loop can query (the
site-sweep live leg proved an organ invisible to every queryable tool gets DENIED by the
antifabrication reflex — catch #4, campaign §45b).

**Verdict up front: the hypothesis is confirmed and understated.** Detection is abundant and
mostly healthy. Between detection and repair, every stage is broken in a different way: findings
FOLD silently into one row, the queue STARVES them behind stale heads, the only repair lane is
WRONG-SHAPED for program defects, green outcomes land in a WRITE-ONLY state, the one escalation
door has NEVER FIRED (schema-rejected, error swallowed), the reaper SILENTLY DISCARDS at 7 days,
and several organs' comments claim consumer wires that DO NOT EXIST — stale bookkeeping survived
as false memory, exactly the disease class the handoff predicted.

## 1. Need #99, the full measured lifecycle (traced live)

Filed 08-27 by self_watch ("[dispatch-timeout] tool=run_dedup_adjudication…", born_from
"self-watch: recurred 3x/24h"). Status today: **open**. The failure it names was CURED by hand
(the KGJUDGE leash, §43) — zero dispatch-timeouts in all four of today's boots — and the ledger
never learned it.

1. **DETECT — works.** self_watch's console hook counted the signature to 3/24h and minted.
2. **THE SILENT FOLD** (`lib/capability_need.js:85` + `lib/self_watch.js:173,178`): record()
   dedups on exact born_from equality BEFORE the similarity check; self_watch's born_from is the
   constant "self-watch: recurred 3x/24h", so every later distinct failure that recurs 3x folds
   into #99 — and the deduped branch logs NOTHING (no console line, no obs event). #99's
   updated_ts bumped again today; WHAT folded in is unrecoverable by design. The `similarFloor:
   0.75` raise added for exactly this boilerplate is unreachable dead code behind the born_from
   short-circuit.
3. **HEAD-OF-LINE STARVATION** (`lib/capability_need.js:155`): manifestLines shows the decider
   the OLDEST 4 of (today) 22 open needs — repair needs queue behind stale external-blocked rows
   and surface only as the queue ahead parks (7 days per head).
4. **WRONG-SHAPED REPAIR LANE**: the repair-class study (lib/diagnosis.js, Stage 2 of the
   2026-08-15 native self-repair loop — evidence bundle + file:line-cited diagnosis,
   main.js:15579) is real, but its endpoint is the rehearse sandbox → smoke-suite bar →
   proposal card — a pipeline built to ACQUIRE MISSING TOOLS. A program defect has no suite
   (suiteFor → null) and cannot be sandbox-patched; the need parks.
5. **THE DOMINANT TERMINAL STATE IS SILENT DISCARD**: population today = 22 open · 77 parked ·
   1 rehearsing · **0 proposed, ever**. The curator parks 7-day-stale opens (lib/curator.js:137)
   with no notification. Needs #95/#100 are the rehearse lane filing needs about its OWN
   schema-validation failures — recursion with no exit.

**The one-sentence answer to Lucas's question:** corrections aren't picked up because the only
pipeline self-diagnostics feed was built to acquire missing tools, not to consume program-defect
findings — and every stage between "filed" and "fixed" folds, starves, mis-routes, discards
silently, or (the escalation door) has never successfully run.

## 2. The emitter census

Verdicts: **LOOP** = detect→act→escalate→door all present · **PARTIAL** = some legs ·
**DEAD LETTER** = written, never consumed · **INERT** = not even writing.

| Emitter | Writes to | Consumer | Escalation | Status door | Verdict |
|---|---|---|---|---|---|
| self_watch (console hook + exhaust audit) | obs_events + capability_needs | decider manifest / rehearse / curator-reaper | `_surfaceExternalNeeds` — **NEVER FIRED** (schema-rejected) | obs_query + localdb (needs pinned); NOT in work_state | PARTIAL, badly |
| self_audit (source sweep) | capability_needs (capped) | same pipeline | same dead door | same | PARTIAL |
| pathway_cadence failures | capability_needs (born_from pathway:*) | same pipeline | same | same | PARTIAL |
| producer_vitals (lane heartbeats) | meta producer_vitals + obs lane 'producer' | status_vector LINE only — **no repair, no restart, no need-mint** | NO (a 48-day-dark lane = an ambient phrase) | line yes; **block() OMITS producers** (asymmetric); not in work_state | DEAD LETTER |
| machine_vitals | meta + obs 'machine' | status_vector line+block; internal_state appraisal | no | yes (block) | PARTIAL (best of the vitals) |
| db_health | meta + obs 'db' | status_vector | no | yes | PARTIAL |
| route_obs (dispatch outcomes) | route_obs table (drained → route_health) | **route_health: ZERO production readers** (one caller = its smoke) | no | **actively closed** (localdb EXHAUST_RE excludes route_obs) | INERT — **DEFAULT OFF, nothing ever set meta route.obs='1'** |
| stall attribution (markActivity + 1s probe) + slow_sync_probe | data/stall_attrib.log + console.warn | **NONE in production** (one offline script); self_watch classifies the warn as 'count' — can never reach the mint threshold | no | **log_read REFUSES the file by name** (LOG_NAME_RE admits only boot*.log) — the catch-#4 denial shape | DEAD LETTER |
| content_firewall refusals | obs lane 'firewall' | generic obs readers only | no | obs_query | DEAD LETTER |
| internal_state (drives/affect) | its journal | zero consumers BY DESIGN (declared) | — | partial | (by design) |

**Working-loop baselines (the pattern to copy):** site_ledger access profiles (bestDoor/hostDown
→ consumed by open_page + fetch_escalation + site_crawler: detection changes the next action in
the same organ) · recheck_queue (metabolism drains, gap_plan escalates, work_state grounds —
all four legs). The sweep organ (§45) now also closes all four.

## 3. The defect classes (each named once, instances listed)

**C1 — THE SILENT FOLD**: born_from-constant dedupe collapses distinct findings into one
unrecoverable row, unlogged. (capability_need.record × self_watch/self_audit callers.)

**C2 — THE DEAD ESCALATION DOOR**: main.js:18817 writes 'blocked_external', :18825
'routed_research' — both violate the live table's CHECK
('open','rehearsing','proposed','parked','retired'); the UPDATE throws; setStatus swallows
(catch → false) under a second try/catch at the call site. Consequences: external-blocked needs
burn a fresh cloud triage call EVERY cycle; research-routed needs can re-open duplicate
inquiries every cycle; the `WHERE status='blocked_external'` surface query can never match — the
family's ONE unprompted chat escalation has never fired. Its smoke (smoke_need_triage.js:117)
regex-greps main.js SOURCE TEXT for the literals — never executes against the schema. A
silent-green of the build-process-guards class.

**C3 — WRITE-ONLY TERMINAL STATES**: nothing anywhere consumes a 'proposed' need
(approvals reads the rehearsal RUN meta, not the need row — replaced run ⇒ invisible).
'parked'/'retired' likewise. Green outcomes evaporate.

**C4 — THE FALSE-CLAIM COMMENT CLASS**: producer_vitals:15, machine_vitals:9, db_health:10,
main.js:5257 all claim anomalies "escalate obs_bus → self_watch's repair loop." That wire does
not exist — self_watch reads ONLY the console hook; obs_bus never touches console; both live
obs_events readers filter stalls out (kinds anomaly/need only). Stale design intent surviving
as false memory in four files.

**C5 — THE INVISIBLE-ORGAN SHAPE** (catch #4's class): stall_attrib.log unreadable by the
log_read tool; route_obs excluded from localdb; producers missing from status_vector.block();
capability_needs absent from work_state. An organ no queryable door can see gets DENIED by the
antifab reflex when the model is asked about it.

**C6 — RESET-ON-REBOOT MEMORY**: self_watch's recurrence table is module-level in-memory — a
signature at 2-of-3 hits resets to zero every reboot; frequent-reboot periods (build days!)
suppress detection exactly when defects are most likely.

**C7 — TWO NEED STORES THAT NEVER MEET**: capability_gaps (older, own
open→proposed→resolved lifecycle, read by approvals) vs capability_needs. Split-brain debt.

## 4. The missing organ (the deliverable, per the graph-integrity law)

A hand-run repair is an unfinished feature. What the census shows is that no single "repair
organ" is missing — SEVEN small wires are broken. The organ that closes the loop:

1. **Program-defect needs are a CLASS with their own lane** (isRepairNeed already classifies
   them): their consumer is NOT the rehearse sandbox — it is the Stage-2 diagnosis pass
   (already built) whose OUTPUT ESCALATES: a deterministic unprompted card to Lucas
   ("my watch organ says X recurs; diagnosis cites file:line Y; needs a builder") — the
   gap_plan pattern, cadenced and fingerprinted. Repair-class needs skip the manifest queue.
2. **Fix the fold**: born_from for self-watch mints must carry the signature (unique), and the
   deduped branch must log + record recurrence.
3. **Fix the dead door**: migrate the CHECK (or map the two statuses into legal ones +
   note), and re-write the triage smoke to EXECUTE setStatus against the real schema.
4. **Close the green loop**: 'proposed' needs surface via approvals from the NEED row.
5. **Status doors everywhere** (the C5 sweep): needs + producers + route_health into
   work_state/status_vector.block; stall_attrib.log admitted to log_read.
6. **Persist self_watch recurrence** across reboots (meta), or accept and note the loss.
7. **Correction feedback**: when a cure lands (a gate-passed commit naming a signature), the
   need row closes with a 'resolved: <commit>' note — the ledger learns what was fixed.

## 5. The second census leg (families 5-9) and the reconciliation

**C2 CONFIRMED ON THE LIVE DB** (the two survey passes disagreed; measured to settle it): the live
`capability_needs` CHECK holds only ('open','rehearsing','proposed','parked','retired'); no row
has EVER held 'blocked_external' or 'routed_research'; and `needs.external_surfaced_at` — the
escalation door's own once/24h stamp — is **NULL. The door has never fired in the program's
life.** One survey described the chain as working end-to-end from its code shape; the schema says
otherwise. (Itself a lesson for this investigation: design-intent reads lie; measure.)

**Integrity audit / dedup / link-grounding RESULTS — parsed success-only, findings discarded.**
The revived passes (§43's leash) return rich reports (converged/halted/auto_killed/parked); the
app reads them ONLY to build a console line, and writes a monologue row ONLY on the success
branch (total_fixed>0 / applied>0). An audit reporting "NOT converged, autopilot disarmed"
leaves ZERO durable trace; link-grounding results reach nothing but a log line. Asymmetry:
a dispatch FAILURE is console.error → self_watch can mint; **a successful pass reporting bad
news is invisible.**

**Quota degrade — total amnesia.** Every allow() denial prints and vanishes (the rate-limit is
one module-global — five lanes standing down print one line). No counter, no meta, no table:
**a one-hour closure and a two-week closure render identically** ("idle lane closed", edge
phrase, 15-min expiry). gap_plan sweeps gaps without quota as an input, so a quota-starved
backlog surfaces as gaps that never name the cause. The known spend-under-count warn
(mark older than the meter ring) is console-only.

**The self_watch classifier's blind spot** (why tier-3 text is seen but not consumed):
anomaly = console.error OR Traceback/Uncaught/FAILED shapes. slow-sync, stall-attrib, quota,
audit, kg-apply, pathway, board all log at info/warn → the counted bucket → an anonymous
`slow-sync×47` in the 5-min flush. Never a signature, never a mint.

**More console-only emitters found**: the Echo engine supervisor's crash ring (5-in-60s
give-up — in-memory, no read-back) · graph_integrity_tick per-target repair failures ·
board-vs-slow-sync: a lane blocking >5min on legitimate sync work is marked 'failed' and its
lock released WHILE STILL RUNNING, and nothing can correlate it with the slow-sync probe's
measurements because those live in the unreadable log file.

**Working loops confirmed as the reference shapes**: delivery promises (the strongest:
detect → durable row → scheduled actor that COMPOSES the delivery → unprompted announce both
branches → work_state field + metacognition probe) · chain_guard in-turn + procedural_lessons
cross-turn · board heartbeat sweep (two real consumers) · pathway_cadence → the needs funnel ·
self_check RED → context · delivery_audit → honest non-delivery.

## 6. The synthesis — three tiers, one funnel, seven wires

Every emitter falls in one of three tiers:
1. **TABLE + scheduled acting reader** — works (promises, needs-funnel*, board, lessons).
2. **META KEY read for rendering** — visible, never acted on (producer/machine/db vitals).
3. **LOG LINE / LOCAL VARIABLE** — the dead letters (slow-sync, stall-attrib, quota deferrals,
   audit/dedup/link failure branches, route_health, engine ring, graph-repair failures).

*The funnel (capability_needs) is the RIGHT sink and its downstream chain exists — but it has
the four diseases of §1/§3 (fold C1, dead door C2, write-only proposed C3, head-of-line
starvation) plus the class mismatch (program defects routed to a tool-acquisition lane).

**The missing organ is therefore NOT one new organ.** It is: (a) cure the funnel's four
diseases; (b) give tier-3 emitters their three lines each — write a row into the funnel (or an
anomaly into obs_bus at a mintable level) instead of a log line; (c) the C5 status-door sweep so
no organ is invisible to the agent loop; (d) a repair-class LANE whose endpoint is a
deterministic escalate-to-builder card (the Stage-2 diagnosis already produces the file:line
content), because a program defect can never be cured by the rehearse sandbox; (e) the
correction-feedback wire: a landed cure closes its need row, so the ledger learns what was
fixed — the exact wire whose absence left need #99 open after the leash cure shipped.
