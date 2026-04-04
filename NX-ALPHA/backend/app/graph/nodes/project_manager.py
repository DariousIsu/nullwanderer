"""
AURA NX-Alpha — Project Manager Node (§12.1)
Decomposes a team request into an ExecutionPlan with AreaBriefs.
Uses Ollama workhorse with schema-constrained output for reliable JSON.
"""

import json
import logging
import uuid
from typing import Optional
from app.graph.state import GraphState, ExecutionPlan, AreaBrief

logger = logging.getLogger(__name__)

_MAX_AREAS = 4

# Schema for pre-planning clarification check (fast, cheap call)
_CLARIFICATION_SCHEMA = {
    "type": "object",
    "properties": {
        "needs_clarification": {"type": "boolean"},
        "question":            {"type": "string"},
    },
    "required": ["needs_clarification", "question"],
}

# Schema for structured output — Ollama grammar-constrains to this exact shape
_AREAS_SCHEMA = {
    "type": "object",
    "properties": {
        "areas": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "domain":    {"type": "string"},
                    "objective": {"type": "string"},
                    "tools":     {"type": "array", "items": {"type": "string"}},
                },
                "required": ["domain", "objective", "tools"],
            },
        }
    },
    "required": ["areas"],
}


async def run_project_manager(state: GraphState) -> dict:
    """
    Dual-mode Project Manager:
      PLAN MODE (initial):  Decompose team_request into AreaBriefs.
      RETURN MODE (post-verifier):  Package verified output for Interface Agent.

    Return mode is detected when state.verified is True — the team pipeline
    has completed and the verifier has signed off. PM packages the final
    output with provenance and hands it to the Interface Agent for rendering.
    """
    from app.controller.chat_controller import _emit

    # ── RETURN MODE: verified output ready — package for Interface Agent ────
    if state.get("verified") is True:
        return await _return_mode(state)

    team_request = state.get("team_request") or state.get("user_message", "")
    thread_id = state.get("thread_id", "default")
    revision = state.get("plan_revision_count", 0)
    corrections = state.get("plan_corrections") or []

    logger.info("[project_manager] Building plan for: %.80s", team_request)
    if revision > 0:
        logger.info("[project_manager] Revision %d. Corrections: %s", revision, corrections)

    # ── CLARIFICATION GATE — check for genuine subject-matter ambiguity ────────
    # Only runs on first-pass plans (not revisions). Does NOT ask about format,
    # length, audience, or style — those are AURA's domain, not planning's.
    clarification_answer: Optional[str] = state.get("clarification_answer")
    if not clarification_answer and not corrections:
        try:
            from app.service.ollama_service import get_ollama_service
            _svc = get_ollama_service()
            if _svc and _svc.is_available():
                question = await _should_ask_clarification(team_request, _svc)
                if question:
                    from app.service.team_dispatcher import get_team_dispatcher
                    _dispatcher = get_team_dispatcher()
                    logger.info("[project_manager] Requesting clarification: %s", question)
                    await _emit("agent_update", {
                        "agent_id": "project_manager",
                        "status":   "waiting",
                        "summary":  "Waiting for your input...",
                    })
                    _answer = await _dispatcher.request_clarification(question, thread_id)
                    if _answer:
                        clarification_answer = _answer
                        logger.info(
                            "[project_manager] Clarification received: %.80s", clarification_answer
                        )
                    else:
                        logger.info("[project_manager] Clarification timed out — proceeding")
        except Exception as _exc:
            logger.warning("[project_manager] Clarification gate error: %s — skipping", _exc)

    await _emit("agent_update", {
        "agent_id": "project_manager",
        "status": "working",
        "summary": "Decomposing task into execution plan...",
    })

    team_id = f"team-{uuid.uuid4().hex[:8]}"
    areas = await _decompose_with_ollama(team_request, corrections, clarification_answer=clarification_answer)

    plan: ExecutionPlan = {
        "team_id":     team_id,
        "task":        team_request,
        "area_briefs": areas,
        "agents":      [
            {"agent_id": f"agent-{a['area_id']}", "area_id": a["area_id"], "role": "sprint"}
            for a in areas
        ],
    }

    await _emit("agent_update", {
        "agent_id": "project_manager",
        "status": "done",
        "summary": f"Plan created: {len(areas)} area(s)",
    })

    # Emit team_dispatched with the full agent roster for AgentMonitor
    await _emit("team_dispatched", {
        "plan": {
            "teamId": team_id,
            "task":   team_request,
            "agents": [
                {
                    "id": "project_manager", "name": "Project Manager",
                    "task": "Planning & coordination",
                    "status": "done", "summary": f"Plan created: {len(areas)} area(s)",
                },
                *[
                    {
                        "id": a["area_id"], "name": f"Area: {a['domain'].title()}",
                        "task": a["objective"][:120],
                        "status": "waiting", "summary": "",
                    }
                    for a in areas
                ],
                {"id": "assembler", "name": "Assembler", "task": "Synthesize results", "status": "waiting", "summary": ""},
                {"id": "validator", "name": "Validator", "task": "Quality review", "status": "waiting", "summary": ""},
                {"id": "verifier",  "name": "Verifier",  "task": "Final verification", "status": "waiting", "summary": ""},
            ],
        }
    })

    output_contract = (
        "Produce a complete, standalone, professionally written document. "
        "It must have an introduction, developed body sections with subheadings, "
        "and a conclusion. It must read as if written by a single author. "
        "The user should be able to hand this to someone without explanation."
    )

    return {
        "execution_plan":      plan,
        "remaining_areas":     list(areas),
        "plan_revision_count": revision + 1,
        "path":                "team",
        "output_contract":     output_contract,
    }


