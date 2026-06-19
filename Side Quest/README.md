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

Single model, both chat and the between-turn inner monologue:
**`hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M`**
(Mistral-Small-3.1-24B finetune, decensored, tool/instruction/RP-trained). ~14.8 GB
VRAM on a 20 GB RX 7900 XT. Mistral-3 arch unlocks KV-cache quantization.

Recommended env: `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`.
All call sites use `num_ctx: 8192` (uniform, to avoid single-model reload thrash).

> History: started on Stheno-v3.2-Q6 (8B chat) + gemma3-abliterated:4b (subconscious).
> Swapped to single Dans-24B — the 4B was ~72% attractor-slop and Stheno (Llama-3 arch)
> confabulated tool calls + couldn't use KV-quant.

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
(chat-bot replies). Identity in `meta` (chosen_name = Zoe Lane).

### Tools Zoe can use
- **Web** — `<navigate>`, auto search (curiosity/boredom), page fetch.
- **Browser** (co-pilot of the user's real Chrome via Playwright CDP, port 9222) —
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
  outbound mail (Gmail SMTP via nodemailer) toward the publication goal. She sends
  directly — no approval gate — with a per-day cap as a runaway backstop and a full
  `email_log` audit trail.
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

4. **Model** — pull the Dans model and set the KV-cache env (persist these on the
   machine so Ollama picks them up):

   ```
   ollama pull hf.co/bartowski/PocketDoc_Dans-PersonalityEngine-V1.3.0-24b-GGUF:Q4_K_M
   setx OLLAMA_FLASH_ATTENTION 1
   setx OLLAMA_KV_CACHE_TYPE q8_0
   ```

5. **Credentials** — copy `.env.example` to `.env` and fill what you want enabled:

   - **Email** (`ZOE_EMAIL_USER` / `ZOE_EMAIL_PASS` / `ZOE_EMAIL_FROM`): Gmail needs a
     16-char **App Password**, not the account login password. `ZOE_EMAIL_DAILY_CAP`
     bounds runaway sends.
   - **Discord** (`DISCORD_BOT_TOKEN` / `DISCORD_OWNER_ID`): bot token from the Discord
     developer portal (enable the *Message Content Intent*), plus your own user id.

   `.env` is gitignored. Tools whose creds are blank are simply hidden — the app runs fine without them.

## Run

```
npm start
```

The app boots, warms the model, starts the self-scheduling ticker, connects the Discord
bridge (if configured), verifies email creds, and (if Chrome is open with
`--remote-debugging-port=9222`) auto-reconnects the browser layer.

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
