"""
AURA NX-Alpha — Finance Service
Provides live financial quotes, market overview, and crypto data.

Sources:
    - yfinance  — equities/ETF quotes (no API key required)
    - CoinGecko  — cryptocurrency prices (no API key required)

SINGLETON PATTERN:
    Call init_finance_service() once at startup.
    Callers use get_finance_service() to get the instance.

CACHING:
    Quotes          — 60 seconds
    Crypto          — 30 seconds
    Market overview — 5 minutes (300 seconds)

DEPENDENCIES:
    yfinance — Yahoo Finance wrapper (sync; called via asyncio.to_thread)
    httpx    — async HTTP client for CoinGecko
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
    import yfinance as yf
    _YF_AVAILABLE = True
except ImportError:
    _YF_AVAILABLE = False
    logger.warning("[finance_service] yfinance not installed — all quote calls will return empty results")

try:
    import httpx
    _HTTPX_AVAILABLE = True
except ImportError:
    _HTTPX_AVAILABLE = False
    logger.warning("[finance_service] httpx not installed — CoinGecko calls will return empty results")

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

CACHE_TTL_QUOTES   = 60       # seconds
CACHE_TTL_CRYPTO   = 30       # seconds
CACHE_TTL_OVERVIEW = 300      # 5 minutes

INDEX_TICKERS = ["SPY", "QQQ", "DIA", "IWM", "VXX"]
CRYPTO_IDS    = "bitcoin,ethereum,solana,cardano"

COINGECKO_MARKETS_URL = (
    "https://api.coingecko.com/api/v3/coins/markets"
    "?vs_currency=usd"
    f"&ids={CRYPTO_IDS}"
    "&order=market_cap_desc"
    "&per_page=10"
    "&page=1"
    "&sparkline=false"
)

# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: "FinanceService | None" = None


def init_finance_service() -> "FinanceService":
    """Instantiate and register the global FinanceService singleton."""
    global _instance
    _instance = FinanceService()
    logger.info("[finance_service] FinanceService initialised")
    return _instance


def get_finance_service() -> "FinanceService":
    """Return the global FinanceService singleton. Raises if not yet initialised."""
    if _instance is None:
        raise RuntimeError("FinanceService has not been initialised. Call init_finance_service() first.")
    return _instance


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _now() -> float:
    return time.monotonic()


def _is_stale(ts: float, ttl: float) -> bool:
    return (_now() - ts) > ttl


def _safe_float(val: Any, default: float = 0.0) -> float:
    """Coerce a value to float, returning *default* on failure."""
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE CLASS
# ─────────────────────────────────────────────────────────────────────────────

class FinanceService:
    """
    Live financial data service backed by yfinance and CoinGecko.

    All public methods are async; blocking yfinance calls are dispatched
    to a thread pool via asyncio.to_thread so they never block the event loop.
    """

    def __init__(self) -> None:
        # Cache stores: { key: (timestamp, data) }
        self._quote_cache:    dict[str, tuple[float, dict]]  = {}
        self._crypto_cache:   tuple[float, list[dict]] | None = None
        self._overview_cache: tuple[float, dict]       | None = None

    # ─────────────────────────────────────────────────────────────────────────
    # QUOTE — single ticker
    # ─────────────────────────────────────────────────────────────────────────

    async def get_quote(self, ticker: str) -> dict:
        """
        Fetch a single ticker quote from Yahoo Finance.

        Returns a dict with keys:
            symbol, name, price, change, change_pct, high, low,
            volume, market_cap, currency, ohlcv

        ohlcv is a list of dicts: {t (unix ms), o, h, l, c, v}

        Returns an empty dict on any failure.
        """
        key = ticker.upper()

        # Cache hit
        if key in self._quote_cache:
            ts, data = self._quote_cache[key]
            if not _is_stale(ts, CACHE_TTL_QUOTES):
                return data

        if not _YF_AVAILABLE:
            return {}

        try:
            result = await asyncio.to_thread(self._fetch_quote_sync, key)
            self._quote_cache[key] = (_now(), result)
            return result
        except Exception as exc:
            logger.warning("[finance_service] get_quote(%s) failed: %s", key, exc)
            return {}

    def _fetch_quote_sync(self, symbol: str) -> dict:
        """Blocking yfinance call — run inside asyncio.to_thread."""
        ticker_obj = yf.Ticker(symbol)

        # fast_info is a lightweight dict-like object
        fi = ticker_obj.fast_info

        price       = _safe_float(getattr(fi, "last_price",        None))
        prev_close  = _safe_float(getattr(fi, "previous_close",    None))
        change      = round(price - prev_close, 4) if prev_close else 0.0
        change_pct  = round((change / prev_close) * 100, 4) if prev_close else 0.0

        high        = _safe_float(getattr(fi, "day_high",          None))
        low         = _safe_float(getattr(fi, "day_low",           None))
        volume      = _safe_float(getattr(fi, "last_volume",       None))
        market_cap  = _safe_float(getattr(fi, "market_cap",        None))
        currency    = getattr(fi, "currency", "USD") or "USD"

        # Long name falls back to shortName, then the symbol itself
        info        = {}
        try:
            info = ticker_obj.info or {}
        except Exception:
            pass
        name = info.get("longName") or info.get("shortName") or symbol

        # Intraday OHLCV — 1-day window, 5-minute bars
        ohlcv: list[dict] = []
        try:
            hist = ticker_obj.history(period="1d", interval="5m")
            for ts_idx, row in hist.iterrows():
                ohlcv.append({
                    "t": int(ts_idx.timestamp() * 1000),
                    "o": round(_safe_float(row.get("Open")),   4),
                    "h": round(_safe_float(row.get("High")),   4),
                    "l": round(_safe_float(row.get("Low")),    4),
                    "c": round(_safe_float(row.get("Close")),  4),
                    "v": int(_safe_float(row.get("Volume"))),
                })
        except Exception as exc:
            logger.warning("[finance_service] OHLCV fetch failed for %s: %s", symbol, exc)

        return {
            "symbol":     symbol,
            "name":       name,
            "price":      price,
            "change":     change,
            "change_pct": change_pct,
            "high":       high,
            "low":        low,
            "volume":     int(volume),
            "market_cap": market_cap,
            "currency":   currency,
            "ohlcv":      ohlcv,
        }

    # ─────────────────────────────────────────────────────────────────────────
    # QUOTES — batch
    # ─────────────────────────────────────────────────────────────────────────

    async def get_quotes(self, tickers: list[str]) -> list[dict]:
        """
        Fetch quotes for multiple tickers concurrently.

        Each ticker is fetched in its own asyncio.to_thread call so
        yfinance's blocking I/O does not serialise the batch.

        Returns a list of quote dicts (empty dicts for failed tickers are
        filtered out).
        """
        tasks = [self.get_quote(t) for t in tickers]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        out: list[dict] = []
        for ticker, res in zip(tickers, results):
            if isinstance(res, Exception):
                logger.warning("[finance_service] get_quotes: error for %s: %s", ticker, res)
            elif res:
                out.append(res)
        return out

    # ─────────────────────────────────────────────────────────────────────────
    # MARKET OVERVIEW
    # ─────────────────────────────────────────────────────────────────────────

    async def get_market_overview(self) -> dict:
        """
        Return a high-level market snapshot.

        Shape:
            {
                indices:      list[dict],   # SPY, QQQ, DIA, IWM, VXX quotes
                crypto:       list[dict],   # BTC, ETH, SOL, ADA from CoinGecko
                last_updated: float         # unix timestamp
            }
        """
        if self._overview_cache is not None:
            ts, data = self._overview_cache
            if not _is_stale(ts, CACHE_TTL_OVERVIEW):
                return data

        indices_task = self.get_quotes(INDEX_TICKERS)
        crypto_task  = self._fetch_crypto()

        indices, crypto = await asyncio.gather(indices_task, crypto_task)

        result = {
            "indices":      indices,
            "crypto":       crypto,
            "last_updated": time.time(),
        }
        self._overview_cache = (_now(), result)
        return result

    async def _fetch_crypto(self) -> list[dict]:
        """Fetch crypto market data from CoinGecko with a 30-second cache."""
        if self._crypto_cache is not None:
            ts, data = self._crypto_cache
            if not _is_stale(ts, CACHE_TTL_CRYPTO):
                return data

        if not _HTTPX_AVAILABLE:
            return []

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(COINGECKO_MARKETS_URL)
                resp.raise_for_status()
                raw: list[dict] = resp.json()

            coins = [
                {
                    "id":                 c.get("id"),
                    "symbol":             (c.get("symbol") or "").upper(),
                    "name":               c.get("name"),
                    "price":              _safe_float(c.get("current_price")),
                    "change_pct_24h":     _safe_float(c.get("price_change_percentage_24h")),
                    "market_cap":         _safe_float(c.get("market_cap")),
                    "volume_24h":         _safe_float(c.get("total_volume")),
                    "image":              c.get("image"),
                }
                for c in raw
            ]
            self._crypto_cache = (_now(), coins)
            return coins
        except Exception as exc:
            logger.warning("[finance_service] CoinGecko fetch failed: %s", exc)
            return []

    # ─────────────────────────────────────────────────────────────────────────
    # WATCHLIST
    # ─────────────────────────────────────────────────────────────────────────

    async def get_watchlist(self, tickers: list[str]) -> list[dict]:
        """
        Return quotes for the provided watchlist tickers.

        Thin wrapper around get_quotes so callers have a semantic entry point.
        """
        return await self.get_quotes(tickers)

    # ─────────────────────────────────────────────────────────────────────────
    # TICKER SEARCH
    # ─────────────────────────────────────────────────────────────────────────

    async def search_ticker(self, query: str) -> list[dict]:
        """
        Search for tickers matching *query* via yfinance.Search.

        Returns up to 5 results, each as:
            { symbol, name, exchange }

        Returns an empty list on any failure or if yfinance is unavailable.
        """
        if not _YF_AVAILABLE:
            return []

        try:
            results = await asyncio.to_thread(self._search_sync, query)
            return results
        except Exception as exc:
            logger.warning("[finance_service] search_ticker(%r) failed: %s", query, exc)
            return []

    def _search_sync(self, query: str) -> list[dict]:
        """Blocking yfinance Search call — run inside asyncio.to_thread."""
        search_obj = yf.Search(query)
        raw_quotes = search_obj.quotes[:5]
        out = []
        for q in raw_quotes:
            out.append({
                "symbol":   q.get("symbol", ""),
                "name":     q.get("longname") or q.get("shortname") or q.get("symbol", ""),
                "exchange": q.get("exchange", ""),
            })
        return out