async def _should_ask_clarification(task: str, svc) -> Optional[str]:
    """
    Fast pre-planning check: does this task have a genuine subject-matter ambiguity
    that would produce a completely different execution plan depending on the answer?

    Gate is deliberately narrow:
      - FIRES on: "write about Mercury" (planet vs element vs Roman god — different domains)
      - SKIPS on: "analyze oil prices", "write a paper on WWII", "research climate change"
      - NEVER asks about format, length, tone, audience, or level of detail

    Returns the clarifying question string if needed, or None to proceed without asking.
    """
    try:
        messages = [
            {
                "role": "system",
                "content": (
                    "You are a planning assistant performing a single pre-flight check. "
                    "Determine if the task has ONE critical subject-matter ambiguity where "
                    "two plausible interpretations would require completely different research "
                    "domains, tools, or area agents to execute. This is a very high bar — "
                    "most tasks are unambiguous enough to plan without asking. "
                    "ONLY return needs_clarification=true if the core subject itself is "
                    "ambiguous (e.g. 'Mercury' = planet / element / god, "
                    "'write about Python' = programming language / snake / Monty Python). "
                    "NEVER ask about: format, length, tone, audience, detail level, style, "
                    "deadline, or output format — those do not affect the plan structure. "
                    'Output JSON: {"needs_clarification": false, "question": ""} '
                    'or {"needs_clarification": true, "question": "one concise clarifying sentence"}'
                ),
            },
            {
                "role": "user",
                "content": f"Task: {task}\n\nIs clarification needed before I can plan this?",
            },
        ]
        result = await svc.chat_json(messages, temperature=0.1, schema=_CLARIFICATION_SCHEMA)
        if result.get("needs_clarification") is True:
            question = result.get("question", "").strip()
            if question:
                return question
        return None
    except Exception as exc:
        logger.warning("[project_manager] _should_ask_clarification failed: %s — skipping gate", exc)
        return None


