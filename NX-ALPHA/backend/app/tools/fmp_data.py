"""
Financial Modeling Prep — MCP tool wrapper.

Stock fundamentals, earnings calendars, SEC filings, financial ratios.
Free tier available with API key.
"""

from __future__ import annotations

import logging
from app.tools._mcp_wrapper import _get_setting, _error

import httpx

logger = logging.getLogger(__name__)

_BASE = "https://financialmodelingprep.com/api/v3"

TOOL_DEF = {
    "name": "fmp_data",
    "description": (
        "Financial Modeling Prep: company fundamentals, earnings calendars, "
        "SEC filings, financial ratios, and company profiles. "
        "Complements Polygon IO with deeper fundamental analysis data."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["profile", "income_statement", "balance_sheet", "ratios", "earnings_calendar", "sec_filings"], "description": "Data type to fetch"},
            "ticker": {"type": "string", "description": "Stock ticker (e.g. 'AAPL')"},
            "period": {"type": "string", "enum": ["annual", "quarter"], "default": "annual"},
            "limit":  {"type": "integer", "default": 5},
        },
        "required": ["action", "ticker"],
    },
}


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    ticker = inputs.get("ticker", "").upper()
    api_key = _get_setting("fmp_api_key")
    if not api_key:
        return _error("fmp_api_key not configured")

    params = {"apikey": api_key, "limit": inputs.get("limit", 5)}
    period = inputs.get("period", "annual")

    endpoints = {
        "profile":          f"{_BASE}/profile/{ticker}",
        "income_statement": f"{_BASE}/income-statement/{ticker}",
        "balance_sheet":    f"{_BASE}/balance-sheet-statement/{ticker}",
        "ratios":           f"{_BASE}/ratios/{ticker}",
        "earnings_calendar": f"{_BASE}/earning_calendar",
        "sec_filings":      f"{_BASE}/sec_filings/{ticker}",
    }

    url = endpoints.get(action)
    if not url:
        return _error(f"Unknown action: {action}")

    if action in ("income_statement", "balance_sheet", "ratios"):
        params["period"] = period

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            r = await client.get(url, params=params)
            r.raise_for_status()
            data = r.json()

        if isinstance(data, list):
            return {"ticker": ticker, "action": action, "data": data[:inputs.get("limit", 5)], "count": len(data)}
        return {"ticker": ticker, "action": action, "data": data}

    except Exception as exc:
        logger.error("[fmp_data] %s", exc)
        return _error(str(exc))
