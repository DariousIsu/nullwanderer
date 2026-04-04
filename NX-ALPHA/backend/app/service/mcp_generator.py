"""
AURA NX-Alpha — MCP Generator

Generates server.py (self-contained MCP server) and publish packages:
  mcp/       — server.py + pyproject.toml + install.ps1 + install.sh + mcp_config.json
  claude_project/ — formatted system prompt doc for claude.ai Projects
  chatgpt/   — GPT builder prompt
  gemini/    — Gemini Gem instructions

All generated MCPs are fully self-contained — no AURA dependency at runtime.
"""
from __future__ import annotations

import json
import logging
import re
import textwrap
import time
import zipfile
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_MCP_BASE     = Path.home() / ".aura" / "mcp_tools"
_WRAPPERS_BASE = Path.home() / ".aura" / "tool_wrappers"


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _load_golden(tool_id: str, max_examples: int = 10) -> list[dict]:
    path = _MCP_BASE / tool_id / "golden_set.jsonl"
    entries: list[dict] = []
    if not path.exists():
        return entries
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    entries.append(json.loads(line))
                except Exception:
                    pass
            if len(entries) >= max_examples:
                break
    return entries


def _format_few_shot(entries: list[dict]) -> str:
    lines: list[str] = []
    for i, entry in enumerate(entries, 1):
        messages = entry.get("messages", [])
        user_msg = next((m["content"] for m in messages if m["role"] == "user"), "")
        asst_msg = next((m["content"] for m in messages if m["role"] == "assistant"), "")
        if user_msg and asst_msg:
            lines.append(f"Example {i}:")
            lines.append(f"  Input: {user_msg[:300]}")
            lines.append(f"  Output: {asst_msg[:300]}")
            lines.append("")
    return "\n".join(lines)


def _bump_version(version_tag: str) -> str:
    """1.0.0 → 1.0.1"""
    parts = version_tag.split(".")
    if len(parts) == 3:
        try:
            parts[2] = str(int(parts[2]) + 1)
            return ".".join(parts)
        except ValueError:
            pass
    return version_tag


def _collect_deps(tool) -> list[str]:
    """Union required_packages from all approved wrappers. Always include mcp + httpx."""
    base = {"mcp", "httpx"}
    if tool.build_plan:
        for w in tool.build_plan.get("wrappers", []):
            if w.get("status") == "approved":
                base.update(w.get("required_packages", []))
    return sorted(base)


def _load_wrapper_code(tool_id: str, tool) -> tuple[str, str]:
    """
    Returns (all_wrapper_code, tool_handler_source).
    For single wrapper: wrapper IS the handler.
    For multi-wrapper: orchestrator.py provides the handler.
    """
    wrapper_dir = Path(tool.wrapper_path) if tool.wrapper_path else (_WRAPPERS_BASE / tool_id)
    if not wrapper_dir.exists():
        return "", "async def tool_handler(inputs: dict) -> dict:\n    return {'error': 'no wrapper found'}\n"

    wrappers = tool.build_plan.get("wrappers", []) if tool.build_plan else []
    approved = [w for w in wrappers if w.get("status") == "approved"]

    wrapper_segments: list[str] = []
    for w in approved:
        fpath = wrapper_dir / f"{w['gap_slug']}.py"
        if fpath.exists():
            code = fpath.read_text(encoding="utf-8")
            # Rename tool_handler to avoid collision in multi-wrapper case
            if len(approved) > 1:
                code = code.replace(
                    "async def tool_handler(",
                    f"async def {w['gap_slug']}_handler(",
                )
            wrapper_segments.append(f"# === {w['gap_slug']} ===\n{code}")

    all_code = "\n\n".join(wrapper_segments)

    # Orchestrator
    orch_path = wrapper_dir / "orchestrator.py"
    if len(approved) > 1 and orch_path.exists():
        orch_code = orch_path.read_text(encoding="utf-8")
        # Update imports to match renamed handlers
        for w in approved:
            orch_code = orch_code.replace(
                f"from {w['gap_slug']} import tool_handler as {w['gap_slug']}_tool",
                f"# (inline) {w['gap_slug']}_handler already defined above",
            ).replace(
                f"await {w['gap_slug']}_tool(",
                f"await {w['gap_slug']}_handler(",
            )
        handler_src = orch_code
    elif approved:
        # Single wrapper — tool_handler is already defined in wrapper_segments
        handler_src = ""  # already in all_code
    else:
        handler_src = "async def tool_handler(inputs: dict) -> dict:\n    return {'error': 'no approved wrappers'}\n"

    return all_code, handler_src


