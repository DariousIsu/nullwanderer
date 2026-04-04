"""
Agent Creator Controller — REST API for building and managing custom agents.

Route ordering matters: static paths (/tools, /skills, /templates, /mcp/...)
must be registered before the parameterized /{id} routes so FastAPI doesn't
swallow them as agent IDs.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import StreamingResponse

from app.models.agent_definition import AgentDefinition
from app.service.custom_agent_store import get_custom_agent_store

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/agents/custom", tags=["agent-creator"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─────────────────────────────────────────────────────────────────────────────
# STATIC ROUTES  (must come before /{id})
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/tools")
async def list_tool_types() -> list[dict]:
    """
    Return all available node types with their configurable data schemas.
    Used by the Agent Creator canvas to populate node property panels.
    """
    return [
        {
            "type": "trigger",
            "label": "Trigger",
            "description": "Entry point for the agent. Receives the initial inputs.",
            "data_schema": {},
        },
        {
            "type": "llm",
            "label": "LLM",
            "description": "Call the local Ollama workhorse model.",
            "data_schema": {
                "system_prompt": {"type": "string", "default": ""},
                "input_key":     {"type": "string", "default": "input"},
                "output_key":    {"type": "string", "default": "output"},
            },
        },
        {
            "type": "tool",
            "label": "Tool",
            "description": "Dispatch to a named tool (web_scrape, legislation_search, gpt_researcher).",
            "data_schema": {
                "tool_id":    {"type": "string", "enum": ["web_scrape", "legislation_search", "gpt_researcher"]},
                "params":     {"type": "object", "default": {}},
                "output_key": {"type": "string", "default": "tool_output"},
            },
        },
        {
            "type": "condition",
            "label": "Condition",
            "description": "Branch on a state value. True/false edges control which path runs.",
            "data_schema": {
                "input_key": {"type": "string", "default": "input"},
                "operator":  {"type": "string", "enum": ["truthy", "equals", "gt", "lt", "contains"], "default": "truthy"},
                "value":     {"type": "any", "default": None},
            },
        },
        {
            "type": "memory_read",
            "label": "Memory Read",
            "description": "Retrieve context from AURA's hybrid memory store.",
            "data_schema": {
                "query_key":  {"type": "string", "default": "input"},
                "output_key": {"type": "string", "default": "memory_results"},
                "limit":      {"type": "integer", "default": 5},
            },
        },
        {
            "type": "memory_write",
            "label": "Memory Write",
            "description": "Save a value from state into AURA's memory store.",
            "data_schema": {
                "input_key": {"type": "string", "default": "output"},
                "thread_id": {"type": "string", "default": "custom_agent"},
            },
        },
        {
            "type": "researcher",
            "label": "Deep Researcher",
            "description": "Run GPT Researcher for deep web research on a query.",
            "data_schema": {
                "query_key":  {"type": "string", "default": "input"},
                "output_key": {"type": "string", "default": "research_output"},
            },
        },
        {
            "type": "browser",
            "label": "Browser",
            "description": "Navigate to a URL using Playwright MCP.",
            "data_schema": {
                "url_key": {"type": "string", "default": "url"},
            },
        },
        {
            "type": "output",
            "label": "Output",
            "description": "Terminal node. The state at this point is the final result.",
            "data_schema": {},
        },
    ]


@router.get("/templates")
async def list_templates() -> list[dict]:
    """Pre-built agent templates to start from."""
    return [
        {
            "id":          "blank",
            "name":        "Blank Agent",
            "description": "Empty canvas — start from scratch.",
            "nodes": [
                {"id": "t1", "type": "trigger", "data": {}, "position": {"x": 0,   "y": 0}},
                {"id": "t2", "type": "output",  "data": {}, "position": {"x": 220, "y": 0}},
            ],
            "edges": [{"id": "e1", "source": "t1", "target": "t2"}],
        },
        {
            "id":          "llm_pipeline",
            "name":        "LLM Pipeline",
            "description": "Trigger → LLM → Output",
            "nodes": [
                {"id": "t1", "type": "trigger", "data": {}, "position": {"x": 0,   "y": 0}},
                {"id": "t2", "type": "llm",     "data": {"system_prompt": "You are a helpful assistant."}, "position": {"x": 220, "y": 0}},
                {"id": "t3", "type": "output",  "data": {}, "position": {"x": 440, "y": 0}},
            ],
            "edges": [
                {"id": "e1", "source": "t1", "target": "t2"},
                {"id": "e2", "source": "t2", "target": "t3"},
            ],
        },
        {
            "id":          "research_pipeline",
            "name":        "Research Pipeline",
            "description": "Trigger → Researcher → LLM summary → Output",
            "nodes": [
                {"id": "t1", "type": "trigger",    "data": {}, "position": {"x": 0,   "y": 0}},
                {"id": "t2", "type": "researcher", "data": {"query_key": "input"}, "position": {"x": 220, "y": 0}},
                {"id": "t3", "type": "llm",        "data": {"system_prompt": "Format this research into a clean report.", "input_key": "research_output"}, "position": {"x": 440, "y": 0}},
                {"id": "t4", "type": "output",     "data": {}, "position": {"x": 660, "y": 0}},
            ],
            "edges": [
                {"id": "e1", "source": "t1", "target": "t2"},
                {"id": "e2", "source": "t2", "target": "t3"},
                {"id": "e3", "source": "t3", "target": "t4"},
            ],
        },
        {
            "id":          "conditional_branch",
            "name":        "Conditional Branch",
            "description": "Trigger → Condition → two LLM branches → Output",
            "nodes": [
                {"id": "t1", "type": "trigger",   "data": {}, "position": {"x": 0,   "y": 0}},
                {"id": "t2", "type": "condition", "data": {"input_key": "input", "operator": "truthy"}, "position": {"x": 220, "y": 0}},
                {"id": "t3", "type": "llm",       "data": {"system_prompt": "Handle the TRUE case.", "input_key": "input"}, "position": {"x": 440, "y": -80}},
                {"id": "t4", "type": "llm",       "data": {"system_prompt": "Handle the FALSE case.", "input_key": "input"}, "position": {"x": 440, "y": 80}},
                {"id": "t5", "type": "output",    "data": {}, "position": {"x": 660, "y": 0}},
            ],
            "edges": [
                {"id": "e1", "source": "t1", "target": "t2"},
                {"id": "e2", "source": "t2", "target": "t3", "source_handle": "true"},
                {"id": "e3", "source": "t2", "target": "t4", "source_handle": "false"},
                {"id": "e4", "source": "t3", "target": "t5"},
                {"id": "e5", "source": "t4", "target": "t5"},
            ],
        },
    ]


@router.get("/skills")
async def list_skills_endpoint() -> list[dict]:
    from app.service.skill_library import list_skills
    return list_skills()


# ── MCP server management ────────────────────────────────────────────────────

@router.get("/mcp/servers")
async def list_mcp_servers() -> list[dict]:
    from app.service.mcp_registry_service import list_servers
    return list_servers()


@router.post("/mcp/servers")
async def add_mcp_server(body: dict = Body(...)) -> dict:
    name           = body.get("name", "").strip()
    url_or_package = body.get("url_or_package", "").strip()
    if not name or not url_or_package:
        raise HTTPException(400, "name and url_or_package are required")
    from app.service.mcp_registry_service import add_server
    return await add_server(name, url_or_package)


@router.delete("/mcp/servers/{name}")
async def remove_mcp_server(name: str) -> dict:
    from app.service.mcp_registry_service import remove_server
    remove_server(name)
    return {"deleted": name}


@router.post("/mcp/servers/{name}/reload")
async def reload_mcp_server(name: str) -> dict:
    from app.service.mcp_registry_service import reload_server
    return await reload_server(name)


# ── Git ingestion ─────────────────────────────────────────────────────────────

@router.post("/ingest/git")
async def ingest_git(body: dict = Body(...)) -> dict:
    url       = body.get("url", "").strip()
    type_hint = body.get("type_hint")
    if not url:
        raise HTTPException(400, "url is required")
    from app.service.git_ingestion_service import ingest_git_repo
    return await ingest_git_repo(url, type_hint)


# ─────────────────────────────────────────────────────────────────────────────
# COLLECTION ROUTES  (list + create)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("")
async def list_agents(category: str | None = None) -> list[dict]:
    store = get_custom_agent_store()
    agents = store.list_agents(category=category)
    return [a.model_dump() for a in agents]


@router.post("")
async def create_agent(body: dict = Body(...)) -> dict:
    """
    Create a new custom agent definition.
    Caller may omit id/created_at/updated_at — they are set here.
    """
    body.setdefault("id", str(uuid.uuid4()))
    body.setdefault("created_at", _now())
    body.setdefault("updated_at", _now())
    body.setdefault("version", 1)

    try:
        definition = AgentDefinition.model_validate(body)
    except Exception as exc:
        raise HTTPException(422, str(exc))

    saved = get_custom_agent_store().save_agent(definition)
    return saved.model_dump()


# ─────────────────────────────────────────────────────────────────────────────
# ITEM ROUTES  (/{id} — must follow all static routes above)
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/{agent_id}")
async def get_agent(agent_id: str) -> dict:
    definition = get_custom_agent_store().get_agent(agent_id)
    if not definition:
        raise HTTPException(404, f"Agent not found: {agent_id}")
    return definition.model_dump()


@router.put("/{agent_id}")
async def update_agent(agent_id: str, body: dict = Body(...)) -> dict:
    store = get_custom_agent_store()
    existing = store.get_agent(agent_id)
    if not existing:
        raise HTTPException(404, f"Agent not found: {agent_id}")

    body["id"]         = agent_id
    body["created_at"] = existing.created_at
    body["updated_at"] = _now()

    try:
        definition = AgentDefinition.model_validate(body)
    except Exception as exc:
        raise HTTPException(422, str(exc))

    saved = store.save_agent(definition)
    return saved.model_dump()


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str) -> dict:
    store = get_custom_agent_store()
    if not store.get_agent(agent_id):
        raise HTTPException(404, f"Agent not found: {agent_id}")
    store.delete_agent(agent_id)
    return {"deleted": agent_id}


@router.post("/{agent_id}/publish")
async def publish_agent(agent_id: str) -> dict:
    """Compile the agent and register it in the dynamic registry."""
    try:
        definition = get_custom_agent_store().publish_agent(agent_id)
        return {
            "published": True,
            "agent_id":  agent_id,
            "version":   definition.version,
        }
    except ValueError as exc:
        raise HTTPException(404, str(exc))
    except Exception as exc:
        logger.error("[agent_creator] Publish failed for %s: %s", agent_id, exc, exc_info=True)
        raise HTTPException(500, f"Publish failed: {exc}")


@router.post("/{agent_id}/run")
async def run_agent(agent_id: str, body: dict = Body(default={})) -> StreamingResponse:
    """
    Test-run a custom agent. Streams per-node progress + final result as SSE.
    Body: {"inputs": {...}}
    """
    store = get_custom_agent_store()
    definition = store.get_agent(agent_id)
    if not definition:
        raise HTTPException(404, f"Agent not found: {agent_id}")

    from app.service.agent_compiler import compile_agent

    cls   = compile_agent(definition)
    agent = cls()

    queue: asyncio.Queue[dict | None] = asyncio.Queue()

    async def _on_progress(event: dict) -> None:
        await queue.put(event)

    agent.__class__._progress_callback = _on_progress

    async def _generate():
        yield f"data: {json.dumps({'event': 'start', 'agent_id': agent_id})}\n\n"

        async def _run_agent():
            try:
                result = await agent.execute(body.get("inputs", {}))
                await queue.put({"event": "complete", "result": result})
            except Exception as exc:
                logger.error("[agent_creator] run failed for %s: %s", agent_id, exc, exc_info=True)
                await queue.put({"event": "error", "message": str(exc)})
            finally:
                await queue.put(None)  # sentinel

        task = asyncio.create_task(_run_agent())

        try:
            while True:
                item = await asyncio.wait_for(queue.get(), timeout=120)
                if item is None:
                    break
                yield f"data: {json.dumps(item)}\n\n"
        except asyncio.TimeoutError:
            yield f"data: {json.dumps({'event': 'error', 'message': 'Run timed out'})}\n\n"
        finally:
            task.cancel()
            # Reset callback so it doesn't leak across requests
            agent.__class__._progress_callback = None

    return StreamingResponse(_generate(), media_type="text/event-stream")
