"""
Jina Search — MCP tool wrapper.

Full-page web search that returns complete page content in one call.
Replaces the scrape-then-extract pattern. 1M free tokens/month.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "jina_search",
    "description": (
        "Web search that returns full page content in one call. Unlike regular search "
        "which only returns snippets, Jina reads entire pages and returns clean text. "
        "Use when you need the actual content of search results, not just links."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query or URL to read"},
            "mode":  {"type": "string", "enum": ["search", "read"], "description": "'search' for web search, 'read' for a specific URL", "default": "search"},
        },
        "required": ["query"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    query = inputs.get("query", "")
    mode  = inputs.get("mode", "search")
    if not query:
        return _error("query is required")

    api_key = _get_setting("jina_api_key")
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            if mode == "read" or query.startswith("http"):
                url = f"https://r.jina.ai/{query}"
            else:
                url = f"https://s.jina.ai/{query}"

            r = await client.get(url, headers=headers)
            r.raise_for_status()
            data = r.json()

        if mode == "read" or query.startswith("http"):
            return {
                "title":   data.get("data", {}).get("title", ""),
                "content": data.get("data", {}).get("content", "")[:5000],
                "url":     data.get("data", {}).get("url", query),
            }

        results = []
        for item in data.get("data", []) if isinstance(data.get("data"), list) else []:
            results.append({
                "title":   item.get("title", ""),
                "url":     item.get("url", ""),
                "content": item.get("content", "")[:1000],
            })

        return {"results": results, "total": len(results), "query": query}

    except Exception as exc:
        logger.error("[jina_search] %s", exc)
        return _error(str(exc))
