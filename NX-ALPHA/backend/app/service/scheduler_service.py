"""
AURA NX-Alpha — Scheduled Tasks Engine

APScheduler 3.x running inside FastAPI lifespan.
SQLite store for task_definitions and job_log.
Fires LangGraph jobs by task_type, emits SSE progress events.

TASK TYPES:
    legislative_digest  — Aggregated legislative updates
    news_brief          — Curated news summary
    internal_schedule   — Calendar/agenda digest
    data_pull           — Market/economic data snapshot
    report              — Custom generated report

TABLES:
    task_definitions — task_id, name, task_type, schedule, parameters, sender_email,
                       recipient_list, status, source, created_at, last_run, next_run, notes
    job_log          — log_id, task_id, started_at, finished_at, status, result_summary, error
"""

import asyncio
import json
import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# CONSTANTS
# ─────────────────────────────────────────────────────────────────────────────

VALID_TASK_TYPES = {
    "legislative_digest",
    "news_brief",
    "internal_schedule",
    "data_pull",
    "report",
    "leg_monitor_update",
}

VALID_STATUSES = {"active", "paused", "archived"}
VALID_SOURCES = {"internal", "portal_request"}

_DB_PATH = Path.home() / ".aura" / "scheduler.db"

# ─────────────────────────────────────────────────────────────────────────────
# SQLITE SCHEMA
# ─────────────────────────────────────────────────────────────────────────────

_SCHEMA_TASK_DEFINITIONS = """
CREATE TABLE IF NOT EXISTS task_definitions (
    task_id         TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    task_type       TEXT NOT NULL,
    schedule        TEXT NOT NULL,
    parameters      TEXT DEFAULT '{}',
    sender_email    TEXT DEFAULT '',
    recipient_list  TEXT DEFAULT '[]',
    status          TEXT DEFAULT 'active',
    source          TEXT DEFAULT 'internal',
    created_at      TEXT NOT NULL,
    last_run        TEXT,
    next_run        TEXT,
    notes           TEXT DEFAULT ''
);
"""

_SCHEMA_JOB_LOG = """
CREATE TABLE IF NOT EXISTS job_log (
    log_id          TEXT PRIMARY KEY,
    task_id         TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    status          TEXT DEFAULT 'running',
    result_summary  TEXT DEFAULT '',
    error           TEXT DEFAULT '',
    FOREIGN KEY (task_id) REFERENCES task_definitions(task_id)
);
"""


# ─────────────────────────────────────────────────────────────────────────────
# CRON HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def parse_cron(cron_str: str) -> CronTrigger:
    """Parse a 5-field cron string into an APScheduler CronTrigger.

    Format: 'minute hour day_of_month month day_of_week'
    Examples:
        '0 8 * * MON'       — every Monday at 08:00
        '30 9 * * MON-FRI'  — weekdays at 09:30
        '0 0 1 * *'         — first day of month at midnight
    """
    parts = cron_str.strip().split()
    if len(parts) != 5:
        raise ValueError(f"Invalid cron string (need 5 fields): {cron_str!r}")
    return CronTrigger(
        minute=parts[0],
        hour=parts[1],
        day=parts[2],
        month=parts[3],
        day_of_week=parts[4],
    )


def validate_cron(cron_str: str) -> bool:
    """Return True if the cron string is valid, raise ValueError otherwise."""
    parse_cron(cron_str)
    return True


def next_fire_time(cron_str: str) -> Optional[str]:
    """Return the next fire time as ISO string, or None."""
    try:
        trigger = parse_cron(cron_str)
        from apscheduler.triggers.cron import CronTrigger
        import pytz
        # Get next fire time from trigger
        nft = trigger.get_next_fire_time(None, datetime.now(timezone.utc))
        if nft:
            return nft.isoformat()
    except Exception:
        pass
    return None


# ─────────────────────────────────────────────────────────────────────────────
# SCHEDULER SERVICE
# ─────────────────────────────────────────────────────────────────────────────

