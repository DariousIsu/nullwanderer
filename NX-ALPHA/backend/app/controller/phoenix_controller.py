"""
AURA NX-Alpha — Phoenix Observability Controller
REST API for managing Arize Phoenix tracing configuration and statistics.

ROUTES:
    GET    /phoenix/config    — get current Phoenix host + tracing toggle
    PUT    /phoenix/config    — save Phoenix host + tracing toggle
    GET    /phoenix/status    — ping Phoenix server, return connectivity info
    GET    /phoenix/stats     — routing trace statistics aggregated from Phoenix API
    DELETE /phoenix/traces    — clear all traces from the default Phoenix project
    POST   /phoenix/launch    — start Phoenix via Docker or pip subprocess
"""

import json
import logging
from pathlib import Path
from typing import Optional

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(tags=["phoenix"])

_CONFIG_PATH = Path.home() / ".aura" / "phoenix_config.json"
_DEFAULT_CONFIG: dict = {
    "host": "http://localhost:6006",
    "tracing_enabled": False,
}


# ─────────────────────────────────────────────────────────────────────────────
# INTERNAL HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _load_config() -> dict:
    try:
        if _CONFIG_PATH.exists():
            return {**_DEFAULT_CONFIG, **json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))}
    except Exception:
        pass
    return dict(_DEFAULT_CONFIG)


def _save_config(cfg: dict) -> None:
    _CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    _CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def _span_attr(span: dict, key: str) -> str:
    """Safely extract a string attribute from a Phoenix span object."""
    attrs = span.get("attributes", {})
    return str(attrs.get(key, ""))


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/phoenix/config")
async def get_phoenix_config() -> dict:
    """Return current Phoenix server config."""
    return _load_config()


class PhoenixConfigBody(BaseModel):
    host: Optional[str] = None
    tracing_enabled: Optional[bool] = None


@router.put("/phoenix/config")
async def set_phoenix_config(body: PhoenixConfigBody) -> dict:
    """Persist Phoenix host URL and tracing toggle."""
    cfg = _load_config()
    if body.host is not None:
        cfg["host"] = body.host.rstrip("/")
    if body.tracing_enabled is not None:
        cfg["tracing_enabled"] = body.tracing_enabled
    _save_config(cfg)
    return {"ok": True, **cfg}


# ─────────────────────────────────────────────────────────────────────────────
# STATUS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/phoenix/status")
async def get_phoenix_status() -> dict:
    """
    Ping the configured Phoenix server.
    Returns reachability, version (if available), and project count.
    """
    cfg = _load_config()
    host = cfg["host"]

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            r = await client.get(f"{host}/healthz")
            if r.status_code == 200:
                project_count = 0
                try:
                    pr = await client.get(f"{host}/v1/projects")
                    if pr.status_code == 200:
                        project_count = len(pr.json().get("data", []))
                except Exception:
                    pass

                return {
                    "reachable": True,
                    "host": host,
                    "project_count": project_count,
                    "tracing_enabled": cfg["tracing_enabled"],
                }
    except Exception as exc:
        logger.debug("[phoenix] unreachable at %s: %s", host, exc)

    return {
        "reachable": False,
        "host": host,
        "project_count": 0,
        "tracing_enabled": cfg["tracing_enabled"],
    }


