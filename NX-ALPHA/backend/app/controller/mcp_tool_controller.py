"""
AURA NX-Alpha — MCP Tool Controller

REST endpoints for the Tool Developer Workspace pipeline.

ENDPOINTS (all under /mcp-tools prefix):
  Dataset library
    GET    /mcp-tools/dataset-catalog
    GET    /mcp-tools/dataset-records
    GET    /mcp-tools/golden-sets

  Tool lifecycle
    POST   /mcp-tools/draft
    POST   /mcp-tools/draft/confirm
    POST   /mcp-tools
    GET    /mcp-tools
    GET    /mcp-tools/{id}
    PUT    /mcp-tools/{id}
    DELETE /mcp-tools/{id}

  Dataset
    POST   /mcp-tools/{id}/suggest-prompts

  Composition
    POST   /mcp-tools/{id}/analyze
    GET    /mcp-tools/{id}/build-plan
    POST   /mcp-tools/{id}/sandbox-wrappers
    POST   /mcp-tools/{id}/submit-resources
    POST   /mcp-tools/{id}/approve-plan

  Training
    POST   /mcp-tools/{id}/run-dataset
    POST   /mcp-tools/{id}/run-dataset/stop
    GET    /mcp-tools/{id}/run-dataset/status
    GET    /mcp-tools/{id}/golden-set

  Optimization
    POST   /mcp-tools/{id}/optimize
    POST   /mcp-tools/{id}/optimize/stop
    GET    /mcp-tools/{id}/optimize/status
    GET    /mcp-tools/{id}/reevaluation
    POST   /mcp-tools/{id}/apply-reevaluation

  Sandbox + Human Testing
    POST   /mcp-tools/{id}/sandbox
    POST   /mcp-tools/{id}/test-call
    POST   /mcp-tools/{id}/test-complete

  Publish
    POST   /mcp-tools/{id}/publish
    GET    /mcp-tools/{id}/mcp-config
    GET    /mcp-tools/{id}/download/{target}

  Settings (GitHub token)
    GET    /settings/github-token
    PUT    /settings/github-token
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

router         = APIRouter(prefix="/mcp-tools", tags=["mcp-tools"])
settings_router = APIRouter(tags=["settings"])

_MCP_BASE = Path.home() / ".aura" / "mcp_tools"

# Per-tool test subprocess dict — keyed by tool_id
# Managed in-process: started on test-call, TTL 30 minutes, swept every 5 minutes
_test_subprocesses: dict[str, dict] = {}  # {tool_id: {proc, last_used, writer, reader}}
_sweep_task: Optional[asyncio.Task] = None


# ─────────────────────────────────────────────────────────────────────────────
# REQUEST / RESPONSE MODELS
# ─────────────────────────────────────────────────────────────────────────────

class DraftRequest(BaseModel):
    description: str = Field(..., min_length=10)


class ConfirmRequest(BaseModel):
    draft_id: str
    answers: dict = Field(default_factory=dict)


class SaveToolRequest(BaseModel):
    id: str
    name: str
    description: str
    input_schema: dict
    output_description: str = ""
    target_users: str = ""
    complexity: str = "medium"
    categories: list[str] = []
    base_prompt: str = ""


class UpdateToolRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    input_schema: Optional[dict] = None
    output_description: Optional[str] = None
    target_users: Optional[str] = None
    complexity: Optional[str] = None
    categories: Optional[list[str]] = None
    base_prompt: Optional[str] = None
    optimized_prompt: Optional[str] = None


class AnalyzeRequest(BaseModel):
    pass  # no body needed — uses tool_id from path


class SandboxWrapperRequest(BaseModel):
    gap_slug: str


class SubmitResourcesRequest(BaseModel):
    urls: list[str] = []
    notes: str = ""
    code: str = ""
    gap: str = ""


class ApprovePlanRequest(BaseModel):
    approved_wrappers: list[str]


class TestCallRequest(BaseModel):
    inputs: dict = Field(default_factory=dict)


class PublishRequest(BaseModel):
    targets: list[str] = Field(..., description="e.g. ['mcp','claude_project','chatgpt_gpt','gemini_gem']")
    expose_components: bool = False
    auto_update: bool = False


class GithubTokenRequest(BaseModel):
    token: str


class DatasetRecordsRequest(BaseModel):
    category: str = ""
    golden_only: bool = False
    page: int = 1
    limit: int = 50


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _store():
    from app.service.mcp_tool_store import get_mcp_tool_store
    return get_mcp_tool_store()


def _require_tool(tool_id: str):
    t = _store().get_tool(tool_id)
    if not t:
        raise HTTPException(status_code=404, detail=f"Tool '{tool_id}' not found")
    return t


def _load_golden(tool_id: str) -> list[dict]:
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
    return entries


async def _subprocess_sweep():
    """Background task: kill test subprocesses idle > 30 minutes."""
    while True:
        await asyncio.sleep(300)  # check every 5 minutes
        now = time.time()
        stale = [tid for tid, info in _test_subprocesses.items()
                 if now - info.get("last_used", 0) > 1800]
        for tid in stale:
            info = _test_subprocesses.pop(tid, {})
            proc = info.get("proc")
            if proc:
                try:
                    proc.kill()
                except Exception:
                    pass


def _ensure_sweep():
    global _sweep_task
    if _sweep_task is None or _sweep_task.done():
        _sweep_task = asyncio.create_task(_subprocess_sweep())


# ─────────────────────────────────────────────────────────────────────────────
# DATASET LIBRARY
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/sync-phoenix")
async def sync_phoenix(background_tasks: BackgroundTasks) -> dict:
    """
    Trigger a Phoenix export to refresh eval_raw.jsonl and dataset_catalog.json.
    Runs the same export_traces() call as the eval pipeline. Returns immediately;
    export runs in background and emits SSE events.
    """
    async def _run():
        try:
            from app.service.phoenix_exporter import export_traces
            await export_traces()
        except Exception as exc:
            logger.warning("[mcp_ctrl] sync-phoenix failed: %s", exc)

    background_tasks.add_task(_run)
    return {"started": True, "note": "Phoenix export running in background"}


@router.get("/aura-tools")
async def list_aura_tools() -> dict:
    """Return all tools registered in AURA's MCP client (available for import)."""
    try:
        from app.service.mcp_client_service import get_mcp_client
        client = get_mcp_client()
        schemas = client.get_tool_schemas() if client else []
    except Exception:
        schemas = []
    return {"tools": schemas}


