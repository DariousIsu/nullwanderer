"""
AURA NX-Alpha — Backend Entry Point
FastAPI application. Runs via uvicorn.

START:
    cd backend
    uvicorn main:app --host 127.0.0.1 --port 8000 --reload

OR via the Electron main process (Sprint 2+):
    IPC spawns this as a subprocess on app launch.

ENDPOINTS:
    GET  /stream              — SSE stream (EventSource connects here)
    POST /message             — User message → pipeline → SSE events
    PUT  /settings/team-gate  — Enable/disable Team Functions (§1.6)
    GET  /status              — Health check + runtime state
    GET  /storage             — Storage component usage (§4.5)
    PUT  /storage/quota       — Update storage quota per component

LIFESPAN TASKS:
    Storage Monitor  — polls disk usage every 60s, emits storage_update SSE events
"""

import asyncio
import logging
import os
import warnings
from contextlib import asynccontextmanager

# Suppress feedparser deprecation warnings from Python 3.13 re.sub positional arg change
warnings.filterwarnings("ignore", message="'count' is passed as positional argument", category=DeprecationWarning)
# Suppress torch FutureWarning about encoder_attention_mask
warnings.filterwarnings("ignore", message=".*encoder_attention_mask.*", category=FutureWarning)
# Suppress pandas Timestamp.utcnow deprecation
warnings.filterwarnings("ignore", message=".*Timestamp.utcnow.*")

# ── GPU Environment — set before any subprocess or ROCm library loads ─────────
# Route ROCm/HIP to discrete GPU (index 1), skip integrated GPU (index 0).
# Must be in os.environ so subprocesses (Ollama, etc.) inherit it.
os.environ.setdefault("HIP_VISIBLE_DEVICES", "1")
os.environ.setdefault("ROCR_VISIBLE_DEVICES", "1")
os.environ.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.controller.chat_controller import router as chat_router
from app.controller.data_controller import router as data_router, system_router
from app.controller.voice_controller import router as voice_router
from app.controller.queue_controller import router as queue_router
from app.controller.system_controller import router as system_ctrl_router
from app.controller.satellite_controller import router as satellite_router
from app.controller.boot_controller import router as boot_router
from app.controller.adversarial_trainer_controller import router as adversarial_trainer_router
from app.controller.canvas_controller import router as canvas_router
from app.controller.legislation_controller import router as legislation_router
from app.controller.agent_creator_controller import router as agent_creator_router
from app.controller.media_controller import router as media_router
from app.controller.geo_controller import router as geo_router
from app.controller.profile_controller import router as profile_router
from app.controller.skill_controller import router as skill_router
from app.controller.phoenix_controller import router as phoenix_router
from app.controller.watch_controller import router as watch_router
from app.controller.eval_controller import router as eval_router
from app.controller.mcp_tool_controller import router as mcp_tool_router, settings_router as mcp_settings_router
from app.controller.dev_controller import router as dev_router
from app.controller.neural_controller import router as neural_router
from app.controller.travel_controller import router as travel_router
from app.controller.newsletter_controller import router as newsletter_router
from app.controller.truthsocial_controller import router as truthsocial_router
from app.controller.game_controller import router as game_router
from app.controller.computer_use_controller import router as computer_use_router

# ─────────────────────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────────────────────

settings = get_settings()

