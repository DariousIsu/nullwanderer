# THE SWARM SUBSTRATE — cluster specialists for retrieval, curation, and the autonomic loops (design, 2026-08-30)

**The ask (Lucas, 08-30):** "What if the swarm was tied into everything including context retrieval and
curation. We could use a swarm burst with assigned swarm agents that specialize in different memory
clusters — we might be able to apply this to the autonomic processes as well." And the day before:
"all answers need to be grounded in substantive facts so the swarm flare should go out all the time,
especially since we use cheaper models for the information gathering."

**The evidence this stands on:**
- The gather swarm's first fire (08-30, §72): a driven dossier order spawned 4/4 engine agents, harvested
  ~12.3KB of deposits, and the writer delivered 24KB/3,577w with everything in front of it — after the
  swarm had **zero successful spawns in its entire prior history** (one hyphen, §70). The pattern works;
  it has simply never been pointed at anything but documents.
- The "answering from the model" branch (the atlas's one red line): when cognition's graph pull comes back
  thin, the reply speaks from the model — the standing doctrine violation, on the menu since the deep-dive.
- The Keeter triplication (§69): Madeline Keeter exists three times; 21 Rainey-named nodes include two
  1930s congressmen and Ma Rainey. The fusion debt is cluster-shaped, and no single-loop drain has the
  cluster context to see "meeting-suffix duplicate of the colleague" at a glance.
- The engine registry already holds 15 specialists with tool whitelists (polling-strategist, donor-flow-analyst,
  legislative-analyst, press-monitor, the Rainey verification chain…) — the specialist pattern exists;
  what's missing is the harness treating it as a substrate instead of a document feature.

**The law this extends:** the DB is the foundation and the LLM is the voice. A swarm substrate is the
foundation growing its own hands — many cheap eyes, one trusted mouth, and every write still through a gate.

---

## THE CLUSTER MAP — who owns what memory

| Cluster | Store(s) | Existing specialist | Gap (registers ENGINE-SIDE — his lever) |
|---|---|---|---|
| Legislation & bills | bills, trackers, LegiScan | legislative-analyst, bill-tracker | — |
| People & CRM | contacts, entities (person) | — (fact-checker adjacent) | **people-curator** (dupes, meeting-suffix fusion, staleness) |
| Documents & holdings | documents, downloads, artifact registry | citation-verifier | **document-curator** (orphans, supersession, registry hygiene) |
| Civic / local gov | civic datasets, rosters | — | **civic-curator** (roster staleness, place-key traps) |
| Polling & forecasts | polling corpus, scenario engine | polling-strategist | — |
| Press & events | news bucket, feeds | press-monitor | — |
| Donors & money | FEC, donor flows | donor-flow-analyst | — |
| Owner world | owner_world, meetings, personal facts | — | **owner-curator** (small, high-trust; anchors + aliases) |
| History & precedent | multi-decade legislative | historical-researcher | — |
| Opposition & red-team | adversarial framing | opposition-researcher | — |

The roster gap is four curators. Everything else reuses agents that already exist.

---

## THE THREE TIERS — matched to their physics

### T1 — THE GROUNDING FLARE (retrieval, reactive)
Engine agents take minutes; chat takes seconds. So the flare never blocks a reply — it chases one.

- **Trigger:** cognition's thin-grounding signal (the exact branch that today logs the doctrine-risk line).
  Deterministic; no new classifier.
- **Fire:** 1–2 cluster specialists picked by the manifest's coordinate types on the turn (a person mention
  → people cluster + press; a bill → legislative-analyst + fact-checker). Async, `spawn_agent_async`,
  quiet canvas (see rails).
- **Land:** deposits return through the existing verify-followup lane — enrichment when she was right
  ("the research team came back with…"), a correction when she wasn't (the antifab posture, already built).
- **Effect:** the flare goes out **exactly when she would otherwise answer from the model** — the red
  branch stops being an ending and becomes a beginning.

### T2 — ANTICIPATORY BURSTS (retrieval, ahead-of-turn)
The brainstorm light-pull generalized to a fleet. When conversation warms on a topic (the existing
warm/idle-depth signals), the idle lane fires a cluster burst *ahead* of the next turn; deposits land in
the working set (short-term store, marked as burst-born) so the NEXT reply's package already holds them.

