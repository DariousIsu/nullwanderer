"""
skills_tool.py
───────────────
AURA MCP tool — Skills Knowledge Base lookup.

Searches the FTS5-indexed skills KB for actionable procedural guidance.
Covers: AI/ML (RAG, fine-tuning, inference, agents), Business (PM, marketing,
regulatory), Engineering (security, CI/CD, performance, Playwright, K8s,
Terraform), Infrastructure (Cloudflare Workers, Terraform providers).

DB: ~/.aura/knowledge/skills/fts5.db
Build index first: python backend/scripts/build_skills_index.py
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

_SKILLS_DB = Path.home() / ".aura" / "knowledge" / "skills" / "fts5.db"

# ── Tool definition ───────────────────────────────────────────────────────────
TOOL_DEF = {
    "name": "skills_lookup",
    "description": (
        "Search AURA's skills knowledge base for actionable procedural guidance. "
        "Covers AI/ML (RAG setup, fine-tuning LoRA/QLoRA, vLLM, LangGraph, CrewAI), "
        "Business (OKR, PRD, RICE, A/B testing, GDPR, ISO 13485), "
        "Engineering (CodeQL, Semgrep, CI/CD, Playwright, Kubernetes, Terraform), "
        "and Infra (Cloudflare Workers KV/R2/D1, Durable Objects). "
        "Use when the user needs specific how-to guidance, setup instructions, or best practices."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "What you need to know how to do (e.g. 'LoRA fine-tuning setup', 'GDPR compliance checklist', 'Playwright flaky test fixes')",
            },
            "domain": {
                "type": "string",
                "enum": ["ai_ml", "business", "engineering", "infra", "all"],
                "description": "Restrict to a specific domain (default: all)",
                "default": "all",
            },
            "limit": {
                "type": "integer",
                "description": "Max results to return (default: 3)",
                "default": 3,
            },
        },
        "required": ["query"],
    },
}


# ── Tool handler ──────────────────────────────────────────────────────────────
async def tool_handler(inputs: dict) -> dict:
    query  = inputs.get("query", "").strip()
    domain = inputs.get("domain", "all")
    limit  = min(int(inputs.get("limit", 3)), 10)

    if not query:
        return {"error": "query is required"}

    if not _SKILLS_DB.exists():
        return {
            "error": "Skills index not built yet",
            "hint": "Run: python backend/scripts/build_skills_index.py",
        }

    try:
        conn = sqlite3.connect(str(_SKILLS_DB))
        conn.row_factory = sqlite3.Row

        # Sanitize query for FTS5 — strip special chars that break the parser
        # Note: hyphens must be removed — FTS5 treats "-word" as NOT operator
        fts_query = " ".join(
            w for w in query.replace('"', "").replace("(", "").replace(")", "").replace("-", " ").split()
            if w
        )

        if domain and domain != "all":
            sql = """
                SELECT title, content, domain
                FROM skills_fts
                WHERE skills_fts MATCH ? AND domain = ?
                ORDER BY rank
                LIMIT ?
            """
            rows = conn.execute(sql, (fts_query, domain, limit)).fetchall()
        else:
            sql = """
                SELECT title, content, domain
                FROM skills_fts
                WHERE skills_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            """
            rows = conn.execute(sql, (fts_query, limit)).fetchall()

        conn.close()

        results = [
            {
                "title":   row["title"],
                "domain":  row["domain"],
                "content": row["content"],
            }
            for row in rows
        ]

        if not results:
            return {
                "results": [],
                "query":   query,
                "message": "No matching skills found. Try broader terms or a different domain.",
            }

        return {
            "results": results,
            "query":   query,
            "count":   len(results),
        }

    except Exception as exc:
        logger.error("[skills_tool] Query failed: %s", exc)
        return {"error": str(exc)}
