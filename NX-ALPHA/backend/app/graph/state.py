"""
AURA NX-Alpha — GraphState and Sub-Types
Single source of truth for all LangGraph pipeline state.

§9.1 GraphState TypedDict
§9.2 Sub-Types (MemoryMarker, AgentResult, carry-forward types)
§9.3 StudyGraphState TypedDict

Stored and restored by LangGraph checkpointer (SQLite local).
"""

from __future__ import annotations
from typing import Any, Literal, Optional
from typing_extensions import TypedDict


# ─────────────────────────────────────────────────────────────────────────────
# §9.2 SUB-TYPES — NEW IN NX-ALPHA
# ─────────────────────────────────────────────────────────────────────────────

class MemoryMarker(TypedDict):
    """Pointer to data stored in Layer 2 or 3 memory. Agents pass markers, not raw data."""
    marker_id: str
    type: Literal["data_point", "document", "image", "tool_result", "analysis"]
    source_layer: Literal[2, 3]
    source_key: str
    summary: str
    retrieval_query: str


class AgentResult(TypedDict):
    """Compact structured deliverable from a Sprint Agent (~500–800 tokens + markers)."""
    sprint_id: str
    area_id: str
    agent_id: str
    content: str            # compact structured deliverable
    markers: list           # list[MemoryMarker] — DB pointers to raw data
    summary: str            # one-line inline summary
    sources: list           # list[str]
    metadata: dict          # dict[str, Any]


# ─────────────────────────────────────────────────────────────────────────────
# SUB-TYPES — CARRY-FORWARD FROM V2 (unchanged unless noted)
# ─────────────────────────────────────────────────────────────────────────────

class ConversationMessage(TypedDict):
    role: Literal["user", "aura", "system"]
    content: str
    timestamp: str


class AreaBrief(TypedDict):
    area_id: str
    domain: str
    objective: str
    context_markers: list   # list[MemoryMarker]
    tools: list             # list[str]


class SprintBrief(TypedDict):
    sprint_id: str
    area_id: str
    task: str
    tools: list             # list[str]
    context_markers: list   # list[MemoryMarker]


class AreaReview(TypedDict):
    area_id: str
    verdict: Literal["pass", "fail", "partial"]
    notes: str
    sprint_results: list    # list[AgentResult]


class AssembledOutput(TypedDict):
    content: str
    canvas_blocks: list     # list[ContentBlock]
    provenance_map: dict    # {area_id: list[sprint_id]}
    markers: list           # list[MemoryMarker]


class CorrectionNote(TypedDict):
    agent_id: str
    area_id: str
    issue: str
    instruction: str


class CorrectionNotes(TypedDict):
    notes: list             # list[CorrectionNote]
    affected_areas: list    # list[str]


class ValidationResult(TypedDict):
    verdict: Literal["approved", "rejected", "partial"]
    score: float
    correction_notes: Optional[CorrectionNotes]


class CitationGateResult(TypedDict):
    verdict: Literal["pass", "fail", "pass_with_caveats"]
    corrections: Optional[dict]      # {citation_index: {issue, suggested_fix}}
    caveats: list                    # list[str] for pass_with_caveats
    citation_count: int
    failed_count: int


class CanvasPayload(TypedDict):
    blocks: list            # list[ContentBlock]
    title: str


class SatelliteRoute(TypedDict):
    satellite_id: str
    model: str
    model_family: str
    host: str
    port: int
    is_challenger_eligible: bool  # Changed: new field (was not in V2)
    online: bool


class ExecutionPlan(TypedDict):
    team_id: str
    task: str
    area_briefs: list       # list[AreaBrief]
    agents: list            # list[dict] — simplified agent specs


# ─────────────────────────────────────────────────────────────────────────────
# §9.1 GRAPH STATE — MAIN PIPELINE
# ─────────────────────────────────────────────────────────────────────────────

