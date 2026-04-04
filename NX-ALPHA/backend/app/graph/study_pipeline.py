"""
AURA NX-Alpha — Study Pipeline (§9.3 / Sprint 3+)
Separate LangGraph graph for Study Mode operation.

GRAPH TOPOLOGY:
    START
      └─► study_planner           — decompose topic into sprint queue
            └─► study_sprint_agent  — execute one knowledge sprint
                  ├─► study_sprint_agent  (remaining_study_sprints not empty)
                  └─► study_assembler    (all sprints done)
                        └─► END

STATE: StudyGraphState (§9.3 in state.py)

SPRINT 1:
    Stub implementations. Graph compiles and runs.
    study_planner populates a minimal sprint queue.
    study_sprint_agent emits study_progress SSE events.

STUDY MODES (source_tier_min):
    1 — Local knowledge sources only (FTS5 indexed)
    2 — Local + public APIs (CourtListener, Congress API, etc.)
    3 — Local + APIs + live web crawl

CHECKPOINTER:
    Shared with main pipeline at ~/.aura/checkpoints/aura.db
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_study_graph = None


# ─────────────────────────────────────────────────────────────────────────────
# STUB NODE IMPLEMENTATIONS
# ─────────────────────────────────────────────────────────────────────────────

async def run_study_planner(state: dict) -> dict:
    """
    Study Planner — decompose topic into a sprint queue.
    Sprint 1 stub: generates 3 placeholder sprints.
    Sprint 3+: uses Workhorse to build a real research plan.
    """
    import uuid as _uuid
    topic = state.get("topic", "")
    category_path = state.get("category_path", "general")
    depth = state.get("depth", "standard")

    logger.info("[study_planner] Planning study: topic=%.60s depth=%s", topic, depth)

    # Sprint counts per depth
    sprint_counts = {"surface": 2, "standard": 4, "deep": 8}
    n_sprints = sprint_counts.get(depth, 4)

    sprints = [
        {
            "sprint_id":          f"ss-{_uuid.uuid4().hex[:8]}",
            "topic_fragment":     f"{topic} — part {i+1}",
            "category_path":      category_path,
            "source_tier_min":    state.get("source_tier_min", 1),
            "tools":              ["fts5_search", "embedding_search"],
        }
        for i in range(n_sprints)
    ]

    return {
        **state,
        "remaining_study_sprints": sprints,
        "completed_study_sprints": [],
        "study_sprints_completed": 0,
        "study_facts_ingested":    0,
        "error":                   None,
    }


async def run_study_sprint_agent(state: dict) -> dict:
    """
    Study Sprint Agent — execute one knowledge acquisition sprint.
    Sprint 1 stub: pops a sprint, emits study_progress event, accumulates counts.
    Sprint 3+: runs real FTS5/API searches, stores facts in ChromaDB/FalkorDB.
    """
    remaining = list(state.get("remaining_study_sprints", []))
    completed = list(state.get("completed_study_sprints", []))
    sprints_done = state.get("study_sprints_completed", 0)
    facts_ingested = state.get("study_facts_ingested", 0)

    if not remaining:
        logger.warning("[study_sprint_agent] No remaining sprints — nothing to do")
        return state

    sprint = remaining.pop(0)
    completed.append(sprint)
    sprints_done += 1

    # Stub: simulate fact ingestion count
    stub_facts = 12 if state.get("depth") == "deep" else 6
    facts_ingested += stub_facts

    logger.info(
        "[study_sprint_agent] Sprint %d complete: %s (%d facts)",
        sprints_done, sprint.get("sprint_id"), stub_facts
    )

    # Emit study_progress SSE event
    try:
        from app.controller.chat_controller import _emit
        await _emit("study_progress", {
            "sprints_done":  sprints_done,
            "facts_ingested": facts_ingested,
            "category_path":  sprint.get("category_path", ""),
        })
    except Exception as exc:
        logger.debug("[study_sprint_agent] Could not emit SSE: %s", exc)

    return {
        **state,
        "remaining_study_sprints": remaining,
        "completed_study_sprints": completed,
        "study_sprints_completed": sprints_done,
        "study_facts_ingested":    facts_ingested,
        "error":                   None,
    }


async def run_study_assembler(state: dict) -> dict:
    """
    Study Assembler — consolidate sprint results and emit a summary canvas block.
    Sprint 1 stub: emits a simple completion notification.
    Sprint 3+: assembles knowledge map, emits structured canvas blocks.
    """
    topic = state.get("topic", "")
    sprints_done = state.get("study_sprints_completed", 0)
    facts_ingested = state.get("study_facts_ingested", 0)
    category_path = state.get("category_path", "")

    logger.info(
        "[study_assembler] Study complete: %d sprints, %d facts — %s",
        sprints_done, facts_ingested, topic
    )

    summary = (
        f"Study session complete.\n"
        f"Topic: {topic}\n"
        f"Category: {category_path}\n"
        f"Sprints completed: {sprints_done}\n"
        f"Facts ingested: {facts_ingested}"
    )

    try:
        from app.controller.chat_controller import _emit
        await _emit("render_canvas", {
            "blocks": [{
                "type":    "callout",
                "level":   "info",
                "title":   "Study Complete",
                "content": summary,
            }],
            "title": f"Study: {topic[:60]}",
        })
        await _emit("token", {"text": summary, "messageId": "study-complete"})
        await _emit("end", {"reason": "study_complete"})
    except Exception as exc:
        logger.debug("[study_assembler] Could not emit SSE: %s", exc)

    return {**state, "error": None}


# ─────────────────────────────────────────────────────────────────────────────
# ROUTING
# ─────────────────────────────────────────────────────────────────────────────

def _route_after_sprint(state: dict) -> str:
    """More sprints → loop; done → assembler."""
    from langgraph.graph import END
    if state.get("error"):
        return END
    if state.get("remaining_study_sprints"):
        return "study_sprint_agent"
    return "study_assembler"


# ─────────────────────────────────────────────────────────────────────────────
# GRAPH ASSEMBLY
# ─────────────────────────────────────────────────────────────────────────────

def compile_study_graph(checkpointer_db_path: str | None = None):
    """
    Compile the AURA study pipeline graph.
    Shares the same SQLite checkpointer as the main pipeline.
    """
    try:
        from langgraph.graph import StateGraph, END
    except ImportError as exc:
        raise ImportError(
            "LangGraph is not installed. "
            "Run: pip install langgraph langgraph-checkpoint-sqlite"
        ) from exc

    from app.graph.state import StudyGraphState

    # Reuse main pipeline's checkpointer
    try:
        from app.graph.pipeline import _get_checkpointer
        db_path = checkpointer_db_path or str(
            Path("~/.aura/checkpoints/aura.db").expanduser()
        )
        checkpointer = _get_checkpointer(db_path)
    except Exception as exc:
        logger.warning("[study_pipeline] Could not get checkpointer: %s — using MemorySaver", exc)
        from langgraph.checkpoint.memory import MemorySaver
        checkpointer = MemorySaver()

    builder = StateGraph(StudyGraphState)

    builder.add_node("study_planner",       run_study_planner)
    builder.add_node("study_sprint_agent",  run_study_sprint_agent)
    builder.add_node("study_assembler",     run_study_assembler)

    builder.set_entry_point("study_planner")
    builder.add_edge("study_planner", "study_sprint_agent")

    builder.add_conditional_edges(
        "study_sprint_agent",
        _route_after_sprint,
        {"study_sprint_agent": "study_sprint_agent", "study_assembler": "study_assembler", END: END},
    )

    builder.add_edge("study_assembler", END)

    compile_kwargs = {}
    if checkpointer is not None:
        compile_kwargs["checkpointer"] = checkpointer

    graph = builder.compile(**compile_kwargs)
    logger.info("[study_pipeline] Study graph compiled. Nodes: %d", len(builder.nodes))
    return graph


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

def init_study_pipeline(checkpointer_db_path: str | None = None):
    """Called at startup. Compiles and caches the study graph."""
    global _study_graph
    _study_graph = compile_study_graph(checkpointer_db_path)
    return _study_graph


def get_study_pipeline():
    """Return the compiled study pipeline graph, or None if not initialized."""
    return _study_graph


# ─────────────────────────────────────────────────────────────────────────────
# INVOKE HELPER
# ─────────────────────────────────────────────────────────────────────────────

async def run_study_session(
    topic: str,
    category_path: str,
    depth: str = "standard",
    source_tier_min: int = 1,
    storage_quota_gb: float = 2.0,
    thread_id: str | None = None,
    study_session_id: str | None = None,
) -> None:
    """
    Launch a study session via the compiled study pipeline.
    Called by chat_controller when path == 'study'.
    Emits study_progress and render_canvas SSE events throughout.
    """
    import uuid as _uuid

    pipeline = get_study_pipeline()
    if pipeline is None:
        logger.error("[study_pipeline] Study pipeline not initialized")
        return

    session_id = study_session_id or _uuid.uuid4().hex
    tid = thread_id or _uuid.uuid4().hex

    state = {
        "study_session_id":       session_id,
        "thread_id":               tid,
        "user_id":                 "local",
        "topic":                   topic,
        "category_path":           category_path,
        "depth":                   depth,
        "source_tier_min":         source_tier_min,
        "storage_quota_gb":        storage_quota_gb,
        "remaining_study_sprints": [],
        "completed_study_sprints": [],
        "study_sprints_completed": 0,
        "study_facts_ingested":    0,
        "workhorse_model":         "qwen3-vl-14b",
        "hardware_phase":          1,
        "error":                   None,
    }

    config = {"configurable": {"thread_id": tid}}

    try:
        await pipeline.ainvoke(state, config)
    except Exception as exc:
        logger.error("[study_pipeline] Study session failed: %s", exc, exc_info=True)
