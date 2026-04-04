"""
AURA NX-Alpha — MindSearch-style Query Decomposer

Decomposes complex multi-concept queries into 2-4 focused sub-queries, then
runs them in parallel via asyncio.gather, deduplicating results by URL.

Simple queries pass through unchanged (single-element list) — zero overhead.

Usage:
    from app.knowledge.query_decomposer import parallel_search, decompose_query

    # In interface_agent.py web_search handler:
    search_fn = functools.partial(search, max_results=5)
    results = await parallel_search(query, search_fn)

    # In router.py auto_query():
    sub_queries = await decompose_query(query)
    for sq in sub_queries:
        hits = await local.multi_search(sources, sq)
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Callable, Awaitable

logger = logging.getLogger(__name__)

# Keywords that signal a query involves multiple concepts worth decomposing
_COMPLEXITY_KEYWORDS = frozenset({
    "compare", "comparison", "difference", "differences",
    "vs", "versus", "contrast", "similarities",
    "relationship between", "how does", "relate to",
    "pros and cons", "tradeoffs", "trade-offs",
    "explain the connection", "how do", "what is the relationship",
    "advantages and disadvantages",
})

# Ollama generate endpoint path
_GENERATE_PATH = "/api/generate"

# Prompt sent to the workhorse model
_DECOMPOSE_PROMPT = """\
You are a search query decomposer. Break the following complex query into 2-4 focused, \
specific sub-queries that together cover the full question.

Return ONLY a JSON array of strings. No explanation. No markdown. No extra text.

Example output: ["sub-query 1", "sub-query 2", "sub-query 3"]

Query: {query}"""


def _is_complex(query: str, min_length: int) -> bool:
    """Return True if the query is complex enough to warrant decomposition."""
    if len(query) > min_length:
        return True
    lower = query.lower()
    return any(kw in lower for kw in _COMPLEXITY_KEYWORDS)


def _parse_sub_queries(text: str, original: str) -> list[str]:
    """Parse LLM output into a list of sub-query strings. Falls back to [original]."""
    # Try strict JSON parse first
    text = text.strip()
    # Extract first JSON array found in the response
    match = re.search(r'\[.*?\]', text, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, list):
                valid = [s.strip() for s in parsed if isinstance(s, str) and s.strip()]
                if 1 <= len(valid) <= 6:
                    return valid
        except (json.JSONDecodeError, ValueError):
            pass

    # Fallback: extract quoted strings
    quoted = re.findall(r'"([^"]{5,})"', text)
    if quoted:
        return quoted[:4]

    return [original]


async def decompose_query(query: str) -> list[str]:
    """
    Break a complex query into sub-queries using the workhorse LLM.

    Returns [query] (unchanged) if:
    - query is simple / short
    - decomposer is disabled in config
    - Ollama is unreachable (timeout < 2s)
    - LLM output cannot be parsed
    """
    try:
        from app.config import get_settings
        cfg = get_settings()
        if not cfg.search.decomposer_enabled:
            return [query]
        if not _is_complex(query, cfg.search.decomposer_min_length):
            return [query]
    except Exception:
        return [query]

    try:
        import httpx
        from app.config import get_settings
        cfg = get_settings()
        ollama_host = cfg.workhorse.ollama_host
        model = cfg.workhorse.model

        payload = {
            "model": model,
            "prompt": _DECOMPOSE_PROMPT.format(query=query),
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 256},
        }

        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.post(
                f"{ollama_host}{_GENERATE_PATH}",
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            raw_text = data.get("response", "")

        sub_queries = _parse_sub_queries(raw_text, query)
        if len(sub_queries) > 1:
            logger.info(
                "[decomposer] %r → %d sub-queries: %s",
                query[:60], len(sub_queries),
                [sq[:40] for sq in sub_queries],
            )
        return sub_queries

    except Exception as exc:
        logger.debug("[decomposer] skipped (%s) — using original query", exc)
        return [query]


async def parallel_search(
    query: str,
    search_fn: Callable[[str], Awaitable[list[dict]]],
) -> list[dict]:
    """
    Decompose query into sub-queries and run them concurrently.

    Parameters
    ----------
    query:
        The original user query string.
    search_fn:
        Async callable that accepts a single query string and returns list[dict].
        Each dict must have at least a 'url' key for deduplication.

    Returns
    -------
    list[dict]
        Merged, URL-deduplicated results from all sub-queries.
        On total failure returns [].
    """
    sub_queries = await decompose_query(query)

    tasks = [asyncio.create_task(search_fn(sq)) for sq in sub_queries]
    results_lists = await asyncio.gather(*tasks, return_exceptions=True)

    seen_urls: set[str] = set()
    merged: list[dict] = []

    for result_list in results_lists:
        if isinstance(result_list, Exception):
            logger.warning("[decomposer] sub-query task failed: %s", result_list)
            continue
        for r in result_list:
            url = r.get("url", "")
            if url and url not in seen_urls:
                seen_urls.add(url)
                merged.append(r)
            elif not url:
                # No URL (e.g. FTS5 hits) — deduplicate by title instead
                title = r.get("title", "")
                if title and title not in seen_urls:
                    seen_urls.add(title)
                    merged.append(r)

    return merged
