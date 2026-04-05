"""
lightrag_service.py
───────────────────
AURA LightRAG integration — entity extraction and graph-enhanced RAG.

Architecture:
  - Single LightRAG instance using qwen3.5:9b (interface model) via Ollama
    for both queries and background entity extraction.
  - The same model that talks to the user understands the ingested material.
  - Embeddings: nomic-embed-text via Ollama.
  - Working dir: ~/.aura/lightrag/
  - Async ingest queue with deduplication (source_id based)

Idle-gated ingestion:
  Ingestion rate scales with user idle depth:
    active    → paused (nothing starts)
    soft_idle → 1 doc / 5 min (extract only)
    deep_idle → 1 doc / 2 min (extract + reflection)
    away      → 1 doc / 30s  (extract + reflection + batch synthesis)

  On return to active, in-flight extraction finishes but nothing new starts.

Reflection:
  In deep_idle and away, after each extraction the interface model is asked
  what connections it sees between the new material and existing knowledge.
  Insights are re-inserted as synthetic documents, enriching the graph with
  higher-order connections. Batch synthesis runs every 10 docs in away mode.

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
import shutil
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

_WORKING_DIR  = str(Path.home() / ".aura" / "lightrag")
_OLLAMA_HOST  = "http://127.0.0.1:11434"
_EMBED_MODEL  = "nomic-embed-text"   # Fast local embedding via Ollama
_LLM_MODEL    = "qwen3.5:9b"        # Interface model — always in VRAM

# ── Idle-gated ingestion rates ────────────────────────────────────────────────
_COOLDOWN_BY_IDLE = {
    "active":    300,   # 5 min between docs during active use (~10% of away rate)
    "soft_idle": 300,   # 5 min between docs
    "deep_idle": 120,   # 2 min between docs
    "away":       30,   # 30s between docs
}
_COOLDOWN_DEFAULT = 300  # fallback: 5 min
_BATCH_REFLECT_EVERY = 10  # batch synthesis every N docs in away mode
_FTS5_POLL_INTERVAL = 120  # poll every 2 min (was 30s)
_FTS5_HOT_LIMIT = 10       # hot fetch size (was 50)
_FTS5_BACKFILL_LIMIT = 5   # backfill fetch size (was 20)


def _get_idle_state() -> str:
    """Return current idle state string. Safe if screen_awareness not initialized."""
    try:
        from app.service.screen_awareness_service import get_idle_state
        state, _ = get_idle_state()
        return state
    except Exception:
        return "active"


class LightRAGService:
    """
    Singleton service managing AURA's LightRAG instance.

    Single instance using qwen3.5:9b (interface model) for both queries and
    background entity extraction. Ingestion is idle-gated and includes
    reflection for maximum awareness.

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
        self._rebuilding = False
        self._recent_ingestions: list[str] = []  # summaries for batch reflection

    @classmethod
    def get_instance(cls) -> "LightRAGService":
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    async def initialize(self) -> None:
        """Initialize the single LightRAG instance (qwen3.5:9b via Ollama)."""
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

            # Embedding function — nomic-embed-text via Ollama
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

            # Single instance — interface model for both query and ingest
            self._rag = LightRAG(
                working_dir=_WORKING_DIR,
                llm_model_func=ollama_model_complete,
                llm_model_name=_LLM_MODEL,
                llm_model_kwargs={
                    "host": _OLLAMA_HOST,
                    "options": {"num_ctx": 16384},
                    "timeout": 600,
                },
                embedding_func=embedding_func,
                enable_llm_cache=False,
                enable_llm_cache_for_entity_extract=False,
            )

            await self._rag.initialize_storages()
            self._available = True
            logger.info("[lightrag_service] Initialized (model=%s) — working_dir=%s",
                        _LLM_MODEL, _WORKING_DIR)

        except Exception as exc:
            logger.warning("[lightrag_service] LightRAG init failed: %s", exc)
            self._available = False

    async def start_workers(self) -> None:
        """Start background ingest + FTS5 sync workers. Called from boot Phase 3."""
        if not self._available:
            logger.warning(
                "[lightrag_service] Workers NOT started — LightRAG failed to initialize. "
                "Verify Ollama is running and nomic-embed-text is pulled: "
                "`ollama pull nomic-embed-text`"
            )
            return

        self._worker_task = asyncio.create_task(self._ingest_worker())
        self._sync_task = asyncio.create_task(self._fts5_sync_worker())
        logger.info("[lightrag_service] Background workers started (model=%s)", _LLM_MODEL)

    # ── Ingest Worker ─────────────────────────────────────────────────────────

    async def _ingest_worker(self) -> None:
        """Background worker that drains the ingest queue, idle-gated."""
        while True:
            try:
                # Gate: pause only during active rebuild
                idle = _get_idle_state()
                if self._rebuilding:
                    await asyncio.sleep(10)
                    continue

                try:
                    text, source_id, source_type = self._ingest_queue.get_nowait()
                except asyncio.QueueEmpty:
                    await asyncio.sleep(10)
                    continue

                try:
                    await self._rag.ainsert(text)
                    logger.debug("[lightrag_service] Ingested source_id=%s type=%s",
                                 source_id, source_type)

                    # Reflection in deep_idle and away
                    idle = _get_idle_state()
                    if idle in ("deep_idle", "away"):
                        summary = text[:2000]
                        await self._reflect_on_ingestion(summary, source_id)
                        self._recent_ingestions.append(summary)

                        # Batch synthesis every N docs in away mode
                        if idle == "away" and len(self._recent_ingestions) >= _BATCH_REFLECT_EVERY:
                            await self._batch_reflect()
                            self._recent_ingestions.clear()

                except Exception as exc:
                    logger.warning("[lightrag_service] Ingest failed for %s: %s", source_id, exc)
                finally:
                    self._ingest_queue.task_done()

                # Rate limit based on idle depth
                cooldown = _COOLDOWN_BY_IDLE.get(idle, _COOLDOWN_DEFAULT)
                await asyncio.sleep(cooldown)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.warning("[lightrag_service] Worker error: %s", exc)
                await asyncio.sleep(5)

    # ── Reflection ────────────────────────────────────────────────────────────

    async def _reflect_on_ingestion(self, doc_summary: str, doc_id: str) -> None:
        """Ask the interface model what connections it sees in newly ingested material."""
        from app.service.interface_engine import get_engine

        engine = get_engine()
        if not engine:
            return

        try:
            # Query graph for entities related to this document
            related = await self._rag.aquery(
                doc_summary[:500],
                param=QueryParam(mode="local", top_k=10),
            )

            result = await engine.generate([{
                "role": "user",
                "content": (
                    f"You just processed this document:\n{doc_summary}\n\n"
                    f"Related knowledge already in the graph:\n{str(related)[:2000]}\n\n"
                    f"What new connections, patterns, or insights emerge? "
                    f"Be specific about relationships between entities. "
                    f"Format as a brief analytical note."
                )
            }], max_tokens=512, temperature=0.4)

            insight = result.get("text", "").strip()
            if insight and len(insight) > 50:
                # Feed insight back into graph as synthetic document
                await self._rag.ainsert(f"[Insight — {doc_id}] {insight}")
                logger.info("[lightrag_service] Reflection inserted (%d chars)", len(insight))

                # Update world state knowledge key
                self._update_world_state_knowledge(insight)

        except Exception as exc:
            logger.debug("[lightrag_service] Reflection failed (non-fatal): %s", exc)

    async def _batch_reflect(self) -> None:
        """Cross-domain synthesis across recently ingested documents."""
        from app.service.interface_engine import get_engine

        engine = get_engine()
        if not engine:
            return

        try:
            summaries = "\n---\n".join(self._recent_ingestions[-_BATCH_REFLECT_EVERY:])
            result = await engine.generate([{
                "role": "user",
                "content": (
                    f"Review these recently ingested documents:\n{summaries[:4000]}\n\n"
                    f"Identify cross-domain patterns, emerging themes, or "
                    f"connections between previously unrelated topics."
                )
            }], max_tokens=768, temperature=0.5)

            synthesis = result.get("text", "").strip()
            if synthesis and len(synthesis) > 50:
                await self._rag.ainsert(f"[Synthesis] {synthesis}")
                logger.info("[lightrag_service] Batch synthesis inserted (%d chars)", len(synthesis))
                self._update_world_state_knowledge(synthesis)

        except Exception as exc:
            logger.debug("[lightrag_service] Batch reflection failed (non-fatal): %s", exc)

    @staticmethod
    def _update_world_state_knowledge(insight: str) -> None:
        """Push recent ingestion insight into world state knowledge key."""
        try:
            from app.service.idle_triage_service import get_idle_triage
            triage = get_idle_triage()
            if triage:
                triage.world_state["knowledge"] = f"Recently learned: {insight[:300]}"
        except Exception:
            pass

    # ── Public API ────────────────────────────────────────────────────────────

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

    # ── Graph Rebuild ─────────────────────────────────────────────────────────

    async def rebuild_graph(self) -> dict:
        """
        Rebuild the LightRAG graph from scratch.
        1. Pause workers
        2. Archive old graph data
        3. Clear tracking table + watermark
        4. Reinitialize with fresh working directory
        5. Resume workers — backfill re-discovers all documents
        """
        if self._rebuilding:
            return {"success": False, "error": "Rebuild already in progress"}

        self._rebuilding = True
        backup_name = f"lightrag_backup_{int(time.time())}"
        backup_path = str(Path.home() / ".aura" / backup_name)

        try:
            # Archive old graph
            if Path(_WORKING_DIR).exists():
                shutil.move(_WORKING_DIR, backup_path)
                logger.info("[lightrag_service] Archived graph to %s", backup_path)

            # Clear tracking table
            try:
                from app.service.memory_service import get_memory_service
                mem = get_memory_service()
                if mem:
                    with sqlite3.connect(mem._l1_path) as db:
                        db.execute("DELETE FROM lightrag_processed")
                    logger.info("[lightrag_service] Cleared lightrag_processed table")
            except Exception as exc:
                logger.warning("[lightrag_service] Could not clear tracking table: %s", exc)

            # Clean up old worker directory if it exists
            old_worker_dir = Path.home() / ".aura" / "lightrag_worker"
            if old_worker_dir.exists():
                shutil.rmtree(str(old_worker_dir), ignore_errors=True)
                logger.info("[lightrag_service] Removed old worker directory")

            # Reinitialize
            self._available = False
            self._rag = None
            self._seen_ids.clear()
            self._recent_ingestions.clear()
            await self.initialize()

            self._rebuilding = False
            logger.info("[lightrag_service] Graph rebuild initiated — backfill will re-process all documents")
            return {"success": True, "backup": backup_name}

        except Exception as exc:
            self._rebuilding = False
            logger.error("[lightrag_service] Rebuild failed: %s", exc)
            return {"success": False, "error": str(exc)}

    # ── FTS5 Sync Worker ───────────────────────────────────────────────────────

    async def _fts5_sync_worker(self) -> None:
        """
        Background worker that polls memory_fts for new entries and enqueues
        them into LightRAG for entity extraction.

        Two-pass strategy (newest-first):
          Pass 1: entries newer than high watermark (hot path, always first)
          Pass 2: old unprocessed entries (backfill, only when hot path empty)

        Idle-gated: pauses during active use.
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
                await asyncio.sleep(_FTS5_POLL_INTERVAL)

                idle = _get_idle_state()
                if self._rebuilding:
                    continue

                if not self._available:
                    continue

                from app.service.memory_service import get_memory_service
                mem = get_memory_service()
                if mem is None:
                    continue

                from app.config import get_settings
                disabled = getattr(get_settings(), "lightrag_disabled_sources", [])

                # Passive mode during active use — 1 doc per cycle (10% of idle rate)
                hot_limit = 1 if idle == "active" else _FTS5_HOT_LIMIT
                backfill_limit = 1 if idle == "active" else _FTS5_BACKFILL_LIMIT

                # PASS 1: Hot path — newest entries (> high watermark), DESC
                new_rows = self._query_fts5_newer_than(mem._l1_path, high_wm, limit=hot_limit)

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
                old_rows = self._query_fts5_unprocessed(mem._l1_path, high_wm, limit=backfill_limit)

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
                await asyncio.sleep(_FTS5_POLL_INTERVAL)

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
    def _query_fts5_newer_than(db_path: str, since_ts: float, limit: int = 10) -> list[dict]:
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
    def _query_fts5_unprocessed(db_path: str, before_ts: float, limit: int = 5) -> list[dict]:
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
            "rebuilding": self._rebuilding,
            "idle_state": _get_idle_state(),
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
