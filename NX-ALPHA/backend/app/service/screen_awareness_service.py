"""
AURA NX-Alpha — Screen Awareness Service

Monitors the active foreground window on a background task.
No screenshot taken — only window title + process name (essentially free).

When the user switches to a new meaningful context (e.g., opens a Word doc,
switches to a different VS Code project, navigates to a new browser tab),
this service:
  1. Extracts a search topic from the window title
  2. Queries file_index_service for related files
  3. Emits a canvas "Related Files" card to AURA's canvas
  4. Exposes current context for interface_agent to read

This is the "interactive partner" layer — AURA notices what you're working
on and proactively surfaces relevant resources before you ask.

MODES:
    proactive   — active window tracking + file search + canvas emit
    ambient     — active window tracking only (no canvas emit)
    quiet       — completely dormant
    study       — same as ambient

SINGLETON:
    init_screen_awareness()  — create and start
    get_screen_awareness()   — get instance
    get_current_context()    — current active window context (for prompt injection)

TUNING:
    POLL_INTERVAL_S   = 3.0    window title check cadence (cheap, no screenshot)
    SEARCH_COOLDOWN_S = 20.0   min seconds between file searches for same context
    EMIT_DEBOUNCE_S   = 8.0    min seconds between canvas emits (anti-spam)
    MIN_CONTEXT_WORDS = 2      skip trivial titles like "Settings", "New Tab"
"""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_IS_WINDOWS = platform.system() == "Windows"

# ─────────────────────────────────────────────────────────────────────────────
# TUNING CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

POLL_INTERVAL_S   = 3.0
SEARCH_COOLDOWN_S = 20.0
EMIT_DEBOUNCE_S   = 8.0
MIN_CONTEXT_WORDS = 2

# Vision capture (Phase B)
_VISION_INTERVAL_S         = 30.0    # proactive mode
_VISION_INTERVAL_AMBIENT_S = 120.0   # ambient mode
_VISION_MAX_WIDTH          = 1024
_VISION_JPEG_QUALITY       = 60
_VISION_PROMPT = (
    "Describe what the user is doing on their screen in 2-3 sentences. "
    "Note the application name, document/webpage titles, key visible text, "
    "and the user's apparent task or activity."
)

# Browser history polling (Phase C)
_BROWSER_POLL_INTERVAL_S = 60.0
_CHROME_HISTORY = Path(os.environ.get("LOCALAPPDATA", "")) / "Google/Chrome/User Data/Default/History"
_EDGE_HISTORY   = Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Edge/User Data/Default/History"
_BROWSER_PRIVACY_FILTER = (
    "chrome://", "edge://", "about:", "chrome-extension://",
    "password", "login", "banking", "health",
)

# ─────────────────────────────────────────────────────────────────────────────
# APP SUFFIX STRIPPING — ordered longest-first to match greedily
# ─────────────────────────────────────────────────────────────────────────────

_APP_SUFFIXES = [
    " - Microsoft Visual Studio",
    " - Visual Studio Code",
    " — Visual Studio Code",
    " - Microsoft Word",
    " - Microsoft Excel",
    " - Microsoft PowerPoint",
    " - Microsoft Outlook",
    " - Microsoft OneNote",
    " - Google Chrome",
    " - Mozilla Firefox",
    " - Microsoft Edge",
    " - Notepad++",
    " - Notepad",
    " - Adobe Acrobat",
    " - Adobe Photoshop",
    " - File Explorer",
    " - Windows Explorer",
    " - PyCharm",
    " - IntelliJ IDEA",
    " - Sublime Text",
    " - Atom",
    " - WordPad",
    " - Paint",
    " | ",    # browser tab separator (keep left side)
    " – ",    # em-dash used by some apps
]

# File extensions to strip from document titles
_EXT_PATTERN = re.compile(
    r'\.(docx?|xlsx?|pptx?|pdf|txt|md|py|js|ts|jsx|tsx|html|css|json|csv|zip|log)$',
    re.IGNORECASE,
)

# Titles that are never meaningful
_SKIP_TITLES: frozenset[str] = frozenset({
    "", "new tab", "settings", "task manager", "control panel",
    "start", "desktop", "explorer", "file explorer", "search",
    "untitled", "untitled document", "untitled - notepad",
    "program manager", "windows security", "notification center",
    "clock", "calendar", "calculator", "snipping tool",
})

