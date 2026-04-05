"""
AURA NX-Alpha — Neural Interface Controller

REST endpoints for the Neural Interface feature:
    GET  /neural/status               — Combined memory layer + LightRAG status
    GET  /neural/graph                — Knowledge graph nodes + edges from Neo4j
    GET  /neural/coverage             — Three-state coverage per source type
    GET  /neural/jobs                 — All ingestion jobs with live progress
    PUT  /neural/jobs/{job_id}/action — Job lifecycle actions
    GET  /neural/sources              — Known source types + ingestion_enabled flags
    PUT  /neural/sources/{source_id}/ingestion — Enable/disable ingestion per source
    PUT  /neural/mapper/toggle        — Toggle background mapper
    POST /neural/ingestion-mode/start    — Boost ingestion rate (no model swap)
    POST /neural/ingestion-mode/stop     — Return to idle-gated ingestion
    POST /neural/ingestion-mode/trigger-exit — Automated trigger exit
    POST /neural/graph/rebuild           — Rebuild graph from scratch
    GET  /neural/interrupt-config     — Get interrupt trigger config
    PUT  /neural/interrupt-config     — Save interrupt trigger config
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

import httpx
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/neural", tags=["neural"])

_OLLAMA_BASE = "http://127.0.0.1:11434"

# ─── REQUEST / RESPONSE MODELS ────────────────────────────────────────────────


class JobActionRequest(BaseModel):
    action: str  # map | ingest | pause | resume | cancel | prioritize


class IngestionToggleRequest(BaseModel):
    enabled: bool


class MapperToggleRequest(BaseModel):
    enabled: bool


class IngestionModeStartRequest(BaseModel):
    model: str = ""  # ignored — always uses interface model (qwen3.5:9b)
    workers: int = 2
    aggressiveness: int = 5


class IngestionModeTriggerExitRequest(BaseModel):
    reason: str
    trigger: str
    auto_resume: bool = False


class GraphRebuildRequest(BaseModel):
    confirm: bool = False


class InterruptConfigRequest(BaseModel):
    trigger_types: dict[str, bool]


# ─── HELPERS ─────────────────────────────────────────────────────────────────


def _get_lightrag_svc():
    try:
        from app.service.lightrag_service import LightRAGService
        return LightRAGService.get_instance()
    except Exception:
        return None


def _get_memory_svc():
    try:
        from app.service.memory_service import get_memory_service
        return get_memory_service()
    except Exception:
        return None


def _get_job_svc():
    from app.service.ingestion_job_service import IngestionJobService
    return IngestionJobService.get_instance()


def _get_mapper_svc():
    from app.service.background_mapper_service import BackgroundMapperService
    return BackgroundMapperService.get_instance()


def _get_settings():
    from app.config import get_settings
    return get_settings()


async def _emit(event_type: str, data: dict) -> None:
    """Broadcast SSE event to all connected boot/stream clients."""
    try:
        from app.controller.boot_controller import boot_emit
        await boot_emit(event_type, data)
    except Exception:
        pass
    try:
        from app.controller.chat_controller import _emit as chat_emit
        await chat_emit(event_type, data)
    except Exception:
        pass


def _neo4j_driver():
    """
    Returns a live Neo4j driver, preferring the memory service's driver,
    or creating a fresh one using config settings.
    """
    mem_svc = _get_memory_svc()
    if mem_svc and getattr(mem_svc, "_neo4j_driver", None):
        return mem_svc._neo4j_driver, False  # (driver, should_close)

    try:
        from neo4j import GraphDatabase
        s = _get_settings()
        mem_cfg = s.memory
        driver = GraphDatabase.driver(
            mem_cfg.neo4j_uri,
            auth=(mem_cfg.neo4j_user, mem_cfg.neo4j_password),
        )
        return driver, True
    except Exception:
        return None, False


# ─── ENDPOINTS ────────────────────────────────────────────────────────────────


@router.get("/status")
async def neural_status() -> dict:
    """
    Returns combined status of all memory layers and LightRAG.
    """
    # --- Layer 1: SQLite sliding window ---
    l1: dict[str, Any] = {"available": False, "record_count": 0, "db_size_mb": 0.0, "fts_indexed": 0}
    try:
        from app.service.memory_service import get_memory_service
        import sqlite3
        from pathlib import Path

        mem_svc = get_memory_service()
        if mem_svc and getattr(mem_svc, "_l1_db_path", None):
            db_path = Path(mem_svc._l1_db_path)
        else:
            db_path = Path.home() / ".aura" / "memory.db"

        if db_path.exists():
            conn = sqlite3.connect(str(db_path))
            try:
                row = conn.execute("SELECT COUNT(*) FROM sliding_window").fetchone()
                record_count = row[0] if row else 0
                # FTS count
                try:
                    fts_row = conn.execute(
                        "SELECT COUNT(*) FROM memory_fts"
                    ).fetchone()
                    fts_indexed = fts_row[0] if fts_row else 0
                except Exception:
                    fts_indexed = 0
                size_mb = db_path.stat().st_size / (1024 * 1024)
                l1 = {
                    "available": True,
                    "record_count": record_count,
                    "db_size_mb": round(size_mb, 3),
                    "fts_indexed": fts_indexed,
                }
            finally:
                conn.close()
    except Exception as exc:
        logger.debug("[neural/status] L1 probe failed: %s", exc)

    # --- Layer 2: ChromaDB embeddings ---
    l2: dict[str, Any] = {"available": False, "total_embeddings": 0, "embedding_model": ""}
    try:
        mem_svc = _get_memory_svc()
        if mem_svc and getattr(mem_svc, "_l2_available", False):
            collection = getattr(mem_svc, "_collection", None)
            if collection is not None:
                count = collection.count()
                l2 = {
                    "available": True,
                    "total_embeddings": count,
                    "embedding_model": "e5-small-v2",
                }
    except Exception as exc:
        logger.debug("[neural/status] L2 probe failed: %s", exc)

    # --- Layer 3: Neo4j facts ---
    l3: dict[str, Any] = {"available": False, "fact_count": 0, "db_size_mb": 0.0}
    try:
        mem_svc = _get_memory_svc()
        if mem_svc and getattr(mem_svc, "_l3_available", False):
            driver, should_close = _neo4j_driver()
            if driver:
                try:
                    with driver.session(database=mem_svc._neo4j_database) as session:
                        result = session.run("MATCH (f:Fact) RETURN count(f) AS cnt")
                        record = result.single()
                        fact_count = record["cnt"] if record else 0
                    l3 = {
                        "available": True,
                        "fact_count": fact_count,
                        "db_size_mb": 0.0,
                    }
                finally:
                    if should_close:
                        driver.close()
    except Exception as exc:
        logger.debug("[neural/status] L3 probe failed: %s", exc)

    # --- LightRAG ---
    lightrag: dict[str, Any] = {
        "available": False,
        "queue_size": 0,
        "seen_ids": 0,
        "entity_count": 0,
        "relation_count": 0,
    }
    try:
        lr_svc = _get_lightrag_svc()
        if lr_svc:
            status = lr_svc.index_status()
            lightrag = {
                "available": status.get("available", False),
                "queue_size": status.get("queue_size", 0),
                "seen_ids": status.get("seen_ids_count", 0),
                "entity_count": status.get("entity_count", 0),
                "relation_count": status.get("relation_count", 0),
            }
    except Exception as exc:
        logger.debug("[neural/status] LightRAG probe failed: %s", exc)

    # --- Background mapper status ---
    mapper_status = _get_mapper_svc().get_status()

    # --- Ingestion mode flag ---
    ingestion_mode = False
    try:
        from app.controller.chat_controller import app as _app
        ingestion_mode = getattr(_app.state, "ingestion_mode", False)
    except Exception:
        pass

    return {
        "l1": l1,
        "l2": l2,
        "l3": l3,
        "lightrag": lightrag,
        "ingestion_mode": ingestion_mode,
        "background_mapper": {
            "enabled": mapper_status["enabled"],
            "last_scan_at": mapper_status["last_scan_at"],
            "next_scan_in_seconds": mapper_status["next_scan_in_seconds"],
        },
    }


@router.get("/graph")
async def neural_graph(
    limit: int = Query(500, ge=1, le=5000),
    entity_type: str = Query(""),
    search: str = Query(""),
) -> dict:
    """
    Query Neo4j lightrag_knowledge for Entity nodes and DIRECTED relationships.
    Uses high-degree-first ordering for visual priority.
    Gracefully returns empty graph if Neo4j unavailable.
    """
    empty = {"nodes": [], "edges": [], "meta": {"total_nodes": 0, "total_edges": 0, "truncated": False}}

    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(
            None, _sync_fetch_graph, limit, entity_type, search
        )
        return result
    except Exception as exc:
        logger.debug("[neural/graph] Graph query failed: %s", exc)
        return empty


_graph_cache: dict[str, Any] = {"mtime": 0, "nodes": [], "edges": [], "adj": {}}


def _load_graphml_cache() -> dict:
    """Parse LightRAG's GraphML file with mtime-based caching."""
    from pathlib import Path
    import xml.etree.ElementTree as ET

    graphml_path = Path.home() / ".aura" / "lightrag" / "graph_chunk_entity_relation.graphml"
    if not graphml_path.exists():
        return _graph_cache

    mtime = graphml_path.stat().st_mtime
    if mtime == _graph_cache["mtime"]:
        return _graph_cache

    ns = "{http://graphml.graphdrawing.org/xmlns}"
    tree = ET.parse(str(graphml_path))
    root = tree.getroot()
    graph = root.find(f"{ns}graph")
    if graph is None:
        return _graph_cache

    nodes = []
    adj: dict[str, int] = {}  # node_id → degree

    for node_el in graph.findall(f"{ns}node"):
        node_id = node_el.get("id", "")
        data = {}
        for d in node_el.findall(f"{ns}data"):
            data[d.get("key", "")] = d.text or ""
        nodes.append({
            "id": node_id,
            "label": node_id,
            "type": data.get("d1", "unknown"),
            "description": data.get("d2", ""),
        })

    edges = []
    for edge_el in graph.findall(f"{ns}edge"):
        src = edge_el.get("source", "")
        tgt = edge_el.get("target", "")
        data = {}
        for d in edge_el.findall(f"{ns}data"):
            data[d.get("key", "")] = d.text or ""
        edges.append({
            "id": edge_el.get("id", f"e_{src}_{tgt}"),
            "source": src,
            "target": tgt,
            "label": data.get("d8", ""),
            "weight": float(data.get("d7", "1.0") or "1.0"),
        })
        adj[src] = adj.get(src, 0) + 1
        adj[tgt] = adj.get(tgt, 0) + 1

    # Attach degree to nodes
    for n in nodes:
        n["degree"] = adj.get(n["id"], 0)

    _graph_cache["mtime"] = mtime
    _graph_cache["nodes"] = nodes
    _graph_cache["edges"] = edges
    _graph_cache["adj"] = adj

    logger.info("[neural/graph] Parsed GraphML: %d nodes, %d edges", len(nodes), len(edges))
    return _graph_cache


