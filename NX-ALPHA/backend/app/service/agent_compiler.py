"""
Agent compiler — converts an AgentDefinition (nodes + edges) into a runnable
BaseAgent subclass. Compiled agents are cached by (definition_id, version).

Condition branching:
    When a condition node is reached, its result (True/False) determines which
    outgoing handle ("true"/"false") to follow. Nodes reachable only via the
    skipped handle are added to a blocked set, and blocking propagates forward
    through the topological order so entire dead branches are skipped.
"""
from __future__ import annotations

import logging
from collections import defaultdict, deque
from typing import TYPE_CHECKING, Awaitable, Callable, Optional

if TYPE_CHECKING:
    from app.models.agent_definition import AgentDefinition, NodeDefinition

logger = logging.getLogger(__name__)

_CACHE: dict[tuple[str, int], type] = {}


# ─────────────────────────────────────────────────────────────────────────────
# COMPILER ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

def compile_agent(definition: "AgentDefinition") -> type:
    """Compile an AgentDefinition into a runnable BaseAgent subclass."""
    cache_key = (definition.id, definition.version)
    if cache_key in _CACHE:
        return _CACHE[cache_key]

    from app.agents.base import BaseAgent

    defn = definition.model_copy(deep=True)
    node_map = {n.id: n for n in defn.nodes}
    edges    = defn.edges
    exec_order = _topo_sort(defn)

    # condition adjacency: node_id → {"true": [target_ids], "false": [target_ids]}
    cond_adj: dict[str, dict[str, list[str]]] = {}
    for e in edges:
        if e.source_handle in ("true", "false"):
            cond_adj.setdefault(e.source, {}).setdefault(e.source_handle, []).append(e.target)

    # all edges by source for block propagation
    fwd_edges: dict[str, list[str]] = defaultdict(list)
    for e in edges:
        fwd_edges[e.source].append(e.target)

    class CompiledCustomAgent(BaseAgent):
        AGENT_ID          = defn.id
        AGENT_NAME        = defn.name
        AGENT_DESCRIPTION = defn.description
        INPUTS            = defn.inputs
        OUTPUTS           = defn.outputs

        # Optional per-node progress callback set by the run endpoint for SSE.
        # Signature: async (event: dict) -> None
        _progress_callback: Optional[Callable[[dict], Awaitable[None]]] = None

        async def run(self, inputs: dict) -> dict:
            state:   dict       = dict(inputs)
            blocked: set[str]   = set()

            for node_id in exec_order:
                # Propagate blocking forward through all outgoing edges
                if node_id in blocked:
                    for target in fwd_edges[node_id]:
                        blocked.add(target)
                    continue

                node = node_map[node_id]
                cb   = self.__class__._progress_callback

                if cb:
                    await cb({"event": "node_start", "node_id": node_id, "type": node.type})

                if node.type == "condition":
                    state = await _execute_node(node, state)
                    taken   = "true" if state.get(f"_condition_{node.id}") else "false"
                    skipped = "false" if taken == "true" else "true"
                    for target in cond_adj.get(node_id, {}).get(skipped, []):
                        blocked.add(target)
                else:
                    state = await _execute_node(node, state)

                if cb:
                    await cb({"event": "node_complete", "node_id": node_id})

            return state

    CompiledCustomAgent.__name__ = f"CompiledAgent_{defn.id[:8]}"
    _CACHE[cache_key] = CompiledCustomAgent
    return CompiledCustomAgent


# ─────────────────────────────────────────────────────────────────────────────
# TOPOLOGICAL SORT
# ─────────────────────────────────────────────────────────────────────────────

def _topo_sort(definition: "AgentDefinition") -> list[str]:
    in_degree: dict[str, int]    = defaultdict(int)
    adj:       dict[str, list[str]] = defaultdict(list)

    for e in definition.edges:
        adj[e.source].append(e.target)
        in_degree[e.target] += 1

    queue = deque(n.id for n in definition.nodes if in_degree[n.id] == 0)
    order: list[str] = []
    while queue:
        node_id = queue.popleft()
        order.append(node_id)
        for target in adj[node_id]:
            in_degree[target] -= 1
            if in_degree[target] == 0:
                queue.append(target)
    return order


# ─────────────────────────────────────────────────────────────────────────────
# NODE EXECUTION
# ─────────────────────────────────────────────────────────────────────────────

