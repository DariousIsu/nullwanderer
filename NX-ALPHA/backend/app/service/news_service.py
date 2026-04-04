"""
AURA NX-Alpha — News Service
Fetches headlines from a curated set of RSS feeds (Reuters, AP, BBC, NPR)
using feedparser (synchronous, run via asyncio.to_thread) and httpx for
downloading raw feed XML asynchronously.

SINGLETON PATTERN:
    Call init_news_service() once at startup.
    Callers use get_news_service() to get the instance.

CACHING:
    Each feed is cached independently for 5 minutes (dict + timestamp).

DEPENDENCIES:
    httpx      — async HTTP download of raw RSS XML
    feedparser — synchronous RSS/Atom parsing
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# OPTIONAL IMPORTS
# ─────────────────────────────────────────────────────────────────────────────

try:
    import httpx
    _HTTPX_AVAILABLE = True
except ImportError:
    _HTTPX_AVAILABLE = False
    logger.warning("[news_service] httpx not installed — news feeds will return empty results")

try:
    import feedparser
    _FEEDPARSER_AVAILABLE = True
except ImportError:
    _FEEDPARSER_AVAILABLE = False
    logger.warning("[news_service] feedparser not installed — news feeds will return empty results")

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

FEEDS: dict[str, str] = {
    # ── Tier 1 — wire / broadcast ──
    "reuters":    "https://www.reutersagency.com/feed/?best-topics=political-general&post_type=best",
    "ap":         "https://rss.app/feeds/v1.1/tSmMx6eMHXgSp4JA.json",
    "bbc":        "http://feeds.bbci.co.uk/news/rss.xml",
    "npr":        "https://feeds.npr.org/1001/rss.xml",
    "al_jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
    # ── Tier 2 — business / markets ──
    "bloomberg":  "https://feeds.bloomberg.com/markets/news.rss",
    "cnbc":       "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    "wsj":        "https://feeds.a.wsj.net/wsj/xml/rss/3_7085.xml",
    "ft":         "https://www.ft.com/rss/home",
    # ── Tier 3 — tech / science ──
    "techcrunch": "https://techcrunch.com/feed/",
    "ars":        "https://feeds.arstechnica.com/arstechnica/index",
    "wired":      "https://www.wired.com/feed/rss",
    "hn":         "https://hnrss.org/frontpage",
    "arxiv":      "http://export.arxiv.org/rss/cs.AI",
}

_CACHE_TTL_SECONDS = 300  # 5 minutes


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _parse_feed_xml(xml_bytes: bytes) -> list[dict]:
    """Run feedparser.parse() on raw bytes and return normalised article dicts.

    This is a pure synchronous function intended to be called inside
    asyncio.to_thread so it does not block the event loop.

    Returns an empty list on any parse failure.
    """
    if not _FEEDPARSER_AVAILABLE:
        return []
    try:
        parsed = feedparser.parse(xml_bytes)
        articles: list[dict] = []
        for entry in parsed.get("entries", []):
            # published — try structured time first, fallback to raw string
            published: str = ""
            if entry.get("published_parsed"):
                try:
                    import email.utils
                    published = email.utils.formatdate(
                        time.mktime(entry.published_parsed), usegmt=True
                    )
                except Exception:
                    published = entry.get("published", "")
            else:
                published = entry.get("published", "")

            summary: str = entry.get("summary", "") or entry.get("description", "") or ""

            # ── Extract image / thumbnail from RSS media tags ──
            image: str = ""
            # media:content (most common for news RSS)
            media_content = entry.get("media_content", [])
            if isinstance(media_content, list):
                for mc in media_content:
                    url_candidate = mc.get("url", "")
                    if mc.get("type", "").startswith("image") or url_candidate.lower().endswith(
                        (".jpg", ".jpeg", ".png", ".webp", ".gif")
                    ):
                        image = url_candidate
                        break
            # media:thumbnail fallback
            if not image:
                media_thumb = entry.get("media_thumbnail", [])
                if isinstance(media_thumb, list) and media_thumb:
                    image = media_thumb[0].get("url", "")
            # enclosures fallback
            if not image:
                for link in entry.get("links", []):
                    if link.get("type", "").startswith("image"):
                        image = link.get("href", "")
                        break
            # Last resort: extract <img src="..."> from summary HTML
            if not image and summary:
                import re as _img_re
                img_match = _img_re.search(r'<img[^>]+src=["\']([^"\']+)["\']', summary)
                if img_match:
                    image = img_match.group(1)

            # Strip HTML from summary (HN, arXiv etc. embed markup)
            import re as _strip_re
            clean_summary = _strip_re.sub(r'<[^>]+>', '', summary).strip()

            articles.append(
                {
                    "title":     entry.get("title", "").strip(),
                    "summary":   clean_summary,
                    "link":      entry.get("link", ""),
                    "published": published,
                    "source":    "",  # caller fills this in
                    "image":     image,
                }
            )
        return articles
    except Exception as exc:
        logger.warning("[news_service] feedparser parse error: %s", exc)
        return []


def _sort_key(article: dict) -> float:
    """Return a sortable float timestamp from an article's published string."""
    published = article.get("published", "")
    if not published:
        return 0.0
    try:
        import email.utils
        ts = email.utils.parsedate_to_datetime(published).timestamp()
        return ts
    except Exception:
        return 0.0


