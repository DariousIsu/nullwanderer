"""
File write and edit tools — extends the existing read_file capability.

Safety rules:
  - Paths must not contain '..' (directory traversal blocked)
  - file_edit replaces the first occurrence of old_string only
  - Writes are UTF-8; binary files are not supported
"""

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)

# Resolve once at import time — stays stable for the process lifetime
_HOME = Path.home()


def _safe_path(raw: str) -> Path:
    """
    Resolve and validate a file path.

    Raises ValueError if the path contains directory traversal sequences.
    """
    expanded = os.path.expandvars(raw)
    p = Path(expanded).resolve()
    # Block traversal tricks regardless of final resolved location
    if ".." in Path(expanded).parts:
        raise ValueError(f"Path traversal not allowed: {raw!r}")
    return p


async def file_write(path: str, content: str) -> str:
    """
    Write content to a file, creating it (and parent directories) if needed.

    Parameters
    ----------
    path : str
        Absolute path to the file.
    content : str
        Text content to write (overwrites existing content).

    Returns
    -------
    str
        Confirmation or error message.
    """
    if not path:
        return "file_write requires a path argument."
    try:
        p = _safe_path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")
        size = len(content.encode("utf-8"))
        logger.info("[file_write] wrote %d bytes to %s", size, p)
        return f"Written: {p} ({size} bytes)"
    except ValueError as exc:
        return f"Blocked: {exc}"
    except PermissionError:
        return f"Permission denied: {path}"
    except Exception as exc:
        return f"file_write failed: {exc}"


async def file_edit(path: str, old_string: str, new_string: str) -> str:
    """
    Replace the first occurrence of old_string with new_string in a file.

    Parameters
    ----------
    path : str
        Absolute path to the file.
    old_string : str
        Exact text to find and replace (must exist in file).
    new_string : str
        Replacement text.

    Returns
    -------
    str
        Confirmation or error message.
    """
    if not path:
        return "file_edit requires a path argument."
    if not old_string:
        return "file_edit requires a non-empty old_string."
    try:
        p = _safe_path(path)
        original = p.read_text(encoding="utf-8", errors="replace")
        if old_string not in original:
            # Return a short preview to help the model correct its search string
            preview = original[:300].replace("\n", "\\n")
            return f"old_string not found in {p}. File begins with: {preview!r}"
        updated = original.replace(old_string, new_string, 1)
        p.write_text(updated, encoding="utf-8")
        logger.info("[file_edit] edited %s", p)
        return f"Edited: {p} (replaced 1 occurrence)"
    except ValueError as exc:
        return f"Blocked: {exc}"
    except FileNotFoundError:
        return f"File not found: {path}"
    except PermissionError:
        return f"Permission denied: {path}"
    except Exception as exc:
        return f"file_edit failed: {exc}"


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "file_write",
    "description": "Write or edit files on the local filesystem. operation='write' creates/overwrites; operation='edit' replaces a specific string.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation":  {"type": "string", "enum": ["write", "edit"], "description": "Operation (default: write)"},
            "path":       {"type": "string", "description": "Absolute or home-relative file path"},
            "content":    {"type": "string", "description": "File content for write operation"},
            "old_string": {"type": "string", "description": "Text to find for edit operation"},
            "new_string": {"type": "string", "description": "Replacement text for edit operation"},
        },
        "required": ["path"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    op   = inputs.get("operation", "write")
    path = inputs.get("path", "")
    if not path:
        return {"error": "path is required"}
    if op == "edit":
        old = inputs.get("old_string", "")
        new = inputs.get("new_string", "")
        return await file_edit(path, old, new)
    else:
        return await file_write(path, inputs.get("content", ""))
