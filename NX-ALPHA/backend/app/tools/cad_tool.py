"""
CAD & 3D Tools — CAD rendering server client + 3D model search.

Connects to a local Docker CAD-agent (build123d + VTK) for 3D rendering
and searches Printables.com for downloadable STL files. Free, no API keys.
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import quote_plus

import httpx

from app.tools._mcp_wrapper import _error, _get_setting

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "cad_3d",
    "description": (
        "3D modeling and STL search toolkit. Actions: "
        "(1) render — send build123d Python code to a local CAD rendering server "
        "and get back a rendered image or STL file. Requires cad-agent Docker container. "
        "(2) search_stl — search Printables.com for downloadable 3D print files "
        "(STL, 3MF). Free, no auth needed. "
        "(3) info — check if the CAD rendering server is running."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["render", "search_stl", "info"],
                "description": "CAD/3D action to perform",
            },
            "code": {
                "type": "string",
                "description": "build123d Python code for render action",
            },
            "query": {
                "type": "string",
                "description": "Search query for search_stl action",
            },
            "output_format": {
                "type": "string",
                "enum": ["png", "stl", "step"],
                "description": "Output format for render action (default: png)",
                "default": "png",
            },
            "output_path": {
                "type": "string",
                "description": "Output file path (auto-generated if omitted)",
            },
            "limit": {
                "type": "integer",
                "description": "Number of search results (default: 10)",
                "default": 10,
            },
            "server_url": {
                "type": "string",
                "description": "CAD server URL (default: http://localhost:5000)",
                "default": "http://localhost:5000",
            },
        },
        "required": ["action"],
    },
}


async def _cad_render(inputs: dict) -> dict:
    """Send build123d code to the CAD rendering server."""
    code = inputs.get("code", "")
    if not code:
        return _error("code is required for render action — provide build123d Python code")

    server_url = inputs.get("server_url", _get_setting("cad_server_url", "http://localhost:5000"))
    output_format = inputs.get("output_format", "png")
    output_path = inputs.get("output_path", "")

    if not output_path:
        output_path = os.path.join(tempfile.gettempdir(), f"aura_cad.{output_format}")

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.post(
                f"{server_url}/render",
                json={
                    "code": code,
                    "format": output_format,
                },
            )
            r.raise_for_status()

            if r.headers.get("content-type", "").startswith("application/json"):
                result = r.json()
                if "error" in result:
                    return _error(result["error"])
                return result
            else:
                # Binary response (image or STL)
                Path(output_path).write_bytes(r.content)
                return {
                    "output_path": output_path,
                    "format": output_format,
                    "size_bytes": len(r.content),
                }

    except httpx.ConnectError:
        return _error(
            f"CAD server not reachable at {server_url}. "
            "Start the cad-agent Docker container: docker run -p 5000:5000 cad-agent"
        )
    except Exception as exc:
        logger.error("[cad_3d:render] %s", exc)
        return _error(str(exc))


async def _search_stl(query: str, limit: int) -> dict:
    """Search Printables.com for 3D print files."""
    if not query:
        return _error("query is required for search_stl")

    # Printables.com has a public search page we can scrape
    url = f"https://www.printables.com/search/models?q={quote_plus(query)}"

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            r = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html",
            })
            r.raise_for_status()
            html = r.text

        models = []
        # Parse model cards from search results
        # Printables uses structured data we can extract
        model_pattern = r'<a[^>]*href="(/model/[^"]*)"[^>]*>.*?<img[^>]*alt="([^"]*)"'
        matches = re.findall(model_pattern, html, re.DOTALL)

        for path, name in matches[:limit]:
            models.append({
                "name": name.strip(),
                "url": f"https://www.printables.com{path}",
            })

        # Fallback: look for JSON-LD structured data
        if not models:
            import json
            ld_pattern = r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>'
            ld_matches = re.findall(ld_pattern, html, re.DOTALL)
            for ld_text in ld_matches:
                try:
                    ld = json.loads(ld_text)
                    if isinstance(ld, list):
                        for item in ld[:limit]:
                            if item.get("@type") == "Product" or "name" in item:
                                models.append({
                                    "name": item.get("name", ""),
                                    "url": item.get("url", ""),
                                })
                except json.JSONDecodeError:
                    continue

        return {
            "models": models,
            "query": query,
            "count": len(models),
            "source": "printables.com",
        }

    except Exception as exc:
        logger.error("[cad_3d:search] %s", exc)
        return _error(f"STL search failed: {exc}")


async def _cad_info(server_url: str) -> dict:
    """Check if the CAD rendering server is running."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{server_url}/health")
            r.raise_for_status()
            return {"status": "running", "server_url": server_url, "info": r.json()}
    except Exception:
        return {
            "status": "not_running",
            "server_url": server_url,
            "note": "Start the cad-agent Docker container: docker run -p 5000:5000 cad-agent",
        }


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    if not action:
        return _error("action is required")

    if action == "render":
        return await _cad_render(inputs)
    elif action == "search_stl":
        return await _search_stl(inputs.get("query", ""), inputs.get("limit", 10))
    elif action == "info":
        server_url = inputs.get("server_url", _get_setting("cad_server_url", "http://localhost:5000"))
        return await _cad_info(server_url)

    return _error(f"Unknown action: {action}")
