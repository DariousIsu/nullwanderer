"""
Truth Social Tool — query @realDonaldTrump posts archived by the monitor service.

Actions:
  latest — return N most recent posts
  search — full-text search over stored posts
  stats  — aggregate counts and timestamps
"""

from __future__ import annotations

import asyncio
import logging

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "truthsocial",
    "description": (
        "Query @realDonaldTrump's Truth Social posts. "
        "Posts are polled every 15 minutes and stored locally. "
        "Actions: "
        "(1) latest — fetch the N most recent posts. "
        "(2) search — full-text search over archived posts by keyword. "
        "(3) stats — return total post count and latest post timestamp. "
        "Use this when asked about Trump's recent statements, Truth Social posts, or what he said about a topic."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["latest", "search", "stats"],
                "description": "Action to perform",
            },
            "limit": {
                "type": "integer",
                "description": "Number of posts to return (default: 10)",
                "default": 10,
            },
            "query": {
                "type": "string",
                "description": "Search query for full-text search over post content",
            },
        },
        "required": ["action"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    from app.service.truthsocial_service import get_truthsocial_service

    action = inputs.get("action", "")
    limit = int(inputs.get("limit", 10))

    try:
        svc = get_truthsocial_service()
    except Exception as exc:
        return _error(f"Truth Social service unavailable: {exc}")

    if action == "latest":
        posts = await asyncio.to_thread(svc.get_latest_posts, limit)
        return {"posts": posts, "count": len(posts)}

    elif action == "search":
        query = inputs.get("query", "").strip()
        if not query:
            return _error("query is required for search action")
        results = await asyncio.to_thread(svc.search_posts, query, limit)
        return {"results": results, "count": len(results), "query": query}

    elif action == "stats":
        stats = await asyncio.to_thread(svc.get_stats)
        stats["polling_active"] = svc.is_polling()
        return stats

    return _error(f"Unknown action: {action}")
