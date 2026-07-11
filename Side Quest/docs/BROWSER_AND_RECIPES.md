# Browser, Recipes, Byline & Downtime

How Zoe browses the web, runs reusable site "recipes", builds work under her own
byline, and perceives time offline. (Added 2026-06-21.)

---

## 1. Two browsers — keep them straight

| | Her own browser | Lucas's shared Chrome |
|---|---|---|
| Module | `lib/web.js` | `lib/browser.js` |
| Tags | `<web-*>` | `<browse-*>` |
| Backing | patchright `launchPersistentContext` (own profile, stealth) | CDP attach to system Chrome on :9222 |
| Purpose | her autonomous research/work | co-browsing what Lucas has open |

**Routing guard:** in the idle/research loop a `<browse>URL</browse>` (open in Lucas's
Chrome) is a misfire — she means her own browser. `monologue.splitIdleBrowserTags()`
redirects a research-time `<browse>` open to `<web-open>` (her browser). The other
shared-browser tags (`browse-read`/`click`/`scroll` on his active tab) pass through.

### Her browser tags (`lib/web.js`) — the full manipulation suite

Her visible browser defaults to **Google** for a plain-word `<web-open>` (a normal-browser
feel; DDG was dropped after it null-routed this IP — see §1a). `read()` returns page text
(cap **`MAX_TEXT` = 16 000 chars**, tunable via env **`ZOE_WEB_READ_CHARS`**, floor 2 000)
plus an interactive-element map (**`MAX_INTERACTIVES` = 70 handles**, tunable via env
**`ZOE_WEB_MAX_HANDLES`**, floor 20 — raised from 35 so nav/footer chrome no longer eats the
budget before the real content links on dense pages; the 7 s collection deadline is the backstop).
Handles are typed: `[L#]` links, `[B#]` buttons, `[I#]` inputs, `[C#]` clickable SPA cards/tiles.

