"""
AURA NX-Alpha — Real-Time Data Streaming
Live data stream loops for market, news, and weather data.

All streams run as asyncio background tasks and push updates to
an asyncio.Queue that agent templates consume.

Streams:
    MarketDataStream    — yfinance polling loop (1-5s), per-ticker price ticks
    NewsStream          — RSS + NewsAPI polling loop (60s), headline events
    WeatherStream       — Open-Meteo polling loop (600s), conditions + forecasts
    EconomicEventMonitor— FRED release calendar watcher (hourly), alerts on new data

Usage:
    from app.agents.tools.streaming import MarketDataStream

    stream = MarketDataStream(tickers=["AAPL", "NVDA", "SPY"])
    await stream.start()

    async for tick in stream.listen():
        print(tick)

    await stream.stop()
"""

from __future__ import annotations

import asyncio
import logging
import time
from abc import ABC, abstractmethod
from typing import AsyncIterator

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# BASE STREAM
# ─────────────────────────────────────────────────────────────────────────────

class BaseStream(ABC):
    """
    Abstract base for all real-time data streams.
    Subclasses implement _fetch() which is called on a fixed poll interval.
    Results are pushed to an asyncio.Queue; consumers call listen().
    """

    STREAM_ID:    str   = "base_stream"
    POLL_SECONDS: float = 5.0
    QUEUE_MAXSIZE: int  = 500

    def __init__(self) -> None:
        self._queue:    asyncio.Queue = asyncio.Queue(maxsize=self.QUEUE_MAXSIZE)
        self._task:     asyncio.Task | None = None
        self._running:  bool = False
        self._tick_count: int = 0
        self._error_count: int = 0

    @abstractmethod
    async def _fetch(self) -> list[dict]:
        """Poll the data source. Return list of event dicts to enqueue."""

    async def start(self) -> None:
        """Start the background polling loop."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._loop(), name=self.STREAM_ID)
        logger.info("[%s] stream started (poll=%.1fs)", self.STREAM_ID, self.POLL_SECONDS)

    async def stop(self) -> None:
        """Stop the polling loop gracefully."""
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        logger.info("[%s] stream stopped (ticks=%d errors=%d)", self.STREAM_ID, self._tick_count, self._error_count)

    async def _loop(self) -> None:
        while self._running:
            t0 = time.monotonic()
            try:
                events = await self._fetch()
                for event in events:
                    event.setdefault("_stream", self.STREAM_ID)
                    event.setdefault("_ts", time.time())
                    if not self._queue.full():
                        self._queue.put_nowait(event)
                self._tick_count += 1
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self._error_count += 1
                logger.warning("[%s] fetch error: %s", self.STREAM_ID, exc)

            elapsed = time.monotonic() - t0
            sleep_for = max(0, self.POLL_SECONDS - elapsed)
            await asyncio.sleep(sleep_for)

    async def listen(self) -> AsyncIterator[dict]:
        """Async generator — yields events as they arrive."""
        while self._running or not self._queue.empty():
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=1.0)
                yield event
            except asyncio.TimeoutError:
                continue

    def status(self) -> dict:
        return {
            "stream_id":   self.STREAM_ID,
            "running":     self._running,
            "queue_size":  self._queue.qsize(),
            "tick_count":  self._tick_count,
            "error_count": self._error_count,
        }


# ─────────────────────────────────────────────────────────────────────────────
# MARKET DATA STREAM — yfinance polling
# ─────────────────────────────────────────────────────────────────────────────

class MarketDataStream(BaseStream):
    """
    Real-time market data stream via yfinance polling.

    yfinance doesn't expose a native websocket, so we poll on a short
    interval (default 2s) and emit price tick events.

    Events emitted:
        {
            "_stream":   "market_data",
            "_ts":       float,          # unix timestamp
            "ticker":    str,
            "price":     float,
            "change":    float,
            "change_pct": float,
            "volume":    int,
            "bid":       float | None,
            "ask":       float | None,
            "high":      float,
            "low":       float,
        }
    """

    STREAM_ID    = "market_data"
    POLL_SECONDS = 2.0

    def __init__(
        self,
        tickers:       list[str],
        poll_seconds:  float = 2.0,
        include_ohlcv: bool  = False,
    ) -> None:
        super().__init__()
        self.tickers       = [t.upper() for t in tickers]
        self.POLL_SECONDS  = poll_seconds
        self.include_ohlcv = include_ohlcv
        self._prev_prices: dict[str, float] = {}

    async def _fetch(self) -> list[dict]:
        try:
            from app.service.finance_service import get_finance_service
            svc = get_finance_service()
            quotes = await svc.get_quotes(self.tickers)
            events = []
            for q in quotes:
                ticker = q.get("symbol", "")
                price  = q.get("price", 0.0)
                prev   = self._prev_prices.get(ticker)
                # Only emit if price changed (or first tick)
                if prev is None or abs(price - prev) > 0.0001:
                    self._prev_prices[ticker] = price
                    event = {
                        "ticker":     ticker,
                        "price":      price,
                        "change":     q.get("change", 0.0),
                        "change_pct": q.get("change_pct", 0.0),
                        "volume":     q.get("volume", 0),
                        "high":       q.get("high", 0.0),
                        "low":        q.get("low", 0.0),
                    }
                    if self.include_ohlcv:
                        event["ohlcv"] = q.get("ohlcv", [])
                    events.append(event)
            return events
        except Exception as exc:
            logger.warning("[market_data] fetch failed: %s", exc)
            return []

    def add_ticker(self, ticker: str) -> None:
        if ticker.upper() not in self.tickers:
            self.tickers.append(ticker.upper())

    def remove_ticker(self, ticker: str) -> None:
        self.tickers = [t for t in self.tickers if t != ticker.upper()]


# ─────────────────────────────────────────────────────────────────────────────
# NEWS STREAM — RSS + NewsAPI polling
# ─────────────────────────────────────────────────────────────────────────────

class NewsStream(BaseStream):
    """
    Real-time news stream. Polls RSS feeds every 60s and NewsAPI every 5 minutes.
    Deduplicates by URL to avoid re-emitting seen articles.

    Events emitted:
        {
            "_stream":    "news",
            "_ts":        float,
            "title":      str,
            "summary":    str,
            "source":     str,
            "url":        str,
            "published":  str,
            "category":   str | None,   # "finance", "macro", "crypto", etc.
            "tickers":    list[str],     # mentioned tickers (naive extraction)
        }
    """

    STREAM_ID    = "news"
    POLL_SECONDS = 60.0

    # Finance-relevant RSS feeds (all free, no key required)
    FINANCE_FEEDS = {
        "reuters_finance":     "https://feeds.reuters.com/reuters/businessNews",
        "ap_finance":          "https://feeds.apnews.com/rss/business",
        "marketwatch":         "https://feeds.marketwatch.com/marketwatch/topstories",
        "seeking_alpha":       "https://seekingalpha.com/feed.xml",
        "yahoo_finance":       "https://finance.yahoo.com/news/rssindex",
        "cnbc_markets":        "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839135",
        "bloomberg_markets":   "https://feeds.bloomberg.com/markets/news.rss",
        "ft_markets":          "https://www.ft.com/rss/home/uk",
        "wsj_markets":         "https://feeds.a.dj.com/rss/RSSMarketsMain.xml",
        "investing_news":      "https://www.investing.com/rss/news.rss",
        "coindesk":            "https://www.coindesk.com/arc/outboundfeeds/rss/",
        "cointelegraph":       "https://cointelegraph.com/rss",
    }

    # Known tickers to watch for in headlines (naive string matching)
    WATCHLIST_TICKERS = [
        "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA",
        "BTC", "ETH", "SOL", "SPY", "QQQ", "TLT", "GLD",
        "JPM", "BAC", "GS", "MS", "V", "MA",
        "XOM", "CVX", "OXY", "WTI", "BRENT",
        "NFLX", "AMD", "INTC", "QCOM", "ARM",
    ]

    def __init__(
        self,
        poll_seconds:     float       = 60.0,
        newsapi_interval: int         = 300,   # seconds between NewsAPI calls
        keywords:         list[str] | None = None,
    ) -> None:
        super().__init__()
        self.POLL_SECONDS     = poll_seconds
        self._newsapi_interval = newsapi_interval
        self._keywords         = keywords or ["market", "stock", "economy", "fed", "inflation", "crypto"]
        self._seen_urls:       set[str] = set()
        self._newsapi_last:    float = 0.0

    async def _fetch(self) -> list[dict]:
        events: list[dict] = []

        # ── RSS feeds ────────────────────────────────────────────────────────
        try:
            from app.service.news_service import get_news_service
            svc = get_news_service()
            if svc:
                # Fetch existing configured feeds
                all_articles = await svc.fetch_all(limit_per_feed=20)
                for article in all_articles:
                    url = article.get("url") or article.get("link", "")
                    if url and url not in self._seen_urls:
                        self._seen_urls.add(url)
                        events.append(self._normalize_article(article))
        except Exception as exc:
            logger.warning("[news_stream] RSS fetch failed: %s", exc)

        # ── NewsAPI (rate-limited to once per newsapi_interval) ───────────────
        now = time.time()
        if (now - self._newsapi_last) >= self._newsapi_interval:
            try:
                from app.agents.tools.free_sources import get_free_sources
                fs = get_free_sources()
                for kw in self._keywords[:3]:  # limit to 3 keywords per cycle
                    articles = await fs.news_search(kw, page_size=10)
                    for a in articles:
                        url = a.get("url", "")
                        if url and url not in self._seen_urls:
                            self._seen_urls.add(url)
                            events.append(self._normalize_newsapi_article(a))
                self._newsapi_last = now
            except Exception as exc:
                logger.warning("[news_stream] NewsAPI fetch failed: %s", exc)

        # Trim seen_urls to prevent unbounded growth
        if len(self._seen_urls) > 10000:
            self._seen_urls = set(list(self._seen_urls)[-5000:])

        return events

    def _normalize_article(self, a: dict) -> dict:
        text = f"{a.get('title', '')} {a.get('summary', '')}"
        return {
            "title":     a.get("title", ""),
            "summary":   a.get("summary", "")[:400],
            "source":    a.get("source", ""),
            "url":       a.get("url") or a.get("link", ""),
            "published": a.get("published", ""),
            "category":  self._classify(text),
            "tickers":   self._extract_tickers(text),
        }

    def _normalize_newsapi_article(self, a: dict) -> dict:
        text = f"{a.get('title', '')} {a.get('description', '')}"
        return {
            "title":     a.get("title", ""),
            "summary":   a.get("description", "")[:400],
            "source":    a.get("source", ""),
            "url":       a.get("url", ""),
            "published": a.get("published_at", ""),
            "category":  self._classify(text),
            "tickers":   self._extract_tickers(text),
        }

    def _classify(self, text: str) -> str:
        text_lower = text.lower()
        if any(w in text_lower for w in ["bitcoin", "ethereum", "crypto", "blockchain", "defi", "nft"]):
            return "crypto"
        if any(w in text_lower for w in ["fed", "federal reserve", "rate", "fomc", "powell", "inflation", "cpi"]):
            return "macro"
        if any(w in text_lower for w in ["earnings", "revenue", "profit", "eps", "guidance", "outlook"]):
            return "earnings"
        if any(w in text_lower for w in ["merger", "acquisition", "ipo", "deal", "buyout", "takeover"]):
            return "ma"
        if any(w in text_lower for w in ["oil", "energy", "gas", "opec", "barrel"]):
            return "energy"
        return "finance"

    def _extract_tickers(self, text: str) -> list[str]:
        found = []
        for ticker in self.WATCHLIST_TICKERS:
            if ticker in text.upper():
                found.append(ticker)
        return found


# ─────────────────────────────────────────────────────────────────────────────
# WEATHER STREAM — Open-Meteo polling
# ─────────────────────────────────────────────────────────────────────────────

class WeatherStream(BaseStream):
    """
    Real-time weather stream. Polls Open-Meteo every 10 minutes
    for current conditions and 7-day forecast at one or more locations.

    Events emitted:
        {
            "_stream":      "weather",
            "_ts":          float,
            "location":     {"lat": float, "lon": float, "name": str},
            "current":      dict,         # temp, wind, humidity, etc.
            "forecast":     list[dict],   # 7-day daily forecast
            "impact":       str | None,   # "severe", "watch", "normal"
        }
    """

    STREAM_ID    = "weather"
    POLL_SECONDS = 600.0   # 10 minutes

    def __init__(
        self,
        locations: list[dict] | None = None,
        poll_seconds: float = 600.0,
    ) -> None:
        super().__init__()
        self.POLL_SECONDS = poll_seconds
        # Default: major US financial/agricultural hubs
        self.locations = locations or [
            {"lat": 40.7128, "lon": -74.0060, "name": "New York"},
            {"lat": 41.8781, "lon": -87.6298, "name": "Chicago"},
            {"lat": 34.0522, "lon": -118.2437, "name": "Los Angeles"},
            {"lat": 29.7604, "lon": -95.3698, "name": "Houston"},   # energy hub
            {"lat": 41.6611, "lon": -91.5302, "name": "Iowa City"}, # corn belt
        ]

    async def _fetch(self) -> list[dict]:
        events: list[dict] = []
        try:
            from app.service.weather_service import get_weather_service
            svc = get_weather_service()
            if svc is None:
                return []

            for loc in self.locations:
                lat, lon, name = loc["lat"], loc["lon"], loc.get("name", "")
                current  = await svc.get_current(lat, lon)
                forecast = await svc.get_forecast(lat, lon, days=7)
                if current:
                    events.append({
                        "location": {"lat": lat, "lon": lon, "name": name},
                        "current":  current,
                        "forecast": forecast,
                        "impact":   self._assess_impact(current, forecast),
                    })
        except Exception as exc:
            logger.warning("[weather_stream] fetch failed: %s", exc)
        return events

    def _assess_impact(self, current: dict, forecast: list[dict]) -> str:
        """Classify weather impact on markets/agriculture/energy."""
        code = current.get("weather_code", 0)
        wind = current.get("wind_speed_10m", 0) or 0
        temp = current.get("temperature_2m", 20) or 20

        # Severe conditions
        if code >= 95:                return "severe"  # thunderstorm
        if code in (71, 73, 75, 77): return "watch"   # heavy snow
        if wind > 50:                return "severe"   # high winds
        if temp < -10 or temp > 40:  return "watch"   # extreme temp

        # Check forecast for upcoming severe events
        for day in forecast[:3]:
            if (day.get("weather_code") or 0) >= 95:
                return "watch"
            if (day.get("wind_speed_max") or 0) > 50:
                return "watch"

        return "normal"


# ─────────────────────────────────────────────────────────────────────────────
# ECONOMIC EVENT MONITOR — FRED release calendar watcher
# ─────────────────────────────────────────────────────────────────────────────

class EconomicEventMonitor(BaseStream):
    """
    Watches the FRED economic data release calendar.
    Emits an event when new economic data becomes available.

    Events emitted:
        {
            "_stream":    "economic_event",
            "_ts":        float,
            "release_date": str,          # YYYY-MM-DD
            "release_name": str,
            "series_ids":   list[str],    # affected FRED series
            "priority":     str,          # "high", "medium", "low"
        }

    Also fetches new data for high-priority series on release day.
    """

    STREAM_ID    = "economic_event"
    POLL_SECONDS = 3600.0   # check hourly

    # High-priority releases that drive market moves
    HIGH_PRIORITY = {
        "employment situation",  # jobs report
        "consumer price index",  # cpi
        "gross domestic product", # gdp
        "federal open market committee", # fed meeting
        "retail sales",
        "producer price index",
        "personal income",
    }

    def __init__(self, poll_seconds: float = 3600.0) -> None:
        super().__init__()
        self.POLL_SECONDS     = poll_seconds
        self._seen_releases:  set[str] = set()
        self._last_fetch_date: str     = ""

    async def _fetch(self) -> list[dict]:
        import datetime
        today = datetime.date.today().isoformat()
        if today == self._last_fetch_date:
            return []   # already fetched today's releases

        events: list[dict] = []
        try:
            from app.agents.tools.free_sources import get_free_sources
            fs = get_free_sources()
            releases = await fs.fred_release_dates(limit=20)

            for r in releases:
                date = r.get("date", "")
                name = r.get("release_name", "")
                key  = f"{date}:{name}"

                if key in self._seen_releases:
                    continue
                if date >= today:  # upcoming or today
                    self._seen_releases.add(key)
                    priority = "high" if any(p in name.lower() for p in self.HIGH_PRIORITY) else "medium"
                    events.append({
                        "release_date": date,
                        "release_name": name,
                        "release_id":   r.get("release_id"),
                        "priority":     priority,
                    })

            self._last_fetch_date = today
        except Exception as exc:
            logger.warning("[economic_event] fetch failed: %s", exc)

        return events


# ─────────────────────────────────────────────────────────────────────────────
# STREAM MANAGER — singleton registry of active streams
# ─────────────────────────────────────────────────────────────────────────────

class StreamManager:
    """
    Central registry for all active data streams.
    The Planner and agent templates use this to access shared streams
    without creating duplicate polling loops.
    """

    def __init__(self) -> None:
        self._streams: dict[str, BaseStream] = {}

    def register(self, stream: BaseStream) -> None:
        """Register a stream. Replaces existing stream with same ID."""
        self._streams[stream.STREAM_ID] = stream

    def get(self, stream_id: str) -> BaseStream | None:
        return self._streams.get(stream_id)

    async def start_all(self) -> None:
        for stream in self._streams.values():
            await stream.start()

    async def stop_all(self) -> None:
        for stream in self._streams.values():
            await stream.stop()

    def status_all(self) -> list[dict]:
        return [s.status() for s in self._streams.values()]

    async def start_defaults(
        self,
        market_tickers: list[str] | None = None,
    ) -> None:
        """
        Start the default set of streams used by the trading center.

        Called from the AURA backend lifespan or on-demand by the planner.
        """
        default_tickers = market_tickers or [
            "SPY", "QQQ", "IWM", "DIA",         # indices
            "AAPL", "MSFT", "NVDA", "GOOGL",     # mega-cap tech
            "TSLA", "AMZN", "META",              # high-volatility
            "GLD", "TLT", "VXX",                 # hedges
        ]

        market_stream = MarketDataStream(tickers=default_tickers, poll_seconds=2.0)
        news_stream   = NewsStream(poll_seconds=60.0)
        weather_stream = WeatherStream(poll_seconds=600.0)
        econ_monitor  = EconomicEventMonitor(poll_seconds=3600.0)

        self.register(market_stream)
        self.register(news_stream)
        self.register(weather_stream)
        self.register(econ_monitor)

        await self.start_all()
        logger.info("[StreamManager] Default streams started: %s", list(self._streams.keys()))


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_manager: StreamManager | None = None


def get_stream_manager() -> StreamManager:
    """Return the global StreamManager singleton."""
    global _manager
    if _manager is None:
        _manager = StreamManager()
    return _manager
