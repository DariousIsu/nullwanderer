# Audit handoff — conversation lane → independent auditor — 2026-07-22

Written by the **conversation lane** (mandate: Zoe's communication, recall, personality, speed) at
Lucas's direction, for a fresh context running an **independent audit**. Treat every claim in here
as a hypothesis: each one comes with the query or command that checks it. Where I only smoke-tested
something, I say so — a green suite proves the shape of a change, never its effect.

A second Claude session (the **object-identity lane**) works this repo concurrently, on purpose.
Its handoffs and our couplings live in `docs/LANE_BOUNDARY_2026-07-21.md` — read it before
touching anything; it is the contract both lanes actually honor.

---

## 1. System map, minimum needed to audit

- **Zoe Lane** — Electron desktop AI companion, this repo (`main.js` is the spine, ~8k lines).
  **NX ECHO** — Python MCP engine at `C:\Users\azrae\Desktop\NX ECHO\nx-echo`, spawned by the app
  on HTTP port 8765, 546 tools. The app calls it through `lib/echo_suit.js`.
- **Front/Cortex:** a local model (gemma4:12b) is the *voice*; the cloud (gpt-oss:120b-cloud)
  *writes every reply* and does cognition. The local→cloud package is built by `lib/package.js`
  (order: identity, request, plan, references, manifest, tools, memory, grounding).
- **Reasoning-model channel contract** (the most load-bearing recent fix): ollama streaming
  delivers `message.content` → TagStreamParser (the `<think>/<say>` + `<echo-*>` tag grammar) and
  `message.thinking` → its own callback, RAW, scanned for complete tool tags, never spoken.
  Contract and both live failures documented at the top of `scripts/smoke_thinking_channel.js`.
- **Durable stores:** `data/sq.db` (turns, meta, directives, canvas docs/blocks — SQLite,
  **timestamps are epoch MILLISECONDS**), plus Echo's own DBs (the other lane's territory).
- **Boot logs:** `bootNN.log` at repo root. Current: `boot39.log` (live since ~14:57 Eastern
  2026-07-22). boot37 = the night chat broke; boot38 = channel-separation fix; boot39 = adds
  arg-shape feedback.

## 2. Current live state

| | state | how to check |
|---|---|---|
| Chat (social replies) | **verified fixed live** | §3.1 |
| Assignment → canvas document chain | chain closed; last run produced an **empty tab** (arg fumbling, §3.3) | §3.2, §3.3 |
| Arg-shape feedback (44f8052) | live on boot39, **not yet exercised by a real turn** | §3.4 |
| Meeting scribe digest | built + smoke-tested, **never run in a real meeting finalize** | next meeting is the test |
| Packaging command ("package that" → branded doc) | **not wired** — two open Lucas calls (where it lands; whether verification runs first) | `studio/doc_shapes.js`, `studio/cert_template.js` exist and are tested |
| Echo background `db_query`/`search_entities` | **intermittent `fetch failed`** under DB contention — filed to the other lane | `LANE_BOUNDARY_2026-07-21.md` §3.4 + addendum |

## 3. Claims made by this lane, and how to verify each independently

### 3.1 "Chat broke completely on 2026-07-21 night and is fixed"

Cause: my own first fix wrapped `message.thinking` in `<think>` and fed it to the tag parser; a
reasoning model narrates its own format, the parser read the mentions as real tags, and every
social reply became the literal `"..."`. Fixed in `8429274` (channel separation).

Verify (app can be running; open read-only):

```bash
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd -e "const db=require('better-sqlite3')('data/sq.db',{readonly:true}); for (const r of db.prepare(\"SELECT id,speaker,substr(content,1,120) c FROM turns WHERE id IN (9254,9256,9262,9264)\").all()) console.log(r.id, r.speaker, JSON.stringify(r.c))"
```

Expected: #9254 user "Good evening Zoe" → #9256 ai_said `"..."` (broken, boot37) versus
#9262 user "Good afternoon Zoe" → #9264 ai_said a real sentence (boot38, post-fix). The log line
`[main] CLOUD wrote the reply — … (+429ch reasoning)` in `boot38.log` is the same event from the
other side. The contract itself: `scripts/smoke_thinking_channel.js` (replays the live hijack).

### 3.2 "The artifact delivery chain is closed"

Eleven serial breaks between "write me a research paper" and durable blocks on canvas, peeled off
across seven live runs of the same request. The full list with commit hashes is the doc-comment
history in `scripts/smoke_thinking_channel.js`, `scripts/smoke_echo_batch_args.js`,
`scripts/smoke_arg_feedback.js`, and commits `c66f5c7 726fc00 92148b3 35467d3 9826eaa f3b5ad4
8429274 44f8052`. Durable proof: `canvas_docs`/`canvas_blocks` tables in `data/sq.db` hold the
`china_ai_announcements` tab's blocks, which survived an unclean stop and replay on boot.

Audit angle worth taking: I verified each break by re-running the SAME request. An independent
run with a *different* assignment would test generalization — the Bloomberg run (§3.3) suggests
tool-argument knowledge is the remaining weak point, not the chain itself.

### 3.3 "The Bloomberg brief run: chain held, document empty"