- Pacing: idle lane, governor + burst-rule gated, lull-aware — never mid-exchange main-thread work.
- Recall the churn law: deposits enter the short-term buffer marked and graded, never straight to trust.
- Kill-switch meta (`swarm.anticipate`) — this tier is the most speculative; it ships dark and earns its keep.

### T3 — THE CURATION SWARM (autonomic, the best fit)
Curation is latency-free and cluster-shaped by nature. Each autonomic drain becomes a burst of
cluster-scoped **proposers** feeding the gates that already exist:

- **people-curator** sweeps person entities: meeting-suffix dupes, degree-0 orphans, alias fusion →
  `propose_*` / resolution proposals. The Keeter triplication is its acceptance test.
- **document-curator** sweeps the registry + notes: orphan artifacts (the three from 08-30 are its first
  worklist), superseded canonicals, absent provenance.
- **civic-curator** re-verifies roster rows against place keys; staleness flags, never silent edits.
- The existing drains (dedup adjudication, enrichment, absence resolution, kg-apply) keep their gates and
  breakers; the curators only widen the *noticing*, at cluster context the single loops never had.

**THE ONE RAIL THAT MAKES T3 SAFE: curators PROPOSE, gates DECIDE.** No agent writes the graph. Fan out
the eyes, funnel the pen. The proposal machinery (propose_entity, propose_relation,
decide_resolution_proposal, the quarantine/trust boundary) is untouched and remains the single door.

---

## THE RAILS (all three tiers)

1. **Propose-don't-write** — above. The fusion gate, substantiation gate, and quarantine boundary are
   never bypassed by a swarm deposit.
2. **Latency honesty** — nothing in-turn ever waits on an agent. T1 chases, T2 precedes, T3 is autonomic.
3. **Quiet canvas** — the engine auto-renders agent deliverables to canvas tabs; flare/burst/curation
   spawns pass a designated quiet tab (or the engine grows a `canvas_tab:"none"`) so the workspace isn't
   littered. (Today's dossier run rendered four tabs — acceptable for a dossier, not for ambient bursts.)
4. **Governor pacing** — bursts ride the idle/research lanes under the burn-down governor + the burst
   rule; the interactive reserve floors survive everything. A flare is small (1–2 agents); a burst is
   bounded (≤4); curation runs at drain pace.
5. **Engine-side registration** — the four curator agents are registry entries on HIS engine (purpose,
   tool whitelist, cite floor). The harness never invents agent names; it reads `list_agents`
   (the §70 law: the registry's hyphenated names are the only names).
6. **Deposit provenance** — every deposit lands marked burst-born with its run id; grading at read time,
   per the encounter law. A deposit is testimony, not truth.
7. **D3 interplay** — a swarm-of-swarms is the workload the durable-graph pilot was scoped for. This
   design does not depend on D3, but if D3 lands (Mastra or native), the burst state (spawned, deposited,
   harvested) moves onto it first.

---

## BUILD ORDER

- **W1 — the flare + the citation fix.** The grounding flare on the thin-cognition signal (T1), plus the
  writer's citation format (numbered markers + a Sources section — today's dossier is comprehensive but
  inline-source hard to read). Acceptance: a thin-grounding turn produces an honest immediate answer AND
  a follow-up enrichment within minutes; no "answering from the model" line without a flare line beside it.
- **W2 — the curation swarm, people first.** people-curator registered (his side), wired as a proposer
  burst on the dedup/fusion drains. Acceptance: the Keeter triplication resolves through the proposal
  gate; zero direct writes by any agent.
- **W3 — document + civic curators.** First worklist: the three orphan artifacts of 08-30; the roster
  staleness flags. Acceptance: orphans retired through proposals; no canonical touched without one.
- **W4 — anticipatory bursts, dark.** Behind `swarm.anticipate`; measured by package-fit improvement on
  warm-topic turns (does the working set already hold what the next ask needed?) before it ever defaults on.

One cycle per W, meter-watched, per the standing rhythm.

## DECISION POINTS FOR LUCAS

1. **The curator roster** — four new engine-side agents (people, document, civic, owner). Register all
   four up front, or people-curator alone until W2 proves the funnel?
2. **Flare breadth** — thin-grounding turns only (recommended start), or every lookup-class turn?
3. **Quiet canvas** — a designated "research-flare" tab, or an engine-side `canvas_tab:"none"`? (The
   latter is an engine change — his docket.)
4. **W4 at all** — anticipatory bursts are the speculative tier; comfortable shipping it dark, or park
   until T1/T3 prove out?
