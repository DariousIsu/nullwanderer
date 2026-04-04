"""
Open Access Resolver — AURA MCP Tool

Finds legal, free full-text for paywalled or restricted sources.
Can be called independently by AURA (or any agent) AND is imported
by citation_verifier.py for its internal resolution pipeline.

Resolution chain (in priority order):
  1. Semantic Scholar  — openAccessPdf field (arXiv, PubMed Central, etc.)
  2. Unpaywall         — crowdsourced OA index, prefers PDF copies
  3. CrossRef          — publisher landing page / direct PDF link
  4. CORE API          — 200M+ OA records from institutional repositories
  5. Wayback Machine   — latest saved snapshot (archive.org)
  6. archive.ph        — community snapshots, often more recent for news

DOI extraction from page HTML meta tags lets us unlock the full OA chain
for plain-URL citations that weren't cited by DOI in the source document.
"""

import asyncio
import io
import logging
import re
import urllib.parse
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

# ── Constants ─────────────────────────────────────────────────────────────────

_API_TIMEOUT    = 10.0
_MAX_CHARS      = 50_000

_CROSSREF_URL         = "https://api.crossref.org/works/{doi}"
_UNPAYWALL_URL        = "https://api.unpaywall.org/v2/{doi}?email=citation-bot@aura.local"
_SEMANTIC_SCHOLAR_URL = (
    "https://api.semanticscholar.org/graph/v1/paper/{doi}"
    "?fields=openAccessPdf,title,abstract,externalIds"
)
_CORE_SEARCH_URL      = "https://api.core.ac.uk/v3/search/works?q=doi%3A{doi}&limit=1"

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

# Matches DOI in HTML meta tags (citation_doi, DC.Identifier) and JSON-LD
_META_DOI_RE = re.compile(
    r'(?:'
    r'<meta[^>]+(?:name|property)=["\'](?:citation_doi|DC\.Identifier|doi)["\']'
    r'[^>]+content=["\']'
    r'|<meta[^>]+content=["\'][^"\']*["\'][^>]+(?:name|property)=["\']'
    r'(?:citation_doi|DC\.Identifier)["\']'
    r'|"doi"\s*:\s*"'
    r')(10\.\d{4,9}/[^\s"\'<>]+)',
    re.IGNORECASE,
)


# ── Core async functions (imported by citation_verifier) ──────────────────────

async def resolve_doi(doi: str) -> Optional[str]:
    """
    Resolve a DOI to the best reachable open-access URL.
    Order: Semantic Scholar → Unpaywall → CrossRef.
    Returns a URL string or None if all sources fail.
    """
    clean = doi.lstrip("https://doi.org/").lstrip("http://doi.org/")

    async with httpx.AsyncClient(timeout=_API_TIMEOUT, follow_redirects=True) as client:

        # 1. Semantic Scholar — direct OA PDF links (arXiv, PMC, institutional repos)
        try:
            resp = await client.get(
                _SEMANTIC_SCHOLAR_URL.format(doi=clean),
                headers={"User-Agent": "open-access-resolver/1.0 (research tool)"},
            )
            if resp.status_code == 200:
                oa = resp.json().get("openAccessPdf") or {}
                if oa.get("url"):
                    logger.debug("[oa] Semantic Scholar OA: %s", oa["url"][:80])
                    return oa["url"]
        except Exception as exc:
            logger.debug("[oa] Semantic Scholar failed for %s: %s", doi, exc)

        # 2. Unpaywall — OA index, excellent for journal articles
        try:
            resp = await client.get(_UNPAYWALL_URL.format(doi=clean))
            if resp.status_code == 200:
                best = resp.json().get("best_oa_location") or {}
                url = best.get("url_for_pdf") or best.get("url")
                if url:
                    logger.debug("[oa] Unpaywall OA: %s", url[:80])
                    return url
        except Exception as exc:
            logger.debug("[oa] Unpaywall failed for %s: %s", doi, exc)

        # 3. CrossRef — publisher landing page (may still be paywalled, but gives a URL)
        try:
            resp = await client.get(_CROSSREF_URL.format(doi=clean))
            if resp.status_code == 200:
                msg = resp.json().get("message", {})
                for link in msg.get("link", []):
                    if link.get("content-type") in ("text/html", "application/pdf"):
                        return link["URL"]
                return msg.get("URL") or f"https://doi.org/{doi}"
        except Exception as exc:
            logger.debug("[oa] CrossRef failed for %s: %s", doi, exc)

    return None


