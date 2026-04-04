"""
AURA NX-Alpha — Legislation Service

Singleton wrapper around the SQLite legislation database.
All reads are synchronous sqlite3 (the DB is local, fast enough for read workloads).

PUBLIC API:
    get_legislation_service() → LegislationService
    svc.get_state_bills(state_code, chamber, status, limit) → list[dict]
    svc.get_active_session(state_code) → dict | None
    svc.search_bills(query, state, chamber, status, limit) → list[dict]
    svc.get_bill(bill_id) → dict | None
    svc.get_import_status() → dict
"""

import logging
import sqlite3
from pathlib import Path
from typing import Optional

from app.service.leg_db_importer import LEG_DB_PATH, get_import_progress

logger = logging.getLogger(__name__)

import re as _re

_LEG_STOP_WORDS = frozenset({
    "a", "an", "the", "is", "in", "on", "at", "to", "of", "and", "or",
    "how", "do", "you", "can", "be", "was", "are", "what", "why", "when",
    "where", "who", "which", "that", "this", "it", "its", "for", "with",
    "by", "from", "about", "should", "would", "could", "will", "does",
    "me", "my", "we", "our", "your", "their", "did", "has", "have", "had",
    "i", "he", "she", "they", "us", "him", "her", "them", "give", "tell",
    "please", "some", "any", "all", "not", "no", "so", "if", "but",
    "show", "find", "list", "get", "search", "look",
    "every", "each", "state", "states", "relating", "related",
})


def _sanitize_leg_query(query: str) -> str:
    """
    Convert a natural-language query to a safe FTS5 MATCH expression.
    Strips operators and stop words, returns implicit AND term search.
    Falls back to a quoted phrase if no terms survive.
    """
    clean = _re.sub(r'["\'^*(){}[\]:~?!,]', ' ', query)
    terms = [
        t.lower() for t in clean.split()
        if t.lower() not in _LEG_STOP_WORDS and len(t) >= 2
    ]
    if not terms:
        return '"' + clean.strip().replace('"', '""') + '"'
    return ' '.join(terms)


