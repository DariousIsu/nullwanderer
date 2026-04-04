"""
AURA NX-Alpha — Sprint Agent Node (§12.1)
Executes one SprintBrief: calls Ollama workhorse with tool dispatch,
produces an AgentResult with content + sources.
"""

import json
import logging
import uuid
from app.graph.state import GraphState, AgentResult

logger = logging.getLogger(__name__)


async def run_sprint_agent(state: GraphState) -> dict:
    """
    Sprint execution node. Pops one sprint from remaining_sprints, executes it.
    Calls Ollama with tool dispatch to produce a real AgentResult.
    """
    from app.controller.chat_controller import _emit

    remaining = list(state.get("remaining_sprints", []))
    if not remaining:
        logger.error("[sprint_agent] No sprints remaining")
        return {"error": "sprint_agent: no remaining sprints"}

    sprint = remaining.pop(0)
    sprint_id = sprint.get("sprint_id", f"sp-{uuid.uuid4().hex[:8]}")
    area_id = sprint.get("area_id", "unknown")
    task = sprint.get("task", "")
    tools = sprint.get("tools", ["web_search"])
    domain = sprint.get("domain", "general")

    logger.info("[sprint_agent] Executing sprint=%s domain=%s task=%.60s", sprint_id, domain, task)

    # Update parent area agent to show current sprint work
    await _emit("agent_update", {
        "agent_id": area_id,
        "status": "working",
        "summary": f"Sprint: {task[:80]}",
    })
    # Register sprint agent in monitor (frontend upserts new agents)
    await _emit("agent_update", {
        "agent_id": sprint_id,
        "name":     f"Sprint: {domain.title()}",
        "task":     task[:120],
        "status":   "working",
        "summary":  f"{task[:80]}...",
    })

    # Pass the original user request so the sprint agent can form proper search queries
    team_request = state.get("team_request") or state.get("user_message", "")
    content, sources = await _execute_with_ollama(task, tools, domain, team_request, sprint)

    result: AgentResult = {
        "sprint_id": sprint_id,
        "area_id":   area_id,
        "agent_id":  f"agent-{sprint_id}",
        "content":   content,
        "markers":   [],
        "summary":   content[:200] + "..." if len(content) > 200 else content,
        "sources":   sources,
        "metadata":  {"domain": domain, "task": task},
    }

    await _emit("agent_update", {
        "agent_id": sprint_id,
        "status": "done",
        "summary": f"Complete — {len(sources)} sources",
    })

    current_results = list(state.get("current_area_sprint_results", []))
    all_sprint_results = list(state.get("sprint_results", []))

    return {
        "remaining_sprints":           remaining,
        "current_area_sprint_results": [*current_results, result],
        "sprint_results":              [*all_sprint_results, result],
    }


def _build_search_query(task: str, team_request: str) -> str:
    """
    Build a proper search query from the sprint task and original user request.
    The sprint task name is often an internal label like "Phase 1 Data Collection"
    which returns nothing on the web. Use the original request as the search base.
    """
    # If the task looks like an internal label (short, generic, no domain keywords),
    # use the original user request instead
    task_lower = task.lower()
    generic_indicators = [
        "phase", "step", "initial", "identification", "collection",
        "analysis", "review", "compilation", "assessment", "processing",
    ]
    is_generic = (
        len(task.split()) <= 8
        or sum(1 for g in generic_indicators if g in task_lower) >= 2
    )

    if is_generic and team_request:
        # Combine: use team_request as the core, append task context if it has keywords
        # Strip conversational fluff from team_request
        import re
        clean_request = re.sub(
            r'^(fantastic|ok|great|sure|please|i need to|i want to|can you|help me)\b[.,!]?\s*',
            '', team_request, flags=re.IGNORECASE,
        ).strip()
        return clean_request[:200] if clean_request else team_request[:200]

    return task[:200]


