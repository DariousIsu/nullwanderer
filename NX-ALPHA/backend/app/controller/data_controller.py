"""
AURA NX-Alpha — Data Controller
Exposes all live data to the frontend and to Aura's tool calls.

ROUTES:
    GET  /data/weather                      — current + forecast + radar
    GET  /data/weather/location             — saved default location
    PUT  /data/weather/location             — save default location
    GET  /data/finance/overview             — market overview
    GET  /data/finance/quote/{ticker}       — single ticker quote
    GET  /data/finance/watchlist            — user watchlist quotes
    PUT  /data/finance/watchlist            — save watchlist
    GET  /data/news                         — headlines (optional category filter)
    GET  /data/calendar                     — Google Calendar events
    GET  /data/inbox                        — Gmail inbox
    GET  /data/google/auth-url              — OAuth URL
    POST /data/google/exchange              — exchange auth code for tokens
    GET  /data/google/status               — auth status + scopes
    GET  /system/status                     — full system snapshot
    GET  /data/knowledge/status             — knowledge download statuses
    POST /data/knowledge/download/{source_id} — start a knowledge download
    GET  /data/knowledge/sources            — SOURCES dict with current status merged
    POST /data/knowledge/personal           — ingest a single personal document
    POST /data/knowledge/personal/batch     — batch ingest text files from a folder
    GET  /data/collector/status              — Worker B data collector status
"""

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/data")

# ─────────────────────────────────────────────────────────────────────────────
# SETTINGS HELPERS
# ~/.aura/settings.json — stores weather_location, watchlist, etc.
# ─────────────────────────────────────────────────────────────────────────────

_SETTINGS_PATH = Path.home() / ".aura" / "settings.json"

_DEFAULT_LOCATION = {"lat": 40.7128, "lon": -74.0060, "name": "New York, NY"}
_DEFAULT_WATCHLIST = ["SPY", "QQQ", "BTC-USD", "ETH-USD"]


def _load_settings() -> dict:
    """Load ~/.aura/settings.json; return empty dict if missing."""
    if _SETTINGS_PATH.exists():
        try:
            return json.loads(_SETTINGS_PATH.read_text(encoding="utf-8"))
        except Exception as exc:
            logger.warning("Failed to read settings.json: %s", exc)
    return {}


