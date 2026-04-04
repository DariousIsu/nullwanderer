"""
GOAT DeFi — MCP tool wrapper (future-ready).

Modular blockchain/DeFi analysis. Currently exposes read-only market data
from public APIs. Trading execution plugins can be activated later
when wallet keys are configured.

No API key required for analysis — uses public blockchain RPCs.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _error

import httpx

logger = logging.getLogger(__name__)

# Public, free, no-auth APIs for DeFi market data
_COINGECKO_BASE = "https://api.coingecko.com/api/v3"

TOOL_DEF = {
    "name": "defi_market",
    "description": (
        "DeFi and cryptocurrency market data. Query token prices, market caps, "
        "trading volumes, trending tokens, and protocol TVL. "
        "Read-only analysis — no wallet or trading execution. "
        "Uses CoinGecko public API (free, no key)."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["price", "market_data", "trending", "search"],
                "description": "DeFi data action",
            },
            "token_id": {"type": "string", "description": "CoinGecko token ID (e.g. 'bitcoin', 'ethereum', 'solana')"},
            "vs_currency": {"type": "string", "description": "Quote currency (default 'usd')", "default": "usd"},
            "query": {"type": "string", "description": "Search query (for search action)"},
        },
        "required": ["action"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:

            if action == "price":
                token_id = inputs.get("token_id", "bitcoin")
                vs = inputs.get("vs_currency", "usd")
                r = await client.get(f"{_COINGECKO_BASE}/simple/price", params={"ids": token_id, "vs_currencies": vs, "include_24hr_change": "true", "include_market_cap": "true", "include_24hr_vol": "true"})
                r.raise_for_status()
                data = r.json()
                token_data = data.get(token_id, {})
                return {
                    "token": token_id,
                    "price": token_data.get(vs),
                    "market_cap": token_data.get(f"{vs}_market_cap"),
                    "volume_24h": token_data.get(f"{vs}_24h_vol"),
                    "change_24h_pct": token_data.get(f"{vs}_24h_change"),
                    "currency": vs,
                }

            elif action == "market_data":
                token_id = inputs.get("token_id", "bitcoin")
                r = await client.get(f"{_COINGECKO_BASE}/coins/{token_id}", params={"localization": "false", "tickers": "false", "community_data": "false", "developer_data": "false"})
                r.raise_for_status()
                data = r.json()
                md = data.get("market_data", {})
                return {
                    "token": token_id,
                    "name": data.get("name", ""),
                    "symbol": data.get("symbol", ""),
                    "current_price": md.get("current_price", {}).get("usd"),
                    "market_cap": md.get("market_cap", {}).get("usd"),
                    "total_volume": md.get("total_volume", {}).get("usd"),
                    "high_24h": md.get("high_24h", {}).get("usd"),
                    "low_24h": md.get("low_24h", {}).get("usd"),
                    "ath": md.get("ath", {}).get("usd"),
                    "circulating_supply": md.get("circulating_supply"),
                    "total_supply": md.get("total_supply"),
                }

            elif action == "trending":
                r = await client.get(f"{_COINGECKO_BASE}/search/trending")
                r.raise_for_status()
                data = r.json()
                coins = [{"name": c["item"]["name"], "symbol": c["item"]["symbol"], "id": c["item"]["id"], "market_cap_rank": c["item"].get("market_cap_rank")} for c in data.get("coins", [])]
                return {"trending": coins, "count": len(coins)}

            elif action == "search":
                query = inputs.get("query", "")
                if not query:
                    return _error("query required for search")
                r = await client.get(f"{_COINGECKO_BASE}/search", params={"query": query})
                r.raise_for_status()
                data = r.json()
                coins = [{"id": c["id"], "name": c["name"], "symbol": c["symbol"], "market_cap_rank": c.get("market_cap_rank")} for c in data.get("coins", [])[:10]]
                return {"results": coins, "count": len(coins), "query": query}

            return _error(f"Unknown action: {action}")

    except Exception as exc:
        logger.error("[goat_defi] %s", exc)
        return _error(str(exc))
