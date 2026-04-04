"""
AURA NX-Alpha — Satellite Agent (Main Backend Module)
Periodic background service that manages the satellite fleet from the main AURA backend.
Polls satellites, updates the registry, runs governor checks, and maintains fleet health.

NOTE: This is the MAIN BACKEND's satellite management agent, not the remote satellite agent
that runs on satellite machines. The remote agent is a separate project.

INITIALIZATION:
    init_satellite_agent(interval_seconds=300) — configure the agent
    start_satellite_agent() — returns a background asyncio.Task
    stop_satellite_agent() — cancel the background task

LIFECYCLE (main.py):
    The agent is initialized and started in the FastAPI lifespan, and stopped on shutdown.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# MODULE STATE
# ─────────────────────────────────────────────────────────────────────────────

_interval_seconds: int = 300  # Default 5 minutes
_task: Optional[asyncio.Task] = None
_running: bool = False
_initialized: bool = False


def init_satellite_agent(interval_seconds: int = 300) -> None:
    """Configure the satellite agent. Call once at startup."""
    global _interval_seconds, _initialized
    _interval_seconds = interval_seconds
    _initialized = True
    logger.info("[satellite_agent] Initialized (interval=%ds)", interval_seconds)

    # Initialize all satellite sub-services
    _init_services()


def _init_services() -> None:
    """Initialize the satellite sub-services (registry, governor, poller, provisioner)."""
    try:
        from app.service.satellite.registry import init_satellite_registry
        init_satellite_registry()
        logger.info("[satellite_agent] Registry initialized")
    except Exception as exc:
        logger.warning("[satellite_agent] Registry init failed: %s", exc)

    try:
        from app.service.satellite.governor import init_hardware_governor
        init_hardware_governor()
        logger.info("[satellite_agent] Hardware governor initialized")
    except Exception as exc:
        logger.warning("[satellite_agent] Governor init failed: %s", exc)

    # Get SSE emit function
    emit_fn = None
    try:
        from app.controller.chat_controller import _emit
        emit_fn = _emit
    except Exception:
        pass

    try:
        from app.service.satellite.health_poller import init_health_poller
        poller = init_health_poller(emit_fn=emit_fn)
        logger.info("[satellite_agent] Health poller initialized")
    except Exception as exc:
        logger.warning("[satellite_agent] Health poller init failed: %s", exc)

    try:
        from app.service.satellite.provisioner import init_satellite_provisioner
        init_satellite_provisioner(emit_fn=emit_fn)
        logger.info("[satellite_agent] Provisioner initialized")
    except Exception as exc:
        logger.warning("[satellite_agent] Provisioner init failed: %s", exc)


async def start_satellite_agent() -> asyncio.Task:
    """Start the satellite agent background loop. Returns the task."""
    global _task, _running

    if not _initialized:
        init_satellite_agent()

    _running = True

    # Start the health poller
    try:
        from app.service.satellite.health_poller import get_health_poller
        poller = get_health_poller()
        if poller:
            poller.start()
    except Exception as exc:
        logger.warning("[satellite_agent] Health poller start failed: %s", exc)

    # Start the main agent loop
    _task = asyncio.create_task(_agent_loop(), name="satellite_agent")
    logger.info("[satellite_agent] Started")
    return _task


def stop_satellite_agent() -> None:
    """Stop the satellite agent and health poller."""
    global _running, _task

    _running = False

    # Stop the health poller
    try:
        from app.service.satellite.health_poller import get_health_poller
        poller = get_health_poller()
        if poller:
            poller.stop()
    except Exception:
        pass

    # Cancel the agent task
    if _task and not _task.done():
        _task.cancel()
        logger.info("[satellite_agent] Stopped")


async def _agent_loop() -> None:
    """
    Main agent loop. Runs every `_interval_seconds`.
    Performs fleet maintenance tasks:
      - Check cooldown expirations
      - Prune stale satellites (offline > 24h → mark stale)
      - Emit fleet summary SSE
    """
    while _running:
        try:
            await _maintenance_cycle()
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.error("[satellite_agent] Maintenance cycle error: %s", exc)

        await asyncio.sleep(_interval_seconds)


async def _maintenance_cycle() -> None:
    """Single maintenance cycle."""
    from app.service.satellite.registry import get_satellite_registry

    registry = get_satellite_registry()
    if not registry:
        return

    satellites = registry.get_all()
    if not satellites:
        return

    now = time.time()
    stale_threshold = 86400  # 24 hours

    online_count = 0
    offline_count = 0
    breaker_count = 0

    for sat in satellites:
        sat_id = sat["id"]

        # Check cooldown expiration
        if sat["status"] == "cooldown":
            registry.check_cooldown_expired(sat_id)

        # Detect stale satellites
        last_seen = sat.get("last_seen", 0)
        if last_seen > 0 and (now - last_seen) > stale_threshold:
            if sat["status"] not in ("stale", "circuit_breaker"):
                registry.update_satellite(sat_id, {"status": "stale"})
                logger.info("[satellite_agent] %s marked stale (last seen %.0f hours ago)",
                            sat["name"], (now - last_seen) / 3600)

        # Count statuses
        status = sat["status"]
        if status in ("online", "warm", "cooldown"):
            online_count += 1
        elif status in ("offline", "stale"):
            offline_count += 1
        elif status == "circuit_breaker":
            breaker_count += 1

    # Emit fleet summary periodically
    try:
        from app.controller.chat_controller import _emit
        await _emit("satellite_fleet", {
            "total": len(satellites),
            "online": online_count,
            "offline": offline_count,
            "circuit_breaker": breaker_count,
            "timestamp": now,
        })
    except Exception:
        pass

    logger.debug(
        "[satellite_agent] Fleet: %d total, %d online, %d offline, %d breaker",
        len(satellites), online_count, offline_count, breaker_count,
    )
