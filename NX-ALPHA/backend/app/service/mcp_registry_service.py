"""
MCP Registry Service — manages user-added MCP server registrations at runtime.

Persists to ~/.aura/mcp_servers.json. Registers new servers with the live
MCPClient singleton by calling its internal _connect_stdio / _connect_http
methods directly, so no restart is required.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

SERVERS_PATH = Path.home() / ".aura" / "mcp_servers.json"


# ─────────────────────────────────────────────────────────────────────────────
# DISK PERSISTENCE
# ─────────────────────────────────────────────────────────────────────────────

def _load_servers() -> dict:
    if not SERVERS_PATH.exists():
        return {}
    try:
        return json.loads(SERVERS_PATH.read_text())
    except Exception:
        return {}


def _save_servers(servers: dict) -> None:
    SERVERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SERVERS_PATH.write_text(json.dumps(servers, indent=2))


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

async def add_server(name: str, url_or_package: str) -> dict:
    """
    Register a new MCP server by URL (HTTP) or npm package name (stdio).
    Persists to disk and connects to the live MCPClient if available.
    """
    config = _build_config(url_or_package)
    servers = _load_servers()
    servers[name] = config
    _save_servers(servers)

    connected = await _register_live(name, config)

    return {
        "name":      name,
        "config":    config,
        "connected": connected,
    }


def remove_server(name: str) -> None:
    """Remove a server from the registry. Does not disconnect a live process."""
    servers = _load_servers()
    if name in servers:
        servers.pop(name)
        _save_servers(servers)
        logger.info("[mcp_registry] Removed %s", name)


def list_servers() -> list[dict]:
    """Return all registered servers with live connection status."""
    from app.service.mcp_client_service import get_mcp_client

    servers   = _load_servers()
    client    = get_mcp_client()
    connected = set(client._servers.keys()) if client else set()

    return [
        {
            "name":       name,
            "config":     cfg,
            "connected":  name in connected,
            "tool_count": len(client._servers[name].get("tools", []))
                          if client and name in connected else 0,
        }
        for name, cfg in servers.items()
    ]


async def reload_server(name: str) -> dict:
    """Re-connect an existing server by name."""
    servers = _load_servers()
    if name not in servers:
        return {"error": f"Server '{name}' not found in registry"}
    config    = servers[name]
    connected = await _register_live(name, config)
    return {"name": name, "config": config, "connected": connected}


# ─────────────────────────────────────────────────────────────────────────────
# INTERNALS
# ─────────────────────────────────────────────────────────────────────────────

def _build_config(url_or_package: str) -> dict:
    if url_or_package.startswith("http://") or url_or_package.startswith("https://"):
        return {"url": url_or_package, "transport": "http"}
    # Treat as npm package name — launch via npx
    return {"command": "npx", "args": [url_or_package], "transport": "stdio"}


async def _register_live(name: str, config: dict) -> bool:
    """Connect to the live MCPClient singleton. Returns True on success."""
    from app.service.mcp_client_service import get_mcp_client

    client = get_mcp_client()
    if client is None:
        logger.info("[mcp_registry] MCPClient not initialized — %s saved for next startup", name)
        return False

    try:
        if "url" in config:
            await client._connect_http(name, config)
        else:
            await client._connect_stdio(name, config)
        logger.info("[mcp_registry] Live-registered MCP server: %s", name)
        return True
    except Exception as exc:
        logger.warning("[mcp_registry] Live registration failed for %s: %s", name, exc)
        return False
