"""
Newsletter Ingestion Service — dual-path RSS/Atom polling for Substack + Kill the Newsletter.

Two ingestion paths feed into one unified archive:
  1. Substack  — direct RSS polling at {slug}.substack.com/feed
  2. KtN       — Kill the Newsletter Atom feeds for email-based newsletters

Storage: SQLite (archive + FTS5) + ChromaDB (semantic search).

Supabase swap path:
  Same as citation_results_service — replace _execute/_fetchall internals with supabase-py.
"""

import asyncio
import logging
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Optional

import feedparser

logger = logging.getLogger(__name__)

_DB_PATH_DEFAULT = "~/.aura/newsletters.db"


class FeedSource(str, Enum):
    SUBSTACK = "substack"
    KTN = "ktn"


# ── DDL ──────────────────────────────────────────────────────────────────────

_CREATE_FEEDS = """
CREATE TABLE IF NOT EXISTS feeds (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    source          TEXT NOT NULL,
    feed_url        TEXT NOT NULL,
    email           TEXT,
    substack_slug   TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    last_polled     TEXT,
    active          INTEGER DEFAULT 1
);
"""

_CREATE_ENTRIES = """
CREATE TABLE IF NOT EXISTS entries (
    id              TEXT PRIMARY KEY,
    feed_id         TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    guid            TEXT NOT NULL,
    title           TEXT,
    author          TEXT,
    published_at    TEXT,
    content_html    TEXT,
    content_text    TEXT,
    embedded        INTEGER DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now')),
    UNIQUE(feed_id, guid)
);
"""

_CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_entries_feed ON entries(feed_id, published_at DESC);",
    "CREATE INDEX IF NOT EXISTS idx_entries_embedded ON entries(embedded) WHERE embedded = 0;",
]

# FTS5 content-sync table — triggers keep it in sync with entries
_CREATE_FTS = """
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
    title, content_text, author,
    content='entries', content_rowid='rowid'
);
"""

_CREATE_FTS_TRIGGERS = [
    """
    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
        INSERT INTO entries_fts(rowid, title, content_text, author)
        VALUES (new.rowid, new.title, new.content_text, new.author);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content_text, author)
        VALUES ('delete', old.rowid, old.title, old.content_text, old.author);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
        INSERT INTO entries_fts(entries_fts, rowid, title, content_text, author)
        VALUES ('delete', old.rowid, old.title, old.content_text, old.author);
        INSERT INTO entries_fts(rowid, title, content_text, author)
        VALUES (new.rowid, new.title, new.content_text, new.author);
    END;
    """,
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_uuid() -> str:
    return str(uuid.uuid4())


def _strip_html(html: str) -> str:
    """Best-effort HTML→plain text. Uses html2text if available, else regex fallback."""
    try:
        import html2text
        h = html2text.HTML2Text()
        h.ignore_links = False
        h.ignore_images = True
        h.body_width = 0
        return h.handle(html).strip()
    except ImportError:
        # Regex fallback — good enough for search indexing
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text)
        return text.strip()


def _strip_tracking_pixels(html: str) -> str:
    """Remove 1x1 tracking pixel images."""
    return re.sub(
        r'<img[^>]*(?:width\s*=\s*["\']1["\']|height\s*=\s*["\']1["\'])[^>]*/?>',
        "",
        html,
        flags=re.IGNORECASE,
    )


# ── Service ──────────────────────────────────────────────────────────────────

