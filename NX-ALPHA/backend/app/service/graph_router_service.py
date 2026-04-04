"""
graph_router_service.py
────────────────────────
Phase 6 — Graph-based tool and skill pre-selection.

Pre-flight query against Neo4j to identify 2-3 relevant tools and 1-2 skill
chunks before prompt assembly. Replaces the static 30-tool MCP awareness dump
with a query-specific, compact context injection (~600-800 chars vs ~4.8KB).

Architecture:
  1. Extract keywords from query (fast, no LLM)
  2. Neo4j full-text search on :Tool nodes → top 3 by relevance
  3. FTS5 skills DB search → top 2 skill excerpts
  4. Return compact context string for injection into system prompt

Graceful fallback:
  - If Neo4j is unavailable → skip tool pre-selection
  - If skills DB missing → skip skills pre-selection
  - If both fail → return empty string (caller falls back to static tool list)

Usage (in interface_agent.py):
    from app.service.graph_router_service import get_relevant_context
    ctx = await get_relevant_context(query)
    # Inject ctx into prompt as "GRAPH-ROUTED CONTEXT" section
"""

from __future__ import annotations

import asyncio
import logging
import re
import sqlite3
from functools import lru_cache
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
NEO4J_URI      = "bolt://localhost:7687"
NEO4J_USER     = "neo4j"
NEO4J_PASSWORD = "aurapassword"
NEO4J_DATABASE = "neo4j"
SKILLS_DB      = Path.home() / ".aura" / "knowledge" / "skills" / "fts5.db"

# Max chars for the returned context string
_MAX_CONTEXT_CHARS = 800

# Stop words to strip before keyword matching
_STOP = frozenset({
    "a", "an", "the", "is", "in", "on", "at", "to", "of", "and", "or",
    "how", "do", "you", "can", "be", "was", "are", "what", "why", "when",
    "where", "who", "which", "that", "this", "it", "its", "for", "with",
    "by", "from", "about", "should", "would", "could", "will", "does",
    "me", "my", "we", "our", "your", "their", "did", "has", "have", "had",
    "i", "he", "she", "they", "us", "him", "her", "them", "give", "tell",
    "please", "some", "any", "all", "not", "no", "so", "if", "but", "use",
    "using", "used", "need", "want", "get", "make", "show", "help",
})


def _extract_keywords(query: str) -> list[str]:
    """Extract meaningful keywords from query — fast, no LLM."""
    words = re.findall(r'\b[a-zA-Z][a-zA-Z0-9_-]{2,}\b', query.lower())
    return [w for w in words if w not in _STOP][:10]


async def _query_neo4j_tools(keywords: list[str]) -> list[dict]:
    """
    Search Neo4j :Tool nodes using full-text index (Community 5.x supports this).
    Returns list of {name, description, domain} dicts.
    Falls back to simple property matching if full-text index not created.
    """
    if not keywords:
        return []

    try:
        from neo4j import AsyncGraphDatabase
    except ImportError:
        return []

    driver = AsyncGraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
    try:
        await asyncio.wait_for(driver.verify_connectivity(), timeout=2.0)
    except Exception:
        await driver.close()
        return []

    results = []
    try:
        async with driver.session(database=NEO4J_DATABASE) as session:
            # Try full-text index first (requires CALL db.index.fulltext.queryNodes)
            kw_str = " ".join(keywords[:5])

            try:
                # Ensure full-text index exists
                await session.run(
                    "CREATE FULLTEXT INDEX tool_fulltext IF NOT EXISTS "
                    "FOR (t:Tool) ON EACH [t.name, t.description]"
                )
            except Exception:
                pass  # May already exist or unsupported — continue

            try:
                records = await session.run(
                    """
                    CALL db.index.fulltext.queryNodes('tool_fulltext', $query)
                    YIELD node, score
                    RETURN node.name AS name, node.description AS description, node.domain AS domain, score
                    ORDER BY score DESC
                    LIMIT 3
                    """,
                    query=kw_str,
                )
                async for record in records:
                    results.append({
                        "name":        record["name"],
                        "description": (record["description"] or "")[:120],
                        "domain":      record["domain"] or "",
                    })
            except Exception:
                # Fallback: simple CONTAINS match on name
                for kw in keywords[:3]:
                    try:
                        records = await session.run(
                            """
                            MATCH (t:Tool)
                            WHERE toLower(t.name) CONTAINS $kw OR toLower(t.description) CONTAINS $kw
                            RETURN t.name AS name, t.description AS description, t.domain AS domain
                            LIMIT 2
                            """,
                            kw=kw,
                        )
                        async for record in records:
                            entry = {
                                "name":        record["name"],
                                "description": (record["description"] or "")[:120],
                                "domain":      record["domain"] or "",
                            }
                            if entry not in results:
                                results.append(entry)
                        if len(results) >= 3:
                            break
                    except Exception:
                        pass

    except Exception as exc:
        logger.debug("[graph_router] Neo4j tool query failed: %s", exc)
    finally:
        await driver.close()

    return results[:3]


