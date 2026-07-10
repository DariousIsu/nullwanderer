# Dedup / Link lane → visual (KG neuron field) impact

How the autonomous dedup + link machinery built this session changes what the graph
visualization (`renderer/kg.js`, fed by Echo `graph_overview`) actually renders.

---

## 🟢 LIVE as of 2026-07-10 — change set for the graphics context

The lane described below is **no longer hypothetical — it is armed and running.** Zoe was
rebooted 2026-07-10 (~09:13) with both flags on (`ZOE_KG_DEDUP_ENABLED=1`,
`ZOE_KG_APPLY_ENABLED=1`), so real merges will start landing on the live graph within the hour.
Five commits this session make up the change set:

| commit | what | visual relevance |
|---|---|---|
| Echo `041c598` | dedup adjudicator recalibrated to **LLM-as-veto** on anchored tiers (+ non-answer safety) | this is *why* merges now actually land — the old gate parked everything, so the declutter below was theoretical; now it happens for real |
| Echo `7081ad1` | **per-tier model split** — anchored tiers judged by fast gemma (~2s), fuzzy tiers by kimi | throughput lever; sets how *fast* the graph declutters (see timeline) |
| Echo `10b5dd8` | `graph_overview` mount filters tombstones (`canonical_id`) + excludes `SAME_AS` | **the thing that protects your render** — see below; loaded in the running Echo as of this reboot |
| Zoe `6f1be8d` | **2-hop corridor-gated investigation frontier** (`idle_anchors`) | the discovery walk now reaches one ring further out (hub-gated), so enrichment edges appear a hop deeper around Lucas's active nodes — denser local neighborhoods, more tendrils near his work |
| Zoe `.env` | daily full-sweep detection + temporary drain pace (`APPLY_BATCH=150`, `1h` floor) | sets the **timeline**: the one-time ~24k dedup backlog clears over ~days, not instantly |

**What you'll actually see, and when.** The apply tick fires hourly (batch 150). Over the next
**several days** the ~24k historical duplicate backlog drains → the node population **shrinks
toward the true entity count** and fragmented hubs **concentrate their degree onto one bright
canonical** (the three effects below). After the stock clears, steady-state is a **trickle
(~5–12 merges/day)** — the field goes stable, not churning. So: a visible multi-day declutter,
then quiet.

**What you need to change in `renderer/kg.js`: essentially nothing.** The ghost-node / stub-edge
risk is handled **server-side** by `10b5dd8` (the mount already resolves to live canonicals and
drops `SAME_AS`). Two things to simply *expect* rather than treat as bugs: (1) the node count
will **trend down** over the coming days, and (2) some mid-degree nodes will **brighten / grow**
as duplicate fragments fold into them. If you cache node/edge lists client-side, just don't
assume a stable node population — a node present last frame may be a tombstone next frame
(reads follow `canonical_id`; the mount already excludes it).

## What the lane does to the underlying data
- **Merge (dedup apply)** = `echo.resolve.apply`: the non-canonical member gets
  `entities.canonical_id → canonical`, a `SAME_AS` edge (member → canonical) is recorded,
  and the canonical's `degree` is recomputed (external edges only, `SAME_AS` excluded). The
  member is **tombstoned** — reads follow `canonical_id` — but its row and its edges stay in
  place (nothing is deleted; fully reversible via `reverse_proposal`).
- **Link candidates** (slice 2) live in the `link_candidates` staging table, **ungrounded**.
  They are NOT in `civic_graph.relations` and do **not** touch the graph until a future
  grounding lane verifies + promotes them.

## The three visible effects (once auto-apply is armed)
1. **Declutter — fewer, truer nodes.** Every real-world entity currently split across several
   fragments ("Merck Co Inc" ×5, "Bob Smith"/"Robert Smith") collapses to one canonical. The
   node population shrinks toward the real entity count; the field stops being a haze of
   near-duplicates.
2. **Hub sharpening — brighter, better-placed blooms.** A fragmented entity's edges were
   spread across its duplicates (several dim mid-degree nodes). Post-merge the degree
   concentrates on the canonical → it renders as a **larger, brighter neuron with a stronger
   bloom**, and the galactic-core / center-of-mass framing gets more defined because the real
   hubs are no longer diluted by their own copies. The dim duplicate satellites disappear.
3. **Densification — richer tendrils (later, from links).** When the link lane's grounded
   candidates promote, genuinely-related nodes gain direct edges → more dendritic tendrils,
   more short paths pre-computed. The graph looks *more connected*, not more cluttered
   (density is real structure, dedup removed the noise).

Net: the map becomes **cleaner and more legible** — communities and hubs read clearly because
duplicate-fragment noise is gone and true structure is concentrated. This is the visual face of
the "pre-searched index" goal: a navigable field, not a fog.

## ✅ RESOLVED — the gap below is fixed (Echo `10b5dd8`)
Fixed in `echo/mcp/external/graph.py`: hub query **and** the recent slice now filter
`AND (canonical_id IS NULL OR canonical_id = id)` (the live-canonical predicate used across
`echo.resolve` — the bare `canonical_id IS NULL` the note suggested would have wrongly dropped
self-referencing canonicals), and the edge query excludes `relation_type = 'SAME_AS'`. Validated
against `data/foundations/civic_graph.db`: **7,098** existing tombstones with `degree>0` (already
present — merges have run) are now filtered out of the mount, **363** `SAME_AS` edges excluded,
hub UNION executes with 0 tombstones surviving. **Requires an Echo MCP server restart to serve
the new code.** Endpoint re-pointing (below, "Optionally") was intentionally NOT done — with
tombstones filtered from the node union, member-owned edges surface as kg.js *tendrils* (hidden
connections) rather than vanishing, which is on-aesthetic; drawn edges stay between live hubs.

## ⚠ (Original gap — now resolved above)
`graph_overview` (the viz mount, `echo/mcp/external/graph.py`) currently:
- picks top hubs by `degree` **without** `WHERE canonical_id IS NULL`, and
- returns **all** edges including `relation_type = 'SAME_AS'`.

A tombstoned member keeps its old `degree` and its edges, so as merges land the viz would show
**ghost nodes** (duplicates that reads no longer surface) and **`SAME_AS` stub edges** (short
self-referential links between a tombstone and its canonical). The read/search path already
resolves canonicals (`kg_query` follows `canonical_id`); the **mount view does not**.

**Fix (small, one place):** in `graph_overview`'s hub query add `AND canonical_id IS NULL`, and
exclude `relation_type = 'SAME_AS'` from the edge set (the same exclusion `apply.external_degree`
already uses). Optionally, when an edge endpoint is a tombstone, resolve it to its canonical so
inbound edges re-point rather than vanish. Until this lands, arming `ZOE_KG_APPLY_ENABLED` would
visibly corrupt the neuron field even though the data stays correct.

## ~~No change until armed~~ → ARMED 2026-07-10
Superseded by the LIVE section at the top. Both flags are now **on**, the `graph_overview`
filter (`10b5dd8`) is in the running Echo, and merges are landing on the hourly apply tick. The
generation pass (`ZOE_KG_DEDUP_ENABLED`) still only writes **proposals** (invisible to the viz);
the visible declutter/hub-sharpening comes from the apply flag (`ZOE_KG_APPLY_ENABLED`), which is
now active. To pause the visual churn, set either flag to `0` and restart Zoe.