def _save_settings(data: dict) -> None:
    """Merge data into ~/.aura/settings.json."""
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    current = _load_settings()
    current.update(data)
    _SETTINGS_PATH.write_text(json.dumps(current, indent=2), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# REQUEST / RESPONSE MODELS
# ─────────────────────────────────────────────────────────────────────────────

class LocationBody(BaseModel):
    lat: float
    lon: float
    name: str = ""


class WatchlistBody(BaseModel):
    tickers: List[str]


class GoogleExchangeBody(BaseModel):
    code: str


# ─────────────────────────────────────────────────────────────────────────────
# WEATHER
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/weather")
async def get_weather(lat: float = 40.7128, lon: float = -74.0060):
    """Return current conditions, forecast, radar URL, and the requested location."""
    from app.service.weather_service import get_weather_service

    logger.info("GET /data/weather lat=%s lon=%s", lat, lon)
    svc = get_weather_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        current = await svc.get_current(lat=lat, lon=lon)
        forecast = await svc.get_forecast(lat=lat, lon=lon)
        radar_url = svc.get_radar_url(lat=lat, lon=lon)
        return {
            "current": current,
            "forecast": forecast,
            "radar_url": radar_url,
            "location": {"lat": lat, "lon": lon},
        }
    except Exception as exc:
        logger.exception("Weather service error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/weather/location")
async def get_weather_location():
    """Return the saved default weather location."""
    logger.info("GET /data/weather/location")
    settings = _load_settings()
    return settings.get("weather_location", _DEFAULT_LOCATION)


@router.put("/weather/location")
async def put_weather_location(body: LocationBody):
    """Save a new default weather location."""
    logger.info("PUT /data/weather/location lat=%s lon=%s name=%s", body.lat, body.lon, body.name)
    location = {"lat": body.lat, "lon": body.lon, "name": body.name}
    _save_settings({"weather_location": location})
    return location


# ─────────────────────────────────────────────────────────────────────────────
# FINANCE
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/finance/overview")
async def get_finance_overview():
    """Return market overview: indices, crypto, last_updated."""
    from app.service.finance_service import get_finance_service

    logger.info("GET /data/finance/overview")
    svc = get_finance_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        overview = await svc.get_market_overview()
        return overview
    except Exception as exc:
        logger.exception("Finance overview error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/finance/quote/{ticker}")
async def get_finance_quote(ticker: str):
    """Return a single ticker quote."""
    from app.service.finance_service import get_finance_service

    logger.info("GET /data/finance/quote/%s", ticker)
    svc = get_finance_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        return await svc.get_quote(ticker.upper())
    except Exception as exc:
        logger.exception("Finance quote error for %s: %s", ticker, exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/finance/watchlist")
async def get_finance_watchlist():
    """Return quotes for the user's watchlist."""
    from app.service.finance_service import get_finance_service

    logger.info("GET /data/finance/watchlist")
    settings = _load_settings()
    tickers = settings.get("watchlist", _DEFAULT_WATCHLIST)

    svc = get_finance_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        quotes = await svc.get_quotes(tickers)
        return {"tickers": tickers, "quotes": quotes}
    except Exception as exc:
        logger.exception("Finance watchlist error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.put("/finance/watchlist")
async def put_finance_watchlist(body: WatchlistBody):
    """Save a new watchlist."""
    logger.info("PUT /data/finance/watchlist tickers=%s", body.tickers)
    tickers = [t.upper() for t in body.tickers]
    _save_settings({"watchlist": tickers})
    return {"tickers": tickers}


# ─────────────────────────────────────────────────────────────────────────────
# NEWS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/news")
async def get_news(category: Optional[str] = None, limit: int = 20):
    """Return news articles, optionally filtered by category."""
    from app.service.news_service import get_news_service

    logger.info("GET /data/news category=%s limit=%s", category, limit)
    svc = get_news_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        if category:
            articles = await svc.fetch_by_category(category=category, limit=limit)
        else:
            articles = await svc.fetch_all(limit_per_feed=max(1, limit // 5))
            articles = articles[:limit]

        sources = list({a.get("source", "") for a in articles if a.get("source")})
        return {
            "articles": articles,
            "sources": sources,
            "last_updated": datetime.now(timezone.utc).isoformat(),
        }
    except Exception as exc:
        logger.exception("News service error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# GOOGLE — CALENDAR + GMAIL
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/calendar")
async def get_calendar(days: int = 14):
    """Return Google Calendar events for the next N days."""
    from app.service.google_service import get_google_service

    logger.info("GET /data/calendar days=%s", days)
    svc = get_google_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        authenticated = await svc.is_authenticated()
        if not authenticated:
            return {"events": [], "authenticated": False}
        events = await svc.get_calendar_events(days_ahead=days)
        return {"events": events, "authenticated": True}
    except Exception as exc:
        logger.exception("Calendar service error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/inbox")
async def get_inbox(max_results: int = 20):
    """Return Gmail inbox messages."""
    from app.service.google_service import get_google_service

    logger.info("GET /data/inbox max_results=%s", max_results)
    svc = get_google_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        authenticated = await svc.is_authenticated()
        if not authenticated:
            return {"messages": [], "authenticated": False}
        messages = await svc.get_inbox(max_results=max_results)
        return {"messages": messages, "authenticated": True}
    except Exception as exc:
        logger.exception("Inbox service error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/google/auth-url")
async def get_google_auth_url(account_id: Optional[str] = Query(None)):
    """Return the Google OAuth URL for the user to open."""
    from app.service.google_service import get_google_service

    logger.info("GET /data/google/auth-url (account_id=%s)", account_id)
    svc = get_google_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        url, acct_id = await svc.get_auth_url(account_id)
        return {"url": url, "account_id": acct_id}
    except Exception as exc:
        logger.exception("Google auth-url error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.post("/google/exchange")
async def post_google_exchange(body: GoogleExchangeBody):
    """Exchange an OAuth authorization code for tokens."""
    from app.service.google_service import get_google_service

    logger.info("POST /data/google/exchange")
    svc = get_google_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        success = await svc.exchange_code(body.code)
        authenticated = await svc.is_authenticated()
        return {"success": success, "authenticated": authenticated}
    except Exception as exc:
        logger.exception("Google exchange error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/google/callback")
async def google_oauth_callback(code: str, state: str = ""):
    """
    OAuth2 redirect callback. Google redirects here after the user grants access.
    The `state` param carries the account_id set during get_auth_url().
    Exchanges the code for tokens and saves them. Returns a simple HTML page
    the user can close.
    """
    from fastapi.responses import HTMLResponse
    from app.service.google_service import get_google_service

    # state carries the account_id we set in get_auth_url
    account_id = state.strip() if state.strip() else None
    logger.info("GET /data/google/callback — exchanging code (account_id=%s)", account_id)
    svc = get_google_service()
    success = False
    if svc:
        try:
            success = await svc.handle_callback(code, account_id=account_id)
        except Exception as exc:
            logger.error("OAuth callback exchange failed: %s", exc)

    if success:
        html = """<!DOCTYPE html><html><head><title>AURA — Connected</title>
<style>body{background:#04080F;color:#4ade80;font-family:monospace;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0;font-size:18px;}
</style></head><body>✓ Google connected. You can close this tab.</body></html>"""
    else:
        html = """<!DOCTYPE html><html><head><title>AURA — Error</title>
<style>body{background:#04080F;color:#ef4444;font-family:monospace;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0;font-size:18px;}
</style></head><body>✗ Authentication failed. Check backend logs and try again.</body></html>"""

    return HTMLResponse(content=html)


@router.get("/google/status")
async def get_google_status():
    """Return Google OAuth status — active account auth state + all connected accounts."""
    from app.service.google_service import get_google_service

    logger.info("GET /data/google/status")
    svc = get_google_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        accounts = await svc.list_accounts()
        authenticated = any(a["is_active"] for a in accounts) and await svc.is_authenticated()
        return {
            "authenticated": authenticated,
            "accounts": accounts,
            "active_account_id": svc._get_active_account_id(),
        }
    except Exception as exc:
        logger.exception("Google status error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/google/accounts")
async def list_google_accounts():
    """Return all connected Google accounts."""
    from app.service.google_service import get_google_service
    svc = get_google_service()
    accounts = await svc.list_accounts()
    return {"accounts": accounts}


@router.put("/google/accounts/{account_id}/activate")
async def set_active_google_account(account_id: str):
    """Switch the active Google account."""
    from app.service.google_service import get_google_service
    svc = get_google_service()
    ok = await svc.set_active_account(account_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Account {account_id!r} not found")
    return {"active_account_id": account_id}


@router.delete("/google/accounts/{account_id}")
async def remove_google_account(account_id: str):
    """Disconnect and remove a Google account."""
    from app.service.google_service import get_google_service
    svc = get_google_service()
    ok = await svc.remove_account(account_id)
    if not ok:
        raise HTTPException(status_code=404, detail=f"Account {account_id!r} not found")
    return {"removed": account_id}


# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM STATUS  (note: prefix is /system not /data)
# ─────────────────────────────────────────────────────────────────────────────

system_router = APIRouter(prefix="/system")


@system_router.get("/status")
async def get_system_status():
    """Return the full system snapshot (CPU, RAM, GPU, disks)."""
    from app.service.system_monitor_service import get_system_monitor, get_latest_snapshot

    logger.info("GET /system/status")
    try:
        svc = get_system_monitor()
        if svc is not None:
            return await svc.get_snapshot()
        return get_latest_snapshot()
    except Exception as exc:
        logger.exception("System monitor error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# KNOWLEDGE DOWNLOADER
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/knowledge/sources")
async def get_knowledge_sources():
    """Return indexed collections from disk + download status.
    Frontend expects { sources: [ { source_id, name, status, ... }, ... ] }"""
    from pathlib import Path

    logger.info("GET /data/knowledge/sources")
    knowledge_dir = Path.home() / ".aura" / "knowledge"
    sources = []
    seen_ids = set()

    # 1. Scan actual indexed collections on disk
    if knowledge_dir.exists():
        skip = {"_inbox", "__pycache__"}
        for entry in sorted(knowledge_dir.iterdir()):
            if not entry.is_dir() or entry.name in skip or entry.name.startswith("."):
                continue
            # Compute size
            size_bytes = sum(f.stat().st_size for f in entry.rglob("*") if f.is_file())
            size_gb = round(size_bytes / (1024 ** 3), 2)
            # Count articles (rough: count .html/.txt/.json files, or total files)
            article_count = sum(1 for f in entry.rglob("*") if f.is_file() and f.suffix in ('.html', '.txt', '.json', '.md'))
            if article_count == 0:
                article_count = sum(1 for f in entry.rglob("*") if f.is_file())

            source_id = entry.name
            seen_ids.add(source_id)
            # Pretty label from folder name
            label = source_id.replace("_", " ").replace("-", " ").title()
            sources.append({
                "source_id":     source_id,
                "label":         label,
                "name":          label,
                "description":   f"Indexed from collection folder",
                "status":        "ready",
                "size_gb":       size_gb,
                "article_count": article_count,
                "progress_pct":  100.0,
                "downloaded_gb": size_gb,
                "error":         None,
            })

    return {"sources": sources}


@router.get("/knowledge/status")
async def get_knowledge_status():
    """Return download status for all knowledge sources."""
    from app.service.knowledge_downloader import get_knowledge_downloader

    logger.info("GET /data/knowledge/status")
    downloader = get_knowledge_downloader()
    if downloader is None:
        raise HTTPException(status_code=503, detail="service not available")

    all_status = downloader.get_all_status()
    return {k: vars(v) for k, v in all_status.items()}


# ─────────────────────────────────────────────────────────────────────────────
# KNOWLEDGE CURATOR
# ─────────────────────────────────────────────────────────────────────────────

class CuratorEvaluateBody(BaseModel):
    source: str   # HF dataset ID, URL, or local file path


@router.post("/knowledge/curator/evaluate")
async def post_curator_evaluate(body: CuratorEvaluateBody):
    """
    Evaluate a dataset source before ingestion.
    Fetches a sample and runs the workhorse model for safety/PII/relevance analysis.
    Returns {curator_id, report}.
    """
    from app.service.curator_service import get_curator_service

    logger.info("POST /data/knowledge/curator/evaluate source=%r", body.source[:80])
    svc = get_curator_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="curator service not available")

    try:
        return await svc.evaluate(body.source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Curator evaluate error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.post("/knowledge/curator/ingest/{curator_id}")
async def post_curator_ingest(curator_id: str):
    """
    Approve a pending evaluation and start full download + FTS5 indexing.
    Returns immediately; progress is emitted via storage_update SSE events.
    """
    from app.service.curator_service import get_curator_service
    import asyncio

    logger.info("POST /data/knowledge/curator/ingest/%s", curator_id)
    svc = get_curator_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="curator service not available")

    try:
        await svc.ingest(curator_id)
        return {"status": "started", "curator_id": curator_id}
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": str(exc)})
    except ValueError as exc:
        raise HTTPException(status_code=409, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Curator ingest error for %s: %s", curator_id, exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/knowledge/curator/status/{curator_id}")
async def get_curator_status(curator_id: str):
    """Return current status for a single curated source."""
    from app.service.curator_service import get_curator_service
    from dataclasses import asdict

    logger.info("GET /data/knowledge/curator/status/%s", curator_id)
    svc = get_curator_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="curator service not available")

    try:
        return asdict(svc.get_status(curator_id))
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": str(exc)})


@router.get("/knowledge/curator/list")
async def get_curator_list():
    """Return all curated sources and their statuses."""
    from app.service.curator_service import get_curator_service
    from dataclasses import asdict

    logger.info("GET /data/knowledge/curator/list")
    svc = get_curator_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="curator service not available")

    return {cid: asdict(cs) for cid, cs in svc.get_all().items()}


@router.post("/knowledge/download/{source_id}")
async def post_knowledge_download(source_id: str):
    """Start downloading a knowledge source."""
    from app.service.knowledge_downloader import SOURCES, get_knowledge_downloader
    import asyncio

    logger.info("POST /data/knowledge/download/%s", source_id)

    if source_id not in SOURCES:
        raise HTTPException(status_code=404, detail={"error": f"unknown source_id: {source_id}"})

    downloader = get_knowledge_downloader()
    if downloader is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        # Validate before starting background task (raises ValueError/KeyError synchronously)
        downloader.get_status(source_id)  # will KeyError if unknown

        def _download_done(t: asyncio.Task) -> None:
            if not t.cancelled() and t.exception():
                logger.error("[data_controller] Background download failed for %s: %s",
                             source_id, t.exception())

        task = asyncio.create_task(
            downloader.start_download(source_id),
            name=f"download_{source_id}",
        )
        task.add_done_callback(_download_done)
        return {"status": "started", "source_id": source_id}
    except ValueError as exc:
        logger.warning("Cannot start download for %s: %s", source_id, exc)
        raise HTTPException(status_code=409, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Download start error for %s: %s", source_id, exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# ZIM COLLECTION FOLDER
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/knowledge/sweep")
async def sweep_collection_folder():
    """
    Scan the ZIM collection folder for new/updated/duplicate ZIM files.
    Processes them automatically (move, index, or delete).
    """
    from app.service.zim_collector import sweep_collection_folder as _sweep

    logger.info("POST /data/knowledge/sweep")
    try:
        results = await _sweep()
        return {"status": "ok", "actions": results}
    except Exception as exc:
        logger.exception("Collection folder sweep failed: %s", exc)
        raise HTTPException(status_code=500, detail={"error": str(exc)})


@router.get("/knowledge/collection-folder")
async def get_collection_folder():
    """Return the current collection folder path."""
    from app.service.zim_collector import get_collection_folder as _get
    folder = _get()
    return {"path": str(folder), "exists": folder.exists()}


@router.put("/knowledge/collection-folder")
async def set_collection_folder(body: dict):
    """Set a new collection folder path."""
    from app.service.zim_collector import set_collection_folder as _set
    path = body.get("path", "")
    if not path:
        raise HTTPException(status_code=400, detail="path is required")
    try:
        resolved = _set(path)
        return {"path": str(resolved), "status": "saved"}
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# PERSONAL CONTEXT INGESTION (Phase G)
# ─────────────────────────────────────────────────────────────────────────────

PERSONAL_TYPES = {"style_guide", "design_standard", "user_context", "conversation_history"}


class PersonalDocRequest(BaseModel):
    content: str
    type: str       # one of PERSONAL_TYPES
    title: str
    tags: Optional[List[str]] = []


class BatchIngestRequest(BaseModel):
    path: str       # local folder path
    type: str       # applied to all files in the folder
    tags: Optional[List[str]] = []


def _chunk_text(text: str, max_chars: int = 1600, overlap: int = 160) -> list[str]:
    """Split text at paragraph boundaries, respecting max_chars per chunk.

    Trailing overlap: the last `overlap` chars of each chunk are prepended to
    the next chunk so semantic meaning at paragraph boundaries isn't fragmented.
    Only affects newly ingested documents; existing chunks are unchanged.
    """
    paragraphs = [p.strip() for p in text.split('\n\n') if p.strip()]
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for para in paragraphs:
        if current_len + len(para) > max_chars and current:
            chunk_text = '\n\n'.join(current)
            chunks.append(chunk_text)
            # Carry the tail of the previous chunk as semantic overlap
            tail = chunk_text[-overlap:] if overlap and len(chunk_text) > overlap else ""
            current = ([tail, para] if tail else [para])
            current_len = len(tail) + len(para) if tail else len(para)
        else:
            current.append(para)
            current_len += len(para)
    if current:
        chunks.append('\n\n'.join(current))
    return chunks


async def _ingest_personal_document(content: str, doc_type: str, title: str, tags: list) -> int:
    """Chunk, embed, and dual-write a personal document to ChromaDB + FTS5."""
    from app.service.memory_service import get_memory_service

    mem = get_memory_service()
    if mem is None:
        logger.warning("[personal_ingest] Memory service not available")
        return 0

    chunks = _chunk_text(content)
    for i, chunk in enumerate(chunks):
        doc_id = f"personal_{doc_type}_{title}_{i}_{uuid.uuid4().hex[:8]}"
        meta = {
            "doc_id":     doc_id,
            "type":       doc_type,
            "title":      title,
            "tags":       ",".join(tags) if tags else "",
            "source":     "personal",
            "thread_id":  "",
            "agent_role": "personal_ingest",
            "area_id":    "",
            "timestamp":  str(time.time()),
        }
        # Dual-write: ChromaDB (semantic) + FTS5 (BM25)
        mem._store_layer2(doc_id, chunk, meta)
        try:
            mem._store_fts5(doc_id, chunk, meta)
        except Exception as exc:
            logger.warning("[personal_ingest] FTS5 store failed for %s: %s", doc_id, exc)

    logger.info("[personal_ingest] Ingested '%s' (%s) — %d chunks", title, doc_type, len(chunks))
    return len(chunks)


async def _batch_ingest_personal_folder(files: list, doc_type: str, tags: list) -> dict:
    """Ingest all text files from a folder. Returns summary."""
    total_chunks = 0
    ingested = 0
    skipped = 0
    for file_path in files:
        try:
            content = file_path.read_text(encoding='utf-8', errors='ignore')
            if len(content.strip()) < 50:
                skipped += 1
                continue
            count = await _ingest_personal_document(content, doc_type, file_path.stem, tags)
            total_chunks += count
            ingested += 1
        except Exception as exc:
            logger.warning("[personal_ingest] Failed to ingest %s: %s", file_path.name, exc)
            skipped += 1
    logger.info("[personal_ingest] Batch complete: %d files, %d chunks, %d skipped",
                ingested, total_chunks, skipped)
    return {"ingested": ingested, "chunks": total_chunks, "skipped": skipped}


@router.post("/knowledge/personal")
async def ingest_personal_doc(req: PersonalDocRequest):
    """Ingest a single personal document into ChromaDB + FTS5."""
    logger.info("POST /data/knowledge/personal title=%r type=%s", req.title, req.type)

    if req.type not in PERSONAL_TYPES:
        raise HTTPException(400, f"type must be one of {sorted(PERSONAL_TYPES)}")
    if not req.content.strip():
        raise HTTPException(400, "content must not be empty")

    def _done(t: asyncio.Task) -> None:
        if not t.cancelled() and t.exception():
            logger.error("[personal_ingest] Background ingest failed for %r: %s", req.title, t.exception())

    task = asyncio.create_task(
        _ingest_personal_document(req.content, req.type, req.title, req.tags or []),
        name=f"personal_ingest_{req.title}",
    )
    task.add_done_callback(_done)
    return {"status": "ingesting", "title": req.title}


@router.post("/knowledge/personal/batch")
async def batch_ingest_personal(req: BatchIngestRequest):
    """Batch ingest all .txt and .md files from a local folder path."""
    logger.info("POST /data/knowledge/personal/batch path=%r type=%s", req.path, req.type)

    if req.type not in PERSONAL_TYPES:
        raise HTTPException(400, f"type must be one of {sorted(PERSONAL_TYPES)}")

    folder = Path(req.path)
    if not folder.exists() or not folder.is_dir():
        raise HTTPException(400, f"Path not found or not a directory: {req.path}")

    files = sorted(folder.glob("*.txt")) + sorted(folder.glob("*.md"))
    if not files:
        return {"status": "no_files", "file_count": 0}

    def _done(t: asyncio.Task) -> None:
        if not t.cancelled() and t.exception():
            logger.error("[personal_ingest] Batch ingest failed: %s", t.exception())

    task = asyncio.create_task(
        _batch_ingest_personal_folder(files, req.type, req.tags or []),
        name=f"personal_batch_{folder.name}",
    )
    task.add_done_callback(_done)
    return {"status": "ingesting", "file_count": len(files)}


# ─────────────────────────────────────────────────────────────────────────────
# MEMORY SEARCH — Semantic search over ChromaDB (used by aura_mcp_server.py)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/memory/search")
async def memory_search(q: str, limit: int = 5):
    """Semantic hybrid search over AURA's ChromaDB memory layer."""
    from app.service.memory_service import get_memory_service

    logger.info("GET /data/memory/search q=%r limit=%d", q, limit)
    svc = get_memory_service()
    if not svc:
        return {"results": [], "error": "Memory service not initialized"}
    try:
        raw = svc._hybrid_search(query=q, n_results=limit)
        results = [{"content": r.get("content", ""), "metadata": r.get("metadata", {})} for r in raw]
        return {"results": results}
    except Exception as exc:
        logger.exception("Memory search error: %s", exc)
        raise HTTPException(status_code=500, detail={"error": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# INTELLIGENCE SERVICE — Unified Data Aggregation
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/intelligence/sources")
async def get_intelligence_sources():
    """Return all available intelligence sources with current ranking."""
    from app.service.intelligence_service import get_intelligence_service

    logger.info("GET /data/intelligence/sources")
    svc = get_intelligence_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        sources = await svc.get_all_sources()
        return {"sources": sources}
    except Exception as exc:
        logger.exception("Intelligence sources error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.post("/intelligence/sources/{source_type}/{source_id}/rank")
async def update_source_rank(source_type: str, source_id: str, body: dict):
    """Update ranking and enabled status for a source."""
    from app.service.intelligence_service import get_intelligence_service

    logger.info("POST /data/intelligence/sources/%s/%s/rank", source_type, source_id)
    svc = get_intelligence_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        rank = body.get("rank", 0)
        enabled = body.get("enabled", True)
        result = await svc.update_source_rank(source_type, source_id, rank, enabled)
        return result
    except Exception as exc:
        logger.exception("Update source rank error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.post("/intelligence/sources/custom")
async def add_custom_source(body: dict):
    """Add a custom user-defined data source."""
    from app.service.intelligence_service import get_intelligence_service

    logger.info("POST /data/intelligence/sources/custom")
    svc = get_intelligence_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        source_type = body.get("type", "")
        source_id = body.get("id", "")
        source_config = body.get("config", {})

        if not source_type or not source_id:
            raise HTTPException(status_code=400, detail="type and id required")

        result = await svc.add_custom_source(source_type, source_id, source_config)
        return result
    except Exception as exc:
        logger.exception("Add custom source error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/intelligence/feed")
async def get_intelligence_feed(
    types: Optional[str] = None,
    limit: int = 100,
    hours_back: int = 24,
):
    """Get aggregated, ranked feed across all enabled sources.

    Query params:
        types: Comma-separated source types (news,finance,economic,legislative,legal)
        limit: Max items to return
        hours_back: Only include items from last N hours
    """
    from app.service.intelligence_service import get_intelligence_service

    logger.info("GET /data/intelligence/feed types=%s limit=%s hours_back=%s",
               types, limit, hours_back)
    svc = get_intelligence_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        source_types = types.split(",") if types else None
        feed = await svc.get_aggregated_feed(
            source_types=source_types,
            limit=limit,
            hours_back=hours_back,
        )
        return feed
    except Exception as exc:
        logger.exception("Intelligence feed error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# API KEY MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

class APIKeysBody(BaseModel):
    fred_api_key: Optional[str] = None
    bls_api_key: Optional[str] = None
    bea_api_key: Optional[str] = None
    census_api_key: Optional[str] = None
    news_api_key: Optional[str] = None
    polygon_api_key: Optional[str] = None
    alpha_vantage_api_key: Optional[str] = None
    openweathermap_api_key: Optional[str] = None
    congress_api_key: Optional[str] = None
    openstates_api_key: Optional[str] = None
    courtlistener_token: Optional[str] = None
    govinfo_api_key: Optional[str] = None
    caselaw_api_key: Optional[str] = None
    # Tool API keys
    exa_api_key: Optional[str] = None
    jina_api_key: Optional[str] = None
    nasa_api_key: Optional[str] = None
    apify_api_key: Optional[str] = None
    fmp_api_key: Optional[str] = None
    slack_bot_token: Optional[str] = None
    notion_integration_token: Optional[str] = None
    composio_api_key: Optional[str] = None


@router.get("/api-keys")
async def get_api_keys():
    """Return current API key configuration (censored for security)."""
    from app.config import get_settings

    logger.info("GET /data/api-keys")
    settings = get_settings()
    market = settings.market
    knowledge = settings.knowledge

    # Return censored versions (show first 4 and last 4 chars)
    def censor(key: str) -> str:
        if not key or len(key) <= 8:
            return "****" if key else ""
        return f"{key[:4]}...{key[-4:]}"

    return {
        "fred_api_key": censor(market.fred_api_key),
        "bls_api_key": censor(market.bls_api_key),
        "bea_api_key": censor(market.bea_api_key),
        "census_api_key": censor(market.census_api_key),
        "news_api_key": censor(market.news_api_key),
        "polygon_api_key": censor(market.polygon_api_key),
        "alpha_vantage_api_key": censor(market.alpha_vantage_api_key),
        "openweathermap_api_key": censor(market.openweathermap_api_key),
        "congress_api_key": censor(knowledge.congress_api_key or ""),
        "openstates_api_key": censor(knowledge.openstates_api_key or ""),
        "courtlistener_token": censor(knowledge.courtlistener_token or ""),
        "govinfo_api_key": censor(knowledge.govinfo_api_key or ""),
        "caselaw_api_key": censor(knowledge.caselaw_api_key or ""),
        # Tool API keys (direct settings attributes)
        "exa_api_key": censor(settings.exa_api_key or ""),
        "jina_api_key": censor(settings.jina_api_key or ""),
        "nasa_api_key": censor(settings.nasa_api_key or ""),
        "apify_api_key": censor(settings.apify_api_key or ""),
        "fmp_api_key": censor(settings.fmp_api_key or ""),
        "slack_bot_token": censor(settings.slack_bot_token or ""),
        "notion_integration_token": censor(settings.notion_integration_token or ""),
        "composio_api_key": censor(settings.composio_api_key or ""),
    }


@router.put("/api-keys")
async def update_api_keys(body: APIKeysBody):
    """Update API keys. Saves to ~/.aura/settings.json."""
    from pathlib import Path
    import json

    logger.info("PUT /data/api-keys")

    # Load settings file
    settings_path = Path.home() / ".aura" / "settings.json"
    settings_path.parent.mkdir(parents=True, exist_ok=True)

    if settings_path.exists():
        try:
            data = json.loads(settings_path.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    else:
        data = {}

    # Update keys
    api_keys = data.get("api_keys", {})
    updates = body.model_dump(exclude_none=True)
    api_keys.update(updates)
    data["api_keys"] = api_keys

    # Save
    settings_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    logger.info("PUT /data/api-keys — keys updated")

    return {"status": "updated", "keys": list(updates.keys())}


# ── Test endpoints per service ────────────────────────────────────────────────

_TEST_URLS = {
    "fred":           ("GET", "https://api.stlouisfed.org/fred/releases?api_key={key}&file_type=json&limit=1"),
    "bls":            ("POST", "https://api.bls.gov/publicAPI/v2/timeseries/data/"),
    "bea":            ("GET", "https://apps.bea.gov/api/data/?UserID={key}&method=GetDataSetList&ResultFormat=JSON"),
    "census":         ("GET", "https://api.census.gov/data.json"),
    "newsapi":        ("GET", "https://newsapi.org/v2/top-headlines?country=us&pageSize=1&apiKey={key}"),
    "polygon":        ("GET", "https://api.polygon.io/v2/aggs/ticker/AAPL/prev?apiKey={key}"),
    "alpha_vantage":  ("GET", "https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=IBM&interval=5min&apikey={key}&datatype=json"),
    "openweathermap": ("GET", "https://api.openweathermap.org/data/2.5/weather?q=London&appid={key}"),
    "congress":       ("GET", "https://api.congress.gov/v3/bill?limit=1&api_key={key}"),
    "openstates":     ("GET", "https://v3.openstates.org/jurisdictions"),
    "courtlistener":  ("GET", "https://www.courtlistener.com/api/rest/v3/courts/?page_size=1"),
    # Tool API keys
    "exa":            ("GET", "https://api.exa.ai/search"),       # header auth: x-api-key
    "jina":           ("GET", "https://r.jina.ai/https://example.com"),  # header auth: Authorization
    "nasa":           ("GET", "https://api.nasa.gov/planetary/apod?api_key={key}&count=1"),
    "apify":          ("GET", "https://api.apify.com/v2/users/me?token={key}"),
    "fmp":            ("GET", "https://financialmodelingprep.com/api/v3/profile/AAPL?apikey={key}"),
    "slack":          ("GET", "https://slack.com/api/auth.test"),  # header auth: Authorization Bearer
    "notion":         ("GET", "https://api.notion.com/v1/users/me"),  # header auth: Authorization Bearer
    "composio":       ("GET", "https://backend.composio.tech/api/v1/connectedAccounts"),  # header auth: x-api-key
}


@router.post("/api-keys/test")
async def test_api_key(body: dict):
    """Test an API key by making a simple request to the service."""
    import httpx

    service = body.get("service", "")
    api_key = body.get("api_key", "")

    if not service or not api_key:
        raise HTTPException(status_code=400, detail="service and api_key required")

    logger.info("POST /data/api-keys/test service=%s", service)

    if service not in _TEST_URLS:
        return {"service": service, "status": "unknown", "message": f"No test available for '{service}'"}

    method, url_template = _TEST_URLS[service]

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            url = url_template.format(key=api_key)
            headers = {}

            # Special handling for services that need auth headers
            if service == "openstates":
                headers["X-API-KEY"] = api_key
            elif service == "courtlistener":
                headers["Authorization"] = f"Token {api_key}"

            if method == "GET":
                resp = await client.get(url, headers=headers)
            else:
                # BLS uses POST
                payload = {
                    "seriesid": ["LNS14000000"],
                    "startyear": "2025",
                    "endyear": "2026",
                    "registrationkey": api_key,
                }
                resp = await client.post(url, json=payload, headers=headers)

            if resp.status_code == 200:
                return {"service": service, "status": "ok", "message": "API key is valid ✓"}
            elif resp.status_code in (401, 403):
                return {"service": service, "status": "invalid", "message": f"Authentication failed (HTTP {resp.status_code})"}
            elif resp.status_code == 429:
                return {"service": service, "status": "rate_limited", "message": "Rate limited — key may still be valid"}
            else:
                return {"service": service, "status": "error", "message": f"Unexpected HTTP {resp.status_code}"}
    except httpx.TimeoutException:
        return {"service": service, "status": "timeout", "message": "Request timed out — service may be slow"}
    except Exception as exc:
        return {"service": service, "status": "error", "message": str(exc)}


# ─────────────────────────────────────────────────────────────────────────────
# SCHEDULED TASKS — APScheduler Engine
# ─────────────────────────────────────────────────────────────────────────────

class TaskCreateBody(BaseModel):
    name: str
    task_type: str
    schedule: str
    parameters: dict = {}
    sender_email: str = ""
    recipient_list: List[str] = []
    source: str = "internal"
    notes: str = ""


class TaskUpdateBody(BaseModel):
    name: Optional[str] = None
    task_type: Optional[str] = None
    schedule: Optional[str] = None
    parameters: Optional[dict] = None
    sender_email: Optional[str] = None
    recipient_list: Optional[List[str]] = None
    notes: Optional[str] = None


@router.get("/tasks")
async def get_scheduled_tasks():
    """Return all scheduled tasks with next_run info."""
    from app.service.scheduler_service import get_scheduler_service

    logger.info("GET /data/tasks")
    svc = get_scheduler_service()
    if svc is None:
        # Graceful fallback if scheduler not yet initialized
        return {"tasks": []}

    try:
        tasks = svc.get_all_tasks()
        return {"tasks": tasks}
    except Exception as exc:
        logger.exception("Scheduled tasks error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.post("/tasks")
async def create_scheduled_task(body: TaskCreateBody):
    """Create a new scheduled task. Validates cron and stores in SQLite."""
    from app.service.scheduler_service import get_scheduler_service

    logger.info("POST /data/tasks name=%s type=%s schedule=%s",
               body.name, body.task_type, body.schedule)
    svc = get_scheduler_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="scheduler service not available")

    try:
        task = svc.create_task(body.model_dump())
        return task
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Task creation error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.put("/tasks/{task_id}")
async def update_scheduled_task(task_id: str, body: TaskUpdateBody):
    """Update a task. Reschedules if schedule changed."""
    from app.service.scheduler_service import get_scheduler_service

    logger.info("PUT /data/tasks/%s", task_id)
    svc = get_scheduler_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="scheduler service not available")

    try:
        updates = body.model_dump(exclude_none=True)
        task = svc.update_task(task_id, updates)
        return task
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": str(exc)})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Task update error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.delete("/tasks/{task_id}")
async def delete_scheduled_task(task_id: str):
    """Archive a task (soft delete)."""
    from app.service.scheduler_service import get_scheduler_service

    logger.info("DELETE /data/tasks/%s", task_id)
    svc = get_scheduler_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="scheduler service not available")

    try:
        return svc.delete_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Task delete error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.post("/tasks/{task_id}/run-now")
async def run_task_now(task_id: str):
    """Trigger immediate execution of a task."""
    from app.service.scheduler_service import get_scheduler_service

    logger.info("POST /data/tasks/%s/run-now", task_id)
    svc = get_scheduler_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="scheduler service not available")

    try:
        return await svc.run_now(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": str(exc)})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Run-now error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.post("/tasks/{task_id}/pause")
async def pause_task(task_id: str):
    """Pause an active task."""
    from app.service.scheduler_service import get_scheduler_service

    logger.info("POST /data/tasks/%s/pause", task_id)
    svc = get_scheduler_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="scheduler service not available")

    try:
        return svc.pause_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Pause error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.post("/tasks/{task_id}/resume")
async def resume_task(task_id: str):
    """Resume a paused task."""
    from app.service.scheduler_service import get_scheduler_service

    logger.info("POST /data/tasks/%s/resume", task_id)
    svc = get_scheduler_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="scheduler service not available")

    try:
        return svc.resume_task(task_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail={"error": str(exc)})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)})
    except Exception as exc:
        logger.exception("Resume error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/tasks/{task_id}/history")
async def get_task_history(task_id: str, limit: int = 50):
    """Get job execution log for a task."""
    from app.service.scheduler_service import get_scheduler_service

    logger.info("GET /data/tasks/%s/history limit=%s", task_id, limit)
    svc = get_scheduler_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="scheduler service not available")

    try:
        # Verify task exists
        task = svc.get_task(task_id)
        if not task:
            raise HTTPException(status_code=404, detail={"error": f"Task not found: {task_id}"})

        log = svc.get_job_log(task_id, limit=limit)
        return {"task_id": task_id, "history": log}
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Task history error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# CALENDAR — Multi-Account Support
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/calendar/all-accounts")
async def get_calendar_all_accounts(days: int = 14):
    """Return Google Calendar events from all connected accounts merged.

    This is the master view combining events from all accounts.
    """
    from app.service.google_service import get_google_service

    logger.info("GET /data/calendar/all-accounts days=%s", days)
    svc = get_google_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        authenticated = await svc.is_authenticated()
        if not authenticated:
            return {"events": [], "authenticated": False, "accounts": []}

        # TODO: Get events from all connected accounts
        # For now, get from default/active account
        events = await svc.get_calendar_events(days_ahead=days)

        return {
            "events": events,
            "authenticated": True,
            "accounts": [],  # TODO: list all connected accounts
        }
    except Exception as exc:
        logger.exception("Calendar all-accounts error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


@router.get("/calendar/accounts")
async def list_calendar_accounts():
    """Return list of all connected Google accounts with their calendar info."""
    from app.service.google_service import get_google_service

    logger.info("GET /data/calendar/accounts")
    svc = get_google_service()
    if svc is None:
        raise HTTPException(status_code=503, detail="service not available")

    try:
        # TODO: Use multi-account support from google_service
        # For now, return empty
        return {"accounts": []}
    except Exception as exc:
        logger.exception("Calendar accounts error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})


# ─────────────────────────────────────────────────────────────────────────────
# DATA COLLECTOR (Worker B) STATUS
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/collector/status")
async def collector_status():
    """Return Worker B data collector operational status."""
    try:
        from app.service.data_collector_service import get_data_collector
        svc = get_data_collector()
        return svc.status()
    except RuntimeError:
        return {"running": False, "detail": "Data collector not initialised"}
    except Exception as exc:
        logger.exception("Collector status error: %s", exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)})
