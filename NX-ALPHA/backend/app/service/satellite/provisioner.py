"""
AURA NX-Alpha — Satellite Provisioning Orchestrator
Drives remote provisioning from AURA main: assess → install → configure.
Communicates with the Bootstrap Agent (port 7778) on target machines.
Streams progress back via SSE.

All provisioning is driven from AURA main. The user never needs to touch
the target machine again after running the bootstrap script.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Callable, Coroutine, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# HTTP CLIENT
# ─────────────────────────────────────────────────────────────────────────────

try:
    import httpx
    _HTTPX_AVAILABLE = True
except ImportError:
    httpx = None  # type: ignore[assignment]
    _HTTPX_AVAILABLE = False


async def _fetch_json(url: str, timeout: float = 10.0) -> dict | None:
    """GET JSON from a URL."""
    if _HTTPX_AVAILABLE:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(url)
                if resp.status_code == 200:
                    return resp.json()
                logger.warning("[provisioner] GET %s → %d", url, resp.status_code)
        except Exception as exc:
            logger.debug("[provisioner] GET failed %s: %s", url, exc)
    return None


async def _post_json(url: str, data: dict, timeout: float = 30.0) -> dict | None:
    """POST JSON to a URL."""
    if _HTTPX_AVAILABLE:
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.post(url, json=data)
                if resp.status_code in (200, 201, 202):
                    return resp.json()
                logger.warning("[provisioner] POST %s → %d", url, resp.status_code)
        except Exception as exc:
            logger.debug("[provisioner] POST failed %s: %s", url, exc)
    return None


# ─────────────────────────────────────────────────────────────────────────────
# MODEL RECOMMENDATIONS (from SATELLITE_SPEC §3)
# Uses VRAM-fit formula: Q4 size (GB) ≈ params_B × 0.5
# q4_vram_mb is the empirically measured peak VRAM at Q4 quantization
# ─────────────────────────────────────────────────────────────────────────────

_SATELLITE_MODELS: list[dict] = [
    # Sorted by q4_vram_mb ascending for efficient fit filtering
    {"ollama_name": "tinyllama:1.1b",       "params_b": 1.1,  "q4_vram_mb": 700,  "laptop_safe": True},
    {"ollama_name": "phi3:mini",             "params_b": 3.8,  "q4_vram_mb": 2200, "laptop_safe": True},
    {"ollama_name": "llama3.2:3b",           "params_b": 3.2,  "q4_vram_mb": 1800, "laptop_safe": True},
    {"ollama_name": "gemma3:4b",             "params_b": 4.0,  "q4_vram_mb": 2500, "laptop_safe": True},
    {"ollama_name": "mistral:7b-q4_K_M",    "params_b": 7.0,  "q4_vram_mb": 4200, "laptop_safe": True},
    {"ollama_name": "qwen2.5:7b",            "params_b": 7.0,  "q4_vram_mb": 4500, "laptop_safe": True},
    {"ollama_name": "mistral:7b",            "params_b": 7.0,  "q4_vram_mb": 4500, "laptop_safe": False},
    {"ollama_name": "llama3.1:8b",           "params_b": 8.0,  "q4_vram_mb": 5200, "laptop_safe": False},
    {"ollama_name": "qwen2.5:14b",           "params_b": 14.0, "q4_vram_mb": 9000, "laptop_safe": False},
]

_SAFETY_BUFFER_MB = 500   # Reserve for OS + driver overhead
_LAPTOP_HEADROOM  = 0.85  # Additional 15% thermal headroom on laptops


def _recommend_models(vram_mb: int, gpu_class: str, is_laptop: bool) -> list[str]:
    """
    Return model recommendations that actually fit in the detected VRAM.
    Models are sorted largest-fitting first (best capability first).
    Always returns at least tinyllama:1.1b as a fallback.
    """
    if gpu_class in ("integrated", "intel_arc"):
        return []  # Not recommended for GPU inference

    if vram_mb <= 0:
        return ["tinyllama:1.1b"]  # CPU-only path

    effective_vram = vram_mb - _SAFETY_BUFFER_MB
    if is_laptop:
        effective_vram = int(effective_vram * _LAPTOP_HEADROOM)

    fitting = [
        m for m in _SATELLITE_MODELS
        if m["q4_vram_mb"] <= effective_vram
        and (not is_laptop or m["laptop_safe"])
    ]

    # Sort largest-fitting first
    fitting.sort(key=lambda m: m["q4_vram_mb"], reverse=True)
    names = [m["ollama_name"] for m in fitting]

    return names if names else ["tinyllama:1.1b"]


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: Optional["SatelliteProvisioner"] = None


def init_satellite_provisioner(
    emit_fn: Callable[[str, dict], Coroutine] | None = None,
) -> "SatelliteProvisioner":
    global _instance
    _instance = SatelliteProvisioner(emit_fn=emit_fn)
    return _instance


def get_satellite_provisioner() -> Optional["SatelliteProvisioner"]:
    return _instance


# ─────────────────────────────────────────────────────────────────────────────
# PROVISIONER
# ─────────────────────────────────────────────────────────────────────────────

class SatelliteProvisioner:
    """Orchestrates remote provisioning of satellite machines."""

    def __init__(self, emit_fn: Callable[[str, dict], Coroutine] | None = None):
        self._emit = emit_fn
        logger.info("[provisioner] Satellite provisioner initialized")

    async def _emit_event(self, event_type: str, data: dict) -> None:
        if self._emit:
            try:
                await self._emit(event_type, data)
            except Exception as exc:
                logger.debug("[provisioner] SSE emit failed: %s", exc)

    async def _emit_progress(self, host: str, step: str, status: str, detail: str = "") -> None:
        """Emit a provisioning progress event."""
        await self._emit_event("provision_progress", {
            "host": host,
            "step": step,
            "status": status,
            "detail": detail,
            "timestamp": time.time(),
        })

    # ── Step 1: Assess ───────────────────────────────────────────────────────

    async def assess(self, host: str, token: str = "") -> dict[str, Any]:
        """
        GET /status from bootstrap agent. Build an assessment checklist.

        Returns:
            {
                "host": "192.168.1.42",
                "status_data": { ... raw bootstrap status ... },
                "checklist": [
                    {"step": "ollama", "label": "Install Ollama", "required": true, "installed": false},
                    ...
                ],
                "model_recommendations": ["llama3.2:3b", "phi3:mini"],
                "warnings": ["Laptop detected — Q4 quants recommended", ...],
            }
        """
        await self._emit_progress(host, "assess", "started", "Connecting to bootstrap agent...")

        base_url = f"http://{host}:7778"
        headers = {"Authorization": f"Bearer {token}"} if token else {}

        status_data = await _fetch_json(f"{base_url}/status")
        if status_data is None:
            await self._emit_progress(host, "assess", "failed", "Cannot reach bootstrap agent")
            return {"host": host, "error": "Cannot reach bootstrap agent", "checklist": []}

        await self._emit_progress(host, "assess", "connected", "Reading system info...")

        # Parse assessment
        gpus = status_data.get("gpus", [])
        gpu = gpus[0] if gpus else {}
        vram_mb = gpu.get("vram_dedicated_mb", 0)
        gpu_class = gpu.get("class", "cpu_only")
        chassis = status_data.get("chassis", "desktop")
        is_laptop = chassis in ("notebook", "laptop", "subnotebook", "portable")

        ollama_installed = status_data.get("ollama_installed", False)
        rocm_installed = status_data.get("rocm_installed", False)
        disk_free_gb = status_data.get("disk_free_gb", 0)

        # Build checklist
        checklist: list[dict] = []

        # Ollama
        checklist.append({
            "step": "ollama",
            "label": "Install Ollama",
            "required": True,
            "installed": ollama_installed,
            "command": "winget install Ollama.Ollama",
        })

        # ROCm (AMD only)
        if "amd" in gpu_class.lower():
            checklist.append({
                "step": "rocm",
                "label": "Install ROCm/HIP SDK",
                "required": True,
                "installed": rocm_installed,
                "command": "winget install AMD.ROCm",
            })

        # Model pull
        recs = _recommend_models(vram_mb, gpu_class, is_laptop)
        if recs:
            checklist.append({
                "step": "model",
                "label": f"Pull model ({recs[0]})",
                "required": True,
                "installed": False,
                "command": f"ollama pull {recs[0]}",
            })

        # AURA satellite agent upgrade
        checklist.append({
            "step": "agent_upgrade",
            "label": "Upgrade to AURA Satellite Agent",
            "required": True,
            "installed": False,
            "command": "POST /upgrade",
        })

        # Warnings
        warnings: list[str] = []
        if is_laptop:
            warnings.append("Laptop detected — thermal thresholds 5°C lower, Q4 quants recommended")
            warnings.append("Ensure plugged in during inference")
        if disk_free_gb < 20:
            warnings.append(f"Low disk space: {disk_free_gb:.0f} GB free")
        if gpu_class == "intel_arc":
            warnings.append("Intel Arc GPU — Ollama Arc support experimental, defaulting to CPU")
        if gpu_class == "integrated":
            warnings.append("Integrated GPU only — not recommended for inference roles")
        if "amd" in gpu_class.lower() and not rocm_installed:
            warnings.append("AMD GPU requires ROCm/HIP SDK for GPU inference")

        result = {
            "host": host,
            "status_data": status_data,
            "checklist": checklist,
            "model_recommendations": recs,
            "warnings": warnings,
            "is_laptop": is_laptop,
            "gpu_class": gpu_class,
            "vram_mb": vram_mb,
        }

        await self._emit_progress(host, "assess", "complete", f"Found {gpu.get('name', 'Unknown GPU')}")
        return result

    # ── Step 2: Provision (run install steps) ────────────────────────────────

    async def provision(
        self,
        host: str,
        steps: list[dict],
        token: str = "",
    ) -> dict[str, Any]:
        """
        Execute install steps on the bootstrap agent.

        Args:
            host: Target IP
            steps: List of steps from the checklist (each has 'step' and 'command')
            token: Bootstrap auth token

        Returns:
            {"host": host, "results": [{"step": "ollama", "status": "success"}, ...]}
        """
        base_url = f"http://{host}:7778"
        results: list[dict] = []

        for step in steps:
            step_name = step.get("step", "unknown")
            command = step.get("command", "")

            await self._emit_progress(host, step_name, "running", f"Executing: {command}")

            if step_name == "agent_upgrade":
                # Special step: upgrade bootstrap to full agent
                resp = await _post_json(f"{base_url}/upgrade", {})
                if resp and resp.get("status") == "ok":
                    results.append({"step": step_name, "status": "success"})
                    await self._emit_progress(host, step_name, "success", "Agent upgraded")
                else:
                    results.append({"step": step_name, "status": "failed", "error": "Upgrade failed"})
                    await self._emit_progress(host, step_name, "failed", "Agent upgrade failed")
            elif step_name == "model":
                # Model pull
                model = command.replace("ollama pull ", "")
                resp = await _post_json(f"{base_url}/pull_model", {"model": model}, timeout=300)
                if resp and resp.get("status") in ("ok", "success"):
                    results.append({"step": step_name, "status": "success", "model": model})
                    await self._emit_progress(host, step_name, "success", f"Model {model} pulled")
                else:
                    results.append({"step": step_name, "status": "failed"})
                    await self._emit_progress(host, step_name, "failed", f"Model pull failed")
            else:
                # Generic install command
                resp = await _post_json(f"{base_url}/install", {"command": command}, timeout=120)
                if resp and resp.get("status") in ("ok", "success"):
                    results.append({"step": step_name, "status": "success"})
                    await self._emit_progress(host, step_name, "success", f"{step_name} installed")
                else:
                    results.append({"step": step_name, "status": "failed"})
                    await self._emit_progress(host, step_name, "failed", f"{step_name} install failed")

        all_success = all(r["status"] == "success" for r in results)
        await self._emit_progress(
            host, "provision",
            "complete" if all_success else "partial",
            f"{sum(1 for r in results if r['status'] == 'success')}/{len(results)} steps succeeded",
        )

        return {"host": host, "results": results, "all_success": all_success}

    # ── Step 3: Configure ────────────────────────────────────────────────────

    async def configure(
        self,
        host: str,
        config: dict[str, Any],
    ) -> dict[str, Any]:
        """
        Configure a provisioned satellite: set name, role, model parameters.
        Talks to the full satellite agent on port 7779.

        Args:
            config: {
                "name": "LEGION-PC",
                "role": "general" | "tool_specialist" | "autonomous_collector",
                "model": "llama3.2:3b",
                "model_family": "llama",
            }
        """
        base_url = f"http://{host}:7779"
        await self._emit_progress(host, "configure", "running", "Applying configuration...")

        resp = await _post_json(f"{base_url}/configure", config)
        if resp and resp.get("status") in ("ok", "success", "configured"):
            await self._emit_progress(host, "configure", "success",
                                       f"Configured as {config.get('name', 'satellite')}")

            # Register in local registry
            from app.service.satellite.registry import get_satellite_registry
            registry = get_satellite_registry()
            if registry:
                existing = registry.get_by_host(host)
                if existing:
                    registry.update_satellite(existing["id"], {
                        "name": config.get("name", existing["name"]),
                        "role": config.get("role", "general"),
                        "model": config.get("model", ""),
                        "model_family": config.get("model_family", ""),
                        "status": "online",
                    })
                else:
                    registry.register_satellite({
                        "host": host,
                        "port": 7779,
                        "name": config.get("name", f"Satellite-{host}"),
                        "role": config.get("role", "general"),
                        "model": config.get("model", ""),
                        "model_family": config.get("model_family", ""),
                        "status": "online",
                    })

            return {"host": host, "status": "configured", "config": config}
        else:
            await self._emit_progress(host, "configure", "failed", "Configuration failed")
            return {"host": host, "status": "failed", "error": "Configuration failed"}

    # ── Model Hot-Swap ───────────────────────────────────────────────────────

    async def swap_model(
        self,
        host: str,
        port: int,
        model: str,
    ) -> dict[str, Any]:
        """Hot-swap the model on a running satellite."""
        base_url = f"http://{host}:{port}"
        await self._emit_progress(host, "model_swap", "running", f"Swapping to {model}...")

        resp = await _post_json(f"{base_url}/model/swap", {"model": model}, timeout=300)
        if resp and resp.get("status") in ("ok", "success"):
            await self._emit_progress(host, "model_swap", "success", f"Now running {model}")
            return {"host": host, "status": "success", "model": model}
        else:
            await self._emit_progress(host, "model_swap", "failed", f"Swap to {model} failed")
            return {"host": host, "status": "failed", "model": model}

    # ── Send Query to Satellite ──────────────────────────────────────────────

    async def send_query(
        self,
        host: str,
        port: int,
        prompt: str,
        model: str = "",
        max_tokens: int = 2048,
        temperature: float = 0.7,
    ) -> dict[str, Any]:
        """Send an inference query to a satellite agent."""
        base_url = f"http://{host}:{port}"
        payload = {
            "prompt": prompt,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if model:
            payload["model"] = model

        resp = await _post_json(f"{base_url}/query", payload, timeout=120)
        if resp:
            return {"host": host, "status": "success", "response": resp}
        return {"host": host, "status": "failed", "error": "Query failed"}
