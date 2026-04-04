#!/usr/bin/env python3
"""
AURA MCP Server — exposes AURA as an MCP tool for Claude Code.

Run as: python aura_mcp_server.py
Claude Code spawns this via claude_desktop_config.json.
"""

import asyncio
import httpx
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp import types

AURA_BACKEND = "http://localhost:8000"
app = Server("aura")


@app.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="aura_chat",
            description=(
                "Send a message to AURA and get her response. She has canvas, "
                "memory, web search, and team pipeline access."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "The message to send to AURA",
                    },
                    "thread_id": {
                        "type": "string",
                        "description": "Conversation thread ID (optional)",
                    },
                },
                "required": ["message"],
            },
        ),
        types.Tool(
            name="aura_search_memory",
            description="Search AURA's memory (ChromaDB semantic store) for relevant context.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default 5)",
                    },
                },
                "required": ["query"],
            },
        ),
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    async with httpx.AsyncClient(timeout=60) as client:
        if name == "aura_chat":
            r = await client.post(
                f"{AURA_BACKEND}/chat/sync",
                json={
                    "message": arguments["message"],
                    "thread_id": arguments.get("thread_id", "mcp_default"),
                },
            )
            r.raise_for_status()
            result = r.json().get("response", "No response")

        elif name == "aura_search_memory":
            r = await client.get(
                f"{AURA_BACKEND}/memory/search",
                params={
                    "q": arguments["query"],
                    "limit": arguments.get("limit", 5),
                },
            )
            r.raise_for_status()
            result = r.json().get("results", "No results")
            if isinstance(result, list):
                result = "\n".join(str(item) for item in result)

        else:
            result = f"Unknown tool: {name}"

    return [types.TextContent(type="text", text=str(result))]


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