def _sync_fetch_graph(limit: int, entity_type: str, search: str) -> dict:
    """Query LightRAG's GraphML file for graph visualization."""
    empty = {"nodes": [], "edges": [], "meta": {"total_nodes": 0, "total_edges": 0, "truncated": False}}

    try:
        cache = _load_graphml_cache()
    except Exception as exc:
        logger.debug("[neural/graph] GraphML parse error: %s", exc)
        return empty

    all_nodes = cache.get("nodes", [])
    all_edges = cache.get("edges", [])

    if not all_nodes:
        return empty

    # Filter nodes
    filtered = all_nodes
    if entity_type:
        et_lower = entity_type.lower()
        filtered = [n for n in filtered if n["type"].lower() == et_lower]
    if search:
        s_lower = search.lower()
        filtered = [
            n for n in filtered
            if s_lower in n["label"].lower() or s_lower in n["description"].lower()
        ]

    # Sort by degree descending, take top `limit`
    filtered.sort(key=lambda n: n["degree"], reverse=True)
    truncated = len(filtered) > limit
    filtered = filtered[:limit]

    node_ids = {n["id"] for n in filtered}

    # Filter edges to only include those between selected nodes
    edges = [
        e for e in all_edges
        if e["source"] in node_ids and e["target"] in node_ids
    ][:limit]

    return {
        "nodes": filtered,
        "edges": edges,
        "meta": {
            "total_nodes": len(filtered),
            "total_edges": len(edges),
            "truncated": truncated,
        },
    }


