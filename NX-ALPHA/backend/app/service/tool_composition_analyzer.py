"""
AURA NX-Alpha — Tool Composition Analyzer

Scans AURA's existing tool ecosystem and GitHub for components that address
each gap in a tool spec. Generates wrapper code (async def tool_handler) and
an orchestrator for multi-wrapper tools. Validates wrappers via Ruff + llm-sandbox.

FLOW:
    POST /mcp-tools/{id}/analyze → background task → SSE events
    POST /mcp-tools/{id}/sandbox-wrappers → ruff check + Docker sandbox
    POST /mcp-tools/{id}/submit-resources → re-analyze with user-provided URLs/code
    POST /mcp-tools/{id}/approve-plan → commit wrappers + orchestrator to disk
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

_WRAPPERS_BASE = Path.home() / ".aura" / "tool_wrappers"
_PAGE_SIZE     = 5   # GitHub search results per gap

# AURA internal capabilities → free external API equivalents
AURA_CAPABILITY_MAP = {
    "web_search":         "DuckDuckGo Instant Answer API (free, no key) — GET https://api.duckduckgo.com/?q={query}&format=json",
    "memory_search":      "sentence-transformers + cosine similarity (pip install sentence-transformers)",
    "pdf_parse":          "pypdf (pip install pypdf)",
    "web_scrape":         "httpx + BeautifulSoup4 (pip install httpx beautifulsoup4)",
    "document_extract":   "pypdf for PDF, python-docx for DOCX (pip install pypdf python-docx)",
    "data_analysis":      "pandas + numpy (pip install pandas numpy)",
    "citation_lookup":    "habanero CrossRef client (pip install habanero)",
    "geocoding":          "Nominatim via geopy (pip install geopy) — free, no key",
    "legal_search":       "CourtListener REST API (free, no key for basic use)",
    "news_fetch":         "NewsAPI (free tier) or feedparser for RSS (pip install feedparser)",
    "image_analyze":      "Pillow + pytesseract for OCR (pip install pillow pytesseract)",
    "math_compute":       "sympy or scipy (pip install sympy scipy)",
    "code_execute":       "subprocess.run with timeout (stdlib)",
    "http_request":       "httpx (pip install httpx)",
}

_WRAPPER_SCHEMA = {
    "type": "object",
    "properties": {
        "wrapper_code":        {"type": "string"},
        "wrapper_description": {"type": "string"},
        "required_packages":   {"type": "array", "items": {"type": "string"}},
    },
    "required": ["wrapper_code", "wrapper_description", "required_packages"],
}

_ORCHESTRATOR_SCHEMA = {
    "type": "object",
    "properties": {
        "orchestrator_code": {"type": "string"},
        "call_sequence":     {"type": "array", "items": {"type": "string"}},
    },
    "required": ["orchestrator_code"],
}

_GAP_SCHEMA = {
    "type": "object",
    "properties": {
        "matching_tools": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "tool_name":  {"type": "string"},
                    "fit_score":  {"type": "number"},
                    "fit_reason": {"type": "string"},
                },
            },
        },
        "gaps": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["matching_tools", "gaps"],
}


# ─────────────────────────────────────────────────────────────────────────────
# SSE EMIT
# ─────────────────────────────────────────────────────────────────────────────

async def _emit(event_type: str, data: dict) -> None:
    try:
        from app.controller.chat_controller import _emit as _chat_emit
        await _chat_emit(event_type, data)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_ollama():
    try:
        from app.service.ollama_service import get_ollama_service
        return get_ollama_service()
    except Exception:
        return None


def _get_settings():
    try:
        from app.config import get_settings
        return get_settings()
    except Exception:
        return None


def _github_headers() -> dict:
    settings = _get_settings()
    token = settings.github_token if settings else ""
    h = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


# ─────────────────────────────────────────────────────────────────────────────
# GITHUB HELPERS
# ─────────────────────────────────────────────────────────────────────────────

async def _github_search(gap: str, client: httpx.AsyncClient) -> list[dict]:
    """Search GitHub for Python libraries matching the gap. Returns top results."""
    try:
        r = await client.get(
            "https://api.github.com/search/repositories",
            params={"q": f"{gap} python language:python", "sort": "stars", "per_page": _PAGE_SIZE},
            headers=_github_headers(),
            timeout=15.0,
        )
        if r.status_code == 403:
            retry_after = int(r.headers.get("Retry-After", 60))
            logger.warning("[composition] GitHub rate limited, waiting %ds", retry_after)
            await _emit("composition_progress", {"step": "rate_limited", "retry_after": retry_after})
            await asyncio.sleep(retry_after)
            r = await client.get(
                "https://api.github.com/search/repositories",
                params={"q": f"{gap} python language:python", "sort": "stars", "per_page": _PAGE_SIZE},
                headers=_github_headers(),
                timeout=15.0,
            )
        if r.status_code != 200:
            return []
        return r.json().get("items", [])
    except Exception as exc:
        logger.warning("[composition] GitHub search failed for '%s': %s", gap, exc)
        return []


async def _fetch_readme(repo: dict, client: httpx.AsyncClient) -> str:
    """Fetch README from raw.githubusercontent.com."""
    owner = repo.get("owner", {}).get("login", "")
    name  = repo.get("name", "")
    default_branch = repo.get("default_branch", "main")
    for fname in ["README.md", "readme.md", "README.rst", "README"]:
        try:
            r = await client.get(
                f"https://raw.githubusercontent.com/{owner}/{name}/{default_branch}/{fname}",
                timeout=10.0,
            )
            if r.status_code == 200:
                return r.text[:8000]
        except Exception:
            pass
    return ""


async def _deep_analyze_repo(repo_url: str) -> str:
    """
    Shallow-clone repo into tempdir, read key files, return combined context
    for Workhorse (up to ~10K tokens worth of text).
    """
    with tempfile.TemporaryDirectory() as tmpdir:
        proc = await asyncio.create_subprocess_exec(
            "git", "clone", "--depth=1", repo_url, tmpdir,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)
        except asyncio.TimeoutError:
            proc.kill()
            return ""

        if proc.returncode != 0:
            logger.warning("[composition] Clone failed for %s: %s", repo_url, stderr.decode().strip())
            return ""

        path = Path(tmpdir)
        segments: list[str] = []
        char_limit = 12000

        def _read_file(p: Path, label: str) -> None:
            if len("".join(segments)) >= char_limit:
                return
            try:
                text = p.read_text(encoding="utf-8", errors="replace")[:4000]
                segments.append(f"--- {label} ---\n{text}")
            except Exception:
                pass

        # README
        for fname in ["README.md", "readme.md", "README.rst"]:
            f = path / fname
            if f.exists():
                _read_file(f, "README")
                break

        # __init__.py (top-level or first package)
        for init in [path / "__init__.py"] + sorted(path.rglob("__init__.py"))[:3]:
            if init.exists():
                _read_file(init, "__init__.py")
                break

        # Core module — largest .py file excluding tests
        py_files = [
            f for f in path.rglob("*.py")
            if "test" not in f.name.lower() and "__pycache__" not in str(f)
        ]
        if py_files:
            core = max(py_files, key=lambda f: f.stat().st_size)
            _read_file(core, f"core/{core.name}")

        # Examples
        for examples_dir in [path / "examples", path / "example", path / "demo"]:
            if examples_dir.is_dir():
                for ex in sorted(examples_dir.glob("*.py"))[:2]:
                    _read_file(ex, f"examples/{ex.name}")
                break

        return "\n\n".join(segments)


# ─────────────────────────────────────────────────────────────────────────────
# AURA TOOL SCAN
# ─────────────────────────────────────────────────────────────────────────────

def _get_aura_tools() -> list[str]:
    """Return list of AURA's available MCP tool names."""
    try:
        from app.service.mcp_client_service import get_mcp_client
        client = get_mcp_client()
        if client:
            schemas = client.get_tool_schemas() if hasattr(client, "get_tool_schemas") else []
            return [s.get("name", "") for s in schemas if s.get("name")]
    except Exception:
        pass
    return []


