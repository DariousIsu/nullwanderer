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

### Her browser tags (`lib/web.js`)
- `<web-open>url OR search terms</web-open>` — open a page (plain words = a search)
- `<web-read/>` — read the page; interactive els come back as `[L#]/[B#]/[I#]/[C#]` handles
- `<web-deepen/>` — on a search-results page, open the **top result** (don't stall at the SERP)
- `<web-scroll/>` — scroll down to load/read **more** of a long page, then `<web-read/>` again
- `<web-click>L3</web-click>` / `<web-type selector="I0">text</web-type>` — act by handle
- `<web-back/>` / `<web-close/>` / `<web-chat speaker="X">line</web-chat>`

Handles are valid only from the most recent `<web-read/>`. Guidance in the prompt:
**go deep, not wide — deepen + scroll + take notes.**

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

## Tests
`smoke_blockers` · `smoke_web` · `smoke_browse_redirect` · `smoke_flow_runner` ·
`smoke_recipes` · `smoke_recipes_heavy` (every recipe × success/heal/fail/blocker/vars +
50× determinism) · `smoke_byline` · `smoke_downtime` · `smoke_play_runtick`.
Run: `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd scripts/<name>.js`
