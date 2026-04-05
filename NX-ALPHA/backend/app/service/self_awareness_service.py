"""
AURA NX-Alpha — Self-Awareness Service

Aggregates AURA's own operational state into a structured self-model.
Agents can query this to answer questions like "are you healthy?",
"what errors have occurred?", "which services are running?", etc.

TWO-TIER POLLING:
    Fast poll (30 s)  — in-memory reads only: service health, error deque,
                        active asyncio tasks, current screen context.
    Slow poll (5 min) — DB and network queries: model status (Ollama /api/ps),
                        memory layer sizes (ChromaDB, SQLite, Neo4j).
    Both polls skip their tick if the system is under load (CPU > 75% or
    RAM > 85%) using _system_under_load() to read the cached system_monitor
    snapshot — no additional polling.

ERROR CAPTURE:
    SelfAwarenessLogHandler is installed at init_self_awareness() into the
    root logger.  Every WARNING+ log entry is appended to a deque of 100.
    An immediate "self_error" SSE event fires for each WARNING+ entry.

SSE EVENTS EMITTED:
    self_status   — lightweight snapshot (service health + error count)
    self_error    — immediate emit on any WARNING+ log entry

SINGLETON:
    init_self_awareness()   — create and start
    get_self_awareness()    — get instance (None if not yet initialised)
"""

from __future__ import annotations

import asyncio
import collections
import logging
import time
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ── Singleton ─────────────────────────────────────────────────────────────────
_instance: "SelfAwarenessService | None" = None


def init_self_awareness() -> "SelfAwarenessService":
    """Create and register the global SelfAwarenessService singleton."""
    global _instance
    _instance = SelfAwarenessService()
    _instance._install_log_handler()
    return _instance


def get_self_awareness() -> "SelfAwarenessService | None":
    """Return the global singleton, or None if not yet initialised."""
    return _instance


# ── System load guard ─────────────────────────────────────────────────────────

def _system_under_load() -> bool:
    """
    Return True if CPU > 75% or RAM > 85%.
    Reads the cached system_monitor snapshot — no new I/O.
    """
    try:
        from app.service.system_monitor_service import get_latest_snapshot
        snap = get_latest_snapshot()
        return (
            snap.get("cpu_percent", 0) > 75
            or snap.get("ram", {}).get("percent", 0) > 85
        )
    except Exception:
        return False


# ── Log handler ───────────────────────────────────────────────────────────────

class SelfAwarenessLogHandler(logging.Handler):
    """
    Lightweight logging handler that captures WARNING+ entries.

    Appends to a fixed-size deque and fires an immediate SSE event
    on each WARNING+ record.
    """

    def __init__(self, service: "SelfAwarenessService") -> None:
        super().__init__(level=logging.WARNING)
        self._svc = service

    def emit(self, record: logging.LogRecord) -> None:
        try:
            entry = {
                "timestamp": record.created,
                "level":     record.levelname,
                "logger":    record.name,
                "message":   record.getMessage()[:400],
            }
            self._svc._error_log.append(entry)
            # Fire SSE from event loop if one is running
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    asyncio.ensure_future(self._svc._emit_error(entry))
            except Exception:
                pass
        except Exception:
            pass  # never crash the logging system


# ── Service ────────────────────────────────────────────────────────────────────

