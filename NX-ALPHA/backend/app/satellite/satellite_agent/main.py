"""
AURA Satellite Agent — FastAPI service on port 7779

Permanent service running on each provisioned satellite. Loads config from
C:/ProgramData/AURA/satellite_config.json at startup.

Dual-mode launch:
    Direct:  python main.py                        (dev/testing)
    Service: python main.py install | start | stop  (Windows Service via pywin32)

All endpoints except GET /health require Bearer token auth (sat_token from config).
"""

from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from . import governor
from .collector import get_collector, init_collector
from .health import get_health_metrics
from .inference import (
    get_current_model,
    list_models,
    run_query,
    set_current_model,
    swap_model,
)

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# CONFIG LOAD
# ─────────────────────────────────────────────────────────────────────────────

_CONFIG_PATH = Path("C:/ProgramData/AURA/satellite_config.json")

def _load_config() -> dict:
    if _CONFIG_PATH.exists():
        try:
            return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("[satellite_agent] Could not load config: %s", exc)
    return {}

_cfg = _load_config()
AURA_MAIN_HOST: str = _cfg.get("aura_main_host", "")
AURA_MAIN_PORT: int = int(_cfg.get("aura_main_port", 8000))
SAT_TOKEN: str      = _cfg.get("sat_token", "")
SAT_ID: str         = _cfg.get("sat_id", "")
SAT_NAME: str       = _cfg.get("name", socket.gethostname())
SAT_ROLE: str       = _cfg.get("role", "general")

# Initialise collector if config present
if AURA_MAIN_HOST and SAT_TOKEN and SAT_ID:
    init_collector(AURA_MAIN_HOST, AURA_MAIN_PORT, SAT_TOKEN, SAT_ID)

# Apply any stored governor config
_gov_cfg = _cfg.get("governor", {})
if _gov_cfg:
    governor.apply_config(_gov_cfg)

# Set initial model from config
_saved_model = _cfg.get("model", "")
if _saved_model:
    set_current_model(_saved_model)

# ─────────────────────────────────────────────────────────────────────────────
# APP
# ─────────────────────────────────────────────────────────────────────────────

app = FastAPI(title="AURA Satellite Agent", version="1.0.0")

_start_time = time.time()


# ─────────────────────────────────────────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────────────────────────────────────────

async def _require_auth(authorization: str = Header(default="")) -> None:
    """Validate sat_token. No auth if SAT_TOKEN is empty (dev mode)."""
    if not SAT_TOKEN:
        return
    token = authorization.removeprefix("Bearer ").strip()
    if token != SAT_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid satellite token")


# ─────────────────────────────────────────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    prompt: str
    model: str = ""
    max_tokens: int = 2048
    temperature: float = 0.7


class CollectConfigRequest(BaseModel):
    data_source: str
    ingest_rate_s: int = 60
    use_gpu: bool = False


class ConfigureRequest(BaseModel):
    name: str = ""
    role: str = ""
    model: str = ""
    data_source: str = ""
    ingest_rate_s: int = 60
    capabilities: list[str] = []
    governor: dict = {}


class ModelSwapRequest(BaseModel):
    model: str


# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict[str, Any]:
    """Full metrics snapshot. No auth required — AURA main polls this every 30s."""
    metrics = get_health_metrics()
    gov = governor.get_state()
    col = get_collector()
    return {
        "id": SAT_ID,
        "name": SAT_NAME,
        "role": SAT_ROLE,
        "model": get_current_model(),
        "status": "circuit_breaker" if gov["circuit_breaker"] else "online",
        **metrics,
        "circuit_breaker": gov["circuit_breaker"],
        "circuit_breaker_reason": gov["circuit_breaker_reason"],
        "queue_depth": gov["queue_depth"],
        "active_requests": gov["active_requests"],
        "collector_running": col.get_status()["running"] if col else False,
        "uptime_s": round(time.time() - _start_time, 1),
    }


@app.get("/status")
async def status(authorization: str = Header(default="")) -> dict[str, Any]:
    """Extended status including governor thresholds."""
    await _require_auth(authorization)
    metrics = get_health_metrics()
    gov = governor.get_state()
    col = get_collector()
    return {
        "id": SAT_ID,
        "name": SAT_NAME,
        "role": SAT_ROLE,
        "model": get_current_model(),
        **metrics,
        "governor": gov,
        "collector": col.get_status() if col else None,
    }


@app.post("/query")
async def query(req: QueryRequest, authorization: str = Header(default="")) -> dict[str, Any]:
    """Run an inference request via local Ollama."""
    await _require_auth(authorization)
    return await run_query(req.prompt, req.model, req.max_tokens, req.temperature)


