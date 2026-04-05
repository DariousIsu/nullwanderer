"""
AURA NX-Alpha — Computer Use Controller

REST endpoints for computer control, file system operations, and
destructive-action authorisation.

ENDPOINTS:
    POST /computer-use/screenshot           — capture screen
    GET  /computer-use/windows              — list open windows
    POST /computer-use/window/control       — focus/minimize/maximize/close/restore window
    POST /computer-use/mouse                — mouse action
    POST /computer-use/keyboard             — keyboard action
    POST /computer-use/launch               — launch application
    POST /computer-use/elements             — find UI elements in a window
    POST /computer-use/element/action       — click element or get/set value
    POST /computer-use/files                — file system operations
    POST /computer-use/authorize            — pre-authorise a destructive file op
    GET  /computer-use/availability         — service capability flags
"""

from __future__ import annotations

import logging
from typing import Any, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/computer-use", tags=["computer_use"])


# ── REQUEST MODELS ─────────────────────────────────────────────────────────────

class ScreenshotRequest(BaseModel):
    monitor:  int            = 1
    region:   Optional[dict] = None
    max_width: int           = 1280
    quality:  int            = 70


class WindowControlRequest(BaseModel):
    hwnd:   int
    action: str  # focus | minimize | maximize | restore | close


class ResizeWindowRequest(BaseModel):
    hwnd:   int
    x:      int = 0
    y:      int = 0
    width:  int = 800
    height: int = 600


class MouseRequest(BaseModel):
    action:    str
    x:         int   = 0
    y:         int   = 0
    button:    str   = "left"
    double:    bool  = False
    clicks:    int   = 3
    direction: str   = "down"
    duration:  float = 0.2
    x2:        int   = 0
    y2:        int   = 0


class KeyboardRequest(BaseModel):
    action:   str
    text:     str        = ""
    keys:     List[str]  = []
    key:      str        = ""
    duration: float      = 0.5


class LaunchRequest(BaseModel):
    path: str
    args: List[str] = []


class ElementSearchRequest(BaseModel):
    hwnd:          int
    name:          str = ""
    control_type:  str = ""
    automation_id: str = ""


class ElementActionRequest(BaseModel):
    hwnd:          int
    action:        str   # click | get_value | set_value
    automation_id: str = ""
    name:          str = ""
    value:         str = ""


class FileRequest(BaseModel):
    operation:   str
    path:        str        = ""
    destination: str        = ""
    content:     str        = ""
    old_text:    str        = ""
    new_text:    str        = ""
    query:       str        = ""
    root:        Optional[str] = None
    extensions:  Optional[List[str]] = None
    max_results: int        = 50
    depth:       int        = 1
    max_bytes:   int        = 500_000
    confirmed:   bool       = False
    op_id:       Optional[str] = None


class AuthorizeRequest(BaseModel):
    op_id: str


# ── HELPERS ────────────────────────────────────────────────────────────────────

def _get_cu():
    from app.service.computer_use_service import get_computer_use
    svc = get_computer_use()
    if svc is None:
        raise HTTPException(status_code=503, detail="Computer use service not ready")
    return svc


def _get_fs():
    from app.service.file_system_service import get_file_system
    svc = get_file_system()
    if svc is None:
        raise HTTPException(status_code=503, detail="File system service not ready")
    return svc


# ── ENDPOINTS ─────────────────────────────────────────────────────────────────

@router.get("/availability")
async def get_availability():
    """Return computer use service capability flags."""
    from app.service.computer_use_service import get_computer_use
    cu = get_computer_use()
    if cu is None:
        return {"available": False, "reason": "Service not initialised"}
    return {"available": True, **cu.availability()}


@router.post("/screenshot")
async def take_screenshot(req: ScreenshotRequest):
    """Capture a screenshot of the specified monitor or region."""
    cu = _get_cu()
    result = await cu.screenshot(
        monitor=req.monitor,
        region=req.region,
        max_width=req.max_width,
        quality=req.quality,
    )
    return result


@router.get("/windows")
async def list_windows():
    """List all visible windows with title, hwnd, pid, exe, and rect."""
    cu = _get_cu()
    windows = await cu.list_windows()
    return {"windows": windows}


@router.post("/window/control")
async def window_control(req: WindowControlRequest):
    """Focus, minimize, maximize, restore, or close a window by hwnd."""
    cu = _get_cu()
    action = req.action.lower()
    dispatch = {
        "focus":    cu.focus_window,
        "minimize": cu.minimize_window,
        "maximize": cu.maximize_window,
        "restore":  cu.restore_window,
        "close":    cu.close_window,
    }
    fn = dispatch.get(action)
    if fn is None:
        raise HTTPException(status_code=400, detail=f"Unknown action: {action!r}")
    return await fn(req.hwnd)


@router.post("/window/resize")
async def resize_window(req: ResizeWindowRequest):
    """Resize and reposition a window."""
    cu = _get_cu()
    return await cu.resize_window(req.hwnd, req.x, req.y, req.width, req.height)