# ─────────────────────────────────────────────────────────────────────────────
# SERVER.PY GENERATION
# ─────────────────────────────────────────────────────────────────────────────

_SERVER_TEMPLATE = '''\
#!/usr/bin/env python3
"""
{tool_name} — MCP Server
Generated by AURA NX-Alpha Tool Developer Workspace.
Self-contained: no AURA required at runtime.
"""
# ── stdlib only for MCP protocol ──────────────────────────────────────────────
import asyncio
import sys
import logging

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
logger = logging.getLogger(__name__)

try:
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp import types
except ImportError:
    sys.stderr.write("ERROR: mcp package not installed. Run: pip install mcp\\n")
    sys.exit(1)

# ── Tool identity ──────────────────────────────────────────────────────────────

TOOL_NAME = "{tool_id}"

TOOL_DESCRIPTION = """{tool_description}

{few_shot_section}"""

FEW_SHOT_EXAMPLES = {few_shot_json}

TOOL_INPUT_SCHEMA = {input_schema_json}

# ── Wrapper code (from approved wrappers + orchestrator) ───────────────────────

{wrapper_code}

{handler_code}

# ── MCP server ─────────────────────────────────────────────────────────────────

app = Server(TOOL_NAME)


@app.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name=TOOL_NAME,
            description=TOOL_DESCRIPTION,
            inputSchema=TOOL_INPUT_SCHEMA,
        )
    ]


@app.call_tool()
async def call_tool(name: str, arguments: dict) -> list[types.TextContent]:
    if name != TOOL_NAME:
        raise ValueError(f"Unknown tool: {{name}}")
    try:
        result = await tool_handler(arguments)
        return [types.TextContent(type="text", text=json.dumps(result, ensure_ascii=False))]
    except Exception as exc:
        logger.error("tool_handler failed: %s", exc)
        return [types.TextContent(type="text", text=json.dumps({{"error": str(exc)}})) ]


async def main() -> None:
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    import json  # ensure available in scope
    asyncio.run(main())
'''


def generate_server_py(tool_id: str) -> Path:
    """Generate server.py for the given tool. Returns path to generated file."""
    from app.service.mcp_tool_store import get_mcp_tool_store
    store = get_mcp_tool_store()
    tool  = store.get_tool(tool_id)
    if not tool:
        raise ValueError(f"Tool {tool_id} not found")

    out_dir = _MCP_BASE / tool_id / "mcp"
    out_dir.mkdir(parents=True, exist_ok=True)

    golden = _load_golden(tool_id)
    few_shot_text = _format_few_shot(golden)
    few_shot_section = f"Usage examples:\n{few_shot_text}" if few_shot_text else ""

    description = tool.optimized_prompt or tool.base_prompt or tool.description
    wrapper_code, handler_code = _load_wrapper_code(tool_id, tool)

    server_src = _SERVER_TEMPLATE.format(
        tool_name=tool.name,
        tool_id=tool_id,
        tool_description=description.replace('"""', "'''"),
        few_shot_section=few_shot_section,
        few_shot_json=json.dumps(
            [{"input": next((m["content"] for m in e.get("messages",[]) if m["role"]=="user"),""),
              "output": next((m["content"] for m in e.get("messages",[]) if m["role"]=="assistant"),"")}
             for e in golden], indent=2, ensure_ascii=False),
        input_schema_json=json.dumps(tool.input_schema, indent=2, ensure_ascii=False),
        wrapper_code=wrapper_code,
        handler_code=handler_code,
    )

    server_path = out_dir / "server.py"
    server_path.write_text(server_src, encoding="utf-8")
    logger.info("[mcp_generator] server.py written to %s", server_path)
    return server_path


# ─────────────────────────────────────────────────────────────────────────────
# PYPROJECT.TOML
# ─────────────────────────────────────────────────────────────────────────────

def _generate_pyproject(tool_id: str, tool, version_tag: str) -> str:
    deps = _collect_deps(tool)
    deps_str = "\n".join(f'    "{d}",' for d in deps)
    return textwrap.dedent(f"""\
        [build-system]
        requires = ["hatchling"]
        build-backend = "hatchling.build"

        [project]
        name = "{tool_id}"
        version = "{version_tag}"
        description = "{tool.description.replace(chr(34), chr(39))}"
        requires-python = ">=3.10"
        dependencies = [
        {deps_str}
        ]

        [project.scripts]
        {tool_id} = "server:main"
    """)


