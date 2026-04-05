"""
Truth Social Monitor Service — polls @realDonaldTrump for new posts.

Mirrors newsletter_service.py in structure:
  - SQLite archive + FTS5 full-text search
  - Async polling loop via asyncio.create_task()
  - Deduplication via UNIQUE(post_id) constraint
  - SSE emission on new posts via render_canvas card-list block

Storage: ~/.aura/truthsocial.db
"""

import asyncio
import logging
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DB_PATH_DEFAULT = "~/.aura/truthsocial.db"

# ── DDL ──────────────────────────────────────────────────────────────────────

_CREATE_POSTS = """
CREATE TABLE IF NOT EXISTS ts_posts (
    id          TEXT PRIMARY KEY,
    post_id     TEXT UNIQUE NOT NULL,
    content     TEXT,
    created_at  TEXT,
    url         TEXT,
    reply_count   INTEGER DEFAULT 0,
    repost_count  INTEGER DEFAULT 0,
    like_count    INTEGER DEFAULT 0,
    fetched_at  TEXT DEFAULT (datetime('now'))
);
"""

_CREATE_INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_ts_posts_created ON ts_posts(created_at DESC);",
]

_CREATE_FTS = """
CREATE VIRTUAL TABLE IF NOT EXISTS ts_posts_fts USING fts5(
    content,
    content='ts_posts', content_rowid='rowid'
);
"""