async def _scan_aura_tools(tool_def, ollama) -> dict:
    """Ask Workhorse which AURA tools match this tool's description."""
    aura_tools = _get_aura_tools()
    capability_catalog = json.dumps(AURA_CAPABILITY_MAP, indent=2)

    messages = [{
        "role": "user",
        "content": (
            f"Tool to build: {tool_def.name}\n"
            f"Description: {tool_def.description}\n"
            f"Input schema: {json.dumps(tool_def.input_schema)}\n"
            f"Output: {tool_def.output_description}\n\n"
            f"Available AURA tools: {json.dumps(aura_tools)}\n\n"
            f"AURA capability → external API mapping:\n{capability_catalog}\n\n"
            "Identify which AURA tools are useful, and what gaps remain. "
            "Return JSON: {matching_tools: [{tool_name, fit_score (0-1), fit_reason}], gaps: [str]}"
        ),
    }]
    try:
        return await ollama.chat_json(messages, temperature=0.3, schema=_GAP_SCHEMA, timeout=30)
    except Exception:
        return {"matching_tools": [], "gaps": [tool_def.description]}


# ─────────────────────────────────────────────────────────────────────────────
# WRAPPER GENERATION
# ─────────────────────────────────────────────────────────────────────────────

def _slugify_gap(gap: str) -> str:
    s = gap.lower().strip()
    s = re.sub(r"[^\w\s]", "", s)
    s = re.sub(r"\s+", "_", s)
    return s[:40].strip("_") or "wrapper"


