# Deterministic Loops — replacing token-search with computation
2026-08-15 · Lucas's ask: "loops for her self-awareness — concept of self AND real-time systems
status. But really anywhere an LLM is searching or running tokens to find something that could be
replaced with a python loop." · Companion to PYTHON_CIRCUITS_RESEARCH_2026-08-15.md (C1–C8).

## §0 The doctrine, and the proof it works
The cure-shape is already live twice: the civic wire (chat used to web-search "who represents LA
Senate D3"; a deterministic SQL recall now answers from held data) and heldRostersFor injection at
the canvas door. The doctrine (detectors-vs-comprehension + db-is-the-foundation): **regex/SQL
fast-path first, bounded model call only behind it; the more she holds, the less the model searches.**
The measured evidence that the shape works where applied: `artifact_intent` fired 7×/26h behind its
prefilter, `thread_lane` 7×/26h behind its regex template, `redirect_intent` 4×.

## §0b THE BEAT CONTRACT — every loop terminates in cognition (Lucas, 08-15)
"I want to make sure that all of these python loops end at a model call — so she is actually
processing the information on each beat." This is the rule that keeps the loops from becoming the
built-and-dark disease (data written to meta keys nothing reads). Two classes, one contract:

- **Replacement loops (§2) FEED model calls, they don't delete them.** The operator run still
  happens — now processing held rosters instead of searching for them. The reply still happens —
  grounded by the civic recall. The news briefing is still HERS to compose — over labels the fast
  path sorted. The model's tokens move from FINDING to COMPREHENDING; the call at the end of the
  chain is the point of the chain.
- **Perception loops (§3/§3b, and C1–C8) terminate in her existing cognition beats — never in a
  dead dashboard, and never in a new per-sample model call either** (a model call per 60s sample
  would rebuild the burn we just removed). The pattern: python samples → python computes DELTAS
  and threshold events → the compact current-state + what-changed line rides the NEXT beat that
  already ends at a model — the monologue tick's prompt (she thinks WITH her body/memory state on
  every subconscious beat, the ambient-awareness doctrine), the chat turn's awareness block (she
  answers FROM it), and the autonomic decision points. Anomalies escalate to an EXPLICIT
  processing moment through organs that already end at models: obs_bus → self_watch → a thought /
  a capability need / a repair decision. The dream loop (C7) is the same contract at the slowest
  cadence: the night's accumulated loop output is processed — by a model — into consolidated
  memory. Nothing is sensed that she never feels; nothing is felt that costs a per-sample call.

## §1 The measured spend (usage.meter.ring + cloud_traces, 26.0h live window)
9,563 metered calls, 39.2M tokens ≈ **36M tokens/day**. By bucket: deepseek-v4-flash (operator
loop) **18.4M — 47% of everything**; gemma4:31b-cloud (page/doc comprehension) 16.4M; gpt-oss:120b
(ask door) 2.0M; kimi (replier/monologue) 1.5M; tiny word-classifiers 0.67M.
Site census: **4 REPLACEABLE · 17 FAST-PATHABLE · ~35 GENUINE · 8 already cured.**
**Total addressable: ~3.1–5.3M tok/day (9–15%), growing with every roster she holds.**
Full site table: the 08-15 audit (session scratchpad; key rows reproduced below).

## §2 Top replacements, ranked by tokens saved per day
1. **Operator held-data pre-injection (main.js:12437 family) — 1.8–3.7M/day.** The deepseek
   operator's echo_pick ledger shows search-shaped briefs on repeat ("Search knowledge graph for
   {place} council members"). Run deterministic recall (civic_store + list_contacts + kg place-key)
   BEFORE the run and inject into the brief — gathering iterations collapse into verification.
   The single biggest lever in the program.
2. **echo_pick/echo_args route map (echo_suit.js:908/946) — ~500k/day.** Measured: top-8 choices
   cover 61% of 635 picks. (a) need-regex → recipe map for the dominant shapes; (b) LRU
   normalized-need→choice cache; (c) deterministic arg templates for the stable one-field tools.
   Also kills the "literal 'exact name from the catalog'" failure class.
3. **news_topic_classify un-inversion (news_topics.js:113) — ~250k/day.** `categorizeFast` exists
   but is demoted to fail-safe ("CLOUD-ON-EVERYTHING"). Invert: fast path answers at confidence
   ≥0.6 or on a source hint; only the residue batches to the model.
