"""
AURA NX-Alpha — Storage Monitor (§4.5)
Background asyncio task. Polls disk usage every 60s.
Emits storage_update / storage_warning / storage_limit_reached SSE events.

Runs as an asyncio task in main.py lifespan.

COMPONENTS MONITORED:
    conversations  — SQLite sliding window (Layer 1)
    vector         — ChromaDB (Layer 2)
    graph          — FalkorDB data directory (Layer 3)
    api_cache      — SQLite LRU (knowledge layer)
    training_data  — JSONL + sidecar traces
    study_data     — Raw study session data
    knowledge      — Offline ZIM/PubMed downloads (~/.aura/knowledge)
"""

import asyncio
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

WARNING_PCT  = 85.0     # Emit storage_warning at this percentage
CRITICAL_PCT = 100.0    # Emit storage_limit_reached at this percentage

# Most recent snapshot — read by GET /storage endpoint
_latest_snapshot: dict = {}

# Runtime quota overrides — updated via PUT /storage/quota without restart
_runtime_quotas: dict[str, float] = {}


def get_latest_storage_snapshot() -> dict:
    """Return the most recent storage usage snapshot. Keyed by component id."""
    return _latest_snapshot.copy()


def set_quota_override(component: str, quota_gb: float) -> None:
    """Override the quota for a component at runtime. Takes effect on next tick."""
    _runtime_quotas[component] = quota_gb
    logger.info("[storage_monitor] Runtime quota override: %s → %.1f GB", component, quota_gb)


# ─────────────────────────────────────────────────────────────────────────────
# DISK USAGE
# ─────────────────────────────────────────────────────────────────────────────

def _dir_size_gb(path: Path) -> float:
    """Return the total size of a directory (or single file) in GB."""
    if not path.exists():
        return 0.0
    try:
        if path.is_file():
            return path.stat().st_size / 1024 ** 3
        total = sum(
            f.stat().st_size
            for f in path.rglob("*")
            if f.is_file()
        )
        return total / 1024 ** 3
    except PermissionError:
        return 0.0
    except Exception as exc:
        logger.warning("[storage_monitor] Could not measure %s: %s", path, exc)
        return 0.0


# ─────────────────────────────────────────────────────────────────────────────
# STORAGE MONITOR
# ─────────────────────────────────────────────────────────────────────────────

class StorageMonitor:
    """
    Runs as a background asyncio task.
    On each tick: measure disk usage per component, update snapshot,
    emit SSE events for frontend Storage Viewport.
    """

    def __init__(self, storage_config):
        self._cfg = storage_config
        self._interval = storage_config.monitor_interval_s

    def _component_map(self) -> list[dict]:
        """Return list of {id, path, quota_gb} for each monitored component.
        Runtime overrides (set via PUT /storage/quota) take precedence over config values."""
        cfg = self._cfg

        def _quota(component_id: str, config_default: float) -> float:
            return _runtime_quotas.get(component_id, config_default)

        return [
            {
                "id":        "conversations",
                "path":      Path(cfg.layer2_path).expanduser() / "conversations",
                "quota_gb":  _quota("conversations", 2.0),
            },
            {
                "id":        "vector",
                "path":      cfg.resolve_path("layer2_path"),
                "quota_gb":  _quota("vector", cfg.layer2_quota_gb),
            },
            {
                "id":        "graph",
                "path":      cfg.resolve_path("layer3_data_path"),
                "quota_gb":  _quota("graph", cfg.layer3_quota_gb),
            },
            {
                "id":        "api_cache",
                "path":      cfg.resolve_path("api_cache_path"),
                "quota_gb":  _quota("api_cache", cfg.api_cache_quota_gb),
            },
            {
                "id":        "training_data",
                "path":      cfg.resolve_path("training_data_path"),
                "quota_gb":  _quota("training_data", cfg.training_data_quota_gb),
            },
            {
                "id":        "study_data",
                "path":      cfg.resolve_path("study_data_path"),
                "quota_gb":  _quota("study_data", cfg.study_data_quota_gb),
            },
            {
                "id":        "knowledge",
                "path":      cfg.resolve_path("knowledge_data_path"),
                "quota_gb":  _quota("knowledge", cfg.knowledge_quota_gb),
            },
        ]

    async def _tick(self) -> None:
        """Measure all components and emit SSE events."""
        from app.controller.chat_controller import _emit

        snapshot = {}

        for comp in self._component_map():
            used_gb  = _dir_size_gb(comp["path"])
            quota_gb = comp["quota_gb"]
            pct      = (used_gb / quota_gb * 100) if quota_gb > 0 else 0.0

            snapshot[comp["id"]] = {
                "used_gb":  round(used_gb, 3),
                "quota_gb": quota_gb,
                "pct":      round(pct, 1),
            }

            # Always emit storage_update (frontend refreshes its bars)
            await _emit("storage_update", {
                "component": comp["id"],
                "used_gb":   round(used_gb, 3),
                "quota_gb":  quota_gb,
                "pct":       round(pct, 1),
            })

            # Threshold alerts
            if pct >= CRITICAL_PCT:
                await _emit("storage_limit_reached", {
                    "component":       comp["id"],
                    "eviction_pending": True,
                })
                logger.warning(
                    "[storage_monitor] LIMIT REACHED: %s at %.1f%%", comp["id"], pct
                )
            elif pct >= WARNING_PCT:
                await _emit("storage_warning", {
                    "component": comp["id"],
                    "pct":       round(pct, 1),
                    "message":   f"{comp['id']} is at {pct:.0f}% of quota ({used_gb:.1f}/{quota_gb} GB)",
                })
                logger.warning(
                    "[storage_monitor] WARNING: %s at %.1f%%", comp["id"], pct
                )

        global _latest_snapshot
        _latest_snapshot = snapshot

        logger.debug(
            "[storage_monitor] Tick complete. Components: %s",
            {k: f"{v['pct']}%" for k, v in snapshot.items()},
        )

    async def run(self) -> None:
        """Main monitor loop. Runs until cancelled."""
        logger.info("[storage_monitor] Starting. Interval: %ds", self._interval)

        # Initial tick after a short delay (let the app finish starting)
        await asyncio.sleep(5)

        while True:
            try:
                await self._tick()
            except asyncio.CancelledError:
                logger.info("[storage_monitor] Cancelled")
                return
            except Exception as exc:
                logger.error("[storage_monitor] Tick failed: %s", exc)

            try:
                await asyncio.sleep(self._interval)
            except asyncio.CancelledError:
                logger.info("[storage_monitor] Cancelled during sleep")
                return