@router.get("/coverage")
async def neural_coverage() -> dict:
    """
    Three-state coverage per source: ingested (TextUnit in Neo4j), queued (in LightRAG), unmapped.
    """
    source_types = ["conversations", "knowledge", "legislative", "documents", "satellites"]

    mapper = _get_mapper_svc()
    job_svc = _get_job_svc()

    # Get Neo4j TextUnit coverage
    coverage_counts = await asyncio.get_running_loop().run_in_executor(
        None, mapper._sync_neo4j_coverage
    )

    # Count queued from LightRAG queue
    lr_svc = _get_lightrag_svc()
    lr_queue_size = 0
    if lr_svc:
        try:
            lr_queue_size = lr_svc.index_status().get("queue_size", 0)
        except Exception:
            pass

    # Get raw totals from mapper count functions
    raw_totals: dict[str, int] = {}
    loop = asyncio.get_running_loop()

    for src in source_types:
        try:
            if src == "conversations":
                raw_totals[src] = await loop.run_in_executor(None, mapper._count_conversations)
            elif src == "knowledge":
                raw_totals[src] = await loop.run_in_executor(None, mapper._count_knowledge)
            elif src == "legislative":
                raw_totals[src] = await loop.run_in_executor(None, mapper._count_legislative)
            else:
                raw_totals[src] = 0
        except Exception:
            raw_totals[src] = 0

    by_source = {}
    overall_total = 0
    overall_mapped = 0

    for src in source_types:
        total = raw_totals.get(src, 0)
        mapped = coverage_counts.get(src, 0)

        # Queued: jobs for this source in active states
        all_jobs = job_svc.get_all_jobs()
        queued_chunks = sum(
            j.get("chunks_total", 0) - j.get("chunks_done", 0)
            for j in all_jobs
            if j.get("source_type") == src
            and j.get("status") in ("queued", "mapping", "mapped", "ingesting")
        )

        unmapped = max(0, total - mapped - queued_chunks)
        pct = round((mapped / total * 100) if total > 0 else 0.0, 1)

        by_source[src] = {
            "total": total,
            "mapped": mapped,
            "queued": queued_chunks,
            "unmapped": unmapped,
            "pct": pct,
        }
        overall_total += total
        overall_mapped += mapped

    overall_pct = round(
        (overall_mapped / overall_total * 100) if overall_total > 0 else 0.0, 1
    )

    return {
        "overall": {
            "total": overall_total,
            "mapped": overall_mapped,
            "pct": overall_pct,
        },
        "by_source": by_source,
    }


