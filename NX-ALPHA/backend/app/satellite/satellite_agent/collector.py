"""
AURA Satellite Agent — Autonomous Collector (Phase 2)

Background thread that continuously fetches data from a configured source
and POSTs it to AURA main's /memory/ingest endpoint.

Design rules:
    - Runs on CPU by default (use_gpu=False). GPU path requires explicit enable.
    - Minimum ingestion interval: 10 seconds (enforced hard).
    - Pauses when governor blocks (GPU temp Warm+). Resumes when Nominal.
    - Stops on circuit breaker fire. Does NOT auto-restart.
    - Uses threading.Thread (not asyncio) — does not block FastAPI event loop.
    - Uses requests (synchronous) inside the thread.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

logger = logging.getLogger(__name__)

MIN_INGEST_INTERVAL = 10  # Absolute minimum between collection cycles (seconds)

# Module-level collector instance (one per satellite agent process)
_collector: "AutonomousCollector | None" = None


def get_collector() -> "AutonomousCollector | None":
    return _collector


def init_collector(aura_main_host: str, aura_main_port: int, sat_token: str, sat_id: str) -> "AutonomousCollector":
    global _collector
    _collector = AutonomousCollector(aura_main_host, aura_main_port, sat_token, sat_id)
    return _collector


class AutonomousCollector:
    def __init__(self, aura_main_host: str, aura_main_port: int, sat_token: str, sat_id: str):
        self._host      = aura_main_host
        self._port      = aura_main_port
        self._token     = sat_token
        self._sat_id    = sat_id
        self._running   = False
        self._thread: threading.Thread | None = None
        self._lock      = threading.Lock()

        # Configuration (set via configure())
        self._data_source: str  = ""
        self._ingest_rate_s: int = 60
        self._use_gpu: bool     = False  # CPU-only by default

        # State tracking
        self._last_ingest: float = 0.0
        self._pushed_count: int  = 0
        self._last_error: str    = ""
        self._paused: bool       = False  # True when governor is blocking

    def configure(self, data_source: str, ingest_rate_s: int, use_gpu: bool = False) -> None:
        with self._lock:
            self._data_source    = data_source
            self._ingest_rate_s  = max(ingest_rate_s, MIN_INGEST_INTERVAL)
            self._use_gpu        = use_gpu
        logger.info(
            "[collector] Configured: source=%s rate=%ds gpu=%s",
            data_source, self._ingest_rate_s, use_gpu,
        )

    def start(self) -> bool:
        with self._lock:
            if self._running:
                return False
            if not self._data_source:
                logger.warning("[collector] Cannot start — no data_source configured")
                return False
            self._running = True
            self._thread = threading.Thread(target=self._run_loop, daemon=True, name="AURACollector")
            self._thread.start()
        logger.info("[collector] Started collection loop (source: %s)", self._data_source)
        return True

    def stop(self) -> None:
        with self._lock:
            self._running = False
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=15)
        logger.info("[collector] Stopped")

    def get_status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "paused": self._paused,
            "data_source": self._data_source,
            "ingest_rate_s": self._ingest_rate_s,
            "use_gpu": self._use_gpu,
            "last_ingest": self._last_ingest,
            "pushed_count": self._pushed_count,
            "last_error": self._last_error,
        }

    # ─────────────────────────────────────────────────────────────────────────
    # COLLECTION LOOP (runs in thread)
    # ─────────────────────────────────────────────────────────────────────────

    def _run_loop(self) -> None:
        import requests

        try:
            import feedparser
            _HAS_FEEDPARSER = True
        except ImportError:
            _HAS_FEEDPARSER = False
            logger.warning("[collector] feedparser not installed — RSS ingestion unavailable")

        from . import governor
        from .health import get_health_metrics

        while self._running:
            # ── Governor check ─────────────────────────────────────────────
            try:
                metrics = get_health_metrics()
                allowed, reason = governor.check_and_enforce(metrics)
                if not allowed:
                    if not self._paused:
                        logger.info("[collector] Paused by governor: %s", reason)
                    self._paused = True
                    # Collectors are first to be suspended — check circuit breaker
                    if governor._circuit_breaker:
                        logger.warning("[collector] Circuit breaker active — stopping collector")
                        self._running = False
                        break
                    time.sleep(30)
                    continue
                self._paused = False
            except Exception as exc:
                logger.warning("[collector] Governor check failed: %s", exc)

            # ── Fetch data ────────────────────────────────────────────────
            payload: dict[str, Any] | None = None
            try:
                src = self._data_source
                is_feed = (
                    src.endswith((".rss", ".xml", ".atom"))
                    or "rss" in src.lower()
                    or "feed" in src.lower()
                    or "atom" in src.lower()
                )

                if is_feed and _HAS_FEEDPARSER:
                    feed = feedparser.parse(src)
                    entries = [
                        {
                            "title": getattr(e, "title", ""),
                            "summary": getattr(e, "summary", ""),
                            "link": getattr(e, "link", ""),
                            "published": getattr(e, "published", ""),
                        }
                        for e in (feed.entries or [])[:20]
                    ]
                    payload = {
                        "type": "rss",
                        "source": src,
                        "entries": entries,
                    }
                else:
                    resp = requests.get(src, timeout=30, headers={"User-Agent": "AURA-Collector/1.0"})
                    resp.raise_for_status()
                    payload = {
                        "type": "http",
                        "source": src,
                        "content": resp.text[:50000],  # Cap at 50KB
                        "status_code": resp.status_code,
                    }
            except Exception as exc:
                self._last_error = str(exc)
                logger.warning("[collector] Fetch failed from %s: %s", self._data_source, exc)
                time.sleep(max(self._ingest_rate_s, MIN_INGEST_INTERVAL))
                continue

            # ── POST to AURA main ─────────────────────────────────────────
            if payload:
                try:
                    ingest_url = f"http://{self._host}:{self._port}/satellites/memory/ingest"
                    response = requests.post(
                        ingest_url,
                        json={"satellite_id": self._sat_id, "payload": payload},
                        headers={"Authorization": f"Bearer {self._token}"},
                        timeout=30,
                    )
                    if response.status_code == 200:
                        self._last_ingest = time.time()
                        self._pushed_count += 1
                        self._last_error = ""
                        logger.debug("[collector] Ingested %s (total: %d)", payload["type"], self._pushed_count)
                    else:
                        self._last_error = f"Ingest HTTP {response.status_code}"
                        logger.warning("[collector] Ingest failed: HTTP %d", response.status_code)
                except Exception as exc:
                    self._last_error = str(exc)
                    logger.warning("[collector] Ingest POST failed: %s", exc)

            # ── Sleep ─────────────────────────────────────────────────────
            time.sleep(max(self._ingest_rate_s, MIN_INGEST_INTERVAL))
