"""
AURA NX-Alpha — Legislation Controller

REST API for the 50-state legislation database.

ROUTES:
    GET  /legislation/import/status
    POST /legislation/import/start
    GET  /legislation/states
    GET  /legislation/states/{code}/sessions
    GET  /legislation/states/{code}/bills
    GET  /legislation/states/{code}/bills/{bill_id}
    GET  /legislation/search
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.service.legislation_service import get_legislation_service
from app.service.leg_db_importer import run_import

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/legislation", tags=["legislation"])

# Tracks the running import task so we can report status and prevent double-starts
_import_task: Optional[asyncio.Task] = None
_import_progress: dict = {"running": False, "completed": 0, "total": 0, "pct": 0, "current_zip": ""}


# ── Import ────────────────────────────────────────────────────────────────────

class ImportStartRequest(BaseModel):
    force: bool = False


@router.get("/import/status")
async def import_status():
    """Return current import progress and database stats."""
    svc = get_legislation_service()
    db_status = svc.get_import_status()
    return {
        **db_status,
        "running": _import_task is not None and not _import_task.done(),
        "progress": _import_progress,
    }


@router.post("/import/start")
async def import_start(body: ImportStartRequest = ImportStartRequest()):
    """
    Trigger legislation database import as a background task.
    Returns immediately. Poll /import/status for progress.
    Pass force=true to wipe and reimport from scratch.
    """
    global _import_task, _import_progress

    if _import_task and not _import_task.done():
        return {"status": "already_running", "message": "Import already in progress"}

    async def _emit(event: str, data: dict) -> None:
        global _import_progress
        if event == "leg_import_progress":
            _import_progress = {
                "running": True,
                "completed": data.get("completed", 0),
                "total": data.get("total", 0),
                "pct": data.get("pct", 0),
                "current_zip": data.get("current_zip", ""),
            }

    async def _run():
        global _import_progress
        _import_progress = {"running": True, "completed": 0, "total": 0, "pct": 0, "current_zip": ""}
        try:
            await run_import(emit_fn=_emit, force=body.force)
        except Exception as exc:
            logger.error("[legislation] Import task failed: %s", exc)
        finally:
            _import_progress["running"] = False

    _import_task = asyncio.create_task(_run())
    return {"status": "started", "force": body.force}


# ── States ────────────────────────────────────────────────────────────────────

@router.get("/states")
async def list_states():
    """List all states with imported data."""
    svc = get_legislation_service()
    return {"states": svc.get_states()}


@router.get("/states/{code}/sessions")
async def list_sessions(code: str):
    """List all legislative sessions for a state."""
    svc = get_legislation_service()
    sessions = svc.get_sessions(code)
    if not sessions:
        raise HTTPException(status_code=404, detail=f"No sessions found for {code.upper()}")
    return {"sessions": sessions}


# ── Bills ─────────────────────────────────────────────────────────────────────

@router.get("/states/{code}/bills")
async def list_bills(
    code: str,
    chamber: Optional[str] = Query(None, description="house | senate | joint"),
    status: Optional[str] = Query(None, description="active | pending | passed | dropped"),
    session_id: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """
    List bills for a state with optional chamber/status/session filters.
    Results are sorted by last_action_date DESC.
    """
    svc = get_legislation_service()
    bills = svc.get_state_bills(
        state_code=code,
        chamber=chamber,
        status=status,
        session_id=session_id,
        limit=limit,
        offset=offset,
    )
    total = svc.count_bills(state_code=code, chamber=chamber, status=status)
    return {"bills": bills, "total": total, "limit": limit, "offset": offset}


@router.get("/states/{code}/bills/{bill_id:path}")
async def get_bill(code: str, bill_id: str):
    """
    Return a single bill with all related records (actions, sponsors, sources, versions).
    bill_id is the full OCD ID, e.g. ocd-bill/...
    """
    svc = get_legislation_service()
    bill = svc.get_bill(bill_id)
    if not bill:
        raise HTTPException(status_code=404, detail=f"Bill {bill_id!r} not found")
    if bill.get("state_code", "").upper() != code.upper():
        raise HTTPException(status_code=404, detail="Bill not found in this state")
    return bill


# ── AI Commentary ─────────────────────────────────────────────────────────────

@router.post("/states/{code}/bills/{bill_id:path}/commentary")
async def get_bill_commentary(
    code: str,
    bill_id: str,
    context: str = Query("personal", description="personal | client"),
):
    """
    Stream AI commentary on a bill via SSE.
    AURA analyzes the bill text, fiscal impact, political context, and likely trajectory.
    context='client' frames analysis for Gleipnir consulting work.
    context='personal' frames for personal research.
    """
    svc = get_legislation_service()
    bill = svc.get_bill(bill_id)
    if not bill:
        raise HTTPException(status_code=404, detail=f"Bill {bill_id!r} not found")
    if bill.get("state_code", "").upper() != code.upper():
        raise HTTPException(status_code=404, detail="Bill not found in this state")

    context_note = (
        "from the perspective of a political consulting firm advising clients on regulatory impact"
        if context == "client"
        else "from the perspective of a policy researcher tracking legislative trends"
    )

    sponsors = bill.get("sponsors", [])
    primary = next((s["name"] for s in sponsors if s.get("primary_sponsor")), "Unknown")
    co_sponsors = [s["name"] for s in sponsors if not s.get("primary_sponsor")][:5]
    actions = bill.get("actions", [])
    recent_actions = "\n".join(
        f"  {a['date']}: {a['description']}" for a in actions[-5:]
    )

    prompt = (
        f"Analyze the following bill {context_note}.\n\n"
        f"State: {code.upper()}\n"
        f"Identifier: {bill.get('identifier', '')}\n"
        f"Title: {bill.get('title', '')}\n"
        f"Chamber: {bill.get('chamber', '')}\n"
        f"Status: {bill.get('status', '')}\n"
        f"Primary Sponsor: {primary}\n"
        f"Co-Sponsors: {', '.join(co_sponsors) or 'None listed'}\n"
        f"Subjects: {bill.get('subjects', '[]')}\n"
        f"Abstract: {bill.get('abstract') or 'Not available'}\n"
        f"Recent Actions:\n{recent_actions or '  None recorded'}\n\n"
        f"Provide commentary covering: what the bill does, likely fiscal impact, "
        f"political context and stakeholders, and probable trajectory."
    )

    async def _stream():
        import json
        try:
            from app.service.interface_engine import get_engine
            engine = get_engine()
            if engine is None:
                yield f"data: {json.dumps({'token': '[Interface engine unavailable]'})}\n\n"
                yield "data: {\"done\": true}\n\n"
                return

            messages = [{"role": "user", "content": prompt}]
            async for chunk in engine.generate_streaming(messages, max_tokens=768, temperature=0.65):
                yield f"data: {json.dumps({'token': chunk})}\n\n"

            yield "data: {\"done\": true}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
            yield "data: {\"done\": true}\n\n"

    return StreamingResponse(_stream(), media_type="text/event-stream")


# ── Deep Research ─────────────────────────────────────────────────────────────

@router.post("/states/{code}/bills/{bill_id:path}/deep-research")
async def deep_research_bill(
    code: str,
    bill_id: str,
    context: str = Query("personal", description="personal | client"),
):
    """
    Inject a deep research request for a bill into the main chat pipeline.
    The interface agent handles it like any other message — tools, team, canvas.
    Returns 202; results stream via the main /stream SSE connection.
    """
    svc = get_legislation_service()
    bill = svc.get_bill(bill_id)
    if not bill:
        raise HTTPException(status_code=404, detail=f"Bill {bill_id!r} not found")
    if bill.get("state_code", "").upper() != code.upper():
        raise HTTPException(status_code=404, detail="Bill not found in this state")

    context_note = (
        "from a consulting/client-advisory angle — focus on regulatory impact, stakeholder positions, and actionable recommendations"
        if context == "client"
        else "from a policy research angle — focus on legislative history, precedent, fiscal analysis, and political dynamics"
    )

    message = (
        f"Deep research brief on {code.upper()} {bill.get('identifier', '')} — "
        f"{bill.get('title', 'Untitled')}.\n\n"
        f"Analyze this bill {context_note}. Cover: what the bill does in plain language, "
        f"fiscal and economic impact, primary stakeholders and their positions, "
        f"political context and sponsor motivations, similar legislation in other states, "
        f"and the probable trajectory. Surface any conflicts, amendments, or opposition. "
        f"Present a structured research summary on canvas."
    )

    from app.controller.chat_controller import _pipeline_response, _get_session_thread_id
    thread_id = _get_session_thread_id()
    asyncio.create_task(_pipeline_response(message, thread_id))

    return {"status": "accepted", "thread_id": thread_id}


# ── Search ────────────────────────────────────────────────────────────────────

@router.get("/search")
async def search_bills(
    q: str = Query(..., min_length=2, description="Full-text search query"),
    state: Optional[str] = Query(None, description="Filter to a single state code"),
    chamber: Optional[str] = Query(None),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
):
    """
    Full-text search across all bills (identifier, title, subjects, abstract).
    Powered by SQLite FTS5. Returns ranked results.
    """
    svc = get_legislation_service()
    results = svc.search_bills(
        query=q,
        state=state,
        chamber=chamber,
        status=status,
        limit=limit,
    )
    return {"results": results, "count": len(results), "query": q}


# ── Monitoring Profiles ───────────────────────────────────────────────────────

class CreateProfileRequest(BaseModel):
    name: str
    description: str = ""


class AddTopicRequest(BaseModel):
    topic_name: str
    keywords: list[str]


class AddStateRequest(BaseModel):
    state_code: str


class UpdateTopicRequest(BaseModel):
    keywords: list[str]


@router.post("/profiles")
async def create_profile(body: CreateProfileRequest):
    """Create a personal monitoring profile."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    try:
        profile = mon.create_profile(body.name, body.description)
        return profile
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))


