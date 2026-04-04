"""
Polygon IO — MCP tool wrapper.

Comprehensive stock market data: historical OHLCV, real-time quotes,
ticker news with sentiment, and quarterly/annual financial statements.
Requires API key (user has one). Native SDK: polygon-api-client.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://api.polygon.io"

TOOL_DEF = {
    "name": "polygon_io",
    "description": (
        "Stock market data from Polygon.io. Supports: historical price data (OHLCV), "
        "real-time quotes, ticker news with sentiment, and company financial statements. "
        "Use for market analysis, financial research, and policy impact assessment."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["aggregates", "quote", "news", "financials", "ticker_details"],
                "description": "What to fetch",
            },
            "ticker":    {"type": "string", "description": "Stock ticker symbol (e.g. 'AAPL', 'MSFT')"},
            "from_date": {"type": "string", "description": "Start date YYYY-MM-DD (for aggregates)"},
            "to_date":   {"type": "string", "description": "End date YYYY-MM-DD (for aggregates)"},
            "timespan":  {"type": "string", "enum": ["minute", "hour", "day", "week", "month", "quarter", "year"], "default": "day"},
            "limit":     {"type": "integer", "description": "Max results (default 10)", "default": 10},
        },
        "required": ["action", "ticker"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    ticker = inputs.get("ticker", "").upper()
    if not action or not ticker:
        return _error("action and ticker are required")

    api_key = _get_setting("polygon_api_key")
    if not api_key:
        return _error("polygon_api_key not configured in settings")

    params = {"apiKey": api_key}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:

            if action == "aggregates":
                from_d = inputs.get("from_date", "2024-01-01")
                to_d   = inputs.get("to_date", "2025-01-01")
                ts     = inputs.get("timespan", "day")
                url = f"{_BASE}/v2/aggs/ticker/{ticker}/range/1/{ts}/{from_d}/{to_d}"
                params["limit"] = inputs.get("limit", 50)
                r = await client.get(url, params=params)
                r.raise_for_status()
                data = r.json()
                bars = []
                for bar in data.get("results", []):
                    bars.append({
                        "date":   bar.get("t"),
                        "open":   bar.get("o"),
                        "high":   bar.get("h"),
                        "low":    bar.get("l"),
                        "close":  bar.get("c"),
                        "volume": bar.get("v"),
                        "vwap":   bar.get("vw"),
                    })
                return {"ticker": ticker, "bars": bars, "count": len(bars)}

            elif action == "quote":
                url = f"{_BASE}/v3/quotes/{ticker}"
                params["limit"] = 1
                r = await client.get(url, params=params)
                r.raise_for_status()
                data = r.json()
                quotes = data.get("results", [])
                if quotes:
                    q = quotes[0]
                    return {
                        "ticker": ticker,
                        "bid": q.get("bid_price"), "ask": q.get("ask_price"),
                        "bid_size": q.get("bid_size"), "ask_size": q.get("ask_size"),
                        "timestamp": q.get("participant_timestamp"),
                    }
                return {"ticker": ticker, "note": "No quote data available"}

            elif action == "news":
                url = f"{_BASE}/v2/reference/news"
                params["ticker"] = ticker
                params["limit"] = inputs.get("limit", 10)
                r = await client.get(url, params=params)
                r.raise_for_status()
                data = r.json()
                articles = []
                for a in data.get("results", []):
                    articles.append({
                        "title":     a.get("title", ""),
                        "url":       a.get("article_url", ""),
                        "published": a.get("published_utc", ""),
                        "source":    a.get("publisher", {}).get("name", ""),
                        "tickers":   a.get("tickers", []),
                    })
                return {"ticker": ticker, "articles": articles, "count": len(articles)}

            elif action == "financials":
                url = f"{_BASE}/vX/reference/financials"
                params["ticker"] = ticker
                params["limit"] = inputs.get("limit", 4)
                r = await client.get(url, params=params)
                r.raise_for_status()
                data = r.json()
                return {"ticker": ticker, "financials": data.get("results", []), "count": data.get("count", 0)}

            elif action == "ticker_details":
                url = f"{_BASE}/v3/reference/tickers/{ticker}"
                r = await client.get(url, params=params)
                r.raise_for_status()
                data = r.json()
                res = data.get("results", {})
                return {
                    "ticker": ticker, "name": res.get("name", ""),
                    "market_cap": res.get("market_cap"), "description": res.get("description", "")[:500],
                    "homepage": res.get("homepage_url", ""), "sic_code": res.get("sic_code", ""),
                    "locale": res.get("locale", ""), "employees": res.get("total_employees"),
                }

            return _error(f"Unknown action: {action}")

    except Exception as exc:
        logger.error("[polygon_io] %s", exc)
        return _error(str(exc))
