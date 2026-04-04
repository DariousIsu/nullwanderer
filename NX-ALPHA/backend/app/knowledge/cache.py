"""
AURA NX-Alpha — API Response Cache (§3.5 / §4.5)
50GB SQLite LRU cache for all streaming API responses.

TTL per source (see SOURCE_TTL_HOURS).
Eviction policy: LRU — least hits + oldest TTL first.
Hard cap enforced at CACHE_MAX_BYTES (default 50GB).

Schema:
    key          TEXT PRIMARY KEY   — sha256(source + query)
    source       TEXT               — e.g. "courtlistener", "openalex"
    value        BLOB               — JSON-encoded response
    size_bytes   INTEGER
    created_at   REAL               — Unix timestamp
    expires_at   REAL               — Unix timestamp (created_at + TTL)
    hits         INTEGER DEFAULT 0
"""

import asyncio
import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

import aiosqlite

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

CACHE_MAX_BYTES = 50 * 1024 ** 3       # 50 GB hard cap
EVICTION_TARGET = 0.90                 # Evict down to 90% of cap when triggered

SOURCE_TTL_HOURS: dict[str, float] = {
    "courtlistener":   24 * 7,          # 7 days — legal opinions stable
    "cap":             24 * 30,         # 30 days — historical caselaw
    "congress":        6,               # 6 hours — active legislative session
    "govinfo":         24 * 7,
    "openstates":      6,
    "openalex":        24 * 3,          # 3 days — scientific literature
    "ncbi":            24,              # 1 day — PubMed updates daily
    "arxiv":           24 * 7,
    "wikipedia_api":   24 * 90,         # 90 days — encyclopedia is stable
    "wikidata_sparql": 24 * 7,
    "common_crawl":    24 * 30,
    "default":         24,              # 1 day fallback
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_cache (
    key          TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    value        BLOB NOT NULL,
    size_bytes   INTEGER NOT NULL,
    created_at   REAL NOT NULL,
    expires_at   REAL NOT NULL,
    hits         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_source     ON api_cache (source);
CREATE INDEX IF NOT EXISTS idx_expires_at ON api_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_hits       ON api_cache (hits, created_at);
"""


# ─────────────────────────────────────────────────────────────────────────────
# CACHE
# ─────────────────────────────────────────────────────────────────────────────

class APICache:
    """
    Async SQLite LRU cache for streaming API responses.
    Thread-safe via asyncio (single event loop, aiosqlite).
    """

    def __init__(self, db_path: str | Path, max_bytes: int = CACHE_MAX_BYTES):
        self._db_path = Path(db_path).expanduser()
        self._max_bytes = max_bytes
        self._db: Optional[aiosqlite.Connection] = None
        self._lock = asyncio.Lock()
        self._initialized = False

    async def _init(self) -> None:
        if self._initialized:
            return
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(str(self._db_path))
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(SCHEMA)
        await self._db.commit()
        self._initialized = True
        logger.info("[cache] Initialized at %s", self._db_path)

    async def _ensure_init(self) -> None:
        async with self._lock:
            await self._init()

    # ── Cache key ─────────────────────────────────────────────────────────────

    @staticmethod
    def make_key(source: str, query: str) -> str:
        return hashlib.sha256(f"{source}:{query}".encode()).hexdigest()

    # ── Get ───────────────────────────────────────────────────────────────────

    async def get(self, source: str, query: str) -> Optional[Any]:
        """
        Return cached value if present and not expired, else None.
        Increments hit counter on cache hit.
        """
        await self._ensure_init()
        key = self.make_key(source, query)
        now = time.time()

        async with self._lock:
            async with self._db.execute(
                "SELECT value, expires_at FROM api_cache WHERE key = ?", (key,)
            ) as cursor:
                row = await cursor.fetchone()

            if row is None:
                return None

            if row["expires_at"] < now:
                # Expired — delete and return miss
                await self._db.execute("DELETE FROM api_cache WHERE key = ?", (key,))
                await self._db.commit()
                return None

            # Hit — bump counter
            await self._db.execute(
                "UPDATE api_cache SET hits = hits + 1 WHERE key = ?", (key,)
            )
            await self._db.commit()

        return json.loads(row["value"])

    # ── Set ───────────────────────────────────────────────────────────────────

    async def set(self, source: str, query: str, value: Any) -> None:
        """Write a value to cache. Triggers LRU eviction if cap is exceeded."""
        await self._ensure_init()
        key = self.make_key(source, query)
        now = time.time()
        ttl_hours = SOURCE_TTL_HOURS.get(source, SOURCE_TTL_HOURS["default"])
        expires_at = now + ttl_hours * 3600

        serialized = json.dumps(value, ensure_ascii=False).encode()
        size_bytes = len(serialized)

        async with self._lock:
            await self._db.execute(
                """
                INSERT INTO api_cache (key, source, value, size_bytes, created_at, expires_at, hits)
                VALUES (?, ?, ?, ?, ?, ?, 0)
                ON CONFLICT(key) DO UPDATE SET
                    value      = excluded.value,
                    size_bytes = excluded.size_bytes,
                    created_at = excluded.created_at,
                    expires_at = excluded.expires_at,
                    hits       = 0
                """,
                (key, source, serialized, size_bytes, now, expires_at),
            )
            await self._db.commit()
            await self._maybe_evict()

    # ── LRU Eviction ──────────────────────────────────────────────────────────

    async def _maybe_evict(self) -> None:
        """
        If total cache size exceeds cap, evict LRU entries until below 90% cap.
        Called inside the lock — do not acquire lock again.
        Eviction priority: expired first, then lowest hits + oldest.
        """
        async with self._db.execute(
            "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM api_cache"
        ) as cursor:
            row = await cursor.fetchone()
        total = row["total"] if row else 0

        if total <= self._max_bytes:
            return

        target = int(self._max_bytes * EVICTION_TARGET)
        to_free = total - target
        freed = 0
        now = time.time()

        logger.warning(
            "[cache] Over cap (%.1f GB / %.1f GB). Evicting...",
            total / 1024**3, self._max_bytes / 1024**3,
        )

        # Pass 1: expired entries
        async with self._db.execute(
            "SELECT key, size_bytes FROM api_cache WHERE expires_at < ? ORDER BY expires_at ASC",
            (now,),
        ) as cursor:
            rows = await cursor.fetchall()

        for row in rows:
            if freed >= to_free:
                break
            await self._db.execute("DELETE FROM api_cache WHERE key = ?", (row["key"],))
            freed += row["size_bytes"]

        # Pass 2: LRU (fewest hits, oldest) if still over target
        if freed < to_free:
            async with self._db.execute(
                "SELECT key, size_bytes FROM api_cache ORDER BY hits ASC, created_at ASC"
            ) as cursor:
                rows = await cursor.fetchall()

            for row in rows:
                if freed >= to_free:
                    break
                await self._db.execute("DELETE FROM api_cache WHERE key = ?", (row["key"],))
                freed += row["size_bytes"]

        await self._db.commit()
        logger.info("[cache] Evicted %.1f MB", freed / 1024**2)

    # ── Stats ─────────────────────────────────────────────────────────────────

    async def stats(self) -> dict:
        """Return size and entry count."""
        await self._ensure_init()
        async with self._lock:
            async with self._db.execute(
                "SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes), 0) AS total_bytes FROM api_cache"
            ) as cursor:
                row = await cursor.fetchone()
        return {
            "entries": row["entries"],
            "used_gb": round(row["total_bytes"] / 1024**3, 3),
            "quota_gb": self._max_bytes / 1024**3,
            "pct": round(row["total_bytes"] / self._max_bytes * 100, 1) if self._max_bytes else 0,
        }

    async def close(self) -> None:
        if self._db:
            await self._db.close()
            self._db = None
            self._initialized = False


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_cache: Optional[APICache] = None


def get_cache(db_path: Optional[str | Path] = None) -> APICache:
    """Return the singleton APICache instance."""
    global _cache
    if _cache is None:
        from app.config import get_settings
        path = db_path or get_settings().storage.resolve_path("api_cache_path")
        _cache = APICache(path)
    return _cache
