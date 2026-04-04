"""
AURA NX-Alpha — Qdrant Semantic Search Cache
Wraps qdrant-client for semantic caching of web search results.

Collections:
  search_cache — stores recent search results as embeddings. Future semantically-
                 similar queries (cosine > threshold) return cached results instantly.

Phase 2 upgrade path: add legal_embeddings collection here when legal FTS5 index
is replaced with local vector search (4TB HDD).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Optional

logger = logging.getLogger(__name__)

# Embedding dimensions for all-MiniLM-L6-v2
_VECTOR_SIZE = 384


class QdrantService:
    """Semantic search result cache backed by Qdrant."""

    def __init__(
        self,
        host: str,
        port: int,
        collection: str,
        threshold: float,
        ttl_hours: float,
    ) -> None:
        self._host = host
        self._port = port
        self._collection = collection
        self._threshold = threshold
        self._ttl_secs = ttl_hours * 3600
        self._client = None           # qdrant_client.QdrantClient — lazy init
        self._model = None            # SentenceTransformer — lazy init
        self._collection_ready = False

    # ─────────────────────────────────────────────────────────────────────────
    # Public API
    # ─────────────────────────────────────────────────────────────────────────

    async def ensure_collection(self) -> None:
        """Create the search_cache collection if it doesn't exist.
        Called lazily on first use — never blocks startup.
        """
        if self._collection_ready:
            return
        try:
            await asyncio.to_thread(self._ensure_collection_sync)
            self._collection_ready = True
        except Exception as exc:
            logger.warning("[qdrant] ensure_collection failed: %s", exc)

    async def search_cache(self, query: str) -> list[dict] | None:
        """Return cached results for a semantically similar past query, or None."""
        try:
            await self.ensure_collection()
            vector = await asyncio.to_thread(self._embed, query)
            hits = await asyncio.to_thread(self._search_sync, vector)
            if not hits:
                return None
            hit = hits[0]
            # TTL check
            ts = hit.payload.get("timestamp", 0)
            if time.time() - ts > self._ttl_secs:
                logger.debug("[qdrant] cache EXPIRED for %r", query[:60])
                asyncio.create_task(self._delete_point(hit.id))
                return None
            results = json.loads(hit.payload.get("results", "[]"))
            logger.info("[qdrant] cache HIT (score=%.3f) for %r", hit.score, query[:60])
            return results
        except Exception as exc:
            logger.warning("[qdrant] search_cache error: %s", exc)
            return None

    async def store_results(self, query: str, results: list[dict]) -> None:
        """Embed query and upsert results into the cache. Fire-and-forget safe."""
        if not results:
            return
        try:
            await self.ensure_collection()
            vector = await asyncio.to_thread(self._embed, query)
            point_id = str(uuid.uuid5(uuid.NAMESPACE_URL, query))
            payload = {
                "query": query,
                "results": json.dumps(results),
                "timestamp": time.time(),
            }
            await asyncio.to_thread(self._upsert_sync, point_id, vector, payload)
            logger.debug("[qdrant] stored %d results for %r", len(results), query[:60])
        except Exception as exc:
            logger.warning("[qdrant] store_results error: %s", exc)

    # ─────────────────────────────────────────────────────────────────────────
    # Sync helpers (run via to_thread)
    # ─────────────────────────────────────────────────────────────────────────

    def _get_client(self):
        if self._client is None:
            from qdrant_client import QdrantClient
            self._client = QdrantClient(host=self._host, port=self._port, timeout=5)
        return self._client

    def _get_model(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            self._model = SentenceTransformer("all-MiniLM-L6-v2")
        return self._model

    def _embed(self, text: str) -> list[float]:
        model = self._get_model()
        vec = model.encode(text, normalize_embeddings=True)
        return vec.tolist()

    def _ensure_collection_sync(self) -> None:
        from qdrant_client.models import Distance, VectorParams
        client = self._get_client()
        existing = {c.name for c in client.get_collections().collections}
        if self._collection not in existing:
            client.create_collection(
                collection_name=self._collection,
                vectors_config=VectorParams(size=_VECTOR_SIZE, distance=Distance.COSINE),
            )
            logger.info("[qdrant] created collection '%s'", self._collection)

    def _search_sync(self, vector: list[float]):
        client = self._get_client()
        result = client.query_points(
            collection_name=self._collection,
            query=vector,
            limit=1,
            score_threshold=self._threshold,
            with_payload=True,
        )
        return result.points

    def _upsert_sync(self, point_id: str, vector: list[float], payload: dict) -> None:
        from qdrant_client.models import PointStruct
        client = self._get_client()
        client.upsert(
            collection_name=self._collection,
            points=[PointStruct(id=point_id, vector=vector, payload=payload)],
        )

    async def _delete_point(self, point_id) -> None:
        try:
            from qdrant_client.models import PointIdsList
            client = self._get_client()
            await asyncio.to_thread(
                client.delete,
                collection_name=self._collection,
                points_selector=PointIdsList(points=[point_id]),
            )
        except Exception:
            pass


# ── Singleton ─────────────────────────────────────────────────────────────────
_qdrant: Optional[QdrantService] = None


def get_qdrant_service() -> QdrantService:
    global _qdrant
    if _qdrant is None:
        from app.config import get_settings
        s = get_settings().search
        _qdrant = QdrantService(
            host=s.qdrant_host,
            port=s.qdrant_port,
            collection=s.qdrant_collection,
            threshold=s.semantic_cache_threshold,
            ttl_hours=s.semantic_cache_ttl_hours,
        )
    return _qdrant
