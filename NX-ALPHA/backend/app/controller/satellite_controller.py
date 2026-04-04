"""
AURA NX-Alpha — Satellite Controller
REST API for satellite management: discovery, registration, health, provisioning, inference.

ROUTES:
    GET    /satellites              — list all registered satellites with status
    GET    /satellites/scan         — trigger network discovery
    POST   /satellites/register     — register new satellite
    PUT    /satellites/{id}         — update satellite config
    DELETE /satellites/{id}         — remove satellite
    POST   /satellites/{id}/query   — send inference query to satellite
    GET    /satellites/{id}/metrics — get satellite metrics
    POST   /satellites/{id}/governor/reset — manual circuit breaker reset
    POST   /satellites/{id}/model/swap     — hot-swap model on satellite
    GET    /satellites/network-map  — topology data for UI

PROVISIONING:
    POST   /satellites/assess       — assess a bootstrap host
    POST   /satellites/provision    — run install steps on host
    POST   /satellites/configure    — configure a provisioned satellite

GOVERNOR:
    GET    /satellites/governor/defaults  — get global governor defaults
    PUT    /satellites/{id}/governor/thresholds — set per-machine thresholds
"""

import io
import logging
import secrets
import socket
import time
import zipfile
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/satellites", tags=["satellites"])


# ─────────────────────────────────────────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────────────────────────────────────────

class RegisterSatelliteRequest(BaseModel):
    host: str
    port: int = 7779
    name: str = ""
    role: str = "general"
    model: str = ""
    model_family: str = ""
    gpu_type: str = ""
    gpu_class: str = ""
    vram_mb: int = 0
    ram_gb: float = 0
    cpu_name: str = ""
    cpu_cores: int = 0
    chassis: str = "desktop"
    is_laptop: bool = False


class UpdateSatelliteRequest(BaseModel):
    name: Optional[str] = None
    role: Optional[str] = None
    model: Optional[str] = None
    model_family: Optional[str] = None
    port: Optional[int] = None


class QueryRequest(BaseModel):
    prompt: str
    model: str = ""
    max_tokens: int = 2048
    temperature: float = 0.7


class AssessRequest(BaseModel):
    host: str
    token: str = ""


class ProvisionRequest(BaseModel):
    host: str
    steps: list[dict[str, Any]]
    token: str = ""


class ConfigureRequest(BaseModel):
    host: str
    name: str = ""
    role: str = "general"
    model: str = ""
    model_family: str = ""


class ModelSwapRequest(BaseModel):
    model: str


class ThresholdsRequest(BaseModel):
    temp_nominal_max: Optional[float] = None
    temp_warm_max: Optional[float] = None
    temp_hot_max: Optional[float] = None
    vram_cap_pct: Optional[float] = None
    vram_hard_cap_pct: Optional[float] = None
    ram_caution_pct: Optional[float] = None
    ram_hard_cap_pct: Optional[float] = None
    is_laptop: Optional[bool] = None


class IngestRequest(BaseModel):
    satellite_id: str
    payload: dict  # {type: "rss"|"http", source: str, entries|content: ...}


# ─────────────────────────────────────────────────────────────────────────────
# SSE EMIT HELPER
# ─────────────────────────────────────────────────────────────────────────────

async def _emit(event_type: str, data: dict) -> None:
    """Forward SSE events through the chat controller's broadcast."""
    try:
        from app.controller.chat_controller import _emit as chat_emit
        await chat_emit(event_type, data)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# LIST / NETWORK MAP
# ─────────────────────────────────────────────────────────────────────────────

