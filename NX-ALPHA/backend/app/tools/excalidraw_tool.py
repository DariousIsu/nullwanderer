"""
Excalidraw Flowchart — Generate .excalidraw diagram files from text.

Creates Excalidraw-compatible JSON files for flowcharts, architecture
diagrams, and whiteboard sketches. Fully local, no API keys.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "excalidraw",
    "description": (
        "Generate Excalidraw diagram files (.excalidraw) from structured data. "
        "Create flowcharts, architecture diagrams, org charts, and whiteboard "
        "sketches that can be opened in excalidraw.com or VS Code Excalidraw plugin. "
        "Works fully offline."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "nodes": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "label": {"type": "string"},
                        "x": {"type": "number"},
                        "y": {"type": "number"},
                        "width": {"type": "number", "default": 200},
                        "height": {"type": "number", "default": 60},
                        "type": {
                            "type": "string",
                            "enum": ["rectangle", "diamond", "ellipse"],
                            "default": "rectangle",
                        },
                        "color": {"type": "string", "default": "#1e1e1e"},
                        "bg_color": {"type": "string", "default": "#a5d8ff"},
                    },
                },
                "description": "Diagram nodes with position and style",
            },
            "edges": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "from": {"type": "string", "description": "Source node ID"},
                        "to": {"type": "string", "description": "Target node ID"},
                        "label": {"type": "string", "default": ""},
                    },
                },
                "description": "Connections between nodes",
            },
            "title": {
                "type": "string",
                "description": "Diagram title (added as text element)",
                "default": "",
            },
            "output_path": {
                "type": "string",
                "description": "Output .excalidraw file path (auto-generated if omitted)",
            },
        },
        "required": ["nodes"],
    },
}


def _make_id() -> str:
    import random
    return "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=10))


def _create_element(
    element_type: str, x: float, y: float, width: float, height: float,
    label: str = "", color: str = "#1e1e1e", bg_color: str = "#a5d8ff",
    node_id: str = "",
) -> dict:
    """Create an Excalidraw element."""
    eid = node_id or _make_id()

    element = {
        "id": eid,
        "type": element_type,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
        "angle": 0,
        "strokeColor": color,
        "backgroundColor": bg_color,
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "roundness": {"type": 3},
        "seed": hash(eid) % 2**31,
        "version": 1,
        "versionNonce": hash(eid + "v") % 2**31,
        "isDeleted": False,
        "boundElements": [],
        "updated": 1,
        "link": None,
        "locked": False,
    }

    elements = [element]

    # Add text label
    if label:
        text_id = _make_id()
        text_element = {
            "id": text_id,
            "type": "text",
            "x": x + 10,
            "y": y + height / 2 - 10,
            "width": width - 20,
            "height": 20,
            "angle": 0,
            "strokeColor": color,
            "backgroundColor": "transparent",
            "fillStyle": "solid",
            "strokeWidth": 1,
            "strokeStyle": "solid",
            "roughness": 1,
            "opacity": 100,
            "groupIds": [],
            "roundness": None,
            "seed": hash(text_id) % 2**31,
            "version": 1,
            "versionNonce": hash(text_id + "v") % 2**31,
            "isDeleted": False,
            "boundElements": None,
            "updated": 1,
            "link": None,
            "locked": False,
            "text": label,
            "fontSize": 16,
            "fontFamily": 1,
            "textAlign": "center",
            "verticalAlign": "middle",
            "containerId": eid,
            "originalText": label,
        }
        elements.append(text_element)

        # Update parent to reference the text
        element["boundElements"] = [{"id": text_id, "type": "text"}]

    return elements


def _create_arrow(from_el: dict, to_el: dict, label: str = "") -> list[dict]:
    """Create an arrow between two elements."""
    arrow_id = _make_id()

    # Calculate connection points (center-right to center-left)
    start_x = from_el["x"] + from_el["width"]
    start_y = from_el["y"] + from_el["height"] / 2
    end_x = to_el["x"]
    end_y = to_el["y"] + to_el["height"] / 2

    # If target is below, connect bottom to top
    if to_el["y"] > from_el["y"] + from_el["height"]:
        start_x = from_el["x"] + from_el["width"] / 2
        start_y = from_el["y"] + from_el["height"]
        end_x = to_el["x"] + to_el["width"] / 2
        end_y = to_el["y"]

    arrow = {
        "id": arrow_id,
        "type": "arrow",
        "x": start_x,
        "y": start_y,
        "width": end_x - start_x,
        "height": end_y - start_y,
        "angle": 0,
        "strokeColor": "#1e1e1e",
        "backgroundColor": "transparent",
        "fillStyle": "solid",
        "strokeWidth": 2,
        "strokeStyle": "solid",
        "roughness": 1,
        "opacity": 100,
        "groupIds": [],
        "roundness": {"type": 2},
        "seed": hash(arrow_id) % 2**31,
        "version": 1,
        "versionNonce": hash(arrow_id + "v") % 2**31,
        "isDeleted": False,
        "boundElements": None,
        "updated": 1,
        "link": None,
        "locked": False,
        "points": [[0, 0], [end_x - start_x, end_y - start_y]],
        "lastCommittedPoint": None,
        "startBinding": {"elementId": from_el["id"], "focus": 0, "gap": 5},
        "endBinding": {"elementId": to_el["id"], "focus": 0, "gap": 5},
        "startArrowhead": None,
        "endArrowhead": "arrow",
    }

    return [arrow]


async def tool_handler(inputs: dict) -> dict:
    nodes_data = inputs.get("nodes", [])
    if not nodes_data:
        return _error("nodes is required — provide diagram nodes")

    edges_data = inputs.get("edges", [])
    title = inputs.get("title", "")
    output_path = inputs.get("output_path", "")

    if not output_path:
        output_path = os.path.join(tempfile.gettempdir(), "aura_diagram.excalidraw")

    all_elements = []
    node_map = {}  # id -> element dict

    # Create title if provided
    if title:
        title_elements = _create_element(
            "text", 10, 10, len(title) * 12, 30,
            label="", color="#1e1e1e", bg_color="transparent",
        )
        # Override to be a plain text
        title_el = {
            "id": _make_id(),
            "type": "text",
            "x": 10, "y": 10,
            "width": len(title) * 12, "height": 30,
            "text": title, "fontSize": 24, "fontFamily": 1,
            "textAlign": "left", "verticalAlign": "top",
            "strokeColor": "#1e1e1e", "backgroundColor": "transparent",
            "fillStyle": "solid", "strokeWidth": 1, "strokeStyle": "solid",
            "roughness": 1, "opacity": 100, "angle": 0,
            "groupIds": [], "roundness": None,
            "seed": 42, "version": 1, "versionNonce": 43,
            "isDeleted": False, "boundElements": None, "updated": 1,
            "link": None, "locked": False, "originalText": title,
            "containerId": None,
        }
        all_elements.append(title_el)

    # Create nodes
    for node in nodes_data:
        node_id = node.get("id", _make_id())
        shape = node.get("type", "rectangle")
        x = node.get("x", 0)
        y = node.get("y", 0)
        w = node.get("width", 200)
        h = node.get("height", 60)
        label = node.get("label", "")
        color = node.get("color", "#1e1e1e")
        bg = node.get("bg_color", "#a5d8ff")

        elements = _create_element(shape, x, y, w, h, label, color, bg, node_id)
        all_elements.extend(elements)
        node_map[node_id] = elements[0]  # Store the shape element

    # Create edges
    for edge in edges_data:
        from_id = edge.get("from", "")
        to_id = edge.get("to", "")
        if from_id in node_map and to_id in node_map:
            arrows = _create_arrow(node_map[from_id], node_map[to_id], edge.get("label", ""))
            all_elements.extend(arrows)

    # Build Excalidraw file
    excalidraw_data = {
        "type": "excalidraw",
        "version": 2,
        "source": "https://excalidraw.com",
        "elements": all_elements,
        "appState": {
            "gridSize": None,
            "viewBackgroundColor": "#ffffff",
        },
        "files": {},
    }

    Path(output_path).write_text(json.dumps(excalidraw_data, indent=2), encoding="utf-8")

    return {
        "output_path": output_path,
        "format": "excalidraw",
        "nodes": len(nodes_data),
        "edges": len(edges_data),
    }
