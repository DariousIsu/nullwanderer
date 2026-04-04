"""
sanity_tool.py
───────────────
AURA MCP tool — Sanity CMS content operations via GROQ queries.

Read and manage content in Sanity CMS datasets via GROQ queries and
the Content Lake API. Supports filtering, projection, and references.

Requires: set AURA_SANITY_PROJECT_ID, AURA_SANITY_DATASET, AURA_SANITY_API_TOKEN in .env
Get token: https://sanity.io/manage → API → Tokens
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "sanity",
    "description": (
        "Sanity CMS content operations via GROQ query language. "
        "Operations: query (run GROQ query), get_document (by ID), "
        "list_types (schema document types). "
        "GROQ example: *[_type == 'post' && published == true]{title, slug, body}. "
        "Useful for reading/analyzing CMS content without the Sanity Studio UI."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["query", "get_document", "list_types"],
                "description": "Operation to perform",
            },
            "groq": {
                "type": "string",
                "description": "GROQ query string (for query), e.g. '*[_type == \"post\"]{title, slug}'",
            },
            "document_id": {
                "type": "string",
                "description": "Document ID (for get_document)",
            },
            "params": {
                "type": "object",
                "description": "GROQ query parameters (for parameterized queries)",
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")

    import os
    try:
        from app.tools._mcp_wrapper import _get_setting
        project_id = _get_setting("sanity_project_id") or os.environ.get("AURA_SANITY_PROJECT_ID", "")
        dataset    = _get_setting("sanity_dataset") or os.environ.get("AURA_SANITY_DATASET", "production")
        api_token  = _get_setting("sanity_api_token") or os.environ.get("AURA_SANITY_API_TOKEN", "")
    except Exception:
        project_id = os.environ.get("AURA_SANITY_PROJECT_ID", "")
        dataset    = os.environ.get("AURA_SANITY_DATASET", "production")
        api_token  = os.environ.get("AURA_SANITY_API_TOKEN", "")

    if not project_id:
        return {
            "error": "Sanity project ID not configured",
            "hint":  "Set AURA_SANITY_PROJECT_ID (and AURA_SANITY_DATASET, AURA_SANITY_API_TOKEN) in .env",
        }

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    api_version = "2024-01-01"
    base        = f"https://{project_id}.api.sanity.io/v{api_version}/data"
    headers     = {}
    if api_token:
        headers["Authorization"] = f"Bearer {api_token}"

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            if operation == "query":
                groq   = inputs.get("groq", "")
                params = inputs.get("params", {})
                if not groq:
                    return {"error": "groq query required"}
                query_params = {"query": groq}
                for k, v in params.items():
                    query_params[f"${k}"] = str(v)
                resp = await client.get(
                    f"{base}/query/{dataset}",
                    headers=headers,
                    params=query_params,
                )
                resp.raise_for_status()
                data = resp.json()
                return {
                    "result": data.get("result", []),
                    "count":  len(data.get("result", [])) if isinstance(data.get("result"), list) else 1,
                }

            elif operation == "get_document":
                doc_id = inputs.get("document_id", "")
                if not doc_id:
                    return {"error": "document_id required"}
                resp = await client.get(
                    f"{base}/doc/{dataset}/{doc_id}",
                    headers=headers,
                )
                resp.raise_for_status()
                return resp.json().get("documents", [{}])[0]

            elif operation == "list_types":
                resp = await client.get(
                    f"{base}/query/{dataset}",
                    headers=headers,
                    params={"query": "array::unique(*[]._type)"},
                )
                resp.raise_for_status()
                types = resp.json().get("result", [])
                return {"types": sorted(types), "count": len(types)}

    except Exception as exc:
        logger.error("[sanity_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}

    return {"error": f"Unknown operation: {operation}"}