async def core_fetch_by_doi(doi: str) -> tuple[Optional[str], Optional[str]]:
    """
    Query the CORE aggregator for open-access full text by DOI.
    CORE indexes 200M+ OA records from institutional repositories worldwide.
    Returns (text, title) or (None, None).
    """
    clean = doi.lstrip("https://doi.org/").lstrip("http://doi.org/")
    try:
        encoded = urllib.parse.quote(clean, safe="")
        async with httpx.AsyncClient(timeout=_API_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(
                _CORE_SEARCH_URL.format(doi=encoded),
                headers={"User-Agent": "open-access-resolver/1.0 (research tool)"},
            )
        if resp.status_code != 200:
            return None, None
        results = resp.json().get("results") or []
        if not results:
            return None, None
        item = results[0]
        full_text = item.get("fullText") or item.get("abstract") or ""
        title = item.get("title")
        if full_text and len(full_text) > 100:
            logger.info("[oa] CORE: %d chars for DOI %s", len(full_text), clean)
            return full_text[:_MAX_CHARS], title
    except Exception as exc:
        logger.debug("[oa] CORE failed for %s: %s", doi, exc)
    return None, None


async def extract_doi_from_url(url: str) -> Optional[str]:
    """
    Fetch the HTML head of a paywalled page and extract a DOI from:
      - <meta name="citation_doi" content="...">
      - <meta name="DC.Identifier" content="...">
      - JSON-LD "doi": "..."

    Returns a DOI string (e.g. '10.1234/xyz') or None.
    Unlocks the full OA chain (CORE, Semantic Scholar, Unpaywall) for
    plain-URL citations that weren't cited by DOI in the source document.
    """
    try:
        async with httpx.AsyncClient(timeout=8.0, follow_redirects=True) as client:
            resp = await client.get(
                url, headers={"User-Agent": _UA, "Accept": "text/html,application/xhtml+xml"},
            )
        if resp.status_code != 200:
            return None
        m = _META_DOI_RE.search(resp.text[:8000])
        if m:
            doi = m.group(1).rstrip("\"'.,;)")
            logger.debug("[oa] DOI extracted from %s: %s", url[:60], doi)
            return doi
    except Exception as exc:
        logger.debug("[oa] DOI extraction failed for %s: %s", url, exc)
    return None


async def fetch_pdf_text(url: str) -> tuple[Optional[str], Optional[str]]:
    """
    Download a PDF from a URL and extract its full text.
    Returns (text, title) or (None, None).
    """
    try:
        from pypdf import PdfReader
        async with httpx.AsyncClient(timeout=_API_TIMEOUT, follow_redirects=True) as client:
            resp = await client.get(url)
        if resp.status_code != 200:
            return None, None
        text = "".join(
            page.extract_text() or ""
            for page in PdfReader(io.BytesIO(resp.content)).pages
        )
        title = Path(url.split("?")[0]).stem.replace("-", " ").replace("_", " ")
        return (text[:_MAX_CHARS] if text.strip() else None), title
    except Exception as exc:
        logger.debug("[oa] PDF fetch failed for %s: %s", url, exc)
        return None, None


async def fetch_via_archives(
    url: str,
    doi: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """
    Try every available open-access and archive source for a URL.

    Resolution order:
      1. CORE API (DOI required)       — 200M+ OA repository full texts
      2. Semantic Scholar OA PDF       — DOI → legal OA PDF → download + extract
      3. Wayback Machine               — latest saved snapshot (archive.org)
      4. archive.ph                    — community snapshots, more recent for news

    Returns (text, title) or (None, None) if all sources fail.
    """
    if doi:
        # 1. CORE
        text, title = await core_fetch_by_doi(doi)
        if text:
            return text, title

        # 2. Semantic Scholar → OA PDF download
        try:
            oa_url = await resolve_doi(doi)
            if oa_url and oa_url.lower().split("?")[0].endswith(".pdf"):
                text, title = await fetch_pdf_text(oa_url)
                if text:
                    logger.info("[oa] Semantic Scholar OA PDF retrieved for DOI %s", doi)
                    return text, title
            elif oa_url and oa_url != url:
                # Non-PDF OA landing page — try trafilatura
                import trafilatura
                downloaded = await asyncio.to_thread(trafilatura.fetch_url, oa_url)
                if downloaded:
                    text = await asyncio.to_thread(
                        trafilatura.extract, downloaded,
                        include_comments=False, include_tables=True, no_fallback=False,
                    )
                    if text and len(text) > 300:
                        meta = trafilatura.extract_metadata(downloaded)
                        logger.info("[oa] OA landing page retrieved for DOI %s", doi)
                        return text[:_MAX_CHARS], meta.title if meta else None
        except Exception as exc:
            logger.debug("[oa] OA PDF fetch failed for DOI %s: %s", doi, exc)

    # 3 & 4. Web archives
    for archive_url in [
        f"https://web.archive.org/web/2/{url}",
        f"https://archive.ph/{url}",
    ]:
        try:
            import trafilatura
            downloaded = await asyncio.to_thread(trafilatura.fetch_url, archive_url)
            if downloaded:
                text = await asyncio.to_thread(
                    trafilatura.extract, downloaded,
                    include_comments=False, include_tables=True, no_fallback=False,
                )
                if text and len(text) > 300:
                    meta = trafilatura.extract_metadata(downloaded)
                    logger.info("[oa] Archive hit: %d chars from %s",
                                len(text), archive_url[:60])
                    return text[:_MAX_CHARS], meta.title if meta else None
        except Exception as exc:
            logger.debug("[oa] Archive %s failed: %s", archive_url[:60], exc)

    return None, None


# ── MCP Tool Interface ─────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "open_access_resolver",
    "description": (
        "Find legal, free full-text for paywalled or restricted academic and news sources. "
        "Queries Semantic Scholar, Unpaywall, CrossRef, CORE (200M+ OA records), "
        "Wayback Machine, and archive.ph in sequence. Can also extract a DOI from a "
        "paywalled page's HTML metadata to unlock the full open-access chain. "
        "Use for: finding open-access PDFs, retrieving archived article text, "
        "resolving DOIs to readable content, checking if a paywalled source has an "
        "OA copy before attempting full verification."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "resolve_doi",
                    "core_fetch",
                    "extract_doi_from_url",
                    "archive_fetch",
                ],
                "description": (
                    "resolve_doi: DOI → best open-access URL (Semantic Scholar → Unpaywall → CrossRef). "
                    "core_fetch: DOI → full text from CORE repository aggregator. "
                    "extract_doi_from_url: URL → DOI extracted from page HTML meta tags. "
                    "archive_fetch: URL (+ optional doi) → full text via all OA sources then archives."
                ),
            },
            "doi": {
                "type": "string",
                "description": "DOI string (e.g. '10.1234/example') or full doi.org URL",
            },
            "url": {
                "type": "string",
                "description": "Full URL of the source page to resolve or archive",
            },
        },
        "required": ["action"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    """MCP-compatible dispatch for open_access_resolver actions."""
    action = inputs.get("action", "")
    doi    = inputs.get("doi", "") or ""
    url    = inputs.get("url", "") or ""

    if action == "resolve_doi":
        if not doi:
            return {"error": "doi is required for resolve_doi"}
        result_url = await resolve_doi(doi)
        return {
            "doi":             doi,
            "open_access_url": result_url,
            "found":           bool(result_url),
        }

    if action == "core_fetch":
        if not doi:
            return {"error": "doi is required for core_fetch"}
        text, title = await core_fetch_by_doi(doi)
        return {
            "doi":         doi,
            "title":       title,
            "text":        text[:2000] if text else None,   # truncate for tool response
            "full_length": len(text) if text else 0,
            "found":       bool(text),
        }

    if action == "extract_doi_from_url":
        if not url:
            return {"error": "url is required for extract_doi_from_url"}
        found_doi = await extract_doi_from_url(url)
        return {
            "url":   url,
            "doi":   found_doi,
            "found": bool(found_doi),
        }

    if action == "archive_fetch":
        if not url:
            return {"error": "url is required for archive_fetch"}
        text, title = await fetch_via_archives(url, doi=doi or None)
        return {
            "url":         url,
            "title":       title,
            "text":        text[:2000] if text else None,
            "full_length": len(text) if text else 0,
            "found":       bool(text),
        }

    return {
        "error": (
            f"Unknown action: {action!r}. "
            "Valid: resolve_doi, core_fetch, extract_doi_from_url, archive_fetch"
        )
    }
