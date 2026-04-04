"""
MCP Client Service — discovers and connects to MCP servers from Claude Code config.

Reads Claude Code's MCP server config, spawns local stdio servers, discovers their
tools via JSON-RPC 2.0, and exposes them as a fallback in AURA's tool dispatch.
"""

import json
import asyncio
import logging
import os
from pathlib import Path
from typing import Dict, Any, Optional

logger = logging.getLogger(__name__)


def _find_claude_mcp_config() -> Optional[dict]:
    """Find and parse Claude Code's MCP server configuration."""
    candidates = [
        Path.home() / "AppData" / "Roaming" / "Claude" / "claude_desktop_config.json",
        Path.home() / ".claude" / "settings.json",
        Path.home() / ".claude" / "claude_desktop_config.json",
    ]
    for path in candidates:
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if "mcpServers" in data:
                    logger.info("[mcp_client] Found MCP config at %s", path)
                    return data["mcpServers"]
            except Exception as e:
                logger.warning("[mcp_client] Could not parse %s: %s", path, e)
    return None


# ── AURA-owned MCP servers ────────────────────────────────────────────────────
# These are hardcoded operational tools AURA depends on, independent of whatever
# MCP servers the user has configured in Claude Code.
# They are merged with (and take precedence over) any Claude Code config entries.

_AURA_MCP_SERVERS: dict = {
    "playwright": {
        # Browser automation — browser_navigate, browser_snapshot, browser_click, browser_fill
        # Install: npm install -g @playwright/mcp
        "command": "npx",
        "args": ["@playwright/mcp", "--headless"],
        "transport": "stdio",
    },
    # ── External MCP servers ──────────────────────────────────────────────────
    # Auto-installed at boot by _ensure_dependencies() in _mcp_wrapper.py
    "open-stocks-mcp": {
        # 104 stock analysis/trading tools
        "command": "uvx",
        "args": ["open-stocks-mcp"],
        "transport": "stdio",
    },
    "coding-tools": {
        # 461 code analysis functions
        "command": "uvx",
        "args": ["coding-open-agent-tools"],
        "transport": "stdio",
    },
}


def _merge_mcp_configs(claude_config: Optional[dict]) -> dict:
    """
    Merge AURA hardcoded servers with the Claude Code config.
    AURA servers are added only if not already present in the Claude config.
    """
    merged = dict(claude_config) if claude_config else {}
    for name, cfg in _AURA_MCP_SERVERS.items():
        if name not in merged:
            merged[name] = cfg
            logger.info("[mcp_client] Adding AURA-owned MCP server: %s", name)
    return merged


