"""
AURA NX-Alpha — TeamDispatcher (Phase 3 + Phase 5)

Manages the background team pipeline lifecycle:
  - FIFO queue (one team at a time — hardware constraint)
  - Runs TeamGraphState through team_pipeline.py
  - Delivers results asynchronously to the correct chat session via SSE
  - Phase 5: PM clarification pause/resume via asyncio.Event

USAGE:
    dispatcher = get_team_dispatcher()
    queue_pos = await dispatcher.dispatch(task, thread_id, team_id)
    # → returns 0 if starting now, N if queued at position N

PM CLARIFICATION (Phase 5):
    PM calls await dispatcher.request_clarification(question, thread_id)
    → emits pm_clarification SSE, blocks up to 5 minutes
    → _pipeline_response intercepts the next user message and routes here
    → dispatcher.answer_clarification(answer, thread_id) unblocks PM

DELIVERY:
    When team completes, dispatcher calls deliver_team_result() from
    interface_agent.py, which does the AURA personality pass and emits
    the team_result SSE event to the chat session.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# TEAM JOB
# ─────────────────────────────────────────────────────────────────────────────

class TeamJob:
    __slots__ = ("team_id", "thread_id", "task")

    def __init__(self, team_id: str, thread_id: str, task: str):
        self.team_id   = team_id
        self.thread_id = thread_id
        self.task      = task


# ─────────────────────────────────────────────────────────────────────────────
# TEAM DISPATCHER
# ─────────────────────────────────────────────────────────────────────────────

class TeamDispatcher:
    """
    Singleton service that queues and executes team pipeline jobs one at a time.

    The queue enforces the hardware constraint (20 GB VRAM — one Ollama run max).
    Results are delivered asynchronously to the originating chat session.
    """

    def __init__(self):
        self._queue:              asyncio.Queue  = asyncio.Queue()
        self._active_task:        Optional[asyncio.Task] = None
        self._active_team_id:     Optional[str]  = None
        self._active_thread_id:   Optional[str]  = None

        # Phase 5 — PM clarification pause/resume
        self._clarification_event:    asyncio.Event = asyncio.Event()
        self._clarification_answer:   Optional[str] = None
        self._waiting_for_clarification: bool       = False
        self._clarification_answered:    bool       = False  # one-shot guard for ack emission

    # ── Public API ────────────────────────────────────────────────────────────

    async def dispatch(self, task: str, thread_id: str, team_id: str) -> int:
        """
        Enqueue a team job.

        Returns:
            0 if the job starts immediately (queue was empty and nothing active).
            N if the job is queued at position N (1-based).
        """
        job = TeamJob(team_id=team_id, thread_id=thread_id, task=task)
        await self._queue.put(job)
        queue_pos = self._queue.qsize()   # how many are waiting (including this one)

        if self._active_team_id is not None:
            # Something is already running — this job is truly queued
            logger.info(
                "[team_dispatcher] Job %s queued at position %d (active: %s)",
                team_id, queue_pos, self._active_team_id,
            )
            return queue_pos
        else:
            # Nothing running — this job will start immediately
            logger.info("[team_dispatcher] Job %s starting immediately", team_id)
            # Start the queue runner if not already running
            if self._active_task is None or self._active_task.done():
                self._active_task = asyncio.create_task(self._run_queue())
            return 0

    async def request_clarification(self, question: str, thread_id: str) -> Optional[str]:
        """
        Called by the PM node when it needs user input before planning.

        Emits a pm_clarification SSE event to the frontend, then pauses the
        PM coroutine for up to 5 minutes waiting for the user's reply.

        When the user replies, _pipeline_response intercepts the message,
        detects is_awaiting_clarification(), and calls answer_clarification().
        The asyncio.Event is set → this method returns the answer.

        Returns the answer string, or None if the 5-minute window expires.
        """
        from app.controller.chat_controller import _emit

        self._waiting_for_clarification = True
        self._clarification_answered = False  # reset one-shot guard
        self._clarification_answer = None
        self._clarification_event.clear()   # reset from any previous run

        logger.info(
            "[team_dispatcher] PM requesting clarification (thread=%s): %.120s",
            thread_id, question,
        )

        await _emit("pm_clarification", {
            "question":  question,
            "team_id":   self._active_team_id,
            "thread_id": thread_id,
        })

        try:
            await asyncio.wait_for(self._clarification_event.wait(), timeout=300.0)
            answer = self._clarification_answer
            logger.info("[team_dispatcher] Clarification received for thread %s: %.80s", thread_id, answer)
            return answer
        except asyncio.TimeoutError:
            logger.warning(
                "[team_dispatcher] Clarification timed out (thread=%s) — PM will proceed without answer",
                thread_id,
            )
            return None
        finally:
            self._waiting_for_clarification = False
            self._clarification_answer = None

    async def answer_clarification(self, answer: str, thread_id: str) -> bool:
        """
        Resume a PM that's waiting for user clarification.
        Returns True if the answer was accepted, False if no PM was waiting.

        Uses _clarification_answered as a one-shot guard to prevent multiple
        concurrent _pipeline_response calls from each emitting the ack message
        (race window between answer_clarification returning and request_clarification's
        finally block clearing _waiting_for_clarification).
        """
        if not self._waiting_for_clarification:
            logger.warning("[team_dispatcher] answer_clarification called but no PM is waiting")
            return False
        if self._clarification_answered:
            logger.debug("[team_dispatcher] answer_clarification already handled — ignoring duplicate")
            return False
        if self._active_thread_id != thread_id:
            logger.warning(
                "[team_dispatcher] Clarification answer for thread %s but active thread is %s",
                thread_id, self._active_thread_id,
            )
            return False
        self._clarification_answered = True  # one-shot: prevent duplicate ack emissions
        self._clarification_answer = answer
        self._clarification_event.set()
        logger.info("[team_dispatcher] Clarification answered for thread %s", thread_id)
        return True

    def is_awaiting_clarification(self, thread_id: Optional[str] = None) -> bool:
        """
        Returns True if the PM is currently paused waiting for clarification.
        If thread_id is provided, also verifies it matches the active thread.
        """
        if not self._waiting_for_clarification:
            return False
        if thread_id is not None and self._active_thread_id != thread_id:
            return False
        return True

    def get_status(self) -> dict:
        """Return current dispatcher status."""
        return {
            "active_team_id":           self._active_team_id,
            "active_thread_id":         self._active_thread_id,
            "queue_depth":              self._queue.qsize(),
            "awaiting_clarification":   self._waiting_for_clarification,
        }

    # ── Internal queue runner ─────────────────────────────────────────────────

    async def _run_queue(self):
        """Process jobs from the queue sequentially."""
        while not self._queue.empty():
            try:
                job = self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            await self._run_team(job)
        self._active_task = None
        logger.info("[team_dispatcher] Queue drained")

    async def _run_team(self, job: TeamJob):
        """Execute one team job end-to-end."""
        from app.graph.team_pipeline import get_team_pipeline
        from app.graph.state import initial_team_state
        from app.config import get_settings
        from app.controller.chat_controller import _emit

        self._active_team_id   = job.team_id
        self._active_thread_id = job.thread_id

        logger.info(
            "[team_dispatcher] Starting team job %s for thread %s: %.80s",
            job.team_id, job.thread_id, job.task,
        )

        settings = get_settings()
        team_pipeline = get_team_pipeline()

        if team_pipeline is None:
            logger.error("[team_dispatcher] Team pipeline not compiled — aborting job %s", job.team_id)
            await _emit("error", {
                "message": "Team pipeline not available. Please restart AURA.",
                "code":    "TEAM_PIPELINE_NOT_READY",
            })
            self._active_team_id   = None
            self._active_thread_id = None
            return

        # Build initial team state
        state = initial_team_state(
            team_id=job.team_id,
            thread_id=job.thread_id,
            task=job.task,
            workhorse_model=settings.workhorse_model_name,
            hardware_phase=settings.hardware_phase,
        )

        config = {
            "configurable": {
                "thread_id": job.team_id,   # team has its own checkpoint thread
            }
        }

        try:
            logger.info("[team_dispatcher] Running team pipeline for job %s", job.team_id)
            final_state = await team_pipeline.ainvoke(state, config)
            logger.info("[team_dispatcher] Team pipeline complete for job %s", job.team_id)
            await self._deliver_result(final_state, job.thread_id, job.team_id)

        except Exception as exc:
            logger.error(
                "[team_dispatcher] Team pipeline error for job %s: %s",
                job.team_id, exc, exc_info=True,
            )
            await _emit("error", {
                "message": f"Team pipeline failed for job {job.team_id}. Check server logs.",
                "code":    "TEAM_PIPELINE_ERROR",
            })
        finally:
            self._active_team_id   = None
            self._active_thread_id = None

    async def _deliver_result(self, final_state: dict, thread_id: str, team_id: str):
        """
        Deliver completed team results to the chat session.
        Calls deliver_team_result() from interface_agent.py which handles
        the AURA personality pass and SSE emission.
        """
        from app.graph.nodes.interface_agent import deliver_team_result
        msg_id = f"msg-team-{team_id}"
        logger.info("[team_dispatcher] Delivering result for job %s to thread %s", team_id, thread_id)
        try:
            await deliver_team_result(final_state, msg_id, thread_id)
        except Exception as exc:
            logger.error("[team_dispatcher] Result delivery failed for job %s: %s", team_id, exc, exc_info=True)


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_dispatcher: Optional[TeamDispatcher] = None


def get_team_dispatcher() -> TeamDispatcher:
    """Return the singleton TeamDispatcher, creating it if needed (lazy init)."""
    global _dispatcher
    if _dispatcher is None:
        _dispatcher = TeamDispatcher()
        logger.info("[team_dispatcher] TeamDispatcher initialized")
    return _dispatcher
