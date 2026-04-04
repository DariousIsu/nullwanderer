"""
AURA NX-Alpha — Dev Controller
All /dev/* endpoints + dedicated SSE stream for the Dev Panel.

Dev Mode Architecture:
    - DevPanel chat goes STRAIGHT to Workhorse (OllamaService) — no Interface Agent.
    - Interface Engine continues solo-mode chat unaffected.
    - Models only interact at the validation gate (Phase IV).
    - Separate /dev/stream SSE channel — completely independent of /stream.

ROUTES:
    POST /dev/activate              — Enter Dev Mode, dedicate Workhorse
    POST /dev/deactivate            — Exit Dev Mode, release Workhorse
    GET  /dev/state                 — Current dev mode state
    GET  /dev/stream                — SSE stream for DevPanel (separate channel)
    POST /dev/message               — DevPanel chat → straight to Workhorse → SSE
    POST /dev/project/new           — Create and register a new project
    POST /dev/project/open          — Load project into active session
    GET  /dev/project/list          — All registered projects
    GET  /dev/project/context       — Active project full context
    PUT  /dev/project/update        — Update project fields (stack, deploy_cmd, etc.)
    GET  /dev/tasks                 — Task queue for active project
    POST /dev/tasks/cancel/{task_id} — Cancel a queued or active task
"""

