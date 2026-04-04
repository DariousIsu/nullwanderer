"""
AURA NX-Alpha — PlannerAgent
The Planner reads the agent registry and intelligently assigns the right
agent templates, tools, and data streams to incoming tasks.

The Planner does NOT build anything from scratch — it selects from the
pre-built template library in registry.json and wires them together.

Integration:
    The existing project_manager.py handles general task decomposition.
    PlannerAgent extends this specifically for financial/market tasks,
    adding awareness of streams, agent templates, and training pipelines.

Usage:
    from app.agents.planner import get_planner
    planner = get_planner()

    plan = await planner.plan("Run a full analysis on NVDA and generate a trade signal")
    result = await planner.execute_plan(plan)
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any

from app.agents.base import BaseAgent

logger = logging.getLogger(__name__)

_REGISTRY_PATH = Path(__file__).parent / "registry.json"


# ─────────────────────────────────────────────────────────────────────────────
# AGENT TEMPLATE LOADER
# ─────────────────────────────────────────────────────────────────────────────

def _load_agent(agent_id: str) -> BaseAgent | None:
    """Instantiate an agent template by registry ID."""
    registry = {
        "market_data_streamer_v1": lambda: _import("app.agents.templates.data.market_data_streamer", "MarketDataStreamer"),
        "economic_scheduler_v1":   lambda: _import("app.agents.templates.data.economic_scheduler",   "EconomicScheduler"),
        "technical_analyst_v1":    lambda: _import("app.agents.templates.analysis.technical_analyst", "TechnicalAnalystAgent"),
        "sentiment_v1":            lambda: _import("app.agents.templates.analysis.sentiment",         "SentimentAgent"),
        "fundamental_analyst_v1":  lambda: _import("app.agents.templates.analysis.fundamental",       "FundamentalAnalystAgent"),
        "forecasting_v1":          lambda: _import("app.agents.templates.forecasting.forecasting_agent", "ForecastingAgent"),
        "risk_manager_v1":         lambda: _import("app.agents.templates.trading.risk_manager",       "RiskManagerAgent"),
        "bull_bear_debate_v1":     lambda: _import("app.agents.templates.trading.bull_bear_debate",   "BullBearDebateAgent"),
        "trader_v1":               lambda: _import("app.agents.templates.trading.trader",             "TraderAgent"),
        "weather_impact_v1":       lambda: _import("app.agents.templates.utility.weather_impact",     "WeatherImpactAgent"),
    }
    factory = registry.get(agent_id)
    if factory is not None:
        try:
            return factory()
        except Exception as exc:
            logger.error("[planner] Failed to load agent %s: %s", agent_id, exc)
            return None

    # Check dynamic registry — custom agents published from Agent Creator
    try:
        from app.agents.dynamic_registry import get_dynamic_agent
        cls = get_dynamic_agent(agent_id)
        if cls:
            return cls()
    except ImportError:
        pass

    logger.warning("[planner] Unknown agent_id: %s", agent_id)
    return None


def _import(module_path: str, class_name: str) -> BaseAgent:
    import importlib
    mod = importlib.import_module(module_path)
    cls = getattr(mod, class_name)
    return cls()


# ─────────────────────────────────────────────────────────────────────────────
# PLANNER AGENT
# ─────────────────────────────────────────────────────────────────────────────

class PlannerAgent:
    """
    Reads the registry and wires agent templates together for a given task.

    Key responsibilities:
        1. Parse incoming task into a structured job description
        2. Match job requirements to agent capabilities from registry
        3. Build a dependency-ordered execution pipeline
        4. Execute the pipeline and collect outputs
        5. Produce a unified result dict for the caller

    The Planner uses Ollama for task parsing and pipeline decisions.
    All agent execution is local.
    """

    def __init__(self) -> None:
        self._registry: list[dict] = self._load_registry()
        self._agent_cache: dict[str, BaseAgent] = {}

    def _load_registry(self) -> list[dict]:
        try:
            with open(_REGISTRY_PATH, encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            logger.warning("[planner] registry.json not found at %s", _REGISTRY_PATH)
            return []
        except Exception as exc:
            logger.error("[planner] Failed to load registry: %s", exc)
            return []

    # ── PUBLIC API ────────────────────────────────────────────────────────────

    def get_registry(self) -> list[dict]:
        """Return the full agent registry. Used by the UI and project_manager."""
        return self._registry

    def get_agent_ids(self) -> list[str]:
        return [a["id"] for a in self._registry]

    def find_agents(
        self,
        category:     str | None = None,
        requires_llm: bool | None = None,
        real_time:    bool | None = None,
        free_tier:    bool | None = None,
    ) -> list[dict]:
        """Filter registry by capability."""
        result = self._registry
        if category:
            result = [a for a in result if a.get("category") == category]
        if requires_llm is not None:
            result = [a for a in result if a.get("requires_llm") == requires_llm]
        if real_time is not None:
            result = [a for a in result if a.get("real_time") == real_time]
        if free_tier is not None:
            result = [a for a in result if a.get("free_tier") == free_tier]
        return result

    async def plan(self, task: str, context: dict | None = None) -> dict:
        """
        Decompose a task into an execution plan using Ollama.

        Returns a plan dict:
        {
            "task": str,
            "pipeline": [
                {"step": int, "agent_id": str, "inputs_from": list[str], "params": dict},
                ...
            ],
            "requires_streaming": bool,
            "estimated_llm_calls": int,
        }
        """
        # Build registry summary for the LLM
        registry_summary = self._registry_summary()

        system = (
            "You are AURA's financial task planner. You have a library of pre-built "
            "agent templates. Your job is to select the right agents from the registry "
            "and build a dependency-ordered pipeline to complete the task. "
            "Return only valid JSON. No explanation, no markdown."
        )

        prompt = f"""TASK: {task}

