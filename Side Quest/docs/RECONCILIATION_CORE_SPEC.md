# Reconciliation Core — Interface Spec (v1)

**Owner:** Zoe Builder context. **Consumers:** the Monitor/news-stream context (news lane) + this context (research corrections + recall). One contract; one context implements the core, the other consumes it.

**The law** ([[zoe-is-the-memory]]): new information about an object/edge must *accrete back into the substrate*, reconciled — not appended sideways as a dead-end doc. Two ingest lanes (news, research), **one** object graph, **one** reconciliation.

**Grounded in verified constraints (this session):**
- Echo `propose_entity` FK-rejects an **unregistered `entity_type`** (0 successful calls; `event` type absent) and is the citation-gate at the DB level.
- Echo `propose_relation` accepts only **71 whitelisted types**; `INVOLVES`/`MENTIONS`/`ABOUT` are **not** whitelisted — `LINKED_TO`, `RELATED_TO`, and **`SUPERSEDES`** are.
- `search_entities` returns `{id,name,entity_type,entity_subtype,summary,confidence,rank,snippet}` — **no `wikidata_qid`/`degree`** (grouping needs a `db_query` follow-up).
- Short-term **`verified_facts` table is NOT materialized** in `sq.db` — corrections currently land as loose, unranked `knowledge` notes. Materializing it is prerequisite #1.
- Reusable primitives already exist: `lib/news_lane.js` (corroboration), `lib/staleness.js` (TTL), `lib/graph_memory.js` (epistemics), `lib/echo_suit.js` (resolver, R1).

---

## 1. The `Claim` — the shared candidate shape (both lanes emit this)

```js
Claim = {
  kind:      'entity' | 'edge' | 'event',
  subject:   { name, type, ref? },        // ref = canonical id once resolved (via R1)
  predicate: relation_type | null,        // edges: a WHITELISTED Echo type
  object:    { name, type, ref? } | null, // edge target
  value:     string,                      // the assertion ("US Attorney General until 2026-04-02")
  as_of:     'YYYY-MM-DD' | null,          // the fact's EFFECTIVE date — NOT crawl/publish time
  ttl_class: 'volatile'|'stable'|'permanent',   // staleness.classify(value)
  citations: Citation[],                   // >=1 REQUIRED to promote (else reject)
  corroboration: { reports, outlets, authority, tier },   // filled by §2
  provenance: 'witnessed'|'told'|'read'|'anticipated',    // graph_memory epistemic gate
  lane:      'news' | 'research' | 'chat',
}
Citation = { source_id | url, title, fetched_at, authority_tier, report_key }
// authority_tier: 3 primary/gov (justice.gov, SEC) · 2 major outlet · 1 blog/aggregate · 0 unknown
```

Rule: `speculated` provenance never becomes a Claim (stays a proposal — graph_memory law).

---

## 2. Corroboration scoring — REUSE the news-lane primitives (shared math, do not reinvent)

```js
score(citations) -> { reports, outlets, authority, tier }
  reports   = |distinct news_lane.reportKeysOf|      // syndication-collapsed: 30 wire copies = 1 report
  outlets   = |distinct news_lane.outletsOf|
  authority = max(c.authority_tier)
  tier      = news_lane.corroborationTier(reports)   // 'none'|'weak'|'corroborated'|'strong'
```
- Independence via `reportKeysOf` + `isSyndicatedRepublication` — *"the internet echoed it"* must not inflate the count.
- A source **retraction/correction** on the incumbent's citation → `news_lane.detectRedactionSignal` → supersede-bias signal.

---

## 3. Identity match — the R1 resolver (echo_suit, my other deliverable)

```js
echo_suit.resolveMention(subject.name, { preferType }) -> { status, object, candidates? }
  // 'resolved'  -> object (canonical, richest by QID group)
  // 'ambiguous' -> candidates[] (different QID, same name) -> reconcile returns ASK
  // 'nil'       -> no match -> reconcile may create NEW (if citation present)
```
Reconciliation **consumes** this; it does not resolve names itself. `ambiguous` ⇒ never write, ASK.

---

## 4. `reconcile(claim, incumbent)` — the core decision (the thing I implement)

```js
reconcile(claim, incumbent) -> {
  action: 'new' | 'merge' | 'supersede' | 'append' | 'reject' | 'ask',
  reason,
  corroboration?,        // merged score on 'merge'
  supersedes_ref?,       // incumbent edge/fact id on 'supersede'
}
```

**Decision table (deterministic; no cloud model in the decision):**

