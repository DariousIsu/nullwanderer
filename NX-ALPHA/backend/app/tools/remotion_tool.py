"""
remotion_tool.py
─────────────────
AURA MCP tool — Programmatic video generation via Remotion.

Renders React-based video compositions to MP4 using Remotion CLI.
Remotion enables data-driven videos — pass props to a React component
and render it as video.

No API key required. Requires Node.js + Remotion project:
  npm init video  (creates new Remotion project)
  OR use an existing project path via AURA_REMOTION_PROJECT_DIR in .env

Operations: render (render composition to video), list_compositions (show available comps).
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

_DEFAULT_PROJECT = os.environ.get("AURA_REMOTION_PROJECT_DIR", str(Path.home() / "remotion-project"))
_OUTPUT_DIR      = str(Path.home() / ".aura" / "videos")

TOOL_DEF = {
    "name": "remotion_render",
    "description": (
        "Generate videos programmatically using Remotion (React-based video framework). "
        "Operations: render (render a named composition to MP4), "
        "list_compositions (show available compositions in project). "
        "Props are passed as JSON to the React composition. "
        "Requires Node.js and a Remotion project (npm init video, or set AURA_REMOTION_PROJECT_DIR)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["render", "list_compositions"],
                "description": "Operation to perform",
            },
            "composition": {
                "type": "string",
                "description": "Composition ID to render (for render, e.g. 'MyVideo')",
            },
            "props": {
                "type": "object",
                "description": "JSON props to pass to the composition (for render)",
            },
            "output": {
                "type": "string",
                "description": "Output file path (default: ~/.aura/videos/<composition>.mp4)",
            },
            "project_dir": {
                "type": "string",
                "description": f"Path to Remotion project directory (default: {_DEFAULT_PROJECT})",
            },
            "concurrency": {
                "type": "integer",
                "description": "Number of threads for rendering (default: 4)",
                "default": 4,
            },
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    operation   = inputs.get("operation", "")
    project_dir = inputs.get("project_dir", _DEFAULT_PROJECT)

    if not Path(project_dir).exists():
        return {
            "error": f"Remotion project directory not found: {project_dir}",
            "hint":  "Create a project: npm init video, or set AURA_REMOTION_PROJECT_DIR in .env",
        }

    if operation == "list_compositions":
        try:
            proc = await asyncio.create_subprocess_exec(
                "npx", "remotion", "compositions",
                cwd=project_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
            if proc.returncode != 0:
                return {"error": stderr.decode(errors="replace")[-500:]}
            return {"output": stdout.decode(errors="replace"), "cwd": project_dir}
        except FileNotFoundError:
            return {"error": "npx not found — ensure Node.js is installed and in PATH"}
        except asyncio.TimeoutError:
            return {"error": "Listing compositions timed out"}
        except Exception as exc:
            return {"error": str(exc)}

    if operation == "render":
        composition  = inputs.get("composition", "")
        props        = inputs.get("props", {})
        concurrency  = int(inputs.get("concurrency", 4))
        if not composition:
            return {"error": "composition ID required"}

        Path(_OUTPUT_DIR).mkdir(parents=True, exist_ok=True)
        output_path = inputs.get("output", str(Path(_OUTPUT_DIR) / f"{composition}.mp4"))

        cmd = [
            "npx", "remotion", "render",
            composition,
            output_path,
            "--concurrency", str(concurrency),
            "--log", "verbose",
        ]
        if props:
            import json
            cmd += ["--props", json.dumps(props)]

        logger.info("[remotion_tool] Rendering: %s → %s", composition, output_path)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=project_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=600)
        except FileNotFoundError:
            return {"error": "npx not found — ensure Node.js is installed"}
        except asyncio.TimeoutError:
            return {"error": "Render timed out after 10 minutes"}
        except Exception as exc:
            return {"error": str(exc)}

        if proc.returncode == 0:
            return {
                "success":     True,
                "output_file": output_path,
                "composition": composition,
            }
        return {
            "error":  f"Render failed (exit {proc.returncode})",
            "stderr": stderr.decode(errors="replace")[-1000:],
        }

    return {"error": f"Unknown operation: {operation}"}