# ─────────────────────────────────────────────────────────────────────────────
# INSTALL SCRIPTS
# ─────────────────────────────────────────────────────────────────────────────

def _generate_install_ps1(tool_id: str, tool_name: str) -> str:
    return textwrap.dedent(f"""\
        # {tool_name} — MCP Server Installer (Windows PowerShell)
        # Run: .\\install.ps1

        Set-StrictMode -Version Latest
        $ErrorActionPreference = "Stop"

        # 1. Ensure uv is installed
        if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {{
            Write-Host "Installing uv package manager..."
            irm https://astral.sh/uv/install.ps1 | iex
        }}

        # 2. Install the MCP server package
        Write-Host "Installing {tool_name}..."
        uv tool install .

        # 3. Patch AI client configs
        $configs = @(
            "$env:APPDATA\\Claude\\claude_desktop_config.json",
            "$env:APPDATA\\Cursor\\User\\globalStorage\\saoudrizwan.claude-dev\\settings\\cline_mcp_settings.json"
        )

        $mcpEntry = '"{tool_id}": {{"command": "uvx", "args": ["{tool_id}"]}}'

        foreach ($configPath in $configs) {{
            if (Test-Path $configPath) {{
                # Backup
                $backup = "$configPath.bak.$((Get-Date).ToString('yyyyMMddHHmmss'))"
                Copy-Item $configPath $backup
                Write-Host "Backed up $configPath to $backup"

                try {{
                    $config = Get-Content $configPath -Raw | ConvertFrom-Json
                    if (-not $config.mcpServers) {{
                        $config | Add-Member -NotePropertyName mcpServers -NotePropertyValue @{{}}
                    }}
                    $config.mcpServers | Add-Member -NotePropertyName "{tool_id}" -NotePropertyValue @{{command="uvx"; args=@("{tool_id}")}} -Force
                    $config | ConvertTo-Json -Depth 10 | Set-Content $configPath -Encoding UTF8
                    Write-Host "Updated $configPath"
                }} catch {{
                    Write-Warning "Failed to update $configPath`: $_"
                    Copy-Item $backup $configPath  # restore on error
                }}
            }}
        }}

        Write-Host ""
        Write-Host "✓ {tool_name} installed. Restart Claude Desktop / Cursor to activate."
    """)


def _generate_install_sh(tool_id: str, tool_name: str) -> str:
    return textwrap.dedent(f"""\
        #!/bin/bash
        # {tool_name} — MCP Server Installer (Mac/Linux)
        # Run: bash install.sh

        set -e

        # 1. Ensure uv is installed
        if ! command -v uv &>/dev/null; then
            echo "Installing uv package manager..."
            curl -LsSf https://astral.sh/uv/install.sh | sh
            export PATH="$HOME/.cargo/bin:$PATH"
        fi

        # 2. Install the MCP server package
        echo "Installing {tool_name}..."
        uv tool install .

        # 3. Patch Claude Desktop config (Mac)
        CONFIG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
        if [ -f "$CONFIG" ]; then
            BACKUP="${{CONFIG}}.bak.$(date +%Y%m%d%H%M%S)"
            cp "$CONFIG" "$BACKUP"
            echo "Backed up config to $BACKUP"

            python3 -c "
        import json, sys
        with open('$CONFIG', 'r') as f:
            c = json.load(f)
        c.setdefault('mcpServers', {{}})
        c['mcpServers']['{tool_id}'] = {{'command': 'uvx', 'args': ['{tool_id}']}}
        with open('$CONFIG', 'w') as f:
            json.dump(c, f, indent=2)
        print('Updated Claude Desktop config')
        " || (echo "Config update failed, restoring backup"; cp "$BACKUP" "$CONFIG")
        fi

        echo ""
        echo "✓ {tool_name} installed. Restart Claude Desktop to activate."
    """)


# ─────────────────────────────────────────────────────────────────────────────
# PROMPT PACKAGES
# ─────────────────────────────────────────────────────────────────────────────

