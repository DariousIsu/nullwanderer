"""
AURA NX-Alpha — Team Pipeline (Phase 3)
Background StateGraph for multi-agent research tasks.

GRAPH TOPOLOGY:
    START
      └─► project_manager
            ├─► plan_validator     (initial mode — decompose task)
            │     ├─► project_manager  (plan_valid=False, retry up to 3x)
            │     └─► area_agent       (plan_valid=True)
            │           ├─► sprint_agent  (remaining_sprints not empty)
            │           │     ├─► sprint_agent  (more sprints)
            │           │     └─► area_agent    (sprints done — review)
            │           └─► citation_gate  (area review ready — always gates first)
            │                 ├─► area_agent   (citations failed, attempt < 3 — full re-run)
            │                 ├─► area_agent   (citations passed, more areas remain)
            │                 └─► assembler    (citations passed or caveated, all areas done)
            │                       └─► validator
            │                             ├─► assembler  (rejected, retry up to 3x)
            │                             └─► verifier   (approved)
            │                                   └─► project_manager  (return mode)
            └─► END  (path=team_return — TeamDispatcher delivers result)

CHECKPOINTER:
    SQLite at ~/.aura/checkpoints/team.db
    Separate from the chat pipeline checkpointer (aura.db).
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_team_graph = None   # compiled team graph singleton


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
        logger.warning("[team_pipeline] aiosqlite not installed — using MemorySaver")
        from langgraph.checkpoint.memory import MemorySaver
        return MemorySaver()


# ─────────────────────────────────────────────────────────────────────────────
# ROUTING FUNCTIONS
# ─────────────────────────────────────────────────────────────────────────────

def _route_after_project_manager(state: dict) -> str:
    """After PM: team_return → END (TeamDispatcher delivers), else → plan_validator."""
    from langgraph.graph import END
    if state.get("error"):
        return END
    if state.get("path") == "team_return":
        return END  # Team pipeline complete — TeamDispatcher handles delivery
    return "plan_validator"


def _route_after_plan_validator(state: dict) -> str:
    from langgraph.graph import END
    if state.get("error"):
        return END
    if state.get("plan_valid"):
        return "area_agent"
    if state.get("plan_revision_count", 0) >= 3:
        logger.warning("[team_pipeline] Plan revision limit reached — aborting")
        return END
    return "project_manager"


def _route_after_area_agent(state: dict) -> str:
    from langgraph.graph import END
    if state.get("error"):
        return END
    if state.get("current_area_review") is not None:
        # Always pass through citation gate before advancing to next area or assembler
        return "citation_gate"
    if state.get("remaining_sprints"):
        return "sprint_agent"
    return "assembler"


def _route_after_citation_gate(state: dict) -> str:
    from langgraph.graph import END
    if state.get("error"):
        return END
    corrections = state.get("citation_gate_corrections")
    if corrections:
        # Corrections set → gate failed, retry area agent (attempts < 3)
        return "area_agent"
    # Passed (or max retries — caveats flagged, gate cleared)
    if state.get("remaining_areas"):
        return "area_agent"
    return "assembler"


def _route_after_sprint_agent(state: dict) -> str:
    from langgraph.graph import END
    if state.get("error"):
        return END
    if state.get("remaining_sprints"):
        return "sprint_agent"
    return "area_agent"


def _route_after_validator(state: dict) -> str:
    from langgraph.graph import END
    if state.get("error"):
        return END
    result = state.get("validation_result") or {}
    verdict = result.get("verdict", "rejected")
    if verdict == "approved":
        return "verifier"
    if state.get("validator_iteration", 0) >= 3:
        logger.warning("[team_pipeline] Validator limit reached — forcing verifier")
        return "verifier"
    return "assembler"


# ─────────────────────────────────────────────────────────────────────────────
# GRAPH ASSEMBLY
# ─────────────────────────────────────────────────────────────────────────────

async def compile_team_graph(checkpointer_db_path: str | None = None):
    """Compile the AURA team pipeline graph."""
    StateGraph, END = _import_langgraph()

    from app.graph.state import TeamGraphState
    from app.graph.nodes.project_manager import run_project_manager
    from app.graph.nodes.plan_validator   import run_plan_validator
    from app.graph.nodes.area_agent       import run_area_agent
    from app.graph.nodes.sprint_agent     import run_sprint_agent
    from app.graph.nodes.citation_gate    import run_citation_gate
    from app.graph.nodes.assembler        import run_assembler
    from app.graph.nodes.validator        import run_validator
    from app.graph.nodes.verifier         import run_verifier

    builder = StateGraph(TeamGraphState)

    builder.add_node("project_manager", run_project_manager)
    builder.add_node("plan_validator",  run_plan_validator)
    builder.add_node("area_agent",      run_area_agent)
    builder.add_node("sprint_agent",    run_sprint_agent)
    builder.add_node("citation_gate",   run_citation_gate)
    builder.add_node("assembler",       run_assembler)
    builder.add_node("validator",       run_validator)
    builder.add_node("verifier",        run_verifier)

    builder.set_entry_point("project_manager")

    # PM → plan_validator (initial) | END (return mode — path=team_return)
    builder.add_conditional_edges(
        "project_manager",
        _route_after_project_manager,
        {"plan_validator": "plan_validator", END: END},
    )

    # plan_validator → area_agent | project_manager (retry)
    builder.add_conditional_edges(
        "plan_validator",
        _route_after_plan_validator,
        {"area_agent": "area_agent", "project_manager": "project_manager", END: END},
    )

    # area_agent → sprint_agent | citation_gate (when area review ready)
    builder.add_conditional_edges(
        "area_agent",
        _route_after_area_agent,
        {"sprint_agent": "sprint_agent", "citation_gate": "citation_gate", "assembler": "assembler", END: END},
    )

    # citation_gate → area_agent (corrections) | area_agent (next area) | assembler
    builder.add_conditional_edges(
        "citation_gate",
        _route_after_citation_gate,
        {"area_agent": "area_agent", "assembler": "assembler", END: END},
    )

    # sprint_agent → sprint_agent (loop) | area_agent (review)
    builder.add_conditional_edges(
        "sprint_agent",
        _route_after_sprint_agent,
        {"sprint_agent": "sprint_agent", "area_agent": "area_agent", END: END},
    )

    # assembler → validator (always)
    builder.add_edge("assembler", "validator")

    # validator → verifier | assembler (retry)
    builder.add_conditional_edges(
        "validator",
        _route_after_validator,
        {"verifier": "verifier", "assembler": "assembler", END: END},
    )

    # verifier → project_manager (return mode — PM packages then routes to END)
    builder.add_edge("verifier", "project_manager")

    db_path = checkpointer_db_path or str(
        Path("~/.aura/checkpoints/team.db").expanduser()
    )
    checkpointer = await _get_checkpointer(db_path)
    graph = builder.compile(checkpointer=checkpointer)
    logger.info("[team_pipeline] Team graph compiled. Nodes: %d", len(builder.nodes))
    return graph


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

async def init_team_pipeline(checkpointer_db_path: str | None = None):
    """Called once at startup. Compiles and caches the team graph."""
    global _team_graph
    _team_graph = await compile_team_graph(checkpointer_db_path)
    return _team_graph


def get_team_pipeline():
    """Return the compiled team pipeline graph, or None if not initialized."""
    return _team_graph
