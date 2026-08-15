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

**Loop A — STATUS VECTOR (real-time systems awareness; zero LLM).** New `lib/status_vector.js`:
`assemble()` READS (never computes) organs up/down, current focus + why, quota + lane allowances
(quota_gate.state()), tier-gate mode, voice/speaker guard state, last-8 organ fires (obs_bus),
watch flags → one JSON vector in meta `status_vector`, refreshed on a ~60s tick + staleness-refresh
at turn start. Injected twice from the SAME object (so they can never disagree): an always-on
one-liner beside selfCheckLine in buildAwarenessBlock (lib/context.js:109), and the full block
replacing the ad-hoc gather behind a WIDENED STATE_RE. Authority split with C1 drive_gauge: the
vector owns Node-side operational facts; C1 owns drives; the vector's `drives` section only ever
reads C1's journal (fail-absent).

**Loop B — CONCEPT-OF-SELF (event-driven identity maintenance).** self_model/self_dev are already
event-driven; self_narrative recomposes on a blind 6h TTL with generic evidence. Add a
dirty-journal: identity-mutating writers (self_model record add/revise, recordTold, self_dev
record, focus/milestone resolutions, directives) append {kind, ref, ts} to meta
`self_narrative_dirty`. Recompose when dirty ≥3, immediately on revise/told, 24h backstop.
The compose prompt becomes: current narrative + the dereferenced changed rows (old→new trait
text) + "revise minimally". Detection/staleness/evidence-assembly become loop; ONLY the wording
stays model. Each version stores its consumed event refs (`self_narrative_basis`) — every
narrative traces to the identity events that produced it.

## §4 Recommended order
(0) cloud_logic cache key repair — a defect, not a feature. (1) Loop A status vector — the
self-awareness ask, zero-LLM, and the substrate C1 rides beside. (2) #2 route map + (3) #3 news
un-inversion — the proven prefilter shape, big wins, low risk. (4) #5 embedding tier — one shared
function, seven consumers. (5) #1 operator pre-injection — biggest lever, needs care (brief-size
budgets). (6) Loop B dirty-journal. (7) #4 autonomy fast path. Rest opportunistically.

## §5 What NOT to touch
The compose/comprehension spine is genuinely generative: replies, monologue, research sections,
paper assembly, doc-QA, meeting scribing, mood ("she authors herself" — leave), voice. The
gemma4:31b 16.4M bucket is the program eating reality (page/doc comprehension) — its lever is
reading fewer junk pages (crawl brake, importance-gated decomposition), never cheaper classifying.
