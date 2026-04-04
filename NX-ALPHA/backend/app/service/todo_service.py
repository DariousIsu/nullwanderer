"""
AURA NX-Alpha — Todo Service

Persistent task/todo management backed by SQLite.
Cross-session continuity: todos survive backend restarts.

SCHEMA:
    todos — id, content, status, priority, created_at, updated_at, thread_id

STATUS VALUES:  pending | in_progress | completed | cancelled
PRIORITY VALUES: high | medium | low

SINGLETON PATTERN:
    Call init_todo_service() once at startup.
    Tools call get_todo_service() to get the instance.
"""

from __future__ import annotations

import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

logger = logging.getLogger(__name__)

_DB_PATH = Path.home() / ".aura" / "todos.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS todos (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    priority    TEXT NOT NULL DEFAULT 'medium',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    thread_id   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_todos_status   ON todos(status);
CREATE INDEX IF NOT EXISTS idx_todos_priority ON todos(priority);
"""

Status   = Literal["pending", "in_progress", "completed", "cancelled"]
Priority = Literal["high", "medium", "low"]

_VALID_STATUSES   = {"pending", "in_progress", "completed", "cancelled"}
_VALID_PRIORITIES = {"high", "medium", "low"}

_todo_service: Optional[TodoService] = None


class TodoService:
    """SQLite-backed persistent todo/task store."""

    def __init__(self, db_path: Path | None = None) -> None:
        self._db_path = db_path or _DB_PATH
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    # ── Schema ────────────────────────────────────────────────────────────────

    def _get_conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL;")
        return conn

    def _init_db(self) -> None:
        with self._get_conn() as conn:
            conn.executescript(_SCHEMA)
        logger.info("[todo_service] SQLite initialized at %s", self._db_path)

    # ── CRUD ──────────────────────────────────────────────────────────────────

    def create(
        self,
        content: str,
        priority: Priority = "medium",
        thread_id: str = "",
    ) -> dict:
        """Create a new todo. Returns the created todo dict."""
        if not content or not content.strip():
            raise ValueError("Todo content cannot be empty.")
        if priority not in _VALID_PRIORITIES:
            raise ValueError(f"Invalid priority: {priority!r}. Use high, medium, or low.")

        now = datetime.now(timezone.utc).isoformat()
        todo_id = f"todo_{uuid.uuid4().hex[:12]}"

        with self._get_conn() as conn:
            conn.execute(
                "INSERT INTO todos (id, content, status, priority, created_at, updated_at, thread_id) "
                "VALUES (?, ?, 'pending', ?, ?, ?, ?)",
                (todo_id, content.strip(), priority, now, now, thread_id),
            )
        logger.info("[todo_service] created %s: %s", todo_id, content[:60])
        return self.get(todo_id)

    def get(self, todo_id: str) -> dict | None:
        """Get a single todo by ID. Returns None if not found."""
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT * FROM todos WHERE id = ?", (todo_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_todos(
        self,
        status: str | None = None,
        priority: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """List todos, optionally filtered by status and/or priority."""
        filters = []
        values = []

        if status and status in _VALID_STATUSES:
            filters.append("status = ?")
            values.append(status)
        if priority and priority in _VALID_PRIORITIES:
            filters.append("priority = ?")
            values.append(priority)

        where = f"WHERE {' AND '.join(filters)}" if filters else ""
        values.append(min(int(limit), 200))

        with self._get_conn() as conn:
            rows = conn.execute(
                f"SELECT * FROM todos {where} ORDER BY "
                "CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, "
                "created_at DESC LIMIT ?",
                values,
            ).fetchall()
        return [dict(r) for r in rows]

    def update(
        self,
        todo_id: str,
        content: str | None = None,
        status: str | None = None,
        priority: str | None = None,
    ) -> dict:
        """Update content, status, and/or priority of a todo."""
        existing = self.get(todo_id)
        if existing is None:
            raise KeyError(f"Todo not found: {todo_id}")

        if status and status not in _VALID_STATUSES:
            raise ValueError(f"Invalid status: {status!r}")
        if priority and priority not in _VALID_PRIORITIES:
            raise ValueError(f"Invalid priority: {priority!r}")

        sets = []
        values = []
        if content is not None and content.strip():
            sets.append("content = ?")
            values.append(content.strip())
        if status is not None:
            sets.append("status = ?")
            values.append(status)
        if priority is not None:
            sets.append("priority = ?")
            values.append(priority)

        if not sets:
            return existing

        now = datetime.now(timezone.utc).isoformat()
        sets.append("updated_at = ?")
        values.append(now)
        values.append(todo_id)

        with self._get_conn() as conn:
            conn.execute(
                f"UPDATE todos SET {', '.join(sets)} WHERE id = ?",
                values,
            )
        logger.info("[todo_service] updated %s", todo_id)
        return self.get(todo_id)

    def active_context_block(self) -> str:
        """
        Return a compact string of pending/in_progress todos for context injection.
        Returns empty string if no active todos exist.
        """
        todos = self.list_todos(limit=20)
        active = [t for t in todos if t["status"] in ("pending", "in_progress")]
        if not active:
            return ""

        lines = []
        for t in active:
            marker = "[>]" if t["status"] == "in_progress" else "[ ]"
            pri = f"({t['priority']})" if t["priority"] != "medium" else ""
            lines.append(f"{marker} {pri} {t['content'][:120]}  [{t['id']}]")

        return "ACTIVE TODOS:\n" + "\n".join(lines)


# ── Singleton ─────────────────────────────────────────────────────────────────

def init_todo_service(db_path: Path | None = None) -> TodoService:
    """Initialize and return the TodoService singleton."""
    global _todo_service
    _todo_service = TodoService(db_path=db_path)
    return _todo_service


def get_todo_service() -> TodoService | None:
    """Return the TodoService singleton, or None if not initialized."""
    return _todo_service