def _generate_claude_project_doc(tool) -> str:
    few_shot = _format_few_shot(_load_golden(tool.id, max_examples=5))
    return textwrap.dedent(f"""\
        # {tool.name} — Claude Project Setup Guide

        ## System Prompt

        Paste the following into your Claude Project's "Project Instructions":

        ---

        {tool.optimized_prompt or tool.base_prompt or tool.description}

        ---

        ## Usage Examples

        {few_shot or "No examples available yet."}

        ## What This Tool Does

        {tool.description}

        ## Expected Inputs

        ```json
        {json.dumps(tool.input_schema, indent=2)}
        ```

        ## Expected Output

        {tool.output_description or "Structured JSON response."}
    """)


def _generate_chatgpt_gpt_doc(tool) -> str:
    return textwrap.dedent(f"""\
        # {tool.name} — ChatGPT Custom GPT Setup

        ## Instructions (paste into GPT Builder → Instructions)

        {tool.optimized_prompt or tool.base_prompt or tool.description}

        ## Conversation Starters

        {chr(10).join(f"- {m['content'][:100]}" for entry in _load_golden(tool.id, 4) for m in entry.get("messages",[]) if m["role"]=="user")[:500] or "Ask me anything about " + tool.name}

        ## Description (for GPT Profile)

        {tool.description}

        ## Target Users

        {tool.target_users or "General users"}
    """)


def _generate_gemini_gem_doc(tool) -> str:
    return textwrap.dedent(f"""\
        # {tool.name} — Gemini Gem Instructions

        ## Gem Instructions (paste into Gem builder)

        {tool.optimized_prompt or tool.base_prompt or tool.description}

        ## Gem Name

        {tool.name}

        ## Gem Description

        {tool.description}

        ## Example Prompts

        {chr(10).join(f"- {m['content'][:100]}" for entry in _load_golden(tool.id, 4) for m in entry.get("messages",[]) if m["role"]=="user")[:500] or "Use me for: " + tool.description[:100]}
    """)


# ─────────────────────────────────────────────────────────────────────────────
# PUBLISH
# ─────────────────────────────────────────────────────────────────────────────

def publish(tool_id: str, targets: list[str], expose_components: bool = False) -> dict:
    """
    Generate selected target packages. Returns {targets_generated, publish_path}.
    Idempotent — safe to call multiple times.
    """
    from app.service.mcp_tool_store import get_mcp_tool_store
    store = get_mcp_tool_store()
    tool  = store.get_tool(tool_id)
    if not tool:
        raise ValueError(f"Tool {tool_id} not found")

    # Bump version
    new_tag = _bump_version(tool.version_tag)
    base_dir = _MCP_BASE / tool_id
    base_dir.mkdir(parents=True, exist_ok=True)

    generated: list[str] = []

    if "mcp" in targets:
        _publish_mcp(tool_id, tool, base_dir, new_tag, expose_components)
        generated.append("mcp")

    if "claude_project" in targets:
        cp_dir = base_dir / "claude_project"
        cp_dir.mkdir(exist_ok=True)
        (cp_dir / f"{tool_id}_claude.md").write_text(
            _generate_claude_project_doc(tool), encoding="utf-8"
        )
        generated.append("claude_project")

    if "chatgpt_gpt" in targets:
        cg_dir = base_dir / "chatgpt"
        cg_dir.mkdir(exist_ok=True)
        (cg_dir / f"{tool_id}_gpt.md").write_text(
            _generate_chatgpt_gpt_doc(tool), encoding="utf-8"
        )
        generated.append("chatgpt_gpt")

    if "gemini_gem" in targets:
        gg_dir = base_dir / "gemini"
        gg_dir.mkdir(exist_ok=True)
        (gg_dir / f"{tool_id}_gem.md").write_text(
            _generate_gemini_gem_doc(tool), encoding="utf-8"
        )
        generated.append("gemini_gem")

    # Push golden set to Phoenix Datasets (best-effort)
    _push_golden_to_phoenix(tool_id, tool)

    # Register internal invoke route
    _register_internal_routes(tool_id, tool)

    # Update store
    existing_targets = list(set(tool.publish_targets + generated))
    store.update_fields(
        tool_id,
        published=True,
        publish_targets=existing_targets,
        publish_path=str(base_dir),
        expose_components=expose_components,
        version_tag=new_tag,
        stage="published",
        blocking_reason=None,
    )

    return {
        "targets_generated": generated,
        "publish_path":      str(base_dir),
        "version_tag":       new_tag,
    }


