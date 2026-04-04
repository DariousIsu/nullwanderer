"""
lightrag_tool.py
────────────────
AURA MCP tool — LightRAG document ingestion and graph-enhanced RAG retrieval.

Operations:
  ingest  — feed text into LightRAG; entity/relation extraction → Neo4j graph
  query   — retrieve from the knowledge graph (local/global/hybrid/naive modes)
  status  — queue depth and initialization state
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

# ── Tool definition ───────────────────────────────────────────────────────────
TOOL_DEF = {
    "name": "lightrag",
    "description": (
        "Ingest documents into AURA's knowledge graph and query with relational "
        "understanding. Modes: local (entity traversal), global (themes), hybrid (both)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["ingest", "query", "status"],
                "description": "ingest: add text to graph | query: retrieve | status: queue info",
            },
            "text": {
                "type": "string",
                "description": "Text to ingest (required for operation=ingest)",
            },
            "source_id": {
                "type": "string",
                "description": "Unique identifier for the document (used for deduplication)",
            },
            "source_type": {
                "type": "string",
                "enum": ["document", "skill", "legislation", "conversation", "knowledge", "tool"],
                "description": "Category of the source being ingested",
                "default": "document",
            },
            "query": {
                "type": "string",
                "description": "Question to ask the knowledge graph (required for operation=query)",
            },
            "mode": {
                "type": "string",
                "enum": ["hybrid", "local", "global", "naive"],
                "description": "Retrieval mode: hybrid (recommended), local, global, naive",
                "default": "hybrid",
            },
        },
        "required": ["operation"],
    },
    "expose_components": ["tool-workspace"],
}


# ── Tool handler ──────────────────────────────────────────────────────────────
async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "status")

    # Lazy import to avoid circular deps at startup
    from app.service.lightrag_service import LightRAGService
    svc = LightRAGService.get_instance()

    if operation == "status":
        return svc.index_status()

    if operation == "ingest":
        text = inputs.get("text", "").strip()
        if not text:
            return {"success": False, "error": "text is required for ingest"}
        source_id   = inputs.get("source_id") or f"manual_{hash(text) & 0xFFFFFF:06x}"
        source_type = inputs.get("source_type", "document")
        return await svc.ingest_document(text, source_id=source_id, source_type=source_type)

    if operation == "query":
        query_text = inputs.get("query", "").strip()
        if not query_text:
            return {"success": False, "error": "query is required for query operation"}
        mode = inputs.get("mode", "hybrid")
        return await svc.query(query_text, mode=mode)

    return {"success": False, "error": f"Unknown operation: {operation}"}
