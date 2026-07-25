# Database shape handoff — 2026-07-25

For the graphics/KG lane. What the stores look like now, what changed this week, and which of those
changes the 3D KG actually has to react to.

> Lane note: this is a **read-only description**. I have not touched `renderer/kg3d.js`,
> `renderer/kg.js`, or anything under the graph lane's boundary
> (`docs/LANE_BOUNDARY_2026-07-22_GRAPH.md`). Everything below is a change to the DATA those files
> read.

---

## 1. Where the data lives (post-carve layout)

The old monolithic `rainey.db` is gone. Three stores, and **attach order is load-bearing** — the carve
left EMPTY duplicate tables behind, so reading the wrong one silently returns zero instead of failing.

| store | path (under `NX ECHO/nx-echo/`) | holds |
|---|---|---|
| **civic_graph** | `data/foundations/civic_graph.db` | `entities`, `relations`, `entity_search` (FTS5) — **this is the KG** |
| **electoral** | `data/foundations/electoral.db` | CRM: `contact`, `account`, `fact__c`, `contact_tag`, `alias_*`, `ref_*` |
| **tenant** | `data/mcps/rainey/isolated.db` | `inbox`, `api_quota_log`, `documents` |

⚠️ `entities` exists in BOTH civic_graph (1.76M rows) and tenant (14 rows). `enrichment_finding`
exists in both electoral (193,632) and tenant (0). Open the union through
`nx-echo/pass_db.py::open_union()` (main → electoral → tenant, **do not reorder**), or open exactly
one file and never ATTACH.

---

## 2. The KG as of right now

**1,764,775 entities / 17 types · 8,631,016 live edges / 551 types.**

| entity_type | count | | entity_type | count |
|---|---:|---|---|---:|
| bill | 1,492,837 | | place | **5,973** |
| person | 127,956 | | concept | 2,829 |
| organization | 74,962 | | event | 1,658 |
| document | 20,228 | | citation | 691 |
| decision | 11,567 | | government_body | 403 |
| office_held | **9,366** | | poll | 287 |
| legal_instrument | 9,147 | | source / theme / network | 2 / 2 / 1 |
| committee | 6,866 | | | |

Top edges: `AUTHORED_BY` 6,787,843 · `CONTRIBUTED_TO` 341,665 · `FUNDED_BY` 244,461 ·
`DONOR_OVERLAP_PAC` 233,871 · `INVOKES` 185,695 · `CO_SPONSORS_WITH` 167,413 · `LINKED_TO` 131,466 ·
`COMMITTEE_PEER` 75,993 · `INFLUENCED_BY` 63,054 · `HELD_OFFICE` 52,874 · `MEMBER_OF` 48,573 ·
`HOLDS_OFFICE_IN` 46,658 · `VOTES_FOR` 36,420 · `CAUCUS_PEER` 31,598 · `REPRESENTS_ON` 31,481.

---

## 3. What changed, and why the KG cares

The 3D view partitions the interior into **lobes by `entity_type`, with each type's sub-lobe sized by
`cbrt(count/total)`** (`buildBrainLobes`, `renderer/kg3d.js:234`). It rebuilds only when the type mix
changes — `_lobeSig` is the string `type:count|type:count|…`. **Every change below moves that
signature**, so a rebuild will fire on next load. Nothing needs editing for that to work; this is the
heads-up that the anatomy will visibly shift.

### 3a. Places got a spine — the change most visible in the render

`place → LOCATED_IN → place` went from **23 edges to 5,825**, and the place node count grew
**5,956 → 7,054**.

Before, places connected only through their office-holders (`HOLDS_OFFICE_IN`, 46,658), so
city → county → state could not be walked and **1,970 of 5,956 places (33%) had no edges at all**.
Now 2,421 containment edges tie towns to counties to states to countries.