@router.get("/jobs")
async def neural_jobs() -> dict:
    """Return all ingestion jobs with live progress."""
    job_svc = _get_job_svc()
    if not job_svc._initialized:
        await job_svc.initialize()
    jobs = job_svc.get_all_jobs()
    return {"jobs": jobs}


@router.put("/jobs/{job_id}/action")
async def neural_job_action(job_id: str, body: JobActionRequest) -> dict:
    """Dispatch lifecycle actions to the ingestion job service."""
    job_svc = _get_job_svc()
    if not job_svc._initialized:
        await job_svc.initialize()

    job = job_svc.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")

    action = body.action.lower()

    if action == "map":
        await job_svc.set_status(job_id, "mapping")
    elif action == "ingest":
        await job_svc.set_status(job_id, "queued")
    elif action == "pause":
        await job_svc.set_status(job_id, "paused")
        await job_svc.add_interruption(job_id, reason="manual_pause", trigger="user")
    elif action == "resume":
        await job_svc.close_interruption(job_id)
        await job_svc.set_status(job_id, "ingesting")
    elif action == "cancel":
        await job_svc.set_status(job_id, "failed")
    elif action == "prioritize":
        # Move to front of queue by re-creating with earlier timestamp — update created_at
        from datetime import datetime, timezone, timedelta
        early_ts = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        await job_svc.update_job(job_id, created_at=early_ts, status="queued")
    else:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action!r}")

    return {"ok": True, "job_id": job_id, "action": action}