_CREATE_FTS_TRIGGERS = [
    """
    CREATE TRIGGER IF NOT EXISTS ts_posts_ai AFTER INSERT ON ts_posts BEGIN
        INSERT INTO ts_posts_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS ts_posts_ad AFTER DELETE ON ts_posts BEGIN
        INSERT INTO ts_posts_fts(ts_posts_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
    END;
    """,
    """
    CREATE TRIGGER IF NOT EXISTS ts_posts_au AFTER UPDATE ON ts_posts BEGIN
        INSERT INTO ts_posts_fts(ts_posts_fts, rowid, content)
        VALUES ('delete', old.rowid, old.content);
        INSERT INTO ts_posts_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    """,
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _strip_html(html: str) -> str:
    """Best-effort HTML → plain text."""
    try:
        import html2text
        h = html2text.HTML2Text()
        h.ignore_links = True
        h.ignore_images = True
        h.body_width = 0
        return h.handle(html).strip()
    except ImportError:
        text = re.sub(r"<[^>]+>", " ", html)
        text = re.sub(r"\s+", " ", text)
        return text.strip()


# ── Service ──────────────────────────────────────────────────────────────────

class TruthSocialService:
    """
    Poll @realDonaldTrump on Truth Social and archive posts locally.

    All DB methods are synchronous — callers should use asyncio.to_thread()
    when calling from async contexts.
    """

    def __init__(
        self,
        db_path: str = _DB_PATH_DEFAULT,
        username: str = "",
        password: str = "",
        monitor_username: str = "realDonaldTrump",
        poll_interval: int = 900,
    ):
        self._db_path = str(Path(db_path).expanduser())
        Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
        self._username = username
        self._password = password
        self._monitor_username = monitor_username
        self._poll_interval = poll_interval
        self._poll_task: Optional[asyncio.Task] = None
        self._last_polled: Optional[str] = None
        self._init_schema()

    # ── Schema ───────────────────────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(_CREATE_POSTS)
            for idx_sql in _CREATE_INDEXES:
                conn.execute(idx_sql)
            conn.execute(_CREATE_FTS)
            for trigger_sql in _CREATE_FTS_TRIGGERS:
                conn.execute(trigger_sql)
        logger.debug("[truthsocial_db] Schema ready: %s", self._db_path)

    # ── Read methods (sync) ───────────────────────────────────────────────────

    def get_latest_posts(self, limit: int = 20) -> list[dict]:
        """Return the N most recent posts."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM ts_posts ORDER BY created_at DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_post(self, post_id: str) -> Optional[dict]:
        """Return a single post by its Truth Social post_id."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM ts_posts WHERE post_id = ?", (post_id,)
            ).fetchone()
        return dict(row) if row else None

    def search_posts(self, query: str, limit: int = 20) -> list[dict]:
        """Full-text search over post content."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT p.*, snippet(ts_posts_fts, 0, '<b>', '</b>', '...', 12) AS snippet
                FROM ts_posts_fts f
                JOIN ts_posts p ON p.rowid = f.rowid
                WHERE ts_posts_fts MATCH ?
                ORDER BY rank
                LIMIT ?
                """,
                (query, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    def get_stats(self) -> dict:
        """Return aggregate stats."""
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT
                    COUNT(*) as total_count,
                    MAX(created_at) as latest_post_at,
                    MIN(created_at) as oldest_post_at
                FROM ts_posts
                """
            ).fetchone()
        return dict(row) if row else {"total_count": 0}

    # ── Fetch (sync — called via asyncio.to_thread) ───────────────────────────

    def _fetch_new_posts(self) -> list[dict]:
        """
        Poll Truth Social for new posts from monitor_username.
        Returns list of newly-inserted post dicts.
        Synchronous — must be called via asyncio.to_thread().
        """
        try:
            from truthbrush.api import Api  # type: ignore
        except ImportError:
            logger.error("[truthsocial] truthbrush not installed. Run: pip install truthbrush")
            return []

        if not self._username or not self._password:
            logger.warning("[truthsocial] Credentials not configured — skipping poll")
            return []

        try:
            api = Api(username=self._username, password=self._password)
            statuses = api.pull_statuses(self._monitor_username)
        except Exception as exc:
            logger.error("[truthsocial] API fetch failed: %s", exc)
            return []

        new_posts = []
        try:
            with self._connect() as conn:
                for status in statuses:
                    try:
                        post_id = str(status.get("id", ""))
                        if not post_id:
                            continue

                        # Deduplication — skip if already stored
                        existing = conn.execute(
                            "SELECT 1 FROM ts_posts WHERE post_id = ?", (post_id,)
                        ).fetchone()
                        if existing:
                            continue

                        content_html = status.get("content", "")
                        content = _strip_html(content_html) if content_html else ""
                        created_at = status.get("created_at", "")
                        url = status.get("url", "")
                        reply_count = status.get("replies_count", 0)
                        repost_count = status.get("reblogs_count", 0)
                        like_count = status.get("favourites_count", 0)

                        conn.execute(
                            """
                            INSERT INTO ts_posts
                                (id, post_id, content, created_at, url,
                                 reply_count, repost_count, like_count, fetched_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                post_id,  # use post_id as primary key too
                                post_id,
                                content,
                                created_at,
                                url,
                                reply_count,
                                repost_count,
                                like_count,
                                _now_iso(),
                            ),
                        )
                        new_posts.append({
                            "post_id": post_id,
                            "content": content,
                            "created_at": created_at,
                            "url": url,
                        })
                    except Exception as exc:
                        logger.warning("[truthsocial] Skipping status due to error: %s", exc)
                        continue
        except Exception as exc:
            logger.error("[truthsocial] DB write failed: %s", exc)

        if new_posts:
            logger.info("[truthsocial] %d new posts from @%s", len(new_posts), self._monitor_username)
        self._last_polled = _now_iso()
        return new_posts

    # ── Polling loop ─────────────────────────────────────────────────────────

    async def start_polling(self, interval_seconds: Optional[int] = None):
        """Start the background polling loop."""
        if self._poll_task and not self._poll_task.done():
            logger.warning("[truthsocial] Polling already running")
            return

        interval = interval_seconds or self._poll_interval

        async def _loop():
            while True:
                try:
                    new_posts = await asyncio.to_thread(self._fetch_new_posts)
                    if new_posts:
                        await self._emit_new_posts(new_posts)
                except Exception as exc:
                    logger.error("[truthsocial] Poll cycle error: %s", exc)
                await asyncio.sleep(interval)

        self._poll_task = asyncio.create_task(_loop())
        logger.info("[truthsocial] Background polling started (interval=%ds)", interval)

    async def stop_polling(self):
        """Stop the background polling loop."""
        if self._poll_task and not self._poll_task.done():
            self._poll_task.cancel()
            try:
                await self._poll_task
            except asyncio.CancelledError:
                pass
            logger.info("[truthsocial] Background polling stopped")

    def is_polling(self) -> bool:
        return bool(self._poll_task and not self._poll_task.done())

    # ── SSE emission ─────────────────────────────────────────────────────────

    async def _emit_new_posts(self, new_posts: list[dict]):
        """Emit a render_canvas card-list event for new posts."""
        try:
            from app.controller.chat_controller import _emit

            cards = []
            for p in new_posts[:5]:  # preview first 5
                content = p.get("content", "")
                cards.append({
                    "title": content[:120] + ("..." if len(content) > 120 else ""),
                    "date": p.get("created_at", ""),
                    "source": f"@{self._monitor_username} · Truth Social",
                    "url": p.get("url", ""),
                })

            caption = f"{len(new_posts)} new post{'s' if len(new_posts) != 1 else ''}"
            await _emit("render_canvas", {
                "title": "Truth Social — New Posts",
                "blocks": [{
                    "type": "card-list",
                    "data": {
                        "cards": cards,
                        "caption": caption,
                    },
                }],
            })
        except Exception as exc:
            logger.warning("[truthsocial] SSE emit failed: %s", exc)


# ── Singleton ─────────────────────────────────────────────────────────────────

_service: Optional[TruthSocialService] = None


def get_truthsocial_service(
    db_path: Optional[str] = None,
    username: Optional[str] = None,
    password: Optional[str] = None,
    monitor_username: Optional[str] = None,
    poll_interval: Optional[int] = None,
) -> TruthSocialService:
    """Return the shared TruthSocialService instance (lazy init)."""
    global _service
    if _service is None:
        try:
            from app.config import get_settings
            cfg = get_settings().truthsocial
            _service = TruthSocialService(
                db_path=db_path or cfg.db_path,
                username=username or cfg.username,
                password=password or cfg.password,
                monitor_username=monitor_username or cfg.monitor_username,
                poll_interval=poll_interval or cfg.poll_interval,
            )
        except Exception:
            _service = TruthSocialService(
                db_path=db_path or _DB_PATH_DEFAULT,
                username=username or "",
                password=password or "",
            )
    return _service
