# Harness organ catalog — the remaining transplants (2026-07-22)

Written for the build lane by a harness-native context — the same Claude Code harness slices 2/3
were dissected from, describing its own organs from the inside. This is a **catalog, not a build
order**: material for whenever the lane has time. Slicing and priority stay Lucas's call.

Method is `program-not-context` (auto-memory): port the ORGAN — the mechanism that makes fixed
weights perform above their class — never the CONTEXT MODEL. The thesis and the existence proof
live in auto-memory `harness-fills-the-gap`: this harness already implements "how-to in DB memory
on fixed weights" (skills, CLAUDE.md, auto-memory, hooks, the smoke gate), and the same weights
visibly outperform inside it. Each entry below names the harness mechanism, why it works, where it
lands in Zoe (verified against the code 2026-07-22), what the transplant is, and the
context-model trap to refuse.

Nothing here was built or committed by this lane. Doc only.

---

## 1. Already transplanted — do not re-port

| Harness organ | Zoe port | Where |
|---|---|---|
| Task list / background-task board | Workstream board + resource locks | `lib/board.js` (2a, 77bf9b2) |
| Procedural auto-memory | Crystallized procedures w/ track records | `lib/procedures.js` (2c, 2114952) |
| Permission allowlist + forced args | MAINTAIN_TOOLS, args merged at dispatch | `lib/echo_tier.js` (2d, 78c6f34) |
| Read-own-source | Jailed source_map/read/search | `lib/self_source.js` (3a, 5ad01cd) |
| Verification oracle (`npm test`) | `self_test` runs the offline gate | `lib/self_source.js` (3a) |
| Worktree isolation | Rehearsal sandbox, junctioned node_modules | `lib/rehearsal.js` (R1) |
| Edit primitive (exact-match contract) | `rehearsal.edit` — sandbox-only | `lib/rehearsal.js` (R1) |
| CLAUDE.md standing instructions | Directives table — always-on, no decay, provenance | `lib/directives.js` |
| Dereference handles ([dN]) | `<recall ref="dN"/>` pulls the stored DOCUMENT | 8a2964c, translator layer 3 |
| Background-task notification | `_drainAgentInbox` → readings + toast | `main.js` (895c2fc; see O5 — half done) |
| Instruction-pack-on-demand (single case) | `<echo-guide>` returns the atlas as a turn tool-result | `lib/echo_suit.js` (see O1 — generalize this) |

## 2. The acceptance contract (every new organ signs it)

These are the codebase's own laws, restated so no organ ships without them:

1. **Pure core, injected I/O, offline smoke** — every module ships with a `scripts/smoke_*.js`
   and joins the gate. No organ "passes" on a model's say-so.
2. **One choke point** — anything a model can reach autonomously classifies through
   `echo_tier.policyFor` / the `echo_suit` dispatch. No side doors.
3. **Determinism law** — no LLM inside allocation, render, or enforcement loops. The model
   decides *what*; code decides *whether* and *renders how*.
4. **Board registration** — long or resource-holding work does `board.start/beat/finish`.
   Nothing is silent.
5. **Propose, never apply** — writes that change her or the record land as proposals with
   provenance. Code crosses into the live tree only through Lucas + the gate + a commit
   (`docs/REHEARSAL_SANDBOX_DESIGN.md` R3 stance).
6. **No artificial caps** — size work to the window/task; a bound may DEFER (park + resume,
   honest deferral note), never silently truncate (auto-memory `artificial-caps-truncate`).
7. **Let it in, mark provenance** — new material lands marked and churns; doors don't reject.
8. **Kill-switch pair** — `ZOE_<ORGAN>` env + a `meta` flag, the `lib/autonomy.js` pattern.

---

## 3. The catalog

### O0 ⭐⭐ THE LINE OF INQUIRY — why the background still isn't logical

*Added same-day, after Lucas's observation: "the background research is still non logical, the
models aren't driving the lanes." Run to ground against boot40/41 + the code before writing.*

**The observation, measured.** Three mechanisms produce exactly what he's seeing:

1. **The one model-driven lane made ZERO decisions in boot40.** A full day, not one
   `[autonomy] chose=` line — the driver deferred throughout (directed #3542 resumed at boot and
   outranked it all day; `_researchGateOk` pacing/caps; free-slot requirement; boot40's slice-1
   yields). Worse, deferrals at `_researchGateOk` (main.js:8614) are SILENT — `return false`, no
   log — so a zero-decision day looks identical to a working one. boot41 so far: driver started,
   inbox drained, still no decision.
2. **The volume that DID run is code-enumerated.** boot40 background: 454 [graph-walk] +
   153 [idle-anchors] + 119 [pipeline] + 42 [puller-walk] + 44 [doc-decomp] moves. Every target
   was picked by constants — tier cascades (`idle_anchors`: news→frontier→convo, MAX_PER_TIER=6),
   degree thresholds (`graph_walk`: THIN_DEGREE=8, WALK_MAX_NODES=5), roster order (puller).
   The model is called INSIDE each move to interpret and extract; it never chooses the object,
   the moment to move on, or what "done" means. Each move is locally fine; the SEQUENCE is a
   scan schedule, and a scan schedule reads as a random walk. (`engine-starvation-audit` named
   it: code enumerates, model fills templates.)
3. **Where the model does decide, continuity is against the rules.** One decision → one bounded
   operator run → a one-line history entry; the next tick re-decides from counts + 8 one-liners.
   No leads carry, no "what I learned," no next step. And DECISION_WANT instructs: *"Do not
   choose a target your recent ticks show as just-run… Variety matters across ticks."* Written
   to kill repetition-noise, it also forbids follow-through — a run that surfaces a promising
   lead may not be followed next tick. In this harness the default is the inverse: continue until
   answered or blocked; variety is the exception. That inversion, more than any gate, is why the
   lanes don't feel driven.