class MCPClient:
    """Manages connections to MCP servers via stdio or HTTP transport."""

    def __init__(self):
        self._servers: Dict[str, dict] = {}
        self._tool_index: Dict[str, str] = {}
        self._initialized = False

    async def initialize(self, server_configs: dict) -> None:
        for name, config in server_configs.items():
            try:
                if "url" in config:
                    await self._connect_http(name, config)
                else:
                    await self._connect_stdio(name, config)
            except Exception as e:
                logger.warning("[mcp_client] Failed to connect %s: %s", name, e)
        self._initialized = True
        logger.info(
            "[mcp_client] Initialized. Tools available: %s",
            list(self._tool_index.keys()),
        )

    async def _connect_stdio(self, name: str, config: dict) -> None:
        import subprocess

        cmd = config.get("command", "")
        args = config.get("args", [])
        env = {**os.environ, **(config.get("env") or {})}
        NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

        try:
            proc = await asyncio.create_subprocess_exec(
                cmd,
                *args,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                env=env,
                creationflags=NO_WINDOW,
            )
        except FileNotFoundError:
            logger.warning(
                "[mcp_client] Command not found for %s: '%s %s' — is it on PATH?",
                name, cmd, " ".join(args),
            )
            return
        except OSError as e:
            logger.warning(
                "[mcp_client] Could not spawn %s ('%s %s'): %s",
                name, cmd, " ".join(args), e,
            )
            return

        # initialize handshake
        await self._stdio_send(proc, {
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "clientInfo": {"name": "aura", "version": "1.0"},
                "capabilities": {},
            },
        })
        await self._stdio_recv(proc)

        # initialized notification
        await self._stdio_send(proc, {
            "jsonrpc": "2.0", "method": "notifications/initialized",
        })

        # tools/list
        await self._stdio_send(proc, {
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
        })
        resp = await self._stdio_recv(proc)
        tools = resp.get("result", {}).get("tools", [])

        self._servers[name] = {"process": proc, "tools": tools, "transport": "stdio"}
        for tool in tools:
            self._tool_index[tool["name"]] = name
        logger.info("[mcp_client] %s (stdio): %d tools", name, len(tools))

    async def _connect_http(self, name: str, config: dict) -> None:
        import httpx

        url = config["url"].rstrip("/")
        headers = {}
        token = (config.get("env") or {}).get("API_KEY") or (
            config.get("env") or {}
        ).get("TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"

        payload = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(url, json=payload, headers=headers)
            r.raise_for_status()
            resp = r.json()
        tools = resp.get("result", {}).get("tools", [])

        self._servers[name] = {
            "url": url, "tools": tools, "transport": "http", "headers": headers,
        }
        for tool in tools:
            self._tool_index[tool["name"]] = name
        logger.info("[mcp_client] %s (http): %d tools", name, len(tools))

    async def call_tool(self, tool_name: str, arguments: dict) -> Any:
        server_name = self._tool_index.get(tool_name)
        if not server_name:
            raise ValueError(f"Unknown MCP tool: {tool_name}")
        server = self._servers[server_name]
        payload = {
            "jsonrpc": "2.0", "id": 3, "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
        }

        if server["transport"] == "stdio":
            proc = server["process"]
            await self._stdio_send(proc, payload)
            resp = await self._stdio_recv(proc)
        else:
            import httpx
            async with httpx.AsyncClient(timeout=60) as client:
                r = await client.post(
                    server["url"], json=payload, headers=server["headers"],
                )
                r.raise_for_status()
                resp = r.json()

        result = resp.get("result", {})
        content = result.get("content", [])
        texts = [c.get("text", "") for c in content if c.get("type") == "text"]
        return "\n".join(texts) if texts else str(result)

    def get_tool_schemas(self) -> list:
        schemas = []
        for server in self._servers.values():
            schemas.extend(server.get("tools", []))
        return schemas

    def get_tool_awareness_text(self) -> str:
        """Return a cached MCP tool awareness string for prompt injection.

        Computed once after initialization and cached — avoids re-serializing
        all tool schemas on every request (which was causing per-turn context bloat).
        Returns empty string if no tools are available.
        """
        if hasattr(self, "_tool_awareness_cache"):
            return self._tool_awareness_cache  # type: ignore[attr-defined]
        tools = self.get_tool_schemas()
        if not tools:
            self._tool_awareness_cache = ""
            return ""
        # Cap at 30 tools — names + one-line descriptions only (no input schemas)
        capped = tools[:30]
        lines = ["\n\nYou also have live MCP tool connections to external services:"]
        for t in capped:
            lines.append(f'  {{"tool": "{t["name"]}"}} — {t.get("description", "")}')
        if len(tools) > 30:
            lines.append(f"  … and {len(tools) - 30} more tools available.")
        self._tool_awareness_cache = "\n".join(lines)
        return self._tool_awareness_cache

    async def _stdio_send(self, proc, message: dict) -> None:
        data = (json.dumps(message) + "\n").encode()
        proc.stdin.write(data)
        await proc.stdin.drain()

    async def _stdio_recv(self, proc) -> dict:
        line = await asyncio.wait_for(proc.stdout.readline(), timeout=30)
        return json.loads(line.decode().strip()) if line.strip() else {}

    async def shutdown(self) -> None:
        for name, server in self._servers.items():
            if server.get("transport") == "stdio":
                try:
                    server["process"].terminate()
                    logger.info("[mcp_client] Terminated %s", name)
                except Exception:
                    pass


# ── Singleton ────────────────────────────────────────────────────────────────

_mcp_client: Optional[MCPClient] = None


def get_mcp_client() -> Optional[MCPClient]:
    return _mcp_client


async def init_mcp_client() -> None:
    global _mcp_client
    claude_configs = _find_claude_mcp_config()
    configs = _merge_mcp_configs(claude_configs)
    if not configs:
        logger.warning("[mcp_client] No MCP servers configured")
        return
    _mcp_client = MCPClient()
    await _mcp_client.initialize(configs)
