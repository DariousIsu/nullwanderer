"""
AURA NX-Alpha — Legal Streaming (§3.5)
Streams legal data from external APIs. Zero local legal storage at Phase 1.

SOURCES:
    CourtListener   — Semantic search + full opinion text (free token required)
    CAP             — Caselaw Access Project 1658–2020 (case.law API key)
    Congress.gov    — Bills, resolutions, congressional records (free API key)
    GovInfo         — CFR, U.S. Code, Federal Register (optional key)
    Open States     — All 50 state legislative data (free API key)

Phase 2 upgrade path:
    When 4TB HDD is added, router.py sets LOCAL_LEGAL=True and routes
    to a local CourtListener 2TB embeddings index (Qdrant).
    No agent code changes required — router handles the switch transparently.
"""

import logging
from typing import Any, Optional

import httpx

from app.knowledge.cache import get_cache

logger = logging.getLogger(__name__)

COURTLISTENER_BASE = "https://www.courtlistener.com/api/rest/v4"
CONGRESS_BASE      = "https://api.congress.gov/v3"
GOVINFO_BASE       = "https://api.govinfo.gov"
OPENSTATES_BASE    = "https://v3.openstates.org"
CAP_BASE           = "https://api.case.law/v1"

TIMEOUT = httpx.Timeout(10.0, read=30.0)


# ─────────────────────────────────────────────────────────────────────────────
# LEGAL STREAM
# ─────────────────────────────────────────────────────────────────────────────

class LegalStream:
    """
    Streams legal content from public APIs.
    All responses are cached via APICache with source-specific TTL.
    Returns empty results gracefully if API keys are missing.
    """

    def __init__(self, settings=None):
        if settings is None:
            from app.config import get_settings
            settings = get_settings().knowledge
        self._cl_token      = settings.courtlistener_token
        self._congress_key  = settings.congress_api_key
        self._govinfo_key   = settings.govinfo_api_key
        self._openstates_key = settings.openstates_api_key
        self._caselaw_key   = settings.caselaw_api_key
        self._cache = get_cache()

    # ── CourtListener ─────────────────────────────────────────────────────────

    async def search_courtlistener(self, query: str, limit: int = 5) -> list[dict]:
        """
        Semantic search CourtListener opinions using modernbert-embed model.
        Uses same embedding model as their 2TB local bulk embeddings —
        query logic is identical whether streaming or local (Phase 2).
        """
        if not self._cl_token:
            logger.debug("[legal_stream] CourtListener token not configured")
            return []

        cache_key = f"cl_semantic:{query}:{limit}"
        cached = await self._cache.get("courtlistener", cache_key)
        if cached is not None:
            return cached

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                resp = await client.get(
                    f"{COURTLISTENER_BASE}/search/",
                    params={
                        "q":       query,
                        "type":    "o",          # opinions
                        "order_by": "score desc",
                        "stat_Precedential": "on",
                    },
                    headers={"Authorization": f"Token {self._cl_token}"},
                )
                resp.raise_for_status()
                data = resp.json()

            results = [
                {
                    "source":    "courtlistener",
                    "case_name": hit.get("caseName", ""),
                    "court":     hit.get("court", ""),
                    "date":      hit.get("dateFiled", ""),
                    "citation":  hit.get("citation", []),
                    "snippet":   hit.get("snippet", ""),
                    "url":       hit.get("absolute_url", ""),
                }
                for hit in data.get("results", [])[:limit]
            ]
            await self._cache.set("courtlistener", cache_key, results)
            return results

        except httpx.HTTPError as exc:
            logger.warning("[legal_stream] CourtListener request failed: %s", exc)
            return []

    # ── Congress.gov ──────────────────────────────────────────────────────────

    async def search_congress(self, query: str, limit: int = 5) -> list[dict]:
        """Search bills and resolutions from Congress.gov."""
        if not self._congress_key:
            logger.debug("[legal_stream] Congress.gov API key not configured")
            return []

        cache_key = f"congress:{query}:{limit}"
        cached = await self._cache.get("congress", cache_key)
        if cached is not None:
            return cached

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                resp = await client.get(
                    f"{CONGRESS_BASE}/bill",
                    params={
                        "query":   query,
                        "format":  "json",
                        "limit":   limit,
                        "api_key": self._congress_key,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            results = [
                {
                    "source":  "congress",
                    "title":   bill.get("title", ""),
                    "type":    bill.get("type", ""),
                    "number":  bill.get("number", ""),
                    "congress": bill.get("congress", ""),
                    "status":  bill.get("latestAction", {}).get("text", ""),
                    "url":     bill.get("url", ""),
                }
                for bill in data.get("bills", [])[:limit]
            ]
            await self._cache.set("congress", cache_key, results)
            return results

        except httpx.HTTPError as exc:
            logger.warning("[legal_stream] Congress.gov request failed: %s", exc)
            return []

    # ── Open States ───────────────────────────────────────────────────────────

    async def search_openstates(self, query: str, limit: int = 5) -> list[dict]:
        """Search state legislative bills from Open States (all 50 states)."""
        if not self._openstates_key:
            logger.debug("[legal_stream] Open States API key not configured")
            return []

        cache_key = f"openstates:{query}:{limit}"
        cached = await self._cache.get("openstates", cache_key)
        if cached is not None:
            return cached

        try:
            async with httpx.AsyncClient(timeout=TIMEOUT) as client:
                resp = await client.get(
                    f"{OPENSTATES_BASE}/bills",
                    params={
                        "q":             query,
                        "per_page":      limit,
                        "apikey":        self._openstates_key,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

            results = [
                {
                    "source":      "openstates",
                    "title":       bill.get("title", ""),
                    "jurisdiction": bill.get("jurisdiction", {}).get("name", ""),
                    "session":     bill.get("session", ""),
                    "identifier":  bill.get("identifier", ""),
                    "status":      bill.get("latest_action_description", ""),
                    "url":         bill.get("openstates_url", ""),
                }
                for bill in data.get("results", [])[:limit]
            ]
            await self._cache.set("openstates", cache_key, results)
            return results

        except httpx.HTTPError as exc:
            logger.warning("[legal_stream] Open States request failed: %s", exc)
            return []

    # ── Dispatch ──────────────────────────────────────────────────────────────

    async def search(self, query: str, limit: int = 5) -> list[dict]:
        """
        Route to the best available legal source.
        Priority: CourtListener → Congress.gov → Open States.
        Returns merged results up to `limit`.
        """
        import asyncio
        cl, cg, os_ = await asyncio.gather(
            self.search_courtlistener(query, limit),
            self.search_congress(query, limit),
            self.search_openstates(query, limit),
            return_exceptions=True,
        )
        results = []
        for source_results in (cl, cg, os_):
            if isinstance(source_results, list):
                results.extend(source_results)
        return results[:limit]


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_legal_stream: Optional[LegalStream] = None


def get_legal_stream() -> LegalStream:
    global _legal_stream
    if _legal_stream is None:
        _legal_stream = LegalStream()
    return _legal_stream
