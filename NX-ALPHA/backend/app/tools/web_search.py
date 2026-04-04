"""
Web search tools for the interface agent.

Search priority chain (inside `search()`):
  1. Qdrant semantic cache   — instant, no network (if Qdrant is running)
  2. SearxNG                 — multi-engine (Google, Bing, DDG, Brave) via local Docker
  3. DuckDuckGo text         — fallback if SearxNG unavailable / returns empty
  4. DuckDuckGo news         — final fallback if text search also returns empty

`image_search()` and `news_search()` use DuckDuckGo directly (unchanged).
"""

import asyncio
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


def _get_ddgs():
    """Import DDGS from whichever package name is installed."""
    try:
        from ddgs import DDGS
        return DDGS
    except ImportError:
        from duckduckgo_search import DDGS
        return DDGS


# ── SearxNG ───────────────────────────────────────────────────────────────────

async def _searxng_search(query: str, max_results: int) -> list[dict]:
    """Query local SearxNG instance. Returns [] on any failure."""
    try:
        from app.config import get_settings
        cfg = get_settings().search
        url = f"{cfg.searxng_url}/search"
        params = {
            "q": query,
            "format": "json",
            "categories": "general",
            "language": "en",
            "safesearch": "0",
        }
        async with httpx.AsyncClient(timeout=cfg.searxng_timeout_s) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        raw = data.get("results", [])[:max_results]
        results = [
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": r.get("content", ""),
                "source": r.get("engine", "searxng"),
            }
            for r in raw
            if r.get("url")
        ]
        logger.info("[searxng] %r → %d results", query[:60], len(results))
        return results
    except Exception as exc:
        logger.warning("[searxng] unavailable for %r: %s", query[:60], exc)
        return []


# ── DuckDuckGo fallbacks ──────────────────────────────────────────────────────

async def _ddg_text(query: str, max_results: int) -> list[dict]:
    def _run() -> list[dict]:
        DDGS = _get_ddgs()
        results = []
        with DDGS() as ddgs:
            for item in ddgs.text(query, max_results=max_results):
                results.append({
                    "title": item.get("title", ""),
                    "url": item.get("href", ""),
                    "snippet": item.get("body", ""),
                    "source": item.get("source", "duckduckgo"),
                })
        return results
    try:
        results = await asyncio.to_thread(_run)
        logger.info("[ddg-text] %r → %d results", query[:60], len(results))
        return results
    except Exception as exc:
        logger.warning("[ddg-text] failed for %r: %s", query[:60], exc)
        return []


async def _ddg_news(query: str, max_results: int) -> list[dict]:
    def _run() -> list[dict]:
        DDGS = _get_ddgs()
        results = []
        with DDGS() as ddgs:
            for item in ddgs.news(query, max_results=max_results):
                results.append({
                    "title": item.get("title", ""),
                    "url": item.get("url", item.get("href", "")),
                    "snippet": item.get("body", ""),
                    "source": item.get("source", "duckduckgo-news"),
                })
        return results
    try:
        results = await asyncio.to_thread(_run)
        logger.info("[ddg-news] %r → %d results", query[:60], len(results))
        return results
    except Exception as exc:
        logger.warning("[ddg-news] failed for %r: %s", query[:60], exc)
        return []


# ── Public API ────────────────────────────────────────────────────────────────

async def search(query: str, max_results: int = 8) -> list[dict]:
    """
    Web search with tiered fallback chain.

    Priority: Qdrant cache → SearxNG → DuckDuckGo text → DuckDuckGo news.

    Returns
    -------
    list[dict]
        Each item: title, url, snippet, source.  Returns [] on total failure.
    """
    logger.debug("[search] query=%r max=%d", query, max_results)

    # 1. Qdrant semantic cache
    try:
        from app.config import get_settings
        if get_settings().search.qdrant_enabled:
            from app.service.qdrant_service import get_qdrant_service
            cached = await get_qdrant_service().search_cache(query)
            if cached:
                return cached
    except Exception as exc:
        logger.debug("[search] qdrant cache check skipped: %s", exc)

    # 2. SearxNG
    results = await _searxng_search(query, max_results)

    # 3. DDG text fallback
    if not results:
        logger.info("[search] SearxNG empty, trying DDG text for %r", query[:60])
        results = await _ddg_text(query, max_results)

    # 4. DDG news fallback
    if not results:
        logger.info("[search] DDG text empty, trying DDG news for %r", query[:60])
        results = await _ddg_news(query, max_results)

    # 5. Store in Qdrant cache (fire and forget)
    if results:
        try:
            from app.config import get_settings
            if get_settings().search.qdrant_enabled:
                from app.service.qdrant_service import get_qdrant_service
                asyncio.create_task(
                    get_qdrant_service().store_results(query, results)
                )
        except Exception:
            pass

    return results


