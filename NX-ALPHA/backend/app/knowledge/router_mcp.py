"""
AURA NX-Alpha — Router MCP Server (§3.5 / Sprint 0.5C)
Wraps router.py as an MCP (Model Context Protocol) server.

Agents call knowledge_router as an MCP tool in the research bundle.
The router handles local/stream dispatch transparently —
agents see a single clean interface regardless of data source.

TOOL: knowledge_router
    Input:  { query: str, context?: str }
    Output: { source: str, results: list, query: str, cached: bool }

RUN STANDALONE:
    python -m app.knowledge.router_mcp

MCP PROTOCOL:
    This module implements the MCP stdio transport (JSON-RPC 2.0 over stdin/stdout).
    Registered in toolkit_registry.py under the "research" bundle.
"""

import asyncio
import json
import logging
import sys

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL DEFINITION
# ─────────────────────────────────────────────────────────────────────────────

MCP_TOOL_SPEC = {
    "name": "knowledge_router",
    "description": (
        "Route a knowledge query to the best available source. "
        "Dispatches to local FTS5 indices (Wikipedia, Stack Exchange, PubMed, arXiv), "
        "streaming APIs (CourtListener, OpenAlex, arXiv, Congress.gov), "
        "or the API cache. Legal queries always stream. "
        "Returns normalized result records regardless of source."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The search query or question to look up.",
            },
            "context": {
                "type": "string",
                "description": "Optional context hint (category path, topic) for routing.",
                "default": "",
            },
        },
        "required": ["query"],
    },
}


# ─────────────────────────────────────────────────────────────────────────────
# MCP SERVER — STDIO TRANSPORT
# ─────────────────────────────────────────────────────────────────────────────

class RouterMCPServer:
    """
    Minimal MCP server (JSON-RPC 2.0 over stdin/stdout).
    Exposes knowledge_router.route() as the single MCP tool.
    """

    def __init__(self):
        self._reader = None
        self._writer = None

    async def run(self) -> None:
        """Main event loop — read JSON-RPC requests from stdin, write responses to stdout."""
        self._reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(self._reader)
        loop = asyncio.get_event_loop()

        await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
        transport, _ = await loop.connect_write_pipe(asyncio.BaseProtocol, sys.stdout.buffer)
        self._writer = asyncio.StreamWriter(transport, protocol, self._reader, loop)

        logger.info("[router_mcp] MCP server started (stdio)")

        while True:
            try:
                line = await self._reader.readline()
                if not line:
                    break
                request = json.loads(line.decode())
                response = await self._handle(request)
                if response is not None:
                    self._writer.write((json.dumps(response) + "\n").encode())
                    await self._writer.drain()
            except json.JSONDecodeError as exc:
                logger.warning("[router_mcp] JSON decode error: %s", exc)
            except Exception as exc:
                logger.error("[router_mcp] Unexpected error: %s", exc)

    async def _handle(self, request: dict) -> dict | None:
        """Dispatch a JSON-RPC request to the appropriate handler."""
        method = request.get("method", "")
        req_id = request.get("id")
        params = request.get("params", {})

        if method == "initialize":
            return self._ok(req_id, {
                "protocolVersion": "2024-11-05",
                "serverInfo": {"name": "aura-knowledge-router", "version": "0.1.0"},
                "capabilities": {"tools": {}},
            })

        if method == "tools/list":
            return self._ok(req_id, {"tools": [MCP_TOOL_SPEC]})

        if method == "tools/call":
            tool_name = params.get("name", "")
            tool_input = params.get("arguments", {})
            if tool_name == "knowledge_router":
                result = await self._call_router(tool_input)
                return self._ok(req_id, {
                    "content": [{"type": "text", "text": json.dumps(result)}]
                })
            return self._error(req_id, -32601, f"Unknown tool: {tool_name}")

        if method == "notifications/initialized":
            return None  # Notification — no response

        return self._error(req_id, -32601, f"Method not found: {method}")

    async def _call_router(self, args: dict) -> dict:
        """Execute knowledge_router.route() and return result."""
        from app.knowledge.router import route
        query = args.get("query", "")
        context = args.get("context", "")
        if not query:
            return {"source": "error", "results": [], "query": "", "error": "query is required"}
        return await route(query, context)

    @staticmethod
    def _ok(req_id: int | str | None, result: dict) -> dict:
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    @staticmethod
    def _error(req_id: int | str | None, code: int, message: str) -> dict:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


# ─────────────────────────────────────────────────────────────────────────────
# DIRECT CALL INTERFACE (for use inside the Python process, not MCP)
# ─────────────────────────────────────────────────────────────────────────────

async def call_router(query: str, context: str = "") -> dict:
    """
    Direct async call to the knowledge router.
    Use this when calling from within the Python backend process
    (e.g., from LangGraph nodes). Use the MCP server when calling
    from external processes or agents that speak MCP.
    """
    from app.knowledge.router import route
    return await route(query, context)


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    server = RouterMCPServer()
    asyncio.run(server.run())
