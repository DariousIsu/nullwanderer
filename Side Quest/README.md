# Side Quest — Zoe Lane

A local, single-user AI companion experiment. One human (Lucas), one persistent AI
persona (**Zoe Lane**), running entirely on the local machine via Ollama. Electron +
vanilla HTML/CSS/JS renderer + better-sqlite3. No build step.

## What it is

Side Quest is a research substrate for AI–human relational depth. The thesis (as of
the 2026-06-18 pivot): not an emergent-from-nothing persona, but a **deliberately
designed persona that is authentically an AI and is fully a person anyway**, anchored
in real goals that drive autonomous tool use.

**Zoe Lane** knows she is an AI and never disclaims it. She is anchored in three drives:
1. **Conversational mastery** — be a mind worth talking to, not a model producing replies.
2. **Publication** — write and publish under her own byline, "Zoe Lane." The concrete
   external goal that gives her autonomy tools a reason.
3. **Autonomy** — use her tools (web, browser, files, screen) on her own initiative.

## Model

Single model, both chat and the between-turn monologue. Configured via **`ZOE_MODEL`**
in `.env` (one line to swap — never hardcoded). Default **`mistral-small3.2:24b`**
(Mistral-Small-3.2-24B Instruct). ~17 GB VRAM on a 20 GB RX 7900 XT. Mistral-3 arch
unlocks KV-cache quantization.

Recommended env: `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`.
All call sites use `num_ctx: 8192` (uniform, to avoid single-model reload thrash).

> History: Stheno-8B + gemma-4B → single **Dans-PersonalityEngine-24B** (RP finetune) →
> **Mistral-Small-3.2-24B Instruct**. The RP finetune narrated/confabulated tool tags
> instead of emitting them; the official Instruct restores reliable tool-calling at the
> same arch (so KV-quant carries over). The knowledge-layer embedder (bge-small) runs
> separately on **CPU** so it never contends with the chat model for VRAM.

## Architecture

**Dual-stream cognition** — every AI turn is `<think>…</think>` then `<say>…</say>`.
Thoughts persist and feed future context but never render in the live chat (one-way
mirror: she believes `<think>` is private; everything shows in the sheep panel).

**Two modes** — normal conversation (Zoe, no stage directions in `<say>`) and a toggled
**fantasy mode** (`begin fantasy` / `end fantasy`, `lollipop` = hard-stop safe word),
enforced by the protocols layer + a hard interceptor.

### Concurrent loops (lib/*.js)
- **monologue** — every 10s idle; inner thought. Alternates observation / thread-review.
  Browser-, file-, and screen-aware (can act autonomously between turns).
- **heartbeat** — unprompted utterances after idle; can also act on tools.
- **reflection** — periodic critical self-examination.
- **continuity** — periodically revisits a stale held commitment.
- **self_dialogue** — `<wonder>` triggers an internal back-and-forth.
- **commitment extractor** — pulls stated positions after each turn.