On a **Google SERP**, `read()` composes **`AI Overview:` (+ `AI Overview sources:`) + `Search
results:`** — the AI Overview box (the synthesized answer: names/emails/phones/structured facts
+ citations) was being dropped when only the organic links were scraped. `aiOverview()` anchors
on the durable visible "AI Overview" label (Google's classes rotate) and climbs to its content
block, returning **`{ text, sources }`** — the answer text PLUS the **citation source-links**
inside the overview (Google `/url?q=` redirects unwrapped, external hosts only — google/gstatic/
youtube dropped — deduped, capped 12). Those grounding URLs are otherwise lost when only
`innerText` is kept. `waitForAiOverview()` gives it a bounded ≤3 s to stream in (it renders
after the results). Verified live: photosynthesis→4 sources (Wikipedia/NatGeo/Monash/Nature),
intermittent-fasting→9 (Hopkins/Harvard/Mayo/PubMed…), mayor-of-chicago→4 (chicago.gov/Wiki).

**Perceive / navigate**
- `<web-open>url OR search terms</web-open>` — open a page (plain words = a Google search)
- `<web-read/>` — page text + interactive els as `[L#]/[B#]/[I#]/[C#]` handles (the "button map")
- `<web-see>question</web-see>` — screenshot → vision (viewport; `scroll="down"` first, or `full`/`whole` for the whole page)
- `<web-deepen/>` — on a SERP, open the **top result** (don't stall at the results list)
- `<web-scroll/>` — scroll down (or `up`/`top`) to load/read more, then `<web-read/>` again
- `<web-back/>` `<web-forward/>` `<web-reload/>` `<web-close/>`

**Click / keyboard**
- `<web-click>L3</web-click>` — click a handle (`button="right"` or `dbl="1"` for right/double-click)
- `<web-click-text>Sign in</web-click-text>` — click by visible text when there's no handle
- `<web-type selector="I0">text</web-type>` — type into an input handle
- `<web-press selector="I0">Enter</web-press>` — press a key/combo (Enter/Tab/Escape/ArrowDown/"Control+A"; selector optional → focused element)
- `<web-clear selector="I0"/>` — empty a field

**Forms**
- `<web-select selector="I0">Option label</web-select>` — pick a dropdown option (by label → value)
- `<web-check>I2</web-check>` / `<web-uncheck>I2</web-uncheck>` — tick/untick checkbox or radio
- `<web-upload selector="I3">C:\path\file.pdf</web-upload>` — attach a local file to a file input
- `<web-submit selector="I0"/>` — submit the form (Enter)

**Tactile / vision-guided**
- `<web-hover>L3</web-hover>` — hover a handle/text to reveal a menu or tooltip, then `<web-read/>`
- `<web-click-xy x="120" y="340"/>` — click at **viewport** pixels read off a `<web-see>` screenshot (don't pair with a full-page `<web-see>`; `button`/`dbl` too)
- `<web-drag from="L1" to="L5"/>` — drag one handle onto another (reorder, sliders, drop targets)

**Tabs / timing / dialogs**
- `<web-tab-new>url</web-tab-new>` `<web-tab-list/>` `<web-tab-switch>2</web-tab-switch>` `<web-tab-close>2</web-tab-close>`
- `<web-wait>2000</web-wait>` or `<web-wait selector=".results"/>` — pause N ms, or wait for an element
- `<web-dialog>accept</web-dialog>` / `<web-dialog>dismiss</web-dialog>` — answer a native alert/confirm (`text="…"` for a prompt). A page `dialog` listener holds it open with a **30 s safety auto-dismiss** so an unanswered popup can't hang the page.

**Precise extraction / inspection**
- `<web-get selector="a.headline" attr="href"/>` — read one element's attribute (omit `attr` for its text)
- `<web-eval>document.querySelectorAll('.price').length</web-eval>` — run a JS expression, get the (bounded) result; in-page errors return `ERR: …`

**Auto-capture PDFs** (`<web-grab-pdfs/>` — manual nudge; also fully automatic — see §1b).

**Chat sites** (`<web-chat speaker="X">line</web-chat>` — type+send+wait for a bot's reply; `<web-watch>`/`<web-unwatch>`).

Each tag is a thin Playwright wrapper on the CURRENT page and **resets the handle registry**
when the DOM may change — handles are valid only from the most recent `<web-read/>`, so read
again after opening / clicking / scrolling / hovering / waiting / switching tabs. Prompt guidance:
**go deep, not wide — deepen + scroll + take notes.** Dispatch caps at **8 web tags per turn**
(`main.js`), enough for a full fill→select→check→submit→read flow.

---

## 1a. Search — two lanes (`lib/search_lane.js` + `lib/web.js`)

DuckDuckGo **null-routed this IP** at the connection level (`ERR_CONNECTION_TIMED_OUT` on every
DDG host) after the old shared search lane over-pinged its HTML endpoint. Search was split into
two independent lanes, on Lucas's design — *"dedicated stealth lanes for rapid searching, normal
browsers for deeper web browsing."*

| | Rapid stealth lane | Deep-browse lane |
|---|---|---|
| Module | `lib/search_lane.js` | `lib/web.js` (her visible browser) |
| Engine | **Bing** | **Google** |
| Window | **hidden** (headful but parked off-screen) | visible, co-watched |
| Used by | `lib/web_search.search()` → cognition, monologue, meetings, media, research_exec, super_search | her interactive `<web-*>` work |

- **`lib/web_search.search()`** calls the stealth lane first; a raw Bing GET (`parseBingResults`)
  is the fallback when the lane can't launch, or when `ZOE_SEARCH_VIA_BROWSER=0`. An empty lane
  result is trusted (no raw re-query).
- **Stealth lane = its own patchright context** on a separate profile (`data/search_profile`),
  serialized, lazy + reused. Bing anchors carry real destination URLs (some wrap in
  `bing.com/ck/a?…&u=a1<b64url>` — decoded).
- **⚠ Patchright ignores `headless:true`** — its stealth patches need a headed browser, so it
  spawns a real (blank/black) window on Windows. Fix: launch **headful but off-screen**
  (`--window-position=-32000,-32000`) — renders SERPs normally, never visible. A
  `killStaleProfileChrome()` (matches `*search_profile*`, disjoint from web.js's `*web_profile*`)
  clears an orphaned lane Chrome on fresh launch so it can't linger as a stray window / hold the lock.
- **Google SERP parsing** (her visible lane's `readSerpResults`/`openTopResult`): `#search h3`,
  `div.g`/`.MjjYud`, `.VwiC3b` snippet. Headless Google trips its `/sorry` bot wall — it only
  parses **headful** (which is how her lane runs).

---

## 1b. Auto-download + auto-ingest PDFs (`lib/web.js` + `main.js` watcher)

PDFs she encounters are captured and folded into memory automatically. Three acquisition paths,
one ingest rail.

**Acquire → `DOWNLOADS_DIR` (`lib/web.js`):**
- **Fully-auto harvest** — `read()` grabs every `.pdf` link on the page (fire-and-forget), deduped
  per session, capped `AUTO_GRAB_PER_READ` (5) per read, `≤ PDF_MAX_BYTES` (25 MB). Off with
  `ZOE_AUTO_GRAB_PDFS=0`.
- **Nav capture** — `open()` onto a PDF (Chrome's inline viewer has no readable HTML) fetches the
  bytes instead of returning a blank read; result carries `pdf: { savedAs }`.
- **Manual** — `<web-grab-pdfs/>` (`max=` optional).
- **`downloadPdf(url)`** does the fetch via **`context.request`** (shares the persistent profile's
  cookies → session-gated PDFs work). Guards: PDF content-type **or** `.pdf` URL, a real `%PDF`
  header, size ceiling, per-session `grabbedUrls` dedup.

**Ingest ← `DOWNLOADS_DIR` (`main.js` `startDownloadsIngestWatcher`):** an `fs.watch` on the folder,
with a **size-stable debounce** (a download is still being written when the first event fires), runs
each landed file through the SAME rail as a canvas drop — `extractFileMarkdown` (→ `file_ingest` →
`doc_extract` text layer) → `doc_store.land` (idempotent on `ref = download:<path>`) →
`decomposeLandedDoc` + `surfaceDocCards`. Decoupled on purpose: **whatever** puts a file there
(harvest, nav, a click-download, a recipe) gets ingested.

**Scanned / image-only PDFs** (no text layer) are handled too: `file_ingest` falls back to
`doc_extract.rasterizePdf` (pdfjs + `@napi-rs/canvas` → per-page PNGs, bounded `maxPages`) →
`lib/vision.describe` — the same vision path an image drop uses (`via: 'vision:pdf'`). Text-layer
PDFs skip this (no wasted vision calls).

---

## 2. Blocker detection → ask Lucas (`lib/blockers.js`)

Zoe does **not** try to defeat sign-in walls, CAPTCHAs, Cloudflare challenges, or
paywalls. `web.open()` runs `blockers.detect(page, resp)` after every navigation; on a
`needsHuman` blocker it returns `result.blocker`, and `main.js` surfaces a help-request
to Lucas in her own voice ("I hit a sign-in wall on X — can you log me in? I'll resume").
Her persistent profile means once he logs in, the cookie sticks and she won't re-ask.

Signatures (deterministic, no model): Cloudflare `cf-mitigated: challenge` header /
`#challenge-form` / `_cf_chl_opt`; reCAPTCHA/hCaptcha/Turnstile iframes + response
fields; login = HTTP 401 / known IdP host / OAuth param-triple / unexpected password
field; paywall = JSON-LD `isAccessibleForFree:false` or a subscribe modal + scroll-lock;
cookie consent = `__tcfapi` / vendor banner selectors (this tier is **auto-dismiss**,
not a human handoff).

`classify(signals)` is pure (offline-testable); `detect()` gathers the live signals.

---

## 3. Recipe engine — record once, replay without the LLM

A **recipe** is a JSON list of steps in `recipes/*.json`. Each step stores a **locator
descriptor** (not code, not a stale handle). patchright locators re-resolve live, so a
stored `getByRole("button", {name:"Publish"})` rebuilds against the current DOM — **zero
model inference at author or replay** (the Stagehand/Skyvern pattern).

### Recipe format
```json
{
  "site": "substack.com", "task": "publish_post", "verified": false,
  "fingerprint": { "url_pattern": "substack.com/publish" },
  "steps": [
    { "action": "navigate", "url": "https://substack.com/publish/post", "expectLogin": true },
    { "action": "fill",
      "locator": { "method": "getByPlaceholder", "placeholder": "Title" },
      "fallbacks": [ { "method": "getByRole", "role": "textbox", "name": "Title" }, { "css": "textarea[data-testid=post-title]" } ],
      "value": "{{title}}" },
    { "action": "click", "locator": { "method": "getByRole", "role": "button", "name": "Publish now" },
      "fallbacks": [ { "text": "Publish now" } ], "mayNavigate": true }
  ]
}
```
- **Actions:** `navigate | fill | click | scroll | waitFor | read`.
- **Primary locator methods:** `getByRole | getByText | getByLabel | getByPlaceholder | getByTestId`.
- **Fallback shapes:** `{css} | {testid} | {text} | {xpath}`.
- **Vars:** `{{title}}`, `{{body}}`, `{{query}}` … substituted into `value`/`url`.
- `verified:false` = author-time provisional selectors, confirmed/healed on first live run.

### Runner (`lib/flow_runner.js`)
`runRecipe(page, recipe, vars, ctx)` walks the steps. Per step it resolves the target
through the **self-heal ladder**:
1. primary descriptor
2. each fallback in order
3. role-only re-derive (role is stable; the accessible name is what drifts)
4. `ctx.modelHeal(page, step)` — the **only** place the 24B re-enters (optional)

After a navigation it runs `blockers.detect`; a `needsHuman` blocker **pauses** the
recipe and returns `{ blocker, atStep }` so the caller can ask Lucas and resume.

### Store + live bridge
- `lib/recipe_store.js` — `load(name)`, `find(site, task)`, `all()`, `list()`.
- `web.runRecipe(name, vars, ctx)` — the live path: ensures her browser, loads the
  recipe, replays it. This is how the byline pipeline publishes.

### Shipped recipes (provisional)
`substack_publish`, `gcal_create_event`, `gdrive_open_doc`. Selectors are best-effort
until a logged-in run verifies them.

### Recipe recorder — record by demonstration (`lib/recorder.js`)
Instead of hand-authoring every recipe, she can **learn one by watching a walk-through**.
The recorder captures a flow into the exact descriptor format above (primary
`getByRole`/`getByPlaceholder` + the heal-ladder fallback chain), so what it emits replays
with **zero model inference**. Two capture paths feed one assembly core:

- **Demonstration (Lucas drives).** Say *"record how to X on \<site\>"* → main.js's
  deterministic **recorder interceptor** opens the site in her browser and installs
  in-page listeners via `page.addInitScript` + `page.exposeFunction` (the Playwright-native
  path — **never** `connectOverCDP`+`Runtime.enable`, which would re-light the CDP bot
  signal patchright suppresses). Click/type through it once; say *"stop recording"* → the
  recipe is assembled + saved. `web.startRecording()` / `stopRecording()` / `isRecording()`.
- **Passive (she drives herself).** On `web.open()` of a site with **no** existing recipe,
  a passive session starts; each of her own successful `click`/`type` actions is captured
  (`recorder.captureLocator` → descriptor). When she leaves the host (or closes), a flow of
  **≥2 action steps** is auto-saved as a candidate recipe (`source:"passive"`). Single
  clicks and already-covered sites are dropped as noise.

**Core (pure, offline-tested):** `computeDescriptor(el)` (self-contained, runs in-page or
in tests) → `buildDescriptor` (primary + ordered fallbacks) → `eventToStep` → `dedupeSteps`
(collapses repeated fills; folds a click-induced navigation into the click's `mayNavigate`)
→ `assembleRecipe` (always `verified:false`). **Safety:** credential fields are never
baked in — a password / OTP field is recorded as an `optional` `needsHuman` step with the
value scrubbed; at replay `flow_runner` treats a present sign-in field as a `login` blocker
and pauses for Lucas. **No-clobber:** `save()` refuses to overwrite a `verified:true`
recipe, writing `\<stem\>.recorded.json` for review instead.

---

## 4. Byline pipeline (`lib/byline.js`)

Her "build a body of work under my own byline" goal, as a staged work project. Mirrors
`play_session`: the app holds the structure and advances **one stage per idle tick**;
the model is asked for at most one decision (the draft).

```
research → read → write → publish → done
```
- **research** — `web_search` for the topic → store top sources + write `notes/byline_<slug>.md` (no model)
- **read** — open the top sources in HER browser, append page text to the notes (one source/tick; a blocked source is skipped + Lucas asked)
- **write** — ONE model call composes a draft → `drafts/<slug>.md` (versioned, `num_ctx 8192`)
- **publish** — `web.runRecipe('substack_publish', {title, body})` — **fully autonomous**; a login wall pauses and asks Lucas, then retries
- **done** — log + clear state

State lives in `meta` (one active pipeline). **Start:** Lucas says "write/publish a post
about X" → `byline.detectStart()` → `byline.start(topic)`; it then advances on its own
during idle. Wired in `monologue.js` (work-mode branch, takes precedence over
free-association) and `main.js` (chat trigger).

---

## 5. Downtime marker (`lib/downtime.js`)

So Zoe perceives how long she was offline (her own request). A 60s **heartbeat** writes
`last_alive_at` (robust to hard `Stop-Process` kills); `markShutdown()` stamps a clean
quit. On boot `recordBoot()` computes the gap from the last heartbeat/shutdown, drops a
first-person "[Back online] I was offline ~X" reading, and stores a second-person
awareness line surfaced by `buildAwarenessBlock` for the first 30 min. Sub-minute
reloads are ignored as noise.

**Reboot capability log** (`lib/changelog.js`): a reboot that changes her capabilities
tells her *what* changed. Before deploying, the dev records a one-line entry —
`scripts/log_capability_change.js "what changed"` — and `recordBoot()` surfaces any
unsurfaced entries in the back-online marker (and her awareness), then marks them
surfaced so they're shown once. This is **decoupled from the offline-duration gate**, so
even a quick redeploy that adds a capability still tells her. Stored in
`data/capability_log.json` with its own surfaced-marker.

---

## 6. Google Meet — Step 1 (`lib/gmeet.js`)

Join a meeting muted, post a **mandatory self-introduction** to the meeting chat, then
observe live captions. Built like the byline stepper (meta stages, one per idle tick):
`joining → intro → observing → done`.

- **Join** = the `gmeet_join` recipe (mute mic+cam → Join now), replayed by flow_runner;
  a sign-in wall pauses and **notifies Lucas to log her Google account in** (blocker handoff).
- **Triggers**: a `meet.google.com` link from Lucas in chat (`detectMeetUrl`) = "join now";
  calendar auto-join uses `meetLinkFromEvent` (hangoutLink / conferenceData / location) +
  the scheduler (the calendar poll itself lands in the live pass).
- **Mandatory intro**: she writes it warm and may greet recognized attendees by name, but
  the **AI-disclosure is enforced deterministically** — `validateIntro` + `ensureDisclosure`
  guarantee the intro always states she's an AI on Lucas's behalf, even if the model omits it.
- **Captions**: enabled with **`Shift+C`** (keyboard, retried; button click only as fallback —
  the approach maintained OSS Meet bots use, since the control bar auto-hides / the CC button
  can be in the overflow menu). The scraper anchors on the **durable accessibility attributes**
  (`[role="region"][aria-label*="Captions"]` / `[aria-live]`) — Google rotates the obfuscated
  class names every few months, so classes (`.nMcdL` row, `.NWpY1d`/`.xoMHSc` speaker) are only
  fallbacks, and text is extracted by **cloning a row and removing the speaker badge + avatars**
  (class-free, durable). Selectors sourced from Recall.ai's Playwright bot + extension,
  yunho0130/google-meet-cc-to-srt, and S Anand's recorder. A heal signal logs candidate regions
  if none match. Dedup is a seen-set (captions scroll + the active line mutates in place, so an
  index breaks).

Provisional until verified on a live meeting: `gmeet_join`, `gmeet_post_chat`, and the caption
selectors. Meet's DOM needs her Google login. Pure helpers + the stage machine are offline-tested
(`smoke_gmeet` 28/28).
Steps 2–3 (grounded contribution from Echo's KB, loopback transcript) ride Echo.

## Tests
`smoke_blockers` · `smoke_web` · `smoke_browse_redirect` · `smoke_flow_runner` ·
`smoke_gmeet` ·
`smoke_recipes` · `smoke_recipes_heavy` (every recipe × success/heal/fail/blocker/vars +
50× determinism) · `smoke_recorder` (descriptor computation, build/dedupe/redact/assemble,
no-clobber save) · `smoke_intent` (incl. `detectRecordCommand`) · `smoke_byline` ·
`smoke_downtime` · `smoke_play_runtick`.
Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd scripts/<name>.js`
