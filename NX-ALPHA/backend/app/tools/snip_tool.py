"""
Snip tool — extract conversation snippets from L1 SQLite sliding window.

Supplements memory context by letting the model pull specific prior turns
by keyword, useful when pre-injected context didn't surface what's needed.
"""

import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

_DB_PATH = Path.home() / ".aura" / "conversations.db"


async def snip(query: str, thread_id: str | None = None, limit: int = 5) -> str:
    """
    Search the L1 sliding window for conversation turns matching a keyword.

    Parameters
    ----------
    query : str
        Keyword or phrase to search for (case-insensitive substring match).
    thread_id : str, optional
        Restrict search to a specific conversation thread.
    limit : int
        Maximum number of turns to return (default 5, max 20).

    Returns
    -------
    str
        Formatted matching turns, or 'No snippets found.'
    """
    if not query or not query.strip():
        return "snip requires a non-empty query."

    limit = min(int(limit), 20)
    db_path = _DB_PATH

    if not db_path.exists():
        return "Conversation database not found — no history to search."

    try:
        with sqlite3.connect(str(db_path)) as conn:
            conn.row_factory = sqlite3.Row
            if thread_id:
                rows = conn.execute(
                    """SELECT role, content, timestamp FROM sliding_window
                       WHERE thread_id = ? AND content LIKE ?
                       ORDER BY timestamp DESC LIMIT ?""",
                    (thread_id, f"%{query}%", limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """SELECT role, content, timestamp FROM sliding_window
                       WHERE content LIKE ?
                       ORDER BY timestamp DESC LIMIT ?""",
                    (f"%{query}%", limit),
                ).fetchall()

        if not rows:
            return f"No conversation turns found matching '{query}'."

        import datetime
        lines = []
        for row in reversed(rows):  # chronological order
            ts = row["timestamp"]
            try:
                dt = datetime.datetime.fromtimestamp(float(ts)).strftime("%Y-%m-%d %H:%M")
            except Exception:
                dt = str(ts)
            content = row["content"].strip()[:500]
            lines.append(f"[{dt}] {row['role'].upper()}: {content}")

        return f"Snippets matching '{query}':\n\n" + "\n\n".join(lines)

    except sqlite3.Error as exc:
        logger.warning("[snip_tool] SQLite error: %s", exc)
        return f"Snippet search failed: {exc}"
    except Exception as exc:
        logger.warning("[snip_tool] unexpected error: %s", exc)
        return f"Snippet search failed: {exc}"


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "snip",
    "description": "Search conversation history (L1 SQLite sliding window) for turns matching a keyword.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "query":     {"type": "string", "description": "Keyword to search for"},
            "thread_id": {"type": "string", "description": "Scope search to a specific thread ID (optional)"},
            "limit":     {"type": "integer", "description": "Max results (default 5)"},
        },
        "required": ["query"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    return await snip(
        query=inputs.get("query", ""),
        thread_id=inputs.get("thread_id"),
        limit=int(inputs.get("limit", 5)),
    )
