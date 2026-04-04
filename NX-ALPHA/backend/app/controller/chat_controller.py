"""
AURA NX-Alpha — Chat Controller
SSE streaming endpoint + message intake.

§10 SSE Contract — all 26 event types
§15.8 chat_controller.py — LangGraph SSE streaming

ROUTES:
    GET  /stream         — persistent SSE connection (EventSource connects here)
    POST /message        — receive user text, trigger pipeline, emit events to stream
    PUT  /settings/team-gate — enable/disable Team Functions (§1.6)
    GET  /status         — backend health check
    GET  /storage        — storage component usage (§4.5)

SSE FORMAT (named events):
    event: token
    data: {"type": "token", "text": "hello"}

    event: end
    data: {"type": "end", "reason": "completed"}

Each SSE event has:
    - A named `event:` field matching the event type string
    - A `data:` field with JSON matching the §10 payload spec
    - The `type` field is always included in the JSON data
"""

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import AsyncGenerator, Optional

# ─────────────────────────────────────────────────────────────────────────────
# SESSION THREAD ID — persisted to disk so memory survives backend restarts
# ─────────────────────────────────────────────────────────────────────────────

_SESSION_THREAD_FILE = Path("~/.aura/session_thread.txt").expanduser()


def _load_or_create_thread_id() -> str:
    """Load the persisted session thread_id, or create and save a new one."""
    try:
        if _SESSION_THREAD_FILE.exists():
            stored = _SESSION_THREAD_FILE.read_text(encoding="utf-8").strip()
            if stored:
                return stored
    except Exception:
        pass
    new_id = str(uuid.uuid4())
    try:
        _SESSION_THREAD_FILE.parent.mkdir(parents=True, exist_ok=True)
        _SESSION_THREAD_FILE.write_text(new_id, encoding="utf-8")
    except Exception:
        pass
    return new_id


from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.config import get_settings
from app.utils.routing import is_team_task

logger = logging.getLogger(__name__)

router = APIRouter()

# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL EVENT BUS — broadcast fan-out
# Each connected SSE client gets its own queue. _emit() copies every event
# to all active client queues so multiple EventSource connections (main stream,
# Settings section panels, pop-out windows) each receive a complete copy.
# ─────────────────────────────────────────────────────────────────────────────

_stream_clients: set[asyncio.Queue] = set()
_canvas_replay: list[dict] = []   # Canvas events from current pipeline run; replayed on reconnect

# Session thread ID — persisted to disk so conversation memory survives backend restarts.
# The interface chat is always one conversation, so all messages share
# this thread_id unless the frontend explicitly provides a different one.
_session_thread_id: str = _load_or_create_thread_id()


def _get_session_thread_id() -> str:
    """Return the stable session thread_id for this backend instance."""
    return _session_thread_id


# Runtime state persisted in memory (survives individual message cycles).
# validator_challenger is seeded from config at first settings access (see _init_runtime_state).
_runtime_state: dict = {
    "team_enabled": False,
    "operating_mode": "proactive",
    "interface_busy": False,      # True while interface model is engaged as validator challenger
    "validator_challenger": None, # "interface" | "workhorse" — None = not yet seeded from config
    "pending_team_context": None, # str | None — set when interface asks clarifying Qs before team dispatch
    "pending_team_confirmed": False,  # True after user explicitly confirms team dispatch
    "brainstorm_mode": None,      # "devils_advocate"|"starbursting"|"socratic"|"sequential_scope"|None
    "brainstorm_turn_count": 0,   # turns since last explicit brainstorm trigger (for auto-clear)
    "vision_busy": False,         # True while screen vision analysis is running
}


def _ensure_runtime_seeded() -> None:
    """Seed runtime_state values from persisted settings.json on first access."""
    if _runtime_state["validator_challenger"] is None:
        _runtime_state["validator_challenger"] = get_settings().validator.challenger_source
        # Restore persisted frontend settings
        team_explicitly_set = False
        try:
            import json as _json
            sp = Path("~/.aura/settings.json").expanduser()
            if sp.exists():
                saved = _json.loads(sp.read_text(encoding="utf-8"))
                if "operating_mode" in saved:
                    _runtime_state["operating_mode"] = saved["operating_mode"]
                if "team_enabled" in saved:
                    _runtime_state["team_enabled"] = saved["team_enabled"]
                    team_explicitly_set = True
                logger.debug("[chat_controller] Restored settings: mode=%s team=%s",
                             _runtime_state["operating_mode"], _runtime_state["team_enabled"])
        except Exception as exc:
            logger.debug("[chat_controller] Could not restore settings: %s", exc)

        # Auto-enable team gate when hardware supports it and user hasn't explicitly disabled it
        if not team_explicitly_set:
            try:
                from app.service.hardware_gate import is_team_available
                if is_team_available():
                    _runtime_state["team_enabled"] = True
                    logger.info("[chat_controller] Team gate auto-enabled (hardware supports full mode)")
            except Exception:
                pass


def set_interface_busy(busy: bool) -> None:
    """
    Mark the interface model as busy (in use by the validator challenger role).
    Called by validator.py before/after using the interface engine for adversarial review.
    """
    _runtime_state["interface_busy"] = busy