@router.get("")
async def list_satellites() -> dict:
    """List all registered satellites with status."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        if not registry:
            return {"satellites": [], "count": 0}
        sats = registry.get_all()
        return {"satellites": sats, "count": len(sats)}
    except Exception as exc:
        logger.error("[satellite_ctrl] list error: %s", exc)
        return {"satellites": [], "count": 0, "error": str(exc)}


@router.get("/network-map")
async def get_network_map() -> dict:
    """Return topology data for the Network Map UI."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        if not registry:
            return {"nodes": [], "hub": _get_hub_info()}
        nodes = registry.get_network_map()
        return {"nodes": nodes, "hub": _get_hub_info()}
    except Exception as exc:
        logger.error("[satellite_ctrl] network-map error: %s", exc)
        return {"nodes": [], "hub": _get_hub_info(), "error": str(exc)}


def _get_hub_info() -> dict:
    """Return info about the main AURA machine (hub node)."""
    try:
        from app.service.system_monitor_service import get_latest_snapshot
        snap = get_latest_snapshot()
        gpu_name = "Unknown"
        gpu_temp = 0
        vram_used = 0
        vram_total = 0
        if snap.get("gpu"):
            g = snap["gpu"][0]
            gpu_name = g.get("name", "Unknown")
            gpu_temp = g.get("temperature", 0)
            vram_used = g.get("vram_used_mb", 0)
            vram_total = g.get("vram_total_mb", 0)
        return {
            "name": "AURA Main",
            "status": "online",
            "gpu": gpu_name,
            "gpu_temp_c": gpu_temp,
            "vram_used_mb": vram_used,
            "vram_total_mb": vram_total,
            "ram_used_gb": snap.get("ram", {}).get("used_gb", 0),
            "ram_total_gb": snap.get("ram", {}).get("total_gb", 0),
        }
    except Exception:
        return {"name": "AURA Main", "status": "online"}


# ─────────────────────────────────────────────────────────────────────────────
# DISCOVERY
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/scan")
async def scan_network(subnet: str = "") -> dict:
    """Trigger network discovery scan for AURA services."""
    try:
        from app.service.satellite.discovery import scan_subnet
        await _emit("satellite_status", {"action": "scan_started"})
        results = await scan_subnet(subnet=subnet if subnet else None)
        await _emit("satellite_status", {"action": "scan_complete", "found": len(results)})
        return {"discovered": results, "count": len(results)}
    except RuntimeError as exc:
        # Known failure (subnet detection failed, etc.) — propagate clearly
        logger.error("[satellite_ctrl] scan failed: %s", exc)
        await _emit("satellite_status", {"action": "scan_error", "error": str(exc)})
        return {"discovered": [], "count": 0, "error": str(exc)}
    except Exception as exc:
        logger.error("[satellite_ctrl] scan unexpected error: %s", exc)
        return {"discovered": [], "count": 0, "error": f"Scan error: {exc}"}


# ─────────────────────────────────────────────────────────────────────────────
# REGISTRATION
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/register")
async def register_satellite(req: RegisterSatelliteRequest) -> dict:
    """Register a new satellite."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        if not registry:
            raise HTTPException(status_code=503, detail="Satellite registry not initialized")

        # Check for duplicate host
        existing = registry.get_by_host(req.host)
        if existing:
            raise HTTPException(status_code=409, detail=f"Satellite already registered at {req.host}")

        sat = registry.register_satellite(req.model_dump())
        await _emit("satellite_status", {
            "action": "registered",
            "satellite_id": sat["id"],
            "name": sat["name"],
            "host": sat["host"],
        })
        return {"satellite": sat}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] register error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# UPDATE / DELETE
# ─────────────────────────────────────────────────────────────────────────────

@router.put("/{sat_id}")
async def update_satellite(sat_id: str, req: UpdateSatelliteRequest) -> dict:
    """Update satellite configuration."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        if not registry:
            raise HTTPException(status_code=503, detail="Satellite registry not initialized")

        updates = {k: v for k, v in req.model_dump().items() if v is not None}
        sat = registry.update_satellite(sat_id, updates)
        if not sat:
            raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found")
        return {"satellite": sat}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] update error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/{sat_id}")