# App process names → human-readable app type hint (appended to search query)
_PROC_HINT: dict[str, str] = {
    "winword.exe":   "document",
    "excel.exe":     "spreadsheet",
    "powerpnt.exe":  "presentation",
    "code.exe":      "code",
    "pycharm64.exe": "code",
    "chrome.exe":    "browser",
    "firefox.exe":   "browser",
    "msedge.exe":    "browser",
    "acrobat.exe":   "pdf",
    "acrord32.exe":  "pdf",
    "outlook.exe":   "email",
}


# ─────────────────────────────────────────────────────────────────────────────
# CONTEXT DATACLASS
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class WindowContext:
    raw_title:   str    = ""
    topic:       str    = ""    # cleaned search topic
    app_name:    str    = ""    # e.g. "WINWORD.EXE"
    app_hint:    str    = ""    # e.g. "document"
    captured_at: float = 0.0

    @property
    def search_query(self) -> str:
        """Best query for file search — topic, with app hint appended if useful."""
        if self.app_hint and self.app_hint not in ("browser",):
            return f"{self.topic} {self.app_hint}".strip()
        return self.topic

    def is_meaningful(self) -> bool:
        lc = self.topic.lower()
        return (
            bool(self.topic)
            and lc not in _SKIP_TITLES
            and len(self.topic.split()) >= MIN_CONTEXT_WORDS
        )

    def differs_from(self, other: "WindowContext") -> bool:
        """True if this context is different enough to warrant a new search."""
        return self.topic.lower() != other.topic.lower()


# ─────────────────────────────────────────────────────────────────────────────
# TITLE PARSING
# ─────────────────────────────────────────────────────────────────────────────

def _strip_app_suffix(title: str) -> str:
    """Remove known application suffixes and separators from a window title."""
    for suffix in _APP_SUFFIXES:
        if " | " == suffix or " – " == suffix:
            # Use as splitter — keep left side only
            if suffix in title:
                title = title.split(suffix)[0]
        else:
            if title.endswith(suffix):
                title = title[: -len(suffix)]
    return title.strip()


def _clean_title(raw: str) -> str:
    """
    Convert a raw window title into a clean search topic.

    "GLEIPNIR CONSULTING CORP.docx - Word"  →  "GLEIPNIR CONSULTING CORP"
    "NX-Alpha — Visual Studio Code"         →  "NX-Alpha"
    "Budget 2026.xlsx - Excel"              →  "Budget 2026"
    "New Tab - Chrome"                      →  ""  (skipped downstream)
    """
    t = _strip_app_suffix(raw)
    t = _EXT_PATTERN.sub("", t)   # strip file extensions
    t = t.strip(" -–—|")           # strip leading/trailing separators
    return t.strip()


def _get_foreground_info() -> tuple[str, str]:
    """
    Return (raw_title, process_name) for the current foreground window.
    Returns ("", "") if win32gui is unavailable or an error occurs.
    Runs synchronously — call via asyncio.to_thread().
    """
    if not _IS_WINDOWS:
        return "", ""
    try:
        import win32gui      # type: ignore
        import win32process  # type: ignore
        import psutil        # type: ignore

        hwnd  = win32gui.GetForegroundWindow()
        title = win32gui.GetWindowText(hwnd)

        _, pid    = win32process.GetWindowThreadProcessId(hwnd)
        proc_name = ""
        try:
            proc_name = psutil.Process(pid).name().lower()
        except Exception:
            pass

        return title, proc_name
    except Exception as exc:
        logger.debug("[screen_awareness] GetForegroundWindow failed: %s", exc)
        return "", ""


# ─────────────────────────────────────────────────────────────────────────────
# SCREEN CAPTURE HELPER (blocking — call via asyncio.to_thread)
# ─────────────────────────────────────────────────────────────────────────────

def _capture_screen_b64() -> str:
    """Capture primary monitor, downscale, return base64 JPEG. Blocking."""
    import base64
    import io
    import mss
    from PIL import Image

    with mss.mss() as sct:
        monitor = sct.monitors[1]  # primary monitor only
        raw = sct.grab(monitor)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

    if img.width > _VISION_MAX_WIDTH:
        ratio = _VISION_MAX_WIDTH / img.width
        img = img.resize((_VISION_MAX_WIDTH, int(img.height * ratio)), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=_VISION_JPEG_QUALITY)
    return base64.b64encode(buf.getvalue()).decode()


