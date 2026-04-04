"""
AURA NX-Alpha — Satellite Registry
SQLite-backed registry for all known satellites. Persists across restarts.
Stores identity, hardware info, model assignments, and circuit breaker state.

DB Path: ~/.aura/satellites.db

SINGLETON PATTERN:
    Call init_satellite_registry() at startup.
    Use get_satellite_registry() to access the instance.
"""

from __future__ import annotations

import logging
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SCHEMA
# ─────────────────────────────────────────────────────────────────────────────

_CREATE_TABLE = """
CREATE TABLE IF NOT EXISTS satellites (
    id                    TEXT PRIMARY KEY,
    name                  TEXT NOT NULL,
    host                  TEXT NOT NULL,
    port                  INTEGER NOT NULL DEFAULT 7779,
    role                  TEXT NOT NULL DEFAULT 'general',
    model                 TEXT DEFAULT '',
    model_family          TEXT DEFAULT '',
    status                TEXT NOT NULL DEFAULT 'offline',
    gpu_type              TEXT DEFAULT '',
    gpu_class             TEXT DEFAULT '',
    vram_mb               INTEGER DEFAULT 0,
    ram_gb                REAL DEFAULT 0,
    cpu_name              TEXT DEFAULT '',
    cpu_cores             INTEGER DEFAULT 0,
    chassis               TEXT DEFAULT 'desktop',
    is_laptop             INTEGER DEFAULT 0,
    auth_token            TEXT DEFAULT '',
    last_seen             REAL DEFAULT 0,
    circuit_breaker_tripped INTEGER DEFAULT 0,
    circuit_breaker_time  REAL DEFAULT 0,
    circuit_breaker_reason TEXT DEFAULT '',
    cooldown_until        REAL DEFAULT 0,
    created_at            REAL NOT NULL,
    updated_at            REAL NOT NULL
);
"""

_CREATE_EVENTS_TABLE = """
CREATE TABLE IF NOT EXISTS satellite_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    satellite_id TEXT NOT NULL,
    event_type  TEXT NOT NULL,
    detail      TEXT DEFAULT '',
    timestamp   REAL NOT NULL,
    FOREIGN KEY (satellite_id) REFERENCES satellites(id) ON DELETE CASCADE
);
"""


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: Optional["SatelliteRegistry"] = None


def init_satellite_registry(db_path: str = "~/.aura/satellites.db") -> "SatelliteRegistry":
    global _instance
    _instance = SatelliteRegistry(db_path)
    return _instance


def get_satellite_registry() -> Optional["SatelliteRegistry"]:
    return _instance


# ─────────────────────────────────────────────────────────────────────────────
# REGISTRY
# ─────────────────────────────────────────────────────────────────────────────

