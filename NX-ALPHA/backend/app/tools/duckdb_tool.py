"""
duckdb_tool.py
───────────────
AURA MCP tool — SQL analytics over local CSV/Parquet/JSON via DuckDB.

DuckDB runs entirely in-process — no server required. Query any local
data file directly with standard SQL. Supports window functions, CTEs,
PIVOT, full Parquet/Arrow integration, and JSON unpacking.

No API key required. Requires: pip install duckdb
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "duckdb_query",
    "description": (
        "Run SQL queries against local CSV, Parquet, or JSON files using DuckDB. "
        "Supports full SQL including window functions, CTEs, PIVOT, and aggregates. "
        "Can query multiple files with JOIN, read remote Parquet over HTTP, and export results. "
        "Ideal for data analysis, CSV exploration, and local dataset querying without a database server."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "sql": {
                "type": "string",
                "description": "SQL query to execute. Use read_csv_auto('path'), read_parquet('path'), or read_json_auto('path') to load files.",
            },
            "limit": {
                "type": "integer",
                "description": "Max rows to return in results (default: 100)",
                "default": 100,
            },
        },
        "required": ["sql"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    sql   = inputs.get("sql", "").strip()
    limit = int(inputs.get("limit", 100))

    if not sql:
        return {"error": "sql is required"}

    try:
        import duckdb
    except ImportError:
        return {"error": "duckdb not installed — run: pip install duckdb"}

    try:
        conn = duckdb.connect()

        # Auto-inject LIMIT if not present and not a DDL/non-SELECT
        sql_upper = sql.upper().strip()
        is_select = sql_upper.startswith("SELECT") or sql_upper.startswith("WITH")
        if is_select and "LIMIT" not in sql_upper:
            sql = f"{sql.rstrip(';')} LIMIT {limit}"

        result = conn.execute(sql)

        if result.description:
            columns = [desc[0] for desc in result.description]
            rows    = result.fetchall()
            data    = [dict(zip(columns, row)) for row in rows]
            return {
                "columns": columns,
                "rows":    data,
                "count":   len(data),
            }
        else:
            return {"success": True, "message": "Query executed (no result set)"}

    except Exception as exc:
        logger.error("[duckdb_tool] Query failed: %s", exc)
        return {"error": str(exc)}