**In the harness.** The unit of my autonomous work is not a step or a tick — it is an
INVESTIGATION: a question that persists, accretes evidence, revises after every observation, and
decides its own next step, until answered, dead-ended, or blocked. My context window IS that
persistence. Zoe can't hold a window for hours — so the investigation must be an object. This is
the program-not-context move applied to the driver itself.

**Landing sites.** The persistence machinery already exists — for HIS work: a directed focus
accretes into a dossier, parks, and resumes across reboots (#3542 proved it on boot40 — the very
run that starved the driver). Her self-chosen work gets amnesia by design. Also on hand:
expect-vs-actual verdicts (895c2fc), procedures (2c), the board (2a), doc_store artifact landing
(530c51b), the tick manifest.

**The transplant.**
- `inquiries` table: `question` (model-authored), `born_from` (interest / gap / story / lead —
  the state line it came from), `status` (active | parked | closed_answered | closed_dead_end),
  accreted `evidence` (cited — reuse the focus/dossier accretion shape, don't invent a second
  one), `open_leads`, `next_step` (model-written at the end of every touch), `touches`,
  `last_touched_ts`, and the expect-verdict trail.
- **The decision flips to continue-first.** The manifest carries OPEN INQUIRIES (question +
  next_step + verdict trail). The tick chooses: ADVANCE one (the default) · OPEN one (the
  exception, born from a named state line) · CLOSE one (answered or dead — honest closure is
  first-class, like `nothing`) · or the existing one-shot moves. The variety rule survives
  ACROSS inquiries and dies WITHIN one.
- **Write-back per touch.** A touch's brief = question + evidence gist + next_step + matched
  procedures; the run ENDS by writing back learned / leads / next_step (structured, validated —
  the O3 envelope). The next touch starts where this one stopped: retry-with-context at day
  scale. Ticks become steps IN something.
- **Feeders feed.** graph-walk / idle-anchors / news principals / absence gaps become LEAD
  emitters into the decider's view (candidate inquiries), and their autonomous volume rebalances
  downward once inquiries carry the depth — the conductor stance already says old pickers become
  streams the conductor allocates.
- **Un-starve the driver, audibly.** Every deferral logs its reason
  (`[autonomy] deferred: directed-focus | pacing | caps | no-slot`) — a zero-decision day must
  be visible in one grep. And the deliberate 2b lockout ("his assignment outranks idle" = total
  yield) softens to SLOT priority: a directed focus holds one pool slot, the driver may take the
  other. ⚠️That relaxation reverses a decision 2b kept on purpose — it is Lucas's call, flagged
  here, not assumed.

**Do NOT port**: unbounded time-slicing (a touch is still one bounded run on a pool slot);
inquiry spam (opening requires naming its born_from state line; open count bounded, oldest
parks); rolling-rewrite evidence (append + gist — the meeting-notes lesson); deleting the
code-enumerated lanes (they are her reflexes; the inquiry is her attention — demote, don't
amputate).

**Proof.** Smoke: a seeded inquiry advances across 3 simulated ticks, each brief carrying the
prior evidence, close writes the answer artifact to doc_store. Live — the test Lucas actually
set: read a day's log and the background reads as LINES OF WORK (`[inquiry #N] touch 3 …`
advancing the same question) rather than a shuffle; "what are you working on?" answers with a
question and its progress; a starved day says why.

---

### O1 ⭐ THE SKILL SHELF — trigger surface small, bodies out of context

**In the harness.** A skill is a file: name + a one-line *trigger description* + a body of steps/
checks + optional scripts. The mechanic that makes it work is **progressive disclosure**: the
descriptions — one line each — are ALWAYS in context; the body loads only on invoke; references
load only at need. I carry ~80 trigger lines everywhere and pay for a body only when it fires.
Users can also invoke by name (`/slash`). That's the whole trick, and it is the existence proof
Lucas pointed at.

**Why it works.** Retrieval is the bottleneck (`harness-fills-the-gap`): a procedure that doesn't
surface at the right moment doesn't exist. The shelf solves surfacing by making the *trigger
surface* cheap and permanent while keeping *content* dereferenced — the [dN] pattern applied to
know-how.

**Landing sites.** Three procedure systems already exist and should NOT be merged:
flow recipes (`recipes/*.json` + `lib/flow_runner.js` — Playwright replay w/ heal ladder),
the procedural-memory card (`lib/recipes.js` — need→literal-tag map, parser-checked),
crystallized procedures (`lib/procedures.js` — met/unmet track records, token-overlap match).
Plus the one existing load-on-demand instruction pack: `<echo-guide>` (`lib/echo_suit.js`).
Program-side grep confirms there is otherwise NO skill system.

**The transplant.** A registry over the existing systems, not a fourth system:
- `skills` table: `name` (slug PK), `trigger_desc` (≤140 chars, the retrieval surface), `kind`
  (`flow|procedure|shape|guide`), `body_ref` (recipe file / procedures.id / doc-shape key /
  guide id), `applies`, `provenance`, `uses`, `last_used_ts`.
- **Descriptions ride, bodies don't**: chat turns and operator briefs get turn-matched trigger
  lines (reuse `procedures.match` token overlap); the autonomy manifest gets a bounded
  HER SKILLS section (top-K by relevance + total count — counts+keys, never bodies).
- **Pull by handle**: `<skill name="…"/>` returns the body as a tool-result that turn — exactly
  the `<echo-guide>` mechanic, generalized. One new tag, one dispatcher case.
