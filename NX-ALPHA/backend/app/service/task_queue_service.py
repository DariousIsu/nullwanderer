"""
AURA NX-Alpha — Task Queue Service
Saves team tasks to SQLite when hardware_mode is interface_only.
When mode switches to full, drain_queue() executes them through the pipeline
and notifies the user via SSE.

TABLE: queued_tasks
    id          INTEGER PRIMARY KEY
    task_id     TEXT UNIQUE
    thread_id   TEXT
    task_text   TEXT
    created_at  TEXT (ISO 8601)
    status      TEXT ('pending' | 'running' | 'done' | 'failed' | 'cancelled')
    result      TEXT (nullable)
    executed_at TEXT (nullable)
"""

from __future__ import annotations

import asyncio
import json
import logging
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DB_PATH = Path.home() / ".aura" / "task_queue.db"


# ── DB helpers ────────────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db() -> None:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS queued_tasks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id     TEXT UNIQUE NOT NULL,
                thread_id   TEXT NOT NULL DEFAULT 'default',
                task_text   TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'pending',
                result      TEXT,
                executed_at TEXT
            )
        """)
        conn.commit()


# ── Service ───────────────────────────────────────────────────────────────────

class TaskQueueService:

    def __init__(self) -> None:
        _init_db()
        logger.info("[task_queue] Initialized (db: %s)", _DB_PATH)

    # ── Write ──────────────────────────────────────────────────────────────────

    def queue_task(self, task_text: str, thread_id: str = "default") -> dict:
        """Save a pending task. Returns task record."""
        task_id = f"tq-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        with _get_conn() as conn:
            conn.execute(
                """INSERT INTO queued_tasks (task_id, thread_id, task_text, created_at, status)
                   VALUES (?, ?, ?, ?, 'pending')""",
                (task_id, thread_id, task_text, now),
            )
            conn.commit()
        logger.info("[task_queue] Queued: %s (%.60s)", task_id, task_text)
        return {"task_id": task_id, "task_text": task_text, "created_at": now, "status": "pending"}

    def cancel_task(self, task_id: str) -> bool:
        with _get_conn() as conn:
            cur = conn.execute(
                "UPDATE queued_tasks SET status='cancelled' WHERE task_id=? AND status='pending'",
                (task_id,),
            )
            conn.commit()
            return cur.rowcount > 0

    # ── Read ───────────────────────────────────────────────────────────────────

    def list_pending(self) -> list[dict]:
        with _get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM queued_tasks WHERE status='pending' ORDER BY id ASC"
            ).fetchall()
            return [dict(r) for r in rows]

    def list_all(self, limit: int = 50) -> list[dict]:
        with _get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM queued_tasks ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
            return [dict(r) for r in rows]

    # ── Drain ──────────────────────────────────────────────────────────────────

    async def drain_queue(self) -> None:
        """Execute all pending tasks through the team pipeline."""
        pending = self.list_pending()
        if not pending:
            return

        logger.info("[task_queue] Draining %d queued task(s)", len(pending))

        try:
            from app.controller.chat_controller import _emit
            await _emit("queue_draining", {
                "count": len(pending),
                "message": f"Team pipeline online — running {len(pending)} queued task(s).",
            })
        except Exception:
            pass

        for task in pending:
            task_id = task["task_id"]
            task_text = task["task_text"]
            thread_id = task.get("thread_id", "default")

            # Mark running
            with _get_conn() as conn:
                conn.execute(
                    "UPDATE queued_tasks SET status='running' WHERE task_id=?",
                    (task_id,),
                )
                conn.commit()

            try:
                from app.graph.pipeline import get_pipeline
                pipeline = get_pipeline()
                if pipeline is None:
                    raise RuntimeError("Pipeline not initialized")

                result = await pipeline.run(
                    user_message=task_text,
                    thread_id=thread_id,
                    team_enabled=True,
                )

                final_response = result.get("final_response", "") or result.get("assembled_output", {})
                if isinstance(final_response, dict):
                    final_response = final_response.get("content", str(final_response))

                now = datetime.now(timezone.utc).isoformat()
                with _get_conn() as conn:
                    conn.execute(
                        "UPDATE queued_tasks SET status='done', result=?, executed_at=? WHERE task_id=?",
                        (str(final_response)[:4000], now, task_id),
                    )
                    conn.commit()

                logger.info("[task_queue] Task %s completed", task_id)

            except Exception as exc:
                logger.error("[task_queue] Task %s failed: %s", task_id, exc)
                now = datetime.now(timezone.utc).isoformat()
                with _get_conn() as conn:
                    conn.execute(
                        "UPDATE queued_tasks SET status='failed', result=?, executed_at=? WHERE task_id=?",
                        (str(exc)[:500], now, task_id),
                    )
                    conn.commit()

        try:
            from app.controller.chat_controller import _emit
            await _emit("queue_drained", {
                "count": len(pending),
                "message": f"Queue cleared — {len(pending)} task(s) completed.",
            })
        except Exception:
            pass


# ── Singleton ─────────────────────────────────────────────────────────────────

_task_queue_service: Optional[TaskQueueService] = None


def init_task_queue_service() -> TaskQueueService:
    global _task_queue_service
    _task_queue_service = TaskQueueService()
    return _task_queue_service


def get_task_queue_service() -> Optional[TaskQueueService]:
    global _task_queue_service
    if _task_queue_service is None:
        _task_queue_service = TaskQueueService()
    return _task_queue_service