Because the design lets **edges do the modelling** ("links inside a lobe pull it dense, links across
lobes become tracts" — kg3d.js:214), this is a genuinely new dense intra-`place` bundle. Isolated
places dropped **1,970 → 1,007**.

**The shape it makes is a 4-level tree**, which is new information for the layout:

```
city/town  →  county  →  state  →  country  →  continent
   e.g. Cary, NC → North Carolina → United States → North America
```

1-hop 5,828 · 2-hop 5,774 · **3-hop 5,709**. Almost every edge participates in a deep chain rather
than a flat star, so the place lobe should now read as a hierarchy — 50 state hubs and ~1,332
county nodes between the cities and the handful of country roots. If the layout has any notion of
tree depth or edge direction, `LOCATED_IN` is the first relation in this graph worth using it on.

**1,035 new county nodes were minted** to build the middle rung (the graph held 308 county/parish
places against ~3,143 real US counties). They are demand-driven — only a county some place we hold
actually names as its parent — and all carry `wikidata_qid`.

- Written by `nx-echo/pass80_place_hierarchy.py` (`proposed_by='place_hierarchy:v1'`), idempotent.
- Edges are `LOCATED_IN`, child → parent, `confidence=0.95`. Two sources: names that state their own
  parent, and Wikidata P131.
- ⚠️ Duplicate identity is handled via `canonical_id` (11,620 entities use it). `United States` has
  two place rows — `United States` and `United States [wd:Q30]` — with the latter pointed at the
  former. **Any node view that groups by QID must prefer the row whose `canonical_id` is NULL**, or
  the US will appear twice.

### 3b. New country nodes, and 8 nodes changed type

12 countries now exist as `place`. Eight of them **already existed but were typed `person`** —
`refresh:wikidata_organizations` read the UN's founding-member list and filed every member state as a
person. Those were retyped in place (not duplicated), so **8 node IDs moved from the person lobe to
the place lobe**. Four were newly minted.

⚠️ Naming convention worth knowing: `entities.name` is UNIQUE **across every entity_type**, so where a
bare name was taken (a Wikiquote article called "England"), the place is named `England [wd:Q21]`.
Any display code that strips a trailing ` [wd:Q…]` for labels will read better. `wikidata_qid` is
populated on 2,511 places.

### 3c. 55 nodes retyped against Wikidata — DONE (`ace9fe2`)

`pass81_retype_wikidata_targets.py` asked Wikidata `P31` about all 3,763 QID-suffixed entities.
**3,408 were already correct; 55 were not.** Moves:

| from → to | n | examples |
|---|---:|---|
| person → place | 43 | `United States [wd:Q30]`, `Soviet Union`, `Turkey`, `Argentina` |
| office_held → government_body | 5 | `Kansas Department of Administration` |
| person → organization | 4 | |
| office_held → organization | 2 | `Republican Party [wd:Q29468]`, `Democratic Party` |
| organization → government_body | 1 | |

**Final type mix** (this is the current lobe signature): bill 1,492,837 · person **127,912** ·
organization **74,968** · document 20,228 · decision 11,567 · office_held **9,359** ·
legal_instrument 9,147 · committee 6,866 · place **6,018** · concept 2,829 · event 1,658 ·
citation 691 · government_body **409** · poll 287 · source 2 · theme 2 · network 1.

⚠️ **13 entities have a QID pointing at a Wikidata disambiguation or list page** —
`District Judge [wd:Q5283340]`, `list of speakers of the Massachusetts House [wd:Q6597942]`. Those
are wrong LINKS, not wrong types, and were deliberately left alone. If the UI ever renders a
Wikidata link from `wikidata_qid`, these 13 will go somewhere useless.

### 3d. CRM side (does not affect the KG directly)

`Jurisdiction_Canonical` coverage went 49% → 78% (86,275 contacts; 38,491 federal). `alias_state`
grew 51 → 145 written forms. Only relevant to the KG if a view joins contacts to entities via
`entities.contact_id`.

---

## 4. Things that will bite

1. **`event` is 1,658 nodes but only ~4 are real convenings.** The rest are news headlines the news
   lane typed as events ("Where to watch Spain vs. Belgium today"), because
   `lib/news_lane.js:837` names the object with the article headline. **Do not build an event-centric
   view on this yet** — the type is not trustworthy and is scheduled for rework (task #24).
2. **`ATTENDED` (3,891) is doing double duty.** 3,522 of those edges point at an `organization` and
   mean *alumni* ("attended University of Georgia"); only 366 point at an `event` and mean
   attendance. Don't render them with one meaning.
3. **Isolated nodes are still significant**: place 1,005 · organization ~16,152 (22%) ·
   person ~23,900 (19%) · event 1,264 (77%). If the layout drops zero-degree nodes, a large fraction
   of the corpus never appears.
4. **`degree` on `entities` is a cached column and drifts.** Count from `relations` if exactness
   matters.
5. **Soft deletes everywhere.** `relations.deleted` and `contact.deleted` — always filter
   `COALESCE(deleted,0)=0`. Live edge counts above already do.
6. **`bill` is 85% of all nodes.** Any unweighted type-proportional layout is a bill lobe with
   confetti around it; the `cbrt` sizing already compensates, which is worth preserving.

---

## 5. Provenance tags added this week

Filterable via `relations.proposed_by` / `entities.proposed_by`:

| tag | what |
|---|---|
| `place_hierarchy:v1` | the 2,421 `LOCATED_IN` containment edges + 4 minted countries |
| `retype:wikidata_p31:v1` | pass81 retypes (in flight) |

Both are reversible: delete by `proposed_by` for the edges; retypes are recorded per-row with
`updated_at`.
