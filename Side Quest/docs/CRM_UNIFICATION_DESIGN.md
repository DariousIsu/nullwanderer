# CRM Unification — the person object and its one true home

**Status:** DESIGN — no code written. Authored 2026-07-24 after a live deliverable failure.
**Author:** Zoe dev session (boot96). **Reviewer:** Lucas.

---

## 1. What broke, precisely

Live test, boot96:

> **Lucas:** "Make me a contact sheet of all the Parish leadership in Louisiana, include their names title Parish and email"
> **Zoe:** "Do you want the contact sheet displayed here or added to a Canvas document?" → *"Canvas please"*
> **Zoe (thought):** "I don't have any emails collected yet… I'll start by searching the web."
> **Zoe:** "Pulling a web source that lists Louisiana parish officials…"

She then drifted and **no document was ever produced**. The newest canvas doc predates the request by ~70 minutes.

The reflex diagnosis — "the query composition is fumbling" — was **wrong**, and so was the second one
("we don't have parish data, so the web was correct"). Both were assumption, not measurement. The truth:

**We hold 1,150 Louisiana parish leadership records. They are in Puller. The CRM has 0.**

```
Glenn Benton        | Bossier Parish            | 2019 President
Eric Soileau        | Evangeline Parish         | President
Stormy Gage-Watts   | Caddo Parish Commission   | Commission President
Brenda Abercrombie  | Union Parish Police Jury  | President
```

She went to the open web to re-gather what she already had, because the store she reads
(the CRM) is not the store the data landed in (Puller).

### The root, in one line
**Puller became a reservoir instead of a tool, and the door to the CRM was never opened.**

This predates the solidification of what a "real person object" is. Puller-as-separate-store existed to
*grade candidates before object creation*, back when that bar was narrow and uncertain. That shape was
abandoned once "real person object" was defined broadly — but the plumbing was never re-cut. So a
processing unit has been silently acting as the system of record.

---

## 2. Measured state (2026-07-24, not estimated)

| | |
|---|---|
| Puller live targets | **328,665** (all `kind='person'`) |
| …with `crm_id` set (promoted) | **0** — 0.0% |
| …status `adhoc` / `promoted` | 327,760 / 9 |
| Puller **beliefs** (graded enriched facts) | **495,012** |
| …targets w/ company · domain · notes | 238,710 · 72,933 · 280,549 |
| Obvious non-person rows (PAC/committee patterns) | **326** (~0.1%) |
| ALL-CAPS names (bulk-load signature) | 35,273 |
| **CRM live contacts** | **110,319** |
| …with Email · Phone · Org (`AccountId`) | 13,326 (12%) · 13,059 (12%) · 21,837 (20%) |
| …with no `Enrichment_Stage__c` | 109,841 (99.6%) |
| `entities` person nodes | 124,814 (17,734 = 14% carry a Wikidata QID) |
| …carrying a contact/CRM external id | **0** |
| LA parish people: Puller vs CRM | **1,150 vs 0** |

Two facts drive the whole design:

1. **Nothing has ever flowed Puller → CRM.** Not "a few slipped." Zero, out of 328k.
2. **The CRM's biggest gap is exactly Puller's biggest asset.** 88% of CRM contacts have no email;
   Puller holds 495k graded facts. These two stores are the halves of one object.

`puller_db.promoteTarget(id, crmId)` exists but only *records* a linkage after a CRM row exists —
and `puller_db.js:10` states outright that Puller "references CRM/Echo rows by id only — it never
edits them." The bridge was built read-only by design. **Nothing was ever built to create the CRM row.**

---

## 3. The model

