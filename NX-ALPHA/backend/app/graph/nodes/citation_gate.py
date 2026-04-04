"""
AURA NX-Alpha — Citation Gate Node
Adversarial citation check between area_agent and assembler.

Rules:
  - 3 attempt limit per area
  - On fail (attempt < 3): corrections returned to area_agent for full re-run
  - On fail (3rd attempt): flagged as pass_with_caveats, passes to assembler
  - Source content: LightRAG-first (warm from sprint research), HTTP fallback

The gate resets citation_gate_attempts to 0 when an area clears or hits max retries,
so each new area starts fresh.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def _emit(event_type: str, data: dict) -> None:
    """Emit SSE event through AURA's chat controller. Non-fatal if unavailable."""
    try:
        from app.controller.chat_controller import _emit as _aura_emit
        await _aura_emit(event_type, data)
    except Exception:
        pass


async def run_citation_gate(state: dict) -> dict:
    """
    Gate node: verify citations in the current area review before it advances
    to the assembler or triggers the next area agent.

    State reads:
        current_area_review         — AreaReview with sprint_results
        citation_gate_attempts      — attempt counter for current area
        citation_gate_caveats       — accumulated caveats across all areas

    State writes:
        citation_gate_attempts      — incremented on fail, reset to 0 on pass/max
        citation_gate_corrections   — None on pass, dict on fail (< 3 attempts)
        citation_gate_caveats       — extended with any 3rd-attempt failures
    """
    from app.tools.citation_verifier import verify_section

    area_review: dict[str, Any] | None = state.get("current_area_review")
    if not area_review:
        # No area content to check — pass through silently
        logger.debug("[citation_gate] No current_area_review — passing through")
        return {}

    area_id  = area_review.get("area_id", "unknown")
    attempts = state.get("citation_gate_attempts", 0) + 1
    caveats  = list(state.get("citation_gate_caveats") or [])

    # Compile section text from all sprint results in this area
    section_text = "\n\n".join(
        r.get("content", "") for r in area_review.get("sprint_results", [])
    )

    if not section_text.strip():
        # Nothing to verify — pass through
        logger.debug("[citation_gate] %s has no content — passing through", area_id)
        return {
            "citation_gate_attempts":    0,
            "citation_gate_corrections": None,
            "citation_gate_caveats":     caveats,
        }

    await _emit("agent_update", {
        "agent_id": "citation_gate",
        "status":   "working",
        "summary":  f"Checking citations for {area_id} (attempt {attempts}/3)…",
    })

    try:
        report = await verify_section(section_text, area_id)
    except Exception as exc:
        logger.error("[citation_gate] verify_section failed for %s: %s", area_id, exc)
        # Non-fatal — pass through on error rather than blocking pipeline
        await _emit("agent_update", {
            "agent_id": "citation_gate",
            "status":   "done",
            "summary":  f"{area_id}: citation check failed ({exc}) — passing through.",
        })
        return {
            "citation_gate_attempts":    0,
            "citation_gate_corrections": None,
            "citation_gate_caveats":     caveats,
        }

    # Determine which citations failed — exclude ref_only (no claim context to fix)
    failed = [
        c for c in report.citations
        if c.status in ("hallucinated", "uncertain")
        and getattr(c, "claim_source", "body") != "ref_only"
    ]

    if not failed:
        # All citations cleared
        await _emit("agent_update", {
            "agent_id": "citation_gate",
            "status":   "done",
            "summary":  (
                f"{area_id}: {len(report.citations)} citations passed"
                + (f" (attempt {attempts})" if attempts > 1 else "") + "."
            ),
        })
        logger.info("[citation_gate] %s PASSED — %d citations OK (attempt %d)",
                    area_id, len(report.citations), attempts)
        return {
            "citation_gate_attempts":    0,   # reset for next area
            "citation_gate_corrections": None,
            "citation_gate_caveats":     caveats,
        }

    if attempts >= 3:
        # Max retries reached — flag as caveats and pass through to assembler
        new_caveats = [
            f"[{area_id}] Citation #{c.index} unresolved ({c.status}): {c.claim[:120]}"
            for c in failed
        ]
        await _emit("agent_update", {
            "agent_id": "citation_gate",
            "status":   "done",
            "summary":  (
                f"{area_id}: {len(failed)} citation(s) flagged as caveats "
                "after 3 attempts — passing to assembler."
            ),
        })
        logger.warning("[citation_gate] %s: %d citations unresolved after 3 attempts — caveats",
                       area_id, len(failed))
        return {
            "citation_gate_attempts":    0,           # reset for next area
            "citation_gate_corrections": None,        # no corrections — passing through
            "citation_gate_caveats":     caveats + new_caveats,
        }

    # Build correction instructions for area agent full re-run
    corrections: dict[int, dict] = {}
    for c in failed:
        suggested = ""
        if c.llm_note:
            suggested = f"Source says: {c.llm_note}"
        elif c.matched_passage:
            suggested = f"Closest source passage: {c.matched_passage[:200]}"
        corrections[c.index] = {
            "claim":         c.claim[:300],
            "issue":         f"Citation {c.status} (score {c.match_score:.2f})",
            "suggested_fix": suggested or "Verify source directly and revise the claim.",
        }

    await _emit("agent_update", {
        "agent_id": "citation_gate",
        "status":   "working",
        "summary":  (
            f"{area_id}: {len(failed)} citation(s) need correction — "
            f"re-running area (attempt {attempts}/3)."
        ),
    })
    logger.info("[citation_gate] %s FAIL — %d corrections needed (attempt %d/3)",
                area_id, len(failed), attempts)
    return {
        "citation_gate_attempts":    attempts,
        "citation_gate_corrections": corrections,
        "citation_gate_caveats":     caveats,
    }