class SchedulerService:
    """
    Core scheduled tasks engine.

    - Manages task_definitions and job_log in SQLite
    - Runs APScheduler AsyncIOScheduler
    - Fires LangGraph handlers per task_type
    - Emits SSE events for progress tracking
    """

    def __init__(self, db_path: Optional[Path] = None) -> None:
        self._db_path = db_path or _DB_PATH
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._scheduler: Optional[AsyncIOScheduler] = None
        self._conn: Optional[sqlite3.Connection] = None
        self._emit_fn = None  # SSE emit function, set during init

    # ── Database ──────────────────────────────────────────────────────────────

    def _get_conn(self) -> sqlite3.Connection:
        """Get or create the SQLite connection."""
        if self._conn is None:
            self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA foreign_keys=ON;")
        return self._conn

    def _init_db(self) -> None:
        """Create tables if they don't exist."""
        conn = self._get_conn()
        conn.execute(_SCHEMA_TASK_DEFINITIONS)
        conn.execute(_SCHEMA_JOB_LOG)
        conn.commit()
        logger.info("[scheduler] SQLite initialized at %s", self._db_path)

    def _row_to_dict(self, row: sqlite3.Row) -> dict:
        """Convert a sqlite3.Row to a plain dict with JSON parsing."""
        d = dict(row)
        # Parse JSON fields
        for field in ("parameters", "recipient_list"):
            if field in d and isinstance(d[field], str):
                try:
                    d[field] = json.loads(d[field])
                except (json.JSONDecodeError, TypeError):
                    pass
        return d

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(self, emit_fn=None) -> None:
        """Initialize the scheduler and load all active tasks."""
        self._emit_fn = emit_fn
        self._init_db()

        self._scheduler = AsyncIOScheduler(
            job_defaults={
                "coalesce": True,
                "max_instances": 1,
                "misfire_grace_time": 3600,  # 1 hour grace for missed jobs
            },
        )

        # Load and schedule all active tasks
        active_tasks = self._get_tasks_by_status("active")
        for task in active_tasks:
            self._schedule_task(task)

        self._scheduler.start()
        logger.info("[scheduler] APScheduler started with %d active tasks", len(active_tasks))

        # Check for missed jobs on startup
        await self._check_missed_jobs()

    async def shutdown(self) -> None:
        """Gracefully shut down the scheduler."""
        if self._scheduler and self._scheduler.running:
            self._scheduler.shutdown(wait=False)
            logger.info("[scheduler] APScheduler shut down")
        if self._conn:
            self._conn.close()
            self._conn = None
            logger.info("[scheduler] SQLite connection closed")

    # ── SSE Emit ──────────────────────────────────────────────────────────────

    async def _emit(self, event_type: str, data: dict) -> None:
        """Emit an SSE event if emit function is available."""
        if self._emit_fn:
            try:
                await self._emit_fn(event_type, data)
            except Exception as exc:
                logger.debug("[scheduler] SSE emit failed: %s", exc)

    # ── Task CRUD ─────────────────────────────────────────────────────────────

    def create_task(self, data: dict) -> dict:
        """Create a new scheduled task and add it to the scheduler.

        Required fields: name, task_type, schedule
        Optional: parameters, sender_email, recipient_list, source, notes
        """
        # Validate
        task_type = data.get("task_type", "")
        if task_type not in VALID_TASK_TYPES:
            raise ValueError(f"Invalid task_type: {task_type!r}. Must be one of {VALID_TASK_TYPES}")

        schedule = data.get("schedule", "")
        validate_cron(schedule)

        source = data.get("source", "internal")
        if source not in VALID_SOURCES:
            raise ValueError(f"Invalid source: {source!r}. Must be one of {VALID_SOURCES}")

        task_id = f"task_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()

        # Compute next_run
        nft = next_fire_time(schedule)

        # Serialize JSON fields
        parameters = json.dumps(data.get("parameters", {}))
        recipient_list = json.dumps(data.get("recipient_list", []))

        conn = self._get_conn()
        conn.execute(
            """INSERT INTO task_definitions
               (task_id, name, task_type, schedule, parameters, sender_email,
                recipient_list, status, source, created_at, next_run, notes)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)""",
            (
                task_id,
                data.get("name", "Untitled Task"),
                task_type,
                schedule,
                parameters,
                data.get("sender_email", ""),
                recipient_list,
                source,
                now,
                nft,
                data.get("notes", ""),
            ),
        )
        conn.commit()

        task = self.get_task(task_id)

        # Schedule it
        self._schedule_task(task)

        logger.info("[scheduler] Task created: %s (%s)", task_id, data.get("name"))
        return task

    def update_task(self, task_id: str, data: dict) -> dict:
        """Update an existing task. Reschedules if schedule changed."""
        existing = self.get_task(task_id)
        if not existing:
            raise KeyError(f"Task not found: {task_id}")

        if existing["status"] == "archived":
            raise ValueError("Cannot update an archived task")

        # Validate fields if provided
        if "task_type" in data and data["task_type"] not in VALID_TASK_TYPES:
            raise ValueError(f"Invalid task_type: {data['task_type']!r}")

        schedule_changed = False
        if "schedule" in data:
            validate_cron(data["schedule"])
            schedule_changed = data["schedule"] != existing["schedule"]

        # Build SET clause dynamically
        updatable = ["name", "task_type", "schedule", "parameters", "sender_email",
                     "recipient_list", "notes"]
        sets = []
        values = []
        for field in updatable:
            if field in data:
                val = data[field]
                if field in ("parameters",):
                    val = json.dumps(val) if not isinstance(val, str) else val
                elif field in ("recipient_list",):
                    val = json.dumps(val) if not isinstance(val, str) else val
                sets.append(f"{field} = ?")
                values.append(val)

        if not sets:
            return existing

        # Update next_run if schedule changed
        if schedule_changed:
            nft = next_fire_time(data["schedule"])
            sets.append("next_run = ?")
            values.append(nft)

        values.append(task_id)
        conn = self._get_conn()
        conn.execute(
            f"UPDATE task_definitions SET {', '.join(sets)} WHERE task_id = ?",
            values,
        )
        conn.commit()

        task = self.get_task(task_id)

        # Reschedule if needed
        if schedule_changed and task["status"] == "active":
            self._unschedule_task(task_id)
            self._schedule_task(task)
            logger.info("[scheduler] Task rescheduled: %s", task_id)

        logger.info("[scheduler] Task updated: %s", task_id)
        return task

    def delete_task(self, task_id: str) -> dict:
        """Archive a task (soft delete). Removes from scheduler."""
        existing = self.get_task(task_id)
        if not existing:
            raise KeyError(f"Task not found: {task_id}")

        conn = self._get_conn()
        conn.execute(
            "UPDATE task_definitions SET status = 'archived' WHERE task_id = ?",
            (task_id,),
        )
        conn.commit()

        self._unschedule_task(task_id)

        logger.info("[scheduler] Task archived: %s", task_id)
        return {"task_id": task_id, "status": "archived"}

    def pause_task(self, task_id: str) -> dict:
        """Pause a task — removes from scheduler but keeps in DB."""
        existing = self.get_task(task_id)
        if not existing:
            raise KeyError(f"Task not found: {task_id}")

        conn = self._get_conn()
        conn.execute(
            "UPDATE task_definitions SET status = 'paused' WHERE task_id = ?",
            (task_id,),
        )
        conn.commit()

        self._unschedule_task(task_id)

        logger.info("[scheduler] Task paused: %s", task_id)
        return self.get_task(task_id)

    def resume_task(self, task_id: str) -> dict:
        """Resume a paused task — adds back to scheduler."""
        existing = self.get_task(task_id)
        if not existing:
            raise KeyError(f"Task not found: {task_id}")

        if existing["status"] != "paused":
            raise ValueError(f"Task is not paused (status: {existing['status']})")

        nft = next_fire_time(existing["schedule"])
        conn = self._get_conn()
        conn.execute(
            "UPDATE task_definitions SET status = 'active', next_run = ? WHERE task_id = ?",
            (nft, task_id),
        )
        conn.commit()

        task = self.get_task(task_id)
        self._schedule_task(task)

        logger.info("[scheduler] Task resumed: %s", task_id)
        return task

    def get_task(self, task_id: str) -> Optional[dict]:
        """Get a single task by ID."""
        conn = self._get_conn()
        row = conn.execute(
            "SELECT * FROM task_definitions WHERE task_id = ?", (task_id,)
        ).fetchone()
        if row is None:
            return None
        return self._row_to_dict(row)

    def get_all_tasks(self, include_archived: bool = False) -> List[dict]:
        """Get all tasks, optionally including archived ones."""
        conn = self._get_conn()
        if include_archived:
            rows = conn.execute(
                "SELECT * FROM task_definitions ORDER BY created_at DESC"
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM task_definitions WHERE status != 'archived' ORDER BY created_at DESC"
            ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    def _get_tasks_by_status(self, status: str) -> List[dict]:
        """Get tasks filtered by status."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM task_definitions WHERE status = ?", (status,)
        ).fetchall()
        return [self._row_to_dict(r) for r in rows]

    # ── Job Log ───────────────────────────────────────────────────────────────

    def get_job_log(self, task_id: str, limit: int = 50) -> List[dict]:
        """Get execution log for a task."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT * FROM job_log WHERE task_id = ? ORDER BY started_at DESC LIMIT ?",
            (task_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def _log_job_start(self, task_id: str) -> str:
        """Create a job_log entry for a starting job. Returns log_id."""
        log_id = f"log_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc).isoformat()
        conn = self._get_conn()
        conn.execute(
            "INSERT INTO job_log (log_id, task_id, started_at, status) VALUES (?, ?, ?, 'running')",
            (log_id, task_id, now),
        )
        conn.commit()
        return log_id

    def _log_job_finish(self, log_id: str, status: str, result_summary: str = "", error: str = "") -> None:
        """Update a job_log entry when finished."""
        now = datetime.now(timezone.utc).isoformat()
        conn = self._get_conn()
        conn.execute(
            "UPDATE job_log SET finished_at = ?, status = ?, result_summary = ?, error = ? WHERE log_id = ?",
            (now, status, result_summary, error, log_id),
        )
        # Update task's last_run and next_run
        row = conn.execute("SELECT task_id FROM job_log WHERE log_id = ?", (log_id,)).fetchone()
        if row:
            task_id = row["task_id"]
            task = self.get_task(task_id)
            if task:
                nft = next_fire_time(task["schedule"])
                conn.execute(
                    "UPDATE task_definitions SET last_run = ?, next_run = ? WHERE task_id = ?",
                    (now, nft, task_id),
                )
        conn.commit()

    # ── APScheduler Integration ───────────────────────────────────────────────

    def _schedule_task(self, task: dict) -> None:
        """Add a task to the APScheduler."""
        if not self._scheduler:
            return

        task_id = task["task_id"]
        try:
            trigger = parse_cron(task["schedule"])
            self._scheduler.add_job(
                self._execute_task,
                trigger=trigger,
                id=task_id,
                name=task.get("name", task_id),
                args=[task_id],
                replace_existing=True,
            )
            logger.debug("[scheduler] Scheduled job: %s (%s)", task_id, task["schedule"])
        except Exception as exc:
            logger.error("[scheduler] Failed to schedule %s: %s", task_id, exc)

    def _unschedule_task(self, task_id: str) -> None:
        """Remove a task from the APScheduler."""
        if not self._scheduler:
            return
        try:
            self._scheduler.remove_job(task_id)
            logger.debug("[scheduler] Unscheduled job: %s", task_id)
        except Exception:
            pass  # Job may not exist in scheduler

    # ── Task Execution ────────────────────────────────────────────────────────

    async def _execute_task(self, task_id: str) -> None:
        """Execute a scheduled task. Called by APScheduler."""
        task = self.get_task(task_id)
        if not task:
            logger.warning("[scheduler] Task %s not found, skipping execution", task_id)
            return

        if task["status"] != "active":
            logger.debug("[scheduler] Task %s is %s, skipping", task_id, task["status"])
            return

        log_id = self._log_job_start(task_id)
        logger.info("[scheduler] Executing task: %s (%s)", task_id, task["name"])

        # Emit SSE: task execution started
        await self._emit("task_event", {
            "action": "started",
            "task_id": task_id,
            "name": task["name"],
            "task_type": task["task_type"],
        })

        try:
            result = await self._run_handler(task)
            self._log_job_finish(log_id, "completed", result_summary=str(result)[:500])

            # Emit SSE: task completed
            await self._emit("task_event", {
                "action": "completed",
                "task_id": task_id,
                "name": task["name"],
                "task_type": task["task_type"],
                "summary": str(result)[:200],
            })

            logger.info("[scheduler] Task completed: %s", task_id)

        except Exception as exc:
            error_msg = str(exc)
            self._log_job_finish(log_id, "failed", error=error_msg[:500])

            # Emit SSE: task failed
            await self._emit("task_event", {
                "action": "failed",
                "task_id": task_id,
                "name": task["name"],
                "error": error_msg[:200],
            })

            logger.error("[scheduler] Task failed: %s — %s", task_id, error_msg)

    async def _run_handler(self, task: dict) -> str:
        """Dispatch to the appropriate handler based on task_type.

        Each handler:
        1. Runs the LangGraph pipeline or calls the appropriate service
        2. Optionally sends email with results
        3. Returns a result summary string
        """
        task_type = task["task_type"]
        params = task.get("parameters", {})
        if isinstance(params, str):
            params = json.loads(params)

        handler_map = {
            "legislative_digest":  self._handle_legislative_digest,
            "news_brief":          self._handle_news_brief,
            "internal_schedule":   self._handle_internal_schedule,
            "data_pull":           self._handle_data_pull,
            "leg_monitor_update":  self._handle_leg_monitor_update,
            "report":            self._handle_report,
        }

        handler = handler_map.get(task_type)
        if not handler:
            raise ValueError(f"No handler for task_type: {task_type}")

        return await handler(task, params)

    # ── Task Type Handlers ────────────────────────────────────────────────────

    async def _handle_legislative_digest(self, task: dict, params: dict) -> str:
        """Generate a legislative digest or run a per-state monitor agent.

        If params contains state_code, dispatches to _handle_state_monitor()
        (BaseStateAgent scrape → detect → persist → summarize → SSE).
        Otherwise runs the original aggregated intelligence-service digest.
        """
        state_code = params.get("state_code")
        if state_code:
            return await self._handle_state_monitor(task, params, state_code)

        # Original aggregated digest path
        result_text = "Legislative digest generated"
        try:
            from app.service.intelligence_service import get_intelligence_service
            svc = get_intelligence_service()
            if svc:
                feed = await svc.get_aggregated_feed(
                    source_types=["legislative", "legal"],
                    limit=params.get("limit", 20),
                    hours_back=params.get("hours_back", 168),  # 1 week default
                )
                items = feed.get("items", [])
                result_text = f"Legislative digest: {len(items)} items aggregated"

                if task.get("recipient_list"):
                    await self._send_task_email(
                        task,
                        subject="AURA Legislative Digest",
                        body_items=items,
                    )
                    result_text += f", emailed to {len(task['recipient_list'])} recipients"
        except Exception as exc:
            logger.warning("[scheduler] Legislative digest partial failure: %s", exc)
            result_text = f"Legislative digest completed with warnings: {exc}"

        return result_text

    async def _handle_state_monitor(self, task: dict, params: dict, state_code: str) -> str:
        """Run BaseStateAgent for a single state legislature.

        Wires self._emit to the agent's emit_fn so legislation_update SSE
        events fire through the same channel as all other scheduler events.
        """
        from app.agents.legislation.base_state_agent import BaseStateAgent

        agent = BaseStateAgent(state_code)

        async def _emit_update(data: dict) -> None:
            await self._emit("legislation_update", data)

        result = await agent.run(
            inputs={"context": params.get("context", "personal")},
            emit_fn=_emit_update,
        )

        changed = result.get("changed_bills", [])
        summary = result.get("summary", "")
        result_text = f"State monitor [{state_code}]: {len(changed)} change(s) detected"
        if summary:
            result_text += f" — {summary[:100]}"

        if task.get("recipient_list") and changed:
            state_name = agent.config.name if agent.config else state_code
            await self._send_task_email(
                task,
                subject=f"AURA Legislative Update: {state_name}",
                body_html=(
                    f"<h2>{state_name} Legislative Update</h2>"
                    f"<p>{len(changed)} bill(s) with new activity.</p>"
                    f"<p>{summary}</p>"
                ),
            )
            result_text += f", emailed to {len(task['recipient_list'])} recipients"

        return result_text

    async def _handle_news_brief(self, task: dict, params: dict) -> str:
        """Generate a curated news brief."""
        result_text = "News brief generated"
        try:
            from app.service.news_service import get_news_service
            svc = get_news_service()
            if svc:
                category = params.get("category")
                limit = params.get("limit", 15)
                if category:
                    articles = await svc.fetch_by_category(category=category, limit=limit)
                else:
                    articles = await svc.fetch_all(limit_per_feed=max(1, limit // 5))
                    articles = articles[:limit]
                result_text = f"News brief: {len(articles)} articles"

                if task.get("recipient_list"):
                    await self._send_task_email(
                        task,
                        subject="AURA News Brief",
                        body_items=articles,
                    )
                    result_text += f", emailed to {len(task['recipient_list'])} recipients"
        except Exception as exc:
            logger.warning("[scheduler] News brief partial failure: %s", exc)
            result_text = f"News brief completed with warnings: {exc}"

        return result_text

    async def _handle_internal_schedule(self, task: dict, params: dict) -> str:
        """Generate a calendar/agenda digest."""
        result_text = "Schedule digest generated"
        try:
            from app.service.google_service import get_google_service
            svc = get_google_service()
            if svc:
                authenticated = await svc.is_authenticated()
                if authenticated:
                    days = params.get("days_ahead", 7)
                    events = await svc.get_calendar_events(days_ahead=days)
                    result_text = f"Schedule digest: {len(events)} events in next {days} days"

                    if task.get("recipient_list"):
                        await self._send_task_email(
                            task,
                            subject="AURA Schedule Digest",
                            body_items=events,
                        )
                        result_text += f", emailed to {len(task['recipient_list'])} recipients"
                else:
                    result_text = "Schedule digest skipped: Google not authenticated"
        except Exception as exc:
            logger.warning("[scheduler] Schedule digest partial failure: %s", exc)
            result_text = f"Schedule digest completed with warnings: {exc}"

        return result_text

    async def _handle_data_pull(self, task: dict, params: dict) -> str:
        """Pull market/economic data snapshot."""
        result_text = "Data pull completed"
        try:
            from app.service.finance_service import get_finance_service
            svc = get_finance_service()
            if svc:
                tickers = params.get("tickers", ["SPY", "QQQ", "BTC-USD"])
                quotes = await svc.get_quotes(tickers)
                result_text = f"Data pull: {len(quotes)} quotes fetched"

                if task.get("recipient_list"):
                    await self._send_task_email(
                        task,
                        subject="AURA Data Pull",
                        body_items=quotes,
                    )
                    result_text += f", emailed to {len(task['recipient_list'])} recipients"
        except Exception as exc:
            logger.warning("[scheduler] Data pull partial failure: %s", exc)
            result_text = f"Data pull completed with warnings: {exc}"

        return result_text

    async def _handle_report(self, task: dict, params: dict) -> str:
        """Generate a custom report via LangGraph pipeline."""
        result_text = "Report generation attempted"
        try:
            from app.graph.pipeline import get_pipeline
            pipeline = get_pipeline()
            if pipeline:
                prompt = params.get("prompt", f"Generate a {task['name']} report")
                # Fire pipeline with report prompt
                result = await pipeline.invoke({
                    "messages": [{"role": "user", "content": prompt}],
                    "task_type": "report",
                    "task_id": task["task_id"],
                })
                output = result.get("output", "Report generated")
                result_text = f"Report: {str(output)[:200]}"

                if task.get("recipient_list"):
                    await self._send_task_email(
                        task,
                        subject=f"AURA Report: {task['name']}",
                        body_html=str(output),
                    )
                    result_text += f", emailed to {len(task['recipient_list'])} recipients"
            else:
                result_text = "Report skipped: LangGraph pipeline not available"
        except ImportError:
            result_text = "Report skipped: LangGraph pipeline not installed"
        except Exception as exc:
            logger.warning("[scheduler] Report generation partial failure: %s", exc)
            result_text = f"Report completed with warnings: {exc}"

        return result_text

    async def _handle_leg_monitor_update(self, task: dict, params: dict) -> str:
        """Run daily legislative delta pull, match pass, and optional auto-brief."""
        from app.service.leg_daily_updater import run_daily_update
        from app.service.leg_monitor_service import get_monitor_service

        profile_id = params.get("profile_id")   # None = all profiles
        states     = params.get("states")        # None = auto from profiles

        result = await run_daily_update(states=states, emit_fn=self._emit)
        added   = result.get("added", 0)
        updated = result.get("updated", 0)
        processed = result.get("states_processed", [])
        errors = result.get("errors", [])

        mon = get_monitor_service()
        match_result = mon.run_match_pass(profile_id=profile_id)
        alerts_created = match_result.get("alerts_created", 0)

        # Auto-brief if profile specified and enabled
        if profile_id and params.get("auto_report"):
            from app.service.leg_report_service import generate_brief
            await generate_brief(profile_id, emit_fn=self._emit)

        summary = (
            f"Updated {updated} bills, added {added} new across {len(processed)} states. "
            f"{alerts_created} alerts generated."
        )
        if errors:
            summary += f" Errors: {'; '.join(errors[:3])}"
        return summary

    # ── Email Dispatch ────────────────────────────────────────────────────────

    async def _send_task_email(
        self,
        task: dict,
        subject: str,
        body_html: Optional[str] = None,
        body_items: Optional[list] = None,
    ) -> None:
        """Send email results for a completed task."""
        try:
            from app.service.email_dispatch import get_email_service
            email_svc = get_email_service()
            if not email_svc:
                logger.debug("[scheduler] Email service not available, skipping dispatch")
                return

            recipients = task.get("recipient_list", [])
            if isinstance(recipients, str):
                recipients = json.loads(recipients)
            if not recipients:
                return

            sender = task.get("sender_email", "")

            # Build HTML body from items if no explicit body_html
            if body_html is None and body_items:
                body_html = email_svc.format_items_html(subject, body_items)
            elif body_html is None:
                body_html = f"<p>Task <strong>{task['name']}</strong> completed.</p>"

            await email_svc.send_email(
                to_list=recipients,
                subject=subject,
                body_html=body_html,
                sender_email=sender,
            )
            logger.info("[scheduler] Email sent for task %s to %d recipients",
                       task["task_id"], len(recipients))
        except Exception as exc:
            logger.warning("[scheduler] Email dispatch failed for %s: %s",
                          task["task_id"], exc)

    # ── Run Now ───────────────────────────────────────────────────────────────

    async def run_now(self, task_id: str) -> dict:
        """Trigger immediate execution of a task, regardless of schedule."""
        task = self.get_task(task_id)
        if not task:
            raise KeyError(f"Task not found: {task_id}")

        if task["status"] == "archived":
            raise ValueError("Cannot run an archived task")

        # Execute in background
        asyncio.create_task(
            self._execute_task(task_id),
            name=f"run_now_{task_id}",
        )

        return {"task_id": task_id, "status": "triggered", "name": task["name"]}

    # ── Missed Jobs ───────────────────────────────────────────────────────────

    async def _check_missed_jobs(self) -> None:
        """On startup, check for tasks that should have run while we were down."""
        tasks = self._get_tasks_by_status("active")
        now = datetime.now(timezone.utc)

        for task in tasks:
            last_run = task.get("last_run")
            next_run = task.get("next_run")

            if next_run:
                try:
                    next_dt = datetime.fromisoformat(next_run)
                    if next_dt.tzinfo is None:
                        next_dt = next_dt.replace(tzinfo=timezone.utc)
                    if next_dt < now:
                        # This task missed its scheduled run
                        logger.info("[scheduler] Missed job detected for %s (was due %s), running now",
                                   task["task_id"], next_run)
                        await self.run_now(task["task_id"])
                except (ValueError, TypeError):
                    pass


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_scheduler_service: Optional[SchedulerService] = None


def init_scheduler_service(db_path: Optional[Path] = None) -> SchedulerService:
    """Initialize and return the SchedulerService singleton."""
    global _scheduler_service
    _scheduler_service = SchedulerService(db_path=db_path)
    logger.info("[scheduler] SchedulerService created (db: %s)", _scheduler_service._db_path)
    return _scheduler_service


def get_scheduler_service() -> Optional[SchedulerService]:
    """Return the SchedulerService singleton, or None if not initialized."""
    return _scheduler_service