import asyncio
import json
import logging
import uuid
from pathlib import Path
from typing import Optional, AsyncGenerator

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.service.dev_session_service import (
    activate_dev_mode,
    deactivate_dev_mode,
    get_dev_state,
    is_dev_mode_active,
    create_project,
    open_project,
    list_projects,
    get_project_context,
    get_active_project,
    update_project,
    create_task,
    update_task_status,
    get_task_queue,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/dev", tags=["dev"])

# ─────────────────────────────────────────────────────────────────────────────
# DEDICATED DEV SSE BUS
# Completely separate from /stream in chat_controller.
# Only DevPanel EventSource connects here.
# ─────────────────────────────────────────────────────────────────────────────

_dev_clients: set[asyncio.Queue] = set()


def _dev_sse(event_type: str, data: dict) -> str:
    payload = json.dumps({**data, "type": event_type})
    return f"event: {event_type}\ndata: {payload}\n\n"


async def _dev_emit(event_type: str, data: dict) -> None:
    """Broadcast an event to all connected DevPanel SSE clients."""
    payload = {"type": event_type, **data}
    for q in list(_dev_clients):
        await q.put(payload)


async def _dev_stream_generator(request: Request) -> AsyncGenerator[str, None]:
    q: asyncio.Queue = asyncio.Queue()
    _dev_clients.add(q)
    yield ": dev-connected\n\n"
    try:
        while True:
            if await request.is_disconnected():
                return
            try:
                event = await asyncio.wait_for(q.get(), timeout=25.0)
                event_type = event.get("type", "message")
                yield _dev_sse(event_type, event)
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
            except asyncio.CancelledError:
                return
            except Exception as exc:
                logger.error("[dev_controller] Stream error: %s", exc)
                yield _dev_sse("error", {"message": "Dev stream error", "code": "DEV_STREAM_ERROR"})
    finally:
        _dev_clients.discard(q)


# ─────────────────────────────────────────────────────────────────────────────
# DEV MODE ACTIVATION
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/activate")
async def activate() -> dict:
    """
    Enter Dev Mode — Workhorse is dedicated to the Dev Panel.
    Also persists 'dev' as the operating mode to settings.json.
    """
    state = activate_dev_mode()
    # Persist operating mode
    try:
        from app.controller.chat_controller import _persist_settings_json, _runtime_state
        _runtime_state["operating_mode"] = "dev"
        _persist_settings_json({"operating_mode": "dev"})
    except Exception as exc:
        logger.warning("[dev_controller] Could not persist operating mode: %s", exc)
    logger.info("[dev_controller] Dev Mode activated")
    return {"status": "activated", **state}


@router.post("/deactivate")
async def deactivate() -> dict:
    """
    Exit Dev Mode — Workhorse is released back to the team pipeline.
    Restores operating mode to 'proactive'.
    """
    state = deactivate_dev_mode()
    try:
        from app.controller.chat_controller import _persist_settings_json, _runtime_state
        _runtime_state["operating_mode"] = "proactive"
        _persist_settings_json({"operating_mode": "proactive"})
    except Exception as exc:
        logger.warning("[dev_controller] Could not restore operating mode: %s", exc)
    logger.info("[dev_controller] Dev Mode deactivated")
    return {"status": "deactivated", **state}


@router.get("/state")
async def dev_state() -> dict:
    """Return current dev mode runtime state."""
    return get_dev_state()


# ─────────────────────────────────────────────────────────────────────────────
# DEV SSE STREAM
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/stream")
async def dev_stream(request: Request) -> StreamingResponse:
    """
    Dedicated SSE stream for the DevPanel.
    Completely separate from the main /stream — only dev events flow here.
    """
    return StreamingResponse(
        _dev_stream_generator(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# DEV MESSAGE — straight to Workhorse
# ─────────────────────────────────────────────────────────────────────────────

class DevMessageRequest(BaseModel):
    text: str
    thread_id: Optional[str] = None


@router.post("/message")
async def dev_message(
    body: DevMessageRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    """
    Receive a DevPanel chat message.
    Routes DIRECTLY to Workhorse (OllamaService.stream_chat) — no Interface Agent.
    Response streams to /dev/stream SSE channel.
    Returns 202 immediately.
    """
    if len(body.text) > 16000:
        raise HTTPException(
            status_code=400,
            detail="Message too long — max 16000 characters.",
        )
    msg_id = str(uuid.uuid4())
    background_tasks.add_task(_workhorse_response, body.text, msg_id)
    return {"status": "accepted", "msg_id": msg_id}


async def _workhorse_response(text: str, msg_id: str) -> None:
    """
    Send a message straight to the Workhorse (Ollama) and stream the response
    back through the dev SSE channel.
    No Interface Agent is involved.
    """
    try:
        from app.service.ollama_service import get_ollama_service
        ollama = get_ollama_service()
        if ollama is None:
            await _dev_emit("dev_error", {
                "msg_id": msg_id,
                "message": "Workhorse model not available — check Ollama is running.",
            })
            return

        # Build context: system prompt + active project context + user message
        project = get_active_project()
        system_parts = [
            "You are AURA's Workhorse — a dedicated AI coding assistant running in Dev Mode.",
            "You have full access to the developer toolkit: file_write, bash execution, git, repo mapping.",
            "Be direct and code-focused. Prefer writing actual code over describing it.",
            "When writing code, use canvas blocks. When executing, report results clearly.",
        ]
        if project:
            system_parts.append(
                f"\nActive Project: {project['name']}\n"
                f"Path: {project['path']}\n"
                f"Stack: {project.get('stack') or 'Unknown'}\n"
                f"Autonomy: {project.get('autonomy_mode', 'gated')}\n"
            )

        messages = [
            {"role": "system", "content": "\n".join(system_parts)},
            {"role": "user",   "content": text},
        ]

        # Stream tokens to dev SSE clients
        await _dev_emit("dev_thinking", {"msg_id": msg_id})

        full_text = await ollama.stream_chat(
            messages=messages,
            emit_fn=_dev_token_emit,
            msg_id=msg_id,
        )

        await _dev_emit("dev_end", {
            "msg_id": msg_id,
            "reason": "completed",
            "full_text": full_text,
        })

    except Exception as exc:
        logger.error("[dev_controller] Workhorse response failed: %s", exc)
        await _dev_emit("dev_error", {
            "msg_id": msg_id,
            "message": f"Workhorse error: {exc}",
        })


async def _dev_token_emit(event_type: str, payload: dict) -> None:
    """Adapter: stream_chat calls emit_fn(event_type, payload) — we forward to dev SSE."""
    await _dev_emit(event_type, payload)


# ─────────────────────────────────────────────────────────────────────────────
# PROJECT MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

class NewProjectRequest(BaseModel):
    name: str
    path: str
    stack: str = ""
    deploy_cmd: str = ""


@router.post("/project/new")
async def new_project(body: NewProjectRequest) -> dict:
    """
    Register a new project. Creates .aura/project.md scaffold in the project root.
    Returns the created project record.
    """
    # Validate path exists
    project_path = Path(body.path)
    if not project_path.exists():
        raise HTTPException(status_code=400, detail=f"Path does not exist: {body.path}")
    if not project_path.is_dir():
        raise HTTPException(status_code=400, detail=f"Path is not a directory: {body.path}")

    try:
        project = create_project(
            name=body.name,
            path=str(project_path.resolve()),
            stack=body.stack,
            deploy_cmd=body.deploy_cmd,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))

    # Scaffold .aura/project.md
    _scaffold_project_md(project_path, project)

    return {"status": "created", "project": project}


class OpenProjectRequest(BaseModel):
    project_id: int


@router.post("/project/open")
async def open_project_endpoint(body: OpenProjectRequest) -> dict:
    """Load a project into the active dev session context."""
    try:
        project = open_project(body.project_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    await _dev_emit("dev_project_loaded", {"project": project})
    return {"status": "opened", "project": project}


@router.get("/project/list")
async def project_list() -> dict:
    """Return all registered projects."""
    return {"projects": list_projects()}


@router.get("/project/context")
async def project_context() -> dict:
    """Return the full context for the active project."""
    return get_project_context()


class UpdateProjectRequest(BaseModel):
    project_id: int
    stack: Optional[str] = None
    deploy_cmd: Optional[str] = None
    autonomy_mode: Optional[str] = None
    last_plan: Optional[str] = None


@router.put("/project/update")
async def update_project_endpoint(body: UpdateProjectRequest) -> dict:
    """Update project fields."""
    fields = {k: v for k, v in body.model_dump().items() if k != "project_id" and v is not None}
    try:
        project = update_project(body.project_id, **fields)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"status": "updated", "project": project}


# ─────────────────────────────────────────────────────────────────────────────
# TASK QUEUE
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/tasks")
async def task_queue() -> dict:
    """Return the task queue for the active project."""
    return {"tasks": get_task_queue()}


@router.post("/tasks/cancel/{task_id}")
async def cancel_task(task_id: int) -> dict:
    """Cancel a queued or active task."""
    update_task_status(task_id, "cancelled")
    return {"status": "cancelled", "task_id": task_id}


# ─────────────────────────────────────────────────────────────────────────────
# LIVE PREVIEW
# ─────────────────────────────────────────────────────────────────────────────

class PreviewStartRequest(BaseModel):
    port: Optional[int] = None   # Override port detection if known


@router.post("/preview/start")
async def preview_start(body: PreviewStartRequest, background_tasks: BackgroundTasks) -> dict:
    """
    Start the project's dev server (runs deploy_cmd or detected dev command).
    Emits dev_preview_ready SSE event with the port when server is up.
    The Electron main process handles opening the BrowserWindow.
    """
    project = get_active_project()
    if not project:
        raise HTTPException(status_code=400, detail="No active project open.")
    background_tasks.add_task(_start_preview_server, project, body.port)
    return {"status": "starting"}


async def _start_preview_server(project: dict, override_port: Optional[int]) -> None:
    """Run the dev server command and detect the port from stdout."""
    import asyncio
    import re

    project_path = project["path"]
    # Detect dev command: look for package.json scripts or use deploy_cmd
    dev_cmd = _detect_dev_command(project)
    if not dev_cmd:
        await _dev_emit("dev_error", {"message": "No dev server command found. Set deploy_cmd in project settings."})
        return

    try:
        proc = await asyncio.create_subprocess_shell(
            dev_cmd,
            cwd=project_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        port = override_port
        port_pattern = re.compile(r"(?:localhost|127\.0\.0\.1):(\d{4,5})|port[:\s]+(\d{4,5})", re.IGNORECASE)
        timeout = 30.0
        deadline = asyncio.get_event_loop().time() + timeout

        while asyncio.get_event_loop().time() < deadline:
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=2.0)
            except asyncio.TimeoutError:
                continue
            if not line:
                break
            text = line.decode("utf-8", errors="replace").strip()
            await _dev_emit("dev_terminal_output", {"text": text, "source": "preview"})
            if not port:
                m = port_pattern.search(text)
                if m:
                    port = int(m.group(1) or m.group(2))
                    await _dev_emit("dev_preview_ready", {
                        "url": f"http://localhost:{port}",
                        "port": port,
                    })
                    return
        if port:
            await _dev_emit("dev_preview_ready", {"url": f"http://localhost:{port}", "port": port})
    except Exception as exc:
        logger.error("[dev_controller] Preview server failed: %s", exc)
        await _dev_emit("dev_error", {"message": f"Preview server error: {exc}"})


def _detect_dev_command(project: dict) -> Optional[str]:
    """Detect a dev server command from project config or package.json."""
    if project.get("deploy_cmd"):
        return project["deploy_cmd"]
    pkg = Path(project["path"]) / "package.json"
    if pkg.exists():
        try:
            import json
            data = json.loads(pkg.read_text(encoding="utf-8"))
            scripts = data.get("scripts", {})
            for name in ("dev", "start", "serve"):
                if name in scripts:
                    return f"npm run {name}"
        except Exception:
            pass
    return None


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _scaffold_project_md(project_path: Path, project: dict) -> None:
    """
    Create .aura/project.md in the project root.
    This file primes the Workhorse with project context on each session open.
    """
    aura_dir = project_path / ".aura"
    aura_dir.mkdir(exist_ok=True)
    project_md = aura_dir / "project.md"
    if project_md.exists():
        return  # Don't overwrite user edits

    content = f"""# Project: {project['name']}
**Stack:** {project.get('stack') or 'Not specified — update this file'}
**Root:** {project['path']}
**Deploy:** {project.get('deploy_cmd') or 'Not specified — set deploy_cmd in project settings'}
**Autonomy:** {project.get('autonomy_mode', 'gated')}

## Conventions
<!-- Add your coding conventions, style guides, and preferences here -->

## Architecture
<!-- Describe the high-level structure of this project -->
<!-- AURA will auto-populate this via repo_map scan when you first open the project -->

## Notes
<!-- Any important context the Workhorse should know about this project -->
"""
    project_md.write_text(content, encoding="utf-8")
    logger.info("[dev_controller] Scaffolded .aura/project.md at %s", project_path)
