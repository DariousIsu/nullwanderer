"""
AURA NX-Alpha — Legislation Database Importer

Imports all ZIP exports from the Open States Leg Database into a local SQLite DB.
Source: C:\\Users\\azrae\\Desktop\\Leg Database\\ — one subdir per state, ZIPs per session.
DB:     ~/.aura/legislation.db

USAGE:
    from app.service.leg_db_importer import run_import
    await run_import()                     # skip if already complete
    await run_import(force=True)           # drop all tables and reimport
"""

import ast
import asyncio
import csv
import io
import logging
import sqlite3
import tempfile
import zipfile
from pathlib import Path
from typing import Callable, Awaitable, Optional

logger = logging.getLogger(__name__)

LEG_DB_PATH = Path.home() / ".aura" / "legislation.db"
LEG_ZIP_DIR = Path(r"C:\Users\azrae\Desktop\Leg Database")

# ── Schema ────────────────────────────────────────────────────────────────────

_DDL = """
CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS states (
    code TEXT PRIMARY KEY,
    name TEXT,
    legislature_url TEXT,
    api_type TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    id         TEXT PRIMARY KEY,
    state_code TEXT NOT NULL,
    identifier TEXT NOT NULL,
    start_date TEXT,
    end_date   TEXT,
    is_active  INTEGER DEFAULT 0,
    FOREIGN KEY (state_code) REFERENCES states(code)
);

CREATE TABLE IF NOT EXISTS bills (
    id               TEXT PRIMARY KEY,
    session_id       TEXT NOT NULL,
    state_code       TEXT NOT NULL,
    identifier       TEXT,
    title            TEXT,
    bill_type        TEXT,
    chamber          TEXT,
    status           TEXT,
    subjects         TEXT,
    last_action_date TEXT,
    last_action      TEXT,
    abstract         TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS bill_sponsors (
    id              TEXT PRIMARY KEY,
    bill_id         TEXT NOT NULL,
    name            TEXT,
    primary_sponsor INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bill_actions (
    id                  TEXT PRIMARY KEY,
    bill_id             TEXT NOT NULL,
    date                TEXT,
    description         TEXT,
    raw_classification  TEXT,
    norm_classification TEXT
);

CREATE TABLE IF NOT EXISTS bill_sources (
    id      TEXT PRIMARY KEY,
    bill_id TEXT NOT NULL,
    url     TEXT,
    note    TEXT
);

CREATE TABLE IF NOT EXISTS bill_versions (
    id      TEXT PRIMARY KEY,
    bill_id TEXT NOT NULL,
    note    TEXT,
    date    TEXT,
    url     TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS bills_fts USING fts5(
    identifier, title, subjects, abstract,
    content=bills
);
"""

# B-tree indexes created AFTER bulk insert for maximum import speed.
# Applied at the end of _sync_import() and on any incremental re-run.
_INDEX_DDL = """
CREATE INDEX IF NOT EXISTS idx_bills_state_code      ON bills(state_code);
CREATE INDEX IF NOT EXISTS idx_bills_status          ON bills(status);
CREATE INDEX IF NOT EXISTS idx_bills_last_action_date ON bills(last_action_date DESC);
CREATE INDEX IF NOT EXISTS idx_bills_state_date      ON bills(state_code, last_action_date DESC);
CREATE INDEX IF NOT EXISTS idx_bills_state_status    ON bills(state_code, status);
CREATE INDEX IF NOT EXISTS idx_bills_session_id      ON bills(session_id);
CREATE INDEX IF NOT EXISTS idx_bill_actions_bill_id  ON bill_actions(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_sponsors_bill_id ON bill_sponsors(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_versions_bill_id ON bill_versions(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_sources_bill_id  ON bill_sources(bill_id);
"""

_DROP_TABLES = [
    "bills_fts", "bill_versions", "bill_sources", "bill_actions",
    "bill_sponsors", "bills", "sessions", "states", "_meta",
]

# ── Monitoring Schema (applied separately — safe on existing DBs) ──────────────

