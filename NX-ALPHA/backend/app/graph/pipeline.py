"""
AURA NX-Alpha — Chat Pipeline (Phase 3)
Chat-only graph: a single interface_agent node.

GRAPH TOPOLOGY:
    START → interface_agent → END

The team pipeline lives in team_pipeline.py and is managed by TeamDispatcher.
interface_agent now dispatches team tasks to TeamDispatcher and returns
immediately with an acknowledgment — it no longer routes into the team graph.

CHECKPOINTER:
    SQLite at ~/.aura/checkpoints/aura.db
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_graph = None   # compiled chat graph singleton


def _import_langgraph():
    try:
        from langgraph.graph import StateGraph, END
        return StateGraph, END
    except ImportError as exc:
        raise ImportError(
            "LangGraph is not installed. "
            "Run: pip install langgraph langgraph-checkpoint-sqlite"
        ) from exc


async def _get_checkpointer(db_path: str):
    try:
        import aiosqlite
        from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(db_path)
        saver = AsyncSqliteSaver(conn)
        await saver.setup()
        return saver
    except ImportError:
        logger.warning("[pipeline] aiosqlite not installed — using MemorySaver")
        from langgraph.checkpoint.memory import MemorySaver
        return MemorySaver()


# ─────────────────────────────────────────────────────────────────────────────
# GRAPH ASSEMBLY
# ─────────────────────────────────────────────────────────────────────────────

async def compile_graph(checkpointer_db_path: str | None = None):
    """
    Compile the AURA chat pipeline graph.
    Single node: interface_agent → END.
    """
    StateGraph, END = _import_langgraph()

    from app.graph.state import GraphState
    from app.graph.nodes.interface_agent import run_interface_agent

    builder = StateGraph(GraphState)
    builder.add_node("interface_agent", run_interface_agent)
    builder.set_entry_point("interface_agent")
    builder.add_edge("interface_agent", END)

    db_path = checkpointer_db_path or str(
        Path("~/.aura/checkpoints/aura.db").expanduser()
    )
    checkpointer = await _get_checkpointer(db_path)
    graph = builder.compile(checkpointer=checkpointer)
    logger.info("[pipeline] Chat graph compiled. Nodes: %d", len(builder.nodes))
    return graph


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

async def init_pipeline(checkpointer_db_path: str | None = None):
    """Called once at startup. Compiles and caches the chat graph."""
    global _graph
    _graph = await compile_graph(checkpointer_db_path)
    return _graph


def get_pipeline():
    """Return the compiled chat pipeline graph, or None if not initialized."""
    return _graph