class SelfAwarenessService:
    """
    AURA's introspective state aggregator.

    Never instantiate directly — use init_self_awareness() / get_self_awareness().
    """

    def __init__(self) -> None:
        # Error capture (deque of 100 most recent WARNING+ log entries)
        self._error_log: collections.deque = collections.deque(maxlen=100)

        # Cached slow-poll data
        self._model_status:  dict = {}
        self._memory_stats:  dict = {}
        self._world_state:   dict = {}

        # Task handles
        self._fast_task: Optional[asyncio.Task] = None
        self._slow_task: Optional[asyncio.Task] = None

        logger.info("[self_awareness] SelfAwarenessService created")

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def _install_log_handler(self) -> None:
        """Attach to root logger so we capture all WARNING+ entries."""
        root = logging.getLogger()
        handler = SelfAwarenessLogHandler(self)
        handler.setFormatter(logging.Formatter("%(message)s"))
        root.addHandler(handler)
        logger.debug("[self_awareness] Log handler installed")

    def start_polling(self, interval_s: int = 30) -> None:
        """Start fast and slow background poll loops."""
        self._fast_task = asyncio.create_task(
            self._fast_poll_loop(interval_s), name="self_awareness_fast"
        )
        self._slow_task = asyncio.create_task(
            self._slow_poll_loop(interval_s * 10), name="self_awareness_slow"
        )
        logger.info(
            "[self_awareness] Polling started (fast=%ds, slow=%ds)",
            interval_s, interval_s * 10,
        )

    def stop(self) -> None:
        for task in (self._fast_task, self._slow_task):
            if task and not task.done():
                task.cancel()

    # ── Fast poll loop (30 s, in-memory only) ─────────────────────────────────

    async def _fast_poll_loop(self, interval_s: int) -> None:
        while True:
            try:
                if not _system_under_load():
                    snap = self._fast_snapshot()
                    await self._emit_status(snap)
                await asyncio.sleep(interval_s)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("[self_awareness] Fast poll error: %s", exc)
                await asyncio.sleep(interval_s)

    def _fast_snapshot(self) -> dict:
        """Collect in-memory state: services, errors, tasks, screen context."""
        snap: dict = {"timestamp": time.time()}

        # Service health
        try:
            from app.service.process_manager import get_all_service_statuses
            snap["services"] = get_all_service_statuses()
        except Exception:
            try:
                # Fallback: direct dict read
                from app.service import process_manager as _pm
                snap["services"] = dict(_pm._service_status)
            except Exception:
                snap["services"] = {}

        # Recent errors
        snap["recent_errors"] = list(self._error_log)[-20:]
        snap["error_count"]   = len(self._error_log)

        # Active asyncio tasks
        snap["active_tasks"] = self._get_task_list()

        # Screen context
        try:
            from app.service.screen_awareness_service import get_current_context, get_idle_state
            ctx = get_current_context()
            idle_state, idle_secs = get_idle_state()
            snap["screen"] = {
                "window_title": ctx.raw_title,
                "app":          ctx.app_name,
                "topic":        ctx.topic,
                "idle_state":   idle_state,
                "idle_secs":    round(idle_secs, 1),
            }
        except Exception:
            snap["screen"] = {}

        # Merge slow-poll data (read cached — no I/O)
        if self._model_status:
            snap["models"] = self._model_status
        if self._memory_stats:
            snap["memory"] = self._memory_stats

        return snap

    def _get_task_list(self) -> list[str]:
        """Return names of running asyncio tasks (AURA background workers)."""
        try:
            tasks = asyncio.all_tasks()
            names = []
            for t in tasks:
                n = t.get_name() or ""
                if n and not n.startswith("Task-"):
                    names.append(n)
            return sorted(names)
        except Exception:
            return []

    # ── Slow poll loop (5 min, DB + network) ──────────────────────────────────

    async def _slow_poll_loop(self, interval_s: int) -> None:
        # Initial delay so we don't hit DB right at boot
        await asyncio.sleep(60)
        while True:
            try:
                if not _system_under_load():
                    await self._refresh_model_status()
                    await self._refresh_memory_stats()
                    await self._refresh_world_state()
                await asyncio.sleep(interval_s)
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("[self_awareness] Slow poll error: %s", exc)
                await asyncio.sleep(interval_s)

    async def _refresh_model_status(self) -> None:
        """Query Ollama /api/ps for loaded models."""
        try:
            import httpx
            from app.config import get_settings
            host = get_settings().interface_model.ollama_host
            async with httpx.AsyncClient(timeout=5) as client:
                resp = await client.get(f"{host}/api/ps")
                if resp.status_code == 200:
                    data = resp.json()
                    models = data.get("models", [])
                    self._model_status = {
                        "loaded": [m.get("name", "") for m in models],
                        "count":  len(models),
                        "details": [
                            {
                                "name":    m.get("name", ""),
                                "size_mb": round(m.get("size", 0) / (1024**2), 1),
                            }
                            for m in models
                        ],
                    }
        except Exception as exc:
            logger.debug("[self_awareness] Model status refresh failed: %s", exc)

    async def _refresh_memory_stats(self) -> None:
        """Read memory layer sizes from ChromaDB, SQLite, and Neo4j."""
        stats: dict = {}

        # ChromaDB
        try:
            from app.service.memory_service import get_memory_service
            mem = get_memory_service()
            if mem and hasattr(mem, "_l2") and mem._l2 is not None:
                stats["chroma_count"] = await asyncio.to_thread(lambda: mem._l2.count())
        except Exception:
            pass

        # SQLite sliding window
        try:
            import aiosqlite
            from pathlib import Path as _P
            db_path = _P.home() / ".aura" / "memory.db"
            if db_path.exists():
                async with aiosqlite.connect(str(db_path)) as db:
                    row = await (await db.execute(
                        "SELECT COUNT(*) FROM sliding_window"
                    )).fetchone()
                    stats["sqlite_window_rows"] = row[0] if row else 0
        except Exception:
            pass

        # Neo4j
        try:
            from neo4j import AsyncGraphDatabase
            from app.config import get_settings
            cfg = get_settings().memory
            driver = AsyncGraphDatabase.driver(
                cfg.neo4j_uri,
                auth=(cfg.neo4j_user, cfg.neo4j_password),
            )
            async with driver.session() as session:
                result = await session.run("MATCH (n) RETURN count(n) AS cnt")
                record = await result.single()
                stats["neo4j_nodes"] = record["cnt"] if record else 0
            await driver.close()
        except Exception:
            pass

        if stats:
            self._memory_stats = stats

    async def _refresh_world_state(self) -> None:
        """Cache the current world state summary."""
        try:
            from app.service.idle_triage_service import get_idle_triage
            svc = get_idle_triage()
            if svc:
                self._world_state = dict(svc.world_state)
        except Exception:
            pass

    # ── SSE emission ──────────────────────────────────────────────────────────

    async def _emit_status(self, data: dict) -> None:
        try:
            from app.controller.chat_controller import _emit  # type: ignore
            await _emit("self_status", data)
        except Exception:
            pass

    async def _emit_error(self, entry: dict) -> None:
        try:
            from app.controller.chat_controller import _emit  # type: ignore
            await _emit("self_error", entry)
        except Exception:
            pass

    # ── Public snapshot API (called by aura_self tool) ────────────────────────

    def snapshot(self, query: str = "full") -> dict:
        """
        Return a structured snapshot of AURA's operational state.

        Parameters
        ----------
        query : str
            One of: "health", "services", "memory", "errors", "tasks",
                    "config", "models", "logs", "world_state", "full"
        """
        result: dict = {"query": query, "timestamp": time.time()}

        if query in ("health", "services", "full"):
            try:
                from app.service import process_manager as _pm
                result["services"] = dict(_pm._service_status)
            except Exception:
                result["services"] = {}

        if query in ("models", "full"):
            result["models"] = self._model_status or {"note": "Not yet collected (slow poll at 5 min)"}

        if query in ("memory", "full"):
            result["memory"] = self._memory_stats or {"note": "Not yet collected (slow poll at 5 min)"}

        if query in ("errors", "full"):
            result["recent_errors"] = list(self._error_log)[-20:]
            result["error_count"]   = len(self._error_log)

        if query in ("tasks", "full"):
            result["active_tasks"] = self._get_task_list()

        if query in ("config", "full"):
            result["config"] = self._config_summary()

        if query in ("world_state", "full"):
            result["world_state"] = self._world_state

        if query in ("logs", "full"):
            result["logs"] = self._get_log_tail(50)

        if query in ("screen", "full"):
            try:
                from app.service.screen_awareness_service import get_current_context, get_idle_state
                ctx = get_current_context()
                idle_state, idle_secs = get_idle_state()
                result["screen"] = {
                    "window_title": ctx.raw_title,
                    "app":          ctx.app_name,
                    "topic":        ctx.topic,
                    "idle_state":   idle_state,
                    "idle_secs":    round(idle_secs, 1),
                }
            except Exception:
                result["screen"] = {}

        return result

    def _config_summary(self) -> dict:
        """Return a safe, non-secret config summary."""
        try:
            from app.config import get_settings
            s = get_settings()
            return {
                "interface_model": s.interface_model.model,
                "workhorse_model": s.workhorse.model,
                "log_level":       s.log_level,
                "hardware_phase":  s.hardware_phase,
                "dev_stub":        s.dev_stub_responses,
            }
        except Exception:
            return {}

    def _get_log_tail(self, n: int = 50) -> list[str]:
        """Read the last N lines from AURA's log file."""
        try:
            root_logger = logging.getLogger()
            for handler in root_logger.handlers:
                if isinstance(handler, logging.FileHandler):
                    log_path = handler.baseFilename
                    with open(log_path, "r", encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()
                    return [l.rstrip() for l in lines[-n:]]
        except Exception:
            pass
        # Fallback: return recent error_log entries as text
        return [
            f"[{e['level']}] {e['logger']}: {e['message']}"
            for e in list(self._error_log)[-n:]
        ]
