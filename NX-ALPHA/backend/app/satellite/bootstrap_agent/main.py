"""
AURA Bootstrap Agent — FastAPI service on port 7778

Temporary service installed on a target Windows machine before provisioning.
After provisioning completes, POST /upgrade replaces this with the full
AURA Satellite Agent on port 7779.

All endpoints except GET /health require Bearer token auth.
Token is single-use and expires after 24 hours.

Usage (standalone, NSSM-wrapped):
    python -m uvicorn app.satellite.bootstrap_agent.main:app --host 0.0.0.0 --port 7778
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import socket
import subprocess
import time
import zipfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from .installer import get_job_result, get_job_status, run_command, stream_job_output
from .system_info import get_system_info
from .token import TokenExpiredError, TokenInvalidError, TokenUsedError, validate_token

logger = logging.getLogger(__name__)

app = FastAPI(title="AURA Bootstrap Agent", version="1.0.0")

AURA_DATA_DIR = Path("C:/ProgramData/AURA")
SATELLITE_INSTALL_DIR = Path("C:/Program Files/AURA/SatelliteAgent")


# ─────────────────────────────────────────────────────────────────────────────
# AUTH
# ─────────────────────────────────────────────────────────────────────────────

async def _require_auth(authorization: str = Header(default="")) -> None:
    """Dependency: validate Bearer token."""
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    try:
        validate_token(token)
    except TokenExpiredError:
        raise HTTPException(status_code=401, detail="Token has expired")
    except TokenUsedError:
        raise HTTPException(status_code=401, detail="Token already used")
    except TokenInvalidError:
        raise HTTPException(status_code=401, detail="Invalid token")


# ─────────────────────────────────────────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────────────────────────────────────────

class InstallRequest(BaseModel):
    command: str


class PullModelRequest(BaseModel):
    model: str


class UpgradeRequest(BaseModel):
    aura_main_host: str
    aura_main_port: int = 8000
    sat_token: str
    sat_id: str = ""
    name: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health() -> dict[str, Any]:
    """Ping — no auth required. Used by AURA main to confirm bootstrap is live."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
    except Exception:
        ip = socket.gethostbyname(socket.gethostname())
    return {
        "status": "bootstrap",
        "hostname": socket.gethostname(),
        "ip": ip,
        "version": "1.0.0",
        "timestamp": time.time(),
    }


@app.get("/status")
async def status(authorization: str = Header(default="")) -> dict[str, Any]:
    """Full hardware assessment. Auth required."""
    await _require_auth(authorization)
    loop = asyncio.get_event_loop()
    info = await loop.run_in_executor(None, get_system_info)
    return info


@app.post("/install")
async def install(req: InstallRequest, authorization: str = Header(default="")) -> dict[str, str]:
    """Start an install command. Returns job_id for progress polling."""
    await _require_auth(authorization)
    if not req.command.strip():
        raise HTTPException(status_code=400, detail="Command cannot be empty")
    job_id = await run_command(req.command)
    return {"status": "started", "job_id": job_id}


