"""
Knowledge Search — MCP tool wrapper.

Wraps AURA's local FTS5 knowledge indices (Wikipedia, PubMed, arXiv,
Stack Exchange, Gutenberg). No external API — queries local SQLite databases.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "knowledge_search",
    "description": (
        "Search AURA's local knowledge databases: Wikipedia (7M+ articles), "
        "PubMed (40M abstracts), arXiv (metadata), Stack Exchange (all sites), "
        "and Project Gutenberg (full text). All data is stored locally — no internet required. "
        "Returns ranked results with title, snippet, and source."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "sources": {
                "type": "array",
                "items": {"type": "string", "enum": ["wikipedia", "pubmed", "arxiv", "stackexchange", "gutenberg"]},
                "description": "Which knowledge sources to search. Omit for auto-routing based on query content.",
            },
            "limit": {"type": "integer", "description": "Max results per source (default 10)", "default": 10},
        },
        "required": ["query"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    query   = inputs.get("query", "")
    sources = inputs.get("sources")
    limit   = inputs.get("limit", 10)

    if not query:
        return {"error": "query is required"}

    try:
        if sources:
            # Direct multi-source search
            from app.knowledge.local_search import multi_search
            raw = await multi_search(query, sources=sources, limit=limit)
        else:
            # Auto-route based on query content (legal → legal stream, science → pubmed/arxiv, etc.)
            from app.knowledge.router import route
            raw = await route(query)

        if isinstance(raw, str):
            return {"results": [{"content": raw, "source": "auto"}], "total": 1, "query": query}

        if isinstance(raw, list):
            results = []
            for item in raw[:limit]:
                if isinstance(item, dict):
                    results.append({
                        "title":   item.get("title", ""),
                        "snippet": (item.get("content", "") or item.get("snippet", ""))[:500],
                        "source":  item.get("source", "unknown"),
                        "score":   item.get("score", 0),
                        "url":     item.get("url", ""),
                    })
                elif isinstance(item, str):
                    results.append({"content": item[:500], "source": "unknown"})
            return {"results": results, "total": len(results), "query": query}

        return {"results": [{"content": str(raw)[:1000]}], "total": 1, "query": query}

    except Exception as exc:
        logger.error("[knowledge_mcp] %s", exc)
        return {"error": str(exc)}
