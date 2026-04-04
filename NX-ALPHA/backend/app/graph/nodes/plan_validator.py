"""
AURA NX-Alpha — Plan Validator Node (§12.1)
Reviews the ExecutionPlan for completeness and feasibility.
Uses Ollama with schema-constrained output. Falls back to auto-approve.
"""

import logging
from app.graph.state import GraphState

logger = logging.getLogger(__name__)

_MAX_REVISIONS = 3

# Schema for plan validation response
_VALIDATION_SCHEMA = {
    "type": "object",
    "properties": {
        "valid":       {"type": "boolean"},
        "corrections": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["valid", "corrections"],
}


async def run_plan_validator(state: GraphState) -> dict:
    """
    Plan validation gate.
    Calls Ollama to review the plan and flag issues.
    Falls back to auto-approve if Ollama unavailable or max revisions exceeded.
    """
    from app.controller.chat_controller import _emit

    plan = state.get("execution_plan")
    revision = state.get("plan_revision_count", 0)

    if plan is None:
        logger.warning("[plan_validator] No execution plan in state — forcing valid")
        return {"plan_valid": True, "plan_corrections": None}

    if revision >= _MAX_REVISIONS:
        logger.warning("[plan_validator] Max revisions (%d) reached — forcing approval", _MAX_REVISIONS)
        return {"plan_valid": True, "plan_corrections": None}

    areas = plan.get("area_briefs", [])
    task = plan.get("task", "")

    await _emit("agent_update", {
        "node": "plan_validator",
        "status": "running",
        "detail": f"Validating plan ({len(areas)} areas)...",
    })

    valid, corrections = await _validate_with_ollama(task, areas)

    await _emit("agent_update", {
        "node": "plan_validator",
        "status": "complete",
        "detail": "Approved" if valid else f"Needs revision: {corrections}",
    })

    return {"plan_valid": valid, "plan_corrections": corrections if not valid else None}


async def _validate_with_ollama(task: str, areas: list) -> tuple[bool, list[str]]:
    """Ask Ollama to validate the plan. Returns (is_valid, corrections)."""
    try:
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc is None or not svc.is_available():
            raise RuntimeError("Ollama not available")

        area_text = "\n".join(
            f"  - [{a.get('domain', '?')}] {a.get('objective', '?')}"
            for a in areas
        )
        prompt = f"""Review this execution plan for completeness and feasibility.

Original task: {task}

Proposed areas:
{area_text}

Respond with JSON: {{"valid": true/false, "corrections": ["issue1", "issue2"]}}
If valid, corrections should be an empty array. Only flag serious gaps."""

        messages = [
            {"role": "system", "content": "You are a plan reviewer. Respond with valid JSON."},
            {"role": "user", "content": prompt},
        ]
        result = await svc.chat_json(messages, temperature=0.2, schema=_VALIDATION_SCHEMA)

        if isinstance(result, dict):
            is_valid = bool(result.get("valid", True))
            corrections = result.get("corrections", [])
            if not isinstance(corrections, list):
                corrections = [str(corrections)]
            return is_valid, corrections
        return True, []

    except Exception as exc:
        logger.warning("[plan_validator] Ollama validation failed (%s) — auto-approving", exc)
        return True, []