async def _generate_wrapper(gap: str, repo_context: str, tool_def, ollama) -> dict:
    """Use Workhorse to generate wrapper code for a specific gap."""
    messages = [{
        "role": "user",
        "content": (
            f"Write a Python async wrapper for the following capability gap:\n"
            f"Gap: {gap}\n\n"
            f"This wrapper is for tool: {tool_def.name}\n"
            f"Tool input schema: {json.dumps(tool_def.input_schema)}\n\n"
            f"Library/context:\n{repo_context[:6000]}\n\n"
            "Requirements:\n"
            "1. Expose exactly: async def tool_handler(inputs: dict) -> dict\n"
            "2. Use ONLY free external APIs — no localhost, no AURA dependencies\n"
            "3. Include all necessary imports at the top\n"
            "4. Handle exceptions gracefully, return {error: str} on failure\n"
            "5. List required PyPI packages in required_packages\n\n"
            "Return JSON: {wrapper_code: str, wrapper_description: str, required_packages: [str]}"
        ),
    }]
    try:
        result = await ollama.chat_json(messages, temperature=0.3, schema=_WRAPPER_SCHEMA, timeout=60)
        return result
    except Exception as exc:
        logger.warning("[composition] wrapper generation failed for '%s': %s", gap, exc)
        return {
            "wrapper_code": (
                "async def tool_handler(inputs: dict) -> dict:\n"
                "    return {'error': 'wrapper generation failed'}\n"
            ),
            "wrapper_description": f"Failed to generate wrapper for: {gap}",
            "required_packages": [],
        }