# ─────────────────────────────────────────────────────────────────────────────
# BROWSER HISTORY READER (blocking — call via asyncio.to_thread)
# ─────────────────────────────────────────────────────────────────────────────

def _read_chromium_history(
    last_visit_time: int | None,
) -> tuple[list[dict], int | None]:
    """
    Read recent visits from Chrome and Edge History DBs.
    Returns (visits_list, new_high_water_mark).
    Blocking — call via asyncio.to_thread().
    """
    import shutil
    import sqlite3
    import tempfile

    visits: list[dict] = []
    high_water = last_visit_time or 0

    for db_path in (_CHROME_HISTORY, _EDGE_HISTORY):
        if not db_path.exists():
            continue
        tmp_path = None
        try:
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=".db")
            os.close(tmp_fd)
            shutil.copy2(db_path, tmp_path)
            conn = sqlite3.connect(tmp_path)
            cutoff = last_visit_time or 0
            rows = conn.execute(
                "SELECT url, title, last_visit_time FROM urls "
                "WHERE last_visit_time > ? ORDER BY last_visit_time DESC LIMIT 20",
                (cutoff,),
            ).fetchall()
            conn.close()
            for url, title, ts in rows:
                if any(p in url.lower() for p in _BROWSER_PRIVACY_FILTER):
                    continue
                visits.append({"url": url, "title": title or "", "visit_time": ts})
                high_water = max(high_water, ts)
        except Exception as exc:
            logger.debug("[screen_awareness] Browser history read error: %s", exc)
        finally:
            if tmp_path:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    return visits, high_water if high_water > (last_visit_time or 0) else last_visit_time


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_instance: "ScreenAwarenessService | None" = None


def init_screen_awareness() -> "ScreenAwarenessService":
    global _instance
    _instance = ScreenAwarenessService()
    return _instance


def get_screen_awareness() -> "ScreenAwarenessService | None":
    return _instance


def get_current_context() -> WindowContext:
    """Return the current window context for prompt injection. Safe if not initialized."""
    if _instance is None:
        return WindowContext()
    return _instance.current_context


