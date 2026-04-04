"""
AURA NX-Alpha — Dev Session Service
Manages Dev Mode state, project registry, and Workhorse dedication.

Dev Mode Architecture:
    - When active: Workhorse is DEDICATED to the Dev Panel.
    - Interface Engine continues solo-mode chat unaffected.
    - Team pipeline tasks queued from main UI wait until Dev Mode deactivates.
    - DevPanel chat goes STRAIGHT to Workhorse (no Interface Agent routing).
    - Models only interact at the validation gate.

TABLE: dev_projects
    id            INTEGER PRIMARY KEY
    name          TEXT NOT NULL
    path          TEXT NOT NULL UNIQUE
    stack         TEXT                    (e.g. "React + FastAPI")
    deploy_cmd    TEXT                    (e.g. "npm run build && vercel deploy")
    autonomy_mode TEXT DEFAULT 'gated'    ('gated' | 'auto')
    last_plan     TEXT                    (most recent plan summary, nullable)
    created_at    TEXT                    (ISO 8601)
    last_opened   TEXT                    (ISO 8601, nullable)

TABLE: dev_tasks
    id            INTEGER PRIMARY KEY
    project_id    INTEGER NOT NULL
    description   TEXT NOT NULL
    status        TEXT DEFAULT 'queued'   ('queued'|'active'|'done'|'cancelled')
    agent_step    TEXT                    (current agent phase label, nullable)
    result        TEXT                    (nullable — final output summary)
    created_at    TEXT
    updated_at    TEXT
"""

from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DB_PATH = Path.home() / ".aura" / "dev_projects.db"

# ── Runtime state ─────────────────────────────────────────────────────────────
_dev_state: dict = {
    "active": False,                # Is Dev Mode currently on?
    "workhorse_locked": False,      # Is Workhorse dedicated to dev?
    "active_project_id": None,      # int | None
    "active_project": None,         # dict | None — full project row
}


