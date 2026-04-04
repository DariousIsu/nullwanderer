"""
clickhouse_tool.py
───────────────────
AURA MCP tool — ClickHouse query execution and table management.

Execute analytical SQL queries against ClickHouse over the HTTP interface.
ClickHouse excels at time-series aggregations, log analytics, and event data.

No API key required for self-hosted. Configure via .env:
  AURA_CLICKHOUSE_HOST=localhost
  AURA_CLICKHOUSE_PORT=8123
  AURA_CLICKHOUSE_USER=default
  AURA_CLICKHOUSE_PASSWORD=
  AURA_CLICKHOUSE_DATABASE=default
"""

from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "clickhouse",
    "description": (
        "Execute SQL queries against ClickHouse analytical database. "
        "Operations: query (run SELECT, any analytics SQL), "
        "list_tables (show tables in database), "
        "describe_table (schema of a specific table), "
        "insert (insert rows as JSON). "
        "ClickHouse SQL dialect: supports ARRAY JOIN, window functions, AggregateFunction types, "
        "materialized views, and 100+ analytical functions."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["query", "list_tables", "describe_table", "insert"],
                "description": "Operation to perform",
            },
            "sql": {
                "type": "string",
                "description": "SQL query to execute (for query)",
            },
            "table": {
                "type": "string",
                "description": "Table name (for describe_table, insert)",
            },
            "database": {
                "type": "string",
                "description": "Database name (default: from config)",
            },
            "rows": {
                "type": "array",
                "items": {"type": "object"},
                "description": "Array of row objects to insert (for insert)",
            },
            "limit": {
                "type": "integer",
                "description": "Max rows for query results (default: 100)",
                "default": 100,
            },
        },
        "required": ["operation"],
    },
}


def _cfg(key: str, default: str = "") -> str:
    try:
        from app.tools._mcp_wrapper import _get_setting
        val = _get_setting(f"clickhouse_{key}")
        return val or os.environ.get(f"AURA_CLICKHOUSE_{key.upper()}", default)
    except Exception:
        return os.environ.get(f"AURA_CLICKHOUSE_{key.upper()}", default)


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")
    host      = _cfg("host", "localhost")
    port      = _cfg("port", "8123")
    user      = _cfg("user", "default")
    password  = _cfg("password", "")
    database  = inputs.get("database") or _cfg("database", "default")

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    base    = f"http://{host}:{port}"
    params  = {"user": user, "database": database}
    if password:
        params["password"] = password

    limit = int(inputs.get("limit", 100))

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            async def _run_sql(sql: str, fmt: str = "JSON") -> dict:
                resp = await client.post(
                    base,
                    params={**params, "default_format": fmt},
                    content=sql.encode(),
                    headers={"Content-Type": "text/plain"},
                )
                resp.raise_for_status()
                if fmt == "JSON":
                    return resp.json()
                return {"raw": resp.text[:5000]}

            if operation == "list_tables":
                result = await _run_sql(f"SHOW TABLES FROM {database}")
                return {"tables": [row.get("name", "") for row in result.get("data", [])]}

            elif operation == "describe_table":
                table = inputs.get("table", "")
                if not table:
                    return {"error": "table required"}
                result = await _run_sql(f"DESCRIBE TABLE {database}.{table}")
                return {"columns": result.get("data", [])}

            elif operation == "query":
                sql = inputs.get("sql", "").strip()
                if not sql:
                    return {"error": "sql required"}
                if "LIMIT" not in sql.upper() and sql.upper().startswith("SELECT"):
                    sql = f"{sql.rstrip(';')} LIMIT {limit}"
                result = await _run_sql(sql)
                return {
                    "data":      result.get("data", []),
                    "meta":      result.get("meta", []),
                    "rows_read": result.get("statistics", {}).get("rows_read", 0),
                    "elapsed":   result.get("statistics", {}).get("elapsed", 0),
                }

            elif operation == "insert":
                table = inputs.get("table", "")
                rows  = inputs.get("rows", [])
                if not table or not rows:
                    return {"error": "table and rows required"}
                import json
                ndjson = "\n".join(json.dumps(r) for r in rows)
                resp   = await client.post(
                    base,
                    params={**params, "query": f"INSERT INTO {database}.{table} FORMAT JSONEachRow"},
                    content=ndjson.encode(),
                    headers={"Content-Type": "text/plain"},
                )
                resp.raise_for_status()
                return {"success": True, "inserted": len(rows)}

    except Exception as exc:
        logger.error("[clickhouse_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}

    return {"error": f"Unknown operation: {operation}"}