class SatelliteRegistry:
    """SQLite-backed satellite registry."""

    def __init__(self, db_path: str = "~/.aura/satellites.db"):
        self._db_path = Path(db_path).expanduser()
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self._init_tables()
        logger.info("[satellite_registry] Initialized at %s", self._db_path)

    def _init_tables(self) -> None:
        self._conn.executescript(_CREATE_TABLE + _CREATE_EVENTS_TABLE)
        # Safe migration: add auth_token column to existing databases
        try:
            self._conn.execute("ALTER TABLE satellites ADD COLUMN auth_token TEXT DEFAULT ''")
            self._conn.commit()
            logger.info("[satellite_registry] Migrated: added auth_token column")
        except sqlite3.OperationalError:
            pass  # Column already exists

    def _row_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        d["circuit_breaker_tripped"] = bool(d.get("circuit_breaker_tripped", 0))
        d["is_laptop"] = bool(d.get("is_laptop", 0))
        return d

    # ── CRUD ─────────────────────────────────────────────────────────────────

    def register_satellite(self, data: dict[str, Any]) -> dict[str, Any]:
        """Register a new satellite. Returns the created record."""
        now = time.time()
        sat_id = data.get("id") or f"sat-{uuid.uuid4().hex[:8]}"
        self._conn.execute(
            """INSERT INTO satellites
               (id, name, host, port, role, model, model_family, status,
                gpu_type, gpu_class, vram_mb, ram_gb, cpu_name, cpu_cores,
                chassis, is_laptop, auth_token, last_seen, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                sat_id,
                data.get("name", f"Satellite-{sat_id[:8]}"),
                data["host"],
                data.get("port", 7779),
                data.get("role", "general"),
                data.get("model", ""),
                data.get("model_family", ""),
                data.get("status", "offline"),
                data.get("gpu_type", ""),
                data.get("gpu_class", ""),
                data.get("vram_mb", 0),
                data.get("ram_gb", 0),
                data.get("cpu_name", ""),
                data.get("cpu_cores", 0),
                data.get("chassis", "desktop"),
                1 if data.get("is_laptop") else 0,
                data.get("auth_token", ""),
                now,
                now,
                now,
            ),
        )
        self._conn.commit()
        self._log_event(sat_id, "registered", f"host={data['host']}")
        logger.info("[satellite_registry] Registered satellite %s (%s)", sat_id, data["host"])
        return self.get_by_id(sat_id)  # type: ignore

    def update_satellite(self, sat_id: str, data: dict[str, Any]) -> dict[str, Any] | None:
        """Update fields on an existing satellite."""
        existing = self.get_by_id(sat_id)
        if not existing:
            return None

        allowed = {
            "name", "host", "port", "role", "model", "model_family", "status",
            "gpu_type", "gpu_class", "vram_mb", "ram_gb", "cpu_name", "cpu_cores",
            "chassis", "is_laptop", "auth_token", "last_seen",
            "circuit_breaker_tripped", "circuit_breaker_time", "circuit_breaker_reason",
            "cooldown_until",
        }
        updates = {k: v for k, v in data.items() if k in allowed}
        if not updates:
            return existing

        updates["updated_at"] = time.time()
        # Convert booleans to int for SQLite
        if "circuit_breaker_tripped" in updates:
            updates["circuit_breaker_tripped"] = 1 if updates["circuit_breaker_tripped"] else 0
        if "is_laptop" in updates:
            updates["is_laptop"] = 1 if updates["is_laptop"] else 0

        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [sat_id]
        self._conn.execute(f"UPDATE satellites SET {set_clause} WHERE id = ?", values)
        self._conn.commit()
        return self.get_by_id(sat_id)

    def remove_satellite(self, sat_id: str) -> bool:
        """Remove a satellite from the registry."""
        cur = self._conn.execute("DELETE FROM satellites WHERE id = ?", (sat_id,))
        self._conn.commit()
        removed = cur.rowcount > 0
        if removed:
            logger.info("[satellite_registry] Removed satellite %s", sat_id)
        return removed

    def get_all(self) -> list[dict[str, Any]]:
        """Return all registered satellites."""
        rows = self._conn.execute("SELECT * FROM satellites ORDER BY created_at DESC").fetchall()
        return [self._row_to_dict(r) for r in rows]

    def get_by_id(self, sat_id: str) -> dict[str, Any] | None:
        """Return a single satellite by ID."""
        row = self._conn.execute("SELECT * FROM satellites WHERE id = ?", (sat_id,)).fetchone()
        return self._row_to_dict(row) if row else None

    def get_by_host(self, host: str) -> dict[str, Any] | None:
        """Return a satellite by host IP."""
        row = self._conn.execute("SELECT * FROM satellites WHERE host = ?", (host,)).fetchone()
        return self._row_to_dict(row) if row else None

    def get_by_token(self, token: str) -> dict[str, Any] | None:
        """Return a satellite by its auth_token. Used to validate collector ingest requests."""
        if not token:
            return None
        row = self._conn.execute(
            "SELECT * FROM satellites WHERE auth_token = ?", (token,)
        ).fetchone()
        return self._row_to_dict(row) if row else None

    def update_last_seen(self, sat_id: str, status: str = "online") -> None:
        """Touch last_seen and optionally update status."""
        now = time.time()
        self._conn.execute(
            "UPDATE satellites SET last_seen = ?, status = ?, updated_at = ? WHERE id = ?",
            (now, status, now, sat_id),
        )
        self._conn.commit()

    # ── Circuit Breaker ──────────────────────────────────────────────────────

    def trip_circuit_breaker(self, sat_id: str, reason: str) -> None:
        """Trip the circuit breaker for a satellite."""
        now = time.time()
        self._conn.execute(
            """UPDATE satellites SET
               circuit_breaker_tripped = 1,
               circuit_breaker_time = ?,
               circuit_breaker_reason = ?,
               status = 'circuit_breaker',
               updated_at = ?
               WHERE id = ?""",
            (now, reason, now, sat_id),
        )
        self._conn.commit()
        self._log_event(sat_id, "circuit_breaker_tripped", reason)
        logger.warning("[satellite_registry] Circuit breaker tripped for %s: %s", sat_id, reason)

    def reset_circuit_breaker(self, sat_id: str) -> dict[str, Any] | None:
        """Manual circuit breaker reset. Starts 5-minute cooldown."""
        now = time.time()
        cooldown_end = now + 300  # 5 minutes
        self._conn.execute(
            """UPDATE satellites SET
               circuit_breaker_tripped = 0,
               circuit_breaker_reason = '',
               cooldown_until = ?,
               status = 'cooldown',
               updated_at = ?
               WHERE id = ?""",
            (cooldown_end, now, sat_id),
        )
        self._conn.commit()
        self._log_event(sat_id, "circuit_breaker_reset", f"cooldown_until={cooldown_end}")
        logger.info("[satellite_registry] Circuit breaker reset for %s — cooldown until %.0f", sat_id, cooldown_end)
        return self.get_by_id(sat_id)

    def check_cooldown_expired(self, sat_id: str) -> bool:
        """Check if a satellite's cooldown period has expired."""
        sat = self.get_by_id(sat_id)
        if not sat:
            return False
        if sat["status"] == "cooldown" and time.time() >= sat.get("cooldown_until", 0):
            self._conn.execute(
                "UPDATE satellites SET status = 'online', cooldown_until = 0, updated_at = ? WHERE id = ?",
                (time.time(), sat_id),
            )
            self._conn.commit()
            self._log_event(sat_id, "cooldown_expired", "")
            return True
        return False

    # ── Events ───────────────────────────────────────────────────────────────

    def _log_event(self, sat_id: str, event_type: str, detail: str = "") -> None:
        self._conn.execute(
            "INSERT INTO satellite_events (satellite_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)",
            (sat_id, event_type, detail, time.time()),
        )
        self._conn.commit()

    def get_events(self, sat_id: str, limit: int = 50) -> list[dict]:
        rows = self._conn.execute(
            "SELECT * FROM satellite_events WHERE satellite_id = ? ORDER BY timestamp DESC LIMIT ?",
            (sat_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_network_map(self) -> list[dict[str, Any]]:
        """Return topology data for the network map UI."""
        satellites = self.get_all()
        return [
            {
                "id": s["id"],
                "name": s["name"],
                "host": s["host"],
                "port": s["port"],
                "role": s["role"],
                "model": s["model"],
                "gpu_type": s["gpu_type"],
                "vram_mb": s["vram_mb"],
                "status": s["status"],
                "is_laptop": s["is_laptop"],
                "circuit_breaker_tripped": s["circuit_breaker_tripped"],
                "last_seen": s["last_seen"],
            }
            for s in satellites
        ]