def get_validator_challenger() -> str:
    """Return the active challenger source ('interface' or 'workhorse')."""
    _ensure_runtime_seeded()
    return _runtime_state["validator_challenger"]


# ─────────────────────────────────────────────────────────────────────────────
# SSE HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _sse(event_type: str, data: dict) -> str:
    """Format a single named SSE event string."""
    payload = json.dumps({**data, "type": event_type})
    return f"event: {event_type}\ndata: {payload}\n\n"


async def _emit(event_type: str, data: dict) -> None:
    """Broadcast an event to all connected SSE clients."""
    payload = {"type": event_type, **data}
    if event_type == "render_canvas":
        _canvas_replay.append(payload)   # buffer for clients that reconnect mid-response
    elif event_type == "end":
        _canvas_replay.clear()           # pipeline complete — new response will start fresh
    for q in list(_stream_clients):
        await q.put(payload)


# ─────────────────────────────────────────────────────────────────────────────
# PROACTIVE DELIVERY (Idle Processing)
# ─────────────────────────────────────────────────────────────────────────────

_proactive_queue: list[dict] = []

# Minimum operating mode required for immediate delivery (ordered least → most restrictive)
_MODE_RANK = {"proactive": 0, "ambient": 1, "quiet": 2, "study": 3, "dev": 4}

# Delivery rules: event_type → min mode for immediate emit
_PROACTIVE_DELIVERY_RULES: dict[str, str] = {
    "news_break_breaking":  "ambient",     # breaking news → emit in proactive + ambient
    "news_break_urgent":    "proactive",   # urgent news → emit only in proactive
    "idle_insight":         "proactive",   # insights → emit only in proactive
    "morning_briefing":     "ambient",     # briefings → emit in proactive + ambient
    "daily_recap":          "ambient",     # recaps → emit in proactive + ambient
}


async def deliver_proactive(event_type: str, data: dict, significance: str = "") -> None:
    """
    Deliver a proactive notification, respecting operating mode.

    If the current mode allows immediate delivery, emits via SSE.
    Otherwise queues for "while you were away" flush on user return.
    """
    current_mode = _runtime_state.get("operating_mode", "proactive")
    current_rank = _MODE_RANK.get(current_mode, 0)

    # Build lookup key (e.g. "news_break_breaking" or just "idle_insight")
    lookup = f"{event_type}_{significance}" if significance else event_type
    min_mode = _PROACTIVE_DELIVERY_RULES.get(lookup, _PROACTIVE_DELIVERY_RULES.get(event_type, "proactive"))
    min_rank = _MODE_RANK.get(min_mode, 0)

    if current_rank <= min_rank:
        # Deliver immediately
        await _emit(event_type, data)
        logger.info("[proactive] Delivered %s immediately (mode=%s)", lookup, current_mode)
    elif current_mode == "study" and event_type == "idle_insight":
        # Suppress entirely in study mode
        logger.debug("[proactive] Suppressed %s in study mode", lookup)
    else:
        # Queue for later
        _proactive_queue.append({
            "event_type": event_type,
            "data": data,
            "significance": significance,
            "queued_at": time.time(),
        })
        logger.debug("[proactive] Queued %s (mode=%s, queue_size=%d)", lookup, current_mode, len(_proactive_queue))


async def flush_proactive_queue() -> None:
    """
    Flush queued proactive notifications on user return.
    If 4+ items, synthesize into a single summary via Interface Engine.
    """
    if not _proactive_queue:
        return

    items = list(_proactive_queue)
    _proactive_queue.clear()

    if len(items) <= 3:
        # Deliver individually
        for item in items:
            await _emit(item["event_type"], item["data"])
        logger.info("[proactive] Flushed %d queued items individually", len(items))
    else:
        # Synthesize summary via Interface Engine
        try:
            from app.service.interface_engine import get_engine
            engine = get_engine()
            if engine:
                summaries = []
                for item in items:
                    summary = item["data"].get("summary", item["data"].get("content", str(item["data"])))
                    summaries.append(f"- [{item['event_type']}] {summary}")
                prompt_text = (
                    f"While the user was away, {len(items)} events occurred:\n"
                    + "\n".join(summaries[:10])
                    + "\n\nWrite a concise 2-3 sentence summary of what happened."
                )
                result = await engine.generate(
                    [{"role": "user", "content": prompt_text}],
                    max_tokens=256,
                    temperature=0.3,
                )
                summary_text = result.get("text", "You had several notifications while away.")
            else:
                summary_text = f"You had {len(items)} notifications while you were away."
        except Exception as exc:
            logger.warning("[proactive] Summary generation failed: %s", exc)
            summary_text = f"You had {len(items)} notifications while you were away."

        await _emit("idle_summary", {
            "summary": summary_text,
            "item_count": len(items),
            "items": [{"type": i["event_type"], "significance": i["significance"]} for i in items],
        })
        logger.info("[proactive] Flushed %d queued items as summary", len(items))


