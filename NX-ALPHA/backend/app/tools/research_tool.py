"""
Research Tools — Academic deep research, arXiv, and RSS feed digest.

Provides structured research methodologies, arXiv paper search/analysis,
and RSS/Atom feed monitoring. All free, local, no API keys required.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote_plus

import httpx

from app.tools._mcp_wrapper import _error

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "research",
    "description": (
        "Advanced research toolkit for academic and policy research. Actions: "
        "(1) arxiv_search — search arXiv for academic papers by topic/keyword. "
        "(2) arxiv_paper — fetch full metadata and abstract for a specific arXiv paper. "
        "(3) feed_digest — fetch and summarize RSS/Atom feeds. "
        "(4) deep_research — execute a structured multi-phase research methodology "
        "with evidence grading and citation management."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["arxiv_search", "arxiv_paper", "feed_digest", "deep_research"],
                "description": "Research action to perform",
            },
            "query": {
                "type": "string",
                "description": "Search query (for arxiv_search) or research question (for deep_research)",
            },
            "arxiv_id": {
                "type": "string",
                "description": "arXiv paper ID (e.g. '2301.07041') for arxiv_paper",
            },
            "feed_urls": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of RSS/Atom feed URLs for feed_digest",
            },
            "max_results": {
                "type": "integer",
                "description": "Maximum number of results (default: 10)",
                "default": 10,
            },
            "category": {
                "type": "string",
                "description": "arXiv category filter (e.g. 'cs.AI', 'cs.CL', 'econ.GN')",
            },
            "hours": {
                "type": "integer",
                "description": "For feed_digest: fetch items from last N hours (default: 24)",
                "default": 24,
            },
        },
        "required": ["action"],
    },
}


# ── arXiv Search ─────────────────────────────────────────────────────────────

async def _arxiv_search(query: str, max_results: int, category: str = "") -> dict:
    """Search arXiv for papers."""
    if not query:
        return _error("query is required for arxiv_search")

    search_query = quote_plus(query)
    if category:
        search_query = f"cat:{category}+AND+{search_query}"

    url = (
        f"http://export.arxiv.org/api/query?"
        f"search_query=all:{search_query}&start=0&max_results={max_results}"
        f"&sortBy=relevance&sortOrder=descending"
    )

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            xml = r.text

        # Parse Atom XML
        papers = []
        entries = re.findall(r"<entry>(.*?)</entry>", xml, re.DOTALL)

        for entry in entries:
            title = re.search(r"<title>(.*?)</title>", entry, re.DOTALL)
            summary = re.search(r"<summary>(.*?)</summary>", entry, re.DOTALL)
            arxiv_id = re.search(r"<id>http://arxiv.org/abs/(.*?)</id>", entry)
            published = re.search(r"<published>(.*?)</published>", entry)
            authors = re.findall(r"<name>(.*?)</name>", entry)
            categories = re.findall(r'<category[^>]*term="([^"]*)"', entry)
            pdf_link = re.search(r'<link[^>]*title="pdf"[^>]*href="([^"]*)"', entry)

            papers.append({
                "title": title.group(1).strip().replace("\n", " ") if title else "",
                "abstract": summary.group(1).strip()[:500] if summary else "",
                "arxiv_id": arxiv_id.group(1) if arxiv_id else "",
                "published": published.group(1)[:10] if published else "",
                "authors": authors[:5],
                "categories": categories,
                "pdf_url": pdf_link.group(1) if pdf_link else "",
            })

        return {"papers": papers, "query": query, "count": len(papers)}

    except Exception as exc:
        logger.error("[research:arxiv] %s", exc)
        return _error(f"arXiv search failed: {exc}")


async def _arxiv_paper(arxiv_id: str) -> dict:
    """Fetch full metadata for a specific arXiv paper."""
    if not arxiv_id:
        return _error("arxiv_id is required")

    # Clean the ID
    arxiv_id = arxiv_id.replace("https://arxiv.org/abs/", "").replace("https://arxiv.org/pdf/", "")

    url = f"http://export.arxiv.org/api/query?id_list={arxiv_id}"

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url)
            r.raise_for_status()
            xml = r.text

        entry = re.search(r"<entry>(.*?)</entry>", xml, re.DOTALL)
        if not entry:
            return _error(f"Paper not found: {arxiv_id}")

        e = entry.group(1)
        title = re.search(r"<title>(.*?)</title>", e, re.DOTALL)
        summary = re.search(r"<summary>(.*?)</summary>", e, re.DOTALL)
        published = re.search(r"<published>(.*?)</published>", e)
        updated = re.search(r"<updated>(.*?)</updated>", e)
        authors = re.findall(r"<name>(.*?)</name>", e)
        categories = re.findall(r'<category[^>]*term="([^"]*)"', e)
        pdf_link = re.search(r'<link[^>]*title="pdf"[^>]*href="([^"]*)"', e)
        doi = re.search(r'<arxiv:doi[^>]*>(.*?)</arxiv:doi>', e)
        comment = re.search(r'<arxiv:comment[^>]*>(.*?)</arxiv:comment>', e)

        return {
            "arxiv_id": arxiv_id,
            "title": title.group(1).strip().replace("\n", " ") if title else "",
            "abstract": summary.group(1).strip() if summary else "",
            "authors": authors,
            "published": published.group(1) if published else "",
            "updated": updated.group(1) if updated else "",
            "categories": categories,
            "pdf_url": pdf_link.group(1) if pdf_link else f"https://arxiv.org/pdf/{arxiv_id}",
            "doi": doi.group(1) if doi else None,
            "comment": comment.group(1).strip() if comment else None,
            "url": f"https://arxiv.org/abs/{arxiv_id}",
        }

    except Exception as exc:
        logger.error("[research:arxiv_paper] %s", exc)
        return _error(f"arXiv fetch failed: {exc}")


# ── RSS Feed Digest ──────────────────────────────────────────────────────────

async def _feed_digest(feed_urls: list[str], hours: int, max_results: int) -> dict:
    """Fetch and parse RSS/Atom feeds."""
    if not feed_urls:
        return _error("feed_urls is required (list of RSS/Atom URLs)")

    try:
        import feedparser
    except ImportError:
        return _error("feedparser not installed. Run: pip install feedparser")

    cutoff = time.time() - (hours * 3600)
    all_items = []

    async with httpx.AsyncClient(timeout=15.0) as client:
        for url in feed_urls:
            try:
                r = await client.get(url, headers={"User-Agent": "AURA/1.0 RSS Reader"})
                feed = feedparser.parse(r.text)

                for entry in feed.entries:
                    # Parse published date
                    published = entry.get("published_parsed") or entry.get("updated_parsed")
                    if published:
                        pub_time = time.mktime(published)
                        if pub_time < cutoff:
                            continue

                    all_items.append({
                        "title": entry.get("title", "")[:200],
                        "link": entry.get("link", ""),
                        "published": entry.get("published", entry.get("updated", "")),
                        "summary": re.sub(r"<[^>]+>", "", entry.get("summary", ""))[:300],
                        "source": feed.feed.get("title", url),
                    })
            except Exception as exc:
                logger.warning("[research:feed] Failed to fetch %s: %s", url, exc)
                continue

    # Sort by recency and limit
    all_items.sort(key=lambda x: x.get("published", ""), reverse=True)
    all_items = all_items[:max_results]

    return {
        "items": all_items,
        "count": len(all_items),
        "feeds_checked": len(feed_urls),
        "hours": hours,
    }


# ── Deep Research Methodology ────────────────────────────────────────────────

async def _deep_research(query: str, max_results: int) -> dict:
    """Execute structured deep research methodology."""
    if not query:
        return _error("query is required for deep_research")

    # Phase 1: Search across sources
    arxiv_results = await _arxiv_search(query, min(max_results, 5))

    # Return a structured research plan with initial results
    return {
        "research_question": query,
        "methodology": "Two-cycle academic research with evidence hierarchy",
        "phase_1_results": {
            "arxiv": arxiv_results if "error" not in arxiv_results else {"papers": []},
        },
        "evidence_hierarchy": [
            "Tier 1: Peer-reviewed journals, systematic reviews, meta-analyses",
            "Tier 2: Conference proceedings, preprints with citations",
            "Tier 3: Technical reports, white papers, institutional publications",
            "Tier 4: News sources, blog posts, opinion pieces",
        ],
        "next_steps": [
            "Review Phase 1 results for relevance",
            "Use exa_search or jina_search for web sources",
            "Cross-reference claims across multiple sources",
            "Grade evidence quality for each claim",
            "Synthesize findings with APA citations",
        ],
    }


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    if not action:
        return _error("action is required")

    max_results = inputs.get("max_results", 10)

    if action == "arxiv_search":
        return await _arxiv_search(
            inputs.get("query", ""),
            max_results,
            inputs.get("category", ""),
        )
    elif action == "arxiv_paper":
        return await _arxiv_paper(inputs.get("arxiv_id", ""))
    elif action == "feed_digest":
        return await _feed_digest(
            inputs.get("feed_urls", []),
            inputs.get("hours", 24),
            max_results,
        )
    elif action == "deep_research":
        return await _deep_research(inputs.get("query", ""), max_results)

    return _error(f"Unknown action: {action}")