async def _decompose_with_ollama(
    task: str,
    corrections: list,
    clarification_answer: Optional[str] = None,
) -> list[AreaBrief]:
    """Use Ollama to decompose task into AreaBriefs. Falls back to single area."""
    try:
        from app.service.ollama_service import get_ollama_service
        svc = get_ollama_service()
        if svc is None or not svc.is_available():
            raise RuntimeError("Ollama not available")

        correction_text = ""
        if corrections:
            correction_text = f"\n\nPrevious plan corrections:\n" + "\n".join(f"- {c}" for c in corrections)

        clarification_text = ""
        if clarification_answer:
            clarification_text = f"\n\nUser clarification: {clarification_answer}"

        prompt = f"""You are planning the production of a complete written document, not a research project.
Your output is a document outline: a list of sections that, taken together, will form
a complete, standalone deliverable.

Task: {task}{correction_text}{clarification_text}

Decide: How many sections does this document need? (1-{_MAX_AREAS})
Each section will be written by a dedicated writer agent.

For EACH section, output a JSON object with:
- "domain": the section heading that will appear in the final document (e.g. "Introduction", "Solar Energy Trends", "Policy Landscape", "Conclusion")
- "objective": one sentence describing what this section must accomplish for the reader — the section goal
- "tools": which tools the writer needs. Pick from the list below. Use an EMPTY array [] unless the section genuinely requires live or specialized data.

Available tools:
  "web_search"         — current events, recent news, general live data
  "exa_search"         — academic papers, policy docs, technical research (neural search)
  "jina_search"        — deep reading of a specific URL or topic (full-page extraction)
  "knowledge_search"   — local knowledge base: Wikipedia, PubMed, arXiv, StackExchange, Gutenberg
  "sec_edgar"          — SEC corporate filings (10-K, 10-Q, 8-K) for any public company
  "legislation_search" — US federal/state legislation, bill text, sponsor info
  "nasa"               — NASA imagery, science data, mission records
  "finance_quote"      — live stock quote for a single ticker
  "market_overview"    — broad market indices and sector data
  "news"               — latest headlines across categories
  "lightrag"           — query AURA's knowledge graph for prior research on this topic
  "citation_verifier"  — verify citations in a submitted document (external document mode)
  "browser"            — fetch and read the full content of a specific URL
  "github"             — GitHub repos, code search, issues, pull requests
  "firecrawl"          — deep web crawl and structured content extraction
  "research"           — arXiv search, paper retrieval, RSS feed digest, deep research methodology
  "ocr"                — extract text from images (OpenOCR + Tesseract)
  "chart_image"        — generate charts (bar, line, scatter, pie, heatmap, candlestick)
  "office_docs"        — generate PPTX, DOCX, XLSX, PDF documents
  "code_runner"        — execute code in Python, Rust, Go, Java, JS, TS, Bash
  "security_scan"      — scan requests for credential leaks, audit packages and plugins
  "x_twitter"          — X/Twitter trends, search, post drafts
  "ffmpeg_editor"      — video editing: trim, merge, transcode, extract audio, resize
  "mindmap"            — generate Mermaid diagrams (flowcharts, mindmaps, sequence)
  "cad_3d"             — 3D rendering (build123d) and STL file search (Printables)
  "excalidraw"         — generate Excalidraw flowchart/diagram files
  "music_gen"          — AI music generation via ACE Music API
  "comfyui_generate"   — local image generation via ComfyUI GPU pipeline
  "logo_gen"           — SVG graphic generation with optional PNG export

Think like an editor assigning sections to writers, not a manager assigning research tasks.

CRITICAL RULES:
1. Section headings ("domain") must be real document headings — clear, specific, reader-facing. Never use internal labels like "Phase 1" or "Data Collection".
2. Each writer already has encyclopedic knowledge. Only assign tools when the section genuinely requires data the writer cannot know from training.
3. For a typical writing task, 2-4 sections is right. Don't over-decompose.

Respond with JSON containing an "areas" array."""

        messages = [
            {"role": "system", "content": (
                "You are an editorial planning AI. You produce document outlines — lists of sections "
                "that writers will draft independently. Each section must have a clear heading and a "
                "one-sentence goal. Your writers have encyclopedic knowledge and do NOT need web search "
                "for well-known topics. Only assign tools when genuinely needed. Respond with valid JSON."
            )},
            {"role": "user", "content": prompt},
        ]

        # Schema-constrained output — Ollama guarantees {"areas": [...]}
        raw = await svc.chat_json(messages, temperature=0.3, schema=_AREAS_SCHEMA)

        # With schema enforcement, raw is always {"areas": [...]}
        # Keep fallback parsing for older Ollama versions
        if isinstance(raw, dict) and "areas" in raw:
            area_data = raw["areas"]
        elif isinstance(raw, list):
            area_data = raw
        elif isinstance(raw, dict):
            # Fallback: scan all values for a list of dicts
            area_data = None
            for v in raw.values():
                if isinstance(v, list) and v and isinstance(v[0], dict):
                    area_data = v
                    break
            if area_data is None:
                if "domain" in raw and "objective" in raw:
                    area_data = [raw]
                else:
                    raise ValueError(f"Unexpected response structure — keys: {list(raw.keys())}")
        else:
            raise ValueError(f"Unexpected JSON type: {type(raw)}")

        areas: list[AreaBrief] = []
        for item in area_data[:_MAX_AREAS]:
            areas.append({
                "area_id":         f"area-{uuid.uuid4().hex[:8]}",
                "domain":          str(item.get("domain", "general")),
                "objective":       str(item.get("objective", task)),
                "context_markers": [],
                "tools":           item.get("tools", []),
            })
        if not areas:
            raise ValueError("No areas returned")
        return areas

    except Exception as exc:
        logger.warning("[project_manager] Ollama decompose failed (%s) — using single-area fallback", exc)
        return [{
            "area_id":         f"area-{uuid.uuid4().hex[:8]}",
            "domain":          "general",
            "objective":       task,
            "context_markers": [],
            "tools":           ["web_search", "browse"],
        }]