async def remove_satellite(sat_id: str) -> dict:
    """Remove a satellite from the registry."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        if not registry:
            raise HTTPException(status_code=503, detail="Satellite registry not initialized")

        removed = registry.remove_satellite(sat_id)
        if not removed:
            raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found")
        await _emit("satellite_status", {"action": "removed", "satellite_id": sat_id})
        return {"removed": True, "satellite_id": sat_id}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] remove error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# INFERENCE QUERY
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{sat_id}/query")
async def send_query(sat_id: str, req: QueryRequest) -> dict:
    """Send an inference query to a satellite."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        from app.service.satellite.provisioner import get_satellite_provisioner
        registry = get_satellite_registry()
        provisioner = get_satellite_provisioner()
        if not registry or not provisioner:
            raise HTTPException(status_code=503, detail="Satellite services not initialized")

        sat = registry.get_by_id(sat_id)
        if not sat:
            raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found")
        if sat.get("circuit_breaker_tripped"):
            raise HTTPException(status_code=503, detail="Circuit breaker tripped — reset required")
        if sat["status"] in ("offline", "circuit_breaker"):
            raise HTTPException(status_code=503, detail=f"Satellite is {sat['status']}")

        result = await provisioner.send_query(
            host=sat["host"],
            port=sat["port"],
            prompt=req.prompt,
            model=req.model or sat.get("model", ""),
            max_tokens=req.max_tokens,
            temperature=req.temperature,
        )
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] query error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# METRICS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{sat_id}/metrics")
async def get_metrics(sat_id: str) -> dict:
    """Get satellite metrics (live fetch from satellite agent)."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        if not registry:
            raise HTTPException(status_code=503, detail="Satellite registry not initialized")

        sat = registry.get_by_id(sat_id)
        if not sat:
            raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found")

        # Try to fetch live metrics
        from app.service.satellite.health_poller import _fetch_json
        base_url = f"http://{sat['host']}:{sat['port']}"
        metrics = await _fetch_json(f"{base_url}/status")

        if metrics:
            return {
                "satellite_id": sat_id,
                "name": sat["name"],
                "status": sat["status"],
                "metrics": metrics,
                "events": registry.get_events(sat_id, limit=20),
            }
        else:
            return {
                "satellite_id": sat_id,
                "name": sat["name"],
                "status": sat["status"],
                "metrics": None,
                "message": "Satellite unreachable",
                "events": registry.get_events(sat_id, limit=20),
            }
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] metrics error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# GOVERNOR / CIRCUIT BREAKER
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{sat_id}/governor/reset")
async def reset_circuit_breaker(sat_id: str) -> dict:
    """Manual circuit breaker reset. Starts 5-minute cooldown."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        if not registry:
            raise HTTPException(status_code=503, detail="Satellite registry not initialized")

        sat = registry.get_by_id(sat_id)
        if not sat:
            raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found")
        if not sat.get("circuit_breaker_tripped"):
            return {"message": "Circuit breaker is not tripped", "satellite": sat}

        updated = registry.reset_circuit_breaker(sat_id)
        await _emit("satellite_status", {
            "action": "circuit_breaker_reset",
            "satellite_id": sat_id,
            "name": sat["name"],
            "cooldown_minutes": 5,
        })
        return {"message": "Circuit breaker reset — 5-minute cooldown started", "satellite": updated}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] governor reset error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/governor/defaults")
async def get_governor_defaults() -> dict:
    """Get global governor threshold defaults."""
    from app.service.satellite.governor import GovernorThresholds
    defaults = GovernorThresholds()
    return {
        "temp_nominal_max": defaults.temp_nominal_max,
        "temp_warm_max": defaults.temp_warm_max,
        "temp_hot_max": defaults.temp_hot_max,
        "vram_cap_pct": defaults.vram_cap_pct,
        "vram_hard_cap_pct": defaults.vram_hard_cap_pct,
        "ram_caution_pct": defaults.ram_caution_pct,
        "ram_hard_cap_pct": defaults.ram_hard_cap_pct,
    }