@app.post("/collect/start")
async def collect_start(req: CollectConfigRequest, authorization: str = Header(default="")) -> dict[str, Any]:
    """Configure and start the autonomous collection loop."""
    await _require_auth(authorization)
    col = get_collector()
    if not col:
        raise HTTPException(status_code=500, detail="Collector not initialised (missing config)")
    col.configure(req.data_source, req.ingest_rate_s, req.use_gpu)
    started = col.start()
    return {"status": "started" if started else "already_running", "config": col.get_status()}


@app.post("/collect/stop")
async def collect_stop(authorization: str = Header(default="")) -> dict[str, Any]:
    """Stop the autonomous collection loop."""
    await _require_auth(authorization)
    col = get_collector()
    if col:
        col.stop()
    return {"status": "stopped"}


@app.get("/collect/status")
async def collect_status(authorization: str = Header(default="")) -> dict[str, Any]:
    """Return collection loop state."""
    await _require_auth(authorization)
    col = get_collector()
    if not col:
        return {"running": False, "error": "Collector not initialised"}
    return col.get_status()


@app.get("/metrics/stream")
async def metrics_stream(authorization: str = Header(default="")) -> StreamingResponse:
    """SSE stream of hardware metrics every 15 seconds."""
    await _require_auth(authorization)

    async def _generate():
        while True:
            metrics = get_health_metrics()
            gov = governor.get_state()
            data = json.dumps({**metrics, "circuit_breaker": gov["circuit_breaker"]})
            yield f"data: {data}\n\n"
            await asyncio.sleep(15)

    return StreamingResponse(
        _generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/governor/reset")
async def governor_reset(authorization: str = Header(default="")) -> dict[str, Any]:
    """Manually reset the circuit breaker. Requires auth."""
    await _require_auth(authorization)
    governor.reset_circuit_breaker()
    return {"status": "ok", "message": "Circuit breaker reset"}


@app.get("/model/list")
async def model_list(authorization: str = Header(default="")) -> dict[str, Any]:
    """List locally available Ollama models."""
    await _require_auth(authorization)
    models = await list_models()
    return {"models": models, "current": get_current_model()}


@app.post("/model/swap")
async def model_swap(req: ModelSwapRequest, authorization: str = Header(default="")) -> dict[str, Any]:
    """Pull a new model and hot-swap (satellite keeps running)."""
    await _require_auth(authorization)
    result = await swap_model(req.model)
    return result


@app.post("/configure")
async def configure(req: ConfigureRequest, authorization: str = Header(default="")) -> dict[str, Any]:
    """Apply configuration: name, role, model, governor thresholds."""
    await _require_auth(authorization)
    global SAT_NAME, SAT_ROLE

    if req.name:
        SAT_NAME = req.name
    if req.role:
        SAT_ROLE = req.role
    if req.model:
        set_current_model(req.model)
    if req.governor:
        governor.apply_config(req.governor)

    # Save updated config back to disk
    updated = _load_config()
    if req.name:
        updated["name"] = req.name
    if req.role:
        updated["role"] = req.role
    if req.model:
        updated["model"] = req.model
    if req.governor:
        updated["governor"] = req.governor
    try:
        _CONFIG_PATH.write_text(json.dumps(updated, indent=2), encoding="utf-8")
    except Exception as exc:
        logger.warning("[satellite_agent] Could not save config: %s", exc)

    return {
        "status": "configured",
        "name": SAT_NAME,
        "role": SAT_ROLE,
        "model": get_current_model(),
    }


# ─────────────────────────────────────────────────────────────────────────────
# WINDOWS SERVICE ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import sys
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    # Windows Service mode: python main.py install | start | stop | remove
    if len(sys.argv) > 1 and sys.argv[1] in ("install", "start", "stop", "remove", "restart"):
        try:
            import win32serviceutil

            class AURASatelliteService(win32serviceutil.ServiceFramework):
                _svc_name_         = "AURASatellite"
                _svc_display_name_ = "AURA Satellite Agent"
                _svc_description_  = "AURA satellite inference node on port 7779"

                def __init__(self, args):
                    win32serviceutil.ServiceFramework.__init__(self, args)
                    import win32event
                    self._stop_event = win32event.CreateEvent(None, 0, 0, None)
                    self._server = None

                def SvcStop(self):
                    import win32service, win32event
                    self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
                    win32event.SetEvent(self._stop_event)

                def SvcDoRun(self):
                    uvicorn.run(app, host="0.0.0.0", port=7779)

            win32serviceutil.HandleCommandLine(AURASatelliteService)
        except ImportError:
            print("pywin32 not available — cannot manage Windows Service")
            sys.exit(1)
    else:
        # Direct launch (dev/testing)
        uvicorn.run(app, host="0.0.0.0", port=7779)
