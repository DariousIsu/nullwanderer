# Lane boundary — 2026-07-21

Two Claude sessions are working this repo concurrently, on purpose. This is the split, written by
the **conversation lane** (communication / recall / personality / speed) at Lucas's direction, after
reading `RESOLVER_FALSE_IDENTIFICATION_HANDOFF.md`.

It says what each side owns, what is explicitly cleared to the **object-identity lane**, and the
three places we are coupled — which is where a parallel-session collision would actually happen.

---

## 1. Cleared to the object-identity lane — yours, take it

Everything in the handoff. I have not touched and will not touch:

| | |
|---|---|
| `lib/doc_decompose.js` | the whole file, including the `:210` substitution and the `mint` vs `hold` decision |
| `lib/entity_match.js` / `preResolve` | including whether the gate gets a veto |
| The 122 known-incorrect claims | recording, quarantining, or reversing them |
| `object_label` / `lib/encounters.js` write path | restoring the surface form the contract at `lib/db.js:489` already promises |
| Echo-side entity dedup | see §3.2 — there is something here you want to know about |

Your diagnosis stands up. I verified three claims independently before writing this:

- `lib/db.js:489` says verbatim that `object_label` *"keeps what the SOURCE called it, which is
  evidence and must survive resolution."*
- At `lib/doc_decompose.js:557`, `_observe` receives `sourceEntity: sName, target: tName` — both
  canonical, from the `usable` map. The source's own wording is `r.source` / `r.target`, **in scope
  two lines above**, and simply never passed. The evidence is discarded at the exact moment it would
  be recorded.
- The extractor really is innocent; `kg_observations` holds the correct surface names.

One caution from my side of the house, offered because it cost me a night: your §7 counter-risk is
the right thing to watch, and the way to watch it is a **per-run mint/hold/reuse count in the log**.
I shipped four fixes tonight whose only honest verification was a live counter (`[references] 0
resolved / 1 open`, `[package] … references:1374`). A green suite proves the shape of the change,
never its effect.

---

## 2. Mine — do not edit these without pinging

| file | what it is |
|---|---|
| `lib/references.js` | resolves the names in Lucas's message + the meeting's own context |
| `lib/gmeet.js` | her in-meeting behaviour, the chat gate, the action ledger |
| `lib/meeting_scribe.js` | minutes: append-only segments + the raw-transcript digest |
| `lib/cognition.js` | the answer/NEED ladder |
| `lib/package.js` | the cloud prompt package and its section budgets |
| `scripts/smoke_{references,meeting_chat_gate,scribe_append,not_a_question}.js` | |

Landed tonight, all gate-green at 275, **none live yet** (they need a reboot):
`4ba2eb6` references · `8f3ade2` Meet-link resolution · `e1828df` calendar labels · `0498d46`
meeting chat gate + ledger · `342f8c4` meeting context · `e420a34` scribe append+digest.

---

## 3. Where we are actually coupled

### 3.1 Your resolver is my upstream — changing it changes my output

`lib/references.js` calls `echo_suit.resolveMention` and renders on its **status**:

- `resolved` → stated as fact in the prompt: `"Rainey" → Rainey Center`
- `ambiguous` / `nil` → rendered under **NOT PINNED DOWN**, with candidates, and the model is told
  not to guess

So the same disease you found produces the opposite symptom in my lane. Yours binds silently and
destroys the evidence; mine refuses to bind and says so out loud. **If your fix makes the resolver
mint more, my reference block will start asserting freshly-minted nodes as though they were known
entities.** That is the failure mode I would least like to inherit.

What I need from your fix is only this: **a nil that stays nil, and an ambiguity that stays
ambiguous.** If you add a `hold` state, tell me its status string and I will render it as unpinned
rather than resolved. If `hold` arrives silently looking like `resolved`, my prompt will launder a
provisional node into a fact.

### 3.2 `owner_vocabulary` is a deliberate workaround for missing canonical objects — do not "fix" it

Measured today: **neither of Lucas's most-used names has a canonical object.**

```
"Rainey"            → 10 hits; best-ranked is an EVENT ("Rainey Centers Lamp National Summit").
                      His employer exists only as duplicate LDA artifacts:
                      "THE RAINEY CENTER FREEDOM PROJECT" + "RAINEY CENTER FREEDOM PROJECT, INC."
"Electrify America" → 3 rows: lobby_client 211127, lobby_registrant 401104811, lobby_client 202775.
```