# ─────────────────────────────────────────────────────────────────────────────
# SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class ScreenAwarenessService:
    """
    Background service that monitors the active window and proactively
    surfaces relevant files on AURA's canvas.
    """

    def __init__(self) -> None:
        self.current_context:   WindowContext = WindowContext()
        self._last_search_ctx:  WindowContext = WindowContext()
        self._last_emit_at:     float = 0.0
        self._last_search_at:   float = 0.0
        self._task: Optional[asyncio.Task] = None

        # Vision capture state (Phase B)
        self._last_vision_at:      float = 0.0
        self._last_vision_summary: str   = ""
        self._vision_busy:         bool  = False

        # Browser history state (Phase C)
        self._last_browser_at:         float      = 0.0
        self._last_browser_visit_time: int | None = None
        self._recent_browser_history:  list[dict] = []

        logger.info("[screen_awareness] ScreenAwarenessService created")

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def start(self) -> asyncio.Task:
        """Start the background poll loop. Returns the task."""
        self._task = asyncio.create_task(self._poll_loop(), name="screen_awareness")
        logger.info("[screen_awareness] Background poll started (interval=%.1fs)", POLL_INTERVAL_S)
        return self._task

    def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            logger.info("[screen_awareness] Poll task cancelled")

    # ── Main loop ─────────────────────────────────────────────────────────────

    async def _poll_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(POLL_INTERVAL_S)
                await self._tick()
                await self._vision_tick()
                await self._browser_tick()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("[screen_awareness] tick error: %s", exc)

    async def _tick(self) -> None:
        """One poll cycle — get window title, maybe trigger search + emit."""
        from app.controller.chat_controller import _runtime_state  # type: ignore

        mode = _runtime_state.get("operating_mode", "proactive")
        if mode == "quiet":
            return  # completely dormant in quiet mode

        raw_title, proc_name = await asyncio.to_thread(_get_foreground_info)
        if not raw_title:
            return
        # Only fire for known work apps — ignore system chrome (Snipping Tool, Task Manager, etc.)
        if proc_name.lower() not in _PROC_HINT:
            return

        topic    = _clean_title(raw_title)
        app_hint = _PROC_HINT.get(proc_name, "")

        ctx = WindowContext(
            raw_title   = raw_title,
            topic       = topic,
            app_name    = proc_name,
            app_hint    = app_hint,
            captured_at = time.time(),
        )
        self.current_context = ctx

        # Only emit/search in proactive mode when context changed
        if mode != "proactive":
            return
        if not ctx.is_meaningful():
            return
        if not ctx.differs_from(self._last_search_ctx):
            return
        if time.time() - self._last_search_at < SEARCH_COOLDOWN_S:
            return

        # Meaningful context change — trigger search
        await self._on_context_change(ctx)

    # ── Vision capture ─────────────────────────────────────────────────────────

    async def _vision_tick(self) -> None:
        """Periodic screenshot + vision analysis via workhorse model. Self-throttled."""
        from app.controller.chat_controller import _runtime_state  # type: ignore

        mode = _runtime_state.get("operating_mode", "proactive")
        if mode == "quiet":
            return
        interval = _VISION_INTERVAL_S if mode == "proactive" else _VISION_INTERVAL_AMBIENT_S
        if time.time() - self._last_vision_at < interval:
            return
        if _runtime_state.get("interface_busy") or self._vision_busy:
            return

        self._vision_busy = True
        try:
            img_b64 = await asyncio.to_thread(_capture_screen_b64)

            from app.service.ollama_service import get_workhorse_service
            wh = get_workhorse_service()
            if wh is None:
                return
            summary = await wh.chat_with_image(_VISION_PROMPT, img_b64)
            self._last_vision_summary = summary.strip()
            self._last_vision_at = time.time()

            # Persist to memory
            try:
                from app.service.memory_service import get_memory_service
                mem = get_memory_service()
                if mem:
                    asyncio.create_task(mem.record(
                        "interface",
                        f"Screen activity: {self._last_vision_summary}",
                        "activity",
                        metadata={"source": "screen_vision"},
                    ))
            except Exception:
                pass

            # Emit SSE event
            try:
                from app.controller.chat_controller import _emit  # type: ignore
                await _emit("activity_vision", {
                    "summary": self._last_vision_summary,
                    "timestamp": time.time(),
                })
            except Exception:
                pass

            logger.debug(
                "[screen_awareness] Vision tick: %s",
                self._last_vision_summary[:80],
            )
        except Exception as exc:
            logger.debug("[screen_awareness] Vision tick error: %s", exc)
        finally:
            self._vision_busy = False

    # ── Browser history polling ───────────────────────────────────────────────

    async def _browser_tick(self) -> None:
        """Poll browser history for new visits. Self-throttled to 60s."""
        if time.time() - self._last_browser_at < _BROWSER_POLL_INTERVAL_S:
            return

        from app.controller.chat_controller import _runtime_state  # type: ignore
        mode = _runtime_state.get("operating_mode", "proactive")
        if mode == "quiet":
            return

        self._last_browser_at = time.time()

        try:
            new_visits, new_hwm = await asyncio.to_thread(
                _read_chromium_history, self._last_browser_visit_time
            )
        except Exception as exc:
            logger.debug("[screen_awareness] Browser tick error: %s", exc)
            return

        if new_hwm is not None:
            self._last_browser_visit_time = new_hwm

        if not new_visits:
            return

        self._recent_browser_history = new_visits[:10]

        # Persist to memory
        try:
            from app.service.memory_service import get_memory_service
            mem = get_memory_service()
            if mem:
                summary = "; ".join(
                    f"{v['title']} ({v['url'][:60]})" for v in new_visits[:5]
                )
                asyncio.create_task(mem.record(
                    "interface",
                    f"Browser activity: {summary}",
                    "activity",
                    metadata={"source": "browser_activity"},
                ))
        except Exception:
            pass

        # Emit SSE event
        try:
            from app.controller.chat_controller import _emit  # type: ignore
            await _emit("activity_browser", {
                "visits": new_visits[:5],
                "timestamp": time.time(),
            })
        except Exception:
            pass

        logger.debug("[screen_awareness] Browser tick: %d new visits", len(new_visits))

    # ── Context change handler ─────────────────────────────────────────────────

    async def _on_context_change(self, ctx: WindowContext) -> None:
        """Search for related files and emit them to canvas."""
        self._last_search_ctx = ctx
        self._last_search_at  = time.time()

        try:
            from app.service.file_index_service import search_files
        except ImportError:
            logger.debug("[screen_awareness] file_index_service not available")
            return

        try:
            files = await search_files(ctx.search_query, max_results=6)
        except Exception as exc:
            logger.debug("[screen_awareness] file search error: %s", exc)
            return

        if not files:
            logger.debug("[screen_awareness] no files for context: %r", ctx.topic)
            return

        # Debounce canvas emits
        now = time.time()
        if now - self._last_emit_at < EMIT_DEBOUNCE_S:
            return
        self._last_emit_at = now

        await self._emit_file_canvas(ctx, files)

    # ── Canvas emit ───────────────────────────────────────────────────────────

    async def _emit_file_canvas(self, ctx: WindowContext, files: list) -> None:
        """Push a compact file standby card to the canvas."""
        try:
            from app.controller.chat_controller import _emit  # type: ignore
        except ImportError:
            return

        cards = []
        for f in files:
            d = f.to_dict() if hasattr(f, "to_dict") else f
            icon = _ext_icon(d.get("type", ""))
            drive_id = d.get("drive_id", "")
            local_path = d.get("path", "")
            # Build a clickable URL: Drive files → Drive viewer, local files → file:// URI
            url = ""
            if drive_id:
                url = f"https://drive.google.com/file/d/{drive_id}/view"
            elif local_path:
                url = f"file:///{local_path.replace(chr(92), '/')}"
            cards.append({
                "title":    d.get("name", ""),
                "subtitle": f"{d.get('source', '')} · {d.get('type', '')} · {d.get('modified', '')}",
                "icon":     icon,
                "url":      url,
                "meta":     {"path": local_path, "drive_id": drive_id},
            })

        app_label = _app_display_name(ctx.app_name)
        title = f"Files — {ctx.topic}" if not app_label else f"{app_label}: {ctx.topic}"

        await _emit("render_canvas", {
            "title":  title,
            "source": "screen_awareness",
            "blocks": [{
                "type": "card-list",
                "data": {
                    "cards":   cards,
                    "caption": f"Files related to your current task · {len(files)} found",
                },
            }],
        })
        logger.info(
            "[screen_awareness] canvas update — context=%r files=%d",
            ctx.topic, len(files),
        )

    # ── Public helpers ─────────────────────────────────────────────────────────

    def context_for_prompt(self) -> str:
        """
        Multi-line context string for system prompt injection.
        Includes active window, vision summary, browser activity, and file changes.
        Empty string if nothing meaningful to report.
        """
        parts: list[str] = []

        # Active window (existing)
        ctx = self.current_context
        if ctx.is_meaningful():
            app_label = _app_display_name(ctx.app_name)
            hint = f" ({app_label})" if app_label else ""
            parts.append(f"Active window: {ctx.topic}{hint}")

        # Vision summary
        if self._last_vision_summary:
            parts.append(f"Screen shows: {self._last_vision_summary}")

        # Recent browser activity
        if self._recent_browser_history:
            recent = self._recent_browser_history[0]
            parts.append(f"Recent browser: {recent['title']} ({recent['url'][:60]})")

        # Recent file activity (from file_monitor_service)
        try:
            from app.service.file_monitor_service import get_file_monitor
            fm = get_file_monitor()
            if fm and fm.last_event:
                parts.append(f"Recent file: {fm.last_event['name']} ({fm.last_event['event']})")
        except Exception:
            pass

        return "\n".join(parts) if parts else ""


