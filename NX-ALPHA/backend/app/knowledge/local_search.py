"""
AURA NX-Alpha — Local FTS5 Search (§3.5)
Queries local SQLite FTS5 indices for Wikipedia, Stack Exchange, PubMed, arXiv.

Data must be downloaded and indexed via Sprint 0.5A scripts.
If a data source is not yet available, queries return empty results (no crash).

SUPPORTED SOURCES:
    wikipedia       — 7M+ articles (115GB ZIM + ~35GB FTS5 index)
    stackexchange   — All sites (70GB + ~40GB FTS5 index)
    pubmed          — 40M abstracts (25GB + ~25GB FTS5 index)
    arxiv           — Metadata only (4GB + ~3GB index)
    gutenberg       — Full text (15GB + ~8GB index)

DATABASE PATHS:
    {knowledge_data_path}/wikipedia/fts5.db
    {knowledge_data_path}/stackexchange/fts5.db
    {knowledge_data_path}/pubmed/fts5.db
    {knowledge_data_path}/arxiv/fts5.db
    {knowledge_data_path}/gutenberg/fts5.db
"""

import logging
from pathlib import Path
from typing import Any, Optional

import aiosqlite

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SOURCE CONFIG
# ─────────────────────────────────────────────────────────────────────────────

# Known sources with specific schemas (e.g. Stack Exchange has tags column)
SOURCE_CONFIG: dict[str, dict] = {
    "wikipedia": {
        "db_file": "wikipedia/fts5.db",
        "table":   "articles_fts",
        "cols":    ("title", "content"),
        "limit":   5,
    },
    "stackexchange": {
        "db_file": "stackexchange/fts5.db",
        "table":   "posts_fts",
        "cols":    ("title", "body", "tags"),
        "limit":   5,
    },
    "pubmed": {
        "db_file": "pubmed/fts5.db",
        "table":   "abstracts_fts",
        "cols":    ("title", "abstract", "authors"),
        "limit":   5,
    },
    "arxiv": {
        "db_file": "arxiv/fts5.db",
        "table":   "papers_fts",
        "cols":    ("title", "abstract", "categories"),
        "limit":   5,
    },
    "gutenberg": {
        "db_file": "gutenberg/fts5.db",
        "table":   "texts_fts",
        "cols":    ("title", "author", "snippet"),
        "limit":   3,
    },
    "skills": {
        "db_file": "skills/fts5.db",
        "table":   "skills_fts",
        "cols":    ("title", "content"),
        "limit":   3,
    },
}


_FTS5_STOP_WORDS = frozenset({
    "a", "an", "the", "is", "in", "on", "at", "to", "of", "and", "or",
    "how", "do", "you", "can", "be", "was", "are", "what", "why", "when",
    "where", "who", "which", "that", "this", "it", "its", "for", "with",
    "by", "from", "about", "should", "would", "could", "will", "does",
    "me", "my", "we", "our", "your", "their", "did", "has", "have", "had",
    "i", "he", "she", "they", "us", "him", "her", "them", "give", "tell",
    "please", "some", "any", "all", "not", "no", "so", "if", "but",
})


def _sanitize_fts5(query: str) -> str:
    """
    Convert a natural-language query to an FTS5 search expression.
    Extracts meaningful terms (strips operators and stop words) for implicit
    AND semantics — much more likely to match than full-phrase quoting.
    Falls back to a sanitized single phrase if no terms survive.
    """
    import re
    # Strip FTS5 special characters
    clean = re.sub(r'["\'^*(){}[\]:~?!,]', ' ', query)
    terms = [
        t.lower() for t in clean.split()
        if t.lower() not in _FTS5_STOP_WORDS and len(t) > 2
    ]
    if not terms:
        # Last resort: quote the cleaned string as a phrase
        return '"' + clean.strip().replace('"', '""') + '"'
    return ' '.join(terms)


def _auto_discover_sources(knowledge_root: str | Path) -> None:
    """
    Scan knowledge_root for fts5.db files and register any that aren't
    already in SOURCE_CONFIG. ZIM-indexed sources use articles_fts schema.
    """
    root = Path(knowledge_root).expanduser()
    if not root.exists():
        return

    for db_file in root.rglob("fts5.db"):
        source_id = db_file.parent.name
        if source_id in SOURCE_CONFIG:
            continue

        # Auto-register with articles_fts schema (ZIM default)
        SOURCE_CONFIG[source_id] = {
            "db_file": f"{source_id}/fts5.db",
            "table":   "articles_fts",
            "cols":    ("title", "content"),
            "limit":   5,
        }
        logger.info("[local_search] Auto-discovered source: %s", source_id)


