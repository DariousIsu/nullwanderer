# Dedup / Link lane → visual (KG neuron field) impact

How the autonomous dedup + link machinery built this session changes what the graph
visualization (`renderer/kg.js`, fed by Echo `graph_overview`) actually renders.

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

## ⚠ One gap to fix BEFORE arming auto-apply (b)
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

## No change until armed
Both flags are default OFF. Generation-only (`ZOE_KG_DEDUP_ENABLED`) writes **proposals**, which
are not in the graph and do not affect the viz at all. The visual changes above begin only when
the merge-apply flag (`ZOE_KG_APPLY_ENABLED`) is armed — and should not be, until the
`graph_overview` canonical/`SAME_AS` filter above is in place.