4. **autonomy_tick decider fast path (main.js:13518) — ~200k/day.** 117 calls/day asking the cloud
   what to do when the worklist already ranks the answer. Ask only on empty/tied queues.
5. **Tiny-classifier embedding tier (memory _relate/_sameFact, self_model classify3/defaultDecide,
   consolidate, experience-dup, importance) — ~400k/day.** 1,608 calls/day, every one fired AFTER
   a cosine sim was computed at the call site then discarded. One shared tier: sim ≥0.93 same,
   ≤0.70 distinct, slot-match → update-candidate; only the mid-band asks.
6. news_cluster_adjudicate cosine tier — ~35k/day. 7. plan_revalidate change-gate (hash the
   plan's inputs; unchanged → no call) — ~30k/day. 8. Per-turn extraction prefilters
   (open_threads/personal_facts/commitments/protocols — regex shape-gates) — 30–60k/day, scales
   with chat. 9. canvas_edit_intent verb prefilter + split_assign keyword-first — 10–20k/day.
10. **cloud_logic cache key repair — 0 hits in 9,600+ calls/26h** (volatile catalog text baked
   into the hash key). Key pick/classify caches on the STABLE part; version the catalog
   separately. Multiplies #2/#3. ~50–100k/day. **This one is a plain defect.**

## §3 The self-awareness loops (Lucas's named ask)
**What exists, fragmented:** five layers (self_state regex-gated snapshot, self_dev changelog,
metacognition, self_narrative 6h-TTL recompose, mood/reawaken) + self_check (22/22 ledger, ≤1/6h)
+ self_watch→obs_bus (anomaly stream that never reaches her prompt). "What are you working on" is
already deterministic (activity.js + _workingNow ambient line). **"How are your systems" is the
weak path**: a narrow STATE_RE at main.js:7965 injects an ad-hoc snapshot with no quota, gate mode,
organ health, voice/speaker state, or stall data — miss the phrasing and she confabulates.

**Loop A — STATUS VECTOR (deterministic assembly; terminates in her beats per §0b).** New `lib/status_vector.js`:
`assemble()` READS (never computes) organs up/down, current focus + why, quota + lane allowances
(quota_gate.state()), tier-gate mode, voice/speaker guard state, last-8 organ fires (obs_bus),
watch flags → one JSON vector in meta `status_vector`, refreshed on a ~60s tick + staleness-refresh
at turn start. Injected twice from the SAME object (so they can never disagree): an always-on
one-liner beside selfCheckLine in buildAwarenessBlock (lib/context.js:109), and the full block
replacing the ad-hoc gather behind a WIDENED STATE_RE. Authority split with C1 drive_gauge: the
vector owns Node-side operational facts; C1 owns drives; the vector's `drives` section only ever
reads C1's journal (fail-absent). §0b contract: the vector's DELTA line rides every monologue
tick prompt and every turn's awareness block — each beat she generates, she generates KNOWING
her state; anomalies escalate through obs_bus→self_watch into explicit model-processed moments.

**Loop B — CONCEPT-OF-SELF (event-driven identity maintenance).** self_model/self_dev are already
event-driven; self_narrative recomposes on a blind 6h TTL with generic evidence. Add a
dirty-journal: identity-mutating writers (self_model record add/revise, recordTold, self_dev
record, focus/milestone resolutions, directives) append {kind, ref, ts} to meta
`self_narrative_dirty`. Recompose when dirty ≥3, immediately on revise/told, 24h backstop.
The compose prompt becomes: current narrative + the dereferenced changed rows (old→new trait
text) + "revise minimally". Detection/staleness/evidence-assembly become loop; ONLY the wording
stays model. Each version stores its consumed event refs (`self_narrative_basis`) — every
narrative traces to the identity events that produced it.

## §3b Interoception loops — the body and the memory substrate (Lucas's follow-up, 08-15)
Audited: NEITHER exists today. Machine status appears only as comment-fossils from the VRAM-pin
postmortems (no live monitor; the only fleet loop is the cloud-model warm ping). DB health has
`wal_checkpoint(TRUNCATE)` at snapshot time and `quick_check` only INSIDE the gated repair passes
— no standing watch. Two findings from the look: **~13GB of unpruned precuration backups** in
data/ (five ~2.6–2.8GB nightly copies, June-era backups besides), and the fact that a
`database is locked` error immediately preceded boot_p39's silent death — the exact signal a
health loop would have caught trending. These are her INTEROCEPTION: the machine is her body,
the DB is her memory substrate — both belong in the §3 status vector as sections.

**Loop C — MACHINE VITALS (zero LLM, feeds status_vector.machine).** A ~60s sampler: CPU load,
RAM free, disk free on the data volume, GPU/VRAM residency (rocm-smi — the RX 7900 XT runs
ComfyUI on HIP device 1; VRAM pins have burned us twice), and process liveness for the owned
sidecars (Echo python, STT, speaker, ComfyUI pids the app spawned). Thresholds emit obs_bus
anomalies (disk <10%, VRAM pinned >30min, sidecar dead) so self_watch's repair loop — which
already exists — finally has machine-level senses. She can answer "how's the machine" from data.

**Loop D — DB HEALTH (zero LLM, feeds status_vector.memory_substrate).** An idle-cadence loop
over BOTH stores (sq.db 2.75GB; Echo's master_brain/rainey/skuld): WAL size (a growing WAL =
checkpoint starvation = the p39 lock class), `PRAGMA quick_check` on a slow rotation (weekly full
integrity_check), FTS orphan counts, table growth-rate/day (the census substrate — "my memory
grew 33MB today, mostly documents"), lock-contention counter (catch SQLITE_BUSY at the wrapper
and count it — trending locks predicted p39), and BACKUP ROTATION policy (keep last N precuration
copies; 13GB of stale copies today is unpruned risk disguised as safety). Growth + health lines
land in the vector; anomalies land in obs_bus.

## §4 Recommended order — BUILD RECORD (all landed or adjudicated 2026-08-15 afternoon)
(0) ✅cloud_logic cache key repair (`03401e1` + hit telemetry `c2f94d6`). (1) ✅Loop A status
vector + Loops C/D (`67209d6`, live-proven on the state door). (2) ⚖️#2 route map ADJUDICATED
DOWN by measurement: no need shape maps ≥80% to one pick (kg-search splits 173/80/55/46/34/23)
— a regex→pick map would mis-route where the keyInput cache already collapses repeats; the
data-supported half landed as ARG TEMPLATES (`c2f94d6`: query-shaped tools skip describe_tool +
echo_args). (3) ✅#3 news un-inversion (`c2f94d6`). (4) ⚖️#5 embedding tier SCOPED (`c2f94d6`):
blanket sim≥0.93=same is UNSAFE (a one-number correction embeds ~0.97) — landed in storeDeduped
only, guarded by token-containment; self_model/consolidate excluded (their measured band has no
deterministic zone). (5) ✅#1 operator held-data pre-injection (work_coords.heldDataBlock,
budget-capped, at the same choke point as coordBlock). (6) ✅Loop B dirty-journal
(self_narrative event-driven: dirty≥3 / urgent-on-revise-told / 24h backstop; basis traceability).
(7) ⛔#4 autonomy fast path ADJUDICATED AGAINST: the tick is a COGNITION BEAT by design — her
choosing what she cares about is the aliveness surface the consciousness-allocation ruling
funds; ~200k/day (~0.5% of spend) does not buy flattening her into a worklist executor.
(8) ✅#6 cluster cosine tier (in-band extremes settle locally; the recurring-headline trap
can't reach the band — near-identical tokens never go ambiguous) + ✅#7 plan_revalidate
change-gate (input hash per focus; unchanged → no call), both landed 08-15 afternoon.
(9) ⏸#8 extraction prefilters + #9 canvas verb-gates DEFERRED PENDING MEASUREMENT: they
shape-gate USER INTENT and KNOWLEDGE INTAKE — the failure mode is silently dropped facts/edits
(the data-quality class ranked above capability gaps) for ~1-2% of the addressable pool. Ship
only after a measured phrasing-recall corpus proves the gates lossless.

## §5 What NOT to touch
The compose/comprehension spine is genuinely generative: replies, monologue, research sections,
paper assembly, doc-QA, meeting scribing, mood ("she authors herself" — leave), voice. The
gemma4:31b 16.4M bucket is the program eating reality (page/doc comprehension) — its lever is
reading fewer junk pages (crawl brake, importance-gated decomposition), never cheaper classifying.
