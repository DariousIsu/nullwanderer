# Program Deep-Dive Evaluation — 2026-08-15

Second full two-repo evaluation (SQ + Echo), run the morning after the tier-gate enforce
flip's first autonomous night (boot_p38). Two jobs: (A) adversarially re-review the 9 SQ +
1 Echo commits that landed 08-14, and (B) re-verify the 08-14 defect review's standing
findings at HEAD and hunt for new ones. Seven parallel read-only lanes + a live log harvest.

SQ HEAD `fe603e0` · Echo HEAD `0a12b9d`. Predecessor: `docs/PROGRAM_DEFECT_REVIEW_2026-08-14.md`.

---

## 0. LIVE ENFORCED-NIGHT HARVEST (boot_p38, first enforced night)

**Verdict: the gate held; no ambient-autonomous write slipped through, no gate fault, no
fail-closed trip.** All 10 `tier-gate BLOCKED` lines are the already-enforced explicit
`routeNeed` path (rainey_compile_verification_report ×5, os_approval_resolve ×2,
research_brief, hub_set_brand, one truncated) — model-picked writes that were hard-blocked
even in shadow. Zero blocks on the ambient loop. The shadow window's prediction held exactly.

**BUT — two latent write-blocks were never exercised and are real gaps (D1, D2 below):**
`hunter_find_email` and inline `promote_grounded_one` didn't fire in the 1,117-line window
(the Puller's Hunter stage hit no known domain; ingest ran via the healthy non-auto
"gate-less drain" path, not the inline graph-walk promote). The 08-14 shadow harvest that
produced the two-tool allowance inventory ALSO never exercised them — so the inventory is
incomplete, and these will block (fail-soft, but with silent capability loss) the first time
their lanes activate. This is the concrete morning-harvest finding the handoff banner asked for.

---

## 1. TODAY'S NEW CODE — DEFECTS INTRODUCED (highest priority: regressions in the just-shipped work)

### 1a. Civic/vacancy wire (`909a7d8` + `cb2fbda` + `6655203`) — the cure inverted the disease
The D14 lesson was "never invent a name for an empty seat." The new code can now do the
opposite — **assert an empty seat over a filled one, framed to the model as VERIFIED and cited.**
Four compounding HIGH findings:

- **C1 [HIGH] `lib/civic_store.js:361-374` — 2-token match uses the wrong stoplist.**
  `civicRecallFor` filters tokens against `_DIGEST_STOP` (tiny) not `_GENERIC_BODY_WORDS`
  (the set `heldRostersFor` uses precisely to prevent generic matches). "state"+"senate",
  "school"+"board", "county"+"commission" each score 2 against every chamber of that class.
  A Texas question with only Louisiana in the store → `louisiana state senate` becomes the
  best match → LA's D14 vacancy rides into chat as the answer to a Texas question.
- **C2 [HIGH] `main.js:7724-7733` — no freshness/confidence/citation gate before the
  "VERIFIED … genuinely empty, cited" header.** `recordVacancy` accepts `sourceUrl:null`,
  `sourceKind` default `'operator'`, confidence 0.5; the store's own 30-day `staleRostersFor`
  rule is never consulted on this path. Stale, uncited, and wrong-body rows all render
  identically to the Ballotpedia-cited D14 row — and the header tells the model NOT to double-check.
- **C3 [HIGH] `lib/civic_store.js:106-115,153-184` — a vacancy recorded after a fill never
  resolves.** The self-healing wire runs only on the fresh-INSERT path of `recordMembership`;
  `unchanged`/`regraded` re-records early-return before it. Successor lands → stale article
  records a vacancy → every later re-observation of the successor is `unchanged` → vacancy
  is live forever. `completeness` then double-counts (filled + phantom-vacant = N marks the
  chamber COMPLETE while a *different* seat is genuinely unresearched).
