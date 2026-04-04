"""
AURA NX-Alpha — Briefing Service

Generates morning briefings and daily recaps by orchestrating data collection
through the Interface Engine and dispatching synthesis to the Workhorse team.

BRIEFING TYPES:
    morning_briefing — 7:00 AM daily: overnight news, market outlook, weather, calendar
    daily_recap      — 6:00 PM weekdays: retrospective, what happened vs expectations
    on_demand        — user says "give me a briefing" → interface agent triggers directly

ARCHITECTURE:
    The Interface Engine gathers context and formulates the briefing task.
    The Workhorse team (via TeamDispatcher) synthesizes the structured briefing.
    Results route through the proactive delivery system.

SINGLETON:
    init_briefing_service()   — create instance
    get_briefing_service()    — get instance
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# BRIEFING PROMPTS
# ─────────────────────────────────────────────────────────────────────────────

_MORNING_BRIEFING_PROMPT = """\
You are AURA, preparing a morning briefing for your user. Using the context below,
formulate a comprehensive morning briefing task for the analysis team.

The briefing should cover:
1. Overnight market movements and pre-market outlook
2. Top news stories from overnight (prioritize policy, economics, tech, geopolitics)
3. Weather forecast for today
4. Calendar events for today (if available)
5. Key insights or connections from overnight data

Context:
{context}

Digest items (overnight accumulation):
{digest}

Write the briefing task as a direct instruction to the analysis team.
Be specific about what to synthesize and how to structure the output."""

_DAILY_RECAP_PROMPT = """\
You are AURA, preparing an end-of-day recap for your user. Using the context below,
formulate a daily recap task for the analysis team.

The recap should cover:
1. Market close summary and notable movements
2. Key news stories of the day
3. Any significant developments since the morning briefing
4. Insights or patterns observed across the day's data
5. Preview of what to watch tomorrow

Context:
{context}