# ─────────────────────────────────────────────────────────────────────────────
# STATS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/phoenix/stats")
async def get_phoenix_stats() -> dict:
    """
    Aggregate routing trace statistics from Phoenix spans named 'routing_classify'.
    Returns zeros with available=False when Phoenix is unreachable or has no data.
    """
    cfg = _load_config()
    host = cfg["host"]

    empty = {
        "total_traces": 0,
        "solo_count": 0,
        "team_count": 0,
        "tier_semantic": 0,
        "tier_llm": 0,
        "tier_keyword": 0,
        "tier_default": 0,
        "disagreements": 0,
        "available": False,
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            pr = await client.get(f"{host}/v1/projects")
            if pr.status_code != 200:
                return empty

            projects = pr.json().get("data", [])
            if not projects:
                return {**empty, "available": True}

            project_id = projects[0]["id"]

            sp = await client.get(
                f"{host}/v1/spans",
                params={
                    "project_id": project_id,
                    "limit": 1000,
                },
            )
            if sp.status_code != 200:
                return {**empty, "available": True}

            all_spans = sp.json().get("data", [])
            spans = [s for s in all_spans if s.get("name") == "routing_classify"]

            return {
                "total_traces":  len(spans),
                "solo_count":    sum(1 for s in spans if _span_attr(s, "route") == "solo"),
                "team_count":    sum(1 for s in spans if _span_attr(s, "route") == "team"),
                "tier_semantic": sum(1 for s in spans if _span_attr(s, "tier") == "semantic"),
                "tier_llm":      sum(1 for s in spans if _span_attr(s, "tier") == "llm"),
                "tier_keyword":  sum(1 for s in spans if _span_attr(s, "tier") == "keyword"),
                "tier_default":  sum(1 for s in spans if _span_attr(s, "tier") == "default_fallback"),
                "disagreements": sum(1 for s in spans if _span_attr(s, "tier_disagreement") == "true"),
                "available":     True,
            }

    except Exception as exc:
        logger.debug("[phoenix] stats error: %s", exc)
        return empty


# ─────────────────────────────────────────────────────────────────────────────
# CLEAR TRACES
# ─────────────────────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────────────────────
# LAUNCH
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/phoenix/launch")
async def launch_phoenix() -> dict:
    """
    Start Phoenix via Docker (preferred) or pip subprocess (fallback).
    Returns immediately — frontend polls /phoenix/status for readiness.
    """
    import subprocess
    import sys

    cfg = _load_config()
    host = cfg["host"]

    # Already running?
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{host}/healthz")
            if r.status_code == 200:
                return {"launched": True, "method": "already_running"}
    except Exception:
        pass

    # Try Docker — start existing container first, then run new one
    try:
        r = subprocess.run(["docker", "start", "phoenix"], capture_output=True, timeout=10)
        if r.returncode == 0:
            logger.info("[phoenix] Started existing Docker container 'phoenix'")
            return {"launched": True, "method": "docker_start"}

        r = subprocess.run(
            ["docker", "run", "-d", "--name", "phoenix", "-p", "6006:6006", "arizephoenix/phoenix:latest"],
            capture_output=True, timeout=30,
        )
        if r.returncode == 0:
            logger.info("[phoenix] Started new Docker container 'phoenix'")
            return {"launched": True, "method": "docker_run"}
        logger.warning("[phoenix] docker launch failed: %s", r.stderr.decode(errors="replace"))
    except FileNotFoundError:
        logger.debug("[phoenix] docker not found, trying pip fallback")
    except Exception as exc:
        logger.warning("[phoenix] docker error: %s", exc)

    # Fallback: pip phoenix subprocess (detached)
    try:
        kwargs: dict = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        else:
            kwargs["start_new_session"] = True
        subprocess.Popen(
            [sys.executable, "-m", "phoenix.server.main", "--port", "6006"],
            **kwargs,
        )
        logger.info("[phoenix] Started via pip subprocess")
        return {"launched": True, "method": "pip_subprocess"}
    except Exception as exc:
        logger.warning("[phoenix] pip launch failed: %s", exc)

    return {"launched": False, "method": "failed"}


# ─────────────────────────────────────────────────────────────────────────────
# CLEAR TRACES
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/phoenix/traces")
async def clear_phoenix_traces() -> dict:
    """Clear all traces from the default Phoenix project."""
    cfg = _load_config()
    host = cfg["host"]

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            pr = await client.get(f"{host}/v1/projects")
            if pr.status_code != 200:
                return {"cleared": False, "message": "Phoenix unreachable"}

            projects = pr.json().get("data", [])
            if not projects:
                return {"cleared": True, "message": "No projects found"}

            project_id = projects[0]["id"]
            dr = await client.delete(f"{host}/v1/projects/{project_id}/traces")
            return {"cleared": dr.status_code < 300}

    except Exception as exc:
        logger.warning("[phoenix] clear_traces error: %s", exc)
        return {"cleared": False, "message": str(exc)}
