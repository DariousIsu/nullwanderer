"""
Citation Results Service — standalone SQLite persistence for citation verification runs.

Designed for a clean Supabase swap when cloud DB migrations are ready:
  - UUID primary keys (TEXT in SQLite, UUID in Supabase)
  - ISO 8601 UTC timestamps
  - JSON-serialized complex fields (maps to JSONB in Supabase)
  - Public API stays identical after backend swap — no changes needed in callers

Supabase swap path:
  Replace the _execute / _fetchall / _fetchone internals with supabase-py calls.
  The two tables (citation_runs, citation_items) map 1:1 to Supabase tables.
"""

import json
import logging
import os
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DB_PATH_DEFAULT = "~/.aura/citation_results.db"

# ── DDL ───────────────────────────────────────────────────────────────────────

_CREATE_RUNS = """
CREATE TABLE IF NOT EXISTS citation_runs (
    id          TEXT PRIMARY KEY,           -- UUID v4
    doc_name    TEXT NOT NULL,
    doc_path    TEXT NOT NULL,
    pdf_path    TEXT,                       -- path to generated PDF report
    created_at  TEXT NOT NULL,              -- ISO8601 UTC (e.g. 2026-04-03T14:22:00Z)
    total       INTEGER DEFAULT 0,
    confirmed   INTEGER DEFAULT 0,
    partial     INTEGER DEFAULT 0,
    uncertain   INTEGER DEFAULT 0,
    not_found   INTEGER DEFAULT 0,
    unreachable INTEGER DEFAULT 0,
    doc_summary TEXT,                       -- LLM-generated document overview
    metadata    TEXT DEFAULT '{}'           -- JSON: run_duration_s, doc_hash, etc.
);
"""

_CREATE_ITEMS = """
CREATE TABLE IF NOT EXISTS citation_items (
    id              TEXT PRIMARY KEY,       -- UUID v4
    run_id          TEXT NOT NULL
                    REFERENCES citation_runs(id) ON DELETE CASCADE,
    citation_index  INTEGER NOT NULL,
    claim           TEXT,
    source_url      TEXT,
    resolved_url    TEXT,
    doi             TEXT,
    status          TEXT,                   -- confirmed|partial|uncertain|hallucinated|unreachable
    match_score     REAL DEFAULT 0.0,
    matched_passage TEXT,
    llm_verdict     TEXT,                   -- CONFIRMED|PARTIAL|NOT_SUPPORTED
    llm_note        TEXT,
    claim_source    TEXT DEFAULT 'body',    -- body|ref_only
    page_title      TEXT,
    error           TEXT,
    created_at      TEXT NOT NULL           -- ISO8601 UTC
);
"""

_CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_citation_runs_doc_name "
    "ON citation_runs(doc_name);",

    "CREATE INDEX IF NOT EXISTS idx_citation_runs_created_at "
    "ON citation_runs(created_at DESC);",

    "CREATE INDEX IF NOT EXISTS idx_citation_items_run_id "
    "ON citation_items(run_id);",

    "CREATE INDEX IF NOT EXISTS idx_citation_items_status "
    "ON citation_items(status);",
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_uuid() -> str:
    return str(uuid.uuid4())


# ── Service ───────────────────────────────────────────────────────────────────

