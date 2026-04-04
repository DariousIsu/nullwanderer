"""
AURA NX-Alpha — Eval Controller

REST endpoints for the Phoenix trace → eval baseline pipeline.

ENDPOINTS:
    POST /eval/run          — start eval run (export + curate + score + report)
    POST /eval/stop         — stop a running eval
    GET  /eval/status       — running/idle, progress counts
    GET  /eval/report       — latest baseline_report.json
    GET  /eval/golden-set   — golden_set.jsonl entries (multi-turn chat format)
"""

import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.service.eval_runner import EvalConfig, get_eval_runner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/eval", tags=["eval"])


# ─────────────────────────────────────────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────────────────────────────────────────

class RunRequest(BaseModel):
    judge_threshold: int  = Field(6, ge=1, le=10,
                                   description="Min Workhorse score to count as a win (1-10)")
    max_per_tier: int     = Field(500, ge=10, le=5000,
                                   description="Max records per routing tier in curated eval set")


# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/run")
async def run_eval(body: RunRequest) -> dict:
    """
    Start the eval pipeline as a background asyncio task.
    Pipeline: Phoenix export → curation → Interface Engine scoring →
              Workhorse judging → baseline_report.json + golden_set.jsonl
    SSE events are emitted on the main stream throughout.
    """
    config = EvalConfig(
        judge_threshold=body.judge_threshold,
        max_per_tier=body.max_per_tier,
    )
    runner = get_eval_runner()
    return await runner.start(config)


@router.post("/stop")
async def stop_eval() -> dict:
    """Cancel a running eval."""
    return await get_eval_runner().stop()


@router.get("/status")
async def eval_status() -> dict:
    """Return current eval progress."""
    return get_eval_runner().get_status()


@router.get("/report")
async def eval_report() -> dict:
    """
    Return the latest baseline_report.json.
    Returns {"available": false} if no report has been generated yet.
    """
    try:
        from app.training.baseline_report import load_report
        report = load_report()
        if report is None:
            return {"available": False}
        return {"available": True, **report}
    except Exception as exc:
        logger.warning("[eval_controller] report load failed: %s", exc)
        return {"available": False, "error": str(exc)}


@router.get("/golden-set")
async def eval_golden_set() -> dict:
    """
    Return all golden_set.jsonl entries.
    Each entry: {"messages": [...], "quality_signal": float}
    """
    try:
        from app.training.baseline_report import load_golden_set
        entries = load_golden_set()
        return {"count": len(entries), "entries": entries}
    except Exception as exc:
        logger.warning("[eval_controller] golden_set load failed: %s", exc)
        return {"count": 0, "entries": [], "error": str(exc)}
