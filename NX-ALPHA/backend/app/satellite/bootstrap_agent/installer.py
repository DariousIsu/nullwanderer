"""
AURA Bootstrap Agent — Command Installer

Executes install commands (winget, ollama pull, pip) as child processes
and streams stdout/stderr as SSE-compatible line events.

Job lifecycle:
    run_command(cmd) → job_id
    stream_job_output(job_id) → AsyncGenerator[str]
    get_job_status(job_id) → "running" | "done" | "failed"
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from typing import Any, AsyncGenerator

logger = logging.getLogger(__name__)

# ─────────────────────────────────────────────────────────────────────────────
# JOB REGISTRY
# ─────────────────────────────────────────────────────────────────────────────

_jobs: dict[str, dict[str, Any]] = {}
# { job_id: { "proc": Process|None, "lines": list[str], "status": str, "started": float } }

_ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;]*[mGKHF]")
_JOB_TIMEOUT = 600  # 10 minutes max per job


def _strip_ansi(text: str) -> str:
    return _ANSI_ESCAPE.sub("", text)


# ─────────────────────────────────────────────────────────────────────────────
# RUN COMMAND
# ─────────────────────────────────────────────────────────────────────────────

async def run_command(command: str) -> str:
    """
    Start a command in a subprocess. Returns job_id.
    Uses 'cmd /c' wrapper so winget and other console tools work correctly.
    """
    job_id = uuid.uuid4().hex
    _jobs[job_id] = {
        "proc": None,
        "lines": [],
        "status": "running",
        "started": time.time(),
    }

    # winget and some tools need a full console session — wrap with cmd /c
    wrapped = f'cmd /c "{command}"'

    try:
        proc = await asyncio.create_subprocess_shell(
            wrapped,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        _jobs[job_id]["proc"] = proc
        asyncio.create_task(_drain_process(job_id, proc))
        logger.info("[installer] Started job %s: %s", job_id, command[:80])
    except Exception as exc:
        _jobs[job_id]["status"] = "failed"
        _jobs[job_id]["lines"].append(f"ERROR: {exc}")
        logger.error("[installer] Failed to start job %s: %s", job_id, exc)

    return job_id


async def _drain_process(job_id: str, proc: asyncio.subprocess.Process) -> None:
    """Background task: read output lines and store in job registry."""
    job = _jobs[job_id]
    deadline = job["started"] + _JOB_TIMEOUT

    try:
        while True:
            if time.time() > deadline:
                proc.kill()
                job["lines"].append("ERROR: Job timed out (10 min limit)")
                job["status"] = "failed"
                return

            try:
                line_bytes = await asyncio.wait_for(proc.stdout.readline(), timeout=5.0)
            except asyncio.TimeoutError:
                if proc.returncode is not None:
                    break
                continue

            if not line_bytes:
                break

            line = _strip_ansi(line_bytes.decode("utf-8", errors="replace")).rstrip()
            if line:
                job["lines"].append(line)

        await proc.wait()
        job["status"] = "done" if proc.returncode == 0 else "failed"
        job["lines"].append(f"[exit code {proc.returncode}]")
        logger.info("[installer] Job %s finished with status %s", job_id, job["status"])

    except Exception as exc:
        job["status"] = "failed"
        job["lines"].append(f"ERROR: {exc}")
        logger.error("[installer] Job %s drain error: %s", job_id, exc)


# ─────────────────────────────────────────────────────────────────────────────
# STREAM OUTPUT
# ─────────────────────────────────────────────────────────────────────────────

async def stream_job_output(job_id: str) -> AsyncGenerator[str, None]:
    """
    Yield lines from a job's output as they arrive.
    First replays all buffered lines, then yields new ones in real-time.
    """
    if job_id not in _jobs:
        yield f"data: ERROR: Unknown job {job_id}\n\n"
        return

    job = _jobs[job_id]
    sent = 0

    while True:
        # Yield any lines we haven't sent yet
        while sent < len(job["lines"]):
            line = job["lines"][sent]
            yield f"data: {line}\n\n"
            sent += 1

        # If done, stop
        if job["status"] in ("done", "failed"):
            yield f"data: [status: {job['status']}]\n\n"
            break

        await asyncio.sleep(0.2)


# ─────────────────────────────────────────────────────────────────────────────
# STATUS & RESULT
# ─────────────────────────────────────────────────────────────────────────────

def get_job_status(job_id: str) -> str:
    """Return 'running', 'done', 'failed', or 'unknown'."""
    if job_id not in _jobs:
        return "unknown"
    return _jobs[job_id]["status"]


def get_job_result(job_id: str) -> dict[str, Any]:
    if job_id not in _jobs:
        return {"status": "unknown", "lines": []}
    job = _jobs[job_id]
    return {"status": job["status"], "lines": job["lines"]}
