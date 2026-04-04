"""
Dynamic agent registry — bridges custom agents compiled from the Agent Creator
into the existing planner pipeline without requiring code changes or restarts.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_DYNAMIC_REGISTRY: dict[str, type] = {}   # agent_id → CompiledCustomAgent class

REGISTRY_PATH = Path.home() / ".aura" / "custom_registry.json"


# ─────────────────────────────────────────────────────────────────────────────
# STARTUP LOADER
# ─────────────────────────────────────────────────────────────────────────────

def load_from_disk() -> None:
    """Load all published agents from disk on startup."""
    if not REGISTRY_PATH.exists():
        return
    try:
        from app.service.agent_compiler import compile_agent
        from app.service.custom_agent_store import get_custom_agent_store

        store = get_custom_agent_store()
        with open(REGISTRY_PATH) as f:
            published: list[dict] = json.load(f)

        for entry in published:
            definition = store.get_agent(entry["id"])
            if definition:
                cls = compile_agent(definition)
                register_compiled_agent(definition.id, cls, definition)
                logger.info("[dynamic_registry] Loaded: %s", definition.name)
    except Exception as exc:
        logger.warning("[dynamic_registry] Failed to load from disk: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# REGISTRATION
# ─────────────────────────────────────────────────────────────────────────────

def register_compiled_agent(agent_id: str, agent_class: type, definition=None) -> None:
    """Register a compiled agent class. Optionally injects it into the live planner."""
    _DYNAMIC_REGISTRY[agent_id] = agent_class
    logger.info("[dynamic_registry] Registered: %s", agent_id)
    if definition is not None:
        _inject_into_planner(agent_id, definition)


def _inject_into_planner(agent_id: str, definition) -> None:
    """
    Append (or replace) a custom agent entry in the live PlannerAgent._registry.
    This makes it visible to Ollama task planning and find_agents() filtering
    without requiring a restart.
    """
    try:
        from app.agents.planner import get_planner

        entry = {
            "id": definition.id,
            "name": definition.name,
            "version": f"custom-v{definition.version}",
            "category": definition.category,
            "description": definition.description,
            "inputs": definition.inputs,
            "outputs": definition.outputs,
            "requires_llm": any(n.type == "llm" for n in definition.nodes),
            "real_time": False,
            "free_tier": True,
            "training_value": "custom",
            "dependencies": [],
            "typical_use": "Custom agent built via Agent Creator",
        }

        planner = get_planner()
        # Remove stale entry first (idempotent on re-publish)
        planner._registry = [a for a in planner._registry if a.get("id") != agent_id]
        planner._registry.append(entry)
        logger.info("[dynamic_registry] Injected %s into planner registry", agent_id)
    except Exception as exc:
        logger.debug("[dynamic_registry] Could not inject into planner (will retry at next call): %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# QUERIES
# ─────────────────────────────────────────────────────────────────────────────

def get_dynamic_agent(agent_id: str) -> type | None:
    return _DYNAMIC_REGISTRY.get(agent_id)


def list_dynamic_agents() -> list[dict]:
    """Returns metadata for all registered dynamic agents."""
    return [
        {
            "id": agent_id,
            "name": getattr(cls, "AGENT_NAME", agent_id),
            "description": getattr(cls, "AGENT_DESCRIPTION", "Custom agent"),
            "inputs": getattr(cls, "INPUTS", []),
            "outputs": getattr(cls, "OUTPUTS", []),
        }
        for agent_id, cls in _DYNAMIC_REGISTRY.items()
    ]
