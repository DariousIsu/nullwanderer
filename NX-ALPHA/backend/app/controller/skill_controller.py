"""
AURA NX-Alpha — Skill Controller
REST endpoints for listing, capturing, and managing procedural skills.

ROUTES:
    GET    /skills                      — list all (static + dynamic)
    GET    /skills/search?q=...         — FTS5 search over skills
    GET    /skills/{skill_id}           — get single skill with procedure_md
    POST   /skills/capture              — distill skill from thread {thread_id, title?}
    POST   /skills                      — manual create {title, description, procedure_md, tags?}
    DELETE /skills/{skill_id}           — delete dynamic skill (static protected)
    POST   /skills/{skill_id}/export    — export to ~/.aura/skills/<title>.md
"""

import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from typing import Optional, List

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/skills", tags=["skills"])


def _svc():
    from app.service.skill_capture_service import get_skill_capture_service
    svc = get_skill_capture_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="Skill capture service not initialized")
    return svc


class CaptureRequest(BaseModel):
    thread_id: str
    title: Optional[str] = None
    tags: Optional[List[str]] = None


class CreateSkillRequest(BaseModel):
    title: str
    description: str
    procedure_md: str
    tags: Optional[List[str]] = None


class ExportRequest(BaseModel):
    export_dir: str = "~/.aura/skills/"


@router.get("")
async def list_skills():
    """List all skills — static (built-in) + dynamic (captured)."""
    return {"skills": _svc().list_skills()}


@router.get("/search")
async def search_skills(
    q: str = Query(..., description="Search query"),
    limit: int = Query(default=10, ge=1, le=50),
):
    """FTS5 keyword search over skill titles, descriptions, and procedures."""
    return {"query": q, "results": _svc().search_skills(q, limit=limit)}


@router.get("/{skill_id}")
async def get_skill(skill_id: str):
    """Return a single skill with full procedure_md."""
    skill = _svc().get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    return skill


@router.post("/capture")
async def capture_skill(body: CaptureRequest):
    """
    Distill a conversation thread into a reusable skill via the workhorse model.
    Returns the saved skill dict.
    """
    try:
        skill = await _svc().capture_from_thread(
            thread_id=body.thread_id,
            title=body.title,
            tags=body.tags,
        )
        return skill
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.warning("[skill_controller] capture error: %s", exc)
        raise HTTPException(status_code=500, detail="Skill capture failed")


@router.post("")
async def create_skill(body: CreateSkillRequest):
    """Manually create and save a skill."""
    skill = _svc().save_skill(
        title=body.title,
        description=body.description,
        procedure_md=body.procedure_md,
        tags=body.tags,
        source_type="manual",
    )
    return skill


@router.delete("/{skill_id}")
async def delete_skill(skill_id: str):
    """Delete a dynamic skill. Static built-in skills cannot be deleted."""
    removed = _svc().delete_skill(skill_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Skill not found or is a static built-in")
    return {"ok": True}


@router.post("/{skill_id}/export")
async def export_skill(skill_id: str, body: ExportRequest = ExportRequest()):
    """Export a skill as a markdown file to ~/.aura/skills/ (or custom dir)."""
    try:
        path = _svc().export_to_file(skill_id, export_dir=body.export_dir)
        return {"ok": True, "path": path}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        logger.warning("[skill_controller] export error: %s", exc)
        raise HTTPException(status_code=500, detail="Export failed")