@router.get("/profiles")
async def list_profiles():
    """List all monitoring profiles with their topics and states."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    return {"profiles": mon.list_profiles()}


@router.get("/profiles/{profile_id}")
async def get_profile(profile_id: str):
    """Get a single profile by ID or name."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    profile = mon.get_profile(profile_id)
    if not profile:
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")
    return profile


@router.delete("/profiles/{profile_id}")
async def delete_profile(profile_id: str):
    """Delete a profile and all associated topics/alerts."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    deleted = mon.delete_profile(profile_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")
    return {"deleted": True, "profile_id": profile_id}


@router.post("/profiles/{profile_id}/topics")
async def add_topic(profile_id: str, body: AddTopicRequest):
    """Add a topic with keywords to a profile."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    if not mon.get_profile(profile_id):
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")
    topic = mon.add_topic(profile_id, body.topic_name, body.keywords)
    return topic


@router.delete("/profiles/{profile_id}/topics/{topic_id}")
async def remove_topic(profile_id: str, topic_id: str):
    """Remove a topic from a profile."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    removed = mon.remove_topic(topic_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Topic '{topic_id}' not found")
    return {"removed": True, "topic_id": topic_id}


@router.put("/profiles/{profile_id}/topics/{topic_id}")
async def update_topic(profile_id: str, topic_id: str, body: UpdateTopicRequest):
    """Update keywords for a topic."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    updated = mon.update_topic_keywords(topic_id, body.keywords)
    if not updated:
        raise HTTPException(status_code=404, detail=f"Topic '{topic_id}' not found")
    return {"updated": True, "topic_id": topic_id}


