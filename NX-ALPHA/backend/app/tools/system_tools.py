"""
System and data query tools callable by the interface agent.

Each function is a thin async wrapper around the corresponding backend
service.  All functions handle missing imports and uninitialized services
gracefully, returning empty dicts or lists with a warning log rather than
raising exceptions.
"""

import logging
from typing import Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# System status
# ---------------------------------------------------------------------------

async def get_system_status() -> dict:
    """
    Return a snapshot of current system resource usage.

    Tries get_system_monitor().get_snapshot() first (live data from the
    running monitor service).  Falls back to get_latest_snapshot() (the
    most recently cached reading) if the service is not running.

    Returns
    -------
    dict
        System snapshot dict.  Returns {} on failure.
    """
    try:
        from app.service.system_monitor_service import get_system_monitor, get_latest_snapshot

        monitor = get_system_monitor()
        if monitor is not None:
            try:
                return await monitor.get_snapshot()
            except Exception as exc:
                logger.warning("get_snapshot() failed, falling back to latest: %s", exc)

        return get_latest_snapshot()
    except ImportError as exc:
        logger.warning("system_monitor_service not available: %s", exc)
        return {}
    except Exception as exc:
        logger.warning("get_system_status failed: %s", exc)
        return {}


# ---------------------------------------------------------------------------
# Weather
# ---------------------------------------------------------------------------

async def get_weather(lat: Optional[float] = None, lon: Optional[float] = None) -> dict:
    """
    Return current weather conditions and forecast.

    Parameters
    ----------
    lat:
        Latitude for the weather lookup.  Uses service default if None.
    lon:
        Longitude for the weather lookup.  Uses service default if None.

    Returns
    -------
    dict
        {current: dict, forecast: list, radar_url: str}.
        Returns {} on failure or if the service is not initialized.
    """
    try:
        from app.service.weather_service import get_weather_service

        svc = get_weather_service()
        if svc is None:
            logger.warning("WeatherService not initialized")
            return {}

        kwargs: dict = {}
        if lat is not None:
            kwargs["lat"] = lat
        if lon is not None:
            kwargs["lon"] = lon

        current = await svc.get_current(**kwargs)
        forecast = await svc.get_forecast(**kwargs)
        radar_url = svc.get_radar_url(
            lat if lat is not None else current.get("lat", 40.7128),
            lon if lon is not None else current.get("lon", -74.0060),
        )

        return {
            "current": current,
            "forecast": forecast,
            "radar_url": radar_url,
        }
    except ImportError as exc:
        logger.warning("weather_service not available: %s", exc)
        return {}
    except Exception as exc:
        logger.warning("get_weather failed: %s", exc)
        return {}


# ---------------------------------------------------------------------------
# Finance
# ---------------------------------------------------------------------------

async def get_finance_quote(ticker: str) -> dict:
    """
    Return a quote for a single equity or index ticker.

    Parameters
    ----------
    ticker:
        The ticker symbol (e.g. 'AAPL', 'SPY').

    Returns
    -------
    dict
        Quote dict from FinanceService.get_quote().
        Returns {} on failure or if the service is not initialized.
    """
    try:
        from app.service.finance_service import get_finance_service

        svc = get_finance_service()
        if svc is None:
            logger.warning("FinanceService not initialized")
            return {}

        return await svc.get_quote(ticker)
    except ImportError as exc:
        logger.warning("finance_service not available: %s", exc)
        return {}
    except Exception as exc:
        logger.warning("get_finance_quote(%r) failed: %s", ticker, exc)
        return {}


async def get_market_overview() -> dict:
    """
    Return a high-level overview of major market indices and sectors.

    Returns
    -------
    dict
        Market overview dict from FinanceService.get_market_overview().
        Returns {} on failure or if the service is not initialized.
    """
    try:
        from app.service.finance_service import get_finance_service

        svc = get_finance_service()
        if svc is None:
            logger.warning("FinanceService not initialized")
            return {}

        return await svc.get_market_overview()
    except ImportError as exc:
        logger.warning("finance_service not available: %s", exc)
        return {}
    except Exception as exc:
        logger.warning("get_market_overview failed: %s", exc)
        return {}


