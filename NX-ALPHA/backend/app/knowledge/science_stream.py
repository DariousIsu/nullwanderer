"""
AURA NX-Alpha — Science Streaming (§3.5)
Streams scientific literature from open APIs.
Used as overflow when local PubMed/arXiv FTS5 indices miss or for PDFs.

SOURCES:
    OpenAlex    — 330GB open scholarly works (no key required)
    NCBI        — PubMed daily updates (E-utilities, free)
    arXiv       — Full PDF temp-cache on demand
"""

import logging
from typing import Any, Optional

import httpx

from app.knowledge.cache import get_cache

logger = logging.getLogger(__name__)

OPENALEX_BASE = "https://api.openalex.org"
NCBI_BASE     = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
ARXIV_BASE    = "https://export.arxiv.org/api"

TIMEOUT = httpx.Timeout(10.0, read=30.0)

# OpenAlex polite pool (adds email to User-Agent per their docs)
OPENALEX_EMAIL = "aura-nx-alpha@local"


class ScienceStream:
    """Streams scientific literature from open APIs with API cache."""

    def __init__(self):
        self._cache = get_cache()

    # ── OpenAlex ──────────────────────────────────────────────────────────────

    async def search_openalex(self, query: str, limit: int = 5) -> list[dict]:
        """Search OpenAlex (330M scholarly works, no key required)."""
        cache_key = f"openalex:{query}:{limit}"
        cached = await self._cache.get("openalex", cache_key)
        if cached is not None:
            return cached

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                resp = await client.get(
                    f"{OPENALEX_BASE}/works",
                    params={
                        "search":   query,
                        "per-page": limit,
                        "select":   "id,title,abstract_inverted_index,authorships,publication_year,doi,primary_location",
                        "mailto":   OPENALEX_EMAIL,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            results = []
            for work in data.get("results", [])[:limit]:
                # Reconstruct abstract from inverted index (OpenAlex format)
                abstract = _reconstruct_abstract(work.get("abstract_inverted_index"))
                authors = [
                    a.get("author", {}).get("display_name", "")
                    for a in work.get("authorships", [])[:3]
                ]
                results.append({
                    "source":  "openalex",
                    "title":   work.get("title", ""),
                    "authors": authors,
                    "year":    work.get("publication_year"),
                    "doi":     work.get("doi", ""),
                    "abstract": abstract,
                    "url":     work.get("primary_location", {}).get("landing_page_url", ""),
                })

            await self._cache.set("openalex", cache_key, results)
            return results

        except httpx.HTTPError as exc:
            logger.warning("[science_stream] OpenAlex request failed: %s", exc)
            return []

    # ── NCBI PubMed ───────────────────────────────────────────────────────────

    async def search_pubmed(self, query: str, limit: int = 5) -> list[dict]:
        """
        Search PubMed via NCBI E-utilities.
        Two-step: esearch (get IDs) → efetch (get summaries).
        Used for daily updates beyond the local 2025 baseline.
        """
        cache_key = f"ncbi:{query}:{limit}"
        cached = await self._cache.get("ncbi", cache_key)
        if cached is not None:
            return cached

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                # Step 1 — search IDs
                search_resp = await client.get(
                    f"{NCBI_BASE}/esearch.fcgi",
                    params={
                        "db":       "pubmed",
                        "term":     query,
                        "retmax":   limit,
                        "retmode":  "json",
                        "sort":     "relevance",
                    },
                )
                search_resp.raise_for_status()
                search_data = search_resp.json()
                ids = search_data.get("esearchresult", {}).get("idlist", [])

                if not ids:
                    return []

                # Step 2 — fetch summaries
                fetch_resp = await client.get(
                    f"{NCBI_BASE}/esummary.fcgi",
                    params={
                        "db":      "pubmed",
                        "id":      ",".join(ids),
                        "retmode": "json",
                    },
                )
                fetch_resp.raise_for_status()
                fetch_data = fetch_resp.json()

            results = []
            uids = fetch_data.get("result", {}).get("uids", [])
            for uid in uids:
                item = fetch_data["result"].get(uid, {})
                results.append({
                    "source":   "ncbi",
                    "pmid":     uid,
                    "title":    item.get("title", ""),
                    "authors":  [a.get("name", "") for a in item.get("authors", [])[:3]],
                    "journal":  item.get("source", ""),
                    "pubdate":  item.get("pubdate", ""),
                    "url":      f"https://pubmed.ncbi.nlm.nih.gov/{uid}/",
                })

            await self._cache.set("ncbi", cache_key, results)
            return results

        except httpx.HTTPError as exc:
            logger.warning("[science_stream] NCBI request failed: %s", exc)
            return []

    # ── arXiv ─────────────────────────────────────────────────────────────────

    async def search_arxiv(self, query: str, limit: int = 5) -> list[dict]:
        """Search arXiv via Atom API. Used for preprints and post-cutoff papers."""
        cache_key = f"arxiv:{query}:{limit}"
        cached = await self._cache.get("arxiv", cache_key)
        if cached is not None:
            return cached

        try:
            import xml.etree.ElementTree as ET
            ns = {
                "atom": "http://www.w3.org/2005/Atom",
                "arxiv": "http://arxiv.org/schemas/atom",
            }

            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                resp = await client.get(
                    f"{ARXIV_BASE}/query",
                    params={
                        "search_query": f"all:{query}",
                        "start":        0,
                        "max_results":  limit,
                        "sortBy":       "relevance",
                    },
                )
                resp.raise_for_status()

            root = ET.fromstring(resp.text)
            results = []
            for entry in root.findall("atom:entry", ns):
                arxiv_id = entry.findtext("atom:id", "", ns).split("/abs/")[-1]
                results.append({
                    "source":    "arxiv",
                    "arxiv_id":  arxiv_id,
                    "title":     (entry.findtext("atom:title", "", ns) or "").strip(),
                    "authors":   [
                        a.findtext("atom:name", "", ns)
                        for a in entry.findall("atom:author", ns)
                    ][:3],
                    "abstract":  (entry.findtext("atom:summary", "", ns) or "").strip()[:500],
                    "published": entry.findtext("atom:published", "", ns)[:10],
                    "url":       f"https://arxiv.org/abs/{arxiv_id}",
                })

            await self._cache.set("arxiv", cache_key, results)
            return results

        except Exception as exc:
            logger.warning("[science_stream] arXiv request failed: %s", exc)
            return []

    # ── Dispatch ──────────────────────────────────────────────────────────────

    async def search(self, query: str, limit: int = 5) -> list[dict]:
        """Search all science sources in parallel and return merged results."""
        import asyncio
        oa, pm, ax = await asyncio.gather(
            self.search_openalex(query, limit),
            self.search_pubmed(query, limit),
            self.search_arxiv(query, limit),
            return_exceptions=True,
        )
        results = []
        for source_results in (oa, pm, ax):
            if isinstance(source_results, list):
                results.extend(source_results)
        return results[:limit]


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _reconstruct_abstract(inverted_index: Optional[dict]) -> str:
    """Reconstruct abstract text from OpenAlex inverted index format."""
    if not inverted_index:
        return ""
    try:
        words: dict[int, str] = {}
        for word, positions in inverted_index.items():
            for pos in positions:
                words[pos] = word
        return " ".join(words[i] for i in sorted(words))
    except Exception:
        return ""


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_science_stream: Optional[ScienceStream] = None


def get_science_stream() -> ScienceStream:
    global _science_stream
    if _science_stream is None:
        _science_stream = ScienceStream()
    return _science_stream
