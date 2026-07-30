# Civic body & membership schema — design for review (2026-07-30)

*Not built. Lucas reviews before any DDL runs.*

## The problem, measured

120 open county-compilation threads, hundreds of boards researched across GA/IA/ID/HI/DE — and
**no structured place for any of it to land**. Verified tonight: `sq.db` has no table matching
`%board%` / `%county%` / `%official%`; `data/electoral.db` is not present. Everything gathered
lives as prose in `notes/directed-*.md` and as nodes in the Echo graph. Nothing is queryable,
countable, diffable, or exportable — which is why the contact-sheet/roster deliverables have never
worked, and why her own `db_query(sql:tables(county_election_boards…))` calls error out.

Her subconscious diagnosed this independently, twice, and the log watcher minted a need from the
same failures. This design is the answer to that.

## Where it lives: `sq.db`

Not a new database. `cardinality` (the seat denominator, keyed by body) and `absence` (named gaps,
keyed by body) **already live in sq.db** and are already keyed the same way. A separate file would
put the roster one JOIN away from its own denominator and its own gap record, for no benefit.

## Identity: `lib/body_key.js`, reused exactly

The body key is already the stable civic identity in this codebase — deliberately built so a
renamed target ("Parish Council of Acadia Parish" → "the governing body of Acadia Parish") keeps
one identity, and deliberately NOT `beats.targetPlaceKey` (which collapses every state's House of
Representatives into `representatives`). New tables key on the same string, so a roster, its seat
count, and its gap record all line up without a translation layer.

## The two tables

```sql
-- ONE ROW PER BODY. What the body IS and where it sits. The seat count is NOT duplicated here —
-- `cardinality` already owns the denominator, keyed by the same `body_key`.
CREATE TABLE IF NOT EXISTS civic_bodies (
  body_key      TEXT PRIMARY KEY,        -- lib/body_key.js — joins cardinality + absence
  title         TEXT NOT NULL,           -- as officially named: "Fulton County Registration and Elections Board"
  -- TWO ORTHOGONAL AXES, not one enum (Lucas's Fulton case, 2026-07-30). "County board" and
  -- "election board" are answers to DIFFERENT questions — what level of government, and what the
  -- body DOES. Conflating them is the trap this codebase already hit once (object-type-identity:
  -- ROLE became TYPE). Fulton's Registration & Elections Board = county/elections; a County
  -- Commission = county/governing. "Every county body in GA" and "every election board in the
  -- country" then each cost one query, and neither has to know about the other.
  level         TEXT NOT NULL,           -- county | municipal | township | school_district | state | special_district | other
  function      TEXT NOT NULL,           -- governing | elections | school | judicial | planning | other
  state         TEXT,                    -- 'GA' (2-letter; NULL for non-US)
  place         TEXT,                    -- 'Fulton County' — the jurisdiction it governs
  official_url  TEXT,                    -- the body's own page (its best door)
  selection     TEXT,                    -- elected | appointed | mixed | unknown  (HOW seats are filled)
  term_years    INTEGER,                 -- nominal term length when known
  notes         TEXT,
  first_seen_ts INTEGER NOT NULL,
  updated_ts    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_civic_bodies_state ON civic_bodies(state, level, function);

-- ONE ROW PER SEAT-HELD-BY-A-PERSON-OVER-A-PERIOD. Not a person store: the CRM remains the
-- ultimate store for people (crm-is-the-ultimate-store). This records the SEAT and points at the
-- person. `person_name` is what the source actually said, kept verbatim even when unresolved.
CREATE TABLE IF NOT EXISTS civic_memberships (
  id            INTEGER PRIMARY KEY,
  body_key      TEXT NOT NULL REFERENCES civic_bodies(body_key),
  person_name   TEXT NOT NULL,           -- as printed by the source (never normalized away)
  role          TEXT,                    -- Chair | Vice Chair | Member | Clerk | District 3 | …
  district      TEXT,                    -- seat/district label when the body is districted
  party         TEXT,
  term_start    TEXT,                    -- ISO date or year — as stated
  term_end      TEXT,
  crm_id        TEXT,                    -- resolved person in the CRM (NULL until resolved)
  puller_id     INTEGER,                 -- puller.db targets.id when the contact lane holds them
  email         TEXT,                    -- ONLY when the body's own source published it
  phone         TEXT,
  -- provenance (birth-context: every row carries where it was born, to REFUSE, never assert)
  source_url    TEXT,                    -- the page this seat was read from
  source_kind   TEXT,                    -- official | news | wiki | held_doc | operator
  doc_ref       INTEGER,                 -- documents.id when it came from a held doc
  confidence    REAL DEFAULT 0.5,        -- 0..1, graded at read time — priority, not a gate
  observed_ts   INTEGER NOT NULL,        -- when WE saw it (bi-temporal: not when it became true)
  superseded_by INTEGER,                 -- id of the row that replaced this one (NULL = current)
  UNIQUE(body_key, person_name, role, observed_ts)
);
CREATE INDEX IF NOT EXISTS idx_civic_mem_body ON civic_memberships(body_key, superseded_by);
CREATE INDEX IF NOT EXISTS idx_civic_mem_crm ON civic_memberships(crm_id);
```

