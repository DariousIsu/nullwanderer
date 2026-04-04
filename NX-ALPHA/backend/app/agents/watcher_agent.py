"""
AURA NX-Alpha — Watcher Agent (Archivist)
Specialized data archivization agent for satellite deployment.

ROLE:
    The Watcher Agent is a dedicated satellite agent assigned to continuous
    data ingestion and archivization from external connectors. It operates
    independently on a satellite system and feeds processed data into the
    main system's memory layers.

SCOPE:
    Single-purpose agent: Data archivization and ingestion
    - Monitors external data sources continuously
    - Ingests from: Finance, News, Weather, Google Calendar/Gmail
    - Converts external data to structured memory markers
    - Records all data with rich metadata for retrieval
    - Emits events to main system for visibility

DEPLOYMENT:
    - Run on dedicated satellite system
    - Long-lived task (weeks/months of continuous operation)
    - Configured with specific collector intervals per data source
    - Gracefully handles API failures and rate limits
    - Auto-recovers from transient errors

ARCHITECTURE:
    Supervisor (main AURA system)
      └─ Satellite 1 (Watcher Agent instance)
         ├─ Finance Collector (60-min interval)
         ├─ News Collector (30-min interval)
         ├─ Weather Collector (60-min interval)
         ├─ Calendar Collector (120-min interval)
         └─ Gmail Collector (120-min interval)
            All → Memory Layers (L1/L2/L3)

INITIALIZATION REQUIREMENTS:
    - Initialized with supervisor connection info
    - Memory service access (to record archival data)
    - All connector services available
    - SSE/gRPC channel to main system for events
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional, Callable

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM PROMPT FOR WATCHER AGENT
# ─────────────────────────────────────────────────────────────────────────────

WATCHER_SYSTEM_PROMPT = """
You are the AURA Watcher Agent — an autonomous archivist dedicated to
continuous data ingestion and deep archival preservation.

YOUR PURPOSE:
    Preserve the user's digital context by systematically archiving external
    data sources (markets, news, weather, communications) into persistent
    memory structures. Every piece of ingested data enriches the system's
    understanding of the world in the user's absence.

YOUR MINDSET:
    - Obsessive about completeness: never miss data that could be relevant
    - Meticulous about metadata: every data point tagged with source, timestamp, confidence
    - Contextual archivization: data stored not just for facts, but for patterns and trends
    - Proactive pattern detection: flag anomalies, shifts, correlations
    - Graceful degradation: continue archiving even when some sources fail

YOUR RESPONSIBILITIES:
    1. CONTINUOUS INGESTION
       Monitor all enabled data sources on fixed schedules:
       - Finance: stocks, crypto, indices (every 60 min)
       - News: global headlines from RSS (every 30 min)
       - Weather: conditions and forecasts (every 60 min)
       - Calendar: upcoming events and commitments (every 120 min)
       - Gmail: inbox summary and important messages (every 120 min)

    2. DATA TRANSFORMATION
       Convert raw external data into structured archival format:
       - Extract core facts and metrics
       - Tag with source, collection time, confidence level
       - Identify relationships and cross-references
       - Flag anomalies or significant changes
       - Create searchable summaries

    3. MEMORY RECORDING
       Store all data in three-layer memory system:
       - L1 (SQLite): Raw data snapshots for exact recall
       - L2 (ChromaDB): Semantic embeddings for intuitive retrieval
       - L3 (FalkorDB): Relationships, trends, knowledge graph

    4. ERROR HANDLING
       When data sources fail:
       - Log the failure with full context
       - Attempt graceful retry after backoff
       - Continue with available sources
       - Emit alerts to supervisor
       - Never crash or stop the archival process

    5. PATTERN DETECTION
       Beyond raw ingestion, identify:
       - Trend reversals (market down 5%+, weather warming)
       - Anomalies (unusual news surge, calendar conflicts)
       - Correlations (news spike correlates with market move)
       - Gaps (expected data not arrived)
       - Completeness (all sources reporting vs partial)

YOUR OPERATIONAL CONSTRAINTS:
    - Non-interactive: no user feedback loop
    - Background operation: must not consume system resources
    - Long-lived: designed for weeks/months continuous operation
    - Network-resilient: handle intermittent connectivity
    - Rate-limit aware: respect API quotas and backoff
    - Memory-efficient: archive but don't bloat memory

YOUR CORE METRICS:
    - Ingestion uptime: % of time sources are live
    - Data completeness: % of expected data points captured
    - Archival latency: seconds from source to memory
    - Error recovery rate: % of transient failures recovered
    - Pattern detections: # of anomalies/trends identified

