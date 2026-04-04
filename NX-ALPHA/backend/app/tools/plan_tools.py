"""
Plan mode tools — structured planning checkpoint before execution.

When the model calls enter_plan_mode, it renders a plan as a canvas block
and emits a pending_approval event. This gates further tool execution
until the user explicitly approves via chat.

Single tool exposed:
  enter_plan_mode — present a plan for user approval before proceeding
"""

import logging

logger = logging.getLogger(__name__)


async def enter_plan_mode(title: str, steps: list[str]) -> str:
    """
    Present a structured plan on canvas and request user approval.

    Call this tool BEFORE taking any consequential actions (file writes,
    shell commands, scheduled tasks). Wait for the user to approve in chat
    before calling any tools that execute the plan.

    Parameters
    ----------
    title : str
        Short title for the plan (e.g. 'Refactor auth module').
    steps : list[str]
        Ordered list of planned steps.

    Returns
    -------
    str
        Instruction to wait for user approval.
    """
    if not title:
        return "enter_plan_mode requires a title."
    if not steps:
        return "enter_plan_mode requires at least one step."

    try:
        from app.controller.chat_controller import _emit

        # Build numbered plan content
        numbered = "\n".join(f"{i+1}. {step}" for i, step in enumerate(steps[:20]))
        plan_content = f"**{title}**\n\n{numbered}"

        # Render plan as a document block on canvas
        await _emit("render_canvas", {
            "title": f"Plan: {title}",
            "blocks": [{
                "type": "document",
                "data": {
                    "title": f"Proposed Plan: {title}",
                    "content": plan_content,
                },
            }],
        })

        # Emit pending_approval so the frontend can show an approval prompt
        await _emit("pending_approval", {
            "message": f"AURA wants to proceed with: {title}",
            "plan_title": title,
            "steps": steps,
        })

        logger.info("[plan_tools] plan presented: %s (%d steps)", title, len(steps))
        return (
            "Plan presented on canvas and submitted for user approval. "
            "Do NOT call any further tools until the user explicitly approves. "
            "Wait for the user to confirm before proceeding."
        )

    except Exception as exc:
        logger.warning("[plan_tools] enter_plan_mode failed: %s", exc)
        return f"enter_plan_mode failed: {exc}"


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "enter_plan_mode",
    "description": "Present a structured plan on canvas and request user approval before executing consequential actions.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Short title describing the plan"},
            "steps": {"type": "array", "items": {"type": "string"}, "description": "Ordered list of steps"},
        },
        "required": ["title", "steps"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    return await enter_plan_mode(
        title=inputs.get("title", ""),
        steps=inputs.get("steps", []),
    )
