"""
AURA NX-Alpha — Watch & Transcribe Controller

Endpoints:
    POST /watch/start              — begin watching + transcribing a stream
    POST /watch/stop               — stop a session
    GET  /watch/sessions           — list all active sessions
    GET  /watch/status/{stream_id} — status of one session
    GET  /watch/transcript/{stream_id} — full transcript for a session

    POST /watch/captions/start     — start passive caption extraction
    POST /watch/captions/stop      — stop caption extraction
    GET  /watch/captions/status    — caption service status + story ledger
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter(prefix="/watch", tags=["watch"])


class StartWatchRequest(BaseModel):
    url:   str
    label: str = ""


class StopWatchRequest(BaseModel):
    stream_id: str


class CaptionFeed(BaseModel):
    id:      str
    label:   str = ""
    hls_url: str


class StartCaptionsRequest(BaseModel):
    feeds: list[CaptionFeed]


class StopCaptionsRequest(BaseModel):
    feed_ids: list[str] | None = None


@router.post("/start")
async def start_watch(req: StartWatchRequest):
    from app.service.watch_service import get_watch_daemon
    return await get_watch_daemon().start_watch(req.url, req.label)


@router.post("/stop")
async def stop_watch(req: StopWatchRequest):
    from app.service.watch_service import get_watch_daemon
    result = await get_watch_daemon().stop_watch(req.stream_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


@router.get("/sessions")
async def list_sessions():
    from app.service.watch_service import get_watch_daemon
    return {"sessions": get_watch_daemon().list_sessions()}


@router.get("/status/{stream_id}")
async def get_status(stream_id: str):
    from app.service.watch_service import get_watch_daemon
    status = get_watch_daemon().get_status(stream_id)
    if status is None:
        raise HTTPException(status_code=404, detail=f"Session {stream_id} not found")
    return status


@router.get("/transcript/{stream_id}")
async def get_transcript(stream_id: str):
    from app.service.watch_service import get_watch_daemon
    segments = get_watch_daemon().get_transcript(stream_id)
    return {"stream_id": stream_id, "segments": segments, "count": len(segments)}


@router.get("/search")
async def search_youtube(q: str, limit: int = 8):
    from app.service.media_service import search_youtube as _search
    results = await _search(q, min(limit, 20))
    return {"results": results}


# ── Caption service endpoints ──────────────────────────────────────────────

@router.post("/captions/start")
async def start_captions(req: StartCaptionsRequest):
    from app.service.caption_service import start_caption_streams
    feeds = [f.model_dump() for f in req.feeds]
    return await start_caption_streams(feeds)


@router.post("/captions/stop")
async def stop_captions(req: StopCaptionsRequest):
    from app.service.caption_service import stop_caption_streams
    await stop_caption_streams(req.feed_ids)
    return {"status": "stopped"}


@router.get("/captions/status")
async def captions_status():
    from app.service.caption_service import get_caption_service
    svc = get_caption_service()
    if svc is None:
        return {"running": False, "feeds": {}, "ledger_size": 0, "ledger_entries": []}
    return svc.get_status()