def _query_skills_fts(keywords: list[str]) -> list[dict]:
    """Search local skills FTS5 for relevant chunks. Sync — fast SQLite."""
    if not keywords or not SKILLS_DB.exists():
        return []

    try:
        conn = sqlite3.connect(str(SKILLS_DB))
        conn.row_factory = sqlite3.Row
        kw_str = " ".join(keywords[:5])
        rows = conn.execute(
            "SELECT title, content, domain FROM skills_fts WHERE skills_fts MATCH ? ORDER BY rank LIMIT 2",
            (kw_str,),
        ).fetchall()
        conn.close()
        return [
            {
                "title":   row["title"],
                "domain":  row["domain"],
                "excerpt": row["content"][:200],
            }
            for row in rows
        ]
    except Exception as exc:
        logger.debug("[graph_router] Skills FTS query failed: %s", exc)
        return []


def _format_context(tools: list[dict], skills: list[dict]) -> str:
    """Format tool + skill results into a compact context string."""
    if not tools and not skills:
        return ""

    lines = ["GRAPH-ROUTED CONTEXT (pre-selected for this query):"]

    if tools:
        lines.append("Relevant tools:")
        for t in tools:
            desc = t.get("description", "").strip()
            lines.append(f"  {t['name']} [{t.get('domain','')}] — {desc}")

    if skills:
        lines.append("Relevant skills KB:")
        for s in skills:
            lines.append(f"  [{s['domain']}] {s['title']}: {s['excerpt'].strip()}")

    result = "\n".join(lines)
    # Truncate to max chars
    if len(result) > _MAX_CONTEXT_CHARS:
        result = result[:_MAX_CONTEXT_CHARS - 3] + "..."
    return result + "\n"


async def get_relevant_context(query: str) -> str:
    """
    Main entry point — called from interface_agent._build_system_prompt().

    Returns a compact context string (~600-800 chars) with the 2-3 most
    relevant tools and 1-2 skill excerpts for the given query.
    Returns empty string on any failure — never blocks prompt assembly.
    """
    if not query or len(query.strip()) < 10:
        return ""

    try:
        keywords = _extract_keywords(query)
        if not keywords:
            return ""

        # Run Neo4j tool lookup async, skills lookup sync (fast)
        tools_coro = _query_neo4j_tools(keywords)
        loop       = asyncio.get_event_loop()
        skills     = await loop.run_in_executor(None, _query_skills_fts, keywords)

        tools = await asyncio.wait_for(tools_coro, timeout=2.5)

        return _format_context(tools, skills)

    except asyncio.TimeoutError:
        logger.debug("[graph_router] Graph lookup timed out — skipping context injection")
        return ""
    except Exception as exc:
        logger.debug("[graph_router] get_relevant_context failed: %s", exc)
        return ""