async def _stream_generator(request: Request) -> AsyncGenerator[str, None]:
    """
    Async generator for the SSE StreamingResponse.
    Registers a per-client queue, receives broadcasts from _emit(),
    and deregisters on disconnect/error.
    Heartbeat comments keep the connection alive across idle periods.
    """
    q: asyncio.Queue = asyncio.Queue()
    # Replay any canvas blocks emitted before this connection (e.g. during reconnect window)
    for event in list(_canvas_replay):
        await q.put(event)
    _stream_clients.add(q)

    # Opening comment — not an event, just establishes the stream
    yield ": connected\n\n"

    try:
        while True:
            if await request.is_disconnected():
                logger.info("[chat_controller] SSE client disconnected — closing stream")
                return
            try:
                event = await asyncio.wait_for(q.get(), timeout=25.0)
                event_type = event.get("type", "message")
                yield _sse(event_type, event)
            except asyncio.TimeoutError:
                # SSE comment — ignored by EventSource, prevents proxy timeout
                yield ": heartbeat\n\n"
            except asyncio.CancelledError:
                logger.info("[chat_controller] SSE stream cancelled")
                return
            except Exception as exc:
                logger.error("[chat_controller] Stream generator error: %s", exc)
                yield _sse("error", {"message": "Stream error — check server logs.", "code": "STREAM_ERROR"})
    finally:
        _stream_clients.discard(q)


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/stream")
async def stream(request: Request) -> StreamingResponse:
    """
    Persistent SSE endpoint. The Electron frontend connects here via EventSource.
    Emits all §10 event types as named SSE events.
    """
    return StreamingResponse(
        _stream_generator(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
            # CORS is handled by CORSMiddleware in main.py — no wildcard override here
        },
    )


class MessageRequest(BaseModel):
    text: str
    thread_id: Optional[str] = None
    voice_enabled: bool = False


@router.post("/message")
async def receive_message(
    body: MessageRequest,
    background_tasks: BackgroundTasks,
) -> dict:
    """
    Receive a user message. Starts processing in the background;
    responses stream via /stream as SSE events.

    Returns 202 immediately — the SSE stream delivers the reply.
    """
    if len(body.text) > 16000:
        raise HTTPException(
            status_code=400,
            detail="Message too long — please break your input into smaller parts (max ~4000 tokens / 16000 characters).",
        )
    settings = get_settings()
    # Use a stable session thread_id so conversation history persists
    # across messages. The interface chat is always one conversation.
    thread_id = body.thread_id or _get_session_thread_id()

    if settings.dev_stub_responses:
        background_tasks.add_task(_stub_response, body.text, thread_id, body.voice_enabled)
    else:
        background_tasks.add_task(_pipeline_response, body.text, thread_id, body.voice_enabled)

    return {"status": "accepted", "thread_id": thread_id}


class TeamClarificationRequest(BaseModel):
    answer: str
    thread_id: Optional[str] = None


@router.post("/chat/team-clarification")
async def team_clarification(body: TeamClarificationRequest) -> dict:
    """
    Phase 5: Send a clarification answer to a paused PM.
    Stub — activates when PM gains pause/resume ability in Phase 5.
    """
    from app.service.team_dispatcher import get_team_dispatcher
    thread_id = body.thread_id or _get_session_thread_id()
    dispatcher = get_team_dispatcher()
    accepted = await dispatcher.answer_clarification(body.answer, thread_id)
    return {"accepted": accepted, "thread_id": thread_id}


@router.get("/chat/team-status")
async def team_status() -> dict:
    """Return current TeamDispatcher status: active team_id and queue depth."""
    from app.service.team_dispatcher import get_team_dispatcher
    dispatcher = get_team_dispatcher()
    return dispatcher.get_status()


class TeamGateRequest(BaseModel):
    enabled: bool


@router.put("/settings/team-gate")
async def set_team_gate(body: TeamGateRequest) -> dict:
    """
    Enable or disable Team Functions (Path B pipeline). §1.6
    Blocked if hardware_gate reports interface_only mode.
    """
    try:
        from app.service.hardware_gate import is_team_available
        if body.enabled and not is_team_available():
            return {
                "team_enabled": False,
                "blocked": True,
                "reason": "hardware_limited",
                "message": "Team pipeline requires a GPU with at least 20 GB VRAM.",
            }
    except Exception:
        pass
    _runtime_state["team_enabled"] = body.enabled
    _persist_settings_json({"team_enabled": body.enabled})
    logger.info("[chat_controller] Team gate: %s", "enabled" if body.enabled else "disabled")
    return {"team_enabled": body.enabled, "blocked": False}


class OperatingModeRequest(BaseModel):
    mode: str   # "proactive" | "reactive" | "quiet"


@router.put("/settings/operating-mode")
async def set_operating_mode(body: OperatingModeRequest) -> dict:
    """
    Persist the operating mode across restarts.
    When switching to 'dev', activates dev mode (locks Workhorse to Dev Panel).
    When switching away from 'dev', deactivates dev mode (releases Workhorse).
    """
    previous_mode = _runtime_state.get("operating_mode")
    _runtime_state["operating_mode"] = body.mode
    _persist_settings_json({"operating_mode": body.mode})
    logger.info("[chat_controller] Operating mode: %s", body.mode)

    # Auto-activate/deactivate dev session service when switching to/from dev mode
    try:
        from app.service.dev_session_service import activate_dev_mode, deactivate_dev_mode
        if body.mode == "dev" and previous_mode != "dev":
            activate_dev_mode()
        elif body.mode != "dev" and previous_mode == "dev":
            deactivate_dev_mode()
    except Exception as _de:
        logger.debug("[chat_controller] Dev mode toggle failed (non-fatal): %s", _de)

    return {"operating_mode": body.mode}


