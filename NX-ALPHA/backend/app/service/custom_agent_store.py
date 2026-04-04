"""
Custom Agent Store — SQLite persistence for agent definitions created via the Agent Creator.

DB location : ~/.aura/custom_agents.db
Registry    : ~/.aura/custom_registry.json  (published agent manifest)
"""
from __future__ import annotations

import json
import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.models.agent_definition import AgentDefinition

logger = logging.getLogger(__name__)

DB_PATH       = Path.home() / ".aura" / "custom_agents.db"
REGISTRY_PATH = Path.home() / ".aura" / "custom_registry.json"
MAX_VERSIONS  = 5


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _init_db(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS agents (
            id         TEXT    PRIMARY KEY,
            name       TEXT    NOT NULL,
            category   TEXT    NOT NULL,
            definition TEXT    NOT NULL,
            version    INTEGER NOT NULL DEFAULT 1,
            published  INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL,
            updated_at TEXT    NOT NULL
        );

        CREATE TABLE IF NOT EXISTS agent_versions (
            rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
            agent_id   TEXT    NOT NULL,
            version    INTEGER NOT NULL,
            definition TEXT    NOT NULL,
            saved_at   TEXT    NOT NULL,
            FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_versions_agent
            ON agent_versions(agent_id, version);
    """)
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# STORE
# ─────────────────────────────────────────────────────────────────────────────

class CustomAgentStore:
    def __init__(self) -> None:
        with _connect() as conn:
            _init_db(conn)

    # ── CRUD ──────────────────────────────────────────────────────────────────

    def save_agent(self, definition: AgentDefinition) -> AgentDefinition:
        """
        Upsert an agent definition. Version is bumped automatically on every save.
        Keeps only the last MAX_VERSIONS snapshots in agent_versions.
        """
        now = _now()

        with _connect() as conn:
            existing = conn.execute(
                "SELECT version FROM agents WHERE id = ?", (definition.id,)
            ).fetchone()

            if existing:
                new_version = existing["version"] + 1
                definition = definition.model_copy(
                    update={"version": new_version, "updated_at": now}
                )
                conn.execute(
                    """UPDATE agents
                       SET name=?, category=?, definition=?, version=?,
                           published=?, updated_at=?
                       WHERE id=?""",
                    (
                        definition.name, definition.category,
                        definition.model_dump_json(), new_version,
                        int(definition.published), now, definition.id,
                    ),
                )
            else:
                definition = definition.model_copy(
                    update={"version": 1, "created_at": now, "updated_at": now}
                )
                conn.execute(
                    """INSERT INTO agents
                       (id, name, category, definition, version, published, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        definition.id, definition.name, definition.category,
                        definition.model_dump_json(), 1,
                        int(definition.published), now, now,
                    ),
                )

            # Archive this version
            conn.execute(
                """INSERT INTO agent_versions (agent_id, version, definition, saved_at)
                   VALUES (?, ?, ?, ?)""",
                (definition.id, definition.version, definition.model_dump_json(), now),
            )

            # Prune: keep only last MAX_VERSIONS per agent
            conn.execute(
                """DELETE FROM agent_versions WHERE rowid IN (
                       SELECT rowid FROM agent_versions
                       WHERE agent_id = ?
                       ORDER BY version DESC
                       LIMIT -1 OFFSET ?
                   )""",
                (definition.id, MAX_VERSIONS),
            )

            conn.commit()

        logger.info("[custom_agent_store] Saved %s v%d", definition.id, definition.version)
        return definition

    def get_agent(self, agent_id: str) -> Optional[AgentDefinition]:
        with _connect() as conn:
            row = conn.execute(
                "SELECT definition FROM agents WHERE id = ?", (agent_id,)
            ).fetchone()
        if not row:
            return None
        return AgentDefinition.model_validate_json(row["definition"])

    def list_agents(self, category: str | None = None) -> list[AgentDefinition]:
        with _connect() as conn:
            if category:
                rows = conn.execute(
                    "SELECT definition FROM agents WHERE category = ? ORDER BY updated_at DESC",
                    (category,),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT definition FROM agents ORDER BY updated_at DESC"
                ).fetchall()
        return [AgentDefinition.model_validate_json(r["definition"]) for r in rows]

    def delete_agent(self, agent_id: str) -> None:
        with _connect() as conn:
            conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
            conn.commit()
        logger.info("[custom_agent_store] Deleted %s", agent_id)

    def publish_agent(self, agent_id: str) -> AgentDefinition:
        """
        Mark agent as published, write to custom_registry.json,
        compile it, and register it in the dynamic registry.
        """
        now = _now()
        with _connect() as conn:
            row = conn.execute(
                "SELECT definition FROM agents WHERE id = ?", (agent_id,)
            ).fetchone()
            if not row:
                raise ValueError(f"Agent not found: {agent_id}")

            definition = AgentDefinition.model_validate_json(row["definition"])
            definition = definition.model_copy(
                update={"published": True, "updated_at": now}
            )
            conn.execute(
                "UPDATE agents SET published=1, definition=?, updated_at=? WHERE id=?",
                (definition.model_dump_json(), now, agent_id),
            )
            conn.commit()

        self._write_registry(definition)

        from app.service.agent_compiler import compile_agent
        from app.agents.dynamic_registry import register_compiled_agent

        cls = compile_agent(definition)
        register_compiled_agent(agent_id, cls, definition)

        logger.info("[custom_agent_store] Published %s", agent_id)
        return definition

    # ── INTERNAL ──────────────────────────────────────────────────────────────

    def _write_registry(self, definition: AgentDefinition) -> None:
        """Update the on-disk published manifest."""
        REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
        published: list[dict] = []
        if REGISTRY_PATH.exists():
            try:
                published = json.loads(REGISTRY_PATH.read_text())
            except Exception:
                published = []

        published = [e for e in published if e.get("id") != definition.id]
        published.append({"id": definition.id, "name": definition.name})
        REGISTRY_PATH.write_text(json.dumps(published, indent=2))


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_store: Optional[CustomAgentStore] = None


def get_custom_agent_store() -> CustomAgentStore:
    global _store
    if _store is None:
        _store = CustomAgentStore()
    return _store