@router.post("/profiles/{profile_id}/states")
async def add_state(profile_id: str, body: AddStateRequest):
    """Add a state to a profile's watchlist."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    if not mon.get_profile(profile_id):
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")
    mon.add_state(profile_id, body.state_code)
    return {"added": True, "state_code": body.state_code.upper()}


@router.delete("/profiles/{profile_id}/states/{state_code}")
async def remove_state(profile_id: str, state_code: str):
    """Remove a state from a profile's watchlist."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    removed = mon.remove_state(profile_id, state_code)
    return {"removed": removed, "state_code": state_code.upper()}


@router.get("/profiles/{profile_id}/alerts")
async def get_alerts(profile_id: str):
    """Return undelivered alerts for a profile."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    if not mon.get_profile(profile_id):
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")
    alerts = mon.get_undelivered_alerts(profile_id)
    summary = mon.get_profile_summary(profile_id)
    return {"alerts": alerts, "summary": summary}


@router.post("/profiles/{profile_id}/brief")
async def generate_brief(
    profile_id: str,
    days_back: int = Query(7, ge=1, le=90),
):
    """
    Generate a legislative brief for a profile via the main SSE stream.
    Results appear as a canvas document block on the active session.
    Returns 202; results stream via /stream SSE connection.
    """
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    if not mon.get_profile(profile_id):
        raise HTTPException(status_code=404, detail=f"Profile '{profile_id}' not found")

    async def _run():
        from app.controller.chat_controller import _emit
        from app.service.leg_report_service import generate_brief as _generate
        try:
            result = await _generate(profile_id, emit_fn=_emit, days_back=days_back)
            await _emit("token", {"text": f"\n\nBrief generated: {result.get('alert_count', 0)} alerts across {len(result.get('sections', []))} sections."})
            await _emit("end", {})
        except Exception as exc:
            logger.error("[legislation] Brief generation failed: %s", exc)

    asyncio.create_task(_run())
    return {"status": "generating", "profile_id": profile_id, "days_back": days_back}


# ── Sync ──────────────────────────────────────────────────────────────────────

class SyncRequest(BaseModel):
    states: Optional[list[str]] = None
    profile_id: Optional[str] = None


_sync_task: Optional[asyncio.Task] = None
_sync_status: dict = {"running": False, "last_result": None}


@router.post("/sync")
async def trigger_sync(body: SyncRequest = SyncRequest()):
    """
    Trigger a manual daily update pull from OpenStates/Congress APIs.
    Runs in background; poll /sync/status for progress.
    """
    global _sync_task, _sync_status

    if _sync_task and not _sync_task.done():
        return {"status": "already_running"}

    async def _run():
        global _sync_status
        _sync_status = {"running": True, "last_result": None}
        try:
            from app.service.leg_daily_updater import run_daily_update
            from app.service.leg_monitor_service import get_monitor_service
            from app.controller.chat_controller import _emit

            result = await run_daily_update(states=body.states, emit_fn=_emit)
            _sync_status["last_result"] = result

            mon = get_monitor_service()
            match_result = mon.run_match_pass(profile_id=body.profile_id)
            _sync_status["last_result"]["alerts_created"] = match_result.get("alerts_created", 0)
        except Exception as exc:
            logger.error("[legislation] Sync failed: %s", exc)
            _sync_status["last_result"] = {"error": str(exc)}
        finally:
            _sync_status["running"] = False

    _sync_task = asyncio.create_task(_run())
    return {"status": "started", "states": body.states}


@router.get("/sync/status")
async def sync_status():
    """Return sync state for all tracked states."""
    from app.service.leg_monitor_service import get_monitor_service
    mon = get_monitor_service()
    return {
        "running":    _sync_status.get("running", False),
        "last_result": _sync_status.get("last_result"),
        "states":     mon.get_sync_status(),
    }
