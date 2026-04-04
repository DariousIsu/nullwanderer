"""
Logo & SVG Generator (OpenGFX) — AI brand design via SVG generation.

The LLM generates SVG code directly based on design system methodology.
No external APIs or libraries needed — pure SVG string output.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "logo_gen",
    "description": (
        "Generate logos, icons, brand mascots, and social media graphics as SVG files. "
        "Describe the desired design and receive production-ready SVG code. Can also "
        "convert SVG to PNG. Works fully offline — the LLM generates SVG directly "
        "following professional design system methodology."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "svg_code": {
                "type": "string",
                "description": (
                    "Raw SVG code to save/convert. If provided, saves directly without generation. "
                    "Must start with '<svg' tag."
                ),
            },
            "output_path": {
                "type": "string",
                "description": "Absolute path for the output file (auto-generated if omitted)",
            },
            "output_format": {
                "type": "string",
                "enum": ["svg", "png"],
                "description": "Output format (default: svg). PNG conversion requires cairosvg.",
                "default": "svg",
            },
            "width": {
                "type": "integer",
                "description": "PNG output width in pixels (default: 512)",
                "default": 512,
            },
            "height": {
                "type": "integer",
                "description": "PNG output height in pixels (default: 512)",
                "default": 512,
            },
        },
        "required": ["svg_code"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    svg_code = inputs.get("svg_code", "").strip()
    if not svg_code:
        return _error("svg_code is required — provide SVG markup starting with <svg")

    if not svg_code.lower().startswith("<svg") and "<svg" not in svg_code.lower():
        return _error("svg_code must contain valid SVG markup (must include <svg tag)")

    output_format = inputs.get("output_format", "svg")
    output_path = inputs.get("output_path", "")

    if not output_path:
        output_path = os.path.join(tempfile.gettempdir(), f"aura_logo.{output_format}")

    if output_format == "svg":
        Path(output_path).write_text(svg_code, encoding="utf-8")
        return {
            "output_path": output_path,
            "format": "svg",
            "size_bytes": len(svg_code.encode("utf-8")),
        }

    elif output_format == "png":
        try:
            import cairosvg
        except ImportError:
            # Fallback: save as SVG instead
            svg_path = output_path.replace(".png", ".svg")
            Path(svg_path).write_text(svg_code, encoding="utf-8")
            return {
                "output_path": svg_path,
                "format": "svg",
                "note": "cairosvg not installed for PNG conversion. Saved as SVG. Install via: pip install cairosvg",
            }

        try:
            width = inputs.get("width", 512)
            height = inputs.get("height", 512)
            cairosvg.svg2png(
                bytestring=svg_code.encode("utf-8"),
                write_to=output_path,
                output_width=width,
                output_height=height,
            )
            return {
                "output_path": output_path,
                "format": "png",
                "width": width,
                "height": height,
            }
        except Exception as exc:
            logger.error("[logo_gen] PNG conversion failed: %s", exc)
            return _error(f"PNG conversion failed: {exc}")

    return _error(f"Unsupported format: {output_format}")