| Condition | Action |
|---|---|
| `citations.length == 0` | **reject** — nothing to long-term without citation |
| resolver `ambiguous` | **ask** — different same-named entities |
| resolver `nil` (no incumbent) | **new** |
| `kind == 'event'` | **append** — cluster via `classifyContinuation` (≥.60 continue); events never supersede |
| incumbent exists, claim **agrees** | **merge** + boost corroboration (union citations, `tier` re-scored) |
| incumbent **contradicts**, `ttl=volatile` | **supersede** iff `claim.as_of` newer **AND** `tier ≥ corroborated` (≥2 reports) **OR** `authority ≥ 3`; else **ask** |
| incumbent **contradicts**, `ttl=stable/permanent` | **supersede** iff newer **AND** `claim.corroboration ≥ incumbent.corroboration`; else **reject/hold** |
| incumbent's citation **retracted** | bias toward **supersede** (lower the incumbent's bar) |

Recency = `as_of` (effective date), **weighted by `ttl_class`** — volatile leans recency, stable/permanent leans corroboration. That closes the *"internet said it once"* hole.

---

## 5. Short-term store + the precedence gate (prerequisite + the Pam-Bondi fix)

**Materialize the short-term verified store** — `sq.db` table `verified_facts`:
```
verified_facts(id, subject_key, subject_ref, predicate, value, as_of, ttl_class,
               reports, outlets, authority, tier, citations_json,
               contradicts_ref, status /* open|promoted|superseded */, created_ts)
```
Capture writes here on a passing `reconcile` (§7). This is what recall can *prioritize* and the overnight pass can *promote*.

**Precedence gate (pure) — hooks into `active_recall` grounding assembly:**
```js
precedence(shortTermFact, echoObjectLine) -> 'short-term-wins' | 'long-term-wins' | 'merge'
  // short-term WINS when it exists for this object AND cleared the §4 bar for its ttl_class
```
On `short-term-wins`: the verified short-term fact **leads** the grounding and the conflicting Echo line is tagged `[superseded by verified fact, as_of YYYY-MM-DD]` — so recall stops serving the stale record *before* the overnight reconcile. (Fixes: the Echo object currently leads unconditionally; the correction sits beneath it, unranked.)

---

## 6. Promotion — overnight, citation-gated (into Echo)

`promote.js` (+ `news_lane.runDailyPass`) carry `status='open'` verified facts → Echo via the proposal rail:
- **object:** `propose_entity` — type MUST be registered (`approve_entity_type` first; e.g. `event`), summary carries the assertion; the landed evidence doc is the citation link.
- **edge / belief-revision:** `propose_relation` with a **whitelisted** type — `SUPERSEDES` for the corrected→stale edge; `LINKED_TO`/`RELATED_TO` for association. **Never** `involves`.
- **supersede:** emit the `SUPERSEDES` edge + lower the stale edge's confidence/mark superseded; **merge:** boost confidence.
- Idempotent; a candidate with no citation is rejected at the proposal (FK), not written.
- On success: `verified_facts.status = 'promoted'`. **This is the "gold star" — the corrected object lives in Echo, cited, forever.**

---

## 7. Lane adapters (each context provides its own; the core is shared)

| Adapter | Owner | Emits |
|---|---|---|
| **news** | Monitor context | story → `Claim{kind:'event', provenance:'read', corroboration from reportKeysOf/outletsOf}` at `runDailyPass` |
| **research** | this context | wrap-up finding → `Claim{kind:'edge'/'entity', citations from visited sources}` at `condenseRun` |
| **chat** | this context | user-confirmed correction → `Claim{provenance:'told', authority high}` |

---

## 8. Hook points (verified files)

- **Resolve:** `echo_suit.resolveMention` (R1 — type-drop + QID grouping).
- **Corroboration:** `news_lane.{reportKeysOf,outletsOf,corroborationTier,isSyndicatedRepublication,detectRedactionSignal}` — shared.
- **TTL / recency:** `staleness.{classify,ttlDays,isStale}`.
- **Core decision:** `lib/reconcile.js` (NEW — I implement) exposing `score`, `reconcile`, `precedence`.
- **Capture:** research `condenseRun` (wrap-up) + news `runDailyPass` → `reconcile` → `verified_facts`.
- **Precedence:** `active_recall.recall` grounding assembly (the gate).
- **Promote:** `promote.js` overnight + `news_lane.runDailyPass`.

---

## 9. Ownership / build order

1. **`lib/reconcile.js` core** (`score`/`reconcile`/`precedence`) — **I implement**; pure + dep-injected + smoke-tested. Both lanes consume.
2. **`verified_facts` table + capture** — **I implement** (research + chat adapters).
3. **Precedence gate in `active_recall`** — **I implement** (shared file; coordinate before edit).
4. **Resolver R1** (`echo_suit`) — **I implement** (feeds §3).
5. **News adapter** (`news_lane` → `Claim`) — **Monitor context** consumes the core.
6. **`promote.js` supersede/merge edges** — coordinate (shared).

**Non-goals (v1):** multi-hop belief chains; automatic re-verification cron (rides the existing staleness/currency reflex); cross-lingual corroboration.