# ---------------------------------------------------------------------------
# News
# ---------------------------------------------------------------------------

async def get_news(category: Optional[str] = None, limit: int = 10) -> list[dict]:
    """
    Return recent news articles, optionally filtered by category.

    Parameters
    ----------
    category:
        Optional news category string.  When provided, fetches articles
        from that category only.  When None, fetches across all configured
        feeds.
    limit:
        Total number of articles to target (default 10).

    Returns
    -------
    list[dict]
        List of article dicts.  Returns [] on failure or if the service
        is not initialized.
    """
    try:
        from app.service.news_service import get_news_service

        svc = get_news_service()
        if svc is None:
            logger.warning("NewsService not initialized")
            return []

        if category:
            return await svc.fetch_by_category(category, limit)

        limit_per_feed = max(1, limit // 4) if limit >= 4 else 5
        return await svc.fetch_all(limit_per_feed=limit_per_feed)
    except ImportError as exc:
        logger.warning("news_service not available: %s", exc)
        return []
    except Exception as exc:
        logger.warning("get_news failed: %s", exc)
        return []


# ---------------------------------------------------------------------------
# Google Calendar / Gmail
# ---------------------------------------------------------------------------

async def get_calendar_events(days: int = 7) -> list[dict]:
    """
    Return upcoming Google Calendar events.

    Parameters
    ----------
    days:
        Number of days ahead to fetch events (default 7).

    Returns
    -------
    list[dict]
        List of event dicts.  Returns [] if Google is not authenticated
        or the service is unavailable.
    """
    try:
        from app.service.google_service import get_google_service

        svc = get_google_service()
        return await svc.get_calendar_events(days_ahead=days)
    except ImportError as exc:
        logger.warning("google_service not available: %s", exc)
        return []
    except Exception as exc:
        logger.warning("get_calendar_events failed: %s", exc)
        return []


async def get_inbox(max_results: int = 10) -> list[dict]:
    """
    Return recent Gmail inbox messages.

    Parameters
    ----------
    max_results:
        Maximum number of messages to return (default 10).

    Returns
    -------
    list[dict]
        List of message dicts.  Returns [] if Google is not authenticated
        or the service is unavailable.
    """
    try:
        from app.service.google_service import get_google_service

        svc = get_google_service()
        return await svc.get_inbox(max_results=max_results)
    except ImportError as exc:
        logger.warning("google_service not available: %s", exc)
        return []
    except Exception as exc:
        logger.warning("get_inbox failed: %s", exc)
        return []


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "system_status",
    "description": "System information, weather, finance quotes, market overview, news, calendar events, and email inbox.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["status", "weather", "finance_quote", "market_overview", "news", "calendar", "email"],
                "description": "Data source to query",
            },
            "ticker":      {"type": "string", "description": "Stock ticker for finance_quote"},
            "category":    {"type": "string", "description": "News category (default: all)"},
            "days":        {"type": "integer", "description": "Days ahead for calendar (default 7)"},
            "max_results": {"type": "integer", "description": "Max inbox messages (default 10)"},
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    op = inputs.get("operation", "status")
    if op == "status":
        return await get_system_status()
    elif op == "weather":
        return await get_weather()
    elif op == "finance_quote":
        ticker = inputs.get("ticker", "")
        if not ticker:
            return {"error": "ticker is required for finance_quote"}
        return await get_finance_quote(ticker)
    elif op == "market_overview":
        return await get_market_overview()
    elif op == "news":
        return await get_news(inputs.get("category"))
    elif op == "calendar":
        return {"events": await get_calendar_events(int(inputs.get("days", 7)))}
    elif op == "email":
        return {"messages": await get_inbox(int(inputs.get("max_results", 10)))}
    return {"error": f"Unknown operation: {op!r}"}
