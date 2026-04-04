"""
AURA NX-Alpha — Ingestion Job Service

SQLite-backed job queue at ~/.aura/ingestion_jobs.db.
Manages ingestion jobs through states:
    pending → mapping → mapped → queued → ingesting → paused → complete → failed

SINGLETON PATTERN:
    Call IngestionJobService.get_instance() to obtain the shared instance.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_DB_PATH = Path.home() / ".aura" / "ingestion_jobs.db"

_CREATE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    source_type TEXT,
    source_label TEXT,
    source_path TEXT,
    status TEXT DEFAULT 'pending',
    chunks_total INTEGER DEFAULT 0,
    chunks_done INTEGER DEFAULT 0,
    tokens_processed INTEGER DEFAULT 0,
    rate_chunks_per_min REAL DEFAULT 0,
    workers_active INTEGER DEFAULT 0,
    started_at TEXT,
    paused_at TEXT,
    completed_at TEXT,
    eta_seconds INTEGER,
    auto_ingested INTEGER DEFAULT 0,
    interruptions TEXT DEFAULT '[]',
    created_at TEXT
)
"""

_VALID_STATUSES = frozenset({
    "pending", "mapping", "mapped", "queued",
    "ingesting", "paused", "complete", "failed",
})

_VALID_SOURCE_TYPES = frozenset({
    "knowledge", "legislative", "conversations",
    "documents", "drive", "folder", "git", "notion",
})


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    # Deserialize interruptions JSON
    if isinstance(d.get("interruptions"), str):
        try:
            d["interruptions"] = json.loads(d["interruptions"])
        except (json.JSONDecodeError, TypeError):
            d["interruptions"] = []
    return d


