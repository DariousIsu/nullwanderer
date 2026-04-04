"""
Playwright browser tool for the interface agent.

Provides headless Chromium browsing capabilities: full page fetch with
text extraction and link collection, plus screenshot capture.

The browser is lazily initialized on first use and reused across calls.
"""

import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Maximum characters of page text to return
_MAX_TEXT_CHARS = 8000
# Maximum links to return per page
_MAX_LINKS = 20
# Navigation timeout in milliseconds
_TIMEOUT_MS = 15_000


class BrowserTool:
    """
    Async headless browser wrapper built on Playwright.

    The Playwright instance, browser, and context are created lazily on
    first use via _ensure_started().  Call close() when the tool is no
    longer needed to release resources.
    """

    def __init__(self) -> None:
        self._playwright = None
        self._browser = None
        self._context = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def _ensure_started(self) -> None:
        """
        Launch Playwright and a headless Chromium browser if not already running.

        Idempotent — safe to call multiple times.
        """
        if self._browser is not None:
            return

        try:
            from playwright.async_api import async_playwright

            self._playwright = await async_playwright().start()
            self._browser = await self._playwright.chromium.launch(headless=True)
            self._context = await self._browser.new_context(
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                )
            )
            logger.info("Playwright browser started")
        except Exception as exc:
            logger.error("Failed to start Playwright browser: %s", exc)
            raise

    async def close(self) -> None:
        """
        Close the browser context, browser, and Playwright instance.

        Safe to call even if the browser was never started.
        """
        try:
            if self._context:
                await self._context.close()
                self._context = None
            if self._browser:
                await self._browser.close()
                self._browser = None
            if self._playwright:
                await self._playwright.stop()
                self._playwright = None
            logger.info("Playwright browser closed")
        except Exception as exc:
            logger.warning("Error closing Playwright browser: %s", exc)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def fetch_page(self, url: str, wait_for: str = "domcontentloaded") -> dict:
        """
        Navigate to a URL and return structured page data.

        Parameters
        ----------
        url:
            The URL to fetch.
        wait_for:
            Playwright waitUntil event (default 'domcontentloaded').

        Returns
        -------
        dict
            On success: {url, title, text_content, links, status_code}.
            On failure: {url, error}.

        Notes
        -----
        - text_content is the visible text with scripts and styles removed,
          truncated to 8000 characters.
        - links is a list of up to 20 {text, href} dicts.
        """
        try:
            await self._ensure_started()

            page = await self._context.new_page()
            try:
                response = await page.goto(
                    url,
                    wait_until=wait_for,
                    timeout=_TIMEOUT_MS,
                )
                status_code = response.status if response else 0

                title = await page.title()

                # Strip script and style elements, then get inner text
                await page.evaluate(
                    """() => {
                        document.querySelectorAll('script, style, noscript, iframe').forEach(el => el.remove());
                    }"""
                )
                raw_text = await page.inner_text("body")
                # Collapse excess whitespace
                text_content = " ".join(raw_text.split())[:_MAX_TEXT_CHARS]

                # Absorb page content into LightRAG knowledge graph (non-blocking)
                if text_content and len(text_content) > 200:
                    try:
                        from app.service.lightrag_service import LightRAGService
                        LightRAGService.get_instance().enqueue_ingest(
                            text_content, url, "document"
                        )
                    except Exception as _lg_exc:
                        import logging as _lg; _lg.getLogger(__name__).debug("[browser] LightRAG enqueue failed: %s", _lg_exc)

                # Collect visible links
                link_elements = await page.query_selector_all("a[href]")
                links = []
                for el in link_elements[:_MAX_LINKS]:
                    try:
                        text = (await el.inner_text()).strip()
                        href = await el.get_attribute("href")
                        if href and href.startswith("http"):
                            links.append({"text": text[:120], "href": href})
                    except Exception:
                        pass

                logger.debug("Fetched page %r — %d chars, %d links", url, len(text_content), len(links))
                return {
                    "url": url,
                    "title": title,
                    "text_content": text_content,
                    "links": links,
                    "status_code": status_code,
                }
            finally:
                await page.close()

        except Exception as exc:
            logger.warning("fetch_page failed for %r: %s", url, exc)
            return {"url": url, "error": str(exc)}

    async def screenshot(self, url: str) -> Optional[bytes]:
        """
        Navigate to a URL and capture a full-page screenshot.

        Parameters
        ----------
        url:
            The URL to screenshot.

        Returns
        -------
        bytes or None
            PNG image bytes on success, None on failure.
        """
        try:
            await self._ensure_started()

            page = await self._context.new_page()
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=_TIMEOUT_MS)
                png_bytes = await page.screenshot(full_page=True, type="png")
                logger.debug("Screenshot captured for %r (%d bytes)", url, len(png_bytes))
                return png_bytes
            finally:
                await page.close()

        except Exception as exc:
            logger.warning("screenshot failed for %r: %s", url, exc)
            return None


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------

_browser_tool: Optional[BrowserTool] = None


def get_browser_tool() -> BrowserTool:
    """
    Return the BrowserTool singleton, creating it if necessary.

    The browser itself is not launched until the first call to
    fetch_page() or screenshot().
    """
    global _browser_tool
    if _browser_tool is None:
        _browser_tool = BrowserTool()
    return _browser_tool


def init_browser_tool() -> BrowserTool:
    """
    (Re-)initialize and return the BrowserTool singleton.

    Useful for explicit initialization at application startup.
    """
    global _browser_tool
    _browser_tool = BrowserTool()
    logger.info("BrowserTool initialized")
    return _browser_tool
