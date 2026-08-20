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
3. D-batch concrete bugs (F11 file-read misroute · F15 italic-eater · F18 anti-fab wrong store · F9 interlocutor · F21 app-root/sandbox model · F5b voice-leak filter · dual-emission recheck) + F22 capability manifest.
4. E1 answer-cache matrix (rapid response) + resume-context cache.
5. W5-S0.5 verdict reconcile · then W5 Slices 1–2 (mood, idle) · then rumination gradient + graded salience.
6. F19 verify-then-govern (priority tiers in the pacer; meter Skuld) + Echo pair (store-init, agent-sandbox search keys).

Each lands with its KIND retest through the real chat (zoe_drive.js) and a new hard_test invariant (`booked`, `consumed`, `landed`, `work-state-honest`).

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

## 10. Test infrastructure left behind

- `zoe_drive.js` (scratchpad) — drives the real chat over CDP, waits for the reply in sq.db, tails the boot log for route/tool lines. Reusable for every future live run.
- `boot_p49.log` — full console capture of the session.
- `LUCAS_INTERACTION_PROFILE.md` + `RUN_LEDGER.md` (scratchpad) — the empirical interaction map (kind frequencies, latencies, sequences, top repeated questions) and the turn-by-turn ledger.
- Test turns live in session s1199 (turns 12615–12685); artifacts listed above are keepers, nothing needs deletion.