class GraphState(TypedDict):
    # ── Identity ──────────────────────────────────────────────────────────────
    thread_id: str
    user_id: str
    execution_id: str

    # ── Conversation ──────────────────────────────────────────────────────────
    conversation_history: list          # list[ConversationMessage]
    user_message: str
    final_response: Optional[str]

    # ── Routing ───────────────────────────────────────────────────────────────
    path: Optional[Literal["solo", "team", "team_return", "study"]]
    team_request: Optional[str]
    team_enabled: bool                  # Team Gate state — False by default at launch

    # ── Planning ──────────────────────────────────────────────────────────────
    execution_plan: Optional[ExecutionPlan]
    plan_valid: Optional[bool]
    plan_corrections: Optional[list]    # list[str]
    plan_revision_count: int

    # ── Head-Tail Work Queues ─────────────────────────────────────────────────
    remaining_areas: list               # list[AreaBrief]
    remaining_sprints: list             # list[SprintBrief]

    # ── Current Area Context ──────────────────────────────────────────────────
    current_area_brief: Optional[AreaBrief]
    current_area_sprint_results: list   # list[AgentResult]
    current_area_review: Optional[AreaReview]
    area_review_count: int

    # ── Global Results ────────────────────────────────────────────────────────
    sprint_results: list                # list[AgentResult]
    area_results: list                  # list[AreaReview]

    # ── Assembly + Validation ─────────────────────────────────────────────────
    assembled_output: Optional[AssembledOutput]
    correction_notes: Optional[CorrectionNotes]
    validation_result: Optional[ValidationResult]
    validator_iteration: int

    # ── Verification ──────────────────────────────────────────────────────────
    verified: Optional[bool]
    verified_output: Optional[AssembledOutput]

    # ── Display ───────────────────────────────────────────────────────────────
    canvas: Optional[CanvasPayload]

    # ── Study Mode ────────────────────────────────────────────────────────────
    study_session_id: Optional[str]
    study_category_path: Optional[str]
    study_sprints_completed: int
    study_facts_ingested: int

    # ── Dual-Model Infrastructure (phase-aware) ───────────────────────────────
    interface_model: str    # "qwen3-vl-4b" (Phase 1) | "gemma-3-27b-qat" (Phase 2+)
    workhorse_model: str    # "qwen3-vl-14b" (Phase 1) | "qwen3-vl-32b" (Phase 2+)
    hardware_phase: int     # 1 | 2 | 3 | 4

    # ── Satellite + Mode ──────────────────────────────────────────────────────
    satellite_routes: dict          # dict[str, SatelliteRoute]
    operating_mode: Literal["quiet", "ambient", "proactive", "study"]

    # ── Voice [Phase 2+] ──────────────────────────────────────────────────────
    voice_enabled: bool
    tts_model: Optional[str]        # "moss-tts-realtime" (Phase 2) | "moss-tts" (Phase 3+)

    # ── Error ─────────────────────────────────────────────────────────────────
    error: Optional[str]


def initial_state(
    thread_id: str,
    user_id: str = "local",
    hardware_phase: int = 1,
    interface_model: str = "qwen3-vl-4b",
    workhorse_model: str = "qwen3-vl-14b",
    team_enabled: bool = False,
    operating_mode: str = "proactive",
) -> GraphState:
    """Return a fresh GraphState with safe defaults."""
    import uuid
    return GraphState(
        thread_id=thread_id,
        user_id=user_id,
        execution_id=str(uuid.uuid4()),
        conversation_history=[],
        user_message="",
        final_response=None,
        path=None,
        team_request=None,
        team_enabled=team_enabled,
        execution_plan=None,
        plan_valid=None,
        plan_corrections=None,
        plan_revision_count=0,
        remaining_areas=[],
        remaining_sprints=[],
        current_area_brief=None,
        current_area_sprint_results=[],
        current_area_review=None,
        area_review_count=0,
        sprint_results=[],
        area_results=[],
        assembled_output=None,
        correction_notes=None,
        validation_result=None,
        validator_iteration=0,
        verified=None,
        verified_output=None,
        canvas=None,
        study_session_id=None,
        study_category_path=None,
        study_sprints_completed=0,
        study_facts_ingested=0,
        interface_model=interface_model,
        workhorse_model=workhorse_model,
        hardware_phase=hardware_phase,
        satellite_routes={},
        operating_mode=operating_mode,
        voice_enabled=False,
        tts_model=None,
        error=None,
    )


# ─────────────────────────────────────────────────────────────────────────────
# §9.3 STUDY GRAPH STATE — SEPARATE GRAPH (study_pipeline.py)
# ─────────────────────────────────────────────────────────────────────────────

class StudySprintBrief(TypedDict):
    sprint_id: str
    topic_fragment: str         # scoped sub-topic for this sprint
    category_path: str          # inherited from session
    source_tier_min: int        # 1 | 2 | 3 — user-set floor
    tools: list                 # list[str]


