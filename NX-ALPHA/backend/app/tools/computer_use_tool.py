"""
AURA NX-Alpha — Computer Use Tool

MCP/agent tool wrapper for ComputerUseService.
Provides screenshot capture, mouse/keyboard control, window management,
app launching, and UIAutomation element interaction.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "computer_use",
    "description": (
        "Control the local Windows computer: take screenshots, move/click/scroll the mouse, "
        "type and press keys, manage windows (list, focus, minimize, maximize, close, resize), "
        "launch applications, and find/interact with UI elements via the Windows Accessibility API."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": [
                    "screenshot",
                    "list_windows",
                    "focus_window",
                    "minimize_window",
                    "maximize_window",
                    "restore_window",
                    "close_window",
                    "resize_window",
                    "mouse_move",
                    "mouse_click",
                    "mouse_right_click",
                    "mouse_scroll",
                    "mouse_drag",
                    "keyboard_type",
                    "keyboard_hotkey",
                    "keyboard_press",
                    "keyboard_hold",
                    "launch_app",
                    "find_elements",
                    "click_element",
                    "get_element_value",
                    "set_element_value",
                ],
                "description": "The action to perform.",
            },
            # Screenshot params
            "monitor":      {"type": "integer", "default": 1, "description": "Monitor index (1=primary, 0=all)."},
            "region":       {"type": "object", "description": "Region: {left, top, width, height}"},
            # Window params
            "hwnd":         {"type": "integer", "description": "Window handle (from list_windows)."},
            "x":            {"type": "integer"},
            "y":            {"type": "integer"},
            "width":        {"type": "integer"},
            "height":       {"type": "integer"},
            # Mouse params
            "button":       {"type": "string", "enum": ["left", "right", "middle"], "default": "left"},
            "double":       {"type": "boolean", "default": False},
            "clicks":       {"type": "integer", "default": 3, "description": "Scroll wheel clicks."},
            "direction":    {"type": "string", "enum": ["up", "down"], "default": "down"},
            "duration":     {"type": "number", "default": 0.2, "description": "Movement duration in seconds."},
            "x2":           {"type": "integer", "description": "Drag end X."},
            "y2":           {"type": "integer", "description": "Drag end Y."},
            # Keyboard params
            "text":         {"type": "string", "description": "Text to type."},
            "keys":         {"type": "array", "items": {"type": "string"}, "description": "Keys for hotkey, e.g. ['ctrl','c']."},
            "key":          {"type": "string", "description": "Single key name (enter, tab, escape, etc.)."},
            # App launch params
            "path":         {"type": "string", "description": "Executable path or name to launch."},
            "args":         {"type": "array", "items": {"type": "string"}, "description": "Launch arguments."},
            # UIAutomation params
            "automation_id": {"type": "string", "description": "Element AutomationId."},
            "name":          {"type": "string", "description": "Element display name."},
            "control_type":  {"type": "string", "description": "Control type name (Button, Edit, etc.)."},
            "value":         {"type": "string", "description": "Value to set on an element."},
        },
        "required": ["action"],
    },
}


async def tool_handler(inputs: dict) -> Any:
    from app.service.computer_use_service import get_computer_use
    cu = get_computer_use()
    if cu is None:
        return {"error": "Computer use service not initialised — boot sequence may not be complete."}

    action = inputs.get("action", "")

    # ── Screenshot ────────────────────────────────────────────────────────────
    if action == "screenshot":
        return await cu.screenshot(
            monitor=inputs.get("monitor", 1),
            region=inputs.get("region"),
        )

    # ── Window listing ────────────────────────────────────────────────────────
    if action == "list_windows":
        return {"windows": await cu.list_windows()}

    # ── Window control ────────────────────────────────────────────────────────
    if action == "focus_window":
        hwnd = inputs.get("hwnd")
        if not hwnd:
            return {"error": "hwnd is required for focus_window"}
        return await cu.focus_window(int(hwnd))

    if action == "minimize_window":
        hwnd = inputs.get("hwnd")
        if not hwnd:
            return {"error": "hwnd is required for minimize_window"}
        return await cu.minimize_window(int(hwnd))

    if action == "maximize_window":
        hwnd = inputs.get("hwnd")
        if not hwnd:
            return {"error": "hwnd is required for maximize_window"}
        return await cu.maximize_window(int(hwnd))

    if action == "restore_window":
        hwnd = inputs.get("hwnd")
        if not hwnd:
            return {"error": "hwnd is required for restore_window"}
        return await cu.restore_window(int(hwnd))

    if action == "close_window":
        hwnd = inputs.get("hwnd")
        if not hwnd:
            return {"error": "hwnd is required for close_window"}
        return await cu.close_window(int(hwnd))

    if action == "resize_window":
        hwnd = inputs.get("hwnd")
        if not hwnd:
            return {"error": "hwnd is required for resize_window"}
        return await cu.resize_window(
            int(hwnd),
            int(inputs.get("x", 0)),
            int(inputs.get("y", 0)),
            int(inputs.get("width", 800)),
            int(inputs.get("height", 600)),
        )

    # ── Mouse ─────────────────────────────────────────────────────────────────
    if action == "mouse_move":
        return await cu.mouse_move(
            int(inputs.get("x", 0)),
            int(inputs.get("y", 0)),
            duration=float(inputs.get("duration", 0.2)),
        )

    if action == "mouse_click":
        return await cu.mouse_click(
            int(inputs.get("x", 0)),
            int(inputs.get("y", 0)),
            button=inputs.get("button", "left"),
            double=bool(inputs.get("double", False)),
        )

    if action == "mouse_right_click":
        return await cu.mouse_right_click(
            int(inputs.get("x", 0)),
            int(inputs.get("y", 0)),
        )

    if action == "mouse_scroll":
        return await cu.mouse_scroll(
            int(inputs.get("x", 0)),
            int(inputs.get("y", 0)),
            clicks=int(inputs.get("clicks", 3)),
            direction=inputs.get("direction", "down"),
        )

    if action == "mouse_drag":
        return await cu.mouse_drag(
            int(inputs.get("x", 0)),
            int(inputs.get("y", 0)),
            int(inputs.get("x2", 0)),
            int(inputs.get("y2", 0)),
            duration=float(inputs.get("duration", 0.3)),
        )

    # ── Keyboard ──────────────────────────────────────────────────────────────
    if action == "keyboard_type":
        text = inputs.get("text", "")
        if not text:
            return {"error": "text is required for keyboard_type"}
        return await cu.keyboard_type(text)

    if action == "keyboard_hotkey":
        keys = inputs.get("keys", [])
        if not keys:
            return {"error": "keys is required for keyboard_hotkey (e.g. ['ctrl','c'])"}
        return await cu.keyboard_hotkey(*keys)

    if action == "keyboard_press":
        key = inputs.get("key", "")
        if not key:
            return {"error": "key is required for keyboard_press"}
        return await cu.keyboard_press(key)

    if action == "keyboard_hold":
        key = inputs.get("key", "")
        if not key:
            return {"error": "key is required for keyboard_hold"}
        return await cu.keyboard_hold(key, duration=float(inputs.get("duration", 0.5)))

    # ── App launch ────────────────────────────────────────────────────────────
    if action == "launch_app":
        path = inputs.get("path", "")
        if not path:
            return {"error": "path is required for launch_app"}
        return await cu.launch_app(path, args=inputs.get("args", []))

    # ── UIAutomation ──────────────────────────────────────────────────────────
    if action == "find_elements":
        hwnd = inputs.get("hwnd")
        if not hwnd:
            return {"error": "hwnd is required for find_elements"}
        elements = await cu.find_elements(
            int(hwnd),
            name=inputs.get("name", ""),
            control_type=inputs.get("control_type", ""),
            automation_id=inputs.get("automation_id", ""),
        )
        return {"elements": elements}

    if action == "click_element":
        hwnd = inputs.get("hwnd")
        if not hwnd:
            return {"error": "hwnd is required for click_element"}
        return await cu.click_element(
            int(hwnd),
            automation_id=inputs.get("automation_id", ""),
            name=inputs.get("name", ""),
        )

    if action == "get_element_value":
        hwnd = inputs.get("hwnd")
        automation_id = inputs.get("automation_id", "")
        if not hwnd or not automation_id:
            return {"error": "hwnd and automation_id are required for get_element_value"}
        return await cu.get_element_value(int(hwnd), automation_id)

    if action == "set_element_value":
        hwnd = inputs.get("hwnd")
        automation_id = inputs.get("automation_id", "")
        value = inputs.get("value", "")
        if not hwnd or not automation_id:
            return {"error": "hwnd and automation_id are required for set_element_value"}
        return await cu.set_element_value(int(hwnd), automation_id, value)

    return {"error": f"Unknown action: {action!r}"}
