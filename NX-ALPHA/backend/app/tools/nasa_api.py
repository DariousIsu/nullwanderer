"""
NASA — MCP tool wrapper.

Search NASA's Image and Video Library + Astronomy Picture of the Day.
Free API key from api.nasa.gov. Also works without key (DEMO_KEY, 30 req/hr).
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "nasa",
    "description": (
        "Search NASA's media library for images and videos of space, Earth science, "
        "and technology. Also provides Astronomy Picture of the Day (APOD). "
        "Free API — works with DEMO_KEY at reduced rate."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["search", "apod"], "description": "'search' for media library, 'apod' for picture of the day", "default": "search"},
            "query":  {"type": "string", "description": "Search terms (for action=search)"},
            "limit":  {"type": "integer", "description": "Max results (default 10)", "default": 10},
            "date":   {"type": "string", "description": "Date for APOD (YYYY-MM-DD, default today)"},
        },
        "required": [],
    },
}


async def tool_handler(inputs: dict) -> dict:
    action  = inputs.get("action", "search")
    api_key = _get_setting("nasa_api_key") or "DEMO_KEY"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:

            if action == "apod":
                params = {"api_key": api_key}
                if inputs.get("date"):
                    params["date"] = inputs["date"]
                r = await client.get("https://api.nasa.gov/planetary/apod", params=params)
                r.raise_for_status()
                data = r.json()
                return {
                    "title":       data.get("title", ""),
                    "explanation": data.get("explanation", ""),
                    "url":         data.get("hdurl") or data.get("url", ""),
                    "date":        data.get("date", ""),
                    "media_type":  data.get("media_type", ""),
                }

            # Default: media library search
            query = inputs.get("query", "")
            if not query:
                return _error("query is required for search action")

            params = {"q": query, "page_size": inputs.get("limit", 10)}
            r = await client.get("https://images-api.nasa.gov/search", params=params)
            r.raise_for_status()
            data = r.json()

            items = []
            for item in data.get("collection", {}).get("items", []):
                meta = item.get("data", [{}])[0] if item.get("data") else {}
                links = item.get("links", [{}])
                thumb = links[0].get("href", "") if links else ""
                items.append({
                    "title":       meta.get("title", ""),
                    "description": meta.get("description", "")[:300],
                    "date":        meta.get("date_created", ""),
                    "nasa_id":     meta.get("nasa_id", ""),
                    "media_type":  meta.get("media_type", ""),
                    "thumbnail":   thumb,
                })

            return {"results": items, "total": len(items), "query": query}

    except Exception as exc:
        logger.error("[nasa_api] %s", exc)
        return _error(str(exc))
