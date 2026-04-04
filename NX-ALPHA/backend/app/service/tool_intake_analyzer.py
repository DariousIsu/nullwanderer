"""
AURA NX-Alpha — Tool Intake Analyzer

Converts a plain-English tool description into a structured MCPToolDef draft
plus clarifying questions, using a single Workhorse (DeepSeek) call.

FLOW:
    POST /mcp-tools/draft        → analyze(description) → {draft_id, draft, questions}
    POST /mcp-tools/draft/confirm → confirm(draft_id, answers) → MCPToolDef

Draft storage: in-memory dict, TTL 30 minutes (evict on access).
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from pathlib import Path
from typing import Optional

from app.service.mcp_tool_store import MCPToolDef, get_mcp_tool_store, slugify, unique_slug

logger = logging.getLogger(__name__)

_DRAFT_TTL = 30 * 60   # 30 minutes
_CATALOG_PATH = Path.home() / ".aura" / "training" / "dataset_catalog.json"

# In-memory draft storage: draft_id → {draft: MCPToolDef, questions: list, expires_at: float}
_drafts: dict[str, dict] = {}


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _load_catalog_categories() -> list[str]:
    """Return tier/category names from dataset_catalog.json, or [] if absent."""
    try:
        if _CATALOG_PATH.exists():
            data = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
            return list(data.get("categories", {}).keys())
    except Exception:
        pass
    return []


def _evict_expired() -> None:
    now = time.time()
    expired = [k for k, v in _drafts.items() if v["expires_at"] < now]
    for k in expired:
        del _drafts[k]


def _get_ollama():
    try:
        from app.service.ollama_service import get_ollama_service
        return get_ollama_service()
    except Exception:
        return None


_DRAFT_SCHEMA = {
    "type": "object",
    "properties": {
        "id":                 {"type": "string"},
        "name":               {"type": "string"},
        "description":        {"type": "string"},
        "input_schema":       {"type": "object"},
        "output_description": {"type": "string"},
        "target_users":       {"type": "string"},
        "complexity":         {"type": "string", "enum": ["low", "medium", "high"]},
        "categories":         {"type": "array", "items": {"type": "string"}},
        "base_prompt":        {"type": "string"},
        "questions": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id":      {"type": "string"},
                    "text":    {"type": "string"},
                    "type":    {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["id", "text", "type"],
            },
        },
    },
    "required": ["name", "description", "input_schema", "questions"],
}


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC API
# ─────────────────────────────────────────────────────────────────────────────

async def analyze(description: str) -> dict:
    """
    Analyze a plain-English tool description.
    Returns {draft_id, draft, questions}.
    Draft stored in memory with 30-min TTL.
    """
    _evict_expired()

    ollama = _get_ollama()
    if ollama is None:
        raise RuntimeError("Workhorse (Ollama) unavailable")

    available_categories = _load_catalog_categories()
    category_hint = (
        f"\nAvailable dataset categories: {json.dumps(available_categories)}. "
        "Use these for the 'categories' field where applicable."
        if available_categories else ""
    )

    system_prompt = (
        "You are an expert MCP tool designer. Analyze the user's tool request and produce "
        "a structured specification plus clarifying questions in a single JSON response.\n\n"
        "Return JSON with these top-level fields:\n"
        "  name: str — concise tool name (Title Case)\n"
        "  id: str — kebab-case slug auto-generated from name\n"
        "  description: str — one paragraph describing what the tool does\n"
        "  input_schema: object — JSON Schema (type='object', properties, required array)\n"
        "  output_description: str — what the tool returns\n"
        "  target_users: str — who this tool is for\n"
        "  complexity: 'low'|'medium'|'high'\n"
        "  categories: array of domain/tier strings" + category_hint + "\n"
        "  base_prompt: str — a system prompt that would guide an LLM to use this tool correctly\n"
        "  questions: array of 2-4 clarifying questions, each with:\n"
        "    id: str, text: str, type: 'free_text'|'multiple_choice'|'multi_select'|'boolean'\n"
        "    options: array of strings (required for multiple_choice and multi_select)\n\n"
        "The input_schema must be valid JSON Schema Draft 7. "
        "Keep the base_prompt focused on output format and quality expectations."
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Tool request: {description}"},
    ]

    try:
        result = await ollama.chat_json(messages, temperature=0.4, schema=_DRAFT_SCHEMA, timeout=45)
    except Exception as exc:
        raise RuntimeError(f"Analysis timed out — try a shorter description or simplify the tool request: {exc}")

    # Validate and fix input_schema
    raw_schema = result.get("input_schema", {})
    if not isinstance(raw_schema, dict) or raw_schema.get("type") != "object":
        raw_schema = {"type": "object", "properties": {}, "required": []}

    try:
        import jsonschema
        jsonschema.Draft7Validator.check_schema(raw_schema)
    except Exception as e:
        logger.warning("[tool_intake] input_schema invalid, using empty schema: %s", e)
        raw_schema = {"type": "object", "properties": {}, "required": []}

    # Build slug — unique within existing tools
    existing_ids = get_mcp_tool_store().existing_ids()
    name = result.get("name", "Unnamed Tool")
    base_slug = slugify(name)
    tool_id = unique_slug(base_slug, existing_ids)

    draft = MCPToolDef(
        id=tool_id,
        name=name,
        description=result.get("description", ""),
        input_schema=raw_schema,
        output_description=result.get("output_description", ""),
        target_users=result.get("target_users", ""),
        complexity=result.get("complexity", "medium"),
        categories=result.get("categories", []),
        base_prompt=result.get("base_prompt", ""),
    )

    questions = result.get("questions", [])

    draft_id = str(uuid.uuid4())
    _drafts[draft_id] = {
        "draft":      draft,
        "questions":  questions,
        "expires_at": time.time() + _DRAFT_TTL,
    }

    return {
        "draft_id":  draft_id,
        "draft":     draft.model_dump(),
        "questions": questions,
    }


async def confirm(draft_id: str, answers: dict) -> MCPToolDef:
    """
    Merge answers into draft and produce a confirmed MCPToolDef.
    If answers is empty, returns draft unchanged.
    """
    _evict_expired()

    entry = _drafts.get(draft_id)
    if not entry:
        raise KeyError(f"Draft '{draft_id}' not found or expired")
    if entry["expires_at"] < time.time():
        del _drafts[draft_id]
        raise KeyError(f"Draft '{draft_id}' expired")

    draft: MCPToolDef = entry["draft"]
    questions: list = entry["questions"]

    if not answers:
        del _drafts[draft_id]
        return draft

    ollama = _get_ollama()
    if ollama is None:
        del _drafts[draft_id]
        return draft

    qa_text = "\n".join(
        f"Q: {q['text']}\nA: {answers.get(q['id'], '[skipped]')}"
        for q in questions
    )

    messages = [
        {
            "role": "system",
            "content": (
                "You are refining an MCP tool specification based on user answers to clarifying questions. "
                "Return an updated JSON spec with the same fields as the draft. "
                "Only change fields that the answers meaningfully affect. "
                "Return ONLY valid JSON."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Draft spec:\n{json.dumps(draft.model_dump(), indent=2)}\n\n"
                f"User answers:\n{qa_text}\n\n"
                "Return the updated spec as JSON."
            ),
        },
    ]

    try:
        result = await ollama.chat_json(messages, temperature=0.3, timeout=45)
        # Validate updated input_schema
        raw_schema = result.get("input_schema", draft.input_schema)
        try:
            import jsonschema
            jsonschema.Draft7Validator.check_schema(raw_schema)
        except Exception:
            raw_schema = draft.input_schema

        confirmed = draft.model_copy(update={
            "name":               result.get("name", draft.name),
            "description":        result.get("description", draft.description),
            "input_schema":       raw_schema,
            "output_description": result.get("output_description", draft.output_description),
            "target_users":       result.get("target_users", draft.target_users),
            "complexity":         result.get("complexity", draft.complexity),
            "categories":         result.get("categories", draft.categories),
            "base_prompt":        result.get("base_prompt", draft.base_prompt),
        })
    except Exception as exc:
        logger.warning("[tool_intake] confirm call failed, returning draft unchanged: %s", exc)
        confirmed = draft

    del _drafts[draft_id]
    return confirmed