# ─────────────────────────────────────────────────────────────────────────────
# FORMATTING HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _ext_icon(ext: str) -> str:
    """Return a short type label for a file extension (used as icon hint in canvas)."""
    icons = {
        "docx": "doc", "doc": "doc",
        "xlsx": "sheet", "xls": "sheet", "csv": "sheet",
        "pdf":  "pdf",
        "pptx": "slides", "ppt": "slides",
        "gdoc": "doc", "gsheet": "sheet", "gslide": "slides",
        "py":   "code", "js": "code", "ts": "code",
        "jsx":  "code", "tsx": "code",
        "html": "web",  "css": "style",
        "txt":  "text", "md": "text",
        "zip":  "archive",
    }
    return icons.get(ext.lower(), "file")


def _app_display_name(proc_name: str) -> str:
    """Convert a process name to a human-readable label."""
    names = {
        "winword.exe":   "Word",
        "excel.exe":     "Excel",
        "powerpnt.exe":  "PowerPoint",
        "code.exe":      "VS Code",
        "pycharm64.exe": "PyCharm",
        "chrome.exe":    "Chrome",
        "firefox.exe":   "Firefox",
        "msedge.exe":    "Edge",
        "acrobat.exe":   "Acrobat",
        "outlook.exe":   "Outlook",
    }
    return names.get(proc_name.lower(), "")
