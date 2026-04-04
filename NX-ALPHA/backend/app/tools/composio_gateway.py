"""
Composio Gateway — Salesforce, HubSpot, and Microsoft 365 via Composio SDK.

Auto-installed at boot by _ensure_dependencies() in _mcp_wrapper.py.
Requires a Composio API key (composio_api_key in config / Settings → Tool API Keys)
and a connected account for each app (configure at app.composio.dev).
"""

from __future__ import annotations

import asyncio
import logging

logger = logging.getLogger(__name__)

_APP_DISPLAY = {
    "salesforce":  "Salesforce",
    "hubspot":     "HubSpot",
    "microsoft365": "Microsoft 365",
}


def _execute_action(api_key: str, app: str, action: str, params: dict, entity_id: str) -> dict:
    """Synchronous Composio action execution."""
    from composio import ComposioToolSet  # type: ignore

    toolset = ComposioToolSet(api_key=api_key)
    result = toolset.execute_action(
        action=action,
        params=params,
        entity_id=entity_id,
    )
    if hasattr(result, "model_dump"):
        return result.model_dump()
    if hasattr(result, "__dict__"):
        return result.__dict__
    return {"result": str(result)}


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "composio",
    "description": (
        "Execute CRM and productivity actions via Composio. "
        "Supported apps: salesforce, hubspot, microsoft365. "
        "Requires composio_api_key in Settings and connected accounts at app.composio.dev. "
        "Find action IDs at app.composio.dev/apps or ask AURA to list available actions."
    ),
    "expose_components": True,
    "inputSchema": {
        "type": "object",
        "properties": {
            "app": {
                "type": "string",
                "enum": ["salesforce", "hubspot", "microsoft365"],
                "description": "Target application",
            },
            "action":    {"type": "string",  "description": "Composio action ID e.g. SALESFORCE_CREATE_CONTACT"},
            "params":    {"type": "object",  "description": "Action-specific parameters"},
            "entity_id": {"type": "string",  "description": "Connected account entity ID (default: 'default')"},
        },
        "required": ["app", "action"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    """MCP-compatible wrapper for Composio gateway."""
    from app.tools._mcp_wrapper import _get_setting

    app       = inputs.get("app", "")
    action    = inputs.get("action", "")
    params    = inputs.get("params") or {}
    entity_id = inputs.get("entity_id", "default")

    if not app or not action:
        return {"error": "app and action are required"}
    if app not in _APP_DISPLAY:
        return {"error": f"Unsupported app: {app!r}. Choose from: {list(_APP_DISPLAY)}"}

    api_key = _get_setting("composio_api_key")
    if not api_key:
        return {
            "error": "composio_api_key not configured. "
                     "Add it in Settings → Tool API Keys, then restart AURA."
        }

    try:
        return await asyncio.to_thread(_execute_action, api_key, app, action, params, entity_id)
    except Exception as exc:
        err = str(exc)
        # Provide a helpful message for common auth errors
        if "not connected" in err.lower() or "entity" in err.lower() or "auth" in err.lower():
            return {
                "error": (
                    f"{_APP_DISPLAY[app]} account not connected. "
                    f"Connect it at app.composio.dev, then retry. Details: {err}"
                )
            }
        logger.error("[composio_gateway] app=%s action=%s error: %s", app, action, exc)
        return {"error": err}