## Five decisions worth challenging

1. **Supersede, never overwrite.** A membership that changes writes a NEW row and stamps
   `superseded_by` on the old one. History is the point: "who chaired this board in 2024" stays
   answerable, and a bad scrape can be reverted rather than having destroyed the truth. Cost: the
   table grows and every read filters `superseded_by IS NULL`.

2. **Completeness is DERIVED, never stored.** `COUNT(current members) vs cardinality.seats` for
   that body. A stored `complete` flag is a lie the moment a seat turns over. This is what makes
   "which Georgia counties are incomplete" a single query — the thing that has never been
   answerable.

3. **This is not a person store.** `person_name` verbatim + optional `crm_id`/`puller_id`. The CRM
   stays authoritative for people; this table owns SEATS. A person on four boards is four
   membership rows and one CRM row.

4. **Email/phone only when the body published them.** The seat record carries contact details only
   from the body's own source. Pattern-derived or inferred addresses belong in Puller, which
   already has the belief/confidence machinery for exactly that.

5. **Confidence grades, it does not gate.** Everything lands marked (let-it-in-mark-and-churn); a
   0.3-confidence row from a news mention is stored and visible, just outranked by the 0.9 official
   roster. Nothing is refused at the door.

## What it unlocks the day it exists

- `SELECT` the full roster for any body, with sources, in one query.
- **Which counties are incomplete** — the standing question behind all 120 threads.
- A real contact sheet / report, generated from data rather than reassembled from prose.
- Diff over time: who changed since the last sweep (feeds the vacancy/turnover work she keeps
  raising in her own syntheses).
- Her `db_query` calls stop erroring, and the research she has already done starts compounding.

## Decisions (Lucas, 2026-07-30)

- **Level + function, two columns** — not one conflated `kind` enum. (Above.)
- **Scope: whatever a pass completes**, from day one — county, municipal, state chamber alike.
  Restricting the writer to counties would manufacture exactly the confusion this table exists to
  end: some bodies structured, some prose-only, no way to tell which without checking both.
- **Backfill: YES** — "so there isn't data confusion later." Discipline below.

## Backfill discipline (the fabrication risk is the whole risk)

Extracting rosters from prose with a model INVENTS plausible names. So:

1. **Dry run first.** The script writes a review file (what it would insert, per body, with the
   prose span it read) and inserts NOTHING until Lucas has read it.
2. **`source_kind='backfill_prose'`, confidence 0.3** — unless the prose carries the source URL for
   that specific claim, in which case it inherits that URL and 0.6. Visibly weaker than researched
   rows; prove-or-fade applies.
3. **Backfill NEVER overwrites or supersedes a researched row.** If both exist for a seat, the
   researched row wins and the backfill row is dropped — not stored as a competing version.
4. **One-off script, not a lane.** No autonomous re-runs.

Expected payoff beyond the data: the backfill reveals **which of the 120 open county threads are
already complete** (filled seats vs `cardinality.seats`). Those close, which clears her board and
stops a stale backlog crowding her attention surface.

## Build shape (if approved)

1. DDL in `lib/db.js` alongside `cardinality`, plus `lib/civic_store.js` — pure, deps-injected
   (`upsertBody`, `recordMembership` with supersession, `roster`, `completeness`), offline smoke.
2. Wire ONE writer: the directed research pass, so completed bodies land structured while still
   writing their prose.
3. Backfill script with the dry-run gate above — separate slice, reviewed before it writes.
