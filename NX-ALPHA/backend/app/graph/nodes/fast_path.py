"""
AURA NX-Alpha — Data-First Fast Path Router

Detects data retrieval queries and executes them directly against the relevant
service, bypassing the model's tool-call round-trip entirely.

Pattern:
    detect_fast_path(user_message) → (handler, params) | None
    handler(params, msg_id) → response_text (also emits canvas + token SSE)

Sources:
    legislation  — SQLite FTS5, all 50 states
    news         — NewsService RSS feeds
    finance      — FinanceService quote / market overview
    weather      — WeatherService current + forecast
    calendar     — GoogleService calendar events
    memory       — ChromaDB hybrid search (named namespace)
    system       — SystemMonitor hardware snapshot

If none match, returns None and the caller falls through to normal model
invocation. The model then has full tool access as before.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections import Counter
from typing import Any, Callable, Awaitable

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# SHARED HELPERS
# ─────────────────────────────────────────────────────────────────────────────

async def _emit(event: str, data: dict) -> None:
    """Emit SSE event. Silently no-ops if chat controller not available."""
    try:
        from app.controller.chat_controller import _emit as _chat_emit
        await _chat_emit(event, data)
    except Exception:
        pass


async def _send_token(text: str, msg_id: str) -> None:
    await _emit("token", {"text": text, "messageId": msg_id})


async def _update_status(detail: str) -> None:
    await _emit("agent_update", {
        "node": "interface_agent",
        "status": "running",
        "detail": detail,
    })


# ─────────────────────────────────────────────────────────────────────────────
# LEGISLATION
# ─────────────────────────────────────────────────────────────────────────────

_LEG_PATTERNS = [
    r'\b(show|list|find|pull up|get|fetch|search|look up|give me|display)\b.{0,40}\b(bill|bills|legislation|legislative|act|acts|law|laws|statute|statutes)\b',
    r'\bbills?\b.{0,40}\b(about|on|related to|regarding|concerning|pertaining to|dealing with)\b',
    r'\blegislation\b.{0,40}\b(about|on|related to|regarding|concerning|track)\b',
    r'\bwhat bills?\b',
    r'\blegislat\w+\s+(tracker|tracking|database|search)\b',
    r'\b(track|tracking)\b.{0,30}\bbills?\b',
]
_LEG_RE = [re.compile(p, re.IGNORECASE) for p in _LEG_PATTERNS]

_STATE_CODE_MAP: dict[str, str] = {
    "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
    "colorado":"CO","connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA",
    "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA",
    "kansas":"KS","kentucky":"KY","louisiana":"LA","maine":"ME","maryland":"MD",
    "massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS",
    "missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV",
    "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
    "north carolina":"NC","north dakota":"ND","ohio":"OH","oklahoma":"OK",
    "oregon":"OR","pennsylvania":"PA","rhode island":"RI","south carolina":"SC",
    "south dakota":"SD","tennessee":"TN","texas":"TX","utah":"UT","vermont":"VT",
    "virginia":"VA","washington":"WA","west virginia":"WV","wisconsin":"WI",
    "wyoming":"WY","dc":"DC","washington dc":"DC","washington d.c.":"DC",
}
_STATE_CODES_2L = set(_STATE_CODE_MAP.values()) | {v.lower() for v in _STATE_CODE_MAP.values()}

_LEG_STRIP = [
    r'\b(check|show|list|find|pull up|get|fetch|search|look up|give me|display|tell me about|what are|are there)\s+(me\s+)?(all\s+)?(the\s+)?',
    r'\bbills?\s+(about|on|related to|regarding|concerning|pertaining to|dealing with|covering)\s+',
    r'\blegislat\w+\s+(about|on|related to|regarding|concerning|covering|for)\s+',
    r'\blegislat\w+\b',
    r'\bbills?\b',
    r'\b(in|for|from)\s+(' + '|'.join(sorted(_STATE_CODE_MAP.keys(), key=len, reverse=True)) + r')\b',
    r'\b(' + '|'.join(sorted(_STATE_CODE_MAP.keys(), key=len, reverse=True)) + r')\b',
    r'\b[A-Z]{2}\b',
    r'\bacross\s+(all\s+)?(50\s+)?states?\b',
    r'\bnationwide\b',
    r'\bcountrywide\b',
    r'\beverywhere\b',
    r'\bfor\s+any\b',
    r'\bany\b',
    r'\bfor\b',
]

# Primary extraction: grabs text after explicit connector ("related to", "about", etc.)
# e.g. "bills related to social media" → "social media"
_LEG_TOPIC_RE = re.compile(
    r'\b(?:bills?|legislation|legislative|acts?|laws?|statutes?)\s+'
    r'(?:about|on|related\s+to|regarding|concerning|pertaining\s+to|dealing\s+with|covering)\s+'
    r'(.+)',
    re.IGNORECASE,
)

# Session-level summary requests should fall through to the model, not FTS5
_LEG_SESSION_EXCLUDE_RE = re.compile(
    r'\b(summary|summarize|overview|recap|review|rundown)\b.{0,40}\b(session|legislature|legislative session)\b'
    r'|\b(legislative\s+)?session\b.{0,40}\b(summary|overview|recap|review|highlights?)\b'
    r'|\bwhat\s+(happened|passed|was\s+enacted|was\s+signed|came\s+out)\b.{0,40}\b(session|legislature)\b'
    r'|\b(tell|give)\s+me\b.{0,30}\b(about|a\s+summary\s+of|an\s+overview\s+of)\b.{0,30}\b(session|legislature)\b',
    re.IGNORECASE,
)


def _detect_legislation(text: str) -> dict | None:
    # Session-level summaries need the model — not a bill search
    if _LEG_SESSION_EXCLUDE_RE.search(text):
        return None
    if not any(p.search(text) for p in _LEG_RE):
        return None
    lower = text.lower()

    # Extract state
    state: str | None = None
    for name, code in sorted(_STATE_CODE_MAP.items(), key=lambda x: -len(x[0])):
        if re.search(r'\b' + re.escape(name) + r'\b', lower):
            state = code
            break
    if state is None:
        m = re.search(r'\b([A-Z]{2})\b', text)
        if m and m.group(1).upper() in _STATE_CODES_2L:
            state = m.group(1).upper()

    # Primary: extract topic from "bills/legislation [connector] TOPIC"
    topic_m = _LEG_TOPIC_RE.search(text)
    if topic_m:
        topic = topic_m.group(1).strip()
        # Remove trailing state reference captured in the group
        for name in sorted(_STATE_CODE_MAP.keys(), key=len, reverse=True):
            topic = re.sub(r'\s*\b(?:in|for|from)\s+' + re.escape(name) + r'\b.*$', '', topic, flags=re.IGNORECASE)
        topic = re.sub(r'\s*\b(?:in|for|from)\s+[A-Z]{2}\b.*$', '', topic)
        topic = topic.strip(' .,?!')
    else:
        # Fallback: strip all noise from full message
        topic = text
        for strip in _LEG_STRIP:
            topic = re.sub(strip, ' ', topic, flags=re.IGNORECASE)
        topic = re.sub(r'\s+', ' ', topic).strip(' .,?!')
        # If more than 5 words survive stripping, the extraction is too noisy —
        # return None so the model handles the query instead
        if len(topic.split()) > 5:
            return None

    if not topic or len(topic) < 2:
        return None

    return {"query": topic, "state": state, "limit": 50}


async def _run_legislation(params: dict, msg_id: str) -> str:
    await _update_status("Searching legislation database...")
    try:
        from app.service.legislation_service import get_legislation_service
        svc = get_legislation_service()
        if svc is None or not svc._available():
            msg = "Legislation database not yet imported. Start via Settings → Data → Import."
            await _send_token(msg, msg_id)
            return msg

        query = params["query"]
        state = params.get("state")
        limit = params.get("limit", 50)

        results = await asyncio.to_thread(svc.search_bills, query, state, None, None, limit)

        if not results:
            state_label = f" in {state}" if state else " nationwide"
            msg = f'No bills found matching "{query}"{state_label}.'
            await _send_token(msg, msg_id)
            return msg

        rows = [
            [
                b.get("state_code", ""),
                b.get("identifier", ""),
                (b.get("title") or "")[:110],
                (b.get("chamber") or "").title(),
                (b.get("status") or "").title(),
                b.get("last_action_date", ""),
            ]
            for b in results
        ]
        state_label = f" in {state}" if state else " — all states"
        await _emit("render_canvas", {
            "title": f'Bills: "{query}"{state_label}',
            "blocks": [{
                "type": "table",
                "data": {
                    "headers": ["State", "ID", "Title", "Chamber", "Status", "Last Action"],
                    "rows": rows,
                },
            }],
        })

        state_counts = Counter(b.get("state_code", "") for b in results)
        top = ", ".join(f"{s} ({n})" for s, n in state_counts.most_common(5))
        extra = f" and {len(state_counts)-5} more states" if len(state_counts) > 5 else ""
        summary = (
            f'Found {len(results)} bill{"s" if len(results) != 1 else ""} '
            f'matching "{query}"{state_label}. Results on canvas.\n\n'
            f'Top states: {top}{extra}.'
        )
        await _send_token(summary, msg_id)
        return summary

    except Exception as exc:
        logger.error("[fast_path] legislation error: %s", exc)
        msg = f"Error searching legislation database: {exc}"
        await _send_token(msg, msg_id)
        return msg


# ─────────────────────────────────────────────────────────────────────────────
# NEWS
# ─────────────────────────────────────────────────────────────────────────────

_NEWS_PATTERNS = [
    r'\b(show|get|pull up|give me|fetch|find|display)\b.{0,30}\b(news|headlines|articles|stories)\b',
    r'\b(latest|recent|today.s|breaking)\b.{0,20}\b(news|headlines|stories)\b',
    r'\bwhat.s (happening|going on)\b',
    r'\bnews (about|on|related to|regarding)\b',
    r'\bheadlines\b',
    r'\bwhat.s in the news\b',
]
_NEWS_RE = [re.compile(p, re.IGNORECASE) for p in _NEWS_PATTERNS]

_NEWS_CATEGORIES = {
    "politics": ["politics", "political", "congress", "senate", "white house", "government"],
    "finance": ["finance", "financial", "market", "stock", "economy", "economic", "business"],
    "technology": ["tech", "technology", "ai", "artificial intelligence", "software", "hardware"],
    "health": ["health", "medical", "medicine", "healthcare", "hospital", "disease"],
    "world": ["world", "international", "global", "foreign", "overseas"],
    "science": ["science", "scientific", "research", "study", "nasa", "space"],
    "sports": ["sports", "sport", "game", "nfl", "nba", "mlb", "nhl", "soccer"],
}


def _detect_news(text: str) -> dict | None:
    if not any(p.search(text) for p in _NEWS_RE):
        return None
    lower = text.lower()
    category: str | None = None
    for cat, keywords in _NEWS_CATEGORIES.items():
        if any(kw in lower for kw in keywords):
            category = cat
            break

    # Extract "news about X" topic
    topic_m = re.search(r'\bnews\s+(about|on|regarding|related to)\s+(.+?)(?:\?|$)', text, re.IGNORECASE)
    topic = topic_m.group(2).strip() if topic_m else None

    return {"category": category, "topic": topic, "limit": 20}


async def _run_news(params: dict, msg_id: str) -> str:
    category = params.get("category")
    topic = params.get("topic")
    limit = params.get("limit", 20)

    label = topic or category or "all categories"
    await _update_status(f"Fetching news: {label}...")

    try:
        from app.tools.system_tools import get_news
        articles = await get_news(category=category, limit=limit)

        if topic:
            lower_topic = topic.lower()
            filtered = [
                a for a in articles
                if lower_topic in (a.get("title") or "").lower()
                or lower_topic in (a.get("summary") or a.get("description") or "").lower()
            ]
            if filtered:
                articles = filtered

        if not articles:
            msg = f"No news articles available{' for ' + label if label != 'all categories' else ''}."
            await _send_token(msg, msg_id)
            return msg

        cards = []
        for a in articles[:20]:
            cards.append({
                "title":   a.get("title", "Untitled"),
                "source":  a.get("source", a.get("feed", "")),
                "date":    a.get("published", a.get("pub_date", "")),
                "url":     a.get("url", a.get("link", "")),
                "summary": (a.get("summary") or a.get("description") or "")[:200],
            })

        cat_label = f" — {label}" if label != "all categories" else ""
        await _emit("render_canvas", {
            "title": f"News{cat_label}",
            "blocks": [{
                "type": "card-list",
                "data": {"cards": cards},
            }],
        })

        source_counts = Counter(c["source"] for c in cards if c["source"])
        top_src = ", ".join(s for s, _ in source_counts.most_common(3))
        summary = (
            f"Here are {len(cards)} headlines{cat_label}. "
            f"Sources: {top_src or 'various'}. Results on canvas."
        )
        await _send_token(summary, msg_id)
        return summary

    except Exception as exc:
        logger.error("[fast_path] news error: %s", exc)
        msg = f"Error fetching news: {exc}"
        await _send_token(msg, msg_id)
        return msg


# ─────────────────────────────────────────────────────────────────────────────
# FINANCE
# ─────────────────────────────────────────────────────────────────────────────

_FINANCE_PATTERNS = [
    r'\b(price|quote|trading|stock|share price)\b.{0,30}\b[A-Z]{1,5}\b',
    r'\$[A-Z]{1,5}\b',
    r'\b[A-Z]{2,5}\b.{0,20}\b(stock|price|share|ticker|trading|quote)\b',
    r'\b(market overview|market summary|how.s the market|market today|indices|index)\b',
    r'\bhow.s?\s+(AAPL|TSLA|MSFT|GOOG|AMZN|NVDA|META|SPY|QQQ|BTC|ETH)\b',
    r'\b(dow|nasdaq|s&p|s&p 500|russell)\b',
]
_FINANCE_RE = [re.compile(p, re.IGNORECASE) for p in _FINANCE_PATTERNS]

_MARKET_WORDS = {"market overview", "market summary", "market today", "the market",
                 "dow", "nasdaq", "s&p", "s&p 500", "russell", "indices", "index"}


def _detect_finance(text: str) -> dict | None:
    if not any(p.search(text) for p in _FINANCE_RE):
        return None
    lower = text.lower()

    # Market overview vs single ticker
    if any(w in lower for w in _MARKET_WORDS):
        return {"mode": "overview"}

    # Extract ticker
    m = re.search(r'\$([A-Z]{1,5})\b', text)
    if not m:
        m = re.search(r'\b([A-Z]{2,5})\b', text)
    if m:
        return {"mode": "quote", "ticker": m.group(1).upper()}

    return {"mode": "overview"}


async def _run_finance(params: dict, msg_id: str) -> str:
    mode = params.get("mode", "overview")
    try:
        from app.tools.system_tools import get_finance_quote, get_market_overview

        if mode == "quote":
            ticker = params["ticker"]
            await _update_status(f"Fetching quote for {ticker}...")
            data = await get_finance_quote(ticker)
            if not data:
                msg = f"No quote data available for {ticker}."
                await _send_token(msg, msg_id)
                return msg

            price = data.get("price", data.get("regularMarketPrice", "N/A"))
            change = data.get("change", data.get("regularMarketChange", ""))
            change_pct = data.get("change_pct", data.get("regularMarketChangePercent", ""))
            volume = data.get("volume", data.get("regularMarketVolume", ""))
            name = data.get("name", data.get("shortName", ticker))

            direction = "▲" if str(change).startswith("-") is False and str(change) not in ("", "0") else "▼"
            await _emit("render_canvas", {
                "title": f"{ticker} — {name}",
                "blocks": [{
                    "type": "metrics",
                    "data": {"metrics": [
                        {"label": "Price",   "value": f"${price}"},
                        {"label": "Change",  "value": f"{direction} {change} ({change_pct}%)"},
                        {"label": "Volume",  "value": str(volume)},
                    ]},
                }],
            })
            summary = f"{ticker} ({name}) is trading at ${price} — {direction} {change} ({change_pct}%)."
            await _send_token(summary, msg_id)
            return summary

        else:
            await _update_status("Fetching market overview...")
            data = await get_market_overview()
            if not data:
                msg = "Market overview not available."
                await _send_token(msg, msg_id)
                return msg

            indices = data.get("indices", data.get("markets", []))
            if isinstance(indices, dict):
                indices = [{"name": k, **v} for k, v in indices.items()]

            rows = []
            for idx in indices[:15]:
                name = idx.get("name", idx.get("symbol", ""))
                price = idx.get("price", idx.get("value", ""))
                change = idx.get("change", "")
                change_pct = idx.get("change_pct", idx.get("changePercent", ""))
                rows.append([name, str(price), str(change), f"{change_pct}%"])

            await _emit("render_canvas", {
                "title": "Market Overview",
                "blocks": [{
                    "type": "table",
                    "data": {
                        "headers": ["Index / Asset", "Price", "Change", "Change %"],
                        "rows": rows,
                    },
                }],
            })
            summary = f"Market overview displayed on canvas ({len(rows)} instruments)."
            await _send_token(summary, msg_id)
            return summary

    except Exception as exc:
        logger.error("[fast_path] finance error: %s", exc)
        msg = f"Error fetching financial data: {exc}"
        await _send_token(msg, msg_id)
        return msg


# ─────────────────────────────────────────────────────────────────────────────
# WEATHER
# ─────────────────────────────────────────────────────────────────────────────

_WEATHER_PATTERNS = [
    r'\b(weather|forecast|temperature|temp|rain|snow|sunny|cloudy|humid|wind)\b',
    r'\bwill it (rain|snow|be hot|be cold|be warm|be sunny)\b',
    r'\bwhat.s (it like|the weather)\b',
    r'\bdo i need (an umbrella|a jacket|a coat)\b',
]
_WEATHER_RE = [re.compile(p, re.IGNORECASE) for p in _WEATHER_PATTERNS]


def _detect_weather(text: str) -> dict | None:
    if not any(p.search(text) for p in _WEATHER_RE):
        return None
    return {}


async def _run_weather(params: dict, msg_id: str) -> str:
    await _update_status("Fetching weather...")
    try:
        from app.tools.system_tools import get_weather
        data = await get_weather()
        if not data:
            msg = "Weather service unavailable. Check that a weather API key is configured."
            await _send_token(msg, msg_id)
            return msg

        current = data.get("current", {})
        forecast = data.get("forecast", [])

        temp   = current.get("temperature", "?")
        feels  = current.get("feels_like", "")
        desc   = current.get("description", "")
        humid  = current.get("humidity", "")
        wind   = current.get("wind_speed", "")
        high   = current.get("high", "")
        low    = current.get("low", "")

        metrics = [{"label": "Conditions", "value": desc.title()}]
        if temp != "?":
            metrics.append({"label": "Temperature", "value": f"{temp}°F"})
        if feels:
            metrics.append({"label": "Feels Like", "value": f"{feels}°F"})
        if high and low:
            metrics.append({"label": "High / Low", "value": f"{high}°F / {low}°F"})
        if humid:
            metrics.append({"label": "Humidity", "value": f"{humid}%"})
        if wind:
            metrics.append({"label": "Wind", "value": f"{wind} mph"})

        blocks = [{"type": "metrics", "data": {"metrics": metrics}}]

        if forecast:
            fc_rows = []
            for day in forecast[:5]:
                fc_rows.append([
                    day.get("date", day.get("day", "")),
                    day.get("description", "").title(),
                    f"{day.get('high', '?')}°F",
                    f"{day.get('low', '?')}°F",
                    f"{day.get('precip_chance', day.get('precipitation', ''))}%",
                ])
            if fc_rows:
                blocks.append({
                    "type": "table",
                    "data": {
                        "headers": ["Day", "Conditions", "High", "Low", "Precip"],
                        "rows": fc_rows,
                    },
                })

        radar_url = data.get("radar_url", "")
        if radar_url:
            blocks.append({
                "type": "image",
                "data": {"src": radar_url, "caption": "Radar"},
            })

        await _emit("render_canvas", {
            "title": "Current Weather",
            "blocks": blocks,
        })

        feels_str = f", feels like {feels}°F" if feels else ""
        summary = f"Currently {temp}°F{feels_str}, {desc}."
        if high and low:
            summary += f" High of {high}°F, low of {low}°F today."
        await _send_token(summary, msg_id)
        return summary

    except Exception as exc:
        logger.error("[fast_path] weather error: %s", exc)
        msg = f"Error fetching weather: {exc}"
        await _send_token(msg, msg_id)
        return msg


# ─────────────────────────────────────────────────────────────────────────────
# CALENDAR
# ─────────────────────────────────────────────────────────────────────────────

_CALENDAR_PATTERNS = [
    r'\b(calendar|schedule|agenda|events?)\b',
    r'\bwhat(\'s| is) (on my|my).{0,20}\b(calendar|schedule|agenda)\b',
    r'\bwhat do i have\b',
    r'\b(today|tomorrow|this week|next week).{0,20}\b(schedule|calendar|events?|agenda)\b',
    r'\bupcoming (meetings?|events?|appointments?)\b',
    r'\bam i (free|busy|available)\b',
]
_CALENDAR_RE = [re.compile(p, re.IGNORECASE) for p in _CALENDAR_PATTERNS]


def _detect_calendar(text: str) -> dict | None:
    # Legislative queries contain "schedule" or "agenda" but should never
    # hit the personal calendar fast path — let them fall through to legislation.
    if re.search(r'\b(legislat\w*|bills?\b|congress\b|senate\b|statehouse)\b', text, re.IGNORECASE):
        return None
    if not any(p.search(text) for p in _CALENDAR_RE):
        return None
    lower = text.lower()
    days = 1 if "today" in lower else (2 if "tomorrow" in lower else (14 if "next week" in lower else 7))
    return {"days": days}


async def _run_calendar(params: dict, msg_id: str) -> str:
    days = params.get("days", 7)
    await _update_status("Fetching calendar...")
    try:
        from app.tools.system_tools import get_calendar_events
        events = await get_calendar_events(days=days)

        if not events:
            msg = "No upcoming events found, or Google Calendar is not connected. Connect via Settings → Connectors → Google."
            await _send_token(msg, msg_id)
            return msg

        rows = []
        for e in events[:25]:
            start = e.get("start", e.get("start_time", ""))
            end   = e.get("end",   e.get("end_time",   ""))
            rows.append([
                e.get("date", str(start)[:10]),
                str(start)[11:16] if len(str(start)) > 10 else str(start),
                e.get("summary", e.get("title", "Untitled")),
                e.get("location", ""),
            ])

        label = "Today" if days == 1 else ("This Week" if days == 7 else f"Next {days} Days")
        await _emit("render_canvas", {
            "title": f"Calendar — {label}",
            "blocks": [{
                "type": "table",
                "data": {
                    "headers": ["Date", "Time", "Event", "Location"],
                    "rows": rows,
                },
            }],
        })

        next_event = events[0]
        next_title = next_event.get("summary", next_event.get("title", ""))
        next_start = next_event.get("start", next_event.get("start_time", ""))
        summary = (
            f"You have {len(events)} event{'s' if len(events) != 1 else ''} "
            f"in the next {days} day{'s' if days != 1 else ''}. "
            f"Next up: {next_title} at {str(next_start)[11:16] or next_start}."
        )
        await _send_token(summary, msg_id)
        return summary

    except Exception as exc:
        logger.error("[fast_path] calendar error: %s", exc)
        msg = f"Error fetching calendar: {exc}"
        await _send_token(msg, msg_id)
        return msg


# ─────────────────────────────────────────────────────────────────────────────
# MEMORY / DOCUMENT SEARCH
# ─────────────────────────────────────────────────────────────────────────────

_MEMORY_PATTERNS = [
    r'\b(remember|recall|remind me)\b.{0,30}\b(when|what|that|about)\b',
    r'\bwe (discussed|talked about|mentioned|decided|agreed)\b',
    r'\byou (said|told me|mentioned|wrote)\b',
    r'\b(search|find|look up|look in)\b.{0,20}\b(my notes|my documents|memory|memories)\b',
    r'\bwhat did (i|we|you).{0,30}\b(say|decide|discuss|agree|write)\b',
    r'\blast time (we|i|you)\b',
    r'\bdo you remember\b',
    r'\bfrom (our|my) (conversation|notes|documents|session|last session)\b',
]
_MEMORY_RE = [re.compile(p, re.IGNORECASE) for p in _MEMORY_PATTERNS]


def _detect_memory(text: str) -> dict | None:
    if not any(p.search(text) for p in _MEMORY_RE):
        return None

    # Strip intent phrases to get the search topic
    topic = text
    for strip in (
        r'\b(remember|recall|remind me|do you remember)\s+(when|what|that|about)?\s*',
        r'\bwe (discussed|talked about|mentioned|decided|agreed)\s+',
        r'\byou (said|told me|mentioned|wrote)\s+',
        r'\bwhat did (i|we|you).{0,20}(say|decide|discuss|agree|write)\s+(about)?\s*',
        r'\blast time (we|i|you)\s+',
        r'\bfrom (our|my) (conversation|notes|documents|session|last session)\s+(about|on)?\s*',
        r'\b(search|find|look up|look in)\s+(my notes|my documents|memory|memories)\s+(for|about)?\s*',
    ):
        topic = re.sub(strip, '', topic, flags=re.IGNORECASE).strip()
    topic = topic.strip(' .,?!')

    return {"query": topic or text, "namespace": None}


async def _run_memory(params: dict, msg_id: str) -> str:
    query = params.get("query", "")
    await _update_status("Searching memory...")
    try:
        from app.service.memory_service import get_memory_service
        mem = get_memory_service()
        if mem is None:
            msg = "Memory service not available."
            await _send_token(msg, msg_id)
            return msg

        results = mem._hybrid_search(query, n_results=10)

        if not results:
            msg = f'No memory entries found matching "{query}".'
            await _send_token(msg, msg_id)
            return msg

        cards = []
        for r in results:
            raw = r.get("content", "")
            content = raw[len("passage: "):] if raw.startswith("passage: ") else raw
            meta = r.get("metadata", {})
            cards.append({
                "title":   meta.get("agent_role", "memory"),
                "source":  meta.get("source", meta.get("thread_id", ""))[:40],
                "date":    meta.get("timestamp", ""),
                "summary": content[:250],
            })

        await _emit("render_canvas", {
            "title": f'Memory: "{query}"',
            "blocks": [{
                "type": "card-list",
                "data": {"cards": cards},
            }],
        })

        summary = f'Found {len(results)} memory entries matching "{query}". Results on canvas.'
        await _send_token(summary, msg_id)
        return summary

    except Exception as exc:
        logger.error("[fast_path] memory error: %s", exc)
        msg = f"Error searching memory: {exc}"
        await _send_token(msg, msg_id)
        return msg


# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM STATUS
# ─────────────────────────────────────────────────────────────────────────────

_SYSTEM_PATTERNS = [
    r'\b(system status|system stats|system health)\b',
    r'\bhow.s (the (gpu|cpu|memory|ram|system|hardware))\b',
    r'\b(gpu|cpu|ram|vram|memory)\s+(usage|utilization|status|stats|load)\b',
    r'\bhardware (status|stats|monitor|usage)\b',
    r'\bwhat.s (the )?(cpu|gpu|ram|vram|memory) (at|doing|usage|running at)\b',
    r'\bresource (usage|monitor|stats)\b',
]
_SYSTEM_RE = [re.compile(p, re.IGNORECASE) for p in _SYSTEM_PATTERNS]


def _detect_system(text: str) -> dict | None:
    if not any(p.search(text) for p in _SYSTEM_RE):
        return None
    return {}


async def _run_system(params: dict, msg_id: str) -> str:
    await _update_status("Reading system status...")
    try:
        from app.tools.system_tools import get_system_status
        data = await get_system_status()
        if not data:
            msg = "System monitor not available."
            await _send_token(msg, msg_id)
            return msg

        cpu  = data.get("cpu", {})
        ram  = data.get("memory", {})
        gpus = data.get("gpu", [])
        if isinstance(gpus, dict):
            gpus = [gpus]

        metrics = [
            {"label": "CPU Usage",   "value": f"{cpu.get('percent', '?')}%"},
            {"label": "CPU Cores",   "value": str(cpu.get("count", "?"))},
            {"label": "RAM Used",    "value": f"{ram.get('used_gb', '?')} / {ram.get('total_gb', '?')} GB"},
            {"label": "RAM %",       "value": f"{ram.get('percent', '?')}%"},
        ]
        for i, g in enumerate(gpus or []):
            label = g.get("name", f"GPU {i}")[:20]
            metrics.append({"label": f"{label} Util", "value": f"{g.get('utilization', g.get('load', '?'))}%"})
            vram_used = g.get("memory_used", g.get("vram_used", "?"))
            vram_total = g.get("memory_total", g.get("vram_total", "?"))
            metrics.append({"label": f"{label} VRAM", "value": f"{vram_used} / {vram_total} MB"})

        await _emit("render_canvas", {
            "title": "System Status",
            "blocks": [{"type": "metrics", "data": {"metrics": metrics}}],
        })

        gpu_summary = ""
        if gpus:
            g = gpus[0]
            gpu_summary = (
                f" GPU: {g.get('utilization', g.get('load', '?'))}% util, "
                f"{g.get('memory_used', g.get('vram_used', '?'))}MB VRAM used."
            )
        summary = (
            f"CPU: {cpu.get('percent', '?')}%, "
            f"RAM: {ram.get('used_gb', '?')}/{ram.get('total_gb', '?')}GB.{gpu_summary}"
        )
        await _send_token(summary, msg_id)
        return summary

    except Exception as exc:
        logger.error("[fast_path] system status error: %s", exc)
        msg = f"Error reading system status: {exc}"
        await _send_token(msg, msg_id)
        return msg


# ─────────────────────────────────────────────────────────────────────────────
# ROUTER — single entry point
# ─────────────────────────────────────────────────────────────────────────────

# Order matters: more specific patterns first.
_DETECTORS: list[tuple[
    Callable[[str], dict | None],
    Callable[[dict, str], Awaitable[str]],
    str,
]] = [
    (_detect_legislation, _run_legislation, "legislation"),
    (_detect_news,        _run_news,        "news"),
    (_detect_finance,     _run_finance,     "finance"),
    (_detect_weather,     _run_weather,     "weather"),
    (_detect_calendar,    _run_calendar,    "calendar"),
    (_detect_memory,      _run_memory,      "memory"),
    (_detect_system,      _run_system,      "system"),
]


def detect_fast_path(
    text: str,
) -> tuple[Callable[[dict, str], Awaitable[str]], dict, str] | None:
    """
    Check whether the user message matches a data-first fast path.

    Returns (handler, params, source_name) if matched, None otherwise.
    Caller should invoke: await handler(params, msg_id)
    """
    for detect, handle, name in _DETECTORS:
        params = detect(text)
        if params is not None:
            logger.info("[fast_path] Matched: %s (query=%.60s)", name, text)
            return handle, params, name
    return None