@router.post("/import-aura-tools")
async def import_aura_tools() -> dict:
    """
    Bulk-import AURA's registered MCP tools into the mcp_tool_store.
    Creates a record at stage='ready' for each tool not already in the store.
    Skips tools that already exist (matched by id/slug).
    """
    from app.service.mcp_tool_store import MCPToolDef, get_mcp_tool_store
    store = get_mcp_tool_store()
    existing_ids = store.existing_ids()

    try:
        from app.service.mcp_client_service import get_mcp_client
        client = get_mcp_client()
        schemas = client.get_tool_schemas() if client else []
    except Exception:
        schemas = []

    imported = []
    skipped  = []

    for schema in schemas:
        raw_name = schema.get("name", "")
        if not raw_name:
            continue

        # Slugify name to use as ID
        from app.service.mcp_tool_store import unique_slug
        slug = unique_slug(raw_name, existing_ids)

        if slug in existing_ids:
            skipped.append(raw_name)
            continue

        tool = MCPToolDef(
            id=slug,
            name=raw_name,
            description=schema.get("description", ""),
            input_schema=schema.get("inputSchema", {"type": "object", "properties": {}}),
            output_description="",
            stage="ready",    # already working — skip training pipeline, go straight to publish
            base_prompt=schema.get("description", ""),
        )
        store.save_tool(tool)
        existing_ids.add(slug)
        imported.append(raw_name)

    return {"imported": imported, "skipped": skipped, "total_imported": len(imported)}


