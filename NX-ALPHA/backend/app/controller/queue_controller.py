"""
AURA NX-Alpha — Task Queue Controller
REST endpoints for the task queue (hardware-limited mode).

Routes (prefix /queue):
    POST   /queue/task              — add a task to the queue
    GET    /queue/tasks             — list all tasks
    GET    /queue/tasks/pending     — list pending only
    DELETE /queue/task/{task_id}    — cancel a pending task
    GET    /queue/status            — hardware mode + pending count
"""

from __future__ import annotations

import logging
from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/queue", tags=["queue"])


class QueueTaskBody(BaseModel):
    task_text: str
    thread_id: str = "default"


@router.post("/task")
async def post_queue_task(body: QueueTaskBody):
    """Add a task to the queue for when the team pipeline becomes available."""
    from app.service.task_queue_service import get_task_queue_service
    svc = get_task_queue_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="Task queue not available")
    try:
        record = svc.queue_task(body.task_text, body.thread_id)
        logger.info("POST /queue/task — queued %s", record["task_id"])
        return record
    except Exception as exc:
        logger.exception("Queue task error: %s", exc)
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/tasks")
async def get_queue_tasks():
    """Return all tasks (all statuses), newest first."""
    from app.service.task_queue_service import get_task_queue_service
    svc = get_task_queue_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="Task queue not available")
    return svc.list_all(limit=100)


@router.get("/tasks/pending")
async def get_pending_tasks():
    """Return only pending tasks."""
    from app.service.task_queue_service import get_task_queue_service
    svc = get_task_queue_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="Task queue not available")
    return svc.list_pending()


@router.delete("/task/{task_id}")
async def delete_queue_task(task_id: str):
    """Cancel a pending task."""
    from app.service.task_queue_service import get_task_queue_service
    svc = get_task_queue_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="Task queue not available")
    cancelled = svc.cancel_task(task_id)
    if not cancelled:
        raise HTTPException(status_code=404, detail="Task not found or already completed")
    return {"cancelled": True, "task_id": task_id}


@router.get("/status")
async def get_queue_status():
    """Hardware mode + pending task count — used by frontend status indicators."""
    from app.service.hardware_gate import get_hardware_mode, get_vram_mb
    from app.service.task_queue_service import get_task_queue_service
    svc = get_task_queue_service()
    pending = svc.list_pending() if svc else []
    return {
        "hardware_mode": get_hardware_mode(),
        "vram_mb":       get_vram_mb(),
        "pending_count": len(pending),
    }
