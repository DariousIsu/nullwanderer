"""
AURA NX-Alpha — MCP Tool Store

SQLite persistence for MCP tool definitions created via the Tool Developer Workspace.

DB location : ~/.aura/mcp_tools.db
Versions    : last 5 snapshots per tool (mcp_tool_versions table)
"""
from __future__ import annotations

import json
import logging
import re
import sqlite3
import time
from pathlib import Path
from typing import Optional

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_DB_PATH     = Path.home() / ".aura" / "mcp_tools.db"
_MAX_VERSIONS = 5


# ─────────────────────────────────────────────────────────────────────────────
# MODEL
# ─────────────────────────────────────────────────────────────────────────────

class MCPToolDef(BaseModel):
    id: str
    name: str
    description: str
    input_schema: dict           # JSON Schema {type, properties, required}
    output_description: str = ""
    target_users: str = ""
    complexity: str = "medium"   # low | medium | high
    categories: list[str] = []
    base_prompt: str = ""
    optimized_prompt: str = ""
    optimization_score: float = 0.0
    golden_set_size: int = 0
    stage: str = "intake"        # intake|composition|dataset|training|optimizing|reevaluation|sandbox|human_testing|ready|published
    blocking_reason: Optional[str] = None
    optimization_cycles: int = 0
    reevaluation_report: Optional[dict] = None
    sandbox_pass_rate: float = 0.0
    build_plan: Optional[dict] = None
    wrapper_path: Optional[str] = None
    published: bool = False
    publish_targets: list[str] = []
    publish_path: Optional[str] = None
    expose_components: bool = True
    auto_update: bool = False                   # re-optimize + re-publish when golden set grows
    last_golden_size_at_optimize: int = 0       # golden_set_size at last auto-update check
    version: int = 1
    version_tag: str = "1.0.0"
    deleted: bool = False
    created_at: float = Field(default_factory=time.time)
    updated_at: float = Field(default_factory=time.time)


