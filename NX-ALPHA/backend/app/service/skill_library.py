"""
Skill library — built-in sub-graph templates for the Agent Creator canvas.

Each skill is a miniature AgentDefinition (nodes + edges) that can be dropped
onto the canvas as a pre-wired building block.
"""
from __future__ import annotations

SKILLS: dict[str, dict] = {
    "web_research": {
        "id":          "web_research",
        "name":        "Web Research",
        "description": "Scrape a URL → summarize with LLM",
        "nodes": [
            {"id": "s1", "type": "tool",   "data": {"tool_id": "web_scrape", "output_key": "scraped"}, "position": {"x": 0,   "y": 0}},
            {"id": "s2", "type": "llm",    "data": {"system_prompt": "Summarize the following web content concisely.", "input_key": "scraped", "output_key": "summary"}, "position": {"x": 220, "y": 0}},
            {"id": "s3", "type": "output", "data": {}, "position": {"x": 440, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "source": "s1", "target": "s2"},
            {"id": "e2", "source": "s2", "target": "s3"},
        ],
    },

    "deep_research": {
        "id":          "deep_research",
        "name":        "Deep Research",
        "description": "GPT Researcher → structured report output",
        "nodes": [
            {"id": "r1", "type": "researcher", "data": {"query_key": "input", "output_key": "research_output"}, "position": {"x": 0,   "y": 0}},
            {"id": "r2", "type": "output",     "data": {}, "position": {"x": 220, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "source": "r1", "target": "r2"},
        ],
    },

    "legislation_check": {
        "id":          "legislation_check",
        "name":        "Legislation Check",
        "description": "Search legislation DB → LLM summary of findings",
        "nodes": [
            {"id": "l1", "type": "tool",   "data": {"tool_id": "legislation_search", "output_key": "leg_results"}, "position": {"x": 0,   "y": 0}},
            {"id": "l2", "type": "llm",    "data": {"system_prompt": "Summarize these legislative findings clearly and concisely.", "input_key": "leg_results", "output_key": "leg_summary"}, "position": {"x": 220, "y": 0}},
            {"id": "l3", "type": "output", "data": {}, "position": {"x": 440, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "source": "l1", "target": "l2"},
            {"id": "e2", "source": "l2", "target": "l3"},
        ],
    },

    "memory_retrieve_and_use": {
        "id":          "memory_retrieve_and_use",
        "name":        "Memory + LLM",
        "description": "Retrieve from memory → inject context → LLM response",
        "nodes": [
            {"id": "m1", "type": "memory_read", "data": {"limit": 5, "query_key": "input", "output_key": "memory_results"}, "position": {"x": 0,   "y": 0}},
            {"id": "m2", "type": "llm",         "data": {"input_key": "memory_results", "output_key": "response"}, "position": {"x": 220, "y": 0}},
            {"id": "m3", "type": "output",      "data": {}, "position": {"x": 440, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "source": "m1", "target": "m2"},
            {"id": "e2", "source": "m2", "target": "m3"},
        ],
    },

    "research_and_save": {
        "id":          "research_and_save",
        "name":        "Research & Save to Memory",
        "description": "Deep research → save result to memory for future retrieval",
        "nodes": [
            {"id": "rs1", "type": "researcher",   "data": {"query_key": "input", "output_key": "research_output"}, "position": {"x": 0,   "y": 0}},
            {"id": "rs2", "type": "memory_write", "data": {"input_key": "research_output"}, "position": {"x": 220, "y": 0}},
            {"id": "rs3", "type": "output",       "data": {}, "position": {"x": 440, "y": 0}},
        ],
        "edges": [
            {"id": "e1", "source": "rs1", "target": "rs2"},
            {"id": "e2", "source": "rs2", "target": "rs3"},
        ],
    },
}


def get_skill(skill_id: str) -> dict | None:
    """Check dynamic captured skills first, then fall back to static SKILLS dict."""
    try:
        from app.service.skill_capture_service import get_skill_capture_service
        svc = get_skill_capture_service()
        if svc is not None:
            return svc.get_skill(skill_id)
    except Exception:
        pass
    return SKILLS.get(skill_id)


def list_skills() -> list[dict]:
    """Return all skills — dynamic (captured) merged with static built-ins."""
    try:
        from app.service.skill_capture_service import get_skill_capture_service
        svc = get_skill_capture_service()
        if svc is not None:
            return svc.list_skills(include_static=True)
    except Exception:
        pass
    return [
        {"id": s["id"], "name": s["name"], "description": s["description"]}
        for s in SKILLS.values()
    ]