# ─────────────────────────────────────────────────────────────────────────────
# DB HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_dev_db() -> None:
    """Create tables if they don't exist. Called at startup."""
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with _get_conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS dev_projects (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                name          TEXT NOT NULL,
                path          TEXT NOT NULL UNIQUE,
                stack         TEXT,
                deploy_cmd    TEXT,
                autonomy_mode TEXT NOT NULL DEFAULT 'gated',
                last_plan     TEXT,
                created_at    TEXT NOT NULL,
                last_opened   TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS dev_tasks (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id  INTEGER NOT NULL,
                description TEXT NOT NULL,
                status      TEXT NOT NULL DEFAULT 'queued',
                agent_step  TEXT,
                result      TEXT,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL,
                FOREIGN KEY (project_id) REFERENCES dev_projects(id)
            )
        """)
        conn.commit()
    logger.info("[dev_session] DB initialized at %s", _DB_PATH)


def _row_to_dict(row: sqlite3.Row) -> dict:
    return dict(row)


# ─────────────────────────────────────────────────────────────────────────────
# DEV MODE ACTIVATION
# ─────────────────────────────────────────────────────────────────────────────

def activate_dev_mode() -> dict:
    """
    Lock the Workhorse to Dev Mode.
    Returns current dev state.
    """
    _dev_state["active"] = True
    _dev_state["workhorse_locked"] = True
    logger.info("[dev_session] Dev Mode ACTIVATED — Workhorse dedicated to dev panel")
    return get_dev_state()


def deactivate_dev_mode() -> dict:
    """
    Release the Workhorse from Dev Mode.
    Active project context is preserved for next activation.
    """
    _dev_state["active"] = False
    _dev_state["workhorse_locked"] = False
    logger.info("[dev_session] Dev Mode DEACTIVATED — Workhorse released")
    return get_dev_state()


def get_dev_state() -> dict:
    return {
        "active": _dev_state["active"],
        "workhorse_locked": _dev_state["workhorse_locked"],
        "active_project_id": _dev_state["active_project_id"],
        "active_project": _dev_state["active_project"],
    }


def is_dev_mode_active() -> bool:
    return _dev_state["active"]


def is_workhorse_locked() -> bool:
    return _dev_state["workhorse_locked"]


# ─────────────────────────────────────────────────────────────────────────────
# PROJECT MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

def list_projects() -> list[dict]:
    """Return all known projects ordered by last_opened desc."""
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM dev_projects ORDER BY COALESCE(last_opened, created_at) DESC"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def create_project(name: str, path: str, stack: str = "", deploy_cmd: str = "") -> dict:
    """
    Register a new project. Returns the created project dict.
    Raises ValueError if path already registered.
    """
    now = datetime.now(timezone.utc).isoformat()
    try:
        with _get_conn() as conn:
            conn.execute(
                """
                INSERT INTO dev_projects (name, path, stack, deploy_cmd, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (name, str(path), stack, deploy_cmd, now),
            )
            conn.commit()
            row = conn.execute(
                "SELECT * FROM dev_projects WHERE path = ?", (str(path),)
            ).fetchone()
    except sqlite3.IntegrityError:
        raise ValueError(f"Project at path '{path}' already registered.")
    project = _row_to_dict(row)
    logger.info("[dev_session] Project created: %s @ %s", name, path)
    return project


def open_project(project_id: int) -> dict:
    """
    Load a project into the active session context.
    Updates last_opened timestamp. Returns project dict.
    """
    now = datetime.now(timezone.utc).isoformat()
    with _get_conn() as conn:
        conn.execute(
            "UPDATE dev_projects SET last_opened = ? WHERE id = ?",
            (now, project_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM dev_projects WHERE id = ?", (project_id,)
        ).fetchone()
    if not row:
        raise ValueError(f"Project id {project_id} not found.")
    project = _row_to_dict(row)
    _dev_state["active_project_id"] = project_id
    _dev_state["active_project"] = project
    logger.info("[dev_session] Project opened: %s", project["name"])
    return project


def get_active_project() -> Optional[dict]:
    return _dev_state["active_project"]


def update_project(project_id: int, **fields) -> dict:
    """Update allowed fields on a project (stack, deploy_cmd, autonomy_mode, last_plan)."""
    allowed = {"stack", "deploy_cmd", "autonomy_mode", "last_plan"}
    updates = {k: v for k, v in fields.items() if k in allowed}
    if not updates:
        raise ValueError("No valid fields to update.")
    set_clause = ", ".join(f"{k} = ?" for k in updates)
    values = list(updates.values()) + [project_id]
    with _get_conn() as conn:
        conn.execute(
            f"UPDATE dev_projects SET {set_clause} WHERE id = ?", values
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM dev_projects WHERE id = ?", (project_id,)
        ).fetchone()
    project = _row_to_dict(row)
    if _dev_state["active_project_id"] == project_id:
        _dev_state["active_project"] = project
    return project


def get_project_context() -> dict:
    """
    Return the full context for the active project:
    project info + recent tasks + autonomy mode.
    """
    project = _dev_state["active_project"]
    if not project:
        return {"active": False, "project": None, "recent_tasks": []}

    project_id = _dev_state["active_project_id"]
    with _get_conn() as conn:
        tasks = conn.execute(
            """
            SELECT * FROM dev_tasks WHERE project_id = ?
            ORDER BY created_at DESC LIMIT 20
            """,
            (project_id,),
        ).fetchall()
    return {
        "active": True,
        "project": project,
        "recent_tasks": [_row_to_dict(t) for t in tasks],
    }


# ─────────────────────────────────────────────────────────────────────────────
# TASK MANAGEMENT
# ─────────────────────────────────────────────────────────────────────────────

def create_task(description: str, project_id: Optional[int] = None) -> dict:
    """Add a task to the queue. Uses active project if project_id not specified."""
    pid = project_id or _dev_state["active_project_id"]
    if not pid:
        raise ValueError("No active project. Open a project first.")
    now = datetime.now(timezone.utc).isoformat()
    with _get_conn() as conn:
        conn.execute(
            """
            INSERT INTO dev_tasks (project_id, description, status, created_at, updated_at)
            VALUES (?, ?, 'queued', ?, ?)
            """,
            (pid, description, now, now),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM dev_tasks WHERE project_id = ? ORDER BY id DESC LIMIT 1",
            (pid,),
        ).fetchone()
    return _row_to_dict(row)


def update_task_status(task_id: int, status: str, agent_step: str = "", result: str = "") -> None:
    """Update a task's status, agent step, and result."""
    now = datetime.now(timezone.utc).isoformat()
    with _get_conn() as conn:
        conn.execute(
            """
            UPDATE dev_tasks
            SET status = ?, agent_step = ?, result = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, agent_step or None, result or None, now, task_id),
        )
        conn.commit()


def get_task_queue(project_id: Optional[int] = None) -> list[dict]:
    """Return all tasks for the active (or specified) project."""
    pid = project_id or _dev_state["active_project_id"]
    if not pid:
        return []
    with _get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM dev_tasks WHERE project_id = ? ORDER BY created_at DESC",
            (pid,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]