class IngestionJobService:
    """
    Singleton service that manages the ingestion job queue backed by SQLite.
    """

    _instance: Optional[IngestionJobService] = None
    _lock = asyncio.Lock()

    def __init__(self) -> None:
        self._db_path = _DB_PATH
        self._conn: Optional[sqlite3.Connection] = None
        self._initialized = False

    @classmethod
    def get_instance(cls) -> IngestionJobService:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Initialization ────────────────────────────────────────────────────────

    async def initialize(self) -> None:
        """Create the DB file and schema if they don't exist yet."""
        if self._initialized:
            return
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._sync_init)
        self._initialized = True
        logger.info("[ingestion_job_service] DB initialized at %s", self._db_path)

    def _sync_init(self) -> None:
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(_CREATE_TABLE_SQL)
        conn.commit()
        self._conn = conn

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            # Auto-init (sync path for non-async callers)
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute(_CREATE_TABLE_SQL)
            conn.commit()
            self._conn = conn
            self._initialized = True
        return self._conn

    # ── CRUD ──────────────────────────────────────────────────────────────────

    def create_job(
        self,
        source_type: str,
        source_label: str,
        source_path: str = "",
    ) -> str:
        """Create a new job in 'pending' state and return its ID."""
        job_id = str(uuid.uuid4())
        now = _now_iso()
        conn = self._get_conn()
        conn.execute(
            """
            INSERT INTO jobs
                (id, source_type, source_label, source_path, status,
                 interruptions, created_at)
            VALUES
                (?, ?, ?, ?, 'pending', '[]', ?)
            """,
            (job_id, source_type, source_label, source_path, now),
        )
        conn.commit()
        logger.debug(
            "[ingestion_job_service] Created job %s type=%s label=%s",
            job_id, source_type, source_label,
        )
        return job_id

    def get_job(self, job_id: str) -> Optional[dict]:
        """Return a single job as a dict, or None if not found."""
        conn = self._get_conn()
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        return _row_to_dict(row)

    def get_all_jobs(self) -> list[dict]:
        """Return all jobs ordered by creation time (newest first)."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC"
        ).fetchall()
        return [_row_to_dict(r) for r in rows]

    async def update_job(self, job_id: str, **kwargs: Any) -> None:
        """Update arbitrary fields on a job row."""
        if not kwargs:
            return
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._sync_update_job, job_id, kwargs)

    def _sync_update_job(self, job_id: str, fields: dict) -> None:
        conn = self._get_conn()
        cols = ", ".join(f"{k} = ?" for k in fields)
        vals = list(fields.values()) + [job_id]
        conn.execute(f"UPDATE jobs SET {cols} WHERE id = ?", vals)
        conn.commit()

    async def set_status(self, job_id: str, status: str) -> None:
        """Transition a job to a new status."""
        if status not in _VALID_STATUSES:
            raise ValueError(f"Invalid status: {status!r}")
        now = _now_iso()
        extra: dict[str, Any] = {"status": status}
        if status == "ingesting":
            extra["started_at"] = now
        elif status == "paused":
            extra["paused_at"] = now
        elif status in ("complete", "failed"):
            extra["completed_at"] = now
        await self.update_job(job_id, **extra)
        logger.debug("[ingestion_job_service] Job %s → %s", job_id, status)

    async def update_rate(self, job_id: str, new_rate_chunks_per_min: float) -> None:
        """
        EMA update for rate_chunks_per_min.
        rate = 0.9 * old + 0.1 * new
        Recomputes eta_seconds from chunks_total - chunks_done.
        """
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None, self._sync_update_rate, job_id, new_rate_chunks_per_min
        )

    def _sync_update_rate(self, job_id: str, new_rate: float) -> None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT rate_chunks_per_min, chunks_total, chunks_done FROM jobs WHERE id = ?",
            (job_id,),
        ).fetchone()
        if row is None:
            return
        old_rate = row["rate_chunks_per_min"] or 0.0
        rate = 0.9 * old_rate + 0.1 * new_rate
        remaining = max(0, (row["chunks_total"] or 0) - (row["chunks_done"] or 0))
        if rate > 0:
            eta_seconds = int((remaining / rate) * 60)
        else:
            eta_seconds = None
        conn.execute(
            "UPDATE jobs SET rate_chunks_per_min = ?, eta_seconds = ? WHERE id = ?",
            (rate, eta_seconds, job_id),
        )
        conn.commit()

    async def add_interruption(
        self,
        job_id: str,
        reason: str,
        trigger: str,
    ) -> None:
        """Append a new interruption record to the job's interruptions JSON array."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None, self._sync_add_interruption, job_id, reason, trigger
        )

    def _sync_add_interruption(self, job_id: str, reason: str, trigger: str) -> None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT interruptions FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        if row is None:
            return
        try:
            interruptions = json.loads(row["interruptions"] or "[]")
        except (json.JSONDecodeError, TypeError):
            interruptions = []
        interruptions.append({
            "reason": reason,
            "trigger": trigger,
            "interrupted_at": _now_iso(),
            "resumed_at": None,
            "duration_min": None,
        })
        conn.execute(
            "UPDATE jobs SET interruptions = ? WHERE id = ?",
            (json.dumps(interruptions), job_id),
        )
        conn.commit()

    async def close_interruption(self, job_id: str) -> None:
        """
        Set resumed_at on the last open interruption and compute duration_min.
        """
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(None, self._sync_close_interruption, job_id)

    def _sync_close_interruption(self, job_id: str) -> None:
        conn = self._get_conn()
        row = conn.execute(
            "SELECT interruptions FROM jobs WHERE id = ?", (job_id,)
        ).fetchone()
        if row is None:
            return
        try:
            interruptions = json.loads(row["interruptions"] or "[]")
        except (json.JSONDecodeError, TypeError):
            interruptions = []

        now_str = _now_iso()
        now_dt = datetime.fromisoformat(now_str)

        for entry in reversed(interruptions):
            if entry.get("resumed_at") is None:
                entry["resumed_at"] = now_str
                try:
                    interrupted_dt = datetime.fromisoformat(entry["interrupted_at"])
                    duration_sec = (now_dt - interrupted_dt).total_seconds()
                    entry["duration_min"] = round(duration_sec / 60, 2)
                except Exception:
                    entry["duration_min"] = None
                break

        conn.execute(
            "UPDATE jobs SET interruptions = ? WHERE id = ?",
            (json.dumps(interruptions), job_id),
        )
        conn.commit()

    async def increment_progress(
        self,
        job_id: str,
        chunks_done_delta: int,
        tokens_delta: int,
    ) -> None:
        """Atomically increment chunks_done and tokens_processed. Checkpoints on every call."""
        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None, self._sync_increment_progress, job_id, chunks_done_delta, tokens_delta
        )

    def _sync_increment_progress(
        self, job_id: str, chunks_done_delta: int, tokens_delta: int
    ) -> None:
        conn = self._get_conn()
        conn.execute(
            """
            UPDATE jobs
            SET chunks_done = chunks_done + ?,
                tokens_processed = tokens_processed + ?
            WHERE id = ?
            """,
            (chunks_done_delta, tokens_delta, job_id),
        )
        conn.commit()  # checkpoint

    def get_active_ingestion_job(self) -> Optional[dict]:
        """Return the first job with status='ingesting', or None."""
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM jobs WHERE status = 'ingesting' LIMIT 1"
        ).fetchone()
        return _row_to_dict(row) if row else None

    def get_next_queued_job(self) -> Optional[dict]:
        """Return the first queued job ordered by created_at, or None."""
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
        return _row_to_dict(row) if row else None

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