class NewsletterService:
    """
    Manage newsletter feed subscriptions and poll for new entries.

    All DB methods are synchronous — callers should use asyncio.to_thread()
    when calling from async contexts.
    """

    def __init__(self, db_path: Optional[str] = None):
        path = db_path or _DB_PATH_DEFAULT
        self._db_path = str(Path(path).expanduser())
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()
        self._poll_task: Optional[asyncio.Task] = None

    # ── Schema ───────────────────────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(_CREATE_FEEDS)
            conn.execute(_CREATE_ENTRIES)
            for idx_sql in _CREATE_INDEXES:
                conn.execute(idx_sql)
            conn.execute(_CREATE_FTS)
            for trigger_sql in _CREATE_FTS_TRIGGERS:
                conn.execute(trigger_sql)
        logger.debug("[newsletter_db] Schema ready: %s", self._db_path)

    # ── Feed management ──────────────────────────────────────────────────────

    def add_substack(self, name: str, slug: str) -> dict:
        """Register a Substack feed by slug (e.g. 'pragmaticengineer')."""
        feed_id = _new_uuid()
        feed_url = f"https://{slug}.substack.com/feed"
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO feeds (id, name, source, feed_url, substack_slug, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (feed_id, name, FeedSource.SUBSTACK, feed_url, slug, _now_iso()),
            )
        logger.info("[newsletter] Added Substack feed: %s (%s)", name, slug)
        return {"id": feed_id, "name": name, "source": "substack", "feed_url": feed_url, "slug": slug}

    def add_ktn_feed(self, name: str, feed_url: str, email: str) -> dict:
        """Register a Kill the Newsletter Atom feed."""
        feed_id = _new_uuid()
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO feeds (id, name, source, feed_url, email, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (feed_id, name, FeedSource.KTN, feed_url, email, _now_iso()),
            )
        logger.info("[newsletter] Added KtN feed: %s (%s)", name, email)
        return {"id": feed_id, "name": name, "source": "ktn", "feed_url": feed_url, "email": email}

    def list_feeds(self, source: Optional[str] = None) -> list[dict]:
        """List all registered feeds, optionally filtered by source."""
        with self._connect() as conn:
            if source:
                rows = conn.execute(
                    "SELECT * FROM feeds WHERE source = ? ORDER BY created_at DESC", (source,)
                ).fetchall()
            else:
                rows = conn.execute("SELECT * FROM feeds ORDER BY created_at DESC").fetchall()

        feeds = []
        for row in rows:
            feed = dict(row)
            with self._connect() as conn:
                count = conn.execute(
                    "SELECT COUNT(*) as cnt FROM entries WHERE feed_id = ?", (feed["id"],)
                ).fetchone()
                feed["entry_count"] = count["cnt"] if count else 0
            feeds.append(feed)
        return feeds

    def get_feed(self, feed_id: str) -> Optional[dict]:
        """Get a single feed by ID."""
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
        return dict(row) if row else None

    def delete_feed(self, feed_id: str) -> bool:
        """Delete a feed and all its entries (cascade)."""
        with self._connect() as conn:
            cur = conn.execute("DELETE FROM feeds WHERE id = ?", (feed_id,))
        deleted = cur.rowcount > 0
        if deleted:
            logger.info("[newsletter] Deleted feed %s", feed_id)
        return deleted

    # ── Entry access ─────────────────────────────────────────────────────────

    def get_entries(
        self, feed_id: Optional[str] = None, limit: int = 50, offset: int = 0
    ) -> list[dict]:
        """Get entries, optionally filtered by feed. Most recent first."""
        with self._connect() as conn:
            if feed_id:
                rows = conn.execute(
                    """
                    SELECT e.*, f.name as feed_name, f.source as feed_source
                    FROM entries e JOIN feeds f ON e.feed_id = f.id
                    WHERE e.feed_id = ?
                    ORDER BY e.published_at DESC LIMIT ? OFFSET ?
                    """,
                    (feed_id, limit, offset),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT e.*, f.name as feed_name, f.source as feed_source
                    FROM entries e JOIN feeds f ON e.feed_id = f.id
                    ORDER BY e.published_at DESC LIMIT ? OFFSET ?
                    """,
                    (limit, offset),
                ).fetchall()
        return [dict(r) for r in rows]

    def get_entry(self, entry_id: str) -> Optional[dict]:
        """Get a single entry with full HTML content."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT e.*, f.name as feed_name, f.source as feed_source
                FROM entries e JOIN feeds f ON e.feed_id = f.id
                WHERE e.id = ?
                """,
                (entry_id,),
            ).fetchone()
        return dict(row) if row else None

    # ── Search ───────────────────────────────────────────────────────────────

    def search_text(self, query: str, limit: int = 20) -> list[dict]:
        """Full-text search across all entries via FTS5."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT e.id, e.feed_id, e.title, e.author, e.published_at,
                       snippet(entries_fts, 1, '<mark>', '</mark>', '…', 40) as snippet,
                       f.name as feed_name, f.source as feed_source
                FROM entries_fts
                JOIN entries e ON e.rowid = entries_fts.rowid
                JOIN feeds f ON e.feed_id = f.id
                WHERE entries_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (query, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    # ── Polling ──────────────────────────────────────────────────────────────

    def poll_feed(self, feed_id: str) -> tuple[int, list[dict]]:
        """
        Poll a single feed and ingest new entries.
        Returns (new_count, list of new entry dicts for LightRAG ingestion).
        Synchronous — call from async context via asyncio.to_thread().
        """
        feed = self.get_feed(feed_id)
        if not feed:
            return 0, []

        parsed = feedparser.parse(feed["feed_url"])
        if parsed.bozo and not parsed.entries:
            logger.warning("[newsletter] Feed parse error for %s: %s", feed["name"], parsed.bozo_exception)
            return 0, []

        new_count = 0
        new_entries = []
        with self._connect() as conn:
            for entry in parsed.entries:
                guid = entry.get("id") or entry.get("link") or entry.get("title", "")
                if not guid:
                    continue

                # Check for duplicate
                existing = conn.execute(
                    "SELECT 1 FROM entries WHERE feed_id = ? AND guid = ?",
                    (feed_id, guid),
                ).fetchone()
                if existing:
                    continue

                # Extract content
                content_html = ""
                if entry.get("content"):
                    content_html = entry.content[0].get("value", "")
                elif entry.get("summary"):
                    content_html = entry.summary

                content_html = _strip_tracking_pixels(content_html)
                content_text = _strip_html(content_html) if content_html else ""

                # Extract published date
                published = entry.get("published") or entry.get("updated") or ""

                # Extract author
                author = entry.get("author") or ""
                if not author and entry.get("authors"):
                    author = entry.authors[0].get("name", "")

                entry_id = _new_uuid()
                title = entry.get("title", "")
                conn.execute(
                    """
                    INSERT INTO entries
                        (id, feed_id, guid, title, author, published_at,
                         content_html, content_text, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry_id,
                        feed_id,
                        guid,
                        title,
                        author,
                        published,
                        content_html,
                        content_text,
                        _now_iso(),
                    ),
                )
                new_count += 1
                new_entries.append({
                    "id": entry_id,
                    "feed_name": feed["name"],
                    "title": title,
                    "author": author,
                    "published_at": published,
                    "content_text": content_text,
                })

            # Update last_polled
            conn.execute(
                "UPDATE feeds SET last_polled = ? WHERE id = ?",
                (_now_iso(), feed_id),
            )

        if new_count:
            logger.info("[newsletter] Polled %s — %d new entries", feed["name"], new_count)
        return new_count, new_entries

    def poll_all(self) -> tuple[dict, list[dict]]:
        """Poll all active feeds. Returns ({feed_id: new_count}, all_new_entries)."""
        feeds = self.list_feeds()
        results = {}
        all_new_entries = []
        for feed in feeds:
            if not feed.get("active"):
                continue
            try:
                count, entries = self.poll_feed(feed["id"])
                results[feed["id"]] = count
                all_new_entries.extend(entries)
            except Exception as exc:
                logger.error("[newsletter] Poll failed for %s: %s", feed["name"], exc)
                results[feed["id"]] = 0
        return results, all_new_entries

    # ── LightRAG ingestion ───────────────────────────────────────────────────

    @staticmethod
    def _enqueue_to_lightrag(new_entries: list[dict]) -> int:
        """
        Enqueue new newsletter entries into LightRAG for entity extraction
        and relational graph building. Returns count of entries enqueued.
        """
        try:
            from app.service.lightrag_service import LightRAGService
            rag = LightRAGService.get_instance()
        except Exception:
            return 0

        enqueued = 0
        for entry in new_entries:
            # Build a structured document for LightRAG entity extraction
            source_id = f"newsletter:{entry['id']}"
            text = (
                f"Newsletter: {entry.get('feed_name', 'Unknown')}\n"
                f"Title: {entry.get('title', '')}\n"
                f"Author: {entry.get('author', '')}\n"
                f"Published: {entry.get('published_at', '')}\n\n"
                f"{entry.get('content_text', '')}"
            )
            if rag.enqueue_ingest(text, source_id=source_id, source_type="newsletter"):
                enqueued += 1
        return enqueued

    # ── Background polling loop ──────────────────────────────────────────────

    async def start_polling(self, interval_seconds: int = 300):
        """Start the background polling loop (5 min default)."""
        if self._poll_task and not self._poll_task.done():
            logger.warning("[newsletter] Polling already running")
            return

        async def _loop():
            while True:
                try:
                    results, new_entries = await asyncio.to_thread(self.poll_all)
                    total_new = sum(results.values())
                    if total_new:
                        logger.info("[newsletter] Poll cycle complete — %d new entries", total_new)
                        # Feed new entries into LightRAG for entity/relation extraction
                        enqueued = self._enqueue_to_lightrag(new_entries)
                        if enqueued:
                            logger.info("[newsletter] Enqueued %d entries to LightRAG", enqueued)
                except Exception as exc:
                    logger.error("[newsletter] Poll cycle error: %s", exc)
                await asyncio.sleep(interval_seconds)

        self._poll_task = asyncio.create_task(_loop())
        logger.info("[newsletter] Background polling started (interval=%ds)", interval_seconds)

    async def stop_polling(self):
        """Stop the background polling loop."""
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            logger.info("[newsletter] Background polling stopped")

    # ── Stats ────────────────────────────────────────────────────────────────

    def stats(self) -> dict:
        """Return aggregate stats."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT
                    (SELECT COUNT(*) FROM feeds) as total_feeds,
                    (SELECT COUNT(*) FROM feeds WHERE source = 'substack') as substack_feeds,
                    (SELECT COUNT(*) FROM feeds WHERE source = 'ktn') as ktn_feeds,
                    (SELECT COUNT(*) FROM entries) as total_entries,
                    (SELECT COUNT(*) FROM entries WHERE embedded = 0) as unembedded,
                    (SELECT MAX(created_at) FROM entries) as latest_entry
                """
            ).fetchone()
        return dict(row) if row else {}


# ── Singleton ────────────────────────────────────────────────────────────────

_service: Optional[NewsletterService] = None


def get_newsletter_service(db_path: Optional[str] = None) -> NewsletterService:
    """Return the shared NewsletterService instance (lazy init)."""
    global _service
    if _service is None:
        _service = NewsletterService(db_path=db_path)
    return _service