@router.post("/mouse")
async def mouse_action(req: MouseRequest):
    """Perform a mouse action: move, click, right_click, scroll, or drag."""
    cu = _get_cu()
    action = req.action.lower()
    if action == "move":
        return await cu.mouse_move(req.x, req.y, duration=req.duration)
    if action == "click":
        return await cu.mouse_click(req.x, req.y, button=req.button, double=req.double)
    if action == "right_click":
        return await cu.mouse_right_click(req.x, req.y)
    if action == "scroll":
        return await cu.mouse_scroll(req.x, req.y, clicks=req.clicks, direction=req.direction)
    if action == "drag":
        return await cu.mouse_drag(req.x, req.y, req.x2, req.y2, duration=req.duration)
    raise HTTPException(status_code=400, detail=f"Unknown mouse action: {action!r}")


@router.post("/keyboard")
async def keyboard_action(req: KeyboardRequest):
    """Perform a keyboard action: type, hotkey, press, or hold."""
    cu = _get_cu()
    action = req.action.lower()
    if action == "type":
        if not req.text:
            raise HTTPException(status_code=400, detail="text is required for type")
        return await cu.keyboard_type(req.text)
    if action == "hotkey":
        if not req.keys:
            raise HTTPException(status_code=400, detail="keys is required for hotkey")
        return await cu.keyboard_hotkey(*req.keys)
    if action == "press":
        if not req.key:
            raise HTTPException(status_code=400, detail="key is required for press")
        return await cu.keyboard_press(req.key)
    if action == "hold":
        if not req.key:
            raise HTTPException(status_code=400, detail="key is required for hold")
        return await cu.keyboard_hold(req.key, duration=req.duration)
    raise HTTPException(status_code=400, detail=f"Unknown keyboard action: {action!r}")


@router.post("/launch")
async def launch_app(req: LaunchRequest):
    """Launch an application by path or name."""
    cu = _get_cu()
    return await cu.launch_app(req.path, args=req.args)


@router.post("/elements")
async def find_elements(req: ElementSearchRequest):
    """Find UI elements in a window using Windows UIAutomation."""
    cu = _get_cu()
    elements = await cu.find_elements(
        req.hwnd,
        name=req.name,
        control_type=req.control_type,
        automation_id=req.automation_id,
    )
    return {"elements": elements}


@router.post("/element/action")
async def element_action(req: ElementActionRequest):
    """Click an element or get/set its value."""
    cu = _get_cu()
    action = req.action.lower()
    if action == "click":
        return await cu.click_element(req.hwnd, automation_id=req.automation_id, name=req.name)
    if action == "get_value":
        return await cu.get_element_value(req.hwnd, req.automation_id)
    if action == "set_value":
        return await cu.set_element_value(req.hwnd, req.automation_id, req.value)
    raise HTTPException(status_code=400, detail=f"Unknown element action: {action!r}")


@router.post("/files")
async def file_operations(req: FileRequest):
    """
    Unified file system endpoint.
    Supported operations: list, read, write, edit, search, move, delete, copy, mkdir, info.
    """
    fs = _get_fs()
    op = req.operation.lower()

    if op == "list":
        if not req.path:
            raise HTTPException(status_code=400, detail="path is required for list")
        return fs.list_directory(req.path, depth=req.depth)

    if op == "read":
        if not req.path:
            raise HTTPException(status_code=400, detail="path is required for read")
        return fs.read_file(req.path, max_bytes=req.max_bytes)

    if op == "info":
        if not req.path:
            raise HTTPException(status_code=400, detail="path is required for info")
        return fs.get_file_info(req.path)

    if op == "search":
        if not req.query:
            raise HTTPException(status_code=400, detail="query is required for search")
        results = fs.search_files(
            query=req.query,
            root=req.root,
            extensions=req.extensions,
            max_results=req.max_results,
        )
        return {"results": results, "count": len(results)}

    if op == "mkdir":
        if not req.path:
            raise HTTPException(status_code=400, detail="path is required for mkdir")
        return fs.create_directory(req.path)

    if op == "copy":
        if not req.path or not req.destination:
            raise HTTPException(status_code=400, detail="path and destination are required for copy")
        return fs.copy_file(req.path, req.destination)

    if op == "write":
        if not req.path:
            raise HTTPException(status_code=400, detail="path is required for write")
        return await fs.write_file(req.path, req.content, confirmed=req.confirmed, op_id=req.op_id)

    if op == "edit":
        if not req.path or not req.old_text:
            raise HTTPException(status_code=400, detail="path and old_text are required for edit")
        return await fs.edit_file(req.path, req.old_text, req.new_text)

    if op == "move":
        if not req.path or not req.destination:
            raise HTTPException(status_code=400, detail="path and destination are required for move")
        return fs.move_file(req.path, req.destination, confirmed=req.confirmed, op_id=req.op_id)

    if op == "delete":
        if not req.path:
            raise HTTPException(status_code=400, detail="path is required for delete")
        return fs.delete_file(req.path, confirmed=req.confirmed, op_id=req.op_id)

    raise HTTPException(status_code=400, detail=f"Unknown operation: {op!r}")


@router.post("/authorize")
async def authorize_operation(req: AuthorizeRequest):
    """
    Pre-authorise a destructive file operation for 30 seconds.
    Called by the Electron confirmation dialog after the user clicks Allow.
    """
    fs = _get_fs()
    fs.authorize_operation(req.op_id)
    return {"authorized": True, "op_id": req.op_id, "expires_in_seconds": 30}
