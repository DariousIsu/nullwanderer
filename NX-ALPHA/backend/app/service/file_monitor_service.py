"""
AURA NX-Alpha — File Monitor Service
Polling-based file change detection for user activity awareness.

Watches configured directories (Desktop, Documents, etc.) for file
modifications and creations, reporting them as activity events via SSE
and persisting to the memory service.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Configuration ────────────────────────────────────────────────────────────

_POLL_INTERVAL_S = 10.0
_MAX_DEPTH = 3
_MAX_FILES_PER_SCAN = 500

# Directories to skip during scan
_SKIP_DIRS = frozenset({
    ".git", "__pycache__", "node_modules", ".vscode", ".idea",
    ".cache", ".tox", ".mypy_cache", ".pytest_cache", "venv",
    ".venv", "env", ".env", "dist", "build", "__MACOSX",
})

# File patterns to skip
_SKIP_PREFIXES = ("~$", ".")   # Office temp files, hidden files
_SKIP_SUFFIXES = (".tmp", ".lock", ".swp", ".swo", ".pyc", ".pyo", ".log")

# Whitelist of extensions we care about
_TRACKED_EXTENSIONS = frozenset({
    ".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml",
    ".md", ".txt", ".rst", ".html", ".css", ".scss",
    ".docx", ".xlsx", ".pptx", ".pdf",
    ".csv", ".xml", ".toml", ".ini", ".cfg", ".conf",
    ".sh", ".bat", ".ps1", ".sql", ".r", ".ipynb",
})

# ── Singleton ────────────────────────────────────────────────────────────────

_instance: Optional["FileMonitorService"] = None


def init_file_monitor() -> "FileMonitorService":
    """Create and register the global FileMonitorService singleton."""
    global _instance
    _instance = FileMonitorService()
    logger.info("[file_monitor] Service initialized")
    return _instance


def get_file_monitor() -> Optional["FileMonitorService"]:
    """Return the FileMonitorService singleton, or None if not initialized."""
    return _instance


# ── Service ──────────────────────────────────────────────────────────────────

class FileMonitorService:
    """Polls watched directories for file changes and emits activity events."""

    def __init__(self) -> None:
        default_dirs: list[Path] = []
        for name in ("Desktop", "Documents"):
            d = Path.home() / name
            if d.is_dir():
                default_dirs.append(d)
        self._watched_dirs: list[Path] = default_dirs
        self._file_states: dict[str, float] = {}  # path → last known mtime
        self._task: Optional[asyncio.Task] = None
        self.last_event: Optional[dict] = None     # most recent file event
        self._first_scan_done = False

    # ── Public API ───────────────────────────────────────────────────────

    def add_watch_dir(self, path: str) -> None:
        """Add a directory to the watch list (idempotent)."""
        p = Path(path).expanduser().resolve()
        if p.is_dir() and p not in self._watched_dirs:
            self._watched_dirs.append(p)
            logger.info("[file_monitor] Added watch dir: %s", p)

    def start(self) -> asyncio.Task:
        """Start the background polling loop. Returns the asyncio Task."""
        if self._task and not self._task.done():
            self._task.cancel()
        self._task = asyncio.create_task(
            self._poll_loop(), name="file_monitor_poll"
        )
        logger.info(
            "[file_monitor] Polling started (interval=%.0fs, dirs=%d)",
            _POLL_INTERVAL_S, len(self._watched_dirs),
        )
        return self._task

    def stop(self) -> None:
        """Cancel the background polling task."""
        if self._task and not self._task.done():
            self._task.cancel()
            logger.info("[file_monitor] Polling stopped")
        self._task = None

    # ── Internals ────────────────────────────────────────────────────────

    async def _poll_loop(self) -> None:
        """Main polling loop — runs until cancelled."""
        try:
            while True:
                try:
                    events = await asyncio.to_thread(self._scan_dirs)
                    if events:
                        await self._handle_events(events)
                except Exception as exc:
                    logger.debug("[file_monitor] Scan error: %s", exc)
                await asyncio.sleep(_POLL_INTERVAL_S)
        except asyncio.CancelledError:
            logger.debug("[file_monitor] Poll loop cancelled")
            raise

    def _scan_dirs(self) -> list[dict]:
        """Scan all watched directories for file changes. Blocking."""
        events: list[dict] = []
        file_count = 0

        for watch_dir in self._watched_dirs:
            if not watch_dir.is_dir():
                continue
            for item in self._walk(watch_dir, depth=0):
                if file_count >= _MAX_FILES_PER_SCAN:
                    break
                file_count += 1

                path_str = str(item)
                try:
                    mtime = item.stat().st_mtime
                except OSError:
                    continue

                prev_mtime = self._file_states.get(path_str)
                self._file_states[path_str] = mtime

                # Skip first scan — just populate baseline
                if not self._first_scan_done:
                    continue

                if prev_mtime is None:
                    events.append({
                        "path": path_str,
                        "name": item.name,
                        "event": "created",
                        "mtime": mtime,
                    })
                elif mtime > prev_mtime:
                    events.append({
                        "path": path_str,
                        "name": item.name,
                        "event": "modified",
                        "mtime": mtime,
                    })

        if not self._first_scan_done:
            self._first_scan_done = True
            logger.info(
                "[file_monitor] Baseline scan complete: %d files indexed",
                len(self._file_states),
            )
        return events

    def _walk(self, directory: Path, depth: int):
        """Yield tracked files up to _MAX_DEPTH, filtering noise."""
        if depth > _MAX_DEPTH:
            return
        try:
            entries = list(os.scandir(directory))
        except (PermissionError, OSError):
            return

        for entry in entries:
            name = entry.name
            if entry.is_dir(follow_symlinks=False):
                if name in _SKIP_DIRS:
                    continue
                yield from self._walk(Path(entry.path), depth + 1)
            elif entry.is_file(follow_symlinks=False):
                if any(name.startswith(p) for p in _SKIP_PREFIXES):
                    continue
                if any(name.endswith(s) for s in _SKIP_SUFFIXES):
                    continue
                ext = Path(name).suffix.lower()
                if ext not in _TRACKED_EXTENSIONS:
                    continue
                yield Path(entry.path)

    async def _handle_events(self, events: list[dict]) -> None:
        """Persist events to memory and emit SSE."""
        self.last_event = events[-1]  # most recent for prompt injection

        # Persist to memory
        try:
            from app.service.memory_service import get_memory_service
            mem = get_memory_service()
            if mem:
                summary_parts = [
                    f"{e['event']}: {e['name']}" for e in events[:10]
                ]
                summary = "File activity: " + "; ".join(summary_parts)
                asyncio.create_task(mem.record(
                    "interface", summary, "activity",
                    metadata={"source": "file_monitor", "event_count": len(events)},
                ))
        except Exception as exc:
            logger.debug("[file_monitor] Memory persist error: %s", exc)

        # Emit SSE
        try:
            from app.controller.chat_controller import _emit  # type: ignore[attr-defined]
            await _emit("activity_file", {
                "events": events[:10],
                "total": len(events),
                "timestamp": time.time(),
            })
        except Exception as exc:
            logger.debug("[file_monitor] SSE emit error: %s", exc)

        logger.debug("[file_monitor] %d file events detected", len(events))
