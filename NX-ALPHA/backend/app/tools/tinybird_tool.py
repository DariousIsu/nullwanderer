"""
tinybird_tool.py
─────────────────
AURA MCP tool — Tinybird real-time analytics API.

Query Tinybird data sources and published API endpoints.
Tinybird is a fast analytics platform built on ClickHouse.

Requires API key: set AURA_TINYBIRD_API_KEY in .env
Get key: https://tinybird.co (Workspace → Tokens)
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "tinybird",
    "description": (
        "Query Tinybird real-time analytics data. "
        "Operations: query_sql (run SQL on any data source), "
        "call_pipe (call a published API endpoint/pipe), "
        "list_datasources (available data sources), "
        "list_pipes (published API endpoints). "
        "Tinybird is ClickHouse-backed — supports fast aggregations over large event datasets."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["query_sql", "call_pipe", "list_datasources", "list_pipes"],
                "description": "Operation to perform",
            },
            "sql": {
                "type": "string",
                "description": "SQL query string (for query_sql). Uses ClickHouse SQL dialect.",
            },
            "pipe_name": {
                "type": "string",
                "description": "Pipe/endpoint name to call (for call_pipe)",
            },
            "params": {
                "type": "object",
                "description": "Query parameters to pass to the pipe (for call_pipe)",
            },
            "limit": {
                "type": "integer",
                "description": "Max rows (for query_sql, default: 100)",
                "default": 100,
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")

    try:
        from app.tools._mcp_wrapper import _get_setting
        api_key = _get_setting("tinybird_api_key") or ""
    except Exception:
        import os
        api_key = os.environ.get("AURA_TINYBIRD_API_KEY", "")

    if not api_key:
        return {
            "error": "Tinybird API key not configured",
            "hint":  "Set AURA_TINYBIRD_API_KEY in .env",
        }

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    base    = "https://api.tinybird.co/v0"
    headers = {"Authorization": f"Bearer {api_key}"}

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            if operation == "list_datasources":
                resp = await client.get(f"{base}/datasources", headers=headers)
                resp.raise_for_status()
                data = resp.json().get("datasources", [])
                return {"datasources": [{"name": d["name"], "rows": d.get("statistics", {}).get("row_count", 0)} for d in data]}

            elif operation == "list_pipes":
                resp = await client.get(f"{base}/pipes", headers=headers)
                resp.raise_for_status()
                data = resp.json().get("pipes", [])
                return {"pipes": [{"name": p["name"], "description": p.get("description", ""), "type": p.get("type", "")} for p in data]}

            elif operation == "query_sql":
                sql   = inputs.get("sql", "").strip()
                limit = int(inputs.get("limit", 100))
                if not sql:
                    return {"error": "sql required"}
                if "LIMIT" not in sql.upper():
                    sql = f"{sql.rstrip(';')} LIMIT {limit}"
                resp = await client.get(
                    f"{base}/sql",
                    headers=headers,
                    params={"q": sql},
                )
                resp.raise_for_status()
                data = resp.json()
                return {
                    "data":    data.get("data", []),
                    "meta":    data.get("meta", []),
                    "rows":    data.get("rows", 0),
                    "elapsed": data.get("statistics", {}).get("elapsed", 0),
                }

            elif operation == "call_pipe":
                pipe_name = inputs.get("pipe_name", "")
                params    = inputs.get("params", {})
                if not pipe_name:
                    return {"error": "pipe_name required"}
                resp = await client.get(
                    f"{base}/pipes/{pipe_name}.json",
                    headers=headers,
                    params=params,
                )
                resp.raise_for_status()
                data = resp.json()
                return {
                    "data":  data.get("data", []),
                    "rows":  data.get("rows", 0),
                    "meta":  data.get("meta", []),
                }

    except Exception as exc:
        logger.error("[tinybird_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}

    return {"error": f"Unknown operation: {operation}"}
