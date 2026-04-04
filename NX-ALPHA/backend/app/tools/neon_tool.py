"""
neon_tool.py
─────────────
AURA MCP tool — Neon serverless PostgreSQL.

Manage Neon projects, branches, and databases. Execute SQL queries against
Neon's serverless PostgreSQL via the HTTP API or connection string.

Requires API key: set AURA_NEON_API_KEY in .env
Get key: https://neon.tech/docs/manage/api-keys
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "neon",
    "description": (
        "Neon serverless PostgreSQL management and querying. "
        "Operations: list_projects, get_project, list_branches, create_branch, "
        "execute_sql (run SQL via Neon HTTP API), list_endpoints. "
        "Neon provides instant branch creation for dev/test environments. "
        "Each branch is an isolated PostgreSQL clone — ideal for feature branches."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["list_projects", "get_project", "list_branches",
                         "create_branch", "execute_sql", "list_endpoints"],
                "description": "Operation to perform",
            },
            "project_id": {
                "type": "string",
                "description": "Neon project ID (for most operations)",
            },
            "branch_id": {
                "type": "string",
                "description": "Branch ID (for execute_sql, list_endpoints)",
            },
            "branch_name": {
                "type": "string",
                "description": "New branch name (for create_branch)",
            },
            "parent_branch": {
                "type": "string",
                "description": "Parent branch ID or name to fork from (for create_branch, default: main)",
                "default": "main",
            },
            "sql": {
                "type": "string",
                "description": "SQL query to execute (for execute_sql)",
            },
            "database": {
                "type": "string",
                "description": "Database name for execute_sql (default: neondb)",
                "default": "neondb",
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")

    try:
        from app.tools._mcp_wrapper import _get_setting
        api_key = _get_setting("neon_api_key") or ""
    except Exception:
        import os
        api_key = os.environ.get("AURA_NEON_API_KEY", "")

    if not api_key:
        return {
            "error": "Neon API key not configured",
            "hint":  "Set AURA_NEON_API_KEY in .env",
        }

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    base    = "https://console.neon.tech/api/v2"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    proj_id = inputs.get("project_id", "")

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            if operation == "list_projects":
                resp = await client.get(f"{base}/projects", headers=headers)
                resp.raise_for_status()
                data = resp.json().get("projects", [])
                return {"projects": [{"id": p["id"], "name": p["name"], "region": p.get("region_id", "")} for p in data]}

            elif operation == "get_project":
                if not proj_id:
                    return {"error": "project_id required"}
                resp = await client.get(f"{base}/projects/{proj_id}", headers=headers)
                resp.raise_for_status()
                return resp.json().get("project", resp.json())

            elif operation == "list_branches":
                if not proj_id:
                    return {"error": "project_id required"}
                resp = await client.get(f"{base}/projects/{proj_id}/branches", headers=headers)
                resp.raise_for_status()
                data = resp.json().get("branches", [])
                return {"branches": [{"id": b["id"], "name": b["name"], "primary": b.get("primary", False)} for b in data]}

            elif operation == "create_branch":
                if not proj_id:
                    return {"error": "project_id required"}
                name   = inputs.get("branch_name", "")
                parent = inputs.get("parent_branch", "main")
                if not name:
                    return {"error": "branch_name required"}
                payload = {"branch": {"name": name}, "endpoints": [{"type": "read_write"}]}
                if parent != "main":
                    payload["branch"]["parent_id"] = parent
                resp = await client.post(f"{base}/projects/{proj_id}/branches", headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                return {"branch": data.get("branch", {}), "endpoints": data.get("endpoints", [])}

            elif operation == "execute_sql":
                if not proj_id:
                    return {"error": "project_id required"}
                sql      = inputs.get("sql", "")
                database = inputs.get("database", "neondb")
                if not sql:
                    return {"error": "sql required"}
                branch_id = inputs.get("branch_id", "")
                payload   = {"query": sql, "database_name": database}
                url       = f"{base}/projects/{proj_id}/query"
                if branch_id:
                    payload["branch_id"] = branch_id
                resp = await client.post(url, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                return {
                    "rows":    data.get("rows", []),
                    "columns": data.get("fields", []),
                    "count":   len(data.get("rows", [])),
                }

            elif operation == "list_endpoints":
                if not proj_id:
                    return {"error": "project_id required"}
                resp = await client.get(f"{base}/projects/{proj_id}/endpoints", headers=headers)
                resp.raise_for_status()
                data = resp.json().get("endpoints", [])
                return {"endpoints": [{"id": e["id"], "type": e.get("type", ""), "host": e.get("host", ""), "branch_id": e.get("branch_id", "")} for e in data]}

    except Exception as exc:
        logger.error("[neon_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}

    return {"error": f"Unknown operation: {operation}"}