- **C4 [HIGH] `lib/civic_store.js:124-139` — auto-resolve wrong-match.** ANY membership row
  matching (body_key, district) resolves the vacancy — including a material-change supersede
  of a *colleague* in a multi-member district, or a prose re-extraction of the dead incumbent
  (no `RESEARCHED_KINDS` guard, unlike the roster path at line 99).

  Supporting-cast (MED/LOW, same file): seat "District 14" vs "14" invariant is comment-only
  (no normalization, no UNIQUE constraint) → "District District 14 — VACANT" and
  simultaneous "no live row held" + vacancy lines (C5); held-and-vacant renders both in one
  line, model picks at random (C6); `rkRows.unshift` of a civic hit downgrades grounding to
  "thin" (softens the search mandate) AND, at `rkRows.length===0` gating, disables the web
  fallback router entirely (C7, `lib/metacognition.js:84-90` + `main.js:11390`);
  `civicHits.length>=1` flips coverage RICH → suppresses autonomous research on topics the
  store can't answer (C8). SQL parameterization, UNION dedup, timestamp discipline, and
  supersede lineage all **verified sound**.

  **Fix shape:** gate the chat header on `confidence>=floor AND sourceUrl!=null AND
  observed_ts within staleness`; switch the token filter to `_GENERIC_BODY_WORDS`; require
  ≥1 *specific* (non-generic) token hit; run the self-heal on every record path (move it
  after the early-returns); normalize seat at write + add the UNIQUE constraint; exclude
  `hit` from the vacancy render when both exist. This is my code from today — it should be
  fixed before it grounds another chat turn.

### 1b. Typed routing (`3bce833`) — two ways the orphan disease returns
- **R1 [HIGH] `lib/user_work.js:62-70` — SELF checked before DELIVERABLE with overbroad
  nouns.** "Explore voter opinions in LA-03 and write a memo by Friday" matches
  `SELF_NOUN opinions` + `SELF_VERB explore` → `{lane:'self', confident:true}`, cloud
  classifier never consulted, deadline thread routed away from the driver. Recreates the
  exact original disease for this phrase class. **Fix:** order DELIVERABLE/RESEARCH detection
  before SELF, or require SELF to also *lack* a deliverable verb/deadline.
- **R2 [HIGH] `main.js:14090-14093` + `lib/db.js:1474` — a lane stamp is a one-way door.**
  Stamping calls `touchOpenThread` (flips pending→active); `getUnstartedUserThreads` selects
  only `status='pending'`; the stamp is permanent (`if getMeta(lane) continue`). A
  misclassified thread exits the seed pool forever with no re-classification path — *less*
  recoverable than pre-fix. **Fix:** don't flip status on stamp (stamp is metadata, not work
  start); or add a re-classification path for low-confidence stamps.
- **R3 [MED-HIGH] `main.js:14071-14081` — cloud-classifier failure head-of-line loop.**
  Threads ordered `created_ts DESC`, 2 ask-slots go to the newest ambiguous threads every
  90s, null results aren't cached → same 2 re-ask every tick (~1,900/day worst case) while
  older ambiguous threads never classify. **Fix:** cache a "tried, deferred" stamp with a
  cooldown; rotate the ask window.
- Self-lane consumer wire (R4) and tool-lane auto-close (R5) confirmed still absent — see §4.

### 1c. Tier-gate cluster (`5bddfb5` + `fe603e0`) — fail-open asymmetries survive the fail-closed catch
Core is sound (single chokepoint, anchored allowances, shell un-carveable, every autonomous
root correctly `lane.run`-wrapped — all **verified**). Residual holes:
- **G1 [MED] `lib/echo_suit.js:687` — lane-module fault fails OPEN.**
  `catch { _auto = !!opts.autonomous }` — if `require('./lane')` itself throws, every ambient
  dispatch resolves interactive → the whole gate silently reverts to pre-fix decorative. The
  fail-closed logic was built for an echo_tier fault; the lane fault is asymmetric.
- **G2 [MED] `lib/echo_suit.js:712-719` — interactive gate-fault allows LOCKED/SHELL.**
  The fail-closed catch blocks only when `_auto`; a fault on an interactive turn falls
  through with no residual locked check, so send_email/image_gen/shell (normally always-denied
  interactive) would dispatch.
- **G3 [MED] `lib/echo_tier.js:166` vs routeNeed — the `set_entity_temporal` carve is
  name-only, but routeNeed lets the cloud author its args**, violating the carve's own
  "deterministic, never cloud-authored JSON" invariant. Needs a call-site check, not a name allow.
- **G4 [MED] `lib/echo_suit.js:692` — `recipe` kind is never tier-gated** ("curated procedure").
  Soundness rests entirely on the untested Echo-side invariant that no recipe mutates — and
  Echo's `run_recipe` dispatches any registered tool in-process (see E4). One write-capable
  recipe = a silent autonomous write door.
