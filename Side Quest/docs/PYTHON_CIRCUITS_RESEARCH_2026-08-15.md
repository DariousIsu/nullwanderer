# Research — Python Circuits for the Autonomic Layer

**Status:** RESEARCH (no code). 2026-08-15.
**Question:** which autonomic organs of the consciousness build should be built as **Python circuits** on the Echo side (`C:\Users\azrae\Desktop\NX ECHO\nx-echo`), where local python + local models = free compute and the FastMCP server is already an always-on loop host.
**Grounds:** `PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md` (the vector, measured never asserted) · `COMPARATIVE_REVIEW_2026-08-14.md` (the convergent gap + refusals). Precedent for python sidecars is already live: faster-whisper STT, speaker-ID, ComfyUI on GPU.

---

## §1 Autonomic gaps Python loops can fill

All four gaps below come from the two docs; each is a *measurement* problem, which is exactly what a cheap always-on local loop is for. The doctrine binding all of them: **every scalar is a reading with provenance, never an instruction to feel** (proposal §2).

1. **Drive-vector computation** (proposal §3.2) — four drives are formulas over exhaust that already exists (novelty, `lastUserTurnTs`, quota position, worklist motion). Nothing computes them on a clock. Pure SQL + arithmetic = ideal free-compute python loop. "Measured never asserted" is satisfied by construction: the reading IS the measurement, journaled with its source rows.
2. **Valence/arousal stamping** (review §1.2 gap 1; memo's appraisal ensemble) — the fast-predictor ensemble needs cheap, high-volume model calls. On the cloud fleet that is quota; on a local model behind `echo/llm_gateway.py` it is free. Doctrine: the stamp is an *appraisal output scored for calibration later*, never narrated as a feeling.
3. **Dream-loop consolidation** (review Part II; §4 item 2) — offline episodic→semantic consolidation over the 2.75 GB sq.db is exactly Letta's "sleep-time compute": shift inference off the interaction path into idle time ([letta.com/blog/sleep-time-compute](https://www.letta.com/blog/sleep-time-compute/), [docs](https://docs.letta.com/guides/agents/architectures/sleeptime/)). Echo already has the **dark P4 bitemporal store with zero writers** (`echo/memory/schema.py`: `memory_facts` with a `salience REAL` column already in the DDL, `memory_supersession`, `write_hook.py`) — the dream loop is its natural first writer. Doctrine: consolidation *summarizes provenance-bearing rows*; it never invents.
4. **Homeostasis measurement / calibration** (proposal Slice 0 gate + Slice 3) — replaying a fixed event log must reproduce the trajectory exactly; predictors must carry Brier records or be demoted to uncertainty-only. Deterministic replay + batch scoring is a python batch job, and Echo's `passes/` framework (`registry.yaml`, `runner.py`, `scoring/`) is a ready pass-harness for it.

## §2 Proposed circuits

Legend — Cost: SQL (pure queries/arithmetic), LM (local model via `llm_gateway`), GPU (shares the Kokoro/ComfyUI card; idle-scheduled). Size: S/M/L.

### C1. `drive_gauge` — the Slice-0 dark instrument, python edition
- **Serves:** drive-vector computation (curiosity/social/energy/progress) + decay toward baseline.
- **Lives:** Echo background lane (`echo/worker.py` job or `spine/lanes.py`), ~60 s tick; exposes read-only MCP tool `internal_state_read` so the Node consumers (`lib/mood.js`, tick ladder) only ever *read* — fail-absent preserved.
- **Builds on:** sq.db read-only (`monologue`, `turns`, `open_threads`, `api_usage`, `agenda`, `commitments` — all confirmed in `lib/db.js` DDL), Echo `trajectory_log.py` for the journal.
- **In/Out:** in = existing exhaust rows; out = one journaled reading per tick `{drive, value, provenance_rows, ts}` in the subjective store. Zero consumers until Slice 1.
- **Cost:** SQL. **Size: S.**
- Matches the deterministic-control-loop-around-the-LLM shape argued by H-ECA ([techrxiv 10.36227/techrxiv.176779758](https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.176779758.84227760)): the regulator is code, the LLM is never asked to *be* the state.

### C2. `replay_harness` — the acceptance gate as a tool
- **Serves:** homeostasis measurement; Slice 0's gate ("replaying a fixed event log reproduces the trajectory exactly").
- **Lives:** Echo pass (`passes/` + `pytest` smoke); also renders the 48 h trajectory plot for the by-hand log check.
- **Builds on:** C1's journal; `trajectory_log.py`.
- **In/Out:** in = frozen event-log fixture; out = pass/fail byte-identical trajectory + drift report.
- **Cost:** SQL. **Size: S.** No C1 without C2 — an instrument that can't be replayed can't be trusted.

### C3. `novelty_meter` — embedding-distance curiosity signal
- **Serves:** a better `drive_curiosity` source than 1−cosine-to-last-item: novelty = distance to k-NN over a rolling index of recent thought/reading embeddings, plus a learning-progress track (novelty *decline* on a topic = learning happened).
- **Lives:** Echo sidecar loop using `echo/ann/` + `embeddings.py` (index infra already exists for entity ANN).
- **Builds on:** monologue/encounter embeddings already computed on the SQ side; Echo ANN index machinery.
- **In/Out:** in = new thought embeddings; out = per-item novelty scalar journaled with the k-NN witnesses as provenance → consumed by C1.
- **Cost:** SQL + embeddings (local, cheap). **Size: S/M.**
- This is the *state-novelty* half of RND — prediction-error-as-novelty ([Burda et al., RND](https://arxiv.org/abs/1810.12894); explainer: [apxml](https://apxml.com/courses/advanced-reinforcement-learning/chapter-4-advanced-exploration-strategies/random-network-distillation)) — implemented as k-NN distance instead of trained predictor nets (see §4).

### C4. `appraisal_stamper` — the VAD fast-predictor ensemble
- **Serves:** valence/arousal/dominance impulses per significant event (memo §4), the affect half of the vector.
- **Lives:** Echo lane calling a small local model through `llm_gateway.py`; batch, idle-priority; GPU-optional.
- **Builds on:** event exhaust (deliverable accept/reject, gate failures, corrections table, conversation passes); OCC→PAD mapping is a solved table-lookup pattern (Broekens, [In Defense of Dominance — PAD in computational affect](https://ii.tudelft.nl/~joostb/files/Broekens_2012.pdf)); classifier output constrained to the 3-tuple + appraisal-axis rationale, never prose.
- **In/Out:** in = event row; out = `{vad_impulse, axis, event_id, predictor_id}` journaled — impulse feeds C1's dynamics equation, magnitude feeds C6.
- **Cost:** LM (free local). **Size: M.**

### C5. `brier_scorer` — the calibration loop (Slice 3)
- **Serves:** falsifiable-or-silent: scores each C4 predictor against next-turn expressed affect / operator label; demotes uncalibrated predictors to uncertainty-only.
- **Lives:** Echo nightly pass (`passes/scoring/` already exists as a scoring home).
- **Builds on:** C4's journal + sq.db `turns`/`corrections` as ground-truth source.
- **In/Out:** in = prediction/outcome pairs; out = per-predictor reliability record; demotion flags read by C4.
- **Cost:** SQL + occasional LM labeling. **Size: S/M.** This is the slice that licenses keeping the organ (proposal §5).

### C6. `salience_stamper` — write-time importance hints
- **Serves:** review gap #3 / still-to-achieve #2: a priority signal so nightly work orders the 2.75 GB by importance, not recency.
- **Lives:** trivial extension of C4 — appraisal impulse magnitude written into the hint; on the Echo side it lands directly in the **existing** `memory_facts.salience` column (dark P4 DDL).
- **In/Out:** in = C4 impulse; out = salience float on the episodic row / bridged fact. **Cost:** SQL. **Size: S** (free once C4 exists — the review predicted exactly this).

### C7. `sleep_consolidator` — the dream loop, and the P4 store's first writer
- **Serves:** offline episodic→semantic consolidation; Continuity and Consequence in the §5b felt-quality table.
- **Lives:** Echo idle/nightly job (`worker.py`/`jobs.py`), Letta dual-agent pattern: a background process that shares the store with the live system and rewrites memory asynchronously ([Letta sleeptime docs](https://docs.letta.com/guides/agents/architectures/sleeptime/)); hierarchical abstraction tiers per TiMem's temporal memory tree — raw → summarized → persona-level, promotion guided by salience ([TiMem, arXiv 2601.02845](https://arxiv.org/pdf/2601.02845)).
- **Builds on:** the DARK substrate wholesale: `memory/bitemporal.py` (`write_fact` closes prior live rows), `memory/supersession.py` (auditable supersede log), `memory/write_hook.py`, `memory/recall.py`; sq.db→Echo bridge (37.5k promotions precedent); C6 salience for work ordering; `resolve/adjudicate.py` queue for conflicts it can't settle.
- **In/Out:** in = recent episodic rows, salience-ordered; out = `memory_facts` rows with 4-timestamp bitemporality + supersession lineage; conflicts → adjudication, never silent overwrite.
- **Cost:** LM batch at idle (free), GPU-optional. **Size: L** (M if scoped to consolidate-only, no reorganization pass). Reflection is load-bearing, not decor: Generative Agents degraded within ~48 simulated hours without it ([Park et al.](https://arxiv.org/abs/2304.03442); survey: [From Storage to Experience, ACL 2026](https://aclanthology.org/2026.findings-acl.2069.pdf)).

### C8. `probe_journal` — blind-week trace assembler
- **Serves:** the §5b real gate: every moment Lucas names must trace to a logged state trajectory.
- **Lives:** Echo pass that joins C1's journal + mood renders + tick-allocation logs into a per-day trace bundle.
- **In/Out:** in = journals; out = queryable trace (a `trace_for(timestamp)` MCP tool). **Cost:** SQL. **Size: S.**

## §3 Build order

1. **C1 + C2 together** — the dark instrument and its replay gate are one unit; nothing else is trustworthy without them. Strictly no consumers, so strictly no risk.
2. **C3** — upgrades C1's weakest input (curiosity) from a point-measure to a distribution-measure; small, pure-local.
3. **C4** — affect half; unlocks both C5 and C6. Needs C1 live first because impulses feed its dynamics equation.
4. **C6** — near-free once C4 exists; and it must exist *before* C7 so the consolidator's work-ordering is salience-driven from day one rather than retrofitted.
5. **C7** — the big one; deliberately last of the organs because it is the only circuit that *writes* durable memory, and it should write into a store whose salience and adjudication inputs are already honest. Waking the dark P4 store is also the highest-leverage single act on this list: built, indexed, zero writers.
6. **C5** — runs continuously once C4 has ~2 weeks of prediction/outcome pairs; demotion authority from day one.
7. **C8** — assemble just before the blind-week probe.

Everything stays **behind the standing queue** (proposal §7); this doc proposes shapes, not a jump.

## §4 What NOT to build

- **Prompt-asserted drives** — the blueprint's "Curiosity Drive: 0.15 — you are intensely bored" is the documented anti-pattern (review §2.2); under program-is-the-model it is training-set corruption. Python's whole advantage here is that the regulator can live outside the prompt entirely (the H-ECA argument, [techrxiv](https://www.techrxiv.org/doi/pdf/10.36227/techrxiv.176779758.84227760)).
- **An autonomy drive / drive-based "no"** — refused by design (review §3.2); refusals stay epistemic.
- **A global-workspace broadcast bus** — GWT/LIDA-style codelet competition for a broadcast bottleneck ([Theater of Mind, arXiv 2604.08206](https://arxiv.org/html/2604.08206v1); [LIDA](https://ccrg.cs.memphis.edu/assets/papers/2009/GWT-IJMC-2009.pdf)) is already implemented better as `lib/package.js` — engineered, measured budgets vs. asserted ratios (review §2.1). Building a second workspace in python would fork the manifest.
- **Trained RND predictor networks** — full RND brings training loops and the noisy-TV failure mode ([RND](https://arxiv.org/abs/1810.12894)); k-NN embedding distance over an ANN index gives the same state-novelty signal on infrastructure Echo already runs.
- **Consolidation-time deletion** — Letta-style prune/archive steps are where the pattern conflicts with the program: prove-or-fade grading, never purge (review §3.4). C7 supersedes bitemporally; `tx_to` closes rows, nothing is deleted.
- **LLM-narrated emotion in the consolidator** — the sleep agent summarizes and links; any output that asserts how she *felt* (rather than citing a C4 reading) fails the anti-performance rule (proposal §5b).
- **Self-referential recursion as an aliveness mechanism** — review §3.6; `lib/rumination.js` was built against it.

---
**Companions:** `PROPOSAL_INTERNAL_STATE_VECTOR_2026-08-14.md` · `COMPARATIVE_REVIEW_2026-08-14.md` · `EMOTIONAL_MATRIX_DESIGN.md`
