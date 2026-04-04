"""
lightrag_service.py
───────────────────
AURA LightRAG integration — entity extraction and graph-enhanced RAG.

Architecture:
  - Uses Neo4j `lightrag_knowledge` database (separate from `aura_memory`)
  - LLM binding: Ollama via OpenAI-compatible endpoint at localhost:11434/v1
  - Working directory: ~/.aura/lightrag/ (LightRAG's own vector + KV storage)
  - Async ingest queue with deduplication (source_id based)

Ingestion paths:
  1. FTS5 sync worker: polls memory_fts for ALL new entries (newest-first),
     automatically covering every ingestion path in the system.
  2. Batch: ingestion scripts call ingest_document() directly for bulk population.

The sync worker uses a two-pass strategy:
  Pass 1 (hot):     entries newer than high watermark — processed first (DESC)
  Pass 2 (backfill): older unprocessed entries — filled during idle time (DESC)

Retrieval modes (passed to query()):
  local   — entity subgraph traversal (best for specific concept lookups)
  global  — community/theme level (best for broad cross-domain questions)
  hybrid  — combines local + global (recommended default)
  naive   — simple vector search fallback
"""

import asyncio
import hashlib
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)

# ── Availability check ────────────────────────────────────────────────────────
try:
    from lightrag import LightRAG, QueryParam
    from lightrag.llm.ollama import ollama_model_complete
    from lightrag.utils import EmbeddingFunc
    _LIGHTRAG_AVAILABLE = True
    logger.debug("[lightrag_service] lightrag-hku available")
except ImportError:
    _LIGHTRAG_AVAILABLE = False
    logger.info("[lightrag_service] lightrag-hku not installed — LightRAG disabled")
    logger.info("[lightrag_service] Install with: pip install lightrag-hku")

_WORKING_DIR = str(Path.home() / ".aura" / "lightrag")
_OLLAMA_HOST = "http://127.0.0.1:11434"
_EMBED_MODEL  = "nomic-embed-text"   # Fast local embedding via Ollama — fallback to mxbai-embed-large
_LLM_MODEL    = "qwen2.5:3b"         # Entity extraction LLM — lightweight, fast for batch extraction