@router.get("/sources")
async def neural_sources() -> dict:
    """Return known source types with ingestion_enabled flag from settings."""
    settings = _get_settings()
    disabled_sources: list[str] = getattr(settings, "lightrag_disabled_sources", [])

    source_defs = [
        {"id": "conversations", "label": "Conversations", "description": "Chat history and sliding window memory"},
        {"id": "knowledge", "label": "Knowledge Base", "description": "Indexed documents in ~/.aura/knowledge/"},
        {"id": "legislative", "label": "Legislative", "description": "Legislation and policy databases"},
        {"id": "documents", "label": "Documents", "description": "Uploaded PDFs and documents"},
        {"id": "satellites", "label": "Satellites", "description": "Satellite node data feeds"},
    ]

    sources = []
    for src in source_defs:
        sources.append({
            **src,
            "ingestion_enabled": src["id"] not in disabled_sources,
        })

    return {"sources": sources}


@router.put("/sources/{source_id}/ingestion")
async def neural_source_ingestion(source_id: str, body: IngestionToggleRequest) -> dict:
    """Enable or disable LightRAG ingestion for a specific source type."""
    settings = _get_settings()

    disabled: list[str] = list(getattr(settings, "lightrag_disabled_sources", []))

    if body.enabled:
        if source_id in disabled:
            disabled.remove(source_id)
    else:
        if source_id not in disabled:
            disabled.append(source_id)

    # Persist to settings object (runtime only — pydantic settings are immutable by default,
    # so we use object.__setattr__ to set it on the live singleton)
    try:
        object.__setattr__(settings, "lightrag_disabled_sources", disabled)
    except Exception:
        pass

    return {"ok": True, "source_id": source_id, "ingestion_enabled": body.enabled}


@router.get("/mapper")
async def neural_mapper_status() -> dict:
    """Return background mapper status."""
    mapper = _get_mapper_svc()
    return mapper.get_status()


@router.put("/mapper/toggle")
async def neural_mapper_toggle(body: MapperToggleRequest) -> dict:
    """Toggle the background mapper service."""
    mapper = _get_mapper_svc()
    mapper.set_enabled(body.enabled)
    return {"ok": True, "enabled": body.enabled}


@router.post("/ingestion-mode/start")
async def neural_ingestion_mode_start(body: IngestionModeStartRequest) -> dict:
    """
    Enter ingestion mode:
    1. Set app state ingestion_mode = True
    2. Emit SSE event

    Note: No model swapping — ingestion uses the interface model (qwen3.5:9b)
    which is always in VRAM. Ingestion rate is controlled by idle-gating.
    """
    # 1. Set app state
    try:
        from app.controller.chat_controller import app as _app
        _app.state.ingestion_mode = True
    except Exception:
        pass

    # 2. Emit SSE event
    await _emit("ingestion_mode_started", {
        "model": "qwen3.5:9b",
        "workers": body.workers,
        "aggressiveness": body.aggressiveness,
    })

    logger.info(
        "[neural] Ingestion mode started — model=qwen3.5:9b workers=%d aggressiveness=%d",
        body.workers, body.aggressiveness,
    )

    return {"started": True, "model": "qwen3.5:9b", "workers": body.workers}