Digest items (day's accumulation):
{digest}

Today's insights:
{insights}

Write the recap task as a direct instruction to the analysis team."""


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: "BriefingService | None" = None


def init_briefing_service() -> "BriefingService":
    global _instance
    _instance = BriefingService()
    return _instance


def get_briefing_service() -> "BriefingService | None":
    return _instance


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class BriefingService:
    """
    Orchestrates morning briefings and daily recaps.
    """

    def __init__(self) -> None:
        self._last_morning_briefing: float = 0.0
        self._last_daily_recap: float = 0.0
        self._briefing_count: int = 0
        logger.info("[briefing] BriefingService created")

    # ── Scheduler entry points ────────────────────────────────────────────────

    async def trigger_morning_briefing(self, _params: dict | None = None) -> str:
        """Called by SchedulerService when morning_briefing cron fires."""
        logger.info("[briefing] Morning briefing triggered")
        try:
            task_text = await self._build_morning_task()
            if task_text:
                await self._dispatch_briefing(task_text, "morning_briefing")
                self._last_morning_briefing = time.time()
                self._briefing_count += 1
                return "dispatched"
            return "skipped — no content"
        except Exception as exc:
            logger.error("[briefing] Morning briefing failed: %s", exc)
            return f"error: {exc}"

    async def trigger_daily_recap(self, _params: dict | None = None) -> str:
        """Called by SchedulerService when daily_recap cron fires."""
        logger.info("[briefing] Daily recap triggered")
        try:
            task_text = await self._build_recap_task()
            if task_text:
                await self._dispatch_briefing(task_text, "daily_recap")
                self._last_daily_recap = time.time()
                self._briefing_count += 1
                return "dispatched"
            return "skipped — no content"
        except Exception as exc:
            logger.error("[briefing] Daily recap failed: %s", exc)
            return f"error: {exc}"

    # ── Task construction ─────────────────────────────────────────────────────

    async def _build_morning_task(self) -> str | None:
        """Gather context and have Interface Engine formulate the morning briefing task."""
        from app.service.interface_engine import get_engine
        engine = get_engine()
        if engine is None:
            return None

        # Gather context
        context_parts = []

        # World state from triage
        try:
            from app.service.idle_triage_service import get_world_state
            ws = get_world_state()
            if ws:
                for key in ("market", "news", "weather", "economic"):
                    val = ws.get(key, "")
                    if val and val != "No recent updates.":
                        context_parts.append(f"{key.title()}: {val}")
        except Exception:
            pass

        # Weather
        try:
            from app.service.weather_service import get_weather_service
            ws = get_weather_service()
            if ws:
                forecast = await ws.get_forecast()
                if forecast:
                    context_parts.append(f"Weather: {forecast}")
        except Exception:
            pass

        # Calendar
        try:
            from app.service.google_service import get_google_service
            gs = get_google_service()
            if gs and gs.calendar_available:
                events = await gs.get_todays_events()
                if events:
                    evt_text = "; ".join(f"{e['summary']} at {e.get('start', '?')}" for e in events[:5])
                    context_parts.append(f"Today's calendar: {evt_text}")
        except Exception:
            pass

        # Digest buffer
        digest_text = ""
        try:
            from app.service.idle_triage_service import get_idle_triage
            triage = get_idle_triage()
            if triage:
                items = triage.get_digest_buffer()
                if items:
                    digest_lines = [
                        f"- [{i.get('significance', '?')}] {i.get('summary', '')}"
                        for i in items[-20:]
                    ]
                    digest_text = "\n".join(digest_lines)
                    triage.clear_digest_buffer()
        except Exception:
            pass

        if not context_parts and not digest_text:
            return None

        context = "\n".join(context_parts) if context_parts else "No live context available."
        digest_text = digest_text or "No overnight digest items."

        # Ask Interface Engine to formulate the task
        try:
            result = await engine.generate(
                [{"role": "user", "content": _MORNING_BRIEFING_PROMPT.format(
                    context=context, digest=digest_text
                )}],
                max_tokens=512,
                temperature=0.4,
            )
            return result.get("text", "").strip() or None
        except Exception as exc:
            logger.warning("[briefing] Morning task formulation failed: %s", exc)
            return None

    async def _build_recap_task(self) -> str | None:
        """Gather context and have Interface Engine formulate the daily recap task."""
        from app.service.interface_engine import get_engine
        engine = get_engine()
        if engine is None:
            return None

        context_parts = []

        # World state
        try:
            from app.service.idle_triage_service import get_world_state
            ws = get_world_state()
            if ws:
                for key in ("market", "news", "economic"):
                    val = ws.get(key, "")
                    if val and val != "No recent updates.":
                        context_parts.append(f"{key.title()}: {val}")
        except Exception:
            pass

        # Digest buffer
        digest_text = ""
        try:
            from app.service.idle_triage_service import get_idle_triage
            triage = get_idle_triage()
            if triage:
                items = triage.get_digest_buffer()
                if items:
                    digest_lines = [
                        f"- [{i.get('significance', '?')}] {i.get('summary', '')}"
                        for i in items[-30:]
                    ]
                    digest_text = "\n".join(digest_lines)
                    triage.clear_digest_buffer()
        except Exception:
            pass

        # Today's insights from memory
        insights_text = ""
        try:
            from app.service.memory_service import get_memory_service
            mem = get_memory_service()
            if mem:
                results = await mem.search(
                    "idle analysis insight today",
                    role="system",
                    max_results=5,
                )
                if results:
                    insights_text = "\n".join(f"- {r.get('content', '')[:200]}" for r in results)
        except Exception:
            pass

        if not context_parts and not digest_text:
            return None

        context = "\n".join(context_parts) if context_parts else "No context available."

        try:
            result = await engine.generate(
                [{"role": "user", "content": _DAILY_RECAP_PROMPT.format(
                    context=context,
                    digest=digest_text or "No digest items.",
                    insights=insights_text or "No insights today.",
                )}],
                max_tokens=512,
                temperature=0.4,
            )
            return result.get("text", "").strip() or None
        except Exception as exc:
            logger.warning("[briefing] Recap task formulation failed: %s", exc)
            return None

    # ── Dispatch ──────────────────────────────────────────────────────────────

    async def _dispatch_briefing(self, task_text: str, task_type: str) -> None:
        """Dispatch a briefing task to the team pipeline."""
        try:
            from app.service.team_dispatcher import get_team_dispatcher
            dispatcher = get_team_dispatcher()
            team_id = f"briefing-{uuid.uuid4().hex[:8]}"

            queue_pos = await dispatcher.dispatch(
                task_text,
                thread_id="idle_processing",
                team_id=team_id,
                metadata={
                    "autonomous": True,
                    "task_type": task_type,
                },
            )

            logger.info(
                "[briefing] Dispatched %s task %s (queue_pos=%d)",
                task_type, team_id, queue_pos,
            )

            # Emit SSE so frontend knows
            try:
                from app.controller.chat_controller import _emit
                await _emit("team_dispatched", {
                    "plan": {
                        "agents": [],
                        "task": f"Generating {task_type.replace('_', ' ')}...",
                        "teamId": team_id,
                        "autonomous": True,
                    }
                })
            except Exception:
                pass

        except Exception as exc:
            logger.error("[briefing] Dispatch failed for %s: %s", task_type, exc)

    # ── Status ────────────────────────────────────────────────────────────────

    def status(self) -> dict:
        return {
            "briefing_count": self._briefing_count,
            "last_morning": self._last_morning_briefing,
            "last_recap": self._last_daily_recap,
        }