class LegislationService:
    """Read-only interface to the legislation SQLite database."""

    def __init__(self) -> None:
        self._db_path = LEG_DB_PATH
        self._cached_conn: sqlite3.Connection | None = None

    def _conn(self) -> sqlite3.Connection:
        """Return a cached read-only connection (singleton-safe, DB is read-only)."""
        if self._cached_conn is not None:
            try:
                # Quick liveness check — will raise if connection was closed
                self._cached_conn.execute("SELECT 1")
                return self._cached_conn
            except Exception:
                self._cached_conn = None
        con = sqlite3.connect(str(self._db_path))
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA query_only=ON")
        con.execute("PRAGMA cache_size=-131072")   # 128 MB page cache
        con.execute("PRAGMA mmap_size=2147483648") # 2 GB memory-mapped I/O
        con.execute("PRAGMA temp_store=MEMORY")    # temp tables in RAM (ORDER BY, sorts)
        self._cached_conn = con
        return con

    def _available(self) -> bool:
        return self._db_path.exists()

    # ── Import Status ─────────────────────────────────────────────────────────

    def get_import_status(self) -> dict:
        return get_import_progress()

    # ── States ────────────────────────────────────────────────────────────────

    def get_states(self) -> list[dict]:
        if not self._available():
            return []
        con = self._conn()
        rows = con.execute(
            "SELECT code, name, legislature_url, api_type FROM states ORDER BY code"
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Sessions ──────────────────────────────────────────────────────────────

    def get_active_session(self, state_code: str) -> Optional[dict]:
        if not self._available():
            return None
        con = self._conn()
        # Try explicit is_active flag first; fall back to most-recent identifier
        row = con.execute(
            """SELECT * FROM sessions
               WHERE state_code = ?
               ORDER BY is_active DESC, identifier DESC
               LIMIT 1""",
            (state_code.upper(),),
        ).fetchone()
        return dict(row) if row else None

    def get_sessions(self, state_code: str) -> list[dict]:
        if not self._available():
            return []
        con = self._conn()
        rows = con.execute(
            "SELECT * FROM sessions WHERE state_code = ? ORDER BY identifier DESC",
            (state_code.upper(),),
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Bills ─────────────────────────────────────────────────────────────────

    def get_state_bills(
        self,
        state_code: str,
        chamber: Optional[str] = None,
        status: Optional[str] = None,
        session_id: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        if not self._available():
            return []

        clauses = ["state_code = ?"]
        params: list = [state_code.upper()]

        if chamber:
            clauses.append("chamber = ?")
            params.append(chamber.lower())
        if status:
            clauses.append("status = ?")
            params.append(status.lower())
        if session_id:
            clauses.append("session_id = ?")
            params.append(session_id)

        where = " AND ".join(clauses)
        params += [limit, offset]

        con = self._conn()
        rows = con.execute(
            f"""SELECT id, session_id, state_code, identifier, title, bill_type,
                       chamber, status, subjects, last_action_date, last_action
                FROM bills WHERE {where}
                ORDER BY last_action_date DESC
                LIMIT ? OFFSET ?""",
            params,
        ).fetchall()
        return [dict(r) for r in rows]

    def get_bill(self, bill_id: str) -> Optional[dict]:
        """Return a bill with all related records. All child queries now use FK indexes."""
        if not self._available():
            return None

        con = self._conn()
        bill_row = con.execute(
            "SELECT * FROM bills WHERE id = ?", (bill_id,)
        ).fetchone()
        if not bill_row:
            return None

        bill = dict(bill_row)

        # Each of these now uses idx_bill_*_bill_id — index scan instead of full table scan
        bill["sponsors"] = [dict(r) for r in con.execute(
            "SELECT * FROM bill_sponsors WHERE bill_id = ? ORDER BY primary_sponsor DESC",
            (bill_id,),
        ).fetchall()]
        bill["actions"] = [dict(r) for r in con.execute(
            "SELECT * FROM bill_actions WHERE bill_id = ? ORDER BY date ASC",
            (bill_id,),
        ).fetchall()]
        bill["sources"] = [dict(r) for r in con.execute(
            "SELECT * FROM bill_sources WHERE bill_id = ?", (bill_id,)
        ).fetchall()]
        bill["versions"] = [dict(r) for r in con.execute(
            "SELECT * FROM bill_versions WHERE bill_id = ? ORDER BY date DESC",
            (bill_id,),
        ).fetchall()]
        return bill

    def get_bill_by_identifier(self, state_code: str, identifier: str) -> Optional[dict]:
        """Return a bill by state + identifier string (e.g. 'HB 42'). Used by state agents."""
        if not self._available():
            return None
        con = self._conn()
        row = con.execute(
            "SELECT * FROM bills WHERE state_code = ? AND identifier = ? LIMIT 1",
            (state_code.upper(), identifier),
        ).fetchone()
        return dict(row) if row else None

    # ── Search ────────────────────────────────────────────────────────────────

    def search_bills(
        self,
        query: str,
        state: Optional[str] = None,
        chamber: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 50,
        session_id: Optional[str] = None,
        year: Optional[int] = None,
    ) -> list[dict]:
        """FTS5 full-text search across identifier, title, subjects, abstract."""
        if not self._available() or not query.strip():
            return []

        # Build filter clauses applied after FTS join
        filter_clauses: list[str] = []
        filter_params: list = []

        if state:
            filter_clauses.append("b.state_code = ?")
            filter_params.append(state.upper())
        if session_id:
            filter_clauses.append("b.session_id = ?")
            filter_params.append(session_id)
        if year:
            filter_clauses.append("b.last_action_date LIKE ?")
            filter_params.append(f"{year}%")
        if chamber and chamber.lower() not in ("both", "all"):
            filter_clauses.append("b.chamber = ?")
            filter_params.append(chamber.lower())
        if status:
            s = status.lower()
            if s == "in_progress":
                # "active bills" — still moving through the legislature (not terminal)
                filter_clauses.append("b.status IN ('active', 'pending')")
            else:
                filter_clauses.append("b.status = ?")
                filter_params.append(s)

        where_extra = ("AND " + " AND ".join(filter_clauses)) if filter_clauses else ""

        safe_query = _sanitize_leg_query(query)

        try:
            con = self._conn()
            # Inner subquery limits FTS5 to the top-1000 globally-ranked matches before
            # joining to bills and applying state/chamber/status filters.  This avoids
            # computing BM25 rank and joining all potentially-tens-of-thousands of matches
            # when a broad query (e.g. "social media") hits bills across every state.
            rows = con.execute(
                f"""SELECT b.id, b.state_code, b.identifier, b.title,
                           b.chamber, b.status, b.subjects,
                           b.last_action_date, b.last_action
                    FROM (SELECT rowid, rank FROM bills_fts
                          WHERE bills_fts MATCH ?
                          ORDER BY rank LIMIT 1000) fts
                    JOIN bills b ON fts.rowid = b.rowid
                    {where_extra}
                    ORDER BY fts.rank
                    LIMIT ?""",
                [safe_query, *filter_params, limit],
            ).fetchall()
            return [dict(r) for r in rows]
        except sqlite3.OperationalError as exc:
            # FTS index may not exist yet (import in progress), or malformed query operator
            logger.warning("[legislation_service] FTS search failed: %s", exc)
            return []

    def get_bill_trend(
        self,
        query: str,
        state: str,
        years: int = 5,
    ) -> list[dict]:
        """Aggregate FTS5 bill counts per session for trend analysis.

        Returns list of {session_id, identifier, bill_count} ordered by
        session identifier ASC, filtered to sessions within the last `years` years.
        """
        import datetime

        if not self._available() or not query.strip() or not state:
            return []

        safe_query = _sanitize_leg_query(query)

        try:
            con = self._conn()
            rows = con.execute(
                """SELECT b.session_id, s.identifier, COUNT(*) as bill_count
                   FROM (SELECT rowid FROM bills_fts WHERE bills_fts MATCH ?
                         ORDER BY rank LIMIT 5000) fts
                   JOIN bills b ON fts.rowid = b.rowid
                   JOIN sessions s ON b.session_id = s.id
                   WHERE b.state_code = ?
                   GROUP BY b.session_id
                   ORDER BY s.identifier ASC""",
                [safe_query, state.upper()],
            ).fetchall()
        except sqlite3.OperationalError as exc:
            logger.warning("[legislation_service] trend query failed: %s", exc)
            return []

        cutoff_year = datetime.datetime.now().year - years
        result = []
        for row in rows:
            ident = row["identifier"] or ""
            try:
                start_year = int(ident.split("-")[0])
                if start_year < 100:   # 2-digit year like "25-26"
                    start_year += 2000
                if start_year < cutoff_year:
                    continue
            except (ValueError, IndexError):
                pass   # can't parse year — include it
            result.append(dict(row))
        return result

    # ── Write Path (state agents) ─────────────────────────────────────────────

    def _write_conn(self) -> sqlite3.Connection:
        """Open a write-capable connection (no query_only, WAL for concurrency)."""
        con = sqlite3.connect(str(self._db_path), check_same_thread=False)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL;")
        return con

    def upsert_bill(
        self,
        state_code: str,
        identifier: str,
        title: str,
        last_action: str,
        last_action_date: str,
        session_id: str = "",
        chamber: str = "",
        status: str = "",
    ) -> str:
        """
        Update last_action fields on an existing bill, or insert a scraped stub.

        Called by BaseStateAgent._persist_changes() after live scraping detects
        new or changed activity not yet reflected in the imported dataset.

        Returns the bill's id (existing or newly generated).
        """
        if not self._available():
            return ""
        import uuid as _uuid
        con = self._write_conn()
        try:
            row = con.execute(
                "SELECT id FROM bills WHERE state_code = ? AND identifier = ?",
                (state_code.upper(), identifier),
            ).fetchone()
            if row:
                bill_id = row["id"]
                con.execute(
                    "UPDATE bills SET last_action = ?, last_action_date = ? WHERE id = ?",
                    (last_action, last_action_date, bill_id),
                )
            else:
                bill_id = f"scraped-{state_code.lower()}-{_uuid.uuid4().hex[:8]}"
                con.execute(
                    """INSERT INTO bills
                       (id, session_id, state_code, identifier, title,
                        bill_type, chamber, status, subjects, last_action, last_action_date)
                       VALUES (?, ?, ?, ?, ?, 'bill', ?, ?, '', ?, ?)""",
                    (
                        bill_id, session_id, state_code.upper(), identifier, title,
                        chamber, status or "introduced", last_action, last_action_date,
                    ),
                )
            con.commit()
        finally:
            con.close()
        return bill_id

    # ── Bill Count (useful for status display) ────────────────────────────────

    def count_bills(
        self,
        state_code: Optional[str] = None,
        chamber: Optional[str] = None,
        status: Optional[str] = None,
    ) -> int:
        if not self._available():
            return 0
        clauses: list[str] = []
        params: list = []
        if state_code:
            clauses.append("state_code = ?")
            params.append(state_code.upper())
        if chamber:
            clauses.append("chamber = ?")
            params.append(chamber.lower())
        if status:
            clauses.append("status = ?")
            params.append(status.lower())
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        con = self._conn()
        count = con.execute(f"SELECT COUNT(*) FROM bills {where}", params).fetchone()[0]
        return count


# ── Singleton ─────────────────────────────────────────────────────────────────

_legislation_service: Optional[LegislationService] = None


def get_legislation_service() -> LegislationService:
    global _legislation_service
    if _legislation_service is None:
        _legislation_service = LegislationService()
    return _legislation_service