@router.put("/{sat_id}/governor/thresholds")
async def set_thresholds(sat_id: str, req: ThresholdsRequest) -> dict:
    """Set per-machine governor threshold overrides."""
    try:
        from app.service.satellite.governor import get_hardware_governor, GovernorThresholds
        governor = get_hardware_governor()
        if not governor:
            raise HTTPException(status_code=503, detail="Hardware governor not initialized")

        # Build thresholds from request, falling back to defaults
        defaults = GovernorThresholds()
        thresholds = GovernorThresholds(
            temp_nominal_max=req.temp_nominal_max or defaults.temp_nominal_max,
            temp_warm_max=req.temp_warm_max or defaults.temp_warm_max,
            temp_hot_max=req.temp_hot_max or defaults.temp_hot_max,
            vram_cap_pct=req.vram_cap_pct or defaults.vram_cap_pct,
            vram_hard_cap_pct=req.vram_hard_cap_pct or defaults.vram_hard_cap_pct,
            ram_caution_pct=req.ram_caution_pct or defaults.ram_caution_pct,
            ram_hard_cap_pct=req.ram_hard_cap_pct or defaults.ram_hard_cap_pct,
            is_laptop=req.is_laptop if req.is_laptop is not None else False,
        )
        governor.set_thresholds(sat_id, thresholds)
        return {"message": f"Thresholds updated for {sat_id}", "thresholds": {
            "temp_nominal_max": thresholds.temp_nominal_max,
            "temp_warm_max": thresholds.temp_warm_max,
            "temp_hot_max": thresholds.temp_hot_max,
            "vram_cap_pct": thresholds.vram_cap_pct,
            "vram_hard_cap_pct": thresholds.vram_hard_cap_pct,
            "ram_caution_pct": thresholds.ram_caution_pct,
            "ram_hard_cap_pct": thresholds.ram_hard_cap_pct,
            "is_laptop": thresholds.is_laptop,
        }}
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] set thresholds error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# MODEL SWAP
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{sat_id}/model/swap")
async def swap_model(sat_id: str, req: ModelSwapRequest) -> dict:
    """Hot-swap the model on a running satellite."""
    try:
        from app.service.satellite.registry import get_satellite_registry
        from app.service.satellite.provisioner import get_satellite_provisioner
        registry = get_satellite_registry()
        provisioner = get_satellite_provisioner()
        if not registry or not provisioner:
            raise HTTPException(status_code=503, detail="Satellite services not initialized")

        sat = registry.get_by_id(sat_id)
        if not sat:
            raise HTTPException(status_code=404, detail=f"Satellite {sat_id} not found")

        result = await provisioner.swap_model(sat["host"], sat["port"], req.model)
        if result.get("status") == "success":
            registry.update_satellite(sat_id, {"model": req.model})
            await _emit("satellite_status", {
                "action": "model_swapped",
                "satellite_id": sat_id,
                "model": req.model,
            })
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] model swap error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# PROVISIONING WIZARD
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/assess")
async def assess_host(req: AssessRequest) -> dict:
    """Assess a bootstrap host for provisioning."""
    try:
        from app.service.satellite.provisioner import get_satellite_provisioner
        provisioner = get_satellite_provisioner()
        if not provisioner:
            raise HTTPException(status_code=503, detail="Provisioner not initialized")
        return await provisioner.assess(req.host, req.token)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] assess error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/provision")