- **Births**: a crystallized procedure reaching met≥3 promotes to a shelf row (body_ref points at
  the procedure — no copy); flow recipes and doc shapes register at boot; Echo `list_recipes`
  entries mirror in read-only. Growth stays the agreed path: research findings → RECIPE PROPOSALS
  Echo-side, Lucas-approved; the shelf just makes them *findable* once approved.

**Do NOT port**: loading skill bodies into every prompt (that's the context model), or letting a
cloud call decide *which* skills exist (registry writes are code paths and approved proposals).

**Proof**: gate smoke for register/match/pull; boot log `[skills] N on the shelf`; a chat turn
whose brief shows a trigger line and whose transcript shows the body arriving only after
`<skill name=…/>`; "what can you do?" answered from the shelf, not confabulated.

---

### O2 THE REHEARSAL DRIVER — the loop that makes R1 an arm, not a hand

**In the harness.** My build loop is: read → edit (match-contract) → run the oracle → **read the
failure** → edit again — for hours if needed. The single most load-bearing mechanic is
*retry-with-failure-context*: the failing output rides the next attempt verbatim. Zoe already
learned the small version (44f8052: an arg failure teaches the arg SHAPE).

**Why it works.** `harness-fills-the-gap` names it: fluid composition doesn't transfer to smaller
weights, but a tight decompose→verify→retry loop SHRINKS the residue the model must supply. A mid
model in a tight verify loop beats a big model open-loop.

**Landing sites.** `lib/rehearsal.js` has create/edit/test/diff/discard — but nothing LOOPS them.
The operator defaults to 4 steps/45s (`lib/operator.js DEFAULT_MAX_STEPS/MAX_MS`); the autonomy
tick runs one bounded operator pass. A failed `rehearsal.test` currently just… sits there.
Directed research already parks/resumes across reboots (#3542) — that's the iteration shape to
reuse.

**The transplant.** `lib/rehearsal_driver.js`, a tick-shaped loop over the R1 primitives:
- A run = `{slug, goal, iteration, last_result, status}` journaled in meta/sq.db — **park between
  ticks, resume across reboots**; never one blocking hours-long call.
- Each iteration: pick edit (cloud, with goal + diff-so-far + **the failing suite output raw**) →
  `rehearsal.edit` → `rehearsal.test` (one suite first, full gate before exit) → parse verdict.
- Exit states: **green** → R2 proposal card (diff + gate verdict + rationale — the only exit that
  leaves the sandbox, per `REHEARSAL_SANDBOX_DESIGN.md`); **parked** at iteration budget (honest
  note, resumable — a bound defers, never disappears); **stuck** (same suite failing with an
  unchanged diff 2×) → stop + write a `constraint` row via `procedures.crystallize`'s unmet path.
- Registers on the board (lane `rehearsal`, a cloud pool slot per iteration, never `cloud_slot_1`).

**Do NOT port**: wall-clock-hours single calls; auto-adopt on green (R3 stance is absolute);
letting the driver touch anything outside `data/rehearsal/<slug>/`.

**Proof**: smoke with a seeded failing sandbox that converges in ≤3 iterations offline (stub
cloud); boot log `[rehearsal] run <slug> iter N verdict=…`; a parked run resuming after reboot;
a green run producing a proposal card and NO live-tree change.

---

### O3 STRUCTURED RETURNS — delegation joins its origin, and the board sees it

**In the harness.** Subagents return **data, not prose**: I can force a JSON schema on an agent's
final output, validated at the tool layer, retried on mismatch. Delegated work notifies on
completion and *joins the task that spawned it*; agents also register as visible background tasks.

**Why it works.** A return that isn't structured can't be checked (expect-vs-actual needs fields);
a return that doesn't join its origin is a toast, not a result.

**Landing sites.** `_drainAgentInbox` (`main.js`) polls `agent_inbox` every 5 min → monologue
readings + toast + `meta autonomy.inbox_recent`. But: **`lib/package.js` (~line 148) and
`scripts/smoke_assignment_plan.js` still teach that delegation is a one-way door** — the guidance
layer contradicts the shipped wiring. Delegation is tier-HEAVY (interactive only). Delegated
agents never appear on the workstream board, so "what are you doing?" omits them.

**The transplant** (the wiring half; §6 carries the full dispatcher's lessons).
1. Fix the lie first (cheap): update the two guidance sites — assignments MAY delegate; returns
   drain within ~5 min.
2. Origin-join: `<echo-delegate>` records `{origin: focus|beat|autonomy-run id}` beside the seen-
   key; on drain, the result lands as **material on its origin** (focus accretion / beat target),
   not only a passive reading.
3. Envelope: the delegate prompt asks for `{found:[], not_found:[], sources:[]}`; drain validates;
   unparseable → the `[UNSATISFIED]` marker rides (the 895c2fc expect-vs-actual pattern).
4. Board row: `board.start({lane:'delegate', kind:'external', resource:null})` at dispatch,
   `finish` at drain — external work holds no local resource but is visible.

**Do NOT port**: agent trees (delegates spawning delegates); un-enveloped free-text returns
promoted straight into the record (let-it-in still marks provenance and grades at read time).

**Proof**: smoke for envelope validation + origin-join; live: delegate during a focus, watch the
result accrete to THAT dossier; "what are you doing?" lists the in-flight delegate.

---

### O4 ONE APPROVAL SURFACE — "what's waiting on me?"

**In the harness.** Plan mode: explore read-only → present ONE written plan → explicit approval →
act. The mechanic worth porting isn't the mode — Zoe already proposes everywhere — it's that
pending-approval work is **one queryable surface**, not five.

**Landing sites.** Propose→approve flows exist per-domain with different stores and gates: KG
proposals (`<echo-propose>`), the dedup/resolution queue (`list_resolution_proposals`), capability
gaps (`lib/gaps.js` return-proposals), rehearsal cards (R2, once O2 exists), packaged-doc
pointers. The sweep's verdict: no unified view. This is goal-2's disease ("what is running in
me?") recurring as "what is waiting on him?"

**The transplant.** A read-model ONLY — `lib/approvals.js` queries the existing stores (counts +
top item each; no new writes, no new store): one manifest section AWAITING LUCAS + the chat answer
to "what's waiting on me?". Approve verbs stay domain-specific. Deliberately small: this is the
board pattern (2a) applied to approvals, ~a day of work, and it makes every other propose-shaped
organ legible.

**Do NOT port**: a generic plan-object subsystem unifying the stores themselves (over-engineering;
the stores' semantics differ for reasons).

**Proof**: smoke on the aggregate query; live: "anything need my sign-off?" enumerates real rows
from ≥3 stores with counts that match the stores.

---

### O5 DOCUMENT SHAPES AS DATA + the artifact that checks itself

**In the harness.** Document creation is skills + **deterministic scripts**: the model writes
CONTENT (markdown), scripts render FORMAT (docx/pdf/pptx); the model never hand-writes OOXML. Two
disciplines ride along: format dispatch by *deliverable kind* ("must be a .docx" → that pack), and
**verify the ARTIFACT** — open what you produced; a deliverable you didn't re-open is a guess
(Zoe already paid for this: auto-memory `artifact-delivery-chain`).

**Landing sites.** `lib/packaging.js` is healthy and already harness-shaped: verb-gated command,
4 shapes in `studio/doc_shapes.js` (hardcoded), cloud `sectionize` with the ≥50% anti-drop guard
("reorganize, never rewrite" — keep this exactly), bounded `verifySources`, HTML→PDF into
`data/packaged/`, canvas pointer back. Gaps the sweep confirmed: shapes are code constants;
**"branded" and ".docx" are mutually exclusive** (`lib/md_to_docx.js` is a separate unbranded
export lane); nothing re-opens the artifact after render.

**The transplant.**
1. Shapes → rows (`doc_shapes` store: ordered sections, required flags, shape_words, brand ref).
   The four current shapes seed it; a NEW shape arrives as a proposal card, not a code edit.
   Registered on the skill shelf (O1, kind `shape`) so she can enumerate what she can produce.
2. Brand the docx lane: `md_to_docx` accepts the same shape+brand context packaging uses — one
   deliverable, three formats (html/pdf/docx), one look.
3. **Post-render self-check** (deterministic, in code): file exists + nonzero; PDF page count > 0;
   every required section present in the rendered output; every [dN]/link in the source appears in
   the render. Verdict line rides the completion announce; failure → the package DOESN'T announce
   success (report the miss instead).
4. She still writes markdown and STOPS — packaging remains Lucas's command. Unchanged.

**Do NOT port**: model-rendered HTML/OOXML; any sectionizer that summarizes (translator reshapes,
never compresses — the distiller line).

**Proof**: smoke: seeded md → all three formats, self-check green; a mutilated render (section
deleted) → self-check red and an honest announce. Live: next real `package that` logs
`[package-doc] self-check ok pages=N sections=M/M links=K/K`.

---

### O6 ADVERSARIAL VERIFY — one refuter before anything reaches Lucas

**In the harness.** Code review here is find → **try to refute** → only findings that survive
land, tagged CONFIRMED/PLAUSIBLE with a concrete failure scenario. The refuter is a separate
call whose prompt is to BREAK the claim, not to polish it.

**Why it works.** Generation and verification are different postures; a model asked to defend its
own diff won't find the input that kills it. Zoe has the fact-side version already (corroborate
move = independent second source; editor's two lanes). Code/claim artifacts lack it.

**Landing sites.** O2's proposal cards (diff + gate verdict); autonomy `build` artifacts;
packaging's cited papers (source-reachability exists; claim-level check is "the editor's lane").

**The transplant.** One bounded cloud call, N=1 (their pool is 2 slots — no fleets): input = the
diff + goal; prompt = "name the concrete input/state that makes this wrong; default to refuted if
uncertain"; output = `{verdict: survives|refuted, scenario}`. Rides the proposal card / artifact
as a labeled field. Advisory, never a gate (grading stays priority-not-gate, and the smoke gate
remains the only code oracle) — but a card that says "refuter: found a scenario" tells Lucas where
to look first.

**Do NOT port**: multi-agent verify panels; letting the refuter's verdict auto-block (that would
make an LLM an enforcement loop — determinism law).

**Proof**: smoke with a seeded bad diff (off-by-one) → refuter field populated; card renders both
gate verdict AND refuter verdict distinctly.

---

### O7 DIRECTIVES THAT ENFORCE — compile a rule to the choke point

**In the harness.** Two rule layers: prose instructions (CLAUDE.md — comprehension-enforced) and
**hooks** (deterministic code at fixed fire-points, configured as data, that inject context or
block an action regardless of what the model understood). The strong property: a hook cannot be
argued with, forgotten, or "outgrown."

**Landing sites.** `lib/directives.js` is the prose layer, shipped and correct (own table, always
rendered, no decay, provenance — the instruction-vs-belief fix). But every directive today is
comprehension-enforced. Zoe's mechanical rules (leakguard, unprompted_gate, thought_gate,
MAINTAIN forced-args) are hooks — hardcoded one by one. The primitive to generalize exists:
`maintainForcedArgs` merges forced args OVER model-written args at dispatch ("never prompt-hoped").

**The transplant.** An optional `enforce` column on directives: a small closed vocabulary, applied
in code at the two existing choke points —
- `deny_tag:<family>` / `require_attended:<family>` → checked in `echo_suit` dispatch;
- `force_arg:<tool>:<k>=<v>` → merged exactly like MAINTAIN_TOOLS;
- `deny_say:<pattern>` → checked in the say-render rail (where leakguard already stands).
A directive without `enforce` stays prose. Lucas's runtime feedback can now land as a rule that
BINDS ("never open substack unattended" becomes a dispatch check, not a hope). Detection stays
conservative (over-capture is the real risk — the file's own header).

**Do NOT port**: prompt-transcribed regex (detectors-vs-comprehension: a rule that matters is
enforced at dispatch, not narrated); free-form enforce strings (closed vocabulary only, each verb
smoke-tested).

**Proof**: smoke per enforce verb (esp. force_arg override of a model-written value); live: a
test directive with `deny_tag` provably blocking on the autonomous loop while prose-only
directives behave as today.

---

### O8 HISTORY BY HANDLE — compaction that addresses, never destroys

**In the harness.** When my context fills, older work leaves as a *summary that carries forward* —
but the crucial property is the originals stay addressable (files, transcripts) and I re-open them
at need. Summary + dereference, not summary instead of source.

**Landing sites.** Zoe's chat history is a hard turn window (turn-limit constants) — turns past it
just vanish from the prompt. But slice 1 built the missing halves: conversations are now durable
OBJECTS in doc_store (39c62d6), and `<recall ref="dN"/>` pulls a stored document (8a2964c).
The organ is one wire between them.

**The transplant.** At the window edge, aged-out turns are replaced by one line per conversation
window: `(earlier this session: <one-line gist> — recall ref=dN)` where dN is that window's
conversation object. The gist comes from the conversation-object row (already written at filing —
if it isn't, add it there, at write time, not at prompt time). She re-opens the full window by the
existing recall mechanic when the thread needs it.

**Do NOT port**: rolling rewrites of a single summary (the meeting-notes-ate-themselves failure);
distilling the aged turns through the local model at prompt time (translator, not distiller —
the gist is written ONCE at filing, content stays one pull away).

**Proof**: smoke: seeded 40-turn history → prompt contains the recent window + handle lines, and
a `<recall>` of a handle returns the aged turns verbatim. Live: "what did we talk about this
morning?" answered from a pulled conversation object, cited as such.

---

### O9 THEMES AS DATA — the smallest organ, listed for completeness

**In the harness.** Named theme objects (palette/fonts/spacing) applied across artifact types;
design-investment calibration loaded BEFORE building a visual; chart work reads a design contract
(palette + form rules) before the first line of chart code.

**Landing sites.** One house brand, imported everywhere from `studio/cert_template` — which is
correct: the brand is Rainey/Lucas's, fixed. `renderer/kg3d` had its own lesson (colour-space, not
layout). Chart emission has no pre-flight contract.

**The transplant (only if ever needed).** A `themes` row keyed by name with the house brand as the
sole seed, referenced (not copied) by packaging/docx/canvas render paths — so a second brand ever
arriving is a row, not a hunt through render code. Plus a 10-line deterministic chart contract
(palette constants + "label axes, no rainbow defaults") injected recipe-card-style when a chart
block is being emitted. Rank last; skip freely.

---

## 4. Rank order (leverage ÷ cost, this lane's read)

| Rank | Organ | Why here |
|---|---|---|
| **0** | O0 line of inquiry | The diagnosis organ (boot40: 0 model decisions vs ~800 code-picked moves). The others serve it: the shelf feeds its briefs, O2 is its code twin, O3's returns join it |
| A | O1 skill shelf | The existence-proof organ; fixes retrieval-is-the-bottleneck; O5 shapes and Echo recipes plug into it |
| B | O2 rehearsal driver | Completes the driver's-seat set; R2 proposal cards become real; the self-grow ladder gets its motor |
| C | O3 structured returns | Closes a live guidance-vs-wiring contradiction; small, mostly wiring |
| D | O4 approval surface | A day of work; makes every propose-shaped organ legible to Lucas |
| E | O5 doc shapes + self-check | Papers thread hardening; the docx/brand unification is user-visible |
| F | O6 adversarial verify | Rides O2's cards; one bounded call |
| G | O7 directive enforce | High trust value; needs the closed vocabulary designed carefully |
| H | O8 history handles | Slice-1 machinery makes it one wire; user-visible memory depth |
| I | O9 themes | Only if a second brand ever exists |

Suggested slicing when the time comes: **slice 4 = O0** (the inquiry substrate + continue-first
decision + audible deferrals — the slot-priority relaxation inside it is Lucas's explicit call),
**slice 5 = A+B** (shelf + driver — the crystallization write path meets its retrieval surface),
**slice 6 = C+D** (the legibility pair), **slice 7 = E+F** (deliverable hardening). G/H ride
along wherever they fit; each sub-slice gate-green + committed per the standing process.

## 5. Standing refusals (the context-model traps, in one place)

- Awareness assembled by hand into prompts → drift (proven 3×). Every organ's surface must be a
  queryable substrate rendered by code.
- A translator that compresses through a weaker model is a distiller. Reshape and address;
  never shrink content to fit (a cap defers, never disappears).
- A detector transcribed into a prompt is still a detector. Rules that matter compile to the
  choke point (O7); prompts carry the WHY.
- Fan-out is not their shape. Two allocatable cloud slots is a design fact; organs scale by
  parking and resuming, not by fleets.
- Nothing self-adopts except the substrates built for it (procedures' track records; approved
  recipe proposals). Program code crosses only through Lucas + gate + commit. R3 stance holds
  everywhere, forever.

---

## 6. Last dig — the dispatcher's lessons (how my fan-out comes home)

*Lucas's closing question for this catalog: the harness fans out to as many places as the
program does, yet the answers always land back in one coherent piece — what transfers? Five
mechanics. None of them are model intelligence; all of them are addressing discipline. Each
verified against the program 2026-07-22.*

**L1 — The return address is the QUESTION, not the program.** In this harness every fan-out
result returns into the exact context that formulated the question — the asker still holds WHY,
so integration is trivial and immediate. In Zoe, a delegated result returns to a GENERAL
surface: `_drainAgentInbox` banks it in meta + a monologue reading + a toast; the focus/beat/
tick that asked has died or moved on, so the manifest must NAG ("absorb it") — the answer became
an obligation. Adoption = O3's origin-join, stated as the principle: record `origin` at
dispatch; the drain delivers to that origin as material; only orphaned results fall back to a
reading. An inbox is where answers go to be forgotten.

**L2 — The envelope is defined at DISPATCH, not discovered at return.** Every subagent this
harness spawns is told at send time exactly what shape to reply in — and the shape is enforced
mechanically (a mis-shaped return is retried at the tool layer, invisibly to the caller).
`<echo-delegate>` sends a task string and scrapes whatever prose returns (`parseAgentInbox`).
Adoption: the dispatch template appends the envelope (`{found, not_found, sources, next}`) plus
the sentence that changes everything — *"your reply IS the return value, not a message to
Lucas"* — and the drain VALIDATES in code (2d's law: never prompt-hoped); unparseable →
`[UNSATISFIED]` rides to the origin.

**L3 — Every fan-out NAMES its join.** However many agents run here, exactly ONE context reads
all the returns before anything is written — the synthesis point is designated before the
fan-out starts. The program's swarm has an allocator (`partitionRoster`/`planSwarmSlots`) and
release conditions — but `releaseSwarm` (main.js:9608) FREES the workers; nothing reads the
parts together and writes the one artifact; findings just accrue wherever they landed.
Adoption: a swarm/parallel run carries `join: {origin, artifact}` from the start; release
triggers one synthesis pass (cloud, pool slot) that reads the parts and writes the named
artifact. A fan-out without a named join is a scatter.

**L4 — Errors are RESULTS; route them to the reader of successes.** A failed delegate here
arrives in-band — same channel, labeled, with the failure text — and the caller decides (retry
with the failure quoted, reroute, drop). In Zoe, failures fork OFF the result channel: lanes
catch → `console.error` (a channel no model reads), and the board writes `status='failed'` rows
that nothing anywhere queries (`board.running()`/`manifestLines` render running only — verified:
no consumer of failed exists). The decider cannot see "graph-walk failed 6× tonight." Adoption:
(a) the manifest gains RECENT FAILURES (counts + last note per lane, read from the failed rows
the board already writes — a read-model, one query); (b) a failed delegated run returns THROUGH
the drain with its error as the payload. 44f8052 generalized: every failure teaches, in the
channel where the next decision is made.

**L5 — Returns are GIST + HANDLES; partials land as they go.** The sweep agent for this very
catalog read ~185k tokens of this repo and returned ~4k — but every claim carried file:line, so
the caller could dereference at need. Summarize AND address: the [dN] law at the agent level —
a return that only summarizes is a distiller. Zoe's inbox items already carry `canvasTab`
(a handle): keep it and make it mandatory — no return without a pointer to its full material.
And because partial work must be real work, long runs write back per touch (O0) so a death
loses a step, never the run.

*The through-line: the question keeps custody of its answer. That is the entire trick of
"streams back in so perfectly" — not smarter models, but an address on every result, an
envelope on every dispatch, a named join on every fan-out, failures in the same mailbox, and a
handle on every summary.*

---

## 7. The needs lens (Lucas, 2026-07-23) — the program re-read against what it is FOR

His words (saved verbatim in auto-memory `how-lucas-works`): brainstorming and tangents are
normal — *"the help I need is taking all of it and pulling real materials out of it"*; connect
the dots and tell the bigger story; *forecast into the future* with the interconnected thought;
*better smarter reports*; *learning conversations where the AI is actively searching and growing
as we talk*; the program *taking better care of its own memory and dedicating resources in a
logical and organized way*.

**The one diagnosis, across all six needs: the program is magnificent at TAKING IN and KEEPING,
and thin at PULLING OUT and HANDING BACK.** Intake ≫ harvest, storage ≫ synthesis, record ≫
return. Each need, measured:

| Need | Strongest today | The gap | Serves it |
|---|---|---|---|
| N1 brainstorm → materials | The riff is protected (`lib/brainstorm.js` explicit-commit + muse detection); conversations become durable objects; `lib/track.js` answers deliverable queries — for DIRECTED runs | Nothing HARVESTS a filed conversation. Tangents are gated as noise in the room and then never mined in the record; the transcript is kept, the YIELD isn't | **O0.h below** + O5 |
| N2 dots → bigger story | The deepest machinery in the program (KG, fusion gate, corroboration, wells, temporal substrate) | The BRIDGES: ST↔LT joined by 1 edge, 67.5k isolated nodes, zero org research lane, contacts trapped short-term — dots connect within silos, and the bigger story lives on bridges. And nothing WALKS a subgraph and writes its story | bridge defects (memory index) · O0 inquiries close WITH a story artifact · O5 |
| N3 forecast from thought | The election vertical is genuinely strong (435+35 chain, Brier 0.115) | The graph→forecast wire is thin: encounters/events don't feed features; scenario engine designed, not built; a general "what happens next on X" has no path | O0 (forecast-shaped inquiry closes) · scenario engine |
| N4 smarter reports | packaging + brand + source-reachability + the editor's two lanes | A report REORGANIZES a markdown doc; it never QUERIES the graph (corroboration status, timeline, opposing sources) — the "smarter" half is N2's synthesis gap wearing a suit | O5 + O6 + N2 |
| N5 learning conversations | Turn retrieval ladder; mentions land in the graph DURING chat; brainstorm pulls one grounded bit into the riff | Mid-chat search is crammed into turn latency (operator 4 steps/45s); she cannot fork a dig and keep talking; what she learns rarely loops back into talk | **MID-CONVERSATION DIG below** |
| N6 memory self-care + logical resources | Passes, dedup lanes, decay, the board, the maintain move | Resources are dedicated by TIMERS, not value (boot40: ~800 code-picked moves, 0 reasoned choices); failures invisible (§6 L4); 24.6k dedup stalled; .gov promotion starved | O0 conductor + L4 + maintain expansion |

### O0.h — CONVERSATION HARVEST (new sub-organ of O0; the need he named)

Ride the EXISTING nightly conversation promote: each filed window gets one structured pass →
MATERIALS, each with a [dN] handle back to the window: inquiry leads (→ O0, `born_from:
conversation`), report seeds (→ tracks/canvas), decisions and instructions (→ directives,
conservative detection — its header's over-capture warning stands), factual claims (→ the
existing decompose/encounter path). The anti-tangent gates stay exactly as they are — they
protect the ROOM; the harvest runs later, on the OBJECT. The rule in one line: **a tangent is
feedstock, not noise — gate it in the room, mine it in the record.** Proof: a rambling evening
session yields, by morning, 2-3 named materials on the board ("from last night: lead X, seed Y")
— each traceable to the minute it was said.

### MID-CONVERSATION DIG (new; unlocked by his 2026-07-23 concurrency ruling)

The ruling (recorded in `program-not-context`): ≤3 DISTINCT models in flight; same-model
concurrency unbounded. That dissolves the old constraint that made mid-chat search cram into
turn latency. The organ: a chat turn may FORK a bounded same-model dig — mechanically an O0
inquiry touch with `origin = this conversation` — while the reply goes out on the reserved slot.
The return lands minutes later through the open-question/engage surface, addressed to the
conversation object (§6 L1): *"about the X you asked — here's what I found."* This is N5 whole:
she keeps talking AND goes looking, and the finding comes home to the talk that asked. The
ruling also answers O0's flagged slot-priority call — his focus, her inquiry, and chat may
coexist.

**Needs re-rank:** O0 + O0.h serve N1/N2/N3/N5/N6 — rank 0 confirmed, harvest joins slice 4;
MID-DIG = slice 4b (needs O0's origin machinery); O5 rises for N4; the shelf stays
infrastructure for all. The catalog's engineering ranks (§4) stand; this section is the
tiebreaker whenever they conflict: **the needs list wins.**

---

## 8. Status ledger — the full transplant map, verified live (2026-07-29 review)

Method: BUILT is not the bar — WIRED and FIRING are. Every verdict below is evidence-backed
(code caller + boot-log firing count or DB state), from the 4-agent program review + the live
repairs of 2026-07-29 (boots 97–105). "Quiet" = on-demand organ with no recent trigger; "dark"
= zero firings ever, wire unproven.

### Existing (transplanted + verified)

| Organ | Verdict | Evidence |
|---|---|---|
| Board + resource locks (§1) | LIVE | rows per inquiry touch / rehearse / dig / promote; RECENT FAILURES reads failed rows |
| Procedures + crystallization (§1) | LIVE, COMPOUNDING | "procedure reinforced #53" (was #13 on 07-23); constraints land from NOT-mets |
| MAINTAIN allowlist + forced args (§1) | SHIPPED-BUT-UNCHOSEN | move exists; `chose=maintain` = 0 across boots 94/96 — decider never prefers it |
| Self-source / self_test (§1) | QUIET (on-demand) | no recent invocations; code path intact |
| Rehearsal sandbox R1 (§1) | LIVE-PENDING | consumer (O2 driver) unblocked 2026-07-29; first real run still owed |
| Directives prose layer (§1) | LIVE | always rendered; enforce half is O7 (not built) |
| [dN] dereference (§1) | LIVE (d-half) | coord-half was DEAD (unexported resolveCoord) — fixed 86d7985; first live coord deref still owed |
| Inbox drain (§1) | LIVE, QUIET | drains when delegates return; origin-join still missing (O3) |
| echo-guide pack (§1) | QUIET (on-demand) | the O1 generalization exists (skill_pull) but has never fired |
| O0 line of inquiry | ⭐LIVE, DOMINANT | `chose=advance-inquiry` is the top move (26 of 49); touches 13→35 on one inquiry; expect MET fires |
| O0.h conversation harvest | LIVE | 169 conversations promoted; bank turns over daily (verified in DB — the "starved" read was a severed-log artifact) |
| Mid-conversation dig | DARK | zero `<dig>` emissions ever — model never reaches for it; needs prompt-side surfacing review |
| O1 skill shelf | HALF-LIVE | shelf syncs (6 flows); pull + births + chat trigger-lines: zero firings |
| O2 rehearsal driver | UNBLOCKED 2026-07-29 | 14 `chose=rehearse` across two boots = real demand; 18/18 died on the slug (fixed 2ad33b0); first live iteration owed |
| §6 L4 failures-visible | LIVE (manifest half) | RECENT FAILURES section ships; failures-through-the-drain half missing |
| Beat/puller IDLE TIER (new, 2026-07-29) | LIVE, PROVEN | both burners defer audibly; `idle-defer: her-work-in-flight` on boot105 first tick |

### Pending (catalogued, not built) — rank order stands

| Organ | State | Next move |
|---|---|---|
| O3 structured returns | BUILT (98ecf2b, 2026-07-30) | live proof pending: delegate during a focus → result accretes to THAT thread; board row visible in-flight |
| O4 approval surface | BUILT (lib/approvals.js, 2026-07-30) | read-model + AWAITING-LUCAS manifest section + chat detector; live proof pending: "anything need my sign-off?" with real pending rows (all queues were honestly empty at build time) |
| O5 doc shapes + self-check | NOT BUILT | shapes→rows, branded docx, post-render self-check |
| O6 adversarial verify | NOT BUILT | rides O2's proposal cards — sequenced behind the first real rehearsal run |
| O7 directive enforce | NOT BUILT | closed verb vocabulary compiled to echo_suit dispatch; primitive proven (maintainForcedArgs) |
| O8 history handles | NOT BUILT | one wire: aged-out turns → `(earlier: gist — recall ref=dN)` |
| O9 themes | SKIP | unchanged — only if a second brand exists |
| §6 L3 named join | NOT ADOPTED | releaseSwarm still frees without a synthesis pass |
| graph_integrity scheduling | DARK | beats exist, smoke-proven, zero scheduled callers; now inherits the idle tier for free |

### Newly identified (the 07-22 catalog predates these harness organs)

**O10 — TOOL-SCHEMA PROGRESSIVE DISCLOSURE.** The harness now keeps most tool schemas OUT of
context entirely (deferred tools + a ToolSearch that loads schemas on demand by query). Zoe's
suit mounts all 551 tool docs into the operator surface — part of why `[package] fit` sits at
9–14%. This is O1's trick (trigger surface small, bodies out of context) applied to TOOLS: a
compact tool INDEX rides every prompt; full schemas load per-turn on request. Direct attack on
the engine-starvation finding — rank it with A.

> **MEASURED 2026-07-30 — the premise above is STALE; O10 is effectively DONE.** The 551-doc
> mount is not current reality: the suit context block is capped (guide 1400 + atlas 1200 +
> recipe menu), `routeNeed` already discloses progressively (catalog filtered to ~20 by the
> need → cloud picks ONE → that tool's schema alone is fetched for the args pass), `<echo-find>`
> filters the same way, and the local operator's TOOL_SPEC is a curated ~10.8k-char spec of
> ~15 named tools, not a dump. The engine-starvation number (`fit` 9–14%) means the cloud
> package UNDER-fills its budget — the lever is PACKAGE RICHNESS (the roadmap/retrieval-ladder
> lane, docs/CLOUD_PACKAGE design), not tool-doc dieting. Do not spend here again.

**O11 — CONDITION WATCHERS.** The harness arms background watchers ("notify when this log line /
condition appears") that re-invoke the agent with the event; used all through this review's
boot-verification loop. Zoe's watchdogs RECOVER; nothing lets her ARM a watcher on a condition
and be woken by it (heartbeat polls instead). Natural fit: inquiry next_steps of the form
"when X lands, do Y" — currently impossible. Rank ~C.

Not new (already covered): structured-output-at-tool-layer = O3 · compaction handles = O8 ·
plan/permission surface = O4 · worktree isolation = R1 · subagent fan-out lessons = §6 ·
scheduled wakeups ≈ reawaken/commitments (adequate today).

### Addendum 2026-07-30 — the self-improvement arc (verified live, boot136)

| Organ | Verdict | Evidence |
|---|---|---|
| O11 watching-half: **self_watch + obs bus** (440e338) | LIVE, PROVEN | console hooked at source; caught a real stderr anomaly + a quick_lookup schema defect in its first minutes; recurring anomaly (3x/24h) mints a capability need (≤2 open watch-born, similarFloor 0.75). The WAKE-half (arm a watcher, be woken) remains open |
| Research-first rehearsal: `study` field (863e5f9) | BUILT, spec-pinned | rides every edit pick + the proposal card; smoke pins the prompt text ("reading material ONLY — nothing you found ever executes"). Reaches operator-path opens only; need-born opens still owed the step |
| Subc spawn guard: one open self-directed thread (e9da1c2) | LIVE, PROVEN 6× | paraphrase evasion measured (~0.3 overlap vs 0.6 gate, 3 threads for one tension) → behavioral throttle; `[subc] research deferred` firing repeatedly; dupes merged non-destructively |
| Heartbeat window-fit (31a6c59) | LIVE, PROVEN | `[fit] heartbeat` trimming history-first every heavy tick; system head untouched |
| Obs interface hooks (docs/OBS_INTERFACE_HOOKS.md) | CONTRACT SHIPPED | 'obs:event' broadcast + 'obs:recent' poll + WAL table; the visual-log UI is a parallel lane's build |

**Fresh me-as-baseline gaps identified 2026-07-30** (not in the 07-22 catalog): the
**fetched-content instruction firewall** (observed text is DATA, never commands — the harness's
instruction-source boundary has no Zoe port; directive-shaped lines in fetched web/doc content
can today land as instruction or belief) and **multi-action operator steps** (the harness batches
independent tool calls in one response; her operator is one-JSON-action-per-step — batching
independent TOOL actions per step halves model round-trips without violating the no-model-fleets
refusal). Both packaged in docs/BUILD_PLAN_2026-07-30.md Phase 2.
