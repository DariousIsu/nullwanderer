"""
AURA NX-Alpha — Web Scraper Service

trafilatura primary, Playwright headless fallback.
No cloud APIs. Fully local.

INSTALL:
    pip install trafilatura
    playwright install chromium   (playwright is already in requirements.txt)
"""

import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)


async def scrape(url: str) -> str:
    """
    Fetch URL and return clean Markdown text.
    Tries trafilatura first (fast, handles most article/doc pages).
    Falls back to Playwright for JS-heavy pages or if trafilatura yields < 200 chars.
    """
    import trafilatura

    loop = asyncio.get_running_loop()
    downloaded = await loop.run_in_executor(None, trafilatura.fetch_url, url)
    if downloaded:
        text = trafilatura.extract(
            downloaded,
            output_format="markdown",
            include_links=False,
        )
        if text and len(text) > 200:
            return text

    logger.debug("[scraper] trafilatura insufficient for %s — trying Playwright", url)
    return await _scrape_playwright(url)


async def _scrape_playwright(url: str) -> str:
    """Headless Chromium fallback via Playwright."""
    try:
        from playwright.async_api import async_playwright

        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page()
            await page.goto(url, timeout=30_000)
            await page.wait_for_load_state("networkidle", timeout=15_000)
            text = await page.inner_text("body")
            await browser.close()
            return text[:50_000]  # Cap at 50K chars
    except Exception as exc:
        logger.warning("[scraper] Playwright fallback failed for %s: %s", url, exc)
        return ""


async def crawl(url: str, max_pages: int = 10) -> list[dict]:
    """
    Crawl a domain up to max_pages pages via sitemap.
    Returns list of {url, content} dicts.
    """
    try:
        import trafilatura
        from trafilatura.sitemaps import sitemap_search

        links: Optional[list[str]] = sitemap_search(url)
        if not links:
            links = [url]

        results = []
        for link in links[:max_pages]:
            content = await scrape(link)
            if content:
                results.append({"url": link, "content": content})
        return results
    except Exception as exc:
        logger.error("[scraper] crawl failed for %s: %s", url, exc)
        return []


async def screenshot(url: str) -> Optional[bytes]:
    """
    Navigate to URL and return a single PNG screenshot as bytes.
    Use for: one-shot page captures, canvas browser_snapshot blocks.
    """
    try:
        from playwright.async_api import async_playwright
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            page = await browser.new_page(viewport={"width": 1280, "height": 720})
            await page.goto(url, timeout=30000, wait_until="networkidle")
            img_bytes = await page.screenshot(type="png", full_page=False)
            await browser.close()
            return img_bytes
    except Exception as exc:
        logger.warning("[scraper] screenshot failed for %s: %s", url, exc)
        return None


async def screencast(
    url: str,
    fps: int = 8,
    max_frames: int = 120,
    quality: int = 70,
):
    """
    Stream JPEG frames of a live URL via Chrome DevTools Protocol.
    Use instead of <iframe> for sites that block embedding.

    Yields raw JPEG bytes per frame. Caller is responsible for SSE emission.
    Stops after max_frames or if no frames arrive within 5 seconds.
    Browser is always closed on exit (try/finally ensures no resource leaks).
    """
    import base64
    from playwright.async_api import async_playwright

    frame_queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=30)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        page = await browser.new_page(viewport={"width": 1280, "height": 720})
        cdp = await page.context.new_cdp_session(page)

        async def on_screencast_frame(event: dict):
            raw = base64.b64decode(event["data"])
            session_id = event.get("sessionId", 0)
            try:
                frame_queue.put_nowait(raw)
            except asyncio.QueueFull:
                pass  # drop frame if consumer is slow
            try:
                await cdp.send("Page.screencastFrameAck", {"sessionId": session_id})
            except Exception:
                pass

        cdp.on("Page.screencastFrame", on_screencast_frame)

        await cdp.send("Page.startScreencast", {
            "format": "jpeg",
            "quality": quality,
            "maxWidth": 1280,
            "maxHeight": 720,
            "everyNthFrame": max(1, 60 // fps),
        })

        await page.goto(url, timeout=30000, wait_until="networkidle")

        try:
            count = 0
            while count < max_frames:
                try:
                    frame = await asyncio.wait_for(frame_queue.get(), timeout=5.0)
                    yield frame
                    count += 1
                except asyncio.TimeoutError:
                    break  # no frames for 5s — page is idle or done
        finally:
            try:
                await cdp.send("Page.stopScreencast")
            except Exception:
                pass
            await browser.close()
