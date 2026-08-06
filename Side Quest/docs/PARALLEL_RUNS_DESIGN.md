# Parallel Research Runs — Build Plan (DESIGN ONLY)

Status: **design, not built.** Author: diagnosis session 2026-07-08. Nothing here is committed.
Goal: run **multiple research targets — and multiple projects — concurrently**, bounded by an adaptive
governor, with **reserved lanes for the user and any live meeting**, without hijacking the interactive tab
and without spawning extra Chrome processes.

Backed by: a total-codebase concurrency audit (§7) + external validation of the three technical unknowns (§2).

---

## 1. Why this is feasible (the diagnosis that unblocks it)

- **Inference is already cloud-parallel.** Research passes run their LLM in the cloud, not the local GPU:
  the operator hits `ollama.com` directly with a bearer token ([lib/operator.js:33](../lib/operator.js));
  `-cloud` names are proxied off-GPU. N passes parallelize at the inference layer **today**.
- **The single browser tab is the only serializer.** `page`/`registry`/`counter` are module-level singletons
  ([lib/web.js:60](../lib/web.js)); every new tab hijacks the global `page` via the follow-the-front-tab
  handler ([lib/web.js:188](../lib/web.js)) and `syncActivePage` ([lib/web.js:201](../lib/web.js)).
- **The cheap path is N tabs in the ONE existing context** (~95–233 MB/tab, shared logins) — NOT N Chrome
  processes.
- **The focus model allows exactly one project** — a new one *deletes* the old
  ([lib/focus.js:98](../lib/focus.js)). Multiple projects need a scheduler on top of the tab-pool.

Binding constraint is **not** hardware — it's (a) correctness (per-tab + per-focus state) and (b) the
**cloud plan's concurrency cap** (§2).

---

## 2. External validation (real outside research)

