"""
AURA NX-Alpha — Process Manager
Auto-launches and monitors external services required by AURA.
All launches are background, windowless, and non-blocking.

MANAGED SERVICES:
    ollama    — LLM inference server (workhorse model)
    docker    — Docker Desktop (required by FalkorDB)
    falkordb  — L3 graph memory (Docker container, port 6380)
    blender   — 3D/render tasks (on-demand only, not auto-launched)

LAUNCH POLICY:
    - Check if service is already running first — never double-launch
    - Only launch services AURA started; shut down only those on exit
    - Dependency order enforced: Docker must be ready before FalkorDB
    - Windows: CREATE_NO_WINDOW flag — nothing flashes on screen

SSE EVENTS EMITTED:
    service_status   — { id, name, status, details }
      status values: 'running' | 'starting' | 'stopped' | 'error' | 'not_installed'
"""

from __future__ import annotations

import asyncio
import logging
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Dict, Optional

import httpx

logger = logging.getLogger(__name__)

# ── State ─────────────────────────────────────────────────────────────────────
_service_status: Dict[str, dict] = {}
_launched_by_us: set[str] = set()   # only stop services AURA started
_monitor_task: Optional[asyncio.Task] = None

# ── Windows subprocess flag ────────────────────────────────────────────────────
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

# ── Docker Desktop path candidates (Windows) ──────────────────────────────────
_DOCKER_PATHS = [
    r"C:\Program Files\Docker\Docker\Docker Desktop.exe",
    r"C:\Program Files (x86)\Docker\Docker\Docker Desktop.exe",
]

# ── Blender path candidates ────────────────────────────────────────────────────
_BLENDER_PATHS = [
    r"C:\Program Files\Blender Foundation\Blender 4.2\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender 4.1\blender.exe",
    r"C:\Program Files\Blender Foundation\Blender\blender.exe",
    "blender",   # if on PATH
]


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE REGISTRY
# Each entry defines how to detect, launch, and describe a service.
# ─────────────────────────────────────────────────────────────────────────────

def _build_registry(settings) -> dict:
    """Build the service registry from current settings."""
    falkordb_port = getattr(getattr(settings, "memory", None), "falkordb_port", 6380)
    ollama_host   = getattr(getattr(settings, "workhorse", None), "ollama_host", "http://127.0.0.1:11434")

    return {
        "ollama": {
            "name":        "Ollama",
            "description": "LLM inference server — workhorse model host",
            "auto_launch": True,
            "depends_on":  [],
            "check":       lambda: _ping_http(f"{ollama_host}/api/tags", timeout=3),
            "launch":      _launch_ollama,
            "ready_check": lambda: _ping_http(f"{ollama_host}/api/tags", timeout=5),
            "ready_timeout": 30,
        },
        "docker": {
            "name":        "Docker",
            "description": "Container runtime — required for FalkorDB (L3 memory)",
            "auto_launch": True,
            "depends_on":  [],
            "check":       _check_docker,
            "launch":      _launch_docker,
            "ready_check": _check_docker,
            "ready_timeout": 60,
        },
        "falkordb": {
            "name":        "FalkorDB",
            "description": "L3 graph memory — knowledge + relationship storage",
            "auto_launch": True,
            "depends_on":  ["docker"],
            "check":       lambda: _ping_tcp("localhost", falkordb_port, timeout=2),
            "launch":      lambda: _launch_falkordb(falkordb_port),
            "ready_check": lambda: _ping_tcp("localhost", falkordb_port, timeout=3),
            "ready_timeout": 45,
        },
        "blender": {
            "name":        "Blender",
            "description": "3D rendering — launched on-demand per task",
            "auto_launch": False,
            "depends_on":  [],
            "check":       _check_blender,
            "launch":      None,   # on-demand only
            "ready_check": _check_blender,
            "ready_timeout": 0,
        },
    }


_registry: dict = {}   # populated by init_process_manager


# ─────────────────────────────────────────────────────────────────────────────
# HEALTH CHECKS
# ─────────────────────────────────────────────────────────────────────────────

def _ping_http(url: str, timeout: float = 3) -> bool:
    try:
        r = httpx.get(url, timeout=timeout)
        return r.status_code < 500
    except Exception:
        return False


def _ping_tcp(host: str, port: int, timeout: float = 2) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except Exception:
        return False


