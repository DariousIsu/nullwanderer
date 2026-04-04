"""
Todo tools — model-callable wrappers around TodoService.

Four tools:
  task_create  — create a new persistent todo
  task_get     — retrieve a todo by ID
  task_list    — list todos with optional filters
  task_update  — update status, content, or priority
"""

import logging

logger = logging.getLogger(__name__)


async def _emit_todo_update() -> None:
    """Emit a todo_update SSE event so the frontend can refresh its list."""
    try:
        from app.controller.chat_controller import _emit
        from app.service.todo_service import get_todo_service
        svc = get_todo_service()
        if svc is None:
            return
        active = svc.list_todos(limit=50)
        await _emit("todo_update", {"todos": active})
    except Exception as exc:
        logger.debug("[todo_tools] SSE emit failed: %s", exc)


async def task_create(content: str, priority: str = "medium") -> str:
    """
    Create a new persistent todo.

    Parameters
    ----------
    content : str
        Description of the task.
    priority : str
        'high', 'medium' (default), or 'low'.

    Returns
    -------
    str
        Created todo summary.
    """
    if not content:
        return "task_create requires a content argument."
    try:
        from app.service.todo_service import get_todo_service
        svc = get_todo_service()
        if svc is None:
            return "Todo service not available."
        todo = svc.create(content=content, priority=priority)
        await _emit_todo_update()
        return (
            f"Task created:\n"
            f"  ID: {todo['id']}\n"
            f"  Content: {todo['content']}\n"
            f"  Priority: {todo['priority']}\n"
            f"  Status: {todo['status']}"
        )
    except ValueError as exc:
        return f"Invalid input: {exc}"
    except Exception as exc:
        logger.warning("[todo_tools] task_create failed: %s", exc)
        return f"task_create failed: {exc}"


async def task_get(todo_id: str) -> str:
    """
    Get a todo by ID.

    Parameters
    ----------
    todo_id : str
        The ID returned by task_create or task_list.

    Returns
    -------
    str
        Todo details or 'Not found.'
    """
    if not todo_id:
        return "task_get requires a todo_id argument."
    try:
        from app.service.todo_service import get_todo_service
        svc = get_todo_service()
        if svc is None:
            return "Todo service not available."
        todo = svc.get(todo_id)
        if todo is None:
            return f"Todo not found: {todo_id}"
        return (
            f"ID: {todo['id']}\n"
            f"Content: {todo['content']}\n"
            f"Status: {todo['status']}\n"
            f"Priority: {todo['priority']}\n"
            f"Created: {todo['created_at']}\n"
            f"Updated: {todo['updated_at']}"
        )
    except Exception as exc:
        logger.warning("[todo_tools] task_get failed: %s", exc)
        return f"task_get failed: {exc}"


async def task_list(status: str | None = None, priority: str | None = None) -> str:
    """
    List todos, optionally filtered by status or priority.

    Parameters
    ----------
    status : str, optional
        Filter by status: 'pending', 'in_progress', 'completed', 'cancelled'.
    priority : str, optional
        Filter by priority: 'high', 'medium', 'low'.

    Returns
    -------
    str
        Formatted todo list.
    """
    try:
        from app.service.todo_service import get_todo_service
        svc = get_todo_service()
        if svc is None:
            return "Todo service not available."
        todos = svc.list_todos(status=status or None, priority=priority or None)
        if not todos:
            return "No todos found."
        lines = []
        for t in todos:
            marker = {"pending": "[ ]", "in_progress": "[>]", "completed": "[x]", "cancelled": "[-]"}.get(t["status"], "[ ]")
            pri = f"({t['priority']}) " if t["priority"] != "medium" else ""
            lines.append(f"{marker} {pri}{t['content'][:100]}  [{t['id']}]")
        return f"{len(todos)} todo(s):\n" + "\n".join(lines)
    except Exception as exc:
        logger.warning("[todo_tools] task_list failed: %s", exc)
        return f"task_list failed: {exc}"


async def task_update(
    todo_id: str,
    status: str | None = None,
    content: str | None = None,
    priority: str | None = None,
) -> str:
    """
    Update a todo's status, content, or priority.

    Parameters
    ----------
    todo_id : str
        The todo ID to update.
    status : str, optional
        New status: 'pending', 'in_progress', 'completed', 'cancelled'.
    content : str, optional
        New content text.
    priority : str, optional
        New priority: 'high', 'medium', 'low'.

    Returns
    -------
    str
        Updated todo summary.
    """
    if not todo_id:
        return "task_update requires a todo_id argument."
    if not any([status, content, priority]):
        return "task_update requires at least one of: status, content, priority."
    try:
        from app.service.todo_service import get_todo_service
        svc = get_todo_service()
        if svc is None:
            return "Todo service not available."
        todo = svc.update(todo_id, content=content, status=status, priority=priority)
        await _emit_todo_update()
        return (
            f"Task updated:\n"
            f"  ID: {todo['id']}\n"
            f"  Content: {todo['content']}\n"
            f"  Status: {todo['status']}\n"
            f"  Priority: {todo['priority']}"
        )
    except KeyError as exc:
        return f"Todo not found: {exc}"
    except ValueError as exc:
        return f"Invalid input: {exc}"
    except Exception as exc:
        logger.warning("[todo_tools] task_update failed: %s", exc)
        return f"task_update failed: {exc}"


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "task_manage",
    "description": "Create, retrieve, list, and update todo tasks.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {"type": "string", "enum": ["create", "get", "list", "update"], "description": "Action to perform"},
            "content":   {"type": "string", "description": "Task content (create/update)"},
            "priority":  {"type": "string", "enum": ["high", "medium", "low"], "description": "Priority (create/update)"},
            "todo_id":   {"type": "string", "description": "Task ID (get/update)"},
            "status":    {"type": "string", "enum": ["pending", "in_progress", "completed", "cancelled"], "description": "Status filter (list) or new status (update)"},
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    op = inputs.get("operation", "list")
    if op == "create":
        return await task_create(
            content=inputs.get("content", ""),
            priority=inputs.get("priority", "medium"),
        )
    elif op == "get":
        return await task_get(inputs.get("todo_id", ""))
    elif op == "list":
        return await task_list(
            status=inputs.get("status"),
            priority=inputs.get("priority"),
        )
    elif op == "update":
        return await task_update(
            todo_id=inputs.get("todo_id", ""),
            status=inputs.get("status"),
            content=inputs.get("content"),
            priority=inputs.get("priority"),
        )
    return {"error": f"Unknown operation: {op!r}"}
