"""
Sleep tool — async delay for KAIROS tick pacing and rate limiting.
"""

import asyncio
import logging

logger = logging.getLogger(__name__)

_MAX_SLEEP_SECONDS = 300  # hard cap at 5 minutes


async def sleep(seconds: float) -> str:
    """
    Pause execution for the given number of seconds.

    Parameters
    ----------
    seconds : float
        Duration to sleep. Capped at 300 seconds.

    Returns
    -------
    str
        Confirmation message.
    """
    secs = min(float(seconds), _MAX_SLEEP_SECONDS)
    if secs <= 0:
        return "Sleep skipped (0 or negative duration)."
    logger.debug("[sleep_tool] sleeping %.1fs", secs)
    await asyncio.sleep(secs)
    return f"Slept for {secs:.1f} seconds."


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "sleep",
    "description": "Pause execution for a given number of seconds (max 300).",
    "inputSchema": {
        "type": "object",
        "properties": {
            "seconds": {"type": "number", "description": "Duration to sleep"},
        },
        "required": ["seconds"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    return await sleep(float(inputs.get("seconds", 1)))
