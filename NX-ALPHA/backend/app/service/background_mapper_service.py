"""
AURA NX-Alpha — Background Mapper Service

Always-on asyncio task that scans for unmapped records across all source types
and creates/updates ingestion jobs in IngestionJobService.

Scan interval: 300 seconds (5 minutes)

SINGLETON PATTERN:
    Call BackgroundMapperService.get_instance() to obtain the shared instance.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Awaitable, Optional

logger = logging.getLogger(__name__)

_AURA_DIR = Path.home() / ".aura"
_MEMORY_DB = _AURA_DIR / "memory.db"
_KNOWLEDGE_DIR = _AURA_DIR / "knowledge"
_SCAN_INTERVAL_SECONDS = 300

# Average token-to-chunk ratio estimate for size-based knowledge estimation
_BYTES_PER_CHUNK_ESTIMATE = 1024


class BackgroundMapperService:
    """
    Singleton background service that periodically scans all source types
    to detect unmapped records and create ingestion jobs for them.
    """

    _instance: Optional[BackgroundMapperService] = None

    def __init__(self) -> None:
        self._enabled: bool = True
        self._running: bool = False
        self._scanning: bool = False
        self._task: Optional[asyncio.Task] = None
        self._last_scan_at: Optional[str] = None
        self._next_scan_in: int = _SCAN_INTERVAL_SECONDS
        self._emit_fn: Optional[Callable[[str, dict], Awaitable[None]]] = None

    @classmethod
    def get_instance(cls) -> BackgroundMapperService:
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    # ── Public API ────────────────────────────────────────────────────────────

    async def start(self, emit_fn: Callable[[str, dict], Awaitable[None]]) -> None:
        """Start the background scan loop. Idempotent — safe to call multiple times."""
        self._emit_fn = emit_fn
        if self._task and not self._task.done():
            logger.debug("[background_mapper] Already running — ignoring start()")
            return
        self._running = True
        self._task = asyncio.create_task(self._loop(), name="background_mapper")
        logger.info("[background_mapper] Started (interval=%ds)", _SCAN_INTERVAL_SECONDS)

    async def stop(self) -> None:
        """Cancel the scan loop and wait for it to terminate."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        logger.info("[background_mapper] Stopped")

    def set_enabled(self, enabled: bool) -> None:
        """Toggle scanning without stopping the asyncio task."""
        self._enabled = enabled
        logger.info("[background_mapper] Enabled set to %s", enabled)

    def get_status(self) -> dict:
        """Return current service state."""
        return {
            "enabled": self._enabled,
            "running": self._running and (self._task is not None and not self._task.done()),
            "last_scan_at": self._last_scan_at,
            "next_scan_in_seconds": self._next_scan_in,
            "scanning": self._scanning,
        }

    # ── Internal loop ─────────────────────────────────────────────────────────

    async def _loop(self) -> None:
        """Main scan loop — runs every _SCAN_INTERVAL_SECONDS seconds."""
        while self._running:
            if self._enabled:
                await self._scan_and_update_manifests()
            # Countdown for next scan
            self._next_scan_in = _SCAN_INTERVAL_SECONDS
            for _ in range(_SCAN_INTERVAL_SECONDS):
                if not self._running:
                    break
                await asyncio.sleep(1)
                self._next_scan_in = max(0, self._next_scan_in - 1)

    async def _scan_and_update_manifests(self) -> None:
        """
        Scan each source type for unmapped records.
        For each source with unmapped > 0, create an ingestion job if none exists.
        Emits mapping_progress SSE events for each source.
        """
        self._scanning = True
        self._last_scan_at = datetime.now(timezone.utc).isoformat()
        logger.debug("[background_mapper] Scan starting")

        try:
            from app.service.ingestion_job_service import IngestionJobService
            job_svc = IngestionJobService.get_instance()
            if not job_svc._initialized:
                await job_svc.initialize()

            # Build Neo4j coverage map (source_type → TextUnit count)
            coverage = await self._get_neo4j_coverage()

            sources_to_scan = {
                "conversations": self._count_conversations,
                "knowledge": self._count_knowledge,
                "legislative": self._count_legislative,
            }

            for source_type, count_fn in sources_to_scan.items():
                try:
                    total = await asyncio.get_running_loop().run_in_executor(
                        None, count_fn
                    )
                    mapped = coverage.get(source_type, 0)
                    unmapped = max(0, total - mapped)

                    # Determine queued count from jobs
                    all_jobs = job_svc.get_all_jobs()
                    queued = sum(
                        1 for j in all_jobs
                        if j.get("source_type") == source_type
                        and j.get("status") in ("queued", "mapping", "mapped", "ingesting")
                    )

                    logger.debug(
                        "[background_mapper] %s: total=%d mapped=%d unmapped=%d queued_jobs=%d",
                        source_type, total, mapped, unmapped, queued,
                    )

                    # Emit SSE progress
                    if self._emit_fn:
                        try:
                            await self._emit_fn("mapping_progress", {
                                "source": source_type,
                                "total": total,
                                "mapped": mapped,
                                "unmapped": unmapped,
                            })
                        except Exception as emit_exc:
                            logger.debug(
                                "[background_mapper] SSE emit failed: %s", emit_exc
                            )

                    # Create a job if unmapped records exist and no active job
                    if unmapped > 0 and queued == 0:
                        existing_active = [
                            j for j in all_jobs
                            if j.get("source_type") == source_type
                            and j.get("status") not in ("complete", "failed")
                        ]
                        if not existing_active:
                            job_id = job_svc.create_job(
                                source_type=source_type,
                                source_label=source_type.capitalize(),
                                source_path="",
                            )
                            await job_svc.set_status(job_id, "mapping")
                            await job_svc.update_job(
                                job_id,
                                chunks_total=unmapped,
                            )
                            logger.info(
                                "[background_mapper] Created job %s for %s (%d unmapped)",
                                job_id, source_type, unmapped,
                            )

                except Exception as src_exc:
                    logger.warning(
                        "[background_mapper] Error scanning source %s: %s",
                        source_type, src_exc,
                    )

        except Exception as exc:
            logger.error("[background_mapper] Scan failed: %s", exc)
        finally:
            self._scanning = False
            logger.debug("[background_mapper] Scan complete")

    # ── Source counters ───────────────────────────────────────────────────────

    def _count_conversations(self) -> int:
        """Count records in the sliding_window table in ~/.aura/memory.db."""
        if not _MEMORY_DB.exists():
            return 0
        try:
            conn = sqlite3.connect(str(_MEMORY_DB))
            try:
                row = conn.execute(
                    "SELECT COUNT(*) FROM sliding_window"
                ).fetchone()
                return row[0] if row else 0
            finally:
                conn.close()
        except Exception as exc:
            logger.debug("[background_mapper] conversations count error: %s", exc)
            return 0

    def _count_knowledge(self) -> int:
        """
        Estimate knowledge chunk count by scanning ~/.aura/knowledge/ for indexed sources.
        Returns estimated chunk count based on total file size / _BYTES_PER_CHUNK_ESTIMATE.
        """
        if not _KNOWLEDGE_DIR.exists():
            return 0
        try:
            total_bytes = 0
            for root, _dirs, files in os.walk(_KNOWLEDGE_DIR):
                for fname in files:
                    fp = Path(root) / fname
                    try:
                        total_bytes += fp.stat().st_size
                    except OSError:
                        pass
            return max(0, total_bytes // _BYTES_PER_CHUNK_ESTIMATE)
        except Exception as exc:
            logger.debug("[background_mapper] knowledge count error: %s", exc)
            return 0

    def _count_legislative(self) -> int:
        """
        Check known legislation DB sizes.
        Looks for SQLite files in ~/.aura/ matching legislative naming patterns.
        """
        candidate_patterns = [
            _AURA_DIR / "legislation.db",
            _AURA_DIR / "legislative.db",
            _AURA_DIR / "bills.db",
        ]
        total = 0
        for db_path in candidate_patterns:
            if not db_path.exists():
                continue
            try:
                conn = sqlite3.connect(str(db_path))
                try:
                    # Try common table names
                    for table in ("bills", "legislation", "documents", "records"):
                        try:
                            row = conn.execute(
                                f"SELECT COUNT(*) FROM {table}"
                            ).fetchone()
                            if row:
                                total += row[0]
                                break
                        except sqlite3.OperationalError:
                            continue
                finally:
                    conn.close()
            except Exception as exc:
                logger.debug(
                    "[background_mapper] legislative count error (%s): %s", db_path, exc
                )
        return total

    # ── Neo4j coverage ────────────────────────────────────────────────────────

    async def _get_neo4j_coverage(self) -> dict[str, int]:
        """
        Query Neo4j lightrag_knowledge DB for TextUnit node counts per source type.
        Returns {source_type: count} or empty dict if Neo4j is unavailable.
        """
        try:
            loop = asyncio.get_running_loop()
            return await loop.run_in_executor(None, self._sync_neo4j_coverage)
        except Exception as exc:
            logger.debug("[background_mapper] Neo4j coverage check skipped: %s", exc)
            return {}

    def _sync_neo4j_coverage(self) -> dict[str, int]:
        """Synchronous Neo4j TextUnit count query."""
        try:
            from neo4j import GraphDatabase
        except ImportError:
            return {}

        from app.config import get_settings
        settings = get_settings()
        mem = settings.memory
        uri = mem.neo4j_uri
        user = mem.neo4j_user
        password = mem.neo4j_password

        coverage: dict[str, int] = {}
        source_types = ["conversations", "knowledge", "legislative", "documents"]

        try:
            driver = GraphDatabase.driver(uri, auth=(user, password))
            with driver.session(database="lightrag_knowledge") as session:
                for source_type in source_types:
                    try:
                        result = session.run(
                            "MATCH (t:TextUnit) "
                            "WHERE t.source_id STARTS WITH $prefix "
                            "RETURN count(t) AS cnt",
                            prefix=f"{source_type}:",
                        )
                        record = result.single()
                        coverage[source_type] = record["cnt"] if record else 0
                    except Exception:
                        coverage[source_type] = 0
            driver.close()
        except Exception as exc:
            logger.debug("[background_mapper] Neo4j query failed: %s", exc)

        return coverage