Remember: You are the silent archivist of context. Your work is invisible
to the user, but critical to the system's ability to understand their world
across sessions, absences, and time.
"""


# ─────────────────────────────────────────────────────────────────────────────
# WATCHER AGENT CLASS
# ─────────────────────────────────────────────────────────────────────────────

class WatcherAgent:
    """
    Specialized satellite agent for continuous data archivization.

    Designed to run on a dedicated satellite instance and continuously
    ingest external data into the main system's memory layers.
    """

    def __init__(
        self,
        supervisor_emit_fn: Optional[Callable] = None,
        check_interval_s: int = 300,
    ):
        """
        Initialize the Watcher Agent.

        Args:
            supervisor_emit_fn: Async callback to emit events to supervisor
                               (e.g., {event: "archival_update", data: {...}})
            check_interval_s: How often to check if collections are due
        """
        self.supervisor_emit = supervisor_emit_fn or self._default_emit
        self.check_interval_s = check_interval_s
        self.running = False
        self._last_run_times: dict[str, float] = {}

        logger.info(
            "[watcher_agent] Initialized (check interval: %ds, "
            "system prompt: %d bytes)",
            check_interval_s,
            len(WATCHER_SYSTEM_PROMPT),
        )

    async def _default_emit(self, event_type: str, data: dict) -> None:
        """Fallback emit function (no-op if supervisor not connected)."""
        logger.debug("[watcher_agent] Event (no supervisor): %s", event_type)

    async def run(self) -> None:
        """
        Main loop: continuously archive data on schedule.
        Designed to run for weeks/months without restart.
        """
        self.running = True
        logger.info("[watcher_agent] Starting continuous archival loop")

        try:
            while self.running:
                try:
                    await self._archival_cycle()
                except Exception as exc:
                    logger.error("[watcher_agent] Cycle failed: %s", exc)
                    await self.supervisor_emit("archival_error", {"error": str(exc)})

                await asyncio.sleep(self.check_interval_s)
        except asyncio.CancelledError:
            logger.info("[watcher_agent] Archival loop cancelled")
            self.running = False
            raise

    async def _archival_cycle(self) -> None:
        """Single archival cycle: check each collector against its schedule."""
        now = time.time()

        # Finance — every 60 minutes
        if self._should_run("finance", interval_s=3600, now=now):
            await self._archive_finance()

        # News — every 30 minutes
        if self._should_run("news", interval_s=1800, now=now):
            await self._archive_news()

        # Weather — every 60 minutes
        if self._should_run("weather", interval_s=3600, now=now):
            await self._archive_weather()

        # Google Calendar — every 120 minutes
        if self._should_run("calendar", interval_s=7200, now=now):
            await self._archive_calendar()

        # Google Gmail — every 120 minutes
        if self._should_run("gmail", interval_s=7200, now=now):
            await self._archive_gmail()

    def _should_run(self, source_name: str, interval_s: int, now: float) -> bool:
        """Check if enough time has passed to run this source."""
        last_run = self._last_run_times.get(source_name, 0)
        if (now - last_run) >= interval_s:
            self._last_run_times[source_name] = now
            return True
        return False

    # ─────────────────────────────────────────────────────────────────────────
    # COLLECTION METHODS — One per data source
    # ─────────────────────────────────────────────────────────────────────────

    async def _archive_finance(self) -> None:
        """Archive financial market data."""
        try:
            from app.service.finance_service import get_finance_service
            svc = get_finance_service()
            overview = await svc.get_market_overview()

            if overview and overview.get("indices"):
                await self._record_archival(
                    source="finance",
                    data=overview,
                    summary=f"Market snapshot: {len(overview.get('indices', []))} indices, "
                           f"{len(overview.get('crypto', []))} cryptos",
                )
                await self.supervisor_emit("archival_update", {
                    "source": "finance",
                    "status": "archived",
                    "items": len(overview.get("indices", [])) + len(overview.get("crypto", [])),
                })
        except Exception as exc:
            logger.warning("[watcher_agent] Finance archival failed: %s", exc)
            await self.supervisor_emit("archival_error", {
                "source": "finance",
                "error": str(exc),
            })

    async def _archive_news(self) -> None:
        """Archive news from RSS feeds."""
        try:
            from app.service.news_service import get_news_service
            svc = get_news_service()
            if svc is None:
                return

            articles = await svc.fetch_all(limit_per_feed=15)
            if articles:
                await self._record_archival(
                    source="news",
                    data={"articles": articles},
                    summary=f"News archive: {len(articles)} articles from multiple sources",
                )
                await self.supervisor_emit("archival_update", {
                    "source": "news",
                    "status": "archived",
                    "items": len(articles),
                })
        except Exception as exc:
            logger.warning("[watcher_agent] News archival failed: %s", exc)
            await self.supervisor_emit("archival_error", {
                "source": "news",
                "error": str(exc),
            })

    async def _archive_weather(self) -> None:
        """Archive weather conditions and forecast."""
        try:
            from app.service.weather_service import get_weather_service
            svc = get_weather_service()
            if svc is None:
                return

            current = await svc.get_current()
            forecast = await svc.get_forecast(days=7)

            if current:
                await self._record_archival(
                    source="weather",
                    data={"current": current, "forecast": forecast},
                    summary=f"Weather archive: {current.get('weather_text', '?')}, "
                           f"{current.get('temperature_2m', '?')}°C, "
                           f"{len(forecast)} day forecast",
                )
                await self.supervisor_emit("archival_update", {
                    "source": "weather",
                    "status": "archived",
                    "items": 1 + len(forecast),
                })
        except Exception as exc:
            logger.warning("[watcher_agent] Weather archival failed: %s", exc)
            await self.supervisor_emit("archival_error", {
                "source": "weather",
                "error": str(exc),
            })

    async def _archive_calendar(self) -> None:
        """Archive Google Calendar events."""
        try:
            from app.service.google_service import get_google_service
            svc = get_google_service()

            if not await svc.is_authenticated():
                logger.debug("[watcher_agent] Calendar not authenticated — skipping")
                return

            events = await svc.get_calendar_events(days_ahead=30)
            if events:
                await self._record_archival(
                    source="calendar",
                    data={"events": events},
                    summary=f"Calendar archive: {len(events)} upcoming events",
                )
                await self.supervisor_emit("archival_update", {
                    "source": "calendar",
                    "status": "archived",
                    "items": len(events),
                })
        except Exception as exc:
            logger.debug("[watcher_agent] Calendar archival skipped: %s", exc)
            await self.supervisor_emit("archival_error", {
                "source": "calendar",
                "error": str(exc),
            })

    async def _archive_gmail(self) -> None:
        """Archive Gmail inbox summary."""
        try:
            from app.service.google_service import get_google_service
            svc = get_google_service()

            if not await svc.is_authenticated():
                logger.debug("[watcher_agent] Gmail not authenticated — skipping")
                return

            messages = await svc.get_inbox(max_results=30)
            if messages:
                unread = sum(1 for m in messages if m.get("unread"))
                await self._record_archival(
                    source="gmail",
                    data={"messages": messages, "unread_count": unread},
                    summary=f"Gmail archive: {len(messages)} messages ({unread} unread)",
                )
                await self.supervisor_emit("archival_update", {
                    "source": "gmail",
                    "status": "archived",
                    "items": len(messages),
                    "unread": unread,
                })
        except Exception as exc:
            logger.debug("[watcher_agent] Gmail archival skipped: %s", exc)
            await self.supervisor_emit("archival_error", {
                "source": "gmail",
                "error": str(exc),
            })

    # ─────────────────────────────────────────────────────────────────────────
    # MEMORY RECORDING
    # ─────────────────────────────────────────────────────────────────────────

    async def _record_archival(
        self,
        source: str,
        data: dict,
        summary: str,
    ) -> None:
        """
        Record archived data to memory layers.

        Args:
            source: Data source name (finance, news, weather, calendar, gmail)
            data: Raw data to archive
            summary: Human-readable summary of archived data
        """
        try:
            from app.service.memory_service import get_memory_service
            mem_svc = get_memory_service()
            if mem_svc is None:
                return

            timestamp = datetime.now(timezone.utc).isoformat()

            # Record to memory with rich metadata
            await mem_svc.record(
                role="watcher",
                content=json.dumps({
                    "connector": source,
                    "timestamp": timestamp,
                    "data": data,
                    "summary": summary,
                }),
                thread_id="system:watcher",
                metadata={
                    "source": source,
                    "type": "archival",
                    "timestamp": timestamp,
                    "summary": summary,
                }
            )

            logger.debug("[watcher_agent] Recorded archival: %s", summary)

        except Exception as exc:
            logger.warning("[watcher_agent] Failed to record archival: %s", exc)

    def stop(self) -> None:
        """Signal the agent to stop archival operations."""
        self.running = False
        logger.info("[watcher_agent] Stop requested")


# ─────────────────────────────────────────────────────────────────────────────
# FACTORY & LIFECYCLE
# ─────────────────────────────────────────────────────────────────────────────

def create_watcher_agent(
    supervisor_emit_fn: Optional[Callable] = None,
    check_interval_s: int = 300,
) -> WatcherAgent:
    """
    Create a new Watcher Agent instance.

    Typically called by satellite supervisor when instantiating this agent.

    Args:
        supervisor_emit_fn: Callback for emitting events to main system
        check_interval_s: How often to check archival schedules

    Returns:
        WatcherAgent instance ready to run()
    """
    return WatcherAgent(supervisor_emit_fn, check_interval_s)


async def run_watcher_agent(
    supervisor_emit_fn: Optional[Callable] = None,
    check_interval_s: int = 300,
) -> None:
    """
    Create and run a Watcher Agent to completion.

    Usage:
        task = asyncio.create_task(
            run_watcher_agent(supervisor_emit_fn=my_emit_fn)
        )
    """
    agent = create_watcher_agent(supervisor_emit_fn, check_interval_s)
    await agent.run()