- Latent (no live caller today): non-boolean `opts.autonomous` falls to interactive (G5);
  `routeNeed` default `autonomous=false` becomes explicit-false that beats ambient-true for
  any future autonomous caller through the module-level entry points (G6). Enforce-mode parse
  is exact-`/^enforce$/i` so a typo silently demotes to shadow with no boot log (G7).

---

## 2. FABRICATION SURFACE (next fix cluster per §6 order) — all prior findings STILL-PRESENT, sharpened

The parser (`lib/ollama.js` `TagStreamParser`) is load-bearing for every action; nothing ever
scans the raw stream. Confirmed at HEAD:

- **F1 [CRITICAL] `lib/package.js:256` vs `lib/ollama.js:374,389-422` — the prompt tells the
  model to put tags where the parser is guaranteed to discard them.** Package says "WHERE THE
  TAGS GO: AFTER the closing `</say>`." On `</say>` the parser sets `mode='post'`; `feed()`
  has no post branch and `finalize()` has no post case (line 416 `this.buf=''`) — everything
  after `</say>` is silently deleted, reaches no scanner. She says "putting this on your canvas
  now," the tag evaporates, no error, no followup, no antifab correction. Tags between
  `</think>` and `<say>` are also dropped (`stripTagBlocks` deletes well-formed tags in salvage).
  The ONLY positions a tag executes: inside `<think>`, inside `<say>` body, or the cloud
  reasoning channel (echo/recall/dig/skill only).
- **F2 [HIGH] `scripts/smoke_package.js:129-134` masks F1** by asserting `parseEchoTags(rawString)`
  — a dispatch path production does not have. The smoke is green on a broken contract.
- **F3 [HIGH] near-miss spellings — strip grammar is broader than parse grammar.** Single-quoted
  `name='db_query'`, attribute slack, `<echo-delegate name='x'>` are stripped from the visible
  say and never executed, no error (`echo_suit.js:158,338`); the followup generic scrub
  `replace(/<[^>]+>/g,'')` (`main.js:11835`) deletes any surviving tag-shape silently.
- **F4 [HIGH] `main.js:10418-10421` — `<draw>` and most families not scanned in the cloud
  reasoning channel** where the code's own comment says reasoning models author tags
  ("450 of 633 tokens, tags included, were in message.thinking"). Only echo/recall/dig/skill
  read `cloudThinking`; browser/web/file/screen/inbox/schedule/presence/email/discord/draw don't.
- **F5 [HIGH] `echo_suit.js:126-134` — the 240-char/newline committed bar drops real canvas
  blocks and delegate specs** from the reasoning channel (console-only rejection, model never
  told) — while the manifest commands "EVERY BLOCK CARRIES ITS REAL CONTENT."
- **F6 [MED] `main.js:11846-11848` — followup antifab verifier stubbed open** for canvas/image/db
  claims (`canvasWroteThisTurn:()=>true`) on exactly the path that historically fabricated.

**Fix-map (agent-supplied, exact):** add a `post` channel to `finalize()` and thread it through
every `parse*Tags` consumer (main.js:10211/10328-10421, 11815, 17784); loosen parse-grammar to
match strip-grammar OR make strip sites report; add `parseGenTags(cloudThinking)`; exempt
clean-JSON `kind:'do'` from the committed bar; thread a turn-start anchor into `fireToolFollowup`.
Smokes to rewrite: smoke_package.js (unmask F2), smoke_thinking_channel.js (currently locks in
the F4 omission), smoke_tag_parser.js, smoke_tag_contract.js.

---

## 3. CONSEQUENCE-MEMORY (aliveness prerequisite) — all prior STILL-PRESENT + 5 new family members

Every fix here is a transplant of a correct pattern sitting one file away. This cluster is
degraded at write, capped at intake, and dark at read simultaneously (M1+M2+M4 compound).

