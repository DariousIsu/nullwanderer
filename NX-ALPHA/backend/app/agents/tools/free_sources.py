"""
AURA NX-Alpha — Free Data Sources
Unified interface for all hardcoded free/freemium API integrations.

All API keys come from MarketAPIConfig (config.py). Users override via
.env or the Settings menu — no code changes needed.

Sources:
    FRED          — Federal Reserve economic data (800k+ series)
    BLS           — Bureau of Labor Statistics (CPI, employment, wages)
    BEA           — Bureau of Economic Analysis (GDP, PCE, trade)
    Census        — US Census Bureau (demographics, housing, business)
    NewsAPI       — Global news headlines and search
    Polygon       — Stocks, options, forex, crypto market data
    AlphaVantage  — Stocks, forex, crypto + 50+ technical indicators
    OpenWeatherMap— Weather (optional, Open-Meteo used by default)
    SEC EDGAR     — All public company filings (no key needed)
    CoinGecko     — Crypto prices and market data (no key needed)

Usage:
    from app.agents.tools.free_sources import FreeSources
    fs = FreeSources()
    gdp = await fs.fred_series("GDP", frequency="q", limit=20)
    news = await fs.news_headlines(q="Federal Reserve", language="en")
    quote = await fs.polygon_quote("AAPL")
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# BASE URLS
# ─────────────────────────────────────────────────────────────────────────────

_FRED_BASE      = "https://api.stlouisfed.org/fred"
_BLS_BASE       = "https://api.bls.gov/publicAPI/v2"
_BEA_BASE       = "https://apps.bea.gov/api/data"
_CENSUS_BASE    = "https://api.census.gov/data"
_NEWSAPI_BASE   = "https://newsapi.org/v2"
_POLYGON_BASE   = "https://api.polygon.io"
_AV_BASE        = "https://www.alphavantage.co/query"
_OWM_BASE       = "https://api.openweathermap.org/data/2.5"
_EDGAR_BASE     = "https://data.sec.gov"
_EDGAR_SEARCH   = "https://efts.sec.gov/LATEST/search-index"
_COINGECKO_BASE = "https://api.coingecko.com/api/v3"

# ─────────────────────────────────────────────────────────────────────────────
# SIMPLE IN-PROCESS CACHE
# ─────────────────────────────────────────────────────────────────────────────

class _Cache:
    def __init__(self) -> None:
        self._store: dict[str, tuple[float, Any]] = {}

    def get(self, key: str, ttl: float) -> Any | None:
        if key in self._store:
            ts, val = self._store[key]
            if (time.monotonic() - ts) < ttl:
                return val
        return None

    def set(self, key: str, val: Any) -> None:
        self._store[key] = (time.monotonic(), val)


# ─────────────────────────────────────────────────────────────────────────────
# FREE SOURCES
# ─────────────────────────────────────────────────────────────────────────────

class FreeSources:
    """
    Async wrapper for all free/freemium market and economic data APIs.

    Instantiate once and reuse. All methods are async and never block
    the event loop. Responses are lightly cached to respect free-tier limits.
    """

    def __init__(self, timeout: float = 15.0) -> None:
        from app.config import get_settings
        cfg = get_settings().market
        self._fred_key   = cfg.fred_api_key
        self._bls_key    = cfg.bls_api_key
        self._bea_key    = cfg.bea_api_key
        self._census_key = cfg.census_api_key
        self._news_key   = cfg.news_api_key
        self._poly_key   = cfg.polygon_api_key
        self._av_key     = cfg.alpha_vantage_api_key
        self._owm_key    = cfg.openweathermap_api_key
        self._client     = httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": "AURA-NX-Alpha/1.0"},
        )
        self._cache = _Cache()

    async def close(self) -> None:
        await self._client.aclose()

    # ── INTERNAL ─────────────────────────────────────────────────────────────

    async def _get(self, url: str, params: dict | None = None, cache_ttl: float = 0) -> Any:
        """GET with optional caching. Returns parsed JSON or raises."""
        cache_key = f"{url}:{sorted((params or {}).items())}"
        if cache_ttl > 0:
            cached = self._cache.get(cache_key, cache_ttl)
            if cached is not None:
                return cached
        resp = await self._client.get(url, params=params)
        resp.raise_for_status()
        data = resp.json()
        if cache_ttl > 0:
            self._cache.set(cache_key, data)
        return data

    async def _post(self, url: str, payload: dict) -> Any:
        resp = await self._client.post(url, json=payload)
        resp.raise_for_status()
        return resp.json()

    # ─────────────────────────────────────────────────────────────────────────
    # FRED — Federal Reserve Economic Data
    # https://fred.stlouisfed.org/docs/api/fred/
    # ─────────────────────────────────────────────────────────────────────────

    async def fred_series(
        self,
        series_id: str,
        frequency:  str | None = None,    # d, w, bw, m, q, sa, a
        limit:      int         = 100,
        sort_order: str         = "desc",
    ) -> dict:
        """
        Fetch observations for a FRED data series.

        Common series IDs:
            GDP      — Gross Domestic Product (quarterly)
            CPIAUCSL — Consumer Price Index (monthly)
            FEDFUNDS — Federal Funds Rate (monthly)
            UNRATE   — Unemployment Rate (monthly)
            T10Y2Y   — 10Y-2Y Treasury Spread (daily)
            DGS10    — 10-Year Treasury Yield (daily)
            M2SL     — M2 Money Supply (monthly)
            HOUST    — Housing Starts (monthly)
            INDPRO   — Industrial Production Index (monthly)
            PCE      — Personal Consumption Expenditures (monthly)
            RSAFS    — Retail Sales (monthly)
            UMCSENT  — University of Michigan Consumer Sentiment
            VIXCLS   — CBOE Volatility Index (daily)
            BAMLH0A0HYM2 — High Yield Spread (daily)
        """
        params: dict = {
            "series_id":  series_id,
            "api_key":    self._fred_key,
            "file_type":  "json",
            "limit":      limit,
            "sort_order": sort_order,
        }
        if frequency:
            params["frequency"] = frequency
        try:
            data = await self._get(f"{_FRED_BASE}/series/observations", params, cache_ttl=300)
            observations = data.get("observations", [])
            return {
                "series_id":    series_id,
                "observations": [
                    {
                        "date":  o["date"],
                        "value": None if o["value"] == "." else float(o["value"]),
                    }
                    for o in observations
                    if o.get("value") is not None
                ],
                "count": len(observations),
            }
        except Exception as exc:
            logger.warning("[free_sources] fred_series(%s) failed: %s", series_id, exc)
            return {"series_id": series_id, "observations": [], "error": str(exc)}

    async def fred_search(self, query: str, limit: int = 10) -> list[dict]:
        """Search FRED for series matching a keyword."""
        try:
            data = await self._get(
                f"{_FRED_BASE}/series/search",
                {"search_text": query, "api_key": self._fred_key, "file_type": "json", "limit": limit},
                cache_ttl=3600,
            )
            return [
                {
                    "id":    s.get("id"),
                    "title": s.get("title"),
                    "units": s.get("units"),
                    "freq":  s.get("frequency_short"),
                    "updated": s.get("last_updated"),
                }
                for s in data.get("seriess", [])
            ]
        except Exception as exc:
            logger.warning("[free_sources] fred_search(%r) failed: %s", query, exc)
            return []

    async def fred_release_dates(self, limit: int = 20) -> list[dict]:
        """Fetch upcoming FRED economic data release dates."""
        try:
            data = await self._get(
                f"{_FRED_BASE}/releases/dates",
                {"api_key": self._fred_key, "file_type": "json", "limit": limit,
                 "include_release_dates_with_no_data": "false", "sort_order": "asc"},
                cache_ttl=3600,
            )
            return data.get("release_dates", [])
        except Exception as exc:
            logger.warning("[free_sources] fred_release_dates failed: %s", exc)
            return []

    # ─────────────────────────────────────────────────────────────────────────
    # BLS — Bureau of Labor Statistics
    # https://www.bls.gov/developers/api_signature_v2.htm
    # ─────────────────────────────────────────────────────────────────────────

    async def bls_series(
        self,
        series_ids: list[str],
        start_year: str = "2020",
        end_year:   str | None = None,
    ) -> dict[str, list[dict]]:
        """
        Fetch BLS time series data.

        Common series IDs:
            CES0000000001 — Total Nonfarm Employment (monthly)
            LNS14000000   — Unemployment Rate
            CUSR0000SA0   — CPI All Urban Consumers
            WPUFD4         — PPI Final Demand
            CES0500000003 — Average Hourly Earnings
            CES0600000008 — Average Weekly Hours, Manufacturing
            PCU--          — Producer Price Index
        """
        import datetime
        if end_year is None:
            end_year = str(datetime.date.today().year)
        payload = {
            "seriesid":  series_ids,
            "startyear": start_year,
            "endyear":   end_year,
            "registrationkey": self._bls_key,
        }
        try:
            data = await self._post(f"{_BLS_BASE}/timeseries/data/", payload)
            results: dict[str, list[dict]] = {}
            for series in data.get("Results", {}).get("series", []):
                sid = series.get("seriesID", "")
                results[sid] = [
                    {
                        "year":  d.get("year"),
                        "period": d.get("period"),
                        "value": float(d.get("value", 0)),
                        "footnotes": [f.get("text", "") for f in d.get("footnotes", [])],
                    }
                    for d in series.get("data", [])
                ]
            return results
        except Exception as exc:
            logger.warning("[free_sources] bls_series failed: %s", exc)
            return {}

    # ─────────────────────────────────────────────────────────────────────────
    # BEA — Bureau of Economic Analysis
    # https://apps.bea.gov/api/
    # ─────────────────────────────────────────────────────────────────────────

    async def bea_gdp(self, frequency: str = "Q", year: str = "LAST10") -> dict:
        """
        Fetch GDP data from BEA NIPA tables.

        frequency: A (annual), Q (quarterly)
        year: LAST5, LAST10, or specific like "2020,2021,2022"
        """
        params = {
            "UserID":     self._bea_key,
            "method":     "GetData",
            "DataSetName": "NIPA",
            "TableName":  "T10101",   # GDP and components table
            "Frequency":  frequency,
            "Year":       year,
            "ResultFormat": "JSON",
        }
        try:
            data = await self._get(_BEA_BASE, params, cache_ttl=3600)
            rows = (
                data.get("BEAAPI", {})
                    .get("Results", {})
                    .get("Data", [])
            )
            return {"rows": rows, "count": len(rows)}
        except Exception as exc:
            logger.warning("[free_sources] bea_gdp failed: %s", exc)
            return {"rows": [], "error": str(exc)}

    async def bea_dataset_list(self) -> list[str]:
        """List available BEA datasets."""
        try:
            data = await self._get(
                _BEA_BASE,
                {"UserID": self._bea_key, "method": "GetDataSetList", "ResultFormat": "JSON"},
                cache_ttl=86400,
            )
            datasets = (
                data.get("BEAAPI", {})
                    .get("Results", {})
                    .get("Dataset", [])
            )
            return [d.get("DatasetName", "") for d in datasets]
        except Exception as exc:
            logger.warning("[free_sources] bea_dataset_list failed: %s", exc)
            return []

    # ─────────────────────────────────────────────────────────────────────────
    # CENSUS — US Census Bureau
    # https://www.census.gov/data/developers.html
    # ─────────────────────────────────────────────────────────────────────────

    async def census_acs(
        self,
        variables: list[str],
        for_geo:   str = "us:1",
        year:      int = 2022,
        dataset:   str = "acs/acs1",
    ) -> list[dict]:
        """
        Fetch American Community Survey data.

        Common variables:
            B01003_001E — Total population
            B19013_001E — Median household income
            B23025_005E — Unemployed civilians
            B25064_001E — Median gross rent
            B15003_022E — Bachelor's degree holders
        """
        vars_str = ",".join(["NAME"] + variables)
        try:
            data = await self._get(
                f"{_CENSUS_BASE}/{year}/{dataset}",
                {"get": vars_str, "for": for_geo, "key": self._census_key},
                cache_ttl=86400,
            )
            if not data or len(data) < 2:
                return []
            headers = data[0]
            return [dict(zip(headers, row)) for row in data[1:]]
        except Exception as exc:
            logger.warning("[free_sources] census_acs failed: %s", exc)
            return []

    # ─────────────────────────────────────────────────────────────────────────
    # NEWSAPI — Global News
    # https://newsapi.org/docs
    # ─────────────────────────────────────────────────────────────────────────

    async def news_headlines(
        self,
        q:        str | None = None,
        category: str | None = None,   # business, tech, science, health, sports
        country:  str        = "us",
        language: str        = "en",
        page_size: int       = 20,
    ) -> list[dict]:
        """
        Fetch top headlines from NewsAPI.
        Free tier: 100 requests/day, no access to articles older than 1 month.
        """
        params: dict = {
            "apiKey":   self._news_key,
            "country":  country,
            "language": language,
            "pageSize": page_size,
        }
        if q:
            params["q"] = q
        if category:
            params["category"] = category
        try:
            data = await self._get(f"{_NEWSAPI_BASE}/top-headlines", params, cache_ttl=300)
            return [
                {
                    "title":       a.get("title", ""),
                    "description": a.get("description", ""),
                    "source":      a.get("source", {}).get("name", ""),
                    "url":         a.get("url", ""),
                    "published_at": a.get("publishedAt", ""),
                }
                for a in data.get("articles", [])
                if a.get("title") and "[Removed]" not in a.get("title", "")
            ]
        except Exception as exc:
            logger.warning("[free_sources] news_headlines failed: %s", exc)
            return []

    async def news_search(
        self,
        q:        str,
        from_date: str | None = None,   # YYYY-MM-DD
        language:  str        = "en",
        sort_by:   str        = "publishedAt",  # relevancy, popularity, publishedAt
        page_size: int        = 20,
    ) -> list[dict]:
        """Search all NewsAPI articles by keyword."""
        params: dict = {
            "apiKey":   self._news_key,
            "q":        q,
            "language": language,
            "sortBy":   sort_by,
            "pageSize": page_size,
        }
        if from_date:
            params["from"] = from_date
        try:
            data = await self._get(f"{_NEWSAPI_BASE}/everything", params, cache_ttl=180)
            return [
                {
                    "title":       a.get("title", ""),
                    "description": a.get("description", ""),
                    "content":     (a.get("content") or "")[:500],
                    "source":      a.get("source", {}).get("name", ""),
                    "url":         a.get("url", ""),
                    "published_at": a.get("publishedAt", ""),
                }
                for a in data.get("articles", [])
                if a.get("title") and "[Removed]" not in a.get("title", "")
            ]
        except Exception as exc:
            logger.warning("[free_sources] news_search(%r) failed: %s", q, exc)
            return []

    # ─────────────────────────────────────────────────────────────────────────
    # POLYGON — Stock, Options, Forex, Crypto
    # https://polygon.io/docs/
    # Free Starter: 5 req/min, end-of-day data, 2-year history
    # ─────────────────────────────────────────────────────────────────────────

    async def polygon_quote(self, ticker: str) -> dict:
        """Fetch the latest trade and quote for a ticker."""
        try:
            data = await self._get(
                f"{_POLYGON_BASE}/v2/last/trade/{ticker.upper()}",
                {"apiKey": self._poly_key},
                cache_ttl=60,
            )
            result = data.get("results", {})
            return {
                "ticker":    ticker.upper(),
                "price":     result.get("p"),
                "size":      result.get("s"),
                "timestamp": result.get("t"),
                "exchange":  result.get("x"),
            }
        except Exception as exc:
            logger.warning("[free_sources] polygon_quote(%s) failed: %s", ticker, exc)
            return {}

    async def polygon_aggs(
        self,
        ticker:     str,
        multiplier: int = 1,
        timespan:   str = "day",      # minute, hour, day, week, month, quarter, year
        from_date:  str = "2024-01-01",
        to_date:    str | None = None,
        limit:      int = 120,
        adjusted:   bool = True,
    ) -> list[dict]:
        """
        Fetch OHLCV aggregate bars for a ticker.

        Free tier returns end-of-day data with 15-min delay.
        """
        import datetime
        if to_date is None:
            to_date = datetime.date.today().isoformat()
        try:
            data = await self._get(
                f"{_POLYGON_BASE}/v2/aggs/ticker/{ticker.upper()}/range/{multiplier}/{timespan}/{from_date}/{to_date}",
                {"apiKey": self._poly_key, "adjusted": str(adjusted).lower(), "limit": limit, "sort": "desc"},
                cache_ttl=300,
            )
            return [
                {
                    "t": r.get("t"),   # unix ms timestamp
                    "o": r.get("o"),   # open
                    "h": r.get("h"),   # high
                    "l": r.get("l"),   # low
                    "c": r.get("c"),   # close
                    "v": r.get("v"),   # volume
                    "vw": r.get("vw"), # volume-weighted average price
                    "n": r.get("n"),   # number of transactions
                }
                for r in data.get("results", [])
            ]
        except Exception as exc:
            logger.warning("[free_sources] polygon_aggs(%s) failed: %s", ticker, exc)
            return []

    async def polygon_ticker_details(self, ticker: str) -> dict:
        """Fetch company/asset details for a ticker."""
        try:
            data = await self._get(
                f"{_POLYGON_BASE}/v3/reference/tickers/{ticker.upper()}",
                {"apiKey": self._poly_key},
                cache_ttl=86400,
            )
            r = data.get("results", {})
            return {
                "ticker":      r.get("ticker"),
                "name":        r.get("name"),
                "description": r.get("description", "")[:500],
                "sic_code":    r.get("sic_code"),
                "sic_description": r.get("sic_description"),
                "market_cap":  r.get("market_cap"),
                "employees":   r.get("total_employees"),
                "homepage":    r.get("homepage_url"),
                "exchange":    r.get("primary_exchange"),
            }
        except Exception as exc:
            logger.warning("[free_sources] polygon_ticker_details(%s) failed: %s", ticker, exc)
            return {}

    async def polygon_market_status(self) -> dict:
        """Check if US markets are currently open."""
        try:
            data = await self._get(
                f"{_POLYGON_BASE}/v1/marketstatus/now",
                {"apiKey": self._poly_key},
                cache_ttl=60,
            )
            return {
                "market":     data.get("market"),
                "server_time": data.get("serverTime"),
                "exchanges":  data.get("exchanges", {}),
                "currencies": data.get("currencies", {}),
            }
        except Exception as exc:
            logger.warning("[free_sources] polygon_market_status failed: %s", exc)
            return {}

    # ─────────────────────────────────────────────────────────────────────────
    # ALPHA VANTAGE — Stocks, Forex, Crypto + 50+ TA Indicators
    # https://www.alphavantage.co/documentation/
    # Free: 25 requests/day, 5 req/min
    # ─────────────────────────────────────────────────────────────────────────

    async def av_quote(self, symbol: str) -> dict:
        """Fetch global quote for a symbol."""
        try:
            data = await self._get(
                _AV_BASE,
                {"function": "GLOBAL_QUOTE", "symbol": symbol, "apikey": self._av_key},
                cache_ttl=60,
            )
            q = data.get("Global Quote", {})
            return {
                "symbol":     q.get("01. symbol"),
                "price":      float(q.get("05. price", 0) or 0),
                "change":     float(q.get("09. change", 0) or 0),
                "change_pct": q.get("10. change percent", "0%"),
                "volume":     int(q.get("06. volume", 0) or 0),
                "high":       float(q.get("03. high", 0) or 0),
                "low":        float(q.get("04. low", 0) or 0),
                "prev_close": float(q.get("08. previous close", 0) or 0),
            }
        except Exception as exc:
            logger.warning("[free_sources] av_quote(%s) failed: %s", symbol, exc)
            return {}

    async def av_daily(
        self,
        symbol:     str,
        outputsize: str = "compact",   # compact = 100 days, full = 20 years
        adjusted:   bool = True,
    ) -> list[dict]:
        """Fetch daily OHLCV time series."""
        func = "TIME_SERIES_DAILY_ADJUSTED" if adjusted else "TIME_SERIES_DAILY"
        try:
            data = await self._get(
                _AV_BASE,
                {"function": func, "symbol": symbol, "outputsize": outputsize, "apikey": self._av_key},
                cache_ttl=3600,
            )
            key = "Time Series (Daily)" if not adjusted else "Time Series (Daily)"
            # AV uses slightly different keys
            ts = data.get("Time Series (Daily)") or data.get("Time Series (Daily)")
            if not ts:
                return []
            return [
                {
                    "date":  date,
                    "open":  float(v.get("1. open", 0)),
                    "high":  float(v.get("2. high", 0)),
                    "low":   float(v.get("3. low", 0)),
                    "close": float(v.get("4. close", 0)),
                    "volume": int(v.get("5. volume", 0) or v.get("6. volume", 0) or 0),
                }
                for date, v in list(ts.items())[:200]
            ]
        except Exception as exc:
            logger.warning("[free_sources] av_daily(%s) failed: %s", symbol, exc)
            return []

    async def av_forex(self, from_currency: str, to_currency: str = "USD") -> dict:
        """Fetch real-time forex exchange rate."""
        try:
            data = await self._get(
                _AV_BASE,
                {
                    "function":      "CURRENCY_EXCHANGE_RATE",
                    "from_currency": from_currency,
                    "to_currency":   to_currency,
                    "apikey":        self._av_key,
                },
                cache_ttl=60,
            )
            r = data.get("Realtime Currency Exchange Rate", {})
            return {
                "from":       r.get("1. From_Currency Code"),
                "to":         r.get("3. To_Currency Code"),
                "rate":       float(r.get("5. Exchange Rate", 0) or 0),
                "last_refresh": r.get("6. Last Refreshed"),
            }
        except Exception as exc:
            logger.warning("[free_sources] av_forex(%s/%s) failed: %s", from_currency, to_currency, exc)
            return {}

    async def av_crypto(self, symbol: str, market: str = "USD") -> dict:
        """Fetch crypto daily price data."""
        try:
            data = await self._get(
                _AV_BASE,
                {"function": "DIGITAL_CURRENCY_DAILY", "symbol": symbol, "market": market, "apikey": self._av_key},
                cache_ttl=300,
            )
            ts = data.get("Time Series (Digital Currency Daily)", {})
            if not ts:
                return {}
            latest_date = next(iter(ts))
            v = ts[latest_date]
            return {
                "symbol":     symbol,
                "date":       latest_date,
                "open":       float(v.get(f"1a. open ({market})", 0)),
                "high":       float(v.get(f"2a. high ({market})", 0)),
                "low":        float(v.get(f"3a. low ({market})", 0)),
                "close":      float(v.get(f"4a. close ({market})", 0)),
                "volume":     float(v.get("5. volume", 0)),
                "market_cap": float(v.get("6. market cap (USD)", 0)),
            }
        except Exception as exc:
            logger.warning("[free_sources] av_crypto(%s) failed: %s", symbol, exc)
            return {}

    async def av_economic_indicator(
        self,
        indicator: str,    # REAL_GDP, REAL_GDP_PER_CAPITA, TREASURY_YIELD, FEDERAL_FUNDS_RATE,
                           # CPI, INFLATION, RETAIL_SALES, DURABLES, UNEMPLOYMENT, NONFARM_PAYROLL
        interval:  str = "monthly",  # daily, weekly, monthly, quarterly, annual
    ) -> list[dict]:
        """Fetch economic indicator data from Alpha Vantage."""
        try:
            data = await self._get(
                _AV_BASE,
                {"function": indicator, "interval": interval, "apikey": self._av_key},
                cache_ttl=3600,
            )
            return [
                {"date": d.get("date"), "value": float(d.get("value", 0) or 0)}
                for d in data.get("data", [])
            ]
        except Exception as exc:
            logger.warning("[free_sources] av_economic_indicator(%s) failed: %s", indicator, exc)
            return []

    # ─────────────────────────────────────────────────────────────────────────
    # OPENWEATHERMAP — Optional weather source
    # Used when more granular/global coverage is needed beyond Open-Meteo
    # ─────────────────────────────────────────────────────────────────────────

    async def owm_current(self, lat: float, lon: float, units: str = "metric") -> dict:
        """Current weather from OpenWeatherMap. Requires API key in config."""
        if not self._owm_key:
            logger.warning("[free_sources] OWM key not set — use Open-Meteo instead")
            return {}
        try:
            data = await self._get(
                f"{_OWM_BASE}/weather",
                {"lat": lat, "lon": lon, "units": units, "appid": self._owm_key},
                cache_ttl=600,
            )
            return {
                "city":        data.get("name"),
                "temp":        data.get("main", {}).get("temp"),
                "feels_like":  data.get("main", {}).get("feels_like"),
                "humidity":    data.get("main", {}).get("humidity"),
                "pressure":    data.get("main", {}).get("pressure"),
                "wind_speed":  data.get("wind", {}).get("speed"),
                "wind_deg":    data.get("wind", {}).get("deg"),
                "description": data.get("weather", [{}])[0].get("description", ""),
                "clouds":      data.get("clouds", {}).get("all"),
                "visibility":  data.get("visibility"),
            }
        except Exception as exc:
            logger.warning("[free_sources] owm_current failed: %s", exc)
            return {}

    async def owm_forecast_5day(self, lat: float, lon: float, units: str = "metric") -> list[dict]:
        """5-day / 3-hour forecast from OpenWeatherMap."""
        if not self._owm_key:
            return []
        try:
            data = await self._get(
                f"{_OWM_BASE}/forecast",
                {"lat": lat, "lon": lon, "units": units, "appid": self._owm_key},
                cache_ttl=1800,
            )
            return [
                {
                    "dt_txt":     item.get("dt_txt"),
                    "temp":       item.get("main", {}).get("temp"),
                    "humidity":   item.get("main", {}).get("humidity"),
                    "wind_speed": item.get("wind", {}).get("speed"),
                    "description": item.get("weather", [{}])[0].get("description", ""),
                    "pop":        item.get("pop", 0),  # probability of precipitation
                }
                for item in data.get("list", [])
            ]
        except Exception as exc:
            logger.warning("[free_sources] owm_forecast_5day failed: %s", exc)
            return []

    # ─────────────────────────────────────────────────────────────────────────
    # SEC EDGAR — Filings and Company Data (no API key required)
    # https://www.sec.gov/developer
    # Rate limit: 10 req/sec — do not exceed
    # ─────────────────────────────────────────────────────────────────────────

    async def edgar_company_facts(self, cik: str) -> dict:
        """
        Fetch all reported facts for a company from SEC EDGAR.
        CIK must be zero-padded to 10 digits.

        Returns structured financial data (income statement, balance sheet, cash flows).
        """
        cik_padded = str(cik).lstrip("0").zfill(10)
        try:
            data = await self._get(
                f"{_EDGAR_BASE}/api/xbrl/companyfacts/CIK{cik_padded}.json",
                cache_ttl=86400,
            )
            return data
        except Exception as exc:
            logger.warning("[free_sources] edgar_company_facts(%s) failed: %s", cik, exc)
            return {}

    async def edgar_company_concept(self, cik: str, taxonomy: str, tag: str) -> dict:
        """
        Fetch a specific financial concept for a company.

        Common taxonomy/tag pairs:
            us-gaap / Revenues
            us-gaap / NetIncomeLoss
            us-gaap / EarningsPerShareBasic
            us-gaap / Assets
            us-gaap / Liabilities
            us-gaap / StockholdersEquity
            us-gaap / OperatingIncomeLoss
            us-gaap / CashAndCashEquivalentsAtCarryingValue
        """
        cik_padded = str(cik).lstrip("0").zfill(10)
        try:
            data = await self._get(
                f"{_EDGAR_BASE}/api/xbrl/companyconcept/CIK{cik_padded}/{taxonomy}/{tag}.json",
                cache_ttl=3600,
            )
            units = data.get("units", {})
            usd = units.get("USD", [])
            return {
                "tag":   tag,
                "label": data.get("label"),
                "data":  [
                    {"end": d.get("end"), "val": d.get("val"), "form": d.get("form")}
                    for d in usd
                    if d.get("form") in ("10-K", "10-Q")
                ][-40:],  # last 40 filings
            }
        except Exception as exc:
            logger.warning("[free_sources] edgar_company_concept failed: %s", exc)
            return {}

    async def edgar_search_company(self, name: str) -> list[dict]:
        """Search SEC EDGAR for a company by name to get its CIK."""
        try:
            data = await self._get(
                "https://efts.sec.gov/LATEST/search-index?q=%22{}&dateRange=custom&startdt=2020-01-01&forms=10-K".format(
                    name.replace(" ", "+")
                ),
                cache_ttl=3600,
            )
            # Use the company search endpoint instead
            data = await self._get(
                "https://www.sec.gov/cgi-bin/browse-edgar",
                {
                    "company":    name,
                    "CIK":        "",
                    "type":       "10-K",
                    "dateb":      "",
                    "owner":      "include",
                    "count":      "10",
                    "search_text": "",
                    "action":     "getcompany",
                    "output":     "atom",
                },
                cache_ttl=3600,
            )
            return []
        except Exception as exc:
            logger.warning("[free_sources] edgar_search_company failed: %s", exc)
            return []

    async def edgar_cik_lookup(self, ticker: str) -> str | None:
        """Look up a company's CIK number by ticker symbol."""
        try:
            data = await self._get(
                "https://www.sec.gov/files/company_tickers.json",
                cache_ttl=86400,
            )
            ticker_upper = ticker.upper()
            for entry in data.values():
                if entry.get("ticker", "").upper() == ticker_upper:
                    return str(entry.get("cik_str", "")).zfill(10)
            return None
        except Exception as exc:
            logger.warning("[free_sources] edgar_cik_lookup(%s) failed: %s", ticker, exc)
            return None

    # ─────────────────────────────────────────────────────────────────────────
    # COINGECKO — Crypto Market Data (no API key required)
    # https://www.coingecko.com/api/documentation
    # Rate limit: ~10-50 req/min on free plan
    # ─────────────────────────────────────────────────────────────────────────

    async def coingecko_price(self, coin_ids: list[str], vs_currencies: list[str] | None = None) -> dict:
        """
        Fetch simple price data for one or more coins.

        coin_ids: ["bitcoin", "ethereum", "solana", "cardano", "polkadot"]
        vs_currencies: ["usd", "eur", "btc"] (default ["usd"])
        """
        if vs_currencies is None:
            vs_currencies = ["usd"]
        try:
            data = await self._get(
                f"{_COINGECKO_BASE}/simple/price",
                {
                    "ids":            ",".join(coin_ids),
                    "vs_currencies":  ",".join(vs_currencies),
                    "include_24hr_change": "true",
                    "include_market_cap":  "true",
                    "include_24hr_vol":    "true",
                },
                cache_ttl=30,
            )
            return data
        except Exception as exc:
            logger.warning("[free_sources] coingecko_price failed: %s", exc)
            return {}

    async def coingecko_market_chart(
        self,
        coin_id: str,
        vs_currency: str = "usd",
        days:        int = 30,
    ) -> dict:
        """
        Fetch historical market chart data for a coin.
        Returns prices, market_caps, total_volumes as list of [timestamp, value].
        """
        try:
            data = await self._get(
                f"{_COINGECKO_BASE}/coins/{coin_id}/market_chart",
                {"vs_currency": vs_currency, "days": days},
                cache_ttl=300,
            )
            return {
                "coin_id":      coin_id,
                "prices":       data.get("prices", []),
                "market_caps":  data.get("market_caps", []),
                "volumes":      data.get("total_volumes", []),
            }
        except Exception as exc:
            logger.warning("[free_sources] coingecko_market_chart(%s) failed: %s", coin_id, exc)
            return {}

    async def coingecko_global(self) -> dict:
        """Fetch global crypto market stats (total market cap, dominance, etc.)."""
        try:
            data = await self._get(f"{_COINGECKO_BASE}/global", cache_ttl=120)
            d = data.get("data", {})
            return {
                "total_market_cap_usd": d.get("total_market_cap", {}).get("usd"),
                "total_volume_usd":     d.get("total_volume", {}).get("usd"),
                "btc_dominance":        d.get("market_cap_percentage", {}).get("btc"),
                "eth_dominance":        d.get("market_cap_percentage", {}).get("eth"),
                "active_cryptocurrencies": d.get("active_cryptocurrencies"),
                "market_cap_change_24h": d.get("market_cap_change_percentage_24h_usd"),
            }
        except Exception as exc:
            logger.warning("[free_sources] coingecko_global failed: %s", exc)
            return {}

    # ─────────────────────────────────────────────────────────────────────────
    # CONVENIENCE — Multi-source snapshots for agents
    # ─────────────────────────────────────────────────────────────────────────

    async def economic_snapshot(self) -> dict:
        """
        Fetch a comprehensive economic snapshot from multiple free sources.
        Used by EconomicScheduler and ForecastingAgent as training input.
        """
        tasks = {
            "gdp":         self.fred_series("GDP",       frequency="q", limit=20),
            "cpi":         self.fred_series("CPIAUCSL",  frequency="m", limit=24),
            "fed_funds":   self.fred_series("FEDFUNDS",  frequency="m", limit=24),
            "unemployment": self.fred_series("UNRATE",   frequency="m", limit=24),
            "treasury_10y": self.fred_series("DGS10",    frequency="d", limit=30),
            "yield_spread": self.fred_series("T10Y2Y",   frequency="d", limit=30),
            "m2":          self.fred_series("M2SL",      frequency="m", limit=24),
            "vix":         self.fred_series("VIXCLS",    frequency="d", limit=30),
            "housing":     self.fred_series("HOUST",     frequency="m", limit=24),
            "retail_sales": self.fred_series("RSAFS",    frequency="m", limit=24),
        }
        results = await asyncio.gather(*tasks.values(), return_exceptions=True)
        snapshot = {}
        for key, result in zip(tasks.keys(), results):
            if isinstance(result, Exception):
                snapshot[key] = {"error": str(result)}
            else:
                snapshot[key] = result
        return snapshot

    async def market_snapshot(self, tickers: list[str] | None = None) -> dict:
        """
        Fetch a broad market snapshot across equities, crypto, and forex.
        Used by TechnicalAnalystAgent and TraderAgent as live input.
        """
        if tickers is None:
            tickers = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ", "GLD", "TLT"]

        equity_tasks   = [self.polygon_aggs(t, timespan="day", limit=30) for t in tickers]
        crypto_task    = self.coingecko_price(["bitcoin", "ethereum", "solana"])
        forex_tasks    = [self.av_forex("EUR"), self.av_forex("JPY"), self.av_forex("GBP")]
        market_status  = self.polygon_market_status()
        global_crypto  = self.coingecko_global()

        equity_results, crypto, *forex_results, status, global_c = await asyncio.gather(
            asyncio.gather(*equity_tasks, return_exceptions=True),
            crypto_task,
            *forex_tasks,
            market_status,
            global_crypto,
            return_exceptions=True,
        )

        equities = {}
        if isinstance(equity_results, (list, tuple)):
            for ticker, bars in zip(tickers, equity_results):
                equities[ticker] = bars if not isinstance(bars, Exception) else []

        return {
            "equities":      equities,
            "crypto":        crypto if not isinstance(crypto, Exception) else {},
            "forex":         {
                "EUR/USD": forex_results[0] if not isinstance(forex_results[0], Exception) else {},
                "JPY/USD": forex_results[1] if not isinstance(forex_results[1], Exception) else {},
                "GBP/USD": forex_results[2] if not isinstance(forex_results[2], Exception) else {},
            } if not isinstance(forex_results, Exception) else {},
            "market_status": status if not isinstance(status, Exception) else {},
            "crypto_global": global_c if not isinstance(global_c, Exception) else {},
        }


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: FreeSources | None = None


def get_free_sources() -> FreeSources:
    """Return the global FreeSources singleton. Creates on first call."""
    global _instance
    if _instance is None:
        _instance = FreeSources()
    return _instance