@app.get("/progress")
async def progress(job_id: str, authorization: str = Header(default="")) -> StreamingResponse:
    """SSE stream of command output for a given job_id."""
    await _require_auth(authorization)
    if get_job_status(job_id) == "unknown":
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    return StreamingResponse(
        stream_job_output(job_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/job/{job_id}")
async def job_result(job_id: str, authorization: str = Header(default="")) -> dict[str, Any]:
    """Get final result of a completed job."""
    await _require_auth(authorization)
    result = get_job_result(job_id)
    if result["status"] == "unknown":
        raise HTTPException(status_code=404, detail=f"Unknown job: {job_id}")
    return result


@app.post("/pull_model")
async def pull_model(req: PullModelRequest, authorization: str = Header(default="")) -> dict[str, str]:
    """Pull an Ollama model. Streams progress via SSE on GET /progress?job_id=..."""
    await _require_auth(authorization)
    if not req.model.strip():
        raise HTTPException(status_code=400, detail="Model name cannot be empty")
    job_id = await run_command(f"ollama pull {req.model}")
    return {"status": "started", "job_id": job_id, "model": req.model}


@app.post("/upgrade")
async def upgrade(req: UpgradeRequest, authorization: str = Header(default="")) -> dict[str, Any]:
    """
    Download and install the full AURA Satellite Agent.
    Replaces this bootstrap service with AURASatellite on port 7779.
    """
    await _require_auth(authorization)

    try:
        import httpx
    except ImportError:
        raise HTTPException(status_code=500, detail="httpx not installed — cannot download agent package")

    # Write satellite config
    AURA_DATA_DIR.mkdir(parents=True, exist_ok=True)
    config = {
        "aura_main_host": req.aura_main_host,
        "aura_main_port": req.aura_main_port,
        "sat_token": req.sat_token,
        "sat_id": req.sat_id,
        "name": req.name or socket.gethostname(),
    }
    config_path = AURA_DATA_DIR / "satellite_config.json"
    config_path.write_text(json.dumps(config, indent=2), encoding="utf-8")
    logger.info("[bootstrap] Wrote satellite config to %s", config_path)

    # Download satellite agent package
    pkg_url = f"http://{req.aura_main_host}:{req.aura_main_port}/satellites/agent_package?type=satellite"
    zip_path = AURA_DATA_DIR / "satellite_agent.zip"
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.get(pkg_url)
            if resp.status_code != 200:
                raise HTTPException(status_code=502, detail=f"Agent package download failed: HTTP {resp.status_code}")
            zip_path.write_bytes(resp.content)
        logger.info("[bootstrap] Downloaded satellite agent package (%d bytes)", zip_path.stat().st_size)
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Could not reach AURA main: {exc}")

    # Extract
    SATELLITE_INSTALL_DIR.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(SATELLITE_INSTALL_DIR)
    logger.info("[bootstrap] Extracted satellite agent to %s", SATELLITE_INSTALL_DIR)

    # pip install requirements
    req_file = SATELLITE_INSTALL_DIR / "requirements_satellite.txt"
    if req_file.exists():
        job_id = await run_command(f"pip install -r \"{req_file}\"")
        # Wait for pip to finish (up to 3 minutes)
        for _ in range(180):
            if get_job_status(job_id) in ("done", "failed"):
                break
            await asyncio.sleep(1)

    # Install and start the satellite agent Windows Service
    installer_script = SATELLITE_INSTALL_DIR / "install_service.ps1"
    if installer_script.exists():
        job_id = await run_command(
            f"powershell -NoProfile -ExecutionPolicy Bypass -File \"{installer_script}\""
        )
        for _ in range(60):
            if get_job_status(job_id) in ("done", "failed"):
                break
            await asyncio.sleep(1)
    else:
        # Fallback: use NSSM if PowerShell installer not present
        main_py = SATELLITE_INSTALL_DIR / "main.py"
        await run_command(
            f"nssm install AURASatellite python \"{main_py}\""
        )
        await asyncio.sleep(2)
        await run_command("nssm start AURASatellite")

    logger.info("[bootstrap] Satellite agent installed and started")
    return {
        "status": "ok",
        "message": "Satellite agent installed and started on port 7779",
        "install_dir": str(SATELLITE_INSTALL_DIR),
    }


@app.post("/shutdown")
async def shutdown(authorization: str = Header(default="")) -> dict[str, str]:
    """Stop this bootstrap service. Called after upgrade completes."""
    await _require_auth(authorization)
    logger.info("[bootstrap] Shutdown requested — stopping bootstrap agent")

    async def _delayed_exit():
        await asyncio.sleep(2)
        os.kill(os.getpid(), 15)  # SIGTERM

    asyncio.create_task(_delayed_exit())
    return {"status": "ok", "message": "Bootstrap agent shutting down"}


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=7778)
