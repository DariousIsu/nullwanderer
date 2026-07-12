# KG Activity Visualization — design + emitter spec

Goal: make the Knowledge Graph panel a **living view of every data interaction** in both memory
stores — nodes/edges highest priority, but ultimately *everything that happens in either DB*.
Model (same as the dedup absorb): **the graphics side builds the animation vocabulary + one event
receiver; each DB side emits the requested feed.** This doc is the contract.

Two stores (see [DEDUP_LANE_VISUAL_IMPACT](DEDUP_LANE_VISUAL_IMPACT.md) for the dedup precedent):
- **Echo** = long-term corpus (`civic_graph.db`, ~1.74M entities). The vast galaxy.
- **Side Quest** = short-term buffer (`lib/db.js`, `data/sq.db`) — Zoe + all new data coming in.
  Structured ~1:1 with Echo for federation; adds an **epistemic layer** Echo lacks
  (`witnessed|told|read|speculated|anticipated` + `confirmed`).

---

## ✅ AS-BUILT STATUS (2026-07-11, all in `renderer/kg.js` unless noted)

What actually shipped this arc (all live-verified via CDP; builds 10p→10y):

- **Activity bus (Stage A)** — `onActivity({db,kind,anchor,anchor2,count,tier,epistemic})` dispatcher +
  gestures: `node.born` (spark), `node.enrich` (breath), `edge.born`/`edge.promote` (synapse thread),
  `node.merge`→absorb. In-view = graph-space gesture; **off-screen = far-field "weather"** so the whole
  galaxy shimmers where work happens. `kg:focus-move` (subconscious walk) bridged in as `node.enrich`.
- **Two-source galaxy (structure + REAL read)** — the Side Quest short-term store renders as the violet
  **active core** merged into every view (`shortTerm` layer + `withShortTerm` + `makeCoreForce`), styled by
  `store`/`epistemic` (speculated=translucent+dashed → confirmed=solid). Real read: `db.graphRelationsAmong`
  + `main.js kg:shortterm` (top-90 recent local entities + relations + 18 recent unpromoted docs) + preload
  `shortterm()` + `loadShortTerm()`. Verified live: 105 real nodes, 306 total, 59fps.
