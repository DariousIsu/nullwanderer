"""
Git ingestion service — shallow-clones a repo, detects its type, and returns a
suggested node/tool configuration for the Agent Creator canvas.
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)


async def ingest_git_repo(url: str, type_hint: str | None = None) -> dict:
    """
    Clone a repo shallowly, detect its type, and return a suggested node config.

    Returns:
        {url, detected_type, suggested_node_type, preview_definition}
        or {error: str} on failure.
    """
    import tempfile

    with tempfile.TemporaryDirectory() as tmpdir:
        proc = await asyncio.create_subprocess_exec(
            "git", "clone", "--depth=1", url, tmpdir,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
            return {"error": "Clone timed out after 60s"}

        if proc.returncode != 0:
            return {"error": f"Clone failed: {stderr.decode().strip()}"}

        path = Path(tmpdir)
        detected_type = _detect_repo_type(path, type_hint)

        return {
            "url":                url,
            "detected_type":      detected_type,
            "suggested_node_type": _suggest_node_type(detected_type),
            "preview_definition": _build_preview(url, detected_type),
        }


def _detect_repo_type(path: Path, hint: str | None) -> str:
    if hint:
        return hint

    pkg = path / "package.json"
    if pkg.exists():
        try:
            data = json.loads(pkg.read_text())
            deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
            if "@modelcontextprotocol/sdk" in deps or "mcp" in data.get("name", "").lower():
                return "mcp_server"
        except Exception:
            pass
        return "node_library"

    if (path / "pyproject.toml").exists() or (path / "setup.py").exists():
        return "python_library"

    # Knowledge repo: has markdown, no code
    has_md  = bool(list(path.glob("*.md")))
    has_code = bool(list(path.glob("*.py")) or list(path.glob("*.js")) or list(path.glob("*.ts")))
    if has_md and not has_code:
        return "knowledge"

    return "raw_script"


def _suggest_node_type(detected_type: str) -> str:
    return {
        "mcp_server":     "tool",
        "python_library": "tool",
        "node_library":   "tool",
        "raw_script":     "code_exec",
        "knowledge":      "memory_read",
    }.get(detected_type, "tool")


def _build_preview(url: str, detected_type: str) -> dict:
    return {
        "type": _suggest_node_type(detected_type),
        "data": {
            "source":        "git",
            "url":           url,
            "detected_type": detected_type,
        },
    }
