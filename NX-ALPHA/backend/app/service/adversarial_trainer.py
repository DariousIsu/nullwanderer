"""
AURA NX-Alpha — Adversarial Trainer Service

Native Windows replacement for the WSL2/Axolotl self-care training pipeline.

DESIGN:
  Workhorse (Ollama) acts as questioner + judge.
  Interface Engine (GGUF) acts as respondent.
  Approved / corrected pairs are stored in:
    - training_candidates (SQLite L1) — always, both approved and corrected
    - ChromaDB L2                     — approved pairs only, source='adversarial'
    - FalkorDB L3                     — approved pairs only

  Works with any installed model — no weight changes required.
  Runs as an asyncio background task (no subprocess, no WSL2 dependency).

DATASET REGISTRY:
  Successful dataset loads are persisted in adversarial_dataset_registry (SQLite).
  Each entry tracks: bookmark (resume offset), total_samples_done (cumulative),
  dataset_size (if discoverable), and pct_complete.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
import sqlite3
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Column priority lists extracted from self_care_executor.py
PROMPT_COLS   = ['problem', 'question', 'instruction', 'input', 'prompt', 'query', 'text']
RESPONSE_COLS = ['solution', 'answer', 'response', 'output', 'completion', 'assistant']

_REGISTRY_DDL = """
CREATE TABLE IF NOT EXISTS adversarial_dataset_registry (
    dataset_key         TEXT PRIMARY KEY,
    dataset_id          TEXT NOT NULL,
    dataset_config      TEXT,
    dataset_split       TEXT NOT NULL,
    prompt_col          TEXT,
    response_col        TEXT,
    dataset_size        INTEGER,
    total_samples_done  INTEGER NOT NULL DEFAULT 0,
    bookmark            INTEGER NOT NULL DEFAULT 0,
    first_seen_at       REAL,
    last_run_at         REAL,
    last_session_id     TEXT,
    max_samples         INTEGER,
    interval_minutes    REAL,
    judge_threshold     INTEGER,
    workhorse_model     TEXT
)
"""

# Columns added after initial schema — applied via ALTER TABLE if missing
_REGISTRY_MIGRATIONS = [
    "ALTER TABLE adversarial_dataset_registry ADD COLUMN max_samples INTEGER",
    "ALTER TABLE adversarial_dataset_registry ADD COLUMN interval_minutes REAL",
    "ALTER TABLE adversarial_dataset_registry ADD COLUMN judge_threshold INTEGER",
    "ALTER TABLE adversarial_dataset_registry ADD COLUMN workhorse_model TEXT",
]


# ─────────────────────────────────────────────────────────────────────────────
# CONFIG + RESULT TYPES
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class AdversarialConfig:
    dataset_id: str
    dataset_split: str = "train"
    dataset_config: Optional[str] = None        # HF config name (e.g. 'math' for PersonaHub)
    dataset_prompt_col: Optional[str] = None    # auto-detect if None
    dataset_response_col: Optional[str] = None
    max_samples: int = 100
    interval_minutes: float = 5.0
    judge_threshold: int = 6
    workhorse_model: Optional[str] = None       # defaults to configured workhorse
    tool_ids: list = field(default_factory=list)  # optional: link session to MCP tool(s)
    session_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])


@dataclass
class JudgmentResult:
    score: int
    approved: bool
    correction: Optional[str]
    reasoning: str


# ─────────────────────────────────────────────────────────────────────────────
# ADVERSARIAL TRAINER
# ─────────────────────────────────────────────────────────────────────────────

class AdversarialTrainer:
    """
    Runs a slow adversarial loop:
      dataset sample → Workhorse poses question → Interface answers →
      Workhorse judges → store to memory layers → sleep → repeat
    """

    def __init__(self) -> None:
        self._task: Optional[asyncio.Task] = None
        self._config: Optional[AdversarialConfig] = None
        self._running = False
        self._done = 0
        self._total = 0
        self._approved = 0
        self._rejected = 0
        self._current_sample: Optional[str] = None
        self._session_start: Optional[float] = None

        # ── Queue state ───────────────────────────────────────────────────────
        self._queue: list[AdversarialConfig] = []
        self._queue_pos: int = 0          # index of currently-running dataset
        self._queue_total: int = 0        # total datasets queued this run
        self._queue_completed: list[str] = []   # dataset_ids finished
        self._queue_failed: list[str] = []      # dataset_ids that errored

    # ── PUBLIC API ─────────────────────────────────────────────────────────────

    async def start(self, config: AdversarialConfig) -> dict:
        if self._running:
            return {"started": False, "reason": "already running", "session_id": self._config.session_id}

        self._config = config
        self._running = True
        self._done = 0
        self._total = config.max_samples
        self._approved = 0
        self._rejected = 0
        self._current_sample = None
        self._session_start = time.time()

        self._task = asyncio.create_task(
            self._run_loop(),
            name=f"adversarial_trainer_{config.session_id}",
        )
        self._task.add_done_callback(self._on_task_done)
        logger.info("[adversarial_trainer] Started session %s — %s samples from %s",
                    config.session_id, config.max_samples, config.dataset_id)
        return {"started": True, "session_id": config.session_id}

    async def stop(self) -> dict:
        if not self._running or self._task is None:
            return {"stopped": False, "reason": "not running"}
        # Clear queue so the done-callback doesn't advance to next dataset
        self._queue.clear()
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        return {"stopped": True, "session_id": self._config.session_id if self._config else None}

    async def queue(self, configs: list[AdversarialConfig]) -> dict:
        """
        Enqueue multiple datasets and run them sequentially.
        If a session is already running it must be stopped first.
        """
        if self._running:
            return {"queued": False, "reason": "session already running — stop it first"}
        if not configs:
            return {"queued": False, "reason": "empty config list"}

        self._queue = list(configs)
        self._queue_total = len(configs)
        self._queue_pos = 0
        self._queue_completed = []
        self._queue_failed = []

        logger.info("[adversarial_trainer] Queue loaded: %d datasets", self._queue_total)
        await _emit_at("at_queue_start", {
            "total": self._queue_total,
            "datasets": [c.dataset_id for c in self._queue],
        })
        return await self._start_next_in_queue()

    async def _start_next_in_queue(self) -> dict:
        """Pop and start the next config from the queue. Internal use only."""
        if not self._queue:
            logger.info("[adversarial_trainer] Queue exhausted — all datasets complete")
            await _emit_at("at_queue_complete", {
                "completed": self._queue_completed,
                "failed":    self._queue_failed,
                "total":     self._queue_total,
            })
            return {"queued": True, "done": True, "completed": self._queue_completed}

        config = self._queue.pop(0)
        self._queue_pos = self._queue_total - len(self._queue)
        logger.info("[adversarial_trainer] Queue advancing → %s (%d/%d)",
                    config.dataset_id, self._queue_pos, self._queue_total)
        await _emit_at("at_queue_progress", {
            "current":   self._queue_pos,
            "total":     self._queue_total,
            "dataset_id": config.dataset_id,
            "remaining": len(self._queue),
        })
        return await self.start(config)

    def get_queue_status(self) -> dict:
        return {
            "active":      self._running,
            "queue_pos":   self._queue_pos,
            "queue_total": self._queue_total,
            "remaining":   len(self._queue),
            "completed":   self._queue_completed,
            "failed":      self._queue_failed,
            "current_dataset": self._config.dataset_id if self._config else None,
        }

    def get_status(self) -> dict:
        return {
            "running":        self._running,
            "session_id":     self._config.session_id if self._config else None,
            "done":           self._done,
            "total":          self._total,
            "approved":       self._approved,
            "rejected":       self._rejected,
            "current_sample": self._current_sample,
            "elapsed_s":      round(time.time() - self._session_start, 1) if self._session_start else 0,
        }

    def get_stats(self) -> dict:
        """Query training_candidates for aggregate stats."""
        try:
            mem = _get_mem_service()
            if mem is None:
                return {}
            with sqlite3.connect(mem._l1_path) as db:
                row = db.execute("""
                    SELECT
                        COUNT(*) as total,
                        SUM(CASE WHEN source_type='adversarial_approved' THEN 1 ELSE 0 END) as approved,
                        SUM(CASE WHEN source_type='adversarial_corrected' THEN 1 ELSE 0 END) as corrected,
                        AVG(quality_signal) as avg_quality
                    FROM training_candidates
                    WHERE source_type LIKE 'adversarial%'
                """).fetchone()
                total, approved, corrected, avg_q = row if row else (0, 0, 0, 0.0)
                return {
                    "total_stored":   total or 0,
                    "approved":       approved or 0,
                    "corrected":      corrected or 0,
                    "approval_rate":  round((approved or 0) / max(total, 1), 2),
                    "avg_quality":    round(avg_q or 0.0, 3),
                }
        except Exception as exc:
            logger.warning("[adversarial_trainer] stats query failed: %s", exc)
            return {}

    def list_datasets(self) -> list:
        """Return all known datasets from the registry with progress info."""
        db_path = _get_db_path()
        if db_path is None:
            return []
        try:
            _ensure_registry_table(db_path)
            with sqlite3.connect(db_path) as db:
                db.row_factory = sqlite3.Row
                rows = db.execute("""
                    SELECT dataset_key, dataset_id, dataset_config, dataset_split,
                           prompt_col, response_col, dataset_size,
                           total_samples_done, bookmark,
                           first_seen_at, last_run_at, last_session_id
                    FROM adversarial_dataset_registry
                    ORDER BY last_run_at DESC
                """).fetchall()
            result = []
            for r in rows:
                size = r["dataset_size"]
                done = r["total_samples_done"]
                pct = round(done / size * 100, 1) if size else None
                result.append({
                    "dataset_key":        r["dataset_key"],
                    "dataset_id":         r["dataset_id"],
                    "dataset_config":     r["dataset_config"],
                    "dataset_split":      r["dataset_split"],
                    "prompt_col":         r["prompt_col"],
                    "response_col":       r["response_col"],
                    "dataset_size":       size,
                    "total_samples_done": done,
                    "bookmark":           r["bookmark"],
                    "pct_complete":       pct,
                    "first_seen_at":      r["first_seen_at"],
                    "last_run_at":        r["last_run_at"],
                    "last_session_id":    r["last_session_id"],
                })
            return result
        except Exception as exc:
            logger.warning("[adversarial_trainer] list_datasets failed: %s", exc)
            return []

    def append_to_queue(self, configs: list[AdversarialConfig]) -> dict:
        """
        Append datasets to the running queue without stopping the current session.
        Safe to call while a session is active — entries are picked up by
        _on_task_done as each dataset completes.
        """
        if not configs:
            return {"appended": False, "reason": "empty config list"}
        self._queue.extend(configs)
        self._queue_total += len(configs)
        logger.info("[adversarial_trainer] Appended %d dataset(s) to queue (total now %d)",
                    len(configs), len(self._queue))
        return {"appended": True, "added": len(configs), "queue_length": len(self._queue)}

    async def rerun_datasets(self, dataset_keys: list[str], max_samples_override: Optional[int] = None) -> dict:
        """
        Re-queue datasets by their registry keys (from list_datasets).
        Reconstructs AdversarialConfig from stored params.
        Resets bookmark so the run starts from the beginning.
        Pass max_samples_override to change sample count without editing the registry.
        """
        db_path = _get_db_path()
        if db_path is None:
            return {"queued": False, "reason": "database unavailable"}

        configs = []
        not_found = []
        try:
            _ensure_registry_table(db_path)
            with sqlite3.connect(db_path) as db:
                db.row_factory = sqlite3.Row
                for key in dataset_keys:
                    row = db.execute(
                        "SELECT * FROM adversarial_dataset_registry WHERE dataset_key=?", (key,)
                    ).fetchone()
                    if not row:
                        not_found.append(key)
                        continue
                    # Reset bookmark so it reruns from scratch
                    db.execute(
                        "UPDATE adversarial_dataset_registry SET bookmark=0 WHERE dataset_key=?", (key,)
                    )
                    configs.append(AdversarialConfig(
                        dataset_id=row["dataset_id"],
                        dataset_split=row["dataset_split"],
                        dataset_config=row["dataset_config"],
                        dataset_prompt_col=row["prompt_col"],
                        dataset_response_col=row["response_col"],
                        max_samples=max_samples_override or row["max_samples"] or 100,
                        interval_minutes=row["interval_minutes"] if row["interval_minutes"] is not None else 5.0,
                        judge_threshold=row["judge_threshold"] or 6,
                        workhorse_model=row["workhorse_model"],
                    ))
                db.commit()
        except Exception as exc:
            logger.warning("[adversarial_trainer] rerun_datasets failed: %s", exc)
            return {"queued": False, "reason": str(exc)}

        if not_found:
            logger.warning("[adversarial_trainer] rerun: keys not found: %s", not_found)
        if not configs:
            return {"queued": False, "reason": "no matching datasets found", "not_found": not_found}

        result = await self.queue(configs)
        result["not_found"] = not_found
        return result

    # ── INTERNAL LOOP ─────────────────────────────────────────────────────────

    def _on_task_done(self, task: asyncio.Task) -> None:
        self._running = False
        dataset_id = self._config.dataset_id if self._config else "unknown"

        if task.cancelled():
            # Stop was called — queue already cleared in stop()
            logger.info("[adversarial_trainer] Session cancelled: %s", dataset_id)
            return

        if task.exception():
            logger.error("[adversarial_trainer] Loop crashed: %s", task.exception())
            self._queue_failed.append(dataset_id)
        else:
            self._queue_completed.append(dataset_id)

        # Advance queue if more datasets are waiting
        if self._queue:
            asyncio.get_event_loop().create_task(self._start_next_in_queue())

    async def _run_loop(self) -> None:
        config = self._config
        db_path = _get_db_path()

        try:
            await _emit_at("at_progress", {
                "session_id": config.session_id,
                "done": 0,
                "total": config.max_samples,
                "approved": 0,
                "rejected": 0,
                "status": "starting",
            })

            # Load dataset — returns resolved split and pre-scanned label scheme
            p_col, r_col, dataset_iter, resolved_split, label_scheme = await asyncio.to_thread(
                _load_dataset, config
            )
            if dataset_iter is None:
                logger.error("[adversarial_trainer] Failed to load dataset %s", config.dataset_id)
                await _emit_at("at_complete", {"session_id": config.session_id, "status": "error",
                                               "reason": "dataset_load_failed"})
                return

            logger.info("[adversarial_trainer] Dataset loaded. prompt_col=%s response_col=%s", p_col, r_col)

            # Register dataset + get bookmark
            dkey = _dataset_key(config.dataset_id, config.dataset_config, resolved_split)
            bookmark, prior_total = 0, 0
            if db_path:
                _ensure_registry_table(db_path)
                _upsert_dataset_known(db_path, config, p_col, r_col, resolved_split)
                bookmark, prior_total = _get_dataset_bookmark(db_path, dkey)
                logger.info("[adversarial_trainer] Dataset '%s' bookmark=%d total_done=%d",
                            dkey, bookmark, prior_total)

            # Skip already-processed samples (resume from bookmark)
            if bookmark > 0:
                logger.info("[adversarial_trainer] Skipping %d samples (resuming from bookmark)", bookmark)
                dataset_iter = itertools.islice(dataset_iter, bookmark, None)

            ollama = _get_ollama(config.workhorse_model)
            if ollama is None:
                logger.error("[adversarial_trainer] OllamaService not available")
                await _emit_at("at_complete", {"session_id": config.session_id, "status": "error",
                                               "reason": "ollama_unavailable"})
                return

            for sample in dataset_iter:
                if self._done >= config.max_samples:
                    break

                prompt_text   = str(sample.get(p_col, "") or "").strip()
                expected_text = str(sample.get(r_col, "") or "").strip()
                if not prompt_text:
                    continue

                # Normalize raw dataset label → rich expected answer the judge can use
                # scheme is pre-locked from the upfront scan — no per-sample detection
                from app.service.citation_label_normalizer import normalize as _normalize_label
                _norm = _normalize_label(expected_text, scheme=label_scheme)
                expected_text = _norm.expected_answer

                self._current_sample = prompt_text[:120]

                try:
                    # 1. Workhorse generates question from sample
                    question = await self._pose_question(prompt_text, expected_text, ollama)
                    if not question:
                        continue
                    await _emit_at("at_question", {"session_id": config.session_id,
                                                   "question": question,
                                                   "sample_n": self._done + 1})

                    # 2. Interface answers via Ollama (real call, Phoenix-traced)
                    answer = await self._get_interface_answer(question, ollama)
                    await _emit_at("at_answer", {"session_id": config.session_id,
                                                 "answer": answer[:500]})

                    # 3. Workhorse judges
                    judgment = await self._judge_answer(
                        question, answer, expected_text, config.judge_threshold, ollama
                    )
                    await _emit_at("at_judgment", {
                        "session_id": config.session_id,
                        "score":      judgment.score,
                        "approved":   judgment.approved,
                        "reasoning":  judgment.reasoning[:300],
                    })

                    # 4. Write to memory layers
                    await self._write_to_memory(question, answer, judgment)
                    await _emit_at("at_stored", {"session_id": config.session_id,
                                                 "source_type": "adversarial_approved" if judgment.approved
                                                                else "adversarial_corrected"})

                    self._done += 1
                    if judgment.approved:
                        self._approved += 1
                    else:
                        self._rejected += 1

                    # Update bookmark after each completed sample
                    if db_path:
                        _update_dataset_progress(
                            db_path, dkey,
                            bookmark=bookmark + self._done,
                            total_done=prior_total + self._done,
                            session_id=config.session_id,
                        )

                    await _emit_at("at_progress", {
                        "session_id": config.session_id,
                        "done":       self._done,
                        "total":      config.max_samples,
                        "approved":   self._approved,
                        "rejected":   self._rejected,
                    })

                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    logger.warning("[adversarial_trainer] Sample %d failed: %s", self._done + 1, exc)
                    continue

                # Sleep between turns (unless it's the last sample)
                if self._done < config.max_samples:
                    await asyncio.sleep(config.interval_minutes * 60)

            await _emit_at("at_complete", {
                "session_id": config.session_id,
                "done":       self._done,
                "approved":   self._approved,
                "rejected":   self._rejected,
                "status":     "complete",
            })
            logger.info("[adversarial_trainer] Session %s complete — %d/%d approved",
                        config.session_id, self._approved, self._done)

        except asyncio.CancelledError:
            await _emit_at("at_complete", {"session_id": config.session_id, "status": "stopped"})
            raise

    # ── STEP METHODS ──────────────────────────────────────────────────────────

    async def _pose_question(
        self,
        sample_text: str,
        expected_answer: str,
        ollama,
    ) -> str:
        prompt = (
            "You are generating training questions for an AI assistant.\n"
            "Given this dataset sample, formulate one clear question that tests understanding.\n"
            f"Sample: {sample_text[:800]}\n"
            f"Expected answer: {expected_answer[:400]}\n"
            "Return ONLY the question. No preamble."
        )
        messages = [{"role": "user", "content": prompt}]
        tracer = _get_tracer()
        ctx = tracer.start_as_current_span("at_pose_question") if tracer else _nullspan()
        with ctx as span:
            if span and tracer:
                span.set_attribute("session_id", self._config.session_id)
                span.set_attribute("sample_preview", sample_text[:120])
            try:
                result = await ollama.chat(messages, temperature=0.5)
                return str(result).strip()
            except Exception as exc:
                logger.warning("[adversarial_trainer] pose_question failed: %s", exc)
                return sample_text[:300]

    async def _get_interface_answer(self, question: str, ollama) -> str:
        """Call Ollama with an AURA system prompt — treats it as a real interface turn."""
        messages = [
            {
                "role": "system",
                "content": (
                    "You are AURA, an intelligent AI assistant. "
                    "Answer the user's question clearly, accurately, and helpfully."
                ),
            },
            {"role": "user", "content": question},
        ]
        tracer = _get_tracer()
        ctx = tracer.start_as_current_span("at_interface_answer") if tracer else _nullspan()
        with ctx as span:
            if span and tracer:
                span.set_attribute("session_id", self._config.session_id)
                span.set_attribute("question_preview", question[:120])
            try:
                result = await ollama.chat(messages, temperature=0.7)
                return str(result).strip()
            except Exception as exc:
                logger.warning("[adversarial_trainer] interface answer failed: %s", exc)
                return "[generation failed]"

    async def _judge_answer(
        self,
        question: str,
        answer: str,
        expected: str,
        threshold: int,
        ollama,
    ) -> JudgmentResult:
        schema = {
            "type": "object",
            "properties": {
                "score":      {"type": "integer"},
                "approved":   {"type": "boolean"},
                "correction": {"type": ["string", "null"]},
                "reasoning":  {"type": "string"},
            },
            "required": ["score", "approved", "correction", "reasoning"],
        }
        prompt = (
            f"You are evaluating an AI assistant's answer quality.\n"
            f"Question: {question[:500]}\n"
            f"Expected answer: {expected[:400]}\n"
            f"Actual answer: {answer[:600]}\n\n"
            f"Score 1-10 (10=perfect). If score < {threshold}, provide a correction. "
            f"Return JSON with fields: score (int), approved (bool), correction (str or null), reasoning (str)."
        )
        messages = [{"role": "user", "content": prompt}]
        tracer = _get_tracer()
        ctx = tracer.start_as_current_span("at_judge_answer") if tracer else _nullspan()
        with ctx as span:
            try:
                result = await ollama.chat_json(messages, temperature=0.3, schema=schema)
                score      = int(result.get("score", 5))
                approved   = bool(result.get("approved", score >= threshold))
                correction = result.get("correction") or None
                reasoning  = str(result.get("reasoning", ""))
                if score >= threshold:
                    approved = True
                if span and tracer:
                    span.set_attribute("session_id", self._config.session_id)
                    span.set_attribute("score", score)
                    span.set_attribute("approved", approved)
                return JudgmentResult(score=score, approved=approved,
                                      correction=correction, reasoning=reasoning)
            except Exception as exc:
                logger.warning("[adversarial_trainer] judge_answer failed: %s", exc)
                return JudgmentResult(score=5, approved=True, correction=None, reasoning="judgment unavailable")

    async def _write_to_memory(
        self,
        question: str,
        answer: str,
        judgment: JudgmentResult,
    ) -> None:
        source_type = "adversarial_approved" if judgment.approved else "adversarial_corrected"
        output_text = answer if judgment.approved else (judgment.correction or answer)
        quality     = judgment.score / 10.0

        # Always write to training_candidates (SQLite L1)
        try:
            mem = _get_mem_service()
            if mem:
                markers = json.dumps({"tool_ids": list(self._config.tool_ids)}) if self._config.tool_ids else None
                with sqlite3.connect(mem._l1_path) as db:
                    db.execute(
                        """INSERT INTO training_candidates
                           (source_type, input_text, output_text, quality_signal, markers, created_at)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (source_type, question, output_text, quality, markers, time.time()),
                    )
                    db.commit()
        except Exception as exc:
            logger.warning("[adversarial_trainer] training_candidates insert failed: %s", exc)

        # Approved pairs → L2 (ChromaDB) + L3 (FalkorDB)
        if judgment.approved and mem:
            doc_id = f"adversarial_{uuid.uuid4().hex[:12]}"
            try:
                mem._store_layer2(
                    doc_id,
                    f"Q: {question}\nA: {output_text}",
                    {"source": "adversarial", "score": str(quality)},
                )
            except Exception as exc:
                logger.debug("[adversarial_trainer] L2 store failed: %s", exc)
            try:
                await mem._store_layer3(
                    f"Q: {question}\nA: {output_text}",
                    thread_id="adversarial",
                    source="adversarial",
                )
            except Exception as exc:
                logger.debug("[adversarial_trainer] L3 store failed: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# DATASET REGISTRY HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_db_path() -> Optional[str]:
    mem = _get_mem_service()
    if mem is None:
        return None
    return str(mem._l1_path)


def _dataset_key(dataset_id: str, dataset_config: Optional[str], split: str) -> str:
    cfg = dataset_config or ""
    return f"{dataset_id}|{cfg}|{split}"


def _ensure_registry_table(db_path: str) -> None:
    try:
        with sqlite3.connect(db_path) as db:
            db.execute(_REGISTRY_DDL)
            # Apply any new columns that didn't exist in older schema versions
            for migration in _REGISTRY_MIGRATIONS:
                try:
                    db.execute(migration)
                except Exception:
                    pass  # Column already exists — sqlite raises error on duplicate ADD COLUMN
            db.commit()
    except Exception as exc:
        logger.warning("[adversarial_trainer] ensure_registry_table failed: %s", exc)


def _upsert_dataset_known(
    db_path: str,
    config: AdversarialConfig,
    p_col: str,
    r_col: str,
    resolved_split: str,
) -> None:
    """Insert or update registry entry on successful load. Never resets bookmark or total_done."""
    key = _dataset_key(config.dataset_id, config.dataset_config, resolved_split)
    now = time.time()
    try:
        with sqlite3.connect(db_path) as db:
            existing = db.execute(
                "SELECT dataset_key FROM adversarial_dataset_registry WHERE dataset_key = ?", (key,)
            ).fetchone()
            if existing:
                db.execute("""
                    UPDATE adversarial_dataset_registry
                    SET prompt_col=?, response_col=?, last_run_at=?,
                        max_samples=?, interval_minutes=?, judge_threshold=?, workhorse_model=?
                    WHERE dataset_key=?
                """, (p_col, r_col, now,
                      config.max_samples, config.interval_minutes,
                      config.judge_threshold, config.workhorse_model,
                      key))
            else:
                db.execute("""
                    INSERT INTO adversarial_dataset_registry
                        (dataset_key, dataset_id, dataset_config, dataset_split,
                         prompt_col, response_col, total_samples_done, bookmark,
                         first_seen_at, last_run_at,
                         max_samples, interval_minutes, judge_threshold, workhorse_model)
                    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)
                """, (key, config.dataset_id, config.dataset_config, resolved_split,
                      p_col, r_col, now, now,
                      config.max_samples, config.interval_minutes,
                      config.judge_threshold, config.workhorse_model))
            db.commit()
    except Exception as exc:
        logger.warning("[adversarial_trainer] upsert_dataset_known failed: %s", exc)


def _get_dataset_bookmark(db_path: str, key: str) -> tuple[int, int]:
    """Returns (bookmark, total_samples_done) for a dataset key."""
    try:
        with sqlite3.connect(db_path) as db:
            row = db.execute(
                "SELECT bookmark, total_samples_done FROM adversarial_dataset_registry WHERE dataset_key=?",
                (key,)
            ).fetchone()
            if row:
                return row[0] or 0, row[1] or 0
    except Exception as exc:
        logger.warning("[adversarial_trainer] get_dataset_bookmark failed: %s", exc)
    return 0, 0


def _update_dataset_progress(
    db_path: str,
    key: str,
    bookmark: int,
    total_done: int,
    session_id: str,
) -> None:
    try:
        with sqlite3.connect(db_path) as db:
            db.execute("""
                UPDATE adversarial_dataset_registry
                SET bookmark=?, total_samples_done=?, last_session_id=?, last_run_at=?
                WHERE dataset_key=?
            """, (bookmark, total_done, session_id, time.time(), key))
            db.commit()
    except Exception as exc:
        logger.debug("[adversarial_trainer] update_dataset_progress failed: %s", exc)


# ─────────────────────────────────────────────────────────────────────────────
# DATASET LOAD HELPER
# ─────────────────────────────────────────────────────────────────────────────

def _load_dataset(config: AdversarialConfig):
    """
    Load a HuggingFace dataset and auto-detect prompt/response columns.
    Returns (prompt_col, response_col, iterator, resolved_split) or (None, None, None, None) on failure.
    """
    import re

    try:
        from datasets import load_dataset
    except ImportError:
        logger.error("[adversarial_trainer] 'datasets' package not installed")
        return None, None, None, None

    def _do_load(split: str):
        args = [config.dataset_id]
        if config.dataset_config:
            args.append(config.dataset_config)
        return load_dataset(*args, split=split, streaming=True)

    # Try requested split; on "Bad split" parse and retry with first available
    split = config.dataset_split
    try:
        ds = _do_load(split)
    except Exception as exc:
        err = str(exc)
        if "Available splits" in err or "Bad split" in err:
            m = re.search(r"\[([^\]]+)\]", err)
            if m:
                alts = [x.strip().strip("'\"") for x in m.group(1).split(",")]
                if alts:
                    split = alts[0]
                    try:
                        ds = _do_load(split)
                        logger.info("[adversarial_trainer] Switched to split '%s'", split)
                    except Exception as exc2:
                        logger.error("[adversarial_trainer] Dataset load failed: %s", exc2)
                        return None, None, None, None
                else:
                    logger.error("[adversarial_trainer] Dataset load failed: %s", exc)
                    return None, None, None, None
            else:
                logger.error("[adversarial_trainer] Dataset load failed: %s", exc)
                return None, None, None, None
        else:
            logger.error("[adversarial_trainer] Dataset load failed: %s", exc)
            return None, None, None, None

    try:
        # Detect columns from first sample
        first = next(iter(ds))
        cols = list(first.keys())

        p_col = config.dataset_prompt_col
        r_col = config.dataset_response_col

        if not p_col:
            for c in PROMPT_COLS:
                if c in cols:
                    p_col = c
                    break

        if not r_col:
            for c in RESPONSE_COLS:
                if c in cols:
                    r_col = c
                    break

        # Fallback: use first two string-valued columns
        if not p_col or not r_col:
            text_cols = [k for k, v in first.items() if isinstance(v, str) and v]
            if len(text_cols) >= 2 and not p_col:
                p_col = text_cols[0]
            if len(text_cols) >= 2 and not r_col:
                r_col = text_cols[1]
            elif len(text_cols) == 1 and not p_col:
                p_col = text_cols[0]
                r_col = text_cols[0]

        if not p_col or not r_col:
            logger.error("[adversarial_trainer] Could not detect prompt/response columns from %s", cols)
            return None, None, None, None

        # Try to get total dataset size from split info
        dataset_size = None
        try:
            info = ds.info
            if info and info.splits and split in info.splits:
                dataset_size = info.splits[split].num_examples
        except Exception:
            pass

        # Persist size if we got it
        db_path = _get_db_path()
        if db_path and dataset_size:
            key = _dataset_key(config.dataset_id, config.dataset_config, split)
            try:
                _ensure_registry_table(db_path)
                with sqlite3.connect(db_path) as db:
                    db.execute(
                        "UPDATE adversarial_dataset_registry SET dataset_size=? WHERE dataset_key=?",
                        (dataset_size, key)
                    )
                    db.commit()
            except Exception:
                pass

        # Scan response column to lock in label scheme before the run starts
        label_scheme = "unknown"
        try:
            from app.service.citation_label_normalizer import scan_label_scheme
            # Peek at up to 30 samples for scheme detection, then restart
            peek_ds = _do_load(split)
            label_samples = []
            for s in peek_ds:
                val = s.get(r_col, "")
                if val:
                    label_samples.append(str(val))
                if len(label_samples) >= 30:
                    break
            if label_samples:
                label_scheme = scan_label_scheme(label_samples, dataset_id=config.dataset_id)
                logger.info("[adversarial_trainer] Label scheme locked: %s", label_scheme)
        except Exception as exc:
            logger.warning("[adversarial_trainer] Label scheme scan failed: %s", exc)

        # Restart iterator (streaming datasets are single-pass after next())
        ds = _do_load(split)
        return p_col, r_col, ds, split, label_scheme

    except Exception as exc:
        logger.error("[adversarial_trainer] Dataset load failed: %s", exc)
        return None, None, None, None


# ─────────────────────────────────────────────────────────────────────────────
# OTHER HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _get_ollama(model_override: Optional[str] = None):
    """Return OllamaService singleton, optionally with a model override."""
    try:
        from app.service.ollama_service import get_ollama_service, OllamaService
        from app.config import get_settings
        svc = get_ollama_service()
        if svc and model_override and model_override != svc.model:
            # Wrap with override model — reuse host/settings
            settings = get_settings()
            return OllamaService(
                model=model_override,
                host=svc.host,
                num_ctx=svc.num_ctx,
            )
        return svc
    except Exception:
        return None


def _get_mem_service():
    try:
        from app.service.memory_service import get_memory_service
        return get_memory_service()
    except Exception:
        return None


def _get_tracer():
    """Return an OTel tracer pointed at Phoenix, or None if not configured/enabled."""
    try:
        import json
        from pathlib import Path
        cfg_path = Path.home() / ".aura" / "phoenix_config.json"
        if not cfg_path.exists():
            return None
        cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        if not cfg.get("tracing_enabled", False):
            return None
        from app.utils.routing import _ensure_tracer
        _ensure_tracer(cfg.get("host", "http://localhost:6006"))
        from opentelemetry import trace
        return trace.get_tracer("aura.adversarial_trainer")
    except Exception:
        return None


class _nullspan:
    """No-op context manager used when Phoenix tracing is disabled."""
    def __enter__(self):
        return None
    def __exit__(self, *_):
        pass


async def _emit_at(event_type: str, data: dict) -> None:
    try:
        from app.controller.chat_controller import _emit
        await _emit(event_type, data)
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON
# ─────────────────────────────────────────────────────────────────────────────

_trainer: Optional[AdversarialTrainer] = None


def get_trainer() -> AdversarialTrainer:
    global _trainer
    if _trainer is None:
        _trainer = AdversarialTrainer()
    return _trainer