async def _run_tool(tool_name: str, task: str, team_request: str) -> tuple[str, list]:
    """
    Dispatch one tool and return (text_result, [urls]).
    Routes through MCP registry first, then legacy hardcoded fallbacks.
    """
    import re

    # ── web_search: custom query building ────────────────────────────────────
    if tool_name == "web_search":
        from app.tools.web_search import search
        search_query = _build_search_query(task, team_request)
        logger.info("[sprint_agent] Search query: %.80s", search_query)
        results = await search(search_query, max_results=5)
        if not results:
            return "", []
        text = "\n".join(
            f"[{r['source']}] {r['title']}: {r['snippet']} ({r['url']})"
            for r in results
        )
        urls = [r["url"] for r in results if r.get("url")]
        return f"Web search results:\n{text}", urls

    # ── MCP registry: all registered tools (exa, jina, sec_edgar, etc.) ─────
    try:
        from app.tools._mcp_wrapper import dispatch, is_registered
        if is_registered(tool_name):
            result = await dispatch(tool_name, {"query": task})
            text = json.dumps(result, indent=2)[:3000] if isinstance(result, dict) else str(result)[:3000]
            urls = re.findall(r'https?://[^\s\)\"\',]+', text)
            return text, urls[:5]
    except Exception as exc:
        logger.warning("[sprint_agent] registry dispatch for %s failed: %s", tool_name, exc)

    # ── Legacy hardcoded fallbacks for old tool names ─────────────────────────
    if tool_name in ("finance_quote", "market_overview"):
        from app.tools.system_tools import get_market_overview
        data = await get_market_overview()
        return f"Market data:\n{json.dumps(data, indent=2)[:2000]}", []

    if tool_name == "news":
        from app.tools.system_tools import get_news
        news = await get_news(category="all", limit=8)
        if isinstance(news, list):
            return "Recent news:\n" + "\n".join(f"- {a.get('title','')}" for a in news), []
        return "", []

    if tool_name == "weather":
        from app.tools.system_tools import get_weather
        data = await get_weather()
        return f"Weather:\n{json.dumps(data, indent=2)[:500]}", []

    logger.debug("[sprint_agent] Tool '%s' not available — skipping", tool_name)
    return "", []


async def _execute_with_ollama(task: str, tools: list, domain: str, team_request: str = "", sprint: dict = None) -> tuple[str, list]:
    """Execute sprint task using Ollama with tool dispatch. Returns (content, sources)."""
    try:
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc is None or not svc.is_available():
            raise RuntimeError("Ollama not available")

        # Gather tool results — route each tool through MCP registry or legacy fallback
        tool_results = []
        sources = []

        for tool_name in tools:
            try:
                text, urls = await _run_tool(tool_name, task, team_request)
                if text:
                    tool_results.append(f"[{tool_name}]:\n{text}")
                    sources.extend(urls)
            except Exception as exc:
                logger.warning("[sprint_agent] tool %s failed: %s", tool_name, exc)

        # Build Ollama prompt — sprint agent writes one complete document section
        sprint = sprint or {}
        section_name = sprint.get("domain") or sprint.get("task") or "Section"
        section_goal = task  # task carries the section goal from area agent passthrough

        context = "\n\n".join(tool_results) if tool_results else ""
        tool_section = f"\n\nReference data (use if relevant — do not copy verbatim):\n{context}" if context else ""

        prompt = f"""You are writing one section of a professional document.

DOCUMENT CONTEXT: {team_request}
SECTION: {section_name}
SECTION GOAL: {section_goal}
{tool_section}

Write this section now. Requirements:
- 300-500 words of polished, publication-ready prose
- Authoritative and specific — no filler phrases like "it is important to note"
- Write AS the section — not notes ABOUT the section
- End with a natural transition or closing thought

Return ONLY the written section text. No meta-commentary, no "Here is the section:", just the prose."""

        messages = [
            {"role": "system", "content": (
                "You are a professional writer producing one section of a longer document. "
                "You have comprehensive knowledge spanning history, science, technology, culture, "
                "economics, and all major academic fields. Use your own knowledge as the primary source. "
                "Web search results (if provided) are supplementary — use them to add current data or "
                "confirm recent developments, not as your only source of truth.\n\n"
                "Write polished, publication-ready prose. No bullet points, no meta-commentary, "
                "no preamble. Just the section text, written with authority and specificity."
            )},
            {"role": "user",   "content": prompt},
        ]
        content = await svc.chat(messages, temperature=0.4, max_tokens=2048)
        return content, sources

    except Exception as exc:
        logger.warning("[sprint_agent] Ollama execution failed (%s) — using stub", exc)
        return (
            f"[Research stub] Task: {task[:200]}\nOllama unavailable — install and start Ollama to enable team research.",
            [],
        )
