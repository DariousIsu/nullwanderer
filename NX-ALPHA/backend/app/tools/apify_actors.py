"""
Apify Actors — MCP tool wrapper.

Run any of 10,000+ pre-built web scrapers. Free tier available.
Useful for domain-specific scraping (e-commerce, social media, etc.)
that Playwright can't handle cleanly.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://api.apify.com/v2"

TOOL_DEF = {
    "name": "apify",
    "description": (
        "Run pre-built web scrapers from Apify's library of 10,000+ actors. "
        "Handles domain-specific scraping (Amazon, LinkedIn, Instagram, Google Maps, etc.) "
        "with anti-bot handling built in. Also scrapes arbitrary URLs."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action":   {"type": "string", "enum": ["run_actor", "search_actors", "web_scrape"], "description": "Apify action"},
            "actor_id": {"type": "string", "description": "Actor ID (e.g. 'apify/web-scraper') for run_actor"},
            "input":    {"type": "object", "description": "Actor input JSON (for run_actor)"},
            "query":    {"type": "string", "description": "Search query (for search_actors) or URL (for web_scrape)"},
            "limit":    {"type": "integer", "default": 10},
        },
        "required": ["action"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    action  = inputs.get("action", "")
    api_key = _get_setting("apify_api_key")
    if not api_key:
        return _error("apify_api_key not configured")

    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=60.0, headers=headers) as client:

            if action == "search_actors":
                query = inputs.get("query", "")
                if not query:
                    return _error("query required for search_actors")
                r = await client.get(f"{_BASE}/store", params={"search": query, "limit": inputs.get("limit", 10)})
                r.raise_for_status()
                data = r.json()
                actors = [{"id": a["id"], "name": a.get("name", ""), "title": a.get("title", ""), "description": a.get("description", "")[:200], "runs": a.get("stats", {}).get("totalRuns", 0)} for a in data.get("data", {}).get("items", [])]
                return {"actors": actors, "total": len(actors)}

            elif action == "run_actor":
                actor_id = inputs.get("actor_id", "")
                if not actor_id:
                    return _error("actor_id required")
                actor_input = inputs.get("input", {})
                r = await client.post(f"{_BASE}/acts/{actor_id}/runs", json=actor_input, params={"waitForFinish": 120})
                r.raise_for_status()
                run = r.json().get("data", {})
                dataset_id = run.get("defaultDatasetId")
                if dataset_id:
                    dr = await client.get(f"{_BASE}/datasets/{dataset_id}/items", params={"limit": inputs.get("limit", 10)})
                    if dr.status_code == 200:
                        return {"items": dr.json()[:inputs.get("limit", 10)], "run_id": run.get("id"), "status": run.get("status")}
                return {"run_id": run.get("id"), "status": run.get("status"), "note": "Run started, check results later"}

            elif action == "web_scrape":
                url = inputs.get("query", "")
                if not url:
                    return _error("query (URL) required for web_scrape")
                r = await client.post(f"{_BASE}/acts/apify~web-scraper/runs", json={"startUrls": [{"url": url}], "maxPagesPerCrawl": 1}, params={"waitForFinish": 60})
                r.raise_for_status()
                run = r.json().get("data", {})
                dataset_id = run.get("defaultDatasetId")
                if dataset_id:
                    dr = await client.get(f"{_BASE}/datasets/{dataset_id}/items", params={"limit": 1})
                    if dr.status_code == 200:
                        items = dr.json()
                        return {"url": url, "content": items[0].get("text", "")[:3000] if items else "", "status": "complete"}
                return {"url": url, "status": run.get("status")}

            return _error(f"Unknown action: {action}")

    except Exception as exc:
        logger.error("[apify_actors] %s", exc)
        return _error(str(exc))