# ─────────────────────────────────────────────────────────────────────────────
# DB HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _connect() -> sqlite3.Connection:
    _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _init_db(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS mcp_tools (
            id                   TEXT PRIMARY KEY,
            name                 TEXT NOT NULL,
            description          TEXT NOT NULL,
            input_schema         TEXT NOT NULL,
            output_description   TEXT DEFAULT '',
            target_users         TEXT DEFAULT '',
            complexity           TEXT DEFAULT 'medium',
            categories           TEXT DEFAULT '[]',
            base_prompt          TEXT DEFAULT '',
            optimized_prompt     TEXT DEFAULT '',
            optimization_score   REAL DEFAULT 0.0,
            golden_set_size      INTEGER DEFAULT 0,
            stage                TEXT DEFAULT 'intake',
            blocking_reason      TEXT,
            optimization_cycles  INTEGER DEFAULT 0,
            reevaluation_report  TEXT,
            sandbox_pass_rate    REAL DEFAULT 0.0,
            build_plan           TEXT,
            wrapper_path         TEXT,
            published            INTEGER DEFAULT 0,
            publish_targets      TEXT DEFAULT '[]',
            publish_path         TEXT,
            expose_components    INTEGER DEFAULT 1,
            version              INTEGER DEFAULT 1,
            version_tag          TEXT DEFAULT '1.0.0',
            deleted              INTEGER DEFAULT 0,
            archived_at          REAL,
            created_at           REAL,
            updated_at           REAL
        );

        CREATE TABLE IF NOT EXISTS mcp_tool_versions (
            rowid    INTEGER PRIMARY KEY AUTOINCREMENT,
            tool_id  TEXT NOT NULL,
            version  INTEGER NOT NULL,
            snapshot TEXT NOT NULL,
            saved_at REAL
        );

        CREATE INDEX IF NOT EXISTS idx_tool_versions
            ON mcp_tool_versions(tool_id, version);
    """)

    # ── Migrations — add columns that may not exist in older DBs ──────────────
    for col_sql in [
        "ALTER TABLE mcp_tools ADD COLUMN auto_update INTEGER DEFAULT 0",
        "ALTER TABLE mcp_tools ADD COLUMN last_golden_size_at_optimize INTEGER DEFAULT 0",
    ]:
        try:
            conn.execute(col_sql)
        except Exception:
            pass  # column already exists

    # expose_components default changed from 0 → 1; update any existing 0-value rows
    conn.execute("UPDATE mcp_tools SET expose_components = 1 WHERE expose_components = 0")
    conn.commit()


def _row_to_def(row: sqlite3.Row) -> MCPToolDef:
    d = dict(row)
    d["input_schema"]        = json.loads(d["input_schema"] or "{}")
    d["categories"]          = json.loads(d["categories"] or "[]")
    d["publish_targets"]     = json.loads(d["publish_targets"] or "[]")
    d["build_plan"]          = json.loads(d["build_plan"]) if d.get("build_plan") else None
    d["reevaluation_report"] = json.loads(d["reevaluation_report"]) if d.get("reevaluation_report") else None
    d["published"]           = bool(d["published"])
    d["expose_components"]   = bool(d["expose_components"])
    d["auto_update"]         = bool(d.get("auto_update", 0))
    d["deleted"]             = bool(d["deleted"])
    d.setdefault("last_golden_size_at_optimize", 0)
    return MCPToolDef(**d)


def _def_to_row(t: MCPToolDef) -> dict:
    return {
        "id":                   t.id,
        "name":                 t.name,
        "description":          t.description,
        "input_schema":         json.dumps(t.input_schema, ensure_ascii=False),
        "output_description":   t.output_description,
        "target_users":         t.target_users,
        "complexity":           t.complexity,
        "categories":           json.dumps(t.categories, ensure_ascii=False),
        "base_prompt":          t.base_prompt,
        "optimized_prompt":     t.optimized_prompt,
        "optimization_score":   t.optimization_score,
        "golden_set_size":      t.golden_set_size,
        "stage":                t.stage,
        "blocking_reason":      t.blocking_reason,
        "optimization_cycles":  t.optimization_cycles,
        "reevaluation_report":  json.dumps(t.reevaluation_report, ensure_ascii=False) if t.reevaluation_report else None,
        "sandbox_pass_rate":    t.sandbox_pass_rate,
        "build_plan":           json.dumps(t.build_plan, ensure_ascii=False) if t.build_plan else None,
        "wrapper_path":         t.wrapper_path,
        "published":            int(t.published),
        "publish_targets":      json.dumps(t.publish_targets, ensure_ascii=False),
        "publish_path":         t.publish_path,
        "expose_components":    int(t.expose_components),
        "auto_update":          int(t.auto_update),
        "last_golden_size_at_optimize": t.last_golden_size_at_optimize,
        "version":              t.version,
        "version_tag":          t.version_tag,
        "deleted":              int(t.deleted),
        "created_at":           t.created_at,
        "updated_at":           t.updated_at,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ID HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def slugify(name: str) -> str:
    """Convert 'Policy Summarizer' → 'policy-summarizer'."""
    s = name.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def unique_slug(base: str, existing_ids: set[str]) -> str:
    """Return base slug or base-2, base-3, etc. if collision."""
    if base not in existing_ids:
        return base
    n = 2
    while f"{base}-{n}" in existing_ids:
        n += 1
    return f"{base}-{n}"


# ─────────────────────────────────────────────────────────────────────────────
# STORE
# ─────────────────────────────────────────────────────────────────────────────

class MCPToolStore:
    def __init__(self) -> None:
        with _connect() as conn:
            _init_db(conn)

    # ── CRUD ──────────────────────────────────────────────────────────────────

    def save_tool(self, tool: MCPToolDef) -> MCPToolDef:
        """Upsert a tool definition. Bumps version and saves snapshot."""
        now = time.time()

        with _connect() as conn:
            existing = conn.execute(
                "SELECT version FROM mcp_tools WHERE id = ?", (tool.id,)
            ).fetchone()

            if existing:
                new_version = existing["version"] + 1
                tool = tool.model_copy(update={"version": new_version, "updated_at": now})
                row = _def_to_row(tool)
                conn.execute("""
                    UPDATE mcp_tools SET
                        name=:name, description=:description, input_schema=:input_schema,
                        output_description=:output_description, target_users=:target_users,
                        complexity=:complexity, categories=:categories,
                        base_prompt=:base_prompt, optimized_prompt=:optimized_prompt,
                        optimization_score=:optimization_score, golden_set_size=:golden_set_size,
                        stage=:stage, blocking_reason=:blocking_reason,
                        optimization_cycles=:optimization_cycles,
                        reevaluation_report=:reevaluation_report,
                        sandbox_pass_rate=:sandbox_pass_rate,
                        build_plan=:build_plan, wrapper_path=:wrapper_path,
                        published=:published, publish_targets=:publish_targets,
                        publish_path=:publish_path, expose_components=:expose_components,
                        auto_update=:auto_update,
                        last_golden_size_at_optimize=:last_golden_size_at_optimize,
                        version=:version, version_tag=:version_tag,
                        deleted=:deleted, updated_at=:updated_at
                    WHERE id=:id
                """, row)
            else:
                tool = tool.model_copy(update={"created_at": now, "updated_at": now})
                row = _def_to_row(tool)
                conn.execute("""
                    INSERT INTO mcp_tools VALUES (
                        :id, :name, :description, :input_schema, :output_description,
                        :target_users, :complexity, :categories, :base_prompt,
                        :optimized_prompt, :optimization_score, :golden_set_size,
                        :stage, :blocking_reason, :optimization_cycles,
                        :reevaluation_report, :sandbox_pass_rate, :build_plan,
                        :wrapper_path, :published, :publish_targets, :publish_path,
                        :expose_components, :auto_update, :last_golden_size_at_optimize,
                        :version, :version_tag, :deleted,
                        NULL, :created_at, :updated_at
                    )
                """, row)

            # Save version snapshot
            conn.execute(
                "INSERT INTO mcp_tool_versions (tool_id, version, snapshot, saved_at) VALUES (?, ?, ?, ?)",
                (tool.id, tool.version, tool.model_dump_json(), now),
            )
            # Prune old versions — keep only last MAX_VERSIONS
            conn.execute("""
                DELETE FROM mcp_tool_versions
                WHERE tool_id = ? AND rowid NOT IN (
                    SELECT rowid FROM mcp_tool_versions
                    WHERE tool_id = ?
                    ORDER BY version DESC LIMIT ?
                )
            """, (tool.id, tool.id, _MAX_VERSIONS))
            conn.commit()

        return tool

    def get_tool(self, tool_id: str) -> Optional[MCPToolDef]:
        with _connect() as conn:
            row = conn.execute(
                "SELECT * FROM mcp_tools WHERE id = ? AND deleted = 0", (tool_id,)
            ).fetchone()
            return _row_to_def(row) if row else None

    def list_tools(self) -> list[MCPToolDef]:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT * FROM mcp_tools WHERE deleted = 0 ORDER BY created_at DESC"
            ).fetchall()
            return [_row_to_def(r) for r in rows]

    def list_published(self) -> list[MCPToolDef]:
        with _connect() as conn:
            rows = conn.execute(
                "SELECT * FROM mcp_tools WHERE published = 1 AND deleted = 0"
            ).fetchall()
            return [_row_to_def(r) for r in rows]

    def delete_tool(self, tool_id: str) -> bool:
        """Soft delete — sets deleted=1, archived_at=now. Files preserved."""
        with _connect() as conn:
            result = conn.execute(
                "UPDATE mcp_tools SET deleted=1, archived_at=? WHERE id=? AND deleted=0",
                (time.time(), tool_id),
            )
            conn.commit()
            return result.rowcount > 0

    def update_stage(
        self,
        tool_id: str,
        stage: str,
        blocking_reason: Optional[str] = None,
        **kwargs,
    ) -> Optional[MCPToolDef]:
        """Update stage (and optional fields) without a full save."""
        tool = self.get_tool(tool_id)
        if not tool:
            return None
        updates = {"stage": stage, "blocking_reason": blocking_reason, **kwargs}
        tool = tool.model_copy(update=updates)
        return self.save_tool(tool)

    def update_fields(self, tool_id: str, **kwargs) -> Optional[MCPToolDef]:
        """Update arbitrary fields."""
        tool = self.get_tool(tool_id)
        if not tool:
            return None
        tool = tool.model_copy(update={**kwargs, "updated_at": time.time()})
        return self.save_tool(tool)

    def existing_ids(self) -> set[str]:
        with _connect() as conn:
            rows = conn.execute("SELECT id FROM mcp_tools WHERE deleted=0").fetchall()
            return {r["id"] for r in rows}


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_store: Optional[MCPToolStore] = None


def get_mcp_tool_store() -> MCPToolStore:
    global _store
    if _store is None:
        _store = MCPToolStore()
    return _store