async def _generate_orchestrator(wrappers: list[dict], tool_def, ollama) -> str:
    """Generate orchestrator code that calls multiple wrappers in sequence."""
    if len(wrappers) == 1:
        return ""  # Single wrapper IS the handler — no orchestrator needed

    wrapper_summary = "\n".join(
        f"- {w['gap_slug']}.py: {w['wrapper_description']}" for w in wrappers
    )
    gap_slugs = [w["gap_slug"] for w in wrappers]

    messages = [{
        "role": "user",
        "content": (
            f"Write an orchestrator that calls multiple Python wrapper functions in sequence.\n\n"
            f"Tool: {tool_def.name}\n"
            f"Input schema: {json.dumps(tool_def.input_schema)}\n"
            f"Output: {tool_def.output_description}\n\n"
            f"Wrappers to orchestrate:\n{wrapper_summary}\n\n"
            "Requirements:\n"
            "1. Import each wrapper with an alias to avoid name collision:\n"
            + "\n".join(f"   from {s} import tool_handler as {s}_tool" for s in gap_slugs) + "\n"
            "2. Expose exactly: async def tool_handler(inputs: dict) -> dict\n"
            "3. Call wrappers in the correct logical sequence, passing outputs as needed\n"
            "4. Combine results into a single dict return value\n"
            "5. Handle exceptions per wrapper, include partial results if one fails\n\n"
            "Return JSON: {orchestrator_code: str}"
        ),
    }]
    try:
        result = await ollama.chat_json(messages, temperature=0.3, schema=_ORCHESTRATOR_SCHEMA, timeout=45)
        return result.get("orchestrator_code", "")
    except Exception as exc:
        logger.warning("[composition] orchestrator generation failed: %s", exc)
        # Fallback: call wrappers sequentially, merge results
        lines = ["import asyncio"]
        for s in gap_slugs:
            lines.append(f"from {s} import tool_handler as {s}_tool")
        lines.append("")
        lines.append("async def tool_handler(inputs: dict) -> dict:")
        lines.append("    result = {}")
        for s in gap_slugs:
            lines.append(f"    try:")
            lines.append(f"        r = await {s}_tool(inputs)")
            lines.append(f"        result.update(r)")
            lines.append(f"    except Exception as e:")
            lines.append(f"        result['{s}_error'] = str(e)")
        lines.append("    return result")
        return "\n".join(lines)


# ─────────────────────────────────────────────────────────────────────────────
# SANDBOX
# ─────────────────────────────────────────────────────────────────────────────

def _ruff_check(code: str, filename: str = "wrapper.py") -> dict:
    """Run ruff check on code string. Returns {passed, errors}."""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
        f.write(code)
        tmp = f.name
    try:
        result = subprocess.run(
            ["ruff", "check", tmp, "--output-format=text"],
            capture_output=True, text=True, timeout=10,
        )
        passed = result.returncode == 0
        errors = result.stdout.strip() or result.stderr.strip()
        return {"passed": passed, "errors": errors}
    except FileNotFoundError:
        # ruff not installed — skip pre-check
        return {"passed": True, "errors": "ruff not available"}
    except Exception as exc:
        return {"passed": False, "errors": str(exc)}
    finally:
        try:
            Path(tmp).unlink()
        except Exception:
            pass


def _sandbox_run(code: str, gap_slug: str) -> dict:
    """Run wrapper code in llm-sandbox Docker container (network-allowed, 10s timeout)."""
    test_code = (
        f"{code}\n\n"
        "import asyncio\n"
        "result = asyncio.run(tool_handler({}))\n"
        "print('sandbox_ok:', type(result).__name__)\n"
    )
    try:
        from llm_sandbox import SandboxSession
        with SandboxSession(lang="python", keep_template=True) as session:
            run_result = session.run(test_code)
            stdout = getattr(run_result, "stdout", str(run_result)) or ""
            stderr = getattr(run_result, "stderr", "") or ""
            passed = "sandbox_ok" in stdout or ("error" not in stderr.lower() and "traceback" not in stderr.lower())
            return {"status": "passed" if passed else "failed", "stdout": stdout[:2000], "stderr": stderr[:2000]}
    except ImportError:
        # llm-sandbox not installed — fall back to subprocess
        with tempfile.TemporaryDirectory() as tmpdir:
            wrapper_path = Path(tmpdir) / f"{gap_slug}.py"
            runner_path  = Path(tmpdir) / "_runner.py"
            wrapper_path.write_text(code, encoding="utf-8")
            runner_path.write_text(
                f"import sys, asyncio\nsys.path.insert(0, r'{tmpdir}')\n"
                f"from {gap_slug} import tool_handler\n"
                "result = asyncio.run(tool_handler({}))\n"
                "print('sandbox_ok:', type(result).__name__)\n",
                encoding="utf-8",
            )
            try:
                r = subprocess.run(
                    ["python", str(runner_path)],
                    capture_output=True, text=True, timeout=15, cwd=tmpdir,
                )
                passed = "sandbox_ok" in r.stdout or r.returncode == 0
                return {"status": "passed" if passed else "failed", "stdout": r.stdout[:2000], "stderr": r.stderr[:2000]}
            except subprocess.TimeoutExpired:
                return {"status": "failed", "stdout": "", "stderr": "Execution timed out after 15s"}
    except Exception as exc:
        return {"status": "failed", "stdout": "", "stderr": str(exc)}


