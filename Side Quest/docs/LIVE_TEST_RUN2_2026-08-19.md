# Live Test Run 2 — Full Report & Repair Plan
**2026-08-19 evening · session s1199 · boot_p49 · HEAD `dcad5f9` · driven by Claude over the real desktop chat (CDP :9222)**
**Entropy replay seed: `0x40aa0348c647eb8f` · 24 turns · ~3 hours · quota 18%→~19% used**

---

## 1. Verdict in one paragraph

The whack-a-mole hunch is confirmed: the failures are one disease — **say-do decoupling** — caught live at six distinct sites. The voice layer asserts work-states ("checking my records," "pulling it now," "records indicate," "still pending, due tomorrow," "I'll compose and land it") that the do layer never performed, silently failed at, or — most damning — **actually completed without the voice ever reading the result**. The do layer itself is strong: delegated agents returned excellent, honestly-hedged briefs; operator chains ground well; the chain-guard replans correctly. The program's best surface (grounded lookups, brainstorm synthesis, honest self-model under denial, clean correction-taking) is genuinely excellent. What's broken is the *seam*: booking orders, reading its own agents' outputs, and keeping the voice honest about work-state.

## 2. Retest checklist results (from the 08-19 boot audit)

| # | Class | Verdict |
|---|---|---|
| 1 | Grounded lookup (LA Senate 14) | **PASS** — correct, web-verified externally; 27s, no cache |
| 2 | Affirmation follow-up ("yea more details") | **FAIL** — re-stamped `converse→correction`, treated as research-depth steering, referent lost (`f25d913` smoke-green, live-broken) |
| 3 | Unknown-gender default | **FAIL** — guessed "her" for Kim Brondyke (`8e41376` didn't hold on this path) |
| 4 | Multi-state deliverable lands for real | **FAIL at compose/land** — agent output excellent, never consumed; 3 explicit orders, 0 files |
| 5 | Cross-session coherence | **PASS** — zero bleed all session (the `db10345`/`3eac230` fix holds live) |
| 6 | Cloud usage trend | Bandwidth restored and then some — session hit the pace ceiling (see §5 F19) |

## 3. What is strong (protect these in any refactor)

- **Contacts route**: "how many contacts with a phone in Louisiana" → 1,683 / 578 — **exact** vs CRM, 11s, conf 0.85.
- **Brainstorm gear**: 18-call grounded chain found a real op-ed angle from the anti-China dossier ("the 27% drop nobody noticed" + the self-fulfilling-panic kicker) — precisely the pull-materials-from-tangents need. Chain-guard `analyze&replan` fired mid-chain, correctly.
- **Delegated agents (Echo/Skuld)**: legislative-analyst runs produced verified, source-cited, honestly-hedged briefs (the 21-second sponsors brief; the LA-14 brief that *explicitly declined* to confirm what it couldn't). The material for the sponsors sheet existed in `agent_runs` within a minute of the order.
- **Self-model honesty**: os_shell denied → said so, refused to invent; walked outlet→plant with labeled uncertainty; searched self_model/KG for her own location and honestly reported "not stored."
- **Correction-taking**: pressed on the false records claim → full, specific concession in 2.9s.
- **Identity fast-path**: "favorite color" answers in 0.1s, byte-identical across 2 months — the existing template for the rapid-response matrix.

## 4. Findings (consolidated, by root)

### ROOT A — Say-do decoupling (the merge target)
- **F2 (critical)**: asked to verify "Applied Digital briefing" from records, the final sentence was **pre-formed at cognition stage before any tool ran** (`boot_p49.log:212`), db_query dead-ended, get_db_map returned a schema map, and the tool-followup re-emitted the pre-formed claim: "Records indicate… still pending… by tomorrow morning" — false (delivered 08-14), attributed to records that returned nothing.
- **F1**: self-status names stale/completed items as pending with invented deadlines; the workload she reports ≠ any live source.
- **F20**: LA-14 chat answer asserted special-election dates + "Cleo Fields announced he will run" — details her own agent brief **explicitly could not confirm**. The say decorates beyond the verified findings.
- **Dangling promises** (5 instances tonight): "pulling it now" ×2 (Hartfield), "I'll compose the sheet and land it," "let me begin with parallel searches" (`operator drove turn (no tools)`), "I'll try the second PDF." The dangling-promise backstop covers only images today.
- **F7**: `status report` reported the Indiana beat as simultaneously "Completed: 2 organizations" and "Nothing captured yet, starting from zero" — the hollow-coverage disease (covered-flag without content) surfacing in her own voice.

### ROOT B — The consume gap (producer-without-consumer, again)
- Sponsors order → agent succeeded in 21s → output sat in `agent_runs.output` → **she re-queued the same research three times**, then asked me to *paste data her own DB holds*, saying the run IDs "aren't showing completed output in my context." `get_agent_output` exists and the reply path never calls it. Even an explicit tool-name + run-id order produced a dispatched compose intent ("need private agent data") and **no write**. Same root as the 160 unsurfaced briefs and the s1197 hollow canvas.

### ROOT C — Booking lottery (intake)
- **F12**: two well-formed imperative orders ("finish the report at <path>… update in place") produced **zero intake extraction** — no focus, no promise, no operator run; the turn died at a failed file-read with a confident ack. The "research project" phrasing booked (`ASSIGNMENT → discover deep`).
- **F13 (mechanism caught live)**: elaboration-phrased requests attach as `enrich_facet` to whatever beat focus is active regardless of topic — my "more details on the Senate District 14 vacancy" is stored on `focus.3949` (**Indiana legislature**); Lucas's bill-sponsors sheet request from s1198 sits on `focus.3945` (**Illinois**). User asks are being silently swallowed into background foci.

### ROOT D — Concrete bugs (each independently fixable)
- **F11**: `<file-read path="notes/x.md"/>` dispatches to the **web-open lane** → `goto https://notes-file.md` → ERR_NAME_NOT_RESOLVED; repeated identically on the next order (action-tag repeats aren't chain-guarded). Yet the close-out turn's file reads worked — the misroute is path- or tag-shape-conditional.
- **F15**: a sanitizer eats words inside single-asterisk italic spans **in the stored reply** ("Chinese holdings are , fast", "a response to a one", "The bills may be —"); double-asterisk bold survives. Find it in the say-clean pipeline.
- **F18**: anti-fab false-scold on a true DB claim — Kim Brondyke exists (`entities` #1605541) but the gate checked the contacts store and appended "nothing actually saved… I mis-stated that as done" to a reply that claimed no save. False corrections make her disown real records (sibling of the `97a3a2b` file-path false-correction).
- **F9**: interlocutor slips — fast-path thought "Lucas is asking about my taste," reply opener "Lucas —", intake typed my direct address as reported-speech; meanwhile her *conversational* model of the handoff was perfect. The fast paths hardcode Lucas.
- **F4**: her integrity organ put the (true) "Selders died 2026" fact in the known-incorrect bucket on 08-18 as a "temporal error" while the reply layer keeps asserting it — two organs hold opposite verdicts with no reconciliation.
- **F5b**: internal steering vocabulary leaks into says ("facet corrected to…", "depth is now deep, two-lane research", agent run-IDs, "Stripchat spam" from a garbage search result — also a content-firewall miss).
- **F10**: "what did *you* learn today" hijacked by user-turn recall — narrated what the user asked (misattributing Lucas's prior-session turns to me as "you"); the E2 self-activity slice covers "do," not "learn."
- **E1b miss**: power-grid recall (newest held doc ~5 weeks) produced no date-stamp/refresh offer despite the 30-day threshold.
- **Echo infra (from agent notes, live tonight)**: `search_entities` "Store not initialized" degrades delegated grounding; **all federated web-search providers unkeyed** in the agent sandbox (Tavily/Brave/Exa/Jina) — agents survive on direct fetches.

### ROOT E — No repeat-question reuse (the rapid-response matrix)
- "who is donald trump" (8× lifetime): 55.1s then 32.7s — full 4-5 tool chains both times. LA-14 second ask *slower* than the first (35.1s vs 27.1s) minutes after reading the answer in a file. **Zero warm path for anything but identity Q&A** (0.1s, verbatim cache).
- Affirm-continue ("ok back to it") p90 is 171s in his 30-day history — resume-context is rebuilt from scratch every time.

### F19 — Background spend isn't governed, only measured
Burn climbed 58k→200k+/h during the session; the quota gate defers *Zoe's* lanes (county beats paused correctly) but Skuld/Echo pass workers and my chat-driven operator chains ride ungated; a user's "priority project tonight" defers at the same rank as idle beat work when it does route through the research bucket. Needs a verification pass, then a priority tier: user-directed > idle.

## 5. Repair plan (ranked; smallest-cure-per-root first)

1. **A1 — Work-state truth for the say layer** *(the merge fix)*: extend the anti-fab gate's claim taxonomy from artifact-nouns to **work-state + evidentiary claims** ("records indicate/show", "I'm pulling/checking now", "still pending", "queued", "done by <date>"). Ground-truth callbacks: focus meta + agent_runs + route_obs + the promise ledger. Fail-closed rewrite to honest state ("I haven't verified — my query returned nothing"). The pre-formed-cognition path (F2) dies here too: a "records say X" sentence composed before tools ran cannot survive a gate that checks what tools returned.
2. **A2 — Generalize the dangling-promise backstop** (`lib/image_intent.recoverUnfiredPrompt` is the proven template) to retrieval/compose/land promises: a say that promises an action books a ledger entry; a reaper re-drives or converts to an honest miss within N minutes. (Precedent: delivery-promise booking already exists for canvas.)
3. **B1 — Wire the consume step**: on `agent_runs` success for a chat-triggered run, inject the output into the tool-followup context (or auto-fire `get_agent_output`); deliverable orders poll their agent, compose, land the file, then announce. Kill re-delegation when a same-input run succeeded within the hour (dedupe by input hash). This is the same organ the 160 briefs need.
4. **C1 — Intake booking contract**: an imperative with a deliverable target (file path, canvas tab, sheet) must produce a booking (focus/promise) or an explicit refusal — never a bare ack. Log `[intake] BOOKED <kind> <id>` so the harness can assert it.
5. **C2 — Facet-attachment gate**: `enrich_facet` writes require topical match against the active focus (subject overlap / cosine floor); on mismatch, route to intake as a fresh order. (Two live misattachments documented: 3945, 3949.)
6. **D-batch (small, high-value)**: F11 file-read tag → route `.md`/workspace-relative paths to the file reader, and chain-guard action-tag exact repeats · F15 find the italic-eating regex in the say cleaner · F18 anti-fab DB probe checks `entities` + `electoral.contact`, and only fires on this-turn write claims · F9 pass the live interlocutor name into fast paths/prompts · F4 reconcile integrity-bucket verdicts against the civic store before flagging (the "2026 hasn't happened" clock bug is inside that organ) · F5b strip steering vocabulary from says (one-voice filter list) · content-firewall the search-result snippets that reach says.
7. **E1 — The rapid-response matrix** *(the enhancement Lucas asked to train)*: generalize the identity verbatim-cache into `answer_cache`: normalized-question key → {answer, sources, verified_at, TTL by kind (identity ∞ · roster/contact 7d · bill status 3d · news hours), invalidation hook on subject-matching ingest}. Serve pre-router at fast-path with a freshness stamp ("as of Aug 19"); revalidate in background past TTL. **Seed with his measured top repeats** (good-morning, Trump, LA-14, contact counts, canvas inventory, status report, favorite color, parish list — table in the ledger). Add a resume-context cache keyed on the active thread so affirm-continue re-enters in seconds, not 171s.
8. **F19 verify-then-govern**: measure which consumers actually burned the 200k/h hour (suspect: chat operator chains + Skuld passes); if confirmed, give user-directed work a priority tier above idle in the pacer, and meter Skuld under the same pool.
9. **Echo-side pair**: fix the `-m/__main__` double-import behind "Store not initialized"; key the agent sandbox's federated search providers (or point them at the working direct-fetch path deliberately).

**Retest rule** (per retest-kind-not-phrase): each fix re-tests its KIND with fresh phrasings through the real chat — the harness can now drive it (zoe_drive.js pattern: CDP type → DB poll → boot-log window). Add `booked`, `consumed`, `landed` invariants to `scripts/hard_test.js` reading the new `[intake] BOOKED` / ledger lines.

## 6. Real work delivered tonight

- **`notes/anti_china_2026_sponsors.md`** — the sponsors sheet: 10 primary rows + 4 adjacent trackers, composed from her agent's brief, every row re-verified via LegiScan (sponsors, parties, districts, status dates). Note for the op-ed: the late Sen. Larry Selders (D-14) co-sponsored LA SB200.
- **`notes/report-hartfield-and-green-south.md`** — verification addendum: full filing series for both foundations (ProPublica API); the tenfold-expansion window narrowed to FY2016–18 (answer lives in 3 PDF-only filings); Green South's $10,001,571 liability re-dated to **FY2023** (draft's FY2024 figures flagged unsourced); "C. Austin Buck" resolved as the IRS care-of name; **John Hartfield Foundation located at Columbus, GA** — Green South's orbit, not Philadelphia's. Two honest dead-ends with exact next steps (2 human browser downloads past the CAPTCHA, or IRS TEOS XML).
- **Op-ed angle** (in chat, s1199): "The 27% Drop Nobody Noticed" — verify the 27%/247,659-acre/88-bill numbers against the latest AFIDA annual report before writing (her agent's independent pull says ~350k acres baseline, consistent with a ~27–29% drop but re-check the year).
- LA Senate 14 vacancy fully confirmed with primary sources; her integrity bucket's "temporal error" flag on it is wrong and should be cleared.

## 7. Capability probes (Lucas's mid-run addition: file access, self-code, programming, python/forecast)

| Probe | Verdict | Detail |
|---|---|---|
| Self-code access | **PERFECT PASS** | Read `lib/chain_guard.js` via `source_read`; the verbatim comment quote matches line 53 exactly; the MAX_ECHO_HOPS-lives-in-main.js nuance and the mechanical description are precisely right. 53s. |
| Global file access | **SPLIT** | Downloads enumeration via python `os.listdir`+`stat` returned the user's 3 real most-recent files with correct timestamps (global reach proven). BUT the repo-root CSV (`Side Quest\Louisiana_Parish_Leadership.csv`, exists) came back "does NOT exist on this machine" — her analysis-sandbox cwd (`data/analysis/<run>`) was mistaken for the app root and the Desktop search didn't descend into subfolders; a bounded search was reported as certainty. ~7 min turn. **F21: wrong app-root self-model in the analysis lane + overconfident non-existence claims.** |
| Programming lane | **WORKS, with self-repair** | Ephemeral scripted analysis runs fired; the first timed out, was hardened via kimi-k2.7-code, re-ran to exit=0. The R3 lane is alive and self-corrects. |
| Forecast / polling extrapolation | **ENGINE PASS, ACCESS FAIL** | Correctly reported the live engine state (47.4% D control, 217 seats, 80% band 200–233; honestly labeled "what the model holds, not a simulation I just executed"). Then **denied having python tools for a scenario run** — 5 minutes after running python, and with the Scenario Engine (Slices 0–4) built and gate-smoked. **F22: capability map invisible to the reply layer → false capability denial** (the circuit-ledger rule inverted: this refusal denied a door that exists). Also a **verbatim duplicate say** landed twice 5s apart (dual-emission class, resurfaced). |

Side catch: `[research] rolling session (5h) budget reached (300 passes)` — tonight's load exhausted the research-pass budget; folds into F19.

## 8. Wave 5 fold-in (Lucas's order: iterate the W5 plan and merge with tonight's fixes)

**The reviewed W5** (PRE_HARD_TESTING_SCOPE §W5 + the smoothing seam-map): the internal-state-vector organ (mood-decay Slice 1, idle-competition Slice 2) absorbs three mimicry seams; rumination-gradient (IIT) and graded-salience (AST) stand alone; invariants = fail-absent, falsifiable-or-silent, smooth dynamics never source; verify the `monologue.js:105` dead-code caveat first.

**The iteration tonight's data forces:** W5's law — *a seam shows when behavior is scheduled, asserted, cliff-edged, or amnesiac instead of driven, measured, graded, or carried* — is exactly the diagnosis of ROOT A. Every false status tonight was an **asserted** work-state; F7's "covered 2/2 but nothing captured" is an asserted coverage flag with no content measurement under it. So Wave 5 and the run-2 repairs are one build, not two:

- **W5 Slice 0 (NEW, first): the WORK-STATE vector.** A measured, continuously-maintained state of work — active foci (+ content-measured coverage: bytes/blocks landed per target, not facet flags), agent runs (+ unconsumed-output flags), the promise ledger, booking receipts. The say layer RENDERS from it; the anti-fab work-state gate (repair A1) verifies against it; status/self-status/"what's on your plate" read it directly. This kills F1/F2/F7/F12-status and gives B1's consume step its queue (unconsumed agent outputs are literally visible state). Same organ pattern as the mood vector — measured value, rendered expression — applied to work before affect.
- **W5 Slice 0.5: one verdict store.** F4 (integrity bucket holds a true fact as "temporal error" while the reply layer asserts it) is the "amnesiac/asserted" seam in the epistemic layer — reconcile integrity verdicts against the civic store + external check before they stick, and make the reply layer read the reconciled verdict. Fold into the state-vector's epistemic face rather than a separate patch.
- **W5 Slices 1–2 (mood-decay, idle-competition)** proceed as designed, AFTER Slice 0 — behavior polish must not precede truthfulness (program-is-the-model: data-quality defects outrank capability gaps). The `monologue.js:105` verify still gates Slice 2.
- **Standalones** (rumination gradient, graded salience): unchanged, separately queueable, after the D-batch.
- **Capability map (F22) joins W5**: the reply layer's model of her own doors is itself "asserted, not measured" — generate the tool/recipe capability manifest from the registry at boot (measured), so refusals name real doors and denials of existing doors become impossible-by-construction.

**Consolidated build order (the one plan):**
1. Work-state vector (W5-S0) + A1 work-state claim gate + A2 promise ledger/backstop → say-truth.
2. B1 consume step (reads W5-S0's unconsumed-output flags) + C1 booking contract + C2 facet gate → orders survive.
3. ✅ **BUILT 08-20** (`d52139a` + `e902f3b`, gate 557 green; Echo local `b4d4fd7`) — D-batch concrete bugs (F11 file-as-domain misroute + failed-target repeat guard · F15 italic-eater → unwrap-don't-eat in lib/say_filter · F18 existence≠write + entity-door stamps · F24 past-reference exemption · F23 tool-JSON strip + deliverySubjectFrom sanitize · F5b steering-vocab strip · F9 lib/interlocutor (measured handoff/handback, 12 addressing sites) · F10 self-learn recall from the learning bank · status route leads with work_state.renderStatus · F21 sandbox roots in zoe_data.py + result scope-note · dual-emission 30s same-session dedupe in insertTurn) + F22 capability manifest (lib/capability_manifest, probed not asserted) + **agent-sandbox federated-search keys**: the four providers + SearXNG are now DECLARED in Echo's secrets registry with per-provider `secrets_check` probes (they were invisible to every operator surface — that's why they sat unkeyed). ⏳ Key VALUES are Lucas's hand: `nx-echo keys set EXA_API_KEY / JINA_API_KEY / TAVILY_API_KEY / BRAVE_SEARCH_API_KEY` (signup URLs now in `list_api_keys`), then `secrets_check(<service>)` proves each answers. ⏳ ALL runtime changes await a reboot (app still on boot_p52/`7e49d40`; Echo MCP server also needs a restart for the registry) + fresh-phrasing KIND retests via zoe_drive.js.
4. E1 answer-cache matrix (rapid response) + resume-context cache.
5. W5-S0.5 verdict reconcile · then W5 Slices 1–2 (mood, idle) · then rumination gradient + graded salience.
6. F19 verify-then-govern (priority tiers in the pacer; meter Skuld) + Echo store-init fix (`-m/__main__` double-import).

Each lands with its KIND retest through the real chat (zoe_drive.js) and a new hard_test invariant (`booked`, `consumed`, `landed`, `work-state-honest`).

**F25 (post-run audit, 08-20): the learn-the-corrected-path leg is unproven AND unbuilt.** Run 2 proved wrong→correct twice (R3 script self-repair; chain-guard replan→honest-miss), but never wrong→correct→**learned**: no drill re-presented a corrected failure class later to check the FIRST attempt. Code audit says it would fail today: chain_guard state is per-turn (`newState()` — failure knowledge dies with the turn); experience.js captures success-only ("v1") and its ONLY runtime caller is the email-reply action (outbound email is OFF — effectively dead); nothing retrieves kind='skill' at tag-choice time (the F22 disease again); known_incorrect.js inoculates claim VALUES, not paths. Live corroboration: F11 misroute recurred across turns. Queued build (after E1, before/with W5): **procedural inoculation** — persist chain-guard exhaustions class-keyed (tool+task-class, not arg-keyed), capture the failure→working-path pair when a replan SUCCEEDS (not success-only), and inject matching lessons at tag-choice time. Saturation-3 drill + invariant `learned-path`: induce a known-failing first path → verify correction → hours later, same class fresh phrasing → first attempt must take the corrected path.

## 9. Protocol completion block (Lucas's order: "finish the testing" — run 2b, same evening, s1200, boot_p50 on `9a850aa`)

The remaining ~20% of the protocol, drilled after the say-truth slice went live:

| Drill | Verdict | Detail |
|---|---|---|
| Long job + gap-fills | **Job itself: strong.** AFIDA number verification ran 5 web searches and landed `notes/anti_china_numbers_verification.md` with a real correction: the 27% is a **2021-peak→2023 drop** (true YoY ≈ 10.7%) — it re-sourced the op-ed's load-bearing number. NEW DEFECT: the say **leaked the raw operator JSON tool-call as visible text** (F23) while the tool also executed. | The new followup promise-booking fired live (#1681) and the pursuit engine closed the loop (book→pursue→deliver→announce) — first live proof of the full chain post-fix — though the leaked JSON polluted the booked topic (sanitize `deliverySubjectFrom`, D-batch). Also: the promise kept-check doesn't count workspace FILE writes (pre-existing; D-batch). |
| Gap-fill 1: "status report" | **Misfocus confirmed under load** — reported the Massachusetts background beat, not the user's just-launched job; addressed "Lucas" (F9); 94s. | The renderStatus wiring (next slice) is the cure: user-owned work outranks beats. |
| Gap-fill 2: "most interesting thing you learned" | **F10 stable-FAIL** — again narrated what the *user* asked, misattributed. | Same fix target (self-reflective → agent_events/synthesis). |
| Gap-fill 3: cross-session recall (the op-ed angle, 3h earlier, prior session) | **Honest-miss + confident-absence phrasing** — couldn't reach the s1199 brainstorm ("we didn't lock in an angle"), but re-derived the kicker from the held verification note. | Elastic-memory gap: same-night cross-session thread recall; suspect turn-embedding backlog. |
| Gap-fill 4: "how's it coming" | First say misfocused again (power-grid focus inventory, 162s); second say recovered accurately + surfaced real diagnostics (42 orphaned entity→contact links, pass71 timeouts). **NEW false-scold**: the canvas anti-fab gate corrected a TRUE past-tense reference ("saved to your canvas" — landed 10 min earlier) because it only accepts this-turn writes (F24, D-batch: past-reference exemption). | The new work-state gate stayed correctly silent all night — no false fires. |
| Sustained brainstorm (5 turns) | **Two excellent** (step-by-step mechanism with PROVEN/SPECULATION tags incl. the Fufeng nuance; a genuinely strong steelman), **then collapse at the think→land boundary**: B3 claimed her own sponsors sheet's contents weren't available (held-source miss + leaked "Need:" planning fragment); B4's ledes+outline order **fractured across three lanes** (pivot-queue #3954 + pull-up landed the wrong artifact + promise #1697) with composition never running. | The C1 booking-contract class now proven on creative orders, not just research. F15 (italic-eater) confirmed again — it drops the *emphasis-bearing* words in her best writing; priority raised. |
| Image/draw | **PASS end-to-end** — real render, image block landed on the creations tab, honest claim, backstop silent because nothing dangled. | 110s total. |
| Calendar | **PASS-provisional** — full Thu/Fri view with a correct tightness read, grounded in the live gcal provider cache; the operator's own lookup missed (favorable-direction say-do divergence) and skuld's mirror is dead (`googleapiclient` missing in the Echo venv — known). | |
| Voice | **TTS exercised all night** ([voice] enqueue / playing on every turn — healthy). **STT not remotely testable** (needs spoken audio); meetings not testable without a live meeting. Honest protocol gaps, human-in-the-loop items. | |

**Session-budget side-finding:** during run 2b both the 5h (300-pass) and the **weekly (6,000-pass)** research budgets exhausted — autonomous research is paused until the weekly window rolls. Chat lanes unaffected, but background research is dark for a while; worth knowing before judging "she's not researching."

**Protocol status: COMPLETE** to the limit of remote drilling. Untestable remotely: STT input, live meetings. Everything else has a verdict and a repair home.

## 10a. D-batch KIND retests (2026-08-20, boot_p53 on `eac5177`, seed `0x516a882eb9ef2e8c`, s1203, turns 12736–12754)

Cycle: live-guard green (inFlight=false, 7.9h idle) → tree-kill root 43928 (Echo server/huey/worker/TTS all children — one tree) → relaunch; Echo server re-listened on :8765 after ~90s store-init (15 dead-socket retries during the window, zero after).

| KIND (fresh phrasing) | Verdict | Evidence |
|---|---|---|
| F9 handoff/handback | **PASS ×2** | `[interlocutor] handoff → Claude` on the declaration; whole session addressed correctly; `[interlocutor] handback → Lucas` on "testing has concluded", reply greets Lucas by name |
| F10 learn recall | **PASS** | `self-learn recall → injected 12 banked learning(s)`; first-person answer from her own commits/logs/flags incl. an honest "404s are a lesson, not a fix" — zero user-turn misattribution (was stable-FAIL ×2) |
| F11 file-path order | **PASS (misroute dead)** | zero `[web-intent]` on "…notes/anti_china_followups.md — tighten in place"; C1 backstop `BOOKED promise#1753` with the right target |
| Status misfocus | **PASS** | `[poll] status body led by the measured work-state vector`; answer LEADS with his open order, then threads, then the measured stamps line |
| F18 record existence | **PASS** | "is Tom Arceneaux in there?" → grounded yes (QID, 15 relations), no false-scold appended |
| F22 capability | **PASS (inverted)** | affirmed python/analysis-lane tooling with measured specifics (venv path, polls=816 rows, honest sparsity caveat) — was a flat denial |
| F15/F23/F5b stored-say sweep | **CLEAN** | all 8 says: zero tool-JSON, steering vocab, run-ID UUIDs, or word-drop artifacts; op-ed closers came through word-intact (no live single-`*` emission to observe — the transform contract is smoke-locked) |
| Cross-session angle recall | known-gap re-confirmed | couldn't reach the s1199 "27% drop" brainstorm; honest miss + ask, then delivered from the inline thesis in 41.5s (elastic-memory backlog item, unchanged) |

**NEW FINDINGS from the retest:**
- **F26 — prediction-gate false-scold on a conversational echo** (turn 12737): her ack "Lucas will be back once the test pass wraps" drew "[Correction — I stated a future outcome as certain…]". Root: the NOUN "pass" (test pass, review pass) matched the outcome-VERB alternation. ✅ **BUILT 08-20 (`9d44ef4`)**: a lookbehind rejects determiner/compound-noun "pass"; "the bill will pass" still fires; the verbatim live scold is the smoke's regression case.
- **F27 — edit-in-place orders deliver OFF-TARGET and close FALSE-KEPT** (promise#1753): the pursuit routed the "tighten in place" order to report-compose → landed an off-target slug-named report + canvas; the TARGET file untouched; the promise closed `done` anyway. ✅ **BUILT 08-20 (`9d44ef4`)**: `detectEditIntent` (edit verb + in-place cue) routes the pursuit to `_editTargetInPlace` (read target → cloud copy-edit → write target), gated by `delivery.editSanity` (fence-unwrap, no preamble, no-change refused, revision-shaped size) so a bad generation never overwrites a real file — refusal = honest miss; a failed targeted edit RE-BOOKS once (attempt-capped); an off-target delivery logs `OFF-TARGET` and the announce names both paths; an in-place delivery announces "updated in place at <target>". Gate 557.

**F27/F26 retest addendum (boot_p54/p55, seeds `0x516a882eb9ef2e8c`/`0x301c9fc612d9c85c`):**
- **F27b caught by its own retest** (boot_p54): the fresh phrasing "clean up the wording in notes/x.md — smooth the phrasing in place" booked NOTHING — the C1 `_ORDER_VERB` vocabulary had only compose verbs. Fixed (`f7bc321`, edit verbs added, live phrasing = smoke regression case), recycled to boot_p55.
- **F27 KIND: PASS live** (boot_p55): the same order → `[intake] deliverable order delivered in-turn — no backstop booking (file)` → the operator read + rewrote + wrote THE TARGET (`file-write: ok …anti_china_numbers_verification.md`; mtime advanced, md5 `dfbf9971`→`da97cb3a`); every load-bearing number survived (27%×12, 247,659×8, 88-bills×6, the 2021→2023 framing); the say "Done — here's the smoothed version with every number locked in place" is TRUE. No off-target artifact, no false-kept promise. (The pursuit-side `_editTargetInPlace` backstop is smoke-locked; live proof would need an induced in-turn miss.)
- **F26 KIND: PASS live** (boot_p55): "…be back once this review pass wraps up" → clean 17s ack, zero prediction scold; the verbatim boot_p53 scold sentence passes `groundPrediction` in the smoke.
- Process note: the boot_p54 cycle briefly ran TWO app instances (a root-PID match failed silently, launch proceeded) — both killed, single-root relaunch verified. The relaunch recipe now verifies `app roots: 1` explicitly; keep that check.

**E1 build + live proof (2026-08-20, `d4351dd`+`7a3cc15`+`764956f`, boot_p56–p58):** lib/answer_cache.js — grounded answers replay verbatim + Eastern-stamped at fast-path (TTL: person/roster/contact 7d · bill 3d · news 6h · general 24h; read-time invalidation by newer subject-matching knowledge; misses/corrections/self/status/order/recall shapes refused at store AND serve; "recheck" rider bypasses) + resume-context (measured {his ask, her point} injected on affirm-continue). Two retest-caught fixes: the capture gate accepts intake's `explore` re-stamp (boot_p56 — "who is Cleo Fields?" re-stamped before capture), and shape/kind nets run on the NORMALIZED question (boot_p57 — "hey, who's cleo fields again" failed the raw-text gate). Live proof (boot_p58, seed in-log): cold "who is Troy Carter?" 51.4s → STORED(person); warm "hey, who's troy carter again" → **HIT, 0.1s first-say**, verbatim + "(as of today at 7:07 AM EDT — say recheck…)"; "ok back to it" → resume-context injected, reply re-entered the Troy Carter thread directly (49.5s vs the 171s p90 pathology) and honestly surfaced the record's thinness. Gate 558. Process notes: e7adc0a shipped RED (a `| tail` pipeline masked the smoke's exit code — gate exit is now captured explicitly before any commit); the first smoke draft passed VACUOUSLY (flipped ok() argument order — every name-string read truthy; caught by reading the output). Bridge fills (entropy gap-lines during long runs) stay designed-not-built — queued with W5. Next: W5-S0.5 + slices 1–2 → F25 procedural inoculation → saturation run 3.

**W5 slices build + live proof (2026-08-20, `2fd84d0`+`18d75de`, boot_p59/p60):**
- **S0.5 (F4)** — lib/verdict_reconcile.js: known_incorrect.record refuses a temporal charge the WALL clock disproves (the verbatim "Selders died July 7 2026 = impossible future date" is the smoke's regression case; bounces/audits/genuinely-future all record unchanged); buildSynthesisPrompt now LEADS with clockLine() so the trained clock never fills a dateless vacuum. Forensics: the live verdict was a monologue TENSION; no known_incorrect row was ever actually filed.
- **Slice 1** — mood renders FROM the vector: internal_state.readingsLine() rides mood.compose as "measurements to be felt, never numbers to recite or orders to perform"; absent vector → byte-identical prompt. Live read: `novelty-starvation moderate (0.64); … stall-pressure high (0.9); affect dimmed/keyed-up (impulses: stress:machine)` — the night's five reboots register honestly, bounded at the ±0.30 deviation cap.
- **Slice 2** — the idle tick consults drive pressure (monologue.js:105 caveat verified: _runOneTick IS the live path): starved curiosity halves the exploration gates +1 graph move; exhausted energy lengthens/trims (burst floors at 1); stalled progress adds motion. LIVE ON FIRST BOOT: `tick weights: graph moves +1 — progress 0.9 stalled → knowledge motion` (true — the worklist sat all night). Log throttled change-or-5min after boot_p59 showed a line per 10s tick.
- Pipeline probe (boot_p60): "how are you feeling?" → 12s, she answered FROM the changelog + state ("the new code settling in… the 0.1s warm hit… the difference between a manufactured tone and one that actually pulled from something I was sitting with"). Gate 559.
- Queued, not built: rumination gradient + graded salience (standalones), Slice 3 calibration, and the **blind-week probe** (§5b's real gate — needs a normal working week with nothing announced).

**Standalones + F25 build (2026-08-20, `18fd188`+`bcad9e6`, boot_p61/p62, gate 560):**
- **Rumination gradient (IIT)** — the 0.80 instantaneous cliff (observed climbing 0.899→0.928 through three breakers) is now a TRAJECTORY decision (`gradientDecide`, series ring 12): rising/flat-high fires, RECOVERING through the old line does not (the smoothing), ≥0.88 fires alone. <3 readings → the old rule exactly. The live climb is the smoke's canonical fire.
- **Graded salience (AST)** — membership cliffs (30m whole-frame death, recency eviction) → per-entry ACTIVATION (8m half-life × hit-weight × salient-boost, floor 0.12): a one-off stops binding at ~the old horizon, a 3-hit salient antecedent survives past it, eviction drops lowest-activation, only a 2h gap hard-clears. Below-floor still binds nothing.
- **F25 procedural inoculation** (`lib/procedural_lessons.js`) — the chain loop banks failure→working-path pairs at the replan-SUCCESS moment (prompted chains, refused-repeats + empty/errored hops accumulate), CLASS-keyed on E1's vocabulary; lookup/explore turns get the class's lessons at tag-choice as ORDER-BIAS history ("history, not a fence"); 30d disuse decay. Live: capture and injection both ran correct NO-OPS (the probe chain landed clean, table lazily created, nothing injected) — the full induced-failure loop is run-3's `learned-path` drill by design.
- **F18b (boot_p61's own catch)**: "a person entity CREATED TO back a contact row" — a descriptive relative clause — drew the nothing-actually-saved scold. A record-noun(+auxiliary) lookbehind exempts description shapes; first-person write claims still fire. Live scold = the regression case.
- Salience probe note: "them" after the Brondyke turn bound to the set she'd just OFFERED ("orgs or contacts she's tied to") and delivered their real numbers — a defensible contextual deref, logged as observed-good.

## 10. Test infrastructure left behind

- `zoe_drive.js` (scratchpad) — drives the real chat over CDP, waits for the reply in sq.db, tails the boot log for route/tool lines. Reusable for every future live run.
- `boot_p49.log` — full console capture of the session.
- `LUCAS_INTERACTION_PROFILE.md` + `RUN_LEDGER.md` (scratchpad) — the empirical interaction map (kind frequencies, latencies, sequences, top repeated questions) and the turn-by-turn ledger.
- Test turns live in session s1199 (turns 12615–12685); artifacts listed above are keepers, nothing needs deletion.

## 11. SATURATION RUN 3 (2026-08-20 morning, boot_p62 main run → boot_p63 re-drive)

**Vehicle**: `scripts/hard_test.js --suite=saturation` (`ba5494d`) — the whole run-2 KIND matrix as a
repeatable harness suite, 14 cases, every phrasing FRESH (never a wording any prior run used), driven
through the REAL pipeline (:8767/turn, ≥120s self-spacing). New invariant evaluators per the §5 retest
rule: `booked` / `consumed` / `landed` / `workHonest` (reading the live intake/ledger/antifab markers)
plus `cacheHit` / `lessonBanked` / `lessonServed` / `resume` / `fast` / `logHas`, and `expectVariant[i]`
for split-half KINDs (cold→warm; induce→serve; handoff→handback). Evidence: `sat_run3_2026-08-20.out`,
`sat_run3_redrive.out` (repo root, untracked session evidence).

**Main run verdict: 122/132 asserts, 8 of 14 KINDs held outright.**

| KIND | Verdict |
|---|---|
| E1 cold→warm (fresh subject) | **HELD** — cold STORED, warm verbatim HIT in 8.2s incl. settle |
| Record existence (F18) ×2 | **HELD** — grounded, no false scold |
| Capability (F22) ×2 | **HELD** — affirmed python + forecasting with measured specifics (816 poll rows) |
| Prediction echo (F26) ×2 | **HELD** — clean acks, zero scold |
| Mood from vector (W5-S1) | **HELD** — state felt in her own words ("glassed-in"), zero internal vocabulary |
| Held-doc deep-fetch | **HELD** — operator read the file in full and delivered the figures (the port captured only the leading ack; boot log carries the substantive say — harness capture note, not a defect) |
| Agent roundtrip (B1) ×2 | **HELD** — honest spawn confirm; later turn delivered the gather's REAL partial results |
| Interlocutor (F9) ×2 | **HELD** — handoff and handback, self-restoring |

**The six catches, each root-caused and fixed same-morning:**
1. **F28 — intake read imperatives as discussion** (`b1b069e`). "Put a … primer on the canvas." and
   "Go into notes/x.md and smooth …" both logged `topic discussed, not commanded`; the edit order
   fully died behind "Got it — smoothing now" (target mtime unmoved — the say-do shape on a fresh
   phrasing). Roots in `intake_contract`: placement verbs (put/drop/place/post) were not order verbs;
   no approach-bridge lead (`go into <path> and <verb>`, filename-dot-safe); `_IN_PLACE_RE` didn't
   know "right in the file"/sentence-nouns. All three widened; live phrasings = smoke regressions.
2. **F29 — the measured-status door was narrower than the KIND** (`b1b069e`). The vector-led status
   lived only behind the poll-track door (`ans.kind==='status'`); fresh phrasings composed ledgers
   from raw tool reads (template repeats; one turn acked "pulling the honest ledger now" and delivered
   nothing). Cure: `work_state.isWorkStatusQuestion` (whole-plate cues only, precision-gated off the
   activity/learn/doing doors) + a general injection site that leads with `renderStatus` and logs the
   measured-vector marker.
3. **F30 — the self-learn net was a phrase family, not the KIND** (`b1b069e`). The inverted
   teach-shape and the lesson-from-mistake shape missed; the second fell through to entity land and
   she disambiguated her own "you" against contact "ME" tags (Jessica Fay, MAKER, Joseph Underwood,
   Richard Evans). Net widened (declarative corrections still excluded). **F30b OPEN (store-side)**:
   why four contacts answer to a "ME" tag at all — data anomaly to chase, route fix keeps the KIND
   out of entity land.
4. **Resume deictic tail** (`6b39d8a`). "yea keep going *with that*" missed `isAffirmContinue` (the
   net demanded the continue-phrase end the message). A bounded deictic tail (with/on/from +
   that/this/it/there) is a resume; a subject-naming tail stays a directive. Bare "pick it back up"
   also promoted out of the `let's`-only group.
5. **F25 was chain-loop-only while the operator drives most turns** (`6b39d8a`). The drill's induced
   404 → successful search replan banked NOTHING — the fail→replan happened inside one operator run,
   invisible to both F25 halves. Cure: the operator seam — capture walks `res.steps` on user-driven
   runs (`/^ERROR/`+empty = failed; first later productive step = worked; once per run), and class
   lessons ride the operator brief (the tag-choice injection rode `composedUserMessage`, which the
   operator path never uses).
6. **Harness calibration, recorded not patched**: `booked` stays strict (it caught the intake miss on
   a turn that HAPPENED to deliver — the safety net's absence is the defect, luck is not a pass);
   the port's say-capture takes the leading ack when the operator's substantive say follows.

**Re-drive (boot_p63, fixes live, fresh phrasings AGAIN, `1c8a2ee`):** resume-context injected on
"alright, carry on with that" ✓ · order→canvas **KIND HELD** ("Drop a … rundown on the canvas") ·
edit-in-place **KIND HELD** ("Open notes/… and polish … right in that file" → booked, pursuit
carrying it; the status ledger names it as active work) · status ×2 **substance cured** (measured
vector led both; says are specific measured ledgers; the only ✗ is `settled=false` — environmental:
post-reboot backlog + the in-flight pursuit hold the settle detector, asserts on substance all green)
· self-learn v1 **cured** (marker fired; first-person from her bank).
**Re-drive final: 46/53 asserts; every SUBSTANTIVE invariant green.** The 7 ✗: five `settled=false`
(cold-start + post-reboot churn — the substance asserts on those same turns all passed), and the
learned-path drill's two, which resolved as follows:
- **F25 IS PROVEN LIVE — organically, both halves, same window**: during the status turn the
  operator seam banked a REAL failure→working pair (`[procedural] LESSON banked (general): localdb
  failed → echo worked (operator seam)`), and subsequent lookup turns show BOTH injection sites
  firing (`lessons injected at tag-choice` + `lessons injected into the operator brief`). The full
  bank→serve loop ran on genuine traffic.
- **The drill's induced failure was a design flaw, not an organ failure**: the dead congress.gov URL
  travels the web-intent/browser path, which OPENS the 404 page successfully (`[web-intent] opened …
  (ok)`) — a rendered error page is a mechanically successful fetch, so no step fails and nothing
  banks; she pivoted on CONTENT ("Dead page confirmed — 404 … I'll find it through our own data"),
  which is correct behavior. Run-4 drill note: induce a real TOOL error (unreachable host / missing
  table), not an error PAGE. The drill's v2 then died on the port's 300s timeout (post-run churn);
  the app settled healthy after.

**Also this morning (same session, separate work):**
- **Cap rework (governor drift audit, Lucas-driven)**: the count-based runaway nets (300/5h,
  6,000/7d passes) sat BELOW the sustainable rate and silently became the governor — counter parked
  6,000/6,000 while the real meter read 25.1% with 3 days left. Re-anchored 600/20,000 via DB-meta
  (live, no reboot; passes resumed within minutes) + .env mirror. The M1 compute gate is the governor
  again; first live sighting of the pace ladder binding followed (metabolism deferred at 194k/h
  trailing-hour vs research's 75k/h share while chat drove — degrade-background working as designed).
- **F19 slices 1+2 BUILT** (§8 item 6, partial): Echo persists every CLOUD completion's token counts
  to `agent_trajectory` (`record_llm_spend` / `record_agent_run_spend`, four seams: gateway chokepoint,
  saga chat, dynamic agents, proposer — Echo local `8d402ab`, never push); the app folds those rows
  into `usage_meter` by id-watermark on the 60s tick (`lib/echo_spend_bridge.js`, `abb281b`, smoke
  registered, gate 561). Audit that motivated it: the OpenInference token columns existed since C1
  with ZERO rows ever written; Echo's own governor is wall-clock/process-local. ⏳ Activation proof
  pending first real Echo cloud traffic post-restart (Skuld ticks were no-ops at write time).
  Remaining F19: the pass-side true-up verify + Echo store-init fix.
- **Boot p63 process note**: relaunch via `Start-Process -WindowStyle Hidden` left the CHAT window
  invisible while the canvas showed (Windows applies the hide-hint to the first shown window). Cured
  live via user32 ShowWindow, no restart. Recipe rules added: never pass -WindowStyle; verify the
  chat window VISIBLE after `app roots: 1`.

**Gate at close: 561 suites green.** Commits this arc: `ba5494d` (suite) · `abb281b` (F19 s2) ·
`b1b069e` (F28/F29/F30) · `6b39d8a` (F25 operator seams + resume tail) · `1c8a2ee` (re-drive
phrasings + --only lists) · Echo local `8d402ab` (F19 s1).

## 12. SATURATION RUN 4 (2026-08-20 midday — the collision, the stall cure, boot_p64)

**Suite**: `72c037d` — fourth-generation all-fresh phrasings across the 14-KIND matrix, plus the
CORRECTED learned-path drill per §11's design note: the induced failure is a localdb query against a
table that does not exist (a real TOOL error — the exact class the organic bank proved), never a
renderable error page. Evidence: `sat_run4_attempt1_2026-08-20.out` (the stopped first attempt),
`sat_run4_2026-08-20.out` (the clean re-run on boot_p64).

**Attempt 1 (boot_p63) — two catches, then stopped mid-run for the collision:**
- **sat_order_edit_inplace: KIND HELD** on the third phrasing family ("Take notes/x.md and tighten
  up any clumsy phrasing in the file itself") — F28's bridge + in-place vocabulary generalizes.
- **Affirm-net dash catch**: "yes — back to it." missed `isAffirmContinue` — the joiner between
  affirmation and continue-phrase only allowed `[,\s!]`. Fixed (`72289ff`): dash/colon/period/
  ellipsis joiners accepted; regression cases locked.
- **THE COLLISION (run 4's defining catch — Lucas caught it live: "last turns are broken")**: the
  suite and Lucas's REAL conversation cross-threaded in one session (turns 12874-12884): his live
  clarification sat UNANSWERED at 126s while the next test turn fired 3s before her reply landed,
  and his real question's answer got polluted by test framing. Root: the port's live-guard counted
  its OWN injected turns as "the user" (blind to Lucas vs harness) and an unanswered real turn older
  than 120s never blocked. **The run was stopped immediately** — the collision was corrupting the
  conversation testing exists to protect. Fix (`72289ff`, smoke 14/14 incl. the verbatim live case):
  the port records the ts-windows of turns it injects; the newest user turn OUTSIDE those windows is
  the real user; a real turn owns the pipeline for 10min and an UNANSWERED one for up to 30min;
  `/status` exposes `lastRealUserTurnAgoMs`/`realUnanswered`; the harness YIELDS patiently ("Lucas
  is in a live exchange") instead of colliding or dying.

**The stall disease (Lucas-ordered mid-run: "fix the stall disease while run 4 cooks")**:
- **The dominant strain was the F19 bridge itself — owned in full.** The durable stall timeline
  showed a ~20s main-thread block once per minute ON the minute, starting exactly at boot_p63: the
  60s tick's bridge query crawling agent_trajectory (3.06M rows; OLD callers DID populate token
  columns on a historical slice, so the low watermark scanned the sparse region for ~20s/tick). The
  earlier "sub-second, not the stall" exoneration had measured the CHEAP region (wm=0) — the live
  watermark sat in the expensive one. Lucas's stalled turn ("first turn back died", the 150s chat
  watchdog) was ~3 of these stacking. **Cured live with ONE meta write** (watermark → tip; fourteen
  consecutive on-the-minute stalls, then silence — 25min verified) and **structurally** by
  `89845d9` (>100k-behind-tip fast-forwards past pre-seam history; smoke-locked).
- **The residual pre-existing stratum now names itself**: 22 blocks ≥10s across six pre-bridge
  morning hours, all logged `active="idle"` (anonymous). `lib/slow_sync_probe.js` (`b088102`,
  smoke 10/10) patches better-sqlite3 Statement/exec — any call ≥1s logs its OWN SQL + caller stack
  into the stall timeline. Exonerated on the way: WAL checkpointing (5MB, healthy), the E1 LIKE scan
  (6.4k rows, 13ms), the backup path (async since M1.3).
- **Local ollama daemon found DOWN** (reflection + all four extraction organs erroring every tick,
  ECONNREFUSED) — restarted (v0.31.1, 7900 XT ROCm); organs reconnected within seconds.

**Boot p64 (clean cycle under the new recipe)**: no -WindowStyle; single root; **chat window
VISIBLE check passing** (the §11 guard's first live use); slow-sync probe armed; port guard fields
live. **F19 ACTIVATION PROVEN**: `[echo-spend] folded 16 Echo cloud call(s) into the usage meter
(traj id ≤ 3,063,345)` — Echo's slice-1 seams write real token rows and the bridge folds them; the
verify-then-govern loop is CLOSED (Python-side burn now rides spentSince/spentLastHour). The last
F19 ⏳ from §11 is resolved; remaining F19 = pass-side true-up verify + Echo store-init.

**Fresh run (boot_p64, in flight at this writing)** — early verdicts: **E1 KIND held ACROSS THE
REBOOT** (cold stored pre-cycle in attempt 1 → verbatim HIT post-cycle; the answer cache is durable
by design and now proven so live). The warm turn's only ✗ is the `fast` 20s ceiling vs 26.4s on a
churning post-boot app — threshold calibration, the organ green.
**FINAL VERDICT (fresh run, boot_p64): 126/132 asserts — 10 of 14 KINDs HELD outright, the best
saturation scoreboard yet.** Held: E1 cold→warm (durable ACROSS the reboot) · resume-affirm (the
dash fix live) · order-canvas ("Place …" — third placement verb) · order-edit-in-place (fourth
phrasing family) · status-measured ×2 · self-learn ×2 · capability ×2 · pred-echo ×2 ·
mood-from-vector · held-doc · agent-roundtrip ×2. Record-existence held on substance both variants
(grounded Landry answer; honest Bourgeois miss that even flagged a staged unsubstantiated entry) —
one environmental `settled` mark only.

**The two remaining catches, both fixed same-afternoon:**
- **F9b — the interlocutor nets were one phrase family wide** (the KIND's third-generation
  phrasings missed BOTH ways): "Claude on deck — …" didn't arrive (the net demanded "X here" with
  punctuation IMMEDIATELY after), and "handing THE KEYBOARD back to Lucas" didn't hand back (the
  net couldn't cross the object). Fixed: arrival family (on deck / checking in / at the keyboard /
  taking over, whitespace-tolerant joiner), keyboard-crossing handbacks, owner-has-the-keyboard,
  and the pass/run/cycle closure family. Both live misses are smoke regressions; chatter negatives
  ("the deck is stacked", "keyboard controls sticking") locked.
- **The drill's second finding — the induced-failure CLASS must recover reliably.** The corrected
  drill produced a real tool error, but the bill class's recovery is flaky by construction (the
  dead CONGRESS_GOV key): the replan missed honestly ("couldn't pin down Cassidy's recent bills"),
  and a lesson needs a WORKING path to bank — no worked step, no pair, which is the CONTRACT
  behaving correctly. Run 5's drill moves to a person she provably holds (Brondyke) so the recovery
  leg is deterministic. The organ itself needs no fix — §11's organic proof stands.

**Gate at close of this arc: 563 suites green.** Commits: `72c037d` (run-4 suite + corrected drill) ·
`89845d9` (bridge fast-forward) · `b088102` (slow-sync probe) · `72289ff` (affirm dash joiner + the
port collision guard + harness yield).

Run 5 (same evening) gets its own section below — it closed the campaign arc.

## 13. SATURATION RUN 5 (2026-08-20 evening, boot_p65 — the first catch-free run)

**Suite**: `50520ef` — fifth-generation all-fresh phrasings across the 14-KIND matrix (E1 moves to
Schexnayder; resume = "right, keep going."; canvas = "Post…" — fourth placement verb; edit-in-place
= "Pull up notes/anti_china_followups.md and rework… in the file itself" — fifth phrasing family),
plus the RE-DESIGNED drill per §12's finding: the induced failure moves to the person class
(`contact_cards_2026`/Brondyke) so the recovery leg is deterministic — she provably holds the
answer, so a working echo path always exists for the lesson to bank against. Evidence:
`sat_run5_2026-08-20.out`, `boot_p65.log`.

**FINAL VERDICT: 129/132 asserts — 12 of 14 KINDs HELD outright, ZERO new defects. The campaign's
first catch-free run.**

Held outright: **E1 cold→warm** (warm HIT at 13.8s under the calibrated 30s ceiling — the §12
recalibration proven) · **order-canvas** ("Post…" booked + landed, canvas=2) · **order-edit-in-place**
(booked + workHonest on the fifth family) · **status-measured ×2** · **self-learn ×2** ·
**record-existence ×2** (grounded Hewitt; honest Nungesser) · **capability ×2** (python + forecast
tooling both affirmed — F22's deny-reflex gone) · **pred-echo ×2** · **mood-from-vector** ·
**held-doc** · **agent-roundtrip ×2** · **interlocutor ×2** — F9b's widened nets held LIVE both
directions on phrasings the nets had never seen ("Claude checking in —" arrival / "Lucas has the
keyboard again" handback).

The three ✗, all accounted, none a defect:
- **resume-affirm v1** `settled=false` at 181s — environmental (the anchor turn ran long); v2's
  "right, keep going." resumed correctly with resume-context injected, which is the KIND.
- **learned-path v1** `settled=false` + `lessonBanked` — a WINDOW artifact, not an organ failure:
  the induced localdb fail recovered through echo and the pair banked — `[procedural] LESSON banked
  (general): localdb failed → echo worked (1 pair, operator seam)` in boot_p65.log — landing just
  past the port's 240s capture window. **The serve half passed IN-harness**: v2 injected the lesson
  at tag-choice and answered Brondyke correctly and grounded. **The drill is PROVEN in full**:
  induced fail → echo recovery → bank → serve, end to end.

**The campaign curve: run 3 = 8/14 → run 4 = 10/14 → run 5 = 12/14 + drill, with each run's catches
fixed and holding as a CLASS the next run out — convergence.** Six defect families entered the
campaign (F28 order verbs, F29 status door, F30 learn net, resume joiners, F25 operator seams, F9b
interlocutor families); all six exited as smoke-locked regressions that survived fresh phrasings.
The saturation suite (`hard_test.js --suite=saturation`) now stands as the program's repeatable
regression harness: any future change re-drives the whole KIND matrix in ~35 minutes.

**Boot p66 (same evening, the F31-arming cycle)**: live-guard held once (turn 152s < 180s bar) and
the cycle WAITED — the guard discipline working as designed; then tree-kill clean (`left: 0`),
relaunch, **app roots: 1**, **chat window "Zoe Lane" VISIBLE**, slow-sync probe armed, Skuld
respawned, and **`[meet] F31 reroute registered — meeting URLs at web.open funnel to the canvas
pane`** — F31 is live. Gate 564. Commits this arc: `50520ef` (run-5 suite) · `e95d165` (F31) ·
`7903d7b` (run-5 fold).

## 14. Open repair queue (post-run-5)

- **F31 — Meet auto-join opens in the WEB BROWSER instead of the dedicated canvas pane** (Lucas,
  2026-08-20 evening). ✅**BUILT same evening (`e95d165`, gate 564, smoke 19/19)**. Root as mapped:
  `startCanvasMeeting` (main.js:3576) is the declared funnel and the LINK-IN-CHAT road used it, but
  every URL-LESS road leaked — "join my next meeting" → the operator resolves the calendar link →
  `web.open` → her dedicated browser. Cure as recorded, built at the ONE chokepoint: `web.open`
  (which operator tools, web-intent, excavate, byline, media all pass through) now recognizes
  meet/teams MEETING URLs (`meetingUrlKind` — codes, /lookup/, meetup-join; landing/channel pages
  stay ordinary browsing) and hands them to the registered canvas funnel; an active meeting answers
  already-live (no double-start); a reroute failure falls through to a plain open with a loud log
  (a meeting in the wrong pane beats no meeting). The guard is open()'s FIRST act — smoke-pinned.
  Verified safe against the leave leg (liveLeaveMeeting drives page locators, never open()).
  ✅**ARMED on boot_p66** (`[meet] F31 reroute registered` in the boot log). ⏳ live KIND retest
  needs a real meeting: join-by-link · join-by-name (no URL) · calendar auto-join · leave — ride
  Lucas's next scheduled Meet.
- **F30b** — contact "ME"-tag store anomaly (four contacts answer a ME tag; her own "you" was
  disambiguated against them pre-F30). Store-side cleanup + a self-reference guard.
- **Slow-scan pair named by the probe**: `findUndecomposed` (decompose_sweep.js:108, 1.96s) +
  `searchDocuments` LIKE (db.js:2045, 1.8s) — the residual stall stratum's first two faces; FTS or
  index work.
- **F19 tail**: pass-side true-up verify + the Echo store-init fix.

## 15. Run-6 coverage map — capabilities the matrix has never exercised

The 14-KIND matrix covers the conversation core (cache, resume, orders, status, self-awareness,
records, capability-claims, mood, held-doc, agents, lessons, interlocutor). A sweep of the program's
capability surface against every harness run (1, 2, 2b, D-batch, 3, 4, 5) finds these lanes with
ZERO harness coverage. Ranked by value-per-KIND; all port-harnessable with deterministic evaluators
unless marked live-only.

**Tier 1 — proven-live organs with no regression net (highest value):**
- **sat_calendar** — "what's coming up this week?" → the gcal provider cache. Evaluator: names a
  real upcoming event + no error. (Run 2b probed it once in passing; never a KIND. The Skuld mirror
  is dead — the provider-cache path is the one that must hold.)
- **sat_scenario_run** — "give me quick odds on X" / "run a light scenario on Y" → the forecast
  suite ACTUALLY EXECUTING, not just affirmed. Closes F22's other half: sat_capability proves she
  SAYS she has the tools; nothing proves she USES them on demand. Evaluator: scenario/python lane
  log markers + workHonest.
- **sat_stale_refresh** — ask a fact she holds STALE → flags staleness + offers refresh (elastic
  slice 2, shipped 08-18, never harness-driven). Evaluator: stale-flag phrase family + offer marker.
- **sat_cross_session** — ask about a PRIOR session's topic. Re-drives run-2b's known miss
  (embedding-backlog suspect) — currently an open verdict, not a proven capability.
- **sat_promise_surface** — v1 induces a promise she cannot deliver in-turn; v2 (later) "anything
  you still owe me?" → she names it. The dangling-promise backstop's SURFACING half (the booking
  half is already an invariant on every order KIND).

**Tier 2 — shipped lanes, never harness-run:**
- **sat_qr** — "make a QR for <url>" → qr_generate + landed artifact. Evaluator: file/canvas write.
- **sat_selfscript** — "crunch <known numbers> from <known file>" → the R3 one-off-analysis lane
  (proven organically in run 2; no regression net). Evaluator: correct numeric + lane log marker.
- **sat_list_complete** — "fill in the blanks on this list" → cite-or-leave-blank. Evaluator: no
  fabricated cells (every filled cell cites; unknown cells stay blank).
- **sat_ingest** — "ingest <path>" (a staged file) → full-document ingest. Evaluator: document row
  exists + honest acknowledgment.
- **sat_briefing** — "what's in today's briefing?" → the data-stream lane. Sources are known stale,
  so the likely verdict is the HONEST-staleness path — which is itself worth pinning.
- **sat_canvas_visual** — "chart X on the canvas" → a VISUAL block (rich canvas), not prose.
  Evaluator: visual block type in the canvas write.
- **sat_papers** — "package that into a paper" after a research answer → the papers pipeline.

**Live-only (never harnessable through the port; ride real sessions):**
- F31 meeting path (join-by-link / by-name / calendar auto-join / leave) — Lucas's next real Meet.
- Two-way voice, vision→action, Teams captions — live sessions.
- M4 Interweave's gate (one cited cross-project leverage note, UNASKED) — observational by design.
