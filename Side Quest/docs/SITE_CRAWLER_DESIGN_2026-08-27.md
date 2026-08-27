# THE SITE-SWEEP WALKER — design pass (2026-08-27)

Lucas's order (08-27, pre-compact): *"full build and test on the missing organs, starting with the
crawler."* The requirement is a year-old standing one (07-20, tagged pre-compact): *"capture whole
websites plus multi step page depth and translate into memory objects"* — and the 07-23 site-ledger
ask: *"the whole site can be swept correctly, each page only once … I would rather get explained
that a site is taking longer to digest than realize we took 500 calls to interact with the landing
page."*

## What the survey found (2026-08-27, code-verified)

Most of the crawler already exists. What is missing is one organ:

| Piece | Where | Status |
|---|---|---|
| Visited ledger (UNIQUE url, TTL skip) | `lib/site_ledger.js` `record`/`shouldSkip` | LIVE |
| Frontier build (same-host links → bounded checklist) | `site_ledger.buildPlan`, fed by **every** `web.js read()` (:741) | LIVE — drawn constantly |
| Frontier walk | `site_ledger.nextPending` / `markDone` | **ZERO production callers** |
| Access-door learning + dead-host breaker | `profileFor`/`bestDoor`/`hostDown` | LIVE |
| Fetch ladder (fetch → browser → wayback → vision) | `lib/fetch_escalation.escalatedRead`, wired at `main.js` `open_page` | LIVE |
| Origin → one-source-per-site collapse | `lib/origin.js` `independence` = min(distinct `origin_host`, distinct `content_hash`) | LIVE — automatic |
| Content-hash doc dedup | `doc_store.land` → `db.getDocumentByHash` | LIVE (advisory — must land through `land()`) |
| Page → objects | `decomposeLandedDoc` (`main.js:17183`) → encounters w/ origin stamped | LIVE |
| Digest narration | `site_ledger.planLine` ("host: 12/30 digested") | built, 1 log caller |
| The order surface | `gap_plan.js` AGGRESSIVE bucket advertises "a full crawl of the official site", go-phrase "run the deep crawl on X" | **SAY-DO GAP** — no lane actually sweeps |

**The organ to build: the WALKER** — the consumer of `nextPending`/`markDone`. Everything else is
plumbing it inherits.

## The origin doctrine (the whole risk, already solved by construction)

The 07-20 sequencing rule: no crawler before the origin/corroboration rule is enforced — ten pages
of one site are ONE source, or the crawler manufactures corroboration at scale.

Enforcement is already structural: every landed page sets `origin` = **the individual page URL**;
`insertDocument` derives `origin_host`; `independence()` counts distinct *hosts*. Ten pages of
`parish.la.gov` → origins:1, texts:10, count:1. The walker adds **no collapsing logic** — it only
has to (a) always land through `doc_store.land` with `origin` = page URL (never the site root:
that would destroy per-page provenance and buy nothing), and (b) never insert via `db.insertDocument`
directly (bypasses hash dedup).

## Design

### New: `lib/site_crawler.js` + `site_sweeps` table

`site_sweeps(id, host, seed_url, status 'active'|'done'|'paused'|'stopped', reason, requested_by,
pages_fetched, pages_reused, pages_skipped, docs_landed, created_ts, updated_ts, done_ts, note)`.

- `startSweep(seedUrl, {reason, requestedBy})` — resolve the seed (final host after redirect wins,
  so `www.x.gov`/`x.gov` unify), refuse if a sweep is already active (**one sweep at a time** — the
  don't-hammer doctrine), create the row, seed the frontier: the seed URL + `sitemap.xml` locs +
  robots `Sitemap:` lines (same-host, bounded by the existing `ZOE_PLAN_MAX_URLS` 200 frontier cap).
- `sweepTick(deps)` — the walker bite, called from an idle-gated driver:
  1. `nextPending(host)` — none left → **completion**: status done, honest report.
  2. `shouldSkip` (TTL reuse — "each page only once"), `hostDown` (breaker → pause + say so),
     robots-disallowed → count + skip (never silent).
  3. Fetch through the SAME ladder `open_page` uses (`escalatedRead` w/ `bestDoor` preference;
     plain fetch first — most civic sites are static — browser/wayback/vision behind it).
  4. Land: `doc_store.land({title, body, source:'site_sweep', ref:'sweep:'+url, origin:url,
     fetchUrl:url})` (hash dedup absorbs pages a read already captured) → `site_ledger.record` →
     `markDone` → `decomposeLandedDoc`.
  5. Harvest same-host links from the fetched page → `buildPlan` (the frontier self-extends; the
     200 bound caps the MAP — if hit, the report says so, never silently).
  6. Pace: `ZOE_SWEEP_PAGE_DELAY_MS` (default 9000, jittered) between pages,
     `ZOE_SWEEP_BITE` (default 4) pages per tick. Nothing existing rate-limits page navigation —
     this is the crawler's own governor.
- `sweepStatusLine()` — `planLine` + counts, for narration and work-state.
- Robots: minimal honest parse (UA `*` Disallow prefixes; `ZOE_SWEEP_ROBOTS=0` to disable).
  Skips are counted and named in the report — a page Lucas names EXPLICITLY is never robots-blocked
  (a human ask always navigates; only the autonomous walk defers).

### `main.js` wiring (3 doors)

1. **Order door** — "run the deep crawl on X" / "sweep/crawl the whole site" + a URL or host →
   `startSweep`, ack names the host + frontier size + cadence. This closes the gap_plan say-do gap:
   the AGGRESSIVE go-phrase now starts a real sweep instead of a judgment-driven browse.
2. **Driver** — idle-gated interval (active sweep + user idle → `sweepTick`). Milestone narration
   (start / ~each 25% / done) through the deterministic unprompted door (task-update load — the
   allowed channel use).
3. **Leash bypass** — `_docLeashOk` (main.js:17163) + the download-ingest leash (main.js:4037)
   quarantine off-vocabulary docs; a DIRECTED sweep is an explicit order, so docs whose source is
   the active sweep's `site_sweep` tag pass, logged. Mirrors the existing `.gov` bypass and the
   "chat-driven opens never consult the ledger" rule.

### What the walker does NOT do

- No crawl through `lib/browser.js` (Lucas's shared browser — a crawler would fight him for tabs).
- No off-host hops (buildPlan is same-host by construction; cross-site = a NEW sweep, a NEW source).
- No decompose forcing: capture and digestion stay decoupled — `decompose_sweep`'s daily chunk
  budget remains the digestion governor; `planLine` explains the lag (the exact narration Lucas asked for).
- No unbounded depth: depth emerges from the frontier; the map bound + page pacing + the breaker
  are the three brakes.

### Tests

- `scripts/smoke_site_crawler.js` (hermetic, temp db, injected fetch/land/decompose): walker drains
  a plan; TTL-fresh pages reuse not refetch; breaker pauses; robots prefix skip + count; frontier
  self-extends; completion detected only when pending empty; one-sweep-at-a-time; origin = page URL
  on every land call; bite + budget respected; say-do: the order regex routes and the ack names the host.
- Register in `run_smokes.js` (curated allow-list). Full gate.
- Live proof (needs the reboot grant): directed sweep of one small real civic site → `site_plans`
  drains to done, docs carry `origin_host`, `independence` over the swept docs returns origins:1,
  narration lands in chat, completion report honest.
