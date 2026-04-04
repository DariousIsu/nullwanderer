"""
AURA NX-Alpha — Change Planner
Uses the workhorse model to generate concrete file-level change plans.

Called by self_improvement_service.py after relevant files have been read.

OUTPUT FORMAT:
    {
        "tier": "cosmetic" | "correction",
        "summary": "one-line description of the change",
        "changes": [
            {
                "path": "relative/path/from/project/root",
                "operation": "modify" | "create",
                "old_snippet": "exact text to replace (modify only)",
                "new_snippet": "replacement text",
                "explanation": "why this change fixes the problem"
            }
        ],
        "test_scope": "tests/test_foo.py or null",
        "risk": "low" | "medium" | "high"
    }

COSMETIC MOCKUP FORMAT (canvas preview):
    {
        "mockup_html": "<full standalone HTML with embedded CSS>",
        "description": "what changed visually"
    }
"""

from __future__ import annotations

import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Maximum chars of file content to send per file (keep prompt manageable)
_MAX_FILE_CHARS = 6_000
_MAX_FILES      = 4


# ─────────────────────────────────────────────────────────────────────────────
# PLANNER
# ─────────────────────────────────────────────────────────────────────────────

async def plan_correction(
    description: str,
    file_contents: dict[str, str],   # {rel_path: content}
    tier: str = "correction",
) -> dict:
    """
    Ask the workhorse to generate a precise change plan.

    Args:
        description:    What the user wants changed or fixed.
        file_contents:  Dict of {relative_path: file_content} for relevant files.
        tier:           "cosmetic" or "correction"

    Returns:
        Parsed plan dict. Returns a safe error dict if the model call fails.
    """
    from app.service.ollama_service import get_ollama_service

    ollama = get_ollama_service()
    if ollama is None:
        return {"error": "Workhorse model not available", "changes": []}

    # Build file context block
    file_blocks: list[str] = []
    for path, content in list(file_contents.items())[:_MAX_FILES]:
        trimmed = content[:_MAX_FILE_CHARS]
        if len(content) > _MAX_FILE_CHARS:
            trimmed += f"\n... (truncated, {len(content) - _MAX_FILE_CHARS} chars omitted)"
        file_blocks.append(f"=== {path} ===\n{trimmed}")
    files_text = "\n\n".join(file_blocks)

    if tier == "cosmetic":
        prompt = _cosmetic_prompt(description, files_text)
    else:
        prompt = _correction_prompt(description, files_text)

    result = await ollama.chat_json(
        messages=[{"role": "user", "content": prompt}],
        temperature=0.1,
    )

    if not result:
        return {"error": "Model returned empty response", "changes": []}

    # Normalise — ensure required keys exist
    result.setdefault("tier", tier)
    result.setdefault("summary", description[:100])
    result.setdefault("changes", [])
    result.setdefault("risk", "low")
    result.setdefault("test_scope", None)

    logger.info(
        "[change_planner] Plan generated: tier=%s changes=%d risk=%s",
        result["tier"], len(result["changes"]), result["risk"],
    )
    return result


async def plan_cosmetic_mockup(
    description: str,
    current_html_or_css: str,
) -> dict:
    """
    Generate a standalone HTML mockup for canvas preview.
    Used in the iterative cosmetic design loop before any code is touched.

    Returns:
        {"mockup_html": "<html...>", "description": "..."}
    """
    from app.service.ollama_service import get_ollama_service

    ollama = get_ollama_service()
    if ollama is None:
        return {"error": "Workhorse model not available", "mockup_html": ""}

    prompt = f"""You are designing a UI mockup for a dark-themed AI workspace application.

The user wants: {description}

Current relevant styles/component:
{current_html_or_css[:3000]}

Generate a standalone HTML file that previews what the requested change would look like.
Requirements:
- Self-contained: all CSS embedded in <style> tags, no external imports
- Dark theme (background: #04080F or similar deep dark)
- Show just the relevant UI element or section being changed
- Make it look like the AURA interface: monospace fonts, terminal aesthetic, subtle glows

Respond with a JSON object containing:
- "mockup_html": the complete standalone HTML string
- "description": one sentence describing what changed visually"""

    result = await ollama.chat_json(
        messages=[{"role": "user", "content": prompt}],
        temperature=0.4,
    )
    result.setdefault("mockup_html", "")
    result.setdefault("description", description)
    return result


# ─────────────────────────────────────────────────────────────────────────────
# PROMPTS
# ─────────────────────────────────────────────────────────────────────────────

def _correction_prompt(description: str, files_text: str) -> str:
    return f"""You are a senior engineer maintaining the AURA NX-Alpha codebase (Python/FastAPI backend, React/TypeScript frontend).

The user or system has identified a problem or desired improvement:
"{description}"

Relevant files:
{files_text}

Generate a precise change plan as a JSON object with these keys:

- "tier": "correction"
- "summary": one-line description of the change (max 80 chars)
- "changes": array of change objects, each with:
    - "path": relative file path from project root (e.g. "backend/app/knowledge/local_search.py")
    - "operation": "modify" or "create"
    - "old_snippet": the EXACT text to be replaced (for modify operations — must match verbatim)
    - "new_snippet": the replacement text
    - "explanation": why this change fixes the problem
- "test_scope": relative path to the most relevant test file, or null if none exists
- "risk": "low", "medium", or "high"

Rules:
- old_snippet must be an exact substring of the file content shown above
- Keep changes minimal — only touch what is necessary
- Do not add imports unless required by your change
- Do not reformat or rename anything unrelated to the fix
- Respond with only the JSON object"""


def _cosmetic_prompt(description: str, files_text: str) -> str:
    return f"""You are a senior frontend engineer maintaining the AURA NX-Alpha codebase (React/TypeScript, Tailwind CSS).

The user wants a visual/style change:
"{description}"

Relevant files:
{files_text}

Generate a precise change plan as a JSON object with these keys:

- "tier": "cosmetic"
- "summary": one-line description of the visual change (max 80 chars)
- "changes": array of change objects, each with:
    - "path": relative file path from project root
    - "operation": "modify" or "create"
    - "old_snippet": the EXACT text to be replaced (must match verbatim)
    - "new_snippet": the replacement text
    - "explanation": what this changes visually
- "test_scope": null (cosmetic changes don't require test runs)
- "risk": "low"

Rules:
- Only touch CSS classes, style values, color tokens, Tailwind classes, or asset references
- Do not touch logic, state, or event handlers
- old_snippet must be an exact substring of the file content shown
- Respond with only the JSON object"""