@router.get("/dataset-catalog")
async def dataset_catalog() -> dict:
    """Return category/tier counts from dataset_catalog.json.
    Normalizes categories from dict → array of {name, count, golden_count}.
    """
    catalog_path = Path.home() / ".aura" / "training" / "dataset_catalog.json"
    if not catalog_path.exists():
        return {"total": 0, "categories": [], "note": "Run a Phoenix export to populate the catalog"}
    try:
        with catalog_path.open("r", encoding="utf-8") as f:
            raw = json.load(f)
        cats = raw.get("categories", {})
        # Normalize: dict → array
        if isinstance(cats, dict):
            cats_list = [
                {"name": k, "count": v.get("count", 0) if isinstance(v, dict) else int(v), "golden_count": v.get("golden_count", 0) if isinstance(v, dict) else 0}
                for k, v in cats.items()
            ]
        else:
            cats_list = cats  # already an array
        return {
            "total":       raw.get("total", 0),
            "categories":  sorted(cats_list, key=lambda c: -c["count"]),
            "last_export": raw.get("generated_at"),
        }
    except Exception as exc:
        logger.warning("[mcp_ctrl] catalog read failed: %s", exc)
        return {"total": 0, "categories": [], "error": str(exc)}


@router.get("/dataset-records")
async def dataset_records(
    category: str = "",
    golden_only: bool = False,
    page: int = 1,
    limit: int = 50,
) -> dict:
    """Paginated unified dataset records from eval_raw.jsonl + training_candidates."""
    import sqlite3
    from app.service.tool_dataset_runner import _TRAINING_DIR, _RAW_PATH

    records: list[dict] = []

    # Pool A — Phoenix raw
    if _RAW_PATH.exists():
        try:
            with _RAW_PATH.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue
                    tier    = rec.get("tier", "")
                    if category and tier != category:
                        continue
                    if golden_only and rec.get("quality_signal", 0) < 0.8:
                        continue
                    records.append({
                        "prompt_preview": rec.get("prompt", "")[:120],
                        "tier":           tier,
                        "domain":         rec.get("route_type", ""),
                        "source_type":    "phoenix",
                        "quality_signal": rec.get("quality_signal"),
                        "is_golden":      (rec.get("quality_signal", 0) or 0) >= 0.8,
                        "tool_ids":       [],
                    })
        except Exception as exc:
            logger.warning("[mcp_ctrl] Pool A read failed: %s", exc)

    # Pool B — training_candidates
    try:
        from app.service.memory_service import get_memory_service
        mem = get_memory_service()
        with sqlite3.connect(str(mem._l1_path)) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute("""
                SELECT input_text, quality_signal, markers, source_type
                FROM training_candidates
                ORDER BY rowid DESC
                LIMIT 5000
            """).fetchall()
        for row in rows:
            markers: dict = {}
            try:
                markers = json.loads(row["markers"] or "{}")
            except Exception:
                pass
            tier = markers.get("tier", "")
            if category and tier != category:
                continue
            quality = row["quality_signal"] or 0.0
            if golden_only and quality < 0.8:
                continue
            records.append({
                "prompt_preview": (row["input_text"] or "")[:120],
                "tier":           tier,
                "domain":         markers.get("route_type", ""),
                "source_type":    row["source_type"],
                "quality_signal": quality,
                "is_golden":      quality >= 0.8,
                "tool_ids":       markers.get("tool_ids", []),
            })
    except Exception as exc:
        logger.debug("[mcp_ctrl] Pool B read failed: %s", exc)

    total  = len(records)
    offset = (page - 1) * limit
    return {
        "total": total,
        "page":  page,
        "limit": limit,
        "records": records[offset: offset + limit],
    }


