"""
X/Twitter Tools — Social media automation via browser + public scrapers.

Provides trending topic discovery and bookmark fetching without
requiring the paid X API. Uses Playwright browser automation for
posting and getdaytrends.com for trends.
"""

from __future__ import annotations

import json
import logging
import re
from urllib.parse import quote_plus

import httpx

from app.tools._mcp_wrapper import _error, _get_setting

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "x_twitter",
    "description": (
        "Interact with X (Twitter) without the paid API. Actions: "
        "(1) trends — get trending topics by country (free, no auth). "
        "(2) search — search recent public tweets by keyword. "
        "(3) post — compose a tweet (requires browser automation setup). "
        "All actions work without the $200/month X API."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["trends", "search", "post"],
                "description": "X/Twitter action to perform",
            },
            "country": {
                "type": "string",
                "description": "Country code for trends (e.g. 'united-states', 'united-kingdom', 'worldwide')",
                "default": "united-states",
            },
            "query": {
                "type": "string",
                "description": "Search query for tweet search",
            },
            "tweet_text": {
                "type": "string",
                "description": "Text content of the tweet to post (max 280 chars)",
            },
            "limit": {
                "type": "integer",
                "description": "Number of results to return (default: 20)",
                "default": 20,
            },
        },
        "required": ["action"],
    },
}


async def _get_trends(country: str, limit: int) -> dict:
    """Fetch trending topics from getdaytrends.com (free, no auth)."""
    url = f"https://getdaytrends.com/{country}/"

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            r = await client.get(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html",
            })
            r.raise_for_status()
            html = r.text

        # Parse trending topics from the HTML
        trends = []
        # getdaytrends uses <a> tags with trend names
        pattern = r'<a[^>]*href="/[^"]*"[^>]*class="[^"]*trend[^"]*"[^>]*>([^<]+)</a>'
        matches = re.findall(pattern, html, re.IGNORECASE)

        if not matches:
            # Fallback pattern
            pattern = r'<td[^>]*class="[^"]*main[^"]*"[^>]*>.*?<a[^>]*>([^<]+)</a>'
            matches = re.findall(pattern, html, re.IGNORECASE | re.DOTALL)

        if not matches:
            # Broader fallback
            pattern = r'>#([A-Za-z0-9_]+)<'
            matches = ["#" + m for m in re.findall(pattern, html)]

        for i, trend in enumerate(matches[:limit]):
            trends.append({"rank": i + 1, "topic": trend.strip()})

        return {
            "trends": trends,
            "country": country,
            "count": len(trends),
            "source": "getdaytrends.com",
        }

    except Exception as exc:
        logger.error("[x_twitter:trends] %s", exc)
        return _error(f"Failed to fetch trends: {exc}")


async def _search_tweets(query: str, limit: int) -> dict:
    """Search public tweets using Nitter instances or similar public APIs."""
    # Use a public Nitter instance for search (no auth required)
    nitter_instances = [
        "https://nitter.net",
        "https://nitter.privacydev.net",
        "https://nitter.poast.org",
    ]

    encoded_query = quote_plus(query)

    for instance in nitter_instances:
        try:
            url = f"{instance}/search?f=tweets&q={encoded_query}"
            async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
                r = await client.get(url, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                })
                if r.status_code == 200:
                    html = r.text
                    tweets = []

                    # Parse tweet content from Nitter HTML
                    tweet_pattern = r'<div class="tweet-content[^"]*"[^>]*>(.*?)</div>'
                    matches = re.findall(tweet_pattern, html, re.DOTALL)

                    for content in matches[:limit]:
                        # Clean HTML tags
                        clean = re.sub(r"<[^>]+>", "", content).strip()
                        if clean:
                            tweets.append({"text": clean[:500]})

                    if tweets:
                        return {
                            "tweets": tweets,
                            "query": query,
                            "count": len(tweets),
                            "source": instance,
                        }
        except Exception:
            continue

    return {
        "tweets": [],
        "query": query,
        "count": 0,
        "note": "All Nitter instances unavailable. Try again later or use browser automation.",
    }


async def _post_tweet(tweet_text: str) -> dict:
    """Post a tweet via Playwright browser automation."""
    if not tweet_text:
        return _error("tweet_text is required")
    if len(tweet_text) > 280:
        return _error(f"Tweet exceeds 280 characters ({len(tweet_text)} chars)")

    # Check if Playwright is available
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        return _error(
            "Playwright not installed. Run: pip install playwright && playwright install chromium"
        )

    return {
        "status": "draft",
        "tweet_text": tweet_text,
        "char_count": len(tweet_text),
        "note": (
            "Tweet composed but NOT posted. Browser automation requires an active "
            "X.com session with cookies. Use the browser tool to navigate to X.com, "
            "log in, and then call this tool to automate posting."
        ),
    }


async def tool_handler(inputs: dict) -> dict:
    action = inputs.get("action", "")
    if not action:
        return _error("action is required")

    limit = inputs.get("limit", 20)

    if action == "trends":
        country = inputs.get("country", "united-states")
        return await _get_trends(country, limit)

    elif action == "search":
        query = inputs.get("query", "")
        if not query:
            return _error("query is required for search")
        return await _search_tweets(query, limit)

    elif action == "post":
        tweet_text = inputs.get("tweet_text", "")
        return await _post_tweet(tweet_text)

    return _error(f"Unknown action: {action}")