- **Playwright multi-page is safe in our setup.** Playwright is "not thread-safe" and persistent contexts
  are "not designed for concurrent execution" — but those warnings are about parallel *threads/processes*
  sharing a profile. **Node is single-threaded**; concurrent `page.goto()` on different tabs is cooperative
  async on one event loop, which *is* the required synchronization. Multiple tabs in one persistent context,
  driven via async in one process, is a supported pattern. → the tab-pool (§4) is sound.
  Sources: [Playwright multithreading](https://playwright.dev/java/docs/multithreading),
  [persistent-context concurrency gist](https://gist.github.com/mezhgano/5b311f33a52652628c419d9532dc17fd).
- **The TRUE cap is the Ollama plan, and it's small + ambiguous.** Ollama **Pro = 3 concurrent**; beyond
  that, requests **queue FIFO then get rejected** when the queue fills. The exact semantics — 3 concurrent
  *requests* vs 3 distinct *models* (where same-model calls may serialize) — are **undocumented and have
  changed more than once**. Every research web-lane uses the *same* model (`gemma4:31b`), so if it's
  per-model, same-model passes could serialize. → **the governor must be ADAPTIVE** (probe up, back off on
  queue-reject/429), not hard-assume 3×. And each **two-lane deep pass already burns 2 cloud slots**, so the
  budget is spent by *lanes*, not projects. Sources: [Ollama pricing](https://ollama.com/pricing),
  [Ollama FAQ](https://docs.ollama.com/faq),
  [Cloud Free vs Pro 2026](https://dev.to/amareswer/ollama-cloud-free-vs-pro-usage-limits-pricing-what-you-actually-get-2026-3ieo).
- **RAM is fine at ~3 tabs.** Chrome ~95–233 MB per background tab; 8 GB is the practical floor for 20–40
  tabs; we have ~5.5 GB free — comfortable for 2–3 research tabs, and Memory Saver discards idle ones.
  Source: [Chrome RAM per tab 2026](https://www.superchargebrowser.com/library/chrome-ram-usage-per-tab-2026/).

**Net:** real parallelism is achievable, but the ceiling is the **~3 cloud slots**, not the browser or RAM.
Expect a real but modest speedup (≈2–3×) *when the user/meeting aren't consuming slots*, degrading gracefully
to serial when they are — which is exactly the desired priority behavior.

---

## 3. Architecture: two layers + a lane governor

- **Layer 1 — Browser tab-pool** (§4): per-session `{page, registry, counter, passive}`; a capped pool of
  tabs inside the single persistent context; pool tabs walled off from the interactive/meeting tab.
- **Layer 2 — Multi-project scheduler** (§5): focus model single-pointer → small capped set; the driver
  round-robins passes across active foci, each pass leasing its own tab + a cloud slot.
- **The lane governor** (§6): the load-bearing coordinator. Governs TWO pools — **browser tabs** and **cloud
  slots** — with **priority tiers and reserved lanes** for the user and any live meeting. This explicitly
  replaces the implicit protection that the single serial monologue tick provides today
  ([lib/monologue.js:843](../lib/monologue.js)) — which concurrency removes.

Layer 1 alone buys parallel targets within a run and is the riskiest correctness surface → validated first.

---

## 4. Layer 1 — Browser tab-pool

### 4a. Per-session state (`lib/web.js`)
`Session = { page, registry, counter, passive, pooled }`. Keep a module `globalSession` = the interactive/
meeting tab; **every existing caller uses it by default** (source-compatible). Refactor the primitives —
`open, read, click, clickText, type, scroll, back, openTopResult, pageImages, screenshot, runRecipe` — to
take an optional `session` (default `globalSession`) and use `session.page/registry/counter`. Keep global:
`ensure, syncActivePage, cookies, isConnected, close`.

Per-session `registry`/`counter` is **mandatory**: with two tabs interleaving, tab A's `L3` resolves to tab
B's locator → wrong-element click (audit item #1).

### 4b. The pool (`lib/web_pool.js` — pure coordinator + thin `lib/web.js` hooks)
`acquireTab()` → `context.newPage()`, wrap in `Session{pooled:true}`, register in a `Set<Page>`; block (async
semaphore) at cap; return a lease. `releaseTab()` → close/park + free slot. Reuse the bounded-worker shape in
[lib/forecast_assess.js:70](../lib/forecast_assess.js); the pure semaphore/lease logic lives in `web_pool.js`
for offline smokes. Copy the concurrency-aware **counter** idiom from [lib/email.js:29](../lib/email.js)
(the audit's named template) rather than a drop-if-busy boolean.

### 4c. Protect the interactive/meeting tab (CRITICAL — audit items #1, #5, #6)
- `context.on('page')` ([lib/web.js:188](../lib/web.js)): **early-return** (don't reassign global state) when
  the new page is in the pool `Set`.
- `syncActivePage` ([lib/web.js:201](../lib/web.js)): skip pool pages when picking the front tab.
- **Global-teardown guard:** `close()` ([lib/web.js:473](../lib/web.js)) and `killStaleProfileChrome()`
  ([lib/web.js:109](../lib/web.js)) must **never** fire while a reserved lane is live. A research
  `<web-close/>` closes only its own pooled tab, never the shared context.
- `isInteractiveLocked()` — true during a Meet/attend session or record-by-demonstration; while locked the
  pool doesn't grow and pool tabs never take focus.

### 4d. Wire autonomous callers to lease a tab (contained blast radius)
`operatorTools.web_search/open_page/browser_read/see_page` ([main.js:6091](../main.js)),
`readHerBrowserDeep` ([main.js:6037](../main.js)), the two-lane web lane ([main.js:7287](../main.js)), the
directed passes. Later/optional: excavate.js, byline.js, monologue Puller image-match, play_session (own
pinned tab). **Untouched (stay on `globalSession`):** gmeet.js, chat "open this for me"
([main.js:3458](../main.js)), media_cc, heartbeat/monologue `<browse>` redirects, record-by-demonstration.

### 4e. Config + flag
`browserPoolConfig()`: `enabled` (default **OFF**), `maxTabs` (default 3), `pauseDuringMeeting` (true).

### 4f. Smokes (`smoke_web_pool.js`, offline, mock page factory)
Session isolation; acquire/release + cap + wait; pool-page exemption from a mocked `context.on('page')`;
`isInteractiveLocked` blocks growth; a pooled `close` never tears down the shared context.

### 4g. Stage-1 exit proof (live)
Flag ON, open a Meet, kick a run → two autonomous tabs advance in parallel; the Meet tab is **never** stolen.

---

## 5. Layer 2 — Multi-project scheduler

### 5a. Focus model: single pointer → capped set (`lib/focus.js`)
Add `directed_focus_ids` (JSON array meta, cap default 3). `setFromDirective` **adds** a distinct directed
focus instead of `clear('superseded-by-new-directive')` ([lib/focus.js:108](../lib/focus.js)); beyond cap,
offer to queue. Per-run state (`recordOutcome`/`_loadState`/`_saveState`, [lib/focus.js:214](../lib/focus.js))
must be **per-focus**, not the one global `focus_state` blob (audit item #2). Keep `getCurrent()` (primary)
for back-compat; add `getActiveDirected()` → array. Keep idempotent-dedup + "user task displaces a musing."

### 5b. Driver: single tick → round-robin (`main.js` directedFocusTick [main.js:6238](../main.js))
Iterate `getActiveDirected()`; launch up to the governor's allowance concurrently, each focus gated by its
**own** in-flight flag (replace the single global `directedStepInFlight` [main.js:6234](../main.js), audit
item #3). Each pass leases a tab + a cloud slot from the governor.

### 5c. Per-focus state isolation (audit item #4 — exact sites found)
Re-key or lock the single-run meta the audit pinned: `research.last_focus_id`
([main.js:6878/7043](../main.js)), `research.last_dossier` ([main.js:6877](../main.js)),
`research.last_referenced_focus_id` ([main.js:6932](../main.js)) — else "expand/track the last run" aliases
to whichever focus wrote most recently. Per-focus keys `focus.<id>.*` and files `notes/directed-<id>*.md` are
already id-namespaced → **safe, don't touch** (§7 safe-list).

### 5d. Status/UI
Activity poll + deliverable index must report **N active projects** (today both assume one).

### 5e. Smokes
`smoke_focus_multi.js` (add/cap/dedup/stop-one; getActiveDirected; new project doesn't kill a running one;
per-focus run-state isolation). `smoke_scheduler.js` (round-robin, per-focus in-flight, governor allowance).

### 5f. Stage-2 exit proof (live)
Cap raised; two distinct explicit projects both appear in `getActiveDirected()` and advance simultaneously
(interleaved `[directed] #A`/`#B`), each on its own tab.

---

## 6. The lane governor — dynamic, demand-driven preemption (Lucas's model)

**A "lane" = one worker = 1 browser tab + its model/tool calls.** N lanes (default 3, matching the Ollama
concurrency cap). NOT static-reserve — lanes default to work and are **preempted on demand**, then returned.

**Default (idle — no meeting, no live user turn):** ALL 3 lanes run work = active **projects** + **database
cleaning/expansion**. Nothing sits idle.

**On demand (preemption):**
- **Meeting starts** → **1 lane** peels off to the meeting (join/scribe/caption/answer).
- **User asks a question** (any time, incl. during a meeting) → **another lane** peels off to answer it →
  during a meeting that's **two lanes** engaged (meeting + user), as specified.
- **Question answered / meeting ends** → the lane(s) return to work.

**Yield order — which lane surrenders first when one is needed** (lowest priority first):
1. **Database cleaning/expansion** (always the first to give up a lane).
2. **Projects, lowest-priority-first** (`yellow` yields before `orange` before `red`).
Interactive (user) and meeting are the top-priority *demanders*; they never yield to research.

**Preemption timing (open detail — §11 Q1):** to free a lane for a user question, the governor either (a)
lets the yielding lane's current model step finish (a few seconds, no work lost) or (b) aborts it (instant,
re-run later). Proposed default: (a); escalate to (b) only if the latency is felt.

**Adaptive sizing (Ollama cap is ambiguous, §2):** N seeds at 3; the governor **backs off on
queue-reject/429** and probes back up — never hard-assumes a fixed 3×. NOTE: a two-lane *deep* pass consumes
**2 model slots** for one target, so it costs more than one lane's share of the cloud budget (§11 Q2).

`governorConfig()`: `lanes` (default 3, adaptive), `yieldOrder` (`['database','projects:asc']`),
`preemptAbort` (false = finish current step).

Smoke `smoke_governor.js` (pure): idle → all lanes on work; meeting preempts 1; user-question preempts a 2nd;
yield order (database → lowest-priority project → highest); release returns lanes to work; backoff on reject.

---

## 7. Total-codebase inventory (confirmation everything is factored in)

Swept `lib/`, `main.js`, `studio/`, `renderer/`, `scripts/`, `sidecar/`.

### MUST-HANDLE-OR-IT-BREAKS
1. **`lib/web.js` single `page`/`registry`/`counter` + `syncActivePage`** ([:60](../lib/web.js),[:201](../lib/web.js),[:188](../lib/web.js)) — per-session or clicks land on the wrong tab. **Hard blocker.** → §4a/4c.
2. **`lib/focus.js` `current_focus_id` + `focus_state` single pointers** ([:45](../lib/focus.js), all of getCurrent/setCurrent/recordOutcome) — per-focus run-state needed. **Hard blocker.** → §5a.
3. **`directedStepInFlight` + single `directedDriverTimer`** ([main.js:6234/6233](../main.js)) — one driver, one focus/tick; the 2nd focus's slice is dropped. → §5b.
4. **`research.last_focus_id` / `last_dossier` / `last_referenced_focus_id`** ([main.js:6877-6878/6932/7043](../main.js) + readers) — alias across concurrent focuses. → §5c.
5. **`web.close()` + `killStaleProfileChrome()`** ([:473](../lib/web.js),[:109](../lib/web.js)) — global teardown/kill must never fire while a reserved lane is live. → §4c.
6. **Meeting + user browser access** (gmeet.js ensure/read; [main.js:3458-3497/6037-6112](../main.js); media_cc [:259-327](../lib/media_cc.js)) — must be reserved preemption-priority lanes; today only de-conflicted by the serial monologue tick. → §6.
7. **Cross-subsystem drop-guards** (monologue.js [:75/:78](../lib/monologue.js); heartbeat [:43](../lib/heartbeat.js); reflection [:130](../lib/reflection.js); continuity [:16](../lib/continuity.js); self_dialogue [:24](../lib/self_dialogue.js)) — if they share the browser with a research lane, convert drop→queue or they starve. → governed via §6 tiers.

### SECONDARY (bottleneck / ordering, not corruption)
- **`echo_suit` dispatch is a single socket** ([lib/echo_suit.js:400/1082](../lib/echo_suit.js)) — parallel deep-lane callers serialize on it. Not corruption, but it caps the parallelism benefit for Echo-heavy passes; worth measuring, not blocking.
- **Canvas emits funnel through one engine RPC** ([main.js:2629-2659](../main.js)) — distinct `tab_key`s so blocks don't cross, but verify the sidecar RPC is reentrant under interleaving.
- **`lib/browser.js` shared `tabContext` `activeTab`/`lastMentioned` pointer** ([:52](../lib/browser.js)) — single pointer two co-pilot readers could fight over (the shared :9222 Chrome, not her research browser).

### SAFE AS-IS (do NOT over-engineer)
`studio/canvas_emit.js` (pure); per-focus meta `focus.<id>.*` + files `notes/directed-<id>*.md` (id-namespaced);
canvas Sets keyed by focus/block ([main.js:2625/2645](../main.js)); `lib/browser.js` `elementRegistry`
per-page Map ([:630](../lib/browser.js)); `lib/db.js` synchronous single-connection better-sqlite3 + WAL (no
write corruption; logical last-writer-wins is covered by item #4); `lib/email.js` `inFlightSends` counter (the
template to copy); `lib/inbox.js` mailbox lock; `lib/screen.js` OS `desktopCapturer` (independent of the
browser — no reserved lane needed); `lib/doc_store.js` idempotent by `ref`.

**Completeness caveat:** the ~200 `scripts/smoke_*`/CLI harnesses that `require('./lib/web'|'./lib/focus')`
drive the same singletons directly, but they are not production runtime paths (they only collide if run
alongside the live app). All production paths (`lib/`, `main.js`, `studio/`) are covered above.

---

## 8. Sequencing (each stage: build → smoke → commit → ASK to reboot → live-verify)

1. **Stage 1 — Layer 1 pool, flag OFF** + the interactive/meeting guards (§4c) + governor tab-reservation
   skeleton. Smokes. Reboot, flag ON, run §4g (parallel tabs, Meet untouched). The riskiest surface, alone.
2. **Stage 2 — Layer 2 focus-set + round-robin + governor cloud-slot tiers**, research slots start at 1 (=
   today) then raise. `research.last_*` re-key (§5c). Smokes. Reboot, run §5f (two projects at once).
3. **Stage 3 — adaptive governor tuning + status/UI + echo_suit/canvas-RPC reentrancy check + pool-tab reuse.**

## 9. Risks / guardrails
- **Meeting/user hijack (highest):** reserved lanes + pool walled from follow-tab + no global teardown while
  reserved (audit #1/#5/#6). Live-verify with a real Meet **and** a mid-meeting user question.
- **Cross-tab handle bleed:** per-session registry/counter (§4a).
- **Cross-focus state bleed:** `research.last_*` re-key (§5c).
- **Cloud queue-reject:** adaptive governor + backoff (§6); never assume a fixed 3×.
- **echo_suit serialization:** may cap deep-lane parallelism; measure in Stage 3.
- **Default-OFF flags** so a reboot never changes behavior until each stage is validated.

## 10. Explicitly OUT of scope here
Output **depth** (16 KB rolling window, early-stall termination) and **format/branding** (bullet templates,
unused saga/vault renderers) — separate workstream, already diagnosed.

---

## 11. Open questions to settle BEFORE building

**Q1 — Preemption timing.** When the user asks a question while all 3 lanes are on research, do we (a) let
the yielding lane's current model step finish (~seconds, no lost work) or (b) abort it instantly? Proposed
default (a). Decision needed.

**Q2 — Two-lane deep passes cost 2 model slots.** A single deep target already fires web-lane + deep-lane
concurrently ([main.js:7287](../main.js)). So "3 lanes" of the browser pool ≠ "3 model slots" if any lane is
running deep mode. The governor must budget **model slots** separately from **browser tabs**, or a deep pass
alone can exhaust the Ollama cap. Decision: cap deep mode to 1 concurrent, or count it as 2 lanes.

**Q3 — DOES same-model concurrency actually parallelize? (the load-bearing assumption).** The whole payoff
rests on 3 concurrent `gemma4:31b` calls to ollama.com running in PARALLEL, not serializing. Ollama's docs
don't say whether "3 concurrent" means 3 requests (any model) or 3 distinct models (same-model serializes).
**This must be settled empirically before building** — a tiny probe firing 3 concurrent same-model requests
and measuring wall-clock vs sequential. If same-model serializes, the model-layer speedup collapses to ~1×
(only the browser I/O overlaps) and we'd assign different models per lane or reconsider scope.

**Q4 — echo_suit single socket.** Structured Echo tools serialize on one connection
([lib/echo_suit.js:400](../lib/echo_suit.js)) regardless of parallel browsers. The web lane (the slow part)
still parallelizes; the deep/structured lane does not fully. Accept, or investigate multi-socket Echo.