@router.get("/golden-sets")
async def golden_sets() -> dict:
    """Return all golden sets with stats (baseline + per-tool)."""
    sets: list[dict] = []

    # Baseline (from eval_runner)
    baseline_path = Path.home() / ".aura" / "training" / "golden_set.jsonl"
    if baseline_path.exists():
        entries = []
        with baseline_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except Exception:
                        pass
        avg_quality = (
            round(sum(e.get("quality_signal", 0) for e in entries) / max(len(entries), 1), 3)
            if entries else 0.0
        )
        sets.append({
            "id":           "baseline",
            "name":         "Baseline Golden Set",
            "record_count": len(entries),
            "avg_quality":  avg_quality,
            "categories":   [],
        })

    # Per-tool golden sets
    for tool in _store().list_tools():
        path = _MCP_BASE / tool.id / "golden_set.jsonl"
        if path.exists():
            entries = []
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        try:
                            entries.append(json.loads(line))
                        except Exception:
                            pass
            avg_quality = (
                round(sum(e.get("quality_signal", 0) for e in entries) / max(len(entries), 1), 3)
                if entries else 0.0
            )
            sets.append({
                "id":           tool.id,
                "name":         f"{tool.name} Golden Set",
                "record_count": len(entries),
                "avg_quality":  avg_quality,
                "categories":   tool.categories,
            })

    return {"golden_sets": sets}


# ─────────────────────────────────────────────────────────────────────────────
# TOOL LIFECYCLE
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/draft")
async def create_draft(body: DraftRequest) -> dict:
    """Natural language description → draft spec + clarifying questions."""
    from app.service.tool_intake_analyzer import analyze
    try:
        return await analyze(body.description)
    except TimeoutError:
        raise HTTPException(status_code=408, detail="Analysis timed out — try a shorter description")
    except Exception as exc:
        logger.error("[mcp_ctrl] draft failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/draft/confirm")