- **M1 [HIGH] `lib/active_recall.js:259-264` — graph facts never render.** `_relStr` reads
  `.source/.type/.target`; rows have `source_id/target_id/relation_type`. Always returns null →
  every `[graph]` line, the `facts.length>=3` rich trigger, and consolidation facts are dead.
  (`cb2fbda` shifted the line from ~238 but didn't touch the bug.) Fix must also join
  `graph_entities` for names — rows carry ids, not names.
- **M2 [HIGH] `lib/db.js:2474-2485` — relation upsert unconditional overwrite** downgrades a
  witnessed 0.95/confirmed edge to a re-extracted 0.75 and resets `confirmed=null`, undoing
  reconciliation. The entity path (`graph_memory.js:120-126`) is upgrade-only; relations got no guard.
- **M3 [HIGH] `lib/memory.js:136-138` — NULL-embedding knowledge invisible forever.**
  `getAllKnowledgeEmbeddings` filters `IS NOT NULL`; a `verified_fact` banked during an embedder
  outage never reaches `retrieveScored`, so the precedence gate can never fire on it. A turn
  backfill exists; no knowledge equivalent.
- **M4 [MED] `lib/graph_extract.js:51` — triple cap at 6 contradicts its own "up to 20" comment
  and prompt.** Model emits 20, parser truncates at 6 with positional bias. One-constant fix.
- **M5 [MED-HIGH] `lib/self_model.js:70` — self_model destructive merge when LLM down.**
  `classify3` catch returns `'same'` → `record()` overwrites a trait's content/embedding.
  Identity corruption, not just missed dedup. Fix: distinct `'unknown'` sentinel → plain ADD.
- **M6 [MED] `lib/mood.js:172-197` — no retry-floor**, called every user turn with a live cloud
  genFn → one wasted cloud attempt per turn when cloud is down. The cure exists verbatim next
  door (`self_narrative.js:20-26`, built for this exact measured failure).
- **New family members (store-writes that silently lose fidelity on dependency outage):**
  M7 self_model NULL-embedding rows still injected but un-consolidatable (`self_model.js:124`);
  M8 `storeDeduped` embed-fail = duplicate + invisible in one move (`memory.js:150`);
  M9 merge-with-failed-re-embed leaves a stale vector under new content (`memory.js:184`,
  `cloud_curator.js:220,396`); **M10 [MED] `lib/self_explore.js:156` — EXPERIENCE/personality
  rows are born `embedding:null` by construction** → the personality database (future training
  substrate per program-is-the-model) is invisible to scored recall; M11 interests NULL-embed
  rows can't gain reinforcement weight (`interests.js:68`).

---

## 4. BACKGROUND / WORKLIST + WONDERING ORGANS — the aliveness engine is still dark

- **B1 [HIGH] `lib/monologue.js:1622-1772` — free-thought lane unreachable (SQ-B2 confirmed).**
  `_runOneTick` has two terminal branches, both `return` before the `<wonder>`/self-`<focus>`/
  boredom-seed block. Under `ZOE_AUTONOMIC=1` there is no source of a non-directed focus:
  `focus.setFromText`→null, `rumination.escalate`→queues a thread (D1), directed foci nulled,
  and `interests.maybeSpawnFocus` — the one remaining undirected-focus spawner — **has zero
  live callers.** This is the drive-engine the state-vector proposal depends on; it is off.
- **B2 [HIGH] `main.js:13582,13590` + `lib/open_threads.js:306` — beat mint→resolve→remint churn.**
  `insertOpenThread` has no content dedup; the only seed-site dedup (`matchCarriedThread`)
  requires `source_turn_id!=null` so it can adopt Lucas's threads but never the beat's own
  prior mint. Resolve → maintenance sweep clears `bs.thread` → next pick re-mints identical
  content. A topical beat reminting 26× is this loop at its natural cadence.
- **B3 [MED] `lib/db.js:1576` — action_count near-dead.** Its only writer path
  (`parseAndApplyStatusUpdates` from model-emitted `[thread-progress:N]` tags) runs only in the
  chat thought channel and the near-dead generateThought path (B1). Directed research, the beat
  driver, and the user-work driver all use `touchOpenThread` and never increment. Downstream
  consumers mislead: curator's "over-pursued" retirement (`curator.js:83`) can never fire.
- **B4 [MED] `main.js:11570` + `open_threads.js:135` — cross-turn dup minting race.**
  `extractFromUserTurn` is fire-and-forget; each snapshots the dedup pool once at entry.
  Two work-shaped turns seconds apart → second's pool predates first's insert → double mint.
  `consolidate.decideForCandidate` fails **open to ADD** on classify/embed failure. HEAD's
  newestFirst fix closed the within-window variant, not the cross-turn race.
- **B5 [MED] R2 head-of-line block on need #24 (`need_triage.js:88` + `rehearsal_driver.js`).**
  `duePressure` returns `iterate` whenever any run exists; a run that only ever *parks* leaves
  its need stuck in status `'rehearsing'` forever (advanced only on green/stuck/discarded;
  excluded from `listOpen` so the 7d reaper can't touch it). Resume → burn 6 iters (or 4
  no-ops) → park → 30-min gap → resume, monopolizing the lane. Parked-since-08-10 signature.
- **B6 [HIGH] self-lane consumer wire missing (R4 confirmed):** `self_explore.js` reads no
  `thread.*.lane` meta — picks only from its hardcoded CATALOG. Self-lane threads are stamped
  then permanently orphaned. Compounds: D1 rumination themes enter `getUnstartedUserThreads`
  (which has no user-origin filter despite the name) and die in the same orphanage.
- **B7 [MED] tool-lane auto-close missing (R5 confirmed):** need minted with `bornFrom:'thread-N'`;
  nothing parses `born_from` back to a thread resolve. Green R2 card leaves the thread pending forever.

**Predicted first-enforced-night blocks not yet observed (latent gaps):**
D1 `hunter_find_email` (write, autonomous=true, explicit — dead since the ambient-gate fix,
never in the shadow harvest; `_hunterFind`→null→pattern+web fallback, silent capability loss);
D2 inline `promote_grounded_one` (write, ambient — comment claims non-auto but passes no opts;
blocked when armed, batch drain covers it ≤1min); D3 `saga_canvas_update_block` in list-completion
(silent engine/durable-mirror divergence, no throw so the blocked result is ignored — while every
*other* canvas write bypasses the gate via `pollCallTool`). Fix D1/D2 by tier-taxonomy/opts
correction (one line each); D3 by checking the blocked result.

---

## 5. VOICE / INDIVIDUALITY — both prior findings stand; the guard graduated but leaks

- **V1 [HIGH] `main.js:685-695` + `lib/voice_guard.js:101-105` — one hotkey cycle kills
  auto-detect permanently (SQ-I1 confirmed, worse than filed).** The only road back to auto
  mode (`manual('auto')` over IPC `voice:guard-manual`) is **unreachable dead code** — preload
  exposes no guard function to the renderer (grep: zero hits). Pause-before-call + resume-after
  = meeting auto-detect dead until restart, silently.
- **V2 [MED-HIGH] `main.js:594-626` — pause doesn't flush in-flight speech (SQ-I2 confirmed).**
  Guard checked at enqueue only; nothing calls `_speech.flush()` on pause. Unprompted utterances
  (`speakStreaming`) enqueue all sentences at once → pause has zero effect on that whole utterance.
- **V3 [MED] `main.js:3018-3030` — `speaker:enroll` has no guard check** → meeting-room voices
  can contaminate the operator voiceprint if enrollment is active mid-meeting.
- **V4 [MED] `main.js:584-586` — auto-detect tick gated on `ttsConfig().enabled`** but the mic
  isn't → a voiceless install (TTS off, mic on) never auto-pauses; meetings become turns.
- **V5 [MED] speaker-gate reject path has no organ watching it.** Env-beats-snapshot precedence
  is **verified real** (`speaker.js:43-49`), but a quiet genuine-REJECT is a console line only —
  no counter, no score history, nothing that would ever surface "add enrollment samples." The
  never-lower-the-cut doctrine lives only in comments. Compounds with **V6 [MED]**: the 400ms
  pre-roll ring buffer runs unconditionally (`chat.js:784`) and can seed an utterance with her
  own speech tail → drags genuine scores toward the 0.575 cut → produces exactly the quiet
  rejects nobody counts. Curiosity confirmed still language-driven (unchanged).

---

## 6. ECHO — auth fix is correct for /mcp but bypassed in-process; fusion findings all stand

- **E1 [HIGH] `echo/nl/tool_loop.py:100-105` + `deterministic_dispatcher.py:199-206` — the auth
  commit fixes the /mcp wire path but NOT the in-process chat path.** `deny_untagged_to_readers`
  runs only in `AuthMiddleware.on_call_tool` (HTTP JSON-RPC). `/admin/chat`, `/skuld/chat`,
  `/saga/chat` dispatch via `tool.fn(**args)` directly, bypassing all middleware, and partition
  read/write as `tags & {"admin","write"}` → all 441 untagged tools land in READ and are exposed
  to `is_admin=False`. A **read-only shared-token** holder can POST `/admin/chat` and prompt the
  LLM to invoke `hub_delete`, `spawn_agent`, `team_spawn`, `decide_resolution_proposal`. Same root
  disease as the one just closed, one door over. Fix: default-deny the chat partition (untagged⇒write)
  or route chat dispatch through `parent`. (E2: the Saga toolset wraps `external` not `parent`,
  same bypass — trusted-operator, bypass-by-design, but a second uncovered surface.)
- **E3 [HIGH] default-deny locked 454 read-only tools out of the reader tier.** Only 3 tools
  carry `read`; the entire search/retrieve/introspect surface (search_knowledge, get_document,
  stats, get_db_map, kg_query_*, every connector) now needs a write token. Invisible today only
  because the SQ client holds admin. Usability debt + a ratchet risk: if catalog reconciliation
  ever pattern-tags hub tools `read`, `hub_delete` silently re-opens (it's protected only by the
  blanket untagged⇒write rule, not an explicit tag — same for a family of untagged mutator siblings).
- **E4 [HIGH] the shell→admin gate covers exactly one tool.** `restrict_tag("shell")` matches only
  `os_run_powershell`. `gui_do`, `os_launch_app`, `os_send_keys`, the UIA drive surface, agent
  spawns, `run_recipe` (dispatches any registered tool **in-process**, tag-blind), and proxied
  `blender_execute_blender_code` are all arbitrary-execution-capable and sit at the **write** tier,
  one rung below the PowerShell they're peers with. The local permissions confirm-gate defends in
  depth, but the HTTP scope model's "shell is admin-gated" mental model is ⅛ true.
- **E5 [HIGH] `echo/graph.py:696-698` — promote_proposal merges by bare name, no type check
  (M-fusion confirmed).** Person "Jackson" folds into place "Jackson"; provenance mis-attributed;
  irreversible (proposal row deleted). The type-aware guard exists in two sibling paths
  (`propose_entity:320`, concept promote:826) — `promote_proposal` is the outlier. **One-line fix:**
  add `AND entity_type = ?` to the dedup SELECT.
- **E6 [MED] `echo/resolve/adjudicate.py:111-113` — "second signal" double-counts jurisdiction.**
  Juris is already in every name blocking key, so `corroboration()=="jurisdiction"` is structurally
  guaranteed for any name-blocked pair → `_anchored` auto-anchors name-exact+juris → LLM demoted to
  veto-only. The two-signal gate collapses to one → over-merging. **E7 [MED]** surname-only names
  produce name-exact joins → union-find collapses a whole block of "Jackson" stubs into one cluster
  (compounds E6 then destroyed by E5 at promote). **E8 [MED]** adjudication queue head-of-line
  starvation: parked low-id proposals reoccupy every batch head; no `last_attempted_at` cursor.
- **E9 [LOW] P4 bitemporal + relation supersession fully dark (confirmed).** Schema created every
  Store open; grep confirms zero `INSERT INTO relation_supersession`, `log_supersession`/
  `supersede_fact`/`recall_as_of` have no callers outside `echo/memory/`. `tx_to` always NULL,
  no history accrues. The substrate the consequence-memory/aliveness build depends on is inert.

---

## 7. FIX ORDER (revised from the 08-14 §6, incorporating today's regressions)

0. **Today's regressions first** (they ship defects into live paths): C1-C4 civic wire (my code;
   fix before it grounds another chat turn), R1-R2 routing orphan-return, G1-G3 gate fail-opens,
   D1-D3 latent enforce blocks (one-line taxonomy/opts fixes).
1. **Fabrication surface** (F1-F6) — the `post`-channel salvage is the keystone; unmask smoke_package.
2. **Consequence-memory** (M1-M11) — all transplants; M1/M2/M4/M10 first (write→intake→read chain).
3. **Voice-guard promise** (V1-V6) — V1 (expose the preload handback) + V2 (flush on pause) are
   the honesty-critical pair.
4. **Echo in-process auth + fusion** (E1 chat-path default-deny, E5 one-line type check, E4 shell
   taxonomy) — E1 and E5 are high-value/low-effort.
5. **Re-wire the wondering organs** (B1/B6) — the aliveness prerequisite; do AFTER the memory
   cluster (a drive engine with corrupted consequence-memory is a dashboard with no engine), and
   BEFORE the internal-state-vector proposal.
6. Worklist hygiene (B2-B5, B7, action_count) — churn/dedup/lane-close; lower user-visible stakes.

Nothing in this review has been fixed — read-only sweep, both trees clean. Live gate harvest is
clean of ambient blocks; the enforce flip is holding.

[[program-defect-review-2026-08-14]] [[program-census-plan]] [[pre-land-sweep]]
[[comparative-review-and-state-vector-proposal]]
