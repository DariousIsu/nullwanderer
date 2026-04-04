"""
AURA NX-Alpha — Newsletter Controller
Manages Substack RSS + Kill the Newsletter feed subscriptions.

ROUTES:
    POST /data/newsletters/substack         — add a Substack feed by slug
    POST /data/newsletters/ktn              — add a KtN Atom feed
    GET  /data/newsletters/feeds            — list all feeds (?source=substack|ktn)
    GET  /data/newsletters/feeds/{feed_id}  — single feed detail
    DELETE /data/newsletters/feeds/{feed_id} — remove feed + entries
    GET  /data/newsletters/entries          — recent entries (?feed_id=&limit=&offset=)
    GET  /data/newsletters/entries/{entry_id} — single entry with full HTML
    GET  /data/newsletters/search           — full-text search (?q=)
    POST /data/newsletters/poll             — trigger immediate poll of all feeds
    POST /data/newsletters/poll/{feed_id}   — poll a single feed
    GET  /data/newsletters/stats            — aggregate stats
"""

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.service.newsletter_service import get_newsletter_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/data/newsletters", tags=["newsletters"])


# ── Request models ───────────────────────────────────────────────────────────

class SubstackBody(BaseModel):
    name: str
    slug: str


class KtnBody(BaseModel):
    name: str
    feed_url: str
    email: str


# ── Feed management ──────────────────────────────────────────────────────────

@router.post("/substack")
async def add_substack(body: SubstackBody):
    """Register a Substack newsletter by slug (e.g. 'pragmaticengineer')."""
    svc = get_newsletter_service()
    result = await asyncio.to_thread(svc.add_substack, body.name, body.slug)
    # Trigger an immediate poll + LightRAG ingestion for the new feed
    _count, new_entries = await asyncio.to_thread(svc.poll_feed, result["id"])
    if new_entries:
        svc._enqueue_to_lightrag(new_entries)
    result["initial_entries"] = _count
    return result


@router.post("/ktn")
async def add_ktn(body: KtnBody):
    """Register a Kill the Newsletter Atom feed."""
    svc = get_newsletter_service()
    result = await asyncio.to_thread(svc.add_ktn_feed, body.name, body.feed_url, body.email)
    # Trigger an immediate poll + LightRAG ingestion for the new feed
    _count, new_entries = await asyncio.to_thread(svc.poll_feed, result["id"])
    if new_entries:
        svc._enqueue_to_lightrag(new_entries)
    result["initial_entries"] = _count
    return result


@router.get("/feeds")
async def list_feeds(source: Optional[str] = Query(None, pattern="^(substack|ktn)$")):
    """List all registered feeds, optionally filtered by source."""
    svc = get_newsletter_service()
    return await asyncio.to_thread(svc.list_feeds, source)


@router.get("/feeds/{feed_id}")
async def get_feed(feed_id: str):
    """Get a single feed by ID."""
    svc = get_newsletter_service()
    feed = await asyncio.to_thread(svc.get_feed, feed_id)
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    return feed


@router.delete("/feeds/{feed_id}")
async def delete_feed(feed_id: str):
    """Delete a feed and all its entries."""
    svc = get_newsletter_service()
    deleted = await asyncio.to_thread(svc.delete_feed, feed_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Feed not found")
    return {"deleted": True}


# ── Entries ──────────────────────────────────────────────────────────────────

@router.get("/entries")
async def list_entries(
    feed_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """List recent entries across all feeds or for a specific feed."""
    svc = get_newsletter_service()
    return await asyncio.to_thread(svc.get_entries, feed_id, limit, offset)


@router.get("/entries/{entry_id}")
async def get_entry(entry_id: str):
    """Get a single entry with full HTML content."""
    svc = get_newsletter_service()
    entry = await asyncio.to_thread(svc.get_entry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found")
    return entry


# ── Search ───────────────────────────────────────────────────────────────────

@router.get("/search")
async def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
):
    """Full-text search across all newsletter entries."""
    svc = get_newsletter_service()
    return await asyncio.to_thread(svc.search_text, q, limit)


# ── Polling ──────────────────────────────────────────────────────────────────

@router.post("/poll")
async def poll_all():
    """Trigger an immediate poll of all active feeds + LightRAG ingestion."""
    svc = get_newsletter_service()
    results, new_entries = await asyncio.to_thread(svc.poll_all)
    total_new = sum(results.values())
    enqueued = 0
    if new_entries:
        enqueued = svc._enqueue_to_lightrag(new_entries)
    return {"polled": len(results), "new_entries": total_new, "lightrag_enqueued": enqueued, "per_feed": results}


@router.post("/poll/{feed_id}")
async def poll_feed(feed_id: str):
    """Poll a single feed immediately + LightRAG ingestion."""
    svc = get_newsletter_service()
    feed = await asyncio.to_thread(svc.get_feed, feed_id)
    if not feed:
        raise HTTPException(status_code=404, detail="Feed not found")
    new_count, new_entries = await asyncio.to_thread(svc.poll_feed, feed_id)
    enqueued = 0
    if new_entries:
        enqueued = svc._enqueue_to_lightrag(new_entries)
    return {"feed_id": feed_id, "new_entries": new_count, "lightrag_enqueued": enqueued}


# ── Stats ────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def get_stats():
    """Return aggregate newsletter stats."""
    svc = get_newsletter_service()
    return await asyncio.to_thread(svc.stats)