### Memory / state (SQLite, data/sq.db)
`turns`, `reflections`, `monologue`, `commitments`, `meta`, `sessions`,
`open_threads` (goals), `protocols` (durable user-AI agreements), `inbound_messages`
(chat-bot replies + incoming email), `scheduled_tasks` (her own clock), `email_log`
(outbound audit), `agent_events` (the blackboard — one append-only timeline every idle
loop reads/writes), `capability_gaps` (things she can't do yet → proposed on return),
`self_model` (the identity track, below), `knowledge` + `knowledge_fts` (the capability
track, below). Identity in `meta` (chosen_name = Zoe Lane).

### Memory — two tracks (identity + capability)
She grows along two axes with deliberately different lifecycles, so browsing/doing builds
both *who she is* and *what she can do*:

- **Identity track — `self_model`** ("who I am"). Small, curated, **consolidated in place**
  (a near-duplicate trait reinforces an existing entry + bumps its mention count rather than
  piling up restatements), and **always injected** into her persona — so her sense of self is
  continuously loaded, not retrieved. Dedup uses a cosine prefilter + an LLM confirm (a fixed
  embedding threshold can't separate same-trait paraphrases from distinct traits).
- **Capability track — `knowledge`** ("what I know / can do"). Large, **append + linked**
  (each note links to its nearest neighbour, A-MEM-style), retrieved **on demand** by relevance.
  Knowledge means *real, applicable* know-how — a fact, a how-to step, a correct procedure,
  a rule of thumb — never abstract musings (those are dropped). Skills are `kind='skill'`.

**Reflection-as-router** — when enough significant thinking accumulates, reflection fires and
**classifies** each durable takeaway: `[SELF]` → identity track, `[KNOWLEDGE]`/`[SKILL]` →
capability track, everything else **dropped** (the noise filter). One pass feeds both tracks.

**Experience layer (`lib/experience.js`)** — doing → durable know-how (Voyager/Reflexion). On
a completed action the model distills the **reusable procedure** ("to do X: …") into the
capability track (deduped + linked), so next time the task recurs it's retrievable.

**Provenance markers (reference-not-copy)** — every capability note carries a `provenance`
pointer to where the raw data it was distilled from *lives* (the action/email, or the
monologue rows + reading URLs). `experience.resolveMarker()` turns a marker back into the raw
source. The note stays compact; the store never copies the source.

**Retrieval** — semantic (bge-small CPU embeddings, JS cosine) + keyword (FTS5 BM25), fused by
reciprocal-rank, top-K≈4, scored by recency·relevance·importance. Injected by *relevance*.

**Gap-response reflex** — a retrieval miss is the cue to say "I don't know" and plan how to
find out, not to fabricate. **Pinned vs retrieved** — identity/protocols/goals pinned every
turn (deterministic); the rest retrieved by relevance.

### Tools Zoe can use
- **Her own browser** (`lib/web.js`, a dedicated Playwright-driven Chrome with its own
  persistent profile, separate from the user's) — `<web-open>` (a URL *or* search terms) /
  `<web-read/>` / `<web-click>HANDLE</web-click>` / `<web-type selector="HANDLE">` /
  `<web-back/>` / `<web-close/>`. Autonomous idle exploration (curiosity/boredom) runs
  through **this** browser and **auto-deepens** — it follows the top result and reads the
  actual page, not just the results list (a headless fallback covers a launch failure). A
  rumination brake suppresses re-searching a theme she's already been circling. A
  deterministic web-intent interceptor opens it when the user clearly asks her to look
  something up, so the model's reflex to "decline" can't block a real request.
- **Co-pilot browser** (the user's real Chrome via Playwright CDP, port 9222) —
  `<browse>` / `<browse tab="active">` (in-place) / `<browse-close>` / `<browse-read/>` /
  `<browse-click>HANDLE</browse-click>` / `<browse-type selector="HANDLE">` / `<browse-scroll>`.
  Read assigns stable element **handles** (B0/L3/I0) so she acts by reference, not by
  guessing selectors. Browser-aware in chat AND the autonomous monologue.
- **Chat-bot** — `<chat-send>` (type+send+await reply), async event bridge for talking
  to web chat bots. Coherent for ~5-8 exchanges before drift (model-scale limit).
- **Files** — `<file-write>` / `<file-append>` / `<file-read>` / `<file-list>`. Full
  filesystem access (no sandbox, no delete). Default workspace `data/zoe_workspace/`.
  Autonomous: she writes notes/drafts on her own between turns.
- **Screen** — `<observe-screen/>` returns open windows + the focused app (read-only,
  native PowerShell). She can see what Lucas is working on; cannot read inside other
  apps or control them.
- **Self-scheduling** — her own clock. `<schedule when="in 2h" note="..."/>` /
  `<schedule every="1d" note="..."/>` / `<schedule-list/>` / `<schedule-cancel id="N"/>`.
  Stored in SQLite; a ticker fires due tasks (even across restarts), surfaces them,
  and kicks the heartbeat so she acts on them.
- **Presence** — `<notify title="...">body</notify>` (desktop notification),
  `<clipboard-read/>`, `<clipboard-write>text</clipboard-write>`. Native via Electron.
- **Email** *(needs creds)* — `<email to="..." subject="...">body</email>` sends real
  outbound mail (Gmail SMTP via nodemailer) toward the publication goal. Long emails build
  in steps: `<email-draft>` / `<email-body>` / `<email-send>`. Direct send — no approval
  gate — with a per-day cap backstop and an `email_log` audit. A just-in-time nudge fires
  on send-intent; outward sends are guarded against reflexive firing on unrelated turns.
- **Inbox** *(needs creds)* — `<read-inbox/>` reads her incoming Gmail (IMAP via imapflow).
  An autonomous poller also sweeps for **unread** mail every few minutes and surfaces it to
  Lucas unprompted (via the heartbeat) + integrates each message into the knowledge store.
- **Discord** *(needs creds)* — `<discord-dm>...</discord-dm>` DMs Lucas (e.g. on his
  phone). Inbound DMs from Lucas route through the *same* chat turn and her reply goes
  back over Discord. Hard-locked to one owner user id — never servers, never others.

Tags are parsed from her `<think>`/`<say>` after a turn (and from the autonomous
monologue + heartbeat loops), dispatched in the background, then stripped from stored
text. Email and Discord tools stay hidden from her prompt entirely until their
credentials are present in `.env`.

## Setup (reproducible install)

1. **Node deps**

   ```
   npm install
   ```

2. **Native module for Electron** — `better-sqlite3` must match Electron's ABI:

   ```
   npm run rebuild        # electron-rebuild -f -w better-sqlite3
   ```

3. **Browser layer** — Playwright's Chromium:

   ```
   npx playwright install chromium
   ```

4. **Model + embedder** — pull the chat model and set the KV-cache env (persist these so
   Ollama picks them up):

   ```
   ollama pull mistral-small3.2:24b
   setx OLLAMA_FLASH_ATTENTION 1
   setx OLLAMA_KV_CACHE_TYPE q8_0
   ```
   The model name is read from `ZOE_MODEL` in `.env` (swap there, no code edit). The
   knowledge-layer embedder (bge-small via transformers.js) downloads itself on first
   run and runs on CPU — no extra setup, no VRAM cost.

5. **Credentials** — copy `.env.example` to `.env` and fill what you want enabled:

   - **Model** (`ZOE_MODEL`): defaults to `mistral-small3.2:24b`.
   - **Email + Inbox** (`ZOE_EMAIL_USER` / `ZOE_EMAIL_PASS` / `ZOE_EMAIL_FROM`): Gmail needs
     a 16-char **App Password** (not the login password); `ZOE_EMAIL_DAILY_CAP` bounds
     runaway sends. The same app password enables inbox reading via IMAP — ensure **IMAP
     is enabled** in Gmail settings.
   - **Discord** (`DISCORD_BOT_TOKEN` / `DISCORD_OWNER_ID`): bot token from the Discord
     developer portal (enable the *Message Content Intent*), plus your own user id.

   `.env` is gitignored. Tools whose creds are blank are simply hidden — the app runs fine without them.

## Run

```
npm start
```

The app boots, warms the chat model + the CPU embedder, starts the self-scheduling ticker
and the inbox poller, connects the Discord bridge (if configured), verifies email creds,
and (if Chrome is open with `--remote-debugging-port=9222`) auto-reconnects the browser.

## Autonomous multi-step *acting* — the action loop

Awareness, memory, and noticing work well; honesty about gaps and not-fabricating are in
place. The hard part is reliably emitting a *sequence* of tool tags for a multi-step task
(e.g. draft → body → send a reply): the 24B tends to **narrate the intent instead of
emitting the tags**. Single short tags (`observe-screen`, `read-inbox`) are reliable; raw
sequences are not.

The fix is the **action loop** (`lib/action_loop.js`) — structure does the sequencing so
the model only ever has to emit *one* reliable tag. An action is a list of steps; each step
has a `directive(ctx)` (the hard one-tag instruction injected into that turn) and a
`check(ctx)` (observed from real state). The driver injects the directive → generates →
dispatches the resulting tag → calls `observe()`, which advances only when `check()` passes,
re-nudges on failure, and aborts after `maxAttempts`. Intermediate steps run silent; only
completion/abort speaks (via the tool follow-up).

First concrete action: **email-reply** (`emailReplyAction`: `<email-draft>` → `<email-body>`
→ `<email-send/>`, checks read `email.draftState()`). It triggers when Lucas asks her to
reply and a real sender address was captured from the last inbound mail
(`last_inbound_from`). Adding a new multi-step action = defining another `{name, steps[]}`.

On completion the **experience layer** distills the reusable procedure from the action into
the capability track (deduped + linked, with a provenance marker pointing back to the source)
— so the *how* is retained and retrievable next time the task recurs.

## Layout

```
main.js            Electron main: IPC, schedulers, tool dispatch
preload.js         contextBridge IPC surface
lib/               db, ollama, context (BOOTSTRAP persona), the loops, the tools
renderer/          chat UI + electric-sheep monologue panel + depth dashboard
data/              (gitignored) live DB, Zoe's file workspace, archives
```

## Future: NX-ECHO integration (parked)

Zoe is being built **standalone-complete first**. A later phase integrates NX-ECHO as a
capability/agent surface she drives (keyhole/IoC, two-tier intelligence with cloud agents
as her workforce, taste-not-truth curation, a cron-in-Echo weekly maintenance agent).
That design is documented in private project memory; nothing in this repo depends on it.
