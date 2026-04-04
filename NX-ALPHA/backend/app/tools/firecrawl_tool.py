"""
firecrawl_tool.py
──────────────────
AURA MCP tool — Web scraping, crawling, and site mapping via Firecrawl.

Operations: scrape (single URL), crawl (full site), map (URL discovery).
Returns clean Markdown output from any URL. Handles JS-rendered pages,
auth flows, and custom extraction schemas.

Requires API key: set AURA_FIRECRAWL_API_KEY in .env
Get key: https://firecrawl.dev
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "firecrawl",
    "description": (
        "Web scraping and crawling via Firecrawl. "
        "Operations: scrape (get clean Markdown from any URL, handles JS), "
        "crawl (crawl entire site, returns all pages as Markdown), "
        "map (discover all URLs on a site). "
        "Better than raw HTTP for JS-heavy sites, paywalled content, and structured extraction."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["scrape", "crawl", "map"],
                "description": "Operation: scrape (1 page), crawl (full site), map (URL list)",
            },
            "url": {
                "type": "string",
                "description": "URL to scrape/crawl/map",
            },
            "limit": {
                "type": "integer",
                "description": "Max pages for crawl/map (default: 50)",
                "default": 50,
            },
            "formats": {
                "type": "array",
                "items": {"type": "string", "enum": ["markdown", "html", "rawHtml", "screenshot", "links"]},
                "description": "Output formats for scrape (default: ['markdown'])",
                "default": ["markdown"],
            },
        },
        "required": ["operation", "url"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "scrape")
    url       = inputs.get("url", "").strip()
    limit     = int(inputs.get("limit", 50))
    formats   = inputs.get("formats", ["markdown"])

    if not url:
        return {"error": "url is required"}

    try:
        from app.tools._mcp_wrapper import _get_setting
        api_key = _get_setting("firecrawl_api_key")
    except Exception:
        import os
        api_key = os.environ.get("AURA_FIRECRAWL_API_KEY", "")

    if not api_key:
        return {
            "error": "Firecrawl API key not configured",
            "hint":  "Set AURA_FIRECRAWL_API_KEY in .env or via Settings",
        }

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    base = "https://api.firecrawl.dev/v1"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            if operation == "scrape":
                resp = await client.post(
                    f"{base}/scrape",
                    headers=headers,
                    json={"url": url, "formats": formats},
                )
                resp.raise_for_status()
                data = resp.json()
                markdown_content = data.get("data", {}).get("markdown", "")
                # Absorb scraped content into LightRAG knowledge graph (non-blocking)
                if markdown_content and len(markdown_content) > 200:
                    try:
                        from app.service.lightrag_service import LightRAGService
                        LightRAGService.get_instance().enqueue_ingest(
                            markdown_content, url, "document"
                        )
                    except Exception as _lg_exc:
                        import logging as _lg; _lg.getLogger(__name__).debug("[firecrawl] LightRAG enqueue failed: %s", _lg_exc)
                return {
                    "url":      url,
                    "markdown": markdown_content,
                    "metadata": data.get("data", {}).get("metadata", {}),
                }

            elif operation == "crawl":
                resp = await client.post(
                    f"{base}/crawl",
                    headers=headers,
                    json={"url": url, "limit": limit, "scrapeOptions": {"formats": ["markdown"]}},
                )
                resp.raise_for_status()
                job = resp.json()
                job_id = job.get("id", "")
                # Poll for completion (max 60s)
                import asyncio
                for _ in range(30):
                    await asyncio.sleep(2)
                    status_resp = await client.get(f"{base}/crawl/{job_id}", headers=headers)
                    status_data = status_resp.json()
                    if status_data.get("status") == "completed":
                        pages = status_data.get("data", [])
                        return {
                            "url":   url,
                            "pages": [{"url": p.get("metadata", {}).get("url", ""), "markdown": p.get("markdown", "")[:500]} for p in pages],
                            "count": len(pages),
                        }
                    if status_data.get("status") == "failed":
                        return {"error": "Crawl job failed", "details": status_data}
                return {"error": "Crawl timed out — check Firecrawl dashboard for job status", "job_id": job_id}

            elif operation == "map":
                resp = await client.post(
                    f"{base}/map",
                    headers=headers,
                    json={"url": url, "limit": limit},
                )
                resp.raise_for_status()
                data = resp.json()
                return {"url": url, "links": data.get("links", []), "count": len(data.get("links", []))}

    except Exception as exc:
        logger.error("[firecrawl_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}
