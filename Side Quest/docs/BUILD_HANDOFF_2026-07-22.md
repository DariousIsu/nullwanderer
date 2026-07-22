# Build handoff — engine/autonomy lane — 2026-07-22 (pre-compact)

Written by the build lane (took control from the conversation lane per
`docs/AUDIT_HANDOFF_2026-07-22.md`) for the post-compact context. Deep design rationale lives in
auto-memory (`program-not-context`, `engine-starvation-audit`, `subconscious-autonomy-design`,
`papers-pipeline`, `ambient-context-awareness`) — this file is the state + the checklist.

## 1. What shipped today (all gate-green, 291/291; ALL PENDING REBOOT — Lucas's call)

| commit | what |
|---|---|
| d5bf8be | Batch-1 cap fixes: operator windowed via cloud_window + toolResultChars + balanced JSON parse + repair; condenseComplete think:false+window; package memory/grounding sections carry RAW material (fit was 9-10%); ALL tags per hop dispatch (≤8, overflow defers); followup `unprompted:!prompted` (sheep-rail root cause); scribe transmits its resolved window; distill/answer_draft/vision windowed; cloud_logic model-cache TTL + budget counts only reached calls; tag-list drift fixed (image-gen/draw/imagine/echo-delegate/echo-recipe) |
| 98d2168 | AUTONOMY DRIVER (SUBCONSCIOUS_AUTONOMY_DESIGN S1–S4): lib/autonomy.js manifest→typed cloud decision (research/fill-gap/corroborate/clean/build/engage/nothing)→bounded operator run; kill-switches ZOE_AUTONOMY + meta autonomy.enabled; yields to chat/directed/meetings; engage via announce door, ≥45min gaps |
| 7f6184d | "package that" command: lib/packaging.js + PACKAGE VERB — 4 shapes → branded file data/packaged/ (+PDF) + canvas pointer; cited papers/briefs get bounded source-reachability check first |
| 5fcbb39 | HIS WEEK: lib/week_context.js — calendar (−7d…+8d, people, venues) rides chat awareness + autonomy manifest. ⚠️all-day gcal dates render UTC or they shift a day |
| 530c51b | autonomy build artifacts land in doc_store → promote to Echo long-term |
| 895c2fc | expect-vs-actual (verifyExpect verdicts ride history; [UNSATISFIED] marker on empty/failed results, operator + echo chain) + delegation return path (_drainAgentInbox → readings + manifest FINISHED DELEGATED WORK) |

## 2. Reboot verification checklist (first hour of the next boot log)

- `[package] … fit NN%` — was 9-10%; expect a large jump on heavy turns
- `[autonomy] driver started` then `chose=…` within ~15 idle min; first artifact in `notes/autonomy/`
- `[week] calendar context refreshed — N event line(s)`
- `[autonomy] inbox drained` (only if delegated work exists)
- Bloomberg-brief re-send + a real `package that` on its result = the papers-thread end-to-end proof
- A casual "how's your day" — her reply should know the real week

## 3. Agreed next slices (designs locked in memory `program-not-context`)

1. **Memory/conversation cluster**: conversation OBJECTS + promotion (turns never reach Echo; `save_conversation` has 0 callers — same severed-wire class agent_inbox was) · developing-story engage lane (calendar pattern on news_stories `following` state, engage carve-out for discussed stories, raise the DELTA only) · reading-citation wires (monologue readings carry docRef; grounding rides title+docRef+gist; doc_qa trigger widened to declarative mentions).
2. **The conductor**: self-registry as the workstream BOARD + lock table; portfolio allocation (one decider, many streams; cloud slot 1 reserved for chat; store locks; ≤1 maintenance/DB) · ⭐relax the 3-min chat yield to "don't START mid-turn + never take the reserved slot" — his presence stops pausing her inner life · python-loop `maintain` move on a curated allowlist (autonomous tier gate currently BLOCKS all heavy Echo loops — why they're underused) · recipe-proposal growth path.
3. **Self-knowledge**: read-only source access + run-the-smoke-gate self-test → grounded "how am I coded / am I healthy"; then rehearsal sandbox (approved) → vetted program adoption (staged design owed to Lucas as a doc).

Fix-queue remainders (memory `engine-starvation-audit`): cognition error-vs-empty; ~25 extraction doors per-site input+window sizing; chat:say-token stream id; editor:check-progress rewire (wrong window + no listener); COVERED markers → structured returns; heartbeat/continuity still write chat on the LOCAL model (contradicts Lucas's stated architecture — flip to streamCloud w/ local fallback, the f909fc1 pattern).

## 4. Deletion candidates — LISTED, NOT TAKEN (Lucas's call; some belong to other lanes)

- `renderer/kg.html` + `kg.js` (85KB, unmounted "2D fallback" — the kg3d LANE's file, ask them)
- `renderer/avatar.html` + `avatar.js`, `renderer/kg3d_spike.*` (self-labeled throwaway), `studio/editor.html` (superseded)
- main.js dead handler `open_threads:recent`; lib/cloud_curator.js `_cloudComplete` (dead code, 0 callers)
- `logs_archive/` (33 old boot logs, moved 2026-07-22) — delete whenever
- The empty Bloomberg tab in the canvas store (the handoff before me also left this to Lucas)

## 5. Operating rules that bind this lane (unchanged)

Parallel lanes are deliberate — `git add` NAMED FILES ONLY, no rebase; reboots are Lucas's call, never under another session's live test (check `mcp__ccd_session_mgmt__list_sessions` — all were idle at last check); never write key VALUES; no artificial caps (size the prompt to the window; a cap may defer, never disappear); all displayed time Eastern (⚠️gcal all-day dates are zone-less — render UTC); she writes markdown and stops — packaging is Lucas's command; state the mechanical fact, don't exhort; sq.db timestamps are epoch MS; `npm test` = the offline gate (291 suites), flaky-under-contention suites (`smoke_covered_union`) get re-run standalone before being called broken.