async def confirm_draft(body: ConfirmRequest) -> dict:
    """Merge draft + user answers → confirmed MCPToolDef."""
    from app.service.tool_intake_analyzer import confirm
    try:
        return await confirm(body.draft_id, body.answers)
    except KeyError:
        raise HTTPException(status_code=404, detail="Draft not found or expired")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.error("[mcp_ctrl] confirm failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("")
async def save_tool(body: SaveToolRequest) -> dict:
    """Save confirmed spec to mcp_tool_store. Stage = 'composition'."""
    from app.service.mcp_tool_store import MCPToolDef, get_mcp_tool_store
    store = get_mcp_tool_store()
    tool = MCPToolDef(
        id=body.id,
        name=body.name,
        description=body.description,
        input_schema=body.input_schema,
        output_description=body.output_description,
        target_users=body.target_users,
        complexity=body.complexity,
        categories=body.categories,
        base_prompt=body.base_prompt,
        stage="composition",
    )
    store.save_tool(tool)
    return {"id": tool.id, "stage": tool.stage}


@router.get("")
async def list_tools() -> dict:
    """List all tools with stage + blocking_reason."""
    tools = _store().list_tools()
    return {"tools": [t.model_dump() for t in tools]}


@router.get("/{tool_id}")
async def get_tool(tool_id: str) -> dict:
    tool = _require_tool(tool_id)
    return tool.model_dump()


@router.put("/{tool_id}")
async def update_tool(tool_id: str, body: UpdateToolRequest) -> dict:
    """Patch tool definition fields."""
    store = _store()
    _require_tool(tool_id)
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if updates:
        store.update_fields(tool_id, **updates)
    return {"updated": True, "id": tool_id}


@router.delete("/{tool_id}")
async def delete_tool(tool_id: str) -> dict:
    """Soft-delete tool. Files preserved; published MCPs continue working."""
    _require_tool(tool_id)
    _store().delete_tool(tool_id)
    return {"deleted": True, "id": tool_id}


# ─────────────────────────────────────────────────────────────────────────────
# DATASET — SUGGEST PROMPTS
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{tool_id}/suggest-prompts")
async def suggest_prompts(tool_id: str) -> dict:
    """
    Workhorse generates 20-30 domain-specific training prompts for this tool.
    Returns a list of prompt strings for copy-paste into AdversarialTrainerPanel.
    """
    tool = _require_tool(tool_id)
    try:
        from app.service.ollama_service import get_ollama_service
        ollama = get_ollama_service()
    except Exception:
        raise HTTPException(status_code=503, detail="Workhorse unavailable")

    messages = [{
        "role": "user",
        "content": (
            f"Generate 25 diverse, realistic training prompts for an AI tool with this profile:\n"
            f"Name: {tool.name}\n"
            f"Description: {tool.description}\n"
            f"Categories: {', '.join(tool.categories)}\n"
            f"Target users: {tool.target_users or 'general users'}\n\n"
            "Requirements:\n"
            "- Cover easy, medium, and hard difficulty levels\n"
            "- Include edge cases and ambiguous inputs\n"
            "- Each prompt should be a realistic user query\n"
            "- Return ONLY a JSON object: {\"prompts\": [\"prompt1\", \"prompt2\", ...]}\n"
            "- 25 prompts minimum, varied in style and complexity"
        ),
    }]
    schema = {
        "type": "object",
        "properties": {
            "prompts": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["prompts"],
    }
    try:
        result = await ollama.chat_json(messages, temperature=0.8, schema=schema, timeout=60)
        prompts = result.get("prompts", [])
    except Exception as exc:
        logger.warning("[mcp_ctrl] suggest-prompts failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    return {"prompts": prompts, "count": len(prompts)}


# ─────────────────────────────────────────────────────────────────────────────
# COMPOSITION
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{tool_id}/analyze")
async def analyze_composition(tool_id: str, background_tasks: BackgroundTasks) -> dict:
    """
    Start background composition analysis: scan AURA tools + GitHub (two-stage).
    SSE events emitted during analysis. Returns immediately.
    """
    _require_tool(tool_id)
    from app.service.tool_composition_analyzer import run_analysis
    background_tasks.add_task(run_analysis, tool_id)
    return {"started": True, "tool_id": tool_id}


@router.get("/{tool_id}/build-plan")
async def get_build_plan(tool_id: str) -> dict:
    """Return current build plan JSON."""
    tool = _require_tool(tool_id)
    return {"build_plan": tool.build_plan or {}}


@router.post("/{tool_id}/sandbox-wrappers")
async def sandbox_wrappers(tool_id: str, body: SandboxWrapperRequest) -> dict:
    """
    Run three-step sandbox on a specific wrapper:
    1. Ruff pre-check (instant)
    2. llm-sandbox Docker execution
    3. Workhorse diagnosis on failure
    """
    _require_tool(tool_id)
    from app.service.tool_composition_analyzer import sandbox_wrapper
    try:
        return await sandbox_wrapper(tool_id, body.gap_slug)
    except Exception as exc:
        logger.error("[mcp_ctrl] sandbox-wrappers failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{tool_id}/submit-resources")
async def submit_resources(tool_id: str, body: SubmitResourcesRequest) -> dict:
    """
    User-provided resources to unblock composition:
    - GitHub URLs → two-stage pipeline (clone + Workhorse wrapper generation)
    - Docs URLs → scraper_service → Workhorse analysis
    - Raw code → accepted as proposed wrapper directly
    """
    _require_tool(tool_id)
    from app.service.tool_composition_analyzer import submit_resources as _submit
    try:
        return await _submit(
            tool_id,
            urls=body.urls,
            notes=body.notes,
            code=body.code,
            gap=body.gap,
        )
    except Exception as exc:
        logger.error("[mcp_ctrl] submit-resources failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{tool_id}/approve-plan")
async def approve_plan(tool_id: str, body: ApprovePlanRequest) -> dict:
    """
    Commit approved wrappers + orchestrator to ~/.aura/tool_wrappers/{id}/.
    Advances stage to 'dataset'.
    """
    _require_tool(tool_id)
    from app.service.tool_composition_analyzer import approve_plan as _approve
    try:
        return await _approve(tool_id, body.approved_wrappers)
    except Exception as exc:
        logger.error("[mcp_ctrl] approve-plan failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# TRAINING
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{tool_id}/run-dataset")
async def run_dataset(tool_id: str) -> dict:
    """Start tool training run (enqueues if GPU busy). Returns session_id."""
    _require_tool(tool_id)
    from app.service.tool_dataset_runner import get_tool_dataset_runner
    return await get_tool_dataset_runner().start(tool_id)


@router.post("/{tool_id}/run-dataset/stop")
async def stop_dataset(tool_id: str) -> dict:
    """Cancel a running training job."""
    from app.service.tool_dataset_runner import get_tool_dataset_runner
    return await get_tool_dataset_runner().stop()


@router.get("/{tool_id}/run-dataset/status")
async def dataset_status(tool_id: str) -> dict:
    """Current training runner status."""
    from app.service.tool_dataset_runner import get_tool_dataset_runner
    return get_tool_dataset_runner().get_status()


@router.get("/{tool_id}/golden-set")
async def get_golden_set(tool_id: str) -> dict:
    """Return golden set entries for this tool."""
    _require_tool(tool_id)
    entries = _load_golden(tool_id)
    return {"tool_id": tool_id, "count": len(entries), "entries": entries}


# ─────────────────────────────────────────────────────────────────────────────
# OPTIMIZATION
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{tool_id}/optimize")
async def optimize(tool_id: str) -> dict:
    """Run one optimization cycle (5 iterations). Returns immediately — SSE events fired."""
    _require_tool(tool_id)
    from app.service.prompt_optimizer import get_optimizer_runner
    return await get_optimizer_runner(tool_id).start(tool_id)


@router.post("/{tool_id}/optimize/stop")
async def stop_optimize(tool_id: str) -> dict:
    """Cancel a running optimization job."""
    from app.service.prompt_optimizer import get_optimizer_runner
    return await get_optimizer_runner(tool_id).stop()


@router.get("/{tool_id}/optimize/status")
async def optimize_status(tool_id: str) -> dict:
    """Current optimization runner status."""
    from app.service.prompt_optimizer import get_optimizer_runner
    return get_optimizer_runner(tool_id).get_status()


@router.get("/{tool_id}/reevaluation")
async def get_reevaluation(tool_id: str) -> dict:
    """Return reevaluation report (populated after 5 failed cycles)."""
    tool = _require_tool(tool_id)
    report = tool.reevaluation_report
    if not report:
        return {"tool_id": tool_id, "report": None, "stage": tool.stage}
    return {"tool_id": tool_id, "report": report, "stage": tool.stage}


@router.post("/{tool_id}/apply-reevaluation")
async def apply_reevaluation(tool_id: str) -> dict:
    """Apply reevaluation suggestions: reset cycles=0, clear failures, stage=dataset."""
    _require_tool(tool_id)
    from app.service.prompt_optimizer import apply_reevaluation as _apply
    return _apply(tool_id)


# ─────────────────────────────────────────────────────────────────────────────
# SANDBOX + HUMAN TESTING
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{tool_id}/sandbox")
async def run_sandbox(tool_id: str) -> dict:
    """
    Run Phase 5b MCP server sandbox:
    starts server.py subprocess, MCP handshake, feeds golden set → Workhorse judge.
    Returns {sandbox_pass_rate, results, stage}.
    """
    _require_tool(tool_id)
    from app.service.mcp_sandbox import run_sandbox as _run
    try:
        return await _run(tool_id)
    except Exception as exc:
        logger.error("[mcp_ctrl] sandbox failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{tool_id}/test-call")
async def test_call(tool_id: str, body: TestCallRequest) -> dict:
    """
    Interactive human test call. Starts server.py subprocess if not running
    (TTL 30 minutes). Sends one MCP tools/call, returns response.
    """
    _ensure_sweep()
    tool = _require_tool(tool_id)

    server_py = _MCP_BASE / tool_id / "mcp" / "server.py"
    if not server_py.exists():
        raise HTTPException(status_code=400, detail="server.py not found — run optimization to generate it")

    # Start subprocess if not alive
    info = _test_subprocesses.get(tool_id)
    if info is None or info["proc"].poll() is not None:
        proc = await asyncio.create_subprocess_exec(
            "python", str(server_py),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        # MCP initialize handshake
        async def _send(method: str, params: dict, req_id: int) -> None:
            msg = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
            proc.stdin.write((msg + "\n").encode("utf-8"))
            await proc.stdin.drain()

        async def _read(timeout: float = 10.0) -> Optional[dict]:
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
                return json.loads(line.decode("utf-8").strip())
            except Exception:
                return None

        await _send("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "aura-human-test", "version": "1.0"},
        }, req_id=0)
        init_resp = await _read(timeout=30.0)
        if not init_resp or "error" in init_resp:
            try:
                proc.kill()
            except Exception:
                pass
            raise HTTPException(status_code=500, detail="MCP initialize failed")

        _test_subprocesses[tool_id] = {
            "proc":      proc,
            "last_used": time.time(),
        }
        info = _test_subprocesses[tool_id]

    # Update last_used
    info["last_used"] = time.time()
    proc = info["proc"]

    # Determine tool name from tools/list
    tool_name = tool_id
    call_id   = int(time.time() * 1000) % 100000

    async def _send_to(method: str, params: dict, req_id: int) -> None:
        msg = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        proc.stdin.write((msg + "\n").encode("utf-8"))
        await proc.stdin.drain()

    async def _read_from(timeout: float = 10.0) -> Optional[dict]:
        try:
            line = await asyncio.wait_for(proc.stdout.readline(), timeout=timeout)
            return json.loads(line.decode("utf-8").strip())
        except Exception:
            return None

    # Send test call
    await _send_to("tools/call", {
        "name": tool_name,
        "arguments": body.inputs,
    }, req_id=call_id)

    response = await _read_from(timeout=30.0)
    if response is None:
        raise HTTPException(status_code=504, detail="No response from server (timeout)")

    if "error" in (response or {}):
        return {"success": False, "error": response["error"], "raw": response}

    result_content = response.get("result", {})
    actual = ""
    if isinstance(result_content, dict):
        content_list = result_content.get("content", [])
        if content_list:
            actual = content_list[0].get("text", str(result_content))
        else:
            actual = json.dumps(result_content)
    else:
        actual = str(result_content)

    return {
        "success":   True,
        "response":  actual,
        "raw":       response,
        "timestamp": time.time(),
    }


@router.post("/{tool_id}/test-complete")
async def test_complete(tool_id: str) -> dict:
    """
    Mark human testing done → stage = 'ready', publish unlocked.
    Requires that at least 3 test calls have been made (enforced by UI).
    """
    _require_tool(tool_id)

    # Kill any running test subprocess for this tool
    info = _test_subprocesses.pop(tool_id, None)
    if info:
        try:
            info["proc"].kill()
        except Exception:
            pass

    _store().update_stage(tool_id, "ready", blocking_reason=None)
    return {"stage": "ready", "tool_id": tool_id, "publish_unlocked": True}


# ─────────────────────────────────────────────────────────────────────────────
# PUBLISH
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{tool_id}/publish")
async def publish_tool(tool_id: str, body: PublishRequest) -> dict:
    """
    Generate selected output packages:
    - mcp: server.py + pyproject.toml + install scripts + ZIP
    - claude_project: prompt doc
    - chatgpt_gpt: GPT builder prompt doc
    - gemini_gem: Gem instructions doc
    Registers POST /tools/{tool_id}/invoke dynamically.
    """
    _require_tool(tool_id)
    from app.service.mcp_generator import publish
    try:
        result = await publish(tool_id, body.targets, body.expose_components)
        # Persist auto_update preference
        store = get_mcp_tool_store()
        store.update_fields(tool_id, auto_update=body.auto_update)
        return result
    except Exception as exc:
        logger.error("[mcp_ctrl] publish failed: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{tool_id}/auto-update-check")
async def auto_update_check_now(tool_id: str, background_tasks: BackgroundTasks) -> dict:
    """Trigger an immediate auto-update check for this tool (ignores golden set growth threshold)."""
    _require_tool(tool_id)

    async def _run():
        from app.service.tool_auto_updater import _update_one_tool
        await _update_one_tool(tool_id)

    background_tasks.add_task(_run)
    return {"started": True, "tool_id": tool_id}


@router.get("/{tool_id}/mcp-config")
async def mcp_config(tool_id: str) -> dict:
    """Return raw Claude Desktop config fragment for manual copy."""
    tool = _require_tool(tool_id)
    if not tool.published:
        raise HTTPException(status_code=400, detail="Tool not yet published")
    config_path = _MCP_BASE / tool_id / "mcp" / "mcp_config.json"
    if not config_path.exists():
        raise HTTPException(status_code=404, detail="mcp_config.json not found — re-publish to generate")
    with config_path.open("r", encoding="utf-8") as f:
        return json.load(f)


@router.get("/{tool_id}/download/{target}")
async def download_tool(tool_id: str, target: str) -> FileResponse:
    """Stream ZIP (mcp target) or markdown file (prompt package targets)."""
    tool = _require_tool(tool_id)
    if not tool.published:
        raise HTTPException(status_code=400, detail="Tool not yet published")

    base = _MCP_BASE / tool_id

    target_map = {
        "mcp":            (base / "mcp" / f"{tool_id}.zip",            "application/zip"),
        "claude_project": (base / "claude_project" / f"{tool_id}_claude.md", "text/markdown"),
        "chatgpt_gpt":    (base / "chatgpt" / f"{tool_id}_gpt.md",     "text/markdown"),
        "gemini_gem":     (base / "gemini" / f"{tool_id}_gem.md",       "text/markdown"),
    }

    if target not in target_map:
        raise HTTPException(status_code=400, detail=f"Unknown target '{target}'")

    file_path, media_type = target_map[target]
    if not file_path.exists():
        raise HTTPException(status_code=404, detail=f"Package for target '{target}' not found — re-publish")

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        filename=file_path.name,
    )


# ─────────────────────────────────────────────────────────────────────────────
# SETTINGS — GITHUB TOKEN
# ─────────────────────────────────────────────────────────────────────────────

@settings_router.get("/settings/github-token")
async def get_github_token() -> dict:
    """Returns whether a GitHub token is configured (never returns the token value)."""
    from app.config import get_settings
    s = get_settings()
    return {"configured": bool(s.github_token)}


@settings_router.put("/settings/github-token")
async def set_github_token(body: GithubTokenRequest) -> dict:
    """Write token to backend/.env and reload settings."""
    env_path = Path(__file__).parent.parent.parent / ".env"
    if not env_path.exists():
        raise HTTPException(status_code=500, detail=".env file not found")

    # Read existing .env
    lines = env_path.read_text(encoding="utf-8").splitlines()
    key   = "AURA_GITHUB_TOKEN"
    found = False
    new_lines = []
    for line in lines:
        if line.startswith(f"{key}="):
            new_lines.append(f"{key}={body.token}")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"{key}={body.token}")

    env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

    # Reload settings (best-effort — avoids full restart)
    try:
        from app.config import get_settings
        s = get_settings()
        s.github_token = body.token
    except Exception:
        pass

    return {"configured": True}
