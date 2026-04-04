"""
web3_tool.py
─────────────
AURA MCP tool — Crypto market data and wallet analysis.

Provides cryptocurrency price data, market statistics, token info,
and basic wallet balance lookups via CoinGecko (free, no key) and
Binance public API (no key required for market data).

No API key required for most operations.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "crypto",
    "description": (
        "Cryptocurrency market data and wallet analysis. "
        "Operations: price (get price for coins), market_overview (top N coins by market cap), "
        "coin_info (detailed token info from CoinGecko), "
        "trending (trending coins), "
        "binance_ticker (real-time OHLCV from Binance). "
        "Free, no API key required. Data from CoinGecko and Binance public APIs."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["price", "market_overview", "coin_info", "trending", "binance_ticker"],
                "description": "Operation to perform",
            },
            "coins": {
                "type": "array",
                "items": {"type": "string"},
                "description": "List of CoinGecko coin IDs (for price), e.g. ['bitcoin', 'ethereum', 'solana']",
            },
            "coin_id": {
                "type": "string",
                "description": "CoinGecko coin ID (for coin_info), e.g. 'bitcoin'",
            },
            "symbol": {
                "type": "string",
                "description": "Binance trading pair symbol (for binance_ticker), e.g. 'BTCUSDT'",
            },
            "vs_currency": {
                "type": "string",
                "description": "Quote currency (default: usd)",
                "default": "usd",
            },
            "limit": {
                "type": "integer",
                "description": "Number of results for market_overview (default: 20, max: 250)",
                "default": 20,
            },
        },
        "required": ["operation"],
    },
}


_CG_BASE  = "https://api.coingecko.com/api/v3"
_BIN_BASE = "https://api.binance.com/api/v3"


async def tool_handler(inputs: dict) -> dict:
    operation   = inputs.get("operation", "")
    vs_currency = inputs.get("vs_currency", "usd")

    try:
        import httpx
    except ImportError:
        return {"error": "httpx not installed"}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            if operation == "price":
                coins = inputs.get("coins", [])
                if not coins:
                    return {"error": "coins list required (CoinGecko IDs, e.g. ['bitcoin', 'ethereum'])"}
                ids_str = ",".join(coins)
                resp = await client.get(
                    f"{_CG_BASE}/simple/price",
                    params={
                        "ids": ids_str,
                        "vs_currencies": vs_currency,
                        "include_24hr_change": "true",
                        "include_market_cap": "true",
                    },
                )
                resp.raise_for_status()
                data = resp.json()
                results = {}
                for coin, vals in data.items():
                    results[coin] = {
                        "price":      vals.get(vs_currency, 0),
                        "market_cap": vals.get(f"{vs_currency}_market_cap", 0),
                        "change_24h": vals.get(f"{vs_currency}_24h_change", 0),
                    }
                return {"prices": results, "currency": vs_currency}

            elif operation == "market_overview":
                limit = min(int(inputs.get("limit", 20)), 250)
                resp  = await client.get(
                    f"{_CG_BASE}/coins/markets",
                    params={
                        "vs_currency":           vs_currency,
                        "order":                 "market_cap_desc",
                        "per_page":              limit,
                        "page":                  1,
                        "sparkline":             "false",
                        "price_change_percentage": "24h",
                    },
                )
                resp.raise_for_status()
                coins = resp.json()
                return {
                    "coins": [
                        {
                            "rank":       c.get("market_cap_rank"),
                            "id":         c.get("id"),
                            "symbol":     c.get("symbol", "").upper(),
                            "price":      c.get("current_price"),
                            "market_cap": c.get("market_cap"),
                            "change_24h": c.get("price_change_percentage_24h"),
                        }
                        for c in coins
                    ],
                    "currency": vs_currency,
                }

            elif operation == "coin_info":
                coin_id = inputs.get("coin_id", "")
                if not coin_id:
                    return {"error": "coin_id required (CoinGecko ID, e.g. 'bitcoin')"}
                resp = await client.get(
                    f"{_CG_BASE}/coins/{coin_id}",
                    params={"localization": "false", "tickers": "false", "community_data": "false", "developer_data": "false"},
                )
                resp.raise_for_status()
                c = resp.json()
                return {
                    "id":             c.get("id"),
                    "symbol":         c.get("symbol", "").upper(),
                    "name":           c.get("name"),
                    "market_cap_rank": c.get("market_cap_rank"),
                    "description":    (c.get("description", {}).get("en", "") or "")[:500],
                    "homepage":       (c.get("links", {}).get("homepage") or [""])[0],
                    "contract":       c.get("contract_address", ""),
                    "price_usd":      c.get("market_data", {}).get("current_price", {}).get("usd"),
                    "ath_usd":        c.get("market_data", {}).get("ath", {}).get("usd"),
                }

            elif operation == "trending":
                resp = await client.get(f"{_CG_BASE}/search/trending")
                resp.raise_for_status()
                coins = resp.json().get("coins", [])
                return {
                    "trending": [
                        {
                            "rank": c["item"].get("score"),
                            "id":   c["item"].get("id"),
                            "name": c["item"].get("name"),
                            "symbol": c["item"].get("symbol"),
                        }
                        for c in coins[:10]
                    ]
                }

            elif operation == "binance_ticker":
                symbol = inputs.get("symbol", "BTCUSDT").upper()
                resp = await client.get(
                    f"{_BIN_BASE}/ticker/24hr",
                    params={"symbol": symbol},
                )
                resp.raise_for_status()
                d = resp.json()
                return {
                    "symbol":       d.get("symbol"),
                    "price":        float(d.get("lastPrice", 0)),
                    "price_change": float(d.get("priceChangePercent", 0)),
                    "volume":       float(d.get("volume", 0)),
                    "high_24h":     float(d.get("highPrice", 0)),
                    "low_24h":      float(d.get("lowPrice", 0)),
                }

    except Exception as exc:
        logger.error("[web3_tool] %s failed: %s", operation, exc)
        return {"error": str(exc)}

    return {"error": f"Unknown operation: {operation}"}