@router.post("/ingestion-mode/stop")
async def neural_ingestion_mode_stop() -> dict:
    """
    Exit ingestion mode (graceful user stop):
    1. Checkpoint all active jobs
    2. Set ingestion_mode = False
    3. Emit SSE event

    Note: No model swapping needed — interface model stays loaded.
    """
    # 1. Checkpoint all active jobs
    job_svc = _get_job_svc()
    try:
        for job in job_svc.get_all_jobs():
            if job.get("status") == "ingesting":
                await job_svc.set_status(job["id"], "paused")
    except Exception as exc:
        logger.debug("[neural] Job checkpoint failed: %s", exc)

    # 2. Clear ingestion mode flag
    try:
        from app.controller.chat_controller import app as _app
        _app.state.ingestion_mode = False
    except Exception:
        pass

    # 3. Emit SSE
    await _emit("ingestion_mode_stopped", {"reason": "user_stop"})

    logger.info("[neural] Ingestion mode stopped (graceful)")
    return {"stopped": True}


@router.post("/ingestion-mode/trigger-exit")
async def neural_ingestion_mode_trigger_exit(body: IngestionModeTriggerExitRequest) -> dict:
    """
    Exit ingestion mode via automated trigger:
    Same as stop, but also logs interruption to the active ingestion job.
    """
    job_svc = _get_job_svc()

    # Log interruption to active job
    active = job_svc.get_active_ingestion_job()
    if active:
        await job_svc.add_interruption(
            active["id"],
            reason=body.reason,
            trigger=body.trigger,
        )
        await job_svc.set_status(active["id"], "paused")

    # Clear ingestion mode flag
    try:
        from app.controller.chat_controller import app as _app
        _app.state.ingestion_mode = False
    except Exception:
        pass

    # Emit SSE
    await _emit("ingestion_mode_stopped", {
        "reason": body.reason,
        "trigger": body.trigger,
        "auto_resume": body.auto_resume,
    })

    logger.info(
        "[neural] Ingestion mode trigger-exit — reason=%s trigger=%s auto_resume=%s",
        body.reason, body.trigger, body.auto_resume,
    )

    return {
        "stopped": True,
        "reason": body.reason,
        "trigger": body.trigger,
        "auto_resume": body.auto_resume,
    }


@router.post("/graph/rebuild")
async def neural_graph_rebuild(body: GraphRebuildRequest) -> dict:
    """
    Rebuild the LightRAG graph from scratch.
    Archives old graph, clears tracking, reinitializes.
    Backfill worker will re-process all documents with qwen3.5:9b.
    """
    if not body.confirm:
        raise HTTPException(400, "Set confirm=true to rebuild the graph")

    lr_svc = _get_lightrag_svc()
    if lr_svc is None:
        raise HTTPException(503, "LightRAG service not available")

    result = await lr_svc.rebuild_graph()

    if result.get("success"):
        await _emit("graph_rebuild_started", {"backup": result.get("backup")})
        logger.info("[neural] Graph rebuild started — backup=%s", result.get("backup"))
    else:
        logger.warning("[neural] Graph rebuild failed: %s", result.get("error"))

    return result


@router.get("/interrupt-config")
async def neural_get_interrupt_config() -> dict:
    """Return the interrupt trigger configuration."""
    settings = _get_settings()
    default_config = {
        "news_keyword": True,
        "scheduled_report": True,
        "satellite_alert": True,
        "user_message": True,
        "low_memory": True,
        "model_request": True,
    }
    stored = getattr(settings, "lightrag_interrupt_config", None)
    if stored and isinstance(stored, dict):
        merged = {**default_config, **stored}
    else:
        merged = default_config

    return {"trigger_types": merged}


@router.put("/interrupt-config")
async def neural_set_interrupt_config(body: InterruptConfigRequest) -> dict:
    """Save interrupt trigger configuration to settings."""
    settings = _get_settings()
    try:
        object.__setattr__(settings, "lightrag_interrupt_config", body.trigger_types)
    except Exception as exc:
        logger.debug("[neural] Failed to persist interrupt config: %s", exc)

    return {"ok": True, "trigger_types": body.trigger_types}
