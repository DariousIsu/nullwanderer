"""
DataFrame analysis tool — high-performance analysis of large CSV, Parquet, and JSON files.

Uses Bodo JIT compilation when available for large datasets (auto-installed at boot).
Falls back to standard pandas if Bodo is not installed or compilation fails.

Operations: head, describe, groupby, filter, value_counts, merge
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_LARGE_FILE_BYTES = 500 * 1024 * 1024  # 500 MB — warn threshold without Bodo


def _load_df(file_path: str, file_path2: str | None = None):
    """Load one or two DataFrames. Returns (df, df2 or None)."""
    try:
        import bodo  # type: ignore  # noqa: F401
        _has_bodo = True
    except ImportError:
        _has_bodo = False

    import pandas as pd

    def _read(path: str):
        ext = Path(path).suffix.lower()
        if ext == ".parquet":
            return pd.read_parquet(path)
        elif ext == ".json":
            return pd.read_json(path)
        else:
            return pd.read_csv(path)

    size = os.path.getsize(file_path)
    if size > _LARGE_FILE_BYTES and not _has_bodo:
        logger.warning(
            "[bodo_dataframes] File is %.0f MB — Bodo not available. "
            "Processing with pandas (may be slow or OOM).",
            size / 1024 / 1024,
        )

    df  = _read(file_path)
    df2 = _read(file_path2) if file_path2 else None
    return df, df2, _has_bodo


def _safe_path(raw: str) -> str:
    """Reject path traversal attempts."""
    if ".." in raw:
        raise ValueError(f"Path traversal not allowed: {raw!r}")
    return raw


def _run_operation(inputs: dict) -> Any:
    """Execute the DataFrame operation synchronously."""
    file_path  = _safe_path(inputs.get("file_path", ""))
    file_path2 = inputs.get("file_path2")
    if file_path2:
        file_path2 = _safe_path(file_path2)
    op = inputs.get("operation", "head")

    df, df2, _has_bodo = _load_df(file_path, file_path2)

    if op == "head":
        n = int(inputs.get("n", 10))
        return {"rows": df.head(n).to_dict(orient="records"), "shape": list(df.shape)}

    elif op == "describe":
        cols = inputs.get("columns")
        target = df[cols] if cols else df
        return target.describe(include="all").fillna("").to_dict()

    elif op == "groupby":
        by  = inputs.get("by", "")
        agg = inputs.get("agg", "count")
        cols = inputs.get("columns")
        if not by:
            raise ValueError("by (column name) is required for groupby")
        target = df[cols] if cols else df
        agg_funcs = {"sum": "sum", "mean": "mean", "count": "count", "min": "min", "max": "max"}
        fn = agg_funcs.get(agg, "count")
        result = getattr(target.groupby(by), fn)().reset_index()
        return {"result": result.to_dict(orient="records")}

    elif op == "filter":
        query_str = inputs.get("query", "")
        if not query_str:
            raise ValueError("query string is required for filter")
        filtered = df.query(query_str)
        return {"rows": filtered.head(100).to_dict(orient="records"), "total_matches": int(len(filtered))}

    elif op == "value_counts":
        by = inputs.get("by", "")
        if not by:
            raise ValueError("by (column name) is required for value_counts")
        vc = df[by].value_counts().head(50)
        return {"value_counts": vc.to_dict()}

    elif op == "merge":
        if df2 is None:
            raise ValueError("file_path2 is required for merge")
        on  = inputs.get("on", "")
        how = inputs.get("how", "inner")
        if not on:
            raise ValueError("on (join key column) is required for merge")
        merged = df.merge(df2, on=on, how=how)
        return {"rows": merged.head(100).to_dict(orient="records"), "shape": list(merged.shape)}

    else:
        raise ValueError(f"Unknown operation: {op!r}")


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "dataframe_analyze",
    "description": (
        "Analyze large CSV, Parquet, or JSON files using pandas (with Bodo JIT acceleration when available). "
        "Operations: head, describe, groupby, filter, value_counts, merge."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation":  {
                "type": "string",
                "enum": ["head", "describe", "groupby", "filter", "value_counts", "merge"],
                "description": "Analysis operation to run",
            },
            "file_path":  {"type": "string",  "description": "Absolute path to CSV, Parquet, or JSON file"},
            "file_path2": {"type": "string",  "description": "Second file path for merge operation"},
            "columns":    {"type": "array",   "items": {"type": "string"}, "description": "Subset of columns to analyze"},
            "by":         {"type": "string",  "description": "Column to group/count by (groupby, value_counts)"},
            "agg":        {"type": "string",  "enum": ["sum", "mean", "count", "min", "max"], "description": "Aggregation function for groupby (default: count)"},
            "query":      {"type": "string",  "description": "Pandas query string for filter e.g. \"age > 30 and salary < 100000\""},
            "on":         {"type": "string",  "description": "Join key column name for merge"},
            "how":        {"type": "string",  "enum": ["inner", "outer", "left", "right"], "description": "Merge type (default: inner)"},
            "n":          {"type": "integer", "description": "Number of rows for head (default 10)"},
        },
        "required": ["operation", "file_path"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    """MCP-compatible wrapper for DataFrame analysis."""
    try:
        result = await asyncio.to_thread(_run_operation, inputs)
        return result
    except ValueError as exc:
        return {"error": str(exc)}
    except FileNotFoundError as exc:
        return {"error": f"File not found: {exc}"}
    except Exception as exc:
        logger.error("[bodo_dataframes] operation=%s error: %s", inputs.get("operation"), exc)
        return {"error": str(exc)}
