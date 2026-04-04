"""
Cron scheduling tools — model-callable wrappers around SchedulerService.

Exposes three tools:
  schedule_cron       — create a new scheduled task
  list_scheduled_tasks — list active/paused tasks
  delete_scheduled_task — archive (soft-delete) a task by ID
"""

import json
import logging

logger = logging.getLogger(__name__)


async def schedule_cron(
    name: str,
    cron: str,
    task_type: str,
    parameters: dict | None = None,
    notes: str = "",
) -> str:
    """
    Create a new APScheduler task in the scheduler database.

    Parameters
    ----------
    name : str
        Human-readable task name.
    cron : str
        5-field cron expression, e.g. '0 9 * * MON'.
    task_type : str
        One of: legislative_digest, news_brief, internal_schedule, data_pull, report.
    parameters : dict, optional
        Task-specific configuration (query, state, recipients, etc.).
    notes : str, optional
        Free-text notes attached to the task.

    Returns
    -------
    str
        Created task summary or error message.
    """
    try:
        from app.service.scheduler_service import get_scheduler_service
        svc = get_scheduler_service()
        if svc is None:
            return "Scheduler service not available. Backend may still be starting."

        task = svc.create_task({
            "name": name,
            "task_type": task_type,
            "schedule": cron,
            "parameters": parameters or {},
            "notes": notes,
            "source": "internal",
        })
        return (
            f"Scheduled task created:\n"
            f"  ID: {task['task_id']}\n"
            f"  Name: {task['name']}\n"
            f"  Type: {task['task_type']}\n"
            f"  Cron: {task['schedule']}\n"
            f"  Next run: {task.get('next_run', 'unknown')}"
        )
    except ValueError as exc:
        return f"Invalid task parameters: {exc}"
    except Exception as exc:
        logger.warning("[cron_tools] schedule_cron failed: %s", exc)
        return f"schedule_cron failed: {exc}"


async def list_scheduled_tasks() -> str:
    """
    List all active and paused scheduled tasks.

    Returns
    -------
    str
        Formatted task list or 'No tasks scheduled.'
    """
    try:
        from app.service.scheduler_service import get_scheduler_service
        svc = get_scheduler_service()
        if svc is None:
            return "Scheduler service not available."

        tasks = svc.get_all_tasks(include_archived=False)
        if not tasks:
            return "No scheduled tasks."

        lines = []
        for t in tasks:
            lines.append(
                f"[{t['status'].upper()}] {t['name']} ({t['task_type']}) "
                f"| cron: {t['schedule']} | next: {t.get('next_run', '?')} "
                f"| ID: {t['task_id']}"
            )
        return f"{len(tasks)} scheduled task(s):\n" + "\n".join(lines)
    except Exception as exc:
        logger.warning("[cron_tools] list_scheduled_tasks failed: %s", exc)
        return f"list_scheduled_tasks failed: {exc}"


async def delete_scheduled_task(task_id: str) -> str:
    """
    Archive (soft-delete) a scheduled task by ID.

    Parameters
    ----------
    task_id : str
        The task_id returned by schedule_cron or list_scheduled_tasks.

    Returns
    -------
    str
        Confirmation or error message.
    """
    if not task_id:
        return "delete_scheduled_task requires a task_id."
    try:
        from app.service.scheduler_service import get_scheduler_service
        svc = get_scheduler_service()
        if svc is None:
            return "Scheduler service not available."

        result = svc.delete_task(task_id)
        return f"Task archived: {result['task_id']} (status: {result['status']})"
    except KeyError as exc:
        return f"Task not found: {exc}"
    except Exception as exc:
        logger.warning("[cron_tools] delete_scheduled_task failed: %s", exc)
        return f"delete_scheduled_task failed: {exc}"


# ─────────────────────────────────────────────────────────────────────────────
# MCP TOOL INTERFACE
# ─────────────────────────────────────────────────────────────────────────────

TOOL_DEF = {
    "name": "schedule_cron",
    "description": "Create, list, and delete scheduled cron tasks.",
    "inputSchema": {
        "type": "object",
        "properties": {
            "operation": {"type": "string", "enum": ["create", "list", "delete"], "description": "Action to perform"},
            "name":      {"type": "string", "description": "Task name (create only)"},
            "cron":      {"type": "string", "description": "Cron expression e.g. '0 9 * * MON' (create only)"},
            "task_type": {"type": "string", "description": "Task type: legislative_digest, news_brief, internal_schedule, data_pull, report (create only)"},
            "parameters":{"type": "object", "description": "Task-specific parameters (create only)"},
            "notes":     {"type": "string", "description": "Optional notes (create only)"},
            "task_id":   {"type": "string", "description": "Task ID (delete only)"},
        },
        "required": ["operation"],
    },
}


async def tool_handler(inputs: dict) -> dict | str:
    op = inputs.get("operation", "list")
    if op == "create":
        return await schedule_cron(
            name=inputs.get("name", ""),
            cron=inputs.get("cron", ""),
            task_type=inputs.get("task_type", ""),
            parameters=inputs.get("parameters"),
            notes=inputs.get("notes", ""),
        )
    elif op == "list":
        return await list_scheduled_tasks()
    elif op == "delete":
        return await delete_scheduled_task(inputs.get("task_id", ""))
    return {"error": f"Unknown operation: {op!r}"}
