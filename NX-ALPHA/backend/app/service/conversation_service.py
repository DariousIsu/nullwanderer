"""
AURA NX-Alpha — Conversation Service
Persist and retrieve conversation threads from Layer 1 SQLite.

Reads from the same memory.db that MemoryService writes to.
Conversation history is stored in the `sliding_window` table,
keyed by thread_id.

EXPOSED API:
    list_conversations(limit)  → list[ConversationMeta]
    get_thread(thread_id)      → list[ConversationTurn]
    restore_thread(thread_id)  → str | None  (summary for re-insertion)
    delete_thread(thread_id)   → bool

Called by chat_controller.py: GET /conversations, POST /conversations/restore
"""

import json
import logging
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_DB_PATH: Optional[Path] = None


# ─────────────────────────────────────────────────────────────────────────────
# DATA SHAPES
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ConversationTurn:
    role: str
    content: str
    timestamp: str
    metadata: dict = field(default_factory=dict)


@dataclass
class ConversationMeta:
    thread_id: str
    first_message: str          # truncated opening user message
    last_active: str            # ISO timestamp of last message
    turn_count: int
    preview: str                # truncated last assistant message


# ─────────────────────────────────────────────────────────────────────────────
# INITIALISATION
# ─────────────────────────────────────────────────────────────────────────────

def init_conversation_service(db_path: str) -> None:
    """Called once at startup. Sets the database path for all queries."""
    global _DB_PATH
    _DB_PATH = Path(db_path).expanduser()
    logger.info("[conversation_service] Using db: %s", _DB_PATH)