async def _searxng_image_search(query: str, max_results: int) -> list[dict]:
    """Query SearxNG for images. Returns [] on any failure."""
    try:
        from app.config import get_settings
        cfg = get_settings().search
        url = f"{cfg.searxng_url}/search"
        params = {
            "q": query,
            "format": "json",
            "categories": "images",
            "language": "en",
            "safesearch": "0",
        }
        # Image searches return large payloads — use a longer timeout than text searches
        image_timeout = max(cfg.searxng_timeout_s, 10.0)
        async with httpx.AsyncClient(timeout=image_timeout) as client:
            resp = await client.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()

        raw = data.get("results", [])[:max_results]
        results = []
        for r in raw:
            img_url = r.get("img_src") or r.get("thumbnail_src") or r.get("url", "")
            if img_url and img_url.startswith("http"):
                results.append({
                    "url": img_url,
                    "title": r.get("title", ""),
                    "source": r.get("url", ""),
                })
        logger.info("[searxng-images] %r → %d results", query[:60], len(results))
        return results
    except Exception as exc:
        logger.warning("[searxng-images] failed for %r: %s (%s)", query[:60], repr(exc), type(exc).__name__)
        return []


async def image_search(query: str, max_results: int = 3) -> list[dict]:
    """
    Search for images. Tries SearxNG first, falls back to DuckDuckGo.

    Returns
    -------
    list[dict]
        Each item contains: url (direct image URL), title, source.
        Returns [] on any failure.
    """
    logger.debug("Image search query: %r", query)

    # 1. Try SearxNG images
    results = await _searxng_image_search(query, max_results)
    if results:
        return results

    # 2. Fall back to DDG images
    def _run() -> list[dict]:
        DDGS = _get_ddgs()
        items = []
        with DDGS() as ddgs:
            for item in ddgs.images(query, max_results=max_results):
                url = item.get("image", "")
                if url and url.startswith("http"):
                    items.append({
                        "url": url,
                        "title": item.get("title", ""),
                        "source": item.get("url", ""),
                    })
        return items

    try:
        results = await asyncio.to_thread(_run)
        logger.info("Image search for %r returned %d results", query, len(results))
        return results
    except Exception as exc:
        logger.warning("Image search failed for query %r: %s", query, exc)
        return []


async def news_search(query: str, max_results: int = 8) -> list[dict]:
    """
    Perform a DuckDuckGo news search.

    Returns
    -------
    list[dict]
        Each item contains: title, url, snippet, source, date.
        Returns [] on any failure.
    """
    logger.debug("News search query: %r", query)

    def _run() -> list[dict]:
        DDGS = _get_ddgs()
        results = []
        with DDGS() as ddgs:
            for item in ddgs.news(query, max_results=max_results):
                results.append({
                    "title": item.get("title", ""),
                    "url": item.get("url", ""),
                    "snippet": item.get("body", ""),
                    "source": item.get("source", ""),
                    "date": item.get("date", ""),
                })
        return results

    try:
        results = await asyncio.to_thread(_run)
        logger.info("News search for %r returned %d results", query, len(results))
        return results
    except Exception as exc:
        logger.warning("News search failed for query %r: %s", query, exc)
        return []


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "web_search",
    "description": "Web, image, and news search. Uses SearxNG with DuckDuckGo fallback.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation":   {"type": "string", "enum": ["search", "image_search", "news_search"], "description": "Search type (default: search)"},
            "query":       {"type": "string", "description": "Search query"},
            "max_results": {"type": "integer", "description": "Max results to return (default 8)"},
        },
        "required": ["query"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    op  = inputs.get("operation", "search")
    q   = inputs.get("query", "")
    n   = int(inputs.get("max_results", 8))
    if not q:
        return {"error": "query is required"}
    if op == "image_search":
        return {"results": await image_search(q, n)}
    elif op == "news_search":
        return {"results": await news_search(q, n)}
    else:
        return {"results": await search(q, n)}
