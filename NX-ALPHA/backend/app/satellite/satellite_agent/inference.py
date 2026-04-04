"""
AURA Satellite Agent — Inference Proxy

Proxies inference requests to the local Ollama instance (port 11434).
Enforces the local hardware governor before dispatching.
Tracks active request count for queue depth enforcement.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

from . import governor

logger = logging.getLogger(__name__)

OLLAMA_BASE = "http://localhost:11434"

try:
    import httpx
    _HTTPX = True
except ImportError:
    _HTTPX = False
    logger.warning("[inference] httpx not available — inference will fail")

# Module-level current model (updated by swap_model)
_current_model: str = ""


def set_current_model(model: str) -> None:
    global _current_model
    _current_model = model


def get_current_model() -> str:
    return _current_model


# ─────────────────────────────────────────────────────────────────────────────
# QUERY
# ─────────────────────────────────────────────────────────────────────────────

async def run_query(
    prompt: str,
    model: str = "",
    max_tokens: int = 2048,
    temperature: float = 0.7,
) -> dict[str, Any]:
    """
    Run inference via local Ollama. Returns {response, model, duration_ms}.
    Raises HTTPException 503 if governor blocks the request.
    """
    from fastapi import HTTPException

    if not _HTTPX:
        raise HTTPException(status_code=500, detail="httpx not installed")

    # Governor check
    from .health import get_health_metrics
    metrics = get_health_metrics()
    allowed, reason = governor.check_and_enforce(metrics)
    if not allowed:
        raise HTTPException(status_code=503, detail=f"Governor blocked: {reason}")

    target_model = model or _current_model
    if not target_model:
        raise HTTPException(status_code=400, detail="No model specified and no current model set")

    governor.increment_requests()
    t0 = time.time()
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/generate",
                json={
                    "model": target_model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "num_predict": max_tokens,
                        "temperature": temperature,
                    },
                },
            )
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"Ollama returned HTTP {resp.status_code}",
                )
            data = resp.json()
            return {
                "response": data.get("response", ""),
                "model": target_model,
                "duration_ms": round((time.time() - t0) * 1000),
                "done": data.get("done", True),
            }
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"Ollama unreachable: {exc}")
    finally:
        governor.decrement_requests()


# ─────────────────────────────────────────────────────────────────────────────
# MODEL MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

async def list_models() -> list[str]:
    """Return locally available Ollama model names."""
    if not _HTTPX:
        return []
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{OLLAMA_BASE}/api/tags")
            if resp.status_code == 200:
                data = resp.json()
                return [m["name"] for m in data.get("models", [])]
    except Exception as exc:
        logger.warning("[inference] list_models failed: %s", exc)
    return []


async def swap_model(model: str) -> dict[str, Any]:
    """
    Pull a new model and hot-swap. Keeps the service running.
    Uses a background asyncio pull (streams to Ollama's streaming pull endpoint).
    """
    global _current_model
    if not _HTTPX:
        return {"status": "failed", "detail": "httpx not installed"}

    logger.info("[inference] Starting model swap to: %s", model)
    try:
        async with httpx.AsyncClient(timeout=300.0) as client:
            resp = await client.post(
                f"{OLLAMA_BASE}/api/pull",
                json={"name": model, "stream": False},
            )
            if resp.status_code == 200:
                _current_model = model
                logger.info("[inference] Model swapped to: %s", model)
                return {"status": "ok", "model": model}
            return {"status": "failed", "detail": f"Ollama HTTP {resp.status_code}"}
    except Exception as exc:
        logger.error("[inference] swap_model failed: %s", exc)
        return {"status": "failed", "detail": str(exc)}