@router.get("/settings")
async def get_all_settings() -> dict:
    """Return all persisted settings for frontend restore on mount."""
    import json as _json
    _ensure_runtime_seeded()
    settings = get_settings()
    # Read raw persisted file
    persisted = {}
    try:
        sp = Path("~/.aura/settings.json").expanduser()
        if sp.exists():
            persisted = _json.loads(sp.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {
        "operating_mode": _runtime_state["operating_mode"],
        "team_enabled": _runtime_state["team_enabled"],
        "validator_challenger": _runtime_state["validator_challenger"],
        "dev_stub_responses": settings.dev_stub_responses,
        "voice": persisted.get("voice", {}),
        "api_keys": persisted.get("api_keys", {}),
        "email_senders": persisted.get("email_senders", []),
    }


# ── API Key persistence ─────────────────────────────────────────────────────

class ApiKeySaveRequest(BaseModel):
    key_id: str
    value: str


@router.put("/settings/api-key")
async def save_api_key(body: ApiKeySaveRequest) -> dict:
    """Persist a single API key into ~/.aura/settings.json."""
    _persist_settings_json({"api_keys": {body.key_id: body.value}})
    # HuggingFace token also needs to go to ~/.huggingface/token for the hub lib
    if body.key_id == "huggingface" and body.value:
        try:
            hf_dir = Path("~/.huggingface").expanduser()
            hf_dir.mkdir(parents=True, exist_ok=True)
            (hf_dir / "token").write_text(body.value, encoding="utf-8")
            logger.info("[chat_controller] HF token also written to ~/.huggingface/token")
        except Exception as exc:
            logger.warning("[chat_controller] Could not write HF token file: %s", exc)
    logger.info("[chat_controller] API key saved: %s", body.key_id)
    return {"key_id": body.key_id, "status": "saved"}


@router.get("/settings/api-keys")
async def get_api_keys() -> dict:
    """Return all saved API keys (masked for display)."""
    import json as _json
    sp = Path("~/.aura/settings.json").expanduser()
    keys: dict = {}
    try:
        if sp.exists():
            data = _json.loads(sp.read_text(encoding="utf-8"))
            keys = data.get("api_keys", {})
    except Exception:
        pass
    # Mask values for safe display: show last 4 chars only
    masked = {}
    for k, v in keys.items():
        if v and len(v) > 4:
            masked[k] = "•" * (len(v) - 4) + v[-4:]
        else:
            masked[k] = v
    return {"api_keys": masked, "has_keys": {k: bool(v) for k, v in keys.items()}}


class EmailSendersSaveRequest(BaseModel):
    senders: list


@router.put("/settings/email-senders")
async def save_email_senders(body: EmailSendersSaveRequest) -> dict:
    """Persist email sender configs to ~/.aura/settings.json."""
    _persist_settings_json({"email_senders": body.senders})
    logger.info("[chat_controller] Email senders updated: %d entries", len(body.senders))
    return {"status": "saved", "count": len(body.senders)}


class ValidatorSettingsRequest(BaseModel):
    challenger_source: str   # "interface" | "workhorse"


@router.put("/settings/validator")
async def set_validator_settings(body: ValidatorSettingsRequest) -> dict:
    """
    Switch the validator challenger model at runtime. §12.1

    "interface"  — Interface model (Phase 1, single-GPU hardware).
                   Interface is marked busy during validation; live chat receives
                   a hold message while the challenger is running.

    "workhorse"  — Ollama workhorse (Phase 2+ once 32GB GPUs are installed).
                   Interface model stays free for live chat during validation.

    Persisted to ~/.aura/settings.json so it survives restarts.
    """
    source = body.challenger_source
    if source not in ("interface", "workhorse"):
        return {"error": f"Invalid challenger_source '{source}'. Must be 'interface' or 'workhorse'.", "status": "rejected"}

    _ensure_runtime_seeded()
    _runtime_state["validator_challenger"] = source
    _persist_settings_json({"validator": {"challenger_source": source}})
    logger.info("[chat_controller] Validator challenger: %s", source)
    return {"validator_challenger": source, "status": "ok"}


@router.get("/status")
async def status() -> dict:
    """Backend health check. Returns runtime state summary."""
    settings = get_settings()
    _ensure_runtime_seeded()
    return {
        "status": "ok",
        "hardware_phase": settings.hardware_phase,
        "interface_model": settings.interface_model_name,
        "workhorse_model": settings.workhorse_model_name,
        "team_enabled": _runtime_state["team_enabled"],
        "operating_mode": _runtime_state["operating_mode"],
        "validator_challenger": _runtime_state["validator_challenger"],
        "dev_stub_responses": settings.dev_stub_responses,
    }


@router.get("/models/status")
async def models_status() -> dict:
    """Live model + GPU status for the frontend model cards."""
    settings = get_settings()

    # ── Interface Engine status ──
    interface_status = "offline"
    interface_health = {}
    try:
        from app.service.interface_engine import get_engine
        engine = get_engine()
        if engine:
            interface_health = engine.health_check()
            interface_status = "online" if interface_health.get("model_loaded") else "stub"
    except Exception:
        pass

    # ── Workhorse (Ollama) status ──
    workhorse_status = "offline"
    svc = None
    try:
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc and await asyncio.to_thread(svc.is_available):
            workhorse_status = "online"
    except Exception:
        pass

    # ── GPU info ──
    gpu_info = []
    try:
        from app.service.system_monitor_service import get_latest_snapshot
        snapshot = get_latest_snapshot()
        gpu_info = snapshot.get("gpu", [])
    except Exception:
        pass

    # ── Hardware gate ──
    hw_mode = "interface_only"
    vram_mb = 0
    try:
        from app.service.hardware_gate import get_hardware_mode, get_vram_mb
        hw_mode = get_hardware_mode()
        vram_mb = get_vram_mb()
    except Exception:
        pass

    return {
        "interface": {
            "name":   settings.interface_model_name,
            "status": interface_status,
            "runtime": "llama-cpp-python",
            "stub_mode": settings.dev_stub_responses or interface_status == "stub",
            **interface_health,
        },
        "workhorse": {
            "name":   settings.workhorse_model_name,
            "status": workhorse_status,
            "runtime": "ollama",
            "loaded": svc.is_probably_loaded if svc else False,
            "idle_seconds": round(svc.idle_seconds) if svc else None,
            "keep_alive": settings.workhorse.keep_alive,
        },
        "gpu": gpu_info,
        "hardware_mode": hw_mode,
        "vram_mb": vram_mb,
        "dev_stub_responses": settings.dev_stub_responses,
    }


@router.get("/storage")
async def get_storage() -> dict:
    """
    §4.5 Storage Viewport — returns current usage per component plus disk pool stats.
    Live usage queried from storage_monitor; falls back to zeros if monitor not running.
    Includes runtime quota overrides so the UI always shows the current effective quota.
    """
    import shutil as _shutil
    try:
        from app.service.storage_monitor import get_latest_storage_snapshot, _runtime_quotas
        snapshot = get_latest_storage_snapshot()
    except Exception:
        snapshot = {}
        _runtime_quotas = {}

    settings = get_settings()
    s = settings.storage
    components = [
        {"id": "conversations",  "quota_gb": _runtime_quotas.get("conversations",  2.0)},
        {"id": "vector",         "quota_gb": _runtime_quotas.get("vector",         s.layer2_quota_gb)},
        {"id": "graph",          "quota_gb": _runtime_quotas.get("graph",          s.layer3_quota_gb)},
        {"id": "api_cache",      "quota_gb": _runtime_quotas.get("api_cache",      s.api_cache_quota_gb)},
        {"id": "training_data",  "quota_gb": _runtime_quotas.get("training_data",  s.training_data_quota_gb)},
        {"id": "study_data",     "quota_gb": _runtime_quotas.get("study_data",     s.study_data_quota_gb)},
        {"id": "knowledge",      "quota_gb": _runtime_quotas.get("knowledge",      s.knowledge_quota_gb)},
    ]

    result = []
    total_allocated = 0.0
    for comp in components:
        live = snapshot.get(comp["id"], {})
        used_gb = live.get("used_gb", 0.0)
        quota_gb = live.get("quota_gb", comp["quota_gb"])
        pct = (used_gb / quota_gb * 100) if quota_gb > 0 else 0.0
        total_allocated += quota_gb
        result.append({
            "component": comp["id"],
            "used_gb":   round(used_gb, 2),
            "quota_gb":  round(quota_gb, 2),
            "pct":       round(pct, 1),
        })

    # Disk pool stats for the allocation editor
    try:
        disk = _shutil.disk_usage(Path("~/.aura").expanduser())
        disk_total_gb = round(disk.total / 1024 ** 3, 1)
        disk_free_gb  = round(disk.free  / 1024 ** 3, 1)
    except Exception:
        disk_total_gb = 0.0
        disk_free_gb  = 0.0

    return {
        "components":       result,
        "disk_total_gb":    disk_total_gb,
        "disk_free_gb":     disk_free_gb,
        "total_allocated_gb": round(total_allocated, 1),
    }


class StorageQuotaRequest(BaseModel):
    component: str
    quota_gb: float


@router.put("/storage/quota")
async def set_storage_quota(body: StorageQuotaRequest) -> dict:
    """
    Update quota for a storage component. §4.5
    Applies immediately at runtime (next storage_monitor tick) and
    persists to ~/.aura/settings.json so the quota survives restarts.
    """
    logger.info(
        "[chat_controller] Storage quota update: %s → %.1f GB",
        body.component, body.quota_gb
    )
    try:
        from app.service.storage_monitor import set_quota_override
        set_quota_override(body.component, body.quota_gb)
    except Exception as exc:
        logger.warning("[chat_controller] Could not apply runtime quota override: %s", exc)
    _persist_settings_json({"storage_quotas": {body.component: body.quota_gb}})
    return {"component": body.component, "quota_gb": body.quota_gb, "status": "accepted"}


# ─────────────────────────────────────────────────────────────────────────────
# CONVERSATIONS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/conversations")
async def list_conversations(
    limit: int = 50,
    q: str | None = Query(default=None, description="Optional keyword filter — only returns threads containing matching turns"),
) -> dict:
    """
    List recent conversation threads from Layer 1 SQLite memory.
    Returns newest-first list with preview snippets.
    When `q` is provided, filters to threads whose turns match the keyword via FTS5.
    """
    try:
        from app.service.conversation_service import list_conversations as _list
        conversations = _list(limit=limit, query=q or None)
        return {
            "conversations": [
                {
                    "thread_id":     c.thread_id,
                    "first_message": c.first_message,
                    "last_active":   c.last_active,
                    "turn_count":    c.turn_count,
                    "preview":       c.preview,
                }
                for c in conversations
            ]
        }
    except Exception as exc:
        logger.warning("[chat_controller] list_conversations error: %s", exc)
        return {"conversations": []}


@router.get("/conversations/search")
async def search_conversations(
    q: str = Query(..., description="Search query"),
    mode: str = Query(default="keyword", description="'keyword' (FTS5) or 'semantic' (ChromaDB)"),
    limit: int = Query(default=20, ge=1, le=100),
    thread_id: str | None = Query(default=None, description="Restrict search to a specific thread"),
) -> dict:
    """
    Search conversation history by keyword (FTS5) or semantic similarity (ChromaDB).
    Only searches turns indexed after the dual-write patch was deployed.
    """
    try:
        if mode == "semantic":
            from app.service.conversation_service import search_conversations_semantic
            results = await search_conversations_semantic(q, limit=limit)
        else:
            from app.service.conversation_service import search_conversations as _search
            results = _search(q, limit=limit, thread_id=thread_id)
        return {"query": q, "mode": mode, "results": results, "count": len(results)}
    except Exception as exc:
        logger.warning("[chat_controller] search_conversations error: %s", exc)
        return {"query": q, "mode": mode, "results": [], "count": 0}


class ConversationRestoreRequest(BaseModel):
    thread_id: str


@router.post("/conversations/restore")
async def restore_conversation(body: ConversationRestoreRequest) -> dict:
    """
    Restore a past conversation thread into the active context.
    Returns the restored summary string for the frontend to display.
    """
    try:
        from app.service.conversation_service import restore_thread
        summary = restore_thread(body.thread_id)
        if summary is None:
            return {"status": "not_found", "thread_id": body.thread_id}
        return {"status": "restored", "thread_id": body.thread_id, "summary": summary}
    except Exception as exc:
        logger.warning("[chat_controller] restore_conversation error: %s", exc)
        return {"status": "error", "message": str(exc)}


@router.delete("/conversations/{thread_id}")
async def delete_conversation(thread_id: str) -> dict:
    """Delete a conversation thread from Layer 1 memory."""
    try:
        from app.service.conversation_service import delete_thread
        deleted = delete_thread(thread_id)
        return {"status": "deleted" if deleted else "not_found", "thread_id": thread_id}
    except Exception as exc:
        logger.warning("[chat_controller] delete_conversation error: %s", exc)
        return {"status": "error", "message": str(exc)}


# ─────────────────────────────────────────────────────────────────────────────
# APPROVALS — pending_approval SSE events
# ─────────────────────────────────────────────────────────────────────────────

class ApprovalRequest(BaseModel):
    approval_id: str
    decision: str   # "approved" | "denied"
    tool: Optional[str] = None


# In-memory approval registry — maps approval_id → asyncio.Event + decision
_pending_approvals: dict = {}


@router.post("/approvals")
async def post_approval(body: ApprovalRequest) -> dict:
    """
    Receive user approval/denial for a pending_approval SSE event.
    The pipeline node waiting on this approval_id is unblocked.
    """
    logger.info(
        "[chat_controller] Approval received: %s → %s (tool: %s)",
        body.approval_id, body.decision, body.tool or "unknown"
    )

    # Resolve any waiter registered for this approval_id
    entry = _pending_approvals.get(body.approval_id)
    if entry:
        entry["decision"] = body.decision
        entry["event"].set()

    # Emit SSE event so stream listeners can react immediately
    await _emit("approval_received", {
        "approval_id": body.approval_id,
        "decision":    body.decision,
    })

    return {"status": "ok", "approval_id": body.approval_id, "decision": body.decision}


async def wait_for_approval(approval_id: str, timeout_s: float = 300.0) -> str:
    """
    Called by pipeline nodes that need user approval before proceeding.
    Returns "approved" or "denied" (or "timeout").
    """
    event = asyncio.Event()
    _pending_approvals[approval_id] = {"event": event, "decision": "denied"}
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout_s)
        return _pending_approvals[approval_id]["decision"]
    except asyncio.TimeoutError:
        return "timeout"
    finally:
        _pending_approvals.pop(approval_id, None)


