"""
AURA NX-Alpha — Idle Triage Service

When the user is idle, the Interface Engine becomes the system's attention manager:
  1. Drains incoming data streams (market, news, weather, economic, legal)
  2. Classifies each event by significance, relevance, and cross-source potential
  3. Maintains a rolling "world state" summary across all categories
  4. Fires news breaks for urgent/breaking events
  5. Autonomously dispatches the Workhorse team for deep analysis

The Interface Engine never calls the Workhorse directly — it formulates
natural-language analysis tasks and dispatches them through the existing
TeamDispatcher, preserving the full PM → Area → Sprint → Assemble pipeline.

IDLE STATES (from screen_awareness_service):
    active      — user interacting, triage sleeps
    soft_idle   — 3 min idle, triage begins
    deep_idle   — 10 min idle, team dispatch eligible
    away        — 30 min idle, reduced frequency

SINGLETON:
    init_idle_triage()   — create and start
    get_idle_triage()    — get instance
    get_world_state()    — current world state summary (for prompt injection)
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# TRIAGE CLASSIFICATION SCHEMA (for Interface Engine JSON-constrained output)
# ─────────────────────────────────────────────────────────────────────────────

_TRIAGE_SCHEMA = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index":            {"type": "integer"},
                    "significance":     {"type": "string", "enum": ["routine", "notable", "urgent", "breaking"]},
                    "relevance":        {"type": "number", "minimum": 0.0, "maximum": 1.0},
                    "summary":          {"type": "string"},
                    "cross_ref_streams": {"type": "array", "items": {"type": "string"}},
                    "action":           {"type": "string", "enum": ["archive", "digest", "alert", "team_analyze"]},
                },
                "required": ["index", "significance", "summary", "action"],
            },
        },
    },
    "required": ["items"],
}

_TRIAGE_SYSTEM_PROMPT = """\
You are AURA's attention manager. Your job is to classify incoming data events
by their significance and decide what action to take.

CLASSIFICATION GUIDE:
- routine: Normal market movement, weather update, typical news. Action: archive
- notable: Meaningful shift, interesting development, worth remembering. Action: digest
- urgent: Important event the user should know about soon. Action: alert
- breaking: Major, time-sensitive event requiring immediate attention. Action: alert
- team_analyze: Event(s) that would benefit from deep cross-source analysis. Action: team_analyze

RELEVANCE: Score 0.0-1.0 based on the user's known interests:
- Policy, politics, economics, legislative activity
- Financial markets, crypto, technology
- Geopolitics, US-Israel relations
- Scientific developments, AI/ML

Cross-reference potential: Note which OTHER stream types might have related data.
For example, a Fed rate decision (economic) would cross-reference with market_data and news.

Respond with JSON only. Be selective — most items are routine. Only flag as urgent/breaking
for genuinely significant events."""

_WORLD_STATE_PROMPT = """\
Summarize the current state across these categories based on recent events.
Write 1-2 sentences per category. If no recent data, say "No recent updates."

Categories: market, news, weather, economic, legal, scientific

Recent events:
{events}

Respond with JSON: {{"market": "...", "news": "...", "weather": "...", "economic": "...", "legal": "...", "scientific": "..."}}"""

_TEAM_TASK_PROMPT = """\
You have accumulated these data events flagged for deeper analysis by our triage system.
Formulate a concise research task for the analysis team. The task should:
1. Ask for cross-source correlation between related events
2. Request pattern identification across the data
3. Ask for actionable insights and implications

Write it as a direct instruction, like a user would give to an analyst.
Be specific about what connections to explore.

Events for analysis:
{events}