async def provision_host(req: ProvisionRequest) -> dict:
    """Run install steps on a bootstrap host."""
    try:
        from app.service.satellite.provisioner import get_satellite_provisioner
        provisioner = get_satellite_provisioner()
        if not provisioner:
            raise HTTPException(status_code=503, detail="Provisioner not initialized")
        return await provisioner.provision(req.host, req.steps, req.token)
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] provision error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/configure")
async def configure_satellite(req: ConfigureRequest) -> dict:
    """Configure a provisioned satellite."""
    try:
        from app.service.satellite.provisioner import get_satellite_provisioner
        provisioner = get_satellite_provisioner()
        if not provisioner:
            raise HTTPException(status_code=503, detail="Provisioner not initialized")
        return await provisioner.configure(req.host, req.model_dump())
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] configure error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# BOOTSTRAP SCRIPT GENERATION
# ─────────────────────────────────────────────────────────────────────────────

def _get_lan_ip() -> str:
    """Get this machine's LAN IP (same trick used by discovery.py)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return socket.gethostbyname(socket.gethostname())


@router.get("/bootstrap_script")
async def get_bootstrap_script() -> Response:
    """
    Generate a per-machine aura_bootstrap.ps1 with a unique single-use token.
    Returns the filled-in .ps1 as a downloadable text file.
    """
    template_path = Path(__file__).parent.parent.parent.parent / "scripts" / "aura_bootstrap.ps1.template"
    if not template_path.exists():
        raise HTTPException(status_code=500, detail="Bootstrap script template not found")

    token = secrets.token_urlsafe(32)
    lan_ip = _get_lan_ip()
    generated_at = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())

    script = template_path.read_text(encoding="utf-8")
    script = script.replace("{{TOKEN}}", token)
    script = script.replace("{{AURA_MAIN_IP}}", lan_ip)
    script = script.replace("{{GENERATED_AT}}", generated_at)

    logger.info("[satellite_ctrl] Bootstrap script generated for %s (token: %s...)", lan_ip, token[:8])
    return Response(
        content=script,
        media_type="text/plain",
        headers={"Content-Disposition": "attachment; filename=aura_bootstrap.ps1"},
    )


# ─────────────────────────────────────────────────────────────────────────────
# AGENT PACKAGE SERVING
# ─────────────────────────────────────────────────────────────────────────────

# Cache: { type: (zip_bytes, mtime_sum) }
_pkg_cache: dict[str, tuple[bytes, float]] = {}

_AGENT_DIRS = {
    "bootstrap": Path(__file__).parent.parent / "satellite" / "bootstrap_agent",
    "satellite":  Path(__file__).parent.parent / "satellite" / "satellite_agent",
}

_REQ_FILES = {
    "bootstrap": Path(__file__).parent.parent.parent.parent / "backend" / "app" / "satellite" / "requirements_bootstrap.txt",
    "satellite":  Path(__file__).parent.parent.parent.parent / "backend" / "app" / "satellite" / "requirements_satellite.txt",
}


def _build_agent_zip(agent_type: str) -> bytes:
    """Zip the agent directory. Returns raw bytes."""
    agent_dir = _AGENT_DIRS[agent_type]
    if not agent_dir.exists():
        raise FileNotFoundError(f"Agent directory not found: {agent_dir}")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fpath in sorted(agent_dir.rglob("*")):
            if fpath.is_file() and "__pycache__" not in str(fpath):
                arcname = fpath.relative_to(agent_dir)
                zf.write(fpath, arcname)
        # Bundle requirements file
        req_path = Path(__file__).parent.parent / "satellite" / f"requirements_{agent_type}.txt"
        if req_path.exists():
            zf.write(req_path, f"requirements_{agent_type}.txt")
    return buf.getvalue()


def _get_mtime_sum(agent_type: str) -> float:
    agent_dir = _AGENT_DIRS[agent_type]
    if not agent_dir.exists():
        return 0.0
    return sum(p.stat().st_mtime for p in agent_dir.rglob("*.py") if p.is_file())


@router.get("/agent_package")
async def get_agent_package(type: str = "satellite") -> Response:
    """
    Serve the bootstrap or satellite agent as a .zip for remote install.
    Cached and invalidated when source files change.
    type: 'bootstrap' | 'satellite'
    """
    if type not in ("bootstrap", "satellite"):
        raise HTTPException(status_code=400, detail="type must be 'bootstrap' or 'satellite'")

    try:
        current_mtime = _get_mtime_sum(type)
        cached = _pkg_cache.get(type)
        if cached and cached[1] == current_mtime:
            zip_bytes = cached[0]
        else:
            zip_bytes = _build_agent_zip(type)
            _pkg_cache[type] = (zip_bytes, current_mtime)
            logger.info("[satellite_ctrl] Built %s agent package (%d bytes)", type, len(zip_bytes))

        return Response(
            content=zip_bytes,
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename=aura_{type}_agent.zip"},
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=500, detail=str(exc))
    except Exception as exc:
        logger.error("[satellite_ctrl] agent_package error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


# ─────────────────────────────────────────────────────────────────────────────
# MEMORY INGEST (Phase 2 — Autonomous Collectors)
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/memory/ingest")
async def satellite_memory_ingest(req: IngestRequest, authorization: str = Header(default="")) -> dict:
    """
    Receive raw data payload from an autonomous collector satellite.
    Routes to L2 ChromaDB (text) or L3 FalkorDB (structured + graph_entities).
    Auth: satellite must present its sat_token as Bearer token.
    """
    # Validate satellite token
    bearer = authorization.removeprefix("Bearer ").strip()
    try:
        from app.service.satellite.registry import get_satellite_registry
        registry = get_satellite_registry()
        if not registry:
            raise HTTPException(status_code=503, detail="Satellite registry not initialized")

        sat = registry.get_by_token(bearer) if bearer else None
        if not sat:
            raise HTTPException(status_code=401, detail="Invalid satellite token")
        if sat["id"] != req.satellite_id:
            raise HTTPException(status_code=403, detail="Token does not match satellite_id")
    except HTTPException:
        raise
    except Exception as exc:
        logger.error("[satellite_ctrl] ingest auth error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))

    # Extract text from payload
    payload = req.payload
    payload_type = payload.get("type", "http")
    source = payload.get("source", f"satellite_{req.satellite_id}")
    chunks_stored = 0

    try:
        if payload_type == "rss":
            entries = payload.get("entries", [])
            text_parts = []
            for e in entries:
                title   = e.get("title", "")
                summary = e.get("summary", "")
                link    = e.get("link", "")
                if title or summary:
                    text_parts.append(f"# {title}\n{summary}\n{link}")
            combined = "\n\n".join(text_parts)
        else:
            combined = payload.get("content", "")

        if combined.strip():
            # Route to L2 ChromaDB via knowledge_service ingest
            try:
                from app.service.knowledge_service import ingest_text
                chunks_stored = await ingest_text(
                    text=combined,
                    source=f"satellite_{req.satellite_id}",
                    metadata={
                        "type": payload_type,
                        "url": source,
                        "satellite_id": req.satellite_id,
                        "satellite_name": sat.get("name", ""),
                        "ingested_at": time.time(),
                    },
                )
            except ImportError:
                # Fallback: try data_controller ingest pattern
                from app.controller.data_controller import _ingest_document
                chunks_stored = await _ingest_document(combined, source, {"satellite_id": req.satellite_id})

        # Structured graph data → L3 FalkorDB
        if "graph_entities" in payload:
            try:
                from app.service.memory_service import store_graph_entities
                await store_graph_entities(payload["graph_entities"], source=source)
            except Exception as graph_exc:
                logger.warning("[satellite_ctrl] Graph ingest failed: %s", graph_exc)

        logger.info(
            "[satellite_ctrl] Ingested from satellite %s (%s): %d chunks",
            req.satellite_id, payload_type, chunks_stored,
        )
        return {"status": "ok", "chunks_stored": chunks_stored, "type": payload_type}

    except Exception as exc:
        logger.error("[satellite_ctrl] ingest error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))
