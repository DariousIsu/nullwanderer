"""
AURA NX-Alpha — Boot Controller

SSE stream + REST endpoints for the supervised boot sequence.
The frontend connects here FIRST, before the main /stream endpoint.

ROUTES:
    GET  /boot/stream         — SSE stream for boot progress events
    GET  /boot/status         — current boot state (for reconnection)
    POST /boot/confirm-models — user accepts or changes model selection
    POST /boot/launch         — user clicks LAUNCH AURA
    GET  /boot/model-options  — available models that fit current GPU
"""

import asyncio
import json
import logging
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/boot", tags=["boot"])

# ─────────────────────────────────────────────────────────────────────────────
# MODULE STATE — set by main.py during lifespan setup
# ─────────────────────────────────────────────────────────────────────────────

_boot_sequence = None       # type: ignore
_boot_clients: set = set()  # SSE subscriber queues


def set_boot_sequence(boot_seq) -> None:
    """Called by main.py to register the boot sequence instance."""
    global _boot_sequence
    _boot_sequence = boot_seq


async def boot_emit(event_type: str, data: dict) -> None:
    """Broadcast a boot event to all connected SSE clients."""
    payload = {"type": event_type, **data}
    for q in list(_boot_clients):
        try:
            await q.put(payload)
        except Exception:
            pass


def _sse(event_type: str, data: dict) -> str:
    """Format a single named SSE event string."""
    payload = json.dumps({**data, "type": event_type})
    return f"event: {event_type}\ndata: {payload}\n\n"


# ─────────────────────────────────────────────────────────────────────────────
# SSE STREAM
# ─────────────────────────────────────────────────────────────────────────────

async def _boot_stream_generator() -> AsyncGenerator[str, None]:
    """Async generator for the boot SSE stream."""
    q: asyncio.Queue = asyncio.Queue()
    _boot_clients.add(q)

    yield ": boot stream connected\n\n"

    # Send current state immediately on connect (for reconnection)
    if _boot_sequence:
        yield _sse("boot_state", _boot_sequence.state.to_dict())

    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=15.0)
                event_type = event.get("type", "boot_step")
                yield _sse(event_type, event)
            except asyncio.TimeoutError:
                yield ": heartbeat\n\n"
            except asyncio.CancelledError:
                return
    finally:
        _boot_clients.discard(q)


@router.get("/stream")
async def boot_stream(request: Request):
    """SSE endpoint for boot progress. Frontend connects here on startup."""
    return StreamingResponse(
        _boot_stream_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ─────────────────────────────────────────────────────────────────────────────
# STATUS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/status")
async def boot_status():
    """Return current boot state. Used by frontend on page refresh."""
    if _boot_sequence is None:
        return {"current_phase": -1, "boot_complete": False, "launched": False}
    return _boot_sequence.state.to_dict()


# ─────────────────────────────────────────────────────────────────────────────
# MODEL GATE
# ─────────────────────────────────────────────────────────────────────────────

class ConfirmModelsRequest(BaseModel):
    interface_model: Optional[str] = None   # override GGUF path or None to keep
    workhorse_model: Optional[str] = None   # override Ollama model or None to keep


@router.post("/confirm-models")
async def confirm_models(body: ConfirmModelsRequest):
    """User confirms or changes model selection. Unblocks Phase 2."""
    if _boot_sequence is None:
        return {"error": "Boot sequence not initialized"}

    _boot_sequence.confirm_models(
        interface_override=body.interface_model,
        workhorse_override=body.workhorse_model,
    )
    return {"confirmed": True}


@router.post("/launch")
async def launch():
    """User clicks LAUNCH AURA. Transitions frontend to main UI."""
    if _boot_sequence is None:
        return {"error": "Boot sequence not initialized"}

    _boot_sequence.confirm_launch()
    return {"launched": True}


# ─────────────────────────────────────────────────────────────────────────────
# MODEL OPTIONS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/model-options")
async def model_options():
    """Return available models that fit the detected GPU."""
    try:
        from app.service.hardware_gate import get_vram_mb
        from app.service.llmfit_service import get_fit_suggestions
        vram = get_vram_mb()
        return get_fit_suggestions(vram)
    except Exception as exc:
        logger.warning("[boot] model-options failed: %s", exc)
        return {"error": str(exc)}