CONTEXT: {json.dumps(context or {}, indent=2)[:500]}

AVAILABLE AGENT TEMPLATES:
{registry_summary}

Build an execution pipeline. Return JSON:
{{
  "pipeline": [
    {{
      "step": 1,
      "agent_id": "<id from registry>",
      "purpose": "<why this step>",
      "params": {{"key": "value"}},
      "inputs_from_steps": []
    }}
  ],
  "requires_streaming": true/false,
  "reasoning": "<one sentence>"
}}

Rules:
- Only use agent_ids that exist in the registry
- Order steps by dependency (data agents first, trading agents last)
- Always include market_data_streamer_v1 if any ticker analysis is needed
- Include economic_scheduler_v1 for macro-context tasks
- For trade signal tasks: ta → sentiment → forecast → debate → trader → risk_manager
- For research tasks: economic_scheduler + fundamental + sentiment
- Minimum pipeline: 1 step, Maximum: 8 steps"""

        try:
            from app.service.ollama_service import get_ollama_service
            svc = get_ollama_service()
            if svc and svc.is_available():
                messages = [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": prompt},
                ]
                if hasattr(svc, "chat_json"):
                    raw = await svc.chat_json(messages, temperature=0.2)
                else:
                    response = await svc.chat(messages, temperature=0.2)
                    raw = json.loads(response.strip())

                pipeline = raw.get("pipeline", [])
                return {
                    "task":     task,
                    "pipeline": pipeline,
                    "requires_streaming": raw.get("requires_streaming", False),
                    "reasoning": raw.get("reasoning", ""),
                    "estimated_llm_calls": sum(
                        1 for step in pipeline
                        if any(
                            a.get("id") == step.get("agent_id") and a.get("requires_llm")
                            for a in self._registry
                        )
                    ),
                }
        except Exception as exc:
            logger.warning("[planner] LLM plan failed: %s — using heuristic fallback", exc)

        # Heuristic fallback — detect task type by keywords
        return self._heuristic_plan(task)

    async def execute_plan(self, plan: dict, base_inputs: dict | None = None) -> dict:
        """
        Execute a pipeline plan sequentially, passing outputs between steps.

        Args:
            plan:        Output from plan()
            base_inputs: Common inputs available to all steps (e.g., ticker, account_size)

        Returns:
            Dict with results from all steps, keyed by step number.
        """
        pipeline   = plan.get("pipeline", [])
        results:    dict[int, dict] = {}
        cumulative: dict[str, Any] = base_inputs.copy() if base_inputs else {}

        # Start streaming if needed
        if plan.get("requires_streaming"):
            try:
                from app.agents.tools.streaming import get_stream_manager
                mgr = get_stream_manager()
                if not mgr.get("market_data"):
                    tickers = [cumulative.get("ticker")] if cumulative.get("ticker") else []
                    await mgr.start_defaults(market_tickers=tickers)
            except Exception as exc:
                logger.warning("[planner] streaming start failed: %s", exc)

        for step_def in sorted(pipeline, key=lambda x: x.get("step", 0)):
            step_num  = step_def.get("step", 0)
            agent_id  = step_def.get("agent_id", "")
            params    = step_def.get("params", {})
            from_steps = step_def.get("inputs_from_steps", [])

            # Build inputs for this step
            step_inputs = {**cumulative, **params}
            for prev_step in from_steps:
                if prev_step in results:
                    step_inputs.update(results[prev_step])

            # Load and execute agent
            agent = self._get_or_load(agent_id)
            if agent is None:
                results[step_num] = {"_error": f"Agent {agent_id} not found", "step": step_num}
                continue

            logger.info("[planner] Step %d: executing %s", step_num, agent_id)
            result = await agent.execute(step_inputs)
            results[step_num] = result

            # Make outputs available to subsequent steps
            cumulative.update({k: v for k, v in result.items() if not k.startswith("_")})

        return {
            "plan":    plan,
            "results": results,
            "final":   cumulative,
        }

    async def run_trade_pipeline(
        self,
        ticker:       str,
        account_size: float = 10000.0,
        portfolio:    dict | None = None,
    ) -> dict:
        """
        Convenience method: run the complete trade signal pipeline for a ticker.
        TA → Sentiment → Forecast → Debate → Trader → RiskManager
        """
        base_inputs = {
            "ticker":       ticker,
            "tickers":      [ticker],
            "account_size": account_size,
            "portfolio":    portfolio or {},
            "fetch_live":   True,
        }

        pipeline_steps = [
            {"step": 1, "agent_id": "market_data_streamer_v1",  "params": {"tickers": [ticker]}, "inputs_from_steps": []},
            {"step": 2, "agent_id": "technical_analyst_v1",     "params": {"ticker": ticker, "fetch_live": True}, "inputs_from_steps": [1]},
            {"step": 3, "agent_id": "sentiment_v1",             "params": {"tickers": [ticker]}, "inputs_from_steps": []},
            {"step": 4, "agent_id": "forecasting_v1",           "params": {"ticker": ticker, "horizon": 5, "method": "auto"}, "inputs_from_steps": [2]},
            {"step": 5, "agent_id": "bull_bear_debate_v1",      "params": {"ticker": ticker}, "inputs_from_steps": [2, 3, 4]},
            {"step": 6, "agent_id": "trader_v1",                "params": {"ticker": ticker}, "inputs_from_steps": [2, 3, 4, 5]},
            {"step": 7, "agent_id": "risk_manager_v1",          "params": {}, "inputs_from_steps": [6]},
        ]

        plan = {
            "task":              f"Full trade analysis for {ticker}",
            "pipeline":          pipeline_steps,
            "requires_streaming": True,
            "reasoning":         "Full trading pipeline",
        }

        return await self.execute_plan(plan, base_inputs)

    async def run_research_pipeline(self, topic: str, tickers: list[str] | None = None) -> dict:
        """
        Convenience method: run the economic research pipeline.
        EconomicScheduler → Fundamental (per ticker) → Sentiment → WeatherImpact
        """
        base_inputs = {
            "tickers": tickers or [],
            "topics":  [topic, "economy", "market"],
            "force_refresh": False,
        }

        pipeline_steps = [
            {"step": 1, "agent_id": "economic_scheduler_v1", "params": {}, "inputs_from_steps": []},
            {"step": 2, "agent_id": "sentiment_v1",          "params": {"tickers": tickers or []}, "inputs_from_steps": []},
            {"step": 3, "agent_id": "weather_impact_v1",     "params": {}, "inputs_from_steps": []},
        ]

        # Add fundamental analysis for each ticker
        step_n = 4
        for ticker in (tickers or [])[:3]:  # limit to 3 tickers
            pipeline_steps.append({
                "step": step_n,
                "agent_id": "fundamental_analyst_v1",
                "params": {"ticker": ticker, "depth": "full"},
                "inputs_from_steps": [],
            })
            step_n += 1

        plan = {
            "task":              f"Economic research: {topic}",
            "pipeline":          pipeline_steps,
            "requires_streaming": False,
            "reasoning":         "Economic research pipeline",
        }

        return await self.execute_plan(plan, base_inputs)

    # ── INTERNALS ─────────────────────────────────────────────────────────────

    def _get_or_load(self, agent_id: str) -> BaseAgent | None:
        if agent_id not in self._agent_cache:
            agent = _load_agent(agent_id)
            if agent:
                self._agent_cache[agent_id] = agent
        return self._agent_cache.get(agent_id)

    def _registry_summary(self) -> str:
        lines = []
        for a in self._registry:
            lines.append(
                f"  {a['id']} [{a.get('category')}] — {a.get('description', '')} "
                f"(llm={a.get('requires_llm')} rt={a.get('real_time')} "
                f"in={a.get('inputs')} out={a.get('outputs')})"
            )
        return "\n".join(lines)

    def _heuristic_plan(self, task: str) -> dict:
        """Keyword-based fallback plan when Ollama is unavailable."""
        task_lower = task.lower()

        if any(w in task_lower for w in ["trade", "signal", "buy", "sell", "position"]):
            pipeline = [
                {"step": 1, "agent_id": "market_data_streamer_v1", "params": {}, "inputs_from_steps": []},
                {"step": 2, "agent_id": "technical_analyst_v1",    "params": {}, "inputs_from_steps": [1]},
                {"step": 3, "agent_id": "sentiment_v1",            "params": {}, "inputs_from_steps": []},
                {"step": 4, "agent_id": "trader_v1",               "params": {}, "inputs_from_steps": [2, 3]},
                {"step": 5, "agent_id": "risk_manager_v1",         "params": {}, "inputs_from_steps": [4]},
            ]
            return {"task": task, "pipeline": pipeline, "requires_streaming": True, "reasoning": "heuristic:trade"}

        if any(w in task_lower for w in ["forecast", "predict", "outlook"]):
            pipeline = [
                {"step": 1, "agent_id": "market_data_streamer_v1", "params": {}, "inputs_from_steps": []},
                {"step": 2, "agent_id": "technical_analyst_v1",    "params": {}, "inputs_from_steps": [1]},
                {"step": 3, "agent_id": "forecasting_v1",          "params": {}, "inputs_from_steps": [2]},
            ]
            return {"task": task, "pipeline": pipeline, "requires_streaming": True, "reasoning": "heuristic:forecast"}

        if any(w in task_lower for w in ["economy", "macro", "gdp", "inflation", "fed"]):
            pipeline = [
                {"step": 1, "agent_id": "economic_scheduler_v1", "params": {}, "inputs_from_steps": []},
                {"step": 2, "agent_id": "sentiment_v1",          "params": {}, "inputs_from_steps": []},
                {"step": 3, "agent_id": "weather_impact_v1",     "params": {}, "inputs_from_steps": []},
            ]
            return {"task": task, "pipeline": pipeline, "requires_streaming": False, "reasoning": "heuristic:macro"}

        if any(w in task_lower for w in ["weather", "commodity", "energy", "agriculture"]):
            pipeline = [
                {"step": 1, "agent_id": "weather_impact_v1", "params": {}, "inputs_from_steps": []},
            ]
            return {"task": task, "pipeline": pipeline, "requires_streaming": True, "reasoning": "heuristic:weather"}

        # Default: sentiment + economic snapshot
        pipeline = [
            {"step": 1, "agent_id": "economic_scheduler_v1", "params": {}, "inputs_from_steps": []},
            {"step": 2, "agent_id": "sentiment_v1",          "params": {}, "inputs_from_steps": []},
        ]
        return {"task": task, "pipeline": pipeline, "requires_streaming": False, "reasoning": "heuristic:default"}


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_planner: PlannerAgent | None = None


def get_planner() -> PlannerAgent:
    global _planner
    if _planner is None:
        _planner = PlannerAgent()
    return _planner