# ─────────────────────────────────────────────────────────────────────────────
# NEWS SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class NewsService:
    """
    Async RSS news aggregation service.

    Usage::

        articles = await news_service.fetch_feed("bbc")
        all_news = await news_service.fetch_all(limit_per_feed=10)
        tech     = await news_service.fetch_by_category("technology", limit=20)
    """

    def __init__(self) -> None:
        # Per-feed cache: source_name → {"data": list[dict], "ts": float}
        self._cache: dict[str, dict[str, Any]] = {}
        # Per-feed failure backoff: source → {"count": int, "ts": float}
        self._failures: dict[str, dict[str, Any]] = {}
        self._client: "httpx.AsyncClient | None" = None
        if _HTTPX_AVAILABLE:
            self._client = httpx.AsyncClient(
                timeout=15.0,
                follow_redirects=True,
                headers={"User-Agent": "AURA-NX-Alpha/1.0 (RSS reader)"},
            )
        logger.info(
            "[news_service] Initialized (httpx=%s feedparser=%s feeds=%s)",
            _HTTPX_AVAILABLE, _FEEDPARSER_AVAILABLE, list(FEEDS.keys()),
        )

    # ── CACHE HELPERS ─────────────────────────────────────────────────────────

    def _get_cache(self, source: str) -> list[dict] | None:
        entry = self._cache.get(source)
        if entry and (time.time() - entry["ts"]) < _CACHE_TTL_SECONDS:
            return entry["data"]
        return None

    def _set_cache(self, source: str, data: list[dict]) -> None:
        self._cache[source] = {"data": data, "ts": time.time()}

    # ── PUBLIC API ────────────────────────────────────────────────────────────

    async def fetch_feed(self, source: str) -> list[dict]:
        """Fetch and parse one RSS feed by source name.

        Args:
            source: Key from the FEEDS dict (e.g. "reuters", "bbc").

        Returns:
            List of article dicts: {title, summary, link, published, source}.
            Returns an empty list on any failure — never raises.
        """
        url = FEEDS.get(source)
        if not url:
            logger.warning("[news_service] Unknown feed source: %r", source)
            return []

        cached = self._get_cache(source)
        if cached is not None:
            return cached

        # Backoff: skip sources that have been failing repeatedly
        fail_info = self._failures.get(source)
        if fail_info:
            backoff = min(60 * (2 ** (fail_info["count"] - 1)), 1800)  # max 30 min
            if (time.time() - fail_info["ts"]) < backoff:
                return []  # still in backoff window

        if not _HTTPX_AVAILABLE or self._client is None:
            logger.warning("[news_service] httpx unavailable — returning empty for %s", source)
            return []

        try:
            response = await self._client.get(url)
            response.raise_for_status()
            raw_bytes = response.content

            # feedparser is synchronous — offload to a thread pool
            articles: list[dict] = await asyncio.to_thread(_parse_feed_xml, raw_bytes)

            # Stamp each article with its source
            for article in articles:
                article["source"] = source

            self._set_cache(source, articles)
            self._failures.pop(source, None)  # clear backoff on success
            logger.debug("[news_service] Fetched %d articles from %s", len(articles), source)
            return articles
        except Exception as exc:
            prev = self._failures.get(source, {"count": 0, "ts": 0})
            self._failures[source] = {"count": prev["count"] + 1, "ts": time.time()}
            backoff = min(60 * (2 ** prev["count"]), 1800)
            logger.warning(
                "[news_service] fetch_feed failed (source=%s, attempt %d, retry in %ds): %s",
                source, prev["count"] + 1, backoff, exc,
            )
            return []

    async def fetch_all(self, limit_per_feed: int = 10) -> list[dict]:
        """Fetch all configured feeds concurrently, merge, and sort by date.

        Args:
            limit_per_feed: Maximum articles to take from each feed before merging.

        Returns:
            Flat list of article dicts sorted by published date descending.
            Never raises — individual feed failures produce empty contributions.
        """
        tasks = [self.fetch_feed(source) for source in FEEDS]
        results: list[list[dict]] = await asyncio.gather(*tasks, return_exceptions=False)

        merged: list[dict] = []
        for feed_articles in results:
            merged.extend(feed_articles[:limit_per_feed])

        merged.sort(key=_sort_key, reverse=True)
        return merged

    async def fetch_by_category(self, category: str, limit: int = 20) -> list[dict]:
        """Fetch all feeds and return articles matching a category keyword.

        Matching is case-insensitive and checks both title and summary fields.

        Args:
            category: Keyword to filter on (e.g. "technology", "climate").
            limit:    Maximum number of articles to return (default 20).

        Returns:
            List of matching article dicts sorted by published date descending.
            Never raises.
        """
        all_articles = await self.fetch_all(limit_per_feed=50)
        needle = category.lower()
        filtered = [
            a for a in all_articles
            if needle in a.get("title", "").lower()
            or needle in a.get("summary", "").lower()
        ]
        return filtered[:limit]

    async def close(self) -> None:
        """Close the underlying httpx client. Call during app shutdown."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None
            logger.debug("[news_service] httpx client closed")


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_news_service: NewsService | None = None


def init_news_service() -> NewsService:
    """Instantiate and register the global NewsService. Call once at startup."""
    global _news_service
    _news_service = NewsService()
    return _news_service


def get_news_service() -> NewsService | None:
    """Return the running NewsService instance, or None if not initialised."""
    return _news_service