def _get_conn() -> sqlite3.Connection:
    if _DB_PATH is None:
        raise RuntimeError("conversation_service not initialized — call init_conversation_service first")
    conn = sqlite3.connect(str(_DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def _db_available() -> bool:
    """True if the db file exists and is readable."""
    return _DB_PATH is not None and _DB_PATH.exists()


# ─────────────────────────────────────────────────────────────────────────────
# QUERIES
# ─────────────────────────────────────────────────────────────────────────────

def list_conversations(limit: int = 50, query: str | None = None) -> list[ConversationMeta]:
    """
    Return the most recently active conversation threads, newest first.
    When `query` is provided, only returns threads that contain matching turns
    (via FTS5 keyword search on memory_fts WHERE agent_role='conversation').
    """
    if not _db_available():
        return []

    try:
        with _get_conn() as conn:
            cur = conn.cursor()

            # When query filter is provided, first find matching thread_ids via FTS5
            matching_threads: set[str] | None = None
            if query and query.strip():
                safe_q = '"' + query.strip().replace('"', '""') + '"'
                try:
                    fts_rows = conn.execute(
                        """SELECT DISTINCT thread_id FROM memory_fts
                           WHERE memory_fts MATCH ? AND agent_role = 'conversation'
                           LIMIT 200""",
                        (safe_q,),
                    ).fetchall()
                    matching_threads = {r[0] for r in fts_rows}
                except Exception:
                    matching_threads = None  # FTS5 table not yet populated — fall through

            # Group by thread_id, get stats
            cur.execute("""
                SELECT
                    thread_id,
                    COUNT(*)                                              AS turn_count,
                    MAX(timestamp)                                        AS last_active,
                    MIN(CASE WHEN role='user' THEN content END)           AS first_message,
                    MAX(CASE WHEN role='assistant' THEN content END)      AS last_response
                FROM sliding_window
                GROUP BY thread_id
                ORDER BY last_active DESC
                LIMIT ?
            """, (limit,))

            rows = cur.fetchall()

        result = []
        for row in rows:
            # Apply query filter if FTS5 returned a matching set
            if matching_threads is not None and row["thread_id"] not in matching_threads:
                continue
            first = (row["first_message"] or "")[:80]
            preview = (row["last_response"] or "")[:120]
            # last_active is REAL (unix epoch) — convert to string for API
            la = row["last_active"]
            la_str = str(la) if la else ""
            result.append(ConversationMeta(
                thread_id=row["thread_id"],
                first_message=first,
                last_active=la_str,
                turn_count=row["turn_count"],
                preview=preview,
            ))
        return result

    except Exception as exc:
        logger.warning("[conversation_service] list_conversations error: %s", exc)
        return []


def get_thread(thread_id: str) -> list[ConversationTurn]:
    """
    Return all turns for a thread in chronological order.
    """
    if not _db_available():
        return []

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT role, content, timestamp
                FROM sliding_window
                WHERE thread_id = ?
                ORDER BY timestamp ASC
            """, (thread_id,))

            rows = cur.fetchall()

        result = []
        for row in rows:
            # Map stored role to display role: 'assistant' → 'aura' for frontend
            display_role = "aura" if row["role"] == "assistant" else row["role"]
            ts = row["timestamp"]
            # timestamp is stored as REAL (unix epoch) — convert to string
            ts_str = str(ts) if ts else ""
            result.append(ConversationTurn(
                role=display_role,
                content=row["content"],
                timestamp=ts_str,
            ))
        return result

    except Exception as exc:
        logger.warning("[conversation_service] get_thread error: %s", exc)
        return []


def restore_thread(thread_id: str) -> Optional[str]:
    """
    Return a compact summary string for re-injecting a past thread into context.
    Format: "RESTORED THREAD {thread_id}\n{role}: {content}\n..."
    Used by the pipeline to prime conversation_history when user loads a past thread.
    """
    turns = get_thread(thread_id)
    if not turns:
        return None

    lines = [f"RESTORED THREAD: {thread_id}"]
    for t in turns[-20:]:   # last 20 turns — keep context manageable
        lines.append(f"{t.role.upper()}: {t.content[:500]}")

    return "\n".join(lines)


def search_conversations(
    query: str, limit: int = 20, thread_id: str | None = None
) -> list[dict]:
    """
    Keyword search over conversation history via FTS5.
    Only searches turns indexed with agent_role='conversation' (i.e. turns stored
    after the dual-write patch was deployed — older turns won't appear).

    Returns list of {thread_id, role, content, timestamp, snippet} dicts.
    """
    if not _db_available() or not query.strip():
        return []

    safe_q = '"' + query.strip().replace('"', '""') + '"'
    try:
        with _get_conn() as conn:
            if thread_id:
                rows = conn.execute(
                    """SELECT doc_id, content, thread_id, area_id AS role, timestamp
                       FROM memory_fts
                       WHERE memory_fts MATCH ? AND agent_role = 'conversation' AND thread_id = ?
                       ORDER BY bm25(memory_fts)
                       LIMIT ?""",
                    (safe_q, thread_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT doc_id, content, thread_id, area_id AS role, timestamp
                       FROM memory_fts
                       WHERE memory_fts MATCH ? AND agent_role = 'conversation'
                       ORDER BY bm25(memory_fts)
                       LIMIT ?""",
                    (safe_q, limit),
                ).fetchall()

        results = []
        for r in rows:
            content = r["content"] or ""
            results.append({
                "thread_id": r["thread_id"],
                "role":      r["role"] or "unknown",
                "content":   content,
                "timestamp": str(r["timestamp"] or ""),
                "snippet":   content[:200],
            })
        return results

    except Exception as exc:
        logger.warning("[conversation_service] search_conversations error: %s", exc)
        return []


async def search_conversations_semantic(query: str, limit: int = 10) -> list[dict]:
    """
    Semantic search over conversation history via ChromaDB L2.
    Searches documents with source='conversation' (indexed by the sliding_window dual-write).
    Groups results by thread_id for context.

    Returns list of {thread_id, role, content, score, timestamp} dicts.
    """
    if not query.strip():
        return []
    try:
        # Import at call time to avoid circular dependency
        from app.service.memory_service import get_memory_service
        mem = get_memory_service()
        if mem is None or not mem._l2_available:
            return []

        raw = mem._query_layer2(
            query,
            n_results=limit,
            where={"source": {"$in": ["conversation"]}},
        )

        results = []
        for item in raw:
            content = item.get("content", "")
            if content.startswith("passage: "):
                content = content[len("passage: "):]
            meta = item.get("metadata", {})
            results.append({
                "thread_id": meta.get("thread_id", ""),
                "role":      meta.get("conv_role", ""),
                "content":   content,
                "score":     round(1.0 - item.get("distance", 1.0), 4),
                "timestamp": meta.get("timestamp", ""),
                "snippet":   content[:200],
            })
        return results

    except Exception as exc:
        logger.warning("[conversation_service] search_conversations_semantic error: %s", exc)
        return []


def delete_thread(thread_id: str) -> bool:
    """
    Delete all turns for a thread. Returns True if rows were deleted.
    """
    if not _db_available():
        return False

    try:
        with _get_conn() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM sliding_window WHERE thread_id = ?", (thread_id,))
            deleted = cur.rowcount > 0
            row_count = cur.rowcount
        logger.info("[conversation_service] Deleted thread: %s (%d rows)", thread_id, row_count)
        return deleted
    except Exception as exc:
        logger.warning("[conversation_service] delete_thread error: %s", exc)
        return False
