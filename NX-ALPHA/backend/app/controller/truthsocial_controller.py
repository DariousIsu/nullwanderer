"""
AURA NX-Alpha — Truth Social Controller
REST endpoints for the @realDonaldTrump monitor.

ROUTES:
    GET  /data/truthsocial/posts              — recent posts (?limit=20)
    GET  /data/truthsocial/posts/{post_id}    — single post by Truth Social ID
    GET  /data/truthsocial/search             — FTS5 search (?q=&limit=20)
    POST /data/truthsocial/poll               — trigger immediate poll now
    GET  /data/truthsocial/stats              — aggregate stats
    GET  /data/truthsocial/status             — polling service status
    POST /data/truthsocial/poll/start         — start background polling
    POST /data/truthsocial/poll/stop          — stop background polling
"""

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query

from app.service.truthsocial_service import get_truthsocial_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/data/truthsocial", tags=["truthsocial"])


@router.get("/posts")
async def list_posts(limit: int = Query(20, ge=1, le=200)):
    """Return the N most recent archived posts."""
    svc = get_truthsocial_service()
    posts = await asyncio.to_thread(svc.get_latest_posts, limit)
    return {"posts": posts, "count": len(posts)}


@router.get("/posts/{post_id}")
async def get_post(post_id: str):
    """Return a single post by its Truth Social post ID."""
    svc = get_truthsocial_service()
    post = await asyncio.to_thread(svc.get_post, post_id)
    if not post:
        raise HTTPException(status_code=404, detail=f"Post {post_id} not found")
    return post


@router.get("/search")
async def search_posts(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
):
    """Full-text search over archived posts."""
    svc = get_truthsocial_service()
    results = await asyncio.to_thread(svc.search_posts, q, limit)
    return {"results": results, "count": len(results), "query": q}


@router.post("/poll")
async def trigger_poll():
    """Trigger an immediate poll for new posts."""
    svc = get_truthsocial_service()
    new_posts = await asyncio.to_thread(svc._fetch_new_posts)
    if new_posts:
        await svc._emit_new_posts(new_posts)
    return {"new_count": len(new_posts), "posts": new_posts}


@router.get("/stats")
async def get_stats():
    """Return aggregate stats (total count, latest/oldest post timestamps)."""
    svc = get_truthsocial_service()
    stats = await asyncio.to_thread(svc.get_stats)
    stats["polling_active"] = svc.is_polling()
    return stats


@router.get("/status")
async def get_status():
    """Return polling service status."""
    svc = get_truthsocial_service()
    return {
        "polling_active": svc.is_polling(),
        "last_polled": svc._last_polled,
        "monitor_username": svc._monitor_username,
        "poll_interval_seconds": svc._poll_interval,
        "credentials_configured": bool(svc._username and svc._password),
    }


@router.post("/poll/start")
async def start_polling():
    """Start the background polling loop (idempotent)."""
    svc = get_truthsocial_service()
    if not svc._username or not svc._password:
        raise HTTPException(
            status_code=400,
            detail="Truth Social credentials not configured. Set AURA_TRUTHSOCIAL__USERNAME and AURA_TRUTHSOCIAL__PASSWORD in .env",
        )
    await svc.start_polling()
    return {"polling_active": svc.is_polling()}


@router.post("/poll/stop")
async def stop_polling():
    """Stop the background polling loop."""
    svc = get_truthsocial_service()
    await svc.stop_polling()
    return {"polling_active": svc.is_polling()}