def _check_docker() -> bool:
    # Try docker info first (fastest when CLI is on PATH)
    try:
        r = subprocess.run(
            ["docker", "info"],
            capture_output=True, timeout=8,
            creationflags=_NO_WINDOW,
        )
        if r.returncode == 0:
            return True
    except Exception:
        pass

    # Fallback: check Docker Desktop named pipe (Windows) or socket (Linux)
    if sys.platform == "win32":
        try:
            pipe_path = r"\\.\pipe\docker_engine"
            import ctypes
            INVALID = ctypes.c_void_p(-1).value
            handle = ctypes.windll.kernel32.CreateFileW(
                pipe_path, 0x80000000, 0, None, 3, 0, None)  # GENERIC_READ, OPEN_EXISTING
            if handle != INVALID:
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
        except Exception:
            pass
    else:
        try:
            return Path("/var/run/docker.sock").exists()
        except Exception:
            pass
    return False


def _check_blender() -> bool:
    for path in _BLENDER_PATHS:
        if path == "blender":
            r = subprocess.run(
                ["where", "blender"] if sys.platform == "win32" else ["which", "blender"],
                capture_output=True, timeout=5, creationflags=_NO_WINDOW,
            )
            if r.returncode == 0:
                return True
        elif Path(path).exists():
            return True
    return False


def get_blender_path() -> Optional[str]:
    """Return the first valid Blender executable path, or None."""
    for path in _BLENDER_PATHS:
        if path == "blender":
            r = subprocess.run(
                ["where", "blender"] if sys.platform == "win32" else ["which", "blender"],
                capture_output=True, timeout=5, creationflags=_NO_WINDOW,
            )
            if r.returncode == 0:
                return r.stdout.strip().splitlines()[0]
        elif Path(path).exists():
            return path
    return None


# ─────────────────────────────────────────────────────────────────────────────
# LAUNCHERS
# ─────────────────────────────────────────────────────────────────────────────