class StudyGraphState(TypedDict):
    # Session Identity
    study_session_id: str
    thread_id: str              # same thread as main graph
    user_id: str

    # Study Parameters (from prompt)
    topic: str
    category_path: str
    depth: Literal["surface", "standard", "deep"]
    source_tier_min: int        # 1 | 2 | 3
    storage_quota_gb: float

    # Study Pipeline Queues
    remaining_study_sprints: list   # list[StudySprintBrief]
    completed_study_sprints: list   # list[StudySprintBrief]

    # Progress Counters
    study_sprints_completed: int
    study_facts_ingested: int

    # Infrastructure
    workhorse_model: str
    hardware_phase: int

    # Error
    error: Optional[str]


# ─────────────────────────────────────────────────────────────────────────────
# §9.4 TEAM GRAPH STATE — separate background graph (team_pipeline.py)
# Lean TypedDict — only what the team pipeline nodes need.
# No conversation_history, no interface model, no voice, no canvas display.
# ─────────────────────────────────────────────────────────────────────────────

class TeamGraphState(TypedDict):
    # ── Identity ──────────────────────────────────────────────────────────────
    team_id: str
    thread_id: str          # chat session thread — used to deliver result back

    # ── Task ──────────────────────────────────────────────────────────────────
    team_request: str       # original user request (PM uses team_request)
    user_message: str       # alias — for compatibility with _handle_team_return
    output_contract: Optional[str]  # PM-set quality contract for assembler

    # ── Planning ──────────────────────────────────────────────────────────────
    execution_plan: Optional[ExecutionPlan]
    plan_valid: Optional[bool]
    plan_corrections: Optional[list]
    plan_revision_count: int

    # ── Head-Tail Work Queues ─────────────────────────────────────────────────
    remaining_areas: list               # list[AreaBrief]
    remaining_sprints: list             # list[SprintBrief]

    # ── Current Area Context ──────────────────────────────────────────────────
    current_area_brief: Optional[AreaBrief]
    current_area_sprint_results: list   # list[AgentResult]
    current_area_review: Optional[AreaReview]
    area_review_count: int

    # ── Global Results ────────────────────────────────────────────────────────
    sprint_results: list                # list[AgentResult]
    area_results: list                  # list[AreaReview]

    # ── Assembly + Validation ─────────────────────────────────────────────────
    assembled_output: Optional[AssembledOutput]
    correction_notes: Optional[CorrectionNotes]
    validation_result: Optional[ValidationResult]
    validator_iteration: int

    # ── Verification ──────────────────────────────────────────────────────────
    verified: Optional[bool]
    verified_output: Optional[AssembledOutput]

    # ── Routing ───────────────────────────────────────────────────────────────
    path: Optional[str]     # set to "team_return" by PM when work is complete

    # ── Citation Gate ─────────────────────────────────────────────────────────
    citation_gate_attempts: int          # reset to 0 at start of each new area
    citation_gate_corrections: Optional[dict]  # {citation_index: {claim, issue, suggested_fix}}
    citation_gate_caveats: list          # list[str] — issues that passed on 3rd attempt

    # ── PM Clarification (Phase 5 stub — not yet active) ─────────────────────
    awaiting_clarification: Optional[bool]
    clarification_question: Optional[str]
    clarification_answer: Optional[str]

    # ── Infrastructure ────────────────────────────────────────────────────────
    workhorse_model: str
    hardware_phase: int

    # ── Error ─────────────────────────────────────────────────────────────────
    error: Optional[str]


def initial_team_state(
    team_id: str,
    thread_id: str,
    task: str,
    workhorse_model: str = "gemma3:12b",
    hardware_phase: int = 1,
) -> TeamGraphState:
    """Return a fresh TeamGraphState with safe defaults."""
    return TeamGraphState(
        team_id=team_id,
        thread_id=thread_id,
        team_request=task,
        user_message=task,
        output_contract=None,
        execution_plan=None,
        plan_valid=None,
        plan_corrections=None,
        plan_revision_count=0,
        remaining_areas=[],
        remaining_sprints=[],
        current_area_brief=None,
        current_area_sprint_results=[],
        current_area_review=None,
        area_review_count=0,
        sprint_results=[],
        area_results=[],
        assembled_output=None,
        correction_notes=None,
        validation_result=None,
        validator_iteration=0,
        verified=None,
        verified_output=None,
        path=None,
        citation_gate_attempts=0,
        citation_gate_corrections=None,
        citation_gate_caveats=[],
        awaiting_clarification=None,
        clarification_question=None,
        clarification_answer=None,
        workhorse_model=workhorse_model,
        hardware_phase=hardware_phase,
        error=None,
    )
