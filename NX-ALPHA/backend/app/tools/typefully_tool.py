"""
typefully_tool.py
──────────────────
AURA MCP tool — Social media scheduling via Typefully.

Schedule and manage posts for X (Twitter), LinkedIn, and Threads.
Create drafts, schedule posts, and retrieve recently published content.

Requires API key: set AURA_TYPEFULLY_API_KEY in .env
Get key: https://typefully.com (Settings → API)
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "typefully",
    "description": (
        "Social media scheduling via Typefully. "
        "Operations: create_draft (create post/thread draft), "
        "schedule (schedule a draft for a specific time), "
        "list_drafts (view pending drafts), "
        "list_published (view recently published posts). "
        "Supports X (Twitter), LinkedIn, and Threads."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["create_draft", "schedule", "list_drafts", "list_published"],
                "description": "Operation to perform",
            },
            "content": {
                "type": "string",
                "description": "Post content (for create_draft). Use \\n\\n\\n\\n to split into thread tweets.",
            },
            "schedule_date": {
                "type": "string",
                "description": "ISO 8601 datetime to schedule for, e.g. '2026-04-05T14:00:00Z' (for schedule/create_draft)",
            },
            "draft_id": {
                "type": "string",
                "description": "Draft ID (for schedule)",
            },
            "threadify": {
                "type": "boolean",
                "description": "Auto-split long content into thread (default: false)",
                "default": False,
            },
            "limit": {
                "type": "integer",
                "description": "Max items to return for list operations (default: 20)",
                "default": 20,
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation = inputs.get("operation", "")

    try:
        from app.tools._mcp_wrapper import _get_setting
        api_key = _get_setting("typefully_api_key") or ""
    except Exception:
        import os
        api_key = os.environ.get("AURA_TYPEFULLY_API_KEY", "")

    if not api_key:
        return {
            "error": "Typefully API key not configured",
            "hint":  "Set AURA_TYPEFULLY_API_KEY in .env",
        }

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    base    = "https://api.typefully.com/v1"
    headers = {"X-API-KEY": f"Bearer {api_key}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            if operation == "create_draft":
                content      = inputs.get("content", "")
                schedule_date = inputs.get("schedule_date")
                threadify    = inputs.get("threadify", False)
                if not content:
                    return {"error": "content required"}
                payload = {"content": content, "threadify": threadify}
                if schedule_date:
                    payload["schedule-date"] = schedule_date
                resp = await client.post(f"{base}/drafts/", headers=headers, json=payload)
                resp.raise_for_status()
                return resp.json()

            elif operation == "schedule":
                draft_id      = inputs.get("draft_id", "")
                schedule_date = inputs.get("schedule_date", "")
                if not draft_id or not schedule_date:
                    return {"error": "draft_id and schedule_date required"}
                resp = await client.post(
                    f"{base}/drafts/{draft_id}/schedule/",
                    headers=headers,
                    json={"schedule-date": schedule_date},
                )
                resp.raise_for_status()
                return resp.json()

            elif operation == "list_drafts":
                resp = await client.get(f"{base}/drafts/?filter=scheduled", headers=headers)
                resp.raise_for_status()
                data  = resp.json()
                limit = int(inputs.get("limit", 20))
                return {"drafts": data[:limit] if isinstance(data, list) else data}

            elif operation == "list_published":
                resp = await client.get(f"{base}/drafts/?filter=published", headers=headers)
                resp.raise_for_status()
                data  = resp.json()
                limit = int(inputs.get("limit", 20))
                return {"published": data[:limit] if isinstance(data, list) else data}

    except Exception as exc:
        logger.error("[typefully_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}

    return {"error": f"Unknown operation: {operation}"}