async def _execute_node(node: "NodeDefinition", state: dict) -> dict:
    t   = node.type
    cfg = node.data

    if t == "llm":
        from app.service.ollama_service import get_ollama_service

        svc = get_ollama_service()
        if svc is None:
            logger.warning("[compiler] OllamaService not available — skipping LLM node %s", node.id)
            return state

        system_prompt = cfg.get("system_prompt", "")
        input_key     = cfg.get("input_key", "input")
        output_key    = cfg.get("output_key", "output")

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": str(state.get(input_key, ""))})

        text = await svc.chat(messages)
        state[output_key] = text

    elif t == "tool":
        tool_id    = cfg.get("tool_id", "")
        params     = {k: state.get(v, v) for k, v in cfg.get("params", {}).items()}
        output_key = cfg.get("output_key", "tool_output")
        state[output_key] = await _dispatch_tool(tool_id, params)

    elif t == "researcher":
        from app.service.gpt_researcher_service import research

        query      = str(state.get(cfg.get("query_key", "input"), ""))
        output_key = cfg.get("output_key", "research_output")
        state[output_key] = await research(query)

    elif t == "browser":
        from app.service.mcp_client_service import get_mcp_client

        mcp = get_mcp_client()
        if mcp:
            result = await mcp.call_tool(
                "browser_navigate", {"url": state.get("url", "")}
            )
            state["browser_output"] = str(result)

    elif t == "memory_read":
        from app.service.memory_service import get_memory_service

        svc = get_memory_service()
        if svc:
            query  = str(state.get(cfg.get("query_key", "input"), ""))
            limit  = int(cfg.get("limit", 5))
            # _hybrid_search is synchronous
            results = svc._hybrid_search(query, n_results=limit)
            state[cfg.get("output_key", "memory_results")] = results

    elif t == "memory_write":
        from app.service.memory_service import get_memory_service

        svc = get_memory_service()
        if svc:
            content   = str(state.get(cfg.get("input_key", "output"), ""))
            thread_id = cfg.get("thread_id", "custom_agent")
            await svc.record(role="interface", content=content, thread_id=thread_id)

    elif t == "condition":
        input_key     = cfg.get("input_key", "input")
        operator      = cfg.get("operator", "truthy")
        compare_value = cfg.get("value")
        val           = state.get(input_key)

        if operator == "equals":
            result = val == compare_value
        elif operator == "gt":
            result = float(val) > float(compare_value)
        elif operator == "lt":
            result = float(val) < float(compare_value)
        elif operator == "contains":
            result = str(compare_value) in str(val)
        else:  # truthy
            result = bool(val)

        state[f"_condition_{node.id}"] = result

    elif t in ("output", "trigger", "skill_group"):
        pass  # passthrough / terminal nodes

    return state


# ─────────────────────────────────────────────────────────────────────────────
# TOOL DISPATCH
# ─────────────────────────────────────────────────────────────────────────────

async def _dispatch_tool(tool_id: str, params: dict):
    """
    Canvas agent tool dispatch — MCP-first chain.
    Tries the AURA tool registry (all registered tool_handlers), then MCP client
    (external servers like playwright, open-stocks-mcp), then legacy fallbacks.
    """
    # 1. Try AURA tool registry (covers all tools with tool_handler + TOOL_DEF)
    try:
        from app.tools._mcp_wrapper import dispatch, is_registered
        if is_registered(tool_id):
            return await dispatch(tool_id, params)
    except Exception as exc:
        logger.warning("[compiler] Registry dispatch for %s failed: %s", tool_id, exc)

    # 2. Try MCP client (external MCP servers)
    try:
        from app.service.mcp_client_service import get_mcp_client
        mcp = get_mcp_client()
        if mcp:
            return await mcp.call_tool(tool_id, params)
    except ValueError:
        pass  # Unknown tool — fall through
    except Exception as exc:
        logger.warning("[compiler] MCP dispatch for %s failed: %s", tool_id, exc)

    # 3. Legacy hardcoded fallbacks (kept for backward compat, shrinks over time)
    if tool_id == "web_scrape":
        from app.service.scraper_service import scrape
        return await scrape(params.get("url", ""))

    if tool_id == "gpt_researcher":
        from app.service.gpt_researcher_service import research
        return await research(params.get("query", ""))

    logger.warning("[compiler] Unknown tool_id: %s", tool_id)
    return None
