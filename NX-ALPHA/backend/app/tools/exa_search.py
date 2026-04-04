"""
Exa Search — MCP tool wrapper.

Neural search engine optimized for finding academic papers, policy documents,
and high-quality web content. 1,000 free searches/month.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "exa_search",
    "description": (
        "Neural search engine that finds high-quality academic papers, policy documents, "
        "and web content. Better than keyword search for research queries — understands "
        "meaning and context. Returns URLs, titles, and optional full-text extracts."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query":           {"type": "string", "description": "Natural language search query"},
            "num_results":     {"type": "integer", "description": "Number of results (default 10)", "default": 10},
            "use_autoprompt":  {"type": "boolean", "description": "Let Exa optimize the query (default true)", "default": True},
            "include_text":    {"type": "boolean", "description": "Include page text in results (default false)", "default": False},
            "type":            {"type": "string", "enum": ["neural", "keyword", "auto"], "description": "Search type (default auto)", "default": "auto"},
        },
        "required": ["query"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    query = inputs.get("query", "")
    if not query:
        return _error("query is required")

    api_key = _get_setting("exa_api_key")
    if not api_key:
        return _error("exa_api_key not configured in settings")

    body = {
        "query": query,
        "numResults": inputs.get("num_results", 10),
        "useAutoprompt": inputs.get("use_autoprompt", True),
        "type": inputs.get("type", "auto"),
    }
    if inputs.get("include_text"):
        body["contents"] = {"text": True}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.post(
                "https://api.exa.ai/search",
                json=body,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            )
            r.raise_for_status()
            data = r.json()

        results = []
        for item in data.get("results", []):
            entry = {
                "title": item.get("title", ""),
                "url":   item.get("url", ""),
                "score": item.get("score", 0),
            }
            if "text" in item:
                entry["text"] = item["text"][:1000]
            results.append(entry)

        return {"results": results, "total": len(results), "query": query}

    except Exception as exc:
        logger.error("[exa_search] %s", exc)
        return _error(str(exc))
