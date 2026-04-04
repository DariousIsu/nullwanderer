"""
AURA NX-Alpha — Boot Sequence

Phased startup orchestrator. Replaces the flat init list in main.py.

PHASES:
    0: Foundation  — config, DBs, memory layers
    1: Hardware    — GPU registry, hardware gate, VRAM ledger
    2: Model Gate  — user reviews/confirms models, then load (USER CHECKPOINT)
    3: Services    — weather, finance, news, voice, scheduler, etc.
    4: Ready       — emit boot_complete, wait for user launch

Phase 2 PAUSES until the user confirms via POST /boot/confirm-models.
Nothing touches the GPU until the user says go.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Callable, Awaitable, Optional

from app.config import AuraSettings

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# STEP TRACKING
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class BootStep:
    name: str
    phase: int
    status: str = "pending"      # pending | running | ok | warn | error
    message: str = ""
    started_at: float = 0.0
    finished_at: float = 0.0


@dataclass
class BootState:
    current_phase: int = -1
    steps: list[BootStep] = field(default_factory=list)
    model_gate_proposal: Optional[dict] = None
    model_gate_confirmed: bool = False
    boot_complete: bool = False
    launched: bool = False      # user clicked Launch

    def to_dict(self) -> dict:
        return {
            "current_phase": self.current_phase,
            "steps": [
                {
                    "name": s.name,
                    "phase": s.phase,
                    "status": s.status,
                    "message": s.message,
                }
                for s in self.steps
            ],
            "model_gate_proposal": self.model_gate_proposal,
            "model_gate_confirmed": self.model_gate_confirmed,
            "boot_complete": self.boot_complete,
            "launched": self.launched,
        }


# ─────────────────────────────────────────────────────────────────────────────
# BOOT SEQUENCE
# ─────────────────────────────────────────────────────────────────────────────

class BootSequence:
    """
    Orchestrates phased startup with SSE progress reporting.

    Usage:
        boot = BootSequence(settings, emit_fn=my_sse_emitter)
        await boot.run()        # blocks until phase 4 done
        # ... app runs ...
        await boot.shutdown()
    """

    def __init__(
        self,
        settings: AuraSettings,
        emit_fn: Optional[Callable[[str, dict], Awaitable[None]]] = None,
    ):
        self.settings = settings
        self._emit_fn = emit_fn
        self.state = BootState()
        self._model_gate_event = asyncio.Event()
        self._background_tasks: list[asyncio.Task] = []

    # ── SSE emit helper ─────────────────────────────────────────────────────

    async def _emit(self, event_type: str, data: dict) -> None:
        if self._emit_fn:
            try:
                await self._emit_fn(event_type, data)
            except Exception:
                pass

    async def _emit_step(self, step: BootStep) -> None:
        await self._emit("boot_step", {
            "name": step.name,
            "phase": step.phase,
            "status": step.status,
            "message": step.message,
        })

    async def _emit_phase(self, phase: int, status: str = "complete") -> None:
        await self._emit("boot_phase", {
            "phase": phase,
            "status": status,
            "state": self.state.to_dict(),
        })

    # ── Step runner ──────────────────────────────────────────────────────────

    async def _run_step(self, name: str, phase: int, fn, *args, **kwargs) -> bool:
        """Run a single boot step with status tracking. Returns True on success."""
        step = BootStep(name=name, phase=phase, status="running", started_at=time.time())
        self.state.steps.append(step)
        await self._emit_step(step)

        try:
            result = fn(*args, **kwargs)
            if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                result = await result
            step.status = "ok"
            step.message = str(result) if result else ""
            step.finished_at = time.time()
            await self._emit_step(step)
            return True
        except Exception as exc:
            step.status = "error"
            step.message = str(exc)
            step.finished_at = time.time()
            logger.warning("[boot] Step '%s' failed: %s", name, exc)
            await self._emit_step(step)
            return False

    async def _run_step_warn(self, name: str, phase: int, fn, *args, **kwargs) -> bool:
        """Like _run_step but downgrades errors to warnings (non-fatal)."""
        step = BootStep(name=name, phase=phase, status="running", started_at=time.time())
        self.state.steps.append(step)
        await self._emit_step(step)

        try:
            result = fn(*args, **kwargs)
            if asyncio.iscoroutine(result) or asyncio.isfuture(result):
                result = await result
            step.status = "ok"
            step.message = str(result) if result else ""
        except Exception as exc:
            step.status = "warn"
            step.message = str(exc)
            logger.warning("[boot] Step '%s' warning: %s", name, exc)

        step.finished_at = time.time()
        await self._emit_step(step)
        return step.status == "ok"

    # ══════════════════════════════════════════════════════════════════════════
    # PHASE 0: FOUNDATION
    # ══════════════════════════════════════════════════════════════════════════

    async def _phase_0(self) -> None:
        self.state.current_phase = 0
        await self._emit_phase(0, "started")

        # Config already loaded (settings passed in)
        step = BootStep(name="Config loaded", phase=0, status="ok",
                        started_at=time.time(), finished_at=time.time())
        self.state.steps.append(step)
        await self._emit_step(step)

        # SQLite conversation DB
        await self._run_step("Conversation DB", 0, self._init_conversation_db)

        # Memory service (L1 sqlite, L2 chroma, L3 falkordb)
        await self._run_step_warn("Memory layers", 0, self._init_memory_service)

        # LightRAG entity extraction + graph-enhanced RAG
        await self._run_step_warn("LightRAG", 0, self._init_lightrag)

        # User profile service (depends on memory_service L1 path)
        await self._run_step_warn("User profile", 0, self._init_user_profile_service)

        # Skill capture service (depends on memory_service L1 path)
        await self._run_step_warn("Skill capture", 0, self._init_skill_capture_service)

        # Task queue DB
        await self._run_step_warn("Task queue", 0, self._init_task_queue)

        # Storage monitor (background)
        await self._run_step_warn("Storage monitor", 0, self._init_storage_monitor)

        # Travel planning service (TREK-inspired)
        await self._run_step_warn("Travel planner", 0, self._init_travel_service)

        # MCP tool registry — dependency install + tool scan (per-package steps emitted inline)
        await self._init_tool_registry()

        await self._emit_phase(0, "complete")

    async def _init_conversation_db(self):
        from app.service.conversation_service import init_conversation_service
        init_conversation_service(self.settings.memory.sqlite_db_path)
        return "sqlite"

    async def _init_memory_service(self):
        from app.service.memory_service import init_memory_service
        svc = init_memory_service(self.settings)
        l1 = "ok"
        l2 = "ok" if svc._l2_available else "disabled"
        l3 = "ok" if svc._l3_available else "disabled"
        # If L3 failed, retry in background (Docker may be starting)
        if not svc._l3_available:
            self._background_tasks.append(
                asyncio.create_task(
                    svc.retry_layer3_connect(max_attempts=5, delay=10.0),
                    name="l3_retry",
                )
            )
        return f"L1={l1} L2={l2} L3={l3}"

    async def _init_lightrag(self):
        from app.service.lightrag_service import LightRAGService
        svc = LightRAGService.get_instance()
        await svc.initialize()
        status = svc.index_status()
        if status["available"]:
            return f"{status['entity_count']} entities, {status['relation_count']} relations"
        return "unavailable"

    async def _init_user_profile_service(self):
        from app.service.memory_service import get_memory_service
        from app.service.user_profile_service import init_user_profile_service
        mem = get_memory_service()
        if mem is None:
            return "skipped (memory_service not ready)"
        init_user_profile_service(mem._l1_path)
        return "ok"

    async def _init_skill_capture_service(self):
        from app.service.memory_service import get_memory_service
        from app.service.skill_capture_service import init_skill_capture_service
        mem = get_memory_service()
        if mem is None:
            return "skipped (memory_service not ready)"
        init_skill_capture_service(mem._l1_path)
        return "ok"

    async def _init_task_queue(self):
        from app.service.task_queue_service import init_task_queue_service
        init_task_queue_service()
        return "ok"

    async def _init_travel_service(self):
        from app.service.travel_service import init_travel_db, init_travel_service
        init_travel_db()
        init_travel_service()
        return "ok"

    async def _init_storage_monitor(self):
        from app.service.storage_monitor import StorageMonitor
        monitor = StorageMonitor(self.settings.storage)
        task = asyncio.create_task(monitor.run(), name="storage_monitor")
        self._background_tasks.append(task)
        return f"interval={self.settings.storage.monitor_interval_s}s"

    async def _init_tool_registry(self) -> None:
        """
        Install any missing optional dependencies (one step per package, visible
        on the load screen), then scan app/tools/ and register all tool handlers.
        Runs each blocking subprocess in a thread so the event loop stays live.
        """
        import importlib.util as _ilu
        import subprocess
        import sys
        from app.tools._mcp_wrapper import _OPTIONAL_PACKAGES, load_all_tools

        # ── Per-package dependency install ──────────────────────────────────
        installed_any = False
        for import_name, pip_spec in _OPTIONAL_PACKAGES.items():
            if _ilu.find_spec(import_name) is not None:
                continue  # already present

            pkg_step = BootStep(
                name=f"Install: {pip_spec.split()[0]}",
                phase=0, status="running", started_at=time.time(),
            )
            self.state.steps.append(pkg_step)
            await self._emit_step(pkg_step)

            try:
                await asyncio.to_thread(
                    subprocess.check_call,
                    [sys.executable, "-m", "pip", "install"] + pip_spec.split() + ["-q"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                pkg_step.status = "ok"
                pkg_step.message = "installed"
                installed_any = True
            except subprocess.CalledProcessError as exc:
                pkg_step.status = "warn"
                pkg_step.message = (
                    exc.stderr.decode(errors="replace").strip()[:120]
                    if exc.stderr else str(exc)
                )
            except Exception as exc:
                pkg_step.status = "warn"
                pkg_step.message = str(exc)[:120]

            pkg_step.finished_at = time.time()
            await self._emit_step(pkg_step)

        # ── anyio integrity guard (only if something was freshly installed) ─
        if installed_any:
            anyio_step = BootStep(
                name="Reinstall: anyio (integrity guard)",
                phase=0, status="running", started_at=time.time(),
            )
            self.state.steps.append(anyio_step)
            await self._emit_step(anyio_step)
            try:
                await asyncio.to_thread(
                    subprocess.check_call,
                    [sys.executable, "-m", "pip", "install",
                     "--force-reinstall", "anyio", "-q"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                )
                anyio_step.status = "ok"
                anyio_step.message = "ok"
            except Exception as exc:
                anyio_step.status = "warn"
                anyio_step.message = str(exc)[:120]
            anyio_step.finished_at = time.time()
            await self._emit_step(anyio_step)

        # ── Tool scan ────────────────────────────────────────────────────────
        scan_step = BootStep(
            name="Tool registry scan", phase=0, status="running", started_at=time.time(),
        )
        self.state.steps.append(scan_step)
        await self._emit_step(scan_step)
        try:
            count = await asyncio.to_thread(load_all_tools)
            scan_step.status = "ok"
            scan_step.message = f"{count} tools registered"
        except Exception as exc:
            scan_step.status = "warn"
            scan_step.message = str(exc)
            logger.warning("[boot] Tool registry scan failed: %s", exc)
        scan_step.finished_at = time.time()
        await self._emit_step(scan_step)

    # ══════════════════════════════════════════════════════════════════════════
    # PHASE 1: HARDWARE
    # ══════════════════════════════════════════════════════════════════════════

    async def _phase_1(self) -> None:
        self.state.current_phase = 1
        await self._emit_phase(1, "started")

        # GPU Registry
        await self._run_step("GPU detection", 1, self._init_gpu_registry)

        # Hardware Gate
        await self._run_step("Hardware gate", 1, self._init_hardware_gate)

        await self._emit_phase(1, "complete")

    async def _init_gpu_registry(self):
        from app.service.gpu_registry import init_gpu_registry
        gpus = await init_gpu_registry()
        if not gpus:
            return "no GPUs detected"
        names = [f"{g.name} ({g.vendor}, {g.vram_total_mb:.0f} MB)" for g in gpus]
        return "; ".join(names)

    async def _init_hardware_gate(self):
        from app.service.hardware_gate import init_hardware_gate
        mode = await init_hardware_gate()
        return f"mode={mode}"

    # ══════════════════════════════════════════════════════════════════════════
    # PHASE 2: MODEL GATE (USER CHECKPOINT)
    # ══════════════════════════════════════════════════════════════════════════

    async def _phase_2(self) -> None:
        self.state.current_phase = 2
        await self._emit_phase(2, "started")

        # Build proposal
        await self._run_step("Building model proposal", 2, self._build_model_proposal)

        # Emit the model_gate event and WAIT for user confirmation
        await self._emit("model_gate", self.state.model_gate_proposal)

        logger.info("[boot] Phase 2: waiting for user model confirmation...")
        await self._model_gate_event.wait()
        logger.info("[boot] Phase 2: user confirmed models")

        # Ghost cleanup
        await self._run_step_warn("Clear ghost sessions", 2, self._clear_ghost_sessions)

        # Init Ollama service (config only, no model load)
        await self._run_step("Ollama service", 2, self._init_ollama_service)

        # Ensure Ollama process is running (launch if not)
        await self._run_step_warn("Launch Ollama", 2, self._ensure_ollama_running)

        # Load Interface Engine
        await self._run_step("Load Interface Engine", 2, self._load_interface_engine)

        # Verify Interface Engine
        await self._run_step_warn("Verify Interface Engine", 2, self._verify_interface_engine)

        # Verify Workhorse availability
        from app.service.hardware_gate import get_hardware_mode
        workhorse_ok = False
        if get_hardware_mode() == "full":
            await self._run_step_warn("Verify Workhorse", 2, self._verify_workhorse)
            # Check the step result for "available"
            wh_step = next((s for s in reversed(self.state.steps) if s.name == "Verify Workhorse"), None)
            workhorse_ok = wh_step and wh_step.status == "ok" and "available" in (wh_step.message or "").lower()

        # Auto-enable team gate when workhorse (Ollama) is verified
        if workhorse_ok:
            try:
                from app.controller.chat_controller import _runtime_state, _persist_settings_json
                _runtime_state["team_enabled"] = True
                _persist_settings_json({"team_enabled": True})
                logger.info("[boot] Team gate auto-enabled — workhorse verified")
            except Exception as exc:
                logger.warning("[boot] Could not auto-enable team gate: %s", exc)

        await self._emit_phase(2, "complete")

    async def _build_model_proposal(self):
        from app.service.hardware_gate import get_hardware_mode, get_vram_mb
        from app.service.gpu_registry import get_all_gpus, get_best_gpu

        gpus = get_all_gpus()
        best = get_best_gpu()
        mode = get_hardware_mode()
        vram = get_vram_mb()

        # Get LLMFit suggestions
        try:
            from app.service.llmfit_service import get_fit_suggestions
            suggestions = get_fit_suggestions(vram)
        except Exception:
            suggestions = {}

        self.state.model_gate_proposal = {
            "gpus": [g.to_dict() for g in gpus],
            "best_gpu": best.to_dict() if best else None,
            "mode": mode,
            "vram_total_mb": vram,
            "proposed": {
                "interface": {
                    "name": self.settings.interface_model_name,
                    "ollama_host": self.settings.interface_model.ollama_host,
                },
                "workhorse": {
                    "name": self.settings.workhorse_model_name,
                    "ollama_host": self.settings.workhorse.ollama_host,
                },
            },
            "suggestions": suggestions,
        }
        return f"mode={mode} vram={vram}MB"

    async def _clear_ghost_sessions(self):
        """Unload any models currently held in Ollama to free VRAM."""
        try:
            from app.service.ollama_service import get_ollama_service
            svc = get_ollama_service()
            if svc:
                await svc.unload_model()
                return "ollama models unloaded"
        except Exception:
            pass
        return "no ollama to clear"

    async def _init_ollama_service(self):
        from app.service.ollama_service import init_ollama_service
        init_ollama_service(
            self.settings.workhorse.model,
            self.settings.workhorse.ollama_host,
            num_gpu=self.settings.workhorse.num_gpu,
            num_ctx=self.settings.workhorse.context_size,
            keep_alive=self.settings.workhorse.keep_alive,
        )
        return f"{self.settings.workhorse.model} (num_gpu={self.settings.workhorse.num_gpu}, num_ctx={self.settings.workhorse.context_size}, keep_alive={self.settings.workhorse.keep_alive})"

    async def _ensure_ollama_running(self):
        """Check if Ollama is reachable; launch it if not."""
        import httpx
        host = self.settings.workhorse.ollama_host

        # Quick ping — already running?
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                resp = await client.get(f"{host}/api/tags")
                if resp.status_code == 200:
                    return "Ollama already running"
        except Exception:
            pass

        # Not running — launch it
        from app.service.process_manager import _launch_ollama
        launched = await asyncio.to_thread(_launch_ollama)
        if not launched:
            return "Ollama not installed — skipping"

        # Wait for it to become reachable (up to 15s)
        for _ in range(15):
            await asyncio.sleep(1)
            try:
                async with httpx.AsyncClient(timeout=3) as client:
                    resp = await client.get(f"{host}/api/tags")
                    if resp.status_code == 200:
                        return "Ollama launched and ready"
            except Exception:
                continue

        return "Ollama launched but not yet reachable"

    async def _load_interface_engine(self):
        if self.settings.dev_stub_responses:
            return "stub mode — skipped"

        from app.service.interface_engine import InterfaceEngine, register_engine
        engine = InterfaceEngine(self.settings.interface_model)
        # load() calls ollama.pull (synchronous) — run in executor
        await asyncio.get_running_loop().run_in_executor(None, engine.load)
        register_engine(engine)
        return self.settings.interface_model_name

    async def _verify_interface_engine(self):
        if self.settings.dev_stub_responses:
            return "stub mode — skipped"

        from app.service.interface_engine import get_engine
        engine = get_engine()
        if engine is None:
            raise RuntimeError("Interface engine not registered")
        if not engine._loaded:
            raise RuntimeError(
                f"Interface engine not loaded — ensure Ollama is running and "
                f"{self.settings.interface_model.model} is pulled"
            )

        # Quick inference test — use enough tokens for thinking models (Qwen3, etc.)
        # to finish their <think> block and emit a visible response.
        try:
            result = await engine.generate(
                [{"role": "user", "content": "Say ok."}],
                max_tokens=200,
            )
            import re as _re
            text = result.get("text", "")
            # Strip <think>...</think> blocks — thinking models emit these before responding
            clean = _re.sub(r"<think>.*?</think>", "", text, flags=_re.DOTALL).strip()
            if clean:
                return f"verified — responded with {len(clean)} chars"
            raise RuntimeError("Empty response from interface engine")
        except Exception as exc:
            raise RuntimeError(f"Interface engine verification failed: {exc}")

    async def _verify_workhorse(self):
        import httpx
        host = self.settings.workhorse.ollama_host
        model = self.settings.workhorse.model

        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{host}/api/tags")
                if resp.status_code == 200:
                    tags = resp.json()
                    model_names = [m.get("name", "") for m in tags.get("models", [])]
                    # Check if model is pulled (exact or prefix match)
                    found = any(model in name or name.startswith(model.split(":")[0])
                                for name in model_names)
                    if found:
                        return f"{model} available in Ollama"
                    return f"{model} not pulled — will pull on first use"
                return f"Ollama responded {resp.status_code}"
        except Exception as exc:
            return f"Ollama not reachable: {exc}"

    # ══════════════════════════════════════════════════════════════════════════
    # PHASE 3: SERVICES
    # ══════════════════════════════════════════════════════════════════════════

    async def _phase_3(self) -> None:
        self.state.current_phase = 3
        await self._emit_phase(3, "started")

        # LangGraph pipeline
        await self._run_step_warn("LangGraph pipeline", 3, self._init_pipeline)

        # Data services (can run concurrently — none touch GPU)
        data_inits = [
            ("Weather service", self._init_weather),
            ("Finance service", self._init_finance),
            ("News service", self._init_news),
            ("Intelligence service", self._init_intelligence),
            ("Caption service", self._init_caption),
            ("Google service", self._init_google),
        ]
        for name, fn in data_inits:
            await self._run_step_warn(name, 3, fn)

        # Knowledge services
        await self._run_step_warn("Knowledge downloader", 3, self._init_knowledge_downloader)
        await self._run_step_warn("Knowledge curator", 3, self._init_curator)
        await self._run_step_warn("ZIM collector", 3, self._init_zim)
        await self._run_step_warn("Self-improvement", 3, self._init_self_improvement)

        # Voice
        await self._run_step_warn("Voice controller", 3, self._init_voice)

        # Process manager (Docker, FalkorDB — NOT Ollama)
        await self._run_step_warn("Process manager", 3, self._init_process_manager)

        # Browser tool
        await self._run_step_warn("Browser tool", 3, self._init_browser_tool)

        # System monitor (safe now — models are loaded)
        await self._run_step_warn("System monitor", 3, self._init_system_monitor)

        # Screen awareness — active window title → proactive file surfacing
        await self._run_step_warn("Screen awareness", 3, self._init_screen_awareness)

        # Idle triage — passive intelligence processing during user idle
        await self._run_step_warn("Idle triage", 3, self._init_idle_triage)

        # File monitor — polling-based file change detection
        await self._run_step_warn("File monitor", 3, self._init_file_monitor)

        # Scheduler
        await self._run_step_warn("Scheduler", 3, self._init_scheduler)

        # Briefing service (depends on scheduler for cron registration)
        await self._run_step_warn("Briefing service", 3, self._init_briefing)

        # Email dispatch
        await self._run_step_warn("Email service", 3, self._init_email)

        # Satellite agent
        await self._run_step_warn("Satellite agent", 3, self._init_satellite)

        # Legislation service + background import (non-fatal)
        await self._run_step_warn("Legislation service", 3, self._init_legislation_service)

        # Custom agent dynamic registry
        await self._run_step_warn("Dynamic agent registry", 3, self._init_dynamic_registry)

        # Warm up the Qdrant embedding model so first chat message isn't slow
        await self._run_step_warn("Vector encoder warm-up", 3, self._warm_vector_encoder)

        # Start LightRAG background workers (deferred from Phase 0 to avoid
        # Ollama contention during model verification in Phase 2).
        await self._run_step_warn("LightRAG workers", 3, self._start_lightrag_workers)
        await self._run_step_warn("Data collector", 3, self._start_data_collector)

        await self._emit_phase(3, "complete")

    # ── Phase 3 init helpers ──

    async def _start_lightrag_workers(self):
        from app.service.lightrag_service import LightRAGService
        svc = LightRAGService.get_instance()
        if not svc._available:
            return "skipped — LightRAG not initialized"
        await svc.start_workers()
        backend = "llama-cpp" if svc._worker_available else "ollama-fallback"
        return f"started ({backend})"

    async def _start_data_collector(self):
        from app.service.data_collector_service import init_data_collector
        svc = init_data_collector()
        return await svc.start()

    async def _init_pipeline(self):
        from app.graph.pipeline import init_pipeline
        from app.graph.team_pipeline import init_team_pipeline
        await init_pipeline()
        await init_team_pipeline()
        return "compiled"

    async def _init_weather(self):
        from app.service.weather_service import init_weather_service
        init_weather_service()

    async def _init_finance(self):
        from app.service.finance_service import init_finance_service
        init_finance_service()

    async def _init_news(self):
        from app.service.news_service import init_news_service
        init_news_service()

    async def _init_intelligence(self):
        from app.service.intelligence_service import init_intelligence_service, start_background_collection
        init_intelligence_service()
        task = start_background_collection(interval_seconds=1800)  # every 30 min
        self._background_tasks.append(task)

    async def _init_caption(self):
        from app.service.caption_service import init_caption_service
        init_caption_service()

    async def _init_google(self):
        from app.service.google_service import init_google_service
        init_google_service()

    async def _init_knowledge_downloader(self):
        from app.service.knowledge_downloader import init_knowledge_downloader
        init_knowledge_downloader(self.settings)

    async def _init_curator(self):
        from app.service.curator_service import init_curator_service
        init_curator_service()

    async def _init_zim(self):
        from app.service.zim_collector import startup_sweep, get_collection_folder
        inbox = get_collection_folder()
        task = asyncio.create_task(startup_sweep(), name="zim_startup_sweep")
        self._background_tasks.append(task)
        return str(inbox)

    async def _init_self_improvement(self):
        from app.service.self_improvement_service import init_self_improvement_service
        init_self_improvement_service()

    async def _init_voice(self):
        from app.controller.voice_controller import init_voice_controller
        loop = asyncio.get_running_loop()
        init_voice_controller(loop)

        # Voice auto-setup (background)
        try:
            from app.service.voice_service import auto_setup_voice
            task = asyncio.create_task(
                auto_setup_voice(emit_fn=self._emit),
                name="voice_auto_setup",
            )
            self._background_tasks.append(task)
        except Exception:
            pass

    async def _init_process_manager(self):
        from app.service.process_manager import init_process_manager
        task = asyncio.create_task(
            init_process_manager(self.settings),
            name="process_manager",
        )
        self._background_tasks.append(task)

    async def _init_browser_tool(self):
        from app.tools.browser import init_browser_tool
        init_browser_tool()

    async def _init_system_monitor(self):
        from app.service.system_monitor_service import init_system_monitor
        svc = init_system_monitor()
        svc.start_polling(interval_s=5)

    async def _init_screen_awareness(self):
        from app.service.screen_awareness_service import init_screen_awareness
        svc = init_screen_awareness()
        task = svc.start()
        self._background_tasks.append(task)

    async def _init_idle_triage(self):
        from app.service.idle_triage_service import init_idle_triage
        svc = init_idle_triage()
        tasks = svc.start()
        self._background_tasks.extend(tasks)

    async def _init_briefing(self):
        from app.service.briefing_service import init_briefing_service
        init_briefing_service()
        # Register default briefing schedules (idempotent)
        try:
            from app.service.scheduler_service import get_scheduler_service
            from app.config import get_settings
            sched = get_scheduler_service()
            cfg = get_settings().idle_processing
            if sched and cfg.enabled:
                existing = sched.get_all_tasks()
                existing_types = {t.get("task_type") for t in existing}
                if "morning_briefing" not in existing_types:
                    sched.create_task({
                        "name": "Morning Briefing",
                        "task_type": "morning_briefing",
                        "schedule": cfg.morning_briefing_cron,
                        "parameters": {},
                        "source": "internal",
                    })
                    logger.info("[boot] Registered default morning briefing schedule")
                if "daily_recap" not in existing_types:
                    sched.create_task({
                        "name": "Daily Recap",
                        "task_type": "daily_recap",
                        "schedule": cfg.daily_recap_cron,
                        "parameters": {},
                        "source": "internal",
                    })
                    logger.info("[boot] Registered default daily recap schedule")
        except Exception as exc:
            logger.warning("[boot] Briefing schedule registration failed: %s", exc)

    async def _init_file_monitor(self):
        from app.service.file_monitor_service import init_file_monitor
        svc = init_file_monitor()
        task = svc.start()
        self._background_tasks.append(task)

    async def _init_scheduler(self):
        from app.service.scheduler_service import init_scheduler_service
        svc = init_scheduler_service()
        await svc.start(emit_fn=self._emit)

    async def _init_email(self):
        from app.service.email_dispatch import init_email_service
        svc = init_email_service()
        return f"available={svc.available}"

    async def _init_satellite(self):
        from app.agents.satellite_agent import init_satellite_agent, start_satellite_agent
        init_satellite_agent(interval_seconds=300)
        task = await start_satellite_agent()
        self._background_tasks.append(task)

    async def _init_legislation_service(self):
        from app.service.legislation_service import LegislationService
        import app.service.legislation_service as _leg_mod
        leg_svc = LegislationService()
        _leg_mod._legislation_service = leg_svc

        status = leg_svc.get_import_status()
        if not status.get("complete"):
            from app.service.leg_db_importer import run_import
            from app.controller.boot_controller import boot_emit
            task = asyncio.create_task(run_import(emit_fn=boot_emit), name="legislation_import")
            self._background_tasks.append(task)
            logger.info("[boot] Legislation import started in background")
            return "import started"
        else:
            count = status.get("total_bills", 0)
            logger.info("[boot] Legislation DB already imported (%d bills)", count)
            return f"already imported ({count} bills)"

    async def _init_dynamic_registry(self):
        from app.agents.dynamic_registry import load_from_disk
        load_from_disk()
        logger.info("[boot] Custom agent registry loaded")
        return "ok"

    async def _warm_vector_encoder(self):
        """Pre-load the all-MiniLM-L6-v2 encoder so the first chat request isn't slow."""
        try:
            from app.service.qdrant_service import get_qdrant_service
            svc = get_qdrant_service()
            if svc is not None:
                svc._get_model()  # loads SentenceTransformer into memory
                logger.info("[boot] Vector encoder warm-up complete")
                return "ok"
            return "skipped (qdrant_service not ready)"
        except Exception as exc:
            logger.warning("[boot] Vector encoder warm-up failed: %s", exc)
            return f"warn: {exc}"

    # ══════════════════════════════════════════════════════════════════════════
    # PHASE 4: READY
    # ══════════════════════════════════════════════════════════════════════════

    async def _phase_4(self) -> None:
        self.state.current_phase = 4
        self.state.boot_complete = True

        # Memory maintenance loop
        async def _memory_maintenance():
            while True:
                await asyncio.sleep(600)
                try:
                    from app.service.memory_service import get_memory_service
                    svc = get_memory_service()
                    if svc:
                        await svc.run_idle_maintenance()
                except Exception:
                    pass

        self._background_tasks.append(
            asyncio.create_task(_memory_maintenance(), name="memory_maintenance")
        )

        await self._emit("boot_complete", self.state.to_dict())
        logger.info("[boot] All phases complete — waiting for user launch")

    # ══════════════════════════════════════════════════════════════════════════
    # PUBLIC API
    # ══════════════════════════════════════════════════════════════════════════

    def confirm_models(self, interface_override: Optional[str] = None,
                       workhorse_override: Optional[str] = None) -> None:
        """Called by boot_controller when user confirms model selection."""
        # TODO: apply overrides to settings if user changed models
        self.state.model_gate_confirmed = True
        self._model_gate_event.set()

    def confirm_launch(self) -> None:
        """Called when user clicks LAUNCH AURA."""
        self.state.launched = True

    async def run(self) -> None:
        """Execute all boot phases. Blocks until phase 4."""
        logger.info("[boot] ═══════════════════════════════════════════════")
        logger.info("[boot] AURA NX-Alpha boot sequence starting")
        logger.info("[boot] ═══════════════════════════════════════════════")

        await self._phase_0()
        await self._phase_1()
        await self._phase_2()   # pauses for user confirmation
        await self._phase_3()
        await self._phase_4()

        logger.info("[boot] Boot sequence complete")

    async def shutdown(self) -> None:
        """Clean shutdown of all background tasks."""
        logger.info("[boot] Shutting down...")

        # Scheduler
        try:
            from app.service.scheduler_service import get_scheduler_service
            sched = get_scheduler_service()
            if sched:
                await sched.shutdown()
        except Exception:
            pass

        # Satellite
        try:
            from app.agents.satellite_agent import stop_satellite_agent
            stop_satellite_agent()
        except Exception:
            pass

        # Browser
        try:
            from app.tools.browser import get_browser_tool
            bt = get_browser_tool()
            if bt:
                await bt.close()
        except Exception:
            pass

        # Voice
        try:
            from app.service.voice_service import cleanup_voice_resources
            cleanup_voice_resources()
        except Exception:
            pass

        # Background tasks
        for task in self._background_tasks:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

        # Interface Engine — unload from VRAM via Ollama
        try:
            from app.service.interface_engine import get_engine
            engine = get_engine()
            if engine:
                await engine.shutdown()
        except Exception:
            pass

        # Ollama — unload workhorse model from VRAM
        try:
            from app.service.ollama_service import get_ollama_service
            ollama = get_ollama_service()
            if ollama:
                await ollama.unload_model()
        except Exception:
            pass

        logger.info("[boot] Shutdown complete")
