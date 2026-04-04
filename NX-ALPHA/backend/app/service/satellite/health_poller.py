"""
AURA NX-Alpha — Satellite Health Poller
Background service that polls all registered satellites every 30 seconds.
Fetches /health and /status from each satellite agent, updates the registry,
runs governor checks, and emits SSE alerts on state changes.

SINGLETON PATTERN:
    Call init_health_poller() at startup.
    Use get_health_poller() to access the instance.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, Coroutine, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# HTTP CLIENT (lazy import)
# ─────────────────────────────────────────────────────────────────────────────

try:
    import httpx
    _HTTPX_AVAILABLE = True
except ImportError:
    httpx = None  # type: ignore[assignment]
    _HTTPX_AVAILABLE = False
    logger.warning("[health_poller] httpx not installed — satellite polling will use urllib fallback")


async def _fetch_json(url: str, timeout: float = 5.0) -> dict | None:
    """Fetch JSON from a URL. Returns None on any failure."""
    if _HTTPX_AVAILABLE:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    return resp.json()
        except Exception as exc:
            logger.debug("[health_poller] Fetch failed %s: %s", url, exc)
            return None
    else:
        # Fallback to urllib in executor
        import urllib.request
        import json
        try:
            loop = asyncio.get_running_loop()
            def _sync_fetch():
                req = urllib.request.Request(url)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return json.loads(resp.read())
            return await loop.run_in_executor(None, _sync_fetch)
        except Exception as exc:
            logger.debug("[health_poller] urllib fetch failed %s: %s", url, exc)
            return None


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: Optional["HealthPoller"] = None


def init_health_poller(
    emit_fn: Callable[[str, dict], Coroutine] | None = None,
) -> "HealthPoller":
    global _instance
    _instance = HealthPoller(emit_fn=emit_fn)
    return _instance


def get_health_poller() -> Optional["HealthPoller"]:
    return _instance


# ─────────────────────────────────────────────────────────────────────────────
# HEALTH POLLER
# ─────────────────────────────────────────────────────────────────────────────

class HealthPoller:
    """Polls all registered satellites on a fixed interval."""

    def __init__(
        self,
        interval_s: float = 30.0,
        emit_fn: Callable[[str, dict], Coroutine] | None = None,
    ):
        self._interval = interval_s
        self._emit = emit_fn
        self._task: asyncio.Task | None = None
        self._running = False
        # Track previous states for change detection
        self._prev_states: dict[str, str] = {}
        logger.info("[health_poller] Initialized (interval=%ds)", interval_s)

    async def _emit_event(self, event_type: str, data: dict) -> None:
        """Emit an SSE event if the emit function is available."""
        if self._emit:
            try:
                await self._emit(event_type, data)
            except Exception as exc:
                logger.debug("[health_poller] SSE emit failed: %s", exc)

    def start(self) -> asyncio.Task:
        """Start the polling loop as a background task."""
        if self._task and not self._task.done():
            logger.warning("[health_poller] Already running")
            return self._task
        self._running = True
        self._task = asyncio.create_task(self._poll_loop(), name="satellite_health_poller")
        logger.info("[health_poller] Polling started")
        return self._task

    def stop(self) -> None:
        """Stop the polling loop."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
        logger.info("[health_poller] Polling stopped")

    async def _poll_loop(self) -> None:
        """Main polling loop."""
        while self._running:
            try:
                await self._poll_all()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("[health_poller] Poll cycle error: %s", exc)
            await asyncio.sleep(self._interval)

    async def _poll_all(self) -> None:
        """Poll all registered satellites concurrently."""
        from app.service.satellite.registry import get_satellite_registry
        from app.service.satellite.governor import get_hardware_governor

        registry = get_satellite_registry()
        governor = get_hardware_governor()
        if not registry:
            return

        satellites = registry.get_all()
        if not satellites:
            return

        # Concurrent polling
        tasks = [self._poll_single(sat, registry, governor) for sat in satellites]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _poll_single(
        self,
        sat: dict[str, Any],
        registry: Any,
        governor: Any,
    ) -> None:
        """Poll a single satellite."""
        sat_id = sat["id"]
        host = sat["host"]
        port = sat["port"]
        base_url = f"http://{host}:{port}"

        # Check if cooldown has expired
        if sat["status"] == "cooldown":
            registry.check_cooldown_expired(sat_id)

        # Skip polling if circuit breaker is tripped (but keep it in the map)
        if sat.get("circuit_breaker_tripped"):
            return

        # Fetch health
        health = await _fetch_json(f"{base_url}/health")
        if health is None:
            # Satellite unreachable
            old_status = sat["status"]
            if old_status not in ("offline", "circuit_breaker", "cooldown"):
                registry.update_satellite(sat_id, {"status": "offline"})
                if old_status != "offline":
                    await self._emit_event("satellite_status", {
                        "satellite_id": sat_id,
                        "name": sat["name"],
                        "status": "offline",
                        "previous": old_status,
                        "message": f"{sat['name']} is unreachable",
                    })
                    logger.warning("[health_poller] %s (%s) is offline", sat["name"], host)
            return

        # Satellite is alive — update last_seen
        registry.update_last_seen(sat_id, "online")

        # Fetch detailed metrics
        metrics = await _fetch_json(f"{base_url}/status")
        if metrics is None:
            metrics = health  # fallback to health data

        # Run governor check
        if governor:
            from app.service.satellite.governor import GovernorAction
            result = governor.check_health(metrics, satellite_id=sat_id)

            # Update status based on governor
            new_status = "online"
            if result.action == GovernorAction.CIRCUIT_BREAK:
                registry.trip_circuit_breaker(sat_id, result.circuit_break_reason)
                new_status = "circuit_breaker"
                await self._emit_event("hardware_alert", {
                    "satellite_id": sat_id,
                    "name": sat["name"],
                    "action": "circuit_break",
                    "reason": result.circuit_break_reason,
                    "metrics": result.to_dict(),
                })
                logger.warning("[health_poller] CIRCUIT BREAKER: %s — %s",
                               sat["name"], result.circuit_break_reason)
            elif result.action == GovernorAction.PAUSE_NEW:
                new_status = "throttled"
            elif result.action == GovernorAction.REDUCE_QUEUE:
                new_status = "warm"

            # Detect state change and emit event
            prev_status = self._prev_states.get(sat_id, "unknown")
            if new_status != prev_status and new_status != "circuit_breaker":
                registry.update_satellite(sat_id, {"status": new_status})
                if prev_status != "unknown":
                    await self._emit_event("satellite_status", {
                        "satellite_id": sat_id,
                        "name": sat["name"],
                        "status": new_status,
                        "previous": prev_status,
                        "governor": result.to_dict(),
                    })
            self._prev_states[sat_id] = new_status

    async def poll_now(self) -> list[dict]:
        """Force an immediate poll cycle. Returns current satellite states."""
        await self._poll_all()
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        return registry.get_all() if registry else []
