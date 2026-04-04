"""
Legislation Search — MCP tool wrapper.

Wraps AURA's legislation_service for bill search, details, and trend data.
Free, no API key — queries local FTS5 SQLite database.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "legislation_search",
    "description": (
        "Search US federal and state legislation. Returns bills matching a query "
        "with title, summary, status, sponsors, and last action date. "
        "Use for policy research, regulatory monitoring, and legislative tracking."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query":  {"type": "string", "description": "Search terms for bills/legislation"},
            "limit":  {"type": "integer", "description": "Max results (default 20)", "default": 20},
            "state":  {"type": "string", "description": "Two-letter state code to filter (e.g. 'CA', 'NY'). Omit for federal."},
            "status": {"type": "string", "description": "Filter by status: 'introduced', 'passed', 'enacted', 'vetoed'"},
            "year":   {"type": "integer", "description": "Filter to bills active in this year (e.g. 2025). Use for 'this session' / 'current year' queries."},
        },
        "required": ["query"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    query  = inputs.get("query", "")
    limit  = inputs.get("limit", 20)
    state  = inputs.get("state")
    status = inputs.get("status")
    year   = inputs.get("year")

    if not query:
        return {"error": "query is required"}

    try:
        from app.service.legislation_service import get_legislation_service
        svc = get_legislation_service()
        if not svc:
            return {"error": "Legislation service not available"}

        results = svc.search_bills(
            query=query,
            limit=limit,
            state=state,
            status=status,
            year=year,
        )

        bills = []
        for bill in (results if isinstance(results, list) else results.get("bills", [])):
            if isinstance(bill, dict):
                bill_id      = bill.get("id", "")
                bill_title   = bill.get("title", "")
                bill_summary = bill.get("summary", "")
                bills.append({
                    "id":          bill_id,
                    "title":       bill_title,
                    "summary":     bill_summary[:500],
                    "status":      bill.get("status", ""),
                    "sponsors":    bill.get("sponsors", []),
                    "state":       bill.get("state", ""),
                    "last_action": bill.get("last_action_date", ""),
                    "url":         bill.get("url", ""),
                })
                # Absorb bill content into LightRAG knowledge graph (non-blocking)
                if bill_id and bill_summary:
                    bill_text = f"Legislation: {bill_title}\nID: {bill_id}\n{bill_summary}"
                    try:
                        from app.service.lightrag_service import LightRAGService
                        LightRAGService.get_instance().enqueue_ingest(
                            bill_text, f"bill:{bill_id}", "legislation"
                        )
                    except Exception as _lg_exc:
                        import logging as _lg; _lg.getLogger(__name__).debug("[legislation_mcp] LightRAG enqueue failed: %s", _lg_exc)

        return {"bills": bills[:limit], "total": len(bills), "query": query}

    except Exception as exc:
        logger.error("[legislation_mcp] %s", exc)
        return {"error": str(exc)}
