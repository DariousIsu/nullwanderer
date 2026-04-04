"""
AURA NX-Alpha — Knowledge Router (§3.5)
Central query dispatcher. The ONLY data ingress for agents.
Agents call route(query, context) and receive a normalized result dict.

ROUTING PRIORITY:
    1. Legal keywords detected → legal_stream.py (always streamed — zero local legal storage)
    2. Science keywords         → local PubMed/arXiv FTS5 → science_stream if miss
    3. General knowledge        → local Wikipedia/StackExchange FTS5 → overflow if miss
    4. Fallback                 → Wikipedia REST API

CACHE:
    All stream calls check cache.py first.
    Cache misses are written back with source-specific TTL.
    Local FTS5 hits are NOT cached (sub-100ms, on-disk).

RESULT FORMAT:
    {
        "source":  str,             # e.g. "local_wikipedia", "courtlistener", "cache"
        "results": list[dict],      # normalized result records
        "query":   str,             # original query (for traceability)
        "cached":  bool,
    }
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# KEYWORD SIGNALS
# ─────────────────────────────────────────────────────────────────────────────

LEGAL_KEYWORDS = frozenset({
    "law", "statute", "regulation", "court", "case", "opinion",
    "ruling", "judge", "plaintiff", "defendant", "cfr", "usc",
    "congress", "senate", "legislature", "bill", "act",
    "election", "vote", "ballot", "amendment", "constitution",
    "legal", "attorney", "lawsuit", "litigation", "precedent",
    "jurisdiction", "appellate", "circuit", "supreme court",
})

SCIENCE_KEYWORDS = frozenset({
    "study", "research", "trial", "pubmed", "arxiv", "doi",
    "journal", "paper", "abstract", "clinical", "medline",
    "biology", "chemistry", "physics", "medicine", "genome",
    "experiment", "hypothesis", "methodology", "peer reviewed",
    "meta-analysis", "cohort", "randomized",
})


def _has_keywords(text: str, keywords: frozenset) -> bool:
    lower = text.lower()
    return any(kw in lower for kw in keywords)


# ─────────────────────────────────────────────────────────────────────────────
# ROUTER
# ─────────────────────────────────────────────────────────────────────────────

async def route(query: str, context: str = "") -> dict:
    """
    Main entry point. Route query to the appropriate knowledge source.
    Called by agents in the research bundle via knowledge_router tool.

    Args:
        query:   The search query string.
        context: Optional additional context (category_path, topic) for routing hints.

    Returns:
        {
            "source":  str,         # which source served the result
            "results": list[dict],  # normalized records
            "query":   str,
            "cached":  bool,
        }
    """
    combined = f"{query} {context}".strip()

    # ── Route 1: Legal ────────────────────────────────────────────────────────
    if _has_keywords(combined, LEGAL_KEYWORDS):
        return await _route_legal(query)

    # ── Route 2: Science ─────────────────────────────────────────────────────
    if _has_keywords(combined, SCIENCE_KEYWORDS):
        return await _route_science(query)

    # ── Route 3: General knowledge ────────────────────────────────────────────
    return await _route_general(query)


async def _route_legal(query: str) -> dict:
    """Legal: always stream (zero local legal footprint at Phase 1)."""
    from app.knowledge.cache import get_cache
    from app.knowledge.legal_stream import get_legal_stream

    cache = get_cache()
    cache_key = f"route_legal:{query}"
    cached = await cache.get("route_legal", cache_key)
    if cached is not None:
        return {"source": "cache", "results": cached, "query": query, "cached": True}

    legal = get_legal_stream()
    results = await legal.search(query)

    if results:
        await cache.set("route_legal", cache_key, results)
        return {"source": "legal_stream", "results": results, "query": query, "cached": False}

    # Fallback: overflow Wikipedia API (may have legal article summaries)
    return await _overflow_fallback(query)


async def _route_science(query: str) -> dict:
    """Science: local FTS5 first, stream on miss."""
    from app.knowledge.local_search import get_local_search
    from app.knowledge.science_stream import get_science_stream

    local = get_local_search()

    # Try local PubMed + arXiv FTS5
    local_results = await local.multi_search(["pubmed", "arxiv"], query, limit_per_source=3)
    hits = local_results.get("pubmed", []) + local_results.get("arxiv", [])

    if hits:
        return {"source": "local_science", "results": hits, "query": query, "cached": False}

    # Miss — stream from OpenAlex/NCBI/arXiv APIs
    science = get_science_stream()
    results = await science.search(query)

    if results:
        return {"source": "science_stream", "results": results, "query": query, "cached": False}

    return await _overflow_fallback(query)


async def _route_general(query: str) -> dict:
    """General: local Wikipedia/StackExchange FTS5, then overflow API."""
    from app.knowledge.local_search import get_local_search

    local = get_local_search()

    # Try local Wikipedia + StackExchange
    local_results = await local.multi_search(["wikipedia", "stackexchange"], query, limit_per_source=3)
    hits = local_results.get("wikipedia", []) + local_results.get("stackexchange", [])

    if hits:
        source = "local_wikipedia" if local_results.get("wikipedia") else "local_stackexchange"
        return {"source": source, "results": hits, "query": query, "cached": False}

    # Miss — overflow to Wikipedia REST API
    return await _overflow_fallback(query)


def _format_knowledge(results: list, max_tokens: int) -> str:
    """Format knowledge results into a compact context string within token budget."""
    lines = []
    char_budget = max_tokens * 4  # rough chars-per-token estimate
    used = 0
    for i, r in enumerate(results, 1):
        content = (
            r.get("content") or r.get("body") or r.get("abstract")
            or r.get("snippet") or r.get("text") or ""
        )[:500]
        title = r.get("title", "")
        source = r.get("source", r.get("collection", "knowledge"))
        entry = f"[{title}] {content}" if title else content
        line = f"  [{i}] {entry} [src: {source}]"
        if used + len(line) > char_budget:
            break
        lines.append(line)
        used += len(line)
    if not lines:
        return ""
    return "LOCAL KNOWLEDGE BASE (auto-retrieved):\n" + "\n".join(lines)


async def auto_query(query: str, max_tokens: int = 1500) -> str:
    """
    Always-on knowledge retrieval. Runs for every interface message.
    Uses local FTS5 index only — no network calls, no latency spike.
    Falls back silently if knowledge store is unavailable.

    Complex queries are decomposed into sub-queries (via query_decomposer) and
    each is searched in parallel. Results are deduplicated by title.
    """
    try:
        from app.knowledge.local_search import get_local_search
        from app.knowledge.query_decomposer import decompose_query
        local = get_local_search()
        sources = local.available_sources()
        if not sources:
            return ""

        sub_queries = await decompose_query(query)

        all_results: list[dict] = []
        seen_titles: set[str] = set()
        for sq in sub_queries:
            raw = await local.multi_search(sources, sq, limit_per_source=3)
            for src, hits in raw.items():
                for hit in hits:
                    title = hit.get("title", "")
                    if title and title not in seen_titles:
                        seen_titles.add(title)
                        hit["source"] = src
                        all_results.append(hit)
                    elif not title:
                        hit["source"] = src
                        all_results.append(hit)

        if not all_results:
            return ""
        return _format_knowledge(all_results, max_tokens)
    except Exception:
        return ""


async def _overflow_fallback(query: str) -> dict:
    """Last resort: Wikipedia REST API."""
    from app.knowledge.overflow_stream import get_overflow_stream

    overflow = get_overflow_stream()
    results = await overflow.search(query)

    return {
        "source":  "overflow_wikipedia" if results else "no_results",
        "results": results,
        "query":   query,
        "cached":  False,
    }