_MONITOR_DDL = """
CREATE TABLE IF NOT EXISTS leg_sync_state (
    state_code    TEXT PRIMARY KEY,
    last_run      TEXT,
    last_success  TEXT,
    status        TEXT DEFAULT 'never',
    error_msg     TEXT DEFAULT '',
    bills_added   INTEGER DEFAULT 0,
    bills_updated INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bill_change_events (
    id           TEXT PRIMARY KEY,
    bill_id      TEXT NOT NULL,
    change_type  TEXT NOT NULL,
    old_value    TEXT,
    new_value    TEXT,
    detected_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS monitoring_profiles (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    active      INTEGER DEFAULT 1,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_topics (
    id          TEXT PRIMARY KEY,
    profile_id  TEXT NOT NULL,
    topic_name  TEXT NOT NULL,
    keywords    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_states (
    id          TEXT PRIMARY KEY,
    profile_id  TEXT NOT NULL,
    state_code  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_bill_matches (
    id            TEXT PRIMARY KEY,
    profile_id    TEXT NOT NULL,
    topic_id      TEXT NOT NULL,
    bill_id       TEXT NOT NULL,
    first_matched TEXT NOT NULL,
    active        INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS profile_alerts (
    id                 TEXT PRIMARY KEY,
    profile_id         TEXT NOT NULL,
    topic_id           TEXT,
    bill_id            TEXT NOT NULL,
    alert_type         TEXT NOT NULL,
    summary            TEXT DEFAULT '',
    detected_at        TEXT NOT NULL,
    included_in_report TEXT
);

CREATE INDEX IF NOT EXISTS idx_bill_change_events_bill  ON bill_change_events(bill_id);
CREATE INDEX IF NOT EXISTS idx_bill_change_events_time  ON bill_change_events(detected_at);
CREATE INDEX IF NOT EXISTS idx_profile_topics_profile   ON profile_topics(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_states_profile   ON profile_states(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_matches_profile  ON profile_bill_matches(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_matches_bill     ON profile_bill_matches(bill_id);
CREATE INDEX IF NOT EXISTS idx_profile_alerts_profile   ON profile_alerts(profile_id);
CREATE INDEX IF NOT EXISTS idx_profile_alerts_unread    ON profile_alerts(profile_id, included_in_report);
"""


def ensure_monitor_schema(con: sqlite3.Connection) -> None:
    """Apply monitoring tables/indexes to an existing legislation DB.
    All statements use IF NOT EXISTS — safe to call repeatedly."""
    for stmt in _MONITOR_DDL.strip().split(";"):
        stmt = stmt.strip()
        if stmt:
            con.execute(stmt)
    con.commit()

# ── Status / Chamber Normalization ────────────────────────────────────────────

TERMINAL_PASSED = {"became-law", "executive-signature"}
TERMINAL_DROPPED = {"failure", "executive-veto", "withdrawal"}

HOUSE_PREFIXES = {"HB", "HR", "HJR", "HCR", "HF", "HA", "HM"}
SENATE_PREFIXES = {"SB", "SR", "SJR", "SCR", "SF", "SA", "SM"}


def _parse_classification(raw: str) -> list[str]:
    """Parse a classification field that may be a Python list literal or plain string."""
    if not raw:
        return []
    try:
        val = ast.literal_eval(raw)
        if isinstance(val, list):
            return [str(v) for v in val]
        return [str(val)]
    except (ValueError, SyntaxError):
        return [raw]


def normalize_status(actions: list[dict]) -> str:
    """
    Walk actions sorted by date DESC.
    Terminal action → 'passed' or 'dropped'.
    Both chambers passed → 'passed'.
    One chamber passed → 'pending'.
    Otherwise → 'active'.
    """
    sorted_actions = sorted(actions, key=lambda a: a.get("date", ""), reverse=True)
    chambers_passed: set[str] = set()
    for action in sorted_actions:
        for c in _parse_classification(action.get("classification", "")):
            c = c.strip()
            if c in TERMINAL_PASSED:
                return "passed"
            if c in TERMINAL_DROPPED:
                return "dropped"
            if c == "passage":
                # org_classification lives on the action row from our join
                oc = action.get("org_classification", "")
                if oc in ("lower", "upper"):
                    chambers_passed.add(oc)
    if len(chambers_passed) == 2:
        return "passed"
    if len(chambers_passed) == 1:
        return "pending"
    return "active"