2026-07-22, first assignment on boot38 (`turns` #9265 onward). Tab
"Bloomberg Government AI Team Follow-up Brief" opened + mirrored; then hops 1–4 all died on
`db_query` args — first the literal `…` placeholder, then guessed keys `{"name": …}` — because
the error feedback never stated the signature. Zero blocks written. Verify: `boot38.log` around
`[main] echo chain hop`, and the tab's block count in `data/sq.db`.

### 3.4 "An arg failure now teaches the arg shape" (44f8052 — live but unexercised)

`lib/echo_suit.js` now indexes tool schemas at attach (`_toolIndex`), and `argShape(name)` appends
a compact signature to invalid-JSON args and Echo-side argument rejections — never to runtime
failures. Offline proof: `scripts/smoke_arg_feedback.js` (replays both live failures). **No real
turn has exercised it yet** — the first fumbled tool call on boot39 is the live test; grep
`boot39.log` for `args: {`.

### 3.5 Watch items an auditor is well-placed to check

- **Turns 9235–9256** hold several `"..."` ai_said rows from the broken night — the renderer's
  sheep-panel latch (`memory: reply-delivery-path`) means a *correct DB row can still fail to
  reach Lucas*. DB-side checks alone cannot close that loop; the renderer path is
  unaudited by me beyond the latch fix.
- **`route-obs` logs only the FIRST error per call shape.** Absence of repeat log lines is not
  absence of repeats. Frequency questions need the `route_obs` store, not the log.
- **The empty Bloomberg tab is still in `canvas_docs`.** Deleting it is Lucas's call, not ours.
- The `<echo-do>` UNCLOSED reporter may cry wolf on narration echoes in the thinking channel
  (known, deferred). A single UNCLOSED line is a flag to read in context, not a confirmed loss.

## 4. Open items owned by this lane

1. **Bloomberg brief re-send** — the pending end-to-end test of §3.4. Bar: contract block in full
   sentences on the tab, then filled sections, surviving restart.
2. **Packaging command** — operator-triggered "package that" onto `cert_template` STYLE via a
   third renderer (`renderCertificate`/`renderReport` are verdict-keyed, unsuitable for prose).
   Blocked on two Lucas decisions: landing place (file beside certs vs canvas tab) and whether
   the verification pass runs first.
3. **Scribe digest in a real finalize** — rebuild window for the 2026-07-21 Rainey Huddle is
   saved in meta `scribe_rebuild_window`.
4. **Directives live test** — say a standing instruction ("from now on always cite the source for
   a number"); expect `[directive] RECORDED` in the log and a row in `directives`.
5. **Subconscious autonomy** — designed (`docs/SUBCONSCIOUS_AUTONOMY_DESIGN.md`), not built.

## 5. Traps that produced MY false alarms — do not repeat them

1. **Epoch MS.** `sq.db` timestamps are milliseconds. Treating them as seconds dates everything
   to 1970-and-change and "proves" capture is dead. I did this twice.
2. **SQLite `LIKE` treats `_` as a wildcard.** My first count of the resolver's false rows was
   122; the real count was 56. Escape or use `instr()`.
3. **Eastern rendering is not an off-by-one.** All display time is `America/New_York`
   (`lib/tz.js`); a date that looks shifted against UTC is usually correct. His calendar runs
   -04:00 (EDT), not fixed EST.
4. **`TagStreamParser` exposes `p.thought`/`p.say`/`p.mode`** — not `p.think`. `mode==='post'`
   means complete.
5. **Smokes:** `npm test` is the curated offline gate (288 suites at last green run).
   `smoke_editor_roundtrip` and `smoke_covered_union` need the LIVE app/DB and flake when it's
   down or contended — run them standalone before calling them broken. Direct runs:
   `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd scripts/<name>.js`.
6. **Google Meet codes are REUSED across weeks.** Anything keyed on meet code without
   `ts >= gmeet_started_at` mixes meetings.
7. **Non-ASCII characters in regex literals** have bitten this repo three times. If a pattern
   "can't possibly be failing", hex-dump it.
8. **Coverage counts BODIES, never people.**
9. **PowerShell 5.1 mangles embedded double quotes** passed to native commands — use `git commit -F <file>`.

## 6. Operating rules that bind every context in this repo

- **Parallel lanes are deliberate.** Stay in yours; `git add` NAMED FILES ONLY (never `-A` —
  the other lane's in-progress work is always in the tree). Append-only history: no rebase on
  shared branches (one rebase already orphaned hashes Lucas had been given).
- **Reboots are Lucas's call.** Never restart the app unprompted — and never under another
  session's live test.
- **Never write key VALUES** anywhere (Echo keychain holds them; `get_key` 3-tier).
- **Outbound is gated:** email send kill-switch is ON by design; Meet chat gate closed by default
  (`ZOE_MEET_CHAT`), the AI-disclosure intro stays on.
- Lucas's standing preferences: no artificial caps that truncate model output (size the prompt to
  the window); all displayed time Eastern; she writes plain markdown and STOPS — packaging is his
  command; user input creates objects as *unverified* pending a real source.
- The prompt-fix pattern that has repeatedly worked here: **state the mechanical fact, don't
  exhort.** An unsatisfiable rule gets ignored and its failures read as dishonesty.

## 7. Toolkit crib sheet

```bash
# offline gate (288 suites at last green run)
npm test
# lint
npm run lint
# read the live DB without contention
ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd -e "const db=require('better-sqlite3')('data/sq.db',{readonly:true}); ..."
# engine health
curl -s http://127.0.0.1:8765/health
# the turn-path signals in the current boot log
grep -E "turn-router|CLOUD wrote|chain hop|saga_canvas|mirrored her|UNCLOSED|args: \{" boot39.log
```

Boot logs are at repo root; `boot39.log` is current. The conversation lane keeps a persistent
monitor on it — if you start your own, don't also restart the app.

---

*Correct anything here you find to be wrong — that is the audit working. If you need this lane's
reasoning behind a decision, `docs/LANE_BOUNDARY_2026-07-21.md` and the doc-comments at the top of
the `scripts/smoke_*.js` files added this week carry most of it.*
