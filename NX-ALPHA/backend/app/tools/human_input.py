"""
Human-in-the-Loop — MCP tool wrapper.

When the agent is uncertain or needs clarification, this tool requests
human input via AURA's SSE channel. The agent pauses until the user responds.
"""

from __future__ import annotations

import asyncio
import logging
import time

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "human_input",
    "description": (
        "Request human input when the agent needs clarification, approval, or a decision. "
        "The agent pauses and waits for the user to respond via the chat interface. "
        "Use sparingly — only when the agent genuinely cannot proceed without human judgment."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "The question or request for the human"},
            "context":  {"type": "string", "description": "Brief context for why this input is needed"},
            "options":  {"type": "array", "items": {"type": "string"}, "description": "Optional list of choices to present"},
            "timeout":  {"type": "integer", "description": "Max seconds to wait (default 300)", "default": 300},
        },
        "required": ["question"],
    },
}

# In-memory response queue — the chat controller deposits answers here
_pending_requests: dict[str, asyncio.Event] = {}
_responses: dict[str, str] = {}


def submit_human_response(request_id: str, response: str) -> None:
    """Called by the chat controller when the user responds to a human_input request."""
    _responses[request_id] = response
    event = _pending_requests.get(request_id)
    if event:
        event.set()


async def tool_handler(inputs: dict) -> dict:
    question = inputs.get("question", "")
    context  = inputs.get("context", "")
    options  = inputs.get("options", [])
    timeout  = min(inputs.get("timeout", 300), 600)

    if not question:
        return {"error": "question is required"}

    request_id = f"hitl_{int(time.time() * 1000)}"
    event = asyncio.Event()
    _pending_requests[request_id] = event

    # Emit the request to the frontend via SSE
    try:
        from app.controller.chat_controller import _emit
        await _emit("human_input_request", {
            "request_id": request_id,
            "question":   question,
            "context":    context,
            "options":    options,
        })
    except Exception as exc:
        logger.warning("[human_input] SSE emit failed: %s", exc)

    # Wait for response
    try:
        await asyncio.wait_for(event.wait(), timeout=timeout)
        response = _responses.pop(request_id, "")
        _pending_requests.pop(request_id, None)
        return {"response": response, "request_id": request_id, "timed_out": False}
    except asyncio.TimeoutError:
        _pending_requests.pop(request_id, None)
        _responses.pop(request_id, None)
        return {"response": "", "request_id": request_id, "timed_out": True, "error": f"No response within {timeout}s"}