class LightRAGService:
    """
    Singleton service managing AURA's LightRAG instance.

    Usage:
        svc = LightRAGService.get_instance()
        await svc.ingest_document("text...", source_id="doc_123", source_type="skill")
        result = await svc.query("how does LoRA fine-tuning work?", mode="hybrid")
    """

    _instance: "LightRAGService | None" = None

    def __init__(self) -> None:
        self._rag: "LightRAG | None" = None
        self._available = False
        self._ingest_queue: asyncio.Queue = asyncio.Queue(maxsize=500)
        self._seen_ids: set[str] = set()
        self._worker_task: asyncio.Task | None = None
        self._sync_task: asyncio.Task | None = None

    @classmethod
    def get_instance(cls) -> "LightRAGService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def initialize(self) -> None:
        """Initialize LightRAG with Ollama LLM + Neo4j graph backend."""
        if not _LIGHTRAG_AVAILABLE:
            logger.warning("[lightrag_service] LightRAG not available — skipping init")
            return
        if self._available:
            return

        try:
            Path(_WORKING_DIR).mkdir(parents=True, exist_ok=True)

            # Configure Ollama as the LLM and embedding provider
            os.environ.setdefault("OPENAI_BASE_URL", f"{_OLLAMA_HOST}/v1")
            os.environ.setdefault("OPENAI_API_KEY", "ollama")

            # LightRAG 1.4.x API: pass llm function + model name + kwargs separately.
            # Do NOT wrap ollama_model_complete — LightRAG injects model= internally.
            # For embedding: use ollama_embed.func to bypass the hardcoded 1024-dim
            # EmbeddingFunc wrapper; nomic-embed-text is 768-dim.
            import numpy as np
            from lightrag.llm.ollama import ollama_embed as _ollama_embed_wrapped

            async def _embed_func(texts: list[str]) -> np.ndarray:
                result = await _ollama_embed_wrapped.func(
                    texts,
                    embed_model=_EMBED_MODEL,
                    host=_OLLAMA_HOST,
                )
                return np.array(result, dtype=np.float32)

            embedding_func = EmbeddingFunc(
                embedding_dim=768,        # nomic-embed-text output dim
                max_token_size=8192,
                func=_embed_func,
            )

            self._rag = LightRAG(
                working_dir=_WORKING_DIR,
                llm_model_func=ollama_model_complete,
                llm_model_name=_LLM_MODEL,
                llm_model_kwargs={
                    "host": _OLLAMA_HOST,
                    "options": {"num_ctx": 8192},
                    "timeout": 600,
                },
                embedding_func=embedding_func,
                enable_llm_cache=False,
                enable_llm_cache_for_entity_extract=False,
            )

            await self._rag.initialize_storages()
            self._available = True

            # Start background ingest worker + FTS5 sync worker
            self._worker_task = asyncio.create_task(self._ingest_worker())
            self._sync_task = asyncio.create_task(self._fts5_sync_worker())

            logger.info("[lightrag_service] LightRAG initialized — working_dir=%s", _WORKING_DIR)

        except Exception as exc:
            logger.warning("[lightrag_service] LightRAG init failed: %s", exc)
            self._available = False

    async def _ingest_worker(self) -> None:
        """Background worker that drains the ingest queue."""
        while True:
            try:
                text, source_id, source_type = await self._ingest_queue.get()
                try:
                    await self._rag.ainsert(text)
                    logger.debug("[lightrag_service] Ingested source_id=%s type=%s", source_id, source_type)
                except Exception as exc:
                    logger.warning("[lightrag_service] Ingest failed for %s: %s", source_id, exc)
                finally:
                    self._ingest_queue.task_done()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("[lightrag_service] Worker error: %s", exc)
                await asyncio.sleep(1)

    def enqueue_ingest(self, text: str, source_id: str, source_type: str = "conversation") -> bool:
        """
        Non-blocking enqueue for real-time ingestion (called from memory_service.record()).
        Returns False if queue is full or LightRAG not available.
        Deduplicates by source_id.
        """
        if not self._available or self._rag is None:
            return False

        # Dedup by source_id
        dedup_key = hashlib.sha256(source_id.encode()).hexdigest()[:16]
        if dedup_key in self._seen_ids:
            return False
        self._seen_ids.add(dedup_key)

        # Keep seen_ids bounded to 50k entries
        if len(self._seen_ids) > 50_000:
            self._seen_ids = set(list(self._seen_ids)[-25_000:])

        try:
            self._ingest_queue.put_nowait((text, source_id, source_type))
            return True
        except asyncio.QueueFull:
            return False

    async def ingest_document(self, text: str, source_id: str, source_type: str = "document") -> dict:
        """
        Direct async ingest — for batch scripts and lightrag_tool.py.
        Awaits completion (unlike enqueue_ingest which is fire-and-forget).
        """
        if not self._available or self._rag is None:
            return {"success": False, "error": "LightRAG not initialized"}

        dedup_key = hashlib.sha256(source_id.encode()).hexdigest()[:16]
        if dedup_key in self._seen_ids:
            return {"success": True, "skipped": True, "reason": "already ingested"}
        self._seen_ids.add(dedup_key)

        try:
            await self._rag.ainsert(text)
            return {"success": True, "source_id": source_id, "source_type": source_type}
        except Exception as exc:
            logger.warning("[lightrag_service] Direct ingest failed for %s: %s", source_id, exc)
            return {"success": False, "error": str(exc)}

    async def query(
        self,
        query_text: str,
        mode: Literal["local", "global", "hybrid", "naive"] = "hybrid",
    ) -> dict:
        """Query the LightRAG knowledge graph."""
        if not self._available or self._rag is None:
            return {"success": False, "error": "LightRAG not initialized", "result": ""}

        try:
            result = await self._rag.aquery(
                query_text,
                param=QueryParam(mode=mode),
            )
            return {"success": True, "result": result, "mode": mode}
        except Exception as exc:
            logger.warning("[lightrag_service] Query failed: %s", exc)
            return {"success": False, "error": str(exc), "result": ""}

    # ── FTS5 Sync Worker ───────────────────────────────────────────────────────

    async def _fts5_sync_worker(self, poll_interval: float = 30.0) -> None:
        """
        Background worker that polls memory_fts for new entries and enqueues
        them into LightRAG for entity extraction.

        Two-pass strategy (newest-first):
          Pass 1: entries newer than high watermark (hot path, always first)
          Pass 2: old unprocessed entries (backfill, only when hot path empty)
        """
        watermark_path = Path(_WORKING_DIR) / "fts5_high_watermark.txt"

        high_wm = 0.0
        if watermark_path.exists():
            try:
                high_wm = float(watermark_path.read_text().strip())
            except (ValueError, OSError):
                pass

        self._ensure_processed_table()

        while True:
            try:
                await asyncio.sleep(poll_interval)
                if not self._available:
                    continue

                from app.service.memory_service import get_memory_service
                mem = get_memory_service()
                if mem is None:
                    continue

                from app.config import get_settings
                disabled = getattr(get_settings(), "lightrag_disabled_sources", [])

                # PASS 1: Hot path — newest entries (> high watermark), DESC
                new_rows = self._query_fts5_newer_than(mem._l1_path, high_wm, limit=50)

                if new_rows:
                    for row in new_rows:
                        source_type = self._classify_source(row)
                        if source_type not in disabled:
                            self.enqueue_ingest(
                                row["content"],
                                source_id=row["doc_id"],
                                source_type=source_type,
                            )
                        self._mark_processed(mem._l1_path, row["doc_id"])
                        high_wm = max(high_wm, float(row["timestamp"]))

                    watermark_path.write_text(str(high_wm))
                    continue  # prioritize new data — skip backfill this cycle

                # PASS 2: Backfill — old unprocessed entries, newest-of-old first
                old_rows = self._query_fts5_unprocessed(mem._l1_path, high_wm, limit=20)

                if old_rows:
                    for row in old_rows:
                        source_type = self._classify_source(row)
                        if source_type not in disabled:
                            self.enqueue_ingest(
                                row["content"],
                                source_id=row["doc_id"],
                                source_type=source_type,
                            )
                        self._mark_processed(mem._l1_path, row["doc_id"])

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("[lightrag_service] FTS5 sync error: %s", exc)
                await asyncio.sleep(poll_interval)

    def _ensure_processed_table(self) -> None:
        """Create the lightrag_processed tracking table if it doesn't exist."""
        from app.service.memory_service import get_memory_service
        mem = get_memory_service()
        if mem is None:
            return
        with sqlite3.connect(mem._l1_path) as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS lightrag_processed (
                    doc_id TEXT PRIMARY KEY,
                    processed_at REAL NOT NULL
                )
            """)
            db.execute("""
                CREATE INDEX IF NOT EXISTS idx_lrp_ts
                ON lightrag_processed(processed_at)
            """)

    @staticmethod
    def _query_fts5_newer_than(db_path: str, since_ts: float, limit: int = 50) -> list[dict]:
        """Newest entries first — hot path for real-time data."""
        with sqlite3.connect(db_path) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                "SELECT doc_id, content, thread_id, agent_role, area_id, timestamp "
                "FROM memory_fts WHERE CAST(timestamp AS REAL) > ? "
                "ORDER BY CAST(timestamp AS REAL) DESC LIMIT ?",
                (since_ts, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def _query_fts5_unprocessed(db_path: str, before_ts: float, limit: int = 20) -> list[dict]:
        """Backfill: old entries not yet processed, newest-of-old first."""
        with sqlite3.connect(db_path) as db:
            db.row_factory = sqlite3.Row
            rows = db.execute(
                "SELECT f.doc_id, f.content, f.thread_id, f.agent_role, f.area_id, f.timestamp "
                "FROM memory_fts f "
                "LEFT JOIN lightrag_processed p ON f.doc_id = p.doc_id "
                "WHERE p.doc_id IS NULL AND CAST(f.timestamp AS REAL) <= ? "
                "ORDER BY CAST(f.timestamp AS REAL) DESC LIMIT ?",
                (before_ts, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    @staticmethod
    def _mark_processed(db_path: str, doc_id: str) -> None:
        """Record that a doc_id has been sent to LightRAG."""
        with sqlite3.connect(db_path) as db:
            db.execute(
                "INSERT OR IGNORE INTO lightrag_processed (doc_id, processed_at) VALUES (?, ?)",
                (doc_id, time.time()),
            )

    @staticmethod
    def _classify_source(row: dict) -> str:
        """Derive LightRAG source_type from FTS5 row metadata."""
        doc_id = row.get("doc_id", "")
        agent_role = row.get("agent_role", "")

        if doc_id.startswith("personal_"):
            return "personal"
        if doc_id.startswith("skill_"):
            return "skill"
        if doc_id.startswith("git_"):
            return "git"
        if doc_id.startswith("satellite_"):
            return "satellite"
        if agent_role == "conversation":
            return "conversation"
        return "indexed"

    # ── Status & Lifecycle ────────────────────────────────────────────────────

    def index_status(self) -> dict:
        """Return current ingestion queue and availability status."""
        entity_count = 0
        relation_count = 0
        try:
            import json
            ent_path = Path(_WORKING_DIR) / "kv_store_full_entities.json"
            rel_path = Path(_WORKING_DIR) / "kv_store_full_relations.json"
            if ent_path.exists():
                with open(ent_path, encoding="utf-8") as f:
                    entity_count = len(json.load(f))
            if rel_path.exists():
                with open(rel_path, encoding="utf-8") as f:
                    relation_count = len(json.load(f))
        except Exception:
            pass
        return {
            "available": self._available,
            "queue_size": self._ingest_queue.qsize(),
            "seen_ids_count": len(self._seen_ids),
            "working_dir": _WORKING_DIR,
            "llm_model": _LLM_MODEL,
            "embed_model": _EMBED_MODEL,
            "entity_count": entity_count,
            "relation_count": relation_count,
        }

    async def shutdown(self) -> None:
        """Graceful shutdown — cancel sync worker, drain queue, cancel ingest worker."""
        # Stop sync worker first (stops feeding the queue)
        if self._sync_task and not self._sync_task.done():
            self._sync_task.cancel()
            try:
                await self._sync_task
            except asyncio.CancelledError:
                pass

        if self._worker_task and not self._worker_task.done():
            # Drain queue (up to 30s)
            try:
                await asyncio.wait_for(self._ingest_queue.join(), timeout=30.0)
            except asyncio.TimeoutError:
                logger.warning("[lightrag_service] Shutdown timeout — %d items remaining in queue",
                               self._ingest_queue.qsize())
            self._worker_task.cancel()
            try:
                await self._worker_task
            except asyncio.CancelledError:
                pass
