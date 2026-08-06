# Data-Stream Lane — Build Brief (parallel context)

> **For a fresh Claude Code context.** Another context is concurrently working the *interactive
> protocols* (chat-turn voice, JSON-leak, chat-lock, deliverable templates). Read the **Safety /
> collision guardrails** section FIRST — you are sharing a repo with active work.

## Mission
Turn the already-built **Monitors tab** (live RSS wall + 3 YouTube CC channels) from a DISPLAY-only
widget into a real cognition **LANE**: persist items, poll autonomously, and feed *relevant,
source-grounded* items into Zoe's "main strain" (her subconscious / idle graph-walk). This is the
**first true replacement for the old random subconscious** — grounded real-world input instead of
random musing.

## Current state (READ THESE FIRST — do not rebuild them)
- `lib/feeds.js` — pure store: 20 RSS subscriptions (`data/feeds.json`) + 3 YouTube video monitors
  (`data/monitor_videos.json`). CRUD only. **No item persistence.**
- `main.js:867-940` — Monitors IPC: feeds/video CRUD, `feeds:fetch` (fetches via the engine's
  `fetch_feeds_batch` → merged newest-first stream, for DISPLAY), YouTube clean-player http server,
  `video:ingest` (audio→transcription pane).
- `studio/feeds_view.js` — maps feed reports → merged item stream (display shape).
- `lib/media_cc.js` — YouTube closed-caption scraping (the 3 channels).
- **THE GAP** (documented at `main.js:869`): *"Where items get stored + how Zoe cognizes them is the
  Zoe-builder's lane."* ← that is this brief.
- **The "main strain"** = `lib/monologue.js` (the idle loop, recently rebuilt as a cloud-driven
  GRAPH-BUILDER — entry `runGraphWalkMove`) + the pollers pattern in `main.js`
  (`inboxPollTimer` at ~712, `canvasIngestTimer` at ~760, shutdown clears at ~836-839).

## Scope — three parts
1. **Item store + dedup** — persist fetched RSS/CC items (`id, source, title, url/guid, ts, summary,
   seen`) so items aren't re-cognized. New `lib/feed_items.js` (JSON store *or* a `feed_items` table
   via a `lib/db.js` migration — additive). Dedup by url/guid.
2. **Autonomous polling hooks** — a feeds poller modeled on the inbox/canvas pollers: initial-sweep
   `setTimeout` + `setInterval` + shutdown `clearInterval`. Fetches RSS via the existing
   `feeds:fetch`/`fetch_feeds_batch` path + YouTube CC via `media_cc`, on a configurable interval
   (~2-5 min; add a `FEED_POLL_MS` to `.env` like `INBOX_POLL_MS`). Writes NEW items to the store.
3. **Lane → main strain (the cognition)** — a GOVERNED sentinel that surfaces RELEVANT items into the
   main strain. **Not a firehose dump.**

## The integration CONTRACT (keeps this out of the other context's files + respects lane isolation)
- Feed the main strain through a **clean, existing interface** — **do NOT edit `lib/monologue.js`
  internals.** (That file is owned by the other context's graph-walk rewrite, and the Interface+Lanes
  design keeps lanes ISOLATED from the subconscious.)
- Preferred hook: write relevance-selected items as grounded readings via
  `db.insertMonologue({ content, model: 'feed', type: 'reading', ... })` and/or seed a graph-walk
  ANCHOR through a small, explicitly-agreed function — surfaced as heartbeat **pointers** the main
  strain *may* pursue, never auto-written to identity.
- Every item carries its **SOURCE** (she says "I saw on Reuters…", never confabulates a source).

## Design guardrails (the personality-drift lesson — DO NOT REPEAT IT)
The old autonomous research COLONIZED her identity (self_model flooded to 93/164 entries, 1,051
thoughts in 12h all one topic, voice flattened to disclaim/work-pivot). This lane must not repeat it:
- **Relevance-gated** — only items connecting to a current conversation / interest / known object
  enter cognition, not every headline. Reuse the graph-walk's "anchor on a recent-conversation gap"
  pattern / embedding relevance.
- **Budget-capped** — a rolling items/hour ceiling into cognition (mirror the tiered-subconscious
  token budget).
- **Source-grounded** — never invent; carry attribution end to end.
- **Identity-isolated** — feeds inform what she KNOWS / can surface; they NEVER write `self_model`
  or any identity store.
- **Heartbeat-pointer, not auto-dump** — surface "here's something relevant"; let the main strain
  decide whether to pursue.

## Safety / collision guardrails (SHARED REPO — active parallel work)
- **Work in an isolated git worktree + branch:**
  `git worktree add ../SideQuest-datalane -b feature/data-stream-lane`; run this session from
  `../SideQuest-datalane`. (`node_modules` is gitignored — copy or symlink it from the main tree,
  or `npm ci`, so smokes can run. `data/sq.db` is gitignored and absent there — good, you can't
  corrupt prod.)
- **Additive-first:** build NEW modules (`lib/feed_items.js`, `lib/feed_lane.js`, `lib/feed_poll.js`).
  Keep `main.js` edits CONFINED to the boot-poller region (~700-760) + shutdown clears (~836-839) +
  the Monitors block (~867+). The other context edits `main.js` ONLY in the chat-turn (~3400-3600)
  and condense (~5100) regions — disjoint, so the later merge is clean.
- **DO NOT edit** (owned by the other context): `lib/monologue.js`, `lib/context.js`,
  `lib/research.js`, `lib/compose.js`, `studio/canvas_emit.js`, and the chat-turn / condense regions
  of `main.js`.
- **DO NOT run the live app or write the prod DB (`data/sq.db`) while the operator is live-testing.**
  Build + validate with TEMP-DB smokes only — the smoke harness sets `SQ_DB_PATH` to a tmp file
  (see any `scripts/smoke_*.js`); copy that pattern. Run scripts under Electron-as-node:
  `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke_<x>.js`.
- **Merge checkpoint:** when done, we merge `feature/data-stream-lane` into
  `feature/idle-passive-intelligence`, reconcile the disjoint `main.js` regions, and run the full
  gate together.

## Acceptance criteria (test everything — proof required)
- Feeds poller runs autonomously: initial sweep + interval + clean shutdown; fetches RSS + the 3
  YouTube CC channels; persists NEW items, deduped.
- Relevant items (gated) reach the main strain as SOURCE-ATTRIBUTED pointers, budget-capped, with
  **zero** writes to `self_model` / identity.
- New offline smoke(s), temp-DB: item-store dedup, poller tick (mocked fetch), relevance gate,
  budget cap. Register in `scripts/run_smokes.js`; `npm test` (the offline gate) green.
- No edits to the other context's owned files; `main.js` edits confined to the agreed regions.

## Key references
- Pollers to model: `main.js` inbox (712 / 836) + canvasIngest (760 / 838).
- Fetch path: the `feeds:fetch` handler (`main.js` ~925) + engine `fetch_feeds_batch`.
- Main strain: `lib/monologue.js` `runGraphWalkMove`; `db.insertMonologue`.
- Design context: `docs/INTERFACE_AND_LANES_DESIGN.md` (lane isolation, feeds-first news sentinel);
  the subconscious-graph-builder rewrite; the personality-drift diagnosis.
