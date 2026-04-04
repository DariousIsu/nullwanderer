"""
AURA NX-Alpha — Intelligence Service
Unified data aggregation across all external sources: news, finance, economic,
legislative, legal, weather, and calendar data.

SOURCES:
    News:
        - RSS feeds (Reuters, AP, BBC, NPR)
        - NewsAPI.com (30+ news outlets)
    Finance:
        - Polygon (stocks, crypto, forex)
        - Alpha Vantage (stocks, forex, crypto)
        - CoinGecko (crypto, no key required)
        - Yahoo Finance (stocks, no key required)
    Economic:
        - FRED (Federal Reserve Economic Data)
        - BLS (Bureau of Labor Statistics)
        - BEA (Bureau of Economic Analysis)
        - Census Bureau
    Legislative:
        - Congress.gov API
        - OpenStates API
    Legal:
        - CourtListener API
    Other:
        - Weather (Open-Meteo, OpenWeatherMap optional)
        - Google Calendar
        - Gmail

USER RANKING:
    Sources are stored in ~/.aura/intelligence_sources.json with user rank + enabled status.
    Aggregated feed sorted by: (1) user preference, (2) recency.

SINGLETON PATTERN:
    Call init_intelligence_service() at startup.
    Use get_intelligence_service() to access.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)

# ── Optional deps ────────────────────────────────────────────────────────────
try:
    import httpx
    _HTTPX = True
except ImportError:
    _HTTPX = False
    logger.warning("[intelligence_service] httpx not installed — remote API calls disabled")

# ─────────────────────────────────────────────────────────────────────────────
# SETTINGS & DEFAULTS
# ─────────────────────────────────────────────────────────────────────────────

_SOURCES_CONFIG_PATH = Path.home() / ".aura" / "intelligence_sources.json"

# Default source configuration (user can override ranking)
DEFAULT_SOURCES = {
    "news": {
        "reuters":       {"type": "rss", "enabled": True, "rank": 1},
        "bloomberg":     {"type": "rss", "enabled": True, "rank": 2},
        "cnbc":          {"type": "rss", "enabled": True, "rank": 3},
        "bbc":           {"type": "rss", "enabled": True, "rank": 4},
        "al_jazeera":    {"type": "rss", "enabled": True, "rank": 5},
        "techcrunch":    {"type": "rss", "enabled": True, "rank": 6},
        "ars":           {"type": "rss", "enabled": True, "rank": 7},
        "hn":            {"type": "rss", "enabled": True, "rank": 8},
        "wsj":           {"type": "rss", "enabled": True, "rank": 9},
        "ft":            {"type": "rss", "enabled": True, "rank": 10},
        "wired":         {"type": "rss", "enabled": True, "rank": 11},
        "arxiv":         {"type": "rss", "enabled": True, "rank": 12},
        "ap":            {"type": "rss", "enabled": True, "rank": 13},
        "npr":           {"type": "rss", "enabled": True, "rank": 14},
        "newsapi":       {"type": "newsapi", "enabled": True, "rank": 15},
    },
    "finance": {
        "polygon":       {"type": "api", "enabled": True, "rank": 1},
        "alpha_vantage": {"type": "api", "enabled": True, "rank": 2},
        "coingecko":     {"type": "api", "enabled": True, "rank": 3},
        "yfinance":      {"type": "api", "enabled": True, "rank": 4},
    },
    "economic": {
        "fred":          {"type": "api", "enabled": True, "rank": 1},
        "bls":           {"type": "api", "enabled": True, "rank": 2},
        "bea":           {"type": "api", "enabled": True, "rank": 3},
        "census":        {"type": "api", "enabled": True, "rank": 4},
    },
    "legislative": {
        "congress":      {"type": "api", "enabled": True, "rank": 1},
        # openstates disabled — all US state bills are in the local SQLite FTS5 DB.
        # Live API calls are redundant and cause 400s when no jurisdiction param is set.
        "openstates":    {"type": "api", "enabled": False, "rank": 2},
    },
    "legal": {
        "courtlistener": {"type": "api", "enabled": True, "rank": 1},
    },
}

_CACHE_TTL_SECONDS = 300  # 5 minutes


# ─────────────────────────────────────────────────────────────────────────────
# DATA MODELS
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class DataItem:
    """Unified data item from any source."""
    id: str
    source: str
    source_type: str  # "news", "finance", "economic", etc.
    title: str
    description: str = ""
    url: str = ""
    timestamp: str = ""  # ISO 8601
    rank: int = 0  # User preference rank
    tags: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "source": self.source,
            "sourceType": self.source_type,
            "title": self.title,
            "description": self.description,
            "url": self.url,
            "timestamp": self.timestamp,
            "rank": self.rank,
            "tags": self.tags,
            "metadata": self.metadata,
        }


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_api_keys() -> dict:
    """Read API keys from config (MarketAPIConfig + KnowledgeConfig)."""
    try:
        from app.config import get_settings
        s = get_settings()
        return {
            "fred":          s.market.fred_api_key,
            "bls":           s.market.bls_api_key,
            "bea":           s.market.bea_api_key,
            "census":        s.market.census_api_key,
            "newsapi":       s.market.news_api_key,
            "polygon":       s.market.polygon_api_key,
            "alpha_vantage": s.market.alpha_vantage_api_key,
            "congress":      getattr(s.knowledge, "congress_api_key", "") or "",
            "openstates":    getattr(s.knowledge, "openstates_api_key", "") or "",
            "courtlistener": getattr(s.knowledge, "courtlistener_token", "") or "",
        }
    except Exception:
        return {}


def _uid(*parts: str) -> str:
    """Deterministic short ID from parts."""
    raw = "|".join(parts)
    return hashlib.md5(raw.encode()).hexdigest()[:12]


# ─────────────────────────────────────────────────────────────────────────────
# INTELLIGENCE SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class IntelligenceService:
    """Unified intelligence aggregation service."""

    def __init__(self) -> None:
        self._cache: dict[str, dict[str, Any]] = {}
        self._source_config = self._load_source_config()
        self._http: Optional[Any] = None
        if _HTTPX:
            self._http = httpx.AsyncClient(
                timeout=20.0,
                follow_redirects=True,
                headers={"User-Agent": "AURA-NX-Alpha/1.0"},
            )
        logger.info("[intelligence_service] Initialized with %d sources",
                   sum(len(v) for v in self._source_config.values()))

    # ── CONFIG HELPERS ────────────────────────────────────────────────────────

    def _load_source_config(self) -> dict:
        """Load user source ranking config or use defaults."""
        if _SOURCES_CONFIG_PATH.exists():
            try:
                return json.loads(_SOURCES_CONFIG_PATH.read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning("[intelligence_service] Failed to load source config: %s", exc)
        return json.loads(json.dumps(DEFAULT_SOURCES))  # deep copy

    def _save_source_config(self) -> None:
        """Persist source config to disk."""
        _SOURCES_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        _SOURCES_CONFIG_PATH.write_text(
            json.dumps(self._source_config, indent=2),
            encoding="utf-8"
        )
        logger.debug("[intelligence_service] Saved source config")

    # ── PUBLIC API ────────────────────────────────────────────────────────────

    async def get_all_sources(self) -> dict:
        """Return all available sources with current ranking."""
        return self._source_config

    async def update_source_rank(self, source_type: str, source_id: str, rank: int, enabled: bool) -> dict:
        """Update ranking and enabled status for a source."""
        if source_type in self._source_config:
            if source_id in self._source_config[source_type]:
                self._source_config[source_type][source_id]["rank"] = rank
                self._source_config[source_type][source_id]["enabled"] = enabled
                self._save_source_config()
                logger.info("[intelligence_service] Updated %s.%s: rank=%d enabled=%s",
                           source_type, source_id, rank, enabled)
                return {"success": True}
        return {"success": False, "error": f"Source {source_type}.{source_id} not found"}

    async def add_custom_source(self, source_type: str, source_id: str, source_config: dict) -> dict:
        """Add a custom user-defined source."""
        if source_type not in self._source_config:
            self._source_config[source_type] = {}

        # Find next rank
        next_rank = max(
            (s.get("rank", 0) for s in self._source_config[source_type].values()),
            default=0
        ) + 1

        self._source_config[source_type][source_id] = {
            **source_config,
            "rank": next_rank,
            "enabled": True,
            "custom": True,
        }
        self._save_source_config()
        logger.info("[intelligence_service] Added custom source: %s.%s", source_type, source_id)
        return {"success": True, "source_id": source_id}

    async def get_aggregated_feed(
        self,
        source_types: Optional[list[str]] = None,
        limit: int = 100,
        hours_back: int = 24,
        max_concurrent: int = 3,
    ) -> dict:
        """Get aggregated, ranked feed across all enabled sources.

        max_concurrent caps simultaneous HTTP fetches to avoid spiking
        memory on constrained hardware (default 3 — safe for Pi/8GB systems).
        REST callers can pass max_concurrent=10 for full speed when desired.
        """
        items: list[DataItem] = []
        cutoff_time = datetime.now(timezone.utc) - timedelta(hours=hours_back)

        # Build list of (src_type, source_id, config) tuples for enabled sources
        pending = []
        for src_type, sources in self._source_config.items():
            if source_types and src_type not in source_types:
                continue
            for source_id, config in sources.items():
                if not config.get("enabled"):
                    continue
                pending.append((src_type, source_id, config))

        # Throttled gather: semaphore limits concurrent live fetches so all
        # HTTP response bodies don't sit in memory simultaneously.
        sem = asyncio.Semaphore(max_concurrent)

        async def _throttled(src_type, source_id, config):
            async with sem:
                return await self._fetch_from_source(src_type, source_id, config, cutoff_time)

        tasks = [_throttled(s, sid, cfg) for s, sid, cfg in pending]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in results:
            if isinstance(r, list):
                items.extend(r)
            elif isinstance(r, Exception):
                logger.warning("[intelligence_service] Source fetch error: %s", r)

        # Sort by rank (user preference) then by recency
        def _sort_key(x: DataItem):
            ts = 0.0
            if x.timestamp:
                try:
                    ts = datetime.fromisoformat(x.timestamp.replace("Z", "+00:00")).timestamp()
                except Exception:
                    pass
            return (x.rank, -ts)

        items.sort(key=_sort_key)

        return {
            "items": [item.to_dict() for item in items[:limit]],
            "last_updated": datetime.now(timezone.utc).isoformat(),
            "sources_enabled": sum(1 for src_type in self._source_config.values()
                                  for cfg in src_type.values() if cfg.get("enabled")),
        }

    # ── PRIVATE FETCH METHODS ─────────────────────────────────────────────────

    async def _fetch_from_source(
        self,
        source_type: str,
        source_id: str,
        config: dict,
        cutoff_time: datetime,
    ) -> list[DataItem]:
        """Fetch items from a specific source."""

        # Check cache
        cache_key = f"{source_type}:{source_id}"
        if cache_key in self._cache:
            cached = self._cache[cache_key]
            if (time.time() - cached["ts"]) < _CACHE_TTL_SECONDS:
                return cached["data"]

        items: list[DataItem] = []

        # Route to appropriate fetcher
        try:
            if source_type == "news":
                items = await self._fetch_news(source_id, config, cutoff_time)
            elif source_type == "finance":
                items = await self._fetch_finance(source_id, config, cutoff_time)
            elif source_type == "economic":
                items = await self._fetch_economic(source_id, config, cutoff_time)
            elif source_type == "legislative":
                items = await self._fetch_legislative(source_id, config, cutoff_time)
            elif source_type == "legal":
                items = await self._fetch_legal(source_id, config, cutoff_time)
        except Exception as exc:
            logger.warning("[intelligence_service] Fetch %s.%s failed: %s", source_type, source_id, exc)

        # Set rank from config
        rank = config.get("rank", 999)
        for item in items:
            item.rank = rank

        # Cache
        self._cache[cache_key] = {"data": items, "ts": time.time()}

        return items

    # ─────────────────────────────────────────────────────────────────────────
    # NEWS
    # ─────────────────────────────────────────────────────────────────────────

    async def _fetch_news(
        self, source_id: str, config: dict, cutoff_time: datetime,
    ) -> list[DataItem]:
        """Fetch news from RSS or NewsAPI."""
        items: list[DataItem] = []

        if config.get("type") == "rss":
            try:
                from app.service.news_service import get_news_service, FEEDS as _RSS_FEEDS
                news_svc = get_news_service()
                if news_svc and source_id in _RSS_FEEDS:
                    articles = await news_svc.fetch_feed(source_id)
                    for i, article in enumerate(articles):
                        ts = article.get("published", "")
                        items.append(DataItem(
                            id=_uid("news", source_id, str(i), article.get("title", "")),
                            source=source_id,
                            source_type="news",
                            title=article.get("title", ""),
                            description=article.get("summary", ""),
                            url=article.get("link", ""),
                            timestamp=ts,
                            tags=["news", source_id],
                            metadata={
                                "summary": article.get("summary", ""),
                                "image": article.get("image", ""),
                            },
                        ))
            except Exception as exc:
                logger.debug("[intelligence_service] RSS fetch failed for %s: %s", source_id, exc)

        elif config.get("type") == "newsapi" or source_id == "newsapi":
            items = await self._fetch_newsapi(cutoff_time)

        # Custom RSS source
        elif config.get("custom") and config.get("url"):
            items = await self._fetch_custom_rss(source_id, config)

        return items

    async def _fetch_newsapi(self, cutoff_time: datetime) -> list[DataItem]:
        """Fetch top headlines from NewsAPI.com."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("newsapi", "")
        if not api_key:
            return []

        items: list[DataItem] = []
        try:
            resp = await self._http.get(
                "https://newsapi.org/v2/top-headlines",
                params={"country": "us", "pageSize": 30, "apiKey": api_key},
            )
            if resp.status_code != 200:
                logger.debug("[intelligence_service] NewsAPI returned %d", resp.status_code)
                return []
            data = resp.json()
            for i, art in enumerate(data.get("articles", [])):
                ts = art.get("publishedAt", "")
                items.append(DataItem(
                    id=_uid("newsapi", str(i), art.get("title", "")),
                    source="newsapi",
                    source_type="news",
                    title=art.get("title", "") or "",
                    description=art.get("description", "") or "",
                    url=art.get("url", ""),
                    timestamp=ts,
                    tags=["news", "newsapi", (art.get("source", {}).get("name", "")).lower()],
                    metadata={
                        "author": art.get("author", ""),
                        "source_name": art.get("source", {}).get("name", ""),
                        "image": art.get("urlToImage", ""),
                    },
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] NewsAPI error: %s", exc)
        return items

    async def _fetch_custom_rss(self, source_id: str, config: dict) -> list[DataItem]:
        """Fetch a user-added custom RSS feed."""
        if not self._http:
            return []
        items: list[DataItem] = []
        try:
            import feedparser
            resp = await self._http.get(config["url"])
            if resp.status_code != 200:
                return []
            parsed = await asyncio.to_thread(feedparser.parse, resp.content)
            for i, entry in enumerate(parsed.get("entries", [])[:30]):
                ts = entry.get("published", "")
                items.append(DataItem(
                    id=_uid("custom", source_id, str(i)),
                    source=source_id,
                    source_type="news",
                    title=entry.get("title", ""),
                    description=entry.get("summary", ""),
                    url=entry.get("link", ""),
                    timestamp=ts,
                    tags=["news", source_id, "custom"],
                ))
        except ImportError:
            logger.debug("[intelligence_service] feedparser not installed for custom RSS")
        except Exception as exc:
            logger.debug("[intelligence_service] Custom RSS %s error: %s", source_id, exc)
        return items

    # ─────────────────────────────────────────────────────────────────────────
    # FINANCE
    # ─────────────────────────────────────────────────────────────────────────

    async def _fetch_finance(
        self, source_id: str, config: dict, cutoff_time: datetime,
    ) -> list[DataItem]:
        """Fetch financial data items for the intelligence feed."""
        items: list[DataItem] = []

        if source_id == "polygon":
            items = await self._fetch_polygon_news()
        elif source_id == "alpha_vantage":
            items = await self._fetch_alpha_vantage_news()
        elif source_id in ("coingecko", "yfinance"):
            # Delegate to existing finance_service for market snapshot items
            items = await self._fetch_finance_snapshot(source_id)

        return items

    async def _fetch_polygon_news(self) -> list[DataItem]:
        """Fetch market news from Polygon.io."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("polygon", "")
        if not api_key:
            return []
        items: list[DataItem] = []
        try:
            resp = await self._http.get(
                "https://api.polygon.io/v2/reference/news",
                params={"limit": 20, "order": "desc", "apiKey": api_key},
            )
            if resp.status_code != 200:
                logger.debug("[intelligence_service] Polygon news returned %d", resp.status_code)
                return []
            data = resp.json()
            for i, art in enumerate(data.get("results", [])):
                ts = art.get("published_utc", "")
                tickers = art.get("tickers", [])
                items.append(DataItem(
                    id=_uid("polygon", str(i), art.get("title", "")),
                    source="polygon",
                    source_type="finance",
                    title=art.get("title", ""),
                    description=art.get("description", "")[:300] if art.get("description") else "",
                    url=art.get("article_url", ""),
                    timestamp=ts,
                    tags=["finance", "polygon"] + tickers[:5],
                    metadata={
                        "tickers": tickers,
                        "publisher": art.get("publisher", {}).get("name", ""),
                        "image": art.get("image_url", ""),
                    },
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] Polygon news error: %s", exc)
        return items

    async def _fetch_alpha_vantage_news(self) -> list[DataItem]:
        """Fetch news/sentiment from Alpha Vantage."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("alpha_vantage", "")
        if not api_key:
            return []
        items: list[DataItem] = []
        try:
            resp = await self._http.get(
                "https://www.alphavantage.co/query",
                params={"function": "NEWS_SENTIMENT", "limit": 20, "apikey": api_key},
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            for i, art in enumerate(data.get("feed", [])):
                ts = art.get("time_published", "")
                # Alpha Vantage format: 20260327T143000 → ISO
                if ts and "T" in ts and len(ts) >= 15:
                    try:
                        ts = f"{ts[:4]}-{ts[4:6]}-{ts[6:8]}T{ts[9:11]}:{ts[11:13]}:{ts[13:15]}Z"
                    except Exception:
                        pass
                items.append(DataItem(
                    id=_uid("av", str(i), art.get("title", "")),
                    source="alpha_vantage",
                    source_type="finance",
                    title=art.get("title", ""),
                    description=art.get("summary", "")[:300] if art.get("summary") else "",
                    url=art.get("url", ""),
                    timestamp=ts,
                    tags=["finance", "alpha_vantage"],
                    metadata={
                        "sentiment": art.get("overall_sentiment_label", ""),
                        "sentiment_score": art.get("overall_sentiment_score", 0),
                        "source_name": art.get("source", ""),
                    },
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] Alpha Vantage news error: %s", exc)
        return items

    async def _fetch_finance_snapshot(self, source_id: str) -> list[DataItem]:
        """Get market snapshot items from existing finance_service."""
        items: list[DataItem] = []
        try:
            from app.service.finance_service import get_finance_service
            svc = get_finance_service()
            if not svc:
                return []
            overview = await svc.get_market_overview()
            if not overview:
                return []
            now_iso = datetime.now(timezone.utc).isoformat()

            # Indices
            for idx_data in overview.get("indices", []):
                ticker = idx_data.get("ticker", "?")
                price = idx_data.get("price", 0)
                change_pct = idx_data.get("change_pct", 0)
                direction = "▲" if change_pct >= 0 else "▼"
                items.append(DataItem(
                    id=_uid("fin", source_id, ticker),
                    source=source_id,
                    source_type="finance",
                    title=f"{ticker} ${price:,.2f} {direction} {change_pct:+.2f}%",
                    description=f"Market index snapshot",
                    timestamp=now_iso,
                    tags=["finance", source_id, "index", ticker],
                    metadata=idx_data,
                ))

            # Crypto
            for crypto in overview.get("crypto", []):
                name = crypto.get("name", "?")
                price = crypto.get("price", 0)
                change = crypto.get("change_24h", 0)
                direction = "▲" if change >= 0 else "▼"
                items.append(DataItem(
                    id=_uid("fin", source_id, name),
                    source=source_id,
                    source_type="finance",
                    title=f"{name} ${price:,.2f} {direction} {change:+.2f}%",
                    description=f"Crypto snapshot",
                    timestamp=now_iso,
                    tags=["finance", source_id, "crypto", name.lower()],
                    metadata=crypto,
                ))
        except Exception as exc:
            logger.debug("[intelligence_service] Finance snapshot error: %s", exc)
        return items

    # ─────────────────────────────────────────────────────────────────────────
    # ECONOMIC
    # ─────────────────────────────────────────────────────────────────────────

    async def _fetch_economic(
        self, source_id: str, config: dict, cutoff_time: datetime,
    ) -> list[DataItem]:
        """Fetch economic data."""
        if source_id == "fred":
            return await self._fetch_fred()
        elif source_id == "bls":
            return await self._fetch_bls()
        elif source_id == "bea":
            return await self._fetch_bea()
        elif source_id == "census":
            return await self._fetch_census()
        return []

    async def _fetch_fred(self) -> list[DataItem]:
        """Fetch recent FRED data releases."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("fred", "")
        if not api_key:
            return []
        items: list[DataItem] = []
        try:
            resp = await self._http.get(
                "https://api.stlouisfed.org/fred/releases/dates",
                params={
                    "api_key": api_key,
                    "file_type": "json",
                    "limit": 20,
                    "sort_order": "desc",
                    "include_release_dates_with_no_data": "false",
                },
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            for i, release in enumerate(data.get("release_dates", [])):
                release_id = release.get("release_id", "")
                release_name = release.get("release_name", f"FRED Release #{release_id}")
                date_str = release.get("date", "")
                items.append(DataItem(
                    id=_uid("fred", str(release_id), date_str),
                    source="fred",
                    source_type="economic",
                    title=release_name,
                    description=f"FRED data release on {date_str}",
                    url=f"https://fred.stlouisfed.org/releases/{release_id}",
                    timestamp=f"{date_str}T12:00:00Z" if date_str else "",
                    tags=["economic", "fred", "release"],
                    metadata={"release_id": release_id, "date": date_str},
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] FRED error: %s", exc)
        return items

    async def _fetch_bls(self) -> list[DataItem]:
        """Fetch latest BLS data (CPI, unemployment, etc)."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("bls", "")
        items: list[DataItem] = []
        # Fetch latest data for key series
        series_ids = [
            ("CUUR0000SA0", "CPI (All Urban Consumers)"),
            ("LNS14000000", "Unemployment Rate"),
            ("CES0000000001", "Total Nonfarm Payrolls"),
        ]
        try:
            year = datetime.now().year
            payload = {
                "seriesid": [s[0] for s in series_ids],
                "startyear": str(year - 1),
                "endyear": str(year),
                "registrationkey": api_key,
            }
            resp = await self._http.post(
                "https://api.bls.gov/publicAPI/v2/timeseries/data/",
                json=payload,
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            name_map = {s[0]: s[1] for s in series_ids}
            for series in data.get("Results", {}).get("series", []):
                sid = series.get("seriesID", "")
                name = name_map.get(sid, sid)
                latest = series.get("data", [{}])[0] if series.get("data") else {}
                value = latest.get("value", "")
                period = latest.get("periodName", "")
                yr = latest.get("year", "")
                items.append(DataItem(
                    id=_uid("bls", sid, yr, period),
                    source="bls",
                    source_type="economic",
                    title=f"{name}: {value} ({period} {yr})",
                    description=f"Bureau of Labor Statistics — {name}",
                    url=f"https://data.bls.gov/timeseries/{sid}",
                    timestamp=f"{yr}-01-01T00:00:00Z",
                    tags=["economic", "bls", sid],
                    metadata={"series_id": sid, "value": value, "period": period, "year": yr},
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] BLS error: %s", exc)
        return items

    async def _fetch_bea(self) -> list[DataItem]:
        """Fetch latest BEA GDP data."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("bea", "")
        if not api_key:
            return []
        items: list[DataItem] = []
        try:
            resp = await self._http.get(
                "https://apps.bea.gov/api/data/",
                params={
                    "UserID": api_key,
                    "method": "GetData",
                    "DataSetName": "NIPA",
                    "TableName": "T10101",
                    "Frequency": "Q",
                    "Year": str(datetime.now().year),
                    "ResultFormat": "JSON",
                },
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            bea_data = data.get("BEAAPI", {}).get("Results", {}).get("Data", [])
            seen = set()
            for entry in bea_data[:20]:
                line_desc = entry.get("LineDescription", "")
                value = entry.get("DataValue", "")
                period = entry.get("TimePeriod", "")
                key = f"{line_desc}-{period}"
                if key in seen:
                    continue
                seen.add(key)
                items.append(DataItem(
                    id=_uid("bea", key),
                    source="bea",
                    source_type="economic",
                    title=f"{line_desc}: {value} ({period})",
                    description="Bureau of Economic Analysis — National Income & Product Accounts",
                    url="https://apps.bea.gov/iTable/?reqid=19&step=2&isuri=1&categories=survey",
                    timestamp=f"{period[:4]}-01-01T00:00:00Z" if len(period) >= 4 else "",
                    tags=["economic", "bea", "gdp"],
                    metadata={"line": line_desc, "value": value, "period": period},
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] BEA error: %s", exc)
        return items

    async def _fetch_census(self) -> list[DataItem]:
        """Fetch latest Census economic indicators."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("census", "")
        if not api_key:
            return []
        items: list[DataItem] = []
        try:
            # Census economic indicators — retail sales
            year = datetime.now().year
            resp = await self._http.get(
                f"https://api.census.gov/data/timeseries/eits/marts",
                params={
                    "get": "cell_value,time_slot_name,category_code",
                    "key": api_key,
                    "time": f"from+{year - 1}",
                    "data_type_code": "SM",
                    "category_code": "44X72",
                },
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            # First row is headers
            if len(data) > 1:
                for row in data[1:6]:  # Take last 5
                    value = row[0] if len(row) > 0 else ""
                    period = row[1] if len(row) > 1 else ""
                    items.append(DataItem(
                        id=_uid("census", period, value),
                        source="census",
                        source_type="economic",
                        title=f"Retail & Food Services Sales: ${value}M ({period})",
                        description="US Census Bureau — Monthly Retail Trade Survey",
                        url="https://www.census.gov/retail/index.html",
                        timestamp="",
                        tags=["economic", "census", "retail"],
                        metadata={"value": value, "period": period},
                    ))
        except Exception as exc:
            logger.warning("[intelligence_service] Census error: %s", exc)
        return items

    # ─────────────────────────────────────────────────────────────────────────
    # LEGISLATIVE
    # ─────────────────────────────────────────────────────────────────────────

    async def _fetch_legislative(
        self, source_id: str, config: dict, cutoff_time: datetime,
    ) -> list[DataItem]:
        """Fetch legislative data."""
        if source_id == "congress":
            return await self._fetch_congress()
        elif source_id == "openstates":
            return await self._fetch_openstates()
        return []

    async def _fetch_congress(self) -> list[DataItem]:
        """Fetch recent bills from Congress.gov API."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("congress", "")
        if not api_key:
            return []
        items: list[DataItem] = []
        try:
            resp = await self._http.get(
                "https://api.congress.gov/v3/bill",
                params={"limit": 20, "sort": "updateDate+desc", "api_key": api_key},
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            for bill in data.get("bills", []):
                number = bill.get("number", "")
                bill_type = bill.get("type", "")
                title = bill.get("title", "")
                update_date = bill.get("updateDate", "")
                congress = bill.get("congress", "")
                items.append(DataItem(
                    id=_uid("congress", str(congress), bill_type, str(number)),
                    source="congress",
                    source_type="legislative",
                    title=f"{bill_type} {number}: {title}",
                    description=f"Congress {congress} — Latest action: {bill.get('latestAction', {}).get('text', '')}",
                    url=bill.get("url", f"https://www.congress.gov/bill/{congress}th-congress/{bill_type.lower()}-bill/{number}"),
                    timestamp=update_date,
                    tags=["legislative", "congress", bill_type],
                    metadata={
                        "congress": congress,
                        "bill_type": bill_type,
                        "number": number,
                        "latest_action": bill.get("latestAction", {}),
                    },
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] Congress.gov error: %s", exc)
        return items

    async def _fetch_openstates(self) -> list[DataItem]:
        """Fetch recent state legislation from OpenStates."""
        if not self._http:
            return []
        keys = _get_api_keys()
        api_key = keys.get("openstates", "")
        if not api_key:
            return []
        items: list[DataItem] = []
        try:
            resp = await self._http.get(
                "https://v3.openstates.org/bills",
                params={"per_page": 20, "sort": "updated_desc"},
                headers={"X-API-KEY": api_key},
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            for bill in data.get("results", []):
                identifier = bill.get("identifier", "")
                title = bill.get("title", "")
                jurisdiction = bill.get("jurisdiction", {}).get("name", "")
                updated = bill.get("updated_at", "")
                items.append(DataItem(
                    id=_uid("openstates", identifier, jurisdiction),
                    source="openstates",
                    source_type="legislative",
                    title=f"[{jurisdiction}] {identifier}: {title}",
                    description=f"State legislation from {jurisdiction}",
                    url=bill.get("openstates_url", ""),
                    timestamp=updated,
                    tags=["legislative", "openstates", jurisdiction.lower()],
                    metadata={
                        "identifier": identifier,
                        "jurisdiction": jurisdiction,
                        "session": bill.get("session", ""),
                    },
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] OpenStates error: %s", exc)
        return items

    # ─────────────────────────────────────────────────────────────────────────
    # LEGAL
    # ─────────────────────────────────────────────────────────────────────────

    async def _fetch_legal(
        self, source_id: str, config: dict, cutoff_time: datetime,
    ) -> list[DataItem]:
        """Fetch legal data from CourtListener."""
        if source_id == "courtlistener":
            return await self._fetch_courtlistener()
        return []

    async def _fetch_courtlistener(self) -> list[DataItem]:
        """Fetch recent opinions from CourtListener."""
        if not self._http:
            return []
        keys = _get_api_keys()
        token = keys.get("courtlistener", "")
        items: list[DataItem] = []
        headers = {}
        if token:
            headers["Authorization"] = f"Token {token}"
        try:
            resp = await self._http.get(
                "https://www.courtlistener.com/api/rest/v3/opinions/",
                params={"order_by": "-date_created", "page_size": 15},
                headers=headers,
            )
            if resp.status_code != 200:
                return []
            data = resp.json()
            for opinion in data.get("results", []):
                case_name = opinion.get("case_name", opinion.get("cluster", ""))
                date_created = opinion.get("date_created", "")
                court = opinion.get("court", "")
                items.append(DataItem(
                    id=_uid("courtlistener", str(opinion.get("id", ""))),
                    source="courtlistener",
                    source_type="legal",
                    title=case_name or "Court Opinion",
                    description=f"Court: {court}",
                    url=opinion.get("absolute_url", ""),
                    timestamp=date_created,
                    tags=["legal", "courtlistener"],
                    metadata={
                        "court": court,
                        "type": opinion.get("type", ""),
                    },
                ))
        except Exception as exc:
            logger.warning("[intelligence_service] CourtListener error: %s", exc)
        return items


# ── SINGLETON ─────────────────────────────────────────────────────────────────

_service: Optional[IntelligenceService] = None


_collection_task: Optional[asyncio.Task] = None


def init_intelligence_service() -> IntelligenceService:
    """Initialize the singleton service."""
    global _service
    _service = IntelligenceService()
    logger.info("[intelligence_service] Singleton initialized")
    return _service


async def _background_collection_loop(interval_seconds: int = 1800) -> None:
    """
    Background loop: pull intelligence feed every interval_seconds and write
    the top items to memory (ChromaDB L2) with source='intelligence'.
    This gives the interface agent ambient context about current events without
    being asked.
    """
    import asyncio as _asyncio
    logger.info("[intelligence_service] Background collection started (interval=%ds)", interval_seconds)
    while True:
        try:
            svc = get_intelligence_service()
            if svc is None:
                await _asyncio.sleep(60)
                continue

            from app.service.memory_service import get_memory_service
            mem = get_memory_service()
            if mem is None:
                await _asyncio.sleep(60)
                continue

            # Background polls use max_concurrent=3 to stay memory-friendly
            # on constrained hardware; no need for full throughput here.
            feed = await svc.get_aggregated_feed(limit=20, hours_back=6, max_concurrent=3)
            items = feed.get("items", [])
            item_count = len(items)
            last_updated = feed.get("last_updated", "")
            if items:
                # Write each article as its own ChromaDB document with dedup.
                # This gives Interface fine-grained semantic retrieval vs the
                # old monolithic digest blob.
                import time as _time
                written = 0
                for item in items[:20]:
                    title = item.get("title", "")
                    if not title:
                        continue
                    # Deterministic doc_id from title hash — prevents re-writing
                    doc_id = f"intel_{hashlib.md5(title.encode()).hexdigest()[:12]}"

                    # Dedup: skip if already in L2
                    if hasattr(mem, '_collection') and mem._collection is not None:
                        try:
                            existing = mem._collection.get(ids=[doc_id])
                            if existing and existing.get("ids"):
                                continue
                        except Exception:
                            pass

                    description = item.get("description", item.get("summary", ""))[:500]
                    source = item.get("source", "unknown")
                    content = f"[{source}] {title}\n{description}"
                    meta = {
                        "doc_id": doc_id,
                        "source": f"intelligence:{source}",
                        "agent_role": "intelligence_collector",
                        "thread_id": "",
                        "area_id": "",
                        "timestamp": str(_time.time()),
                        "tags": ",".join(item.get("tags", [])),
                    }
                    mem._store_layer2(doc_id, content, meta)
                    try:
                        mem._store_fts5(doc_id, content, meta)
                    except Exception:
                        pass
                    written += 1

                if written > 0:
                    logger.info("[intelligence_service] Background collection wrote %d new items to memory", written)
                else:
                    logger.debug("[intelligence_service] Background collection: all %d items already in memory", item_count)

                # Emit SSE so frontend can show "intelligence updated" indicator
                try:
                    from app.controller.chat_controller import _emit
                    await _emit("intelligence_updated", {
                        "item_count": item_count,
                        "timestamp": last_updated,
                    })
                except Exception:
                    pass
            else:
                logger.debug("[intelligence_service] Background collection: no items returned")

            # Release large objects before the long sleep so they don't sit
            # in memory for 30 minutes on constrained hardware.
            feed = None
            items = None
            import gc as _gc
            _gc.collect()

        except Exception as exc:
            logger.warning("[intelligence_service] Background collection error: %s", exc)

        await _asyncio.sleep(interval_seconds)


def start_background_collection(interval_seconds: int = 1800) -> asyncio.Task:
    """
    Start the background intelligence collection loop as an asyncio Task.
    Called from boot_sequence during Phase 3 service startup.
    interval_seconds: how often to pull and store (default 30 min).
    """
    global _collection_task
    _collection_task = asyncio.create_task(
        _background_collection_loop(interval_seconds),
        name="intelligence_background_collection",
    )
    logger.info("[intelligence_service] Background collection task created")
    return _collection_task


def get_intelligence_service() -> Optional[IntelligenceService]:
    """Get the singleton service."""
    return _service