def _publish_mcp(tool_id: str, tool, base_dir: Path, version_tag: str, expose_components: bool) -> None:
    mcp_dir = base_dir / "mcp"
    mcp_dir.mkdir(exist_ok=True)

    # Generate server.py
    generate_server_py(tool_id)

    # pyproject.toml
    (mcp_dir / "pyproject.toml").write_text(
        _generate_pyproject(tool_id, tool, version_tag), encoding="utf-8"
    )

    # Install scripts
    (mcp_dir / "install.ps1").write_text(
        _generate_install_ps1(tool_id, tool.name), encoding="utf-8"
    )
    (mcp_dir / "install.sh").write_text(
        _generate_install_sh(tool_id, tool.name), encoding="utf-8"
    )

    # mcp_config.json
    mcp_config = {
        "mcpServers": {
            tool_id: {"command": "uvx", "args": [tool_id]}
        }
    }
    (mcp_dir / "mcp_config.json").write_text(
        json.dumps(mcp_config, indent=2), encoding="utf-8"
    )

    # ZIP the package
    zip_path = mcp_dir / f"{tool_id}.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in mcp_dir.iterdir():
            if f.name != f"{tool_id}.zip" and f.is_file():
                zf.write(f, arcname=f.name)

    logger.info("[mcp_generator] MCP package zipped: %s", zip_path)


def _push_golden_to_phoenix(tool_id: str, tool) -> None:
    try:
        from app.service.phoenix_exporter import _load_config
        import httpx as _httpx
        golden = _load_golden(tool_id)
        if not golden:
            return
        cfg  = _load_config()
        host = cfg["host"].rstrip("/")
        payload = {
            "name":  f"{tool_id}_golden_set",
            "inputs": [
                {"messages": e.get("messages", [])} for e in golden
            ],
        }
        _httpx.post(f"{host}/v1/datasets/upload", json=payload, timeout=10.0)
    except Exception:
        pass


def _register_internal_routes(tool_id: str, tool) -> None:
    """Register POST /tools/{id}/invoke as a dynamic FastAPI route."""
    try:
        from app.main import app as fastapi_app
        _add_invoke_route(fastapi_app, tool_id)
    except Exception as exc:
        logger.warning("[mcp_generator] Route registration failed (non-fatal): %s", exc)


def _add_invoke_route(fastapi_app, tool_id: str) -> None:
    """Add /tools/{tool_id}/invoke endpoint that directly imports the orchestrator."""
    import importlib.util
    from fastapi import HTTPException
    from fastapi.responses import JSONResponse

    wrapper_dir = _WRAPPERS_BASE / tool_id
    orch_path   = wrapper_dir / "orchestrator.py"
    # Fallback: find first approved wrapper
    if not orch_path.exists():
        py_files = list(wrapper_dir.glob("*.py"))
        if not py_files:
            return
        orch_path = py_files[0]

    route_path = f"/tools/{tool_id}/invoke"

    # Check if route already registered
    existing = [r.path for r in fastapi_app.routes if hasattr(r, "path")]
    if route_path in existing:
        return

    async def invoke_handler(request_body: dict = None):
        try:
            spec = importlib.util.spec_from_file_location("orchestrator", str(orch_path))
            mod  = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
            handler = getattr(mod, "tool_handler", None)
            if not handler:
                raise HTTPException(500, "tool_handler not found in orchestrator")
            result = await handler(request_body or {})
            return JSONResponse(content=result)
        except Exception as exc:
            raise HTTPException(500, str(exc))

    fastapi_app.add_api_route(
        route_path,
        invoke_handler,
        methods=["POST"],
        tags=["tools"],
    )
    logger.info("[mcp_generator] Registered route: POST %s", route_path)


# ─────────────────────────────────────────────────────────────────────────────
# STARTUP RE-REGISTRATION
# ─────────────────────────────────────────────────────────────────────────────

def reregister_published_routes(fastapi_app) -> None:
    """Called at AURA startup — re-registers all published tool routes."""
    try:
        from app.service.mcp_tool_store import get_mcp_tool_store
        store = get_mcp_tool_store()
        published = store.list_published()
        for tool in published:
            try:
                _add_invoke_route(fastapi_app, tool.id)
            except Exception as exc:
                logger.warning("[mcp_generator] Re-register failed for %s: %s", tool.id, exc)
        if published:
            logger.info("[mcp_generator] Re-registered %d published tool routes", len(published))
    except Exception as exc:
        logger.warning("[mcp_generator] Startup re-registration failed (non-fatal): %s", exc)
