"""
AURA NX-Alpha — Computer Use Service

Low-level computer control: mouse, keyboard, window management, screenshots,
app launching, and UIAutomation element interaction.

All Win32, pyautogui, and uiautomation calls are blocking — they run via
asyncio.to_thread() to avoid blocking the event loop.  Nothing in this module
loads an LLM or calls Ollama.

GRACEFUL DEGRADATION:
    Each capability group has a boolean availability flag.  If the required
    package is missing, the method returns an error dict instead of raising.

        _pyautogui_ok      — mouse / keyboard simulation (pyautogui)
        _win32_ok          — window enumeration / focus / launch (pywin32)
        _uiautomation_ok   — UI element finding / clicking (uiautomation)

SINGLETON:
    init_computer_use()   — create instance and check availability
    get_computer_use()    — get instance (None if not yet initialised)
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

_IS_WINDOWS = sys.platform == "win32"

# ── Windows subprocess no-window flag (same constant as process_manager.py) ───
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if _IS_WINDOWS else 0

# ── UIAutomation element result cache ─────────────────────────────────────────
# Key: (hwnd, name, control_type, automation_id)  →  (expiry_ts, result_list)
_element_cache: dict[tuple, tuple[float, list]] = {}
_ELEMENT_CACHE_TTL = 5.0   # seconds

# ── Singleton ─────────────────────────────────────────────────────────────────
_instance: "ComputerUseService | None" = None


def init_computer_use() -> "ComputerUseService":
    """Instantiate and register the global ComputerUseService singleton."""
    global _instance
    _instance = ComputerUseService()
    _instance._check_availability()
    return _instance


def get_computer_use() -> "ComputerUseService | None":
    """Return the global singleton, or None if not yet initialised."""
    return _instance


# ── Module-level screenshot helper ────────────────────────────────────────────
# Shared with screen_awareness_service to avoid duplication.

def capture_region_b64(
    monitor_index: int = 1,
    region: Optional[dict] = None,
    max_width: int = 1280,
    jpeg_quality: int = 70,
) -> dict:
    """
    Capture a screen region and return a base64 JPEG dict.

    Parameters
    ----------
    monitor_index : int
        1 = primary monitor, 0 = all monitors combined.
    region : dict, optional
        {"left": int, "top": int, "width": int, "height": int}.
        If None, captures the full monitor.
    max_width : int
        Downscale if wider than this.
    jpeg_quality : int
        JPEG quality 1–95.

    Returns
    -------
    dict
        {"b64": str, "width": int, "height": int, "timestamp": float}
    """
    import mss
    from PIL import Image

    with mss.mss() as sct:
        if region:
            mon = {
                "left":   region.get("left", 0),
                "top":    region.get("top", 0),
                "width":  region.get("width", 1920),
                "height": region.get("height", 1080),
            }
        else:
            monitors = sct.monitors
            idx = min(monitor_index, len(monitors) - 1)
            mon = monitors[idx]
        raw = sct.grab(mon)
        img = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")

    if img.width > max_width:
        ratio = max_width / img.width
        img = img.resize((max_width, int(img.height * ratio)), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=jpeg_quality)
    b64 = base64.b64encode(buf.getvalue()).decode()
    return {"b64": b64, "width": img.width, "height": img.height, "timestamp": time.time()}


# ── Service ────────────────────────────────────────────────────────────────────

class ComputerUseService:
    """
    Low-level computer control: screenshots, mouse, keyboard, windows, UIAutomation.

    Never instantiate directly — use init_computer_use() / get_computer_use().
    """

    def __init__(self) -> None:
        self._pyautogui_ok:    bool = False
        self._win32_ok:        bool = False
        self._uiautomation_ok: bool = False
        self._screen_size:     tuple[int, int] = (1920, 1080)  # updated at init

    # ── Availability check ────────────────────────────────────────────────────

    def _check_availability(self) -> None:
        """Attempt guarded imports and set availability flags."""
        # pyautogui — mouse / keyboard
        try:
            import pyautogui  # noqa: F401
            import pyautogui as _pag
            _pag.FAILSAFE = True   # move mouse to (0,0) to abort
            _pag.PAUSE = 0.05      # small inter-action pause
            w, h = _pag.size()
            self._screen_size = (int(w), int(h))
            self._pyautogui_ok = True
            logger.info("[computer_use] pyautogui available (%dx%d)", w, h)
        except ImportError:
            logger.warning("[computer_use] pyautogui not installed — mouse/keyboard unavailable")
        except Exception as exc:
            logger.warning("[computer_use] pyautogui init failed: %s", exc)

        # win32 — window management / app launch
        try:
            import win32gui    # noqa: F401
            import win32con    # noqa: F401
            import win32api    # noqa: F401
            import win32process  # noqa: F401
            import psutil       # noqa: F401
            self._win32_ok = True
            logger.info("[computer_use] win32 available")
        except ImportError:
            logger.warning("[computer_use] pywin32 not installed — window management unavailable")
        except Exception as exc:
            logger.warning("[computer_use] win32 init failed: %s", exc)

        # uiautomation — UI element interaction
        try:
            import uiautomation  # noqa: F401
            self._uiautomation_ok = True
            logger.info("[computer_use] uiautomation available")
        except ImportError:
            logger.warning("[computer_use] uiautomation not installed — UI element interaction unavailable")
        except Exception as exc:
            logger.warning("[computer_use] uiautomation init failed: %s", exc)

    def availability(self) -> dict:
        """Return the availability flags as a dict for boot reporting."""
        return {
            "pyautogui":    self._pyautogui_ok,
            "win32":        self._win32_ok,
            "uiautomation": self._uiautomation_ok,
            "screen_size":  self._screen_size,
        }

    # ── Screenshot ────────────────────────────────────────────────────────────

    async def screenshot(
        self,
        monitor: int = 1,
        region: Optional[dict] = None,
        max_width: int = 1280,
        quality: int = 70,
    ) -> dict:
        """
        Take a screenshot.

        Parameters
        ----------
        monitor : int
            1 = primary, 0 = all monitors combined.
        region : dict, optional
            {"left", "top", "width", "height"} for a targeted region.

        Returns
        -------
        dict
            {"b64": str, "width": int, "height": int, "timestamp": float}
        """
        try:
            return await asyncio.to_thread(
                capture_region_b64, monitor, region, max_width, quality
            )
        except Exception as exc:
            logger.debug("[computer_use] Screenshot failed: %s", exc)
            return {"error": str(exc)}

    # ── Window management ─────────────────────────────────────────────────────

    async def list_windows(self) -> list[dict]:
        """Return all visible windows with metadata."""
        if not self._win32_ok:
            return [{"error": "pywin32 not available — run: pip install pywin32"}]
        return await asyncio.to_thread(self._list_windows_sync)

    def _list_windows_sync(self) -> list[dict]:
        import win32gui
        import win32con
        import win32process
        import psutil

        windows: list[dict] = []

        def _enum(hwnd, _):
            if not win32gui.IsWindowVisible(hwnd):
                return
            title = win32gui.GetWindowText(hwnd)
            if not title.strip():
                return
            rect = win32gui.GetWindowRect(hwnd)
            placement = win32gui.GetWindowPlacement(hwnd)
            is_minimized = placement[1] == win32con.SW_SHOWMINIMIZED
            is_maximized = placement[1] == win32con.SW_SHOWMAXIMIZED
            try:
                _, pid = win32process.GetWindowThreadProcessId(hwnd)
                exe = psutil.Process(pid).name()
            except Exception:
                pid, exe = 0, ""
            windows.append({
                "hwnd": hwnd,
                "title": title,
                "pid": pid,
                "exe": exe,
                "rect": list(rect),   # [left, top, right, bottom]
                "minimized": is_minimized,
                "maximized": is_maximized,
            })

        win32gui.EnumWindows(_enum, None)
        return windows

    async def focus_window(self, hwnd: int) -> dict:
        """Bring a window to the foreground."""
        if not self._win32_ok:
            return {"error": "pywin32 not available"}
        return await asyncio.to_thread(self._focus_window_sync, hwnd)

    def _focus_window_sync(self, hwnd: int) -> dict:
        import win32gui
        import win32con
        try:
            placement = win32gui.GetWindowPlacement(hwnd)
            if placement[1] == win32con.SW_SHOWMINIMIZED:
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            win32gui.SetForegroundWindow(hwnd)
            return {"focused": True, "hwnd": hwnd}
        except Exception as exc:
            return {"error": str(exc), "hwnd": hwnd}

    async def minimize_window(self, hwnd: int) -> dict:
        if not self._win32_ok:
            return {"error": "pywin32 not available"}
        return await asyncio.to_thread(self._window_action_sync, hwnd, "minimize")

    async def maximize_window(self, hwnd: int) -> dict:
        if not self._win32_ok:
            return {"error": "pywin32 not available"}
        return await asyncio.to_thread(self._window_action_sync, hwnd, "maximize")

    async def restore_window(self, hwnd: int) -> dict:
        if not self._win32_ok:
            return {"error": "pywin32 not available"}
        return await asyncio.to_thread(self._window_action_sync, hwnd, "restore")

    async def close_window(self, hwnd: int) -> dict:
        if not self._win32_ok:
            return {"error": "pywin32 not available"}
        return await asyncio.to_thread(self._window_action_sync, hwnd, "close")

    async def resize_window(self, hwnd: int, x: int, y: int, width: int, height: int) -> dict:
        if not self._win32_ok:
            return {"error": "pywin32 not available"}
        return await asyncio.to_thread(self._resize_window_sync, hwnd, x, y, width, height)

    def _window_action_sync(self, hwnd: int, action: str) -> dict:
        import win32gui
        import win32con
        try:
            cmd_map = {
                "minimize": win32con.SW_MINIMIZE,
                "maximize": win32con.SW_MAXIMIZE,
                "restore":  win32con.SW_RESTORE,
            }
            if action == "close":
                win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
            else:
                win32gui.ShowWindow(hwnd, cmd_map[action])
            return {"action": action, "hwnd": hwnd, "ok": True}
        except Exception as exc:
            return {"error": str(exc), "hwnd": hwnd}

    def _resize_window_sync(self, hwnd: int, x: int, y: int, width: int, height: int) -> dict:
        import win32gui
        try:
            win32gui.MoveWindow(hwnd, x, y, width, height, True)
            return {"hwnd": hwnd, "x": x, "y": y, "width": width, "height": height, "ok": True}
        except Exception as exc:
            return {"error": str(exc), "hwnd": hwnd}

    # ── App launching ─────────────────────────────────────────────────────────

    async def launch_app(self, path_or_name: str, args: list[str] | None = None) -> dict:
        """
        Launch an application.

        - Absolute paths / .exe names → subprocess.Popen with CREATE_NO_WINDOW
        - Anything else → ShellExecute (handles file associations, URLs, etc.)
        """
        args = args or []
        return await asyncio.to_thread(self._launch_app_sync, path_or_name, args)

    def _launch_app_sync(self, path_or_name: str, args: list[str]) -> dict:
        p = path_or_name.strip()
        # Use Popen for explicit executables
        if p.lower().endswith(".exe") or Path(p).is_absolute():
            try:
                proc = subprocess.Popen(
                    [p] + args,
                    creationflags=_NO_WINDOW,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                return {"launched": True, "pid": proc.pid, "method": "popen", "path": p}
            except FileNotFoundError:
                return {"launched": False, "error": f"Not found: {p}"}
            except Exception as exc:
                return {"launched": False, "error": str(exc)}

        # ShellExecute for everything else
        if _IS_WINDOWS:
            try:
                import win32api
                win32api.ShellExecute(0, "open", p, " ".join(args) if args else None, None, 1)
                return {"launched": True, "method": "shell_execute", "path": p}
            except Exception as exc:
                return {"launched": False, "error": str(exc)}

        # Linux/macOS fallback
        try:
            proc = subprocess.Popen(
                [p] + args,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return {"launched": True, "pid": proc.pid, "method": "popen", "path": p}
        except Exception as exc:
            return {"launched": False, "error": str(exc)}

    # ── Mouse ──────────────────────────────────────────────────────────────────

    def _check_safe_bounds(self, x: int, y: int) -> Optional[str]:
        """Return error string if coordinates are outside the screen, else None."""
        w, h = self._screen_size
        if not (0 <= x <= w and 0 <= y <= h):
            return f"Coordinates ({x}, {y}) out of screen bounds ({w}x{h})"
        return None

    async def mouse_move(self, x: int, y: int, duration: float = 0.2) -> dict:
        if not self._pyautogui_ok:
            return {"error": "pyautogui not available — run: pip install pyautogui"}
        if (err := self._check_safe_bounds(x, y)):
            return {"error": err}
        return await asyncio.to_thread(self._mouse_move_sync, x, y, duration)

    def _mouse_move_sync(self, x: int, y: int, duration: float) -> dict:
        import pyautogui
        pyautogui.moveTo(x, y, duration=duration)
        return {"moved": True, "x": x, "y": y}

    async def mouse_click(
        self,
        x: int,
        y: int,
        button: str = "left",
        double: bool = False,
    ) -> dict:
        if not self._pyautogui_ok:
            return {"error": "pyautogui not available — run: pip install pyautogui"}
        if (err := self._check_safe_bounds(x, y)):
            return {"error": err}
        return await asyncio.to_thread(self._mouse_click_sync, x, y, button, double)

    def _mouse_click_sync(self, x: int, y: int, button: str, double: bool) -> dict:
        import pyautogui
        if double:
            pyautogui.doubleClick(x, y, button=button)
        else:
            pyautogui.click(x, y, button=button)
        return {"clicked": True, "x": x, "y": y, "button": button, "double": double}

    async def mouse_right_click(self, x: int, y: int) -> dict:
        return await self.mouse_click(x, y, button="right")

    async def mouse_scroll(self, x: int, y: int, clicks: int, direction: str = "down") -> dict:
        if not self._pyautogui_ok:
            return {"error": "pyautogui not available — run: pip install pyautogui"}
        if (err := self._check_safe_bounds(x, y)):
            return {"error": err}
        return await asyncio.to_thread(self._mouse_scroll_sync, x, y, clicks, direction)

    def _mouse_scroll_sync(self, x: int, y: int, clicks: int, direction: str) -> dict:
        import pyautogui
        amount = clicks if direction == "up" else -clicks
        pyautogui.scroll(amount, x=x, y=y)
        return {"scrolled": True, "x": x, "y": y, "clicks": clicks, "direction": direction}

    async def mouse_drag(
        self, x1: int, y1: int, x2: int, y2: int, duration: float = 0.3
    ) -> dict:
        if not self._pyautogui_ok:
            return {"error": "pyautogui not available — run: pip install pyautogui"}
        for x, y in ((x1, y1), (x2, y2)):
            if (err := self._check_safe_bounds(x, y)):
                return {"error": err}
        return await asyncio.to_thread(self._mouse_drag_sync, x1, y1, x2, y2, duration)

    def _mouse_drag_sync(self, x1, y1, x2, y2, duration) -> dict:
        import pyautogui
        pyautogui.moveTo(x1, y1, duration=0.1)
        pyautogui.dragTo(x2, y2, duration=duration, button="left")
        return {"dragged": True, "from": [x1, y1], "to": [x2, y2]}

    # ── Keyboard ──────────────────────────────────────────────────────────────

    async def keyboard_type(self, text: str, interval: float = 0.02) -> dict:
        """Type text at the current cursor position."""
        if not self._pyautogui_ok:
            return {"error": "pyautogui not available — run: pip install pyautogui"}
        return await asyncio.to_thread(self._keyboard_type_sync, text, interval)

    def _keyboard_type_sync(self, text: str, interval: float) -> dict:
        import pyautogui
        # Use clipboard paste for non-ASCII text to avoid encoding issues
        printable_ascii = all(0x20 <= ord(c) < 0x7F for c in text)
        if printable_ascii:
            pyautogui.typewrite(text, interval=interval)
        else:
            # Paste via clipboard for Unicode
            import subprocess as _sp
            _sp.run(
                ["clip"],
                input=text.encode("utf-16"),
                creationflags=_NO_WINDOW,
            )
            pyautogui.hotkey("ctrl", "v")
        return {"typed": True, "length": len(text)}

    async def keyboard_hotkey(self, *keys: str) -> dict:
        """Press a key combination, e.g. keyboard_hotkey('ctrl', 'c')."""
        if not self._pyautogui_ok:
            return {"error": "pyautogui not available — run: pip install pyautogui"}
        return await asyncio.to_thread(self._keyboard_hotkey_sync, list(keys))

    def _keyboard_hotkey_sync(self, keys: list[str]) -> dict:
        import pyautogui
        pyautogui.hotkey(*keys)
        return {"hotkey": True, "keys": keys}

    async def keyboard_press(self, key: str) -> dict:
        """Press a single key by name (e.g. 'enter', 'tab', 'escape')."""
        if not self._pyautogui_ok:
            return {"error": "pyautogui not available — run: pip install pyautogui"}
        return await asyncio.to_thread(self._keyboard_press_sync, key)

    def _keyboard_press_sync(self, key: str) -> dict:
        import pyautogui
        pyautogui.press(key)
        return {"pressed": True, "key": key}

    async def keyboard_hold(self, key: str, duration: float = 0.5) -> dict:
        """Hold a key for a specified duration."""
        if not self._pyautogui_ok:
            return {"error": "pyautogui not available — run: pip install pyautogui"}
        return await asyncio.to_thread(self._keyboard_hold_sync, key, duration)

    def _keyboard_hold_sync(self, key: str, duration: float) -> dict:
        import pyautogui
        pyautogui.keyDown(key)
        time.sleep(duration)
        pyautogui.keyUp(key)
        return {"held": True, "key": key, "duration": duration}

    # ── UIAutomation element interaction ──────────────────────────────────────

    async def find_elements(
        self,
        hwnd: int,
        name: str = "",
        control_type: str = "",
        automation_id: str = "",
    ) -> list[dict]:
        """
        Find UI elements in a window using Windows UIAutomation.

        Results are cached for 5 seconds per (hwnd, name, control_type, automation_id).
        """
        if not self._uiautomation_ok:
            return [{"error": "uiautomation not available — run: pip install uiautomation"}]

        cache_key = (hwnd, name, control_type, automation_id)
        cached = _element_cache.get(cache_key)
        if cached and time.time() < cached[0]:
            return cached[1]

        result = await asyncio.to_thread(
            self._find_elements_sync, hwnd, name, control_type, automation_id
        )
        _element_cache[cache_key] = (time.time() + _ELEMENT_CACHE_TTL, result)
        return result

    def _find_elements_sync(
        self,
        hwnd: int,
        name: str,
        control_type: str,
        automation_id: str,
    ) -> list[dict]:
        import uiautomation as auto

        try:
            root = auto.ControlFromHandle(hwnd)
        except Exception as exc:
            return [{"error": f"Could not get window control: {exc}"}]

        try:
            all_controls = root.GetChildren()
            # Flatten by walking descendants up to depth 8
            stack, visited = list(all_controls), []
            depth_limit = 8
            seen: set[int] = set()

            def _walk(ctrl, depth=0):
                try:
                    cid = id(ctrl)
                    if cid in seen or depth > depth_limit:
                        return
                    seen.add(cid)
                    elem = {
                        "name":           ctrl.Name or "",
                        "control_type":   ctrl.ControlTypeName or "",
                        "automation_id":  ctrl.AutomationId or "",
                        "rect":           list(ctrl.BoundingRectangle),
                        "is_enabled":     ctrl.IsEnabled,
                        "is_offscreen":   ctrl.IsOffscreen,
                    }
                    match = True
                    if name and name.lower() not in elem["name"].lower():
                        match = False
                    if control_type and control_type.lower() not in elem["control_type"].lower():
                        match = False
                    if automation_id and automation_id.lower() not in elem["automation_id"].lower():
                        match = False
                    if match and (elem["name"] or elem["automation_id"]):
                        visited.append(elem)
                    for child in ctrl.GetChildren():
                        _walk(child, depth + 1)
                except Exception:
                    pass

            for ctrl in all_controls:
                _walk(ctrl)

            return visited[:50]   # cap at 50 to avoid overwhelming the agent

        except Exception as exc:
            return [{"error": f"Element search failed: {exc}"}]

    async def click_element(
        self,
        hwnd: int,
        automation_id: str = "",
        name: str = "",
    ) -> dict:
        """Click a UI element by automation_id or name."""
        if not self._uiautomation_ok:
            return {"error": "uiautomation not available — run: pip install uiautomation"}
        return await asyncio.to_thread(
            self._click_element_sync, hwnd, automation_id, name
        )

    def _click_element_sync(self, hwnd: int, automation_id: str, name: str) -> dict:
        import uiautomation as auto

        try:
            root = auto.ControlFromHandle(hwnd)
            ctrl = None

            if automation_id:
                ctrl = root.Control(AutomationId=automation_id)
            elif name:
                ctrl = root.Control(Name=name)

            if ctrl is None or not ctrl.Exists(0, 0):
                return {"error": f"Element not found (automation_id={automation_id!r}, name={name!r})"}

            ctrl.Click()
            return {"clicked": True, "name": ctrl.Name, "automation_id": ctrl.AutomationId}
        except Exception as exc:
            return {"error": str(exc)}

    async def get_element_value(self, hwnd: int, automation_id: str) -> dict:
        """Get the text/value of an edit control."""
        if not self._uiautomation_ok:
            return {"error": "uiautomation not available — run: pip install uiautomation"}
        return await asyncio.to_thread(self._get_element_value_sync, hwnd, automation_id)

    def _get_element_value_sync(self, hwnd: int, automation_id: str) -> dict:
        import uiautomation as auto
        try:
            root  = auto.ControlFromHandle(hwnd)
            ctrl  = root.Control(AutomationId=automation_id)
            if not ctrl.Exists(0, 0):
                return {"error": f"Element not found: {automation_id}"}
            pattern = ctrl.GetValuePattern()
            return {"value": pattern.Value, "automation_id": automation_id}
        except Exception as exc:
            return {"error": str(exc)}

    async def set_element_value(self, hwnd: int, automation_id: str, value: str) -> dict:
        """Set the value of an edit control."""
        if not self._uiautomation_ok:
            return {"error": "uiautomation not available — run: pip install uiautomation"}
        return await asyncio.to_thread(
            self._set_element_value_sync, hwnd, automation_id, value
        )

    def _set_element_value_sync(self, hwnd: int, automation_id: str, value: str) -> dict:
        import uiautomation as auto
        try:
            root    = auto.ControlFromHandle(hwnd)
            ctrl    = root.Control(AutomationId=automation_id)
            if not ctrl.Exists(0, 0):
                return {"error": f"Element not found: {automation_id}"}
            pattern = ctrl.GetValuePattern()
            pattern.SetValue(value)
            return {"set": True, "automation_id": automation_id, "value": value}
        except Exception as exc:
            return {"error": str(exc)}