logging.basicConfig(
    level=getattr(logging, settings.log_level.upper(), logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# LIFESPAN — startup / shutdown tasks
# ─────────────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Startup: run supervised boot sequence (phased, with user checkpoint).
    Shutdown: clean up all services.
    """
    from app.service.boot_sequence import BootSequence
    from app.controller.boot_controller import set_boot_sequence, boot_emit

    logger.info("=" * 60)
    logger.info("AURA NX-Alpha backend starting")
    logger.info("  Hardware phase : %d", settings.hardware_phase)
    logger.info("  Interface model: %s", settings.interface_model_name)
    logger.info("  Workhorse model: %s", settings.workhorse_model_name)
    logger.info("  Stub responses : %s", settings.dev_stub_responses)
    logger.info("  Team gate      : %s (default)", "disabled" if not settings.team_gate.default_enabled else "enabled")
    logger.info("=" * 60)

    boot = BootSequence(settings, emit_fn=boot_emit)
    set_boot_sequence(boot)

    # ── Launch boot sequence as a background task ──────────────────────────────
    # Must NOT await boot.run() here — the lifespan must yield so uvicorn
    # starts accepting HTTP connections. Phase 2 (model gate) needs the
    # frontend to POST /boot/confirm-models, which requires the server to be up.
    async def _boot_then_greet():
        await boot.run()

        # ── Boot-complete greeting — canvas block ──
        try:
            from app.controller.chat_controller import _emit
            from app.service.hardware_gate import get_hardware_mode
            from app.service.gpu_registry import get_best_gpu

            hw_mode = get_hardware_mode()
            best_gpu = get_best_gpu()
            gpu_name = best_gpu.name if best_gpu else "unknown GPU"
            mode_label = "Full Team Mode" if hw_mode == "full" else "Interface-Only Mode"
            stub_note = " | Stub responses active" if settings.dev_stub_responses else ""

            await _emit("render_canvas", {
                "title": "AURA Online",
                "blocks": [{
                    "type": "paragraph",
                    "data": {
                        "text": (
                            f"Systems online — {mode_label} on {gpu_name}{stub_note}.\n"
                            f"Ready when you are."
                        ),
                    },
                }],
            })
        except Exception as exc:
            logger.warning("[lifespan] Boot greeting failed: %s", exc)

        # ── Emit model_status SSE ──
        try:
            from app.controller.chat_controller import _emit, models_status
            status = await models_status()
            await _emit("model_status", status)
        except Exception:
            pass

    boot_task = asyncio.create_task(_boot_then_greet())

    # ── Background Mapper — scans for unmapped records, creates ingestion jobs ─
    try:
        from app.service.background_mapper_service import BackgroundMapperService
        mapper = BackgroundMapperService.get_instance()
        asyncio.create_task(mapper.start(boot_emit))
    except Exception as e:
        logger.warning("[main] Background mapper start failed (non-fatal): %s", e)

    # ── MCP Client — lightweight, independent of model boot ──────────────────
    from app.service.mcp_client_service import init_mcp_client, get_mcp_client
    try:
        await init_mcp_client()
    except Exception as e:
        logger.warning("[main] MCP client init failed (non-fatal): %s", e)

    # LightRAG now initializes via boot_sequence._init_lightrag() (Phase 0)

    # ── Dynamic agent registry — load published custom agents from disk ───────
    try:
        from app.agents.dynamic_registry import load_from_disk
        load_from_disk()
    except Exception as e:
        logger.warning("[main] Dynamic registry load failed (non-fatal): %s", e)

    # ── MCP Tool published routes — re-register all published tool invoke endpoints ──
    try:
        from app.service.mcp_generator import reregister_published_routes
        reregister_published_routes(app)
    except Exception as e:
        logger.warning("[main] MCP tool route re-registration failed (non-fatal): %s", e)

    # MCP Tool Registry is now loaded in Phase 0 of the boot sequence so that
    # dependency install progress appears on the load screen via SSE.

    # ── Tool Auto-Updater — re-optimize published tools as golden sets grow ───
    try:
        from app.service.tool_auto_updater import start_auto_updater
        start_auto_updater()
    except Exception as e:
        logger.warning("[main] Tool auto-updater start failed (non-fatal): %s", e)

    # ── Dev session service — project registry + dev mode state ──────────────
    try:
        from app.service.dev_session_service import init_dev_db
        init_dev_db()
    except Exception as e:
        logger.warning("[main] Dev session DB init failed (non-fatal): %s", e)

    # ── Todo service — persistent task tracking ───────────────────────────────
    try:
        from app.service.todo_service import init_todo_service
        init_todo_service()
    except Exception as e:
        logger.warning("[main] Todo service init failed (non-fatal): %s", e)

    # ── Watch daemon — live stream transcription ──────────────────────────────
    try:
        from app.service.watch_service import get_watch_daemon
        get_watch_daemon().start()
    except Exception as e:
        logger.warning("[main] Watch daemon init failed (non-fatal): %s", e)

    # ── Newsletter poller — background RSS/Atom feed polling ───────────────
    try:
        from app.service.newsletter_service import get_newsletter_service
        _newsletter_svc = get_newsletter_service()
        await _newsletter_svc.start_polling(interval_seconds=300)
    except Exception as e:
        logger.warning("[main] Newsletter poller start failed (non-fatal): %s", e)

    # ── Truth Social poller — monitor @realDonaldTrump ─────────────────────
    try:
        from app.service.truthsocial_service import get_truthsocial_service
        _ts_cfg = get_settings().truthsocial
        if _ts_cfg.username and _ts_cfg.password:
            _ts_svc = get_truthsocial_service()
            await _ts_svc.start_polling(interval_seconds=_ts_cfg.poll_interval)
            logger.info("[main] Truth Social polling started (interval=%ds)", _ts_cfg.poll_interval)
        else:
            logger.info("[main] Truth Social polling skipped — credentials not configured in .env")
    except Exception as e:
        logger.warning("[main] Truth Social poller start failed (non-fatal): %s", e)

    # ── Game Session Service — warm singleton (sessions start on demand) ───
    try:
        from app.service.game_session_service import GameSessionService
        GameSessionService.get_instance()
    except Exception as e:
        logger.warning("[main] Game session service init failed (non-fatal): %s", e)

    yield  # ── Application runs here (server is accepting connections) ──────

    # ── Shutdown ──────────────────────────────────────────────────────────────
    try:
        from app.service.newsletter_service import get_newsletter_service
        await get_newsletter_service().stop_polling()
    except Exception:
        pass

    try:
        from app.service.truthsocial_service import get_truthsocial_service
        await get_truthsocial_service().stop_polling()
    except Exception:
        pass

    try:
        from app.service.tool_auto_updater import stop_auto_updater
        stop_auto_updater()
    except Exception:
        pass

    try:
        from app.service.watch_service import get_watch_daemon
        await get_watch_daemon().stop()
    except Exception as e:
        logger.warning("[main] Watch daemon shutdown failed (non-fatal): %s", e)

    mcp = get_mcp_client()
    if mcp:
        await mcp.shutdown()

    try:
        from app.service.lightrag_service import LightRAGService
        await LightRAGService.get_instance().shutdown()
    except Exception:
        pass

    boot_task.cancel()
    try:
        await boot_task
    except asyncio.CancelledError:
        pass
    await boot.shutdown()


# ─────────────────────────────────────────────────────────────────────────────
# APP
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(
    title="AURA NX-Alpha",
    version="0.1.0-alpha",
    description="AURA NX-Alpha backend — LangGraph + FastAPI + SSE",
    lifespan=lifespan,
    docs_url="/docs" if settings.dev_stub_responses else None,
    redoc_url=None,
)

# ── CORS ──────────────────────────────────────────────────────────────────────
# Allows the Vite dev server (localhost:5173) and Electron renderer to connect.
# In production Electron builds CORS is not needed, but dev mode uses the browser.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",    # Vite dev server
        "http://localhost:4173",    # Vite preview
        "http://127.0.0.1:5173",
        "app://.",                  # Electron production origin
        "null",                     # Electron dev origin (file://)
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)

# ── ROUTES ────────────────────────────────────────────────────────────────────
app.include_router(chat_router)
app.include_router(data_router)
app.include_router(system_router)
app.include_router(voice_router)
app.include_router(queue_router)
app.include_router(system_ctrl_router)
app.include_router(satellite_router)
app.include_router(boot_router)
app.include_router(adversarial_trainer_router)
app.include_router(canvas_router)
app.include_router(legislation_router)
app.include_router(agent_creator_router)
app.include_router(agent_creator_router, prefix="/agents")   # alias: POST /agents, POST /agents/{id}/run
app.include_router(media_router)
app.include_router(geo_router)
app.include_router(profile_router)
app.include_router(skill_router)
app.include_router(phoenix_router)
app.include_router(watch_router)
app.include_router(eval_router)
app.include_router(mcp_tool_router)
app.include_router(mcp_settings_router)
app.include_router(dev_router)
app.include_router(neural_router)
app.include_router(travel_router)
app.include_router(newsletter_router)
app.include_router(truthsocial_router)
app.include_router(game_router)
app.include_router(computer_use_router)


@app.post("/shutdown")
async def shutdown_endpoint():
    """Signal the backend to shut down gracefully (called by Electron on app close)."""
    import os
    import signal
    os.kill(os.getpid(), signal.SIGINT)
    return {"status": "shutting_down"}


# ─────────────────────────────────────────────────────────────────────────────
# DIRECT LAUNCH
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.dev_stub_responses,   # Auto-reload in stub/dev mode
        log_level=settings.log_level.lower(),
        timeout_keep_alive=75,
    )
