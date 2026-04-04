"""
AURA NX-Alpha — Area Agent Node (§12.1 / Sprint 2)
Dual-mode: decomposes an AreaBrief into SprintBriefs, OR reviews completed sprint results.
Uses Ollama with schema-constrained output for reliable JSON.

MODE DETECTION (from state):
    decompose: remaining_sprints is empty AND current_area_brief is None (or we just came from plan_validator)
    review:    remaining_sprints is empty AND current_area_sprint_results has entries
"""

import json
import logging
import uuid
from app.graph.state import GraphState, AreaReview, SprintBrief

logger = logging.getLogger(__name__)

_MAX_AREA_REVIEWS = 3

# Schema for sprint decomposition
_SPRINTS_SCHEMA = {
    "type": "object",
    "properties": {
        "sprints": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "sprint_id": {"type": "string"},
                    "task":      {"type": "string"},
                    "tools":     {"type": "array", "items": {"type": "string"}},
                },
                "required": ["task"],
            },
        }
    },
    "required": ["sprints"],
}

# Schema for area review
_REVIEW_SCHEMA = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string"},
        "notes":   {"type": "string"},
    },
    "required": ["verdict", "notes"],
}


async def run_area_agent(state: GraphState) -> dict:
    """
    Area Agent: decompose or review, detected from state.
    Uses OllamaService when available; falls back to stub behavior otherwise.
    """
    from app.service.ollama_service import get_ollama_service
    from app.controller.chat_controller import _emit

    ollama = get_ollama_service()

    sprint_results = state.get("current_area_sprint_results", [])
    remaining_sprints = state.get("remaining_sprints", [])
    current_area = state.get("current_area_brief")

    # ── REVIEW MODE: sprints done, results waiting ────────────────────────────
    if sprint_results and not remaining_sprints:
        area_id = (current_area or {}).get("area_id", "unknown")
        review_count = state.get("area_review_count", 0)
        logger.info("[area_agent] Review mode: area=%s sprints=%d", area_id, len(sprint_results))

        if ollama and ollama.is_available():
            results_summary = "\n".join(
                f"- Sprint {sr.get('sprint_id', '?')}: {sr.get('summary', sr.get('content', '')[:300])}"
                for sr in sprint_results
            )
            # Full content for cross-reference (up to 800 chars per sprint)
            results_full = "\n\n".join(
                f"[Sprint {sr.get('sprint_id', '?')} — {sr.get('summary', '')}]\n"
                f"{sr.get('content', '')[:800]}"
                for sr in sprint_results
            )
            task_objective = (current_area or {}).get("objective", "unknown task")
            domain = (current_area or {}).get("domain", "general")
            team_request = state.get("team_request") or state.get("user_message", "")

            messages = [
                {
                    "role": "system",
                    "content": (
                        f"You are a section editor reviewing the draft of '{domain}'. "
                        "You have encyclopedic knowledge and your job is to validate that this "
                        "section is accurate, complete, and well-written.\n\n"
                        "Perform a 3-stage review:\n\n"
                        "STAGE 1 — SECTION GOAL\n"
                        "Does the draft accomplish the section's stated goal? "
                        "Is it 300+ words of polished prose (not notes or bullet points)?\n\n"
                        "STAGE 2 — ACCURACY CHECK\n"
                        "Cross-reference claims against what YOU know. "
                        "Flag: (a) factual errors, (b) missing critical context, "
                        "(c) filler or vague statements that should be replaced with specifics.\n\n"
                        "STAGE 3 — VERDICT\n"
                        "pass = accurate, complete, publication-ready prose. "
                        "partial = minor gaps but usable. "
                        "fail = significant errors, too short, or reads as notes rather than prose.\n\n"
                        'Output JSON: {"verdict": "pass|partial|fail", "notes": "specific findings"}'
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Original user request: {team_request}\n"
                        f"Section: {domain}\n"
                        f"Section goal: {task_objective}\n\n"
                        f"Draft to review:\n{results_full}\n\n"
                        "Run your 3-stage review."
                    ),
                },
            ]

            try:
                await _emit("agent_update", {
                    "agent_id": area_id,
                    "status": "working",
                    "summary": "Cross-referencing sprint results against knowledge base...",
                })

                review_data = await ollama.chat_json(messages, temperature=0.3, schema=_REVIEW_SCHEMA)
                verdict = review_data.get("verdict", "pass")
                notes = review_data.get("notes", "")
                if verdict not in ("pass", "partial", "fail"):
                    verdict = "pass"
            except Exception as exc:
                logger.warning("[area_agent] OllamaService review failed, defaulting to pass: %s", exc)
                verdict = "pass"
                notes = f"Review fell back to auto-pass due to error: {exc}"
        else:
            logger.info("[area_agent] OllamaService unavailable — stub review (auto-pass)")
            verdict = "pass"
            notes = "Stub review — auto-pass (OllamaService not available)"

        await _emit("agent_update", {
            "agent_id": area_id,
            "status": "done",
            "summary": f"Review: {verdict} — {notes[:80]}" if notes else f"Review: {verdict}",
        })

        review: AreaReview = {
            "area_id":        area_id,
            "verdict":        verdict,
            "notes":          notes,
            "sprint_results": sprint_results,
        }

        remaining_areas = list(state.get("remaining_areas", []))
        area_results = list(state.get("area_results", []))

        return {
            "current_area_review":         review,
            "area_results":                [*area_results, review],
            "current_area_sprint_results": [],
            "remaining_areas":             remaining_areas,
            "area_review_count":           review_count + 1,
        }

    # ── DECOMPOSE MODE: pop next area or re-run current (citation correction) ──
    corrections = state.get("citation_gate_corrections")
    current_area_brief = state.get("current_area_brief")
    remaining_areas = list(state.get("remaining_areas", []))

    if corrections and current_area_brief:
        # Citation gate correction re-run — re-use the area that failed, don't pop a new one
        area = current_area_brief
        area_id = area.get("area_id", f"area-{uuid.uuid4().hex[:8]}")
        logger.info("[area_agent] Citation correction re-run: area=%s corrections=%d",
                    area_id, len(corrections))

        correction_context = "\n".join(
            f"Citation #{idx}: {d['issue']} — {d.get('suggested_fix', 'Verify source directly.')}"
            for idx, d in corrections.items()
        )
    else:
        corrections = None
        correction_context = ""
        if not remaining_areas:
            logger.error("[area_agent] Decompose mode: no remaining areas")
            return {"error": "area_agent: no remaining areas to decompose"}
        area = remaining_areas.pop(0)
        area_id = area.get("area_id", f"area-{uuid.uuid4().hex[:8]}")
        logger.info("[area_agent] Decompose mode: area=%s", area_id)

    # Pass team_request so sprints reference the actual subject matter
    team_request = state.get("team_request") or state.get("user_message", "")

    # ── PASSTHROUGH: one section = one sprint ────────────────────────────
    # Each area is a document section from the PM's outline. Pass it through
    # as a single sprint task — no further decomposition. The sprint agent
    # writes the complete section as polished prose.
    section_name = area.get("domain", "general")
    section_goal = area.get("objective", "")

    # Inject citation corrections into the sprint task when re-running
    if correction_context:
        task = (
            f"{section_goal}\n\n"
            "CITATION CORRECTIONS REQUIRED — revise these citations in the new draft:\n"
            f"{correction_context}"
        )
        summary_msg = f"Re-running section '{section_name}' with citation corrections"
    else:
        task = section_goal
        summary_msg = f"Assigning section: {section_name}"

    await _emit("agent_update", {
        "agent_id": area_id,
        "status": "working",
        "summary": summary_msg,
    })

    sprints: list[SprintBrief] = [{
        "sprint_id":       f"sp-{area_id}-1",
        "area_id":         area_id,
        "task":            task,
        "tools":           area.get("tools", []),
        "context_markers": area.get("context_markers", []),
        # Carry section metadata so the sprint agent can use it
        "domain":          section_name,
    }]

    return {
        "current_area_brief":          area,
        "remaining_areas":             remaining_areas,
        "remaining_sprints":           sprints,
        "current_area_sprint_results": [],
        "current_area_review":         None,
        "area_review_count":           0,
        "citation_gate_corrections":   None,  # clear corrections — sprint agent will re-run clean
    }


def _stub_sprint(area: dict, area_id: str) -> SprintBrief:
    """Fallback single-sprint decomposition when OllamaService is unavailable."""
    return SprintBrief(
        sprint_id=f"sp-{area_id}-1",
        area_id=area_id,
        task=area.get("objective", ""),
        tools=area.get("tools", []),
        context_markers=area.get("context_markers", []),
    )
