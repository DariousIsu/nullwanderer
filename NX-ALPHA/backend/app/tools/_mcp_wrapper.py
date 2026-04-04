"""
AURA NX-Alpha — MCP Tool Registry & Dispatch

Central registry for all AURA tool handlers. Each tool file in this directory
exports a `tool_handler(inputs: dict) -> dict` function and a `TOOL_DEF` dict.

At startup, `load_all_tools()` scans this directory and auto-registers every
tool that exposes these exports.

Dispatch chain:
  1. AURA tool registry (direct Python call — no subprocess overhead)
  2. MCP client (external servers: playwright, open-stocks-mcp, etc.)
  3. Raise ValueError if unknown

This module also provides shared utilities for tool implementations.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

import httpx

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# REGISTRY
# ─────────────────────────────────────────────────────────────────────────────

_TOOL_REGISTRY: dict[str, dict] = {}
# Structure: { "tool_name": { "handler": async callable, "schema": dict } }


def register_tool(name: str, handler: Callable, schema: dict) -> None:
    """Register a tool handler with its MCP-compatible schema."""
    _TOOL_REGISTRY[name] = {"handler": handler, "schema": schema}
    logger.debug("[tool_registry] Registered: %s", name)


def get_registered_tools() -> dict[str, dict]:
    """Return the full registry (read-only view)."""
    return dict(_TOOL_REGISTRY)


def get_tool_schemas() -> list[dict]:
    """Return all registered tool schemas in MCP tools/list format."""
    return [entry["schema"] for entry in _TOOL_REGISTRY.values()]


def is_registered(tool_name: str) -> bool:
    return tool_name in _TOOL_REGISTRY


# ─────────────────────────────────────────────────────────────────────────────
# DISPATCH
# ─────────────────────────────────────────────────────────────────────────────

async def dispatch(tool_name: str, args: dict) -> Any:
    """
    Try AURA tool registry first, then fall through to MCP client.
    Returns the tool result (string or dict).
    Raises ValueError if no handler found anywhere.
    """
    # 1. Local registry
    entry = _TOOL_REGISTRY.get(tool_name)
    if entry:
        try:
            return await entry["handler"](args)
        except Exception as exc:
            logger.error("[tool_registry] %s failed: %s", tool_name, exc)
            return {"error": str(exc)}

    # 2. MCP client (external servers)
    try:
        from app.service.mcp_client_service import get_mcp_client
        mcp = get_mcp_client()
        if mcp and tool_name in {
            t["name"] for s in mcp._servers.values() for t in s.get("tools", [])
        }:
            return await mcp.call_tool(tool_name, args)
    except Exception as exc:
        logger.warning("[tool_registry] MCP fallback for %s failed: %s", tool_name, exc)

    raise ValueError(f"Unknown tool: {tool_name}")


# ─────────────────────────────────────────────────────────────────────────────
# DEPENDENCY AUTO-INSTALLER
# ─────────────────────────────────────────────────────────────────────────────

# Maps importable module name → pip package(s) to install if missing.
# Checked at boot so the load screen shows install progress instead of silent failures.
_OPTIONAL_PACKAGES: dict[str, str] = {
    "open_stocks_mcp":          "open-stocks-mcp",
    "coding_open_agent_tools":  "coding-open-agent-tools",
    "composio":                 "composio-core",
    # bodo excluded: incompatible with Python 3.13 (supports 3.8–3.12 only).
    # bodo_dataframes.py falls back to plain pandas when bodo is unavailable.
    "googleapiclient":          "google-auth google-auth-oauthlib google-auth-httplib2 google-api-python-client",
}


def _ensure_dependencies() -> None:
    """
    Check for optional packages and install any that are missing.
    Runs once at startup so the load screen surfaces install progress.
    Each package is installed independently — one failure does not block others.
    After all installs, anyio is force-reinstalled to repair any version
    corruption that third-party packages may introduce.
    """
    installed_any = False
    for import_name, pip_spec in _OPTIONAL_PACKAGES.items():
        if importlib.util.find_spec(import_name) is None:
            logger.info("[tool_registry] Installing missing dependency: %s", pip_spec)
            try:
                subprocess.check_call(
                    [sys.executable, "-m", "pip", "install"] + pip_spec.split() + ["-q"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                logger.info("[tool_registry] Installed: %s", pip_spec)
                installed_any = True
            except subprocess.CalledProcessError as exc:
                logger.warning(
                    "[tool_registry] Could not install %s: %s",
                    pip_spec,
                    exc.stderr.decode(errors="replace").strip() if exc.stderr else exc,
                )

    if installed_any:
        # Force-reinstall anyio to repair any corruption from third-party installs.
        logger.info("[tool_registry] Force-reinstalling anyio to ensure integrity")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--force-reinstall", "anyio", "-q"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
            )
        except subprocess.CalledProcessError as exc:
            logger.warning(
                "[tool_registry] anyio force-reinstall failed: %s",
                exc.stderr.decode(errors="replace").strip() if exc.stderr else exc,
            )


# ─────────────────────────────────────────────────────────────────────────────
# AUTO-LOADER
# ─────────────────────────────────────────────────────────────────────────────

def load_all_tools() -> int:
    """
    Scan backend/app/tools/*.py for modules that export TOOL_DEF and tool_handler.
    Returns count of tools loaded.
    """
    _ensure_dependencies()

    tools_dir = Path(__file__).parent
    count = 0

    for py_file in sorted(tools_dir.glob("*.py")):
        if py_file.name.startswith("_") or py_file.name == "__init__.py":
            continue

        module_name = f"app.tools.{py_file.stem}"
        try:
            mod = importlib.import_module(module_name)
            handler = getattr(mod, "tool_handler", None)
            tool_def = getattr(mod, "TOOL_DEF", None)

            if handler and tool_def and isinstance(tool_def, dict):
                name = tool_def.get("name", py_file.stem)
                register_tool(name, handler, tool_def)
                count += 1
        except Exception as exc:
            logger.warning("[tool_registry] Failed to load %s: %s", module_name, exc)

    logger.info("[tool_registry] Loaded %d tools from %s", count, tools_dir)

    # ── Auto-register into MCPToolStore (Tool Workspace) ─────────────────────
    # Creates a published MCPToolDef record for any internal tool that doesn't
    # already have one, so it appears in the Tool Workspace pipeline dashboard.
    try:
        import time as _time
        from app.service.mcp_tool_store import MCPToolDef, get_mcp_tool_store
        store = get_mcp_tool_store()
        existing_names = {t.name for t in store.list_tools()}
        new_count = 0
        for tool_name, entry in _TOOL_REGISTRY.items():
            if tool_name not in existing_names:
                schema = entry["schema"]
                store.save_tool(MCPToolDef(
                    id=tool_name.replace("_", "-"),
                    name=tool_name,
                    description=schema.get("description", ""),
                    input_schema=schema.get("inputSchema", {}),
                    stage="published",
                    published=True,
                    expose_components=bool(schema.get("expose_components", True)),
                    auto_update=False,
                    created_at=_time.time(),
                    updated_at=_time.time(),
                ))
                new_count += 1
        if new_count:
            logger.info("[tool_registry] Auto-registered %d tools in MCPToolStore", new_count)
    except Exception as exc:
        logger.warning("[tool_registry] MCPToolStore auto-registration failed (non-fatal): %s", exc)

    return count


# ─────────────────────────────────────────────────────────────────────────────
# SHARED UTILITIES FOR TOOL IMPLEMENTATIONS
# ─────────────────────────────────────────────────────────────────────────────

def _get_setting(key: str, default: str = "") -> str:
    """Read a setting from AURA config. Safe import — returns default if config unavailable."""
    try:
        from app.config import get_settings
        return getattr(get_settings(), key, default)
    except Exception:
        return os.environ.get(key.upper(), default)


def _api_client(timeout: float = 15.0, headers: dict | None = None) -> httpx.AsyncClient:
    """Create a reusable async HTTP client with standard timeout."""
    return httpx.AsyncClient(timeout=timeout, headers=headers or {})


def _error(msg: str) -> dict:
    """Standard error response."""
    return {"error": msg}


def _ok(data: Any) -> dict:
    """Standard success response wrapping arbitrary data."""
    if isinstance(data, dict):
        return data
    return {"result": data}
