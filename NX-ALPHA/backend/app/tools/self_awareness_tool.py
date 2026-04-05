"""
AURA NX-Alpha — Self-Awareness Tool

MCP/agent tool wrapper for SelfAwarenessService.
Lets the agent introspect its own operational state.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "aura_self",
    "description": (
        "Query AURA's own operational state. Use this when the user asks about "
        "system health, running services, memory usage, recent errors, active tasks, "
        "or what AURA is currently doing."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "enum": [
                    "health",
                    "services",
                    "memory",
                    "errors",
                    "tasks",
                    "config",
                    "models",
                    "logs",
                    "world_state",
                    "screen",
                    "full",
                ],
                "description": (
                    "health/services — running service statuses; "
                    "memory — ChromaDB/SQLite/Neo4j sizes; "
                    "errors — last 20 WARNING+ log entries; "
                    "tasks — active background asyncio tasks; "
                    "config — current model/hardware config summary; "
                    "models — loaded Ollama models; "
                    "logs — last 50 log lines; "
                    "world_state — idle triage world state; "
                    "screen — current foreground window + idle state; "
                    "full — everything above."
                ),
            },
        },
        "required": ["query"],
    },
}


async def tool_handler(inputs: dict) -> Any:
    from app.service.self_awareness_service import get_self_awareness
    sa = get_self_awareness()
    if sa is None:
        return {"error": "Self-awareness service not initialised — boot sequence may not be complete."}

    query = inputs.get("query", "health")
    return sa.snapshot(query)
