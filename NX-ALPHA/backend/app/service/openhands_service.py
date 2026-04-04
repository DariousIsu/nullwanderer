"""
AURA NX-Alpha — OpenHands Service (STUB)

TODO: Implement once openhands-ai package is confirmed installed and API is verified.

INSTALL (attempt):
    pip install openhands-ai

VERIFY the correct import path after install:
    python -c "import openhands; print(openhands.__file__)"

Then read the installed package API — the call signature in run_agent_headless
(or its equivalent) may differ from what's sketched here. Update this file
before putting it in any active code path.

Until then, all calls return a clear stub error string.
"""

import logging

logger = logging.getLogger(__name__)


async def run_task(task: str, working_dir: str = "/tmp") -> str:
    """
    Execute a coding/automation task via OpenHands with local Ollama as the LLM.

    TODO: Implement. Steps:
      1. pip install openhands-ai
      2. Verify: python -c "import openhands; print(dir(openhands))"
      3. Find the correct async entry point (was run_agent_headless in some versions)
      4. Configure to use local Ollama (no cloud keys)
      5. Replace the raise below with the real implementation
    """
    raise NotImplementedError(
        "[openhands] Service not yet implemented. "
        "Install openhands-ai, verify the API, then update openhands_service.py."
    )