- **LIVE core** — `loadShortTerm` re-polls every **5s, change-gated** (idle polls don't reheat); fresh nodes
  spark; a **bulk pull (≥8 new nodes) fires a SUPERNOVA** (flash+shockwave+spokes); in Follow the camera
  **flies to the supernova** (`centerAt` + `superNovaHoldUntil`).
- **PERF (3 fixes — the 2D-canvas ceiling)** — perpetual focal `linkDirectionalParticles`→0; `shadowBlur`
  gated to focal/hovered/hub/cross-store only; **tendrils capped to top-40 by hidden-degree**. Took a dense
  follow view 28fps→59fps, 71/90→0/90 dropped frames. LESSON: these are 2D-canvas costs that vanish in WebGL.

**Real-emitter track — SHIPPING (reboot-gated, held):**
- **Slice 1 — the `kg:activity` IPC channel** (commit `8f36bcb`): preload `sq.kg.onActivity` + a `main.js
  emitKgActivity(payload)` broadcaster (exposed as `global.__emitKgActivity`) + a `kg:dev-activity` CDP
  round-trip trigger. The renderer's `onActivity` dispatcher (already built) is now actually served.
- **Slice 2 — real SQ emitters** (commit `bbd5622`): one tap on `lib/graph_memory.js` pushes `node.born`
  (new canonical) / `node.enrich` (trust upgrade) / `edge.born` (grounded edge, both endpoints) via a new
  `lib/kg_activity.js` safe surface. Speculated proposals stay silent. Renderer debounces `node.born` vs the
  5s poll so they don't double-spark. Proven: `smoke_graph_memory.js` +5 payload assertions (26/26).

- **Slice 2b — cross-store currents** (commit `0eaf30d`): `match.hit` (echo_suit `resolveMention` wrapper —
  recognition arc), `recall` (active_recall — corpus record pulled inward), `promote` (`promoteDocumentsPass`
  — graduation arc), `think` (`db.insertMonologue`, throttled ≥3.5s ambient heartbeat). Emitter-only: the
  renderer already routes these as far-field "weather". Smoke-covered (positive + negative each); `promote` is
  live-verify only (main.js fn). Full gate 180/180.

**Still design-only / NOT built:** the **Echo `graph_change_feed` trigger** feed (§4, Slice 3 — separate
NX-ECHO Python repo + MCP restart, gated on Echo up). The live core still uses **polling**; **Slice 4** retires
its gesture role, then adds `doc.land`/`news` (they overlap the poll today) + cross-store **federation threads**
(short↔long by name-match, currently 0) — held because they change existing behavior and need live eyeballing.
**Renderer Stage-B gesture polish** (recognition ARC / inward recall WAVE / graduation ARC in place of weather)
is renderer-only → CDP-iterable without a reboot. Dev hooks:
`__kgActivity/__kgActN/__kgDedup/__kgCuration/__kgNova/__kgRefreshST/__kgSeedShortTerm` + `sq.kg.devActivity`.

**NEXT: the full 3D jump** (three.js/`3d-force-graph`, both in-stack) — bloom=shader pass, gradients=GPU,
instanced nodes → the capped 2D richness returns cheaper. The two-source structure + perf discipline port.

---

## 1. The unlock — one tap per store captures ~everything

Neither store needs its call-sites instrumented one by one:

- **Echo (choke = DB triggers).** Degree triggers on `relations` (`store.py:1221-1265`) fire on *every*
  edge INSERT/DELETE/UPDATE — including the resolve/merge/audit paths that bypass `relation_log`. FTS
  triggers on `entities` (`store.py:175-184`) fire on *every* node write — including the pure
  `canonical_id`/`degree`/`display_name` UPDATEs. **Add two sibling triggers → one
  `graph_change_feed(op, kind, id, anchor, ts)` table → pump through the existing
  `echo/event_bus.py::publish("kg", …)`.** That single addition captures 100% of node/edge
  create/merge/delete/degree-flip with entity-id anchors. Semantic lanes (merge, promote, link) emit
  their richer events on top (merge already does via `applied_sample`).
- **Side Quest (choke = one module).** All local node/edge writes funnel through
  `lib/graph_memory.js` (`recordEntity`/`recordRelation`/`promote*`/`reconcile*`), each returning an
  id + carrying `name`/`nameKey`. One wrapper there taps the whole local graph. Docs = `db.insertDocument`,
  monologue = `db.insertMonologue` (already broadcast as `monologue:tick`), observations =
  `db.recordKgObservation`. Cross-store currents live at known sites (see §4).

---

## 2. The emitter contract — one channel: `kg:activity`

Generalize `kg:curation-move` into a single bus. `main.js` broadcasts to the KG webview; the renderer
routes on `kind`. Back-compat: the current `kg:curation-move {kind:'dedup',…}` keeps working, mapped to
`kg:activity {kind:'node.merge', db:'echo'}`.

```js
kg:activity {
  db:       'echo' | 'sidequest',        // which store — drives placement (corpus vs active core)
  kind:     'node.born' | 'node.promote' | 'node.enrich' | 'node.merge' | 'node.degrade' |
            'edge.born' | 'edge.propose' | 'edge.promote' | 'edge.prune' |
            'match.hit' | 'recall' | 'promote' | 'doc.land' | 'observe' | 'news' |
            'audit.clean' | 'think',      // see §3 taxonomy
  op:       'create'|'update'|'merge'|'delete'|'promote'|'recall'|'match',  // coarse effect
  anchor:   '<entity name or id>',        // primary node the animation plays on
  anchor2:  '<other entity>' | null,      // 2nd endpoint (edges / match / recall)
  count:    <int>,                        // batch size (coalesced) → intensity via log(N)
  tier:     'curation'|'growth'|'clean',  // intensity tempo (existing metabolism)
  epistemic:'witnessed'|'told'|'read'|'speculated'|'anticipated'|null,  // SQ-only, colors the gesture
  meta:     { degree?, confidence?, source?, kind_detail? }   // optional
}
```

**Placement rule (critical — the view shows ~40–320 of 1.74M):**
- `anchor` **in view** → play the full graph-space gesture on the node.
- `anchor` **off-screen** → contribute to the **far-field "activity weather"**: the distant cosmos
  shimmers/flares where activity is happening (densest = busiest region). In Follow mode you fly toward
  the weather and the gestures resolve into full detail. This is what makes the *whole* galaxy feel alive
  without needing every node on screen — and it's the same graceful-degrade the absorb already uses.

**Taming the firehose:** reuse the tiered metabolism + coalescing (per `kind`+region window; N events →
one gesture scaled by `log N`). `think`/`monologue` is high-volume → it drives an **ambient background
rate** (a breathing "she's alive and working" shimmer), never a per-event strobe.

---

## 3. Event taxonomy → animation vocabulary

Gestures reuse the shipped neuron kit (birth-fade, growth pulse, absorb, tendrils, soma-breathing,
signal pulses, shockwave ring) + a few new ones. Priority tiers: **P0 = nodes/edges**, P1 = cross-store
currents, P2 = ambient.

### P0 — NODES
| kind | fires on (Echo / SQ) | animation |
|---|---|---|
| `node.born` | entity.create / promote; local grounded entity | **birth-fade + spark bloom**; SQ tinted by `epistemic` (speculated = translucent, witnessed = solid) |
| `node.promote` | tenant→public promote; SQ→Echo graduation | node **crystallizes** (soft→solid ring lock-in); short→long = a **graduation arc** out of the active core into the corpus |
| `node.enrich` | entity.update, confidence/summary upgrade, degree recompute | gentle **brighten + one breath**; degree change smoothly grows/shrinks the bloom |
| `node.merge` | dedup apply | **ABSORB** (shipped) — duplicates collapse inward, canonical blooms |
| `node.degrade` | tombstone / delete / reject / unmerge | **fade to ghost** then out (reject = quick puff) |

### P0 — EDGES (the top priority — "connections")
| kind | fires on | animation |
|---|---|---|
| `edge.born` | relation.create; local relation.born | a **light-thread grows** between the two nodes (synapse forming) + a travelling pulse along it |
| `edge.propose` | tenant relation proposal; local relation proposal | a **faint dashed ghost-thread** (tentative synapse) |
| `edge.promote` | relation proposal → public | ghost-thread **solidifies + fires a pulse** |
| `edge.prune` | soft-delete / supersede | thread **retracts / dims** (synapse pruned); supersession = old edge fades as the new one lights |

*(SAME_AS alias edges are never drawn — the `node.merge` absorb represents them.)*

### P1 — CROSS-STORE currents (the "tricks" you named)
| kind | fires on | animation |
|---|---|---|
| `match.hit` | new local mention resolves to an existing Echo entity (`resolveMention`) | **recognition arc**: the new active-core node shoots a bright thread to the matched corpus node — a spark of "I know this" jumping core→corpus |
| `recall` | Echo → short-term (`active_recall`) | a corpus node **lights up** and a wave travels **inward** toward the active core; reference-not-copy → it flares and settles (no node minted) |
| `promote` | short-term → Echo (`promoteDocumentsPass`, nightly) | the **graduation arc**: node travels from core out to the corpus and locks in |
| `epistemic.harden` | speculated→confirmed / correction | the node/edge **sharpens**: translucent → solid (a focus-pull) |

### P2 — AMBIENT (the "always writing, even monitoring news")
| kind | fires on | animation |
|---|---|---|
| `doc.land` | new material into `documents` | a **packet drops** into the active core |
| `news` | news lane ingest | a **stream of packets** flowing in from "outside" the galaxy (an inflow current) |
| `observe` | `kg_observations` staging | faint **staging specks** near the relevant region |
| `think` | `monologue:tick` firehose | **ambient shimmer / background pulse rate** — the living-mind heartbeat, never per-event |
| `audit.clean` | integrity autoclean / daily sweep | the **clean showpiece** (existing `clean` tier sweep) |

**Epistemic coloring (P1 layer, SQ):** `speculated`/`anticipated` render translucent/dashed;
`told`/`read` mid; `witnessed`/`confirmed` solid+bright. Promotion & hardening are the transitions
between these states — so the active core visibly *firms up* over time.

---

## 4. The requested feeds — what each DB context wires

Renderer (this side) builds: the `kg:activity` receiver + dispatcher, the gesture functions, the
far-field activity-weather, coalescing. **Each DB side emits its feed:**

### Echo context (Python)
1. **`graph_change_feed` triggers** on `entities` + `relations` (mirror the existing degree/FTS
   triggers) → append `{op, kind:'node'|'edge', id, anchor_name, ts}`.
2. Bridge that feed to the KG channel via `event_bus.publish("kg", …)` (rail exists) → `main.js`
   forwards as `kg:activity`.
3. Semantic lanes already/next: **merge** → keep `applied_sample` (done). **promote**
   (`auto_promote_grounded` / `promote_*`) → emit `{kind:'node.promote'|'edge.promote', anchor, count}`.
   **link grounding** → `edge.promote`. **audit autoclean** → `{kind:'audit.clean', count}`.

### Side Quest context (Node)
1. **`lib/graph_memory.js` wrapper** → emit `kg:activity {db:'sidequest', kind:'node.born'|'edge.born'|
   'node.enrich'|…, anchor, anchor2, epistemic}` on every local graph write (ids+names in hand).
2. **`match.hit`** at `echo_suit.js resolveMention` (when a new mention resolves to an Echo id).
3. **`recall`** at `active_recall.js` (`_echoSearch`/`_echoObject`) — emit topic + matched Echo anchor.
4. **`promote`** at `main.js promoteDocumentsPass` / `decomposeLandedDoc` (`documents.promoted 0→1`).
5. **`doc.land`** at `db.insertDocument`; **`observe`** at `db.recordKgObservation`; **`news`** at the
   news lane; **`think`** already exists as `monologue:tick` (renderer can subscribe directly or we
   re-tag it).

Payloads stay tiny + additive + safe-with-no-receiver (the dedup rule). Batching/coalescing caps volume
(e.g. Echo bulk promote → one `count`-scaled gesture, like `applied_sample`'s 25/tick cap).

---

## 5. Rollout (nodes/edges first)

- **Stage A (P0, highest value):** `kg:activity` receiver + dispatcher; `node.born`, `node.enrich`,
  `edge.born`, `edge.promote`, plus `node.merge` (already the absorb). Echo `graph_change_feed` tap +
  SQ `graph_memory.js` tap. → the graph visibly builds itself.
- **Stage B (P1 currents):** `match.hit`, `recall`, `promote`, epistemic coloring. → the two-store life
  becomes legible.
- **Stage C (P2 ambient + weather):** `doc.land`, `news`, `think` heartbeat, off-screen activity-weather
  in the far-field. → the whole galaxy is alive.

This all lands *before* the 3D port and ports into it unchanged (the gestures are graph-space; 3D just
gives them depth). The activity-weather is what the "fly into where it's building" Follow experience
flies toward.

---

## 6. Open decisions (for Lucas)
- Lock the **P0 gesture vocabulary** above (node.born spark / edge.born growing thread / promote arc) —
  or tune any gesture before we build (like we picked "absorb inward" from options).
- Confirm the **`kg:activity` contract** so both DB contexts can wire their feeds in parallel.
- `think`/monologue: ambient heartbeat only, or also a faint per-thought mote when in view?