Write the task (2-4 sentences):"""


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: "IdleTriageService | None" = None


def init_idle_triage() -> "IdleTriageService":
    global _instance
    _instance = IdleTriageService()
    return _instance


def get_idle_triage() -> "IdleTriageService | None":
    return _instance


def get_world_state() -> dict:
    """Return current world state summary. Safe if not initialized."""
    if _instance is None:
        return {}
    return _instance.world_state


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class IdleTriageService:
    """
    Interface Engine's idle-time attention manager.

    Runs two background loops:
      1. _triage_loop: Drain streams, classify, route events
      2. _dispatch_loop: Formulate and dispatch team analysis tasks
    """

    def __init__(self) -> None:
        # Buffers
        self._digest_buffer: list[dict] = []        # accumulated "digest" items for briefings
        self._team_analysis_buffer: list[dict] = []  # accumulated "team_analyze" items

        # World state
        self.world_state: dict = {
            "market": "No recent updates.",
            "news": "No recent updates.",
            "weather": "No recent updates.",
            "economic": "No recent updates.",
            "legal": "No recent updates.",
            "scientific": "No recent updates.",
            "knowledge": "No recent ingestion insights.",
            "last_updated": 0.0,
        }

        # Tracking
        self._last_triage_ts: float = time.time()   # high-water mark for stream drain
        self._last_world_update: float = 0.0
        self._last_team_dispatch: float = 0.0
        self._triage_count: int = 0
        self._alert_count: int = 0
        self._dispatch_count: int = 0

        # Background tasks
        self._triage_task: Optional[asyncio.Task] = None
        self._dispatch_task: Optional[asyncio.Task] = None
        self._computer_use_task: Optional[asyncio.Task] = None

        logger.info("[idle_triage] IdleTriageService created")

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> list[asyncio.Task]:
        """Start background loops. Returns the tasks."""
        self._triage_task = asyncio.create_task(self._triage_loop(), name="idle_triage")
        self._dispatch_task = asyncio.create_task(self._dispatch_loop(), name="idle_dispatch")
        self._computer_use_task = asyncio.create_task(
            self._computer_use_idle_loop(), name="idle_computer_use"
        )
        logger.info("[idle_triage] Background loops started")

        # Register return callback for proactive queue flush
        try:
            from app.service.screen_awareness_service import get_screen_awareness
            sa = get_screen_awareness()
            if sa:
                from app.controller.chat_controller import flush_proactive_queue
                sa.register_on_return(flush_proactive_queue)
                logger.info("[idle_triage] Registered proactive queue flush on user return")
        except Exception as exc:
            logger.warning("[idle_triage] Could not register return callback: %s", exc)

        return [self._triage_task, self._dispatch_task, self._computer_use_task]

    def stop(self) -> None:
        for task in (self._triage_task, self._dispatch_task, self._computer_use_task):
            if task and not task.done():
                task.cancel()
        logger.info("[idle_triage] Stopped")

    # ── Public accessors ──────────────────────────────────────────────────────

    def get_digest_buffer(self) -> list[dict]:
        """Return accumulated digest items (for briefing generation)."""
        return list(self._digest_buffer)

    def clear_digest_buffer(self) -> None:
        """Clear digest buffer after briefing generation."""
        self._digest_buffer.clear()

    def world_state_for_prompt(self) -> str:
        """Format world state as a multi-line string for prompt injection."""
        parts = []
        for key in ("market", "news", "weather", "economic", "legal", "scientific", "knowledge"):
            val = self.world_state.get(key, "No data")
            if val and val not in ("No recent updates.", "No recent ingestion insights."):
                parts.append(f"{key.title()}: {val}")
        return "\n".join(parts) if parts else ""

    def status(self) -> dict:
        return {
            "triage_count":     self._triage_count,
            "alert_count":      self._alert_count,
            "dispatch_count":   self._dispatch_count,
            "digest_buffer":    len(self._digest_buffer),
            "team_buffer":      len(self._team_analysis_buffer),
            "world_state_age":  time.time() - self._last_world_update if self._last_world_update else None,
        }

    # ── Triage Loop ───────────────────────────────────────────────────────────

    async def _triage_loop(self) -> None:
        """Main triage loop — runs while system is up, active only during idle."""
        while True:
            try:
                cfg = self._get_config()
                if not cfg or not cfg.enabled:
                    await asyncio.sleep(60)
                    continue

                # Defer during active model inference
                try:
                    from app.controller.chat_controller import _runtime_state
                    if _runtime_state.get("interface_busy"):
                        await asyncio.sleep(cfg.triage_interval_seconds)
                        continue
                except Exception:
                    pass

                idle_state, idle_secs = self._get_idle_state()

                if idle_state == "active":
                    await asyncio.sleep(cfg.triage_interval_seconds)
                    continue

                # Drain recent events from all streams
                events = self._drain_streams()
                if not events:
                    await asyncio.sleep(cfg.triage_interval_seconds)
                    continue

                # Classify events via Interface Engine
                await self._classify_events(events, cfg)

                # Update world state periodically
                if time.time() - self._last_world_update >= cfg.world_state_update_interval:
                    await self._update_world_state(events)

                # Sleep based on idle depth
                interval = cfg.triage_interval_seconds
                if idle_state == "away":
                    interval *= 3  # reduce frequency when away
                await asyncio.sleep(interval)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("[idle_triage] Triage loop error: %s", exc)
                await asyncio.sleep(30)

    # ── Autonomous Dispatch Loop ──────────────────────────────────────────────

    async def _dispatch_loop(self) -> None:
        """Autonomous team dispatch loop — only during deep_idle or away."""
        while True:
            try:
                cfg = self._get_config()
                if not cfg or not cfg.enabled:
                    await asyncio.sleep(60)
                    continue

                idle_state, idle_secs = self._get_idle_state()

                # Defer during active model inference
                try:
                    from app.controller.chat_controller import _runtime_state
                    if _runtime_state.get("interface_busy"):
                        await asyncio.sleep(30)
                        continue
                except Exception:
                    pass

                # Only dispatch during deep idle or away
                if idle_state not in ("deep_idle", "away"):
                    await asyncio.sleep(30)
                    continue

                # Respect cooldown
                if time.time() - self._last_team_dispatch < cfg.team_dispatch_cooldown:
                    await asyncio.sleep(30)
                    continue

                # Check batch threshold
                if len(self._team_analysis_buffer) < cfg.min_items_for_team_dispatch:
                    await asyncio.sleep(30)
                    continue

                # Check team availability
                if not self._is_team_available():
                    await asyncio.sleep(60)
                    continue

                # Formulate and dispatch
                await self._dispatch_team_analysis(cfg)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("[idle_triage] Dispatch loop error: %s", exc)
                await asyncio.sleep(60)

    # ── Stream Drain ────────────────────────────────────────────────────��─────

    def _drain_streams(self) -> list[dict]:
        """Drain recent events from all active streams since last triage."""
        try:
            from app.agents.tools.streaming import get_stream_manager
            mgr = get_stream_manager()
            if mgr is None:
                return []
            all_events = mgr.drain_all_recent(self._last_triage_ts)
            self._last_triage_ts = time.time()

            # Flatten into a single list with stream source tagged
            flat = []
            for stream_id, events in all_events.items():
                for e in events:
                    e["_source_stream"] = stream_id
                    flat.append(e)
            return flat
        except Exception as exc:
            logger.debug("[idle_triage] Stream drain error: %s", exc)
            return []

    # ── Idle Computer Use Loop ────────────────────────────────────────────────

    async def _computer_use_idle_loop(self) -> None:
        """
        Bounded autonomous computer use during deep_idle or away states.

        Only runs if IdleProcessingConfig.autonomous_computer_use_allowed is
        non-empty (default: []). The user must explicitly opt in by listing
        allowed actions. Each action is enqueued via task_queue_service so
        the user can see and cancel it via GET /queue.
        """
        _IDLE_ACTION_SCHEMA = {
            "type": "object",
            "properties": {
                "action":    {"type": "string"},
                "reasoning": {"type": "string"},
                "parameters": {"type": "object"},
            },
            "required": ["action"],
        }

        while True:
            try:
                cfg = self._get_config()
                if not cfg or not cfg.enabled:
                    await asyncio.sleep(120)
                    continue

                allowed = getattr(cfg, "autonomous_computer_use_allowed", [])
                if not allowed:
                    await asyncio.sleep(300)   # check every 5 min if config changes
                    continue

                idle_state, _ = self._get_idle_state()
                if idle_state not in ("deep_idle", "away"):
                    await asyncio.sleep(60)
                    continue

                # Don't interrupt active inference
                try:
                    from app.controller.chat_controller import _runtime_state
                    if _runtime_state.get("interface_busy"):
                        await asyncio.sleep(30)
                        continue
                except Exception:
                    pass

                # Build context for decision
                try:
                    from app.service.interface_engine import get_engine
                    from app.service.self_awareness_service import get_self_awareness
                    from app.service.screen_awareness_service import get_current_context

                    engine = get_engine()
                    if engine is None:
                        await asyncio.sleep(120)
                        continue

                    sa = get_self_awareness()
                    health_snap = sa.snapshot("health") if sa else {}
                    screen_ctx = get_current_context()

                    allowed_list = "\n".join(f"- {a}" for a in allowed)
                    prompt = (
                        f"You are AURA operating autonomously while the user is idle.\n"
                        f"Available actions you may take:\n{allowed_list}\n\n"
                        f"Current screen: {screen_ctx.topic or 'unknown'} ({screen_ctx.app_name or 'none'})\n"
                        f"Service health: {len(health_snap.get('services', {}))} services tracked\n\n"
                        f"Choose ONE action to perform now, or 'none' if nothing is needed. "
                        f"Respond in JSON."
                    )

                    result = await engine.generate(
                        [{"role": "user", "content": prompt}],
                        max_tokens=256,
                        format="json",
                        temperature=0.3,
                    )

                    import json as _json
                    action_data = _json.loads(result.get("text", "{}"))
                    chosen_action = action_data.get("action", "none")

                    if not chosen_action or chosen_action.lower() == "none":
                        await asyncio.sleep(getattr(cfg, "team_dispatch_cooldown", 300))
                        continue

                    # Enqueue via task queue — visible + cancellable by user
                    try:
                        from app.service.task_queue_service import enqueue_task
                        await enqueue_task({
                            "type":          "computer_use_idle",
                            "action":        chosen_action,
                            "parameters":    action_data.get("parameters", {}),
                            "reasoning":     action_data.get("reasoning", ""),
                            "autonomous":    True,
                            "idle_action":   True,
                        })
                        logger.info(
                            "[idle_triage] Autonomous computer use queued: %s", chosen_action
                        )

                        # Emit SSE so frontend can notify user
                        try:
                            from app.controller.chat_controller import _emit
                            await _emit("computer_use_action", {
                                "action":    chosen_action,
                                "reasoning": action_data.get("reasoning", ""),
                                "source":    "idle_autonomous",
                            })
                        except Exception:
                            pass

                    except Exception as exc:
                        logger.warning("[idle_triage] Failed to enqueue autonomous action: %s", exc)

                except Exception as exc:
                    logger.debug("[idle_triage] Computer use idle loop error: %s", exc)

                await asyncio.sleep(getattr(cfg, "team_dispatch_cooldown", 300))

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("[idle_triage] Computer use idle loop outer error: %s", exc)
                await asyncio.sleep(120)

    # ── Classification ────────────────────────────────────────────────────────

    async def _classify_events(self, events: list[dict], cfg) -> None:
        """Send a batch of events to the Interface Engine for classification."""
        from app.service.interface_engine import get_engine

        engine = get_engine()
        if engine is None:
            return

        # Truncate batch
        batch = events[:cfg.triage_max_batch]

        # Format events for classification
        event_lines = []
        for i, e in enumerate(batch):
            stream = e.get("_stream", "unknown")
            summary = self._format_event_summary(e)
            event_lines.append(f"[{i}] ({stream}) {summary}")

        events_text = "\n".join(event_lines)
        messages = [
            {"role": "system", "content": _TRIAGE_SYSTEM_PROMPT},
            {"role": "user", "content": f"Classify these {len(batch)} events:\n\n{events_text}"},
        ]

        try:
            result = await engine.generate(
                messages,
                max_tokens=cfg.max_interface_tokens_per_triage,
                grammar=_TRIAGE_SCHEMA,
                temperature=0.2,
            )
            text = result.get("text", "")
            classification = json.loads(text) if isinstance(text, str) else text
            items = classification.get("items", [])
        except Exception as exc:
            logger.warning("[idle_triage] Classification failed: %s", exc)
            return

        self._triage_count += 1

        # Route classified items
        for item in items:
            idx = item.get("index", -1)
            if idx < 0 or idx >= len(batch):
                continue

            action = item.get("action", "archive")
            event_data = batch[idx]
            enriched = {**event_data, **item}

            if action == "archive":
                pass  # noise — discard

            elif action == "digest":
                self._digest_buffer.append(enriched)
                # Cap buffer at 500 items
                if len(self._digest_buffer) > 500:
                    self._digest_buffer = self._digest_buffer[-300:]

            elif action == "alert":
                await self._fire_news_break(enriched, cfg)

            elif action == "team_analyze":
                self._team_analysis_buffer.append(enriched)
                # Cap buffer at 100 items
                if len(self._team_analysis_buffer) > 100:
                    self._team_analysis_buffer = self._team_analysis_buffer[-50:]

        logger.info(
            "[idle_triage] Classified %d events: %d archive, %d digest, %d alert, %d team",
            len(items),
            sum(1 for i in items if i.get("action") == "archive"),
            sum(1 for i in items if i.get("action") == "digest"),
            sum(1 for i in items if i.get("action") == "alert"),
            sum(1 for i in items if i.get("action") == "team_analyze"),
        )

    # ── News Break ────────────────────────────────────────────────────────────

    async def _fire_news_break(self, event: dict, cfg) -> None:
        """Generate and deliver a news break for an urgent/breaking event."""
        if not cfg.news_break_enabled:
            return

        significance = event.get("significance", "urgent")
        min_sig = cfg.news_break_min_significance
        sig_order = ["routine", "notable", "urgent", "breaking"]
        if sig_order.index(significance) < sig_order.index(min_sig):
            return

        # Generate brief analysis via Interface Engine
        from app.service.interface_engine import get_engine
        engine = get_engine()

        summary = event.get("summary", "")
        source = event.get("_stream", "unknown")
        analysis = ""

        if engine:
            try:
                world_ctx = self.world_state_for_prompt()
                prompt = (
                    f"Breaking event from {source}: {summary}\n\n"
                    f"Current world state:\n{world_ctx}\n\n"
                    "Write a 1-2 sentence analysis of this event's significance and potential impact."
                )
                result = await engine.generate(
                    [{"role": "user", "content": prompt}],
                    max_tokens=128,
                    temperature=0.3,
                )
                analysis = result.get("text", "").strip()
            except Exception as exc:
                logger.debug("[idle_triage] News break analysis failed: %s", exc)

        # Deliver via proactive system
        try:
            from app.controller.chat_controller import deliver_proactive
            await deliver_proactive("news_break", {
                "summary": summary,
                "analysis": analysis,
                "source": source,
                "significance": significance,
                "timestamp": time.time(),
                "raw_event": {k: v for k, v in event.items() if k != "_source_stream"},
            }, significance=significance)
            self._alert_count += 1
        except Exception as exc:
            logger.warning("[idle_triage] News break delivery failed: %s", exc)

    # ── World State Update ────────────────────────────────────────────────────

    async def _update_world_state(self, recent_events: list[dict]) -> None:
        """Ask Interface Engine to synthesize a world state summary."""
        from app.service.interface_engine import get_engine

        engine = get_engine()
        if engine is None:
            return

        # Format recent events compactly
        event_summaries = []
        for e in recent_events[:30]:
            stream = e.get("_stream", "unknown")
            summary = self._format_event_summary(e)
            event_summaries.append(f"({stream}) {summary}")

        events_text = "\n".join(event_summaries) if event_summaries else "No recent events."

        try:
            result = await engine.generate(
                [{"role": "user", "content": _WORLD_STATE_PROMPT.format(events=events_text)}],
                max_tokens=512,
                grammar={
                    "type": "object",
                    "properties": {
                        "market": {"type": "string"},
                        "news": {"type": "string"},
                        "weather": {"type": "string"},
                        "economic": {"type": "string"},
                        "legal": {"type": "string"},
                        "scientific": {"type": "string"},
                    },
                    "required": ["market", "news"],
                },
                temperature=0.3,
            )
            text = result.get("text", "")
            parsed = json.loads(text) if isinstance(text, str) else text
            for key in ("market", "news", "weather", "economic", "legal", "scientific"):
                if key in parsed and parsed[key]:
                    self.world_state[key] = parsed[key]
            self.world_state["last_updated"] = time.time()
            self._last_world_update = time.time()
            logger.info("[idle_triage] World state updated")
        except Exception as exc:
            logger.warning("[idle_triage] World state update failed: %s", exc)

    # ── Autonomous Team Dispatch ──────────────────────────────────────────────

    async def _dispatch_team_analysis(self, cfg) -> None:
        """
        Formulate an analysis task from accumulated events and dispatch to team.

        The Interface Engine writes the task in natural language, then we send it
        through TeamDispatcher.dispatch() — the same pipeline as user-initiated work.
        """
        from app.service.interface_engine import get_engine

        engine = get_engine()
        if engine is None:
            return

        # Grab buffered items
        items = list(self._team_analysis_buffer)
        self._team_analysis_buffer.clear()

        if not items:
            return

        # Format events for task formulation
        event_summaries = []
        for e in items[:15]:
            stream = e.get("_stream", "unknown")
            summary = e.get("summary", self._format_event_summary(e))
            significance = e.get("significance", "notable")
            cross = e.get("cross_ref_streams", [])
            cross_str = f" (cross-ref: {', '.join(cross)})" if cross else ""
            event_summaries.append(f"[{significance}] ({stream}) {summary}{cross_str}")

        events_text = "\n".join(event_summaries)

        # Ask Interface Engine to formulate the analysis task
        try:
            result = await engine.generate(
                [{"role": "user", "content": _TEAM_TASK_PROMPT.format(events=events_text)}],
                max_tokens=512,
                temperature=0.4,
            )
            task_text = result.get("text", "").strip()
        except Exception as exc:
            logger.warning("[idle_triage] Task formulation failed: %s", exc)
            return

        if not task_text or len(task_text) < 20:
            logger.warning("[idle_triage] Task formulation produced insufficient text")
            return

        # Dispatch to team pipeline
        try:
            from app.service.team_dispatcher import get_team_dispatcher
            dispatcher = get_team_dispatcher()
            if dispatcher is None:
                return

            # Don't dispatch if team is already busy (user tasks take priority)
            status = dispatcher.get_status()
            if status.get("active_team_id") or status.get("queue_size", 0) > 0:
                # Re-buffer items for next cycle
                self._team_analysis_buffer = items + self._team_analysis_buffer
                logger.info("[idle_triage] Team busy — deferring autonomous dispatch")
                return

            team_id = f"idle-{uuid.uuid4().hex[:8]}"
            thread_id = "idle_processing"

            queue_pos = await dispatcher.dispatch(
                task_text,
                thread_id,
                team_id,
                metadata={"autonomous": True, "task_type": "idle_analysis", "event_count": len(items)},
            )

            self._last_team_dispatch = time.time()
            self._dispatch_count += 1
            logger.info(
                "[idle_triage] Dispatched autonomous team task %s (queue_pos=%d, events=%d)",
                team_id, queue_pos, len(items),
            )

            # Emit SSE event so frontend shows autonomous work
            try:
                from app.controller.chat_controller import _emit
                await _emit("team_dispatched", {
                    "plan": {
                        "agents": [],
                        "task": task_text,
                        "teamId": team_id,
                        "autonomous": True,
                    }
                })
            except Exception:
                pass

        except Exception as exc:
            logger.warning("[idle_triage] Team dispatch failed: %s", exc)
            # Re-buffer on failure
            self._team_analysis_buffer = items + self._team_analysis_buffer

    # ── Helpers ───────────────────────────────────────────────────────────────

    def _format_event_summary(self, event: dict) -> str:
        """Create a compact text summary of a stream event."""
        stream = event.get("_stream", "")

        if stream == "market_data":
            ticker = event.get("ticker", "?")
            price = event.get("price", 0)
            change_pct = event.get("change_pct", 0)
            return f"{ticker} ${price:.2f} ({change_pct:+.2f}%)"

        elif stream == "news":
            title = event.get("title", "")
            source = event.get("source", "")
            category = event.get("category", "")
            return f"{title} [{source}] ({category})"

        elif stream == "weather":
            loc = event.get("location", {})
            name = loc.get("name", "?") if isinstance(loc, dict) else str(loc)
            impact = event.get("impact", "normal")
            return f"Weather {name}: impact={impact}"

        elif stream == "economic_events":
            title = event.get("title", event.get("series_id", ""))
            return f"Economic: {title}"

        else:
            # Generic fallback
            title = event.get("title", event.get("summary", ""))
            if title:
                return str(title)[:120]
            return json.dumps(event, default=str)[:120]

    @staticmethod
    def _get_config():
        try:
            from app.config import get_settings
            return get_settings().idle_processing
        except Exception:
            return None

    @staticmethod
    def _get_idle_state() -> tuple[str, float]:
        try:
            from app.service.screen_awareness_service import get_idle_state
            return get_idle_state()
        except Exception:
            return ("active", 0.0)

    @staticmethod
    def _is_team_available() -> bool:
        """Check if team pipeline is available (hardware gate + team enabled)."""
        try:
            from app.service.hardware_gate import is_team_available
            if not is_team_available():
                return False
        except Exception:
            pass
        try:
            from app.controller.chat_controller import _runtime_state
            return _runtime_state.get("team_enabled", False)
        except Exception:
            return False
