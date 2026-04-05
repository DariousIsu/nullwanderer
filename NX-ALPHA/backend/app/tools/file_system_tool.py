"""
AURA NX-Alpha — File System Tool

MCP/agent tool wrapper for FileSystemService.
Provides directory listing, file reading, searching, writing, moving,
deleting, copying, and metadata access.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)

TOOL_DEF = {
    "name": "file_system",
    "description": (
        "Navigate, read, write, search, move, copy, and delete files on the local filesystem. "
        "Destructive operations (delete, move, overwrite) require confirmed=True. "
        "File writes/edits use the existing safe write pipeline."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": ["list", "read", "write", "edit", "search", "move", "delete", "copy", "mkdir", "info"],
                "description": "Filesystem operation to perform.",
            },
            "path":        {"type": "string", "description": "File or directory path (~ expanded)."},
            "destination": {"type": "string", "description": "Destination path for move/copy."},
            "content":     {"type": "string", "description": "Content for write operation."},
            "old_text":    {"type": "string", "description": "Text to find for edit operation."},
            "new_text":    {"type": "string", "description": "Replacement text for edit operation."},
            "query":       {"type": "string", "description": "Search query (filename substring)."},
            "root":        {"type": "string", "description": "Root directory for search (defaults to home)."},
            "extensions":  {"type": "array", "items": {"type": "string"}, "description": "Filter by extensions, e.g. ['.py', '.txt']."},
            "max_results": {"type": "integer", "default": 50, "description": "Max search results."},
            "depth":       {"type": "integer", "default": 1, "description": "Directory listing depth."},
            "max_bytes":   {"type": "integer", "default": 500000, "description": "Max bytes to read."},
            "confirmed":   {"type": "boolean", "default": False, "description": "Set true to confirm destructive operations."},
            "op_id":       {"type": "string", "description": "Pre-authorisation token from POST /computer-use/authorize."},
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> Any:
    from app.service.file_system_service import get_file_system
    fs = get_file_system()
    if fs is None:
        return {"error": "File system service not initialised — boot sequence may not be complete."}

    op = inputs.get("operation", "")
    path = inputs.get("path", "")
    confirmed = bool(inputs.get("confirmed", False))
    op_id = inputs.get("op_id")

    if op == "list":
        if not path:
            return {"error": "path is required for list"}
        return fs.list_directory(path, depth=int(inputs.get("depth", 1)))

    if op == "read":
        if not path:
            return {"error": "path is required for read"}
        return fs.read_file(path, max_bytes=int(inputs.get("max_bytes", 500_000)))

    if op == "info":
        if not path:
            return {"error": "path is required for info"}
        return fs.get_file_info(path)

    if op == "search":
        query = inputs.get("query", "")
        if not query:
            return {"error": "query is required for search"}
        results = fs.search_files(
            query=query,
            root=inputs.get("root"),
            extensions=inputs.get("extensions"),
            max_results=int(inputs.get("max_results", 50)),
        )
        return {"results": results, "count": len(results)}

    if op == "mkdir":
        if not path:
            return {"error": "path is required for mkdir"}
        return fs.create_directory(path)

    if op == "copy":
        dst = inputs.get("destination", "")
        if not path or not dst:
            return {"error": "path and destination are required for copy"}
        return fs.copy_file(path, dst)

    if op == "write":
        content = inputs.get("content", "")
        if not path:
            return {"error": "path is required for write"}
        return await fs.write_file(path, content, confirmed=confirmed, op_id=op_id)

    if op == "edit":
        old_text = inputs.get("old_text", "")
        new_text = inputs.get("new_text", "")
        if not path:
            return {"error": "path is required for edit"}
        if not old_text:
            return {"error": "old_text is required for edit"}
        return await fs.edit_file(path, old_text, new_text)

    if op == "move":
        dst = inputs.get("destination", "")
        if not path or not dst:
            return {"error": "path and destination are required for move"}
        return fs.move_file(path, dst, confirmed=confirmed, op_id=op_id)

    if op == "delete":
        if not path:
            return {"error": "path is required for delete"}
        return fs.delete_file(path, confirmed=confirmed, op_id=op_id)

    return {"error": f"Unknown operation: {op!r}"}