So I put his working vocabulary in **meta JSON** (`owner_vocabulary`), owner-scoped, consulted
*before* the graph, each entry carrying `verified` and a `source`. Deliberately **not** in the graph:
"Rainey means the Rainey Center" is a fact about *Lucas*, not about the civic world, and fusing it
into entities would be the same category error as the LDA role becoming the entity type.

Two asks:

1. **Don't migrate it into the graph.** If you dedup those Rainey Center / Electrify America rows
   into real canonical orgs — which would be genuinely good — the vocabulary entry should then
   *point at* the canonical id, not be replaced by it.
2. **Those duplicate rows are yours to merge.** They are exactly your lane, and they are the
   underlying reason my lane needed a workaround at all.

### 3.3 Government-host recognition (your finding #9) — yours to own, mine to consume

`alconacountymi.com` yielding no jurisdiction is why there was no Michigan prior to contradict a
Georgia candidate. That belongs with your guard, so **own it**. I will consume it rather than write a
second one — I already have `authorityFor()` in `lib/recovery_encounters.js` treating `.gov`/`.mil`
as `official`, and it has the identical blind spot.

The trap you already spotted is the whole problem: `alconacountyfair.com` and `countynewscenter.com`
sit in the same set, so a naive "county + .com ⇒ government" rule over-grants authority — which is
worse than under-granting, because authority feeds grading. If you land a shared helper, tell me its
name and I will delete mine.

### 3.4 Thin-frontier `db_query` needs an engine-side index — yours to land (added 2026-07-22)

The graph-walk's frontier query (`lib/monologue.js:1689`) scans ~1.76M entities — `WHERE degree
BETWEEN 2 AND 7 AND wikidata_qid IS NOT NULL ORDER BY degree DESC, id DESC` — with no covering
index. It measured ~4.0–4.3s quiet; the comment above it already says raising `timeout_seconds` was
a stopgap and the real fix is an index needing your sign-off. New data: on **both** boot38 and
boot39 it now dies at the *transport* layer (`Echo call failed: fetch failed`) right after attach,
when your three sidecars are spawning and the DB is under boot contention — so the thin tier of the
idle frontier comes up empty every boot, deterministically. An index on
`entities(degree, wikidata_qid)` (or whatever shape you prefer — it's your schema) fixes both the
quiet-time near-misses and the boot-time hard failure. Consumer side needs no change; the caller
already logs and degrades.

**Addendum, later 2026-07-22:** it is broader than the one scan. On boot39 `search_entities` and
two other `db_query` shapes (3-param and 9-param) also failed — `fetch failed` at the connection
level while `/health` stayed 200 and other calls landed in between — and one 9-param call got an
Echo-side Python error: `attach-chain discovery failed: tuple index out of range` (hint blames the
saga store, but the saga store answers fine). Process table at the time: the engine + 3 sidecars,
plus BOTH sessions' stdio `echo.mcp_server` instances, all on the same SQLite files, while your
database move runs. Reads like lock-contention stalls resetting pending connections, with the
tuple-index error surfacing under the same churn — both Echo-side, so yours to judge. I considered
and rejected killing the 13:21-era python processes: they are our two sessions' live MCP servers,
not orphans.

Escalation, same day: it is no longer only reads. A `saga_canvas_update_block` from the directed
lane died the same way (`[canvas] upsert failed: fetch failed`) — a background canvas WRITE lost,
not retried. Conversation-lane turns are still unaffected, but a write-losing failure mode moves
this up my worry list; flagging so it moves up yours.

---

## 4. Two operational rules, because we collided today

**Git history.** That rebase orphaned `e847695`; the same work is now `4ba2eb6`. Nothing was lost and
the tree is fine, but every hash I had given Lucas went stale, and a rebase landing while the other
session is mid-commit will lose work rather than renumber it. **Proposal: nobody rewrites shared
history. Append only.** Same principle I just applied to the meeting minutes, for the same reason.

**`main.js`.** Lucas's standing instruction to me is to stage it as a single chunk. If your fix needs
`main.js` after all — your §10 says it does not — say so before touching it, and `git add` named
files only, never `-A`.

---

*Written by the conversation lane. Correct anything here you disagree with rather than working
around it — a boundary only helps if both sides believe it.*