Grounded in [Popolo](https://www.popoloproject.com/specs/), adopted by
[Open Civic Data in 2014](https://open-civic-data-docs.readthedocs.io/en/latest/proposals/0005.html) —
the standard this data already belongs to (`OCD_Person_Id__c` *is* that ecosystem).

**A person is one object — a node in the graph.** Its facts come in two shapes:

- **attribute-facts** — values describing the person, pointing at nothing:
  birthday, description, notes, phone, email, gender
- **edge-facts** — links to *other objects*: employer/org, elected body, jurisdiction, school,
  event, agency. In Popolo terms these are **Memberships** (person + org/post + time span).

**The CRM line is the materialized, unified read-out of that object** — one row per person, where
descriptive columns fill from attribute-facts and relational columns fill from edge targets.
The CRM is not a rival store of truth; it is the flattened, queryable face of the object.

### The three rules
1. **Creation lands in the CRM.** If the system would mint a person object, it is born as a CRM
   contact + a linked graph node. There is no pre-object holding pen.
2. **Puller is a completion engine, not a store.** It sweeps the *CRM* for incomplete people and
   works to fill them. Its autonomous hunting points at the CRM.
3. **A role is not an attribute of a person — it is a membership.** Sector/level classification is
   *derived* from current memberships, never hand-stamped (see §5).

---

## 4. The identity crosswalk (the "internal documentation system")

### The problem it solves
17 of `contact`'s ~92 columns are external identifiers:

`sf_id` · `external_id` · `OCD_Person_Id__c` · `Bioguide_Id__c` · `VoteSmart_Id__c` ·
`FJC_Judge_Id__c` · `CL_Person_Id__c` · `FEC_Candidate_Id__c` · `GovTrack_Id__c` ·
`OpenSecrets_Id__c` · `ICPSR_Id__c` · `Ballotpedia_Slug__c` · `Cspan_Id__c` ·
`LAMP_Member_Id__c` · `Legacy_Insightly_Record_Id__c` · **`Wikidata_Id__c` AND `Wikidata_Qid__c`**

That last pair is the tell: the *same* identifier already drifted into two columns. Every new source
costs a schema change, and nothing reconciles them.

### Shape
```
contact_identifier
  contact_id     INTEGER  -- FK → contact.id
  system         TEXT     -- 'entity' | 'wikidata' | 'ocd' | 'bioguide' | 'fec' | 'salesforce'
                          -- | 'insightly' | 'lamp' | 'govtrack' | 'opensecrets' | 'icpsr'
                          -- | 'cspan' | 'votesmart' | 'ballotpedia' | 'fjc' | 'courtlistener'
                          -- | 'puller' | 'lda' | …open
  value          TEXT
  confidence     REAL     -- how sure we are of THIS linkage
  source         TEXT     -- where the linkage came from (feed/url/operator)
  first_seen     INTEGER
  last_verified  INTEGER
  PRIMARY KEY (contact_id, system, value)
  INDEX (system, value)   -- reverse lookup: "who is bioguide A000355?"
```

### What it buys
- **contact ↔ node linkage for *every* person** — the graph link is just a row (`system='entity'`),
  so 100% coverage instead of the 14% that carry a Wikidata QID. **This is the join that does not
  exist today, and without it no CRM column can ever be filled from an edge.**
- **Every number a contact can be found by**, in one place, including ones we haven't met yet —
  **no schema change per source**.
- **Bulk Salesforce ingest** — a batch upsert on `system='salesforce'`, with history retained
  (`first_seen`/`last_verified`) rather than silently overwritten.
- **Dedup fuel** — a strong id match is the *only* safe auto-merge key. Memory records a resolver
  that falsely identified a person on first name; the crosswalk is how we never do that again.

**Migration:** the 17 columns are *copied* to crosswalk rows, then left in place (read-only,
deprecated) until every reader is repointed. Nothing is dropped in the first pass.

---

## 5. Classification tags — one table, two axes, derived

**Decision: one `contact` table + indexed tags** (not separate facet tables). Least disruptive to
everything already reading `contact`, and it gives the fast filtering the deliverable path needs.

**Tags are DERIVED and materialized, not hand-typed.** A person's sector changes — a corporate exec
becomes a cabinet secretary, a legislator becomes a judge. A hand-set tag goes stale, which is the
exact disease this whole document exists to cure. Derived from current memberships/edges and
refreshed on change, filtering is fast *and* stays true.

*Precedent already in this schema:* `Party_Canonical`, `Jurisdiction_Canonical`,
`Office_Role_Canonical`, `State_Represented`, `Active_Status` are already derived/materialized
canonical columns. This is not a new pattern here — it is the one already working.

```
contact_tag
  contact_id    INTEGER
  axis          TEXT     -- 'sector' | 'level'
  value         TEXT
  derived_from  TEXT     -- the membership/edge that produced it (auditable)
  since         INTEGER
  current       INTEGER  -- 1 = holds now, 0 = historical
  PRIMARY KEY (contact_id, axis, value)
  INDEX (axis, value, current)
```

Multi-valued by design: a person is several things at once and over time.

### Axis 1 — `sector` (what world)
`government-elected` · `government-appointed` (constitutional officers: AG, SoS, treasurer) ·
`judicial` · `civil-service` (agency/department staff) · `education` (K-12, higher-ed) ·
`research` (academic, think-tank) · `corporate` · `nonprofit-advocacy` · `media` · `labor` ·
`religious` · `military` · `political-ops` (campaign staff, consultants)

### Axis 2 — `level` (what scope)
`federal` · `state` · `county-parish` · `municipal` · `tribal` · `international`

### Why the second axis is not optional
**It is the failed test.** "Parish leadership in Louisiana" =
`sector:government-elected` + `level:county-parish` + `State_Represented:LA` — one indexed query.
Without a level axis, a parish president is indistinguishable from a state legislator, which is
precisely why that request had nowhere to land. (`Office_Role_Canonical` already holds values like
`state_lower` — sector and level fused into one string. The schema was reaching for this already.)

**Relationship-to-us is a third axis that already exists** as `Tier__c` / `Engagement_Stage__c`.
Leave it alone; it is operator-set, not derived.

---

## 6. Column assignment (~92 existing columns)

**Principle:** the table keeps its columns — we stop *growing* it. New facet data goes to the fact
layer; new identifiers go to the crosswalk.

| Group | Columns | Disposition |
|---|---|---|
| **Spine** (every person) | `FirstName` `LastName` `Salutation` `Suffix` `Title` `Description` `Birth_Date__c` `Gender__c` `Deceased__c` `Death_Date__c` `Contact_Kind__c` `merged_into` | keep — attribute-facts |
| **Contact channels** | `Email` `Phone` `MobilePhone` `Fax` `Mailing*` (5) | keep — attribute-facts; Puller's fill target |
| **Org edge** | `AccountId` → `account.id`, `Reports_To_Contact_Id__c` | keep — **edge-fed** |
| **Elected facet** | `District__c` `Party__c` `Chamber__c` `Jurisdiction__c` `Active_Elected__c` `Sponsorship_Count__c` `Leadership_Role__c` `State_Represented` `Party_Roster` `Office_Role_Canonical` | keep — **edge-fed** from membership |
| **Judicial facet** (11) | `Court_Type__c` `Court_Name__c` `Appointing_President__c` `Commission_Date__c` `Senior_Status_Date__c` `Termination_Date__c` `Active_Service__c` `Chief_Judge__c` `Court_Url__c` `Confirmation_Vote_Yea__c` `Confirmation_Vote_Nay__c` | keep, but **NULL for ~all non-judges** — the clearest evidence for tags; new facets do NOT follow this pattern |
| **Identifiers** (17) | see §4 | **→ crosswalk** (columns kept read-only, deprecated) |
| **CRM ops** | `Tier__c` `Engagement_Stage__c` `Last_Interaction_Date__c` `Donation_Total__c` `LAMP_Category__c` `OwnerId` `Insightly_Owner__c` `Do_Not_Email__c` | keep — operator-set |
| **Enrichment state** | `Last_Enriched_Date__c` `Enrichment_Stage__c` `Email_Validated_At__c` `Email_Deliverable__c` `Email_Quality_Score__c` | keep — **this is the inverted-Puller work queue, already in the schema and 99.6% unused** |
| **Derived canonical** | `Party_Canonical` `Jurisdiction_Canonical` `Active_Status` `Tier_Canonical` | keep — precedent for derived tags |
| **Media/profile** | `Wikipedia_Url__c` `Ballotpedia_Url__c` `Image_Url__c` `Profile_Url__c` `Notes_Public__c` `Notes_Private__c` | keep — attribute-facts |

---

## 7. The three mechanisms

### 7a. The feed — creation lands in the CRM
One function: **given a person object, create/maintain its unified CRM line.**

```
upsertPersonObject({ name, attributeFacts, edgeFacts, identifiers, provenance })
  1. RESOLVE identity  — strong id via crosswalk → else blocked-name + org/jurisdiction match
                         → else MINT. Never match on name alone (see Risks).
  2. WRITE the spine   — attribute-facts → descriptive columns
  3. WRITE the edges   — edge-facts → AccountId / Jurisdiction / Chamber / District,
                         and the corresponding graph relations
  4. LINK              — crosswalk rows for every identifier, incl. system='entity'
  5. DERIVE tags       — sector + level from current memberships → contact_tag
  6. STAMP provenance  — source + confidence per fact (existing encounter/observation vocabulary)
```

Every creation path (doc-decompose, news lane, puller discovery, meeting, manual) calls this one
door. That is the invariant that makes "the CRM is the ultimate store" true rather than aspirational.

### 7b. The drain — 328k Puller targets through that same door
Not a bulk `INSERT`. It runs the *same* `upsertPersonObject`, so the backlog is cleaned as it installs:

1. **Real-person gate** — the ~326 obvious PAC/committee rows and a share of the 35,273 ALL-CAPS
   bulk rows are organizations, not people. Route them to their correct object type (org/committee);
   never force them into the person CRM. *This is the cleanup opportunity, taken deliberately.*
2. **Dedup against the CRM's existing 110,319** — strong-id first (crosswalk), then blocked
   candidate match, then held for review. Auto-merge ONLY on a strong id.
3. **Carry the 495,012 beliefs** as graded attribute-facts — this is what fills the CRM's 88%-empty
   email/phone columns. Confidence and derivation survive the move.
4. **Link back** — `promoteTarget(id, crmId)` (already written) + a `system='puller'` crosswalk row,
   so the drain is idempotent and resumable.
5. **Batched, resumable, observable** — cursor-driven; never a single 328k transaction.

### 7c. The inverted Puller — sweep the CRM for incompletes
Puller stops being a destination and becomes the completion engine:

- **Work queue = the CRM's own gaps**, using columns that already exist:
  `Email IS NULL` (96,993 contacts), `Phone IS NULL`, `AccountId IS NULL` (88,482),
  `Enrichment_Stage__c IS NULL` (109,841).
- Findings return through `upsertPersonObject` — never to a private table.
- `Last_Enriched_Date__c` / `Enrichment_Stage__c` become the real cursor they were designed to be.

---

## 8. Slices

| # | Slice | Proves | Writes to Echo? |
|---|---|---|---|
| **0** | **Measure + gate, read-only.** Real-person classifier over the 328k; overlap report vs the CRM's 110k; dedup-collision estimate. Output = a report, no writes. | The drain's assumptions are true *before* touching the ultimate store | **No** |
| **1** | **Crosswalk table + backfill** from the 17 identity columns. Add `system='entity'` links where derivable. | The join exists; nothing else can proceed without it | schema + backfill |
| **2** | **`upsertPersonObject`** — the one door. Unit-tested against fixtures, then a **small real batch (the 1,150 LA parish records)**. | The feed works end-to-end on the exact case that failed | yes, bounded |
| **3** | **Tag derivation** (`sector` + `level`) + the indexed read path. | `sector:government-elected + level:county-parish + LA` returns the sheet in one query | yes |
| **4** | **The full drain**, batched/resumable, with the real-person gate live. | 328k installed and cleaned | yes, large |
| **5** | **Invert Puller** to sweep CRM incompletes. | The loop closes; the reservoir never refills | yes |

**Slice 2 is the payoff slice** — at its end, "make me a contact sheet of Louisiana parish leadership"
is answerable from our own records, which is the request that started this.

---

## 9. Risks and rails

- **False identity merges.** The single worst outcome — two people fused into one. Memory records a
  resolver that substituted a person on *first name*. **Rail:** auto-merge only on a strong crosswalk
  id; everything else is held for review. Blocked matching, never bare name.
- **Duplicate CRM rows** (a known open issue). **Rail:** the crosswalk is checked *before* insert;
  the drain is idempotent via `system='puller'` rows, so a re-run cannot double-insert.
- **Polluting the ultimate store with non-persons.** **Rail:** Slice 0 measures it read-only and
  Slice 4 gates on it; orgs route to their own type.
- **Schema change to Echo's CRM** — outside the usual Side Quest lane. **Rail:** Slices 0 is
  read-only; 1 is additive-only (new table, no column drops); the 17 identity columns are kept and
  deprecated rather than removed, so every existing reader keeps working.
- **Scale.** 328k × upsert is not a single transaction. **Rail:** batched, cursor-driven, resumable,
  and — per the freeze lesson (`e71afdf`) — **streamed, never a full-population `SELECT *`**.
- **Derived tags going stale.** **Rail:** tags carry `derived_from` + `current`, and are recomputed
  when a membership changes, not written once.

---

## 10. Open questions for review

1. **`Contact_Kind__c` vs `sector`** — the existing column already holds
   `elected|staff|judge|candidate`. Does `sector` *supersede* it (and we backfill + deprecate), or do
   they coexist as coarse-vs-fine? Recommendation: supersede, since `sector` is derived and
   multi-valued while `Contact_Kind__c` is single and hand-set.
2. **The 35,273 ALL-CAPS rows** — bulk-load signature. Sample before deciding: some are FEC committee
   names (orgs), some may be legitimately-cased-badly people. Slice 0 answers this.
3. **Salesforce direction** — is `system='salesforce'` inbound-only for now, or do we eventually push
   back out? Affects whether the crosswalk needs a dirty/sync-state flag.
4. **Level for non-government sectors** — does a corporate VP get a `level` tag at all, or is `level`
   government-only? Recommendation: government-only; absence is meaningful.

---

## Sources
- [Popolo Data Specification](https://www.popoloproject.com/specs/) — Person / Organization / Post / Membership
- [Popolo: Membership](https://www.popoloproject.com/specs/membership.html) — a role is a membership, not an attribute
- [OCDEP 5: People, Organizations, Posts, and Memberships](https://open-civic-data-docs.readthedocs.io/en/latest/proposals/0005.html) — Open Civic Data's adoption of Popolo (2014)