# ─────────────────────────────────────────────────────────────────────────────
# LOCAL SEARCH
# ─────────────────────────────────────────────────────────────────────────────

class LocalSearch:
    """
    Queries local FTS5 SQLite databases.
    Each database is opened on first use and kept open for the process lifetime.
    Returns empty list if the data source is not yet downloaded/indexed.
    """

    def __init__(self, knowledge_data_path: str | Path):
        self._base = Path(knowledge_data_path).expanduser()
        self._connections: dict[str, Optional[aiosqlite.Connection]] = {}
        _auto_discover_sources(self._base)

    async def _get_conn(self, source: str) -> Optional[aiosqlite.Connection]:
        # Only return a cached connection if it's a live (non-None) one.
        # Failed connections are NOT cached so the next query retries.
        conn = self._connections.get(source)
        if conn is not None:
            return conn

        cfg = SOURCE_CONFIG.get(source)
        if not cfg:
            return None

        db_path = self._base / cfg["db_file"]
        if not db_path.exists():
            logger.debug("[local_search] %s not yet downloaded: %s", source, db_path)
            return None  # don't cache — file may appear later

        try:
            conn = await aiosqlite.connect(str(db_path))
            conn.row_factory = aiosqlite.Row
            # Checkpoint any stale WAL before first query — a large WAL file
            # forces SQLite to replay it on every new connection, causing hangs.
            wal_path = Path(str(db_path) + "-wal")
            if wal_path.exists() and wal_path.stat().st_size > 1_000_000:  # >1MB
                logger.info("[local_search] Checkpointing large WAL for %s (%dMB)", source, wal_path.stat().st_size // 1_000_000)
                await conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self._connections[source] = conn
            logger.info("[local_search] Connected to %s FTS5 at %s", source, db_path)
            return conn
        except Exception as exc:
            logger.warning("[local_search] Failed to open %s: %s", source, exc)
            return None  # don't cache — allow retry on next query

    async def search(
        self,
        source: str,
        query: str,
        limit: Optional[int] = None,
    ) -> list[dict]:
        """
        Run an FTS5 MATCH query against a local source.
        Returns list of result dicts, empty if source unavailable.
        """
        cfg = SOURCE_CONFIG.get(source)
        if not cfg:
            return []

        conn = await self._get_conn(source)
        if conn is None:
            return []

        n = limit or cfg["limit"]
        table = cfg["table"]
        cols = ", ".join(cfg["cols"])

        try:
            async with conn.execute(
                f"SELECT {cols}, rank FROM {table} WHERE {table} MATCH ? ORDER BY rank LIMIT ?",
                (_sanitize_fts5(query), n),
            ) as cursor:
                rows = await cursor.fetchall()
            return [dict(row) for row in rows]
        except Exception as exc:
            logger.warning("[local_search] FTS5 query failed on %s: %s", source, exc)
            return []

    async def multi_search(
        self,
        sources: list[str],
        query: str,
        limit_per_source: int = 3,
    ) -> dict[str, list[dict]]:
        """Search multiple sources in parallel. Returns {source: results}."""
        import asyncio
        tasks = {src: self.search(src, query, limit_per_source) for src in sources}
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        return {
            src: (res if isinstance(res, list) else [])
            for src, res in zip(tasks.keys(), results)
        }

    def available_sources(self) -> list[str]:
        """Return list of sources whose FTS5 databases exist on disk."""
        available = []
        for source, cfg in SOURCE_CONFIG.items():
            db_path = self._base / cfg["db_file"]
            if db_path.exists():
                available.append(source)
        return available

    async def close(self) -> None:
        for conn in self._connections.values():
            if conn:
                await conn.close()
        self._connections.clear()


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_local_search: Optional[LocalSearch] = None


def get_local_search() -> LocalSearch:
    global _local_search
    if _local_search is None:
        from app.config import get_settings
        path = get_settings().storage.resolve_path("knowledge_data_path")
        _local_search = LocalSearch(path)
    return _local_search