def normalize_chamber(identifier: str, org_classification: str) -> str:
    """Derive chamber from bill identifier prefix and/or organization_classification."""
    ident_upper = identifier.upper()
    prefix = ident_upper.split(" ")[0] if " " in ident_upper else ident_upper[:3]
    if org_classification == "lower" or any(ident_upper.startswith(p) for p in HOUSE_PREFIXES):
        return "house"
    if org_classification == "upper" or any(ident_upper.startswith(p) for p in SENATE_PREFIXES):
        return "senate"
    return "joint"


# ── ZIP Processing ─────────────────────────────────────────────────────────────

def _read_csv(tmpdir: str, suffix: str) -> list[dict]:
    """Find and read the single CSV matching *{suffix} in tmpdir tree."""
    matches = list(Path(tmpdir).rglob(f"*{suffix}"))
    if not matches:
        return []
    with open(matches[0], encoding="utf-8", errors="replace") as f:
        return list(csv.DictReader(f))


def _process_zip_directory(con: sqlite3.Connection, tmpdir: str) -> None:
    """
    Parse all CSVs from an extracted ZIP directory and bulk-insert into SQLite.
    Derives state_code and session_identifier from the bills rows themselves.
    """
    bills_rows      = _read_csv(tmpdir, "_bills.csv")
    actions_rows    = _read_csv(tmpdir, "_bill_actions.csv")
    sponsors_rows   = _read_csv(tmpdir, "_bill_sponsorships.csv")
    sources_rows    = _read_csv(tmpdir, "_bill_sources.csv")
    versions_rows   = _read_csv(tmpdir, "_bill_versions.csv")
    ver_links_rows  = _read_csv(tmpdir, "_bill_version_links.csv")
    abstracts_rows  = _read_csv(tmpdir, "_bill_abstracts.csv")

    if not bills_rows:
        return

    # ── Derive state + session from first bill row ──────────────────────────
    first = bills_rows[0]
    jurisdiction = first.get("jurisdiction", "").strip()
    session_identifier = first.get("session_identifier", "").strip()

    # Map jurisdiction name → 2-letter code by looking at README or using the
    # zip filename — here we infer from the jurisdiction string directly.
    # We use the jurisdiction name as the state name and derive a code from it.
    state_code = _jurisdiction_to_code(jurisdiction)
    if not state_code:
        logger.warning("[importer] Could not derive state code from '%s', skipping", jurisdiction)
        return

    session_id = f"{state_code}_{session_identifier}"

    # ── Upsert state ─────────────────────────────────────────────────────────
    con.execute(
        "INSERT OR IGNORE INTO states (code, name) VALUES (?, ?)",
        (state_code, jurisdiction),
    )

    # ── Upsert session ────────────────────────────────────────────────────────
    con.execute(
        "INSERT OR IGNORE INTO sessions (id, state_code, identifier) VALUES (?, ?, ?)",
        (session_id, state_code, session_identifier),
    )

    # ── Build lookup maps ─────────────────────────────────────────────────────
    # actions per bill: bill_id → list of action dicts (with org_classification)
    actions_by_bill: dict[str, list[dict]] = {}
    for row in actions_rows:
        bid = row.get("bill_id", "")
        actions_by_bill.setdefault(bid, []).append(row)

    # org_id → classification (for action chamber detection)
    # NOTE: organization_classification is already in bills.csv, but actions
    # reference organization_id. We resolve this by reading organizations.csv
    # if present; otherwise fall back to "".
    org_class: dict[str, str] = {}
    org_rows = _read_csv(tmpdir, "_organizations.csv")
    for row in org_rows:
        org_class[row.get("id", "")] = row.get("classification", "")

    # Annotate actions with org_classification for normalize_status
    for bid, acts in actions_by_bill.items():
        for act in acts:
            act["org_classification"] = org_class.get(act.get("organization_id", ""), "")

    # abstracts: bill_id → first abstract text
    abstracts: dict[str, str] = {}
    for row in abstracts_rows:
        bid = row.get("bill_id", "")
        if bid not in abstracts:
            abstracts[bid] = row.get("abstract", "")

    # version links: version_id → first url
    ver_link_by_version: dict[str, str] = {}
    for row in ver_links_rows:
        vid = row.get("version_id", "")
        if vid not in ver_link_by_version:
            ver_link_by_version[vid] = row.get("url", "")

    # ── Insert bills ──────────────────────────────────────────────────────────
    bill_insert = []
    for row in bills_rows:
        bid        = row.get("id", "")
        identifier = row.get("identifier", "")
        org_cls    = row.get("organization_classification", "")
        acts       = actions_by_bill.get(bid, [])

        # Last action
        sorted_acts = sorted(acts, key=lambda a: a.get("date", ""), reverse=True)
        last_action_date = sorted_acts[0].get("date", "") if sorted_acts else ""
        last_action      = sorted_acts[0].get("description", "") if sorted_acts else ""

        # Normalize action classifications for storage
        norm_class = normalize_status(acts)

        bill_insert.append((
            bid,
            session_id,
            state_code,
            identifier,
            row.get("title", ""),
            row.get("classification", ""),          # bill_type
            normalize_chamber(identifier, org_cls),  # chamber
            norm_class,                              # status
            row.get("subject", ""),                  # subjects — already JSON array string
            last_action_date,
            last_action,
            abstracts.get(bid, ""),
        ))

    con.executemany(
        """INSERT OR REPLACE INTO bills
           (id, session_id, state_code, identifier, title, bill_type, chamber,
            status, subjects, last_action_date, last_action, abstract)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        bill_insert,
    )

    # ── Insert bill actions ───────────────────────────────────────────────────
    action_insert = []
    for bid, acts in actions_by_bill.items():
        for act in acts:
            raw_cls = act.get("classification", "")
            parsed  = _parse_classification(raw_cls)
            action_insert.append((
                act.get("id", ""),
                bid,
                act.get("date", ""),
                act.get("description", ""),
                raw_cls,
                parsed[0] if parsed else "",
            ))
    if action_insert:
        con.executemany(
            """INSERT OR REPLACE INTO bill_actions
               (id, bill_id, date, description, raw_classification, norm_classification)
               VALUES (?,?,?,?,?,?)""",
            action_insert,
        )

    # ── Insert sponsors ───────────────────────────────────────────────────────
    sponsor_insert = [
        (
            row.get("id", ""),
            row.get("bill_id", ""),
            row.get("name", ""),
            1 if row.get("primary", "").strip().lower() == "true" else 0,
        )
        for row in sponsors_rows
    ]
    if sponsor_insert:
        con.executemany(
            "INSERT OR REPLACE INTO bill_sponsors (id, bill_id, name, primary_sponsor) VALUES (?,?,?,?)",
            sponsor_insert,
        )

    # ── Insert sources ────────────────────────────────────────────────────────
    source_insert = [
        (row.get("id", ""), row.get("bill_id", ""), row.get("url", ""), row.get("note", ""))
        for row in sources_rows
    ]
    if source_insert:
        con.executemany(
            "INSERT OR REPLACE INTO bill_sources (id, bill_id, url, note) VALUES (?,?,?,?)",
            source_insert,
        )

    # ── Insert versions (join with version_links for URL) ────────────────────
    version_insert = [
        (
            row.get("id", ""),
            row.get("bill_id", ""),
            row.get("note", ""),
            row.get("date", ""),
            ver_link_by_version.get(row.get("id", ""), ""),
        )
        for row in versions_rows
    ]
    if version_insert:
        con.executemany(
            "INSERT OR REPLACE INTO bill_versions (id, bill_id, note, date, url) VALUES (?,?,?,?,?)",
            version_insert,
        )


# ── Jurisdiction → State Code ─────────────────────────────────────────────────

_JURISDICTION_MAP: dict[str, str] = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR",
    "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
    "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID",
    "Illinois": "IL", "Indiana": "IN", "Iowa": "IA", "Kansas": "KS",
    "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD",
    "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE",
    "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ",
    "New Mexico": "NM", "New York": "NY", "North Carolina": "NC",
    "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR",
    "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC",
    "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
    "Vermont": "VT", "Virginia": "VA", "Washington": "WA",
    "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY",
    "District of Columbia": "DC", "Puerto Rico": "PR",
}


def _jurisdiction_to_code(jurisdiction: str) -> Optional[str]:
    return _JURISDICTION_MAP.get(jurisdiction)


# ── Public Entry Point ────────────────────────────────────────────────────────

EmitFn = Callable[[str, dict], Awaitable[None]]


async def run_import(
    emit_fn: Optional[EmitFn] = None,
    force: bool = False,
) -> None:
    """
    Import all ZIPs from LEG_ZIP_DIR into SQLite at LEG_DB_PATH.

    All heavy I/O runs in a thread pool via asyncio.to_thread so the event loop
    stays responsive while 600+ ZIPs are processed.

    Args:
        emit_fn: Optional async callable(event_name, data) for SSE progress events.
        force:   If True, drop all legislation tables and reimport from scratch.
    """
    loop = asyncio.get_event_loop()

    def _emit_progress(event: str, data: dict) -> None:
        """Schedule an async emit_fn call from the worker thread without blocking."""
        if emit_fn is not None:
            asyncio.run_coroutine_threadsafe(emit_fn(event, data), loop)

    def _sync_import() -> None:
        # Ensure ~/.aura exists
        LEG_DB_PATH.parent.mkdir(parents=True, exist_ok=True)

        con = sqlite3.connect(str(LEG_DB_PATH))
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=NORMAL")
        con.execute("PRAGMA cache_size=-131072")   # 128 MB — speeds up bulk insert
        con.execute("PRAGMA temp_store=MEMORY")    # temp tables in RAM

        if force:
            logger.info("[importer] force=True — dropping all legislation tables")
            for table in _DROP_TABLES:
                con.execute(f"DROP TABLE IF EXISTS [{table}]")
            con.commit()

        # Create schema
        con.executescript(_DDL)
        con.commit()

        # Skip if already complete (and not forced)
        row = con.execute("SELECT value FROM _meta WHERE key='import_complete'").fetchone()
        if row and row[0] == "1":
            logger.info("[importer] Import already complete — skipping (use force=True to reimport)")
            con.close()
            return

        zips = sorted(LEG_ZIP_DIR.glob("**/*.zip"))
        total = len(zips)
        logger.info("[importer] Starting import of %d ZIPs from %s", total, LEG_ZIP_DIR)

        for i, zip_path in enumerate(zips):
            logger.debug("[importer] Processing %s (%d/%d)", zip_path.name, i + 1, total)
            try:
                with tempfile.TemporaryDirectory() as tmpdir:
                    with zipfile.ZipFile(zip_path) as z:
                        z.extractall(tmpdir)
                    _process_zip_directory(con, tmpdir)
                con.commit()
            except Exception as exc:
                logger.warning("[importer] Failed on %s: %s", zip_path.name, exc)

            if i % 10 == 0:
                pct = round((i + 1) / total * 100)
                _emit_progress("leg_import_progress", {
                    "completed": i + 1,
                    "total": total,
                    "pct": pct,
                    "current_zip": zip_path.name,
                })

        # Build FTS5 index
        logger.info("[importer] Building FTS5 index...")
        con.execute("INSERT INTO bills_fts(bills_fts) VALUES('rebuild')")
        con.commit()

        # Build B-tree indexes after all data is inserted (much faster than before)
        logger.info("[importer] Building B-tree indexes...")
        con.executescript(_INDEX_DDL)
        con.execute("ANALYZE")
        con.execute("INSERT OR REPLACE INTO _meta VALUES ('import_complete', '1')")
        con.commit()

        total_bills = con.execute("SELECT COUNT(*) FROM bills").fetchone()[0]
        total_states = con.execute("SELECT COUNT(*) FROM states").fetchone()[0]
        logger.info(
            "[importer] Import complete — %d bills across %d states",
            total_bills, total_states,
        )
        con.close()

    await asyncio.to_thread(_sync_import)


def get_import_progress() -> dict:
    """
    Return import progress without opening a long-lived connection.
    Used by the status endpoint during an active import.
    """
    if not LEG_DB_PATH.exists():
        return {"complete": False, "total_bills": 0, "total_states": 0}
    try:
        con = sqlite3.connect(str(LEG_DB_PATH))
        complete_row = con.execute(
            "SELECT value FROM _meta WHERE key='import_complete'"
        ).fetchone()
        complete = bool(complete_row and complete_row[0] == "1")
        total_bills = con.execute("SELECT COUNT(*) FROM bills").fetchone()[0]
        total_states = con.execute("SELECT COUNT(*) FROM states").fetchone()[0]
        con.close()
        return {"complete": complete, "total_bills": total_bills, "total_states": total_states}
    except Exception:
        return {"complete": False, "total_bills": 0, "total_states": 0}