# ─────────────────────────────────────────────────────────────────────────────
# SYNC CHAT — MCP server endpoint (stub)
# ─────────────────────────────────────────────────────────────────────────────

class SyncChatRequest(BaseModel):
    message: str
    thread_id: str = "mcp_default"


@router.post("/chat/sync")
async def sync_chat(req: SyncChatRequest):
    """Synchronous chat endpoint for MCP server — returns full response as JSON.

    Stub implementation: acknowledges the message and confirms AURA is reachable.
    Full graph-based implementation deferred to post-showcase.
    """
    logger.info("[chat_controller] /chat/sync from thread %s: %s", req.thread_id, req.message[:100])
    return {
        "response": (
            f"[AURA MCP stub] Message received: \"{req.message[:200]}\". "
            f"AURA backend is online. Full pipeline integration pending."
        ),
        "thread_id": req.thread_id,
        "status": "stub",
    }


# ─────────────────────────────────────────────────────────────────────────────
# SETTINGS PERSISTENCE
# ─────────────────────────────────────────────────────────────────────────────

def _persist_settings_json(updates: dict) -> None:
    """
    Deep-merge `updates` into ~/.aura/settings.json.
    Non-critical — failures are logged but not re-raised.
    """
    import json as _json
    settings_path = Path("~/.aura/settings.json").expanduser()
    try:
        settings_path.parent.mkdir(parents=True, exist_ok=True)
        existing: dict = {}
        if settings_path.exists():
            try:
                existing = _json.loads(settings_path.read_text(encoding="utf-8"))
            except Exception:
                existing = {}

        # Deep merge (one level)
        for key, value in updates.items():
            if isinstance(value, dict) and isinstance(existing.get(key), dict):
                existing[key].update(value)
            else:
                existing[key] = value

        settings_path.write_text(
            _json.dumps(existing, indent=2, ensure_ascii=False),
            encoding="utf-8"
        )
    except Exception as exc:
        logger.warning("[chat_controller] Failed to persist settings.json: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# PROCESSING — STUB (dev_stub_responses=True, Sprint 0)
# Replace with _pipeline_response when LangGraph is wired (Sprint 1+).
# ─────────────────────────────────────────────────────────────────────────────

async def _stub_response(text: str, thread_id: str, voice_enabled: bool = False) -> None:
    """
    Stub pipeline — emits token stream + end without loading any models.
    Exercises the full SSE → frontend path for UI development and testing.
    """
    from app.service.streaming_tts_service import StreamingTTSEmitter

    msg_id = f"msg-{thread_id[:8]}"
    tts_emitter = StreamingTTSEmitter(emit_fn=_emit, enabled=voice_enabled)

    # Short delay — simulates thinking
    await asyncio.sleep(0.3)

    # Check team gate
    if is_team_task(text) and not _runtime_state["team_enabled"]:
        await _emit("team_gate_prompt", {
            "message": "This looks like a team task. Enable Team Functions in Settings → General to run the full pipeline.",
        })
        await asyncio.sleep(0.2)
        await _emit("end", {"reason": "team_gate_closed"})
        return

    # Stream token response
    stub_reply = _generate_stub_reply(text)
    words = stub_reply.split(" ")
    for i, word in enumerate(words):
        token = ("" if i == 0 else " ") + word
        await _emit("token", {"text": token, "messageId": msg_id})
        await tts_emitter.feed(token)
        await asyncio.sleep(0.04)

    # Flush streaming TTS + seal the stream
    await tts_emitter.flush()
    await asyncio.sleep(0.1)
    await _emit("end", {"reason": "completed"})


async def _pipeline_response(text: str, thread_id: str, voice_enabled: bool = False) -> None:
    """
    Full LangGraph pipeline response (Sprint 1+).
    Runs the compiled graph with interface_agent as entry point.
    interface_agent streams tokens directly to the SSE queue.
    """
    # Reset idle timer — user is active
    try:
        from app.service.screen_awareness_service import update_interaction
        update_interaction()
    except Exception:
        pass

    from app.graph.pipeline import get_pipeline
    from app.graph.state import initial_state
    from app.config import get_settings

    settings = get_settings()
    pipeline = get_pipeline()

    # ── PHASE 5: PM clarification intercept ────────────────────────────────────
    # If the PM is currently paused waiting for user input, route this message
    # directly to the dispatcher instead of running the chat pipeline.
    try:
        from app.service.team_dispatcher import get_team_dispatcher
        _dispatcher = get_team_dispatcher()
        if _dispatcher.is_awaiting_clarification(thread_id):
            accepted = await _dispatcher.answer_clarification(text, thread_id)
            if accepted:
                msg_id = f"msg-clarify-{thread_id[:8]}"
                ack = "Got it — I'll factor that in."
                words = ack.split()
                for i, word in enumerate(words):
                    await _emit("token", {
                        "text":      ("" if i == 0 else " ") + word,
                        "messageId": msg_id,
                    })
                    await asyncio.sleep(0.04)
                await asyncio.sleep(0.05)
                await _emit("end", {"reason": "completed"})
                logger.info("[chat_controller] PM clarification answered for thread %s", thread_id)
                return
    except Exception as _ce:
        logger.debug("[chat_controller] Clarification intercept check failed: %s", _ce)

    # Interface model is mid-validation — hold the user with a brief message
    if _runtime_state.get("interface_busy"):
        msg_id = f"msg-{thread_id[:8]}"
        hold_text = "I'll be with you shortly — finishing up a validation."
        words = hold_text.split()
        for i, word in enumerate(words):
            await _emit("token", {"text": ("" if i == 0 else " ") + word, "messageId": msg_id})
        await _emit("end", {"reason": "completed"})
        return

    # ── Dev Mode: queue team tasks — Workhorse is dedicated to dev panel ────────
    # When Dev Mode is active, the Workhorse is locked to the dev panel.
    # Team pipeline tasks arrive here but cannot run — queue them and notify user.
    if _runtime_state.get("operating_mode") == "dev":
        if is_team_task(text) and _runtime_state.get("team_enabled"):
            try:
                from app.service.dev_session_service import create_task
                task = create_task(text)
                await _emit("warning", {
                    "message": (
                        "Dev Mode is active — Workhorse is dedicated to the Dev Panel. "
                        f"Your team task has been queued (id: {task['id']}) and will run when Dev Mode ends."
                    ),
                    "code": "DEV_MODE_QUEUED",
                })
            except Exception as _qe:
                await _emit("warning", {
                    "message": "Dev Mode active — this team task will run when Dev Mode is deactivated.",
                    "code": "DEV_MODE_QUEUED",
                })
                logger.warning("[chat_controller] Dev mode task queue failed: %s", _qe)
            await _emit("end", {"reason": "dev_mode_queued"})
            return

    if pipeline is None:
        logger.error("[chat_controller] Pipeline not compiled — falling back to error")
        await _emit("error", {
            "message": "LangGraph pipeline not available. Install: pip install langgraph langgraph-checkpoint-sqlite",
            "code":    "PIPELINE_NOT_READY",
        })
        await _emit("end", {"reason": "error"})
        return

    # Build initial state for this message.
    # Pre-populate conversation_history from L1 SQLite so LangGraph's checkpoint
    # doesn't lose history when initial_state() would otherwise reset it to [].
    prior_history: list = []
    try:
        from app.service.memory_service import get_memory_service
        mem_svc = get_memory_service()
        if mem_svc is not None:
            turns = mem_svc._get_sliding_window(thread_id, limit=20)
            if not turns:
                turns = mem_svc._get_recent_turns_all_threads(limit=20)
            prior_history = [
                {"role": t["role"], "content": t["content"],
                 "timestamp": str(t.get("timestamp", ""))}
                for t in turns
            ]
    except Exception as exc:
        logger.debug("[chat_controller] Could not pre-load conversation history: %s", exc)

    state = initial_state(
        thread_id=thread_id,
        hardware_phase=settings.hardware_phase,
        interface_model=settings.interface_model_name,
        workhorse_model=settings.workhorse_model_name,
        team_enabled=_runtime_state["team_enabled"],
        operating_mode=_runtime_state["operating_mode"],
    )
    state["user_message"] = text
    state["voice_enabled"] = voice_enabled
    if prior_history:
        state["conversation_history"] = prior_history

    config = {
        "configurable": {
            "thread_id": thread_id,
        }
    }

    try:
        logger.info("[chat_controller] Invoking pipeline: thread=%s msg=%.60s", thread_id, text)
        # interface_agent node emits tokens directly to the SSE queue as it runs.
        # ainvoke waits for the full graph to complete.
        await pipeline.ainvoke(state, config)
        logger.info("[chat_controller] Pipeline run complete: thread=%s", thread_id)
    except Exception as exc:
        logger.error("[chat_controller] Pipeline error: %s", exc, exc_info=True)
        await _emit("error", {
            "message": "Pipeline execution failed — check server logs.",
            "code":    "PIPELINE_ERROR",
        })
        await _emit("end", {"reason": "error"})


# ─────────────────────────────────────────────────────────────────────────────
# STUB HELPERS
# ─────────────────────────────────────────────────────────────────────────────

# Team-task routing heuristic imported from app.utils.routing (shared with interface_agent)


def _generate_stub_reply(text: str) -> str:
    """Generate a contextual stub response for dev/test mode."""
    lower = text.lower()

    if any(w in lower for w in ["hello", "hi", "hey"]):
        return "Hello. I'm Aura — your AURA NX-Alpha interface. The backend is running in stub mode. Models will load once Sprint 0 hardware setup is complete."

    if any(w in lower for w in ["status", "ready", "working", "test"]):
        return "Backend is online. SSE stream active. Interface Engine and Workhorse are not yet loaded — running in stub mode. Set AURA_DEV_STUB_RESPONSES=false in .env once models are ready."

    if any(w in lower for w in ["what", "how", "why", "explain", "tell me"]):
        return "I understand your question. In stub mode I can't yet run the Interface Engine to give you a real answer. Once the models are loaded (Sprint 0 complete), I'll respond using Qwen3-VL-8B for conversations like this."

    return f"Received: \"{text[:60]}{'...' if len(text) > 60 else ''}\". Running in stub mode — real responses require the Interface Engine (Sprint 0). The SSE pipeline is fully operational."
