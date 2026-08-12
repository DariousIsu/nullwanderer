# Org Research Lane — the back half (spec)

**Owner:** sole builder. **Relates:** memory `no-organization-research-lane`, `crm-is-the-ultimate-store`, `whole-site-capture-to-objects`, `object-type-identity`. **Front half already built:** `lib/org_site.js` (acceptUrl / verifyPage / selfSiteAuthority) + `scripts/research_org.js` (standalone). **URL source already built:** the org CRM accounts hold **2,045 Wikidata-P856 websites** (Echo pass13f, 2026-08-02).

## The gap (measured 2026-08-11)
`data/puller.db`: **1,471 `kind='org'` targets** (door + backfill classify them) but **no worklist selects them and no research move researches them** — they sit with stale *person-lane* observations (email attempts made before the backfill re-kinded them). `listValueScopedTargets` filters `kind='person'`; the person research move is an email-fill cascade, which is the wrong move for an org. So classification exists; the lane does not.

## The design constraint (unchanged, load-bearing)
**NO DOMAIN GUESSING.** A URL is admissible only from an asserting source — `operator` or `register` (Wikidata P856). `org_site.acceptUrl(url, provenance)` enforces this; anything else is refused. A guessed hostname manufactures an ORIGIN, and origin is what the whole grading model rests on (the corpus already holds `alconacountyfair.com` — a county *fair*, not the county). Even an asserted URL is re-checked: `org_site.verifyPage` requires the page to actually name the org (distinctive tokens + domain/text agreement). An org's own site grades **`ordinary`**, never `official`.

## Phase 1 — offline core (this phase; gate-tested, zero runtime risk)

### 1. `lib/org_walk.js` — the pure, dep-injected research MOVE (mirrors `lib/puller_walk.js runPullerMove`)
- `pickOrg(candidates, {attemptedKeys, now})` — pure ranking: drop already-researched, recently-attempted, or URL-less orgs; prefer CRM-linked then promoted. `candidates: [{id,name,domain,crm_id,status,researched,urlCandidates:[{url,provenance}]}]`.
- `resolveUrl(target)` — first admissible URL from `target.urlCandidates`, re-validated through `org_site.acceptUrl` (provenance gate). Returns `{url,provenance}` or null. **The no-guessing rule holds by construction** — the caller may only put operator/register URLs into `urlCandidates`, and acceptUrl re-checks.
- `runOrgMove(deps)` — one org per move: pick → resolve URL → `fetchPage(url)` (injected) → `org_site.verifyPage` → `land({name,url,text})` (injected → `db.insertDocument({source:'org_research',origin:url})`, the existing decompose lane extracts entities/relations, **no second extraction stack**) → `markResearched` (injected → an `official_site` belief = the durable done-marker) → attempt cooldown. Every I/O injected → fully offline-testable.
- **Attempt cooldown** — meta JSON `orgwalk.attempted` (`[[key, ts, ttl], …]`, TTL-pruned), mirroring `pullerwalk.attempted`: researched = 24h, barren (no-url / verify-fail / fetch-fail) = 3h (a barren pass must not bench a viable org for a day).

### 2. `puller_db.listOrgTargets({limit})` — the org WORKLIST
`SELECT * FROM targets t WHERE t.merged_into IS NULL AND t.kind='org' AND NOT EXISTS (an active 'official_site' belief) ORDER BY (crm_id present) DESC, (status='promoted') DESC, last_accessed_at DESC LIMIT ?`. The `official_site`-belief NOT EXISTS is the "already researched" exclusion (mirrors the person lane's has-`email`-belief done signal). Orgs are ~1.5k → no bulk-company scoping needed.

### 3. `scripts/smoke_org_walk.js` — offline proof (added to the gate)
Drives `runOrgMove` with injected deps + a fake clock: (a) a good org → resolves the register URL, verifies, lands, marks researched, cooldown=24h; (b) a guessed/no-provenance URL → refused (never fetched); (c) an asserted URL whose page does NOT name the org → verify refused, no land, cooldown=barren; (d) recently-attempted org → skipped; (e) already-researched org (has `official_site` belief) → not picked. Plus `listOrgTargets` exclusion. No network, no model.

## Phase 2 — live wire (after a reboot; NOT this phase)
Wire `runOrgMove` into the monologue pipeline tick as a bounded ORG stage (idle-tier / quota / budget / cadence-gated, same leash as the person stages). The caller enriches each `listOrgTargets` row with `urlCandidates` from: the CRM account website (via `crm_id` → Echo account `Website`, P856-sourced = `register`), the target's QID P856, or an operator-supplied URL. `land` → `db.insertDocument(source:'org_research')`; `markResearched` → `puller_db.upsertBelief(id,'official_site',…)`. Live-drive one org (raineycenter.org via its CRM P856 site) end-to-end.

## Phase 3 — stretch (deferred)
First-class affiliation extraction (sister/parent/subsidiary, shared officers, EIN family) as `affiliation`-type beliefs/relations, and the Freedom Project duplicate merge (corporate-form normaliser). The decompose lane already yields `related_to` from a landed org site (proven on the Rainey site); richer affiliation is an additive pass.