class CitationResultsService:
    """
    Persist and retrieve citation verification run results.

    All methods are synchronous — callers should use asyncio.to_thread()
    when calling from async contexts.
    """

    def __init__(self, db_path: Optional[str] = None):
        path = db_path or os.environ.get("CITATION_DB_PATH", _DB_PATH_DEFAULT)
        self._db_path = str(Path(path).expanduser())
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    # ── Schema init ───────────────────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(_CREATE_RUNS)
            conn.execute(_CREATE_ITEMS)
            for idx_sql in _CREATE_INDEXES:
                conn.execute(idx_sql)
        logger.debug("[citation_db] Schema ready: %s", self._db_path)

    # ── Write ─────────────────────────────────────────────────────────────────

    def save_result(self, report: Any) -> str:
        """
        Persist a completed VerificationReport.

        Parameters
        ----------
        report : VerificationReport
            The report object returned by run_verification().

        Returns
        -------
        str
            UUID of the new citation_runs row.
        """
        run_id   = _new_uuid()
        now      = _now_iso()
        summary  = report.summary

        metadata = json.dumps({
            "doc_path": report.doc_path,
        })

        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO citation_runs
                    (id, doc_name, doc_path, pdf_path, created_at,
                     total, confirmed, partial, uncertain, not_found, unreachable,
                     doc_summary, metadata)
                VALUES
                    (?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?,
                     ?, ?)
                """,
                (
                    run_id,
                    report.doc_name,
                    report.doc_path,
                    report.pdf_path,
                    now,
                    summary.get("total", 0),
                    summary.get("confirmed", 0),
                    summary.get("partial", 0),
                    summary.get("uncertain", 0),
                    summary.get("hallucinated", 0),   # stored as not_found
                    summary.get("unreachable", 0),
                    getattr(report, "doc_summary", None),
                    metadata,
                ),
            )

            for c in report.citations:
                conn.execute(
                    """
                    INSERT INTO citation_items
                        (id, run_id, citation_index, claim, source_url, resolved_url,
                         doi, status, match_score, matched_passage, llm_verdict,
                         llm_note, claim_source, page_title, error, created_at)
                    VALUES
                        (?, ?, ?, ?, ?, ?,
                         ?, ?, ?, ?, ?,
                         ?, ?, ?, ?, ?)
                    """,
                    (
                        _new_uuid(),
                        run_id,
                        c.index,
                        c.claim,
                        c.source_url,
                        c.resolved_url,
                        c.doi,
                        c.status,
                        c.match_score,
                        c.matched_passage,
                        getattr(c, "llm_verdict", None),
                        getattr(c, "llm_note", None),
                        c.claim_source,
                        c.page_title,
                        c.error,
                        now,
                    ),
                )

        logger.info("[citation_db] Saved run %s — %d citations (%s)",
                    run_id, len(report.citations), report.doc_name)
        return run_id

    # ── Read ──────────────────────────────────────────────────────────────────

    def get_result(self, run_id: str) -> Optional[dict]:
        """Return a run and all its citation items, or None if not found."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM citation_runs WHERE id = ?", (run_id,)
            ).fetchone()
            if not row:
                return None
            result = dict(row)
            result["citations"] = [
                dict(r) for r in conn.execute(
                    "SELECT * FROM citation_items WHERE run_id = ? ORDER BY citation_index",
                    (run_id,),
                ).fetchall()
            ]
        return result

    def list_results(self, limit: int = 50) -> list[dict]:
        """Return the most recent `limit` runs (summary only, no citation items)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM citation_runs ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_by_doc_name(self, doc_name: str) -> list[dict]:
        """Return all runs for a specific document name, newest first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM citation_runs WHERE doc_name = ? ORDER BY created_at DESC",
                (doc_name,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_items(self, run_id: str) -> list[dict]:
        """Return all citation items for a run."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM citation_items WHERE run_id = ? ORDER BY citation_index",
                (run_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def delete_result(self, run_id: str) -> bool:
        """Delete a run and all its items (cascade). Returns True if deleted."""
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM citation_runs WHERE id = ?", (run_id,)
            )
        deleted = cur.rowcount > 0
        if deleted:
            logger.info("[citation_db] Deleted run %s", run_id)
        return deleted

    def stats(self) -> dict:
        """Return aggregate stats across all runs."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT
                    COUNT(*)        AS total_runs,
                    SUM(total)      AS total_citations,
                    SUM(confirmed)  AS confirmed,
                    SUM(partial)    AS partial,
                    SUM(uncertain)  AS uncertain,
                    SUM(not_found)  AS not_found,
                    SUM(unreachable) AS unreachable,
                    MAX(created_at) AS last_run_at
                FROM citation_runs
                """
            ).fetchone()
        return dict(row) if row else {}


# ── Singleton ──────────────────────────────────────────────────────────────────

_service: Optional[CitationResultsService] = None


def get_citation_results_service(db_path: Optional[str] = None) -> CitationResultsService:
    """Return the shared CitationResultsService instance (lazy init)."""
    global _service
    if _service is None:
        _service = CitationResultsService(db_path=db_path)
    return _service