# ─────────────────────────────────────────────────────────────────────────────
# RETURN MODE — post-verifier packaging
# ─────────────────────────────────────────────────────────────────────────────

async def _return_mode(state: GraphState) -> dict:
    """
    Post-verifier return path. Packages the verified output with provenance
    metadata and routes to Interface Agent for final rendering.
    """
    from app.controller.chat_controller import _emit

    assembled = state.get("verified_output") or state.get("assembled_output") or {}
    plan = state.get("execution_plan") or {}
    area_results = state.get("area_results", [])
    sprint_results = state.get("sprint_results", [])

    logger.info(
        "[project_manager] Return mode: packaging %d area results, %d sprint results",
        len(area_results), len(sprint_results),
    )

    await _emit("agent_update", {
        "agent_id": "project_manager",
        "status": "working",
        "summary": "Packaging verified results for delivery...",
    })

    # Build provenance map: which sprints contributed to which areas
    provenance = {}
    for sr in sprint_results:
        aid = sr.get("area_id", "unknown")
        sid = sr.get("sprint_id", "unknown")
        provenance.setdefault(aid, []).append(sid)

    # Build source list from all sprint results
    all_sources = []
    seen_urls = set()
    for sr in sprint_results:
        for url in sr.get("sources", []):
            if url and url not in seen_urls:
                all_sources.append(url)
                seen_urls.add(url)

    # Enrich assembled output with provenance if not already present
    if assembled and not assembled.get("provenance_map"):
        assembled["provenance_map"] = provenance

    await _emit("agent_update", {
        "agent_id": "project_manager",
        "status": "done",
        "summary": f"Output packaged — {len(all_sources)} sources, {len(provenance)} areas",
    })

    return {
        "path":            "team_return",
        "verified_output": assembled,
    }
