"""
AURA NX-Alpha — Adversarial Trainer Controller

REST endpoints for the native Windows adversarial training loop.

ENDPOINTS:
    POST /adversarial-trainer/start   — Start a training session
    POST /adversarial-trainer/stop    — Stop the running session
    GET  /adversarial-trainer/status  — Current session progress
    GET  /adversarial-trainer/stats   — Aggregate stats from training_candidates
"""

import logging

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.service.adversarial_trainer import AdversarialConfig, get_trainer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/adversarial-trainer", tags=["adversarial-trainer"])


# ─────────────────────────────────────────────────────────────────────────────
# REQUEST MODELS
# ─────────────────────────────────────────────────────────────────────────────

class StartRequest(BaseModel):
    dataset_id: str              = Field(..., description="HuggingFace dataset ID, e.g. 'tatsu-lab/alpaca'")
    dataset_split: str           = Field("train", description="Dataset split (auto-fallback if unavailable)")
    dataset_config: str | None   = Field(None, description="HF dataset config name, e.g. 'math' for PersonaHub")
    dataset_prompt_col: str | None  = Field(None, description="Column for prompts (auto-detect if null)")
    dataset_response_col: str | None = Field(None, description="Column for responses (auto-detect if null)")
    max_samples: int             = Field(100, ge=1, le=10000)
    interval_minutes: float      = Field(5.0, ge=0.0, description="Sleep between turns (minutes)")
    judge_threshold: int         = Field(6, ge=1, le=10, description="Min score to approve a pair")
    workhorse_model: str | None  = Field(None, description="Ollama model override (null = use default)")
    tool_ids: list[str]          = Field(default_factory=list, description="Optional: link session to MCP tool(s) for targeted dataset building")


# ─────────────────────────────────────────────────────────────────────────────
# ENDPOINTS
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/start")
async def start_trainer(body: StartRequest) -> dict:
    """Launch the adversarial training loop as a background asyncio task."""
    config = AdversarialConfig(
        dataset_id=body.dataset_id,
        dataset_split=body.dataset_split,
        dataset_config=body.dataset_config,
        dataset_prompt_col=body.dataset_prompt_col,
        dataset_response_col=body.dataset_response_col,
        max_samples=body.max_samples,
        interval_minutes=body.interval_minutes,
        judge_threshold=body.judge_threshold,
        workhorse_model=body.workhorse_model,
        tool_ids=body.tool_ids,
    )
    trainer = get_trainer()
    return await trainer.start(config)


@router.post("/stop")
async def stop_trainer() -> dict:
    """Cancel the running training loop."""
    trainer = get_trainer()
    return await trainer.stop()


@router.get("/status")
async def trainer_status() -> dict:
    """Return current session progress."""
    return get_trainer().get_status()


@router.get("/stats")
async def trainer_stats() -> dict:
    """Return aggregate stats from training_candidates table."""
    return get_trainer().get_stats()


@router.get("/datasets")
async def trainer_datasets() -> list:
    """Return all known datasets with bookmark, total_samples_done, and pct_complete."""
    return get_trainer().list_datasets()


class QueueItem(BaseModel):
    dataset_id: str
    dataset_split: str                  = Field("train")
    dataset_config: str | None          = Field(None)
    dataset_prompt_col: str | None      = Field(None)
    dataset_response_col: str | None    = Field(None)
    max_samples: int                    = Field(100, ge=1, le=10000)
    interval_minutes: float             = Field(5.0, ge=0.0)
    judge_threshold: int                = Field(6, ge=1, le=10)
    workhorse_model: str | None         = Field(None)


class QueueRequest(BaseModel):
    datasets: list[QueueItem] = Field(..., min_length=1)


@router.post("/queue")
async def queue_trainer(body: QueueRequest) -> dict:
    """
    Enqueue multiple datasets for sequential training.
    Each dataset runs to completion before the next starts.
    Stops the queue cleanly via POST /stop.
    """
    configs = [
        AdversarialConfig(
            dataset_id=item.dataset_id,
            dataset_split=item.dataset_split,
            dataset_config=item.dataset_config,
            dataset_prompt_col=item.dataset_prompt_col,
            dataset_response_col=item.dataset_response_col,
            max_samples=item.max_samples,
            interval_minutes=item.interval_minutes,
            judge_threshold=item.judge_threshold,
            workhorse_model=item.workhorse_model,
        )
        for item in body.datasets
    ]
    return await get_trainer().queue(configs)


@router.get("/queue")
async def queue_status() -> dict:
    """Return queue progress: current position, remaining, completed, failed."""
    return get_trainer().get_queue_status()


class RerunRequest(BaseModel):
    dataset_keys: list[str] = Field(..., min_length=1,
                                    description="Keys from GET /datasets (format: dataset_id|config|split)")
    max_samples_override: int | None = Field(None, ge=1, le=10000,
                                             description="Override max_samples for all datasets in this rerun")


@router.post("/queue/append")
async def append_queue(body: QueueRequest) -> dict:
    """
    Append datasets to the queue while a session is already running.
    Entries are picked up automatically as each dataset completes.
    """
    configs = [
        AdversarialConfig(
            dataset_id=item.dataset_id,
            dataset_split=item.dataset_split,
            dataset_config=item.dataset_config,
            dataset_prompt_col=item.dataset_prompt_col,
            dataset_response_col=item.dataset_response_col,
            max_samples=item.max_samples,
            interval_minutes=item.interval_minutes,
            judge_threshold=item.judge_threshold,
            workhorse_model=item.workhorse_model,
        )
        for item in body.datasets
    ]
    return get_trainer().append_to_queue(configs)


@router.post("/rerun")
async def rerun_datasets(body: RerunRequest) -> dict:
    """
    Re-run previously executed datasets by their registry keys.
    Resets bookmarks and queues them sequentially.
    GET /adversarial-trainer/datasets to retrieve dataset_keys.
    """
    return await get_trainer().rerun_datasets(
        body.dataset_keys,
        max_samples_override=body.max_samples_override,
    )
