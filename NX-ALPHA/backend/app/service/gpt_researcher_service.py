"""
AURA NX-Alpha — GPT Researcher Service

Deep research via gpt-researcher, routed through local Ollama (no cloud LLMs).

REQUIRED .env vars:
    OPENAI_BASE_URL=http://localhost:11434/v1   # Ollama OpenAI-compat endpoint
    OPENAI_API_KEY=ollama                       # Any non-empty value satisfies gpt-researcher
    LLM_PROVIDER=ollama
    LLM_MODEL=<workhorse_model_name>
    FAST_LLM=ollama/<workhorse_model_name>

INSTALL:
    pip install gpt-researcher

NOTE: gpt-researcher defaults to OpenAI. The OPENAI_BASE_URL env var redirects
it to your local Ollama instance. If the vars above are not set, calls will
raise RuntimeError at call time (not at import time).
"""

import logging
import os

logger = logging.getLogger(__name__)


def _check_env() -> None:
    """Raise RuntimeError with clear instructions if required env vars are missing."""
    base_url = os.environ.get("OPENAI_BASE_URL", "")
    api_key  = os.environ.get("OPENAI_API_KEY", "")
    if not base_url or not api_key:
        raise RuntimeError(
            "[gpt_researcher] OPENAI_BASE_URL and OPENAI_API_KEY must be set in .env "
            "to route gpt-researcher through local Ollama. "
            "Example:\n"
            "  OPENAI_BASE_URL=http://localhost:11434/v1\n"
            "  OPENAI_API_KEY=ollama\n"
            "  LLM_PROVIDER=ollama\n"
            "  LLM_MODEL=<your_workhorse_model>"
        )


async def research(query: str, report_type: str = "research_report") -> str:
    """
    Run a deep research query via GPT Researcher using the local Ollama backend.

    Args:
        query:       The research question or topic.
        report_type: 'research_report' | 'outline_report' | 'resource_report'

    Returns:
        A markdown research report string.
    """
    _check_env()
    try:
        from gpt_researcher import GPTResearcher

        researcher = GPTResearcher(query=query, report_type=report_type)
        await researcher.conduct_research()
        report = await researcher.write_report()
        return report
    except RuntimeError:
        raise
    except Exception as exc:
        logger.error("[gpt_researcher] Research failed for query %r: %s", query, exc)
        return f"[Research failed: {exc}]"
