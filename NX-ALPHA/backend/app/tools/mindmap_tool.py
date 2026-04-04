"""
Mindmap Generator — Create visual mindmaps and diagrams using Mermaid.

Generates Mermaid diagram syntax from structured data, then renders to
PNG/SVG via mermaid-cli (mmdc). Runs fully local, no API keys.
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from pathlib import Path

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "mindmap",
    "description": (
        "Generate visual mindmaps, flowcharts, sequence diagrams, and other diagrams. "
        "Provide Mermaid diagram syntax directly or structured data to auto-generate "
        "the syntax. Renders to PNG or SVG. Supports: mindmap, flowchart, sequence, "
        "class, state, gantt, pie, and entity-relationship diagrams."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "mermaid_code": {
                "type": "string",
                "description": (
                    "Raw Mermaid diagram syntax. If provided, this is rendered directly. "
                    "Example: 'mindmap\\n  root((Central Topic))\\n    Branch A\\n      Leaf 1'"
                ),
            },
            "diagram_type": {
                "type": "string",
                "enum": ["mindmap", "flowchart", "sequence", "class", "state", "gantt", "pie", "er"],
                "description": "Diagram type (used with structured data, ignored if mermaid_code is provided)",
                "default": "mindmap",
            },
            "title": {
                "type": "string",
                "description": "Root/central topic for auto-generated mindmaps",
            },
            "nodes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "children": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
                "description": "Structured data for auto-generating mindmaps: [{label, children: [str]}]",
            },
            "output_format": {
                "type": "string",
                "enum": ["png", "svg"],
                "description": "Output format (default: png)",
                "default": "png",
            },
            "output_path": {
                "type": "string",
                "description": "Absolute path for the output file (auto-generated if omitted)",
            },
            "theme": {
                "type": "string",
                "enum": ["default", "dark", "forest", "neutral"],
                "description": "Mermaid theme (default: default)",
                "default": "default",
            },
        },
        "required": [],
    },
}


def _build_mindmap(title: str, nodes: list[dict]) -> str:
    """Build Mermaid mindmap syntax from structured data."""
    lines = ["mindmap", f"  root(({title}))"]
    for node in nodes:
        label = node.get("label", "")
        lines.append(f"    {label}")
        for child in node.get("children", []):
            lines.append(f"      {child}")
    return "\n".join(lines)


def _build_flowchart(title: str, nodes: list[dict]) -> str:
    """Build Mermaid flowchart syntax from structured data."""
    lines = ["flowchart TD"]
    if title:
        lines.append(f"    root[{title}]")
    for i, node in enumerate(nodes):
        node_id = f"n{i}"
        label = node.get("label", "")
        lines.append(f"    {node_id}[{label}]")
        if title:
            lines.append(f"    root --> {node_id}")
        for j, child in enumerate(node.get("children", [])):
            child_id = f"{node_id}c{j}"
            lines.append(f"    {child_id}[{child}]")
            lines.append(f"    {node_id} --> {child_id}")
    return "\n".join(lines)


async def _render_mermaid(mermaid_code: str, output_path: str, output_format: str, theme: str) -> dict:
    """Render Mermaid code to image using mmdc CLI."""
    mmdc = shutil.which("mmdc")
    if not mmdc:
        return _error(
            "mermaid-cli (mmdc) not found. Install via: npm install -g @mermaid-js/mermaid-cli"
        )

    # Write mermaid source to temp file
    tmp_input = tempfile.NamedTemporaryFile(mode="w", suffix=".mmd", delete=False)
    tmp_input.write(mermaid_code)
    tmp_input.close()

    if not output_path:
        output_path = os.path.join(tempfile.gettempdir(), f"aura_diagram.{output_format}")

    try:
        proc = await asyncio.create_subprocess_exec(
            mmdc, "-i", tmp_input.name, "-o", output_path, "-t", theme,
            "-b", "transparent" if output_format == "png" else "white",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)

        if proc.returncode != 0:
            return _error(f"mmdc failed: {stderr.decode(errors='replace')[:500]}")

        return {
            "output_path": output_path,
            "format": output_format,
            "mermaid_code": mermaid_code,
        }
    except asyncio.TimeoutError:
        return _error("mermaid-cli timed out after 30 seconds")
    except Exception as exc:
        logger.error("[mindmap] %s", exc)
        return _error(str(exc))
    finally:
        os.unlink(tmp_input.name)


async def tool_handler(inputs: dict) -> dict:
    mermaid_code = inputs.get("mermaid_code", "")
    output_format = inputs.get("output_format", "png")
    output_path = inputs.get("output_path", "")
    theme = inputs.get("theme", "default")

    if not mermaid_code:
        # Auto-generate from structured data
        title = inputs.get("title", "Mindmap")
        nodes = inputs.get("nodes", [])
        if not nodes:
            return _error("Provide either mermaid_code or title+nodes for auto-generation")

        diagram_type = inputs.get("diagram_type", "mindmap")
        if diagram_type == "flowchart":
            mermaid_code = _build_flowchart(title, nodes)
        else:
            mermaid_code = _build_mindmap(title, nodes)

    return await _render_mermaid(mermaid_code, output_path, output_format, theme)