def _launch_ollama() -> bool:
    """Start `ollama serve` in the background with GPU env vars. Returns True if launched."""
    import os
    env = os.environ.copy()
    # Ensure Ollama uses the discrete GPU (GPU 1) not the integrated (GPU 0)
    env.setdefault("HIP_VISIBLE_DEVICES", "1")
    env.setdefault("ROCR_VISIBLE_DEVICES", "1")
    # HSA_OVERRIDE_GFX_VERSION for gfx1100 (RDNA 3 / RX 7900 XT)
    env.setdefault("HSA_OVERRIDE_GFX_VERSION", "11.0.0")
    try:
        subprocess.Popen(
            ["ollama", "serve"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=_NO_WINDOW,
            env=env,
        )
        logger.info("[process_manager] Launched: ollama serve (HIP_VISIBLE_DEVICES=%s)", env.get("HIP_VISIBLE_DEVICES"))
        return True
    except FileNotFoundError:
        logger.warning("[process_manager] ollama not found on PATH — install from https://ollama.com")
        return False
    except Exception as exc:
        logger.error("[process_manager] Failed to launch ollama: %s", exc)
        return False


def _launch_docker() -> bool:
    """Start Docker Desktop (Windows). Returns True if launch attempted."""
    for path in _DOCKER_PATHS:
        if Path(path).exists():
            try:
                subprocess.Popen(
                    [path],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=_NO_WINDOW,
                )
                logger.info("[process_manager] Launched Docker Desktop: %s", path)
                return True
            except Exception as exc:
                logger.error("[process_manager] Docker Desktop launch failed: %s", exc)
                return False
    logger.warning("[process_manager] Docker Desktop not found at known paths")
    return False


def _launch_falkordb(port: int) -> bool:
    """Start the falkordb Docker container, creating it if needed."""
    # Try starting existing container first
    try:
        r = subprocess.run(
            ["docker", "start", "falkordb"],
            capture_output=True, timeout=15,
            creationflags=_NO_WINDOW,
        )
        if r.returncode == 0:
            logger.info("[process_manager] Started existing falkordb container")
            return True
    except Exception:
        pass

    # Container doesn't exist — create and start it
    try:
        data_path = str(Path("~/.aura/falkordb").expanduser())
        Path(data_path).mkdir(parents=True, exist_ok=True)
        r = subprocess.run(
            [
                "docker", "run", "-d",
                "--name", "falkordb",
                "--restart", "unless-stopped",
                "-p", f"{port}:6379",
                "-v", f"{data_path}:/data",
                "falkordb/falkordb:latest",
            ],
            capture_output=True, timeout=120,
            creationflags=_NO_WINDOW,
        )
        if r.returncode == 0:
            logger.info("[process_manager] Created + started falkordb container on port %d", port)
            return True
        else:
            logger.error("[process_manager] falkordb docker run failed: %s", r.stderr.decode())
            return False
    except Exception as exc:
        logger.error("[process_manager] falkordb launch error: %s", exc)
        return False


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

def get_service_status(service_id: Optional[str] = None) -> dict:
    """Return status dict for one service or all services."""
    if service_id:
        return _service_status.get(service_id, {"id": service_id, "status": "unknown"})
    return dict(_service_status)


async def launch_service(service_id: str) -> dict:
    """
    Manually trigger launch of a service.
    Returns immediately with {'status': 'starting'} — SSE delivers the result.
    """
    svc = _registry.get(service_id)
    if not svc:
        return {"status": "error", "message": f"Unknown service: {service_id}"}
    if not svc.get("launch"):
        return {"status": "error", "message": f"{svc['name']} is launched on-demand only"}

    asyncio.create_task(_launch_and_wait(service_id), name=f"launch_{service_id}")
    return {"status": "starting", "id": service_id}


async def _launch_and_wait(service_id: str) -> None:
    """Launch a service and poll until ready, emitting SSE throughout."""
    svc = _registry[service_id]
    await _emit_status(service_id, "starting", f"Launching {svc['name']}...")

    # Check dependencies first
    for dep in svc.get("depends_on", []):
        dep_svc = _registry.get(dep)
        if dep_svc and not await asyncio.to_thread(dep_svc["check"]):
            await _emit_status(service_id, "error",
                               f"Dependency not ready: {dep_svc['name']}")
            return

    # Launch
    launched = await asyncio.to_thread(svc["launch"])
    if not launched:
        await _emit_status(service_id, "not_installed",
                           f"{svc['name']} not found — check installation")
        return

    _launched_by_us.add(service_id)

    # Poll for ready
    deadline = time.time() + svc.get("ready_timeout", 30)
    while time.time() < deadline:
        await asyncio.sleep(2)
        if await asyncio.to_thread(svc["ready_check"]):
            await _emit_status(service_id, "running", f"{svc['name']} ready")
            return

    await _emit_status(service_id, "error",
                       f"{svc['name']} launched but did not become ready in time")


# ─────────────────────────────────────────────────────────────────────────────
# MONITOR LOOP + INIT
# ─────────────────────────────────────────────────────────────────────────────

async def _monitor_loop() -> None:
    """Poll all services every 30s and emit SSE on status change."""
    while True:
        await asyncio.sleep(30)
        for sid, svc in _registry.items():
            try:
                running = await asyncio.to_thread(svc["check"])
                new_status = "running" if running else "stopped"
                old = _service_status.get(sid, {}).get("status")
                if new_status != old:
                    await _emit_status(sid, new_status)
            except Exception as exc:
                logger.debug("[process_manager] Monitor check failed for %s: %s", sid, exc)


async def _emit_status(service_id: str, status: str, details: str = "") -> None:
    """Update local state and emit SSE event."""
    svc = _registry.get(service_id, {})
    entry = {
        "id":          service_id,
        "name":        svc.get("name", service_id),
        "status":      status,
        "description": svc.get("description", ""),
        "details":     details,
    }
    _service_status[service_id] = entry

    try:
        from app.controller.chat_controller import _emit
        await _emit("service_status", entry)
    except Exception:
        pass

    logger.info("[process_manager] %s → %s %s", service_id, status, details)


async def init_process_manager(settings) -> None:
    """
    Build the service registry, check all services, auto-launch missing ones.
    Called from main.py lifespan as a background task.
    """
    global _registry, _monitor_task

    _registry = _build_registry(settings)

    # Initial check — emit current status for all services
    for sid, svc in _registry.items():
        try:
            running = await asyncio.to_thread(svc["check"])
            await _emit_status(sid, "running" if running else "stopped")
        except Exception as exc:
            await _emit_status(sid, "error", str(exc))

    # Auto-launch missing services (respecting dependency order).
    # Ollama is also launched by boot_sequence Phase 2, but include here as fallback
    # in case process manager initializes after boot or Ollama dies mid-session.
    launch_order = ["ollama", "docker", "falkordb"]   # blender is on-demand

    for sid in launch_order:
        svc = _registry.get(sid)
        if not svc or not svc.get("auto_launch"):
            continue
        current = _service_status.get(sid, {}).get("status")
        if current == "running":
            continue

        # Check dependencies are running
        deps_ok = all(
            _service_status.get(d, {}).get("status") == "running"
            for d in svc.get("depends_on", [])
        )
        if not deps_ok:
            logger.info("[process_manager] Skipping %s — dependency not ready", sid)
            continue

        logger.info("[process_manager] Auto-launching: %s", sid)
        asyncio.create_task(_launch_and_wait(sid), name=f"auto_launch_{sid}")

        # Brief wait so dependency services are up before dependents check
        if sid in ("docker",):
            await asyncio.sleep(3)

    # Start background monitor
    _monitor_task = asyncio.create_task(_monitor_loop(), name="process_monitor")
    logger.info("[process_manager] Process manager initialized")
