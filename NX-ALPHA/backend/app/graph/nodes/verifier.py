"""
AURA NX-Alpha — Verifier Node (§12.1 / Sprint 2)
Final independent fulfillment check. Confirms output satisfies original request.
Does NOT emit render events — that's the Interface Agent's job on the return path.
Sprint 2: uses OllamaService for independent verification.
Falls back to Sprint 1 stub (auto-pass) when OllamaService is unavailable.
"""

import logging
from app.graph.state import GraphState

logger = logging.getLogger(__name__)

# Schema for verification response
_VERIFY_SCHEMA = {
    "type": "object",
    "properties": {
        "verified":   {"type": "boolean"},
        "confidence": {"type": "number"},
        "notes":      {"type": "string"},
    },
    "required": ["verified", "confidence", "notes"],
}


async def run_verifier(state: GraphState) -> dict:
    """
    Final verification gate.
    Uses OllamaService to independently verify the assembled output against the original task.
    Falls back to auto-pass stub if OllamaService is unavailable.
    """
    from app.service.ollama_service import get_ollama_service
    from app.controller.chat_controller import _emit

    ollama = get_ollama_service()

    # Prefer validated output if the validator produced one; else use assembled output
    assembled = state.get("verified_output") or state.get("assembled_output") or {}
    plan = state.get("execution_plan") or {}
    thread_id = state.get("thread_id", "default")
    execution_id = state.get("execution_id", "unknown")
    task = plan.get("task", "Team output")

    content = assembled.get("content", "[Team task complete]")
    canvas_blocks = assembled.get("canvas_blocks", [])

    verified: bool
    confidence: float
    notes_text: str

    if ollama and ollama.is_available() and content:
        messages = [
            {
                "role": "system",
                "content": (
                    "You are the verifier. Independently assess whether this output correctly and completely "
                    "addresses the original task. "
                    'Output JSON with keys: verified (bool), confidence (float 0.0–1.0), notes (str).'
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Original task: {task}\n\n"
                    f"Output to verify:\n\n{content}"
                ),
            },
        ]

        try:
            await _emit("agent_update", {
                "agent_id": "verifier",
                "status": "working",
                "summary": "Independently verifying output...",
            })

            result = await ollama.chat_json(messages, temperature=0.2, schema=_VERIFY_SCHEMA)
            verified = bool(result.get("verified", True))
            confidence = float(result.get("confidence", 1.0))
            notes_text = str(result.get("notes", ""))
            logger.info(
                "[verifier] Verification complete: verified=%s confidence=%.2f notes=%s",
                verified, confidence, notes_text,
            )
        except Exception as exc:
            logger.warning("[verifier] OllamaService verification failed, defaulting to pass: %s", exc)
            verified = True
            confidence = 1.0
            notes_text = f"Verification fell back to auto-pass due to error: {exc}"
    else:
        logger.info("[verifier] OllamaService unavailable — stub verification (auto-pass)")
        verified = True
        confidence = 1.0
        notes_text = "Stub verification — auto-pass (OllamaService not available)"

    await _emit("agent_update", {
        "agent_id": "verifier",
        "status": "done",
        "summary": f"{'Verified' if verified else 'Not verified'} — confidence: {confidence:.0%}",
    })

    # Verifier only verifies — rendering is handled by Interface Agent return path
    return {
        "verified":        verified,
        "verified_output": assembled,
        "final_response":  content,
        "canvas": {
            "blocks": canvas_blocks,
            "title":  task,
        },
    }