async def _workhorse_diagnose(code: str, stderr: str, gap_description: str, ollama) -> dict:
    """Ask Workhorse to diagnose a sandbox failure and suggest a fix."""
    messages = [{
        "role": "user",
        "content": (
            f"This Python wrapper code failed during sandbox testing:\n\n"
            f"```python\n{code[:3000]}\n```\n\n"
            f"Error output:\n{stderr[:1000]}\n\n"
            f"Gap this wrapper is meant to fill: {gap_description}\n\n"
            "Diagnose the failure and suggest a corrected version. "
            "Return JSON: {suggested_fix: str (full corrected code), explanation: str}"
        ),
    }]
    try:
        return await ollama.chat_json(messages, temperature=0.3, timeout=45)
    except Exception:
        return {"suggested_fix": "", "explanation": "Diagnosis unavailable"}


# ─────────────────────────────────────────────────────────────────────────────
# MAIN ANALYSIS TASK
# ─────────────────────────────────────────────────────────────────────────────

async def run_analysis(tool_id: str, extra_context: Optional[dict] = None) -> None:
    """
    Background task: scan AURA tools + GitHub, generate wrappers + orchestrator,
    store build plan in mcp_tool_store.
    """
    from app.service.mcp_tool_store import get_mcp_tool_store

    store = get_mcp_tool_store()
    tool_def = store.get_tool(tool_id)
    if not tool_def:
        await _emit("composition_error", {"tool_id": tool_id, "reason": "tool not found"})
        return

    ollama = _get_ollama()
    if not ollama:
        await _emit("composition_error", {"tool_id": tool_id, "reason": "ollama_unavailable"})
        return

    try:
        # Step 1: Scan AURA tools
        await _emit("composition_progress", {"tool_id": tool_id, "step": "scanning_aura_tools"})
        scan = await _scan_aura_tools(tool_def, ollama)
        matching_tools = scan.get("matching_tools", [])
        gaps: list[str] = scan.get("gaps", [])

        # Inject extra_context gaps/resources if user submitted
        extra_urls: list[str] = []
        extra_code_entries: list[dict] = []  # [{gap, code}]
        if extra_context:
            extra_urls = extra_context.get("urls", [])
            if extra_context.get("code") and extra_context.get("gap"):
                extra_code_entries.append({
                    "gap": extra_context["gap"],
                    "code": extra_context["code"],
                })

        wrappers: list[dict] = []

        async with httpx.AsyncClient(timeout=20.0) as client:
            for gap in gaps:
                gap_slug = _slugify_gap(gap)
                await _emit("composition_progress", {
                    "tool_id": tool_id,
                    "step": "searching_github",
                    "gap": gap,
                })

                # Stage 1: Triage — search + README only
                repos = await _github_search(gap, client)
                if not repos:
                    # Try extra URLs if provided
                    repo_context = ""
                    for url in extra_urls:
                        if "github.com" in url:
                            await _emit("composition_progress", {"tool_id": tool_id, "step": "analyzing_user_url", "url": url})
                            repo_context = await _deep_analyze_repo(url)
                            if repo_context:
                                break
                        else:
                            # Docs page — use scraper
                            try:
                                from app.service.scraper_service import scrape
                                repo_context = await scrape(url)
                            except Exception:
                                pass
                    if not repo_context:
                        wrappers.append({
                            "gap_slug":          gap_slug,
                            "gap_description":   gap,
                            "library_name":      "unknown",
                            "repo_url":          "",
                            "wrapper_code":      "async def tool_handler(inputs: dict) -> dict:\n    return {'error': 'no library found'}\n",
                            "wrapper_description": f"No library found for: {gap}",
                            "required_packages": [],
                            "status":            "proposed",
                        })
                        continue
                    repo_info = {"name": "user-provided", "html_url": extra_urls[0] if extra_urls else ""}
                else:
                    # Pick best candidate from triage
                    best_repo = repos[0]
                    readme = await _fetch_readme(best_repo, client)

                    # Ask Workhorse if this library fits
                    fit_messages = [{
                        "role": "user",
                        "content": (
                            f"Does this library help with: {gap}?\n"
                            f"Library: {best_repo.get('name')} — {best_repo.get('description','')}\n"
                            f"README excerpt:\n{readme[:3000]}\n\n"
                            "Reply with JSON: {fits: bool, reason: str}"
                        ),
                    }]
                    try:
                        fit = await ollama.chat_json(fit_messages, temperature=0.2, timeout=20)
                        if not fit.get("fits", True):
                            # Try next repo
                            for repo in repos[1:]:
                                readme = await _fetch_readme(repo, client)
                                best_repo = repo
                                break
                    except Exception:
                        pass

                    # Stage 2: Deep analysis — clone + read key files
                    await _emit("composition_progress", {
                        "tool_id": tool_id,
                        "step": "generating_wrapper",
                        "gap": gap,
                        "library": best_repo.get("name", ""),
                    })
                    repo_context = await _deep_analyze_repo(best_repo.get("html_url", ""))
                    if not repo_context:
                        repo_context = readme  # fallback to README only
                    repo_info = best_repo

                # Generate wrapper
                wrapper_result = await _generate_wrapper(gap, repo_context, tool_def, ollama)
                wrappers.append({
                    "gap_slug":          gap_slug,
                    "gap_description":   gap,
                    "library_name":      repo_info.get("name", ""),
                    "repo_url":          repo_info.get("html_url", ""),
                    "wrapper_code":      wrapper_result.get("wrapper_code", ""),
                    "wrapper_description": wrapper_result.get("wrapper_description", ""),
                    "required_packages": wrapper_result.get("required_packages", []),
                    "status":            "proposed",
                })

        # Inject user-submitted manual code as wrappers
        for entry in extra_code_entries:
            gap = entry["gap"]
            gap_slug = _slugify_gap(gap)
            wrappers.append({
                "gap_slug":          gap_slug,
                "gap_description":   gap,
                "library_name":      "user-provided",
                "repo_url":          "",
                "wrapper_code":      entry["code"],
                "wrapper_description": f"User-provided wrapper for: {gap}",
                "required_packages": [],
                "status":            "proposed",
            })

        # Generate orchestrator (multi-wrapper only)
        orchestrator_code = ""
        if len(wrappers) > 1:
            orchestrator_code = await _generate_orchestrator(wrappers, tool_def, ollama)

        build_plan = {
            "aura_tools":       matching_tools,
            "wrappers":         wrappers,
            "orchestrator_code": orchestrator_code,
            "analyzed_at":      time.time(),
        }

        # Check for completely blocked state
        all_failed = all(w.get("wrapper_code", "").strip() == "" or "no library found" in w.get("wrapper_description", "") for w in wrappers) if wrappers else True
        blocking = None
        if all_failed:
            failed_gaps = [w["gap_description"] for w in wrappers if "no library found" in w.get("wrapper_description", "")]
            blocking = f"Could not find components for: {failed_gaps}. Provide GitHub URLs or external resources to evaluate."

        store.update_fields(
            tool_id,
            build_plan=build_plan,
            blocking_reason=blocking,
        )

        await _emit("composition_complete", {
            "tool_id":    tool_id,
            "build_plan": build_plan,
        })

    except Exception as exc:
        logger.error("[composition] Analysis failed for tool %s: %s", tool_id, exc)
        await _emit("composition_error", {"tool_id": tool_id, "reason": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# SANDBOX WRAPPER
# ─────────────────────────────────────────────────────────────────────────────

async def sandbox_wrapper(tool_id: str, gap_slug: str) -> dict:
    """
    Run three-step sandbox on a wrapper:
    1. Ruff pre-check (instant)
    2. llm-sandbox Docker run (network-allowed)
    3. Workhorse fix suggestion on failure
    """
    from app.service.mcp_tool_store import get_mcp_tool_store
    store = get_mcp_tool_store()
    tool_def = store.get_tool(tool_id)
    if not tool_def or not tool_def.build_plan:
        return {"status": "error", "reason": "no build plan"}

    wrapper = next(
        (w for w in tool_def.build_plan.get("wrappers", []) if w["gap_slug"] == gap_slug),
        None,
    )
    if not wrapper:
        return {"status": "error", "reason": f"gap_slug '{gap_slug}' not found"}

    code = wrapper.get("wrapper_code", "")

    # Step 1: Ruff
    ruff = _ruff_check(code, filename=f"{gap_slug}.py")
    if not ruff["passed"]:
        return {
            "status":       "ruff_failed",
            "errors":       ruff["errors"],
            "stdout":       "",
            "stderr":       ruff["errors"],
            "suggested_fix": None,
        }

    # Step 2: Docker sandbox
    sandbox = _sandbox_run(code, gap_slug)

    # Update wrapper status in build plan
    wrappers = tool_def.build_plan.get("wrappers", [])
    for w in wrappers:
        if w["gap_slug"] == gap_slug:
            w["status"] = "sandbox_passed" if sandbox["status"] == "passed" else "sandbox_failed"
    build_plan = {**tool_def.build_plan, "wrappers": wrappers}
    store.update_fields(tool_id, build_plan=build_plan)

    result = {
        "status": sandbox["status"],
        "stdout": sandbox["stdout"],
        "stderr": sandbox["stderr"],
        "suggested_fix": None,
    }

    # Step 3: Workhorse diagnosis on failure
    if sandbox["status"] == "failed":
        ollama = _get_ollama()
        if ollama:
            diagnosis = await _workhorse_diagnose(
                code, sandbox["stderr"], wrapper["gap_description"], ollama
            )
            result["suggested_fix"] = diagnosis

    return result


# ─────────────────────────────────────────────────────────────────────────────
# APPROVE PLAN
# ─────────────────────────────────────────────────────────────────────────────

def approve_plan(tool_id: str, approved_slugs: list[str]) -> dict:
    """
    Commit approved wrappers to disk. Write orchestrator.py for multi-wrapper tools.
    Advance stage to 'dataset'.
    """
    from app.service.mcp_tool_store import get_mcp_tool_store
    store = get_mcp_tool_store()
    tool_def = store.get_tool(tool_id)
    if not tool_def or not tool_def.build_plan:
        return {"approved": False, "reason": "no build plan"}

    wrapper_dir = _WRAPPERS_BASE / tool_id
    wrapper_dir.mkdir(parents=True, exist_ok=True)
    sandbox_dir = wrapper_dir / "_sandbox"
    if sandbox_dir.exists():
        shutil.rmtree(sandbox_dir)

    wrappers = tool_def.build_plan.get("wrappers", [])
    approved_wrappers = [w for w in wrappers if w["gap_slug"] in approved_slugs]
    committed: list[str] = []

    for w in approved_wrappers:
        dest = wrapper_dir / f"{w['gap_slug']}.py"
        dest.write_text(w["wrapper_code"], encoding="utf-8")
        # Update status
        w["status"] = "approved"
        committed.append(w["gap_slug"])

    # Write orchestrator
    orchestrator_code = tool_def.build_plan.get("orchestrator_code", "")
    if len(approved_wrappers) > 1 and orchestrator_code:
        (wrapper_dir / "orchestrator.py").write_text(orchestrator_code, encoding="utf-8")

    # Update remaining wrappers status
    for w in wrappers:
        if w["gap_slug"] not in approved_slugs and w["status"] not in ("approved",):
            w["status"] = "rejected"

    build_plan = {**tool_def.build_plan, "wrappers": wrappers}
    store.update_fields(
        tool_id,
        build_plan=build_plan,
        wrapper_path=str(wrapper_dir),
        stage="dataset",
        blocking_reason=None,
    )

    return {"approved": True, "committed": committed, "wrapper_path": str(wrapper_dir)}
