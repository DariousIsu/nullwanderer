"""
AURA NX-Alpha — Overflow Streaming (§3.5)
General knowledge fallbacks when local ZIM/FTS5 misses.

SOURCES:
    Wikipedia REST API    — Post-snapshot articles (local ZIM is the primary)
    Wikidata SPARQL       — Entity/relationship queries
    Common Crawl          — Byte-range fetch for arbitrary web content
"""

import logging
from typing import Any, Optional

import httpx

from app.knowledge.cache import get_cache

logger = logging.getLogger(__name__)

WIKIPEDIA_API_BASE  = "https://en.wikipedia.org/api/rest_v1"
WIKIDATA_SPARQL_URL = "https://query.wikidata.org/sparql"
COMMON_CRAWL_INDEX  = "https://index.commoncrawl.org"

TIMEOUT = httpx.Timeout(8.0, read=20.0)


class OverflowStream:
    """
    Fallback knowledge sources for queries not covered by local data.
    All responses cached with long TTLs (encyclopedia content is stable).
    """

    def __init__(self):
        self._cache = get_cache()

    # ── Wikipedia REST API ────────────────────────────────────────────────────

    async def search_wikipedia(self, query: str, limit: int = 3) -> list[dict]:
        """
        Search Wikipedia via REST API.
        Used for articles published after the local ZIM snapshot date.
        """
        cache_key = f"wikipedia_api:{query}:{limit}"
        cached = await self._cache.get("wikipedia_api", cache_key)
        if cached is not None:
            return cached

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                resp = await client.get(
                    f"{WIKIPEDIA_API_BASE}/page/search/page",
                    params={"q": query, "limit": limit},
                    headers={"User-Agent": "AURA-NX-Alpha/0.1 (local desktop application)"},
                )
                resp.raise_for_status()
                data = resp.json()

            results = [
                {
                    "source":   "wikipedia_api",
                    "title":    page.get("title", ""),
                    "excerpt":  page.get("excerpt", ""),
                    "url":      f"https://en.wikipedia.org/wiki/{page.get('key', '')}",
                    "thumbnail": page.get("thumbnail", {}).get("url", ""),
                }
                for page in data.get("pages", [])[:limit]
            ]

            await self._cache.set("wikipedia_api", cache_key, results)
            return results

        except httpx.HTTPError as exc:
            logger.warning("[overflow_stream] Wikipedia API failed: %s", exc)
            return []

    async def get_wikipedia_summary(self, title: str) -> Optional[dict]:
        """Fetch the summary section of a specific Wikipedia article."""
        cache_key = f"wikipedia_summary:{title}"
        cached = await self._cache.get("wikipedia_api", cache_key)
        if cached is not None:
            return cached

        try:
            import urllib.parse
            encoded = urllib.parse.quote(title.replace(" ", "_"))
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                resp = await client.get(
                    f"{WIKIPEDIA_API_BASE}/page/summary/{encoded}",
                    headers={"User-Agent": "AURA-NX-Alpha/0.1 (local desktop application)"},
                )
                resp.raise_for_status()
                data = resp.json()

            result = {
                "source":  "wikipedia_api",
                "title":   data.get("title", ""),
                "extract": data.get("extract", ""),
                "url":     data.get("content_urls", {}).get("desktop", {}).get("page", ""),
            }
            await self._cache.set("wikipedia_api", cache_key, result)
            return result

        except httpx.HTTPError as exc:
            logger.warning("[overflow_stream] Wikipedia summary fetch failed: %s", exc)
            return None

    # ── Wikidata SPARQL ───────────────────────────────────────────────────────

    async def query_wikidata(self, sparql: str) -> list[dict]:
        """
        Execute a SPARQL query against Wikidata public endpoint.
        Use for entity lookups, relationship traversal, property lookups.
        Rate limit: be considerate — results are cached with 7-day TTL.
        """
        cache_key = f"wikidata_sparql:{sparql[:200]}"
        cached = await self._cache.get("wikidata_sparql", cache_key)
        if cached is not None:
            return cached

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                resp = await client.get(
                    WIKIDATA_SPARQL_URL,
                    params={"query": sparql, "format": "json"},
                    headers={
                        "User-Agent": "AURA-NX-Alpha/0.1 (local desktop application)",
                        "Accept": "application/sparql-results+json",
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            bindings = data.get("results", {}).get("bindings", [])
            results = [
                {k: v.get("value", "") for k, v in binding.items()}
                for binding in bindings
            ]
            await self._cache.set("wikidata_sparql", cache_key, results)
            return results

        except Exception as exc:
            logger.warning("[overflow_stream] Wikidata SPARQL failed: %s", exc)
            return []

    async def lookup_entity(self, entity_name: str) -> list[dict]:
        """
        Simplified Wikidata entity lookup by label.
        Returns basic facts: description, aliases, notable properties.
        """
        sparql = f"""
        SELECT ?item ?itemLabel ?itemDescription WHERE {{
            ?item wikibase:sitelinks ?sitelinks .
            SERVICE wikibase:mwapi {{
                bd:serviceParam wikibase:endpoint "www.wikidata.org";
                                wikibase:api "EntitySearch";
                                mwapi:search "{entity_name}";
                                mwapi:language "en".
                ?item wikibase:apiOutputItem mwapi:item.
            }}
            SERVICE wikibase:label {{ bd:serviceParam wikibase:language "en". }}
        }}
        LIMIT 5
        """
        return await self.query_wikidata(sparql)

    # ── Common Crawl ──────────────────────────────────────────────────────────

    async def fetch_common_crawl(self, url: str, crawl: str = "CC-MAIN-2024-10") -> Optional[str]:
        """
        Fetch page content from Common Crawl via byte-range lookup.
        Use sparingly — high latency (500ms–2s).
        """
        cache_key = f"common_crawl:{url}"
        cached = await self._cache.get("common_crawl", cache_key)
        if cached is not None:
            return cached.get("text")

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                # Step 1 — look up index entry
                index_resp = await client.get(
                    f"{COMMON_CRAWL_INDEX}/{crawl}-index",
                    params={"url": url, "output": "json"},
                )
                if index_resp.status_code != 200:
                    return None

                import json
                entry = json.loads(index_resp.text.splitlines()[0])
                filename = entry.get("filename", "")
                offset   = int(entry.get("offset", 0))
                length   = int(entry.get("length", 0))

                if not filename:
                    return None

                # Step 2 — byte-range fetch from S3
                s3_url = f"https://data.commoncrawl.org/{filename}"
                warc_resp = await client.get(
                    s3_url,
                    headers={"Range": f"bytes={offset}-{offset + length - 1}"},
                )
                warc_resp.raise_for_status()

                # Extract text content from WARC
                text = _extract_warc_text(warc_resp.content)

            if text:
                await self._cache.set("common_crawl", cache_key, {"text": text})
            return text

        except Exception as exc:
            logger.warning("[overflow_stream] Common Crawl fetch failed for %s: %s", url, exc)
            return None

    # ── Dispatch ──────────────────────────────────────────────────────────────

    async def search(self, query: str, limit: int = 5) -> list[dict]:
        """Wikipedia API search as primary overflow."""
        return await self.search_wikipedia(query, limit)


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _extract_warc_text(warc_bytes: bytes) -> str:
    """Extract HTTP response body text from a WARC record."""
    try:
        import gzip
        import io

        # WARC records may be gzip-compressed
        if warc_bytes[:2] == b"\x1f\x8b":
            warc_bytes = gzip.decompress(warc_bytes)

        text = warc_bytes.decode("utf-8", errors="replace")
        # Skip WARC/HTTP headers — find double blank line
        parts = text.split("\r\n\r\n", 2)
        return parts[-1][:4000] if len(parts) >= 2 else ""
    except Exception:
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_overflow_stream: Optional[OverflowStream] = None


def get_overflow_stream() -> OverflowStream:
    global _overflow_stream
    if _overflow_stream is None:
        _overflow_stream = OverflowStream()
    return _overflow_stream
